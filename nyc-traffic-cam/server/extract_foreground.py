"""extract_foreground.py — background-subtract live cam frames.

The /rewind "mash" is: 1940 WPA photo as static background, with people
and cars from the 2026 cam frame composited on top. Background
subtraction is the cheap path — given two frames of the SAME cam taken
minutes apart, anything that's pixel-changed is something that moved
(a car, a pedestrian). Save those changed pixels as RGBA with alpha,
the frontend pastes onto the WPA background.

This script:
  1. For each cam (or a single one via --cam-id), fetch a fresh frame.
  2. Compare it to the existing snapshot in data/cam_snapshots/.
  3. Build a foreground mask (changed pixels, dilated + smoothed).
  4. Extract those pixels with alpha from the new frame.
  5. Save to public/cam_foreground/<cam_id>.png  (RGBA PNG).
  6. Update the on-disk snapshot to the new frame so the next run
     compares against this one (rolling reference).

Output gets gitignored — it's regeneratable + heavy.

Usage:
    python -m server.extract_foreground --cam-id <uuid>     # single cam
    python -m server.extract_foreground --visual-matched    # cams with CLIP matches
    python -m server.extract_foreground --validated-usable  # all 329 usable cams
    python -m server.extract_foreground --threshold 30 --dilate 4
"""
from __future__ import annotations

import argparse
import asyncio
import io
import sys
import time
from pathlib import Path

import duckdb
import httpx
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "photos.duckdb"
SNAPSHOTS_DIR = ROOT / "data" / "cam_snapshots"
OUT_DIR = ROOT / "public" / "cam_foreground"

NYCTMC_IMAGE = "https://webcams.nyctmc.org/api/cameras/{cam_id}/image"
DEFAULT_THRESHOLD = 28
DEFAULT_DILATE_PX = 3
DEFAULT_BLUR_PX = 1
MIN_BYTES = 4_000


async def fetch_frame(client: httpx.AsyncClient, cam_id: str) -> bytes | None:
    url = NYCTMC_IMAGE.format(cam_id=cam_id) + f"?t={int(time.time())}"
    try:
        r = await client.get(url, timeout=20.0)
    except httpx.HTTPError:
        return None
    if r.status_code != 200 or len(r.content) < MIN_BYTES or not r.content.startswith(b"\xff\xd8"):
        return None
    return r.content


def extract_foreground(prev_jpeg: bytes, new_jpeg: bytes,
                       threshold: int, dilate_px: int, blur_px: int) -> Image.Image | None:
    """Return RGBA PIL Image with foreground pixels visible + bg fully transparent."""
    try:
        prev_im = Image.open(io.BytesIO(prev_jpeg)).convert("RGB")
        new_im = Image.open(io.BytesIO(new_jpeg)).convert("RGB")
    except Exception:
        return None

    # Resize prev to new's size if they drifted (shouldn't happen but defensive).
    if prev_im.size != new_im.size:
        prev_im = prev_im.resize(new_im.size, Image.LANCZOS)

    prev_arr = np.asarray(prev_im, dtype=np.int16)
    new_arr = np.asarray(new_im, dtype=np.int16)

    # Per-pixel max channel difference. Robust to lighting drift on a
    # single channel — if R changed but G/B held, that's usually noise.
    diff = np.abs(new_arr - prev_arr).max(axis=-1)            # (H, W)
    mask = (diff > threshold).astype(np.uint8) * 255

    # Smooth + dilate via PIL filters — cheap, no scipy dependency.
    mask_im = Image.fromarray(mask, mode="L")
    if dilate_px > 0:
        mask_im = mask_im.filter(ImageFilter.MaxFilter(dilate_px * 2 + 1))
    if blur_px > 0:
        mask_im = mask_im.filter(ImageFilter.GaussianBlur(radius=blur_px))

    # Compose RGBA: foreground RGB from new frame, alpha from mask.
    rgba = new_im.convert("RGBA")
    rgba.putalpha(mask_im)
    return rgba


def select_cams(con: duckdb.DuckDBPyConnection, args: argparse.Namespace) -> list[str]:
    if args.cam_id:
        return [args.cam_id]
    if args.visual_matched:
        rows = con.execute(
            "SELECT DISTINCT cam_id FROM cam_visual_matches WHERE rank=1"
        ).fetchall()
        return [r[0] for r in rows]
    if args.validated_usable:
        rows = con.execute("""
            SELECT cam_id FROM cam_validations
            WHERE usable=TRUE AND confidence>=0.5
        """).fetchall()
        return [r[0] for r in rows]
    sys.exit("specify --cam-id <uuid> or --visual-matched or --validated-usable")


