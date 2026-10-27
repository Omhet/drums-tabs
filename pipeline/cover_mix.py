"""The cover's final audio: your kit over the song, mixed in Python.

Not exported from Live, so it is automatic and repeatable. The inputs are plain
-- audio, where it starts on the arrangement, a fader -- so nothing here knows
about Live sets; ``cover_cli_mix`` gathers them.

**The "tight" chain**, every stage switchable in ``cover.toml``'s ``[mix]``
(:class:`MixSettings`):

1. on the kit: a high-pass at 35 Hz, then a **tone match** -- the kit's
   long-term average spectrum is pulled partway toward the original drum
   stem's (third-octave smoothed, at most +/-6 dB, half way by default), as a
   linear-phase FIR so not one hit moves in time; then **drum bus
   compression**, about 3 dB on the loud hits;
2. a **shared room**: one short reverb that the kit and the song are both sent
   to, quietly, so they sound like one space;
3. **room for the kit**: a 1.5 dB dip in the no-drums stem where kick and snare
   sit, and optionally a slight duck of the song on every kick;
4. **master**: glue compression, a limiter, and loudness to -14 LUFS with true
   peaks at or below -1 dBTP.

**The click is never mixed.** It is a track like any other on the way in, and
it is dropped before anything is summed -- with an assert where the summing
happens, so a later change cannot let it through.

**Levels** are the Live faders, as they were when the take was heard: the
user sets the balance in Live, and the mix keeps it. ``[mix] trim_db`` adds on
top, per track name.

The **timing report** (:func:`timing_report`) says where your hits sit against
the original drummer's, kick and snare separately.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field, fields, replace
from math import gcd
from pathlib import Path
from typing import Literal

import numpy as np
import soundfile as sf
from scipy import signal
from scipy.fft import next_fast_len

from pipeline import onsets, reference

Role = Literal["kit", "song", "song_drums", "click"]
Log = Callable[[str], None]

SR = 48000


@dataclass
class TrackIn:
    """One track on the arrangement. Give ``audio`` (with ``sr``) or ``path``.

    ``start_s`` is where sample 0 lands on the arrangement; ``pan`` runs -1
    (left) to 1 (right) and balances a stereo file, as Live does.
    """

    name: str
    role: Role
    audio: np.ndarray | None = None
    sr: int | None = None
    path: Path | None = None
    start_s: float = 0.0
    gain_db: float = 0.0
    pan: float = 0.0
    muted: bool = False


@dataclass
class MixSettings:
    sr: int = SR

    hpf: bool = True
    hpf_hz: float = 35.0

    tone_match: bool = True
    tone_amount: float = 0.5
    tone_max_db: float = 6.0

    bus_comp: bool = True
    bus_gr_db: float = 3.0
    bus_ratio: float = 3.0
    bus_attack_ms: float = 10.0
    bus_release_ms: float = 100.0

    room: bool = True
    room_size: float = 0.22
    room_damping: float = 0.6
    room_send_db: float = -20.0

    song_dip: bool = True
    song_dip_db: float = -1.5
    song_dip_hz: list[float] = field(default_factory=lambda: [60.0, 200.0])

    duck: bool = False
    duck_db: float = 1.0

    glue: bool = True
    glue_gr_db: float = 1.5
    glue_ratio: float = 2.0
    glue_attack_ms: float = 30.0
    glue_release_ms: float = 200.0

    limiter: bool = True
    loudness: bool = True
    target_lufs: float = -14.0
    true_peak_db: float = -1.0

    #: Moves the whole kit later (positive) or earlier, in milliseconds.
    drums_shift_ms: float = 0.0
    #: Added to a track's fader, by track name: ``trim_db = { "1-Superior Drummer 3" = 2 }``.
    trim_db: dict[str, float] = field(default_factory=dict)

    @classmethod
    def from_toml(cls, section: dict | None) -> MixSettings:
        """``cover.toml``'s ``[mix]``; anything not there keeps its default."""
        known = {f.name for f in fields(cls)}
        section = section or {}
        unknown = sorted(set(section) - known - {"preview_at_s"})
        if unknown:
            raise ValueError(f"[mix] has unknown settings: {', '.join(unknown)}")
        return cls(**{k: v for k, v in section.items() if k in known})

    def dry(self) -> MixSettings:
        """The same levels with every processing stage off (``--no-chain``).

        Loudness stays on, so the two are compared at the same level.
        """
        off = {
            k: False
            for k in ("hpf", "tone_match", "bus_comp", "room", "song_dip", "duck", "glue")
        }
        return replace(self, **off)


