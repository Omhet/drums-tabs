"""The tab strip along the bottom of a cover video.

Two halves. :func:`render_assets` has alphaTab engrave the song's ``tab.mid``
once, in a browser (``app/cover-tab.html`` driven by
``app/scripts/render-tab.mjs``), into a picture and a list of where every beat
landed on it. :class:`Strip` then draws a frame for any moment of the video
from those two, cheaply enough to be called once per video frame:

* **scroll** -- the whole song on one line, every bar the same width so that
  four bars fill the frame; the notation slides under a playhead fixed at a
  quarter of the width.
* **flip** -- four bars to a row; the frame shows row ``(bar - 1) // 4`` and
  the playhead moves across it.

Time becomes a chart tick through the session's :class:`cover.Clock`, and a
tick becomes an x position by interpolating between the beats alphaTab placed
(``onNotesX``: where the cursor sits when the beat is played). Before bar 1 and
after the last bar the playhead holds.
"""

from __future__ import annotations

import contextlib
import json
import shutil
import subprocess
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from pipeline import cover
from pipeline.proc import StageError

APP_DIR = Path(__file__).resolve().parent.parent / "app"
VITE_URL = "http://localhost:5173/"

LAYOUTS = ("scroll", "flip")

# alphaTab's display scale per output width: what makes four bars fill the
# width with notation that needs no resampling and still reads at a glance.
# 1920 wide: 480 px a bar; 1080 wide (9:16): 270 px a bar.
DEFAULT_SCALE = {1920: 1.8, 1080: 1.3}

PLAYHEAD_RGB = (230, 30, 40)
PLAYHEAD_PX = 4
BORDER_RGB = (60, 60, 60)
BORDER_PX = 2
PLAYHEAD_AT = 0.25  # scroll: where the fixed playhead stands, as a fraction of the width


def default_scale(width: int) -> float:
    return DEFAULT_SCALE.get(width, round(1.8 * width / 1920, 2))


# --- rendering (browser) -------------------------------------------------------


def _vite_up(timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(VITE_URL + "cover-tab.html", timeout=timeout) as r:
            return r.status == 200
    except OSError:
        return False


def _kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if shutil.which("taskkill"):
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        proc.terminate()
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=10)


