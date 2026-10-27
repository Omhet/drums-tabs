"""A recorded cover: one session folder, its settings, and the clock the tab runs on.

Everything the cover commands make or read lives under one session folder,
``songs/<slug>/covers/<name>/``, which is also the Ableton project the
generated set is saved into -- so Live's own recordings land in its
``Samples/Recorded/`` beside everything else::

    cover.toml              settings and every measured number (offsets, crops)
    <name>.als              the generated Live set
    Samples/Recorded/       what Live recorded (audio passes)
    raw/                    main.* and foot.* (the two phones) and the raw MIDI log
    work/                   intermediates: mix, renders, tab strip, frames
    out/                    the finished videos

**The timeline.** Every time in seconds in the cover code is on Live's
arrangement timeline, 0 at 1|1|1. The final mix starts there too, so mix time
and arrangement time are the same thing. A camera file is mapped onto it by
the offset ``cover-sync`` measures.

**Two timings** (see ``Timing``) differ only in where the song's beats fall on
that timeline, which is what :class:`Clock` holds.

**The count-in** is a fact of the session, not of the code: ``cover.toml
[session]`` holds ``count_in_bars`` and the ``stem_start_beats`` it led to
(:func:`stem_start_for`), and everything that places the song on the timeline
-- the clock, the backing, the Live set -- reads them from there. A session
recorded with one count-in keeps it whatever the default becomes.
"""

from __future__ import annotations

import json
import math
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
#: A new session's count-in, in bars of the click.
COUNT_IN_BARS = 2
#: The two cameras, by role: the side-front shot of the player, and the right
#: foot on the kick pedal. Each is ``raw/<role>.<ext>``.
CAMERAS = ("main", "foot")


class Timing(str, Enum):
    """How the song's beats are laid on the arrangement.

    ``straight``: the pitch-kept stretched stems at a constant tempo, starting
    after the count-in. ``original``: the stems untouched, with a click that
    follows the record's own beat map, starting as early as the count-in allows.
    """

    straight = "straight"
    original = "original"


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


def stem_start_for(song: paths.Song, timing: Timing, count_in_bars: int) -> float:
    """Where a new session's song stems start on the arrangement, in Live beats.

    Straight: right after the count-in, ``count_in_bars`` bars of the click at
    ``LIVE_TEMPO``. Original: the count-in runs at the record's opening beat
    spacing and has to fit before bar 1 -- Song 2's bar 1 is 2.02 s into the
    stems, room for one bar at its 0.46 s a beat but not for two -- so the
    stems start at the fewest whole Live bars that make it fit.
    """
    if count_in_bars < 1:
        raise StageError(f"a count-in of {count_in_bars} bars: it needs at least one")
    if timing is Timing.straight:
        return float(count_in_bars * BEATS_PER_BAR)
    beats = original_beats(song)
    need_s = count_in_bars * BEATS_PER_BAR * (beats[1] - beats[0]) - beats[0]
    bar_s = BEATS_PER_BAR * 60.0 / LIVE_TEMPO
    return float(max(0, math.ceil(need_s / bar_s - 1e-9)) * BEATS_PER_BAR)


def clock_for(song: paths.Song, timing: Timing, stem_start_beats: float) -> Clock:
    """The chart's beats on the arrangement, the stems starting at ``stem_start_beats``."""
    start = stem_start_beats * 60.0 / LIVE_TEMPO
    if timing is Timing.straight:
        bpm = straight_bpm(song)
        count = original_beats(song).size
        return Clock(start + np.arange(count, dtype=np.float64) * 60.0 / bpm)
    return Clock(start + original_beats(song))


def stretched(song: paths.Song, name: str) -> Path:
    """A pitch-kept constant-tempo stem (``nodrums``, ``drums``, ``mix``)."""
    return song.stems_dir / f"stretched-{name}.wav"


def click_track(song: paths.Song, timing: Timing, count_in_bars: int) -> Path:
    return song.stems_dir / f"click-{timing.value}-{count_in_bars}bar.wav"


def backing(song: paths.Song, timing: Timing, count_in_bars: int) -> dict[str, Path]:
    """The audio tracks a cover set plays, by track name, click last.

    Each file starts at the session's ``stem_start_beats`` on the arrangement
    except the click, which always starts at 1|1|1 and carries its own count-in.
    """
    if timing is Timing.straight:
        tracks = {"nodrums": stretched(song, "nodrums"), "drums": stretched(song, "drums")}
    else:
        tracks = {"nodrums": song.nodrums, "drums": song.drums}
    tracks["click"] = click_track(song, timing, count_in_bars)
    return tracks


#: What :func:`readable_recording` says when Live holds a file. ">" rather than
#: an arrow: piped, Windows' cp1252 stdout cannot encode one, and the message
#: would become a crash.
LIVE_HOLDS_RECORDINGS = (
    "Live is holding this session's recordings — close the set in Live "
    "(quit Live or File > New), then run this again."
)


def readable_recording(path: Path) -> Path:
    """``path``, once it is known to open for reading.

    While a set is open Live keeps its recordings open with no sharing, so
    reading one raises ``PermissionError`` -- which soundfile reports only as
    "System error" and ffmpeg as a failed decode. Every reader of
    ``Samples/Recorded`` comes through here first.
    """
    try:
        with open(path, "rb"):
            pass
    except PermissionError as exc:
        raise StageError(f"{LIVE_HOLDS_RECORDINGS}\n  ({Path(path).name})") from exc
    return path


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

    def _session_value(self, key: str):
        section = self.settings().get("session", {})
        if key not in section:
            raise StageError(f"{self.toml} has no [session] {key}; make the session with `drums cover-session`")
        return section[key]

    @property
    def timing(self) -> Timing:
        return Timing(self._session_value("timing"))

    @property
    def count_in_bars(self) -> int:
        return int(self._session_value("count_in_bars"))

    @property
    def stem_start_beats(self) -> float:
        """Where the song stems start on the arrangement, in Live beats."""
        return float(self._session_value("stem_start_beats"))

    def backing(self) -> dict[str, Path]:
        return backing(self.song, self.timing, self.count_in_bars)

    def clock(self) -> Clock:
        return clock_for(self.song, self.timing, self.stem_start_beats)


def covers_dir(song: paths.Song) -> Path:
    return song.root / "covers"


def sessions(song: paths.Song) -> list[Session]:
    """Every session of a song that has a ``cover.toml``."""
    return [Session(song, p.parent.name) for p in sorted(covers_dir(song).glob("*/cover.toml"))]


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
