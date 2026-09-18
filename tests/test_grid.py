"""Grid repair and beat-phase maths, on synthetic fixtures.

No audio, no GPU, no models -- these run in under a second and are meant to be
run on every change. The grid is the single point of failure for everything
downstream, and the parts of it that are pure arithmetic have no excuse for
being validated only by looking at a PNG.
"""

from __future__ import annotations

import numpy as np
import pytest

from pipeline import grid as grid_mod
from pipeline.grid import DrumSupport, Grid, GridScore
from pipeline.onsets import HOP_LENGTH
from pipeline.proc import StageError

SR = 44100
FRAME = HOP_LENGTH / SR


def steady_beats(bpm: float = 120.0, count: int = 64, start: float = 0.0) -> np.ndarray:
    return start + np.arange(count) * (60.0 / bpm)


def impulse_envelope(times: np.ndarray, hits: np.ndarray, *, width: int = 2) -> np.ndarray:
    """An onset envelope with a unit spike at each hit time."""
    env = np.zeros(times.size, dtype=np.float32)
    for hit in hits:
        centre = int(np.searchsorted(times, hit))
        env[max(0, centre - width) : centre + width + 1] = 1.0
    return env


def synthetic_support(
    beats: np.ndarray, *, kick_on: tuple[int, ...], snare_on: tuple[int, ...],
    beats_per_bar: int = 4, rotation: int = 0,
) -> DrumSupport:
    """A kit that plays kick and snare on the named beats of every bar."""
    times = np.arange(0.0, beats[-1] + 1.0, FRAME)
    position = (np.arange(beats.size) - rotation) % beats_per_bar
    kick_hits = beats[np.isin(position, kick_on)]
    snare_hits = beats[np.isin(position, snare_on)]
    return DrumSupport(
        times=times,
        kick=impulse_envelope(times, kick_hits),
        snare=impulse_envelope(times, snare_hits),
    )


def make_grid(beats: np.ndarray, *, rotation: int = 0, bar_one: int | None = None) -> Grid:
    return Grid(
        beats=beats,
        beats_per_bar=4,
        downbeat_offset=rotation,
        bar_one_beat=rotation if bar_one is None else bar_one,
        bar_count=(beats.size - (rotation if bar_one is None else bar_one)) // 4,
        score=GridScore(120.0, rotation, 0.5, [0.5, 0, 0, 0], 0.5, 1.0, True),
    )


# --------------------------------------------------------------------------
# interval repair
# --------------------------------------------------------------------------


def test_clean_grid_is_left_alone():
    beats = steady_beats()
    repaired, log = grid_mod.repair_intervals(beats)
    assert log["inserted"] == 0 and log["dropped"] == 0
    np.testing.assert_allclose(repaired, beats)


def test_dropped_beat_is_reinserted():
    beats = steady_beats()
    missing = np.delete(beats, 20)
    repaired, log = grid_mod.repair_intervals(missing)
    assert log["inserted"] == 1
    np.testing.assert_allclose(repaired, beats, atol=1e-9)


def test_run_of_dropped_beats_is_reinserted():
    beats = steady_beats()
    missing = np.delete(beats, [20, 21, 22])
    repaired, log = grid_mod.repair_intervals(missing)
    assert log["inserted"] == 3
    np.testing.assert_allclose(repaired, beats, atol=1e-9)


def test_spurious_beat_is_dropped():
    beats = steady_beats()
    doubled = np.insert(beats, 21, beats[20] + 0.06)
    repaired, log = grid_mod.repair_intervals(doubled)
    assert log["dropped"] == 1
    np.testing.assert_allclose(repaired, beats, atol=1e-9)


def test_gradual_tempo_change_is_not_repaired():
    """A song that speeds up is a performance, not a detector error."""
    intervals = np.linspace(0.5, 0.42, 63)  # 120 -> 143 BPM over 64 beats
    beats = np.concatenate([[0.0], np.cumsum(intervals)])
    _, log = grid_mod.repair_intervals(beats)
    assert log["inserted"] == 0 and log["dropped"] == 0


def test_long_gap_is_left_as_a_gap():
    """A breakdown is not twelve dropped beats; inventing beats there is worse than a hole."""
    beats = np.concatenate([steady_beats(count=32), steady_beats(count=32, start=22.0)])
    _, log = grid_mod.repair_intervals(beats)
    assert log["inserted"] == 0
    assert any("gap" in event["action"] for event in log["events"])


def test_too_few_beats_is_an_error():
    with pytest.raises(StageError):
        grid_mod.repair_intervals(np.array([0.0, 0.5, 1.0]))


