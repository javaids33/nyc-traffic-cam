"""photo_db.py — DuckDB index of 1940s NYC tax photos + cam metadata.

A single analytical store for everything we know about the WPA tax-photo
collection and the NYC DOT cameras. Built for ad-hoc joins like:

  - "show me every pre-1942 brownstone in Brooklyn within 100m of a
    cam llava judged usable"
  - "which boroughs have the densest pre-1942 stock vs cam coverage?"
  - "list the SDXL-baked panoramas with > 0 high-confidence SIFT seams"

Tables (created by `init`):
  footprints_1940s — citywide pre-1942 building inventory (Socrata)
  tax_photos       — locally fetched WPA photos (BIN → photo_url, dims)
  photo_analysis   — llava facade bounds + style tags per photo
  stitch_seams     — SIFT seam matches between adjacent photos
  cameras          — NYC DOT cam list (lat/lng, name, borough)
  cam_validations  — llava per-cam usability verdicts (rewind portal)
  cam_pairs        — geographic + LLM-validated cam ↔ tax-photo pairs

Subcommands:
  init             — create schema (drops + recreates tables)
  import-local     — import everything from the existing JSONs in public/
  fetch-citywide   — pull all pre-1942 footprints from Socrata for one
                     or all boroughs (--boro 1..5 or --all-boros)
  match-cams       — populate cam_pairs by joining footprints + cameras
                     within a max distance, optionally filtering by
                     cam validation verdict
  summary          — print counts + coverage stats

The DB lives at data/photos.duckdb (gitignored — it's data, not source).
Re-run any subcommand idempotently: existing rows are upserted by key.

Usage:
    python -m server.photo_db init
    python -m server.photo_db import-local
    python -m server.photo_db fetch-citywide --boro 1 --limit 5000
    python -m server.photo_db fetch-citywide --all-boros        # full sweep
    python -m server.photo_db match-cams --max-distance-m 400
    python -m server.photo_db summary
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import duckdb
import httpx

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "photos.duckdb"
PUBLIC = ROOT / "public"

# Same Socrata dataset as fetch_1940s.py — building footprints with
# construction year. The dataset has ~1M rows; pre-1942 filter trims to
# ~500-700k. We paginate per-borough to keep responses manageable.
FOOTPRINTS_DATASET = "https://data.cityofnewyork.us/resource/5zhs-2jue.json"
SOCRATA_PAGE_LIMIT = 10000
USER_AGENT = "nyc-traffic-cam/photo-db (https://github.com/javaids33/nyc-traffic-cam)"

BORO_NAMES = {1: "Manhattan", 2: "Bronx", 3: "Brooklyn", 4: "Queens", 5: "Staten Island"}


# ---------------------------------------------------------------- schema

SCHEMA = """
CREATE TABLE IF NOT EXISTS footprints_1940s (
  bin                VARCHAR PRIMARY KEY,
  bbl                VARCHAR,
  boro               INTEGER,
  block              INTEGER,
  lot                INTEGER,
  construction_year  INTEGER,
  height_roof        DOUBLE,
  ground_elevation   DOUBLE,
  centroid_lon       DOUBLE,
  centroid_lat       DOUBLE,
  geometry_json      VARCHAR,
  filename_stem      VARCHAR,            -- nynyma_rec0040_<boro>_<block:05d>_<lot:04d>
  source             VARCHAR,            -- 'socrata' | 'local-manifest'
  fetched_at         BIGINT
);

CREATE TABLE IF NOT EXISTS tax_photos (
  bin                VARCHAR PRIMARY KEY,
  photo_url          VARCHAR,
  width              INTEGER,
  height             INTEGER,
  size_bytes         BIGINT
);

CREATE TABLE IF NOT EXISTS photo_analysis (
  bin                VARCHAR PRIMARY KEY,
  facade_top         DOUBLE,
  facade_bottom      DOUBLE,
  dominant_color     VARCHAR,
  style              VARCHAR,
  has_signage        BOOLEAN,
  has_vehicles       BOOLEAN,
  has_people         BOOLEAN,
  notes              VARCHAR
);