async def process_one(cam_id: str, client: httpx.AsyncClient,
                      args: argparse.Namespace) -> tuple[str, str]:
    out_path = OUT_DIR / f"{cam_id}.png"

    if args.capture_pair:
        # Take TWO fresh frames `pair-gap-sec` apart so lighting matches —
        # only true motion survives the diff. Avoids the 4-hour-old
        # reference problem entirely.
        ref_blob = await fetch_frame(client, cam_id)
        if not ref_blob:
            return (cam_id, "ref-fetch-fail")
        await asyncio.sleep(args.pair_gap_sec)
        new_blob = await fetch_frame(client, cam_id)
        if not new_blob:
            return (cam_id, "new-fetch-fail")
    else:
        snap_path = SNAPSHOTS_DIR / f"{cam_id}.jpg"
        if not snap_path.exists():
            return (cam_id, "no-prior-snapshot")
        new_blob = await fetch_frame(client, cam_id)
        if not new_blob:
            return (cam_id, "fetch-fail")
        ref_blob = snap_path.read_bytes()

    rgba = extract_foreground(ref_blob, new_blob, args.threshold,
                              args.dilate, args.blur)
    if rgba is None:
        return (cam_id, "decode-fail")

    alpha_arr = np.asarray(rgba.split()[-1])
    fg_pct = (alpha_arr > 32).sum() / alpha_arr.size * 100

    rgba.save(out_path, "PNG", optimize=True)
    # In stale-reference mode, roll the snapshot forward so next run
    # diffs against today's frame, not this morning's.
    if not args.capture_pair and not args.no_roll:
        snap_path = SNAPSHOTS_DIR / f"{cam_id}.jpg"
        snap_path.write_bytes(new_blob)
    return (cam_id, f"ok fg={fg_pct:.1f}%")


async def main_async(args: argparse.Namespace) -> None:
    if not DB_PATH.exists():
        sys.exit(f"missing DB at {DB_PATH}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect(str(DB_PATH), read_only=True)
    cam_ids = select_cams(con, args)
    con.close()

    print(f"extracting foreground for {len(cam_ids)} cams "
          f"(threshold={args.threshold}, dilate={args.dilate}px, blur={args.blur}px)",
          flush=True)

    sem = asyncio.Semaphore(args.concurrency)
    summary: dict[str, int] = {}

    async with httpx.AsyncClient(follow_redirects=True) as client:
        async def worker(cam_id: str):
            async with sem:
                cid, status = await process_one(cam_id, client, args)
                bucket = status.split(" ")[0]
                summary[bucket] = summary.get(bucket, 0) + 1
                # Echo per-cam result for the small visual-matched set.
                if len(cam_ids) <= 20:
                    print(f"  {cid[:8]}  {status}", flush=True)

        await asyncio.gather(*(worker(c) for c in cam_ids))

    print(f"\ndone — {summary}", flush=True)
    print(f"PNGs in {OUT_DIR.relative_to(ROOT)}", flush=True)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--cam-id", help="single cam UUID")
    g.add_argument("--visual-matched", action="store_true",
                   help="cams with at least one CLIP visual match (rank=1)")
    g.add_argument("--validated-usable", action="store_true",
                   help="all llava-validated-usable cams (~329)")
    p.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD,
                   help="per-pixel max-channel-diff threshold (0-255)")
    p.add_argument("--dilate", type=int, default=DEFAULT_DILATE_PX,
                   help="mask dilation radius in pixels")
    p.add_argument("--blur", type=int, default=DEFAULT_BLUR_PX,
                   help="gaussian blur radius for mask edges")
    p.add_argument("--concurrency", type=int, default=8)
    p.add_argument("--no-roll", action="store_true",
                   help="(stale-ref mode) don't update the reference snapshot after extraction")
    p.add_argument("--capture-pair", action="store_true",
                   help="take TWO fresh frames N seconds apart instead of using stored snapshot")
    p.add_argument("--pair-gap-sec", type=float, default=20.0,
                   help="seconds between the pair of fresh captures (default 20)")
    args = p.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
