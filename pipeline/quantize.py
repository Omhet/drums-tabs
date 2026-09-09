"""Snap detected onsets onto the beat grid. Pure arithmetic, no audio.

Everything here happens in *beat phase*, never in seconds: for an onset at time
``t`` between beats ``b_k`` and ``b_{k+1}``, its position is
``k + (t - b_k) / (b_{k+1} - b_k)``. That is what makes quantization immune to
tempo drift -- a beat that ran 4% long is still one beat wide in phase, so its
sixteenths are still at 0.25, 0.5 and 0.75 of it. Quantizing against a single
global BPM instead would accumulate half a beat of error over a four-minute song
and flip every note in the back half onto the wrong sixteenth.

**Phase 1b snaps everything to straight sixteenths.** Per-bar subdivision choice
(triplets, 32nds) is Phase 2's Viterbi pass; the seam for it is
:func:`quantize`'s ``subdivision`` argument, which is per-call today and becomes
per-bar then.

Two things are decided here rather than left to the emitter, because both are
about *time* and the emitter is about notation:

- **Same-slot dedup.** Two hits on one drum closer together than a slot both
  round to that slot. At 160 BPM a sixteenth is 94 ms, which is easily inside a
  flam or a buzz, so this is not an edge case -- it happens in most songs, and
  without dedup it emits a duplicate note that renders as a doubled notehead.
- **The count-in is dropped, not renumbered.** ``grid.lock.json`` pins bar 1;
  anything before it is the drummer counting off, and the score starts at 1.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from pipeline import articulations, paths
from pipeline.backends.base import OnsetEvent
from pipeline.grid import Grid, bar_position
from pipeline.proc import StageError

SCORE_VERSION = 1

# Sixteenths. The whole Phase 1b slice is deliberately straight -- see the
# module docstring.
SUBDIVISION = 4


@dataclass(frozen=True)
class Hit:
    """One note, at a slot index within its bar."""

    slot: int
    instrument: str
    velocity: float

    @property
    def is_feet(self) -> bool:
        return articulations.is_feet(self.instrument)


@dataclass
class Bar:
    """One bar of the score. ``index`` is 1-based, as printed in the notation."""

    index: int
    hits: list[Hit] = field(default_factory=list)


@dataclass
class Score:
    bpm: float
    beats_per_bar: int
    beat_unit: int
    subdivision: int
    bars: list[Bar]
    stats: dict = field(default_factory=dict)
    source: dict = field(default_factory=dict)

    @property
    def slots_per_bar(self) -> int:
        return self.beats_per_bar * self.subdivision

    @property
    def note_count(self) -> int:
        return sum(len(bar.hits) for bar in self.bars)


def quantize(
    grid: Grid, events: list[OnsetEvent], *, subdivision: int = SUBDIVISION
) -> Score:
    """Snap ``events`` onto ``grid`` and return the score they make."""
    slots_per_bar = grid.beats_per_bar * subdivision
    bars = [Bar(index=i) for i in range(1, grid.bar_count + 1)]

    stats: dict = {
        "onsets_in": len(events),
        "before_bar_one": 0,
        "after_last_bar": 0,
        "merged_duplicates": 0,
    }
    if not events:
        return _finish(grid, bars, subdivision, stats, [])

    times = np.array([e.t for e in events], dtype=float)
    bar_index, phase = bar_position(grid, times)

    # Round to the nearest slot, then let a hit that rounded up past the end of
    # its bar land on the downbeat of the next one -- playing a hair early is
    # the commonest thing a drummer does, and it must not be dropped.
    slot = np.rint(phase * subdivision).astype(int)
    carry = slot >= slots_per_bar
    bar_index = bar_index + carry
    slot = np.where(carry, 0, slot)

    # Snap error in beats, signed: negative means the hit was played early. Kept
    # as a statistic because a whole song biased one way means the grid's phase
    # is off, not that the drummer is.
    error_beats = slot / subdivision - phase
    error_beats = np.where(carry, error_beats + grid.beats_per_bar, error_beats)

    # (bar, slot, instrument) -> the loudest hit that landed there.
    placed: dict[tuple[int, int, str], Hit] = {}
    kept_errors: list[float] = []
    for event, b, s, err in zip(events, bar_index, slot, error_beats):
        if b < 1:
            stats["before_bar_one"] += 1
            continue
        if b > grid.bar_count:
            stats["after_last_bar"] += 1
            continue
        key = (int(b), int(s), event.instrument)
        existing = placed.get(key)
        if existing is not None:
            stats["merged_duplicates"] += 1
            if event.velocity <= existing.velocity:
                continue
        else:
            kept_errors.append(float(err))
        placed[key] = Hit(slot=int(s), instrument=event.instrument, velocity=event.velocity)

    for (b, _, _), hit in placed.items():
        bars[b - 1].hits.append(hit)
    for bar in bars:
        bar.hits.sort(key=lambda h: (h.slot, h.instrument))

    return _finish(grid, bars, subdivision, stats, kept_errors)


def _finish(
    grid: Grid, bars: list[Bar], subdivision: int, stats: dict, errors: list[float]
) -> Score:
    counts: dict[str, int] = {}
    for bar in bars:
        for hit in bar.hits:
            counts[hit.instrument] = counts.get(hit.instrument, 0) + 1
    stats["by_instrument"] = dict(sorted(counts.items()))
    stats["notes_out"] = sum(counts.values())
    stats["empty_bars"] = sum(1 for bar in bars if not bar.hits)

    bpm = grid.score.bpm or 120.0
    if errors:
        absolute_ms = np.abs(np.array(errors)) * (60_000.0 / bpm)
        stats["snap_error_ms"] = {
            "median": round(float(np.median(absolute_ms)), 1),
            "p90": round(float(np.percentile(absolute_ms, 90)), 1),
            # A signed mean well away from zero means the *grid* is early or
            # late, not the drummer -- one is fixable, the other is the music.
            "signed_mean": round(float(np.mean(errors)) * (60_000.0 / bpm), 1),
        }

    return Score(
        bpm=bpm,
        beats_per_bar=grid.beats_per_bar,
        beat_unit=int(grid.source.get("beat_unit", 4)),
        subdivision=subdivision,
        bars=bars,
        stats=stats,
        source={
            "grid_beats": int(grid.beats.size),
            "bar_one_beat": grid.bar_one_beat,
            "count_in_bars": grid.count_in_bars,
            "video_id": grid.source.get("video_id", ""),
        },
    )


def to_dict(score: Score) -> dict:
    return {
        "version": SCORE_VERSION,
        "tempo": round(score.bpm, 2),
        "meter": {"beats_per_bar": score.beats_per_bar, "beat_unit": score.beat_unit},
        "subdivision": score.subdivision,
        "stats": score.stats,
        "source": score.source,
        "bars": [
            {
                "bar": bar.index,
                "hits": [
                    {
                        "slot": hit.slot,
                        "instrument": hit.instrument,
                        "velocity": round(hit.velocity, 3),
                    }
                    for hit in bar.hits
                ],
            }
            for bar in score.bars
        ],
    }


def save(song: paths.Song, score: Score) -> Path:
    song.score_json.parent.mkdir(parents=True, exist_ok=True)
    song.score_json.write_text(json.dumps(to_dict(score), indent=2), encoding="utf-8")
    return song.score_json


def load(song: paths.Song) -> Score:
    if not song.score_json.exists():
        raise StageError(f"no score at {song.score_json} -- run `drums transcribe` first")
    data = json.loads(song.score_json.read_text(encoding="utf-8"))
    if data.get("version") != SCORE_VERSION:
        raise StageError(
            f"{song.score_json} is version {data.get('version')}, this build writes "
            f"{SCORE_VERSION} -- re-run `drums transcribe`"
        )
    return Score(
        bpm=data["tempo"],
        beats_per_bar=data["meter"]["beats_per_bar"],
        beat_unit=data["meter"]["beat_unit"],
        subdivision=data["subdivision"],
        bars=[
            Bar(
                index=bar["bar"],
                hits=[
                    Hit(
                        slot=hit["slot"],
                        instrument=hit["instrument"],
                        velocity=hit["velocity"],
                    )
                    for hit in bar["hits"]
                ],
            )
            for bar in data["bars"]
        ],
        stats=data.get("stats", {}),
        source=data.get("source", {}),
    )