CREATE TABLE IF NOT EXISTS stitch_seams (
  block_id           VARCHAR,            -- e.g. '1-585'
  side               VARCHAR,            -- 'side_a' ...
  a_bin              VARCHAR,
  b_bin              VARCHAR,
  inliers            INTEGER,
  y_std              DOUBLE,
  l_std              DOUBLE,
  l_px               DOUBLE,
  feature_offset_m   DOUBLE,
  score_overall      DOUBLE,
  confidence         VARCHAR,            -- 'high' | 'med' | 'low'
  PRIMARY KEY (block_id, side, a_bin, b_bin)
);

CREATE TABLE IF NOT EXISTS cameras (
  cam_id             VARCHAR PRIMARY KEY,
  name               VARCHAR,
  lat                DOUBLE,
  lng                DOUBLE,
  borough            VARCHAR,
  is_online          BOOLEAN
);

CREATE TABLE IF NOT EXISTS cam_validations (
  cam_id             VARCHAR PRIMARY KEY,
  usable             BOOLEAN,
  confidence         DOUBLE,
  scene_kind         VARCHAR,            -- 'rowhouse_street' | 'highway' | ...
  has_pedestrians    BOOLEAN,
  has_vehicles       BOOLEAN,
  what_we_see        VARCHAR,
  model              VARCHAR,
  checked_at         BIGINT
);

CREATE TABLE IF NOT EXISTS cam_pairs (
  bin                VARCHAR,
  cam_id             VARCHAR,
  distance_m         DOUBLE,
  PRIMARY KEY (bin, cam_id)
);
"""


def connect(read_only: bool = False) -> duckdb.DuckDBPyConnection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    return duckdb.connect(str(DB_PATH), read_only=read_only)


def upsert_many(con: duckdb.DuckDBPyConnection, table: str, rows: list[dict[str, Any]]) -> int:
    """Bulk insert with ON CONFLICT — uses the table's PRIMARY KEY."""
    if not rows:
        return 0
    cols = list(rows[0].keys())
    placeholders = ", ".join(["?"] * len(cols))
    excluded = ", ".join(f"{c}=excluded.{c}" for c in cols)
    sql = (
        f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders}) "
        f"ON CONFLICT DO UPDATE SET {excluded}"
    )
    data = [tuple(r.get(c) for c in cols) for r in rows]
    con.executemany(sql, data)
    return len(data)


# ---------------------------------------------------------------- subcommands

def cmd_init(args: argparse.Namespace) -> None:
    con = connect()
    con.execute(SCHEMA)
    con.close()
    print(f"schema ready at {DB_PATH.relative_to(ROOT)}")


def filename_stem(boro: int, block: int, lot: int) -> str:
    return f"nynyma_rec0040_{boro}_{block:05d}_{lot:04d}"


