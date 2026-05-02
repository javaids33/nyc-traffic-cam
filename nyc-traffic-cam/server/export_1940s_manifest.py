"""Export the fetched 1940s data as a single JSON manifest the frontend can lazy-load.

Reads from data/nyc.db (populated by fetch_1940s.py) and emits:
  src/data-1940s.json    - one geojson-ish manifest per bbox

Photos are referenced by relative path (`/photos_1940s/<file>.jpg`) and copied
into public/photos_1940s/ so Vite serves them as static assets.

Run:
  .venv/bin/python -m server.export_1940s_manifest
  .venv/bin/python -m server.export_1940s_manifest --out src/data-1940s.json
"""
from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
from pathlib import Path

from .config import DB_PATH, ROOT


PHOTO_SRC = ROOT / "data" / "photos_1940s"
PHOTO_PUB = ROOT / "public" / "photos_1940s"


def quantize(geom: dict, decimals: int = 6) -> dict:
    """Round all coords to `decimals` places to shrink JSON. Mutates in place."""
    def _walk(obj):
        if isinstance(obj, list):
            if obj and isinstance(obj[0], (int, float)):
                return [round(float(x), decimals) for x in obj]
            return [_walk(x) for x in obj]
        return obj
    if "coordinates" in geom:
        geom = {**geom, "coordinates": _walk(geom["coordinates"])}
    return geom


def export(out_path: Path, copy_photos: bool) -> None:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row

    rows = db.execute("""
        SELECT f.bin, f.bbl, f.boro, f.block, f.lot, f.construction_year,
               f.height_roof, f.ground_elevation, f.geometry_json,
               p.filename_stem, p.status AS photo_status, p.width, p.height
        FROM footprints_1940s f
        LEFT JOIN photos_1940s p ON p.bbl = f.bbl
        ORDER BY f.boro, f.block, f.lot, f.bin
    """).fetchall()

    buildings = []
    photo_files: list[str] = []
    for r in rows:
        geom = quantize(json.loads(r["geometry_json"]))
        photo = None
        if r["photo_status"] == "ok" and r["filename_stem"]:
            fn = f"{r['filename_stem']}.jpg"
            if (PHOTO_SRC / fn).exists():
                photo = {
                    "url": f"/photos_1940s/{fn}",
                    "w": r["width"],
                    "h": r["height"],
                }
                photo_files.append(fn)
        buildings.append({
            "bin": r["bin"],
            "bbl": r["bbl"],
            "boro": r["boro"],
            "block": r["block"],
            "lot": r["lot"],
            "year": r["construction_year"],
            "h_roof": r["height_roof"],
            "h_ground": r["ground_elevation"],
            "geom": geom,
            "photo": photo,
        })

    manifest = {
        "version": 1,
        "source": {
            "footprints": "NYC Open Data Building Footprints (5zhs-2jue)",
            "photos": "NYC Municipal Archives via Preservica (nycrecords.access.preservica.com)",
        },
        "count": len(buildings),
        "with_photo": sum(1 for b in buildings if b["photo"]),
        "buildings": buildings,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    size_kb = out_path.stat().st_size // 1024
    print(f"[manifest] wrote {out_path} ({size_kb} KB, {len(buildings)} buildings, {manifest['with_photo']} with photos)")

    # Also copy into public/ so Vite serves it at /<filename>
    pub_path = ROOT / "public" / out_path.name
    pub_path.parent.mkdir(parents=True, exist_ok=True)
    pub_path.write_bytes(out_path.read_bytes())
    print(f"[manifest] mirrored to {pub_path}")

    if copy_photos:
        PHOTO_PUB.mkdir(parents=True, exist_ok=True)
        copied = 0
        for fn in photo_files:
            src = PHOTO_SRC / fn
            dst = PHOTO_PUB / fn
            if not dst.exists() or dst.stat().st_size != src.stat().st_size:
                shutil.copyfile(src, dst)
                copied += 1
        print(f"[photos] copied {copied} new files to {PHOTO_PUB} (total {len(photo_files)})")

    db.close()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(ROOT / "src" / "data-1940s.json"))
    ap.add_argument("--no-copy-photos", action="store_true",
                    help="skip copying photos to public/")
    args = ap.parse_args()
    export(Path(args.out), copy_photos=not args.no_copy_photos)


if __name__ == "__main__":
    main()
