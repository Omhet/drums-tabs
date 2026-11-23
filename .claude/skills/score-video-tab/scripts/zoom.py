"""Blow up part of a reading sheet, for the beats that are hard to make out.

Crops beats <first>-<last> of the bar on a read_gNN.png (with a quarter of a
beat either side, since notes are not spaced evenly), keeps the staff labels
at the left, and scales it up 3x. The beats are cut by width, so check the
neighbouring beat's notes at the edges.

usage: python -I zoom.py <read_gNN.png> <out.png> <first beat> [<last beat>]
"""

import sys
from pathlib import Path

from PIL import Image

PAD = 44  # group.py's label column at the left of a sheet
SCALE = 3


def main() -> None:
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    first = int(sys.argv[3])
    last = int(sys.argv[4]) if len(sys.argv) > 4 else first
    if not 1 <= first <= last <= 4:
        raise SystemExit("beats are 1-4")
    im = Image.open(src).convert("RGB")
    beat = (im.width - PAD) / 4
    x0 = max(PAD, round(PAD + (first - 1.25) * beat))
    x1 = min(im.width, round(PAD + (last + 0.25) * beat))
    labels = im.crop((0, 0, PAD, im.height))
    part = im.crop((x0, 0, x1, im.height))
    canvas = Image.new("RGB", (PAD + part.width, im.height), "white")
    canvas.paste(labels, (0, 0))
    canvas.paste(part, (PAD, 0))
    canvas.resize((canvas.width * SCALE, canvas.height * SCALE), Image.LANCZOS).save(out)
    print(f"wrote {out} (beats {first}-{last})")


if __name__ == "__main__":
    main()
