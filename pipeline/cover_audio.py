"""The audio a cover set plays: pitch-kept stretched stems and the two click tracks.

**Stretched stems** (``Timing.straight``). ``drums straighten`` already lays
the song on a constant grid, but by resampling -- varispeed, the pitch moving a
few cents with the drummer's drift. For a cover that is played along to and
mixed into a video, the pitch should stay put. Same beat-to-time map
(:func:`pipeline.straighten.time_map`: bar 1 at 0, every beat ``60 / bpm``
after the last, the tail at the median ratio), but time-stretched with ffmpeg's
``rubberband`` filter, the ``tempo`` set beat by beat from an ``asendcmd``
script: for each beat, original beat length / straight beat length.

A tempo command takes effect on the next audio frame the filter sees, and the
stretcher's latency is only compensated exactly at tempo 1: away from it a hit
lands about 45 ms x (tempo - 1) off -- +0.45 ms at 1% fast, which is all
Song 2 asks for (its beats run 0.987-1.016 of 130). So the result is not
trusted blind: :func:`measure` finds the hits in the output drum stem and
compares them with where the map says they belong.

**Click tracks**, one per timing and count-in (``click-straight-2bar.wav``).
Each starts at 1|1|1 and carries its own count-in of whole bars; the stems
start where :func:`pipeline.cover.stem_start_for` puts them. Straight: a
steady ``LIVE_TEMPO`` click, the count-in's beats counting in the stems that
start right after them. Original: a click on every beat of ``grid.lock.json``
with the count-in's beats before bar 1 at the opening beat spacing, and two
bars past the last beat at the closing spacing.
"""

from __future__ import annotations

import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from pipeline import cover, paths
from pipeline.proc import StageError, require_on_path

SR = 44100
STEMS = ("nodrums", "drums", "mix")

# Audio frames the stretcher sees per tempo command's resolution. A command
# lands at the start of the first frame at or after its time; 256 samples is
# 5.8 ms, and at a 1% tempo change that is 0.06 ms of placement error.
FRAME = 256

CLICK_PEAK = 0.8
DOWNBEAT_HZ = 1600.0
OFFBEAT_HZ = 900.0
OFFBEAT_GAIN = 0.6  # relative to the downbeat
ORIGINAL_TAIL_BARS = 2
CLICK_LENGTH = 0.035  # audit._click's default duration


# --- the map -----------------------------------------------------------------


def stem_source(song: paths.Song, name: str) -> Path:
    return {"mix": song.mix, "drums": song.drums, "nodrums": song.nodrums}[name]


def song_map(song: paths.Song) -> tuple[np.ndarray, np.ndarray]:
    """``(straight, original)`` beat times from bar 1, as ``drums straighten`` uses."""
    from pipeline import grid as grid_mod
    from pipeline.straighten import time_map

    return time_map(grid_mod.load(song), cover.straight_bpm(song))


def extend_map(straight: np.ndarray, original: np.ndarray, duration: float) -> tuple[np.ndarray, np.ndarray]:
    """Carry the map to the end of the audio at the median beat ratio (as ``_warp``)."""
    tail_ratio = float(np.median(np.diff(original))) / float(straight[1] - straight[0])
    tail = duration - original[-1]
    if tail <= 0:
        raise StageError("last beat lies past the end of the audio; grid and audio disagree")
    return (
        np.append(straight, straight[-1] + tail / tail_ratio),
        np.append(original, duration),
    )


def tempo_script(straight: np.ndarray, original: np.ndarray) -> str:
    """One ``asendcmd`` line per beat, times in seconds after bar 1 of the input."""
    lines = []
    for k in range(straight.size - 1):
        tempo = (original[k + 1] - original[k]) / (straight[k + 1] - straight[k])
        lines.append(f"{original[k] - original[0]:.6f} rubberband@rb tempo {tempo:.9f};")
    return "\n".join(lines) + "\n"


# --- stretching --------------------------------------------------------------


