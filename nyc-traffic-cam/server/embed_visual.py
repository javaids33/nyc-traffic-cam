"""embed_visual.py — CLIP embeddings for cams + WPA photos, then match.

For /rewind we want to know which 1940 photo from a cam's neighborhood
ACTUALLY looks like what that cam sees right now — not just which one is
geographically closest. CLIP image embeddings cross the B&W→color +
1940→2026 domain gap surprisingly well: a brownstone street in either
era embeds near other brownstone streets.

Pipeline:

    1. embed-wpa     embed every downloaded WPA photo (uses tax_photos table)
    2. embed-cams    embed every cam snapshot in data/cam_snapshots/
                     (optionally limit to llava-validated-usable cams)
    3. match         for each cam, find top-K WPA photos by cosine
                     similarity within MAX_RADIUS_M of the cam.
                     Writes cam_visual_matches table in DuckDB.

Outputs end up in DuckDB so they're queryable + joinable. Embeddings
are stored as FLOAT[] arrays (DuckDB native).

Usage:
    python -m server.embed_visual embed-wpa
    python -m server.embed_visual embed-cams --only-usable
    python -m server.embed_visual match --max-radius-m 200 --top-k 3
"""
from __future__ import annotations

import argparse
import io
import sys
import time
from pathlib import Path

import duckdb
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "photos.duckdb"
WPA_DIR = ROOT / "public" / "photos_1940s"
CAM_DIR = ROOT / "data" / "cam_snapshots"

# CLIP ViT-B/32 — 150 MB, 512-dim embeddings, runs at ~80 imgs/sec on
# the 3070. Cross-domain robustness is good (trained on web-scale image
# diversity including historic photos).
DEFAULT_MODEL = "clip-ViT-B-32"
EMBED_DIM = 512
BATCH_SIZE = 32

EMBEDDINGS_SCHEMA = """
CREATE TABLE IF NOT EXISTS image_embeddings (
  kind        VARCHAR,           -- 'wpa' | 'cam'
  key         VARCHAR,           -- bin (for wpa) or cam_id (for cam)
  model       VARCHAR,
  embedding   FLOAT[],
  embedded_at BIGINT,
  PRIMARY KEY (kind, key)
);

CREATE TABLE IF NOT EXISTS cam_visual_matches (
  cam_id      VARCHAR,
  bin         VARCHAR,
  similarity  DOUBLE,
  rank        INTEGER,
  distance_m  DOUBLE,
  model       VARCHAR,
  matched_at  BIGINT,
  PRIMARY KEY (cam_id, bin)
);
"""


def load_model(model_name: str):
    """Lazy import of sentence_transformers — keeps the rest of the
    server scripts importable without dragging torch into them."""
    from sentence_transformers import SentenceTransformer
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"loading {model_name} on {device}", flush=True)
    model = SentenceTransformer(model_name, device=device)
    return model


def open_image(path: Path) -> Image.Image | None:
    try:
        im = Image.open(path).convert("RGB")
        # CLIP's vision encoder downsamples to 224×224 internally; we
        # don't need to pre-resize, but a tiny image is suspicious.
        if min(im.size) < 32:
            return None
        return im
    except Exception as e:
        print(f"  WARN cannot read {path.name}: {e}", flush=True)
        return None


def embed_batch(model, images: list[Image.Image]) -> np.ndarray:
    arr = model.encode(images, batch_size=BATCH_SIZE, convert_to_numpy=True,
                       show_progress_bar=False, normalize_embeddings=True)
    return arr.astype(np.float32)


