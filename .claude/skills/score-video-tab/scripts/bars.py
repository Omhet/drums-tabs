"""Cut clean score lines into bars.

Finds the five staff lines, finds the barlines (dark across the whole staff
and light just above and below it, which is what tells a barline from a
stem), and cuts each bar out at full height. A line with no staff (an end
card) is skipped. Writes <out>/barNNN.png and bars.json; group.py groups them.

usage: python -I bars.py <lines_dir> <out_dir> [--per-line 4] [--clef-end 95]
  --per-line   bars a line, only to warn about lines that differ (the last
               line of a song often has one more)
  --clef-end   x where the first bar starts, past the clef and bar number
"""

import argparse
import json
import re
from pathlib import Path

import numpy as np
from PIL import Image

DARK = 110
#: Staff lines are thin, and one that falls between two pixel rows is only
#: mid-grey in each (Sonne's first line). Looser than DARK for finding them.
STAFF_DARK = 170


def staff_lines(gray: np.ndarray) -> list[int]:
    dark = (gray < STAFF_DARK).mean(axis=1)
    rows = np.where(dark > 0.6)[0]
    groups: list[list[int]] = []
    for r in rows:
        if groups and r - groups[-1][-1] <= 2:
            groups[-1].append(r)
        else:
            groups.append([r])
    centres = [int(round(np.mean(g))) for g in groups]
    # The five evenly spaced ones. A dark band of the drummer's video can show
    # along the top edge of the strip (Sonne's did) and is not a staff line.
    for i in range(len(centres) - 4):
        gaps = np.diff(centres[i:i + 5])
        if gaps.min() > 8 and gaps.max() - gaps.min() <= 3:
            return centres[i:i + 5]
    return []


def barlines(gray: np.ndarray, top: int, bot: int, first: int) -> list[int]:
    """Barline x positions right of `first` (the system's own opening line is left of it)."""
    w = gray.shape[1]
    staff = (gray[top:bot + 1] < DARK).mean(axis=0)
    above = (gray[top - 14:top - 6] < DARK).mean(axis=0)
    below = (gray[bot + 6:bot + 14] < DARK).mean(axis=0)
    cand = np.where((staff > 0.95) & (above < 0.2) & (below < 0.2))[0]
    xs: list[list[int]] = []
    for x in cand:
        if xs and x - xs[-1][-1] <= 20:  # a double or final barline is one edge
            xs[-1].append(x)
        else:
            xs.append([x])
    return [int(round(np.mean(g))) for g in xs if first < np.mean(g) < w - 2 or np.mean(g) >= w - 40]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("lines_dir", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--per-line", type=int, default=4)
    ap.add_argument("--clef-end", type=int, default=95)
    a = ap.parse_args()
    a.out_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(f for f in a.lines_dir.glob("line*.png") if re.fullmatch(r"line\d\d\.png", f.name))
    bars = []
    for li, f in enumerate(files):
        rgb = np.asarray(Image.open(f).convert("RGB"))
        gray = rgb.mean(axis=2)
        st = staff_lines(gray)
        if not st:
            print(f"{f.name}: no staff, skipped (an end card?)")
            continue
        bl = barlines(gray, st[0], st[-1], a.clef_end + 55)
        edges = [a.clef_end] + bl
        if len(edges) - 1 != a.per_line:
            print(f"{f.name}: {len(edges) - 1} bars (barlines at {bl}) -- look at it")
        for k in range(len(edges) - 1):
            x0, x1 = edges[k] - (0 if k == 0 else 4), edges[k + 1] + 4
            n = len(bars) + 1
            Image.fromarray(rgb[:, max(0, x0):x1]).save(a.out_dir / f"bar{n:03d}.png")
            bars.append({"bar": n, "line": li, "file": f.name, "x0": int(x0), "x1": int(x1), "staff": st})
    (a.out_dir / "bars.json").write_text(json.dumps({"bars": bars, "groups": []}, indent=1))
    print(f"{len(bars)} bars from {len(files)} lines")


if __name__ == "__main__":
    main()