def cmd_import_local(args: argparse.Namespace) -> None:
    """Slurp every public/*-1940s.json and the cam files into the DB."""
    con = connect()
    con.execute(SCHEMA)
    now = int(time.time())

    # ---- footprints + tax_photos from data-1940s.json -----------------
    manifest_path = PUBLIC / "data-1940s.json"
    if not manifest_path.exists():
        print(f"skip: {manifest_path.relative_to(ROOT)} not present")
    else:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        fp_rows = []
        photo_rows = []
        for b in manifest.get("buildings", []):
            bin_ = str(b.get("bin"))
            if not bin_:
                continue
            ring = (b.get("geom", {}).get("coordinates") or [[[]]])[0][0]
            if ring:
                cx = sum(p[0] for p in ring) / len(ring)
                cy = sum(p[1] for p in ring) / len(ring)
            else:
                cx = cy = None
            boro = int(b.get("boro") or 0)
            block = int(b.get("block") or 0)
            lot = int(b.get("lot") or 0)
            fp_rows.append({
                "bin": bin_,
                "bbl": str(b.get("bbl") or ""),
                "boro": boro, "block": block, "lot": lot,
                "construction_year": b.get("year"),
                "height_roof": b.get("h_roof"),
                "ground_elevation": b.get("h_ground"),
                "centroid_lon": cx, "centroid_lat": cy,
                "geometry_json": json.dumps(b.get("geom", {})),
                "filename_stem": filename_stem(boro, block, lot) if boro and block else None,
                "source": "local-manifest",
                "fetched_at": now,
            })
            photo = b.get("photo")
            if photo and photo.get("url"):
                photo_rows.append({
                    "bin": bin_,
                    "photo_url": photo["url"],
                    "width": photo.get("w"),
                    "height": photo.get("h"),
                    "size_bytes": photo.get("size"),
                })
        n1 = upsert_many(con, "footprints_1940s", fp_rows)
        n2 = upsert_many(con, "tax_photos", photo_rows)
        print(f"data-1940s.json: {n1} footprints, {n2} photos")

    # ---- photo_analysis ---------------------------------------------
    ana_path = PUBLIC / "photo-analysis-1940s.json"
    if ana_path.exists():
        ana = json.loads(ana_path.read_text(encoding="utf-8"))
        rows = []
        for bin_, info in ana.get("buildings", {}).items():
            rows.append({
                "bin": str(bin_),
                "facade_top": info.get("facade_top"),
                "facade_bottom": info.get("facade_bottom"),
                "dominant_color": info.get("dominant_color"),
                "style": info.get("style"),
                "has_signage": info.get("has_signage"),
                "has_vehicles": info.get("has_vehicles"),
                "has_people": info.get("has_people"),
                "notes": info.get("notes"),
            })
        n = upsert_many(con, "photo_analysis", rows)
        print(f"photo-analysis-1940s.json: {n} rows")

    # ---- stitch_seams -----------------------------------------------
    stitch_path = PUBLIC / "photo-stitch-1940s.json"
    if stitch_path.exists():
        stitch = json.loads(stitch_path.read_text(encoding="utf-8"))
        rows = []
        for block_id, blk in stitch.get("blocks", {}).items():
            for s in blk.get("seams", []):
                raw = s.get("raw", {})
                scores = s.get("scores", {})
                rows.append({
                    "block_id": block_id,
                    "side": s.get("side"),
                    "a_bin": s.get("a_bin"),
                    "b_bin": s.get("b_bin"),
                    "inliers": raw.get("inliers"),
                    "y_std": raw.get("y_std"),
                    "l_std": raw.get("L_std"),
                    "l_px": raw.get("L_px"),
                    "feature_offset_m": s.get("feature_offset_m"),
                    "score_overall": scores.get("overall"),
                    "confidence": s.get("confidence"),
                })
        n = upsert_many(con, "stitch_seams", rows)
        print(f"photo-stitch-1940s.json: {n} seams")

    # ---- cameras ------------------------------------------------------
    cams_path = ROOT / "src" / "cameras.json"
    if cams_path.exists():
        cams = json.loads(cams_path.read_text(encoding="utf-8"))
        cam_list = cams.get("cameras") if isinstance(cams, dict) else cams
        rows = [{
            "cam_id": c["id"],
            "name": c.get("name"),
            "lat": c.get("lat"),
            "lng": c.get("lng"),
            "borough": c.get("borough"),
            "is_online": c.get("is_online"),
        } for c in cam_list]
        n = upsert_many(con, "cameras", rows)
        print(f"cameras.json: {n} cams")

    # ---- cam_validations ---------------------------------------------
    val_path = PUBLIC / "cam-rewind-usability.json"
    if val_path.exists():
        val = json.loads(val_path.read_text(encoding="utf-8"))
        rows = []
        for cam_id, v in val.get("cams", {}).items():
            rows.append({
                "cam_id": cam_id,
                "usable": v.get("usable"),
                "confidence": v.get("confidence"),
                "scene_kind": v.get("scene_kind"),
                "has_pedestrians": v.get("has_pedestrians"),
                "has_vehicles": v.get("has_vehicles"),
                "what_we_see": v.get("what_we_see"),
                "model": v.get("model"),
                "checked_at": v.get("checked_at"),
            })
        n = upsert_many(con, "cam_validations", rows)
        print(f"cam-rewind-usability.json: {n} verdicts")

    # ---- cam_pairs (geographic) -------------------------------------
    pairs_path = PUBLIC / "rewind-pairs-1940s.json"
    if pairs_path.exists():
        pp = json.loads(pairs_path.read_text(encoding="utf-8"))
        rows = [{
            "bin": p["bin"],
            "cam_id": p["cam"]["id"],
            "distance_m": p["distance_m"],
        } for p in pp.get("pairs", [])]
        n = upsert_many(con, "cam_pairs", rows)
        print(f"rewind-pairs-1940s.json: {n} pairs")

    con.close()
    print(f"\nDB at {DB_PATH.relative_to(ROOT)}")


