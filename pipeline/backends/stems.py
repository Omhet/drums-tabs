"""Per-stem SuperFlux detection: the Phase 1b backend.

drumsep has already split the drum stem into kick, snare, toms, hi-hat, ride and
crash, so most of the hard part of drum transcription -- deciding *which* drum
made a transient -- is answered by which file the transient is in. What is left
is peak-picking one envelope per instrument, which is a solved problem.

**Phase 1b transcribes three classes only**: kick, snare and closed hi-hat. Toms
and cymbals are split and sitting on disk, but classification (open vs closed
hat, which tom) is Phase 3 work, and a crude guess at it would produce notation
that looks authoritative and is wrong. Three classes is the deliberately
recognisable-but-incomplete slice the plan asks for.

Each instrument is detected in its own frequency band *within* its own stem. The
stem does the source separation; the band rejects what the separator leaked. A
kick stem still contains a shadow of every snare hit, but almost none of that
shadow is below 120 Hz.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from pipeline import onsets, paths
from pipeline.backends.base import Backend, OnsetEvent, register
from pipeline.proc import StageError, note
from pipeline.separation import drumsep


class _Detector:
    """How one instrument is picked out of its stem.

    ``delta`` is the peak-picking threshold on the normalised envelope and
    ``min_ioi`` the shortest gap between two hits on the same drum -- the kick's
    is the tightest, because double-kick sixteenths at 180 BPM are 83 ms apart
    and anything laxer collapses a fast passage into single notes.

    ``min_velocity`` is the one that does the heavy lifting. It is a *relative*
    floor: a peak below this fraction of how hard the drum is hit elsewhere in
    the same song is not a hit. Peak-picking a single-drum stem finds far more
    than the drummer played -- a kick's pitch envelope drops as it decays, and
    that movement makes its own small flux peak 60-90 ms after the hit -- and
    those artefacts are an order of magnitude weaker than the hit that caused
    them, which is exactly what this threshold sees. On the first song it was
    measured against it took the kick from 13.4 notes per bar (29% of them on a
    quarter) to 4.0 (99% on a quarter), which is what a disco tune is.
    """

    def __init__(
        self,
        stem: str,
        bands: tuple[str, ...],
        delta: float,
        min_ioi: float,
        min_velocity: float,
    ):
        self.stem = stem
        self.bands = bands
        self.delta = delta
        self.min_ioi = min_ioi
        self.min_velocity = min_velocity


DETECTORS: dict[str, _Detector] = {
    "kick": _Detector("kick", ("kick",), delta=0.14, min_ioi=0.055, min_velocity=0.15),
    # Both snare bands, as in the grid's crude proxy: the shell's body tone and
    # the wire rattle. Summing them separates a snare from a floor tom, which
    # shares the body band and has nothing above 2 kHz.
    "snare": _Detector(
        "snare", ("snare_body", "snare_crack"), delta=0.14, min_ioi=0.050, min_velocity=0.15
    ),
    # Lower, because hats are played quietly on purpose. A hat floor as high as
    # the snare's erases the soft notes between the accents, which is most of
    # what a hi-hat part is.
    "hihat_closed": _Detector(
        "hihat", ("hihat",), delta=0.12, min_ioi=0.045, min_velocity=0.12
    ),
}

# A hit must show up in the *unsplit* drum stem too, at least this strongly.
# drumsep occasionally invents quiet material in a stem where the drum in
# question is silent -- an intro, a breakdown -- and those inventions have no
# counterpart in drums.wav.
GATE_SUPPORT = 0.08

# How far either side of a detected peak to look for that support. Wide enough
# to absorb the few-millisecond disagreement between two envelopes computed from
# different audio, narrow enough not to borrow the neighbouring beat's evidence.
GATE_WINDOW = 0.030


def _envelope(path: Path, bands: tuple[str, ...]) -> tuple[np.ndarray, np.ndarray]:
    """Normalised onset envelope for one stem, summed over its bands."""
    y, sr = onsets.load_mono(path)
    total = None
    for band in bands:
        env = onsets.normalize(onsets.superflux(y, sr, *onsets.BANDS[band]))
        total = env if total is None else total + env
    assert total is not None  # DETECTORS never declares an empty band tuple
    return onsets.normalize(total), onsets.envelope_times(total.size, sr)


def detect_stems(song: paths.Song) -> list[OnsetEvent]:
    if not drumsep.is_split(song):
        raise StageError(
            f"no per-drum stems in {song.kit_dir} -- run `drums kit {song.slug}` first"
        )

    events: list[OnsetEvent] = []
    for instrument, detector in DETECTORS.items():
        env, times = _envelope(song.kit_stem(detector.stem), detector.bands)
        support_env, support_times = _envelope(song.drums, detector.bands)

        peaks = onsets.pick_onsets(env, times, delta=detector.delta, wait=detector.min_ioi)
        if peaks.size == 0:
            note(f"[transcribe] {instrument}: no onsets above delta {detector.delta}")
            continue

        strength = onsets.support_at(env, times, peaks, window=detector.min_ioi / 2)
        support = onsets.support_at(
            support_env, support_times, peaks, window=GATE_WINDOW
        )
        gated = support >= GATE_SUPPORT
        # Velocity is relative to how hard *this* drum gets hit in *this* song:
        # a quiet song is not a song of ghost notes.
        loud = float(np.percentile(strength[gated], 95.0)) if gated.any() else 1.0
        loud = loud if loud > 1e-6 else 1.0
        velocity = np.clip(strength / loud, 0.0, 1.0)
        kept = gated & (velocity >= detector.min_velocity)

        for t, level, backing, keep in zip(peaks, velocity, support, kept):
            if not keep:
                continue
            events.append(
                OnsetEvent(
                    t=float(t),
                    instrument=instrument,
                    velocity=float(level),
                    confidence=float(np.clip(backing, 0.0, 1.0)),
                )
            )
        note(
            f"[transcribe] {instrument}: {int(kept.sum())} hits "
            f"({int((~gated).sum())} with no support in drums.wav, "
            f"{int((gated & ~kept).sum())} below {detector.min_velocity:.0%} velocity)"
        )
    return events


register(
    Backend(
        key="stems",
        notes="drumsep stems + band-limited SuperFlux; kick/snare/closed hat only",
        detect=detect_stems,
    )
)
