"""Monitor for `data/cam_pois.json` and report progress.

Run in another terminal while `poi_classify_local.py --resume` runs:
  .venv/Scripts/python.exe server/poi_monitor.py

It prints progress every 30s and shows top candidates when complete.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "cam_pois.json"
CAM_LIST = ROOT / "src" / "cameras.json"

INTERVAL = 30


def load_cameras_total() -> int:
    if not CAM_LIST.exists():
        return 0
    try:
        j = json.loads(CAM_LIST.read_text())
        return int(j.get("count") or len(j.get("cameras", [])))
    except Exception:
        return 0


def load_results() -> dict:
    if not DATA.exists():
        return {}
    try:
        j = json.loads(DATA.read_text())
        return j.get("cameras", {})
    except Exception:
        return {}


def summarize(results: dict) -> None:
    total = load_cameras_total()
    done = len(results)
    print(f"Progress: {done}/{total} cameras classified")
    if done:
        # show top 10 by confidence with non-null categories
        items = [ (k,v) for k,v in results.items() if v.get("category") ]
        items.sort(key=lambda kv: kv[1].get("confidence",0), reverse=True)
        print("Top candidates:")
        for k,v in items[:10]:
            print(f" - {k}: {v.get('poi')!r} ({v.get('category')}) conf={v.get('confidence')}")


def main() -> None:
    last_done = -1
    while True:
        results = load_results()
        done = len(results)
        if done != last_done:
            summarize(results)
            last_done = done
        # exit when complete (no total known -> just keep running)
        total = load_cameras_total()
        if total and done >= total:
            print("Classification complete.")
            summarize(results)
            break
        time.sleep(INTERVAL)


if __name__ == '__main__':
    main()
