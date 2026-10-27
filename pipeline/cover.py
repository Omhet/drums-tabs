"""A recorded cover: one session folder, its settings, and the clock the tab runs on.

Everything the cover commands make or read lives under one session folder,
``songs/<slug>/covers/<name>/``, which is also the Ableton project the
generated set is saved into -- so Live's own recordings land in its
``Samples/Recorded/`` beside everything else::

    cover.toml              settings and every measured number (offsets, crops)
    <name>.als              the generated Live set
    Samples/Recorded/       what Live recorded (audio passes)
    raw/                    camera files and the raw MIDI log
    work/                   intermediates: mix, renders, tab strip, frames
    out/                    the finished videos

**The timeline.** Every time in seconds in the cover code is on Live's
arrangement timeline, 0 at 1|1|1. The final mix starts there too, so mix time
and arrangement time are the same thing. A camera file is mapped onto it by
the offset ``cover-sync`` measures.

**Two timings** (see ``Timing``) differ only in where the song's beats fall on
that timeline, which is what :class:`Clock` holds.
"""

from __future__ import annotations

import json
import tomllib
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

import numpy as np

from pipeline import paths
from pipeline.proc import StageError

TICKS_PER_BEAT = 480  # tab.mid's resolution, as app/plugins/ableton.ts writes it
BEATS_PER_BAR = 4
LIVE_TEMPO = 130.0  # the generated set's tempo, for both timings


class Timing(str, Enum):
    """How the song's beats are laid on the arrangement.

    ``straight``: the pitch-kept stretched stems at a constant tempo, starting
    one bar in so the click can count in. ``original``: the stems untouched at
    1|1|1, with a click that follows the record's own beat map.
    """

    straight = "straight"
    original = "original"


# Where the song's bar 1 sits on the arrangement, in Live beats, per timing.
# Straight: one bar of count-in before it. Original: the stems start at 1|1|1
# and bar 1 is wherever the record has it (2.02 s into Song 2).
STRAIGHT_LEAD_BEATS = BEATS_PER_BAR


@dataclass(frozen=True)
class Clock:
    """Chart position <-> arrangement seconds.

    ``beats[k]`` is the arrangement time of the chart's beat ``k`` (beat 0 is
    the downbeat of bar 1). Between beats, time and tick are interpolated
    straight across; past either end the nearest beat spacing carries on, which
    is how bar 65 -- the last crash, past the end of Song 2's beat map -- gets
    a time.
    """

    beats: np.ndarray

    def tick_at(self, seconds: float | np.ndarray) -> np.ndarray:
        t = np.asarray(seconds, dtype=np.float64)
        b = self.beats
        idx = np.interp(t, b, np.arange(b.size, dtype=np.float64))
        head = (t - b[0]) / (b[1] - b[0])
        tail = (b.size - 1) + (t - b[-1]) / (b[-1] - b[-2])
        idx = np.where(t < b[0], head, np.where(t > b[-1], tail, idx))
        return idx * TICKS_PER_BEAT

    def seconds_at(self, tick: float | np.ndarray) -> np.ndarray:
        k = np.asarray(tick, dtype=np.float64) / TICKS_PER_BEAT
        b = self.beats
        t = np.interp(k, np.arange(b.size, dtype=np.float64), b)
        head = b[0] + k * (b[1] - b[0])
        tail = b[-1] + (k - (b.size - 1)) * (b[-1] - b[-2])
        return np.where(k < 0, head, np.where(k > b.size - 1, tail, t))

    def bar_start(self, bar: int) -> float:
        return float(self.seconds_at((bar - 1) * BEATS_PER_BAR * TICKS_PER_BEAT))


def straight_bpm(song: paths.Song) -> float:
    if not song.straight_json.exists():
        raise StageError(f"no {song.straight_json.name}; run `drums straighten {song.slug}` first")
    return float(json.loads(song.straight_json.read_text(encoding="utf-8"))["bpm"])


