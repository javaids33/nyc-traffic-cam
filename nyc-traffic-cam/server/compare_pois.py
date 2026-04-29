"""compare_pois.py — diff two cam_pois.json runs side by side.

Use after a parallel sweep with `--output-name` to see what changed
between models / parameters. Prints summary stats then per-cam
disagreements grouped by signal (quality flips, scene flips, tag
adds/drops, interest deltas).

Usage:
    python -m server.compare_pois data/cam_pois.json data/cam_pois_qwen25vl.json
    python -m server.compare_pois A.json B.json --top 30   # show 30 biggest interest swings

Reads only — never writes.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


def _load(p: Path) -> dict[str, Any]:
    payload = json.loads(p.read_text())
    return payload.get("cameras", {})


def _qual(rec: dict[str, Any]) -> str:
    return rec.get("quality") or ("good" if rec.get("image_usable", True) else "broken")


def main() -> None:
    p = argparse.ArgumentParser(description="Diff two cam_pois.json files.")
    p.add_argument("a", type=Path, help="baseline file (older / current)")
    p.add_argument("b", type=Path, help="new file (the rerun)")
    p.add_argument("--top", type=int, default=20, help="Show this many biggest per-cam swings (default 20)")
    p.add_argument("--names", type=Path, default=Path("src") / "cameras.json",
                   help="cameras.json with id→name lookup for readable output")
    args = p.parse_args()

    A = _load(args.a)
    B = _load(args.b)
    common = set(A) & set(B)
    only_a = set(A) - set(B)
    only_b = set(B) - set(A)

    names: dict[str, str] = {}
    if args.names.exists():
        try:
            meta = json.loads(args.names.read_text())
            names = {c["id"]: c.get("name", "") for c in meta.get("cameras", [])}
        except Exception:
            pass

    print(f"A: {args.a}  →  {len(A)} cams")
    print(f"B: {args.b}  →  {len(B)} cams")
    print(f"  common: {len(common)} · only-A: {len(only_a)} · only-B: {len(only_b)}\n")

    # Quality histogram comparison.
    hist_a = Counter(_qual(A[c]) for c in common)
    hist_b = Counter(_qual(B[c]) for c in common)
    qualities = sorted(set(hist_a) | set(hist_b))
    print("quality distribution (common cams):")
    print(f"  {'':10s}  {'A':>6s}  {'B':>6s}  {'Δ':>6s}")
    for q in qualities:
        a, b = hist_a.get(q, 0), hist_b.get(q, 0)
        print(f"  {q:10s}  {a:>6d}  {b:>6d}  {b - a:>+6d}")

    # Quality flips per cam.
    flips: Counter = Counter()
    for c in common:
        qa, qb = _qual(A[c]), _qual(B[c])
        if qa != qb:
            flips[(qa, qb)] += 1
    if flips:
        print("\nquality flips (A → B):")
        for (qa, qb), n in flips.most_common():
            print(f"  {qa:>10s} → {qb:<10s}  {n}")

    # Scene flips.
    scene_flips: Counter = Counter()
    for c in common:
        sa = A[c].get("scene") or "?"
        sb = B[c].get("scene") or "?"
        if sa != sb:
            scene_flips[(sa, sb)] += 1
    if scene_flips:
        print("\nscene flips (top 12):")
        for (sa, sb), n in scene_flips.most_common(12):
            print(f"  {sa:>12s} → {sb:<12s}  {n}")

    # Tag add/drop tally.
    tag_added: Counter = Counter()
    tag_dropped: Counter = Counter()
    for c in common:
        ta = set(A[c].get("tags") or [])
        tb = set(B[c].get("tags") or [])
        for t in tb - ta:
            tag_added[t] += 1
        for t in ta - tb:
            tag_dropped[t] += 1
    print("\ntag deltas (per tag, summed across cams):")
    print(f"  {'tag':14s}  {'+B':>5s}  {'-B':>5s}  {'net':>5s}")
    all_tags = sorted(set(tag_added) | set(tag_dropped))
    for t in sorted(all_tags, key=lambda x: -(tag_added[x] - tag_dropped[x])):
        added, dropped = tag_added[t], tag_dropped[t]
        print(f"  {t:14s}  {added:>5d}  {dropped:>5d}  {added - dropped:>+5d}")

    # Biggest interest swings — most likely to be visible on /poi.
    deltas: list[tuple[int, str]] = []
    for c in common:
        ia = A[c].get("interest", 0) or 0
        ib = B[c].get("interest", 0) or 0
        if ia == ib:
            continue
        deltas.append((ib - ia, c))
    deltas.sort(key=lambda x: -abs(x[0]))
    if deltas:
        print(f"\ntop {args.top} interest swings:")
        print(f"  {'Δ':>4s}  {'A→B':>9s}  {'qA→qB':>16s}  cam · name")
        for d, cid in deltas[: args.top]:
            ra, rb = A[cid], B[cid]
            ia, ib = ra.get("interest", 0) or 0, rb.get("interest", 0) or 0
            qa, qb = _qual(ra), _qual(rb)
            label = names.get(cid, "")
            print(f"  {d:>+4d}  {ia:>3d}→{ib:<3d}    {qa:>7s}→{qb:<7s}  {cid[:8]} · {label[:48]}")


if __name__ == "__main__":
    main()
