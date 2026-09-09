"""Beat-phase quantization, on synthetic onsets over synthetic grids.

The claim this file exists to check is the one the whole architecture rests on:
snapping by *beat phase* is immune to tempo drift, where snapping against a
global BPM is not. So the drifting-grid test isn't an edge case here, it's the
point -- at 160 BPM a 0.3% tempo error is half a beat by the end of a song, and
every note in the back half lands on the wrong sixteenth.
"""

from __future__ import annotations

import numpy as np
import pytest

from pipeline.backends.base import OnsetEvent
from pipeline.grid import Grid, GridScore
from pipeline.quantize import quantize


def make_grid(beats: np.ndarray, *, bar_one: int = 0, bpm: float = 120.0) -> Grid:
    return Grid(
        beats=beats,
        beats_per_bar=4,
        downbeat_offset=0,
        bar_one_beat=bar_one,
        bar_count=(beats.size - bar_one) // 4,
        score=GridScore(bpm, 0, 0.5, [0.5, 0.0, 0.0, 0.0], 0.5, 1.0, True),
        source={"beat_unit": 4},
    )


def steady(bpm: float = 120.0, count: int = 33) -> np.ndarray:
    return np.arange(count) * (60.0 / bpm)


def hits(times, instrument: str = "snare", velocity: float = 0.8):
    return [OnsetEvent(t=float(t), instrument=instrument, velocity=velocity, confidence=1.0) for t in times]


def slots_of(score, bar: int, instrument: str | None = None) -> list[int]:
    return [
        hit.slot
        for hit in score.bars[bar - 1].hits
        if instrument is None or hit.instrument == instrument
    ]


def test_hits_on_the_beat_land_on_slot_zero_of_each_beat():
    grid = make_grid(steady())
    score = quantize(grid, hits(grid.beats[:4]))
    assert slots_of(score, 1) == [0, 4, 8, 12]


def test_sixteenths_land_on_consecutive_slots():
    grid = make_grid(steady())
    step = 0.5 / 4  # a sixteenth at 120 BPM
    score = quantize(grid, hits(np.arange(16) * step))
    assert slots_of(score, 1) == list(range(16))


def test_a_hit_played_slightly_early_still_lands_on_its_slot():
    """Drummers push. 20 ms early at 120 BPM is a fifth of a sixteenth."""
    grid = make_grid(steady())
    score = quantize(grid, hits([1.0 - 0.020]))
    assert slots_of(score, 1) == [8]


def test_a_hit_just_before_the_next_bar_carries_into_it():
    """Rounding up past the end of a bar must move the hit, never drop it."""
    grid = make_grid(steady())
    bar_two_start = float(grid.beats[4])
    score = quantize(grid, hits([bar_two_start - 0.01]))
    assert slots_of(score, 1) == []
    assert slots_of(score, 2) == [0]


def test_quantization_does_not_drift_when_the_tempo_does():
    """The load-bearing property: a grid that speeds up all song still snaps clean.

    The beats accelerate by 0.3% per beat -- far more than a real drummer -- and
    every offbeat eighth is placed at the true midpoint between two beats. Every
    one must land on slot 2 of its beat, right to the end of the song. A global
    BPM would have walked off by more than a sixteenth long before then.
    """
    intervals = 0.5 * (0.997 ** np.arange(200))
    beats = np.concatenate([[0.0], np.cumsum(intervals)])
    grid = make_grid(beats)

    offbeats = beats[:-1] + np.diff(beats) / 2
    score = quantize(grid, hits(offbeats))

    placed = [hit.slot for bar in score.bars for hit in bar.hits]
    assert len(placed) == grid.bar_count * 4
    assert set(placed) == {2, 6, 10, 14}


def test_two_hits_in_one_slot_become_one_note():
    """A flam is two onsets 30 ms apart. It is one notehead, not two."""
    grid = make_grid(steady())
    score = quantize(grid, hits([1.0, 1.03]))
    assert slots_of(score, 1) == [8]
    assert score.stats["merged_duplicates"] == 1


def test_the_louder_of_two_merged_hits_wins():
    grid = make_grid(steady())
    events = [
        OnsetEvent(t=1.00, instrument="snare", velocity=0.2, confidence=1.0),
        OnsetEvent(t=1.03, instrument="snare", velocity=0.9, confidence=1.0),
    ]
    score = quantize(grid, events)
    assert score.bars[0].hits[0].velocity == pytest.approx(0.9)


def test_different_drums_share_a_slot():
    """Dedup is per instrument -- a kick and a snare on beat 1 is a chord."""
    grid = make_grid(steady())
    score = quantize(grid, hits([0.0], "kick") + hits([0.0], "snare"))
    assert sorted(h.instrument for h in score.bars[0].hits) == ["kick", "snare"]
    assert score.stats["merged_duplicates"] == 0


def test_the_count_in_is_dropped_not_renumbered():
    """Bar 1 is pinned in grid.lock.json; hits before it are the count-off."""
    grid = make_grid(steady(), bar_one=4)
    score = quantize(grid, hits([0.0, 0.5, 1.0, 1.5]) + hits([2.0]))
    assert score.stats["before_bar_one"] == 4
    assert slots_of(score, 1) == [0]


def test_hits_past_the_last_complete_bar_are_dropped():
    """The grid ends where the last *complete* bar does; a trailing crash is out."""
    beats = steady(count=9)  # two complete bars, then one stray beat
    grid = make_grid(beats)
    score = quantize(grid, hits([float(beats[-1])]))
    assert grid.bar_count == 2
    assert score.stats["after_last_bar"] == 1


def test_no_onsets_still_produces_every_bar():
    """A score with nothing in it must still have its bars -- rests are notation."""
    grid = make_grid(steady())
    score = quantize(grid, [])
    assert len(score.bars) == grid.bar_count
    assert score.note_count == 0
    assert score.stats["empty_bars"] == grid.bar_count


def test_snap_error_is_reported_in_milliseconds():
    """The statistic that says whether the grid, or the drummer, is off."""
    grid = make_grid(steady(), bpm=120.0)
    score = quantize(grid, hits([1.0 - 0.020, 2.0 - 0.020, 3.0 - 0.020]))
    error = score.stats["snap_error_ms"]
    assert error["median"] == pytest.approx(20.0, abs=1.0)
    # Played early, so the correction is positive: the slot is after the hit.
    assert error["signed_mean"] == pytest.approx(20.0, abs=1.0)