@contextlib.contextmanager
def vite_server(start_timeout: float = 60.0):
    """Vite on :5173 for the duration: the one already running, or one started
    here and stopped afterwards. Warmed with one request, since vite pre-bundles
    on the first load and reloads the page mid-render otherwise."""
    if _vite_up():
        yield
        return
    npx = shutil.which("npx")
    if not npx:
        raise StageError("npx not found; install Node to render the tab strip")
    proc = subprocess.Popen(
        [npx, "vite", "--port", "5173", "--strictPort"],
        cwd=APP_DIR,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + start_timeout
        while not _vite_up():
            if proc.poll() is not None:
                raise StageError("vite exited before serving (is port 5173 taken?)")
            if time.monotonic() > deadline:
                raise StageError("vite did not come up on :5173")
            time.sleep(0.5)
        # The module graph, so the real render does not trigger the pre-bundle.
        with contextlib.suppress(OSError):
            urllib.request.urlopen(VITE_URL + "src/cover-tab.ts", timeout=60).read()
        yield
    finally:
        _kill_tree(proc)


def assets_dir(session: cover.Session, layout: str, width: int) -> Path:
    return session.work / "tab" / f"{layout}-{width}"


def render_assets(
    session: cover.Session,
    layout: str,
    scale: float | None = None,
    width: int = 1920,
    bars_per_row: int = 4,
) -> Path:
    """Engrave the song's tab for one layout and output width.

    Writes ``strip.png`` (the whole engraving) and ``tab.json`` (beats, bars,
    rows) into ``work/tab/<layout>-<width>/`` and returns that folder.
    """
    if layout not in LAYOUTS:
        raise StageError(f"layout must be one of {LAYOUTS}, not {layout!r}")
    scale = default_scale(width) if scale is None else scale
    out = assets_dir(session, layout, width)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("tile-*.png"):
        old.unlink()
    node = shutil.which("node")
    if not node:
        raise StageError("node not found; install Node to render the tab strip")
    cmd = [
        node, "scripts/render-tab.mjs",
        "--song", session.song.slug,
        "--layout", layout,
        "--scale", str(scale),
        "--width", str(width),
        "--bars-per-row", str(bars_per_row),
        "--out", str(out),
    ]  # fmt: skip
    with vite_server():
        run = subprocess.run(cmd, cwd=APP_DIR, capture_output=True, text=True)
    if run.returncode != 0:
        raise StageError(f"render-tab failed:\n{run.stderr or run.stdout}")
    _stitch(out)
    return out


def _stitch(out: Path) -> None:
    """Glue render-tab's slices into one ``strip.png``."""
    meta = json.loads((out / "tab.json").read_text(encoding="utf-8"))
    tiles = meta["tiles"]
    full = Image.new("RGB", (int(meta["width"]), int(meta["height"])), "white")
    for t in tiles:
        with Image.open(out / t["file"]) as im:
            full.paste(im.convert("RGB"), (int(t["x"]), 0))
    full.save(out / "strip.png")
    for t in tiles:
        (out / t["file"]).unlink()


# --- drawing (per frame) -------------------------------------------------------


@dataclass(frozen=True)
class _Row:
    pixels: np.ndarray  # (height, W, 3) uint8, already placed in the strip
    ticks: np.ndarray  # knots: chart ticks...
    xs: np.ndarray  # ...and their x on `pixels`


class Strip:
    """Frames of the tab strip, ``width`` x ``height`` RGB, for any time.

    ``assets_dir`` is what :func:`render_assets` wrote. Everything that can be
    is done here, once; :meth:`frame` slices a prepared array and paints the
    playhead.
    """

    def __init__(self, assets_dir: Path, mode: str, width: int, height: int, clock: cover.Clock):
        if mode not in LAYOUTS:
            raise ValueError(f"mode must be one of {LAYOUTS}, not {mode!r}")
        self.mode = mode
        self.width = width
        self.height = height
        self.clock = clock
        meta = json.loads((Path(assets_dir) / "tab.json").read_text(encoding="utf-8"))
        with Image.open(Path(assets_dir) / "strip.png") as im:
            image = im.convert("RGB")
        self.bars_per_row = int(meta.get("barsPerRow", 4))

        bars = sorted(meta["bars"], key=lambda b: b["index"])
        self.bar_ticks = np.array([b["tick"] for b in bars], dtype=np.float64)
        self.end_tick = float(bars[-1]["tick"] + bars[-1]["duration"])

        # One vertical window for every row, lined up on the staff's top line,
        # so the staff does not jump when the row flips.
        rows = meta["rows"]
        staff_top = {}
        for b in bars:
            staff_top.setdefault(b["row"], b["box"]["y"])
        above = max(staff_top[i] - r["y"] for i, r in enumerate(rows))
        below = max(r["y"] + r["h"] - staff_top[i] for i, r in enumerate(rows))
        crop_h = above + below
        room = height - BORDER_PX
        s = min(1.0, room / crop_h)
        # A flip row is engraved at the frame's width; the pixel alphaTab's
        # rounding adds is cropped, not resampled for.
        if mode == "flip" and image.width > width + 2:
            s = min(s, width / image.width)
        self.scale = s

        beats = meta["beats"]
        self._rows: list[_Row] = []
        if mode == "scroll":
            top = staff_top[0] - above
            pixels = self._place(image, top, crop_h, s, pad_x=width)
            ticks, xs = self._knots(beats, bars, row=None)
            self._rows.append(_Row(pixels, ticks, (xs * s) + width))
        else:
            for i in range(len(rows)):
                top = staff_top[i] - above
                pixels = self._place(image, top, crop_h, s, pad_x=0)
                pixels = self._fit_width(pixels)
                ticks, xs = self._knots(beats, bars, row=i)
                self._rows.append(_Row(pixels, ticks, xs * s))

    # -- preparation

    def _place(self, image: Image.Image, top: float, crop_h: float, s: float, pad_x: int) -> np.ndarray:
        """The band [top, top+crop_h) of the engraving, scaled by ``s``, centred
        vertically under the border, with ``pad_x`` white columns either side."""
        box = (0, int(round(top)), image.width, int(round(top + crop_h)))
        band = image.crop(box)  # out-of-range rows come back black; repaint them
        arr = np.asarray(band).copy()
        lo, hi = max(0, -box[1]), max(0, box[3] - image.height)
        if lo:
            arr[:lo] = 255
        if hi:
            arr[arr.shape[0] - hi :] = 255
        band = Image.fromarray(arr)
        if s != 1.0:
            band = band.resize(
                (max(1, round(band.width * s)), max(1, round(band.height * s))), Image.LANCZOS
            )
        out = np.full((self.height, band.width + 2 * pad_x, 3), 255, dtype=np.uint8)
        room = self.height - BORDER_PX
        y0 = BORDER_PX + max(0, (room - band.height) // 2)
        h = min(band.height, self.height - y0)
        out[y0 : y0 + h, pad_x : pad_x + band.width] = np.asarray(band)[:h]
        return out

    def _fit_width(self, pixels: np.ndarray) -> np.ndarray:
        w = pixels.shape[1]
        if w >= self.width:
            return pixels[:, : self.width]
        out = np.full((self.height, self.width, 3), 255, dtype=np.uint8)
        out[:, :w] = pixels
        return out

    def _knots(self, beats: list[dict], bars: list[dict], row: int | None) -> tuple[np.ndarray, np.ndarray]:
        """(tick, x) through every beat of the row (or the song), plus the end
        of its last bar at the barline -- so the playhead reaches the end of
        the row exactly as the next row's first bar starts."""
        chosen = [b for b in beats if row is None or b["row"] == row]
        by_tick: dict[float, list[float]] = {}
        for b in chosen:
            by_tick.setdefault(float(b["tick"]), []).append(float(b["x"]))
        ticks = sorted(by_tick)
        xs = [float(np.mean(by_tick[t])) for t in ticks]
        row_bars = [b for b in bars if row is None or b["row"] == row]
        last = row_bars[-1]
        ticks.append(float(last["tick"] + last["duration"]))
        xs.append(float(last["box"]["x"] + last["box"]["w"]))
        return np.asarray(ticks), np.maximum.accumulate(np.asarray(xs))

    # -- per frame

    def bar_at(self, tick: float) -> int:
        """1-based bar holding ``tick``, clamped to the chart."""
        i = int(np.searchsorted(self.bar_ticks, tick, side="right")) - 1
        return int(np.clip(i, 0, self.bar_ticks.size - 1)) + 1

    def row_at(self, tick: float) -> int:
        if self.mode == "scroll":
            return 0
        return min((self.bar_at(tick) - 1) // self.bars_per_row, len(self._rows) - 1)

    def x_at(self, tick: float) -> float:
        """The playhead's x on its row's prepared pixels (held at either end)."""
        row = self._rows[self.row_at(tick)]
        return float(np.interp(tick, row.ticks, row.xs))

    def playhead_x(self, seconds: float) -> int:
        """Where the playhead is drawn in the output frame, in px."""
        x = self.x_at(float(self.clock.tick_at(seconds)))
        if self.mode == "scroll":
            return int(round(x)) - self._scroll_left(x)
        return int(round(x))

    def _scroll_left(self, x: float) -> int:
        """Scroll: the slice's left edge, holding the playhead at its quarter
        mark except where the notation runs out at either end."""
        left = int(round(x)) - int(round(PLAYHEAD_AT * self.width))
        return max(0, min(left, self._rows[0].pixels.shape[1] - self.width))

    def frame(self, seconds: float) -> Image.Image:
        tick = float(self.clock.tick_at(seconds))
        row = self._rows[self.row_at(tick)]
        x = float(np.interp(tick, row.ticks, row.xs))
        if self.mode == "scroll":
            left = self._scroll_left(x)
            out = row.pixels[:, left : left + self.width].copy()
            # At either end the notation stops sliding and the playhead walks
            # off its quarter mark instead, so it stays on the note.
            head = int(round(x)) - left
        else:
            head = int(round(x))
            out = row.pixels.copy()
        a = max(0, head - PLAYHEAD_PX // 2)
        out[BORDER_PX:, a : a + PLAYHEAD_PX] = PLAYHEAD_RGB
        out[:BORDER_PX] = BORDER_RGB
        return Image.fromarray(out, "RGB")
