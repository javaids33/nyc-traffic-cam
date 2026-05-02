"""fetch_targeted.py — Preservica fetch for a specific BBL list.

The general-purpose fetch_1940s.py walks an entire bbox, which doesn't
map onto our use case anymore: we have 6,093 cam_pairs in DuckDB telling
us EXACTLY which BBLs would unlock /rewind portals, so we fetch only
those photos. ~5 minutes for the 979 within-50m gold pairs vs hours
for a wholesale neighborhood crawl.

Resumes idempotently (skips files already on disk + DB rows marked ok).
Updates the DuckDB `tax_photos` table after each successful fetch so
the renderer can pick up the new photos without re-importing.

Usage:
    # Fetch the 979 within-50m gold pairs:
    python -m server.fetch_targeted --max-distance-m 50

    # Expand to 100m (~6k BBLs):
    python -m server.fetch_targeted --max-distance-m 100

    # One-off: an explicit BBL list:
    python -m server.fetch_targeted --bbls 1009852,1009853,1009854

    # Smoke test (5 BBLs):
    python -m server.fetch_targeted --max-distance-m 50 --limit 5
"""
from __future__ import annotations

import argparse
import asyncio
import io
import re
import sys
import time
from pathlib import Path

import duckdb
import httpx
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "photos.duckdb"
PHOTO_DIR = ROOT / "public" / "photos_1940s"

PRESERVICA_BASE = "https://nycrecords.access.preservica.com"
USER_AGENT = "nyc-traffic-cam/targeted-fetcher (https://github.com/javaids33/nyc-traffic-cam)"
IO_RE = re.compile(r"IO_[a-f0-9-]{36}")

# Polite to Preservica: keep total req/s under 3.
DEFAULT_RATE = 3.0
DEFAULT_CONCURRENCY = 4
TARGET_HEIGHT = 1024


class PoliteGate:
    """Token-bucket rate limiter with bounded concurrency."""

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


async def _get_with_retry(client: httpx.AsyncClient, gate: PoliteGate, url: str,
                          *, params=None, timeout: float, attempts: int = 4):
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
            await asyncio.sleep(2 ** i + 0.25 * i)
    return last_err


async def search_io(client, gate, filename_stem: str) -> str | None:
    r = await _get_with_retry(client, gate, f"{PRESERVICA_BASE}/", params={"s": filename_stem}, timeout=20.0)
    if isinstance(r, str):
        return None
    m = IO_RE.search(r.text)
    return m.group(0) if m else None


async def download_image(client, gate, io_uuid: str) -> tuple[bytes | None, str | None]:
    r = await _get_with_retry(client, gate, f"{PRESERVICA_BASE}/download/file/{io_uuid}", timeout=60.0)
    if isinstance(r, str):
        return None, r
    return r.content, None


def filename_stem(boro: int, block: int, lot: int) -> str:
    return f"nynyma_rec0040_{boro}_{block:05d}_{lot:04d}"


def select_targets(con: duckdb.DuckDBPyConnection, args: argparse.Namespace) -> list[dict]:
    """Decide which BBLs to fetch. Returns list of dicts with bin/boro/block/lot."""
    if args.bbls:
        bbls = [b.strip() for b in args.bbls.split(",") if b.strip()]
        rows = con.execute(
            "SELECT bin, boro, block, lot FROM footprints_1940s WHERE bbl IN ?",
            [bbls]
        ).fetchall()
    else:
        # Pull the BINs from cam_pairs joined to footprints; filter by
        # max distance. Cap to --limit if requested.
        sql = """
        SELECT DISTINCT f.bin, f.boro, f.block, f.lot, MIN(p.distance_m) AS d
        FROM footprints_1940s f
        JOIN cam_pairs p ON p.bin = f.bin
        WHERE p.distance_m <= ?
        GROUP BY f.bin, f.boro, f.block, f.lot
        ORDER BY d ASC
        """
        rows = con.execute(sql, [args.max_distance_m]).fetchall()

    targets = []
    for row in rows:
        bin_, boro, block, lot = row[0], row[1], row[2], row[3]
        if not all([bin_, boro is not None, block is not None, lot is not None]):
            continue
        targets.append({
            "bin": str(bin_),
            "boro": int(boro),
            "block": int(block),
            "lot": int(lot),
            "stem": filename_stem(int(boro), int(block), int(lot)),
        })
        if args.limit and len(targets) >= args.limit:
            break
    return targets


