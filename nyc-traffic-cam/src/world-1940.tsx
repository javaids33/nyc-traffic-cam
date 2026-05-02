/* /world1940 — first-person walk through 1940 NYC, GPU-rendered.

   We're standing in the middle of the street where the WPA tax-photo
   surveyor stood. Every photo is mapped to a textured plane sized to
   its building's real height (h_roof from NYC Open Data) and placed
   along a virtual street. NYC lot numbers run sequentially along each
   side of a block, so we split block 1-585 in half: low lot numbers on
   the right side, high lot numbers on the left, both facing the
   street. As you walk forward you pass real 1940 facades on both
   shoulders.

   Controls: click the canvas to enter pointer-lock, then WASD to walk,
   mouse to look, shift to sprint, esc to release. Click any building
   (without locking first) to see the original photo full-size. */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

interface Photo { url: string; w: number; h: number }
interface Building {
  bin: string;
  bbl: string;
  boro: number;
  block: number;
  lot: number;
  year: number | null;
  h_roof: number | null;
  h_ground: number | null;
  geom: { type: 'MultiPolygon'; coordinates: number[][][][] };
  photo: Photo | null;
}
interface Manifest { version: number; count: number; with_photo: number; buildings: Building[] }

interface PhotoAnalysis {
  facade_top: number;     // 0..1 fraction of photo height (0 = top edge)
  facade_bottom: number;
  dominant_color: string; // "#rrggbb"
  style: string;
  has_signage: boolean;
  has_vehicles: boolean;
  has_people: boolean;
  notes: string;
}
interface AnalysisFile { version: number; buildings: Record<string, PhotoAnalysis> }

// Output of server/stitch_neighbors.py — per-block stitch resolution data.
interface StitchBuilding {
  lot: number;
  side: string;       // "side_a", "side_b", ...
  frontage_m: number; // real along-street width from the footprint geometry
  axis_start: number;
  axis_end: number;
  photo_w: number;
  photo_h: number;
}
interface StitchSeam {
  a_bin: string;
  b_bin: string;
  side: string;
  raw: { inliers: number; aligned: number; y_std: number; L_std: number; L_px: number };
  scores: { inlier: number; precision: number; consistency: number; overall: number };
  confidence: 'high' | 'med' | 'low';
  feature_offset_m: number;
}
interface StitchBlock {
  buildings: Record<string, StitchBuilding>;
  sides: Record<string, string[]>;     // side → ordered list of bins
  seams: StitchSeam[];
  summary: { high: number; med: number; low: number; total: number };
}
interface StitchFile {
  version: number;
  scoring: { high: number; med: number };
  blocks: Record<string, StitchBlock>;  // key = "<boro>-<block>", e.g. "1-585"
}

const DATA_URL = '/data-1940s.json';
const ANALYSIS_URL = '/photo-analysis-1940s.json';
const STITCH_URL = '/photo-stitch-1940s.json';
// Per-side panoramas baked by server/diffuse_seams.py. When a side's
// panorama exists we render it as one big plane instead of N small
// planes — every seam gap is already SDXL-inpainted, no per-plane
// cross-fade needed.
const STITCHED_URL = (block: string, side: string) => `/photo-stitched/${block}-${side}.png`;
// Diffuse sweep used PX_PER_M=80 at CANVAS_HEIGHT=1024px → 12.8m tall
// continuous wall. Must match server/diffuse_seams.py.
const PANORAMA_PX_PER_M = 80;
const PANORAMA_HEIGHT_M = 1024 / PANORAMA_PX_PER_M;
const FOOT_TO_M = 0.3048;
const M_PER_LAT_DEG = 111320;
const EYE_HEIGHT = 1.7;             // m, eye level
const STREET_WIDTH_M = 12;          // sidewalk + asphalt + sidewalk
const SIDEWALK_WIDTH_M = 2.5;
const FACADE_OFFSET_M = STREET_WIDTH_M / 2 - 0.3; // photo plane sits just inside the sidewalk
const LOT_SEAM_M = 4;               // gap injected when lot # jumps
const LOT_SEAM_THRESHOLD = 5;
// Each photo plane is widened by this much on each side so the outer
// strips alpha-fade into the neighbor's plane → hard seams disappear.
const SEAM_OVERLAP_M = 0.6;
// Soft-edge alpha falloff width as a fraction of plane UV (0..1). A larger
// number = softer dissolve, a smaller number = sharper but still seamless.
const EDGE_FADE_FRAC = 0.08;
// When the stitch engine reports a high-confidence feature match between
// two consecutive photos, we shift the second plane by feature_offset_m
// (negative = overlap, positive = gap). Clamped because spurious matches
// can produce huge offsets that would cause visual collisions.
const STITCH_OFFSET_CLAMP_M = 2.0;

function buildingHeightM(b: Building): number {
  const ft = (b.h_roof != null && b.h_ground != null)
    ? b.h_roof - b.h_ground
    : (b.h_roof ?? 35);
  return Math.max(4.2, ft * FOOT_TO_M);
}

interface Placed {
  b: Building;
  x: number;       // X position of the building's left edge (lot boundary)
  width: number;   // real along-street frontage in meters
  height: number;  // up in meters
}

// Flatten a MultiPolygon into the outer ring's vertex list (we only use
// the outer ring for frontage; holes are interior courtyards we ignore).
function outerRing(b: Building): [number, number][] {
  const coords = b.geom?.coordinates;
  if (!coords?.length || !coords[0]?.length || !coords[0][0]?.length) return [];
  return coords[0][0] as unknown as [number, number][];
}

// Project (lon, lat) to local meters around a reference. Good enough for
// a single block (a few hundred meters across) without going full UTM.
function makeProjector(refLon: number, refLat: number) {
  const mPerLon = M_PER_LAT_DEG * Math.cos((refLat * Math.PI) / 180);
  return (lon: number, lat: number): [number, number] => [
    (lon - refLon) * mPerLon,
    (lat - refLat) * M_PER_LAT_DEG,
  ];
}

