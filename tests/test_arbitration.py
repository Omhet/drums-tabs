"""Cross-stem arbitration and per-slot thresholds, as pure functions.

None of this touches audio, files or a GPU: the whole point of splitting
:func:`cluster`, :func:`arbitrate`, :func:`calibrate` and :func:`slot_floors`
out of the detector is that the rules can be stated against invented candidates
and checked in milliseconds, instead of by re-running a pipeline and squinting
at a note count.
"""

from __future__ import annotations

import numpy as np

from pipeline.backends.stems import (
    CALIBRATION_CLAMP,
    CALIBRATION_MIN_EVENTS,
    SUPPORTED_FLOOR,
    UNSUPPORTED_FLOOR,
    Candidate,
    arbitrate,
    calibrate,
    cluster,
    slot_floors,
)


def hit(t: float, instrument: str, share: float) -> Candidate:
    """A candidate with only the fields arbitration looks at."""
    return Candidate(t=t, instrument=instrument, share=share, attack=1.0, level=1.0, support=1.0)


# --- clustering ------------------------------------------------------------


def test_cluster_groups_simultaneous_candidates():
    assert cluster([1.000, 1.008, 1.015, 2.000], window=0.025) == [[0, 1, 2], [3]]


def test_cluster_does_not_chain_across_the_window():
    """Each run is measured from the candidate that opened it, not the last one.

    Otherwise a dense passage of sixteenths -- each 20 ms from its neighbour --
    would daisy-chain into one cluster spanning half a beat, and the strongest
    stem in it would suppress the rest of the bar.
    """
    assert cluster([0.0, 0.020, 0.040, 0.060], window=0.025) == [[0, 1], [2, 3]]


def test_cluster_sorts_unsorted_input():
    assert cluster([2.0, 1.0, 1.01], window=0.025) == [[1, 2], [0]]


def test_cluster_of_nothing():
    assert cluster([], window=0.025) == []


# --- the generic winner-take-all ------------------------------------------


def test_weak_stem_is_outranked_by_a_confusable_one():
    """A kick's shadow in the snare stem: same moment, a fraction of the share.

    Above the absolute floor on its own -- it takes the comparison to reject it.
    """
    candidates = [hit(1.0, "kick", 0.98), hit(1.004, "snare", 0.20)]
    assert arbitrate(candidates, suppression={}) == [None, "outranked"]


def test_a_real_unison_survives():
    """Kick and snare together is a normal thing to play, and both own their bands."""
    candidates = [hit(1.0, "kick", 0.95), hit(1.004, "snare", 0.90)]
    assert arbitrate(candidates, suppression={}) == [None, None]


def test_no_suppression_between_unconfusable_drums():
    """A snare at 300 Hz says nothing about whether a hi-hat sounded at 8 kHz.

    Share is a fraction of a band, so comparing it across bands that do not
    overlap is meaningless -- and doing it deleted real backbeat hi-hats from a
    disco tune, which is what the confusion groups exist to prevent.
    """
    candidates = [hit(1.0, "snare", 0.99), hit(1.004, "hihat_closed", 0.20)]
    assert arbitrate(candidates, suppression={}) == [None, None]


def test_cymbals_do_outrank_each_other():
    """Within the cymbal group the rule still applies -- that is its main job."""
    candidates = [hit(1.0, "crash", 0.95), hit(1.004, "hihat_closed", 0.20)]
    assert arbitrate(candidates, suppression={}) == [None, "outranked"]


def test_absolute_floor_catches_an_unplayed_stem():
    """A ride that is never struck still yields peaks; they hold none of the band."""
    assert arbitrate([hit(1.0, "ride", 0.01)], suppression={}) == ["no share"]
    assert arbitrate([hit(1.0, "ride", 0.80)], suppression={}) == [None]


def test_a_lone_candidate_is_never_outranked_by_itself():
    """The comparison is against *rivals*, so a solitary weak hit is kept."""
    assert arbitrate([hit(1.0, "kick", 0.30)], suppression={}) == [None]


