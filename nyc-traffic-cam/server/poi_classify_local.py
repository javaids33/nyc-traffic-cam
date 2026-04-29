"""poi_classify_local.py — POI classification via a LOCAL vision model.

Same job as poi_classify.py, but talks to a local Ollama instance
instead of the Anthropic API. Use this when you have a GPU on the box
and don't want to pay the cloud bill (or wait for it).

Quickstart:
    # 1. Install + start Ollama (https://ollama.com).
    #    On macOS:   brew install ollama && open -a Ollama
    #    On Linux:   curl -fsSL https://ollama.com/install.sh | sh && ollama serve &

    # 2. Pull a vision model (one-time):
    ollama pull qwen2.5vl:7b           # ~6 GB, default — best quality at this size
    # OR lightweight (older, weaker tags but fits 8 GB GPUs comfortably):
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
# llava:7b is the default — it's the only Ollama VLM that fully fits
# the 3070's 8 GB VRAM (~4.5 GB) and runs ~2.8 s/cam, finishing the
# whole 960-cam sweep in <50 minutes. Quality is coarser than larger
# models, but we lean on three things to compensate:
#   1. The PROMPT in poi_taxonomy.py is rewritten for exhaustive
#      enumeration (systematic frame scan, big tag vocab)
#   2. fetch_image_b64() validates JPEG magic + min size, so frozen
#      placeholders never reach the model
#   3. /poi has a manual override editor for the inevitable misses
#
# Models we tried and rejected on this card:
#   - qwen2.5vl:7b/3b — vision encoder compute graph needs 12+ GiB,
#                       Ollama 0.22 falls 100% to CPU (~50 s and
#                       ~25 s per cam respectively, no GPU offload)
#   - llava-llama3:8b — fits GPU but hallucinates: same tag list for
#                       every cam, fabricates landmarks
#   - llava:13b — fits GPU at 9 GB via WDDM shared memory, quality
#                 is genuinely better, but PCIe-paged spillover means
#                 ~25 s/cam (~6.5 h sweep). Not worth the wait when
#                 the cloud Anthropic path (poi_classify.py) is
#                 ~30 min for the same money sink. Use `--model llava:13b`
#                 if you want it.
DEFAULT_MODEL = "llava:7b"

# Use the shared prompt from poi_taxonomy. Don't shadow it with a
# weaker per-file copy — both classifiers must emit identical schema.


# NYC center-of-mass coords for sunrise-sunset.org lookup.
NYC_LAT = 40.7128
NYC_LNG = -74.0060


async def wait_for_sunset_plus(minutes_after: int) -> None:
    """Sleep until N minutes past today's NYC sunset.

    Free, no auth: uses api.sunrise-sunset.org which returns ISO
    times for any lat/lng/date. If the target moment has already
    passed today (you ran the script after sunset), returns
    immediately so the night sweep starts now rather than waiting
    24 hours. Used by `--at-sunset-plus N` to schedule a one-shot
    night classification.
    """
    today = time.strftime("%Y-%m-%d", time.localtime())
    url = (
        f"https://api.sunrise-sunset.org/json"
        f"?lat={NYC_LAT}&lng={NYC_LNG}&date={today}&formatted=0"
    )
    async with httpx.AsyncClient() as http:
        r = await http.get(url, timeout=10.0)
        r.raise_for_status()
        sunset_iso = r.json()["results"]["sunset"]
    # Parse ISO8601 with timezone, convert to local epoch.
    import datetime as _dt
    sunset_dt = _dt.datetime.fromisoformat(sunset_iso.replace("Z", "+00:00"))
    target_epoch = sunset_dt.timestamp() + minutes_after * 60
    delay = target_epoch - time.time()
    sunset_local = sunset_dt.astimezone().strftime("%Y-%m-%d %H:%M")
    if delay <= 0:
        logging.info(
            "sunset+%dm already passed (NYC sunset today: %s) — starting now",
            minutes_after, sunset_local,
        )
        return
    logging.info(
        "waiting for NYC sunset+%dm — sunset today: %s, fires in %.0fs (%.1fm)",
        minutes_after, sunset_local, delay, delay / 60,
    )
    await asyncio.sleep(delay)


async def list_cameras(client: httpx.AsyncClient) -> list[dict[str, Any]]:
    """Pull the full live cam list from NYCTMC's GraphQL endpoint."""
    q = {"query": "{ cameras { id latitude longitude isOnline } }"}
    r = await client.post(NYCTMC_GRAPHQL, json=q, timeout=30.0)
    r.raise_for_status()
    cams = r.json().get("data", {}).get("cameras", []) or []
    return [c for c in cams if c.get("isOnline")]


