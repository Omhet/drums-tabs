"""Tempo-straightened renders for authoring in a DAW.

A human drummer drifts. Over a three-minute song that is a couple of beats of
slip against a DAW's constant grid, so writing MIDI against the raw audio stops
lining up after a minute. Instead of fighting that in the DAW, warp the audio so
that every beat in ``grid.lock.json`` lands exactly ``60 / bpm`` seconds after
the previous one, starting at bar 1. Set the DAW project to ``bpm``, drop the
render at 1|1|1, and bar *k* of the DAW is bar *k* of the song for the whole
take. The player maps bars back through the same beat array, so nothing is lost
in the round trip.

The warp is a continuous varispeed -- the audio is resampled along a piecewise-
linear time map, exactly what Ableton's "Re-Pitch" warp mode does. With ~1%
drift the pitch moves by a few cents, inaudible, and unlike a phase vocoder run
per beat there are no splice artifacts at the beat boundaries.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.ndimage import map_coordinates

from pipeline import paths
from pipeline.grid import Grid
from pipeline.proc import StageError

# Which stems get straightened. drums is what you transcribe from; nodrums is
# what you play along to; mix for when you want both in one file.
SOURCES = ("mix", "drums", "nodrums")


@dataclass(frozen=True)
class StraightInfo:
    bpm: float
    beats_per_bar: int
    start_beat: int  # index into grid.beats of bar 1
    start_time: float  # seconds into the original media where bar 1 begins
    beat_count: int  # beats covered by the warp, from bar 1 to the last beat
    written: tuple[Path, ...]


# Beats either side that vote on the local tempo when smoothing. Nine beats is
# two bars: long enough to average out the detector's rounding, short enough
# that a real ritardando still comes through.
SMOOTH_WINDOW = 9


def smooth_beats(beats: np.ndarray, window: int = SMOOTH_WINDOW) -> np.ndarray:
    """Fit a smooth tempo curve through the detector's rounded beat times.

    ``beat_this`` runs at 50 frames per second, so every beat time in the grid
    is a multiple of 20 ms: consecutive intervals read 640, 660, 680 ms while
    the drummer is really playing a steady 660 with a slow drift. Warping beat
    by beat on those raw values changes the playback speed by 3% at every beat
    boundary -- half a semitone of pitch, audible as a wobble on anything
    tonal. A local quadratic fit (linear tempo within the window) removes the
    rounding while keeping the drift; hits land within ~10 ms of the smoothed
    beat, which is inside the detector's own error anyway.
    """
    from scipy.signal import savgol_filter

    if beats.size < window:
        return beats
    return savgol_filter(beats, window_length=window, polyorder=2, mode="interp")


def time_map(grid: Grid, bpm: float) -> tuple[np.ndarray, np.ndarray]:
    """Return ``(straight_times, original_times)`` for every beat from bar 1.

    Bar 1 starts at 0 in straight time. Beats after the last detected one don't
    exist, so the tail of the file (outro, ringing) is carried at the median
    beat ratio, which is ~1.0 and keeps the ending audible.
    """
    beats = np.asarray(grid.beats, dtype=np.float64)[grid.bar_one_beat :]
    if beats.size < 2:
        raise StageError("grid has fewer than two beats after bar 1; nothing to straighten")
    period = 60.0 / bpm
    straight = np.arange(beats.size, dtype=np.float64) * period
    return straight, smooth_beats(beats)


def _warp(y: np.ndarray, sr: int, straight: np.ndarray, original: np.ndarray) -> np.ndarray:
    """Resample ``y`` (frames x channels) along the piecewise-linear map."""
    intervals = np.diff(original)
    tail_ratio = float(np.median(intervals)) / (straight[1] - straight[0])
    duration = y.shape[0] / sr
    tail_original = duration - original[-1]
    if tail_original <= 0:
        raise StageError("last beat lies past the end of the audio; grid and audio disagree")
    # Extend the map to the end of the file at the median ratio.
    straight = np.append(straight, straight[-1] + tail_original / tail_ratio)
    original = np.append(original, duration)

    out_frames = int(np.floor(straight[-1] * sr))
    t_out = np.arange(out_frames, dtype=np.float64) / sr
    src = np.interp(t_out, straight, original) * sr  # fractional source frame index
    src = np.clip(src, 0, y.shape[0] - 1)

    out = np.empty((out_frames, y.shape[1]), dtype=np.float32)
    for ch in range(y.shape[1]):
        out[:, ch] = map_coordinates(y[:, ch], [src], order=3, mode="nearest")
    return out


def straighten(song: paths.Song, grid: Grid, *, bpm: float | None = None) -> StraightInfo:
    target_bpm = float(bpm) if bpm else float(round(grid.score.bpm))
    straight, original = time_map(grid, target_bpm)
    written: list[Path] = []
    locked: list[Path] = []
    for name in SOURCES:
        source = {"mix": song.mix, "drums": song.drums, "nodrums": song.nodrums}[name]
        if not source.exists():
            continue
        y, sr = sf.read(str(source), always_2d=True, dtype="float32")
        out = _warp(y, sr, straight, original)
        dest = song.straight(name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            sf.write(str(dest), out, sr, subtype="PCM_16")
        except sf.LibsndfileError:
            # A DAW with the file loaded holds it open. Render the rest anyway
            # and say which ones are stale, rather than stopping at the first.
            locked.append(dest)
            continue
        written.append(dest)
    if locked:
        names = ", ".join(p.name for p in locked)
        raise StageError(
            f"could not overwrite {names}: open in another program (Ableton?). "
            "Close it and run straighten again; the other renders are up to date."
        )
    if not written:
        raise StageError("no audio to straighten; run `drums fetch` and `drums separate` first")

    info = StraightInfo(
        bpm=target_bpm,
        beats_per_bar=grid.beats_per_bar,
        start_beat=grid.bar_one_beat,
        start_time=float(original[0]),
        beat_count=int(original.size),
        written=tuple(written),
    )
    song.straight_json.write_text(
        json.dumps(
            {
                "bpm": info.bpm,
                "beats_per_bar": info.beats_per_bar,
                "start_beat": info.start_beat,
                "start_time": info.start_time,
                "beat_count": info.beat_count,
                "files": [p.name for p in written],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return info


def render_check_click(song: paths.Song, info: StraightInfo, *, stem_gain: float = 0.6) -> Path:
    """A constant-tempo click over the straightened mix.

    If the warp is right, this click sits on every hit for the whole song. If it
    drifts, the beat map is wrong somewhere and the DAW grid would be too.
    """
    from pipeline.audit import _click  # shared click synth

    source = song.straight("mix") if song.straight("mix").exists() else info.written[0]
    data, sr = sf.read(str(source), always_2d=True, dtype="float32")
    track = data.mean(axis=1) * stem_gain
    period = 60.0 / info.bpm
    downbeat = _click(sr, 1600.0)
    offbeat = _click(sr, 900.0)
    beat = 0
    while True:
        start = int(round(beat * period * sr))
        if start >= track.size:
            break
        click = downbeat if beat % info.beats_per_bar == 0 else offbeat
        end = min(track.size, start + click.size)
        track[start:end] += click[: end - start] * 0.5
        beat += 1
    peak = float(np.max(np.abs(track))) or 1.0
    if peak > 0.99:
        track *= 0.99 / peak
    song.debug_dir.mkdir(parents=True, exist_ok=True)
    out = song.debug_dir / "straight_click.wav"
    sf.write(str(out), track, sr, subtype="PCM_16")
    return out
