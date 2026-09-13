"""The sticking solver, on a kit built in the test rather than read from disk.

The interesting claims are all about *which hand*, so the fixtures are a few
instruments at made-up positions and a handful of hits at made-up times. No
MIDI, no audio, no kit.toml.
"""

from __future__ import annotations

import pytest

from pipeline import sticking as sticking_mod
from pipeline.chart import Hit
from pipeline.kit import Instrument, Kit, Weights
from pipeline.paths import Song
from pipeline.sticking import HatChange, Stroke, Sticking, Unplayable, assign_hands, hat_track


def make_kit(**overrides) -> Kit:
    """A small right-handed kit: hats on the left, floor tom on the right."""
    places = {
        # name: (x, y, time_keeper)
        "kick": (0, 0, False),
        "hihat_pedal": (-50, -10, False),
        "snare": (-25, -15, False),
        "hihat_closed": (-50, -10, True),
        "hihat_open": (-50, -10, True),
        "ride": (50, 20, True),
        "tom_high": (-15, 25, False),
        "tom_mid": (15, 25, False),
        "tom_floor": (45, 5, False),
        "crash": (-45, 35, False),
    }
    feet = {"kick": ("right_foot",), "hihat_pedal": ("left_foot",)}
    instruments = {
        name: Instrument(
            name=name,
            x=x,
            y=y,
            limbs=feet.get(name, ("left_hand", "right_hand")),
            time_keeper=keeps_time,
        )
        for name, (x, y, keeps_time) in places.items()
    }
    weights = dict(
        max_speed_cm_s=700,
        travel=1.0,
        crossover=2.0,
        repeat=1.5,
        repeat_below_ms=260,
        lead="right",
        lead_bias=2.5,
    )
    weights.update(overrides)
    return Kit(instruments=instruments, hands=Weights(**weights), digest="test")


def letters(assignment: list[list[str]]) -> str:
    """The hands as a drummer reads them, one letter per hit."""
    return "".join("R" if limb == "right_hand" else "L" for hit in assignment for limb in hit)


# --- which hand ---------------------------------------------------------------


def test_the_lead_hand_keeps_time_and_the_other_takes_the_snare():
    # Eighth-note hats with a snare on 2 and 4: the classic, and the one the
    # solver has to get right or nothing else matters.
    events = []
    for eighth in range(8):
        now = eighth * 0.33
        together = ["hihat_closed"] + (["snare"] if eighth in (2, 6) else [])
        events.append((now, together))
    assignment, _ = assign_hands(events, make_kit())
    hands = {tuple(instruments): tuple(limbs) for (_, instruments), limbs in zip(events, assignment)}
    assert hands[("hihat_closed",)] == ("right_hand",)
    assert hands[("hihat_closed", "snare")] == ("right_hand", "left_hand")


def test_two_things_at_once_take_two_hands():
    events = [(0.0, ["crash", "tom_floor"])]
    assignment, _ = assign_hands(events, make_kit())
    assert set(assignment[0]) == {"left_hand", "right_hand"}


def test_three_things_at_once_is_reported_not_solved():
    events = [(0.0, ["crash", "tom_floor", "snare"])]
    with pytest.raises(Unplayable, match="only two hands"):
        assign_hands(events, make_kit())


def test_a_fast_fill_alternates():
    # Sixteenths at 90 BPM are 165 ms apart -- too fast for one hand, so the
    # repeat penalty makes the solver alternate the way a drummer would.
    events = [(index * 0.165, ["tom_high"]) for index in range(6)]
    assignment, _ = assign_hands(events, make_kit())
    assert letters(assignment) in ("RLRLRL", "LRLRLR")


def test_a_slow_repeat_stays_on_one_hand():
    # A crotchet apart there is all the time in the world, so moving the other
    # hand over would be work for nothing.
    events = [(index * 0.66, ["tom_high"]) for index in range(4)]
    assignment, _ = assign_hands(events, make_kit())
    assert letters(assignment) in ("RRRR", "LLLL")


