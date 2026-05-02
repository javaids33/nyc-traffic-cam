"""stitch_contact_sheet.py - render per-side diagnostic strips.

Reads public/photo-stitch-1940s.json and produces, for each side of each
block, a single PNG that lays out every photo at its derived axis position,
scaled to its frontage_m. Annotates each seam with the SIFT inlier count
and overall score so we can spot misaligned pairs at a glance.

This is purely a diagnostic — the renderer doesn't read these PNGs. The
goal is to put the stitching pipeline's geometric output in front of human
eyes for quick visual validation.

Usage:

    python -m server.stitch_contact_sheet --block 1-585
    python -m server.stitch_contact_sheet --all
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
STITCH_PATH = ROOT / "public" / "photo-stitch-1940s.json"
MANIFEST_PATH = ROOT / "public" / "data-1940s.json"
PHOTOS_DIR = ROOT / "public" / "photos_1940s"
OUT_DIR = ROOT / "public" / "photo-stitch-contact"

PX_PER_M = 32                       # contact-sheet horizontal scale
SHEET_HEIGHT_PX = 280               # uniform per-photo vertical band
LABEL_HEIGHT_PX = 130               # caption strip below each photo (allows 2-row stagger)
SEAM_WIDTH_PX = 4                   # vertical bar between photos
PADDING_X_PX = 60                   # left/right margin


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Return a TrueType font if any common system font is available; fall
    back to PIL's bitmap default. Sizes are in pixels."""
    candidates = [
        "C:/Windows/Fonts/consola.ttf",   # Windows Consolas (monospaced)
        "C:/Windows/Fonts/arial.ttf",     # Windows Arial
        "/System/Library/Fonts/Menlo.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def render_side(
    block_id: str,
    side_id: str,
    side_data: dict,
    buildings: dict,
    seams: list[dict],
    bin_to_photo_path: dict[str, Path],
) -> Image.Image | None:
    bins_in_order = side_data
    if not bins_in_order:
        return None

    # Sort by axis_start so the layout matches the canonical street order.
    bin_axis = [(b, buildings[b]["axis_start"], buildings[b]["axis_end"]) for b in bins_in_order]
    bin_axis.sort(key=lambda t: t[1])

    # Anchor the sheet at axis_start of the leftmost building.
    origin = bin_axis[0][1]
    end = bin_axis[-1][2]
    span_m = max(1.0, end - origin)
    sheet_w = int(PADDING_X_PX * 2 + span_m * PX_PER_M)
    sheet_h = SHEET_HEIGHT_PX + LABEL_HEIGHT_PX + 60   # +header

    sheet = Image.new("RGB", (sheet_w, sheet_h), (24, 22, 20))
    draw = ImageDraw.Draw(sheet)
    title_font = load_font(20)
    label_font = load_font(13)
    seam_font = load_font(12)

    # Header
    draw.text(
        (PADDING_X_PX, 8),
        f"{block_id} / {side_id}  —  {len(bin_axis)} bldgs  span {span_m:.1f}m",
        fill=(240, 230, 210),
        font=title_font,
    )

    # Pre-build a seam lookup keyed by (a_bin, b_bin).
    seam_lookup: dict[tuple[str, str], dict] = {}
    for s in seams:
        if s["side"] != side_id:
            continue
        seam_lookup[(s["a_bin"], s["b_bin"])] = s

    # Draw each building's photo at the correct width + horizontal offset.
    y_top = 40
    for idx, (bin_, ax_start, ax_end) in enumerate(bin_axis):
        info = buildings[bin_]
        x0 = PADDING_X_PX + int((ax_start - origin) * PX_PER_M)
        width_px = max(20, int((ax_end - ax_start) * PX_PER_M))
        photo_path = bin_to_photo_path.get(bin_)
        if photo_path is None or not photo_path.exists():
            draw.rectangle(
                [x0, y_top, x0 + width_px, y_top + SHEET_HEIGHT_PX],
                fill=(60, 50, 44),
                outline=(100, 80, 60),
            )
            draw.text((x0 + 4, y_top + 8), f"missing\nbin {bin_[-4:]}", fill=(240, 200, 160), font=label_font)
        else:
            try:
                img = Image.open(photo_path).convert("RGB")
                img = img.resize((width_px, SHEET_HEIGHT_PX), Image.LANCZOS)
                sheet.paste(img, (x0, y_top))
            except Exception as exc:
                draw.rectangle(
                    [x0, y_top, x0 + width_px, y_top + SHEET_HEIGHT_PX],
                    fill=(80, 50, 50),
                    outline=(160, 80, 80),
                )
                draw.text((x0 + 4, y_top + 8), f"err: {exc}", fill=(240, 180, 180), font=label_font)
        # Caption below — only fits if the photo is wide enough; otherwise
        # stagger via row offset so adjacent narrow lots don't overprint.
        cap_y = y_top + SHEET_HEIGHT_PX + 6 + ((idx % 2) * 50)
        corner = " [COR]" if info.get("is_corner") else ""
        cap = (
            f"lot {info['lot']} bin{bin_[-4:]}\n"
            f"front {info['frontage_m']:.1f}m{corner}\n"
            f"facade {info.get('facade_angle_deg', 0):.0f}d"
        )
        draw.text((x0 + 4, cap_y), cap, fill=(220, 210, 200), font=label_font)

        # Seam annotation between this and the next
        if idx + 1 < len(bin_axis):
            next_bin, next_ax_start, _ = bin_axis[idx + 1]
            seam = seam_lookup.get((bin_, next_bin)) or seam_lookup.get((next_bin, bin_))
            if seam:
                conf = seam["confidence"]
                inl = seam["raw"]["inliers"]
                score = seam["scores"]["overall"]
                offset = seam["feature_offset_m"]
                color = {
                    "high": (110, 220, 110),
                    "med":  (220, 200, 110),
                    "low":  (220, 100, 100),
                }[conf]
                # Draw the seam marker centered between A's end and B's start.
                seam_x_a = PADDING_X_PX + int((ax_end - origin) * PX_PER_M)
                seam_x_b = PADDING_X_PX + int((next_ax_start - origin) * PX_PER_M)
                seam_x = (seam_x_a + seam_x_b) // 2
                draw.line(
                    [(seam_x, y_top), (seam_x, y_top + SHEET_HEIGHT_PX)],
                    fill=color,
                    width=SEAM_WIDTH_PX,
                )
                draw.text(
                    (seam_x + 6, y_top + 6),
                    f"{conf}\ninl {inl}\nscore {score:.2f}\noff {offset:+.1f}m",
                    fill=color,
                    font=seam_font,
                )
            else:
                # No seam metric → unknown
                seam_x_a = PADDING_X_PX + int((ax_end - origin) * PX_PER_M)
                seam_x_b = PADDING_X_PX + int((next_ax_start - origin) * PX_PER_M)
                seam_x = (seam_x_a + seam_x_b) // 2
                draw.line(
                    [(seam_x, y_top), (seam_x, y_top + SHEET_HEIGHT_PX)],
                    fill=(120, 120, 120),
                    width=2,
                )

    return sheet