def cmd_embed_wpa(args: argparse.Namespace) -> None:
    if not DB_PATH.exists():
        sys.exit(f"missing DB at {DB_PATH}")
    con = duckdb.connect(str(DB_PATH))
    con.execute(EMBEDDINGS_SCHEMA)

    # Pull every BIN with a downloaded photo; skip ones already embedded
    # for this model (resume).
    rows = con.execute("""
        SELECT t.bin, t.photo_url FROM tax_photos t
        LEFT JOIN image_embeddings e ON e.kind='wpa' AND e.key=t.bin AND e.model=?
        WHERE e.key IS NULL
    """, [args.model]).fetchall()

    if not rows:
        n = con.execute("SELECT count(*) FROM image_embeddings WHERE kind='wpa' AND model=?",
                        [args.model]).fetchone()[0]
        print(f"nothing to do — {n} WPA photos already embedded with {args.model}")
        con.close()
        return

    print(f"embedding {len(rows)} WPA photos with {args.model}", flush=True)
    model = load_model(args.model)

    batch_imgs: list[Image.Image] = []
    batch_keys: list[str] = []
    written = 0
    skipped = 0
    start = time.time()

    def flush():
        nonlocal written
        if not batch_imgs:
            return
        embs = embed_batch(model, batch_imgs)
        rows_to_write = [
            (
                "wpa", batch_keys[i], args.model,
                embs[i].tolist(),
                int(time.time()),
            )
            for i in range(len(batch_imgs))
        ]
        con.executemany(
            "INSERT INTO image_embeddings (kind, key, model, embedding, embedded_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET "
            "embedding=excluded.embedding, embedded_at=excluded.embedded_at",
            rows_to_write,
        )
        written += len(batch_imgs)
        batch_imgs.clear()
        batch_keys.clear()

    for bin_, photo_url in rows:
        path = ROOT / "public" / photo_url.lstrip("/")
        im = open_image(path) if path.exists() else None
        if im is None:
            skipped += 1
            continue
        batch_imgs.append(im)
        batch_keys.append(bin_)
        if len(batch_imgs) >= BATCH_SIZE:
            flush()
            rate = written / max(0.1, time.time() - start)
            print(f"  written={written}/{len(rows)}  skipped={skipped}  ({rate:.1f}/s)", flush=True)
    flush()

    elapsed = time.time() - start
    print(f"\ndone — {written} WPA embeddings in {elapsed:.1f}s, skipped {skipped}", flush=True)
    con.close()


def cmd_embed_cams(args: argparse.Namespace) -> None:
    if not DB_PATH.exists():
        sys.exit(f"missing DB at {DB_PATH}")
    if not CAM_DIR.exists():
        sys.exit(f"missing {CAM_DIR}")
    con = duckdb.connect(str(DB_PATH))
    con.execute(EMBEDDINGS_SCHEMA)

    # Pick which cams to embed. By default: every snapshot on disk that
    # isn't already embedded. With --only-usable: also require llava
    # marked the cam usable AND there's at least one pre-1942 footprint
    # within --max-radius-m of the cam (no point embedding a cam with
    # nothing to match against).
    only_usable_join = ""
    only_usable_where = ""
    if args.only_usable:
        only_usable_join = "JOIN cam_validations v ON v.cam_id=c.cam_id"
        only_usable_where = "AND v.usable=TRUE AND v.confidence>=0.5"

    candidates = con.execute(f"""
        SELECT c.cam_id FROM cameras c {only_usable_join}
        LEFT JOIN image_embeddings e ON e.kind='cam' AND e.key=c.cam_id AND e.model=?
        WHERE e.key IS NULL {only_usable_where}
    """, [args.model]).fetchall()
    cam_ids = [r[0] for r in candidates]

    targets: list[tuple[str, Path]] = []
    for cid in cam_ids:
        p = CAM_DIR / f"{cid}.jpg"
        if p.exists():
            targets.append((cid, p))

    if not targets:
        print("nothing to do — all candidate cams already embedded")
        con.close()
        return

    print(f"embedding {len(targets)} cam snapshots with {args.model}", flush=True)
    model = load_model(args.model)

    batch_imgs: list[Image.Image] = []
    batch_keys: list[str] = []
    written = 0
    skipped = 0
    start = time.time()

    def flush():
        nonlocal written
        if not batch_imgs:
            return
        embs = embed_batch(model, batch_imgs)
        rows_to_write = [
            ("cam", batch_keys[i], args.model, embs[i].tolist(), int(time.time()))
            for i in range(len(batch_imgs))
        ]
        con.executemany(
            "INSERT INTO image_embeddings (kind, key, model, embedding, embedded_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET "
            "embedding=excluded.embedding, embedded_at=excluded.embedded_at",
            rows_to_write,
        )
        written += len(batch_imgs)
        batch_imgs.clear()
        batch_keys.clear()

    for cid, path in targets:
        im = open_image(path)
        if im is None:
            skipped += 1
            continue
        batch_imgs.append(im)
        batch_keys.append(cid)
        if len(batch_imgs) >= BATCH_SIZE:
            flush()
            rate = written / max(0.1, time.time() - start)
            print(f"  written={written}/{len(targets)}  skipped={skipped}  ({rate:.1f}/s)", flush=True)
    flush()
    elapsed = time.time() - start
    print(f"\ndone — {written} cam embeddings in {elapsed:.1f}s, skipped {skipped}", flush=True)
    con.close()