def test_the_nearer_hand_takes_the_hit():
    # Left hand parked on the hats, right hand on the floor tom, then one hit
    # on the ride: the hand that is already over there should take it.
    events = [
        (0.0, ["hihat_closed", "tom_floor"]),
        (0.5, ["ride"]),
    ]
    assignment, _ = assign_hands(events, make_kit())
    on_floor = assignment[0][1]
    assert assignment[1][0] == on_floor


# Three places 10 ms apart. Two hands can cover two places however fast they
# come -- each just stays where it is -- so it takes a third to be impossible.
IMPOSSIBLE = [(0.0, ["hihat_closed"]), (0.01, ["tom_floor"]), (0.02, ["ride"])]


def test_a_move_nobody_could_make_is_unplayable():
    with pytest.raises(Unplayable) as raised:
        assign_hands(IMPOSSIBLE, make_kit())
    assert "cm/s" in str(raised.value)
    # It says which hit it gave up on, so the caller can name the bar.
    assert raised.value.event == 2


def test_two_hands_can_cover_two_places_however_fast():
    events = [(index * 0.01, ["hihat_closed" if index % 2 else "tom_floor"]) for index in range(6)]
    assignment, _ = assign_hands(events, make_kit())
    assert len(assignment) == 6


def test_a_higher_speed_limit_makes_it_playable():
    assignment, _ = assign_hands(IMPOSSIBLE, make_kit(max_speed_cm_s=100_000))
    assert len(assignment) == 3


def test_the_lead_can_be_the_left_hand():
    events = [(index * 0.33, ["hihat_closed"]) for index in range(4)]
    assignment, _ = assign_hands(events, make_kit(lead="left"))
    assert letters(assignment) == "LLLL"


# --- the hi-hat foot -------------------------------------------------------------


def hits(*pairs: tuple[int, str]) -> list[tuple[Hit, str]]:
    return [(Hit(slot=slot, note=0, velocity=100), name) for slot, name in pairs]


def test_the_foot_lifts_for_an_open_hat_and_drops_after():
    changes, problems = hat_track(hits((0, "hihat_closed"), (4, "hihat_open"), (8, "hihat_closed")), 4)
    assert problems == []
    assert changes == [HatChange(bar=1, slot=3, open=True), HatChange(bar=1, slot=8, open=False)]


def test_the_lift_never_lands_on_the_hit_before_it():
    # An open hat straight after a closed one cannot lift a sixteenth early:
    # the foot would be up for the closed note.
    changes, _ = hat_track(hits((3, "hihat_closed"), (4, "hihat_open")), 4)
    assert changes == [HatChange(bar=1, slot=4, open=True)]


def test_a_chick_closes_the_hat():
    changes, _ = hat_track(hits((0, "hihat_open"), (8, "hihat_pedal")), 4)
    assert changes[-1] == HatChange(bar=1, slot=8, open=False)


def test_open_and_pedalled_at_once_is_a_chart_error():
    _, problems = hat_track(hits((16, "hihat_open"), (16, "hihat_pedal")), 4)
    assert problems and "bar 2" in problems[0]


def test_a_hat_that_is_never_opened_needs_no_track():
    changes, problems = hat_track(hits((0, "hihat_closed"), (4, "snare")), 4)
    assert changes == [] and problems == []


# --- the lock file ------------------------------------------------------------------


def test_the_lock_file_round_trips(tmp_path):
    song = Song(slug="test", root=tmp_path)
    solved = Sticking(
        strokes=[Stroke(1, 0, "snare", "left_hand", 90), Stroke(1, 4, "kick", "right_foot", 110)],
        hat=[HatChange(2, 4, True)],
        chart="sha256:abc",
        kit="sha256:def",
        tempo_bpm=91.0,
        beats_per_bar=4,
        cost=1.5,
        notes=["something to know"],
    )
    sticking_mod.save(song, solved)
    again = sticking_mod.load(song)
    assert again == solved


def test_no_lock_file_reads_as_none(tmp_path):
    assert sticking_mod.load(Song(slug="test", root=tmp_path)) is None
