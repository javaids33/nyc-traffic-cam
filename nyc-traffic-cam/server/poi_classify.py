"""poi_classify.py — one-time POI classification for every NYC DOT camera.

Run once. Camera locations don't change, so the classification is
durable: a snapshot of "what notable thing is visible from each cam"
that ships with the frontend as static JSON.

Usage:
    export ANTHROPIC_API_KEY=sk-ant-...
    python -m server.poi_classify                # full sweep, all cams
    python -m server.poi_classify --limit 30     # quick sample
    python -m server.poi_classify --resume       # skip cams already classified

Outputs:
    data/cam_pois.json    — { "generated_at": ts, "cameras": { "<uuid>": {poi, category, description, confidence} } }

The script is idempotent: re-runs only re-classify cameras that aren't
already in the output JSON. The same file is read by:
- server/main.py /api/pois (fallback API surface)
- src/cam-pois.json copy (build-time bake for the frontend grid)

Cost note: ~$0.01-0.03 per image with Claude Haiku 4.5 vision; ~960
cameras = $10-30 one-time. Cache result, never re-run unless NYC DOT
adds a wave of new cameras.
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

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_PATH = DATA_DIR / "cam_pois.json"
# We also write a copy into src/ so the frontend can `import` it
# directly at build time. Same content, two homes.
FRONTEND_OUT = ROOT / "src" / "cam-pois.json"

NYCTMC_GRAPHQL = "https://webcams.nyctmc.org/cameras/graphql"
NYCTMC_IMAGE = "https://webcams.nyctmc.org/api/cameras/{cam_id}/image"

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
# Haiku is fast + cheap and plenty for "what's visible in this still"
CLASSIFIER_MODEL = "claude-haiku-4-5-20251001"

PROMPT = """\
You are looking at a still frame from a NYC DOT traffic camera.
Identify any notable visible point of interest.

Categories to consider:
- bridge          (Brooklyn, Manhattan, Williamsburg, Verrazano, GW, Queensboro, Triboro, etc.)
- landmark        (Empire State, Statue of Liberty, Times Square, Wall St / Stock Exchange, MSG, etc.)
- park            (Central Park, Prospect Park, Battery, Flushing Meadows)
- waterway        (Hudson, East River, harbor, kill van kull)
- tunnel          (Lincoln, Holland, Brooklyn-Battery, Queens-Midtown)
- iconic          (any uniquely New York street view — elevated subway, brownstone block, etc.)
- skyline         (sweeping cityscape view of buildings)
- intersection    (clearly identifiable major crossing)

If nothing notable is visible — just a generic street, highway shoulder, or unrecognizable scene — return null fields.

Return ONE valid JSON object, no other text:
{
  "poi": "<name or null>",
  "category": "<one of the categories above, or null>",
  "description": "<8-word phrase max, or null>",
  "confidence": <integer 0-100>
}
"""


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
    """Send the image to Claude and parse the structured POI response."""
    body = {
        "model": CLASSIFIER_MODEL,
        "max_tokens": 200,
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
    text = text.strip()
    # Strip ```json fences if the model used them
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    try:
        out = json.loads(text)
    except json.JSONDecodeError:
        return {"poi": None, "category": None, "description": None, "confidence": 0, "_parse_error": text[:120]}
    # normalize
    return {
        "poi": out.get("poi"),
        "category": out.get("category"),
        "description": out.get("description"),
        "confidence": int(out.get("confidence", 0) or 0),
    }


async def run(limit: int | None, resume: bool, concurrency: int) -> None:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("error: set ANTHROPIC_API_KEY before running")

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # Resume support: load existing classifications and skip them.
    existing: dict[str, Any] = {}
    if resume and OUT_PATH.exists():
        try:
            existing = json.loads(OUT_PATH.read_text()).get("cameras", {})
            logging.info("resume: %d cameras already classified", len(existing))
        except Exception as e:
            logging.warning("resume: couldn't read existing %s: %s", OUT_PATH, e)

    async with httpx.AsyncClient() as http:
        cams = await list_cameras(http)
        if limit:
            cams = cams[:limit]
        logging.info("classifying %d cameras (concurrency=%d)", len(cams), concurrency)

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
                    results[cid] = {"poi": None, "category": None, "description": None, "confidence": 0, "_skipped": "no_image"}
                else:
                    try:
                        out = await classify(http, img, key)
                    except Exception as e:
                        out = {"poi": None, "category": None, "description": None, "confidence": 0, "_error": str(e)[:120]}
                    out["_lat"] = cam.get("latitude")
                    out["_lng"] = cam.get("longitude")
                    results[cid] = out
            done += 1
            if done % 20 == 0:
                logging.info("  progress: %d/%d", done, len(cams))
                # Checkpoint: write partial results so a crash doesn't lose work
                _write(results)

        await asyncio.gather(*(one(c) for c in cams))
        _write(results)
        logging.info("done — wrote %d entries to %s", len(results), OUT_PATH)


def _write(cameras: dict[str, Any]) -> None:
    payload = {"generated_at": int(time.time()), "cameras": cameras}
    OUT_PATH.write_text(json.dumps(payload, indent=2))
    # Mirror into src/ for build-time import. The mirror is intentional:
    # the frontend bundles the JSON so production works even if the API
    # is offline (or removed entirely in the hybrid migration).
    FRONTEND_OUT.write_text(json.dumps(payload, indent=2))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser(description="Classify NYC DOT cameras by visible POI.")
    p.add_argument("--limit", type=int, default=None, help="Classify at most N cameras (default: all)")
    p.add_argument("--resume", action="store_true", help="Skip cameras already in cam_pois.json")
    p.add_argument("--concurrency", type=int, default=4, help="Parallel API calls (default 4)")
    args = p.parse_args()
    asyncio.run(run(limit=args.limit, resume=args.resume, concurrency=args.concurrency))


if __name__ == "__main__":
    main()