def cmd_match(args: argparse.Namespace) -> None:
    """For each cam (with embedding), find top-K WPA photos within
    --max-radius-m, ranked by cosine similarity."""
    if not DB_PATH.exists():
        sys.exit(f"missing DB at {DB_PATH}")
    con = duckdb.connect(str(DB_PATH))
    con.execute(EMBEDDINGS_SCHEMA)

    # Pull all cam embeddings + their lat/lng.
    cam_rows = con.execute("""
        SELECT e.key, e.embedding, c.lat, c.lng FROM image_embeddings e
        JOIN cameras c ON c.cam_id = e.key
        WHERE e.kind='cam' AND e.model=? AND c.lat IS NOT NULL
    """, [args.model]).fetchall()
    if not cam_rows:
        sys.exit(f"no cam embeddings for model {args.model} — run embed-cams first")

    # Pull all WPA embeddings + footprint centroids.
    wpa_rows = con.execute("""
        SELECT e.key, e.embedding, f.centroid_lat, f.centroid_lon
        FROM image_embeddings e
        JOIN footprints_1940s f ON f.bin = e.key
        WHERE e.kind='wpa' AND e.model=? AND f.centroid_lat IS NOT NULL
    """, [args.model]).fetchall()
    if not wpa_rows:
        sys.exit(f"no WPA embeddings for model {args.model} — run embed-wpa first")

    print(f"matching {len(cam_rows)} cams against {len(wpa_rows)} WPA photos "
          f"(radius={args.max_radius_m}m, top_k={args.top_k})", flush=True)

    # Stack into matrices for vectorized math.
    wpa_keys = [r[0] for r in wpa_rows]
    wpa_emb = np.asarray([r[1] for r in wpa_rows], dtype=np.float32)        # (Nw, 512)
    wpa_lat = np.asarray([r[2] for r in wpa_rows], dtype=np.float32)        # (Nw,)
    wpa_lon = np.asarray([r[3] for r in wpa_rows], dtype=np.float32)        # (Nw,)

    M_PER_DEG = 111320.0
    matches_to_write: list[tuple] = []
    now = int(time.time())

    for cid, cam_emb, clat, clng in cam_rows:
        cam_v = np.asarray(cam_emb, dtype=np.float32)
        # Geographic filter: equirectangular distance in meters.
        dlat = (wpa_lat - clat) * M_PER_DEG
        dlon = (wpa_lon - clng) * M_PER_DEG * np.cos(np.radians(clat))
        dist = np.sqrt(dlat * dlat + dlon * dlon)
        in_radius = dist <= args.max_radius_m
        if not np.any(in_radius):
            continue
        # Cosine similarity (embeddings are L2-normalized → dot product).
        sims = wpa_emb[in_radius] @ cam_v
        cand_idxs = np.where(in_radius)[0]
        # Top-k by similarity descending.
        order = np.argsort(-sims)[:args.top_k]
        for rank, oi in enumerate(order, start=1):
            wpa_idx = cand_idxs[oi]
            matches_to_write.append((
                cid, wpa_keys[wpa_idx],
                float(sims[oi]), rank,
                float(dist[wpa_idx]),
                args.model, now,
            ))

    # Wipe old matches for this model before re-inserting (idempotent re-run).
    con.execute("DELETE FROM cam_visual_matches WHERE model = ?", [args.model])
    if matches_to_write:
        con.executemany(
            "INSERT INTO cam_visual_matches (cam_id, bin, similarity, rank, distance_m, model, matched_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            matches_to_write,
        )

    n_pairs = len(matches_to_write)
    n_cams_lit = len({m[0] for m in matches_to_write})
    print(f"\nwrote {n_pairs} matches across {n_cams_lit} cams", flush=True)

    # Quick distribution
    if matches_to_write:
        sims = np.asarray([m[2] for m in matches_to_write])
        print(f"similarity: min={sims.min():.3f} max={sims.max():.3f} "
              f"mean={sims.mean():.3f} p90={np.percentile(sims, 90):.3f}", flush=True)
    con.close()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    ew = sub.add_parser("embed-wpa", help="CLIP-embed every downloaded WPA photo")
    ew.add_argument("--model", default=DEFAULT_MODEL)
    ew.set_defaults(fn=cmd_embed_wpa)

    ec = sub.add_parser("embed-cams", help="CLIP-embed every cam snapshot on disk")
    ec.add_argument("--model", default=DEFAULT_MODEL)
    ec.add_argument("--only-usable", action="store_true",
                    help="restrict to llava-validated-usable cams")
    ec.set_defaults(fn=cmd_embed_cams)

    mt = sub.add_parser("match", help="cosine-match every cam against nearby WPA photos")
    mt.add_argument("--model", default=DEFAULT_MODEL)
    mt.add_argument("--max-radius-m", type=float, default=200.0)
    mt.add_argument("--top-k", type=int, default=3)
    mt.set_defaults(fn=cmd_match)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
