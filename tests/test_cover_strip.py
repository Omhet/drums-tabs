"""The tab strip: time -> x, the flip row, and the frames, on a made-up engraving."""

import json

import numpy as np
import pytest
from PIL import Image

from pipeline import cover
from pipeline.cover_strip import BORDER_PX, PLAYHEAD_AT, PLAYHEAD_RGB, Strip

TPB = cover.TICKS_PER_BEAT
BAR = 4 * TPB
BAR_PX = 100  # every bar 100 px wide
PAD = 10  # first beat sits this far into its bar; then one beat every 20 px
STAFF_Y = 40


def fake_assets(tmp_path, n_bars, per_row):
    """An engraving of ``n_bars`` bars, ``per_row`` to a row (all on one row
    when ``per_row`` is None), with a quarter-note beat on every beat."""
    rows, bars, beats = [], [], []
    row_h = 100
    for i in range(n_bars):
        row = 0 if per_row is None else i // per_row
        col = i if per_row is None else i % per_row
        if row == len(rows):
            n = n_bars if per_row is None else per_row
            rows.append({"x": 0, "y": row * row_h, "w": n * BAR_PX, "h": row_h})
        x0 = col * BAR_PX
        bars.append({
            "index": i, "tick": i * BAR, "duration": BAR, "row": row,
            "box": {"x": x0, "y": row * row_h + STAFF_Y, "w": BAR_PX, "h": 20},
        })  # fmt: skip
        for q in range(4):
            for voice in (0, 1):
                beats.append({"tick": i * BAR + q * TPB, "bar": i, "x": x0 + PAD + q * 20, "voice": voice, "row": row})
    width = max(r["w"] for r in rows)
    height = len(rows) * row_h
    meta = {"barsPerRow": per_row or 4, "width": width, "height": height, "rows": rows, "bars": bars, "beats": beats}
    (tmp_path / "tab.json").write_text(json.dumps(meta), encoding="utf-8")
    img = np.full((height, width, 3), 255, dtype=np.uint8)
    for b in bars:  # a black barline at the left of every bar
        img[b["box"]["y"] : b["box"]["y"] + 20, b["box"]["x"]] = 0
    Image.fromarray(img).save(tmp_path / "strip.png")
    return tmp_path


# 120 BPM, bar 1 at 1.0 s: a beat every 0.5 s, a bar every 2 s.
CLOCK = cover.Clock(1.0 + 0.5 * np.arange(8 * 4))


def bar_x(bar, beat=0):
    """x of a beat on an unscaled single-line engraving."""
    return (bar - 1) * BAR_PX + PAD + beat * 20


def test_scroll_time_to_x_at_bars_and_between(tmp_path):
    strip = Strip(fake_assets(tmp_path, 8, None), "scroll", 400, 120, CLOCK)
    assert strip.scale == 1.0
    off = 400  # the white margin either side of the line
    for bar in (1, 2, 5, 8):
        tick = (bar - 1) * BAR
        assert strip.x_at(tick) == pytest.approx(off + bar_x(bar))
        assert strip.x_at(float(CLOCK.tick_at(CLOCK.bar_start(bar)))) == pytest.approx(off + bar_x(bar))
    # Half way between beat 1 and 2 of bar 3.
    assert strip.x_at(2 * BAR + TPB / 2) == pytest.approx(off + bar_x(3) + 10)
    # Beat 4 of bar 2 to the downbeat of bar 3: straight across the barline.
    assert strip.x_at(BAR + 3.5 * TPB) == pytest.approx(off + (bar_x(2, 3) + bar_x(3)) / 2)
    # Held before bar 1 and after the end (the last barline).
    assert strip.x_at(-5 * TPB) == pytest.approx(off + bar_x(1))
    assert strip.x_at(100 * BAR) == pytest.approx(off + 8 * BAR_PX)


@pytest.mark.parametrize(("bar", "row"), [(1, 0), (4, 0), (5, 1), (64, 15), (65, 16)])
def test_flip_row_at_bar_boundaries(tmp_path, bar, row):
    clock = cover.Clock(1.0 + 0.5 * np.arange(65 * 4))
    strip = Strip(fake_assets(tmp_path, 65, 4), "flip", 400, 120, clock)
    start = clock.bar_start(bar)
    assert strip.row_at(float(clock.tick_at(start))) == row
    assert strip.row_at(float(clock.tick_at(start + 1.9))) == row
    if bar > 1:  # a moment before, it is still the previous bar's row
        assert strip.row_at(float(clock.tick_at(start - 0.01))) == (bar - 2) // 4


def test_flip_playhead_moves_across_the_row(tmp_path):
    strip = Strip(fake_assets(tmp_path, 8, 4), "flip", 400, 120, CLOCK)
    # Bar 5 is the first of row 2: the playhead is back at the left.
    assert strip.playhead_x(CLOCK.bar_start(5)) == bar_x(1)
    assert strip.playhead_x(CLOCK.bar_start(6)) == bar_x(2)
    # The end of bar 4 reaches the row's right-hand barline.
    assert strip.x_at(4 * BAR - 1) == pytest.approx(4 * BAR_PX, abs=0.1)


@pytest.mark.parametrize("mode", ["scroll", "flip"])
def test_frame_is_rgb_at_size_with_playhead_and_border(tmp_path, mode):
    strip = Strip(fake_assets(tmp_path, 8, 4 if mode == "flip" else None), mode, 400, 120, CLOCK)
    t = CLOCK.bar_start(2) + 0.25
    im = strip.frame(t)
    assert im.mode == "RGB" and im.size == (400, 120)
    a = np.asarray(im)
    head = strip.playhead_x(t)
    if mode == "scroll":
        assert head == int(PLAYHEAD_AT * 400)
    else:
        assert head == round(bar_x(2) + 10)
    assert tuple(a[60, head]) == PLAYHEAD_RGB
    assert tuple(a[60, (head + 50) % 400]) != PLAYHEAD_RGB
    assert (a[:BORDER_PX] < 100).all()


def test_scroll_notation_slides_under_the_playhead(tmp_path):
    strip = Strip(fake_assets(tmp_path, 8, None), "scroll", 400, 120, CLOCK)
    head = int(PLAYHEAD_AT * 400)
    # At bar 3's downbeat its barline sits PAD px left of the playhead...
    a = np.asarray(strip.frame(CLOCK.bar_start(3)))
    col = head - PAD
    assert (a[BORDER_PX:, col] == 0).all(axis=1).any()
    # ...and four bars span the frame: the next barlines are BAR_PX apart.
    dark = [x for x in range(400) if (a[BORDER_PX:, x] == 0).all(axis=1).any()]
    assert np.diff(dark).tolist() == [BAR_PX] * (len(dark) - 1)


def test_tall_engraving_is_scaled_to_fit(tmp_path):
    strip = Strip(fake_assets(tmp_path, 8, None), "scroll", 400, 52, CLOCK)
    assert strip.scale == pytest.approx(0.5)
    assert strip.x_at(0) == pytest.approx(400 + bar_x(1) * 0.5)
    assert strip.frame(3.0).size == (400, 52)
