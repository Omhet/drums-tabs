"""Reading ``tab.mid``: the hits, on the grid the notation is drawn on.

Everything that analyses the chart -- sections, sticking, and whatever comes
after -- starts here, so that they all see the same hits in the same places as
the player does. The player's converter (``app/src/midi-tab.ts``) lays every
hit on a **sixteenth counted from bar 1**; this mirrors that exactly, because a
tool that disagreed with the page about where a note is would be analysing a
chart nobody can see.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import mido

from pipeline.proc import StageError

#: The notation's grid: four slots to the beat.
SLOTS_PER_BEAT = 4


@dataclass(frozen=True)
class Hit:
    """One note in the chart."""

    #: Sixteenths from the start of bar 1.
    slot: int
    #: MIDI key, as laid out on the drum rack (``[midi_map]`` names them).
    note: int
    #: 1-127 as written in Ableton. Not graded, and not drawn -- but a stroke
    #: has to know how far to lift, so it is carried from here on.
    velocity: int


def read_hits(midi_path: Path) -> list[Hit]:
    """Every note-on in ``tab.mid``, in time order then key order."""
    if not midi_path.exists():
        raise StageError(f"no notation at {midi_path}; author it in Ableton first")
    midi = mido.MidiFile(midi_path)
    ppq = midi.ticks_per_beat
    if not ppq:
        raise StageError(f"{midi_path}: no ticks-per-beat; SMPTE timing is not supported")
    step = ppq / SLOTS_PER_BEAT

    hits: list[Hit] = []
    for track in midi.tracks:
        tick = 0
        for message in track:
            tick += message.time
            if message.type == "note_on" and message.velocity > 0:
                hits.append(Hit(slot=round(tick / step), note=message.note, velocity=message.velocity))
    hits.sort(key=lambda hit: (hit.slot, hit.note))
    return hits


def chart_hash(midi_path: Path) -> str:
    """What everything derived from the chart is pinned to.

    The Live set is re-exported on every Ctrl+S, so anything computed from the
    notation -- sections, sticking, the grade of a take -- has to be able to say
    *which* notation it was computed from. Otherwise a fixed fill silently
    re-grades a take you played months ago against a chart that did not exist
    then.
    """
    return "sha256:" + hashlib.sha256(midi_path.read_bytes()).hexdigest()[:16]


def bar_of(slot: int, beats_per_bar: int) -> int:
    """0-based bar holding ``slot``."""
    return slot // (beats_per_bar * SLOTS_PER_BEAT)


def in_bar(slot: int, beats_per_bar: int) -> int:
    """Position of ``slot`` inside its bar, in sixteenths."""
    return slot % (beats_per_bar * SLOTS_PER_BEAT)
