"""rewind_pairs.py - precompute WPA photo ↔ NYC DOT cam pairs.

For the /rewind page we need to know, for every WPA tax photo we have,
which live NYC DOT camera is closest in lat/lon. Doing this lookup at
runtime would force the browser to load both manifests; a precomputed
JSON keyed by BIN keeps the page lightweight.

Output: public/rewind-pairs-1940s.json

Schema:
  {
    "version": 1,
    "generated_at": <unix>,
    "pairs": [
      {
        "bin": "1009852",
        "lot": 12,
        "block": 585,
        "boro": 1,
        "photo_url": "/photos_1940s/...jpg",
        "centroid": [lon, lat],
        "cam": {
          "id": "...",
          "name": "West Houston @ Hudson St",
          "lat": ..., "lng": ...,
          "borough": "MANHATTAN"
        },
        "distance_m": 395
      }, ...
    ]
  }

Usage:

    python -m server.rewind_pairs --max-distance 800
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "public" / "data-1940s.json"
CAMERAS_PATH = ROOT / "src" / "cameras.json"
OUT_PATH = ROOT / "public" / "rewind-pairs-1940s.json"


def building_centroid(b: dict) -> tuple[float, float] | None:
    coords = b.get("geom", {}).get("coordinates")
    if not coords or not coords[0] or not coords[0][0]:
        return None
    pts = coords[0][0]
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    return (cx, cy)


def main() -> None:
    p = argparse.ArgumentParser(description="Precompute WPA-photo ↔ cam pairs.")
    p.add_argument("--max-distance", type=float, default=800.0,
                   help="Skip pairings beyond this distance in meters.")
    args = p.parse_args()

    if not MANIFEST_PATH.exists():
        sys.exit(f"missing manifest: {MANIFEST_PATH}")
    if not CAMERAS_PATH.exists():
        sys.exit(f"missing cameras: {CAMERAS_PATH}")

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    cams_raw = json.loads(CAMERAS_PATH.read_text(encoding="utf-8"))
    cams = cams_raw["cameras"] if isinstance(cams_raw, dict) else cams_raw

    pairs: list[dict] = []
    skipped = 0
    for b in manifest.get("buildings", []):
        photo = b.get("photo")
        if not photo:
            continue
        centroid = building_centroid(b)
        if not centroid:
            continue
        blon, blat = centroid
        # Equirectangular distance — good enough at NYC latitudes.
        m_per_lon = 111320.0 * math.cos(math.radians(blat))
        best = None
        best_dist = float("inf")
        for cam in cams:
            d = math.hypot(
                (blat - cam["lat"]) * 111320.0,
                (blon - cam["lng"]) * m_per_lon,
            )
            if d < best_dist:
                best_dist = d
                best = cam
        if best is None or best_dist > args.max_distance:
            skipped += 1
            continue
        pairs.append({
            "bin": str(b["bin"]),
            "lot": int(b.get("lot", 0)),
            "block": int(b.get("block", 0)),
            "boro": int(b.get("boro", 0)),
            "photo_url": photo["url"],
            "centroid": [round(blon, 6), round(blat, 6)],
            "cam": {
                "id": best["id"],
                "name": best["name"],
                "lat": best["lat"],
                "lng": best["lng"],
                "borough": best.get("borough", ""),
            },
            "distance_m": round(best_dist, 1),
        })

    pairs.sort(key=lambda p: p["distance_m"])
    payload = {
        "version": 1,
        "generated_at": int(time.time()),
        "max_distance_m": args.max_distance,
        "count": len(pairs),
        "pairs": pairs,
    }
    OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {OUT_PATH.relative_to(ROOT)}  — {len(pairs)} pairs (skipped {skipped})")


if __name__ == "__main__":
    main()
