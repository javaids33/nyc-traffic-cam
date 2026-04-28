"""poi_classify_local.py — POI classification via a LOCAL vision model.

Same job as poi_classify.py, but talks to a local Ollama instance
instead of the Anthropic API. Use this when you have a GPU on the box
and don't want to pay the cloud bill (or wait for it).

Quickstart:
    # 1. Install + start Ollama (https://ollama.com).
    #    On macOS:   brew install ollama && open -a Ollama
    #    On Linux:   curl -fsSL https://ollama.com/install.sh | sh && ollama serve &

    # 2. Pull a vision model (one-time):
    ollama pull llama3.2-vision        # ~7.9 GB, default
    # OR a sharper landmark recognizer:
    ollama pull qwen2.5vl:7b           # ~6 GB
    # OR lightweight:
    ollama pull llava:7b               # ~4.7 GB

    # 3. Smoke test on 5 cams (prints to stdout, doesn't write files):
    .venv/bin/python -m server.poi_classify_local --limit 5 --dry-run

    # 4. Full sweep on all ~960 cams (resumable):
    .venv/bin/python -m server.poi_classify_local --resume

Outputs (identical schema to the Anthropic version):
    data/cam_pois.json      (full report)
    src/cam-pois.json       (frontend bundle copy)

The shared schema is defined in server/poi_taxonomy.py — both this
script and poi_classify.py emit identical records, so /poi page
lights up the moment either finishes.

Notes on speed: a 7B vision model on an M-series Mac runs ~3-8 s per
image. ~960 cams ≈ 1-2 hours single-stream. Bump --concurrency if your
box can fit multiple model contexts (it'll just queue in Ollama
otherwise — no harm, no speedup).
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
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
OUT_PATH_DAY = DATA_DIR / "cam_pois-day.json"
FRONTEND_OUT_DAY = ROOT / "src" / "cam-pois-day.json"
OUT_PATH_NIGHT = DATA_DIR / "cam_pois-night.json"
FRONTEND_OUT_NIGHT = ROOT / "src" / "cam-pois-night.json"

NYCTMC_GRAPHQL = "https://webcams.nyctmc.org/cameras/graphql"
NYCTMC_IMAGE = "https://webcams.nyctmc.org/api/cameras/{cam_id}/image"

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "qwen2.5vl:7b"

PROMPT = """\
You are looking at a still frame from a NYC DOT traffic camera.
Identify whether this camera feed is among the BEST camera feeds for
showcasing New York. Prioritize clarity, wide/interesting composition,
unobstructed iconic landmarks or skyline, good lighting, and unique
views that would make a compelling live feed.

Categories to consider:
- bridge          (Brooklyn, Manhattan, Williamsburg, Verrazano, GW, Queensboro, Triboro, etc.)
- landmark        (Empire State, Statue of Liberty, Times Square, Wall St / Stock Exchange, MSG, etc.)
- park            (Central Park, Prospect Park, Battery, Flushing Meadows)
- waterway        (Hudson, East River, harbor, kill van kull)
- tunnel          (Lincoln, Holland, Brooklyn-Battery, Queens-Midtown)
- iconic          (any uniquely New York street view — elevated subway, brownstone block, etc.)
- skyline         (sweeping cityscape view of buildings)
- intersection    (clearly identifiable major crossing)

If nothing notable is visible — or the feed is low-quality, obstructed,
or not suitable as a showcase feed — return null fields.

Return ONE valid JSON object, no other text. Be concise and aim to flag
feeds that would be best for live, public-facing viewing (high confidence
for strong candidates):
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


async def preflight(client: httpx.AsyncClient, ollama_url: str, model: str) -> None:
    """Verify Ollama is reachable and the requested model is pulled.

    Failing here is much friendlier than the alternative — getting 950
    cameras worth of timeouts because the daemon is asleep.
    """
    try:
        r = await client.get(f"{ollama_url}/api/tags", timeout=5.0)
        r.raise_for_status()
    except Exception as e:
        sys.exit(
            f"error: cannot reach Ollama at {ollama_url} ({e}).\n"
            "  start it with `ollama serve` (or open the Ollama app)\n"
            "  then re-run this command."
        )
    available = [m.get("name", "") for m in r.json().get("models", [])]
    # Allow ":latest" suffix matching — `llama3.2-vision` matches `llama3.2-vision:latest`.
    has_model = any(name.split(":")[0] == model.split(":")[0] for name in available)
    if not has_model:
        sys.exit(
            f"error: model '{model}' is not pulled.\n"
            f"  available: {', '.join(available) or '(none)'}\n"
            f"  run: ollama pull {model}"
        )
    logging.info("ollama ok (%s) · model: %s", ollama_url, model)