# --------------------------------------------------------------------------
# beat phase / bar position
# --------------------------------------------------------------------------


def test_beat_position_is_exact_on_beats():
    grid = make_grid(steady_beats())
    positions = grid_mod.beat_position(grid, grid.beats)
    np.testing.assert_allclose(positions, np.arange(grid.beats.size), atol=1e-9)


def test_beat_position_interpolates_within_a_beat():
    grid = make_grid(steady_beats(bpm=120.0))
    midpoint = (grid.beats[4] + grid.beats[5]) / 2
    assert grid_mod.beat_position(grid, np.array([midpoint]))[0] == pytest.approx(4.5)


def test_beat_position_is_immune_to_tempo_drift():
    """The reason quantization snaps by phase rather than against a global BPM.

    Here the tempo ramps by 20% across the song. A global-BPM mapping would be
    most of a beat out by the end; phase interpolation stays exact.
    """
    intervals = np.linspace(0.50, 0.40, 199)
    beats = np.concatenate([[0.0], np.cumsum(intervals)])
    grid = make_grid(beats)
    offbeats = beats[:-1] + np.diff(beats) / 2
    positions = grid_mod.beat_position(grid, offbeats)
    np.testing.assert_allclose(positions, np.arange(beats.size - 1) + 0.5, atol=1e-9)


def test_bar_position_numbers_bars_from_one():
    grid = make_grid(steady_beats(), rotation=0, bar_one=8)
    bar, phase = grid_mod.bar_position(grid, grid.beats[[8, 9, 12, 16]])
    np.testing.assert_array_equal(bar, [1, 1, 2, 3])
    np.testing.assert_allclose(phase, [0.0, 1.0, 0.0, 0.0], atol=1e-9)


def test_count_in_gets_non_positive_bar_numbers():
    """The count-in stays in the audio and is expressed as an offset, never a cut."""
    grid = make_grid(steady_beats(), rotation=0, bar_one=8)
    assert grid.count_in_bars == 2
    bar, _ = grid_mod.bar_position(grid, grid.beats[[0, 4]])
    np.testing.assert_array_equal(bar, [-1, 0])


# --------------------------------------------------------------------------
# downbeat phase and tempo octave
# --------------------------------------------------------------------------


def test_rotation_is_found_from_the_backbeat():
    beats = steady_beats(count=64)
    support = synthetic_support(beats, kick_on=(0, 2), snare_on=(1, 3), rotation=0)
    score = grid_mod.score_beats(beats, support, 4)
    assert score.rotation == 0


@pytest.mark.parametrize("rotation", [1, 2, 3])
def test_rotation_is_found_when_the_grid_starts_mid_bar(rotation):
    # Kick on 1 only. With kick on both 1 and 3 the pattern repeats every two
    # beats, so rotations 0 and 2 are the same audio and no detector could tell
    # them apart -- see test_kick_breaks_the_tie_between_rotations_zero_and_two.
    beats = steady_beats(count=64)
    support = synthetic_support(beats, kick_on=(0,), snare_on=(1, 3), rotation=rotation)
    score = grid_mod.score_beats(beats, support, 4)
    assert score.rotation == rotation


def test_kick_breaks_the_tie_between_rotations_zero_and_two():
    """Snare on 2 and 4 cannot distinguish rotation 0 from 2 -- both agree. Kick can."""
    beats = steady_beats(count=64)
    support = synthetic_support(beats, kick_on=(0,), snare_on=(1, 3), rotation=2)
    score = grid_mod.score_beats(beats, support, 4)
    assert score.rotation == 2
    assert score.rotation_margins[2] > score.rotation_margins[0]


def test_plausible_tempo_keeps_the_detector_rate():
    beats = steady_beats(bpm=132.0, count=64)
    support = synthetic_support(beats, kick_on=(0, 2), snare_on=(1, 3))
    name, chosen, _, log = grid_mod.choose_octave(beats, support, 4)
    assert name == "unit"
    assert "kept detector rate" in log["decision"]
    np.testing.assert_allclose(chosen, beats)


def test_half_tempo_detection_is_doubled():
    """beat_this locking to half tempo: real beats at 140, detected at 70."""
    real = steady_beats(bpm=140.0, count=128)
    support = synthetic_support(real, kick_on=(0, 2), snare_on=(1, 3))
    detected = real[0::2]  # 70 BPM -- below the plausible floor
    name, chosen, score, _ = grid_mod.choose_octave(detected, support, 4)
    assert name == "double"
    assert score.bpm == pytest.approx(140.0, rel=1e-3)
    # Doubling interleaves midpoints, so the last real beat has no successor to
    # bisect and the recovered grid is one beat short of the original.
    np.testing.assert_allclose(chosen, real[:-1], atol=1e-9)