def original_beats(song: paths.Song) -> np.ndarray:
    """The record's beat times from bar 1 on, in seconds into the original stems."""
    lock = json.loads(song.grid_lock.read_text(encoding="utf-8"))
    beats = np.asarray(lock["beats"], dtype=np.float64)[int(lock["bar_one_beat"]) :]
    if beats.size < 2:
        raise StageError("grid.lock.json has fewer than two beats after bar 1")
    return beats


def clock_for(song: paths.Song, timing: Timing) -> Clock:
    if timing is Timing.straight:
        bpm = straight_bpm(song)
        start = STRAIGHT_LEAD_BEATS * 60.0 / LIVE_TEMPO
        count = original_beats(song).size
        return Clock(start + np.arange(count, dtype=np.float64) * 60.0 / bpm)
    return Clock(original_beats(song))


def stretched(song: paths.Song, name: str) -> Path:
    """A pitch-kept constant-tempo stem (``nodrums``, ``drums``, ``mix``)."""
    return song.stems_dir / f"stretched-{name}.wav"


def click_track(song: paths.Song, timing: Timing) -> Path:
    return song.stems_dir / f"click-{timing.value}.wav"


def backing(song: paths.Song, timing: Timing) -> dict[str, Path]:
    """The audio tracks a cover set plays, by track name, click last.

    Each file starts at :func:`stem_start_beats` on the arrangement except the
    click, which always starts at 1|1|1 and carries its own count-in.
    """
    if timing is Timing.straight:
        tracks = {"nodrums": stretched(song, "nodrums"), "drums": stretched(song, "drums")}
    else:
        tracks = {"nodrums": song.nodrums, "drums": song.drums}
    tracks["click"] = click_track(song, timing)
    return tracks


def stem_start_beats(timing: Timing) -> float:
    """Where the song stems' clips start on the arrangement, in Live beats."""
    return float(STRAIGHT_LEAD_BEATS) if timing is Timing.straight else 0.0


# --- the session folder ------------------------------------------------------


@dataclass(frozen=True)
class Session:
    song: paths.Song
    name: str

    @property
    def root(self) -> Path:
        return self.song.root / "covers" / self.name

    @property
    def toml(self) -> Path:
        return self.root / "cover.toml"

    @property
    def als(self) -> Path:
        return self.root / f"{self.name}.als"

    @property
    def recorded(self) -> Path:
        return self.root / "Samples" / "Recorded"

    @property
    def raw(self) -> Path:
        return self.root / "raw"

    @property
    def work(self) -> Path:
        return self.root / "work"

    @property
    def out(self) -> Path:
        return self.root / "out"

    def ensure_dirs(self) -> None:
        for d in (self.root, self.raw, self.work, self.out):
            d.mkdir(parents=True, exist_ok=True)

    # cover.toml is a handful of flat sections; every command reads the whole
    # file, changes its own section and writes it back.

    def settings(self) -> dict[str, dict]:
        if not self.toml.exists():
            raise StageError(f"no {self.toml}; run `drums cover-session` first")
        return tomllib.loads(self.toml.read_text(encoding="utf-8"))

    def update(self, section: str, values: dict) -> dict[str, dict]:
        current = self.settings() if self.toml.exists() else {}
        current.setdefault(section, {}).update(values)
        paths.write_toml(self.toml, current)
        return current

    @property
    def timing(self) -> Timing:
        return Timing(self.settings()["session"]["timing"])

    def clock(self) -> Clock:
        return clock_for(self.song, self.timing)


def covers_dir(song: paths.Song) -> Path:
    return song.root / "covers"


def session(song: paths.Song, name: str | None = None) -> Session:
    """A named session, or the most recently changed one when no name is given."""
    if name:
        return Session(song, name)
    found = sorted(
        (p for p in covers_dir(song).glob("*/cover.toml")),
        key=lambda p: p.stat().st_mtime,
    )
    if not found:
        raise StageError(f"no cover sessions for {song.slug}; run `drums cover-session` first")
    return Session(song, found[-1].parent.name)


# Saved kits for re-rendering a take: shared by every song and session.
KITS_DIR = Path(__file__).resolve().parent.parent / "kit" / "cover-kits"


def kit_state(name: str) -> Path:
    return KITS_DIR / f"{name}.state"