async def classify(
    client: httpx.AsyncClient,
    image_b64: str,
    ollama_url: str,
    model: str,
) -> dict[str, Any]:
    """Send the image to a local Ollama vision model.

    Uses /api/chat with structured-output `format: "json"` so smaller
    models don't wrap the answer in markdown fences. Parsing is still
    tolerant in case the model leaks prose.
    """
    body = {
        "model": model,
        "stream": False,
        "format": "json",
        "options": {
            "temperature": 0.1,   # low — we want consistent labeling
            # The new prompt has 12 structured fields, so we need a
            # bigger response budget than the old 4-field prompt.
            "num_predict": 400,
        },
        "messages": [
            {
                "role": "user",
                "content": PROMPT,
                "images": [image_b64],
            }
        ],
    }
    r = await client.post(f"{ollama_url}/api/chat", json=body, timeout=180.0)
    r.raise_for_status()
    msg = r.json()
    text = (msg.get("message", {}) or {}).get("content", "") or ""
    return parse_response(text)


def _write(cameras: dict[str, Any], model: str, split_by_time: bool = False) -> None:
    if not split_by_time:
        # Legacy single-file output
        payload = {
            "generated_at": int(time.time()),
            "backend": "ollama",
            "model": model,
            "cameras": cameras,
        }
        OUT_PATH.write_text(json.dumps(payload, indent=2))
        FRONTEND_OUT.write_text(json.dumps(payload, indent=2))
    else:
        # Split output by time_of_day: day and night files
        day_cams: dict[str, Any] = {}
        night_cams: dict[str, Any] = {}
        for cam_id, rec in cameras.items():
            tod = rec.get("time_of_day", "day")
            if tod in ("dusk", "dawn"):
                # Dawn/dusk go to both
                day_cams[cam_id] = rec
                night_cams[cam_id] = rec
            elif tod == "night":
                night_cams[cam_id] = rec
            else:  # day
                day_cams[cam_id] = rec
        
        # Write day
        day_payload = {
            "generated_at": int(time.time()),
            "backend": "ollama",
            "model": model,
            "cameras": day_cams,
        }
        OUT_PATH_DAY.write_text(json.dumps(day_payload, indent=2))
        FRONTEND_OUT_DAY.write_text(json.dumps(day_payload, indent=2))
        
        # Write night
        night_payload = {
            "generated_at": int(time.time()),
            "backend": "ollama",
            "model": model,
            "cameras": night_cams,
        }
        OUT_PATH_NIGHT.write_text(json.dumps(night_payload, indent=2))
        FRONTEND_OUT_NIGHT.write_text(json.dumps(night_payload, indent=2))


def _print_one(cam_id: str, name: str, rec: dict[str, Any]) -> None:
    """Stdout summary for --dry-run smoke testing."""
    flags = []
    if not rec.get("image_usable", True):
        flags.append("UNUSABLE")
    if rec.get("sun_glare"):
        flags.append("glare")
    if rec.get("lens_obstruction"):
        flags.append("lens")
    if rec.get("crowd_or_event"):
        flags.append("EVENT")
    if rec.get("skyline_visible"):
        flags.append("skyline")
    flag_str = f" [{','.join(flags)}]" if flags else ""

    extras = []
    if rec.get("landmark_name"):
        extras.append(f"landmark={rec['landmark_name']!r}")
    if rec.get("event_description"):
        extras.append(f"event={rec['event_description']!r}")

    print(
        f"  {cam_id[:8]}  {name[:38]:38s}  "
        f"scene={rec.get('scene'):12s}  "
        f"{rec.get('time_of_day'):4s}  {rec.get('weather'):5s}  "
        f"cong={rec.get('congestion'):6s}  "
        f"conf={rec.get('confidence'):3d}{flag_str}"
        + (f"  {' '.join(extras)}" if extras else "")
    )