def test_double_tempo_detection_is_halved():
    real = steady_beats(bpm=100.0, count=64)
    support = synthetic_support(real, kick_on=(0, 2), snare_on=(1, 3))
    midpoints = (real[:-1] + real[1:]) / 2
    detected = np.sort(np.concatenate([real, midpoints]))  # 200 BPM
    name, chosen, score, _ = grid_mod.choose_octave(detected, support, 4)
    assert name.startswith("half")
    assert score.bpm == pytest.approx(100.0, rel=1e-3)


def test_forced_multiplier_overrides_the_decision():
    beats = steady_beats(bpm=132.0, count=64)
    support = synthetic_support(beats, kick_on=(0, 2), snare_on=(1, 3))
    name, chosen, _, log = grid_mod.choose_octave(beats, support, 4, forced="double")
    assert name == "double" and log["decision"] == "forced"
    assert chosen.size == beats.size * 2 - 1


def test_unknown_forced_multiplier_is_rejected():
    beats = steady_beats(count=64)
    support = synthetic_support(beats, kick_on=(0,), snare_on=(1, 3))
    with pytest.raises(StageError):
        grid_mod.choose_octave(beats, support, 4, forced="triple")


# --------------------------------------------------------------------------
# rotation choice: detector vs snare
# --------------------------------------------------------------------------


def _score_with(margins: list[float]) -> GridScore:
    best = int(np.argmax(margins))
    return GridScore(120.0, best, margins[best], margins, 0.5, 1.0, True)


def test_confident_detector_rotation_is_kept():
    beats = steady_beats(count=64)
    score = _score_with([0.20, 0.02, 0.24, 0.01])
    rotation, log = grid_mod.choose_rotation(beats, beats[0::4], score, 4)
    assert rotation == 0
    assert "already clear" in log["decision"]


def test_weak_detector_rotation_is_overridden_by_the_snare():
    beats = steady_beats(count=64)
    score = _score_with([0.01, 0.02, 0.30, 0.01])
    rotation, log = grid_mod.choose_rotation(beats, beats[0::4], score, 4)
    assert rotation == 2
    assert "rotated 0 -> 2" in log["decision"]


def test_near_tie_leaves_the_detector_alone():
    beats = steady_beats(count=64)
    score = _score_with([0.030, 0.001, 0.045, 0.001])
    rotation, log = grid_mod.choose_rotation(beats, beats[0::4], score, 4)
    assert rotation == 0
    assert "too close to call" in log["decision"]


def test_forced_rotation_wins():
    beats = steady_beats(count=64)
    score = _score_with([0.30, 0.01, 0.01, 0.01])
    rotation, log = grid_mod.choose_rotation(beats, beats[0::4], score, 4, forced=3)
    assert rotation == 3 and log["decision"] == "forced"


# --------------------------------------------------------------------------
# bar one
# --------------------------------------------------------------------------


def test_bar_one_skips_a_silent_intro():
    beats = steady_beats(count=64)
    times = np.arange(0.0, beats[-1] + 1.0, FRAME)
    playing = beats[16:]  # drums enter at bar 5
    support = DrumSupport(
        times=times,
        kick=impulse_envelope(times, playing[0::2]),
        snare=impulse_envelope(times, playing[1::2]),
    )
    bar_one, log = grid_mod.find_bar_one(beats, 0, support, 4)
    assert bar_one == 16
    assert log["count_in_bars"] == 4


def test_bar_one_ignores_a_hi_hat_count_in():
    """A stick count on the hats is not bar 1; the first kick or snare is."""
    beats = steady_beats(count=64)
    times = np.arange(0.0, beats[-1] + 1.0, FRAME)
    playing = beats[8:]
    support = DrumSupport(
        times=times,
        # Nothing in the kick or snare bands during the first two bars, which is
        # exactly what a hats-only count-in looks like to this stage.
        kick=impulse_envelope(times, playing[0::2]),
        snare=impulse_envelope(times, playing[1::2]),
    )
    bar_one, _ = grid_mod.find_bar_one(beats, 0, support, 4)
    assert bar_one == 8