def main() -> None:
    p = argparse.ArgumentParser(description="Render diagnostic contact sheets per side.")
    p.add_argument("--block", default=None, help="Limit to one block (e.g. 1-585).")
    p.add_argument("--all", action="store_true", help="Render every block in the stitch JSON.")
    args = p.parse_args()

    if not STITCH_PATH.exists():
        sys.exit(f"missing stitch JSON at {STITCH_PATH} — run server.stitch_neighbors first")
    if not MANIFEST_PATH.exists():
        sys.exit(f"missing manifest at {MANIFEST_PATH}")
    data = json.loads(STITCH_PATH.read_text(encoding="utf-8"))
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    # Build bin -> absolute photo path lookup from the manifest's photo URLs.
    bin_to_photo_path: dict[str, Path] = {}
    for b in manifest.get("buildings", []):
        photo = b.get("photo")
        if not photo or not photo.get("url"):
            continue
        url = photo["url"]
        bin_to_photo_path[str(b["bin"])] = ROOT / "public" / url.lstrip("/")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    blocks = data.get("blocks", {})
    if not blocks:
        sys.exit("stitch JSON has no blocks")
    if not args.all:
        if args.block:
            keep = args.block
        else:
            keep = next(iter(blocks))
        blocks = {keep: blocks[keep]}

    written = 0
    for block_id, blk in blocks.items():
        for side_id, bins in blk["sides"].items():
            sheet = render_side(block_id, side_id, bins, blk["buildings"], blk.get("seams", []), bin_to_photo_path)
            if sheet is None:
                continue
            out_path = OUT_DIR / f"{block_id}-{side_id}.png"
            sheet.save(out_path, "PNG", optimize=True)
            print(f"wrote {out_path.relative_to(ROOT)}  ({sheet.width}x{sheet.height})")
            written += 1
    print(f"\ndone — {written} sheet(s) in {OUT_DIR.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
