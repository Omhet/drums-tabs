"""Placing a written note in the mix.

``pipeline.reference.slot_to_seconds`` is the twin of ``slotToMixMs`` in
``app/src/chart.ts``. They have to agree: the player marks a take against one of
them and ``drums reference`` measures the record against the other, so a
disagreement would show up as a timing fault belonging to nobody.
"""

from __future__ import annotations

import numpy as np

from pipeline.grid import Grid, GridScore
from pipeline.paths import Song
from pipeline.reference import Offsets, load, path_for, save, slot_to_seconds, summarise


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


# --- the lock file ----------------------------------------------------------------
# `drums reference` used to print and stop. The player now subtracts the number,
# so it has to survive as a file -- and be readable back exactly, because every
# take's timing is reported against it.


def make_song(tmp_path) -> Song:
    root = tmp_path / "a-song"
    root.mkdir()
    return Song(slug="a-song", root=root)


def offsets(instrument: str, values: list[float], written: int) -> Offsets:
    return Offsets(instrument=instrument, values=np.asarray(values), written=written)


def test_the_floor_is_pooled_over_every_matched_note():
    # Not the mean of the two instrument means: a kick with twice the notes
    # should pull the floor twice as hard.
    body = summarise([offsets("kick", [10.0, 10.0], 2), offsets("snare", [-2.0], 1)], "sha256:c")
    assert body["matched"] == 3
    assert body["written"] == 3
    assert body["mean_ms"] == 6.0
    assert body["median_ms"] == 10.0


def test_the_split_behind_the_floor_is_kept():
    body = summarise([offsets("kick", [10.0, 12.0], 3), offsets("snare", [-2.0], 1)], "sha256:c")
    kick = next(i for i in body["instruments"] if i["instrument"] == "kick")
    assert kick["matched"] == 2, "two of the three written kicks found an onset"
    assert kick["written"] == 3
    assert kick["mean_ms"] == 11.0


def test_nothing_measurable_is_a_floor_of_zero_not_a_nan():
    # An empty mean is NaN, and a NaN subtracted from every take's timing would
    # quietly destroy it rather than failing loudly.
    body = summarise([offsets("kick", [], 4)], "sha256:c")
    assert body["mean_ms"] == 0.0
    assert body["median_ms"] == 0.0
    assert body["matched"] == 0
    assert body["written"] == 4


def test_it_survives_a_round_trip(tmp_path):
    song = make_song(tmp_path)
    written = save(song, [offsets("snare", [3.0, 5.0], 2)], "sha256:chart")
    assert load(song) == written


def test_the_chart_it_was_measured_against_is_on_it(tmp_path):
    # Staleness is checked on this: move a note in Live and the floor moved too.
    song = make_song(tmp_path)
    save(song, [offsets("snare", [3.0], 1)], "sha256:chart")
    assert load(song)["chart"] == "sha256:chart"


def test_no_lock_reads_as_nothing_rather_than_failing(tmp_path):
    assert load(make_song(tmp_path)) is None


def test_a_lock_from_a_version_we_cannot_read_is_ignored(tmp_path):
    song = make_song(tmp_path)
    save(song, [offsets("snare", [3.0], 1)], "sha256:chart")
    path = path_for(song)
    path.write_text(path.read_text(encoding="utf-8").replace('"version": 1', '"version": 99'))
    assert load(song) is None


def test_a_corrupt_lock_is_ignored_rather_than_crashing_the_pipeline(tmp_path):
    song = make_song(tmp_path)
    path_for(song).write_text("{not json", encoding="utf-8")
    assert load(song) is None
