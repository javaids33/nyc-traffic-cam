"""export_visual_matches.py — write cam_visual_matches to a frontend JSON.

Joins cam_visual_matches with cameras + tax_photos + cam_validations so
the /rewind frontend can read a single self-contained payload. The
output is a sibling to rewind-pairs-1940s.json (which is geographic-only)
and rewind-pairs-validated.json (deprecated per-pair llava verdicts):

    public/rewind-pairs-visual.json

Schema:
    {
      "version": 1, "generated_at": <unix>, "model": "clip-ViT-B-32",
      "summary": {"cams_lit": N, "total_matches": M},
      "pairs": [
        {
          "bin": "...",
          "lot": ..., "block": ..., "boro": ...,
          "photo_url": "/photos_1940s/...jpg",
          "centroid": [lon, lat],
          "cam": {"id": "...", "name": "...", "lat": ..., "lng": ..., "borough": "..."},
          "distance_m": 493,
          "rank": 1,           # 1..top_k for this cam
          "similarity": 0.553, # CLIP cosine
          "validation": {       # cam-level llava verdict (joined in)
              "usable": true, "confidence": 0.9, "scene_kind": "rowhouse_street",
              "has_pedestrians": true, "has_vehicles": true,
              "what_we_see": "..."
          }
        }, ...
      ]
    }

Usage:
    python -m server.export_visual_matches
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "photos.duckdb"
OUT_PATH = ROOT / "public" / "rewind-pairs-visual.json"


def main() -> None:
    if not DB_PATH.exists():
        sys.exit(f"missing DB at {DB_PATH}")
    con = duckdb.connect(str(DB_PATH), read_only=True)

    # Pull every visual match joined with metadata. Cameras lacking an
    # llava verdict still get a row (validation = null).
    rows = con.execute("""
        SELECT
            m.bin, f.lot, f.block, f.boro,
            t.photo_url, f.centroid_lon, f.centroid_lat,
            m.cam_id, c.name, c.lat, c.lng, c.borough,
            m.distance_m, m.rank, m.similarity,
            v.usable, v.confidence, v.scene_kind,
            v.has_pedestrians, v.has_vehicles, v.what_we_see
        FROM cam_visual_matches m
        JOIN footprints_1940s f ON f.bin = m.bin
        JOIN tax_photos t ON t.bin = m.bin
        JOIN cameras c ON c.cam_id = m.cam_id
        LEFT JOIN cam_validations v ON v.cam_id = m.cam_id
        ORDER BY m.cam_id, m.rank
    """).fetchall()

    pairs = []
    for r in rows:
        pair = {
            "bin": r[0], "lot": r[1], "block": r[2], "boro": r[3],
            "photo_url": r[4],
            "centroid": [r[5], r[6]],
            "cam": {
                "id": r[7], "name": r[8] or "",
                "lat": r[9], "lng": r[10],
                "borough": r[11] or "",
            },
            "distance_m": round(r[12], 1) if r[12] is not None else None,
            "rank": r[13],
            "similarity": round(r[14], 4),
        }
        if r[15] is not None:
            pair["validation"] = {
                "usable": r[15], "confidence": r[16],
                "scene_kind": r[17] or "",
                "has_pedestrians": r[18], "has_vehicles": r[19],
                "what_we_see": r[20] or "",
            }
        pairs.append(pair)

    summary = {
        "cams_lit": len({p["cam"]["id"] for p in pairs}),
        "total_matches": len(pairs),
    }

    out = {
        "version": 1,
        "generated_at": int(time.time()),
        "model": "clip-ViT-B-32",
        "summary": summary,
        "pairs": pairs,
    }
    OUT_PATH.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"wrote {OUT_PATH.relative_to(ROOT)} — {summary}")
    con.close()


if __name__ == "__main__":
    main()
