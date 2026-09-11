"""Where the video's own soundtrack sits relative to ``mix.wav``.

The beat map, the stems and everything derived from them live on the timeline
of ``audio/mix.wav``, which is decoded from YouTube's best audio-only stream.
``audio/video.mp4`` is a separate download whose AAC track is cut a few tens
of milliseconds differently. The player uses the video as its clock, so it
needs to know that offset: without it the cursor, the stems and the click all
land that far from what the video shows.

The offset is measured by cross-correlating the two soundtracks in a few
windows spread over the song. It must be the same in every window (a constant
shift, not a drift), otherwise something is wrong with the media and the
measurement is refused rather than pinned.

Convention: ``video_offset_ms = video time - mix time``. Positive means a beat
appears in the video later than in the mix.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from pipeline import grid as grid_mod
from pipeline import paths
from pipeline.grid import Grid
from pipeline.proc import StageError, require_on_path

SAMPLE_RATE = 44100
WINDOW_S = 20.0
MAX_LAG_S = 2.0
# Fractions of the song to measure at: early, middle, late.
WINDOW_STARTS = (0.05, 0.3, 0.5, 0.7, 0.9)
MAX_SPREAD_MS = 5.0
MIN_CORRELATION = 0.5


@dataclass(frozen=True)
class Window:
    start_s: float
    offset_ms: float
    correlation: float


@dataclass(frozen=True)
class AlignInfo:
    offset_ms: float
    windows: list[Window]


def lag_ms(
    reference: np.ndarray,
    signal: np.ndarray,
    sr: int,
    *,
    start_s: float,
    window_s: float = WINDOW_S,
    max_lag_s: float = MAX_LAG_S,
) -> tuple[float, float]:
    """How much later ``signal``'s content at ``start_s`` appears in ``reference``.

    Takes ``window_s`` of ``signal`` from ``start_s`` and slides it over the
    matching stretch of ``reference`` (plus ``max_lag_s`` either side) by FFT
    cross-correlation. Returns (lag in ms, normalised correlation at the peak).
    Positive lag: the reference is behind the signal.
    """
    i0 = int(start_s * sr)
    n = int(window_s * sr)
    max_lag = int(max_lag_s * sr)
    segment = signal[i0 : i0 + n]
    ref_start = max(0, i0 - max_lag)
    ref = reference[ref_start : i0 + n + max_lag]
    if segment.size < n or ref.size <= segment.size:
        raise StageError(f"not enough audio to correlate {window_s:g}s at {start_s:.1f}s")
    segment = segment - segment.mean()
    ref = ref - ref.mean()
    size = 1 << int(np.ceil(np.log2(ref.size + segment.size)))
    corr = np.fft.irfft(np.fft.rfft(ref, size) * np.conj(np.fft.rfft(segment, size)), size)
    corr = corr[: ref.size - segment.size + 1]
    peak = int(np.argmax(corr))
    norm = float(np.sqrt((ref**2).sum() * (segment**2).sum())) or 1.0
    return (peak - (i0 - ref_start)) / sr * 1000.0, float(corr[peak] / norm)


def measure_offset(video_audio: np.ndarray, mix: np.ndarray, sr: int) -> AlignInfo:
    """The constant offset between two mono renderings of the same performance."""
    duration = min(video_audio.size, mix.size) / sr
    if duration < WINDOW_S + 2 * MAX_LAG_S:
        raise StageError(f"song too short to align ({duration:.1f}s)")
    windows: list[Window] = []
    for fraction in WINDOW_STARTS:
        start = min(fraction * duration, duration - WINDOW_S - MAX_LAG_S)
        start = max(start, MAX_LAG_S)
        ms, corr = lag_ms(video_audio, mix, sr, start_s=start)
        windows.append(Window(start_s=start, offset_ms=ms, correlation=corr))

    weak = [w for w in windows if w.correlation < MIN_CORRELATION]
    if weak:
        raise StageError(
            "video and mix do not correlate at "
            + ", ".join(f"{w.start_s:.0f}s ({w.correlation:.2f})" for w in weak)
            + " -- are they the same performance?"
        )
    offsets = np.array([w.offset_ms for w in windows])
    spread = float(offsets.max() - offsets.min())
    if spread > MAX_SPREAD_MS:
        raise StageError(
            f"video/mix offset is not constant (spread {spread:.1f} ms across the song): "
            + ", ".join(f"{w.offset_ms:+.1f}" for w in windows)
        )
    return AlignInfo(offset_ms=float(np.median(offsets)), windows=windows)


def decode_mono(path: Path, sr: int = SAMPLE_RATE) -> np.ndarray:
    """The audio track of any container as float mono at ``sr``, via ffmpeg."""
    ffmpeg = require_on_path("ffmpeg")
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    result = subprocess.run(cmd, capture_output=True, check=False)
    if result.returncode != 0:
        raise StageError(f"ffmpeg could not decode {path}: {result.stderr.decode(errors='replace').strip()}")
    return np.frombuffer(result.stdout, dtype=np.float32)


def load_mono(path: Path, sr: int = SAMPLE_RATE) -> np.ndarray:
    data, rate = sf.read(path, dtype="float32", always_2d=True)
    if rate != sr:
        raise StageError(f"{path} is {rate} Hz, expected {sr}")
    return data.mean(axis=1)


def measure(song: paths.Song) -> AlignInfo:
    if not song.video.exists():
        raise StageError(f"no video at {song.video} -- run `drums fetch` with video")
    if not song.mix.exists():
        raise StageError(f"no mix at {song.mix} -- run `drums fetch` first")
    return measure_offset(decode_mono(song.video), load_mono(song.mix), SAMPLE_RATE)


def save(song: paths.Song, grid: Grid, info: AlignInfo) -> Path:
    """Pin the offset next to the beats it applies to."""
    grid.video_offset_ms = round(info.offset_ms, 2)
    return grid_mod.save(song, grid)
