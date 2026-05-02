"""validate_rewind_pairs.py — LLM-validate WPA ↔ cam pairs for /rewind.

Geographic nearest-neighbor (server/rewind_pairs.py) only knows two
points are close in lat/lon. It can't tell whether the cam is actually
LOOKING at the WPA scene — many cams point along a perpendicular street,
or away from the matched building entirely. This script asks a vision
LLM to confirm overlap.

Inputs:
    public/rewind-pairs-1940s.json    (geographic pairs)
    data/cam_snapshots/<cam_id>.jpg   (snapshot of each cam, run snapshot_cams.py first)
    public/photos_1940s/<file>.jpg    (WPA tax photos)

Output:
    public/rewind-pairs-validated.json
        Same structure as the input, but each pair gains:
          {
            "validation": {
              "usable": true/false,
              "confidence": 0.0..1.0,
              "what_matches": "...",
              "what_differs": "...",
              "model": "llava:7b",
              "checked_at": <unix>
            }
          }

The frontend can filter to usable=true pairs.

Usage:
    # 1. snapshot all cams (one-time, ~15 min)
    python -m server.snapshot_cams

    # 2. validate (resumable)
    python -m server.validate_rewind_pairs --limit 10              # smoke test
    python -m server.validate_rewind_pairs --resume                # full sweep
    python -m server.validate_rewind_pairs --model llava:7b
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import re
import sys
import time
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parent.parent
PAIRS_PATH = ROOT / "public" / "rewind-pairs-1940s.json"
OUT_PATH = ROOT / "public" / "rewind-pairs-validated.json"
SNAPSHOTS_DIR = ROOT / "data" / "cam_snapshots"
PHOTOS_DIR = ROOT / "public" / "photos_1940s"

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "llava:7b"

VALIDATION_PROMPT = """You are validating a then-and-now photo pair for an art project that overlays live 2026 NYC pedestrians and cars onto 1940 WPA tax photos. The pair does NOT have to be the literal same shot — modern vehicles, color, and time-of-day differences are EXPECTED and DESIRED, not problems.

Image 1: 1940 black-and-white WPA tax photo of a single building or block face.
Image 2: 2026 NYC DOT traffic camera frame from a nearby location.

Output ONE JSON object, nothing else:
{
  "usable": true|false,
  "confidence": 0.0,
  "what_matches": "short phrase, max 12 words",
  "what_differs": "short phrase, max 12 words"
}

