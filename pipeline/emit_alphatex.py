"""Turn a quantized score into alphaTex. The riskiest pure code in the project.

Rest and duration generation is where notation bugs live. With two voices you
must fill *both* voices in *every* bar to exactly the bar duration -- a bar that
sums to 15/16 doesn't render slightly wrong, it renders as a different bar, and
everything after it shifts.

So the whole thing is one **metric tree**. A bar is a node; splitting it in half
gives two nodes; splitting those gives beats, then eighths, then sixteenths. At
each node: if nothing is played inside it, emit one rest of that node's length;
if exactly one hit is played and it sits at the node's start, emit one note of
that length; otherwise split and recurse. Three consequences fall out for free:

- durations always sum to the bar, because a node is either emitted whole or
  replaced by its two halves;
- every duration is a plain power of two, so no ties and no dotted notes;
- **no rest ever straddles a metric boundary**, because a rest is always exactly
  one node. That is the rule that makes the output readable: a rest spanning
  beats 2-3 hides where beat 3 is, which is the one thing a drummer reading the
  bar needs to see.

Both properties are asserted by tests in ``tests/test_emit_alphatex.py``, which
need no audio and no GPU.

**Two voices, never more.** Voice 0 is hands (stems up), voice 1 is feet (stems
down); alphaTab writes them as ``hands \\voice feet`` per bar under
``\\voicemode barwise``. Guitar Pro's convention, and what alphaTab renders
correctly. Three or four voices is where drum notation stops being legible.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from pipeline import articulations, paths
from pipeline.proc import StageError
from pipeline.quantize import Bar, Score

# alphaTex duration values are the denominators of the note value: 1 is a whole
# note, 4 a quarter, 16 a sixteenth. 64th notes are the shortest alphaTab takes.
VALID_DURATIONS = frozenset({1, 2, 4, 8, 16, 32, 64})


@dataclass(frozen=True)
class Item:
    """One emitted beat: a chord of instruments, or a rest when empty."""

    length: int  # in grid slots
    instruments: tuple[str, ...] = ()

    @property
    def is_rest(self) -> bool:
        return not self.instruments


def slots_per_whole(subdivision: int, beat_unit: int) -> int:
    """How many grid slots make up a whole note.

    In 4/4 with sixteenth slots that is 16; in 6/8 with sixteenth slots (a
    beat_unit of 8) it is 8, because a slot is then a thirty-second of a whole
    note... which is why this is computed rather than hardcoded to 16.
    """
    return subdivision * beat_unit


def duration_value(length: int, subdivision: int, beat_unit: int) -> int:
    """alphaTex duration for a run of ``length`` slots."""
    whole = slots_per_whole(subdivision, beat_unit)
    if length <= 0 or whole % length:
        raise StageError(
            f"{length} slots is not a representable duration "
            f"({whole} slots per whole note)"
        )
    value = whole // length
    if value not in VALID_DURATIONS:
        raise StageError(f"{length} slots would need a 1/{value} note, which alphaTab has no glyph for")
    return value


def bar_nodes(beats_per_bar: int, subdivision: int) -> list[tuple[int, int]]:
    """The top-level metric nodes of a bar, as ``(start_slot, length)``.

    A bar whose slot count is a power of two is one node that halves cleanly all
    the way down (4/4: bar -> half -> beat -> eighth -> sixteenth). One that
    isn't -- 3/4, 5/4 -- can't be halved at all, so its beats are the top level
    and merging stops there. A three-beat rest in 3/4 is then written as three
    quarter rests, which is correct: in 3/4 you *want* to see the beats.
    """
    total = beats_per_bar * subdivision
    if total > 0 and total & (total - 1) == 0:
        return [(0, total)]
    return [(beat * subdivision, subdivision) for beat in range(beats_per_bar)]


def voice_items(
    slots: dict[int, tuple[str, ...]], beats_per_bar: int, subdivision: int
) -> list[Item]:
    """Metric-tree split of one staff voice of one bar.

    ``slots`` maps a slot index to the instruments struck there; slots not
    present are silent.
    """
    items: list[Item] = []
    for start, length in bar_nodes(beats_per_bar, subdivision):
        _split(slots, start, length, items)
    return items


def _split(
    slots: dict[int, tuple[str, ...]], start: int, length: int, out: list[Item]
) -> None:
    struck = [slot for slot in slots if start <= slot < start + length]
    if not struck:
        out.append(Item(length))
        return
    if len(struck) == 1 and struck[0] == start:
        out.append(Item(length, slots[start]))
        return
    if length < 2:  # unreachable: a slot holds at most one entry
        raise StageError(f"two hits in one slot at {start}")
    half = length // 2
    _split(slots, start, half, out)
    _split(slots, start + half, half, out)


def _voice_slots(bar: Bar, *, feet: bool) -> dict[int, tuple[str, ...]]:
    """Instruments per slot for one staff voice, in a stable order.

    Sorted so that re-running the pipeline on unchanged audio produces a
    byte-identical file -- ``git diff song.alphatex`` is only useful if it shows
    what a *pipeline* change did, not what a dict happened to iterate.
    """
    grouped: dict[int, list[str]] = {}
    for hit in bar.hits:
        if articulations.is_feet(hit.instrument) is feet:
            grouped.setdefault(hit.slot, []).append(hit.instrument)
    return {slot: tuple(sorted(set(names))) for slot, names in sorted(grouped.items())}


def render_item(item: Item, subdivision: int, beat_unit: int) -> str:
    value = duration_value(item.length, subdivision, beat_unit)
    if item.is_rest:
        return f"r.{value}"
    names = [articulations.articulation_name(name) for name in item.instruments]
    if len(names) == 1:
        return f'"{names[0]}".{value}'
    quoted = " ".join(f'"{name}"' for name in names)
    return f"({quoted}).{value}"


def render_bar(bar: Bar, *, beats_per_bar: int, subdivision: int, beat_unit: int) -> str:
    """One bar as ``hands \\voice feet``, both voices always filled."""
    parts = []
    for feet in (False, True):
        items = voice_items(_voice_slots(bar, feet=feet), beats_per_bar, subdivision)
        parts.append(" ".join(render_item(i, subdivision, beat_unit) for i in items))
    return f"{parts[0]} \\voice {parts[1]}"


def _escape(text: str) -> str:
    return text.replace("\\", " ").replace('"', "'")


def _tempo(bpm: float) -> str:
    """alphaTex takes an integer tempo; the real tempo lives in grid.lock.json.

    Rounding here costs nothing: playback follows sync points derived from the
    measured beat times, not from this number.
    """
    return str(max(1, int(round(bpm))))


def render(score: Score, *, title: str = "", subtitle: str = "") -> str:
    """The complete ``song.alphatex``."""
    header = [
        "// Generated by `drums emit` -- edits made here are overwritten on the",
        "// next run. One line per bar; the number in /* */ is the bar number.",
        *([f'\\title "{_escape(title)}"'] if title else []),
        *([f'\\subtitle "{_escape(subtitle)}"'] if subtitle else []),
        f"\\tempo {_tempo(score.bpm)}",
        # Every note is forte until Phase 2 works out ghosts and accents, and a
        # row of meaningless f marks is worse than no dynamics at all. Drop this
        # line when the velocities in score.json start reaching the notation.
        "\\hidedynamics",
        '\\track "Drums"',
        "\\instrument percussion",
        # Without this line alphaTab's articulation table is empty and every
        # note in the file is rejected.
        "\\articulation defaults",
        "\\clef neutral",
        # Voices per bar rather than per staff: keeps a bar's hands and feet on
        # one line, which is what makes hand-editing a single bar practical.
        "\\voicemode barwise",
        f"\\ts({score.beats_per_bar} {score.beat_unit})",
        "",
    ]
    body = []
    for index, bar in enumerate(score.bars):
        rendered = render_bar(
            bar,
            beats_per_bar=score.beats_per_bar,
            subdivision=score.subdivision,
            beat_unit=score.beat_unit,
        )
        terminator = "" if index == len(score.bars) - 1 else " |"
        body.append(f"/* {bar.index} */ {rendered}{terminator}")

    return "\n".join(header + body) + "\n"


def emit(song: paths.Song, score: Score) -> Path:
    meta = song.meta().get("source", {})
    text = render(
        score,
        title=meta.get("title", song.slug),
        subtitle=meta.get("url", ""),
    )
    song.alphatex.write_text(text, encoding="utf-8")
    return song.alphatex
