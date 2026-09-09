"""Band-limited SuperFlux onset envelopes.

Phase 1a needs only a fraction of what Phase 3 will: enough of a kick and snare
proxy, computed straight off ``drums.wav``, to sanity-check the beat grid's
tempo octave and downbeat phase. Per-drum stems (drumsep) don't exist yet at
this point in the pipeline, so the "snare" here is a frequency band, not a
source.

SuperFlux rather than plain spectral flux because its maximum-filtered lag
suppresses the decaying broadband content -- cymbal wash -- that produces most
false onsets on a drum stem. The Phase 3 detector deepens this file; nothing
here should need replacing, only extending.
"""

from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np

HOP_LENGTH = 256  # 5.8 ms at 44.1 kHz -- finer than any grid subdivision we snap to
N_FFT = 2048

# How far below a band's loud level a frame can sit before its flux is ignored.
# Spectral flux is computed on a dB scale, where silence sits at the floor, so a
# barely-audible noise in an intro produces a *larger* dB jump than a real hit
# does in a loud chorus. Without this gate a room creak outranks a snare.
GATE_RANGE_DB = 40.0

# Frequency bands per instrument. Grid repair uses only kick and snare; the rest
# are here because the ranges belong in one place, not scattered across callers.
BANDS: dict[str, tuple[float, float]] = {
    "kick": (30.0, 120.0),
    "snare_body": (150.0, 400.0),
    "snare_crack": (2000.0, 6000.0),
    "toms": (80.0, 350.0),
    "hihat": (5000.0, 12000.0),
    "ride": (3000.0, 10000.0),
    "crash": (2000.0, 8000.0),
}


def load_mono(path: Path, sr: int | None = None) -> tuple[np.ndarray, int]:
    """Load audio as mono float32 at its native rate unless told otherwise."""
    y, rate = librosa.load(str(path), sr=sr, mono=True)
    return y.astype(np.float32), int(rate)


def superflux(
    y: np.ndarray, sr: int, fmin: float, fmax: float, *, hop: int = HOP_LENGTH
) -> np.ndarray:
    """SuperFlux onset strength restricted to one frequency band.

    ``lag=2`` compares against the frame two back rather than the previous one,
    and ``max_size=3`` maximum-filters across mel bins first; together those are
    what make it robust to vibrato and to slowly-decaying cymbals.
    """
    fmax = min(fmax, sr / 2 - 1)
    # A 2048-point FFT at 44.1 kHz has 21.5 Hz bins, so the kick band (30-120 Hz)
    # spans about four of them. Asking for 64 mel filters across four bins gives
    # mostly empty ones -- librosa warns, and the empty channels dilute the flux.
    bins_in_band = int((fmax - fmin) / (sr / N_FFT))
    n_mels = int(np.clip(bins_in_band, 4, 64))
    spectrum = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=hop))
    mel = librosa.feature.melspectrogram(
        S=spectrum**2, sr=sr, n_mels=n_mels, fmin=fmin, fmax=fmax
    )
    env = librosa.onset.onset_strength(
        S=librosa.power_to_db(mel, ref=np.max), sr=sr, hop_length=hop, lag=2, max_size=3
    )
    return np.asarray(env * _level_gate(mel), dtype=np.float32)


def _level_gate(mel: np.ndarray) -> np.ndarray:
    """Per-frame weight in [0, 1] from the band's absolute level.

    Frames more than :data:`GATE_RANGE_DB` below the band's loud level are
    silenced and it ramps in linearly above that, so quiet passages can still
    contribute -- proportionally to how much signal is actually there.
    """
    level = librosa.power_to_db(mel.sum(axis=0), ref=np.max)
    loud = float(np.percentile(level, 95.0))
    return np.clip((level - (loud - GATE_RANGE_DB)) / GATE_RANGE_DB, 0.0, 1.0)


def envelope_times(n_frames: int, sr: int, *, hop: int = HOP_LENGTH) -> np.ndarray:
    return librosa.frames_to_time(np.arange(n_frames), sr=sr, hop_length=hop)


def normalize(env: np.ndarray) -> np.ndarray:
    """Scale to roughly [0, 1] using a high percentile, not the max.

    The maximum is one sample of one event -- often a crash -- so dividing by it
    makes every other hit look weak. The 95th percentile is stable enough to
    compare bands against each other.
    """
    reference = float(np.percentile(env, 95.0)) if env.size else 0.0
    if reference <= 1e-9:
        return np.zeros_like(env)
    return np.clip(env / reference, 0.0, None)


def support_at(
    env: np.ndarray,
    times: np.ndarray,
    query: np.ndarray,
    *,
    window: float = 0.045,
) -> np.ndarray:
    """Peak envelope value within +/-``window`` of each query time.

    A window rather than a point sample because detected beats and played hits
    disagree by tens of milliseconds even when both are right -- drummers push
    and drag, and that's the thing being measured, not an error.
    """
    if env.size == 0 or query.size == 0:
        return np.zeros(query.shape, dtype=float)
    half = max(1, int(round(window / (times[1] - times[0])))) if times.size > 1 else 1
    indices = np.searchsorted(times, query)
    out = np.empty(query.shape, dtype=float)
    for i, centre in enumerate(indices):
        lo = max(0, centre - half)
        hi = min(env.size, centre + half + 1)
        out[i] = float(env[lo:hi].max()) if hi > lo else 0.0
    return out


def first_strong_onset(
    env: np.ndarray,
    times: np.ndarray,
    *,
    threshold: float = 0.35,
    sustain: float = 2.0,
    min_hits: int = 3,
) -> float | None:
    """Time of the first onset that's part of actual playing, not a stray noise.

    "Part of playing" means at least ``min_hits`` further onsets within the next
    ``sustain`` seconds. Without that, one isolated transient in the intro -- a
    stick click, or separation bleed from a synth -- sets bar 1 to the wrong
    place, and every bar number in the score is off.

    Note the count is over *peak-picked* onsets, not over frames above the
    threshold. A single hit occupies several consecutive frames, so counting
    frames makes any one loud transient look like a burst of playing.
    """
    events = pick_onsets(env, times, delta=threshold)
    if events.size == 0:
        return None
    for start in events:
        following = events[(events > start) & (events <= start + sustain)]
        if following.size >= min_hits:
            return float(start)
    return None


def pick_onsets(
    env: np.ndarray,
    times: np.ndarray,
    *,
    delta: float = 0.10,
    wait: float = 0.03,
) -> np.ndarray:
    """Peak-pick an onset envelope into event times.

    Phase 1a uses this only for *display* -- the grid inspector's phase scatter --
    so the parameters are loose on purpose. The detector that feeds the score
    lives in Phase 3 and gets adaptive thresholds and per-instrument min-IOI.
    """
    if env.size < 3:
        return np.empty(0, dtype=float)
    frame_rate = 1.0 / (times[1] - times[0])
    wait_frames = max(1, int(round(wait * frame_rate)))
    peaks = librosa.util.peak_pick(
        env,
        pre_max=wait_frames,
        post_max=wait_frames,
        pre_avg=int(frame_rate * 0.10),
        post_avg=int(frame_rate * 0.10),
        delta=delta,
        wait=wait_frames,
    )
    return times[peaks]
