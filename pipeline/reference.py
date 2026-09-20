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

It used to be a diagnostic only -- a number printed once that you then had to
remember and apply in your head to every take you ever played. That decision was
taken deliberately and has now been taken the other way: the measurement is
written to ``reference.lock.json`` and the player subtracts it, so **zero means
"sitting where the record sits"** rather than "sitting on a grid nobody played
to". The split is still printed, because whether the floor is the whole kit or
just the kick is worth seeing.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pipeline import onsets, paths
from pipeline.chart import SLOTS_PER_BEAT, read_hits
from pipeline.grid import Grid
from pipeline.proc import StageError

#: Bumped when the shape of ``reference.lock.json`` changes.
VERSION = 1

#: Beyond this the nearest onset is a different note, not this one played late.
MATCH_MS = 90.0

#: A kick and a snare do not share a frequency range, and one broadband envelope
#: would let the louder of them mask the other.
#:
#: One wide snare band here, rather than the body/crack split in
#: :data:`pipeline.onsets.BANDS`. That split is there to tell a snare from a
#: floor tom, which the grid repair has to do unaided; this already knows which
#: note is a snare, because the chart names it.
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


# --- the lock file ----------------------------------------------------------------
#
# Pinned to the chart hash, like ``sticking.lock.json``: the measurement is of
# the record *against this notation*, so moving a note in Live moves the floor
# with it and a lock solved from the old chart must be able to say so.


def path_for(song: paths.Song) -> Path:
    return song.root / "reference.lock.json"


def summarise(measured: list[Offsets], chart: str) -> dict:
    """The lock's contents: the floor the player subtracts, and the split behind it.

    ``mean_ms`` is one number for the whole kit, and that is a simplification
    worth stating: only kick and snare can be measured (:data:`BANDS`), and on
    some records they do not sit together -- a kick well behind the grid and a
    snare on top of it average to a floor that is right for neither. One number
    is still the honest default, because it is the one that can be explained in
    a sentence; the per-instrument split is kept here so that a later version
    can refine it without re-measuring anything.
    """
    values = [o.values for o in measured if o.values.size]
    every = np.concatenate(values) if values else np.empty(0)
    return {
        "version": VERSION,
        "chart": chart,
        "mean_ms": round(float(every.mean()), 2) if every.size else 0.0,
        "median_ms": round(float(np.median(every)), 2) if every.size else 0.0,
        "matched": int(every.size),
        "written": sum(o.written for o in measured),
        "instruments": [
            {
                "instrument": o.instrument,
                "matched": int(o.values.size),
                "written": o.written,
                "mean_ms": round(o.mean_ms, 2),
                "median_ms": round(o.median_ms, 2),
                "sd_ms": round(o.sd_ms, 2),
            }
            for o in measured
        ],
    }


def save(song: paths.Song, measured: list[Offsets], chart: str) -> dict:
    """Write ``reference.lock.json`` and return what was written."""
    body = summarise(measured, chart)
    path_for(song).write_text(json.dumps(body, indent=1) + "\n", encoding="utf-8")
    return body


def load(song: paths.Song) -> dict | None:
    """The lock, or nothing if it is absent or written by a version we cannot read."""
    path = path_for(song)
    if not path.exists():
        return None
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return body if int(body.get("version", 0)) == VERSION else None
