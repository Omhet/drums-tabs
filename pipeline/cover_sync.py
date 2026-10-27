"""Find where the chosen attempt sits in a camera file, and how fast its clock runs.

The cameras roll for the whole session, so a camera file holds every attempt,
the false starts and the minutes between them. What it hears is a room mic: the
rubber pads and beaters of the e-kit plus the room, muffled and noisy. What we
know exactly is the dry kit audio of the attempt we want, on the arrangement
timeline. Both are turned into an *onset envelope* -- a curve that spikes on
every hit and is flat between them -- which the room sound and the dry kit
share even though they sound nothing alike.

Three steps:

1. **Global search.** The whole attempt's envelope is slid across the whole
   camera envelope (FFT cross-correlation, ~6 ms steps). A false start only
   matches its first few bars; the full attempt matches all of it, so the
   right place stands out. ``confidence`` is that peak over the best peak
   found more than a second away from it.
2. **Refine** at the attempt's first and last 30 s (and its middle, when it is
   long enough), each on a finer envelope (~1.5 ms steps) and to a fraction of
   a step by fitting a parabola through the correlation peak.
3. **Fit a line** through those windows: the camera's clock against the
   timeline. Its slope is the drift -- a phone clock that runs 80 ppm fast is
   14 ms off after three minutes, most of a frame at 60 fps.

The model, which :mod:`pipeline.cover_render` uses::

    camera_time = offset_s + timeline_time * (1 + drift_ppm * 1e-6)

``start_err_ms`` and ``end_err_ms`` are how far the first and last windows sit
from that line. With only two windows they are zero by construction; with a
middle window they say whether the start, middle and end agree.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.ndimage import uniform_filter1d

from pipeline.align import decode_mono
from pipeline.cover import CAMERAS, readable_recording
from pipeline.proc import StageError, require_on_path

SR = 22050
HOP = 128  # ~5.8 ms: the global search
FINE_HOP = 32  # ~1.45 ms: the refinement windows
N_FFT = 512
WINDOW_S = 30.0
SEARCH_S = 0.4  # how far either side of the coarse answer a window may land
NEIGHBOURHOOD_S = 1.0  # peaks closer than this to the best one don't count against it
MIN_CONFIDENCE = 1.3  # synthetic sessions land at 1.5-1.8; a bar-shifted match sits near 1.0
CHUNK_S = 60.0  # envelopes are computed a minute at a time: a 30-min STFT won't fit


@dataclass(frozen=True)
class SyncResult:
    offset_s: float
    drift_ppm: float
    confidence: float
    start_err_ms: float
    end_err_ms: float

    def camera_time(self, timeline_s: float) -> float:
        return self.offset_s + timeline_s * (1.0 + self.drift_ppm * 1e-6)


# --- envelopes ---------------------------------------------------------------


def _onset_strength(y: np.ndarray, hop: int) -> np.ndarray:
    import librosa

    return librosa.onset.onset_strength(y=y, sr=SR, hop_length=hop, n_fft=N_FFT, center=True)


def envelope(y: np.ndarray, hop: int) -> np.ndarray:
    """Whitened onset envelope of ``y``; frame ``i`` is at sample ``i * hop``.

    Computed in chunks with context either side so a long file never builds
    one giant spectrogram, and so the chunk seams don't show. Then whitened:
    the slow level (how loud the room is just now) is taken off and the result
    divided by its local spread, so a loud passage or a noisy minute doesn't
    outweigh the hits everywhere else.
    """
    y = np.asarray(y, dtype=np.float32)
    frames = int(np.ceil(y.size / hop))
    chunk = int(CHUNK_S * SR) // hop * hop
    pad = (2 * N_FFT) // hop * hop
    out = np.empty(frames, dtype=np.float32)
    for start in range(0, max(y.size, 1), chunk):
        stop = min(start + chunk, y.size)
        lo, hi = start - pad, stop + pad
        piece = y[max(lo, 0) : min(hi, y.size)]
        piece = np.concatenate(
            [np.zeros(max(-lo, 0), np.float32), piece, np.zeros(max(hi - y.size, 0), np.float32)]
        )
        env = _onset_strength(piece, hop)
        first = start // hop
        count = min(frames, int(np.ceil(stop / hop))) - first
        out[first : first + count] = env[pad // hop : pad // hop + count]
    return whiten(out, hop)


def whiten(env: np.ndarray, hop: int) -> np.ndarray:
    env = np.log1p(np.maximum(env, 0.0) / (np.median(env[env > 0]) if np.any(env > 0) else 1.0))
    fps = SR / hop
    env = env - uniform_filter1d(env, max(int(0.25 * fps), 1), mode="nearest")
    env = np.maximum(env, 0.0)
    spread = np.sqrt(uniform_filter1d(env**2, max(int(3.0 * fps), 1), mode="nearest"))
    return (env / (spread + 1e-3 * (spread.max() or 1.0))).astype(np.float32)


# --- correlation -------------------------------------------------------------


def _xcorr(signal: np.ndarray, template: np.ndarray) -> np.ndarray:
    """``out[L + template.size - 1]`` = sum_k signal[L + k] * template[k], every overlap lag."""
    size = 1 << int(np.ceil(np.log2(signal.size + template.size)))
    a = np.fft.rfft(signal.astype(np.float64), size)
    b = np.fft.rfft(template[::-1].astype(np.float64), size)
    return np.fft.irfft(a * b, size)[: signal.size + template.size - 1]


def _parabolic(corr: np.ndarray, i: int) -> float:
    if 0 < i < corr.size - 1:
        a, b, c = corr[i - 1], corr[i], corr[i + 1]
        den = a - 2 * b + c
        if den < 0:
            return i + 0.5 * (a - c) / den
    return float(i)


def global_lag(
    cam: np.ndarray, ref: np.ndarray, hop: int, approx_frames: float | None = None, approx_span_s: float = 10.0
) -> tuple[float, float]:
    """Camera frame where ``ref[0]`` lands, and the confidence of that answer."""
    corr = _xcorr(cam, ref)
    lags = np.arange(corr.size) - (ref.size - 1)
    if approx_frames is not None:
        span = approx_span_s * SR / hop
        corr = np.where(np.abs(lags - approx_frames) <= span, corr, -np.inf)
    best = int(np.argmax(corr))
    near = int(NEIGHBOURHOOD_S * SR / hop)
    rest = np.concatenate([corr[: max(best - near, 0)], corr[best + near + 1 :]])
    rest = rest[np.isfinite(rest)]
    second = float(rest.max()) if rest.size else 0.0
    confidence = float(corr[best] / second) if second > 0 else float("inf")
    return float(lags[0] + _parabolic(corr, best)), confidence


def window_time(
    cam_y: np.ndarray, ref_y: np.ndarray, t0: float, t1: float, guess_cam_t0: float
) -> float:
    """Camera time of timeline ``t0``, from the stretch ``t0..t1`` on the fine envelope."""
    margin = SEARCH_S + N_FFT / SR
    ref_seg = ref_y[int(t0 * SR) : int(t1 * SR)]
    c0 = guess_cam_t0 - margin
    c_lo = int(round(max(c0, 0.0) * SR))
    c_hi = int(round((guess_cam_t0 + (t1 - t0) + margin) * SR))
    cam_seg = cam_y[c_lo : min(c_hi, cam_y.size)]
    if cam_seg.size <= ref_seg.size // 2 or ref_seg.size < SR:
        raise StageError(f"the camera does not cover the attempt around {t0:.1f}s on the timeline")
    r = envelope(ref_seg, FINE_HOP)
    c = envelope(cam_seg, FINE_HOP)
    corr = _xcorr(c, r)
    lags = np.arange(corr.size) - (r.size - 1)
    guess = (guess_cam_t0 - c_lo / SR) * SR / FINE_HOP
    span = SEARCH_S * SR / FINE_HOP
    corr = np.where(np.abs(lags - guess) <= span, corr, -np.inf)
    best = int(np.argmax(corr))
    return c_lo / SR + (lags[0] + _parabolic(corr, best)) * FINE_HOP / SR


def find_offset_arrays(
    cam_y: np.ndarray,
    ref_y: np.ndarray,
    *,
    span: tuple[float, float] | None = None,
    approx: float | None = None,
) -> SyncResult:
    """:func:`find_offset` on mono arrays at :data:`SR`. ``ref_y[0]`` is timeline 0."""
    ref_end = ref_y.size / SR
    start, end = span if span else (0.0, ref_end)
    start, end = max(start, 0.0), min(end, ref_end)
    if end - start < 2.0:
        raise StageError(f"the attempt is too short to sync ({end - start:.1f}s)")

    # 1. the whole attempt against the whole camera file
    i0, i1 = int(start * SR), int(end * SR)
    ref_env = envelope(ref_y[i0:i1], HOP)
    cam_env = envelope(cam_y, HOP)
    approx_frames = None if approx is None else (approx + start) * SR / HOP
    lag, confidence = global_lag(cam_env, ref_env, HOP, approx_frames)
    coarse_offset = lag * HOP / SR - start  # camera time of timeline 0, no drift

    # 2. refine at the start, middle and end
    length = end - start
    if length < 10.0:  # too short to see a drift: one window, no slope
        win, starts = length, [start]
    else:
        win = min(WINDOW_S, length / 2)
        starts = [start, end - win]
        if length >= 3 * win:
            starts.insert(1, start + (length - win) / 2)
    ts, cs = [], []
    for w0 in starts:
        cs.append(window_time(cam_y, ref_y, w0, w0 + win, coarse_offset + w0))
        ts.append(w0)
    ts_a, cs_a = np.array(ts), np.array(cs)

    # 3. the camera's clock against the timeline
    if ts_a.size == 1:
        rate, offset = 1.0, float(cs_a[0] - ts_a[0])
    else:
        rate, offset = (float(v) for v in np.polyfit(ts_a, cs_a, 1))
    resid = (cs_a - (offset + rate * ts_a)) * 1000.0
    return SyncResult(
        offset_s=offset,
        drift_ppm=(rate - 1.0) * 1e6,
        confidence=confidence,
        start_err_ms=float(resid[0]),
        end_err_ms=float(resid[-1]),
    )


def find_offset(
    camera_media: Path,
    reference_wav: Path,
    approx: float | None = None,
    *,
    span: tuple[float, float] | None = None,
    reference_start_s: float = 0.0,
) -> SyncResult:
    """Where ``reference_wav``'s attempt sits in ``camera_media``.

    ``reference_wav`` is the dry kit audio, starting at ``reference_start_s`` on
    the timeline. ``span`` (timeline seconds) limits the search to the chosen
    attempt; by default the whole reference. ``approx`` is a known offset in
    seconds to search near (+-10 s) instead of the whole file.
    """
    cam_y = decode_mono(Path(camera_media), SR)
    ref_y = decode_mono(Path(reference_wav), SR)
    if reference_start_s > 0:
        ref_y = np.concatenate([np.zeros(int(round(reference_start_s * SR)), np.float32), ref_y])
    elif reference_start_s < 0:
        ref_y = ref_y[int(round(-reference_start_s * SR)) :]
    return find_offset_arrays(cam_y, ref_y, span=span, approx=approx)


# --- the session side --------------------------------------------------------

VIDEO_EXTS = (".mp4", ".mov", ".mkv", ".m4v", ".avi", ".webm")


def camera_file(raw: Path, camera: str) -> Path | None:
    found = sorted(p for p in raw.glob(f"{camera}.*") if p.suffix.lower() in VIDEO_EXTS)
    return found[0] if found else None


def reference_for(session) -> tuple[Path, float]:
    """The dry kit audio to sync against, and where it starts on the timeline.

    The chosen pass's own ``SD3 rec`` recording when ``cover-attempts --save``
    named it in ``[attempt]``: ``audio`` (absolute, or relative to the session
    folder), whose ``file_offset_s`` plays at ``start_s`` -- so the file's
    first sample is at ``start_s - file_offset_s``. Otherwise
    ``work/drums-only.wav`` from ``cover-mix``: the kit alone, before the
    chain, on the timeline.
    """
    attempt = session.settings().get("attempt", {})
    if attempt.get("audio"):
        path = Path(attempt["audio"])
        path = readable_recording(path if path.is_absolute() else session.root / path)
        return path, float(attempt.get("start_s", 0.0)) - float(attempt.get("file_offset_s", 0.0))
    if (session.work / "drums-only.wav").exists():
        return session.work / "drums-only.wav", 0.0
    raise StageError(f"no dry kit audio to sync against in {session.work}; run `drums cover-mix` first")


def attempt_span(session) -> tuple[float, float] | None:
    attempt = session.settings().get("attempt", {})
    if "start_s" in attempt and "end_s" in attempt:
        return float(attempt["start_s"]), float(attempt["end_s"])
    return None


def extract_frame(media: Path, at_s: float, out: Path) -> Path:
    """One still from ``media`` at ``at_s`` (camera time), rotated upright."""
    ffmpeg = require_on_path("ffmpeg")
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{max(at_s, 0):.3f}", "-i", str(media),
           "-frames:v", "1", str(out)]
    result = subprocess.run(cmd, capture_output=True, check=False)
    if result.returncode != 0 or not out.exists():
        raise StageError(f"ffmpeg could not take a frame from {media}: {result.stderr.decode(errors='replace').strip()}")
    return out


def sync_session(session) -> dict[str, SyncResult]:
    """Sync every camera in ``raw/``, write ``[sync]``, and save a still of each."""
    reference, ref_start = reference_for(session)
    span = attempt_span(session)
    previous = session.settings().get("sync", {})
    results: dict[str, SyncResult] = {}
    values: dict[str, object] = {}
    for cam in CAMERAS:
        media = camera_file(session.raw, cam)
        if media is None:
            continue
        res = find_offset(media, reference, span=span, reference_start_s=ref_start)
        results[cam] = res
        values.update(
            {
                f"{cam}_file": media.name,
                f"{cam}_offset_s": round(res.offset_s, 5),
                f"{cam}_drift_ppm": round(res.drift_ppm, 2),
                f"{cam}_confidence": round(res.confidence, 2),
                f"{cam}_start_err_ms": round(res.start_err_ms, 2),
                f"{cam}_end_err_ms": round(res.end_err_ms, 2),
            }
        )
        if f"{cam}_nudge_ms" not in previous:
            values[f"{cam}_nudge_ms"] = 0.0
    if not results:
        raise StageError(
            f"no camera files (main.* or foot.*) in {session.raw}; run `drums cover-import {session.song.slug} --as main`"
        )
    session.update("sync", values)

    if span:
        mid = (span[0] + span[1]) / 2
    else:
        mid = (decode_duration(reference) + ref_start) / 2
    for cam, res in results.items():
        extract_frame(camera_file(session.raw, cam), res.camera_time(mid), session.work / f"{cam}-frame.png")
    return results


def decode_duration(path: Path) -> float:
    import soundfile as sf

    try:
        return float(sf.info(str(path)).duration)
    except RuntimeError:
        return decode_mono(path, SR).size / SR