async def fetch_image_b64(client: httpx.AsyncClient, cam_id: str) -> str | None:
    """Pull one frame from a camera; return base64-encoded JPEG.

    Validates the bytes before sending them to the VLM:
      - HTTP 200 + non-empty body
      - Starts with the JPEG magic prefix `\\xff\\xd8\\xff` so we
        don't pass HTML error pages or PNG placeholders to the model
      - At least MIN_BYTES — NYCTMC's own "camera offline" status
        image is ~1.5 KB; a real frame is ≥3-4 KB. Below MIN_BYTES we
        skip the cam entirely (routed to quality=empty by the caller),
        saving ~3 s of GPU inference per dead frame.

    Returns None on any rejection — the caller already routes that
    via `empty_skipped_record("no_image")`.
    """
    url = NYCTMC_IMAGE.format(cam_id=cam_id)
    MIN_BYTES = 3000
    try:
        r = await client.get(url, timeout=15.0)
        if r.status_code != 200:
            return None
        body = r.content
        if not body or len(body) < MIN_BYTES:
            return None
        # JPEG magic: every real JPEG starts FF D8 FF (then E0/E1/etc).
        # Reject anything that doesn't — usually an HTML error page
        # served as text/plain or a tiny PNG status placeholder.
        if not body.startswith(b"\xff\xd8\xff"):
            return None
        return base64.standard_b64encode(body).decode("ascii")
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
            # The new prompt has 14 fields including a tags array, so
            # we need a bigger response budget than the old 4-field
            # prompt. ~600 tokens is comfortable for a 10-tag list.
            "num_predict": 600,
            # GPU memory tuning — see ollama server.log if changing.
            #
            # The dominant cost for Qwen2.5-VL is the vision encoder's
            # compute graph (image-preprocessing scratch buffers), not
            # the weights. Ollama 0.22's scheduler is all-or-nothing:
            # if the projected total > free VRAM, it drops 100% to CPU
            # (no partial offload). Numbers measured on an RTX 3070
            # (8 GB · ~6 GB free with desktop apps running):
            #
            #   qwen2.5vl:7b  weights 5.6 GiB + graph 6.7 GiB = 12 GiB   → CPU only
            #   qwen2.5vl:3b  weights 2.6 GiB + graph 6.7 GiB = 10 GiB   → CPU only at num_batch=128
            #   qwen2.5vl:3b  weights 2.6 GiB + graph 1.7 GiB =  4 GiB   → fits, ~3-5s/cam at num_batch=32
            #   llava:7b      weights 4.5 GiB + graph 0.4 GiB =  5 GiB   → fits, ~2.8s/cam
            #
            # num_batch=32 is the smallest setting that still lets the
            # vision encoder run; below that it errors. Together with
            # num_ctx=2048 this is the only config that gets a Qwen
            # vision model onto the 3070.
            # llava:7b is small enough that we can afford 4096 ctx on
            # the 3070 (still fits at ~5 GiB total). The longer ctx
            # matters because the v3 prompt is ~3 KB after the image
            # tokens — at num_ctx=2048 the model runs out of headroom
            # and emits truncated JSON (only the first tag, etc).
            "num_ctx": 4096,
            "num_batch": 32,
            "num_gpu": 99,        # offload as many layers as fit
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


