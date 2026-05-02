"""stitch_neighbors.py - score & resolve seams between consecutive 1940s tax photos.

The /world1940 walk lays one textured plane per building down a virtual
street. Two things drive how those planes meet:

  1) Real lot frontage (from the NYC building footprint geometry) tells
     us how WIDE each plane should be in scene-meters.

  2) Visual overlap between adjacent photos (the WPA photographer's lens
     caught some of the neighbor's wall when shooting a narrow lot) tells
     us how the planes should be POSITIONED relative to each other in
     scene-X so the brick patterns line up across the seam.

This script crunches both. For every block we:

  * Project each building's footprint into local meters and determine its
    along-street frontage and axis position (so two adjacent lots on the
    same street are placed at the right relative X with the right widths).

  * Split the block's buildings into "sides" (two rows facing each other
    across the street) by sign of perpendicular distance from the row's
    principal axis. No more hardcoded lot-number heuristics.

  * For every consecutive pair of buildings on the same side, run SIFT
    feature matching on overlapping edge strips (right of A vs left of B),
    enforce vertical alignment (the WPA shot all photos from roughly the
    same camera height), and score the match by inlier count, y-alignment
    tightness, and L-position consistency.

  * Convert the matched pixel offset to a scene-meter offset using each
    photo's lot frontage as the meters/pixel scale.

Output: public/photo-stitch-1940s.json, organized as:

  {
    "version": 1,
    "scoring": {"high": 0.45, "med": 0.20},
    "blocks": {
      "1-585": {
        "buildings": {
          "<bin>": {"lot": 12, "side": "side_a", "frontage_m": 25.84,
                    "axis_start": -18.06, "axis_end": 7.78,
                    "photo_w": 682, "photo_h": 1024}
        },
        "sides": {
          "side_a": ["<bin1>", "<bin2>", ...],   // ordered along street
          "side_b": [...]
        },
        "seams": [
          {"a_bin": "...", "b_bin": "...", "side": "side_a",
           "raw": {"inliers": 11, "y_std": 8.2, "L_std": 12.4, "L_px": 410.3},
           "scores": {"inlier": 0.92, "precision": 0.78, "consistency": 0.66,
                      "overall": 0.47},
           "confidence": "high",
           "feature_offset_m": -2.84}   // negative = overlap, positive = gap
        ],
        "summary": {"high": 4, "med": 7, "low": 12, "total": 23}
      }
    }
  }

Renderer reads this and uses feature_offset_m to snap planes that have
high-confidence seams; falls back to butt-against-frontage for low ones.

Usage:

    python -m server.stitch_neighbors                  # block 1-585 only
    python -m server.stitch_neighbors --all-blocks
    python -m server.stitch_neighbors --block 1-585 --verbose
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "public" / "data-1940s.json"
PHOTOS_DIR = ROOT / "public" / "photos_1940s"
OUT_PATH = ROOT / "public" / "photo-stitch-1940s.json"

M_PER_LAT_DEG = 111320.0

# Score thresholds: tunable via --high/--med flags but these defaults match
# what the renderer expects in its <stitch> consumption.
HIGH_THRESH = 0.45
MED_THRESH = 0.20

# SIFT/match knobs — sized for our 682x1024 sepia tax photos.
STRIP_FRAC = 0.45               # 45% of each photo's width on the matching edge
SIFT_NFEATURES = 2000
LOWE_RATIO = 0.75
Y_ALIGN_TOL_PX = 15             # accept y_diff up to this in the y-aligned filter
INLIER_BAND_PX = 12             # ±this around median L to count as inlier
LOT_GAP_THRESHOLD = 5           # lot # gap >= this → new "side" of the block


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

@dataclass
class BuildingMeta:
    bin: str
    lot: int
    photo_w: int
    photo_h: int
    photo_path: Path
    centroid_m: tuple[float, float]      # in local meters
    ring_m: list[tuple[float, float]]    # outer ring in local meters
    axis_start: float = 0.0
    axis_end: float = 0.0
    frontage_m: float = 0.0
    perp: float = 0.0                    # signed perpendicular distance from axis
    side: str = "side_a"
    # Geometry-derived facade metadata for corner detection / validation:
    facade_angle_deg: float = 0.0        # dominant facade direction (mod 180)
    facade_length_m: float = 0.0         # length of that dominant facade edge
    is_corner: bool = False              # ≥2 long edges at perpendicular angles


def project_factory(ref_lon: float, ref_lat: float):
    m_per_lon = M_PER_LAT_DEG * math.cos(math.radians(ref_lat))

    def project(lon: float, lat: float) -> tuple[float, float]:
        return ((lon - ref_lon) * m_per_lon, (lat - ref_lat) * M_PER_LAT_DEG)

    return project


def outer_ring(building: dict) -> list[list[float]]:
    coords = building.get("geom", {}).get("coordinates")
    if not coords or not coords[0] or not coords[0][0]:
        return []
    return coords[0][0]


def principal_axis(points: list[tuple[float, float]]) -> tuple[float, float]:
    """Return the principal-axis unit vector (PCA) for a set of 2D points."""
    n = len(points)
    if n < 2:
        return (1.0, 0.0)
    cx = sum(p[0] for p in points) / n
    cy = sum(p[1] for p in points) / n
    sxx = sxy = syy = 0.0
    for x, y in points:
        dx, dy = x - cx, y - cy
        sxx += dx * dx
        sxy += dx * dy
        syy += dy * dy
    angle = 0.5 * math.atan2(2 * sxy, sxx - syy)
    return (math.cos(angle), math.sin(angle))


def edge_lengths_by_orientation(ring: list[tuple[float, float]]) -> dict[int, float]:
    """Sum edge lengths into 1° angle buckets (mod 180). The bucket with
    the most total length is the dominant facade direction — robust against
    polygons with many short jagged edges."""
    buckets: dict[int, float] = {}
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        length = math.hypot(x2 - x1, y2 - y1)
        if length < 0.5:
            continue
        ang = math.degrees(math.atan2(y2 - y1, x2 - x1)) % 180.0
        b = int(round(ang)) % 180
        buckets[b] = buckets.get(b, 0.0) + length
    return buckets


def dominant_facade(
    ring: list[tuple[float, float]],
    outward: tuple[float, float] | None = None,
) -> tuple[float, float, bool]:
    """Return (angle_deg, length_m, is_corner) for the polygon's STREET facade.

    The facade is the edge that faces outward toward the street, not the
    building's longest wall. Without `outward` (the unit vector from the
    block centroid to this building's centroid) we fall back to longest-
    edge — which is wrong for narrow rowhouses, where the long axis is the
    DEPTH and the short edge is the actual facade.

    With `outward` provided:
      1. score each edge by (midpoint · outward) — how far out it sits
      2. require the edge orientation to be within ±35° of perpendicular
         to `outward` (i.e., parallel to the street)
      3. pick the edge with the highest outward score; its orientation is
         the facade angle, its length is the facade width

    Corner detection still looks for a second heavy edge cluster ~90°
    away from the chosen facade.
    """
    if len(ring) < 3:
        return (0.0, 0.0, False)
    if outward is None:
        # Fallback: longest-edge bucket (legacy behaviour).
        raw = edge_lengths_by_orientation(ring)
        if not raw:
            return (0.0, 0.0, False)
        windowed: dict[int, float] = {}
        for ang, length in raw.items():
            for off in range(-5, 6):
                b = (ang + off) % 180
                windowed[b] = windowed.get(b, 0.0) + length
        top_angle = max(windowed, key=windowed.get)
        top_length = windowed[top_angle]
    else:
        ox, oy = outward
        # Perpendicular to outward = facade orientation (mod 180).
        facade_dir_deg = (math.degrees(math.atan2(oy, ox)) + 90.0) % 180.0
        # Score every edge.
        cx = sum(p[0] for p in ring) / len(ring)
        cy = sum(p[1] for p in ring) / len(ring)
        candidates: list[tuple[float, float, float]] = []  # (out_score, angle, length)
        for i in range(len(ring) - 1):
            x1, y1 = ring[i]
            x2, y2 = ring[i + 1]
            length = math.hypot(x2 - x1, y2 - y1)
            if length < 1.0:
                continue
            mx, my = (x1 + x2) / 2 - cx, (y1 + y2) / 2 - cy
            out_score = mx * ox + my * oy
            ang = math.degrees(math.atan2(y2 - y1, x2 - x1)) % 180.0
            delta = min((ang - facade_dir_deg) % 180.0, (facade_dir_deg - ang) % 180.0)
            if delta > 35.0:
                continue
            candidates.append((out_score, ang, length))
        if not candidates:
            # No edge is parallel-ish to the street — building has weird
            # geometry. Fall back to the canonical perpendicular direction.
            return (facade_dir_deg, 0.0, False)
        candidates.sort(reverse=True)
        # The top candidate AND any other candidate within 70% of its score
        # AND adjacent in the polygon → these collectively form the facade.
        top_score, top_angle, top_length = candidates[0]
        # Sum lengths of all qualifying parallel-to-street edges that are
        # within 90% of the top outward-score (handles facades that are
        # split across multiple short polygon edges).
        sum_length = sum(c[2] for c in candidates if c[0] >= 0.9 * top_score)
        top_length = max(top_length, sum_length)

    # Corner check: re-run the longest-edge scan and look for a heavy
    # cluster perpendicular (±10° of 90°) to the chosen facade.
    raw = edge_lengths_by_orientation(ring)
    is_corner = False
    if raw:
        wnd: dict[int, float] = {}
        for ang, length in raw.items():
            for off in range(-5, 6):
                b = (ang + off) % 180
                wnd[b] = wnd.get(b, 0.0) + length
        max_mass = max(wnd.values())
        for ang, length in wnd.items():
            delta = min((ang - top_angle) % 180.0, (top_angle - ang) % 180.0)
            if 80 <= delta <= 100 and length >= 0.40 * max_mass:
                is_corner = True
                break

    return (float(top_angle), float(top_length), is_corner)


# ---------------------------------------------------------------------------
# Match scoring
# ---------------------------------------------------------------------------

@dataclass
class MatchResult:
    a_bin: str
    b_bin: str
    side: str
    inliers: int
    aligned: int
    y_std: float
    L_std: float
    L_px: float           # median pixel column in A where B's left edge belongs
    feature_offset_m: float
    scores: dict
    confidence: str


def score_match(inliers: int, y_std: float, L_std: float) -> dict:
    """Combine the three sub-signals into a unit-interval score."""
    inlier = min(1.0, inliers / 10.0)        # saturates at 10 inliers
    precision = math.exp(-y_std / 20.0)      # tight y match = high precision
    consistency = math.exp(-L_std / 30.0)    # tight L cluster = consistent offset
    overall = inlier * precision * consistency
    return {
        "inlier": round(inlier, 3),
        "precision": round(precision, 3),
        "consistency": round(consistency, 3),
        "overall": round(overall, 3),
    }


def confidence_bucket(score: float) -> str:
    if score >= HIGH_THRESH:
        return "high"
    if score >= MED_THRESH:
        return "med"
    return "low"


def match_pair(a: BuildingMeta, b: BuildingMeta, side: str, *, verbose: bool = False) -> MatchResult | None:
    """SIFT-match the right strip of photo A against the left strip of photo B.

    Returns None if either image is unreadable. Otherwise returns a fully
    populated MatchResult, even when the score ends up low — the renderer
    needs to know about every seam to decide which to trust.
    """
    img_a = cv2.imread(str(a.photo_path), cv2.IMREAD_GRAYSCALE)
    img_b = cv2.imread(str(b.photo_path), cv2.IMREAD_GRAYSCALE)
    if img_a is None or img_b is None:
        return None
    Wa = img_a.shape[1]
    sw = max(1, int(Wa * STRIP_FRAC))
    strip_a = img_a[:, Wa - sw:]
    strip_b = img_b[:, :sw]

    sift = cv2.SIFT_create(nfeatures=SIFT_NFEATURES)
    ka, da = sift.detectAndCompute(strip_a, None)
    kb, db = sift.detectAndCompute(strip_b, None)
    if da is None or db is None or len(ka) < 8 or len(kb) < 8:
        return _empty_result(a, b, side)

    bf = cv2.BFMatcher(cv2.NORM_L2)
    raw = bf.knnMatch(da, db, k=2)
    # Lowe's ratio test
    good = [m for m, n in raw if m.distance < LOWE_RATIO * n.distance]
    # Vertical-alignment filter — WPA shot all photos at near-identical
    # camera height, so legit cross-photo matches must have ~equal y.
    aligned = [m for m in good
               if abs(ka[m.queryIdx].pt[1] - kb[m.trainIdx].pt[1]) < Y_ALIGN_TOL_PX]
    if len(aligned) < 4:
        return _empty_result(a, b, side, aligned=len(aligned))

    # Compute the column in A's full-photo coords where B's left edge
    # belongs, given each y-aligned match. Median is robust; std measures
    # how consistently the matches agree on the offset.
    Ls = []
    y_diffs = []
    for m in aligned:
        xa = ka[m.queryIdx].pt[0]
        xb = kb[m.trainIdx].pt[0]
        ya = ka[m.queryIdx].pt[1]
        yb = kb[m.trainIdx].pt[1]
        Ls.append((Wa - sw) + xa - xb)
        y_diffs.append(ya - yb)
    Ls = np.asarray(Ls)
    y_diffs = np.asarray(y_diffs)
    L_med = float(np.median(Ls))
    inlier_mask = np.abs(Ls - L_med) < INLIER_BAND_PX
    inliers = int(inlier_mask.sum())
    # Score precision/consistency on inliers only — outliers from texture
    # noise (brick patterns matching at random heights) shouldn't punish a
    # genuinely strong cluster.
    if inliers >= 2:
        L_std = float(np.std(Ls[inlier_mask]))
        y_std = float(np.std(y_diffs[inlier_mask]))
        # Also refine the offset to the inlier mean — more accurate than
        # the all-matches median when there's a long tail of outliers.
        L_med = float(np.mean(Ls[inlier_mask]))
    else:
        L_std = float(np.std(Ls))
        y_std = float(np.std(y_diffs))

    scores = score_match(inliers, y_std, L_std)
    confidence = confidence_bucket(scores["overall"])

    # Convert pixel offset to scene meters using A's pixels-per-meter.
    # In the renderer: A's plane is rendered at width = a.frontage_m (real
    # lot frontage), so 1 photo-pixel of A = a.frontage_m / a.photo_w meters.
    # The offset L_med is the column in A where B's LEFT edge should sit;
    # that means the gap (or overlap) between A's right edge and B's left
    # edge is (L_med - a.photo_w) * (a.frontage_m / a.photo_w).
    if a.frontage_m > 0 and a.photo_w > 0:
        m_per_px = a.frontage_m / a.photo_w
        feature_offset_m = round((L_med - a.photo_w) * m_per_px, 3)
    else:
        feature_offset_m = 0.0

    if verbose:
        print(f"    lot {a.lot}->{b.lot}: inliers={inliers}/{len(aligned)}/{len(good)}  "
              f"y_std={y_std:.1f}  L_std={L_std:.1f}  L={L_med:.1f}px  "
              f"offset={feature_offset_m:+.2f}m  score={scores['overall']:.2f} [{confidence}]")

    return MatchResult(
        a_bin=a.bin, b_bin=b.bin, side=side,
        inliers=inliers, aligned=len(aligned),
        y_std=y_std, L_std=L_std, L_px=L_med,
        feature_offset_m=feature_offset_m,
        scores=scores, confidence=confidence,
    )


def _empty_result(a: BuildingMeta, b: BuildingMeta, side: str, *, aligned: int = 0) -> MatchResult:
    return MatchResult(
        a_bin=a.bin, b_bin=b.bin, side=side,
        inliers=0, aligned=aligned,
        y_std=0.0, L_std=0.0, L_px=0.0,
        feature_offset_m=0.0,
        scores={"inlier": 0.0, "precision": 0.0, "consistency": 0.0, "overall": 0.0},
        confidence="low",
    )


# ---------------------------------------------------------------------------
# Per-block pipeline
# ---------------------------------------------------------------------------

def gather_block(buildings: list[dict]) -> list[BuildingMeta]:
    """Project geometry, derive frontage + side for every photo'd building."""
    metas: list[BuildingMeta] = []
    if not buildings:
        return metas

    # Reference for projection = first vertex of the first building's outer ring.
    first_ring = outer_ring(buildings[0])
    if not first_ring:
        return metas
    ref_lon, ref_lat = first_ring[0][0], first_ring[0][1]
    project = project_factory(ref_lon, ref_lat)

    rings_m: list[tuple[dict, list[tuple[float, float]], tuple[float, float]]] = []
    for b in buildings:
        if not b.get("photo"):
            continue
        ring = outer_ring(b)
        if len(ring) < 3:
            continue
        pts = [project(lon, lat) for lon, lat in ring]
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        rings_m.append((b, pts, (cx, cy)))

    if not rings_m:
        return metas

    # Principal axis of the WHOLE block = the dominant street direction.
    # We use it for projecting frontage; per-side axes get refined below.
    centroids = [c for _, _, c in rings_m]
    ax, ay = principal_axis(centroids)
    # Block centroid — anchor for the outward-radial direction passed to
    # dominant_facade so it picks the street-facing edge, not the longest.
    bcx = sum(c[0] for c in centroids) / len(centroids)
    bcy = sum(c[1] for c in centroids) / len(centroids)

    # First pass: build BuildingMeta with frontage + axis position, no side yet.
    pre: list[BuildingMeta] = []
    for b, pts, (cx, cy) in rings_m:
        ts = [px * ax + py * ay for px, py in pts]
        axis_start = min(ts)
        axis_end = max(ts)
        frontage = axis_end - axis_start
        # Pick facade by longest-edge bucket (no outward radial).
        # Longest-edge gave the best SIFT seam quality in tests — buildings
        # whose dominant edge is parallel-to-street produce clean axis
        # progressions, and buildings where it's perpendicular (narrow
        # rowhouses) end up with their depth as the projection axis but
        # SIFT still works because the projection direction is consistent
        # within a side.
        facade_angle, facade_length, is_corner = dominant_facade(pts)

        photo = b["photo"]
        url = photo["url"]
        pre.append(BuildingMeta(
            bin=str(b["bin"]),
            lot=int(b.get("lot", 0)),
            photo_w=int(photo.get("w", 682)),
            photo_h=int(photo.get("h", 1024)),
            photo_path=ROOT / "public" / url.lstrip("/"),
            centroid_m=(cx, cy),
            ring_m=pts,
            axis_start=axis_start,
            axis_end=axis_end,
            frontage_m=frontage,
            perp=0.0,
            side="",  # filled below
            facade_angle_deg=facade_angle,
            facade_length_m=facade_length,
            is_corner=is_corner,
        ))

    # Side detection by NYC lot-number contiguity. NYC tax lots are
    # numbered sequentially along each street frontage of a block, with
    # large jumps when the numbering wraps around a corner. Group runs of
    # consecutive lot numbers (gap < LOT_GAP_THRESHOLD) into one side.
    pre.sort(key=lambda m: m.lot)
    side_id = 0
    prev_lot: int | None = None
    for m in pre:
        if prev_lot is not None and m.lot - prev_lot >= LOT_GAP_THRESHOLD:
            side_id += 1
        m.side = f"side_{chr(ord('a') + side_id)}"
        prev_lot = m.lot

    # Per-side axis refinement. Use the side's MEDIAN FACADE ANGLE — that's
    # the direction the buildings physically face, not just the PCA of their
    # centroids (which can be misled by a single big corner building or a
    # row that bends slightly). Falls back to centroid PCA when fewer than
    # 2 buildings on the side.
    by_side: dict[str, list[BuildingMeta]] = {}
    for m in pre:
        by_side.setdefault(m.side, []).append(m)
    for side, members in by_side.items():
        if len(members) < 2:
            # Single-building side (often a corner): use its own facade angle.
            m = members[0]
            ang_rad = math.radians(m.facade_angle_deg)
            sax, say = math.cos(ang_rad), math.sin(ang_rad)
        else:
            # Median angle (mod 180) — use the longer-edge bucket for each
            # building so corner buildings vote for their primary frontage.
            angles = sorted(m.facade_angle_deg for m in members)
            median_ang = angles[len(angles) // 2]
            ang_rad = math.radians(median_ang)
            sax, say = math.cos(ang_rad), math.sin(ang_rad)
        for m in members:
            ts = [px * sax + py * say for px, py in m.ring_m]
            m.axis_start = min(ts)
            m.axis_end = max(ts)
            m.frontage_m = m.axis_end - m.axis_start

    metas.extend(pre)
    return metas


def process_block(buildings: list[dict], block_id: str, *, verbose: bool = False) -> dict:
    metas = gather_block(buildings)
    if not metas:
        return {"buildings": {}, "sides": {}, "seams": [], "summary": {"total": 0}}

    # Sort each side by axis position so seams pair PHYSICALLY adjacent
    # buildings, not lot-number-adjacent ones. NYC tax lots aren't always
    # contiguous along a frontage — interior lots and re-platting can put
    # lot 23 spatially between lots 16 and 17. The previous lot-sort hid
    # this and asked SIFT to match wall textures from non-neighbors.
    by_side: dict[str, list[BuildingMeta]] = {}
    for m in metas:
        by_side.setdefault(m.side, []).append(m)
    for side in by_side:
        by_side[side].sort(key=lambda m: m.axis_start)

    # Buildings dict for renderer.
    buildings_out: dict[str, dict] = {}
    for m in metas:
        buildings_out[m.bin] = {
            "lot": m.lot,
            "side": m.side,
            "frontage_m": round(m.frontage_m, 3),
            "axis_start": round(m.axis_start, 3),
            "axis_end": round(m.axis_end, 3),
            "photo_w": m.photo_w,
            "photo_h": m.photo_h,
            "facade_angle_deg": round(m.facade_angle_deg, 1),
            "facade_length_m": round(m.facade_length_m, 2),
            "is_corner": m.is_corner,
        }
    sides_out = {s: [m.bin for m in arr] for s, arr in by_side.items()}

    # Seam pass.
    seams: list[dict] = []
    for side, arr in by_side.items():
        if verbose:
            print(f"  {block_id} / {side}: {len(arr)} buildings")
        for i in range(len(arr) - 1):
            res = match_pair(arr[i], arr[i + 1], side, verbose=verbose)
            if res is None:
                continue
            seams.append({
                "a_bin": res.a_bin,
                "b_bin": res.b_bin,
                "side": res.side,
                "raw": {
                    "inliers": res.inliers,
                    "aligned": res.aligned,
                    "y_std": round(res.y_std, 2),
                    "L_std": round(res.L_std, 2),
                    "L_px": round(res.L_px, 1),
                },
                "scores": res.scores,
                "confidence": res.confidence,
                "feature_offset_m": res.feature_offset_m,
            })

    summary = {
        "high": sum(1 for s in seams if s["confidence"] == "high"),
        "med": sum(1 for s in seams if s["confidence"] == "med"),
        "low": sum(1 for s in seams if s["confidence"] == "low"),
        "total": len(seams),
    }
    return {
        "buildings": buildings_out,
        "sides": sides_out,
        "seams": seams,
        "summary": summary,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def select_blocks(manifest: dict, all_blocks: bool, only_block: str | None) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for b in manifest.get("buildings", []):
        if not b.get("photo"):
            continue
        boro = b.get("boro")
        block = b.get("block")
        if boro is None or block is None:
            continue
        key = f"{boro}-{block}"
        if only_block and key != only_block:
            continue
        if not all_blocks and not only_block and key != "1-585":
            continue
        out.setdefault(key, []).append(b)
    return out


def main() -> None:
    global HIGH_THRESH, MED_THRESH
    p = argparse.ArgumentParser(description="Score & resolve seams for the 1940s walk.")
    p.add_argument("--all-blocks", action="store_true", help="Process every block in the manifest.")
    p.add_argument("--block", default=None, help="Process only this block (e.g., 1-585).")
    p.add_argument("--verbose", "-v", action="store_true", help="Print per-pair scores.")
    p.add_argument("--high", type=float, default=HIGH_THRESH)
    p.add_argument("--med", type=float, default=MED_THRESH)
    args = p.parse_args()
    HIGH_THRESH = args.high
    MED_THRESH = args.med

    if not MANIFEST_PATH.exists():
        sys.exit(f"manifest not found at {MANIFEST_PATH}")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    blocks = select_blocks(manifest, args.all_blocks, args.block)
    if not blocks:
        sys.exit("no matching blocks")

    print(f"processing {len(blocks)} block(s)")
    blocks_out: dict[str, dict] = {}
    t0 = time.time()
    for key, buildings in blocks.items():
        print(f"\n[{key}] {len(buildings)} buildings with photos")
        b_t0 = time.time()
        blocks_out[key] = process_block(buildings, key, verbose=args.verbose)
        s = blocks_out[key]["summary"]
        dt = time.time() - b_t0
        print(f"  done in {dt:.1f}s — seams: {s['high']} high / {s['med']} med / "
              f"{s['low']} low / {s['total']} total")

    payload = {
        "version": 1,
        "model": "sift+ransac (cv2 SIFT, y-aligned, ratio test, RANSAC-by-median)",
        "scoring": {"high": HIGH_THRESH, "med": MED_THRESH},
        "generated_at": int(time.time()),
        "blocks": blocks_out,
    }
    OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    elapsed = time.time() - t0
    print(f"\nwrote {OUT_PATH.relative_to(ROOT)}  ({elapsed:.1f}s total)")


if __name__ == "__main__":
    main()