// PCA on a list of 2D points → angle of the principal axis (the street
// direction for a row of building centroids). Returns angle in radians.
function principalAngle(pts: [number, number][]): number {
  const n = pts.length;
  if (n < 2) return 0;
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= n; cy /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) {
    const dx = x - cx, dy = y - cy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

// Compute every building's true street-frontage (in meters) by projecting
// its footprint onto the row's principal axis. Returns Map<bin, frontage_m>
// plus the row's axis origin so we can also lay them out at correct gaps.
interface FrontageInfo {
  width: number;     // real frontage along the street axis
  axisStart: number; // projected coord of the leftmost vertex along axis
  axisEnd: number;   // projected coord of the rightmost vertex along axis
}
function computeFrontages(buildings: Building[]): Map<string, FrontageInfo> {
  const out = new Map<string, FrontageInfo>();
  if (!buildings.length) return out;

  // Reference = first vertex of first building (any consistent point works).
  const firstRing = outerRing(buildings[0]);
  if (!firstRing.length) return out;
  const [refLon, refLat] = firstRing[0];
  const project = makeProjector(refLon, refLat);

  // Centroid of each building in local meters → principal axis = street.
  const centroids: [number, number][] = [];
  const ringsM: { bin: string; pts: [number, number][] }[] = [];
  for (const b of buildings) {
    const ring = outerRing(b);
    if (!ring.length) continue;
    const pts = ring.map(([lo, la]) => project(lo, la));
    let cx = 0, cy = 0;
    for (const [x, y] of pts) { cx += x; cy += y; }
    cx /= pts.length; cy /= pts.length;
    centroids.push([cx, cy]);
    ringsM.push({ bin: b.bin, pts });
  }
  const angle = principalAngle(centroids);
  const ax = Math.cos(angle), ay = Math.sin(angle);

  for (const { bin, pts } of ringsM) {
    let lo = Infinity, hi = -Infinity;
    for (const [x, y] of pts) {
      const t = x * ax + y * ay;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    out.set(bin, { width: hi - lo, axisStart: lo, axisEnd: hi });
  }
  return out;
}

function layoutSide(buildings: Building[]): { placed: Placed[]; totalLength: number } {
  const sorted = [...buildings].sort((a, b) => a.lot - b.lot);
  const placedBuildings = sorted.filter(b => b.photo);
  const frontages = computeFrontages(placedBuildings);

  // Origin: project the leftmost-lot's axis coord to 0 in scene-X.
  let originAxis: number | null = null;
  for (const b of placedBuildings) {
    const f = frontages.get(b.bin);
    if (f) { originAxis = f.axisStart; break; }
  }

  const placed: Placed[] = [];
  let prevLot: number | null = null;
  let prevX: number | null = null;
  let cursorX = 0;
  for (const b of placedBuildings) {
    const height = buildingHeightM(b);
    const f = frontages.get(b.bin);

    let width: number;
    let x: number;
    if (f && originAxis != null && f.width > 1.5 && f.width < 100) {
      // Real geometry: place at the lot's projected position so adjacent
      // lots butt up against each other at their actual boundaries.
      width = f.width;
      x = f.axisStart - originAxis;
    } else {
      // Fallback: photo aspect (legacy behavior) when geom is missing.
      const aspect = b.photo!.w / b.photo!.h;
      width = height * aspect;
      x = prevX != null ? prevX : cursorX;
    }

    // Inject a visible gap when the lot-number jumps a lot (cross street).
    if (prevLot != null && b.lot - prevLot > LOT_SEAM_THRESHOLD && prevX != null) {
      const gap = LOT_SEAM_M;
      x = Math.max(x, prevX + gap);
    }

    placed.push({ b, x, width, height });
    prevX = x + width;
    cursorX = prevX;
    prevLot = b.lot;
  }
  return { placed, totalLength: cursorX };
}

// Build the per-side `Placed[]` lists from the stitch engine's resolved
// data. Each side gets laid out independently. For high-confidence seams
// we offset the next plane by the SIFT-derived feature_offset_m (clamped
// to ±STITCH_OFFSET_CLAMP_M to keep spurious matches from causing visual
// collisions). For med/low we just butt the next plane against the
// previous one's right edge.
function layoutFromStitch(buildings: Building[], block: StitchBlock): { sides: Placed[][]; totalLength: number } {
  const byBin = new Map(buildings.map(b => [b.bin, b]));
  // Index seams as (a_bin, side) → seam for O(1) lookup during walk.
  const seamByPair = new Map<string, StitchSeam>();
  for (const s of block.seams) {
    seamByPair.set(`${s.side}|${s.a_bin}|${s.b_bin}`, s);
  }

  const sides: Placed[][] = [];
  let totalLength = 0;
  for (const [sideId, bins] of Object.entries(block.sides)) {
    const placed: Placed[] = [];
    let prevX: number | null = null;
    let prevWidth = 0;
    let prevBin: string | null = null;
    for (const bin of bins) {
      const b = byBin.get(bin);
      const meta = block.buildings[bin];
      if (!b || !b.photo || !meta) continue;
      const height = buildingHeightM(b);
      const width = meta.frontage_m > 1.5 && meta.frontage_m < 100
        ? meta.frontage_m
        : (b.photo.w / b.photo.h) * height;

      let x: number;
      if (prevX == null) {
        x = 0;
      } else {
        const seam = prevBin ? seamByPair.get(`${sideId}|${prevBin}|${bin}`) : undefined;
        let offset = 0; // default: butt up against previous (no gap, no overlap)
        if (seam && seam.confidence === 'high') {
          // SIFT-derived offset, clamped so wild matches can't cause
          // overlapping building collisions.
          offset = Math.max(-STITCH_OFFSET_CLAMP_M, Math.min(STITCH_OFFSET_CLAMP_M, seam.feature_offset_m));
        }
        x = prevX + prevWidth + offset;
      }
      placed.push({ b, x, width, height });
      prevX = x;
      prevWidth = width;
      prevBin = bin;
    }
    if (placed.length) {
      const sideEnd = placed[placed.length - 1].x + placed[placed.length - 1].width;
      if (sideEnd > totalLength) totalLength = sideEnd;
    }
    sides.push(placed);
  }
  return { sides, totalLength };
}

// ──────────────────────────────────────────────────────────────────────
// Yellow-cab interior cage that follows the camera. We're "driving by"
// in the back of a Crown Vic cab; the interior is built from cheap
// geometric primitives (yellow paint, black trim, dashboard, steering
// wheel, side windows with the iconic NYC "cracked open" gap at the top
// of the rear passenger window). Built in cab-local coords where -Z is
// forward (the windshield), +Z is back (the rear window). On every
// frame we copy camera.position+quaternion onto the cab so it rotates
// with the head turn — looking out the windshield, side, or back window
// happens naturally as you yaw past 0°, ±90°, 180°.
// ──────────────────────────────────────────────────────────────────────
const CAB_YELLOW = 0xffd417;     // brighter, more saturated cab yellow
const CAB_TRIM = 0x0d0d0e;
const CAB_DASH = 0x1a140f;       // warm dark dashboard tone
const CAB_SEAT = 0x2a1f17;       // worn brown vinyl
const CAB_CHROME = 0xc8c0b0;     // slightly tarnished chrome

interface CabRig {
  group: THREE.Group;
  update: (camera: THREE.PerspectiveCamera) => void;
}

function buildTaxiCab(scene: THREE.Scene): CabRig {
  const g = new THREE.Group();
  g.renderOrder = 100; // draw on top of world for proper occlusion
  const trimMat = new THREE.MeshBasicMaterial({ color: CAB_TRIM, fog: false, side: THREE.DoubleSide });
  const yellowMat = new THREE.MeshBasicMaterial({ color: CAB_YELLOW, fog: false });
  const dashMat = new THREE.MeshBasicMaterial({ color: CAB_DASH, fog: false });
  const seatMat = new THREE.MeshBasicMaterial({ color: CAB_SEAT, fog: false });

  // We're a passenger in the BACK SEAT of the cab. Cab proportions
  // tuned so the windshield + side windows leave a generous opening
  // for the world; only ~25% of FOV is interior trim.

  // YELLOW HOOD — sits low and recedes toward the bumper. A textured
  // gradient (back = bright cab yellow, front = darker amber, hint of
  // a center-line bead crease) makes it read as a curving sheet-metal
  // panel catching light, instead of the flat-slab "yellow rectangle
  // on the road" look from before. Sized to occupy ~12% of vertical
  // FOV so it grounds the view without dominating it.
  const hoodTex = makeHoodGradient();
  const hood = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 1.6),
    new THREE.MeshBasicMaterial({ map: hoodTex, fog: false, transparent: true }),
  );
  hood.rotation.x = -Math.PI / 2 + 0.10;   // tilt up slightly toward camera
  hood.position.set(0, -1.55, -3.10);
  g.add(hood);
  // Chrome bumper strip at the leading edge of the hood — narrow band
  // that reads as the front-edge highlight.
  const bumper = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 0.05),
    new THREE.MeshBasicMaterial({ color: CAB_CHROME, fog: false }),
  );
  bumper.position.set(0, -1.46, -3.86);
  bumper.rotation.x = -0.03;
  g.add(bumper);
  // Hood ornament — tiny chrome silhouette dead-center, just above
  // the leading edge. Reads as "cab", not "rectangle".
  const ornament = new THREE.Mesh(
    new THREE.PlaneGeometry(0.05, 0.13),
    new THREE.MeshBasicMaterial({ color: CAB_CHROME, fog: false }),
  );
  ornament.position.set(0, -1.36, -3.84);
  g.add(ornament);
  // Tiny "checker" medallion under the ornament — three black/yellow
  // squares forming the iconic taxi checker. Reinforces "this is a
  // cab" at a glance.
  const checkerTex = makeCheckerMedallion();
  const medallion = new THREE.Mesh(
    new THREE.PlaneGeometry(0.18, 0.05),
    new THREE.MeshBasicMaterial({ map: checkerTex, fog: false, transparent: true }),
  );
  medallion.position.set(0, -1.43, -3.83);
  medallion.rotation.x = -0.04;
  g.add(medallion);

  // WINDSHIELD FRAME — top crossbar high, A-pillars at the actual frame
  // edges so they read as "windshield border", not "view-blocker".
  const winTop = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.12), trimMat);
  winTop.position.set(0, 0.85, -1.05);
  g.add(winTop);
  for (const x of [-1.65, 1.65]) {
    const pillar = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 2.0), trimMat);
    pillar.position.set(x, -0.10, -1.05);
    g.add(pillar);
  }

  // DASHBOARD — angled wedge at the windshield base.
  const dash = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.4), dashMat);
  dash.position.set(0, -0.95, -1.0);
  dash.rotation.x = -0.30;
  g.add(dash);

  // FRONT SEAT BACKS visible just below the dashboard line (we're behind them).
  const frontSeats = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.55), seatMat);
  frontSeats.position.set(0, -0.65, -0.55);
  frontSeats.rotation.x = -0.05;
  g.add(frontSeats);

  // SIDE WINDOWS — door panels are yellow exterior; window opening is
  // the negative space framed by B/C pillars + a thin top trim. The
  // PASSENGER (right) side has a "cracked open" gap in the top trim.
  for (const sign of [-1, 1]) {
    // Door panel below the window opening (yellow paint) — pushed lower
    // so it stays in the peripheral floor area not dominating side view.
    const door = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.9), yellowMat);
    door.position.set(sign * 1.55, -1.30, 0.3);
    door.rotation.y = sign > 0 ? -Math.PI / 2 : Math.PI / 2;
    g.add(door);
    // B-pillar (between front and back doors)
    const bPillar = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 1.6), trimMat);
    bPillar.position.set(sign * 1.55, -0.10, -0.55);
    bPillar.rotation.y = sign > 0 ? -Math.PI / 2 : Math.PI / 2;
    g.add(bPillar);
    // C-pillar (behind back seat)
    const cPillar = new THREE.Mesh(new THREE.PlaneGeometry(0.20, 1.6), trimMat);
    cPillar.position.set(sign * 1.55, -0.10, 2.0);
    cPillar.rotation.y = sign > 0 ? -Math.PI / 2 : Math.PI / 2;
    g.add(cPillar);
    // Side-window top trim — driver side full, passenger side cracked open
    if (sign > 0) {
      // Front portion of top trim
      const topF = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.09), trimMat);
      topF.position.set(sign * 1.15, 0.65, -0.05);
      topF.rotation.y = -Math.PI / 2;
      g.add(topF);
      // Back portion (gap between = cracked-open window)
      const topB = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.09), trimMat);
      topB.position.set(sign * 1.15, 0.65, 1.15);
      topB.rotation.y = -Math.PI / 2;
      g.add(topB);
    } else {
      const top = new THREE.Mesh(new THREE.PlaneGeometry(1.95, 0.09), trimMat);
      top.position.set(sign * 1.15, 0.65, 0.55);
      top.rotation.y = Math.PI / 2;
      g.add(top);
    }
  }

  // ROOF — dark headliner overhead.
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 2.5), trimMat);
  roof.rotation.x = Math.PI / 2;
  roof.position.set(0, 0.85, 0.4);
  g.add(roof);

  // BACK WINDOW FRAME (rear glass) — visible when fully turned.
  const backTop = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.13), trimMat);
  backTop.position.set(0, 0.65, 1.85);
  g.add(backTop);
  const backBot = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.45), seatMat);
  backBot.position.set(0, 0.05, 1.85);
  g.add(backBot);

  // REARVIEW MIRROR — small chrome rectangle in the upper third of the
  // windshield, off-center so it doesn't bisect the road view. Sized to
  // be a recognizable "cab interior" detail without dominating.
  const mirrorBack = new THREE.Mesh(
    new THREE.PlaneGeometry(0.24, 0.075),
    new THREE.MeshBasicMaterial({ color: CAB_TRIM, fog: false }),
  );
  mirrorBack.position.set(-0.22, 0.48, -0.95);
  g.add(mirrorBack);
  const mirrorGlass = new THREE.Mesh(
    new THREE.PlaneGeometry(0.21, 0.055),
    new THREE.MeshBasicMaterial({ color: CAB_CHROME, fog: false }),
  );
  mirrorGlass.position.set(-0.22, 0.48, -0.948);
  g.add(mirrorGlass);
  // A tiny short stalk anchoring the mirror to the windshield top trim.
  const mirrorStalk = new THREE.Mesh(
    new THREE.PlaneGeometry(0.025, 0.30),
    new THREE.MeshBasicMaterial({ color: CAB_TRIM, fog: false }),
  );
  mirrorStalk.position.set(-0.22, 0.65, -0.96);
  g.add(mirrorStalk);

  // TAXIMETER — single canvas-textured plate showing a 1940s Gamewell
  // mechanical fare meter (chrome bezel, "TAXIMETER / NYC" cartouche,
  // illuminated numeric display reading the fare). Replaces the previous
  // chrome+yellow primitive stack which read as "test cube" on the dash.
  // Sized smaller and pushed further off-center so it doesn't compete
  // with the forward view. The face is a single quad with the chrome
  // body, dial face, and numerals all painted into the texture.
  const meterTex = makeTaximeterTexture();
  const meter = new THREE.Mesh(
    new THREE.PlaneGeometry(0.30, 0.18),
    new THREE.MeshBasicMaterial({ map: meterTex, fog: false, transparent: true }),
  );
  meter.position.set(0.55, -0.50, -0.94);
  meter.rotation.x = -0.42;
  meter.rotation.y = -0.18;   // angled toward the back-seat passenger
  g.add(meter);

  scene.add(g);

  return {
    group: g,
    update(camera) {
      g.position.copy(camera.position);
      g.quaternion.copy(camera.quaternion);
    },
  };
}

