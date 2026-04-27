"""check_cameras.py — health-check every NYC DOT camera in cameras.json.

For each camera we probe the image endpoint (twice, ~3s apart) and
classify:

    healthy   — both probes returned 200 + non-empty JPEG, frames differ
                (camera is online and the feed is moving)
    frozen    — both probes returned the same exact bytes (camera is
                online but the feed is stuck on one frame)
    empty     — 200 but empty body
    broken    — non-200 status
    timeout   — both probes timed out

Run:
    python -m server.check_cameras                # full sweep
    python -m server.check_cameras --limit 30     # smoke test
    python -m server.check_cameras --concurrency 16

Outputs:
    data/cam_health.json   — per-camera result + summary

Idempotent (safe to re-run); takes ~2-4 min for the full ~960-cam sweep
at concurrency=16. No API key needed.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT = DATA_DIR / "cam_health.json"
# Slim mirror baked into the frontend bundle. The full per-camera report
# stays under data/ for ops; the UI only needs the frozen-list so it can
# avoid surfacing dead feeds in geoguessr / lounge / turnstile.
SLIM_OUT = ROOT / "src" / "cam-health.json"
CAMERAS = ROOT / "src" / "cameras.json"

IMG_URL = "https://webcams.nyctmc.org/api/cameras/{cam_id}/image"


def classify(p1: dict[str, Any], p2: dict[str, Any]) -> str:
    """Classify based on two consecutive probe results."""
    s1, s2 = p1.get("status"), p2.get("status")
    # Both timed out
    if p1.get("timeout") and p2.get("timeout"):
        return "timeout"
    # Either reachable but non-200
    statuses = [s for s in (s1, s2) if s is not None]
    if statuses and all(s != 200 for s in statuses):
        return "broken"
    # 200 but empty body on either
    if (s1 == 200 and (p1.get("size") or 0) < 200) or (s2 == 200 and (p2.get("size") or 0) < 200):
        return "empty"
    # Both 200 with content — check whether the bytes changed
    h1, h2 = p1.get("hash"), p2.get("hash")
    if h1 and h2 and h1 == h2:
        return "frozen"
    return "healthy"


async def probe(client: httpx.AsyncClient, cam_id: str) -> dict[str, Any]:
    url = IMG_URL.format(cam_id=cam_id)
    started = time.monotonic()
    try:
        r = await client.get(url, timeout=8.0)
        latency_ms = int((time.monotonic() - started) * 1000)
        size = len(r.content) if r.content else 0
        h = hashlib.sha1(r.content).hexdigest()[:12] if size else None
        return {
            "status": r.status_code,
            "size": size,
            "hash": h,
            "latency_ms": latency_ms,
        }
    except httpx.TimeoutException:
        return {"timeout": True, "latency_ms": int((time.monotonic() - started) * 1000)}
    except Exception as e:
        return {"error": str(e)[:120], "latency_ms": int((time.monotonic() - started) * 1000)}


async def check_one(client: httpx.AsyncClient, sem: asyncio.Semaphore, cam_id: str) -> dict[str, Any]:
    async with sem:
        a = await probe(client, cam_id)
        # Small gap between probes lets the upstream feed advance,
        # which is how we tell "frozen" from "healthy".
        await asyncio.sleep(2.5)
        b = await probe(client, cam_id)
        verdict = classify(a, b)
        return {"id": cam_id, "verdict": verdict, "a": a, "b": b}


async def main(limit: int | None, concurrency: int) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if not CAMERAS.exists():
        sys.exit(f"error: {CAMERAS} missing — run `python -m server.sync_cameras` first")
    cams = json.loads(CAMERAS.read_text()).get("cameras", [])
    if limit:
        cams = cams[:limit]

    logging.info("checking %d cameras (concurrency=%d)", len(cams), concurrency)
    sem = asyncio.Semaphore(concurrency)

    results: list[dict[str, Any]] = []
    async with httpx.AsyncClient(headers={"User-Agent": "nyc-traffic-cam-healthcheck/1.0"}) as client:
        tasks = [check_one(client, sem, c["id"]) for c in cams]
        done = 0
        for fut in asyncio.as_completed(tasks):
            r = await fut
            results.append(r)
            done += 1
            if done % 50 == 0:
                logging.info("  progress: %d/%d", done, len(cams))

    # Tally
    summary: dict[str, int] = {}
    for r in results:
        summary[r["verdict"]] = summary.get(r["verdict"], 0) + 1

    # Avg latency for healthy cams (the one signal worth surfacing)
    lats = []
    for r in results:
        if r["verdict"] == "healthy":
            la = r["a"].get("latency_ms")
            lb = r["b"].get("latency_ms")
            if la is not None: lats.append(la)
            if lb is not None: lats.append(lb)
    avg_lat = int(sum(lats) / len(lats)) if lats else None

    payload = {
        "generated_at": int(time.time()),
        "total": len(results),
        "summary": summary,
        "avg_latency_ms_healthy": avg_lat,
        "cameras": {r["id"]: r for r in results},
    }
    OUT.write_text(json.dumps(payload, indent=2))
    # Slim mirror for the frontend — just the frozen list + summary, so
    # the bundle stays small. Frozen is the only verdict the UI cares
    # about right now (everything else is either healthy or already
    # excluded by the camera list itself).
    slim = {
        "generated_at": payload["generated_at"],
        "summary": summary,
        "frozen": sorted([r["id"] for r in results if r["verdict"] == "frozen"]),
    }
    SLIM_OUT.parent.mkdir(parents=True, exist_ok=True)
    SLIM_OUT.write_text(json.dumps(slim, indent=2))
    logging.info("wrote %s", OUT)
    logging.info("wrote %s (%d frozen)", SLIM_OUT, len(slim["frozen"]))
    logging.info("summary: %s · avg latency healthy=%s ms", summary, avg_lat)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--concurrency", type=int, default=16)
    args = p.parse_args()
    asyncio.run(main(limit=args.limit, concurrency=args.concurrency))