async def process_one(target: dict, client, gate, db_writes: list, target_height: int) -> tuple[str, str]:
    stem = target["stem"]
    out_path = PHOTO_DIR / f"{stem}.jpg"

    if out_path.exists() and out_path.stat().st_size > 4000:
        return (target["bin"], "cached")

    io_uuid = await search_io(client, gate, stem)
    if not io_uuid:
        return (target["bin"], "no-match")

    blob, err = await download_image(client, gate, io_uuid)
    if not blob:
        return (target["bin"], f"download-err: {err}")

    try:
        im = Image.open(io.BytesIO(blob))
        w, h = im.size
        if h > target_height:
            new_w = int(w * target_height / h)
            im = im.resize((new_w, target_height), Image.LANCZOS)
        if im.mode != "L":
            im = im.convert("L")
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85, optimize=True)
        out_bytes = buf.getvalue()
        out_path.write_bytes(out_bytes)
        db_writes.append({
            "bin": target["bin"],
            "photo_url": f"/photos_1940s/{stem}.jpg",
            "width": im.size[0],
            "height": im.size[1],
            "size_bytes": len(out_bytes),
        })
        return (target["bin"], "ok")
    except Exception as e:
        return (target["bin"], f"decode-err: {e!r}")


async def main_async(args: argparse.Namespace) -> None:
    if not DB_PATH.exists():
        sys.exit(f"missing DB at {DB_PATH} — run server.photo_db init + import-local + match-cams first")
    PHOTO_DIR.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect(str(DB_PATH))
    targets = select_targets(con, args)
    if not targets:
        sys.exit("no targets — check --max-distance-m or --bbls")
    print(f"fetching {len(targets)} BBLs from Preservica (rate={args.rate}/s, concurrency={args.concurrency})", flush=True)

    gate = PoliteGate(args.concurrency, args.rate)
    db_writes: list[dict] = []
    headers = {"User-Agent": USER_AGENT}
    summary: dict[str, int] = {}
    start = time.monotonic()
    done = 0

    async with httpx.AsyncClient(headers=headers, follow_redirects=True) as client:
        async def worker(t: dict):
            nonlocal done
            res = await process_one(t, client, gate, db_writes, args.target_height)
            done += 1
            summary[res[1]] = summary.get(res[1], 0) + 1
            if done % 25 == 0 or done == len(targets):
                rate = done / max(0.1, time.monotonic() - start)
                ok = summary.get("ok", 0) + summary.get("cached", 0)
                print(f"  {done}/{len(targets)}  ok+cached={ok}  ({rate:.2f}/s)  "
                      f"summary={summary}", flush=True)

        await asyncio.gather(*(worker(t) for t in targets))

    # Bulk upsert into tax_photos
    if db_writes:
        cols = ["bin", "photo_url", "width", "height", "size_bytes"]
        placeholders = ", ".join(["?"] * len(cols))
        excl = ", ".join(f"{c}=excluded.{c}" for c in cols)
        con.executemany(
            f"INSERT INTO tax_photos ({', '.join(cols)}) VALUES ({placeholders}) "
            f"ON CONFLICT DO UPDATE SET {excl}",
            [tuple(w[c] for c in cols) for w in db_writes],
        )
        print(f"db: upserted {len(db_writes)} tax_photos rows", flush=True)
    con.close()

    elapsed = time.monotonic() - start
    print(f"\ndone — {done} BBLs in {elapsed:.1f}s — {summary}", flush=True)
    print(f"photos in {PHOTO_DIR.relative_to(ROOT)}", flush=True)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--max-distance-m", type=float, default=50.0,
                   help="Max cam-to-building distance (joins footprints + cam_pairs). Default 50m.")
    p.add_argument("--bbls", type=str, default=None,
                   help="Comma-separated BBL list (overrides --max-distance-m).")
    p.add_argument("--limit", type=int, default=0, help="Cap fetches this run (0 = all).")
    p.add_argument("--rate", type=float, default=DEFAULT_RATE, help="Preservica req/s.")
    p.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY, help="Parallel HTTP requests.")
    p.add_argument("--target-height", type=int, default=TARGET_HEIGHT,
                   help="Downscale photos to this pixel height (preserves aspect).")
    args = p.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
