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

    # 3. Smoke test on 5 cams:
    .venv/bin/python -m server.poi_classify_local --limit 5

    # 4. Full sweep on all ~960 cams (resumable):
    .venv/bin/python -m server.poi_classify_local --resume

Outputs (identical schema to the Anthropic version):
    data/cam_pois.json      (full report)
    src/cam-pois.json       (frontend bundle copy)

The shared schema means /poi page lights up the moment this finishes —
no frontend changes needed.

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

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_PATH = DATA_DIR / "cam_pois.json"
FRONTEND_OUT = ROOT / "src" / "cam-pois.json"

NYCTMC_GRAPHQL = "https://webcams.nyctmc.org/cameras/graphql"
NYCTMC_IMAGE = "https://webcams.nyctmc.org/api/cameras/{cam_id}/image"

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "llama3.2-vision"

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

    Uses /api/chat with the structured-output `format: "json"` flag so
    smaller models don't wrap the answer in markdown fences. We still
    try to recover from "json prose" output the model occasionally
    leaks through.
    """
    body = {
        "model": model,
        "stream": False,
        "format": "json",
        "options": {
            "temperature": 0.1,   # low — we want consistent labeling
            "num_predict": 200,   # short response
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
    text = text.strip()
    # Belt-and-suspenders: strip ```json fences if a stubborn model used them.
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    try:
        out = json.loads(text)
    except json.JSONDecodeError:
        return {
            "poi": None, "category": None, "description": None,
            "confidence": 0, "_parse_error": text[:160],
        }
    return {
        "poi": out.get("poi"),
        "category": out.get("category"),
        "description": out.get("description"),
        "confidence": int(out.get("confidence", 0) or 0),
    }


def _write(cameras: dict[str, Any], model: str) -> None:
    payload = {
        "generated_at": int(time.time()),
        "backend": "ollama",
        "model": model,
        "cameras": cameras,
    }
    OUT_PATH.write_text(json.dumps(payload, indent=2))
    FRONTEND_OUT.write_text(json.dumps(payload, indent=2))


async def run(
    limit: int | None,
    resume: bool,
    concurrency: int,
    ollama_url: str,
    model: str,
) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    existing: dict[str, Any] = {}
    if resume and OUT_PATH.exists():
        try:
            existing = json.loads(OUT_PATH.read_text()).get("cameras", {})
            logging.info("resume: %d cameras already classified", len(existing))
        except Exception as e:
            logging.warning("resume: couldn't read existing %s: %s", OUT_PATH, e)

    async with httpx.AsyncClient() as http:
        await preflight(http, ollama_url, model)
        cams = await list_cameras(http)
        if limit:
            cams = cams[:limit]
        todo = [c for c in cams if c["id"] not in existing]
        logging.info(
            "classifying %d cameras (skipping %d already done · concurrency=%d)",
            len(todo), len(cams) - len(todo), concurrency,
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
                    results[cid] = {
                        "poi": None, "category": None, "description": None,
                        "confidence": 0, "_skipped": "no_image",
                    }
                else:
                    try:
                        out = await classify(http, img, ollama_url, model)
                    except Exception as e:
                        out = {
                            "poi": None, "category": None, "description": None,
                            "confidence": 0, "_error": str(e)[:160],
                        }
                    out["_lat"] = cam.get("latitude")
                    out["_lng"] = cam.get("longitude")
                    results[cid] = out
            done += 1
            if done % 10 == 0:
                elapsed = time.monotonic() - started
                rate = done / max(elapsed, 0.01)
                remaining = (len(todo) - done) / max(rate, 0.01)
                logging.info(
                    "  progress: %d/%d · %.1fs/cam · ~%.0fs left",
                    done, len(todo), 1 / max(rate, 0.01), remaining,
                )
                _write(results, model)

        await asyncio.gather(*(one(c) for c in todo))
        _write(results, model)

        # Tally what we got
        by_cat: dict[str, int] = {}
        for v in results.values():
            cat = v.get("category") or "_none"
            by_cat[cat] = by_cat.get(cat, 0) + 1
        logging.info("done — %d entries, by category: %s", len(results), by_cat)
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
    args = p.parse_args()
    asyncio.run(run(
        limit=args.limit,
        resume=args.resume,
        concurrency=args.concurrency,
        ollama_url=args.ollama_url,
        model=args.model,
    ))


if __name__ == "__main__":
    main()
