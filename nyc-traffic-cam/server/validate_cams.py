"""validate_cams.py — per-cam usability for /rewind portal overlays.

The previous per-pair validator (validate_rewind_pairs.py) was wrong:
when we only have ONE block of WPA photos baked, the same 5 cams each
get matched against ~50 WPA buildings, so we run ~266 LLM calls but
only judge 5 distinct cam frames. Variance per cam: zero. Useless.

The right question is per-CAM, not per-pair: "Is this cam pointed at
a 2026 streetscape that would be a meaningful source for overlaying
onto a 1940 NYC tax photo?" Answer once per cam, then ANY nearby WPA
building can pair with that cam.

Inputs:
    data/cam_snapshots/<cam_id>.jpg    (run server.snapshot_cams first)

Output:
    public/cam-rewind-usability.json
        {
          "version": 1, "generated_at": <unix>, "model": "...",
          "summary": {"total": ..., "usable": ..., "unusable": ...},
          "cams": {
            "<cam_id>": {
              "name": "...",
              "usable": true|false,
              "confidence": 0.0..1.0,
              "scene_kind": "rowhouse_street" | "arterial" | "highway" | "intersection" | "tunnel" | "bridge" | "other",
              "has_pedestrians": true|false,
              "has_vehicles": true|false,
              "what_we_see": "short phrase",
              "model": "...", "checked_at": <unix>
            }, ...
          }
        }

The frontend joins this with the geographic pairs to show only
usable cams. The same cam serving 50 nearby WPA buildings is fine —
each pair will share the cam's verdict.

Usage:
    python -m server.validate_cams --limit 10               # smoke test
    python -m server.validate_cams --resume                 # full sweep, resume
    python -m server.validate_cams --model qwen2.5vl:7b     # better quality, ~12GB VRAM
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
SNAPSHOTS_DIR = ROOT / "data" / "cam_snapshots"
CAMERAS_PATH = ROOT / "src" / "cameras.json"
OUT_PATH = ROOT / "public" / "cam-rewind-usability.json"

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "llava:7b"

VALIDATION_PROMPT = """You are evaluating a NYC DOT traffic camera frame as a possible source for a then-and-now art project. The project overlays live 2026 pedestrians/cars from this cam onto 1940 WPA black-and-white tax photos of NYC streets.

For the overlay to feel meaningful, this cam needs to show:
- A street-level urban scene (NOT a closed highway, tunnel interior, or bridge deck)
- Buildings, sidewalks, or storefronts visible (places where a 1940 brownstone could plausibly stand)
- At least one person, vehicle, or sign of street life

Output ONE JSON object, nothing else, this exact shape:
{
  "usable": true|false,
  "confidence": 0.0,
  "scene_kind": "rowhouse_street" | "commercial_corner" | "arterial" | "intersection" | "highway" | "tunnel" | "bridge" | "park" | "obstructed" | "other",
  "has_pedestrians": true|false,
  "has_vehicles": true|false,
  "what_we_see": "short phrase, max 15 words"
}

Decision rules (be strict on the negatives):
- usable=FALSE if scene_kind is "highway", "tunnel", "bridge", or "obstructed".
- usable=FALSE if NO sidewalks, NO buildings near the camera, and the road is a multi-lane freeway with no shoulder.
- usable=FALSE if the frame is broken (all black, all gray, error message, "camera offline").
- usable=TRUE if scene_kind is "rowhouse_street", "commercial_corner", or "intersection" AND there are buildings visible AND at least vehicles or pedestrians are visible.
- usable=TRUE if "arterial" but only when buildings line both sides AND a sidewalk is visible (NYC has plenty of arterial streets that are still walkable urban scenes).
- usable=TRUE if "park" only when surrounded by visible city buildings.

confidence: 0.9+ "definitely usable / unusable" (very clear scene), 0.6-0.9 "probably right", 0.3-0.6 "I'm guessing".

Be honest. A lot of cams point at highway interchanges with no nearby pedestrians — those are unusable. Don't rubber-stamp."""


def encode_b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


JSON_RE = re.compile(r"\{.*?\}", re.DOTALL)


def parse_verdict(text: str) -> dict[str, Any]:
    if not text:
        return _err("empty model reply")
    match = JSON_RE.search(text)
    if not match:
        return _err(f"no JSON in reply: {text[:80]}")
    blob = match.group(0)
    try:
        v = json.loads(blob)
    except json.JSONDecodeError:
        try:
            v = json.loads(blob.replace("'", '"').replace(",}", "}"))
        except json.JSONDecodeError:
            return _err(f"unparseable JSON: {blob[:80]}")
    return {
        "usable": bool(v.get("usable", False)),
        "confidence": float(v.get("confidence", 0.0) or 0.0),
        "scene_kind": str(v.get("scene_kind", "other"))[:40],
        "has_pedestrians": bool(v.get("has_pedestrians", False)),
        "has_vehicles": bool(v.get("has_vehicles", False)),
        "what_we_see": str(v.get("what_we_see", ""))[:200],
    }


