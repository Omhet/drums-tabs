"""The cover's backing audio: the click tracks and the pitch-kept stretch.

The clicks are what you play to, so a count-in a beat short or an accent on
the wrong beat is a ruined take. The stretch is what the straight timing's grid
is built on: if it walks off 130 the tab and the audio disagree.
"""

from __future__ import annotations

import shutil
import subprocess

import numpy as np
import pytest
import soundfile as sf

from pipeline import cover, cover_audio
from pipeline.proc import StageError

SR = cover_audio.SR


# --- clicks ------------------------------------------------------------------


def _click_starts(track: np.ndarray) -> np.ndarray:
    """Sample index where each click begins (silence between them)."""
    loud = np.flatnonzero(np.abs(track) > 1e-4)
    return loud[np.concatenate([[True], np.diff(loud) > int(0.01 * SR)])]


def test_straight_click_is_steady_from_zero_with_downbeats_accented():
    period = 60.0 / cover.LIVE_TEMPO
    times, accents = cover_audio.straight_clicks(10 * period + 0.01)
    assert times.size == 11
    np.testing.assert_allclose(np.diff(times), period)
    assert times[0] == 0.0
    assert accents.tolist() == [True, False, False, False] * 2 + [True, False, False]


@pytest.mark.parametrize("count_in", [1, 2])
def test_straight_click_counts_in_whole_bars_and_the_stems_start_on_the_next_downbeat(tmp_path, count_in):
    from pipeline import paths

    song = paths.Song("x", tmp_path / "x")
    period = 60.0 / cover.LIVE_TEMPO
    start = cover.stem_start_for(song, cover.Timing.straight, count_in)  # needs no files for straight
    assert start == count_in * cover.BEATS_PER_BAR
    times, accents = cover_audio.straight_clicks(20 * period)
    lead = count_in * cover.BEATS_PER_BAR
    assert times[lead] == pytest.approx(start * period)
    assert accents[lead] and accents[0]


@pytest.mark.parametrize("count_in", [1, 2])
def test_original_click_follows_the_beats_with_count_in_and_tail(count_in):
    beats = 4.0 + np.array([0.0, 0.46, 0.93, 1.40, 1.86, 2.33, 2.80, 3.27, 3.75])
    times, accents = cover_audio.original_clicks(beats, count_in)
    lead = 4 * count_in
    head, tail = beats[1] - beats[0], beats[-1] - beats[-2]
    np.testing.assert_allclose(times[:lead], beats[0] - head * np.arange(lead, 0, -1))
    np.testing.assert_allclose(times[lead : lead + beats.size], beats)
    np.testing.assert_allclose(times[lead + beats.size :], beats[-1] + tail * np.arange(1, 9))
    assert times.size == lead + beats.size + 8
    # Count-in downbeats, bar 1 downbeat, and every fourth beat after.
    assert np.flatnonzero(accents).tolist() == list(range(0, times.size, 4))
    assert accents[lead]


def test_original_click_refuses_a_count_in_before_zero():
    with pytest.raises(StageError, match="count-in"):
        cover_audio.original_clicks(np.array([1.0, 1.5, 2.0]), 1)
    with pytest.raises(StageError, match="8-beat count-in"):
        cover_audio.original_clicks(np.array([3.0, 3.5, 4.0]), 2)


@pytest.mark.parametrize("count_in", [1, 2])
def test_an_original_click_file_lands_on_the_sessions_clock(tmp_path, count_in):
    """Song 2's shape: bar 1 2.02 s into the stems, 0.46 s a beat -- one bar of
    count-in fits before it, two do not, so the stems move a Live bar later."""
    import json

    from pipeline import paths

    song = paths.Song("x", tmp_path / "x")
    song.ensure_dirs()
    beats = 2.02 + 0.4615 * np.arange(16)
    song.grid_lock.write_text(json.dumps({"beats": beats.tolist(), "bar_one_beat": 0}), encoding="utf-8")
    sf.write(str(song.nodrums), np.zeros((int(10 * SR), 2), np.float32), SR)
    start = cover.stem_start_for(song, cover.Timing.original, count_in)
    assert start == {1: 0.0, 2: 4.0}[count_in]
    path = cover_audio.build_click(song, cover.Timing.original, count_in)
    assert path.name == f"click-original-{count_in}bar.wav"
    track, sr = sf.read(str(path), dtype="float32")
    starts = _click_starts(track[:, 0]) / sr
    clock = cover.clock_for(song, cover.Timing.original, start)
    lead = 4 * count_in
    np.testing.assert_allclose(starts[lead : lead + 16], clock.beats, atol=1.5 / sr)
    assert starts[0] >= 0 and starts[lead] == pytest.approx(clock.bar_start(1), abs=1.5 / sr)


