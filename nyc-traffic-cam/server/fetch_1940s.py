"""Fetch 1940s tax photos + building footprints for a given bbox.

Sources (official, public, no scraping of 3rd-party sites):
  - Building Footprints   : NYC Open Data Socrata (5zhs-2jue)
  - 1940s tax photos      : NYC Municipal Archives Preservica
                            (search by filename → IO UUID → /download/file/<IO>)

Polite to Preservica: a small async semaphore + per-request sleep keep us at
roughly 3 requests/second. The whole pipeline is idempotent — reruns skip
BBLs already in nyc.db and files already on disk.

Run:
  .venv/bin/python -m server.fetch_1940s
  .venv/bin/python -m server.fetch_1940s --bbox 40.7350,-74.008,40.7320,-74.003
  .venv/bin/python -m server.fetch_1940s --bbox times-square
  .venv/bin/python -m server.fetch_1940s --keep-originals
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import aiosqlite
import httpx
from PIL import Image

from .config import DB_PATH, ROOT


PHOTO_DIR = ROOT / "data" / "photos_1940s"
PHOTO_DIR.mkdir(parents=True, exist_ok=True)
ORIG_DIR = ROOT / "data" / "photos_1940s_original"

FOOTPRINTS_DATASET = "https://data.cityofnewyork.us/resource/5zhs-2jue.json"
PRESERVICA_BASE = "https://nycrecords.access.preservica.com"
USER_AGENT = "nyc-traffic-cam/1940s-fetcher (https://github.com/nyc-traffic-cam) - fetching public NYC archives for a non-commercial mapping demo"

# (north, west, south, east) — Socrata within_box takes (n_lat, w_lng, s_lat, e_lng)
BBOX_PRESETS: dict[str, tuple[float, float, float, float]] = {
    "west-village":  (40.7350, -74.0080, 40.7320, -74.0030),
    "times-square":  (40.7610, -73.9920, 40.7540, -73.9820),
    "lower-east":    (40.7220, -73.9920, 40.7140, -73.9820),
    "wall-street":   (40.7100, -74.0140, 40.7050, -74.0050),
    "soho":          (40.7280, -74.0050, 40.7200, -73.9970),
}

IO_RE = re.compile(r"IO_[a-f0-9-]{36}")


@dataclass
class Footprint:
    bin: str
    bbl: str
    boro: int
    block: int
    lot: int
    construction_year: int
    height_roof: float | None
    ground_elevation: float | None
    geometry: dict  # GeoJSON MultiPolygon

    @property
    def filename_stem(self) -> str:
        return f"nynyma_rec0040_{self.boro}_{self.block:05d}_{self.lot:04d}"


# ---------------------------------------------------------------- DB schema

SCHEMA = """
CREATE TABLE IF NOT EXISTS footprints_1940s (
  bin TEXT PRIMARY KEY,
  bbl TEXT NOT NULL,
  boro INTEGER NOT NULL,
  block INTEGER NOT NULL,
  lot INTEGER NOT NULL,
  construction_year INTEGER,
  height_roof REAL,
  ground_elevation REAL,
  geometry_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_footprints_bbl ON footprints_1940s(bbl);

CREATE TABLE IF NOT EXISTS photos_1940s (
  bbl TEXT PRIMARY KEY,
  filename_stem TEXT NOT NULL,
  io_uuid TEXT,            -- NULL means we searched and got no match
  width INTEGER,
  height INTEGER,
  size_bytes INTEGER,
  status TEXT NOT NULL,    -- 'ok' | 'no-match' | 'error'
  error TEXT,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_status ON photos_1940s(status);
"""


async def init_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(DB_PATH)
    await db.executescript(SCHEMA)
    await db.commit()
    return db


# ---------------------------------------------------------------- Socrata

async def fetch_footprints(client: httpx.AsyncClient, bbox: tuple[float, float, float, float]) -> list[Footprint]:
    """Pull all pre-1942 building footprints in bbox from Socrata."""
    n, w, s, e = bbox
    where = (
        f"construction_year < 1942 AND construction_year > 1700 "
        f"AND within_box(the_geom, {n}, {w}, {s}, {e})"
    )
    params = {
        "$where": where,
        "$select": "bin,mappluto_bbl,construction_year,height_roof,ground_elevation,the_geom",
        "$limit": 10000,
    }
    print(f"[footprints] fetching from Socrata: bbox=({n},{w},{s},{e})")
    r = await client.get(FOOTPRINTS_DATASET, params=params, timeout=30.0)
    r.raise_for_status()
    rows = r.json()
    print(f"[footprints] got {len(rows)} rows")

    out: list[Footprint] = []
    for row in rows:
        bbl = row.get("mappluto_bbl")
        bin_ = str(row.get("bin") or "")
        if not bbl or len(bbl) != 10 or not bbl.isdigit() or not bin_:
            continue
        boro, block, lot = int(bbl[0]), int(bbl[1:6]), int(bbl[6:10])
        if lot >= 7500:
            continue  # condo pseudo-lots have no individual photo
        try:
            year = int(row["construction_year"])
        except (KeyError, ValueError, TypeError):
            continue
        out.append(Footprint(
            bin=bin_,
            bbl=bbl,
            boro=boro,
            block=block,
            lot=lot,
            construction_year=year,
            height_roof=_to_float(row.get("height_roof")),
            ground_elevation=_to_float(row.get("ground_elevation")),
            geometry=row.get("the_geom") or {},
        ))
    print(f"[footprints] kept {len(out)} after BBL/condo filter ({len({fp.bbl for fp in out})} unique BBLs)")
    return out


def _to_float(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------- Preservica

class PoliteClient:
    """Async client with per-host token-bucket rate limiting."""

    def __init__(self, max_concurrent: int, requests_per_second: float):
        self._sem = asyncio.Semaphore(max_concurrent)
        self._min_interval = 1.0 / requests_per_second
        self._lock = asyncio.Lock()
        self._next_ok_at = 0.0

    async def __aenter__(self):
        await self._sem.acquire()
        async with self._lock:
            now = time.monotonic()
            wait = self._next_ok_at - now
            if wait > 0:
                await asyncio.sleep(wait)
            self._next_ok_at = max(now, self._next_ok_at) + self._min_interval
        return self

    async def __aexit__(self, *exc):
        self._sem.release()


async def _get_with_retry(client: httpx.AsyncClient, gate: PoliteClient, url: str,
                          *, params: dict | None = None, timeout: float, attempts: int = 4) -> httpx.Response | str:
    """Returns Response on success, or a short error string on permanent failure."""
    last_err = "unknown"
    for i in range(attempts):
        async with gate:
            try:
                r = await client.get(url, params=params, timeout=timeout)
            except httpx.HTTPError as e:
                last_err = f"{type(e).__name__}:{e}"[:80]
                r = None
        if r is not None:
            if r.status_code == 200 and r.content:
                return r
            if r.status_code in (429, 502, 503, 504):
                last_err = f"http {r.status_code}"
            else:
                return f"http {r.status_code}"
        if i < attempts - 1:
            await asyncio.sleep(2 ** i + 0.25 * i)  # 1, 2.25, 4.5, ...
    return last_err


async def search_preservica_for_io(client: httpx.AsyncClient, gate: PoliteClient, filename_stem: str) -> str | None:
    r = await _get_with_retry(client, gate, f"{PRESERVICA_BASE}/", params={"s": filename_stem}, timeout=20.0)
    if isinstance(r, str):
        return None
    m = IO_RE.search(r.text)
    return m.group(0) if m else None


async def download_preservica_image(client: httpx.AsyncClient, gate: PoliteClient, io_uuid: str) -> tuple[bytes | None, str | None]:
    r = await _get_with_retry(client, gate, f"{PRESERVICA_BASE}/download/file/{io_uuid}", timeout=60.0)
    if isinstance(r, str):
        return None, r
    return r.content, None


# ---------------------------------------------------------------- per-BBL job

async def process_bbl(
    fp: Footprint,
    client: httpx.AsyncClient,
    gate: PoliteClient,
    db: aiosqlite.Connection,
    keep_originals: bool,
    target_height: int,
) -> tuple[str, str]:
    """Returns (bbl, status). Idempotent: skips if DB row + file exist."""
    cur = await db.execute(
        "SELECT status, io_uuid FROM photos_1940s WHERE bbl = ?", (fp.bbl,)
    )
    row = await cur.fetchone()
    out_path = PHOTO_DIR / f"{fp.filename_stem}.jpg"

    if row and row[0] == "ok" and out_path.exists():
        return fp.bbl, "cached"

    # Resolve IO UUID
    io_uuid = row[1] if row else None
    if not io_uuid:
        io_uuid = await search_preservica_for_io(client, gate, fp.filename_stem)
        if not io_uuid:
            await _record(db, fp, None, None, None, None, "no-match", None)
            return fp.bbl, "no-match"

    # Download original
    blob, err = await download_preservica_image(client, gate, io_uuid)
    if not blob:
        await _record(db, fp, io_uuid, None, None, None, "error", f"download: {err}")
        return fp.bbl, "error"

    # Optionally keep original full-res
    if keep_originals:
        ORIG_DIR.mkdir(parents=True, exist_ok=True)
        (ORIG_DIR / f"{fp.filename_stem}.jpg").write_bytes(blob)

    # Downscale to target_height while preserving aspect ratio
    try:
        im = Image.open(io.BytesIO(blob))
        w, h = im.size
        if h > target_height:
            new_w = int(w * target_height / h)
            im = im.resize((new_w, target_height), Image.LANCZOS)
        if im.mode != "L":
            im = im.convert("L")  # 1940s photos are B&W; force grayscale
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85, optimize=True)
        out_bytes = buf.getvalue()
        out_path.write_bytes(out_bytes)
        await _record(db, fp, io_uuid, im.size[0], im.size[1], len(out_bytes), "ok", None)
        return fp.bbl, "ok"
    except Exception as e:
        await _record(db, fp, io_uuid, None, None, None, "error", f"image decode: {e}")
        return fp.bbl, "error"


async def _record(db, fp: Footprint, io_uuid, w, h, size, status, err):
    await db.execute(
        """INSERT INTO photos_1940s (bbl, filename_stem, io_uuid, width, height, size_bytes, status, error, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(bbl) DO UPDATE SET
             io_uuid=excluded.io_uuid, width=excluded.width, height=excluded.height,
             size_bytes=excluded.size_bytes, status=excluded.status, error=excluded.error,
             fetched_at=excluded.fetched_at""",
        (fp.bbl, fp.filename_stem, io_uuid, w, h, size, status, err, int(time.time())),
    )
    await db.commit()


async def save_footprint(db: aiosqlite.Connection, fp: Footprint) -> None:
    await db.execute(
        """INSERT INTO footprints_1940s (bin, bbl, boro, block, lot, construction_year, height_roof, ground_elevation, geometry_json, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(bin) DO UPDATE SET
             bbl=excluded.bbl, construction_year=excluded.construction_year,
             height_roof=excluded.height_roof, ground_elevation=excluded.ground_elevation,
             geometry_json=excluded.geometry_json, fetched_at=excluded.fetched_at""",
        (fp.bin, fp.bbl, fp.boro, fp.block, fp.lot, fp.construction_year,
         fp.height_roof, fp.ground_elevation, json.dumps(fp.geometry), int(time.time())),
    )


# ---------------------------------------------------------------- main

async def run(bbox: tuple[float, float, float, float], rate: float, concurrency: int,
              target_height: int, keep_originals: bool) -> None:
    db = await init_db()
    headers = {"User-Agent": USER_AGENT}
    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        # 1. Pull footprints (Socrata is fast, no rate limit needed)
        footprints = await fetch_footprints(client, bbox)
        for fp in footprints:
            await save_footprint(db, fp)
        await db.commit()

        # 2. Per-BBL: search Preservica → download → downscale.
        # Dedupe: tax photo is per-lot, multiple buildings on a BBL share one photo.
        seen_bbl: set[str] = set()
        bbl_targets: list[Footprint] = []
        for fp in footprints:
            if fp.bbl not in seen_bbl:
                seen_bbl.add(fp.bbl)
                bbl_targets.append(fp)

        gate = PoliteClient(max_concurrent=concurrency, requests_per_second=rate)
        print(f"[photos] processing {len(bbl_targets)} unique BBLs ({len(footprints)} buildings) at ~{rate} req/s")
        t0 = time.monotonic()
        results = await asyncio.gather(*[
            process_bbl(fp, client, gate, db, keep_originals, target_height) for fp in bbl_targets
        ])
        dt = time.monotonic() - t0

    summary: dict[str, int] = {}
    for _, status in results:
        summary[status] = summary.get(status, 0) + 1
    print(f"[done] {len(results)} BBLs in {dt:.1f}s — {summary}")
    print(f"[done] photos in {PHOTO_DIR}")
    await db.close()


def parse_bbox(arg: str) -> tuple[float, float, float, float]:
    if arg in BBOX_PRESETS:
        return BBOX_PRESETS[arg]
    parts = [float(x) for x in arg.split(",")]
    if len(parts) != 4:
        raise ValueError(f"bbox must be 'preset' or 'n,w,s,e'; got: {arg}")
    return tuple(parts)  # type: ignore[return-value]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bbox", default="west-village",
                    help=f"preset {sorted(BBOX_PRESETS)} or 'n,w,s,e'")
    ap.add_argument("--rate", type=float, default=3.0, help="requests/sec to Preservica")
    ap.add_argument("--concurrency", type=int, default=6, help="max concurrent in-flight requests")
    ap.add_argument("--target-height", type=int, default=1024,
                    help="downscale photos to this pixel height (preserves aspect)")
    ap.add_argument("--keep-originals", action="store_true",
                    help="also save original full-res JPEGs to data/photos_1940s_original/")
    args = ap.parse_args()

    bbox = parse_bbox(args.bbox)
    asyncio.run(run(bbox, args.rate, args.concurrency, args.target_height, args.keep_originals))


if __name__ == "__main__":
    main()
