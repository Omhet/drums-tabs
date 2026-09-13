"""Placing a written note in the mix.

``pipeline.reference.slot_to_seconds`` is the twin of ``slotToMixMs`` in
``app/src/chart.ts``. They have to agree: the player marks a take against one of
them and ``drums reference`` measures the record against the other, so a
disagreement would show up as a timing fault belonging to nobody.
"""

from __future__ import annotations

import numpy as np

from pipeline.grid import Grid, GridScore
from pipeline.reference import slot_to_seconds


def make_grid(beats: np.ndarray, *, bar_one: int = 0) -> Grid:
    return Grid(
        beats=beats,
        beats_per_bar=4,
        downbeat_offset=0,
        bar_one_beat=bar_one,
        bar_count=(beats.size - bar_one) // 4,
        score=GridScore(120.0, 0, 0.5, [0.5, 0, 0, 0], 0.5, 1.0, True),
    )


#: Half-second beats make every expected answer obvious by eye.
STEADY = np.arange(0, 8, 0.5)


def test_slot_zero_is_the_first_beat_of_bar_one():
    grid = make_grid(STEADY, bar_one=2)
    assert slot_to_seconds(grid, 0) == 1.0


def test_a_whole_beat_is_four_slots():
    grid = make_grid(STEADY)
    assert slot_to_seconds(grid, 4) == 0.5
    assert slot_to_seconds(grid, 8) == 1.0


def test_a_slot_between_beats_is_placed_proportionally():
    grid = make_grid(STEADY)
    # Two slots is half a beat, so half way between beat 0 and beat 1.
    assert slot_to_seconds(grid, 2) == 0.25
    assert slot_to_seconds(grid, 1) == 0.125


def test_an_uneven_beat_stretches_the_slots_inside_it():
    # The drummer slowed down: the second beat is twice as long as the first.
    beats = np.array([0.0, 0.5, 1.5, 2.0])
    grid = make_grid(beats)
    assert slot_to_seconds(grid, 4) == 0.5
    # Half way through the long beat is 0.5 s into it, not 0.25.
    assert slot_to_seconds(grid, 6) == 1.0


def test_past_the_beat_map_it_carries_on_at_the_last_tempo():
    beats = np.array([0.0, 0.5, 1.0])
    grid = make_grid(beats)
    # Slot 8 is the last measured beat; beyond it the last interval continues
    # rather than the note being dropped.
    assert slot_to_seconds(grid, 8) == 1.0
    assert slot_to_seconds(grid, 12) == 1.5
    assert slot_to_seconds(grid, 14) == 1.75


def test_before_bar_one_there_is_nothing_to_place_against():
    grid = make_grid(STEADY, bar_one=0)
    assert slot_to_seconds(grid, -4) is None


def test_a_beat_map_too_short_to_interpolate_places_nothing():
    grid = make_grid(np.array([1.0]))
    assert slot_to_seconds(grid, 0) is None