def _socrata_centroid(geom: dict | None) -> tuple[float | None, float | None]:
    if not geom or not geom.get("coordinates"):
        return (None, None)
    try:
        ring = geom["coordinates"][0][0]
        cx = sum(p[0] for p in ring) / len(ring)
        cy = sum(p[1] for p in ring) / len(ring)
        return (cx, cy)
    except Exception:
        return (None, None)


def _socrata_get_with_retry(client: httpx.Client, params: dict, label: str) -> list[dict] | None:
    for attempt in range(5):
        try:
            r = client.get(FOOTPRINTS_DATASET, params=params)
            r.raise_for_status()
            return r.json()
        except httpx.HTTPStatusError as e:
            if e.response.status_code in (429, 500, 502, 503, 504) and attempt < 4:
                wait = 2 ** attempt + 0.5 * attempt
                print(f"  socrata {e.response.status_code} {label}, retry {attempt + 1}/4 in {wait:.1f}s",
                      flush=True)
                time.sleep(wait)
                continue
            print(f"  socrata HTTP {e.response.status_code} {label}, giving up", flush=True)
            return None
        except httpx.HTTPError as e:
            if attempt < 4:
                wait = 2 ** attempt
                print(f"  socrata {type(e).__name__} {label}, retry {attempt + 1}/4 in {wait:.1f}s",
                      flush=True)
                time.sleep(wait)
                continue
            print(f"  socrata {type(e).__name__} {label}, giving up", flush=True)
            return None
    return None