# --- the physically-motivated asymmetries ---------------------------------


def test_kick_suppresses_a_snare_that_clears_the_generic_bar():
    """0.42 beats the generic 0.35 ratio and still loses to the tighter pair rule."""
    candidates = [hit(1.0, "kick", 0.95), hit(1.004, "snare", 0.42)]
    assert arbitrate(candidates, suppression={("kick", "snare"): 0.45}) == [None, "kick bleed"]


def test_suppression_runs_one_way_only():
    """Kick suppresses snare; a weak kick under a strong snare is not a snare's shadow.

    The asymmetry is the physical claim: a kick's fundamental reaches up into
    the snare's body band, but a snare puts nothing at 60 Hz.
    """
    candidates = [hit(1.0, "snare", 0.95), hit(1.004, "kick", 0.42)]
    assert arbitrate(candidates, suppression={("kick", "snare"): 0.45}) == [None, None]


def test_a_weak_suppressor_suppresses_weakly():
    """The bar scales with the suppressor: half-present, half as much authority."""
    candidates = [hit(1.0, "kick", 0.40), hit(1.004, "snare", 0.30)]
    # 0.30 >= 0.45 * 0.40 = 0.18, so the snare stands.
    assert arbitrate(candidates, suppression={("kick", "snare"): 0.45}) == [None, None]


def test_suppression_does_not_cascade():
    """Every test uses the original shares, so drops cannot chain.

    A crash that has itself just been ruled another cymbal's bleed must not go
    on to silence the hi-hat -- and the outcome must not depend on the order the
    pairs happen to be written in.
    """
    candidates = [
        hit(1.0, "ride", 0.95),
        hit(1.002, "crash", 0.20),  # outranked by the ride
        hit(1.004, "hihat_closed", 0.15),
    ]
    verdicts = arbitrate(candidates, suppression={("crash", "hihat_closed"): 0.45})
    # The hat loses to the ride, not to the already-dismissed crash.
    assert verdicts[1] == "outranked"
    assert verdicts[2] == "outranked"


def test_verdicts_follow_input_order_not_time_order():
    """Callers zip the result against their own list, so the order is a contract."""
    candidates = [hit(9.0, "snare", 0.90), hit(1.0, "kick", 0.95), hit(1.004, "snare", 0.20)]
    assert arbitrate(candidates, suppression={}) == [None, None, "outranked"]


def test_arbitration_does_not_mutate_its_input():
    candidates = [hit(1.0, "kick", 0.98), hit(1.004, "snare", 0.20)]
    before = list(candidates)
    arbitrate(candidates, suppression={})
    assert candidates == before


# --- calibration -----------------------------------------------------------


def test_calibration_fits_the_ratio_to_isolated_hits():
    """Snares that occur with no kick anywhere near them set the bar.

    Twenty of them at a share of 0.50, so the tenth percentile is 0.50 and a
    coincident snare has to look about that separated to be believed.
    """
    isolated = [hit(float(i), "snare", 0.50) for i in range(20)]
    coincident = [hit(100.0, "kick", 0.95), hit(100.004, "snare", 0.30)]
    fitted = calibrate(isolated + coincident, suppression={("kick", "snare"): 0.45})
    assert fitted[("kick", "snare")] == 0.50


def test_calibration_keeps_the_default_without_enough_evidence():
    """A snare that never sounds alone cannot say what a lone snare looks like."""
    few = [hit(float(i), "snare", 0.50) for i in range(CALIBRATION_MIN_EVENTS - 1)]
    fitted = calibrate(few, suppression={("kick", "snare"): 0.45})
    assert fitted[("kick", "snare")] == 0.45


