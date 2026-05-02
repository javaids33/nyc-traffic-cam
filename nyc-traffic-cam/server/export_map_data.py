"""export_map_data.py — single combined JSON for the /rewind-map page.

Joins cameras + cam_validations + tax_photos + footprints + cam_visual_matches
out of DuckDB into one payload the frontend can render with maplibre. We
pre-compute the join server-side so the map page loads ~100KB instead of
~6 MB of separate JSONs.

Output: public/cam-map-data.json

Schema:
    {
      "version": 1, "generated_at": <unix>,
      "summary": {"cams": N, "wpa": M, "links": L,
                  "cams_with_matches": K, "validated_usable": U},
      "cams": [
        {
          "id": "...",
          "name": "W. Houston @ Hudson",
          "lat": ..., "lng": ...,
          "borough": "MANHATTAN",
          "usable": true,
          "scene_kind": "rowhouse_street",
          "confidence": 0.9,
          "match_count": 3,
          "best_similarity": 0.553,
          "best_bin": "1009852"
        }, ...
      ],
      "wpa": [
        {
          "bin": "...",
          "lat": ..., "lng": ...,
          "boro": 1, "block": 585, "lot": 12,
          "has_photo": true,
          "matched_by": ["cam_id1", ...]
        }, ...
      ],
      "links": [
        { "cam_id": "...", "bin": "...", "similarity": 0.55, "rank": 1, "distance_m": 493 }, ...
      ]
    }

Usage:
    python -m server.export_map_data
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "photos.duckdb"
OUT_PATH = ROOT / "public" / "cam-map-data.json"


def main() -> None:
    if not DB_PATH.exists():
        sys.exit(f"missing DB at {DB_PATH}")
    con = duckdb.connect(str(DB_PATH), read_only=True)

    # ---- cams (every cam, with optional validation + match aggregates) ----
    cam_rows = con.execute("""
        SELECT
            c.cam_id, c.name, c.lat, c.lng, c.borough,
            v.usable, v.confidence, v.scene_kind,
            v.has_pedestrians, v.has_vehicles, v.what_we_see,
            mstats.match_count, mstats.best_similarity, mstats.best_bin
        FROM cameras c
        LEFT JOIN cam_validations v ON v.cam_id = c.cam_id
        LEFT JOIN (
            SELECT cam_id,
                   count(*) AS match_count,
                   max(similarity) AS best_similarity,
                   first(bin ORDER BY similarity DESC) AS best_bin
            FROM cam_visual_matches GROUP BY cam_id
        ) mstats ON mstats.cam_id = c.cam_id
        WHERE c.lat IS NOT NULL
        ORDER BY c.cam_id
    """).fetchall()
    cams = [{
        "id": r[0], "name": r[1] or "", "lat": r[2], "lng": r[3],
        "borough": r[4] or "",
        "usable": bool(r[5]) if r[5] is not None else None,
        "confidence": r[6],
        "scene_kind": r[7] or "",
        "has_pedestrians": r[8],
        "has_vehicles": r[9],
        "what_we_see": r[10] or "",
        "match_count": r[11] or 0,
        "best_similarity": r[12],
        "best_bin": r[13],
    } for r in cam_rows]

    # ---- WPA photos (only ones with downloaded photos for now) ----
    wpa_rows = con.execute("""
        SELECT
            f.bin, f.centroid_lat, f.centroid_lon, f.boro, f.block, f.lot,
            CASE WHEN t.bin IS NOT NULL THEN TRUE ELSE FALSE END AS has_photo,
            list(DISTINCT m.cam_id) FILTER (WHERE m.cam_id IS NOT NULL) AS matched_by
        FROM footprints_1940s f
        LEFT JOIN tax_photos t ON t.bin = f.bin
        LEFT JOIN cam_visual_matches m ON m.bin = f.bin
        WHERE f.centroid_lat IS NOT NULL AND t.bin IS NOT NULL
        GROUP BY f.bin, f.centroid_lat, f.centroid_lon, f.boro, f.block, f.lot, t.bin
        ORDER BY f.bin
    """).fetchall()
    wpa = [{
        "bin": r[0], "lat": r[1], "lng": r[2],
        "boro": r[3], "block": r[4], "lot": r[5],
        "has_photo": bool(r[6]),
        "matched_by": list(r[7]) if r[7] else [],
    } for r in wpa_rows]

    # ---- links (CLIP visual matches) ----
    link_rows = con.execute("""
        SELECT cam_id, bin, similarity, rank, distance_m
        FROM cam_visual_matches
        ORDER BY cam_id, rank
    """).fetchall()
    links = [{
        "cam_id": r[0], "bin": r[1],
        "similarity": round(r[2], 4) if r[2] is not None else None,
        "rank": r[3],
        "distance_m": round(r[4], 1) if r[4] is not None else None,
    } for r in link_rows]

    summary = {
        "cams": len(cams),
        "wpa": len(wpa),
        "links": len(links),
        "cams_with_matches": sum(1 for c in cams if c["match_count"]),
        "validated_usable": sum(1 for c in cams if c.get("usable")),
        "scene_kinds": {},
    }
    for c in cams:
        sk = c.get("scene_kind") or "unverified"
        summary["scene_kinds"][sk] = summary["scene_kinds"].get(sk, 0) + 1

    out = {
        "version": 1, "generated_at": int(time.time()),
        "summary": summary,
        "cams": cams, "wpa": wpa, "links": links,
    }
    OUT_PATH.write_text(json.dumps(out), encoding="utf-8")
    sz = OUT_PATH.stat().st_size
    print(f"wrote {OUT_PATH.relative_to(ROOT)} — {summary['cams']} cams, "
          f"{summary['wpa']} WPA, {summary['links']} links ({sz / 1024:.1f} KB)")
    con.close()


if __name__ == "__main__":
    main()