def test_isolated_noise_does_not_move_bar_one():
    """One stray transient in the intro must not shift every bar number in the score."""
    beats = steady_beats(count=64)
    times = np.arange(0.0, beats[-1] + 1.0, FRAME)
    playing = beats[16:]
    kick = impulse_envelope(times, playing[0::2])
    kick[int(1.3 / FRAME) : int(1.3 / FRAME) + 3] = 1.0  # a lone click at 1.3 s
    support = DrumSupport(
        times=times, kick=kick, snare=impulse_envelope(times, playing[1::2])
    )
    bar_one, _ = grid_mod.find_bar_one(beats, 0, support, 4)
    assert bar_one == 16


# --------------------------------------------------------------------------
# edge trimming
# --------------------------------------------------------------------------


def test_isolated_intro_beats_are_trimmed():
    """Two guesses over a silent intro must not become bars 1 and 2."""
    body = steady_beats(count=60, start=20.0)
    beats = np.concatenate([[0.4, 6.0, 12.0], body])
    trimmed, log = grid_mod.trim_isolated_edges(beats)
    assert log["head"] == 3 and log["tail"] == 0
    np.testing.assert_allclose(trimmed, body)


def test_isolated_outro_beats_are_trimmed():
    beats = np.concatenate([steady_beats(count=60), [40.0, 47.0]])
    trimmed, log = grid_mod.trim_isolated_edges(beats)
    assert log["tail"] == 2 and log["head"] == 0


def test_a_gap_in_the_middle_is_not_trimmed():
    """A breakdown is not an edge; the beats either side of it are real."""
    beats = np.concatenate([steady_beats(count=32), steady_beats(count=32, start=25.0)])
    trimmed, log = grid_mod.trim_isolated_edges(beats)
    assert log == {"head": 0, "tail": 0}
    np.testing.assert_allclose(trimmed, beats)


def test_trimming_never_eats_the_song():
    """A guard against a pathological grid being trimmed down to nothing."""
    beats = np.array([0.0, 3.0, 7.0, 12.0, 18.0, 25.0, 33.0, 42.0, 52.0, 63.0])
    trimmed, _ = grid_mod.trim_isolated_edges(beats)
    assert trimmed.size >= 8


# --------------------------------------------------------------------------
# local double-time
# --------------------------------------------------------------------------


def test_a_double_time_section_is_halved():
    """The detector switching metrical level mid-song, as seen on a real cover."""
    # Proportions taken from the real case: ~a third of the beats, doubled.
    head = steady_beats(bpm=88.0, count=100)
    fast = steady_beats(bpm=176.0, count=110, start=head[-1] + 60 / 176)
    tail = steady_beats(bpm=88.0, count=100, start=fast[-1] + 60 / 88)
    beats = np.concatenate([head, fast, tail])

    repaired, log = grid_mod.repair_local_octave(beats)
    assert len(log["runs"]) == 1
    assert log["runs"][0]["local_bpm"] == pytest.approx(176.0, rel=0.02)
    assert log["dropped"] == pytest.approx(55, abs=2)

    intervals = np.diff(repaired)
    assert intervals.max() < 60 / 88 * 1.6  # no hole left where beats were removed
    assert intervals.min() > 60 / 88 * 0.7  # and nothing still at double rate


def test_a_steady_song_is_untouched_by_local_octave_repair():
    beats = steady_beats(bpm=120.0, count=128)
    repaired, log = grid_mod.repair_local_octave(beats)
    assert log["runs"] == [] and log["dropped"] == 0
    np.testing.assert_allclose(repaired, beats)


def test_a_short_fast_burst_is_not_halved():
    """Eight quick beats are a fill. Halving them would be the actual mistake."""
    head = steady_beats(bpm=100.0, count=40)
    burst = steady_beats(bpm=200.0, count=8, start=head[-1] + 0.3)
    tail = steady_beats(bpm=100.0, count=40, start=burst[-1] + 0.6)
    beats = np.concatenate([head, burst, tail])
    _, log = grid_mod.repair_local_octave(beats)
    assert log["runs"] == []


def test_halving_keeps_the_surrounding_phase():
    """Surviving beats must line up with the beats either side of the run."""
    head = steady_beats(bpm=90.0, count=100)
    step = 60 / 90
    fast = head[-1] + step / 2 + np.arange(110) * (step / 2)
    tail = fast[-1] + step / 2 + np.arange(100) * step
    repaired, log = grid_mod.repair_local_octave(np.concatenate([head, fast, tail]))
    intervals = np.diff(repaired)
    off_grid = np.flatnonzero(~np.isclose(intervals, step, atol=1e-6))
    # An odd number of half-beats puts the run's trailing edge at 1.5x, and the
    # run's own record still says so -- but the grid that comes out is back on
    # the pulse, because the seam is closed rather than carried.
    assert log["runs"][0]["end_seam_ratio"] == 1.5
    assert off_grid.size == 0, f"{off_grid.size} intervals still off the pulse"
    assert log["seams_closed"], "the 1.5x seam was left open"
    assert log["seams_closed"][0]["pulled_back_ms"] == pytest.approx(step * 500, rel=0.02)