def stretch(source: Path, dest: Path, straight: np.ndarray, original: np.ndarray) -> Path:
    """Write ``source`` stretched along the map, bar 1 at 0, pitch kept.

    ``straight``/``original`` are beat times from bar 1; the map is extended to
    the end of the file here. 44.1 kHz stereo PCM_16, the length the map gives.
    """
    ffmpeg = require_on_path("ffmpeg")
    duration = sf.info(str(source)).duration
    straight, original = extend_map(straight, original, duration)
    frames = int(round((straight[-1] - straight[0]) * SR))
    first_tempo = (original[1] - original[0]) / (straight[1] - straight[0])

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "tempo.txt").write_text(tempo_script(straight, original), encoding="ascii")
        graph = (
            f"aresample={SR},aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"atrim=start={original[0]:.6f},asetpts=PTS-STARTPTS,"
            f"asetnsamples=n={FRAME}:p=0,"
            "asendcmd=f=tempo.txt,"
            f"rubberband@rb=tempo={first_tempo:.9f}:pitch=1:pitchq=quality"
        )
        cmd = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source.resolve()), "-af", graph,
            "-f", "f32le", "-ac", "2", "-ar", str(SR), "-",
        ]  # fmt: skip
        result = subprocess.run(cmd, capture_output=True, cwd=work, check=False)
    if result.returncode != 0:
        raise StageError(f"ffmpeg rubberband failed on {source.name}: {result.stderr.decode(errors='replace').strip()}")
    out = np.frombuffer(result.stdout, dtype=np.float32).reshape(-1, 2)
    if out.shape[0] >= frames:
        out = out[:frames]
    else:
        out = np.concatenate([out, np.zeros((frames - out.shape[0], 2), dtype=np.float32)])
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        sf.write(str(dest), np.clip(out, -1.0, 1.0), SR, subtype="PCM_16")
    except sf.LibsndfileError as exc:
        raise StageError(f"could not write {dest.name}: open in another program (Ableton?)") from exc
    return dest


# --- measuring ---------------------------------------------------------------

ONSET_HOP = 64  # 1.45 ms at 44.1 kHz
ONSET_FLOOR = 0.3  # of the envelope's 99th percentile


def onsets(y: np.ndarray, sr: int) -> np.ndarray:
    """Hit times in seconds: peaks of the onset envelope, refined to the sample."""
    import librosa
    from scipy.signal import find_peaks

    env = librosa.onset.onset_strength(
        y=y, sr=sr, hop_length=ONSET_HOP, n_fft=512, n_mels=40, lag=1, max_size=1, center=True
    )
    # Hits clearly above the bed, at least 50 ms apart (a 16th at 300 BPM).
    floor = float(np.percentile(env, 99)) * ONSET_FLOOR
    frames, _ = find_peaks(env, height=floor, distance=max(1, int(0.05 * sr / ONSET_HOP)))
    # Parabolic interpolation around each envelope peak, for sub-hop precision.
    out = []
    for f in frames:
        if 0 < f < env.size - 1:
            a, b, c = env[f - 1], env[f], env[f + 1]
            denom = a - 2 * b + c
            shift = 0.5 * (a - c) / denom if denom else 0.0
        else:
            shift = 0.0
        out.append((f + shift) * ONSET_HOP / sr)
    return np.asarray(out, dtype=np.float64)


@dataclass(frozen=True)
class Accuracy:
    """How far the stretched stem's hits sit from where the map puts them.

    Each hit found in the original is looked up in the stretch where the map
    says it should be, and the two short loudness envelopes around it are slid
    against each other; the best lag is that hit's error. Matching two lists of
    detected onsets instead reads a 40 ms "error" every time a detector splits
    a flam one way in one file and the other way in the other.
    """

    hits: int
    median_ms: float
    p95_ms: float
    max_ms: float
    offset_ms: float  # signed median over the whole song: a constant lag
    drift_ms: float  # worst DRIFT_WINDOW-second median, absolute: walking off


DRIFT_WINDOW = 10.0
LOOK_MS = 60.0  # envelope either side of a hit
SEARCH_MS = 25.0  # largest lag considered
ENV_SMOOTH = 64  # samples
ENV_STEP = 4  # envelope decimation: 0.09 ms a step at 44.1 kHz


def _envelope(y: np.ndarray) -> np.ndarray:
    smooth = np.convolve(np.abs(y), np.ones(ENV_SMOOTH) / ENV_SMOOTH, mode="same")
    return smooth[::ENV_STEP]


