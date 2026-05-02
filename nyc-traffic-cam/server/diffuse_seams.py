"""diffuse_seams.py - generate seam-bridge content via SDXL inpaint, then
stitch each side of a block into a single seamless panorama PNG that the
/world1940 renderer drops in as one big plane (instead of N small ones).

Pipeline:

  1) Read public/photo-stitch-1940s.json (output of stitch_neighbors.py).
     For each block / side, we already have:
       - real frontage_m per building
       - axis_start / axis_end positions along the street
       - per-seam confidence + feature_offset_m

  2) Lay out each side as a single wide canvas (PIL Image) at
     PX_PER_M scale. Each photo is resized horizontally to its real
     frontage_m * PX_PER_M, pasted at its axis position. High-confidence
     seams use the SIFT-derived offset (clamped) to slide neighbors
     into alignment.

  3) Build an alpha mask of the canvas: 0 wherever no photo covers,
     1 where one photo dominates, gradient in overlap zones.

  4) Find each "gap" region (contiguous run of low-coverage pixels) and
     run SDXL inpaint on a 1024x1024 window centered on that gap. The
     inpaint mask covers just the gap (with feathered edges so the
     diffusion blends into the existing photo content on both sides).

  5) Composite the inpainted strips back into the canvas. Save as
     public/photo-stitched/<block>-<side>.png. The renderer auto-
     detects these and switches from per-photo planes to one panorama
     plane per side.

Hardware: built for 8GB VRAM (RTX 3070-class). Uses fp16 +
enable_model_cpu_offload() so SDXL inpaint fits. ~12-20s per inference
warm. SD 1.5 inpaint mode (--small) is faster but lower quality.

Usage:

    python -m server.diffuse_seams --dry-run       # save canvas+mask only, no inference
    python -m server.diffuse_seams --block 1-585   # full inpaint on one block
    python -m server.diffuse_seams --side side_a   # one side only
    python -m server.diffuse_seams --small         # use SD 1.5 inpaint instead of SDXL
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "public" / "data-1940s.json"
STITCH_PATH = ROOT / "public" / "photo-stitch-1940s.json"
ANALYSIS_PATH = ROOT / "public" / "photo-analysis-1940s.json"
OUT_DIR = ROOT / "public" / "photo-stitched"

# Canvas resolution: 80 px/m means a 7m-wide townhouse ends up as 560 px,
# a 25m corner lot as 2000 px. Each photo is 682 native px wide so this
# scales narrow lots up slightly and wide lots down — the alpha-fade
# masks the resampling artifacts.
PX_PER_M = 80
CANVAS_HEIGHT = 1024  # match native photo height — 1 px/photo-row, no vertical stretch

# Default vertical crop matches the WPA framing convention: small sky
# strip at top, fixed archive label band at bottom. Same defaults as
# the renderer when no per-photo Ollama crop is available.
DEFAULT_FACADE_TOP = 0.04
DEFAULT_FACADE_BOTTOM = 0.82  # archive label band runs ~12-18% of native photo height

# Hard clamp on the SIFT-derived seam offset, mirroring the renderer's
# STITCH_OFFSET_CLAMP_M so panoramas built here look the same as planes
# the renderer would have laid out itself.
STITCH_OFFSET_CLAMP_M = 2.0

# Inpaint windowing.
INPAINT_TILE_SIZE = 1024
GAP_FEATHER_PX = 32     # alpha falloff into existing photo pixels at gap edges
COVERAGE_GAP_THRESHOLD = 0.5  # column coverage < this → counts as a gap to inpaint

# Label-mask geometry: WPA surveyors held a black sign reading "<block>-<lot> M"
# in front of every building during the 1940 photo capture. The sign sits at
# the bottom-center of every photo (y≈0.73-0.79 of native height, x≈center
# 40% of width). We mask this region too so SDXL inpaints clean storefront
# content over the sign + the surveyor holding it.
LABEL_BAND_TOP_FRAC = 0.82       # in panorama y (bottom-aligned to facade crop)
LABEL_BAND_BOT_FRAC = 1.00       # extend to canvas bottom — captures sign + post + ground around it
LABEL_BAND_HORIZ_PAD = 0.18      # cover central 1 - 2*pad of each photo's width

# Diffusion knobs.
SDXL_INPAINT_MODEL = "diffusers/stable-diffusion-xl-1.0-inpainting-0.1"
SD15_INPAINT_MODEL = "stable-diffusion-v1-5/stable-diffusion-inpainting"
DEFAULT_PROMPT = (
    "a 1940 New York City tax-survey photograph, sepia tone, brick and "
    "stone facades of low-rise apartment and storefront buildings, "
    "continuous row of buildings, archival quality, fine grain, "
    "consistent lighting, no people, no text"
)
DEFAULT_NEGATIVE = (
    "text, sign, label, lettering, numbers, writing, signage, "
    "color photo, modern, vibrant, watermark, person, people, low quality"
)
GUIDANCE_SCALE = 7.5
NUM_INFERENCE_STEPS = 28


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

@dataclass
class BuildingMeta:
    bin: str
    lot: int
    side: str
    frontage_m: float
    axis_start: float
    axis_end: float
    photo_w: int
    photo_h: int
    photo_path: Path
    facade_top: float = DEFAULT_FACADE_TOP
    facade_bottom: float = DEFAULT_FACADE_BOTTOM


def load_pipeline_inputs(block_id: str, side_filter: str | None) -> tuple[dict, dict, dict]:
    """Returns (manifest, stitch_block, analysis_dict)."""
    if not STITCH_PATH.exists():
        sys.exit(f"stitch JSON not found at {STITCH_PATH}. Run stitch_neighbors.py first.")
    if not MANIFEST_PATH.exists():
        sys.exit(f"manifest not found at {MANIFEST_PATH}")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    stitch = json.loads(STITCH_PATH.read_text(encoding="utf-8"))
    if block_id not in stitch.get("blocks", {}):
        sys.exit(f"block {block_id} not in stitch JSON; available: {list(stitch.get('blocks', {}).keys())}")
    block = stitch["blocks"][block_id]
    if side_filter:
        if side_filter not in block.get("sides", {}):
            sys.exit(f"side {side_filter} not in block {block_id}; available: {list(block['sides'].keys())}")
        block = {
            **block,
            "sides": {side_filter: block["sides"][side_filter]},
            "seams": [s for s in block["seams"] if s["side"] == side_filter],
        }
    analysis = {}
    if ANALYSIS_PATH.exists():
        try:
            analysis = json.loads(ANALYSIS_PATH.read_text(encoding="utf-8")).get("buildings", {})
        except (json.JSONDecodeError, OSError):
            pass
    return manifest, block, analysis


def gather_metas(manifest: dict, block: dict, analysis: dict) -> dict[str, BuildingMeta]:
    by_bin: dict[str, dict] = {str(b["bin"]): b for b in manifest.get("buildings", []) if b.get("photo")}
    metas: dict[str, BuildingMeta] = {}
    for bin_id, info in block["buildings"].items():
        m = by_bin.get(bin_id)
        if not m or not m.get("photo"):
            continue
        photo = m["photo"]
        url = photo["url"]
        a = analysis.get(bin_id) or {}
        metas[bin_id] = BuildingMeta(
            bin=bin_id,
            lot=info["lot"],
            side=info["side"],
            frontage_m=float(info["frontage_m"]),
            axis_start=float(info["axis_start"]),
            axis_end=float(info["axis_end"]),
            photo_w=int(info["photo_w"]),
            photo_h=int(info["photo_h"]),
            photo_path=ROOT / "public" / url.lstrip("/"),
            facade_top=float(a.get("facade_top", DEFAULT_FACADE_TOP)) or DEFAULT_FACADE_TOP,
            facade_bottom=float(a.get("facade_bottom", DEFAULT_FACADE_BOTTOM)) or DEFAULT_FACADE_BOTTOM,
        )
    return metas


# ---------------------------------------------------------------------------
# Canvas assembly per side
# ---------------------------------------------------------------------------

def crop_to_facade(img: Image.Image, top_frac: float, bot_frac: float) -> Image.Image:
    """Trim the sky strip and the archive plate, leaving just the facade."""
    h = img.height
    top = int(round(top_frac * h))
    bot = int(round(bot_frac * h))
    return img.crop((0, top, img.width, max(top + 1, bot)))


def lay_out_side(side_id: str,
                  bins: list[str],
                  metas: dict[str, BuildingMeta],
                  seams: list[dict],
                  *, verbose: bool = False) -> tuple[Image.Image, Image.Image, list[tuple[int, int]], list[tuple[int, int, int, int]]]:
    """Build the wide canvas for one side and return (canvas_rgba, alpha_l, gaps, label_boxes).

    gaps: list of (x_start_px, x_end_px) for contiguous regions where
    coverage drops below COVERAGE_GAP_THRESHOLD — those need inpainting.

    label_boxes: list of (x0, y0, x1, y1) rectangles in canvas coords that
    cover the WPA "BLOCK-LOT M" survey signs at each photo's bottom center.
    SDXL inpaints these too so the chalk/sign content is replaced with
    plausible storefront/sidewalk pixels.
    """
    seam_by_pair = {(s["a_bin"], s["b_bin"]): s for s in seams if s["side"] == side_id}

    # Pixel positions for each building's left edge in the panorama.
    # We start the side at x=0 (leftmost building's left edge).
    side_metas = [metas[b] for b in bins if b in metas]
    if not side_metas:
        raise ValueError(f"no metas for side {side_id}")

    # Build (x_left_px, width_px) per building using the engine layout.
    placements: list[tuple[BuildingMeta, int, int]] = []
    cursor = 0
    prev: BuildingMeta | None = None
    for m in side_metas:
        width_px = max(64, int(round(m.frontage_m * PX_PER_M)))
        if prev is None:
            x = 0
        else:
            seam = seam_by_pair.get((prev.bin, m.bin))
            offset = 0.0
            if seam and seam["confidence"] == "high":
                offset = max(-STITCH_OFFSET_CLAMP_M, min(STITCH_OFFSET_CLAMP_M, seam["feature_offset_m"]))
            x = cursor + int(round(offset * PX_PER_M))
        placements.append((m, x, width_px))
        cursor = x + width_px
        prev = m

    canvas_w = cursor + 32
    canvas = Image.new("RGBA", (canvas_w, CANVAS_HEIGHT), (0, 0, 0, 0))
    coverage = np.zeros(canvas_w, dtype=np.float32)  # max alpha by column
    label_boxes: list[tuple[int, int, int, int]] = []

    for m, x, w in placements:
        try:
            img = Image.open(m.photo_path).convert("RGB")
        except FileNotFoundError:
            if verbose:
                print(f"    skip BIN {m.bin}: photo missing at {m.photo_path}")
            continue
        # Crop facade vertically (kill sky + archive plate).
        img = crop_to_facade(img, m.facade_top, m.facade_bottom)
        # Resize to (target_w, CANVAS_HEIGHT) — preserves the building's
        # along-street scale; vertical scale follows.
        img = img.resize((w, CANVAS_HEIGHT), Image.Resampling.LANCZOS)
        # Build a per-photo alpha: solid in the middle, cosine fade at
        # left/right so adjacent photos blend (panorama-style multi-band).
        alpha_arr = np.ones((CANVAS_HEIGHT, w), dtype=np.float32)
        fade_px = max(8, int(w * 0.07))
        for i in range(fade_px):
            t = (i + 1) / fade_px
            f = 0.5 - 0.5 * math.cos(math.pi * t)  # smooth s-curve
            alpha_arr[:, i] = min(alpha_arr[0, i], f)
            alpha_arr[:, w - 1 - i] = min(alpha_arr[0, w - 1 - i], f)
        alpha_img = Image.fromarray((alpha_arr * 255).astype(np.uint8), "L")
        rgba = img.convert("RGBA")
        rgba.putalpha(alpha_img)

        # Composite onto canvas at (x, 0). Using alpha-over with PIL.
        canvas.alpha_composite(rgba, (x, 0))
        # Update coverage column profile (max alpha across x).
        x0 = max(0, x)
        x1 = min(canvas_w, x + w)
        if x1 > x0:
            ax = (alpha_arr * 255).astype(np.uint8).max(axis=0).astype(np.float32) / 255.0
            local = ax[x0 - x:x1 - x]
            coverage[x0:x1] = np.maximum(coverage[x0:x1], local)

        # Compute the WPA-label mask box for this photo (centered horizontally,
        # at the standard sign vertical position). Slightly wider than the sign
        # itself so SDXL has surrounding context to blend into.
        lbl_x0 = max(0, x + int(w * LABEL_BAND_HORIZ_PAD))
        lbl_x1 = min(canvas_w, x + int(w * (1.0 - LABEL_BAND_HORIZ_PAD)))
        lbl_y0 = int(CANVAS_HEIGHT * LABEL_BAND_TOP_FRAC)
        lbl_y1 = int(CANVAS_HEIGHT * LABEL_BAND_BOT_FRAC)
        if lbl_x1 > lbl_x0:
            label_boxes.append((lbl_x0, lbl_y0, lbl_x1, lbl_y1))

    # Gap detection: contiguous columns where coverage < threshold.
    gaps: list[tuple[int, int]] = []
    in_gap = False
    g_start = 0
    for i, c in enumerate(coverage):
        if c < COVERAGE_GAP_THRESHOLD:
            if not in_gap:
                in_gap = True
                g_start = i
        else:
            if in_gap:
                gaps.append((g_start, i))
                in_gap = False
    if in_gap:
        gaps.append((g_start, len(coverage)))

    # Drop tiny gaps (< 8 px) — those are anti-alias edges. Drop gaps
    # that touch the panorama's outer edge — those are the cosine-fade
    # of the first/last photo, not real interior gaps to bridge.
    EDGE_PAD = 4
    gaps = [(a, b) for a, b in gaps
            if (b - a) >= 8 and a > EDGE_PAD and b < canvas_w - EDGE_PAD]

    if verbose:
        print(f"    side {side_id}: canvas {canvas_w}x{CANVAS_HEIGHT}px, "
              f"{len(gaps)} gap(s) + {len(label_boxes)} WPA-label region(s) to inpaint")
        for a, b in gaps:
            print(f"      gap [{a}-{b}] = {b - a}px")

    return canvas, Image.fromarray((coverage * 255).astype(np.uint8), "L"), gaps, label_boxes


# ---------------------------------------------------------------------------
# Inpaint
# ---------------------------------------------------------------------------

def make_pipeline(model_id: str, *, dtype_str: str = "fp16") -> object:
    import torch
    from diffusers import AutoPipelineForInpainting

    dtype = torch.float16 if dtype_str == "fp16" else torch.float32
    print(f"loading {model_id} ({dtype_str}) — first run downloads ~5-7 GB", flush=True)
    pipe = AutoPipelineForInpainting.from_pretrained(model_id, torch_dtype=dtype, variant="fp16" if dtype_str == "fp16" else None)
    # cpu_offload uses ~6 GB peak VRAM (fits in 8 GB). model_cpu_offload
    # is faster but uses more VRAM; sequential_cpu_offload is slower but
    # lets even tiny VRAM run SDXL.
    if torch.cuda.is_available():
        try:
            pipe.enable_model_cpu_offload()
            print("  enabled model_cpu_offload (8GB VRAM friendly)", flush=True)
        except Exception:
            pipe = pipe.to("cuda")
            print("  moved pipe to cuda", flush=True)
    return pipe


@dataclass
class InpaintRegion:
    """A rectangular region of the panorama canvas to repaint via SDXL."""
    x0: int
    y0: int
    x1: int
    y1: int
    kind: str          # "seam" or "label"
    prompt_suffix: str # appended to the side prompt (e.g. "ground floor storefront")
    strength: float = 0.99  # 1.0 = fully replace prefill; lower = refine prefill


def regions_from_gaps_and_labels(
    gaps: list[tuple[int, int]],
    labels: list[tuple[int, int, int, int]],
) -> list[InpaintRegion]:
    out: list[InpaintRegion] = []
    for g0, g1 in gaps:
        out.append(InpaintRegion(g0, 0, g1, CANVAS_HEIGHT, "seam",
                                 "continuous brick facade"))
    for x0, y0, x1, y1 in labels:
        # Strength 0.35 — the wall-texture prefill (real brick from
        # ABOVE the sign) does the heavy lifting; SDXL only smooths
        # out the visible tiling/repetition. Higher strength gives the
        # model enough freedom to hallucinate new signs.
        out.append(InpaintRegion(x0, y0, x1, y1, "label",
                                 "plain brick wall, ground floor",
                                 strength=0.35))
    return out


def prefill_mask_region(rgb: Image.Image, x0: int, y0: int, x1: int, y1: int,
                         _context_pad: int = 0) -> Image.Image:
    """Replace a rectangular region by tiling the building-wall texture from
    ABOVE the region downward.

    The WPA labels sit at the BOTTOM of each photo, so the pixels
    immediately above the label are guaranteed to be the building's
    facade. Repeating that strip downward gives SDXL a "wall continuing
    to the ground" anchor instead of "dark sign rectangle here". The
    model then refines the texture but doesn't hallucinate text because
    the underlying pattern isn't sign-shaped.
    """
    out = rgb.copy()
    arr = np.array(out)
    H, W = arr.shape[:2]
    h = y1 - y0
    w = x1 - x0
    # Sample a strip from above the region — height = same as region (or
    # less if we're near the top). Use the full width of the region.
    sample_h = min(h, y0)
    if sample_h <= 0:
        return out
    sample = arr[y0 - sample_h:y0, x0:x1].copy()
    # Tile the sample to fill the region.
    tile = np.zeros((h, w, 3), dtype=np.uint8)
    for offset in range(0, h, sample_h):
        end = min(h, offset + sample_h)
        tile[offset:end] = sample[: end - offset]
    # Add subtle noise so it's not too uniform (helps model not just copy).
    rng = np.random.default_rng(seed=(x0 * 31 + y0))
    noise = rng.normal(loc=0, scale=6, size=(h, w, 3))
    tile = (tile.astype(np.float32) + noise).clip(0, 255).astype(np.uint8)
    arr[y0:y1, x0:x1] = tile
    return Image.fromarray(arr)


def inpaint_regions(canvas: Image.Image, regions: list[InpaintRegion],
                    pipe, base_prompt: str, negative: str,
                    *, verbose: bool = False) -> Image.Image:
    """Run SDXL inpaint on each region. Each region centers a 1024-tile window
    around itself; the mask within that tile covers just the region (with
    feather). Subsequent regions see the previous ones' results so adjacent
    repaint zones blend rather than fight."""
    if not regions:
        return canvas

    out = canvas.copy()

    for idx, r in enumerate(regions):
        # Read RGB from the OUTPUT canvas (so iterative passes see prior fills).
        rgb = out.convert("RGB")
        # For label regions, destroy the sign-shaped pattern under the mask
        # before SDXL sees it — otherwise the model recreates the sign with
        # hallucinated text. Gap regions are already empty so prefill is a no-op.
        if r.kind == "label":
            rgb = prefill_mask_region(rgb, r.x0, r.y0, r.x1, r.y1)

        cx = (r.x0 + r.x1) // 2
        cy = (r.y0 + r.y1) // 2
        half = INPAINT_TILE_SIZE // 2

        # Center tile horizontally on region; clamp to canvas bounds.
        tx0 = max(0, cx - half)
        tx1 = min(canvas.width, tx0 + INPAINT_TILE_SIZE)
        tx0 = max(0, tx1 - INPAINT_TILE_SIZE)

        # Vertical: centered on region but at canvas-height bound (1024).
        ty0 = max(0, cy - half)
        ty1 = min(CANVAS_HEIGHT, ty0 + INPAINT_TILE_SIZE)
        ty0 = max(0, ty1 - INPAINT_TILE_SIZE)
        # We won't pad vertically — INPAINT_TILE_SIZE matches CANVAS_HEIGHT
        # by design, so we just use the full canvas height.

        tile = rgb.crop((tx0, ty0, tx1, ty1))
        tw, th = tile.size
        if (tw, th) != (INPAINT_TILE_SIZE, INPAINT_TILE_SIZE):
            padded = Image.new("RGB", (INPAINT_TILE_SIZE, INPAINT_TILE_SIZE), (90, 78, 65))
            padded.paste(tile, (0, 0))
            tile = padded

        mask_arr = np.zeros((INPAINT_TILE_SIZE, INPAINT_TILE_SIZE), dtype=np.uint8)
        rx0 = max(0, r.x0 - tx0)
        ry0 = max(0, r.y0 - ty0)
        rx1 = min(INPAINT_TILE_SIZE, r.x1 - tx0)
        ry1 = min(INPAINT_TILE_SIZE, r.y1 - ty0)
        if rx1 > rx0 and ry1 > ry0:
            mask_arr[ry0:ry1, rx0:rx1] = 255
        mask = Image.fromarray(mask_arr, "L").filter(ImageFilter.GaussianBlur(GAP_FEATHER_PX // 2))

        prompt = f"{base_prompt}. {r.prompt_suffix}"

        if verbose:
            t0 = time.time()
            print(f"  [{idx+1}/{len(regions)}] {r.kind} ({r.x1 - r.x0}x{r.y1 - r.y0}px) "
                  f"@ canvas[{r.x0}-{r.x1}, {r.y0}-{r.y1}]...", flush=True)

        result = pipe(
            prompt=prompt,
            negative_prompt=negative,
            image=tile,
            mask_image=mask,
            num_inference_steps=NUM_INFERENCE_STEPS,
            guidance_scale=GUIDANCE_SCALE,
            strength=r.strength,
            height=INPAINT_TILE_SIZE,
            width=INPAINT_TILE_SIZE,
        ).images[0]

        if verbose:
            print(f"      done in {time.time() - t0:.1f}s")

        # Composite back: only the masked region overwrites the canvas.
        result_crop = result.crop((0, 0, INPAINT_TILE_SIZE, INPAINT_TILE_SIZE))
        comp_alpha = mask
        result_rgba = result_crop.convert("RGBA")
        result_rgba.putalpha(comp_alpha)
        out.alpha_composite(result_rgba, (tx0, ty0))

    return out


# ---------------------------------------------------------------------------
# CLI driver
# ---------------------------------------------------------------------------

def build_prompt(side_metas: list[BuildingMeta], analysis: dict) -> str:
    """Assemble a per-side prompt from llava notes if present."""
    notes = []
    for m in side_metas[:6]:
        a = analysis.get(m.bin) or {}
        n = (a.get("notes") or "").strip()
        if n and n.lower() not in ("none", "n/a"):
            notes.append(n)
    if notes:
        joined = "; ".join(notes[:4])
        return DEFAULT_PROMPT + ", featuring: " + joined
    return DEFAULT_PROMPT


def main():
    global NUM_INFERENCE_STEPS
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument("--block", default="1-585", help="Block id (default 1-585)")
    p.add_argument("--side", default=None, help="One side only (e.g. side_a)")
    p.add_argument("--small", action="store_true", help="Use SD 1.5 inpaint (faster, lower quality)")
    p.add_argument("--dry-run", action="store_true", help="Save canvas+mask without diffusion inference")
    p.add_argument("--verbose", "-v", action="store_true")
    p.add_argument("--prompt", default=None)
    p.add_argument("--negative", default=DEFAULT_NEGATIVE)
    p.add_argument("--steps", type=int, default=NUM_INFERENCE_STEPS)
    args = p.parse_args()
    NUM_INFERENCE_STEPS = args.steps

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest, block, analysis = load_pipeline_inputs(args.block, args.side)
    metas = gather_metas(manifest, block, analysis)

    pipe = None
    if not args.dry_run:
        model = SD15_INPAINT_MODEL if args.small else SDXL_INPAINT_MODEL
        pipe = make_pipeline(model)

    for side_id, bins in block["sides"].items():
        side_metas = [metas[b] for b in bins if b in metas]
        if not side_metas:
            continue
        if args.verbose:
            print(f"\n[{args.block} / {side_id}] {len(side_metas)} buildings: lots " +
                  ", ".join(str(m.lot) for m in side_metas))
        canvas, coverage_img, gaps, label_boxes = lay_out_side(
            side_id, bins, metas, block["seams"], verbose=args.verbose)
        # Always save the raw canvas + mask for inspection.
        base = OUT_DIR / f"{args.block}-{side_id}"
        canvas.save(f"{base}-canvas.png")
        coverage_img.save(f"{base}-coverage.png")
        if args.verbose:
            print(f"  wrote {base}-canvas.png ({canvas.size[0]}x{canvas.size[1]}px)")
            print(f"  wrote {base}-coverage.png")

        if args.dry_run or pipe is None:
            continue

        prompt = args.prompt or build_prompt(side_metas, analysis)
        if args.verbose:
            print(f"  prompt: {prompt}")
        regions = regions_from_gaps_and_labels(gaps, label_boxes)
        stitched = inpaint_regions(canvas, regions, pipe, prompt, args.negative,
                                    verbose=args.verbose)
        out_path = OUT_DIR / f"{args.block}-{side_id}.png"
        stitched.convert("RGB").save(out_path)
        print(f"  wrote {out_path.relative_to(ROOT)} ({stitched.size[0]}x{stitched.size[1]}px)")


if __name__ == "__main__":
    main()
