"""Sections: where the song repeats itself, read off the notation.

A section is a stretch of bars you can practise on its own -- and a practice
routine is a fixed grid of (section x tempo) cells, so the sections decide the
shape of every routine and of the whole progress history. That is why they are
*frozen*: this command proposes them once, you rename and nudge them by hand,
and from then on ``song.toml`` is the truth. Re-detecting needs ``--redetect``
and starts a new comparison epoch, because a boundary that moves changes the
cell grid and old runs stop being comparable to new ones.

What it can and cannot know. It reads ``tab.mid`` and finds **pattern**
boundaries: it will say "bars 15-22 come back at 43-50" and call them both B.
It has no idea that one is a verse and the other the last chorus, and no idea
that a chorus you played two different ways is one section. That is what the
renaming is for.

How it decides, in one paragraph. Every bar is reduced to a fingerprint -- what
is hit, on which sixteenth, exactly as the notation quantises it, so that two
bars match when they *look* the same on the page. Any block of bars that occurs
twice (a "repeat") offers a boundary at each of its four ends: where it starts
and where it stops, in both places. Boundaries in the middle of a stretch of
identical bars are thrown away, because a section starts where the music
changes and not at whichever phase of a groove a repeat happened to be found
at. A groove followed by its own immediate repeats is one section, not one per
repeat. What is left cuts the song into segments, segments too short to
practise are merged into a neighbour, and segments whose bars are identical get
the same letter.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from pipeline.chart import SLOTS_PER_BEAT, read_hits
from pipeline.paths import Song
from pipeline.proc import StageError


#: A block has to be at least this many bars long to count as a repeat; a
#: single bar repeats all over a drum chart and says nothing about structure.
MIN_REPEAT_BARS = 2
#: Segments shorter than this are merged into their neighbour. Four bars is
#: the shortest thing worth calling a section and practising on its own.
MIN_SECTION_BARS = 4

#: A bar, as it is drawn: (sixteenth from the start of the bar, MIDI key).
Fingerprint = tuple[tuple[int, int], ...]


@dataclass(frozen=True)
class Section:
    """One practisable stretch. Bar numbers are 1-based and inclusive."""

    name: str
    start_bar: int
    end_bar: int

    @property
    def bars(self) -> int:
        return self.end_bar - self.start_bar + 1


# --- the chart ---------------------------------------------------------------


def bar_fingerprints(midi_path: Path, beats_per_bar: int, bar_count: int = 0) -> list[Fingerprint]:
    """One fingerprint per bar of ``tab.mid``, in bar order.

    ``bar_count`` pads the result with empty bars if the notation stops short of
    the beat map, so a chart that has not been written to the end still gets
    sections for the bars that exist.
    """
    slots_per_bar = beats_per_bar * SLOTS_PER_BEAT
    drawn: dict[int, set[tuple[int, int]]] = {}
    for hit in read_hits(midi_path):
        bar, position = divmod(hit.slot, slots_per_bar)
        drawn.setdefault(bar, set()).add((position, hit.note))

    last = max([*drawn, bar_count - 1], default=-1)
    return [tuple(sorted(drawn.get(bar, ()))) for bar in range(last + 1)]


# --- repeats -----------------------------------------------------------------


def maximal_repeats(bars: list[Fingerprint], min_len: int = MIN_REPEAT_BARS) -> list[tuple[int, int, int]]:
    """Every block of bars that occurs twice, as ``(first, second, length)``.

    Only *maximal* occurrences: a repeat that is one bar of a longer repeat is
    not reported separately, so the boundaries come from where a repeat really
    starts and stops rather than from every sub-block inside it.
    """
    n = len(bars)
    found: list[tuple[int, int, int]] = []
    for i in range(n):
        for j in range(i + 1, n):
            # Extending backwards would give the same block one bar earlier,
            # so this pair is already covered by that longer one.
            if i > 0 and bars[i - 1] == bars[j - 1]:
                continue
            length = 0
            while j + length < n and bars[i + length] == bars[j + length]:
                length += 1
                # Stop before the two occurrences run into each other.
                if i + length == j:
                    break
            if length >= min_len:
                found.append((i, j, length))
    return found


def boundaries(bars: list[Fingerprint], min_section: int = MIN_SECTION_BARS) -> list[int]:
    """Bar indices (0-based) where a section starts, first one always 0."""
    n = len(bars)
    if n == 0:
        return []
    cuts = {0, n}
    for first, second, length in maximal_repeats(bars):
        cuts.update((first, first + length, second, second + length))

    # A section starts where the music changes. Inside a stretch of bars that
    # are all drawn the same -- twelve bars of one groove, which is how this
    # song opens -- a repeat can be found at every offset, and each one offers
    # a boundary that is nothing but the phase it happened to be found at.
    # None of them is where a section starts.
    cuts = {c for c in cuts if c in (0, n) or bars[c - 1] != bars[c]}

    starts = _merge_immediate_repeats(bars, sorted(cuts))

    # Merge away anything too short to practise. A run of short segments
    # collapses into the one before it, except at the very start of the song,
    # where there is nothing before to collapse into.
    kept = [0]
    for cut in starts[1:]:
        if cut - kept[-1] >= min_section and n - cut >= min_section:
            kept.append(cut)
    return kept


def _merge_immediate_repeats(bars: list[Fingerprint], cuts: list[int]) -> list[int]:
    """Absorb a block into the one before it when it is the same block again.

    A verse that plays the same four bars four times is one verse, not four
    sections: the repeats are how the section is built, not a boundary inside
    it. Only *immediate* repeats merge -- the same groove coming back later in
    the song is a different section that happens to share a letter.
    """
    kept: list[int] = []
    index = 0
    while index < len(cuts) - 1:
        start, end = cuts[index], cuts[index + 1]
        kept.append(start)
        unit = bars[start:end]
        # Swallow every following block that is this one again.
        while index + 2 < len(cuts) and bars[cuts[index + 1] : cuts[index + 2]] == unit:
            index += 1
        index += 1
    return kept


def detect(bars: list[Fingerprint], min_section: int = MIN_SECTION_BARS) -> list[Section]:
    """Propose sections: cut at the repeats, merge, then letter them by content."""
    starts = boundaries(bars, min_section)
    if not starts:
        return []
    ends = [*starts[1:], len(bars)]

    letters: dict[tuple[Fingerprint, ...], str] = {}
    sections: list[Section] = []
    for start, end in zip(starts, ends):
        content = tuple(bars[start:end])
        name = letters.get(content)
        if name is None:
            name = _letter(len(letters))
            letters[content] = name
        sections.append(Section(name=name, start_bar=start + 1, end_bar=end))
    return sections


def _letter(index: int) -> str:
    """0 -> A, 25 -> Z, 26 -> AA. Placeholders until they are renamed."""
    name = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(ord("A") + remainder) + name
    return name


# --- song.toml ---------------------------------------------------------------

_HEADER = "[[section]]"
_INTRO = (
    "# The sections a routine is built from, proposed by `drums sections` from\n"
    "# the repeats in tab.mid and then yours: rename them, nudge the bar\n"
    "# numbers, merge or split. Bars are 1-based and inclusive, and together\n"
    "# they cover the song in order.\n"
    "#\n"
    "# Two blocks with the same name are one section the song plays twice --\n"
    "# name both choruses `chorus` and you practise it once, against the first\n"
    "# of them, instead of learning the same music twice in a run.\n"
    "#\n"
    "# Once you have played a routine these are frozen: a boundary that moves\n"
    "# changes the shape of every routine, and old runs stop being comparable\n"
    "# to new ones.\n"
)


def distinct(sections: list[Section]) -> list[str]:
    """The section names, once each, in the order they first occur.

    A name repeated in ``song.toml`` is the same section played again, so this
    is what a routine's cells are counted from: the song's *layout* is every
    block in order, the things to *practise* are these.
    """
    names: list[str] = []
    for section in sections:
        if section.name not in names:
            names.append(section.name)
    return names


def read(song: Song) -> list[Section]:
    """The sections in ``song.toml``, in the order they are written."""
    found = []
    for entry in song.meta().get("section", []):
        try:
            found.append(
                Section(
                    name=str(entry["name"]),
                    start_bar=int(entry["start_bar"]),
                    end_bar=int(entry["end_bar"]),
                )
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise StageError(
                f"{song.toml}: a [[section]] is missing name/start_bar/end_bar ({exc})"
            ) from exc
    return found


def strip(text: str) -> str:
    """``song.toml`` without its ``[[section]]`` blocks, everything else kept.

    The file is hand-edited -- it holds the Ableton pointer and the pad map with
    their comments -- so it is never rewritten wholesale, only cut and appended
    to.
    """
    lines = text.splitlines()
    kept: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if line.strip() == _HEADER:
            # Take the comment written directly above it with it.
            while kept and (kept[-1].lstrip().startswith("#") or not kept[-1].strip()):
                kept.pop()
            index += 1
            while index < len(lines) and not re.match(r"^\[", lines[index]):
                index += 1
            continue
        kept.append(line)
        index += 1
    return "\n".join(kept).rstrip() + "\n"


def write(song: Song, sections: list[Section]) -> None:
    """Replace the ``[[section]]`` blocks in ``song.toml`` with these."""
    body = [_INTRO.rstrip("\n")]
    for section in sections:
        body.append(
            f"{_HEADER}\n"
            f'name = "{section.name}"\n'
            f"start_bar = {section.start_bar}\n"
            f"end_bar = {section.end_bar}"
        )
    text = strip(song.toml.read_text(encoding="utf-8"))
    song.toml.write_text(text + "\n" + "\n\n".join(body) + "\n", encoding="utf-8")
