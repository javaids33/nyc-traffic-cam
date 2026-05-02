"""analyze_1940s_photos.py — Ollama vision pass over the 1940s tax photos.

Ollama is vision-only (it reads images, doesn't make them), so what it
buys us for /world1940 is *renderer-helping metadata* extracted from each
photo:

    - facade_top / facade_bottom  (where in the photo the actual
                                   building is, as 0-1 fractions of
                                   the image height) — lets the 3D
                                   walk crop the photo to just the
                                   facade so we don't waste plane
                                   space on sidewalk + sky borders
    - dominant_color              hex string for color-grading
    - style                       storefront / townhouse / apartment /
                                  industrial / institutional / mixed
    - has_signage / has_vehicles / has_people
    - notes                       1-line human description

Output: public/photo-analysis-1940s.json
        (frontend reads it from /photo-analysis-1940s.json — graceful
         fallback if missing)

Usage:
    # one-time setup (already done if you've used poi_classify_local):
    ollama serve &
    ollama pull llava:7b

    # smoke test, 3 photos to stdout, no file write:
    .venv/bin/python -m server.analyze_1940s_photos --limit 3 --dry-run

    # full sweep over block 1-585 (25 photos, ~2 minutes on llava:7b):
    .venv/bin/python -m server.analyze_1940s_photos

    # bigger sweep — all blocks in the manifest:
    .venv/bin/python -m server.analyze_1940s_photos --all-blocks

    # resumable (skips photos already in the existing JSON):
    .venv/bin/python -m server.analyze_1940s_photos --resume

The schema is intentionally narrow. We are NOT asking the model to
generate or hallucinate facade content — only to localize what's in
the photo and tag a few discrete attributes. That keeps the answers
useful even on a 7B model that gets fuzzy on open-ended description.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "public" / "data-1940s.json"
PHOTOS_DIR = ROOT / "public" / "photos_1940s"
OUT_PATH = ROOT / "public" / "photo-analysis-1940s.json"

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "llava:7b"

PROMPT = """You are looking at a 1940 NYC tax-survey photo of one building's facade.

Return STRICT JSON, no preamble or markdown:
{
  "facade_top": <float 0..1>,        // top of the actual building in the photo (0 = top edge of image)
  "facade_bottom": <float 0..1>,     // bottom of building (where it meets sidewalk; usually 0.85-0.95)
  "dominant_color": "#rrggbb",       // primary facade color (the brick/stone/paint, not the sky)
  "style": "<one of: storefront, townhouse, apartment, industrial, institutional, mixed>",
  "has_signage": <true|false>,       // visible store signs / awnings / lettering
  "has_vehicles": <true|false>,      // cars, carts, trucks visible
  "has_people": <true|false>,        // any human figures
  "notes": "<one short sentence>"    // e.g. "4-storey brick walkup with ground-floor storefront"
}

Be precise on the facade bounds — they drive how the photo is cropped in
a 3D walk-view. The sky/border above the cornice is dead space; mark
facade_top there. The sidewalk + archive plate at the bottom is also
dead space; mark facade_bottom there."""


def load_manifest() -> dict:
    if not MANIFEST_PATH.exists():
        sys.exit(f"manifest not found at {MANIFEST_PATH}")
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def select_buildings(manifest: dict, all_blocks: bool, limit: int | None) -> list[dict]:
    buildings = manifest.get("buildings", [])
    out: list[dict] = []
    for b in buildings:
        if not b.get("photo"):
            continue
        if not all_blocks and not (b.get("boro") == 1 and b.get("block") == 585):
            continue
        out.append(b)
        if limit and len(out) >= limit:
            break
    return out


def photo_path(b: dict) -> Path:
    url = b["photo"]["url"]  # /photos_1940s/xxx.jpg
    return ROOT / "public" / url.lstrip("/")


def encode_b64(p: Path) -> str:
    return base64.b64encode(p.read_bytes()).decode("ascii")


_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


def extract_json(text: str) -> dict | None:
    """Pull the first balanced JSON object out of the model's reply."""
    m = _JSON_BLOCK.search(text)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        # Some models emit trailing commas etc. — try a tolerant pass.
        cleaned = re.sub(r",\s*([}\]])", r"\1", m.group(0))
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            return None