Decide usable=true when ALL THREE hold:
1. Both images show a STREET-LEVEL urban scene (not a closed-off highway, not a tunnel interior, not a bridge deck with no buildings).
2. The kind of streetscape is COMPATIBLE — both show buildings/storefronts/sidewalks of recognizably similar urban density. (Both residential rowhouse-scale, OR both commercial/mixed-use, OR both at an intersection — they don't need to be identical, just compatible enough that a 2026 pedestrian sprite from Image 2 wouldn't look absurd dropped onto Image 1's sidewalk.)
3. Image 2 contains at least one PERSON, VEHICLE, or active pedestrian space — something worth overlaying.

Mark usable=false ONLY when:
- Image 2 is a highway, tunnel, bridge deck, or freeway interchange with no buildings near the camera (the overlay would have nothing to live on).
- Image 1 is unreadable (mostly chalk, mostly sky, blank wall).
- The streetscapes are obviously incompatible (e.g. WPA shows a quiet brownstone block, cam shows a 6-lane arterial overpass with no sidewalk visible).

what_matches: list shared visual elements ("rowhouse street with sidewalk", "commercial corner", "arterial with traffic", etc.)
what_differs: list ONLY structural differences that would break the overlay illusion ("WPA narrow street vs cam wide boulevard", "WPA residential vs cam highway"). DO NOT list color, time-stamp, or "modern vehicles" — those are expected.

confidence: 0.9+ very compatible (same street type, similar scale), 0.6-0.9 compatible kind of place, 0.3-0.6 weak but possible, <0.3 incompatible scene types.

Default to usable=true when in doubt. The art project only needs the overlay to FEEL like NYC, not to be the same corner."""


def encode_b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


JSON_RE = re.compile(r"\{.*?\}", re.DOTALL)


def parse_verdict(text: str) -> dict[str, Any]:
    """Extract the first JSON object from the model's reply. Best-effort."""
    if not text:
        return {"usable": False, "confidence": 0.0, "what_matches": "", "what_differs": "empty model reply"}
    match = JSON_RE.search(text)
    if not match:
        return {"usable": False, "confidence": 0.0, "what_matches": "", "what_differs": f"no JSON in reply: {text[:80]}"}
    blob = match.group(0)
    try:
        v = json.loads(blob)
    except json.JSONDecodeError:
        # Try to repair common issues — single-quoted keys, trailing commas.
        repaired = blob.replace("'", '"').replace(",}", "}")
        try:
            v = json.loads(repaired)
        except json.JSONDecodeError:
            return {"usable": False, "confidence": 0.0, "what_matches": "", "what_differs": f"unparseable JSON: {blob[:80]}"}
    return {
        "usable": bool(v.get("usable", False)),
        "confidence": float(v.get("confidence", 0.0) or 0.0),
        "what_matches": str(v.get("what_matches", ""))[:200],
        "what_differs": str(v.get("what_differs", ""))[:200],
    }


async def preflight(client: httpx.AsyncClient, ollama_url: str, model: str) -> None:
    try:
        r = await client.get(f"{ollama_url}/api/tags", timeout=5.0)
        r.raise_for_status()
    except httpx.HTTPError as e:
        sys.exit(
            f"error: cannot reach Ollama at {ollama_url} ({e}).\n"
            "  start it with `ollama serve` (or open the Ollama app)"
        )
    tags = {t["name"] for t in r.json().get("models", [])}
    if model not in tags and f"{model}:latest" not in tags:
        sys.exit(f"model {model!r} not pulled. run: ollama pull {model}")
    logging.info("ollama ok (%s) · model: %s", ollama_url, model)


async def call_model(
    client: httpx.AsyncClient,
    ollama_url: str,
    model: str,
    wpa_b64: str,
    cam_b64: str,
) -> dict[str, Any]:
    body = {
        "model": model,
        "stream": False,
        "format": "json",
        "options": {
            "temperature": 0.1,
            "num_ctx": 4096,
            "num_batch": 32,
            "num_gpu": 99,
        },
        "messages": [
            {
                "role": "user",
                "content": VALIDATION_PROMPT,
                "images": [wpa_b64, cam_b64],
            }
        ],
    }
    r = await client.post(f"{ollama_url}/api/chat", json=body, timeout=120.0)
    r.raise_for_status()
    msg = r.json()
    text = (msg.get("message", {}) or {}).get("content", "") or ""
    return parse_verdict(text)


async def main_async(args: argparse.Namespace) -> None:
    if not PAIRS_PATH.exists():
        sys.exit(f"missing {PAIRS_PATH} — run server.rewind_pairs first")
    if not SNAPSHOTS_DIR.exists() or not any(SNAPSHOTS_DIR.iterdir()):
        sys.exit(f"no snapshots in {SNAPSHOTS_DIR} — run server.snapshot_cams first")

    payload = json.loads(PAIRS_PATH.read_text(encoding="utf-8"))
    pairs = payload["pairs"]

    # Resume: load existing validated output, preserve verdicts.
    existing: dict[str, dict] = {}
    if args.resume and OUT_PATH.exists():
        try:
            prev = json.loads(OUT_PATH.read_text(encoding="utf-8"))
            for p in prev.get("pairs", []):
                if p.get("validation"):
                    existing[p["bin"]] = p["validation"]
            logging.info("resume: %d existing verdicts loaded", len(existing))
        except Exception as e:
            logging.warning("resume failed (%s) — starting fresh", e)

    # Decide what to validate.
    todo: list[dict] = []
    for p in pairs:
        if args.resume and p["bin"] in existing:
            continue
        cam_path = SNAPSHOTS_DIR / f"{p['cam']['id']}.jpg"
        wpa_path = ROOT / "public" / p["photo_url"].lstrip("/")
        if not cam_path.exists() or not wpa_path.exists():
            continue
        todo.append(p)
        if args.limit and len(todo) >= args.limit:
            break

    print(f"validating {len(todo)} of {len(pairs)} pairs "
          f"(skipped {len(pairs) - len(todo)}: missing snapshot/photo or already done)")

    async with httpx.AsyncClient() as client:
        await preflight(client, args.ollama_url, args.model)

        sem = asyncio.Semaphore(args.concurrency)
        results: dict[str, dict] = dict(existing)
        start = time.time()
        done = 0

        async def worker(p: dict) -> None:
            nonlocal done
            async with sem:
                cam_path = SNAPSHOTS_DIR / f"{p['cam']['id']}.jpg"
                wpa_path = ROOT / "public" / p["photo_url"].lstrip("/")
                try:
                    wpa_b64 = encode_b64(wpa_path)
                    cam_b64 = encode_b64(cam_path)
                    verdict = await call_model(client, args.ollama_url, args.model, wpa_b64, cam_b64)
                except Exception as e:
                    verdict = {
                        "usable": False, "confidence": 0.0,
                        "what_matches": "", "what_differs": f"call failed: {e!r}"[:200],
                    }
                verdict["model"] = args.model
                verdict["checked_at"] = int(time.time())
                results[p["bin"]] = verdict
                done += 1
                if done % 5 == 0 or done == len(todo):
                    rate = done / max(0.1, time.time() - start)
                    usable_count = sum(1 for v in results.values() if v.get("usable"))
                    print(f"  {done}/{len(todo)}  usable so far: {usable_count}  ({rate:.1f}/s)")

        await asyncio.gather(*(worker(p) for p in todo))

    # Re-emit the full pairs JSON with validation attached where present.
    out_pairs = []
    for p in pairs:
        out = dict(p)
        v = results.get(p["bin"])
        if v:
            out["validation"] = v
        out_pairs.append(out)
    out_pairs.sort(key=lambda p: (
        not (p.get("validation", {}).get("usable", False)),
        -(p.get("validation", {}).get("confidence", 0.0)),
        p["distance_m"],
    ))

    summary = {
        "total": len(out_pairs),
        "validated": sum(1 for p in out_pairs if "validation" in p),
        "usable": sum(1 for p in out_pairs if p.get("validation", {}).get("usable")),
    }
    out = {
        "version": 1,
        "generated_at": int(time.time()),
        "model": args.model,
        "summary": summary,
        "pairs": out_pairs,
    }
    OUT_PATH.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"\nwrote {OUT_PATH.relative_to(ROOT)} — {summary}")


def main() -> None:
    p = argparse.ArgumentParser(description="LLM-validate WPA ↔ cam pairs for /rewind.")
    p.add_argument("--ollama-url", default=DEFAULT_OLLAMA_URL)
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--limit", type=int, default=0, help="Cap pairs to validate this run (0 = all).")
    p.add_argument("--concurrency", type=int, default=2,
                   help="Parallel ollama calls — keep low (1-3) for an 8 GB GPU.")
    p.add_argument("--resume", action="store_true", help="Skip pairs already in the output JSON.")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