def cmd_fetch_citywide(args: argparse.Namespace) -> None:
    """Cursor-paginated citywide fetch.

    Socrata reliably 500s past offset 30k on this dataset. Cursor
    pagination — `WHERE bin > <last_seen> ORDER BY bin LIMIT N` — sidesteps
    the cliff entirely and is unbounded. We drop the last seen BIN per
    page and ask for the next chunk.
    """
    con = connect()
    con.execute(SCHEMA)
    boros = [args.boro] if args.boro else [1, 2, 3, 4, 5]

    headers = {"User-Agent": USER_AGENT}
    fetched_total = 0
    with httpx.Client(headers=headers, timeout=60.0) as client:
        for boro in boros:
            print(f"\n[boro {boro} · {BORO_NAMES[boro]}] starting fetch", flush=True)
            last_bin = "0"
            boro_count = 0
            page_no = 0
            while True:
                # Cursor: bin > last_bin so each request starts past the
                # previous tail. ORDER BY bin makes the cursor stable.
                where = (
                    "construction_year < 1942 AND construction_year > 1700 "
                    f"AND starts_with(mappluto_bbl, '{boro}') "
                    f"AND bin > '{last_bin}'"
                )
                params = {
                    "$where": where,
                    "$select": "bin,mappluto_bbl,construction_year,height_roof,ground_elevation,the_geom",
                    "$limit": SOCRATA_PAGE_LIMIT,
                    "$order": "bin",
                }
                rows = _socrata_get_with_retry(client, params, label=f"boro {boro} cursor>{last_bin}")
                if rows is None:
                    print(f"  fatal: boro {boro} aborted at cursor {last_bin}", flush=True)
                    break
                if not rows:
                    break
                page_no += 1
                fp_rows = []
                last_bin_in_page = last_bin
                for row in rows:
                    bbl = row.get("mappluto_bbl")
                    bin_ = str(row.get("bin") or "")
                    if not bbl or len(bbl) != 10 or not bin_:
                        continue
                    last_bin_in_page = bin_
                    try:
                        b = int(bbl[0]); blk = int(bbl[1:6]); lot = int(bbl[6:10])
                    except ValueError:
                        continue
                    if lot >= 7500:
                        continue
                    try:
                        year = int(row["construction_year"])
                    except (KeyError, ValueError, TypeError):
                        continue
                    cx, cy = _socrata_centroid(row.get("the_geom"))
                    fp_rows.append({
                        "bin": bin_,
                        "bbl": bbl,
                        "boro": b, "block": blk, "lot": lot,
                        "construction_year": year,
                        "height_roof": _to_float(row.get("height_roof")),
                        "ground_elevation": _to_float(row.get("ground_elevation")),
                        "centroid_lon": cx, "centroid_lat": cy,
                        "geometry_json": json.dumps(row.get("the_geom") or {}),
                        "filename_stem": filename_stem(b, blk, lot),
                        "source": "socrata",
                        "fetched_at": int(time.time()),
                    })
                upsert_many(con, "footprints_1940s", fp_rows)
                boro_count += len(fp_rows)
                fetched_total += len(fp_rows)
                print(f"  page {page_no:>3}  cursor>{last_bin}  page_size={len(rows):>5}  "
                      f"kept={len(fp_rows):>5}  boro_total={boro_count:>6}", flush=True)
                last_bin = last_bin_in_page
                if args.limit and boro_count >= args.limit:
                    print(f"  stopping early: --limit {args.limit}", flush=True)
                    break
                if len(rows) < SOCRATA_PAGE_LIMIT:
                    break

            print(f"[boro {boro}] {boro_count} footprints written", flush=True)

    con.close()
    print(f"\ncitywide fetch done — {fetched_total} footprints across {len(boros)} boro(s)", flush=True)


def cmd_match_cams(args: argparse.Namespace) -> None:
    """Compute geographic nearest cam for each footprint within max-distance.

    Uses DuckDB to do the cross-join + haversine in SQL — fast even at
    citywide scale because both tables are small (~500k footprints,
    ~1k cams). Optionally filters cams to usable=true via a JOIN.
    """
    con = connect()
    con.execute(SCHEMA)

    only_usable = "AND v.usable = TRUE AND v.confidence >= 0.5" if args.only_usable else ""

    # Equirectangular distance — small error at NYC scale, much faster
    # than haversine. cos(lat) is constant enough across NYC.
    sql = f"""
    INSERT INTO cam_pairs (bin, cam_id, distance_m)
    SELECT bin, cam_id, distance_m FROM (
        SELECT
            f.bin,
            c.cam_id,
            sqrt(
                power((f.centroid_lat - c.lat) * 111320.0, 2)
              + power((f.centroid_lon - c.lng) * 111320.0 * cos(radians(f.centroid_lat)), 2)
            ) AS distance_m,
            row_number() OVER (PARTITION BY f.bin ORDER BY
                (f.centroid_lat - c.lat) * (f.centroid_lat - c.lat)
              + (f.centroid_lon - c.lng) * (f.centroid_lon - c.lng)
            ) AS rn
        FROM footprints_1940s f
        CROSS JOIN cameras c
        LEFT JOIN cam_validations v ON v.cam_id = c.cam_id
        WHERE f.centroid_lat IS NOT NULL
          AND c.lat IS NOT NULL
          {only_usable}
    )
    WHERE rn = 1 AND distance_m <= {args.max_distance_m}
    ON CONFLICT DO UPDATE SET distance_m = excluded.distance_m;
    """
    con.execute(sql)
    n = con.execute("SELECT count(*) FROM cam_pairs").fetchone()[0]
    print(f"cam_pairs: {n} pairs (max_distance_m={args.max_distance_m}, only_usable={args.only_usable})")
    con.close()


