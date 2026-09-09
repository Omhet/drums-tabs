"""The metric-tree emitter, on synthetic bars.

Rest and duration generation is the notation layer's single biggest bug source,
and it is pure arithmetic over a dict of slots -- so it is tested here, exactly,
rather than by squinting at a rendered PNG after a three-minute pipeline run.

Two properties matter more than any particular expected string:

1. **Every voice of every bar sums to the bar length.** A bar that is 15/16 long
   doesn't render as a slightly wrong bar, it renders as a different bar, and
   the rest of the score shifts behind it.
2. **No rest crosses a metric boundary it doesn't start on.** A rest spanning
   beats 2-3 hides where beat 3 is, which is the one thing the reader needs.
"""

from __future__ import annotations

import itertools

import pytest

from pipeline import articulations
from pipeline import emit_alphatex as emit
from pipeline.proc import StageError
from pipeline.quantize import Bar, Hit, Score

BEATS_PER_BAR = 4
SUBDIVISION = 4
SLOTS = BEATS_PER_BAR * SUBDIVISION


def bar(*spec: tuple[int, str], index: int = 1) -> Bar:
    return Bar(index=index, hits=[Hit(slot=s, instrument=n, velocity=0.8) for s, n in spec])


def items(slots: dict[int, tuple[str, ...]]):
    return emit.voice_items(slots, BEATS_PER_BAR, SUBDIVISION)


def total(entries) -> int:
    return sum(item.length for item in entries)


# --------------------------------------------------------------------------
# properties
# --------------------------------------------------------------------------


def every_slot_subset(count: int):
    """All ways ``count`` hits can be placed in a bar of sixteenths."""
    return itertools.combinations(range(SLOTS), count)


@pytest.mark.parametrize("count", [0, 1, 2, 3])
def test_durations_always_sum_to_the_bar(count: int):
    for placement in every_slot_subset(count):
        entries = items({slot: ("snare",) for slot in placement})
        assert total(entries) == SLOTS, placement


@pytest.mark.parametrize("count", [0, 1, 2, 3])
def test_every_duration_is_notatable(count: int):
    for placement in every_slot_subset(count):
        for item in items({slot: ("snare",) for slot in placement}):
            value = emit.duration_value(item.length, SUBDIVISION, beat_unit=4)
            assert value in emit.VALID_DURATIONS


@pytest.mark.parametrize("count", [0, 1, 2, 3])
def test_nothing_straddles_a_boundary_it_does_not_start_on(count: int):
    """A note or rest of length L may only start at a multiple of L.

    That is precisely what the metric tree guarantees, and it is what stops a
    rest from swallowing the middle of the bar. Checking it for every placement
    of up to three hits is 700-odd bars of exhaustive proof, in milliseconds.
    """
    for placement in every_slot_subset(count):
        position = 0
        for item in items({slot: ("snare",) for slot in placement}):
            assert position % item.length == 0, (placement, position, item)
            position += item.length


def test_hits_survive_the_split():
    """Every hit comes out once, at the slot it went in at."""
    for placement in every_slot_subset(3):
        entries = items({slot: ("snare",) for slot in placement})
        position = 0
        struck = []
        for item in entries:
            if not item.is_rest:
                struck.append(position)
            position += item.length
        assert struck == list(placement)


# --------------------------------------------------------------------------
# specific shapes worth pinning
# --------------------------------------------------------------------------


def test_an_empty_voice_is_one_whole_rest():
    assert items({}) == [emit.Item(SLOTS)]


def test_a_lone_downbeat_fills_the_bar():
    assert items({0: ("kick",)}) == [emit.Item(SLOTS, ("kick",))]


def test_backbeats_split_at_the_half_then_the_beat():
    """Snare on 2 and 4: quarter rest, quarter, quarter rest, quarter.

    The interesting part is the rests. A naive emitter writes a half rest from
    beat 3 to 4 here; the tree can't, because that rest would start on beat 3
    with length 2 beats and cross into the second half's second beat.
    """
    entries = items({4: ("snare",), 12: ("snare",)})
    assert entries == [
        emit.Item(4),
        emit.Item(4, ("snare",)),
        emit.Item(4),
        emit.Item(4, ("snare",)),
    ]