def test_calibration_is_clamped_at_both_ends():
    low, high = CALIBRATION_CLAMP
    very_clean = [hit(float(i), "snare", 1.0) for i in range(30)]
    assert calibrate(very_clean, suppression={("kick", "snare"): 0.45})[("kick", "snare")] == high

    barely_there = [hit(float(i), "snare", 0.13) for i in range(30)]
    assert calibrate(barely_there, suppression={("kick", "snare"): 0.45})[("kick", "snare")] == low


def test_calibration_ignores_peaks_below_the_share_floor():
    """Unplayed stems offer hundreds of "isolated" peaks that mean nothing.

    Without this the fit is dragged to the clamp floor on every song and stops
    distinguishing between them.
    """
    junk = [hit(float(i), "snare", 0.01) for i in range(200)]
    real = [hit(200.0 + i, "snare", 0.60) for i in range(20)]
    fitted = calibrate(junk + real, suppression={("kick", "snare"): 0.45})
    assert fitted[("kick", "snare")] == 0.60


# --- per-slot thresholds ---------------------------------------------------


def floors_for(pattern: list[tuple[int, int]], instrument: str = "snare") -> np.ndarray:
    bars = np.array([bar for bar, _ in pattern])
    slots = np.array([slot for _, slot in pattern])
    return slot_floors(bars, slots, [instrument] * len(pattern))


def test_a_slot_every_neighbour_plays_gets_the_low_floor():
    pattern = [(bar, 4) for bar in range(1, 9)]
    assert np.allclose(floors_for(pattern), SUPPORTED_FLOOR)


def test_a_slot_nothing_else_plays_gets_the_high_floor():
    """The backbeat is everywhere; the stray hit on slot 7 stands alone."""
    pattern = [(bar, 4) for bar in range(1, 9)] + [(3, 7)]
    floors = floors_for(pattern)
    assert floors[-1] == UNSUPPORTED_FLOOR
    assert np.isclose(floors[0], SUPPORTED_FLOOR)


def test_partial_support_lands_between_the_two():
    """Half the neighbours playing a slot is most of the way to trusting it."""
    pattern = [(bar, 4) for bar in range(1, 9)] + [(bar, 7) for bar in (2, 4, 6, 8)]
    floors = floors_for(pattern)
    stray = floors[[i for i, (_, slot) in enumerate(pattern) if slot == 7]]
    assert np.all(stray > SUPPORTED_FLOOR)
    assert np.all(stray < UNSUPPORTED_FLOOR)


def test_instruments_are_judged_separately():
    """A kick on slot 4 says nothing about whether a snare belongs there."""
    bars = np.array([1, 2, 3, 4, 5, 3])
    slots = np.array([4, 4, 4, 4, 4, 4])
    instruments = ["kick"] * 5 + ["snare"]
    floors = slot_floors(bars, slots, instruments)
    assert floors[-1] == UNSUPPORTED_FLOOR
    assert np.isclose(floors[0], SUPPORTED_FLOOR)


def test_neighbours_are_counted_in_played_bars_not_bar_numbers():
    """A groove either side of a silence is still its own neighbour.

    Bars 20-23 have nothing at all -- the drummer stopped -- so bar 24 is
    judged against bars 16-19, not against four bars of rest.
    """
    pattern = [(bar, 4) for bar in (16, 17, 18, 19, 24, 25, 26, 27)]
    assert np.allclose(floors_for(pattern), SUPPORTED_FLOOR)


def test_a_bar_does_not_support_itself():
    """One bar repeating a slot cannot make that slot look established."""
    assert np.allclose(floors_for([(1, 4)]), UNSUPPORTED_FLOOR)


def test_the_floors_never_leave_the_band():
    pattern = [(bar, slot) for bar in range(1, 12) for slot in (0, 4, 7, 11)]
    floors = floors_for(pattern)
    assert np.all(floors >= SUPPORTED_FLOOR)
    assert np.all(floors <= UNSUPPORTED_FLOOR)


def test_slot_floors_returns_one_value_per_candidate():
    pattern = [(1, 0), (1, 4), (2, 0), (2, 4), (3, 0)]
    assert floors_for(pattern).shape == (5,)