def hit_lags(a: np.ndarray, b: np.ndarray, at_a: np.ndarray, at_b: np.ndarray, sr: int) -> np.ndarray:
    """Seconds by which each hit in ``b`` (around ``at_b``) trails its twin in ``a``.

    Pearson correlation at every lag, not a raw dot product: unnormalised, the
    lag that drags the window onto the next loud hit wins.
    """
    from numpy.lib.stride_tricks import sliding_window_view

    rate = sr / ENV_STEP
    ea, eb = _envelope(a), _envelope(b)
    half = int(LOOK_MS / 1000 * rate)
    search = int(SEARCH_MS / 1000 * rate)
    lags = []
    for ta, tb in zip(at_a, at_b, strict=True):
        ia, ib = int(round(ta * rate)), int(round(tb * rate))
        if ia - half < 0 or ib - half - search < 0 or ia + half > ea.size or ib + half + search > eb.size:
            lags.append(np.nan)
            continue
        wa = ea[ia - half : ia + half]
        wa = (wa - wa.mean()) / (wa.std() or 1.0)
        segs = sliding_window_view(eb[ib - half - search : ib + half + search], wa.size)  # 2*search+1 lags
        segs = segs - segs.mean(axis=1, keepdims=True)
        r = segs @ wa / (np.linalg.norm(segs, axis=1) + 1e-12)
        lags.append((int(np.argmax(r)) - search) / rate)
    return np.asarray(lags)


def summarise(at: np.ndarray, err_ms: np.ndarray) -> Accuracy:
    ok = np.isfinite(err_ms)
    at, err_ms = at[ok], err_ms[ok]
    if err_ms.size == 0:
        raise StageError("no hits to measure the stretch by")
    windows = [err_ms[(at >= t) & (at < t + DRIFT_WINDOW)] for t in np.arange(0.0, at.max() + 1e-9, DRIFT_WINDOW)]
    a = np.abs(err_ms)
    return Accuracy(
        hits=int(err_ms.size),
        median_ms=float(np.median(a)),
        p95_ms=float(np.percentile(a, 95)),
        max_ms=float(a.max()),
        offset_ms=float(np.median(err_ms)),
        drift_ms=max(abs(float(np.median(w))) for w in windows if w.size),
    )


def measure(source: Path, stretched: Path, straight: np.ndarray, original: np.ndarray) -> Accuracy:
    """Where the stretched stem's hits land vs. where the map puts the original's."""
    y, sr = sf.read(str(source), always_2d=True, dtype="float32")
    z, sr2 = sf.read(str(stretched), always_2d=True, dtype="float32")
    if sr2 != sr:
        raise StageError(f"{stretched.name} is at {sr2} Hz, {source.name} at {sr}")
    y, z = y.mean(axis=1), z.mean(axis=1)
    straight, original = extend_map(straight, original, y.size / sr)
    hits = onsets(y, sr)
    hits = hits[(hits >= original[0] + 0.1) & (hits <= original[-2])]  # within the beat map
    expected = np.interp(hits, original, straight)
    return summarise(expected, hit_lags(y, z, hits, expected, sr) * 1000.0)


# --- clicks ------------------------------------------------------------------


def render_clicks(times: np.ndarray, accents: np.ndarray, length: int, sr: int = SR) -> np.ndarray:
    """A mono track of ``length`` frames with a click at each time (downbeats accented)."""
    from pipeline.audit import _click  # the shared click synth

    down = _click(sr, DOWNBEAT_HZ)
    off = _click(sr, OFFBEAT_HZ) * OFFBEAT_GAIN
    track = np.zeros(length, dtype=np.float64)
    for t, accent in zip(times, accents, strict=True):
        start = int(round(t * sr))
        if start < 0 or start >= length:
            continue
        click = down if accent else off
        end = min(length, start + click.size)
        track[start:end] += click[: end - start]
    peak = float(np.max(np.abs(track))) or 1.0
    return (track * (CLICK_PEAK / peak)).astype(np.float32)


def straight_clicks(duration: float, bpm: float = cover.LIVE_TEMPO) -> tuple[np.ndarray, np.ndarray]:
    """Beat times from 0 to ``duration`` at ``bpm``; beat 0 (and every 4th) accented.

    The first ``count_in_bars`` bars of them are the count-in; the stems start after.
    """
    period = 60.0 / bpm
    count = int(np.floor(duration / period - 1e-9)) + 1
    k = np.arange(count)
    return k * period, k % cover.BEATS_PER_BAR == 0