# --- small pieces --------------------------------------------------------------


def db(x: float) -> float:
    return float(10.0 ** (x / 20.0))


def load(path: Path, sr: int) -> np.ndarray:
    data, rate = sf.read(str(path), dtype="float32", always_2d=True)
    return resample(data.T, int(rate), sr)


def resample(audio: np.ndarray, from_sr: int, to_sr: int) -> np.ndarray:
    audio = np.atleast_2d(np.asarray(audio, dtype=np.float32))
    if from_sr == to_sr:
        return audio
    g = gcd(from_sr, to_sr)
    return signal.resample_poly(audio, to_sr // g, from_sr // g, axis=1).astype(np.float32)


def stereo(audio: np.ndarray) -> np.ndarray:
    audio = np.atleast_2d(audio)
    if audio.shape[0] == 1:
        return np.repeat(audio, 2, axis=0)
    return audio[:2]


def balance(audio: np.ndarray, pan: float) -> np.ndarray:
    pan = float(np.clip(pan, -1.0, 1.0))
    out = audio.copy()
    out[0] *= 1.0 - max(pan, 0.0)
    out[1] *= 1.0 + min(pan, 0.0)
    return out


def loudness(audio: np.ndarray, sr: int) -> float:
    """Integrated loudness in LUFS (BS.1770, gated), of (channels, frames)."""
    import pyloudnorm

    return float(pyloudnorm.Meter(sr).integrated_loudness(np.atleast_2d(audio).T.astype(np.float64)))


def true_peak_db(audio: np.ndarray) -> float:
    up = signal.resample_poly(np.atleast_2d(audio), 4, 1, axis=1)
    return float(20 * np.log10(max(float(np.abs(up).max()), 1e-12)))


def _run(board, audio: np.ndarray, sr: int) -> np.ndarray:
    import pedalboard

    return pedalboard.Pedalboard(board)(np.ascontiguousarray(audio, dtype=np.float32), sr)


def _loud_level_db(audio: np.ndarray, sr: int) -> float:
    """The level of the loud moments: 95th percentile of 10 ms RMS, in dB."""
    mono = np.atleast_2d(audio).mean(axis=0)
    win = max(1, int(0.01 * sr))
    usable = mono[: mono.size // win * win].reshape(-1, win)
    rms = np.sqrt((usable**2).mean(axis=1))
    rms = rms[rms > 1e-6]
    return float(20 * np.log10(np.percentile(rms, 95))) if rms.size else -120.0


def compressor(audio, sr, gr_db, ratio, attack_ms, release_ms):
    """A compressor whose threshold is set so the loud hits lose about ``gr_db``."""
    import pedalboard

    threshold = _loud_level_db(audio, sr) - gr_db / (1.0 - 1.0 / ratio)
    comp = pedalboard.Compressor(
        threshold_db=threshold, ratio=ratio, attack_ms=attack_ms, release_ms=release_ms
    )
    return _run([comp], audio, sr)


# --- tone match ------------------------------------------------------------------

#: Third-octave centres, 31.5 Hz to 16 kHz.
BAND_CENTRES = 1000.0 * 2.0 ** (np.arange(-15, 13) / 3.0)
TONE_TAPS = 4095


def band_levels(audio: np.ndarray, sr: int) -> np.ndarray:
    """Long-term average spectrum in third-octave bands, dB, with the median
    removed -- the shape of the tone, not its level."""
    mono = np.atleast_2d(audio).mean(axis=0)
    f, p = signal.welch(mono, sr, nperseg=8192)
    edges = 2.0 ** (1.0 / 6.0)
    levels = np.array(
        [p[(f >= c / edges) & (f < c * edges)].mean() for c in BAND_CENTRES], dtype=np.float64
    )
    out = 10 * np.log10(np.maximum(levels, 1e-20))
    return out - np.median(out)


def tone_curve(kit: np.ndarray, ref: np.ndarray, sr: int, amount: float, max_db: float) -> np.ndarray:
    """dB per band that pulls ``kit`` toward ``ref``, clamped to +/-``max_db``."""
    return np.clip(amount * (band_levels(ref, sr) - band_levels(kit, sr)), -max_db, max_db)


def tone_fir(curve_db: np.ndarray, sr: int, taps: int = TONE_TAPS) -> np.ndarray:
    """A linear-phase FIR following the band curve (held flat past the ends)."""
    nyq = sr / 2.0
    keep = BAND_CENTRES < nyq * 0.95
    freq = np.concatenate([[0.0], BAND_CENTRES[keep], [nyq]])
    gain_db = np.concatenate([[curve_db[keep][0]], curve_db[keep], [curve_db[keep][-1]]])
    return signal.firwin2(taps, freq, 10.0 ** (gain_db / 20.0), fs=sr)


def apply_fir(audio: np.ndarray, fir: np.ndarray) -> np.ndarray:
    """Filter without moving anything in time: the FIR's delay is cut off."""
    half = (fir.size - 1) // 2
    out = signal.oaconvolve(audio, fir[None, :], axes=1)
    return out[:, half : half + audio.shape[1]].astype(np.float32)


# --- the mix ---------------------------------------------------------------------


def _place(audio: np.ndarray, start_s: float, sr: int, length: int) -> np.ndarray:
    out = np.zeros((2, length), dtype=np.float32)
    at = int(round(start_s * sr))
    src = audio[:, max(0, -at) :]
    at = max(0, at)
    n = min(src.shape[1], length - at)
    if n > 0:
        out[:, at : at + n] = src[:, :n]
    return out


def _kick_duck(kit: np.ndarray, sr: int, depth_db: float) -> np.ndarray:
    sos = signal.butter(4, 120.0, "lowpass", fs=sr, output="sos")
    env = np.abs(signal.sosfilt(sos, kit.mean(axis=0)))
    a = 1.0 / (0.06 * sr)
    env = signal.lfilter([a], [1.0, a - 1.0], env)
    top = float(np.percentile(env, 99.5)) or 1.0
    return (10.0 ** (-depth_db * np.clip(env / top, 0.0, 1.0) / 20.0)).astype(np.float32)


def master(audio: np.ndarray, settings: MixSettings, log: Log) -> np.ndarray:
    """Glue, limiter, then -14 LUFS with true peaks under the ceiling."""
    import pedalboard

    sr = settings.sr
    if settings.glue:
        audio = compressor(
            audio, sr, settings.glue_gr_db, settings.glue_ratio,
            settings.glue_attack_ms, settings.glue_release_ms,
        )
    ceiling = settings.true_peak_db

    def limited(drive_db: float) -> np.ndarray:
        """Through the limiter, with its true peak put at the ceiling.

        pedalboard's (JUCE's) limiter holds its output at 0 dBFS and treats its
        threshold as drive: lower is harder. It only sees samples, so it runs at
        4x to catch the peaks between them; the ceiling is set after.
        """
        up = signal.resample_poly(audio, 4, 1, axis=1).astype(np.float32)
        up = _run([pedalboard.Limiter(threshold_db=drive_db, release_ms=100.0)], up, sr * 4)
        out = signal.resample_poly(up, 1, 4, axis=1).astype(np.float32)
        return out * db(ceiling - true_peak_db(out))

    def under_ceiling(out: np.ndarray) -> np.ndarray:
        peak = true_peak_db(out)
        return out * db(ceiling - peak - 0.02) if peak > ceiling else out

    target = settings.target_lufs
    if not settings.loudness:
        out = limited(0.0) if settings.limiter else audio
    elif not settings.limiter:
        out = under_ceiling(audio * db(target - loudness(audio, sr)))
    else:
        out = limited(0.0)
        if loudness(out, sr) < target:
            # Too quiet at the ceiling: drive the limiter harder until -14 fits.
            lo, hi = -24.0, 0.0
            for _ in range(10):
                mid = (lo + hi) / 2
                out = limited(mid)
                miss = loudness(out, sr) - target
                if abs(miss) < 0.1:
                    break
                lo, hi = (lo, mid) if miss < 0 else (mid, hi)
        out = under_ceiling(out * db(min(0.0, target - loudness(out, sr))))
    log(f"  master: {loudness(out, sr):.1f} LUFS, true peak {true_peak_db(out):.1f} dBTP")
    return out


def mix(
    tracks: list[TrackIn],
    settings: MixSettings,
    reference_drums: Path | np.ndarray | None,
    *,
    reference_sr: int | None = None,
    window: tuple[float, float] | None = None,
    log: Log = lambda _: None,
) -> tuple[np.ndarray, np.ndarray]:
    """The final mix and the kit alone, both stereo (2, frames) at ``settings.sr``.

    The kit alone is dry -- before the chain and at unity -- but shifted by
    ``drums_shift_ms`` like the kit in the mix, so the video synced to it
    follows the kit you hear. ``window`` (start, end seconds) crops both after
    the whole mix is made, so an excerpt is exactly that part of the real mix.
    """
    sr = settings.sr
    shift = settings.drums_shift_ms / 1000.0
    kept = [t for t in tracks if t.role != "click" and not t.muted]

    loaded: list[tuple[TrackIn, np.ndarray, float]] = []
    for t in kept:
        audio = load(t.path, sr) if t.audio is None else resample(t.audio, int(t.sr or sr), sr)
        start = t.start_s + (shift if t.role == "kit" else 0.0)
        loaded.append((t, stereo(audio), start))
    if not loaded:
        raise ValueError("nothing to mix: every track is muted or a click")
    length = max(int(round(max(s, 0) * sr)) + a.shape[1] for _, a, s in loaded)

    ref = None
    if reference_drums is not None:
        ref = (
            load(Path(reference_drums), sr)
            if not isinstance(reference_drums, np.ndarray)
            else resample(reference_drums, int(reference_sr or sr), sr)
        )
        ref = stereo(ref)  # a mono stem plays on both sides

    kit_bus = np.zeros((2, length), dtype=np.float32)
    song_bus = np.zeros((2, length), dtype=np.float32)
    other_bus = np.zeros((2, length), dtype=np.float32)
    drums_only = np.zeros((2, length), dtype=np.float32)

    for t, audio, start in loaded:
        assert t.role != "click", "the click is never mixed"
        trim = settings.trim_db.get(t.name, 0.0)
        if t.role == "kit":
            drums_only += _place(audio, start, sr, length)
            audio = kit_chain(audio, ref, settings, log)
            kit_bus += _place(balance(audio, t.pan) * db(t.gain_db + trim), start, sr, length)
        elif t.role == "song":
            if settings.song_dip:
                import pedalboard

                audio = _run(
                    [pedalboard.PeakFilter(cutoff_frequency_hz=hz, gain_db=settings.song_dip_db, q=1.0)
                     for hz in settings.song_dip_hz],
                    audio, sr,
                )
            song_bus += _place(balance(audio, t.pan) * db(t.gain_db + trim), start, sr, length)
        else:  # the original drum stem, if its fader is up
            other_bus += _place(balance(audio, t.pan) * db(t.gain_db + trim), start, sr, length)

    if settings.duck and np.any(kit_bus):
        song_bus *= _kick_duck(kit_bus, sr, settings.duck_db)[None, :]

    out = kit_bus + song_bus + other_bus
    if settings.room:
        import pedalboard

        verb = pedalboard.Reverb(
            room_size=settings.room_size, damping=settings.room_damping,
            wet_level=1.0, dry_level=0.0, width=1.0,
        )
        out = out + _run([verb], kit_bus + song_bus, sr) * db(settings.room_send_db)

    out = master(out, settings, log)
    if window is not None:
        a, b = (int(round(x * sr)) for x in window)
        out, drums_only = out[:, a:b], drums_only[:, a:b]
    return out.astype(np.float32), drums_only


def kit_chain(audio: np.ndarray, ref: np.ndarray | None, settings: MixSettings, log: Log) -> np.ndarray:
    """High-pass, tone match, bus compression -- the kit's own processing."""
    sr = settings.sr
    if settings.hpf:
        import pedalboard

        audio = _run([pedalboard.HighpassFilter(cutoff_frequency_hz=settings.hpf_hz)], audio, sr)
    if settings.tone_match and ref is not None and np.any(audio):
        curve = tone_curve(audio, ref, sr, settings.tone_amount, settings.tone_max_db)
        log(f"  tone match: {curve.min():+.1f} .. {curve.max():+.1f} dB across the bands")
        audio = apply_fir(audio, tone_fir(curve, sr))
    if settings.bus_comp and np.any(audio):
        audio = compressor(
            audio, sr, settings.bus_gr_db, settings.bus_ratio,
            settings.bus_attack_ms, settings.bus_release_ms,
        )
    return audio


def write(path: Path, audio: np.ndarray, sr: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.clip(audio, -1.0, 1.0).T, sr, subtype="PCM_24")


# --- timing report -----------------------------------------------------------------

#: Where a hit's start is put: the first sample, in the window around it, that
#: has risen this fraction of the way from the window's quietest to the hit's
#: peak. From the quietest, not from zero: in a drum stem the band is never
#: silent before a hit, and a threshold the bleed already clears finds nothing.
_RISE = 0.2
#: The band that start is looked for in, where it differs from the band the hit
#: was found in. A kick's 30-120 Hz body peaks well after the beater, by 8 ms on
#: the kit the sampler was baked from. Above the body, where the beater clicks,
#: the start lands within about 2 ms of the note on both SD3 kits measured.
REFINE_BANDS: dict[str, tuple[float, float]] = {"kick": (150.0, 10000.0)}


@dataclass(frozen=True)
class TimingRow:
    """How one instrument's hits sat. Milliseconds; positive is late."""

    instrument: str
    matched: int
    #: Your hits against the original drummer's, measured directly.
    vs_record_ms: float | None
    #: Your hits against the chart, and that less the record's own floor --
    #: the same question asked a second way, when the chart is given.
    vs_chart_ms: float | None = None
    floor_ms: float | None = None

    @property
    def vs_record_via_chart_ms(self) -> float | None:
        if self.vs_chart_ms is None or self.floor_ms is None:
            return None
        return self.vs_chart_ms - self.floor_ms


def band_onsets(audio: np.ndarray, sr: int) -> dict[str, np.ndarray]:
    """Kick and snare onset times (s), by frequency band, refined to the sample.

    Found the way ``reference.py`` finds the record's (SuperFlux, its bands and
    thresholds), then each is moved to where its band's envelope starts to
    rise, so a 5 ms analysis hop does not quantise the answer.
    """
    mono = np.atleast_2d(audio).mean(axis=0).astype(np.float32)
    spectrum = onsets.magnitudes(mono)
    times = onsets.envelope_times(spectrum.shape[1], sr)
    out: dict[str, np.ndarray] = {}
    for name, (lo, hi) in reference.BANDS.items():
        env = onsets.normalize(onsets.superflux(mono, sr, lo, hi, spectrum=spectrum))
        coarse = onsets.pick_onsets(env, times, delta=0.06, wait=0.04)
        lo, hi = REFINE_BANDS.get(name, (lo, hi))
        sos = signal.butter(2, [lo, min(hi, sr / 2 - 1)], "bandpass", fs=sr, output="sos")
        filtered = signal.sosfiltfilt(sos, mono)
        band = np.abs(signal.hilbert(filtered, next_fast_len(mono.size)))[: mono.size]
        refined = []
        for t in coarse:
            a = max(0, int((t - 0.02) * sr))
            b = min(band.size, int((t + 0.03) * sr))
            if b - a < 2:
                continue
            seg = band[a:b]
            peak = int(np.argmax(seg))
            rise = seg[: peak + 1]
            floor = float(rise.min())
            refined.append((a + int(np.argmax(rise >= floor + _RISE * (seg[peak] - floor)))) / sr)
        out[name] = np.asarray(refined)
    return out


def matched_offsets(player: np.ndarray, target: np.ndarray, window_ms: float = reference.MATCH_MS) -> np.ndarray:
    """Signed ms from each target hit to your nearest hit, where there is one."""
    if player.size == 0 or target.size == 0:
        return np.empty(0)
    player = np.sort(player)
    idx = np.clip(np.searchsorted(player, target), 1, player.size - 1)
    near = np.where(
        np.abs(player[idx - 1] - target) <= np.abs(player[idx] - target), player[idx - 1], player[idx]
    )
    if player.size == 1:
        near = np.full_like(target, player[0])
    delta = (near - target) * 1000.0
    return delta[np.abs(delta) <= window_ms]


def _nearest(found: np.ndarray, at: np.ndarray, window_ms: float) -> np.ndarray:
    """The nearest of ``found`` to each of ``at`` within the window, else NaN."""
    out = np.full(at.shape, np.nan)
    if found.size == 0:
        return out
    found = np.sort(found)
    idx = np.clip(np.searchsorted(found, at), 0, found.size - 1)
    lower = found[np.maximum(idx - 1, 0)]
    upper = found[idx]
    near = np.where(np.abs(lower - at) <= np.abs(upper - at), lower, upper)
    ok = np.abs(near - at) * 1000.0 <= window_ms
    out[ok] = near[ok]
    return out


def timing_report(
    player: np.ndarray | dict[str, np.ndarray],
    record: np.ndarray | dict[str, np.ndarray] | None,
    sr: int = SR,
    *,
    chart: dict[str, np.ndarray] | None = None,
    floor_ms: dict[str, float] | None = None,
) -> list[TimingRow]:
    """Where your kick and snare sat against the original drummer's.

    ``player`` and ``record`` are audio on the same arrangement timeline (the
    dry kit, and the original drum stem placed where it plays), or onset times
    per instrument already.

    ``chart`` is the written notes' times on that timeline, per instrument.
    Given, it does two things. Each written note picks out its own hit in both
    recordings, so a bass note in the kick band or a tom in the snare band is
    not compared with anything (``reference.py`` uses the chart the same way).
    And with ``floor_ms`` (``reference.lock.json``'s per-instrument medians) it
    asks the question a second way: you against the chart, less how late the
    record itself sits on it.
    """
    mine = player if isinstance(player, dict) else band_onsets(player, sr)
    theirs = record if (record is None or isinstance(record, dict)) else band_onsets(record, sr)
    rows = []
    for name in reference.BANDS:
        played = np.asarray(mine.get(name, np.empty(0)))
        written = np.asarray(chart[name]) if chart and name in chart else None
        vs_chart = matched_offsets(played, written) if written is not None else None
        if theirs is None:
            vs_record = np.empty(0)
        elif written is not None:
            a = _nearest(played, written, reference.MATCH_MS)
            b = _nearest(np.asarray(theirs[name]), written, reference.MATCH_MS)
            both = ~np.isnan(a) & ~np.isnan(b)
            vs_record = (a[both] - b[both]) * 1000.0
        else:
            vs_record = matched_offsets(played, np.asarray(theirs[name]))
        rows.append(
            TimingRow(
                instrument=name,
                matched=int(vs_record.size if theirs is not None else (vs_chart.size if vs_chart is not None else 0)),
                vs_record_ms=float(np.median(vs_record)) if vs_record.size else None,
                vs_chart_ms=float(np.median(vs_chart)) if vs_chart is not None and vs_chart.size else None,
                floor_ms=(floor_ms or {}).get(name),
            )
        )
    return rows


def floor_from_lock(lock: dict | None) -> dict[str, float]:
    """Per-instrument medians from ``reference.lock.json`` (``reference.load``)."""
    if not lock:
        return {}
    return {row["instrument"]: float(row["median_ms"]) for row in lock.get("instruments", [])}