def _write(
    cameras: dict[str, Any],
    model: str,
    split_by_time: bool = False,
    output_name: str | None = None,
) -> None:
    if not split_by_time:
        # Single-file output. By default writes data/cam_pois.json +
        # src/cam-pois.json — pass `output_name` to route a parallel
        # run to a sibling file (e.g. `cam_pois_qwen25vl` writes
        # data/cam_pois_qwen25vl.json + src/cam-pois-qwen25vl.json)
        # without clobbering the primary run.
        payload = {
            "generated_at": int(time.time()),
            "backend": "ollama",
            "model": model,
            "cameras": cameras,
        }
        if output_name:
            data_path = DATA_DIR / f"{output_name}.json"
            # data file uses underscores; frontend file uses hyphens
            frontend_name = output_name.replace("cam_pois", "cam-pois").replace("_", "-")
            front_path = ROOT / "src" / f"{frontend_name}.json"
        else:
            data_path = OUT_PATH
            front_path = FRONTEND_OUT
        data_path.write_text(json.dumps(payload, indent=2))
        front_path.write_text(json.dumps(payload, indent=2))
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
    quality = rec.get("quality") or ("good" if rec.get("image_usable", True) else "broken")
    if quality != "good":
        flags.append(quality.upper())
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
    tags = rec.get("tags") or []
    if tags:
        extras.append(f"tags={','.join(tags[:6])}")
    proposed = rec.get("proposed_tags") or []
    if proposed:
        extras.append(f"+proposed={','.join(proposed)}")
    area = rec.get("area_type")
    if area and area != "mixed":
        extras.append(f"area={area}")

    print(
        f"  {cam_id[:8]}  {name[:38]:38s}  "
        f"scene={(rec.get('scene') or '?'):12s}  "
        f"{(rec.get('time_of_day') or '?'):4s}  {(rec.get('weather') or '?'):5s}  "
        f"cong={(rec.get('congestion') or '?'):6s}  "
        f"int={rec.get('interest', 0):3d}  "
        f"conf={rec.get('confidence', 0):3d}{flag_str}"
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
    output_name: str | None = None,
    at_sunset_plus: int | None = None,
) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # If asked, sleep until N minutes after NYC sunset before doing
    # any work. Used by Task Scheduler / cron to fire a daily night
    # sweep that captures actual nighttime camera frames.
    if at_sunset_plus is not None:
        await wait_for_sunset_plus(at_sunset_plus)

    # Pick the file we resume from + write to. `output_name` lets a
    # parallel run (e.g. a model comparison) target its own JSON
    # without touching the main cam_pois.json.
    out_data_path = (DATA_DIR / f"{output_name}.json") if output_name else OUT_PATH

    existing: dict[str, Any] = {}
    if resume and out_data_path.exists() and not dry_run:
        try:
            existing = json.loads(out_data_path.read_text()).get("cameras", {})
            logging.info("resume: %d cameras already classified", len(existing))
        except Exception as e:
            logging.warning("resume: couldn't read existing %s: %s", out_data_path, e)

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
                    _write(results, model, split_by_time=split_by_time, output_name=output_name)

        await asyncio.gather(*(one(c) for c in todo))

        # Tally what we got — useful regardless of dry-run.
        by_scene: dict[str, int] = {}
        by_quality: dict[str, int] = {}
        by_tag: dict[str, int] = {}
        usable = 0
        events = 0
        skyline = 0
        for v in results.values():
            scene = v.get("scene") or "_none"
            by_scene[scene] = by_scene.get(scene, 0) + 1
            qual = v.get("quality") or ("good" if v.get("image_usable") else "broken")
            by_quality[qual] = by_quality.get(qual, 0) + 1
            for t in (v.get("tags") or []):
                by_tag[t] = by_tag.get(t, 0) + 1
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
        logging.info("  by scene:   %s", by_scene)
        logging.info("  by quality: %s", by_quality)
        # Top tags by frequency, capped at 12 for readability.
        top_tags = sorted(by_tag.items(), key=lambda kv: -kv[1])[:12]
        logging.info("  top tags:   %s", top_tags)

        if dry_run:
            logging.info("dry-run: nothing written to disk")
        else:
            _write(results, model, split_by_time=split_by_time, output_name=output_name)
            if split_by_time:
                logging.info("wrote %s", OUT_PATH_DAY)
                logging.info("wrote %s", FRONTEND_OUT_DAY)
                logging.info("wrote %s", OUT_PATH_NIGHT)
                logging.info("wrote %s", FRONTEND_OUT_NIGHT)
            else:
                logging.info("wrote %s", out_data_path)


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
    p.add_argument("--output-name", default=None, help="Override output basename (e.g. 'cam_pois_qwen25vl' to write a parallel comparison file without clobbering the main run).")
    p.add_argument("--at-sunset-plus", type=int, default=None, metavar="MIN", help="Sleep until N minutes after today's NYC sunset before classifying. Used for the nightly run that captures actual nighttime frames; pair with --output-name cam_pois_night.")
    p.add_argument("--night", action="store_true", help="Convenience preset: --at-sunset-plus 20 --output-name cam_pois_night.")
    args = p.parse_args()
    if args.night:
        if args.at_sunset_plus is None:
            args.at_sunset_plus = 20
        if args.output_name is None:
            args.output_name = "cam_pois_night"
    asyncio.run(run(
        limit=args.limit,
        resume=args.resume,
        concurrency=args.concurrency,
        ollama_url=args.ollama_url,
        model=args.model,
        dry_run=args.dry_run,
        split_by_time=args.split_by_time,
        output_name=args.output_name,
        at_sunset_plus=args.at_sunset_plus,
    ))


if __name__ == "__main__":
    main()