def _err(msg: str) -> dict[str, Any]:
    return {"usable": False, "confidence": 0.0, "scene_kind": "other",
            "has_pedestrians": False, "has_vehicles": False,
            "what_we_see": msg}


async def preflight(client: httpx.AsyncClient, ollama_url: str, model: str) -> None:
    try:
        r = await client.get(f"{ollama_url}/api/tags", timeout=5.0)
        r.raise_for_status()
    except httpx.HTTPError as e:
        sys.exit(f"error: cannot reach Ollama at {ollama_url} ({e}). Run `ollama serve`.")
    tags = {t["name"] for t in r.json().get("models", [])}
    if model not in tags and f"{model}:latest" not in tags:
        sys.exit(f"model {model!r} not pulled. Run: ollama pull {model}")
    logging.info("ollama ok (%s) · model: %s", ollama_url, model)


async def call_model(
    client: httpx.AsyncClient, ollama_url: str, model: str, image_b64: str,
) -> dict[str, Any]:
    body = {
        "model": model, "stream": False, "format": "json",
        "options": {"temperature": 0.1, "num_ctx": 4096, "num_batch": 32, "num_gpu": 99},
        "messages": [{"role": "user", "content": VALIDATION_PROMPT, "images": [image_b64]}],
    }
    r = await client.post(f"{ollama_url}/api/chat", json=body, timeout=120.0)
    r.raise_for_status()
    msg = r.json()
    text = (msg.get("message", {}) or {}).get("content", "") or ""
    return parse_verdict(text)


async def main_async(args: argparse.Namespace) -> None:
    if not SNAPSHOTS_DIR.exists():
        sys.exit(f"missing {SNAPSHOTS_DIR} — run server.snapshot_cams first")
    if not CAMERAS_PATH.exists():
        sys.exit(f"missing {CAMERAS_PATH}")
    cameras = json.loads(CAMERAS_PATH.read_text(encoding="utf-8"))
    cam_list = cameras.get("cameras") if isinstance(cameras, dict) else cameras
    cam_by_id = {c["id"]: c for c in cam_list}

    # Resume: load existing
    existing: dict[str, dict] = {}
    if args.resume and OUT_PATH.exists():
        try:
            prev = json.loads(OUT_PATH.read_text(encoding="utf-8"))
            existing = prev.get("cams", {})
            logging.info("resume: %d existing verdicts", len(existing))
        except Exception as e:
            logging.warning("resume failed (%s) — starting fresh", e)

    snapshots = sorted(SNAPSHOTS_DIR.glob("*.jpg"))
    todo = []
    for snap in snapshots:
        cam_id = snap.stem
        if args.resume and cam_id in existing:
            continue
        todo.append(snap)
        if args.limit and len(todo) >= args.limit:
            break

    print(f"validating {len(todo)} of {len(snapshots)} cams (skipped {len(snapshots) - len(todo)})")

    async with httpx.AsyncClient() as client:
        await preflight(client, args.ollama_url, args.model)

        sem = asyncio.Semaphore(args.concurrency)
        results = dict(existing)
        start = time.time()
        done = 0

        async def worker(snap_path: Path) -> None:
            nonlocal done
            cam_id = snap_path.stem
            async with sem:
                try:
                    img_b64 = encode_b64(snap_path)
                    verdict = await call_model(client, args.ollama_url, args.model, img_b64)
                except Exception as e:
                    verdict = _err(f"call failed: {e!r}"[:200])
                cam_meta = cam_by_id.get(cam_id, {})
                verdict["name"] = cam_meta.get("name", "")
                verdict["lat"] = cam_meta.get("lat")
                verdict["lng"] = cam_meta.get("lng")
                verdict["borough"] = cam_meta.get("borough", "")
                verdict["model"] = args.model
                verdict["checked_at"] = int(time.time())
                results[cam_id] = verdict
                done += 1
                if done % 10 == 0 or done == len(todo):
                    rate = done / max(0.1, time.time() - start)
                    usable = sum(1 for v in results.values() if v.get("usable"))
                    print(f"  {done}/{len(todo)}  usable so far: {usable}/{len(results)}  ({rate:.1f}/s)")

        await asyncio.gather(*(worker(s) for s in todo))

    summary = {
        "total": len(results),
        "usable": sum(1 for v in results.values() if v.get("usable")),
        "unusable": sum(1 for v in results.values() if not v.get("usable")),
        "by_scene_kind": {},
    }
    for v in results.values():
        sk = v.get("scene_kind", "other")
        summary["by_scene_kind"][sk] = summary["by_scene_kind"].get(sk, 0) + 1

    out = {"version": 1, "generated_at": int(time.time()), "model": args.model,
           "summary": summary, "cams": results}
    OUT_PATH.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"\nwrote {OUT_PATH.relative_to(ROOT)} — {summary}")


def main() -> None:
    p = argparse.ArgumentParser(description="Per-cam usability for /rewind portal.")
    p.add_argument("--ollama-url", default=DEFAULT_OLLAMA_URL)
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--concurrency", type=int, default=2)
    p.add_argument("--resume", action="store_true")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