async def run(
    limit: int | None,
    resume: bool,
    concurrency: int,
    ollama_url: str,
    model: str,
    dry_run: bool,
    split_by_time: bool = False,
) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    existing: dict[str, Any] = {}
    if resume and OUT_PATH.exists() and not dry_run:
        try:
            existing = json.loads(OUT_PATH.read_text()).get("cameras", {})
            logging.info("resume: %d cameras already classified", len(existing))
        except Exception as e:
            logging.warning("resume: couldn't read existing %s: %s", OUT_PATH, e)

    async with httpx.AsyncClient() as http:
        await preflight(http, ollama_url, model)
        # Need a names lookup for the dry-run printout — pull from the
        # local cameras.json since the GraphQL response only has lat/lng/id.
        cams = await list_cameras(http)
        if dry_run:
            try:
                src_meta = json.loads((ROOT / "src" / "cameras.json").read_text())
                names = {c["id"]: c.get("name", "") for c in src_meta.get("cameras", [])}
            except Exception:
                names = {}

        if limit:
            cams = cams[:limit]
        todo = [c for c in cams if c["id"] not in existing]
        logging.info(
            "classifying %d cameras (skipping %d already done · concurrency=%d · dry_run=%s · split_by_time=%s)",
            len(todo), len(cams) - len(todo), concurrency, dry_run, split_by_time,
        )

        sem = asyncio.Semaphore(concurrency)
        results: dict[str, Any] = dict(existing)
        done = 0
        started = time.monotonic()

        async def one(cam: dict[str, Any]) -> None:
            nonlocal done
            cid = cam["id"]
            async with sem:
                img = await fetch_image_b64(http, cid)
                if not img:
                    rec = empty_skipped_record("no_image")
                else:
                    try:
                        parsed = await classify(http, img, ollama_url, model)
                        rec = to_record(
                            parsed,
                            lat=cam.get("latitude"),
                            lng=cam.get("longitude"),
                        )
                    except Exception as e:
                        rec = empty_error_record(str(e))
                results[cid] = rec
            done += 1
            if dry_run:
                _print_one(cid, names.get(cid, ""), rec)
            if done % 10 == 0:
                elapsed = time.monotonic() - started
                rate = done / max(elapsed, 0.01)
                remaining = (len(todo) - done) / max(rate, 0.01)
                logging.info(
                    "  progress: %d/%d · %.1fs/cam · ~%.0fs left",
                    done, len(todo), 1 / max(rate, 0.01), remaining,
                )
                if not dry_run:
                    _write(results, model, split_by_time=split_by_time)

        await asyncio.gather(*(one(c) for c in todo))

        # Tally what we got — useful regardless of dry-run.
        by_scene: dict[str, int] = {}
        usable = 0
        events = 0
        skyline = 0
        for v in results.values():
            scene = v.get("scene") or "_none"
            by_scene[scene] = by_scene.get(scene, 0) + 1
            if v.get("image_usable"):
                usable += 1
            if v.get("crowd_or_event"):
                events += 1
            if v.get("skyline_visible"):
                skyline += 1
        logging.info(
            "done — %d entries · usable=%d · events=%d · skyline=%d",
            len(results), usable, events, skyline,
        )
        logging.info("  by scene: %s", by_scene)

        if dry_run:
            logging.info("dry-run: nothing written to disk")
        else:
            _write(results, model, split_by_time=split_by_time)
            if split_by_time:
                logging.info("wrote %s", OUT_PATH_DAY)
                logging.info("wrote %s", FRONTEND_OUT_DAY)
                logging.info("wrote %s", OUT_PATH_NIGHT)
                logging.info("wrote %s", FRONTEND_OUT_NIGHT)
            else:
                logging.info("wrote %s", OUT_PATH)
                logging.info("wrote %s", FRONTEND_OUT)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser(description="Classify NYC DOT cameras using a LOCAL Ollama vision model.")
    p.add_argument("--limit", type=int, default=None, help="Classify at most N cameras (default: all).")
    p.add_argument("--resume", action="store_true", help="Skip cameras already in cam_pois.json.")
    p.add_argument("--concurrency", type=int, default=1, help="Parallel inference requests (default 1; Ollama serializes them anyway).")
    p.add_argument("--ollama-url", default=DEFAULT_OLLAMA_URL, help=f"Ollama HTTP base URL (default: {DEFAULT_OLLAMA_URL}).")
    p.add_argument("--model", default=DEFAULT_MODEL, help=f"Ollama model tag (default: {DEFAULT_MODEL}).")
    p.add_argument("--dry-run", action="store_true", help="Smoke test mode: print each result, don't write files.")
    p.add_argument("--split-by-time", action="store_true", help="Split output into separate day/night JSON files (default: single file).")
    args = p.parse_args()
    asyncio.run(run(
        limit=args.limit,
        resume=args.resume,
        concurrency=args.concurrency,
        ollama_url=args.ollama_url,
        model=args.model,
        dry_run=args.dry_run,
        split_by_time=args.split_by_time,
    ))


if __name__ == "__main__":
    main()
