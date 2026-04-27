"""poi_classify.py — POI classification via Anthropic Claude vision.

Cloud counterpart to poi_classify_local.py. Use this when you don't
have a local GPU (or don't want to wait 1-2 hours for an Ollama
sweep). Costs ~$0.01-0.03 per image with Haiku 4.5; ~960 cams = $10-30
one-time.

The schema, prompt, and parsing all live in server/poi_taxonomy.py
and are shared between both backends — output JSON is identical and
either can be used to bake src/cam-pois.json.

Usage:
    export ANTHROPIC_API_KEY=sk-ant-...
    python -m server.poi_classify                # full sweep
    python -m server.poi_classify --limit 5 --dry-run   # smoke test
    python -m server.poi_classify --resume       # incremental

Outputs:
    data/cam_pois.json      (full report)
    src/cam-pois.json       (frontend bundle copy)
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx

from .poi_taxonomy import (
    PROMPT,
    empty_error_record,
    empty_skipped_record,
    parse_response,
    to_record,
)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_PATH = DATA_DIR / "cam_pois.json"
FRONTEND_OUT = ROOT / "src" / "cam-pois.json"

NYCTMC_GRAPHQL = "https://webcams.nyctmc.org/cameras/graphql"
NYCTMC_IMAGE = "https://webcams.nyctmc.org/api/cameras/{cam_id}/image"

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
# Haiku is fast + cheap and plenty for "what's visible in this still"
CLASSIFIER_MODEL = "claude-haiku-4-5-20251001"


async def list_cameras(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    """Pull the full live cam list from NYCTMC's GraphQL endpoint."""
    q = {"query": "{ cameras { id latitude longitude isOnline } }"}
    r = await client.post(NYCTMC_GRAPHQL, json=q, timeout=30.0)
    r.raise_for_status()
    cams = r.json().get("data", {}).get("cameras", []) or []
    return [c for c in cams if c.get("isOnline")]


async def fetch_image_b64(client: httpx.AsyncClient, cam_id: str) -> str | None:
    """Pull one frame from a camera; return base64-encoded JPEG."""
    url = NYCTMC_IMAGE.format(cam_id=cam_id)
    try:
        r = await client.get(url, timeout=15.0)
        if r.status_code != 200 or not r.content:
            return None
        return base64.standard_b64encode(r.content).decode("ascii")
    except Exception:
        return None


async def classify(client: httpx.AsyncClient, image_b64: str, key: str) -> dict[str, Any]:
    """Send the image to Claude and parse the structured response."""
    body = {
        "model": CLASSIFIER_MODEL,
        # 14 structured fields fit comfortably under 400 tokens.
        "max_tokens": 400,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": "image/jpeg", "data": image_b64},
                    },
                    {"type": "text", "text": PROMPT},
                ],
            }
        ],
    }
    headers = {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    r = await client.post(ANTHROPIC_API_URL, headers=headers, json=body, timeout=60.0)
    r.raise_for_status()
    msg = r.json()
    text = "".join(b.get("text", "") for b in msg.get("content", []) if b.get("type") == "text")
    return parse_response(text)


def _print_one(cam_id: str, rec: dict[str, Any]) -> None:
    flags = []
    if not rec.get("image_usable", True): flags.append("UNUSABLE")
    if rec.get("sun_glare"): flags.append("glare")
    if rec.get("lens_obstruction"): flags.append("lens")
    if rec.get("crowd_or_event"): flags.append("EVENT")
    if rec.get("skyline_visible"): flags.append("skyline")
    flag_str = f" [{','.join(flags)}]" if flags else ""

    extras = []
    if rec.get("landmark_name"): extras.append(f"landmark={rec['landmark_name']!r}")
    if rec.get("event_description"): extras.append(f"event={rec['event_description']!r}")

    print(
        f"  {cam_id[:8]}  scene={rec.get('scene'):12s}  "
        f"{rec.get('time_of_day'):4s}  {rec.get('weather'):5s}  "
        f"cong={rec.get('congestion'):6s}  conf={rec.get('confidence'):3d}{flag_str}"
        + (f"  {' '.join(extras)}" if extras else "")
    )


async def run(limit: int | None, resume: bool, concurrency: int, dry_run: bool) -> None:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("error: set ANTHROPIC_API_KEY before running")

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    existing: dict[str, Any] = {}
    if resume and OUT_PATH.exists() and not dry_run:
        try:
            existing = json.loads(OUT_PATH.read_text()).get("cameras", {})
            logging.info("resume: %d cameras already classified", len(existing))
        except Exception as e:
            logging.warning("resume: couldn't read existing %s: %s", OUT_PATH, e)

    async with httpx.AsyncClient() as http:
        cams = await list_cameras(http)
        if limit:
            cams = cams[:limit]
        logging.info("classifying %d cameras (concurrency=%d · dry_run=%s)", len(cams), concurrency, dry_run)

        sem = asyncio.Semaphore(concurrency)
        results: dict[str, Any] = dict(existing)
        done = 0

        async def one(cam: dict[str, Any]) -> None:
            nonlocal done
            cid = cam["id"]
            if cid in existing:
                return
            async with sem:
                img = await fetch_image_b64(http, cid)
                if not img:
                    rec = empty_skipped_record("no_image")
                else:
                    try:
                        parsed = await classify(http, img, key)
                        rec = to_record(parsed, lat=cam.get("latitude"), lng=cam.get("longitude"))
                    except Exception as e:
                        rec = empty_error_record(str(e))
                results[cid] = rec
            done += 1
            if dry_run:
                _print_one(cid, rec)
            if done % 20 == 0:
                logging.info("  progress: %d/%d", done, len(cams))
                if not dry_run:
                    _write(results)

        await asyncio.gather(*(one(c) for c in cams))

        if dry_run:
            logging.info("dry-run: nothing written to disk (%d entries classified)", len(results))
        else:
            _write(results)
            logging.info("done — wrote %d entries to %s", len(results), OUT_PATH)


def _write(cameras: dict[str, Any]) -> None:
    payload = {
        "generated_at": int(time.time()),
        "backend": "anthropic",
        "model": CLASSIFIER_MODEL,
        "cameras": cameras,
    }
    OUT_PATH.write_text(json.dumps(payload, indent=2))
    # Mirror into src/ for build-time import. The mirror is intentional:
    # the frontend bundles the JSON so production works even if the API
    # is offline (or removed entirely in the hybrid migration).
    FRONTEND_OUT.write_text(json.dumps(payload, indent=2))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser(description="Classify NYC DOT cameras by visible POI (Anthropic Claude).")
    p.add_argument("--limit", type=int, default=None, help="Classify at most N cameras (default: all)")
    p.add_argument("--resume", action="store_true", help="Skip cameras already in cam_pois.json")
    p.add_argument("--concurrency", type=int, default=4, help="Parallel API calls (default 4)")
    p.add_argument("--dry-run", action="store_true", help="Smoke test mode: print results, don't write files.")
    args = p.parse_args()
    asyncio.run(run(limit=args.limit, resume=args.resume, concurrency=args.concurrency, dry_run=args.dry_run))


if __name__ == "__main__":
    main()