def test_rendered_click_lands_on_its_samples_accented_at_a_healthy_level():
    times = np.array([0.0, 0.5, 1.0, 1.5, 2.0])
    accents = np.array([True, False, False, False, True])
    track = cover_audio.render_clicks(times, accents, int(2.5 * SR))
    # A sine click starts at zero, so its first audible sample is the next one.
    np.testing.assert_allclose(_click_starts(track), np.round(times * SR), atol=1)
    assert np.max(np.abs(track)) == pytest.approx(cover_audio.CLICK_PEAK, abs=1e-6)
    window = int(0.03 * SR)
    peaks = [np.max(np.abs(track[int(t * SR) : int(t * SR) + window])) for t in times]
    assert peaks[0] > peaks[1] * 1.5 and peaks[4] > peaks[3] * 1.5


# --- stretch -----------------------------------------------------------------


def _has_rubberband() -> bool:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    out = subprocess.run([ffmpeg, "-hide_banner", "-filters"], capture_output=True, text=True, check=False)
    return " rubberband " in out.stdout


needs_rubberband = pytest.mark.skipif(not _has_rubberband(), reason="ffmpeg without the rubberband filter")

TONE_HZ = 440.0
STEADY = 60.0 / 130.0


def _uneven_take(tmp_path):
    """A noise-burst hit on each of 24 beats drifting +-1.5% around 130, over a held A."""
    rng = np.random.default_rng(7)
    ratio = 1.0 + 0.015 * np.sin(np.arange(24) / 3.0)
    original = 1.3 + np.concatenate([[0.0], np.cumsum(STEADY * ratio)])
    y = 0.08 * np.sin(2 * np.pi * TONE_HZ * np.arange(int((original[-1] + 1.0) * SR)) / SR)
    burst = np.arange(int(0.02 * SR))
    for b in original:
        s = int(round(b * SR))
        y[s : s + burst.size] += 0.6 * np.exp(-burst / SR * 200) * rng.standard_normal(burst.size)
    source = tmp_path / "take.wav"
    sf.write(str(source), np.stack([y, y], axis=1), SR, subtype="PCM_16")
    return source, np.arange(original.size) * STEADY, original


def _attack(y: np.ndarray, near: float) -> float:
    """Where the burst near ``near`` first reaches half its peak.

    Half, not a fixed level just over the tone: a phase vocoder smears a little
    of every attack a few ms ahead of it (pre-echo), and a low threshold times
    the smear instead of the hit.
    """
    lo = int((near - 0.015) * SR)
    w = np.abs(y[lo : lo + int(0.04 * SR)])
    return (lo + int(np.argmax(w > 0.5 * w.max()))) / SR


@needs_rubberband
def test_stretch_puts_uneven_hits_on_the_steady_grid_and_keeps_pitch(tmp_path):
    source, straight, original = _uneven_take(tmp_path)
    dest = cover_audio.stretch(source, tmp_path / "out.wav", straight, original)
    info = sf.info(str(dest))
    assert (info.samplerate, info.channels, info.subtype) == (SR, 2, "PCM_16")

    z = sf.read(str(dest), always_2d=True)[0].mean(axis=1)
    err = np.array([_attack(z, g) - g for g in straight[1:]])
    assert np.max(np.abs(err)) < 0.003, np.round(err * 1000, 2)

    # Between hits it is the tone alone: still an A.
    seg = z[int((straight[5] + 0.15) * SR) : int((straight[5] + 0.45) * SR)]
    spectrum = np.abs(np.fft.rfft(seg * np.hanning(seg.size), n=1 << 17))
    peak = np.fft.rfftfreq(1 << 17, 1 / SR)[np.argmax(spectrum)]
    assert peak == pytest.approx(TONE_HZ, abs=2.0)

    accuracy = cover_audio.measure(source, dest, straight, original)
    assert accuracy.drift_ms < 3.0 and accuracy.p95_ms < 3.0