def test_a_mostly_fast_song_cannot_be_locally_halved():
    """A genuinely fast song is safe: the fast rate *is* the median it compares to.

    This is why no explicit majority guard is needed -- if most beats are quick,
    nothing reads as locally quick, and the tempo octave falls through to
    choose_octave, which is the stage that should decide it.
    """
    slow = steady_beats(bpm=88.0, count=30)
    fast = steady_beats(bpm=176.0, count=200, start=slow[-1] + 60 / 176)
    beats = np.concatenate([slow, fast])
    repaired, log = grid_mod.repair_local_octave(beats)
    assert log["dropped"] == 0 and log["runs"] == []
    np.testing.assert_allclose(repaired, beats)


# --------------------------------------------------------------------------
# seam realignment
# --------------------------------------------------------------------------
#
# Halving a run keeps every other beat, and a run spanning an odd number of
# half-beats leaves the beats after it half a beat out of phase. The seam used
# to be left in place as "the boundary's own uncertainty". It is not local: the
# lateness rides to the end of the song, and a second seam doubles it. Found on
# One For The Road, where four seams had the last beat 1.3 s late -- audible as
# the straightened render lurching a fifth in pitch at each one.


def test_a_seam_is_closed_and_the_phase_restored():
    step = 60 / 90
    before = np.arange(20) * step
    # Everything after the seam is half a beat late, as a halved run leaves it.
    after = before[-1] + step * 1.5 + np.arange(20) * step
    fixed, closed = grid_mod.realign_seams(np.concatenate([before, after]))

    np.testing.assert_allclose(np.diff(fixed), step, atol=1e-9)
    assert len(closed) == 1
    assert closed[0]["pulled_back_ms"] == pytest.approx(step * 500, abs=0.05)


def test_closing_a_seam_invents_and_loses_no_beats():
    """Bar numbering downstream depends on the count, so it must not move."""
    step = 60 / 90
    beats = np.concatenate([np.arange(20) * step, 19 * step + step * 1.5 + np.arange(20) * step])
    fixed, _ = grid_mod.realign_seams(beats)
    assert fixed.size == beats.size
    assert fixed[0] == pytest.approx(beats[0]), "the grid is re-phased from the seam, not moved"


def test_two_seams_both_close_and_the_lateness_does_not_accumulate():
    """The real failure: each seam adds half a beat and the error rides to the end."""
    step = 60 / 90
    beats = [np.arange(15) * step]
    for _ in range(2):
        beats.append(beats[-1][-1] + step * 1.5 + np.arange(15) * step)
    fixed, closed = grid_mod.realign_seams(np.concatenate(beats))

    np.testing.assert_allclose(np.diff(fixed), step, atol=1e-9)
    assert len(closed) == 2
    # Without the fix the last beat sits a whole beat late; with it, none.
    assert fixed[-1] == pytest.approx((fixed.size - 1) * step)


def test_a_steady_grid_has_no_seams_to_close():
    beats = steady_beats(bpm=120.0, count=64)
    fixed, closed = grid_mod.realign_seams(beats)
    assert closed == []
    np.testing.assert_allclose(fixed, beats)


def test_a_drummer_slowing_down_is_not_a_seam():
    """A ritardando is a tempo, not a phase slip, and must survive untouched."""
    step = 60 / 120
    beats = np.cumsum(np.concatenate([[0.0], step * np.linspace(1.0, 1.2, 63)]))
    fixed, closed = grid_mod.realign_seams(beats)
    assert closed == [], "a 20% slowdown was mistaken for a seam"
    np.testing.assert_allclose(fixed, beats)


def test_a_breakdown_is_a_hole_not_a_seam():
    """The dangerous false positive, so it is pinned.

    A phase slip is half a beat. A breakdown with the drums out is a real hole
    that `repair_intervals` deliberately leaves alone, and pulling the rest of
    the song back across it would be silently wrong from there to the end.
    """
    step = 60 / 90
    beats = np.concatenate(
        [np.arange(20) * step, 19 * step + 8.0 + np.arange(20) * step]  # an 8 s hole
    )
    fixed, closed = grid_mod.realign_seams(beats)
    assert closed == [], "a breakdown was closed as if it were a phase slip"
    np.testing.assert_allclose(fixed, beats)