// Canvas texture for the cab hood — vertical gradient from saturated
// CAB_YELLOW at the back (near windshield) to a darker amber at the
// front (near bumper). Implies a curving sheet-metal panel catching
// horizon light, instead of the previous flat-slab "yellow rectangle
// on the road" look. A faint center-line crease running back-to-front
// adds period-correct hood detail (Crown Vics had a raised center bead).
function makeHoodGradient(): THREE.CanvasTexture {
  const W = 256, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  // Plane UVs: V=0 bottom of plane (= front of hood, far from driver),
  // V=1 top (= back of hood, near windshield). CanvasTexture default
  // flipY=true → canvas Y=0 maps to V=1. So:
  //   canvas top    (Y=0)   → back of hood (closest to windshield)   → bright
  //   canvas bottom (Y=H)   → front of hood (closest to bumper)      → darker
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0.00, '#ffd417');   // back edge — full cab yellow
  grad.addColorStop(0.40, '#ffc312');
  grad.addColorStop(0.80, '#c98a08');   // front edge — darker amber
  grad.addColorStop(1.00, '#7a4f04');   // shadow under bumper
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Soft horizon highlight — single warm band near the back of the
  // hood implying the windshield reflecting in the paint. Subtle.
  ctx.globalAlpha = 0.18;
  const horizonGrad = ctx.createLinearGradient(0, 0, 0, H * 0.30);
  horizonGrad.addColorStop(0, 'rgba(255,245,200,0.6)');
  horizonGrad.addColorStop(1, 'rgba(255,245,200,0)');
  ctx.fillStyle = horizonGrad;
  ctx.fillRect(0, 0, W, H * 0.30);
  // Center-line crease (raised hood bead) — thin vertical highlight
  // tapered so it doesn't read as a print-line.
  ctx.globalAlpha = 0.14;
  const creaseGrad = ctx.createLinearGradient(0, 0, 0, H);
  creaseGrad.addColorStop(0, 'rgba(255,245,176,0.0)');
  creaseGrad.addColorStop(0.5, 'rgba(255,245,176,1)');
  creaseGrad.addColorStop(1, 'rgba(255,245,176,0.0)');
  ctx.fillStyle = creaseGrad;
  ctx.fillRect(W / 2 - 1.0, 0, 2.0, H);
  // Tiny darker corner shadows so the panel reads as inset under the
  // windshield + door overhang
  ctx.globalAlpha = 0.25;
  for (const x of [0, W - 60]) {
    const g3 = ctx.createLinearGradient(x, 0, x + 60, 0);
    if (x === 0) {
      g3.addColorStop(0, 'rgba(0,0,0,1)');
      g3.addColorStop(1, 'rgba(0,0,0,0)');
    } else {
      g3.addColorStop(0, 'rgba(0,0,0,0)');
      g3.addColorStop(1, 'rgba(0,0,0,1)');
    }
    ctx.fillStyle = g3;
    ctx.fillRect(x, 0, 60, H);
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

// Canvas texture for the dashboard taximeter face. Paints the chrome
// bezel, dark dial face, "TAXIMETER" cartouche, brand mark, and an
// illuminated 5-digit fare display all into a single quad. Much higher
// information density per polygon than the original 4-mesh primitive
// stack, and it actually reads as a 1940s mechanical meter at the
// resolution it occupies on screen (~5% of viewport).
function makeTaximeterTexture(): THREE.CanvasTexture {
  const W = 512, H = 320;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  // Transparent background so the dashboard surface shows through the
  // rounded-rect corners.
  ctx.clearRect(0, 0, W, H);
  // Chrome bezel — rounded outer plate with subtle vertical gradient
  const bezelGrad = ctx.createLinearGradient(0, 0, 0, H);
  bezelGrad.addColorStop(0, '#d6cfbe');
  bezelGrad.addColorStop(0.5, '#9d9685');
  bezelGrad.addColorStop(1, '#5e5648');
  ctx.fillStyle = bezelGrad;
  roundRect(ctx, 8, 8, W - 16, H - 16, 28);
  ctx.fill();
  // Inner bezel ring — slightly darker
  ctx.fillStyle = '#3a3326';
  roundRect(ctx, 24, 24, W - 48, H - 48, 22);
  ctx.fill();
  // Dial face — warm dark amber under glass
  const dialGrad = ctx.createRadialGradient(W / 2, H / 2 - 20, 20, W / 2, H / 2, 220);
  dialGrad.addColorStop(0, '#3a2208');
  dialGrad.addColorStop(1, '#1a1004');
  ctx.fillStyle = dialGrad;
  roundRect(ctx, 36, 36, W - 72, H - 72, 16);
  ctx.fill();
  // "TAXIMETER" cartouche at the top
  ctx.fillStyle = '#e6c98a';
  ctx.font = 'bold 26px ui-serif, Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('TAXIMETER', W / 2, 70);
  // Maker mark sub-line
  ctx.fillStyle = '#9a7d4a';
  ctx.font = '14px ui-serif, Georgia, serif';
  ctx.fillText('GAMEWELL · NYC', W / 2, 100);
  // Numeric fare display window — recessed black slot
  const wx = W * 0.18, wy = H * 0.42, ww = W * 0.64, wh = H * 0.30;
  ctx.fillStyle = '#0a0604';
  roundRect(ctx, wx, wy, ww, wh, 8);
  ctx.fill();
  // Illuminated digits — warm amber 7-segment style. Pre-bake "0.20"
  // as the resting fare (1940 NYC cab drop was $0.20).
  ctx.fillStyle = '#ffce40';
  ctx.shadowColor = '#ff9020';
  ctx.shadowBlur = 18;
  ctx.font = 'bold 78px ui-monospace, "Courier New", monospace';
  ctx.fillText('$0.20', W / 2, wy + wh / 2 + 4);
  ctx.shadowBlur = 0;
  // FARE label below the window
  ctx.fillStyle = '#9a7d4a';
  ctx.font = '13px ui-monospace, monospace';
  ctx.fillText('FARE', W / 2, H - 50);
  // Small "ON DUTY" pip — green dot top-left of the display
  ctx.fillStyle = '#5be055';
  ctx.beginPath();
  ctx.arc(wx + 12, wy - 14, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e6c98a';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('ON DUTY', wx + 22, wy - 11);
  // Tiny crank handle silhouette right side
  ctx.fillStyle = '#5e5648';
  roundRect(ctx, W - 56, H / 2 - 8, 22, 16, 3);
  ctx.fill();
  ctx.fillStyle = '#3a3326';
  ctx.beginPath();
  ctx.arc(W - 30, H / 2, 6, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// Tiny black/yellow checker medallion painted on a strip — sits below
// the hood ornament as a "TAXI CHECKER" badge. Two-row checkerboard.
function makeCheckerMedallion(): THREE.CanvasTexture {
  const W = 256, H = 64;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);
  // Two rows × eight squares
  const cols = 12, rows = 2;
  const sw = W / cols, sh = H / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = ((r + c) % 2 === 0) ? '#0d0d0e' : '#ffd417';
      ctx.fillRect(c * sw, r * sh, sw, sh);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Vertical alpha gradient: opaque in the bottom ~85%, fading to 0 at top.
// Applied as alphaMap on each side panorama so the rectangle's hard top
// edge dissolves into the scene's fog-sky instead of cutting like a billboard.
function makePanoramaTopFade(): THREE.CanvasTexture {
  const W = 4, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  // Three.js textures use bottom-up V coordinates. With CanvasTexture the
  // canvas paints top-down. So gradient TOP of canvas = TOP of UV space?
  // Actually CanvasTexture flips by default unless flipY=false.
  // We want: opaque at the BOTTOM of the plane (most of building), fading to
  // 0 at the TOP (sky meets fog). PlaneGeometry UVs put V=0 at bottom, V=1 at top.
  // CanvasTexture default flipY=true → canvas Y=0 maps to UV V=1 (top).
  // So we want WHITE at canvas Y=H (bottom of canvas → V=0 = bottom of plane)
  // and BLACK at canvas Y=0 (top of canvas → V=1 = top of plane).
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#000');           // top of plane → transparent
  grad.addColorStop(0.20, '#ffffff');     // 80% from bottom → opaque
  grad.addColorStop(1, '#ffffff');        // bottom → fully opaque
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

// Procedural asphalt texture with grain + paving blotches. Replaces the
// flat 0x3a3128 plane that read as "untextured tech demo".
function makeAsphaltTexture(): THREE.CanvasTexture {
  const W = 1024, H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  // Base layer — dark warm asphalt
  ctx.fillStyle = '#2c2520';
  ctx.fillRect(0, 0, W, H);
  // Per-pixel grain noise
  const img = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n * 0.8));
  }
  ctx.putImageData(img, 0, 0);
  // Larger paving blotches — patches of slightly different asphalt mix
  for (let i = 0; i < 140; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = 12 + Math.random() * 60;
    const tone = 30 + Math.random() * 25;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${tone}, ${tone - 5}, ${tone - 8}, 0.35)`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // A few "pothole" hints — darker dots
  for (let i = 0; i < 25; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = 4 + Math.random() * 14;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(10, 8, 6, 0.6)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Procedural sidewalk texture — concrete-grey slabs with seams every ~1m.
function makeSidewalkTexture(): THREE.CanvasTexture {
  const W = 512, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  // Base concrete
  ctx.fillStyle = '#7a6c5d';
  ctx.fillRect(0, 0, W, H);
  // Speckle
  const img = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 22;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  // Slab seams — vertical at 256, horizontal at 256 (= 1 m at our scale)
  ctx.strokeStyle = '#3a3128';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 256); ctx.lineTo(W, 256);
  ctx.moveTo(256, 0); ctx.lineTo(256, H);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Build a 1-row alpha gradient texture used as alphaMap on every photo
// plane: 0 at the outermost EDGE_FADE_FRAC, 1 in the middle. This is what
// turns hard plane seams into soft cross-fades when adjacent planes
// physically overlap by SEAM_OVERLAP_M on each side.
function makeEdgeFadeAlpha(): THREE.CanvasTexture {
  const W = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = 1;
  const ctx = cv.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  // Smooth in/out — black (alpha 0) at edges, white (alpha 1) in middle.
  grad.addColorStop(0, '#000');
  grad.addColorStop(EDGE_FADE_FRAC, '#fff');
  grad.addColorStop(1 - EDGE_FADE_FRAC, '#fff');
  grad.addColorStop(1, '#000');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 1);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

export default function World1940() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisFile | null>(null);
  const [stitch, setStitch] = useState<StitchFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Building | null>(null);
  const [walking, setWalking] = useState(false);
  // Treat narrow viewports as "mobile" for HUD layout. Tracked in state
  // (not just CSS) because we want to also collapse the description
  // text + swap controls hint, not just resize the panel.
  const [isCompact, setIsCompact] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 640,
  );
  useEffect(() => {
    const onResize = () => setIsCompact(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // Live position along the block (0..1). Driven by the render loop via
  // ref → minimap dot CSS, so we don't trigger React re-renders every
  // frame.
  const minimapDotRef = useRef<HTMLDivElement>(null);
  const streetLengthRef = useRef<number>(1);

  useEffect(() => {
    fetch(DATA_URL)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(setManifest)
      .catch(e => setError(String(e)));
    // Optional: per-photo analysis from server/analyze_1940s_photos.py
    // (Ollama vision pass). Renderer falls back gracefully when absent.
    fetch(ANALYSIS_URL)
      .then(r => r.ok ? r.json() : null)
      .then(setAnalysis)
      .catch(() => setAnalysis(null));
    // Optional: stitch engine output from server/stitch_neighbors.py.
    // Provides per-side ordering, real frontages, and per-seam feature
    // offsets with confidence scores. Falls back to in-renderer
    // geometry computation when absent.
    fetch(STITCH_URL)
      .then(r => r.ok ? r.json() : null)
      .then(setStitch)
      .catch(() => setStitch(null));
  }, []);

  useEffect(() => {
    if (!manifest || !containerRef.current) return;

    const blockBuildings = manifest.buildings.filter(b => b.boro === 1 && b.block === 585 && b.photo);
    if (!blockBuildings.length) { setError('No buildings in block 1-585'); return; }

    // Layout: prefer the stitch engine's resolved per-side layout when
    // available (real geometry + per-seam feature offsets). Fall back to
    // the in-renderer geometry/aspect heuristic split by lot < 30.
    const stitchBlock: StitchBlock | null = stitch?.blocks?.['1-585'] ?? null;
    let allSides: Placed[][];
    let streetLength: number;
    if (stitchBlock) {
      const fromStitch = layoutFromStitch(blockBuildings, stitchBlock);
      allSides = fromStitch.sides;
      streetLength = fromStitch.totalLength + 30;
    } else {
      // NYC lot numbers run sequentially along one side of the block,
      // then continue around. Block 585 has lots 12-24 along one side
      // and 41+ along another — split there so each "side of the street"
      // gets a coherent run of facades.
      const rightSide = blockBuildings.filter(b => b.lot < 30);
      const leftSide = blockBuildings.filter(b => b.lot >= 30);
      const rightLayout = layoutSide(rightSide);
      const leftLayout = layoutSide(leftSide);
      allSides = [rightLayout.placed, leftLayout.placed];
      streetLength = Math.max(rightLayout.totalLength, leftLayout.totalLength) + 30;
    }
    streetLengthRef.current = Math.max(1, streetLength);

    const container = containerRef.current;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      // Lets us snapshot the canvas via toDataURL for QA / debug screenshots.
      preserveDrawingBuffer: true,
    });
    // Clamp DPR to [1, 2]: <1 (browser zoomed out) shrinks the draw buffer
    // below the CSS viewport so the canvas appears to only fill a corner;
    // >2 burns GPU on Retina with no visible gain.
    renderer.setPixelRatio(Math.max(1, Math.min(window.devicePixelRatio, 2)));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    renderer.domElement.style.cursor = 'grab';

    // One shared alpha gradient for every photo plane (cheap, single GPU
    // upload). Adjacent planes physically overlap by SEAM_OVERLAP_M and
    // their alpha-faded edges cross-blend → no hard seam.
    const edgeAlpha = makeEdgeFadeAlpha();
    // Vertical alpha used on each side panorama to dissolve the rectangle's
    // top edge into the fog-sky.
    const panoramaTopFade = makePanoramaTopFade();

    const scene = new THREE.Scene();
    // If we have Ollama analysis data, blend the dominant facade colors
    // into the sky/fog tint so the scene matches the photos' palette.
    // Without analysis we fall back to the default sepia haze.
    let skyColor = 0xc4b193;
    if (analysis?.buildings) {
      const blockBins = blockBuildings.map(b => b.bin);
      const colors: [number, number, number][] = [];
      for (const bin of blockBins) {
        const a = analysis.buildings[bin];
        if (!a) continue;
        const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(a.dominant_color);
        if (!m) continue;
        colors.push([parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]);
      }
      if (colors.length) {
        const avg = colors.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]);
        const r = Math.round(avg[0] / colors.length);
        const g = Math.round(avg[1] / colors.length);
        const b = Math.round(avg[2] / colors.length);
        // Lighten 30% toward white for a "haze above the rooftops" feel
        // — pure facade-color sky reads as too dark / closed-in.
        const lr = Math.round(r + (255 - r) * 0.55);
        const lg = Math.round(g + (255 - g) * 0.55);
        const lb = Math.round(b + (255 - b) * 0.55);
        skyColor = (lr << 16) | (lg << 8) | lb;
      }
    }
    scene.background = new THREE.Color(skyColor);
    // Sepia haze mimicking 1940s urban smog. Density 0.018 = visibility
    // drops noticeably past ~50m, which masks the building-height mismatch
    // at the vanishing point and focuses attention on the foreground.
    scene.fog = new THREE.FogExp2(skyColor, 0.018);

    // FOV 60° balances "I'm inside a cab" vs "I can see the world clearly".
    // With wide screen aspect ratios this still gives ~110° horizontal,
    // so cab pillars need to live near the actual frame edge (x≈±1.7 at
    // z=-1.05) to read as window-frame rather than view-blocker.
    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 800);
    // Drop us in the middle of the street near the start of the block,
    // already facing east down the street (+X direction).
    camera.position.set(2, EYE_HEIGHT, 0);
    camera.rotation.order = 'YXZ';

    // Lighting — MeshBasicMaterial doesn't react to lights, but other
    // surfaces (sidewalk, sky panels) might in a future pass.
    scene.add(new THREE.AmbientLight(0xffffff, 1));

    // ── ground ────────────────────────────────────────────────────────
    const asphaltTex = makeAsphaltTexture();
    asphaltTex.repeat.set((streetLength + 60) / 8, (STREET_WIDTH_M - SIDEWALK_WIDTH_M * 2) / 8);
    const asphalt = new THREE.Mesh(
      new THREE.PlaneGeometry(streetLength + 60, STREET_WIDTH_M - SIDEWALK_WIDTH_M * 2),
      new THREE.MeshBasicMaterial({ map: asphaltTex, fog: true }),
    );
    asphalt.rotation.x = -Math.PI / 2;
    asphalt.position.set(streetLength / 2, 0, 0);
    scene.add(asphalt);

    const sidewalkTex = makeSidewalkTexture();
    sidewalkTex.repeat.set((streetLength + 60) / 2, SIDEWALK_WIDTH_M / 2);
    for (const z of [SIDEWALK_WIDTH_M / 2 + (STREET_WIDTH_M / 2 - SIDEWALK_WIDTH_M), -(SIDEWALK_WIDTH_M / 2 + (STREET_WIDTH_M / 2 - SIDEWALK_WIDTH_M))]) {
      const sidewalk = new THREE.Mesh(
        new THREE.PlaneGeometry(streetLength + 60, SIDEWALK_WIDTH_M),
        new THREE.MeshBasicMaterial({ map: sidewalkTex, fog: true }),
      );
      sidewalk.rotation.x = -Math.PI / 2;
      sidewalk.position.set(streetLength / 2, 0.01, z);
      scene.add(sidewalk);
    }

    // Center road markings — period-accurate WHITE (yellow center lines
    // weren't standardized until the 1971 MUTCD revision). Slight tan tint
    // suggests wear and grime from a year of traffic.
    const dashGeo = new THREE.PlaneGeometry(2.6, 0.16);
    const dashMat = new THREE.MeshBasicMaterial({ color: 0xd8cdb6, fog: true });
    for (let dx = 4; dx < streetLength + 60; dx += 5) {
      const dash = new THREE.Mesh(dashGeo, dashMat);
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(dx - 30, 0.02, 0);
      scene.add(dash);
    }

    // ── parked period vehicles at the curb ────────────────────────────
    // Simple boxy 1940s car silhouettes — Plymouth/Buick proportions
    // (4.7m long, 1.5m tall body + 0.8m cab on top, 1.7m wide). Placed
    // every ~14m along the right curb so the corridor feels lived-in.
    function buildPeriodCar(color: number): THREE.Group {
      const car = new THREE.Group();
      const carMat = new THREE.MeshBasicMaterial({ color, fog: true });
      const chrome = new THREE.MeshBasicMaterial({ color: 0xb0a890, fog: true });
      const dark = new THREE.MeshBasicMaterial({ color: 0x141410, fog: true });
      const winMat = new THREE.MeshBasicMaterial({ color: 0x202020, fog: true });
      const headlightMat = new THREE.MeshBasicMaterial({ color: 0xfff4d0, fog: true });
      const taillightMat = new THREE.MeshBasicMaterial({ color: 0x8a1a14, fog: true });

      // Lower body — door region with running boards underneath
      const body = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.85, 1.55), carMat);
      body.position.y = 0.50;
      car.add(body);
      // Running boards — slight chrome trim along the bottom of doors
      for (const rz of [-0.78, 0.78]) {
        const board = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.10, 0.10), dark);
        board.position.set(-0.2, 0.30, rz);
        car.add(board);
      }
      // Cab / passenger compartment — narrower, sits above body
      const cabTop = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.65, 1.50), carMat);
      cabTop.position.set(-0.3, 1.25, 0);
      car.add(cabTop);
      // Hood — narrower forward block (period sedans had a long hood with
      // separate fender shapes; we approximate with a stepped block)
      const hoodMesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.45, 1.45), carMat);
      hoodMesh.position.set(1.45, 0.85, 0);
      car.add(hoodMesh);
      // Front fender curves — small wedges between hood + body
      for (const fz of [-0.78, 0.78]) {
        const fender = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 0.12), carMat);
        fender.position.set(1.4, 0.55, fz);
        car.add(fender);
      }
      // Wheels with chrome hubcaps
      const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.22, 16);
      const hubGeo = new THREE.CircleGeometry(0.18, 16);
      for (const wx of [-1.55, 1.45]) {
        for (const wz of [-0.85, 0.85]) {
          const wheel = new THREE.Mesh(wheelGeo, dark);
          wheel.rotation.x = Math.PI / 2;
          wheel.position.set(wx, 0.36, wz);
          car.add(wheel);
          const hub = new THREE.Mesh(hubGeo, chrome);
          hub.position.set(wx, 0.36, wz + (wz > 0 ? 0.12 : -0.12));
          hub.rotation.y = wz > 0 ? 0 : Math.PI;
          car.add(hub);
        }
      }
      // Side windows
      for (const wz of [-0.76, 0.76]) {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.40), winMat);
        win.position.set(-0.3, 1.38, wz);
        win.rotation.y = wz > 0 ? Math.PI / 2 : -Math.PI / 2;
        car.add(win);
      }
      // Windshield (front, slightly tilted)
      const windshield = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 0.55), winMat);
      windshield.position.set(0.85, 1.30, 0);
      windshield.rotation.y = Math.PI / 2;
      windshield.rotation.x = -0.20;
      car.add(windshield);
      // Rear window
      const rearWin = new THREE.Mesh(new THREE.PlaneGeometry(1.30, 0.45), winMat);
      rearWin.position.set(-1.45, 1.30, 0);
      rearWin.rotation.y = -Math.PI / 2;
      rearWin.rotation.x = 0.15;
      car.add(rearWin);
      // Front grille (vertical chrome bar at face)
      const grille = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.28), chrome);
      grille.position.set(2.26, 0.70, 0);
      grille.rotation.y = Math.PI / 2;
      car.add(grille);
      // Headlights — bright filament center + soft warm halo (additive
      // blending suggests the warm glow of period sealed-beam lamps)
      const haloMat = new THREE.MeshBasicMaterial({
        color: 0xffe28a,
        fog: true,
        transparent: true,
        opacity: 0.45,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      for (const lz of [-0.62, 0.62]) {
        const headlight = new THREE.Mesh(new THREE.CircleGeometry(0.12, 16), headlightMat);
        headlight.position.set(2.26, 0.85, lz);
        headlight.rotation.y = Math.PI / 2;
        car.add(headlight);
        const halo = new THREE.Mesh(new THREE.CircleGeometry(0.28, 16), haloMat);
        halo.position.set(2.27, 0.85, lz);
        halo.rotation.y = Math.PI / 2;
        car.add(halo);
      }
      // Taillights — small dark red dots at rear
      for (const tz of [-0.55, 0.55]) {
        const tail = new THREE.Mesh(new THREE.CircleGeometry(0.06, 12), taillightMat);
        tail.position.set(-2.26, 0.62, tz);
        tail.rotation.y = -Math.PI / 2;
        car.add(tail);
      }
      // Front + rear bumpers (chrome bars)
      const bumperFront = new THREE.Mesh(new THREE.PlaneGeometry(1.55, 0.10), chrome);
      bumperFront.position.set(2.27, 0.45, 0);
      bumperFront.rotation.y = Math.PI / 2;
      car.add(bumperFront);
      const bumperRear = new THREE.Mesh(new THREE.PlaneGeometry(1.55, 0.10), chrome);
      bumperRear.position.set(-2.27, 0.45, 0);
      bumperRear.rotation.y = -Math.PI / 2;
      car.add(bumperRear);
      return car;
    }

    // ── period fire hydrants ──────────────────────────────────────────
    // Squat cast-iron hydrants — painted dark red (period NYC standard).
    // Placed at the curb every ~50m, offset from cars + lamp posts.
    function buildHydrant(): THREE.Group {
      const h = new THREE.Group();
      const ironMat = new THREE.MeshBasicMaterial({ color: 0x6a1a14, fog: true });
      const capMat = new THREE.MeshBasicMaterial({ color: 0x4a1208, fog: true });
      // Base flange
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.10, 12), ironMat);
      base.position.y = 0.05;
      h.add(base);
      // Main barrel
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.13, 0.55, 12), ironMat);
      barrel.position.y = 0.38;
      h.add(barrel);
      // Bonnet (top)
      const bonnet = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.13, 0.10, 12), capMat);
      bonnet.position.y = 0.70;
      h.add(bonnet);
      // Top nut (5-sided pentagon-shaped knob)
      const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 5), capMat);
      nut.position.y = 0.78;
      h.add(nut);
      // Two side outlet caps — chunky chrome-ish disks
      for (const sx of [-1, 1]) {
        const outlet = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 12), capMat);
        outlet.rotation.z = Math.PI / 2;
        outlet.position.set(sx * 0.16, 0.42, 0);
        h.add(outlet);
      }
      return h;
    }
    const hydrants: THREE.Group[] = [];
    const hydrantZ = STREET_WIDTH_M / 2 - SIDEWALK_WIDTH_M + 0.4;  // just on the road side of curb
    let hydIdx = 0;
    for (let hx = 18; hx < streetLength + 4; hx += 50) {
      for (const sign of [-1, 1]) {
        const hyd = buildHydrant();
        // Stagger sides so they appear independently
        const off = sign > 0 ? 0 : 25;
        hyd.position.set(hx + off, 0, sign * hydrantZ);
        scene.add(hyd);
        hydrants.push(hyd);
        hydIdx++;
      }
    }

    // ── period street lamp posts ──────────────────────────────────────
    // Cast-iron lamp posts with a frosted globe at the top — standard
    // NYC sidewalk lighting in the 1940s. Placed every ~28m on alternating
    // sides at the OUTER edge of the sidewalk (against the building line).
    function buildLampPost(): THREE.Group {
      const post = new THREE.Group();
      const ironMat = new THREE.MeshBasicMaterial({ color: 0x121008, fog: true });
      const globeMat = new THREE.MeshBasicMaterial({ color: 0xf2e6c2, fog: true });
      // Base — wider stepped pedestal
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.20, 0.30, 12), ironMat);
      base.position.y = 0.15;
      post.add(base);
      // Main shaft — tall thin post, fluted look via slight taper
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 3.4, 12), ironMat);
      shaft.position.y = 0.30 + 1.7;
      post.add(shaft);
      // Crossbar arm — a horizontal piece holding the globe
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.45), ironMat);
      arm.position.y = 3.55;
      post.add(arm);
      // Globe — frosted glass sphere at end of arm
      const globe = new THREE.Mesh(new THREE.SphereGeometry(0.20, 16, 12), globeMat);
      globe.position.set(0, 3.55, 0.30);
      post.add(globe);
      // Globe cap — small black topper
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.14, 0.10, 12), ironMat);
      cap.position.set(0, 3.78, 0.30);
      post.add(cap);
      return post;
    }
    // Place lamps along outer sidewalk on both sides, offset from cars.
    const lampPosts: THREE.Group[] = [];
    const lampZ = STREET_WIDTH_M / 2 - 0.4;  // just inside the building line
    let lampIdx = 0;
    for (let lx = 4; lx < streetLength + 6; lx += 28) {
      for (const sign of [-1, 1]) {
        const lamp = buildLampPost();
        // Stagger sides slightly so they don't appear in pairs
        const offset = sign > 0 ? 0 : 14;
        lamp.position.set(lx + offset, 0, sign * lampZ);
        // Globe-arm orientation: extend over the sidewalk toward the curb
        lamp.rotation.y = sign > 0 ? Math.PI : 0;
        scene.add(lamp);
        lampPosts.push(lamp);
        lampIdx++;
      }
    }

    // Place ~one car per 22m of street, alternating sides, in plausible
    // period colors. Cars sit at the curb (just inside the sidewalk).
    // Spacing chosen so they look like a typical block's parked-car density
    // without crowding the camera path.
    const carColors = [0x1f3320, 0x3a1c1c, 0x14253a, 0x121212, 0x4a3a14, 0x2a2a2a];
    // Curb position: sidewalk inner edge - half car width.
    const curbZ = (STREET_WIDTH_M / 2) - SIDEWALK_WIDTH_M - 1.0;
    const parkedCars: THREE.Group[] = [];
    let carIdx = 0;
    // Start at x=14 so the first car is past the cab's starting position;
    // skip any car that ends up within 6m of the cab's likely path
    // (here we don't know runtime cam position, so we skip the first slot).
    for (let cx = 14; cx < streetLength - 6; cx += 22) {
      const side = (carIdx % 2 === 0) ? 1 : -1;
      const car = buildPeriodCar(carColors[carIdx % carColors.length]);
      // Slight per-car jitter so they don't read as a regular pattern
      const jitter = ((carIdx * 7) % 5) - 2;
      car.position.set(cx + jitter, 0, side * curbZ);
      car.rotation.y = (carIdx % 2 === 0) ? 0 : Math.PI;
      scene.add(car);
      parkedCars.push(car);
      carIdx++;
    }

    // ── photo planes ──────────────────────────────────────────────────
    // Right side: facing -Z (toward the camera path).
    // Left side: facing +Z. Same lot ordering on both, just mirrored
    // across the street so it feels like a continuous corridor.
    const loader = new THREE.TextureLoader();
    const buildingMeshes: { mesh: THREE.Mesh; b: Building }[] = [];
    const placeOne = (p: Placed, side: 'right' | 'left') => {
      // Crop the texture to just the facade if we have Ollama analysis
      // for this BIN — facade_top/_bottom are 0..1 fractions of the
      // photo height (0=top edge). Three.js texture UVs are bottom-up,
      // so we flip when computing offset/repeat.
      const a = analysis?.buildings?.[p.b.bin];
      // Defaults chosen from the WPA framing convention: a thin sky strip
      // above and a fixed archive label ("BLOCK-LOT M") at the bottom.
      // Trimming these by default removes the visible "plate" without
      // needing per-photo Ollama analysis.
      const cropTop = a ? Math.max(0, Math.min(0.4, a.facade_top)) : 0.04;
      const cropBot = a ? Math.max(0.6, Math.min(1, a.facade_bottom)) : 0.88;
      const tex = loader.load(p.b.photo!.url, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        t.offset.set(0, 1 - cropBot);
        t.repeat.set(1, cropBot - cropTop);
        t.needsUpdate = true;
      });
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.offset.set(0, 1 - cropBot);
      tex.repeat.set(1, cropBot - cropTop);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        // Soft alpha falloff at left/right edges → adjacent planes overlap
        // and cross-blend instead of meeting at hard lines.
        alphaMap: edgeAlpha,
        fog: true,
        transparent: true,
        // Without this, far transparent planes z-fight with closer ones.
        depthWrite: false,
      });
      // Widen the plane past the lot boundary on both sides; the extra
      // width is the alpha-fade overlap zone with neighbors.
      const planeW = p.width + SEAM_OVERLAP_M * 2;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(planeW, p.height), mat);
      const z = side === 'right' ? FACADE_OFFSET_M : -FACADE_OFFSET_M;
      mesh.position.set(p.x + p.width / 2, p.height / 2, z);
      mesh.rotation.y = side === 'right' ? Math.PI : 0;
      // Sort transparent planes back-to-front along the street so
      // overlapping fade zones blend in a stable order.
      mesh.renderOrder = side === 'right' ? p.x : -p.x;
      mesh.userData.bin = p.b.bin;
      scene.add(mesh);
      buildingMeshes.push({ mesh, b: p.b });
    };
    // Pick the two LONGEST sides as the visible corridor. Isolated 1-2
    // building "sides" are corner-lot noise from the lot-number
    // contiguity heuristic; ignore them for the walk.
    const visibleSides = [...allSides]
      .filter(s => s.length > 0)
      .sort((a, b) => b.length - a.length)
      .slice(0, 2);

    // Try to attach an SDXL-inpainted panorama for each visible side.
    // When a panorama loads successfully we replace that side's per-photo
    // planes with ONE big textured plane spanning the side's full extent.
    // When the panorama 404s (not generated yet) we fall back to per-photo
    // planes with cross-fade.
    const sideIds: string[] = stitchBlock
      ? Object.entries(stitchBlock.sides)
          .filter(([, bins]) => bins.length > 0)
          .sort(([, a], [, b]) => b.length - a.length)
          .slice(0, 2)
          .map(([id]) => id)
      : [];

    const panoramaMeshes: THREE.Mesh[] = [];
    const placePanorama = (placed: Placed[], side: 'right' | 'left', sideId: string | undefined) => {
      if (!placed.length || !sideId) return false;
      const xmin = Math.min(...placed.map(p => p.x));
      const xmax = Math.max(...placed.map(p => p.x + p.width));
      const widthM = xmax - xmin;
      const heightM = PANORAMA_HEIGHT_M;
      const url = STITCHED_URL('1-585', sideId);

      const tex = new THREE.TextureLoader().load(
        url,
        t => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = renderer.capabilities.getMaxAnisotropy();
          t.needsUpdate = true;
        },
        undefined,
        () => {
          // 404: panorama not baked yet — remove our placeholder mesh
          // and fall back to per-photo planes for this side.
          for (const m of panoramaMeshes) {
            if (m.userData.sideId === sideId) {
              scene.remove(m);
              (m.material as THREE.MeshBasicMaterial).dispose();
              m.geometry.dispose();
            }
          }
          for (const p of placed) placeOne(p, side);
        },
      );
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        alphaMap: panoramaTopFade,
        transparent: true,
        depthWrite: false,
        fog: true,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, heightM), mat);
      const z = side === 'right' ? FACADE_OFFSET_M : -FACADE_OFFSET_M;
      mesh.position.set((xmin + xmax) / 2, heightM / 2, z);
      mesh.rotation.y = side === 'right' ? Math.PI : 0;
      mesh.userData.sideId = sideId;
      scene.add(mesh);
      panoramaMeshes.push(mesh);
      return true;
    };

    if (visibleSides.length > 0) {
      const sideId = sideIds[0];
      if (!placePanorama(visibleSides[0], 'right', sideId)) {
        for (const p of visibleSides[0]) placeOne(p, 'right');
      }
    }
    if (visibleSides.length > 1) {
      const sideId = sideIds[1];
      if (!placePanorama(visibleSides[1], 'left', sideId)) {
        for (const p of visibleSides[1]) placeOne(p, 'left');
      }
    }

    // DEBUG: expose for browser-side inspection.
    (window as unknown as { __w1940?: unknown }).__w1940 = {
      scene, camera, renderer, buildingMeshes, allSides, edgeAlpha, stitchBlock,
    };

    // ── intersection bookends ─────────────────────────────────────────
    // Distant building silhouettes at each end: a sepia-tinted "next block"
    // suggestion so the street visually continues instead of dying into
    // pink fog. We use two layered planes — closer rougher rooflines, then
    // farther flatter haze — giving a parallax sense of city continuing.
    const bookendMat = (opacity: number) => new THREE.MeshBasicMaterial({
      color: skyColor,
      fog: true,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
    });
    for (const sign of [-1, 1]) {
      const baseX = sign < 0 ? -14 : streetLength + 14;
      const farX = baseX + sign * 8;
      // Near distant: a roughly-shaped roofline silhouette
      const near = new THREE.Mesh(
        new THREE.PlaneGeometry(STREET_WIDTH_M * 1.8, 14),
        bookendMat(0.65),
      );
      near.rotation.y = Math.PI / 2;
      near.position.set(baseX, 7, 0);
      scene.add(near);
      // Far haze: thinner, lighter, suggests next-next block
      const far = new THREE.Mesh(
        new THREE.PlaneGeometry(STREET_WIDTH_M * 2.2, 18),
        bookendMat(0.4),
      );
      far.rotation.y = Math.PI / 2;
      far.position.set(farX, 9, 0);
      scene.add(far);
    }

    // ── taxi cab interior ─────────────────────────────────────────────
    // Yellow Crown Vic cabin around the camera. Rotates with the head
    // so you see the windshield forward, side window L/R when turning,
    // back passenger window when looking behind. The cracked-open gap
    // in the right side window's top trim is the iconic NYC detail.
    const cab = buildTaxiCab(scene);

    // ── ambient cab audio ─────────────────────────────────────────────
    // Tone.js engine drone — a low sawtooth fundamental + 2nd harmonic
    // + filtered noise (wind/road), all gently modulated to feel alive.
    // Starts on first user interaction (browser autoplay policies require
    // a user gesture before AudioContext can resume).
    let stopAudio: (() => void) | null = null;
    let audioStarted = false;
    const startAudio = async () => {
      if (audioStarted) return;
      audioStarted = true;
      try {
        const Tone = await import('tone');
        await Tone.start();
        const ctx = Tone.getContext();
        // Master gain — keep it quiet so it sits under any other audio.
        const master = new Tone.Gain(0.08).toDestination();
        // Engine fundamental: low sawtooth around 70 Hz
        const engine1 = new Tone.Oscillator({
          type: 'sawtooth', frequency: 72, volume: -8,
        }).start();
        // 2nd harmonic gives the "engine" character vs pure tone
        const engine2 = new Tone.Oscillator({
          type: 'sawtooth', frequency: 144, volume: -16,
        }).start();
        // Lowpass on engine sums — kills harshness, keeps body
        const engineFilter = new Tone.Filter({
          type: 'lowpass', frequency: 380, Q: 1.2,
        });
        // Slow tremolo for "rough idle" feel
        const tremolo = new Tone.LFO({
          frequency: 7.5, min: 0.85, max: 1.0,
        }).start();
        const engineGain = new Tone.Gain(0.85);
        tremolo.connect(engineGain.gain);
        engine1.chain(engineFilter, engineGain, master);
        engine2.chain(engineFilter, engineGain, master);
        // Wind/road noise: high-frequency-rolloff white noise
        const wind = new Tone.Noise({ type: 'pink', volume: -22 }).start();
        const windFilter = new Tone.Filter({
          type: 'bandpass', frequency: 800, Q: 0.7,
        });
        const windGain = new Tone.Gain(0.4);
        wind.chain(windFilter, windGain, master);

        stopAudio = () => {
          try {
            engine1.stop(); engine1.dispose();
            engine2.stop(); engine2.dispose();
            wind.stop(); wind.dispose();
            tremolo.stop(); tremolo.dispose();
            engineFilter.dispose();
            windFilter.dispose();
            engineGain.dispose();
            windGain.dispose();
            master.dispose();
            void ctx;
          } catch { /* no-op */ }
        };
      } catch (e) {
        console.warn('cab audio failed to start:', e);
      }
    };
    // Start on the first canvas click (user-gesture-gated by browser).
    const startAudioOnce = () => {
      void startAudio();
    };
    container.addEventListener('click', startAudioOnce, { once: false });

    // ── controls ──────────────────────────────────────────────────────
    const keys: Record<string, boolean> = {};
    const velocity = new THREE.Vector3();
    // Yaw of -π/2 → camera looks down +X (the street's length, "north").
    let yaw = -Math.PI / 2;
    let pitch = 0;
    let locked = false;
    let walkTime = 0;
    // Drive-by mode: camera auto-translates +X at constant cab speed.
    // Click-to-lock for mouse-look still works; WASD nudges the cab
    // faster/slower/reverse but the default is rolling forward.
    let driving = true;
    const DRIVE_SPEED = 4.5;     // m/s — slow city-traffic pace
    const DRIVE_LANE_Z = 0;      // stays in the middle of the street

    const onKeyDown = (e: KeyboardEvent) => {
      keys[e.code] = true;
      // 'F' toggles drive-by ↔ walk so you can hop out of the cab.
      if (e.code === 'KeyF') driving = !driving;
    };
    const onKeyUp = (e: KeyboardEvent) => { keys[e.code] = false; };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const onMouseMove = (e: MouseEvent) => {
      if (!locked) return;
      yaw -= e.movementX * 0.0022;
      pitch -= e.movementY * 0.0022;
      pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, pitch));
    };
    const onLockChange = () => {
      locked = document.pointerLockElement === renderer.domElement;
      setWalking(locked);
      renderer.domElement.style.cursor = locked ? 'none' : 'grab';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onLockChange);

    // Click: if locked, do a raycast to see if we clicked a building →
    // open the modal. If not locked, single-click enters pointer-lock.
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const onClick = (_e: MouseEvent) => {
      if (!locked) {
        renderer.domElement.requestPointerLock?.();
        return;
      }
      // When locked the cursor is in the center; raycast straight ahead.
      ndc.set(0, 0);
      raycaster.setFromCamera(ndc, camera);
      const meshes = buildingMeshes.map(m => m.mesh);
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits.length) {
        const bin = hits[0].object.userData.bin as string;
        const found = buildingMeshes.find(m => m.b.bin === bin);
        if (found) {
          document.exitPointerLock?.();
          setOpen(found.b);
        }
      }
    };
    // Click-without-lock for opening photos by clicking with the mouse.
    const onUnlockedClick = (e: MouseEvent) => {
      if (locked) return;
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const meshes = buildingMeshes.map(m => m.mesh);
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits.length) {
        const bin = hits[0].object.userData.bin as string;
        const found = buildingMeshes.find(m => m.b.bin === bin);
        if (found) { setOpen(found.b); return; }
      }
      // No building hit → fall through to lock.
      renderer.domElement.requestPointerLock?.();
    };
    renderer.domElement.addEventListener('click', onUnlockedClick);

    const resize = () => {
      const w = container.clientWidth, h = container.clientHeight;
      // updateStyle=true → canvas CSS dimensions track the container so the
      // <canvas> visually fills the viewport (not just the draw buffer).
      renderer.setSize(w, h, true);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let raf = 0;
    let last = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (driving) {
        // Drive-by: cab auto-rolls forward in +X with light WASD trim.
        const accel = (keys.KeyW || keys.ArrowUp ? 1.6 : 0) - (keys.KeyS || keys.ArrowDown ? 1.6 : 0);
        const targetSpeed = DRIVE_SPEED + accel;
        velocity.x += (targetSpeed - velocity.x) * Math.min(1, dt * 2.5);
        velocity.z += (DRIVE_LANE_Z - camera.position.z) * Math.min(1, dt * 1.5);
        camera.position.x += velocity.x * dt;
        camera.position.z += velocity.z * dt;
        // Loop the block so the drive-by never ends.
        if (camera.position.x > streetLength + 6) camera.position.x = -6;
      } else {
        // Walking: original WASD/yaw-relative free motion.
        const fwd = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
        const right = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
        const sprint = keys.ShiftLeft || keys.ShiftRight;
        const speed = sprint ? 6.5 : 2.6;
        const sinY = Math.sin(yaw), cosY = Math.cos(yaw);
        const targetVx = (fwd * -sinY + right * cosY) * speed;
        const targetVz = (fwd * -cosY - right * sinY) * speed;
        velocity.x += (targetVx - velocity.x) * Math.min(1, dt * 9);
        velocity.z += (targetVz - velocity.z) * Math.min(1, dt * 9);
        camera.position.x += velocity.x * dt;
        camera.position.z += velocity.z * dt;
        camera.position.x = Math.max(-9, Math.min(streetLength + 9, camera.position.x));
        camera.position.z = Math.max(-(STREET_WIDTH_M / 2 - 0.6), Math.min(STREET_WIDTH_M / 2 - 0.6, camera.position.z));
      }

      // Subtle head bob — gentler in the cab (riding shocks) than walking.
      const moving = Math.abs(velocity.x) > 0.4 || Math.abs(velocity.z) > 0.4;
      if (moving) walkTime += dt * (driving ? 4 : 7);
      const bob = moving ? Math.sin(walkTime) * (driving ? 0.018 : 0.045) : 0;
      camera.position.y = EYE_HEIGHT + bob;
      camera.rotation.set(pitch, yaw, 0);

      // Cab follows the head so windshield/sides/back swap by yaw alone.
      cab.update(camera);

      // Hide parked cars within 4.5m of camera — at narrow NYC street
      // widths, a car parked at the curb looks "huge" when you're driving
      // right past it, and physically the cab body would mostly block it
      // anyway. This keeps the foreground readable.
      const cx = camera.position.x;
      for (const car of parkedCars) {
        const dx = car.position.x - cx;
        car.visible = Math.abs(dx) > 4.5;
      }

      // Drive the minimap dot via direct DOM write — avoids one React
      // re-render per frame. Position is the cab's progress along the
      // block, mapped 0..1 so the SVG can place the marker.
      const dot = minimapDotRef.current;
      if (dot) {
        const t = Math.max(0, Math.min(1, cx / streetLength));
        // Heading in the minimap plane: yaw=0 → +X (east, right). Negate
        // because CSS rotates clockwise but yaw rotates counter-clockwise.
        const headingDeg = (-yaw * 180) / Math.PI;
        dot.style.left = `${(t * 100).toFixed(2)}%`;
        dot.style.transform = `translate(-50%, -50%) rotate(${headingDeg.toFixed(1)}deg)`;
      }

      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('pointerlockchange', onLockChange);
      renderer.domElement.removeEventListener('click', onUnlockedClick);
      // Avoid the placeholder `onClick` const lint complaint.
      void onClick;
      for (const { mesh } of buildingMeshes) {
        mesh.geometry.dispose();
        const m = mesh.material as THREE.MeshBasicMaterial;
        m.map?.dispose();
        m.dispose();
      }
      for (const mesh of panoramaMeshes) {
        mesh.geometry.dispose();
        const m = mesh.material as THREE.MeshBasicMaterial;
        m.map?.dispose();
        m.dispose();
      }
      cab.group.traverse(obj => {
        const m = obj as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.MeshBasicMaterial | undefined;
        mat?.dispose();
      });
      scene.remove(cab.group);
      for (const car of parkedCars) {
        car.traverse(obj => {
          const m = obj as THREE.Mesh;
          m.geometry?.dispose();
          const mat = m.material as THREE.MeshBasicMaterial | undefined;
          mat?.dispose();
        });
        scene.remove(car);
      }
      for (const lamp of lampPosts) {
        lamp.traverse(obj => {
          const m = obj as THREE.Mesh;
          m.geometry?.dispose();
          const mat = m.material as THREE.MeshBasicMaterial | undefined;
          mat?.dispose();
        });
        scene.remove(lamp);
      }
      for (const hyd of hydrants) {
        hyd.traverse(obj => {
          const m = obj as THREE.Mesh;
          m.geometry?.dispose();
          const mat = m.material as THREE.MeshBasicMaterial | undefined;
          mat?.dispose();
        });
        scene.remove(hyd);
      }
      container.removeEventListener('click', startAudioOnce);
      stopAudio?.();
      edgeAlpha.dispose();
      panoramaTopFade.dispose();
      asphaltTex.dispose();
      sidewalkTex.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [manifest, analysis, stitch]);

  const buildingCount = manifest
    ? manifest.buildings.filter(b => b.boro === 1 && b.block === 585 && b.photo).length
    : 0;

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#1a1410', color: '#f6e9d6' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Windshield "glass" overlay — sells looking through a real cab
          windshield instead of staring at a render. Stack of pseudo-radial
          gradients: dark vignette at corners (cab roof + door shadow),
          warm sepia tint everywhere, faint horizontal smudge band.
          pointer-events: none so it doesn't break controls. */}
      {!error && manifest && (
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2,
          background: [
            // Corner darkening (cab roof / interior shadow)
            'radial-gradient(ellipse 110% 90% at 50% 50%, transparent 30%, rgba(8,5,2,0.55) 100%)',
            // Subtle warm sepia overall — ties everything to "1940 film"
            'linear-gradient(rgba(180,140,90,0.06), rgba(180,140,90,0.06))',
            // Faint windshield smudge band at eye level
            'linear-gradient(180deg, transparent 38%, rgba(255,240,210,0.04) 42%, rgba(255,240,210,0.04) 48%, transparent 52%)',
            // Top edge — cab roofline shadow
            'linear-gradient(180deg, rgba(0,0,0,0.45) 0%, transparent 8%)',
            // Bottom edge — slight yellow hood reflection bleed
            'linear-gradient(0deg, rgba(255,200,30,0.10) 0%, transparent 6%)',
          ].join(', '),
          mixBlendMode: 'normal',
        }} />
      )}

      {error && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fa6', padding: 24 }}>
          Failed to load: {error}
        </div>
      )}
      {!error && !manifest && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#bba' }}>
          Loading 1940 NYC…
        </div>
      )}

      {/* Header — compact on narrow screens (just title + meta count),
          full chrome on desktop (controls hint + seam stats). The full
          version was eating ~60% of mobile viewports. */}
      {manifest && (
        <div style={{
          position: 'absolute', left: isCompact ? 8 : 14, top: isCompact ? 8 : 14,
          padding: isCompact ? '7px 10px' : '10px 14px',
          background: 'rgba(20,15,10,0.78)', backdropFilter: 'blur(6px)',
          borderRadius: 8, fontFamily: 'ui-monospace, monospace',
          fontSize: isCompact ? 10 : 12, lineHeight: 1.4,
          maxWidth: isCompact ? 'calc(100vw - 90px)' : 360, zIndex: 5,
          pointerEvents: 'none',
        }}>
          <div style={{
            fontSize: isCompact ? 13 : 17, fontWeight: 700,
            letterSpacing: 1, marginBottom: isCompact ? 1 : 4,
          }}>
            1940 · {isCompact ? 'W Village' : 'West Village walk'}
          </div>
          <div style={{ color: '#cdbfa6' }}>
            {buildingCount} buildings · block 1-585
            {!isCompact && analysis ? ` · ${Object.keys(analysis.buildings).length} ai-cropped via ollama` : ''}
            {!isCompact && <br />}
            {!isCompact && stitch?.blocks?.['1-585']?.summary && (() => {
              const s = stitch.blocks['1-585'].summary;
              return (
                <>
                  <span style={{ color: '#9ad48f' }}>{s.high}↑</span>{' '}
                  <span style={{ color: '#d4c98f' }}>{s.med}~</span>{' '}
                  <span style={{ color: '#d49a8f' }}>{s.low}↓</span>{' '}
                  seams · sift+ransac<br />
                </>
              );
            })()}
            {!isCompact && (walking
              ? 'mouse to look · W/S to brake/accelerate · F to step out · esc to release'
              : 'click the canvas to ride along · F to swap walk/drive · click any building to inspect')}
          </div>
        </div>
      )}

      <a href="/" style={{
        position: 'absolute', right: isCompact ? 8 : 12, top: isCompact ? 8 : 12,
        background: 'rgba(20,15,10,0.85)',
        padding: isCompact ? '8px 12px' : '6px 12px',
        borderRadius: 6, color: '#f6e9d6',
        fontSize: isCompact ? 13 : 12, textDecoration: 'none',
        fontFamily: 'ui-monospace, monospace', zIndex: 5,
        // Bigger tap target on touch devices
        minWidth: isCompact ? 56 : undefined,
        textAlign: 'center',
      }}>← back</a>

      {/* MINIMAP — bird-eye view of the 5-block stretch with a yellow
          dot showing the cab's current x-progress along the street.
          Sits in the bottom-left so it doesn't compete with the
          taximeter on the dashboard. The dot's CSS rotation tracks
          the camera yaw → little arrow points where you're facing.
          Hidden when the photo modal is open. */}
      {manifest && !open && (
        <div style={{
          position: 'absolute',
          left: isCompact ? 8 : 14,
          bottom: isCompact ? 8 : 14,
          padding: '8px 10px 10px 10px',
          background: 'rgba(20,15,10,0.78)', backdropFilter: 'blur(6px)',
          borderRadius: 8, fontFamily: 'ui-monospace, monospace',
          fontSize: 10, color: '#cdbfa6', zIndex: 5,
          pointerEvents: 'none',
          width: isCompact ? 160 : 220,
        }}>
          <div style={{ marginBottom: 5, letterSpacing: 1 }}>BLOCK 1-585 · WEST ↣ EAST</div>
          <div style={{
            position: 'relative', height: 12,
            background: 'rgba(246,233,214,0.08)',
            borderRadius: 4,
            border: '1px solid rgba(246,233,214,0.18)',
          }}>
            {/* Side-A / side-C tick marks at quartiles */}
            {[0.25, 0.5, 0.75].map(t => (
              <div key={t} style={{
                position: 'absolute', left: `${t * 100}%`, top: 2, bottom: 2,
                width: 1, background: 'rgba(246,233,214,0.18)',
              }} />
            ))}
            {/* Cab dot — driven by minimapDotRef in the render loop */}
            <div
              ref={minimapDotRef}
              style={{
                position: 'absolute', top: '50%', left: '0%',
                width: 0, height: 0,
                borderLeft: '5px solid transparent',
                borderRight: '5px solid transparent',
                borderBottom: '9px solid #ffd417',
                transform: 'translate(-50%, -50%)',
                transformOrigin: 'center',
                filter: 'drop-shadow(0 0 3px rgba(255,212,23,0.6))',
              }}
            />
          </div>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            marginTop: 4, fontSize: 9, opacity: 0.75,
          }}>
            <span>HUDSON</span>
            <span>WEST 4TH</span>
          </div>
        </div>
      )}

      {/* Crosshair when walking — tiny dot in the center for click target */}
      {walking && (
        <div style={{
          position: 'absolute', left: '50%', top: '50%',
          width: 6, height: 6, borderRadius: 3,
          background: 'rgba(246,233,214,0.7)',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none', zIndex: 4,
        }} />
      )}

      {open && open.photo && (
        <div
          onClick={() => setOpen(null)}
          style={{
            position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.86)',
            display: 'grid', placeItems: 'center', cursor: 'zoom-out', padding: 24, zIndex: 10,
          }}
        >
          <div style={{ maxHeight: '92vh', maxWidth: '92vw', textAlign: 'center' }}>
            <img
              src={open.photo.url}
              alt={`tax photo ${open.bbl}`}
              style={{ maxHeight: '85vh', maxWidth: '92vw', boxShadow: '0 12px 60px rgba(0,0,0,0.6)' }}
            />
            <div style={{ marginTop: 10, color: '#cdbfa6', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
              BBL {open.bbl} · block {open.boro}-{open.block}, lot {open.lot}
              {open.year ? ` · built ${open.year}` : ''}
              {open.h_roof != null ? ` · roof ${open.h_roof.toFixed(0)} ft` : ''}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