def original_clicks(beats: np.ndarray, count_in_bars: int) -> tuple[np.ndarray, np.ndarray]:
    """``beats`` (bar 1 first, timeline seconds) with a count-in before and two bars of tail."""
    if beats.size < 2:
        raise StageError("need at least two beats for a click")
    bar = cover.BEATS_PER_BAR
    lead_beats = count_in_bars * bar
    head_gap = beats[1] - beats[0]
    tail_gap = beats[-1] - beats[-2]
    lead = beats[0] - head_gap * np.arange(lead_beats, 0, -1)
    if lead[0] < -1e-9:
        raise StageError(
            f"bar 1 is at {beats[0]:.2f}s, too early for a {lead_beats}-beat count-in at {head_gap:.3f}s a beat"
        )
    tail = beats[-1] + tail_gap * np.arange(1, ORIGINAL_TAIL_BARS * bar + 1)
    times = np.concatenate([lead, beats, tail])
    # Bar 1's downbeat is index ``lead_beats`` in ``times``; the count-in is whole bars.
    accents = np.arange(times.size) % bar == 0
    return times, accents


def write_click(dest: Path, times: np.ndarray, accents: np.ndarray, length: int) -> Path:
    track = render_clicks(times, accents, length)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        sf.write(str(dest), np.stack([track, track], axis=1), SR, subtype="PCM_16")
    except sf.LibsndfileError as exc:
        raise StageError(f"could not write {dest.name}: open in another program (Ableton?)") from exc
    return dest


def build_click(song: paths.Song, timing: cover.Timing, count_in_bars: int) -> Path:
    """The click for one timing and count-in, from 1|1|1."""
    dest = cover.click_track(song, timing, count_in_bars)
    lead = cover.stem_start_for(song, timing, count_in_bars) * 60.0 / cover.LIVE_TEMPO
    if timing is cover.Timing.straight:
        stem = cover.stretched(song, "nodrums")
        if not stem.exists():
            raise StageError(f"no {stem.name}; stretch the stems first")
        duration = lead + sf.info(str(stem)).duration
        times, accents = straight_clicks(duration)
    else:
        times, accents = original_clicks(lead + cover.original_beats(song), count_in_bars)
        # The stem's length, unless the two tail bars run past it (Song 2's do,
        # by two seconds: its last beat is close to the end of the file).
        duration = max(lead + sf.info(str(song.nodrums)).duration, times[-1] + CLICK_LENGTH)
    return write_click(dest, times, accents, int(round(duration * SR)))


# --- the whole step ----------------------------------------------------------


@dataclass(frozen=True)
class CoverAudio:
    written: tuple[Path, ...]
    skipped: tuple[Path, ...]
    accuracy: Accuracy  # of the drum stem, measured every run (a few seconds)


def _stale(dest: Path, *inputs: Path) -> bool:
    if not dest.exists():
        return True
    newest = max(p.stat().st_mtime for p in inputs if p.exists())
    return dest.stat().st_mtime < newest


def build(song: paths.Song, *, force: bool = False) -> CoverAudio:
    bpm = cover.straight_bpm(song)
    if bpm != cover.LIVE_TEMPO:
        raise StageError(
            f"{song.straight_json.name} is at {bpm:g} BPM but the cover set runs at {cover.LIVE_TEMPO:g}; "
            f"run `drums straighten {song.slug} --bpm {cover.LIVE_TEMPO:g}`"
        )
    straight, original = song_map(song)
    inputs = (song.grid_lock, song.straight_json)
    written: list[Path] = []
    skipped: list[Path] = []
    for name in STEMS:
        source = stem_source(song, name)
        if not source.exists():
            raise StageError(f"no {source}; run `drums separate {song.slug}` first")
        dest = cover.stretched(song, name)
        if force or _stale(dest, source, *inputs):
            written.append(stretch(source, dest, straight, original))
        else:
            skipped.append(dest)
    accuracy = measure(song.drums, cover.stretched(song, "drums"), straight, original)
    # A new session's count-in, and whatever the song's sessions were made with.
    count_ins = sorted({cover.COUNT_IN_BARS} | {s.count_in_bars for s in cover.sessions(song)})
    for timing in cover.Timing:
        deps = (cover.stretched(song, "nodrums"),) if timing is cover.Timing.straight else (song.nodrums,)
        for bars in count_ins:
            dest = cover.click_track(song, timing, bars)
            if force or _stale(dest, *deps, *inputs):
                written.append(build_click(song, timing, bars))
            else:
                skipped.append(dest)
    return CoverAudio(tuple(written), tuple(skipped), accuracy)
