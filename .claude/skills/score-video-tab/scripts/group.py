"""Group look-alike bars, and draw one reading sheet per distinct bar.

Two bars are the same only if no ink blob is in one and not the other (the
ink is thickened before comparing, so a few pixels of justification drift do
not count, but a missing notehead, accent or sticking letter does) AND their
local ink density matches -- the second test is what tells a solid ride
triangle from a circled-x crash at the same spot, which the first calls equal.

Writes the groups into bars.json and read_gNN.png: the group's first bar at
full size, its staff positions labelled with the channel's instruments.

usage: python -I group.py <bars_dir> [--labels "-1:HH,1:HT,2:MT,3:SD,5:FT,7:BD"]
                          [--tolerance 30] [--dilate 7] [--compare 5-21 ...]
  --labels    staff position -> name, positions in half-spaces below the top
              line (0 the top line, 1 the top space, ..., 8 the bottom line,
              negative above the staff): the channel file has them
  --compare   print the two scores for pairs of bars, to see why they did or
              did not group
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy.ndimage import binary_opening, uniform_filter

ROWS = slice(20, 300)


def ink(path: Path, size: tuple[int, int] | None = None) -> Image.Image:
    im = Image.open(path).convert("L")
    if size:
        im = im.resize(size, Image.BILINEAR)
    return im.point(lambda v: 255 if v < 128 else 0)


def extra(a: Image.Image, b: Image.Image, dil: int) -> int:
    """Ink in a with no ink of b nearby, thin slivers (a shifted stem's edge) left out."""
    bd = np.asarray(b.filter(ImageFilter.MaxFilter(dil))) > 0
    only = (np.asarray(a) > 0) & ~bd
    o = Image.fromarray((only * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))
    return int((np.asarray(o) > 0)[ROWS].sum())


def shape_diff(pa: Path, pb: Path) -> int:
    """Pixels where the local ink density differs a lot."""
    def dens(p: Path, size=None) -> np.ndarray:
        im = Image.open(p).convert("L")
        if size:
            im = im.resize(size, Image.BILINEAR)
        return uniform_filter((np.asarray(im) < 128).astype(np.float32), 9)
    a = dens(pa)
    b = dens(pb, Image.open(pa).size)
    return int(binary_opening((np.abs(a - b) > 0.4)[ROWS], np.ones((3, 3))).sum())


def same(pa: Path, pb: Path, tol: int, dil: int) -> tuple[bool, int, int]:
    a = ink(pa)
    wa, wb = a.width, Image.open(pb).width
    if abs(wa - wb) > 0.06 * max(wa, wb):
        return False, -1, -1
    b = ink(pb, a.size)
    d = max(extra(a, b, dil), extra(b, a, dil))
    s = shape_diff(pa, pb)
    return d <= tol and s <= 10, d, s


def sheets(d: Path, bars: list, groups: list[list[int]], labels: dict[int, str]) -> None:
    for old in d.glob("read_g*.png"):
        old.unlink()
    try:
        font = ImageFont.truetype("arial.ttf", 16)
    except OSError:
        font = ImageFont.load_default()
    for g, members in enumerate(groups):
        b = bars[members[0] - 1]
        crop = Image.open(d / f"bar{b['bar']:03d}.png").convert("RGB")
        st = b["staff"]
        half = (st[-1] - st[0]) / 8
        pad = 44
        canvas = Image.new("RGB", (crop.width + pad, crop.height + 26), "white")
        canvas.paste(crop, (pad, 26))
        dr = ImageDraw.Draw(canvas)
        dr.text((4, 4), f"g{g:02d}  bar {b['bar']}  (x{len(members)})", fill="red", font=font)
        for k, name in labels.items():
            y = 26 + st[0] + k * half
            dr.text((4, y - 9), name, fill="blue", font=font)
        canvas.save(d / f"read_g{g:02d}.png")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("bars_dir", type=Path)
    ap.add_argument("--labels", default="-1:HH,1:HT,2:MT,3:SD,5:FT,7:BD")
    ap.add_argument("--tolerance", type=int, default=30)
    ap.add_argument("--dilate", type=int, default=7)
    ap.add_argument("--compare", nargs="*", default=[])
    a = ap.parse_args()
    d = a.bars_dir
    labels = {int(k): v for k, v in (p.split(":") for p in a.labels.split(","))}
    meta = json.loads((d / "bars.json").read_text())
    bars = meta["bars"]
    groups: list[list[int]] = []
    for b in bars:
        p = d / f"bar{b['bar']:03d}.png"
        for g in groups:
            if same(d / f"bar{g[0]:03d}.png", p, a.tolerance, a.dilate)[0]:
                g.append(b["bar"])
                break
        else:
            groups.append([b["bar"]])
    meta["groups"] = groups
    for g, m in enumerate(groups):
        for n in m:
            bars[n - 1]["group"] = g
    (d / "bars.json").write_text(json.dumps(meta, indent=1))
    print(f"{len(bars)} bars, {len(groups)} distinct")
    for g, m in enumerate(groups):
        print(f"  g{g:02d}: {m}")
    sheets(d, bars, groups, labels)
    for pair in a.compare:
        x, y = pair.split("-")
        ok, ink_d, shape_d = same(d / f"bar{int(x):03d}.png", d / f"bar{int(y):03d}.png", a.tolerance, a.dilate)
        print(f"{pair}: {'same' if ok else 'different'} (ink {ink_d}, shape {shape_d})")


if __name__ == "__main__":
    main()
