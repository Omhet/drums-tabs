"""Cut a drum-score video's notation strip into one clean image per line.

Reads the strip region at FPS frames a second, masks the blue playback cursor,
starts a new line whenever the non-cursor pixels change -- or when the cursor
jumps from the right end back to the left, because two lines can differ only
in the bar number -- and writes the per-pixel median of each line's frames:
the cursor moves, the ink does not, so the median has no cursor in it.

Writes <outdir>/lineNN.png and lines.json (each line's time span, and the
cursor's x in every frame).

usage: python -I strips.py <video> <outdir> <y0> <y1>
  y0 y1   the strip's rows in the 1080p frame (the channel file says; the
          height must be even, or the frames come out sheared)
"""

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

FPS = 6
W = 1920


def cursor_mask(rgb: np.ndarray) -> np.ndarray:
    r = rgb[..., 0].astype(np.int16)
    b = rgb[..., 2].astype(np.int16)
    return (b - r) > 40


def frame_size(video: Path) -> tuple[int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
         "-of", "csv=p=0", str(video)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    w, h = out.split(",")[:2]
    return int(w), int(h)


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)
    video, outdir = Path(sys.argv[1]), Path(sys.argv[2])
    y0, y1 = int(sys.argv[3]), int(sys.argv[4])
    h = y1 - y0
    if h % 2:
        raise SystemExit(f"the strip is {h} rows tall: make it even (yuv420 frames shear otherwise)")
    if frame_size(video) != (W, 1080):
        raise SystemExit(f"{video} is {frame_size(video)}, not 1920x1080: download the 1080p stream")
    outdir.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-i", str(video),
         "-vf", f"fps={FPS},crop={W}:{h}:0:{y0}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    size = W * h * 3
    lines, cursor, diffs = [], [], []
    seg: list[np.ndarray] = []
    seg_start = 0
    ref = ref_mask = None
    i = 0

    def flush(end: int) -> None:
        if len(seg) < 3:  # a fade or a one-frame flash, not a line
            return
        med = np.median(np.stack(seg), axis=0).astype(np.uint8)
        n = len(lines)
        Image.fromarray(med).save(outdir / f"line{n:02d}.png")
        lines.append({"n": n, "t0": seg_start / FPS, "t1": end / FPS, "frames": len(seg)})

    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, W, 3)
        mask = cursor_mask(rgb)
        cols = np.where(mask.sum(axis=0) > h * 0.4)[0]
        cursor.append(float(cols.mean()) if len(cols) else None)
        gray = rgb.mean(axis=2)
        if ref is None:
            ref, ref_mask = gray, mask
            seg, seg_start = [rgb], i
        else:
            valid = ~(mask | ref_mask)
            frac = float((np.abs(gray - ref)[valid] > 60).mean())
            diffs.append(frac)
            prev = next((c for c in reversed(cursor[:-1]) if c is not None), None)
            wrapped = cursor[-1] is not None and prev is not None and prev - cursor[-1] > 800
            if frac > 0.004 or wrapped:
                flush(i)
                ref, ref_mask = gray, mask
                seg, seg_start = [rgb], i
            else:
                seg.append(rgb)
        i += 1
    flush(i)
    proc.wait()
    (outdir / "lines.json").write_text(json.dumps(
        {"fps": FPS, "y0": y0, "y1": y1, "lines": lines, "cursor_x": cursor, "diff": diffs}, indent=1))
    for ln in lines:
        print(f"line{ln['n']:02d}  {ln['t0']:7.2f}-{ln['t1']:7.2f}s  {ln['frames']} frames")


if __name__ == "__main__":
    main()