def cmd_summary(args: argparse.Namespace) -> None:
    con = connect(read_only=True)
    print(f"DB: {DB_PATH.relative_to(ROOT)}")
    print()
    for table in ["footprints_1940s", "tax_photos", "photo_analysis", "stitch_seams",
                  "cameras", "cam_validations", "cam_pairs"]:
        try:
            n = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            print(f"  {table:20} {n:>10,} rows")
        except duckdb.Error as e:
            print(f"  {table:20} ERROR: {e}")
    print()
    print("footprints_1940s by borough:")
    rows = con.execute("""
        SELECT boro, count(*) FROM footprints_1940s
        WHERE boro BETWEEN 1 AND 5 GROUP BY boro ORDER BY boro
    """).fetchall()
    for boro, n in rows:
        print(f"  {boro} {BORO_NAMES.get(boro, '?'):15} {n:>10,}")
    print()
    print("cam_validations by scene_kind:")
    rows = con.execute("""
        SELECT scene_kind, count(*) FROM cam_validations
        GROUP BY scene_kind ORDER BY count(*) DESC
    """).fetchall()
    for sk, n in rows:
        print(f"  {sk:25} {n:>4}")
    print()
    print("cam_pairs distance distribution:")
    rows = con.execute("""
        SELECT
            CASE
                WHEN distance_m < 50 THEN '<50m'
                WHEN distance_m < 100 THEN '50-100m'
                WHEN distance_m < 200 THEN '100-200m'
                WHEN distance_m < 400 THEN '200-400m'
                WHEN distance_m < 800 THEN '400-800m'
                ELSE '>=800m'
            END AS bucket,
            count(*) FROM cam_pairs GROUP BY bucket ORDER BY min(distance_m)
    """).fetchall()
    for bucket, n in rows:
        print(f"  {bucket:10} {n:>10,}")
    con.close()


def _to_float(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------- main

def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="create schema").set_defaults(fn=cmd_init)
    sub.add_parser("import-local", help="import existing JSONs in public/").set_defaults(fn=cmd_import_local)

    fc = sub.add_parser("fetch-citywide", help="pull pre-1942 footprints from Socrata")
    fc.add_argument("--boro", type=int, choices=[1, 2, 3, 4, 5], default=None,
                    help="single borough; omit + use --all-boros for all 5")
    fc.add_argument("--all-boros", action="store_true",
                    help="iterate boros 1..5 (omit if --boro is set)")
    fc.add_argument("--limit", type=int, default=0, help="stop after N rows per borough (0 = no cap)")
    fc.set_defaults(fn=cmd_fetch_citywide)

    mc = sub.add_parser("match-cams", help="populate cam_pairs by joining geometry")
    mc.add_argument("--max-distance-m", type=float, default=400.0)
    mc.add_argument("--only-usable", action="store_true",
                    help="only join against cams llava marked usable + confidence >= 0.5")
    mc.set_defaults(fn=cmd_match_cams)

    sub.add_parser("summary", help="print counts").set_defaults(fn=cmd_summary)

    args = p.parse_args()
    if hasattr(args, "fn"):
        # Validate fetch-citywide flags
        if args.cmd == "fetch-citywide" and not args.boro and not args.all_boros:
            sys.exit("specify --boro N or --all-boros")
        args.fn(args)
    else:
        p.print_help()


if __name__ == "__main__":
    main()
