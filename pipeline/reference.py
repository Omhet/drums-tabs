"""Is the chart early, or is the drummer late?

A take is scored against the chart placed on the beat map. But the chart is
*written* -- quantised to a sixteenth grid -- and the record it was written from
is played by a person, who sits wherever the music wants them to sit. If that is
behind the grid, then playing along with the record, copying the feel that is
actually in your ears, reads as systematically late. The number is then a
property of the reference, not of the player, and no amount of practice moves it.

This measures the gap. For every kick and snare in the chart it finds the nearest
onset in the original's drum stem and reports the signed distance. **Positive
means the record's hit is later than where the chart puts it**, which is the
amount a perfectly faithful take would be marked down by.

It is a diagnostic, not a correction. Whether "in time" means the chart's grid or
the record's feel is a decision for whoever is practising, and the honest thing
is to be able to see the difference rather than to quietly remove it.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from pipeline import onsets, paths
from pipeline.chart import SLOTS_PER_BEAT, read_hits
from pipeline.grid import Grid
from pipeline.proc import StageError

#: Beyond this the nearest onset is a different note, not this one played late.
MATCH_MS = 90.0

#: A kick and a snare do not share a frequency range, and one broadband envelope
#: would let the louder of them mask the other.
BANDS: dict[str, tuple[float, float]] = {
    "kick": (30.0, 120.0),
    "snare": (180.0, 1200.0),
}


@dataclass(frozen=True)
class Offsets:
    """What one instrument's notes did, relative to where they are written."""

    instrument: str
    #: Signed milliseconds, one per matched note. Positive is behind the grid.
    values: np.ndarray
    #: How many chart notes of this instrument there were to match at all.
    written: int

    @property
    def mean_ms(self) -> float:
        return float(self.values.mean()) if self.values.size else 0.0

    @property
    def median_ms(self) -> float:
        return float(np.median(self.values)) if self.values.size else 0.0

    @property
    def sd_ms(self) -> float:
        return float(self.values.std()) if self.values.size else 0.0


def slot_to_seconds(grid: Grid, slot: int) -> float | None:
    """Where a sixteenth from bar 1 falls in the mix.

    The same interpolation the player does (``app/src/chart.ts``), because a
    diagnostic that placed the notes differently from the thing being diagnosed
    would be measuring itself.
    """
    beats = np.asarray(grid.beats, dtype=float)
    if beats.size < 2:
        return None
    from_bar_one = slot / SLOTS_PER_BEAT
    whole = int(np.floor(from_bar_one))
    frac = from_bar_one - whole
    i = grid.bar_one_beat + whole
    last = beats.size - 1
    if i < 0:
        return None
    if i < last:
        return float(beats[i] + frac * (beats[i + 1] - beats[i]))
    step = beats[last] - beats[last - 1]
    return float(beats[last] + (i - last + frac) * step)


def measure(song: paths.Song, grid: Grid, midi_map: dict[int, str]) -> list[Offsets]:
    """One :class:`Offsets` per instrument in :data:`BANDS` that the chart uses."""
    stem = song.drums
    if not stem.exists():
        raise StageError(f"no drum stem at {stem}; run `drums separate` first")

    hits = read_hits(song.tab_midi)
    y, sr = onsets.load_mono(stem)
    spectrum = onsets.magnitudes(y)
    times = onsets.envelope_times(spectrum.shape[1], sr)

    out: list[Offsets] = []
    for instrument, (fmin, fmax) in BANDS.items():
        written = [h for h in hits if midi_map.get(h.note) == instrument]
        if not written:
            continue
        env = onsets.normalize(onsets.superflux(y, sr, fmin, fmax, spectrum=spectrum))
        found = onsets.pick_onsets(env, times, delta=0.06, wait=0.04)
        values: list[float] = []
        for hit in written:
            at = slot_to_seconds(grid, hit.slot)
            if at is None or found.size == 0:
                continue
            nearest = found[int(np.argmin(np.abs(found - at)))]
            delta_ms = (nearest - at) * 1000.0
            if abs(delta_ms) <= MATCH_MS:
                values.append(float(delta_ms))
        out.append(
            Offsets(instrument=instrument, values=np.asarray(values), written=len(written))
        )
    return out
