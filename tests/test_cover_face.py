"""The face emoji: Noto's file names, cleaning a track, the sendcmd file, and upright-to-output pixels."""

from __future__ import annotations

import numpy as np
import pytest

from pipeline import cover_face, cover_render
from pipeline.proc import StageError


@pytest.mark.parametrize(
    "emoji, name",
    [
        ("😎", "emoji_u1f60e"),
        ("❤️", "emoji_u2764"),  # U+FE0F dropped, as Noto names it
        ("#️⃣", "emoji_u0023_20e3"),  # four digits at least
        ("👋🏽", "emoji_u1f44b_1f3fd"),  # a skin tone
        ("👨‍👩‍👧", "emoji_u1f468_200d_1f469_200d_1f467"),  # joined
    ],
)
def test_emoji_name(emoji, name):
    assert cover_face.emoji_name(emoji) == name


def test_emoji_name_of_nothing_is_an_error():
    with pytest.raises(StageError, match="empty"):
        cover_face.emoji_name("️")


def test_emoji_png_uses_the_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(cover_face, "EMOJI_DIR", tmp_path)
    (tmp_path / "emoji_u1f60e.png").write_bytes(cover_face.PNG_MAGIC)
    monkeypatch.setattr(cover_face, "_download", lambda *a, **k: pytest.fail("fetched a cached emoji"))
    assert cover_face.emoji_png("😎") == tmp_path / "emoji_u1f60e.png"


def test_clean_bridges_gaps_drops_a_misdetection_and_holds_the_ends():
    count = 200
    frames = np.arange(0, count, 2)
    x, y = 300 + 2.0 * frames, 500 - 1.0 * frames  # moving steadily
    x[0] = y[0] = np.nan  # missed at the start
    x[10:16] = y[10:16] = np.nan  # six in a row missed
    x[40], y[40] = x[40] + 400, y[40] - 300  # five faces off: someone else's
    cx, cy = cover_face.clean(frames, x, y, size=100.0, count=count)
    n = np.arange(count)
    assert cx.shape == cy.shape == (count,)
    inner = slice(6, count - 1)
    assert np.abs(cx - (300 + 2.0 * n))[inner].max() < 0.5
    assert np.abs(cy - (500 - 1.0 * n))[inner].max() < 0.5
    # the nearest detection stands in before the first and after the last
    assert abs(cx[0] - 304) < 1 and cx[-1] == cx[-2] == pytest.approx(696)


def test_clean_smooths_jitter_but_keeps_up_with_a_fast_move():
    rng = np.random.default_rng(1)
    frames = np.arange(0, 600, 2)
    # a swing of 1.5 faces each way, once a second: 30 px between detections at its fastest
    true = 400 + 150 * np.sin(2 * np.pi * frames / 60)
    noisy = true + rng.normal(0, 4, len(frames))
    cx, _ = cover_face.clean(frames, noisy, np.full_like(noisy, 300.0), size=100.0, count=600)
    err = cx[frames] - true
    assert err.std() < 0.75 * 4  # quieter than what was detected
    assert np.abs(err).max() < 12  # and not lagging the swing


def test_clean_with_nothing_found_is_an_error():
    nothing = np.full(5, np.nan)
    with pytest.raises(StageError, match="not found"):
        cover_face.clean(np.arange(5), nothing, nothing, size=100.0, count=10)


def test_commands_are_due_half_a_frame_early_and_only_on_a_move():
    text = cover_face.commands([10, 10, 12, 12], [5, 5, -7, -7], 60)
    assert text.splitlines() == [
        "0.000000 overlay@face x 10, overlay@face y 5;",
        "0.025000 overlay@face x 12, overlay@face y -7;",  # frame 2 at 2/60 s; due at 1.5/60
    ]


def test_to_output_through_a_crop():
    L = cover_render.LAYOUT
    box = (100, 150, 950, 1320)  # 950 wide fills 1080; 1320 * 1080/950 = 1500.63 tall, a hair cut off
    x, y, s = cover_face.to_output([100, 1050, 575], [150, 1470, 810], box, L)
    assert s == pytest.approx(1080 / 950)
    assert x == pytest.approx([0, 1080, 540])
    assert y == pytest.approx([-0.316, 1500.316, 750], abs=0.001)


def test_main_box_without_a_crop_matches_the_render():
    """The render's default crop of an upright 1080x1920 phone is [0, 105, 1080, 1500]."""
    assert cover_face.main_box(1080, 1920, None, cover_render.LAYOUT) == pytest.approx((0, 105, 1080, 1500))
    assert cover_face.main_box(1080, 1920, (1, 2, 3, 4), cover_render.LAYOUT) == (1, 2, 3, 4)