def normalize(record: dict) -> dict:
    """Coerce model output to a stable shape."""
    def f(name: str, default: float) -> float:
        try:
            v = float(record.get(name, default))
            return max(0.0, min(1.0, v))
        except (TypeError, ValueError):
            return default

    def b(name: str) -> bool:
        return bool(record.get(name, False))

    color = str(record.get("dominant_color", "#7d6f5c"))
    if not re.match(r"^#[0-9a-fA-F]{6}$", color):
        color = "#7d6f5c"

    style = str(record.get("style", "mixed")).lower()
    if style not in {"storefront", "townhouse", "apartment", "industrial", "institutional", "mixed"}:
        style = "mixed"

    notes = str(record.get("notes", "")).strip()[:140]

    facade_top = f("facade_top", 0.05)
    facade_bottom = f("facade_bottom", 0.92)
    if facade_bottom <= facade_top + 0.05:
        facade_top, facade_bottom = 0.05, 0.92  # sanity fallback

    return {
        "facade_top": facade_top,
        "facade_bottom": facade_bottom,
        "dominant_color": color.lower(),
        "style": style,
        "has_signage": b("has_signage"),
        "has_vehicles": b("has_vehicles"),
        "has_people": b("has_people"),
        "notes": notes,
    }


async def analyze_one(client: httpx.AsyncClient, url: str, model: str, b: dict) -> dict | None:
    p = photo_path(b)
    if not p.exists():
        return None
    img_b64 = encode_b64(p)
    payload = {
        "model": model,
        "prompt": PROMPT,
        "images": [img_b64],
        "stream": False,
        "format": "json",  # ollama supports a JSON-mode hint
        "options": {"temperature": 0.1},
    }
    try:
        r = await client.post(f"{url}/api/generate", json=payload, timeout=120.0)
    except httpx.RequestError as e:
        print(f"  ! request error for BIN {b['bin']}: {e}", file=sys.stderr)
        return None
    if r.status_code != 200:
        print(f"  ! HTTP {r.status_code} for BIN {b['bin']}: {r.text[:200]}", file=sys.stderr)
        return None
    raw = r.json().get("response", "")
    parsed = extract_json(raw)
    if parsed is None:
        print(f"  ! couldn't parse JSON from BIN {b['bin']}: {raw[:200]}", file=sys.stderr)
        return None
    return normalize(parsed)


async def main_async(args: argparse.Namespace) -> int:
    manifest = load_manifest()
    buildings = select_buildings(manifest, args.all_blocks, args.limit)
    if not buildings:
        print("no buildings selected", file=sys.stderr)
        return 1

    existing: dict[str, Any] = {}
    if args.resume and OUT_PATH.exists():
        try:
            existing = json.loads(OUT_PATH.read_text(encoding="utf-8")).get("buildings", {})
            print(f"resuming — {len(existing)} buildings already analyzed")
        except (json.JSONDecodeError, OSError):
            existing = {}

    todo = [b for b in buildings if b["bin"] not in existing or args.force]
    print(f"will analyze {len(todo)} of {len(buildings)} buildings (model={args.model})")
    if not todo:
        print("nothing to do")
        return 0

    out: dict[str, Any] = dict(existing)
    t0 = time.time()
    async with httpx.AsyncClient() as client:
        for i, b in enumerate(todo):
            bin_id = b["bin"]
            print(f"[{i+1}/{len(todo)}] BIN {bin_id} (lot {b.get('lot')})...", flush=True)
            t_start = time.time()
            rec = await analyze_one(client, args.ollama_url, args.model, b)
            if rec is None:
                continue
            out[bin_id] = rec
            print(f"    style={rec['style']} color={rec['dominant_color']} "
                  f"facade=[{rec['facade_top']:.2f},{rec['facade_bottom']:.2f}] "
                  f"sign={rec['has_signage']} veh={rec['has_vehicles']} "
                  f"({time.time()-t_start:.1f}s)")
            if args.dry_run:
                continue
            # Save after each so a crash doesn't lose work.
            payload = {
                "version": 1,
                "model": args.model,
                "generated_at": int(time.time()),
                "buildings": out,
            }
            OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    elapsed = time.time() - t0
    print(f"\ndone — {len(out)} buildings analyzed in {elapsed:.1f}s "
          f"({elapsed/max(1,len(todo)):.1f}s/photo avg)")
    if not args.dry_run:
        print(f"wrote {OUT_PATH.relative_to(ROOT)}")
    return 0


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument("--ollama-url", default=DEFAULT_OLLAMA_URL)
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--limit", type=int, default=None,
                   help="Only analyze the first N buildings")
    p.add_argument("--all-blocks", action="store_true",
                   help="Analyze every block, not just 1-585")
    p.add_argument("--resume", action="store_true",
                   help="Skip BINs already in the existing output JSON")
    p.add_argument("--force", action="store_true",
                   help="Re-analyze even BINs already in output")
    p.add_argument("--dry-run", action="store_true",
                   help="Print only, don't write the JSON")
    args = p.parse_args()
    sys.exit(asyncio.run(main_async(args)))


if __name__ == "__main__":
    main()
