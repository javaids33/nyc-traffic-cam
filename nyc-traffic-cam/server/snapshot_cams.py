"""snapshot_cams.py — pull a current frame from every NYC DOT cam.

For /rewind validation we need the cam's actual current view side-by-side
with the WPA tax photo so the vision LLM can decide whether the two
overlap geographically + visually. A snapshot folder is also a useful
ground truth for any later cross-cam ML work (object detection sweeps,
nightly snapshots for time-of-day comparisons, etc.).

Outputs:
    data/cam_snapshots/<cam_id>.jpg

The folder is gitignored — these are large + reproducible. Re-run
periodically to refresh. Resumable: skips cams already on disk unless
--force is passed.

Usage:
    python -m server.snapshot_cams                  # all cams, resume
    python -m server.snapshot_cams --limit 20       # smoke test
    python -m server.snapshot_cams --force          # re-download everything
    python -m server.snapshot_cams --concurrency 16
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
CAMERAS_PATH = ROOT / "src" / "cameras.json"
OUT_DIR = ROOT / "data" / "cam_snapshots"

NYCTMC_IMAGE = "https://webcams.nyctmc.org/api/cameras/{cam_id}/image"

# Smallest plausible JPEG that's not a placeholder/error frame.
MIN_BYTES = 4_000


async def fetch_one(client: httpx.AsyncClient, cam_id: str, dest: Path) -> tuple[str, bool, str]:
    """Returns (cam_id, ok, message)."""
    url = NYCTMC_IMAGE.format(cam_id=cam_id) + f"?t={int(time.time())}"
    try:
        r = await client.get(url, timeout=20.0)
    except httpx.TimeoutException:
        return (cam_id, False, "timeout")
    except httpx.HTTPError as exc:
        return (cam_id, False, f"http err: {exc}")
    if r.status_code != 200:
        return (cam_id, False, f"status {r.status_code}")
    body = r.content
    if len(body) < MIN_BYTES:
        return (cam_id, False, f"too small ({len(body)}B)")
    if not body.startswith(b"\xff\xd8"):
        return (cam_id, False, "not a JPEG")
    dest.write_bytes(body)
    return (cam_id, True, f"{len(body)//1024}KB")


async def main_async(args: argparse.Namespace) -> None:
    if not CAMERAS_PATH.exists():
        sys.exit(f"missing {CAMERAS_PATH}")
    payload = json.loads(CAMERAS_PATH.read_text(encoding="utf-8"))
    cams = payload.get("cameras") if isinstance(payload, dict) else payload
    if not cams:
        sys.exit("no cameras in cameras.json")

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    targets: list[tuple[str, Path]] = []
    for cam in cams:
        cam_id = cam["id"]
        dest = OUT_DIR / f"{cam_id}.jpg"
        if dest.exists() and not args.force:
            continue
        targets.append((cam_id, dest))
        if args.limit and len(targets) >= args.limit:
            break

    if not targets:
        print(f"nothing to do — {len(cams)} cams already on disk in {OUT_DIR.relative_to(ROOT)}")
        return

    print(f"fetching {len(targets)} of {len(cams)} cams (concurrency={args.concurrency})")

    sem = asyncio.Semaphore(args.concurrency)
    ok_count = 0
    err_count = 0
    start = time.time()

    async def worker(cam_id: str, dest: Path) -> None:
        nonlocal ok_count, err_count
        async with sem:
            async with httpx.AsyncClient(follow_redirects=True) as client:
                cid, ok, msg = await fetch_one(client, cam_id, dest)
                if ok:
                    ok_count += 1
                else:
                    err_count += 1
                done = ok_count + err_count
                if done % 25 == 0 or done == len(targets):
                    rate = done / max(0.1, time.time() - start)
                    print(f"  {done}/{len(targets)}  ok={ok_count} err={err_count}  ({rate:.1f}/s)")

    await asyncio.gather(*(worker(cid, d) for cid, d in targets))

    elapsed = time.time() - start
    print(f"\ndone — {ok_count} ok, {err_count} err in {elapsed:.1f}s ({ok_count/max(0.1,elapsed):.1f}/s)")
    print(f"snapshots in {OUT_DIR.relative_to(ROOT)}")


def main() -> None:
    p = argparse.ArgumentParser(description="Snapshot every NYC DOT cam to data/cam_snapshots/.")
    p.add_argument("--limit", type=int, default=0, help="Cap the number to fetch (0 = all).")
    p.add_argument("--concurrency", type=int, default=12, help="Parallel HTTP requests.")
    p.add_argument("--force", action="store_true", help="Re-download even if file exists.")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