def test_a_rest_never_spans_the_middle_of_the_bar():
    """One hit on the last sixteenth: the rest before it stops at the midpoint."""
    entries = items({15: ("snare",)})
    lengths = [item.length for item in entries]
    assert lengths == [8, 4, 2, 1, 1]
    assert total(entries) == SLOTS


def test_offbeat_hit_does_not_produce_a_dotted_note():
    """A hit at slot 6 gives an eighth, not a dotted quarter -- no ties needed."""
    entries = items({0: ("kick",), 6: ("kick",)})
    assert [(i.length, i.instruments) for i in entries] == [
        (4, ("kick",)),
        (2, ()),
        (2, ("kick",)),
        (8, ()),
    ]


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------


def test_render_bar_writes_both_voices():
    text = emit.render_bar(
        bar((0, "kick"), (0, "hihat_closed"), (4, "snare"), (4, "hihat_closed")),
        beats_per_bar=BEATS_PER_BAR,
        subdivision=SUBDIVISION,
        beat_unit=4,
    )
    hands, feet = text.split(" \\voice ")
    assert hands == '"hi-hat (closed)".4 ("hi-hat (closed)" "snare (hit)").4 r.2'
    assert feet == '"kick (hit)".1'


def test_feet_and_hands_go_to_different_voices():
    """Kick is a foot, snare and hat are hands -- and the pedal hat is a foot."""
    assert articulations.is_feet("kick")
    assert articulations.is_feet("hihat_pedal")
    assert not articulations.is_feet("hihat_closed")


def test_chords_are_ordered_deterministically():
    """Re-running the pipeline on unchanged audio must produce an identical file."""
    one = emit.render_bar(
        bar((0, "snare"), (0, "hihat_closed")),
        beats_per_bar=BEATS_PER_BAR, subdivision=SUBDIVISION, beat_unit=4,
    )
    two = emit.render_bar(
        bar((0, "hihat_closed"), (0, "snare")),
        beats_per_bar=BEATS_PER_BAR, subdivision=SUBDIVISION, beat_unit=4,
    )
    assert one == two


def test_render_emits_the_header_alphatab_requires():
    score = Score(
        bpm=132.4,
        beats_per_bar=4,
        beat_unit=4,
        subdivision=4,
        bars=[bar((0, "kick"), index=1), bar((4, "snare"), index=2)],
    )
    text = emit.render(score, title="Some Song", subtitle="https://example.test")
    # Without \articulation defaults the articulation table is empty and every
    # note in the file is rejected -- the failure mode is a blank score.
    assert "\\instrument percussion" in text
    assert "\\articulation defaults" in text
    assert "\\voicemode barwise" in text
    assert "\\ts(4 4)" in text
    assert "\\tempo 132" in text
    # One line per bar, numbered, and no trailing bar separator.
    body = [line for line in text.splitlines() if line.startswith("/*")]
    assert len(body) == 2
    assert body[0].startswith("/* 1 */") and body[0].endswith(" |")
    assert not body[1].endswith("|")


def test_a_title_cannot_break_out_of_its_quotes():
    score = Score(bpm=120, beats_per_bar=4, beat_unit=4, subdivision=4, bars=[bar()])
    text = emit.render(score, title='Toto - "Rosanna" \\ live')
    title_line = next(line for line in text.splitlines() if line.startswith("\\title"))
    assert title_line.count('"') == 2


# --------------------------------------------------------------------------
# meters that are not 4/4
# --------------------------------------------------------------------------


def test_three_four_splits_into_beats_not_halves():
    """12 slots can't be halved, so the beats are the top level."""
    assert emit.bar_nodes(3, 4) == [(0, 4), (4, 4), (8, 4)]
    entries = emit.voice_items({}, 3, 4)
    assert [item.length for item in entries] == [4, 4, 4]
    assert total(entries) == 12


def test_an_unrepresentable_duration_fails_loudly():
    """Better a stage error than a bar that silently doesn't add up."""
    with pytest.raises(StageError):
        emit.duration_value(3, SUBDIVISION, beat_unit=4)
