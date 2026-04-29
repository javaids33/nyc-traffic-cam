"""sync_boroughs.py — bake the borough field into src/cameras.json.

The old lounge.tsx `rough_borough()` was a four-line bounding-box
heuristic that mis-classified anything along the East River seam:
Queens Plaza, LIC, Greenpoint, Astoria all came out as Manhattan
because the longitude check used a single fixed meridian.

Fix: download NYC's official borough boundary polygons from NYC Open
Data and run a real point-in-polygon test for every camera. Bake the
result into cameras.json once so the frontend never has to ship a
polygon dataset or do the math at runtime.

Usage:
    python -m server.sync_boroughs
    python -m server.sync_boroughs --check-only   # report changes, don't write

Outputs:
    src/cameras.json   (in-place: each camera grows a `borough` field)

Run this whenever sync_cameras.py runs, or whenever NYC redraws a
boundary (extremely rare but it does happen — Marble Hill, Liberty
Island).
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parent.parent
CAMERAS_PATH = ROOT / "src" / "cameras.json"
BOUNDARY_CACHE = ROOT / "data" / "nyc_borough_boundaries.geojson"

# NYC borough boundary GeoJSON — sourced from a stable GitHub mirror
# of NYC Department of City Planning's nybb release (water area
# excluded). ~3 MB; cached at BOUNDARY_CACHE so reruns are
# offline-fast. The original NYC Open Data Socrata GeoJSON export
# endpoint (data.cityofnewyork.us/api/geospatial/tqmj-j8zm) returns
# 404 as of 2026 — Socrata moved geospatial exports behind a new
# tile-server URL that doesn't accept the old format param.
NYC_BOUNDARY_URL = (
    "https://raw.githubusercontent.com/dwillis/nyc-maps/master/boroughs.geojson"
)

# Map NYC's BoroName values to the labels the frontend already uses
# (lounge.tsx Borough type). Match casing exactly.
NAME_TO_BOROUGH = {
    "Manhattan":     "MANHATTAN",
    "Bronx":         "BRONX",
    "Brooklyn":      "BROOKLYN",
    "Queens":        "QUEENS",
    "Staten Island": "STATEN ISLAND",
}


def fetch_boundaries() -> dict[str, Any]:
    """Return the NYC borough boundary FeatureCollection, cached."""
    if BOUNDARY_CACHE.exists():
        try:
            return json.loads(BOUNDARY_CACHE.read_text())
        except Exception:
            logging.warning("cached boundary file unreadable, refetching")
    logging.info("downloading NYC borough boundary GeoJSON…")
    r = httpx.get(NYC_BOUNDARY_URL, timeout=60.0, follow_redirects=True)
    r.raise_for_status()
    payload = r.json()
    BOUNDARY_CACHE.parent.mkdir(parents=True, exist_ok=True)
    BOUNDARY_CACHE.write_text(json.dumps(payload))
    logging.info("cached %s (%.1f MB)", BOUNDARY_CACHE, BOUNDARY_CACHE.stat().st_size / 1e6)
    return payload


def _ring_contains(lng: float, lat: float, ring: list[list[float]]) -> bool:
    """Ray-casting point-in-polygon for a single linear ring.

    GeoJSON rings are [[lng, lat], …]. The classic algorithm: count
    edge crossings to the right of the test point on a horizontal
    ray. Odd → inside, even → outside.
    """
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        intersect = ((yi > lat) != (yj > lat)) and (
            lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi
        )
        if intersect:
            inside = not inside
        j = i
    return inside


def _polygon_contains(lng: float, lat: float, polygon: list[list[list[float]]]) -> bool:
    """A GeoJSON Polygon = [outer_ring, *holes]. Inside outer AND not in any hole."""
    if not polygon:
        return False
    if not _ring_contains(lng, lat, polygon[0]):
        return False
    for hole in polygon[1:]:
        if _ring_contains(lng, lat, hole):
            return False
    return True


def borough_for(lat: float, lng: float, features: list[dict[str, Any]]) -> str | None:
    """Return the official NYC borough name for a point, or None if outside."""
    for feat in features:
        boro = NAME_TO_BOROUGH.get(feat.get("properties", {}).get("BoroName") or "")
        if not boro:
            continue
        geom = feat.get("geometry") or {}
        if geom.get("type") == "Polygon":
            polys = [geom["coordinates"]]
        elif geom.get("type") == "MultiPolygon":
            polys = geom["coordinates"]
        else:
            continue
        for poly in polys:
            if _polygon_contains(lng, lat, poly):
                return boro
    return None


def _nearest_borough(lat: float, lng: float, features: list[dict[str, Any]]) -> str | None:
    """Fallback for cams just outside any polygon (e.g. on a bridge,
    pier, or right at the water's edge): pick the borough whose
    nearest polygon vertex is closest to the cam.

    Approximate distance is fine — we're tie-breaking among five
    bounded shapes, not measuring real geography.
    """
    best_name: str | None = None
    best_d2 = float("inf")
    for feat in features:
        boro = NAME_TO_BOROUGH.get(feat.get("properties", {}).get("BoroName") or "")
        if not boro:
            continue
        geom = feat.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if geom.get("type") == "Polygon":
            polys: list[list[list[list[float]]]] = [coords]
        elif geom.get("type") == "MultiPolygon":
            polys = coords
        else:
            continue
        for poly in polys:
            for ring in poly:
                # Sample every 5th vertex — these polygons can have
                # tens of thousands of points and we just need a rough
                # nearest-neighbor for the bridge case.
                for v in ring[::5]:
                    dlng = v[0] - lng
                    dlat = v[1] - lat
                    d2 = dlng * dlng + dlat * dlat
                    if d2 < best_d2:
                        best_d2 = d2
                        best_name = boro
    return best_name


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser(description="Bake borough field into src/cameras.json via point-in-polygon.")
    p.add_argument("--check-only", action="store_true", help="Print changes, don't write the file.")
    args = p.parse_args()

    if not CAMERAS_PATH.exists():
        sys.exit(f"error: {CAMERAS_PATH} missing — run sync_cameras.py first")

    payload = json.loads(CAMERAS_PATH.read_text())
    cams = payload.get("cameras") or []
    if not cams:
        sys.exit("error: cameras.json has no cameras")

    feats = fetch_boundaries().get("features") or []
    if not feats:
        sys.exit("error: borough boundary GeoJSON had no features")
    logging.info("loaded %d borough features", len(feats))

    fixed = 0
    bridge_fallback = 0
    distribution: dict[str, int] = {}
    for cam in cams:
        lat = cam.get("lat")
        lng = cam.get("lng")
        if lat is None or lng is None:
            continue
        boro = borough_for(lat, lng, feats)
        if boro is None:
            # Cam is outside every borough's land polygon — most often a
            # bridge approach or pier. Fall back to nearest-vertex.
            boro = _nearest_borough(lat, lng, feats)
            bridge_fallback += 1
        prev = cam.get("borough")
        if prev != boro:
            fixed += 1
        cam["borough"] = boro
        distribution[boro or "UNKNOWN"] = distribution.get(boro or "UNKNOWN", 0) + 1

    logging.info("borough distribution: %s", dict(sorted(distribution.items())))
    logging.info("over-water fallback used for %d cams (bridges/piers)", bridge_fallback)
    logging.info("rewrote borough on %d / %d cams", fixed, len(cams))

    if args.check_only:
        logging.info("--check-only: not writing %s", CAMERAS_PATH)
        return
    CAMERAS_PATH.write_text(json.dumps(payload, indent=2))
    logging.info("wrote %s", CAMERAS_PATH)


if __name__ == "__main__":
    main()
