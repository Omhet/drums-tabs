"""Beat-grid repair -- the keystone.

Everything downstream is expressed in terms of this grid. Quantization snaps
onsets by *beat phase* within it, and alphaTab's cursor follows sync points
derived from the same beat times. So a wrong downbeat phase doesn't degrade the
transcription, it invalidates every bar of it, and a tempo-octave error
invalidates every duration. That is why this module exists before any
transcription does, and why its output is pinned in ``grid.lock.json`` rather
than recomputed on each run.

The repair is deliberately conservative in one specific way: **``beat_this`` is
trusted unless there is positive evidence against it.** It is a strong detector,
and a "correction" applied on a weak signal is worse than no correction, because
it fails silently and plausibly. So each override -- tempo octave, downbeat
rotation -- has a stated trigger, records its evidence in the lock file, and can
be forced by hand from ``song.toml`` or the CLI when the evidence is ambiguous.

Four repairs happen here, in order:

1. **Interval repair.** Compare each gap to a *local* median, so a song that
   speeds up isn't repaired into oblivion. A gap near 2x means a dropped beat;
   near 0.5x means a spurious one.
2. **Tempo octave.** Only reconsidered when the detected tempo is implausible or
   the grid shows no backbeat at all.
3. **Downbeat phase.** One global phase for the whole song, chosen from the
   snare's position -- backbeats on 2 and 4.
4. **Bar one.** The count-in becomes a bar-index offset, never a cut, because
   trimming audio would desynchronise stems, video and sync points.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import soundfile as sf

from scipy import ndimage

from pipeline import beats as beats_mod
from pipeline import onsets, paths
from pipeline.proc import StageError

GRID_VERSION = 1

# Tempo range a drum cover realistically sits in. Used only as a trigger for
# reconsidering the octave -- never to reject an otherwise well-supported grid.
PLAUSIBLE_BPM = (70.0, 190.0)

# A backbeat margin above this counts as "this grid has a backbeat where it
# should". Margins are Michelson contrasts in [-1, 1] -- (on - off) / (on + off)
# -- so the number means something independent of how loud the mix is, and the
# threshold doesn't have to be recalibrated per song. A clean rock backbeat
# scores 0.5 and up; 0.15 is a low bar deliberately, because this only decides
# whether to leave the detector alone.
BACKBEAT_CONFIDENT = 0.15

# How much better a rival rotation must score before we override the detector's
# own downbeat phase. Deliberately not zero: near-ties should stay put.
ROTATION_MARGIN = 0.10

MAX_INSERT_RUN = 8  # a gap wider than this many beats is a break, not a dropped beat

# Edge trimming: how many beats may be dropped from each end, and how much wider
# than the median a gap must be to count one as isolated.
MAX_EDGE_TRIM = 12
EDGE_GAP_RATIO = 1.8

# Local double-time: a stretch whose local median interval falls below this
# fraction of the song's is the detector having switched metrical level, not the
# band having doubled tempo. The run must be at least this many beats long -- a
# short burst is a fill, and halving it would be the actual error.
LOCAL_OCTAVE_RATIO = 0.62
LOCAL_OCTAVE_MIN_RUN = 16
LOCAL_MEDIAN_WINDOW = 17


@dataclass
class DrumSupport:
    """Kick- and snare-band onset envelopes from ``drums.wav``.

    Not per-drum stems -- this pipeline has none. A frequency band on the whole
    drum kit is a crude snare proxy, but the grid only asks it a coarse question
    ("is there a backbeat here"), which it answers well enough.
    """

    times: np.ndarray
    kick: np.ndarray
    snare: np.ndarray

    @classmethod
    def from_stem(cls, drums_path: Path) -> "DrumSupport":
        y, sr = onsets.load_mono(drums_path)
        kick = onsets.normalize(onsets.superflux(y, sr, *onsets.BANDS["kick"]))
        # Snare energy lives in two places: the shell's body tone and the wire
        # rattle up top. Summing both bands distinguishes a snare from a floor
        # tom, which shares the body band but has almost nothing above 2 kHz.
        body = onsets.normalize(onsets.superflux(y, sr, *onsets.BANDS["snare_body"]))
        crack = onsets.normalize(onsets.superflux(y, sr, *onsets.BANDS["snare_crack"]))
        snare = onsets.normalize(body + crack)
        return cls(times=onsets.envelope_times(len(kick), sr), kick=kick, snare=snare)


@dataclass
class GridScore:
    """How well a candidate beat array is explained by the drums."""

    bpm: float
    rotation: int
    backbeat_margin: float
    rotation_margins: list[float]
    snare_alignment: float
    coverage: float
    plausible_tempo: bool

    def as_dict(self) -> dict:
        return {
            "bpm": round(self.bpm, 2),
            "rotation": self.rotation,
            "backbeat_margin": round(self.backbeat_margin, 4),
            "rotation_margins": [round(m, 4) for m in self.rotation_margins],
            "snare_alignment": round(self.snare_alignment, 4),
            "coverage": round(self.coverage, 4),
            "plausible_tempo": self.plausible_tempo,
        }


@dataclass
class Grid:
    """The repaired grid. Serialised to ``grid.lock.json`` and never recomputed casually."""

    beats: np.ndarray
    beats_per_bar: int
    downbeat_offset: int
    bar_one_beat: int
    bar_count: int
    score: GridScore
    repair: dict = field(default_factory=dict)
    source: dict = field(default_factory=dict)
    # video time - mix time, pinned by `drums align`; None until measured.
    video_offset_ms: float | None = None

    @property
    def count_in_bars(self) -> int:
        return (self.bar_one_beat - self.downbeat_offset) // self.beats_per_bar

    def downbeat_times(self) -> np.ndarray:
        return self.beats[self.downbeat_offset :: self.beats_per_bar]

    def bar_start(self, bar: int) -> float:
        """Start time of bar ``bar`` (1-indexed, as printed in the score)."""
        index = self.bar_one_beat + (bar - 1) * self.beats_per_bar
        if not 0 <= index < len(self.beats):
            raise IndexError(f"bar {bar} is outside the grid")
        return float(self.beats[index])


# --------------------------------------------------------------------------
# 1. interval repair
# --------------------------------------------------------------------------


def _local_median_interval(times: np.ndarray, index: int, window: int = 9) -> float:
    """Median beat interval near ``index``.

    Local rather than global so a song that accelerates through a section isn't
    read as a run of dropped and inserted beats.
    """
    lo = max(0, index - window // 2)
    hi = min(len(times), index + window // 2 + 1)
    diffs = np.diff(times[lo:hi])
    if diffs.size == 0:
        diffs = np.diff(times)
    return float(np.median(diffs))


#: An interval this far above its neighbours is a phase slip, not a tempo. The
#: seams this closes are ~1.5x; real rubato inside a bar does not reach 1.25x.
SEAM_RATIO = 1.25

#: ...and a phase slip is *half a beat*, so anything much past 1.5x is something
#: else and must be left alone. A breakdown with the drums out is a real hole in
#: the beat map (``repair_intervals`` deliberately leaves it as one), and pulling
#: the rest of the song back across it would be the worst kind of repair: silent,
#: and wrong from there to the end.
SEAM_RATIO_MAX = 1.75

#: A song cannot plausibly have more seams than this; the loop is bounded so a
#: pathological grid cannot spin here.
MAX_SEAMS = 32


def realign_seams(times: np.ndarray) -> tuple[np.ndarray, list[dict]]:
    """Pull the grid back into phase after a halved run.

    Halving a double-time run keeps every other beat, and which parity survives
    is fixed at the run's start. When the run spans an odd number of half-beats
    the beats *after* it are left half a beat out of phase with it, which shows
    up as a single interval of about 1.5x.

    Closing that seam is not cosmetic. The straightened render's playback speed
    follows the beat spacing, so a 1.5x interval is a 1.5x lurch in speed --
    about a fifth of pitch, at one beat's notice. And the error does not stay
    put: every beat after the seam is late by the excess, so the chart drifts
    off the record for the rest of the song.

    Each seam is closed by pulling everything after it back by the excess over
    the local interval, earliest first. That keeps the beat count -- no beat is
    invented or lost, they are only re-phased -- so bar numbering downstream is
    untouched.
    """
    out = np.array(times, dtype=np.float64)
    closed: list[dict] = []
    for _ in range(MAX_SEAMS):
        diffs = np.diff(out)
        if diffs.size < 2:
            break
        local = ndimage.median_filter(diffs, size=LOCAL_MEDIAN_WINDOW, mode="nearest")
        ratio = diffs / local
        over = np.where((ratio > SEAM_RATIO) & (ratio < SEAM_RATIO_MAX))[0]
        if over.size == 0:
            break
        i = int(over[0])
        excess = float(diffs[i] - local[i])
        closed.append(
            {"at": round(float(out[i]), 3), "pulled_back_ms": round(excess * 1000.0, 1)}
        )
        out[i + 1 :] -= excess
    return out, closed


def repair_local_octave(times: np.ndarray) -> tuple[np.ndarray, dict]:
    """Halve stretches where the detector switched to double time mid-song.

    Distinct from the global octave check, and not a hypothetical: ``beat_this``
    tracked one of the validation songs at 176 BPM for 43 seconds of an 88 BPM
    track -- a third of the song, silently, with the rest correct. A single
    global multiplier cannot express that, and every bar inside the stretch
    would carry half the notes it should.

    The test is a local median interval well under the song's own, sustained
    over enough beats to be a section rather than a fill. Within such a run,
    every other beat is dropped, anchored to the last beat before the run so the
    surviving beats stay in phase with the rest of the grid.

    Two properties are worth stating because they aren't obvious:

    The comparison is against the median interval, so this can't misfire on a
    song that really is fast throughout -- if most of the beats are at the
    quicker rate then that rate *is* the median, nothing reads as local, and the
    decision falls through to :func:`choose_octave` where it belongs.

    A run spanning an odd number of half-beats cannot be tiled with whole ones,
    so one interval at the run's end comes out at 1.5x. That seam used to be
    left alone, on the reasoning that the half-beat was the boundary estimate's
    own uncertainty. It is not: it is a phase slip, and it is not local. Every
    beat after the seam is half a beat late, a second seam makes it a whole
    beat, and the error rides to the end of the song -- on *One For The Road*,
    four seams had dragged the last beat 1.3 s late, which is what sent the
    straightened render's pitch lurching and pulled the chart off the record
    through the back half of the song. :func:`realign_seams` closes them.
    """
    diffs = np.diff(times)
    empty = {"runs": [], "dropped": 0}
    if diffs.size < LOCAL_OCTAVE_MIN_RUN * 2:
        return times, empty

    global_median = float(np.median(diffs))
    local = ndimage.median_filter(diffs, size=LOCAL_MEDIAN_WINDOW, mode="nearest")
    fast = local < LOCAL_OCTAVE_RATIO * global_median

    drop = np.zeros(times.size, dtype=bool)
    runs: list[dict] = []
    for start, stop in _runs(fast):
        if stop - start < LOCAL_OCTAVE_MIN_RUN:
            continue
        # Beats `start` through `stop` bound the run; `start` is the last beat at
        # the correct rate, so keeping the even offsets from it preserves phase.
        drop[start + 1 : stop + 1 : 2] = True
        runs.append(
            {
                "from": round(float(times[start]), 3),
                "to": round(float(times[min(stop, times.size - 1)]), 3),
                "local_bpm": round(60.0 / float(np.median(diffs[start:stop])), 1),
                "song_bpm": round(60.0 / global_median, 1),
                "beats_dropped": int(drop[start + 1 : stop + 1].sum()),
                # 1.5 here means the run had an odd number of half-beats; see
                # the docstring. Anything else would be a bug.
                "end_seam_ratio": round((stop - start) % 2 * 0.5 + 1.0, 2),
            }
        )

    if not runs:
        return times, empty
    kept, closed = realign_seams(times[~drop])
    return kept, {"runs": runs, "dropped": int(drop.sum()), "seams_closed": closed}


def _runs(flags: np.ndarray) -> list[tuple[int, int]]:
    """Half-open [start, stop) index ranges of consecutive True values."""
    padded = np.concatenate([[False], flags, [False]])
    edges = np.diff(padded.astype(int))
    return list(zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)))


def trim_isolated_edges(times: np.ndarray) -> tuple[np.ndarray, dict]:
    """Drop beats the detector guessed in silence before or after the music.

    ``beat_this`` will happily emit a beat or two over a quiet intro, seconds
    apart, with nothing between them. Those aren't beats -- they're its best
    guess at where a pulse would be if there were one. Left in, they become bars
    1 and 2, and bar 1 lands in dead air, which offsets every bar number in the
    score by however many the intro contained.

    Only the *edges* are trimmed. An identical gap in the middle of the song is a
    breakdown, and the beats either side of it are real.
    """
    median = float(np.median(np.diff(times)))
    lo, hi = 0, len(times)
    while hi - lo > 8 and lo < MAX_EDGE_TRIM and times[lo + 1] - times[lo] > EDGE_GAP_RATIO * median:
        lo += 1
    while (
        hi - lo > 8
        and len(times) - hi < MAX_EDGE_TRIM
        and times[hi - 1] - times[hi - 2] > EDGE_GAP_RATIO * median
    ):
        hi -= 1
    return times[lo:hi], {"head": lo, "tail": len(times) - hi}


def repair_intervals(times: np.ndarray) -> tuple[np.ndarray, dict]:
    """Insert beats into obvious gaps and drop obviously-doubled ones."""
    if len(times) < 4:
        raise StageError(f"only {len(times)} beats -- nothing to repair")

    out: list[float] = [float(times[0])]
    inserted = dropped = 0
    gaps: list[dict] = []

    for i in range(1, len(times)):
        local = _local_median_interval(times, i)
        gap = float(times[i]) - out[-1]
        ratio = gap / local if local > 0 else 1.0

        if ratio < 0.55:
            # Two detections of the same beat. Keep the earlier one; onset
            # detectors run slightly late more often than slightly early.
            dropped += 1
            gaps.append({"at": round(out[-1], 3), "ratio": round(ratio, 3), "action": "drop"})
            continue

        n = int(round(ratio))
        if 2 <= n <= MAX_INSERT_RUN and abs(ratio - n) < 0.25:
            base = out[-1]
            for k in range(1, n):
                out.append(base + gap * k / n)
            inserted += n - 1
            gaps.append(
                {"at": round(base, 3), "ratio": round(ratio, 3), "action": f"insert {n - 1}"}
            )
        elif ratio > 1.5:
            # A wide gap that isn't an integer multiple: a breakdown, a stop, or
            # the detector losing the pulse. Filling it would be invention.
            gaps.append({"at": round(out[-1], 3), "ratio": round(ratio, 3), "action": "left as gap"})

        out.append(float(times[i]))

    return np.asarray(out, dtype=float), {
        "inserted": inserted,
        "dropped": dropped,
        "events": gaps[:40],
    }


# --------------------------------------------------------------------------
# 2-3. tempo octave and downbeat phase
# --------------------------------------------------------------------------


def score_beats(candidate: np.ndarray, support: DrumSupport, beats_per_bar: int) -> GridScore:
    """Measure how well the drums explain a candidate beat array.

    Three independent quantities, because each catches a different failure:

    ``snare_alignment``  mean snare support *at* the beats. Collapses if the
        grid is at half the true rate, because then the backbeats fall between
        grid lines rather than on them.
    ``backbeat_margin``  snare support on beats 2 and 4 minus beats 1 and 3, for
        the best rotation. This is the downbeat phase test, and it also weakens
        at double rate, where real backbeats only hit every other candidate.
    ``coverage``  fraction of beats with any drum event nearby. Low coverage on a
        dense arrangement means the grid has beats the drummer never played.

    The backbeat test names beats 2 and 4 specifically, so it only says anything
    in 4/4. Under ``--meter 3/4`` it degrades to "no evidence" rather than to a
    wrong answer, and the rotation falls back to the detector's own downbeats.
    """
    if candidate.size < beats_per_bar * 2:
        return GridScore(0.0, 0, -1.0, [-1.0] * beats_per_bar, 0.0, 0.0, False)

    snare = onsets.support_at(support.snare, support.times, candidate)
    kick = onsets.support_at(support.kick, support.times, candidate)
    indices = np.arange(candidate.size)

    margins: list[float] = []
    for rotation in range(beats_per_bar):
        position = (indices - rotation) % beats_per_bar
        on_backbeat = np.isin(position, (1, 3))
        on_downbeat = np.isin(position, (0, 2))
        if not on_backbeat.any() or not on_downbeat.any():
            margins.append(-1.0)
            continue
        snare_term = _contrast(snare[on_backbeat].mean(), snare[on_downbeat].mean())
        # Kick on 1 is nearly as reliable as snare on 2 and 4, and it breaks the
        # tie between rotations 0 and 2, which the snare test cannot: both put
        # backbeats in the same places.
        kick_term = _contrast(kick[position == 0].mean(), kick[position != 0].mean())
        margins.append(snare_term + 0.5 * kick_term)

    best = int(np.argmax(margins))
    peak = float(snare.max()) or 1.0
    intervals = np.diff(candidate)
    bpm = 60.0 / float(np.median(intervals)) if intervals.size else 0.0
    return GridScore(
        bpm=bpm,
        rotation=best,
        backbeat_margin=margins[best],
        rotation_margins=margins,
        snare_alignment=float((snare / peak).mean()),
        coverage=float(np.mean(np.maximum(snare, kick) > 0.15)),
        plausible_tempo=PLAUSIBLE_BPM[0] <= bpm <= PLAUSIBLE_BPM[1],
    )


def _contrast(on: float, off: float) -> float:
    """Michelson contrast between two mean strengths, in [-1, 1].

    A difference of raw means would scale with how loud the drum stem happens to
    be, which makes any fixed threshold meaningless across songs. A contrast
    ratio doesn't, so the thresholds above can be constants.
    """
    total = float(on) + float(off)
    return float(on - off) / total if total > 1e-9 else 0.0


def _octave_candidates(beats: np.ndarray) -> dict[str, np.ndarray]:
    """The grid at half, unit and double rate.

    Halving has two phases -- keep the even beats or the odd ones -- and they are
    genuinely different grids, so both are offered.
    """
    midpoints = (beats[:-1] + beats[1:]) / 2.0
    doubled = np.empty(beats.size + midpoints.size, dtype=float)
    doubled[0::2] = beats
    doubled[1::2] = midpoints
    return {
        "half_even": beats[0::2],
        "half_odd": beats[1::2],
        "unit": beats,
        "double": doubled,
    }


def choose_octave(
    beats: np.ndarray, support: DrumSupport, beats_per_bar: int, *, forced: str | None = None
) -> tuple[str, np.ndarray, GridScore, dict]:
    """Pick the tempo octave, preferring the detector's own.

    The override only fires on positive evidence: the detected tempo is outside
    the plausible range, or the grid shows no backbeat at all. Otherwise
    ``beat_this``'s rate stands, whatever the alternatives score -- a "better"
    score on a rival octave is routine and usually meaningless, because every
    metrical level of a groove has some structure to find.
    """
    candidates = _octave_candidates(beats)
    scores = {name: score_beats(array, support, beats_per_bar) for name, array in candidates.items()}
    unit = scores["unit"]

    if forced:
        if forced not in candidates:
            raise StageError(
                f"unknown tempo multiplier {forced!r} (have: {', '.join(candidates)})"
            )
        return forced, candidates[forced], scores[forced], {
            "decision": "forced",
            "scores": {k: v.as_dict() for k, v in scores.items()},
        }

    suspicious = (not unit.plausible_tempo) or unit.backbeat_margin < 0.0
    if not suspicious:
        return "unit", candidates["unit"], unit, {
            "decision": "kept detector rate",
            "scores": {k: v.as_dict() for k, v in scores.items()},
        }

    # Something is off. Among the alternatives, take the best-supported grid
    # whose tempo is at least plausible; fall back to the detector if none is.
    ranked = sorted(
        (name for name in candidates if scores[name].plausible_tempo),
        key=lambda name: (
            scores[name].backbeat_margin + 0.5 * scores[name].snare_alignment
        ),
        reverse=True,
    )
    if not ranked:
        return "unit", candidates["unit"], unit, {
            "decision": "no plausible alternative; kept detector rate",
            "scores": {k: v.as_dict() for k, v in scores.items()},
        }
    winner = ranked[0]
    reason = (
        f"detector rate {unit.bpm:.1f} BPM is outside {PLAUSIBLE_BPM}"
        if not unit.plausible_tempo
        else f"detector rate shows no backbeat (margin {unit.backbeat_margin:.3f})"
    )
    return winner, candidates[winner], scores[winner], {
        "decision": f"switched to {winner}: {reason}",
        "scores": {k: v.as_dict() for k, v in scores.items()},
    }


def choose_rotation(
    beats: np.ndarray,
    detected_downbeats: np.ndarray,
    score: GridScore,
    beats_per_bar: int,
    *,
    forced: int | None = None,
) -> tuple[int, dict]:
    """One global downbeat phase for the whole song.

    Per-bar downbeats from the detector are *not* trusted: a single spurious
    3-beat bar shifts every bar after it, and there is no local evidence that
    would let a later stage notice. So the phase is a single number, taken from
    the modal detected downbeat, and overridden only when the snare clearly
    disagrees.
    """
    modal = _modal_detector_rotation(beats, detected_downbeats, beats_per_bar)
    best = score.rotation
    margins = score.rotation_margins

    if forced is not None:
        return forced % beats_per_bar, {
            "decision": "forced",
            "detector_rotation": modal,
            "margins": [round(m, 4) for m in margins],
        }

    if modal is None:
        return best, {
            "decision": f"detector gave no usable downbeats; used snare (rotation {best})",
            "detector_rotation": None,
            "margins": [round(m, 4) for m in margins],
        }
    if modal == best:
        return modal, {
            "decision": "detector and snare agree",
            "detector_rotation": modal,
            "margins": [round(m, 4) for m in margins],
        }
    if margins[modal] >= BACKBEAT_CONFIDENT:
        return modal, {
            "decision": (
                f"kept detector rotation {modal}: its backbeat is already clear "
                f"({margins[modal]:.3f})"
            ),
            "detector_rotation": modal,
            "margins": [round(m, 4) for m in margins],
        }
    if margins[best] - margins[modal] >= ROTATION_MARGIN:
        return best, {
            "decision": (
                f"rotated {modal} -> {best}: snare sits on 2 and 4 there "
                f"({margins[best]:.3f} vs {margins[modal]:.3f})"
            ),
            "detector_rotation": modal,
            "margins": [round(m, 4) for m in margins],
        }
    return modal, {
        "decision": f"kept detector rotation {modal}: rival margin too close to call",
        "detector_rotation": modal,
        "margins": [round(m, 4) for m in margins],
    }


def _modal_detector_rotation(
    beats: np.ndarray, detected_downbeats: np.ndarray, beats_per_bar: int
) -> int | None:
    """Which beat index, mod the bar length, the detector's downbeats mostly land on."""
    if detected_downbeats.size == 0 or beats.size == 0:
        return None
    nearest = np.searchsorted(beats, detected_downbeats).clip(0, beats.size - 1)
    # searchsorted rounds up; step back where the earlier beat is actually closer.
    lower = (nearest - 1).clip(0, beats.size - 1)
    pick_lower = np.abs(beats[lower] - detected_downbeats) < np.abs(
        beats[nearest] - detected_downbeats
    )
    nearest = np.where(pick_lower, lower, nearest)
    counts = np.bincount(nearest % beats_per_bar, minlength=beats_per_bar)
    return int(np.argmax(counts))


# --------------------------------------------------------------------------
# 4. bar one
# --------------------------------------------------------------------------


def find_bar_one(
    beats: np.ndarray, rotation: int, support: DrumSupport, beats_per_bar: int
) -> tuple[int, dict]:
    """Bar 1 is the first downbeat at or before the first kick or snare.

    Note "kick or snare", not "any onset": a stick-count on the hi-hats is
    exactly the thing this is meant to skip past. And note that nothing is cut --
    the count-in bars keep existing, with non-positive bar numbers.
    """
    combined = np.maximum(support.kick, support.snare)
    first_hit = onsets.first_strong_onset(combined, support.times)
    downbeat_indices = np.arange(rotation, beats.size, beats_per_bar)
    if downbeat_indices.size == 0:
        raise StageError("no complete bar in the grid")

    if first_hit is None:
        return int(downbeat_indices[0]), {
            "decision": "no confident first hit; bar 1 is the first downbeat",
            "first_hit": None,
        }

    downbeat_times = beats[downbeat_indices]
    at_or_before = np.flatnonzero(downbeat_times <= first_hit + 0.05)
    if at_or_before.size == 0:
        # The hit predates the grid, which happens when edge trimming removed
        # beats the detector guessed over an intro the drummer wasn't playing in.
        return int(downbeat_indices[0]), {
            "decision": (
                f"first kick/snare at {first_hit:.2f}s is before the grid starts "
                f"({beats[0]:.2f}s); bar 1 is the first downbeat"
            ),
            "first_hit": round(first_hit, 3),
            "count_in_bars": 0,
        }
    chosen = int(downbeat_indices[at_or_before[-1]])
    skipped = (chosen - rotation) // beats_per_bar
    return chosen, {
        "decision": (
            f"first kick/snare at {first_hit:.2f}s; skipped {skipped} bar(s) of intro"
            if skipped
            else f"first kick/snare at {first_hit:.2f}s; bar 1 is the first downbeat"
        ),
        "first_hit": round(first_hit, 3),
        "count_in_bars": int(skipped),
    }


# --------------------------------------------------------------------------
# build + persist
# --------------------------------------------------------------------------


def build(
    song: paths.Song,
    *,
    beats_per_bar: int = 4,
    beat_unit: int = 4,
    tempo_multiplier: str | None = None,
    rotation: int | None = None,
) -> Grid:
    """Run the whole repair and return a :class:`Grid`. Does not write anything."""
    if not song.drums.exists():
        raise StageError(f"no drum stem at {song.drums} -- run `drums separate` first")

    raw = beats_mod.load(song.raw_beats)
    support = DrumSupport.from_stem(song.drums)

    trimmed, trim_log = trim_isolated_edges(raw.times)
    unfolded, octave_log_local = repair_local_octave(trimmed)
    repaired, interval_log = repair_intervals(unfolded)
    # Again, because `repair_intervals` works in whole beats: inserting or
    # dropping one around a halved run can leave a fresh half-beat seam, or
    # re-open one just closed. Only where a run was actually halved -- a song
    # the detector never doubled has no phase to slip.
    if octave_log_local["runs"]:
        repaired, late_seams = realign_seams(repaired)
        octave_log_local["seams_closed"] += late_seams
    octave_name, chosen_beats, score, octave_log = choose_octave(
        repaired, support, beats_per_bar, forced=tempo_multiplier
    )
    chosen_rotation, rotation_log = choose_rotation(
        chosen_beats, raw.downbeat_times, score, beats_per_bar, forced=rotation
    )
    # The rotation may differ from the one that produced `score`, so re-derive the
    # margin that actually applies to the grid we're keeping.
    score = GridScore(
        bpm=score.bpm,
        rotation=chosen_rotation,
        backbeat_margin=score.rotation_margins[chosen_rotation],
        rotation_margins=score.rotation_margins,
        snare_alignment=score.snare_alignment,
        coverage=score.coverage,
        plausible_tempo=score.plausible_tempo,
    )
    bar_one, bar_one_log = find_bar_one(chosen_beats, chosen_rotation, support, beats_per_bar)

    remaining = chosen_beats.size - bar_one
    bar_count = max(0, remaining // beats_per_bar)
    if bar_count == 0:
        raise StageError("grid has no complete bar after the count-in")

    info = sf.info(str(song.mix))
    meta = song.meta()
    return Grid(
        beats=chosen_beats,
        beats_per_bar=beats_per_bar,
        downbeat_offset=chosen_rotation,
        bar_one_beat=bar_one,
        bar_count=bar_count,
        score=score,
        repair={
            "raw_beat_count": int(raw.times.size),
            "beat_count": int(chosen_beats.size),
            "edges_trimmed": trim_log,
            "local_octave": octave_log_local,
            "intervals": interval_log,
            "octave": {"chosen": octave_name, **octave_log},
            "rotation": rotation_log,
            "bar_one": bar_one_log,
            "tempo": _tempo_stats(chosen_beats),
        },
        source={
            "detector": "beat_this",
            "checkpoint": raw.checkpoint,
            "separation": _separation_model(song),
            "audio_duration": round(info.frames / info.samplerate, 3),
            "sample_rate": info.samplerate,
            "video_id": meta.get("source", {}).get("video_id", ""),
            "beat_unit": beat_unit,
        },
    )


def _separation_model(song: paths.Song) -> str:
    manifest = song.stems_dir / "separation.json"
    if not manifest.exists():
        return ""
    try:
        return json.loads(manifest.read_text(encoding="utf-8")).get("model", "")
    except ValueError:
        return ""


def _tempo_stats(beats: np.ndarray) -> dict:
    """Median tempo plus how much it moves -- the number that justifies per-beat quantization."""
    intervals = np.diff(beats)
    if intervals.size == 0:
        return {}
    bpm = 60.0 / intervals
    smooth = np.convolve(bpm, np.ones(8) / 8, mode="valid") if bpm.size >= 8 else bpm
    # Percentiles, not min and max: a grid legitimately contains a few enormous
    # intervals where the detector left a gap through a breakdown, and letting
    # those define the range reports 150% drift on a song that never moves.
    low, high = (float(v) for v in np.percentile(smooth, [10, 90]))
    median = float(np.median(bpm))
    return {
        "median_bpm": round(median, 2),
        "p10_bpm": round(low, 2),
        "p90_bpm": round(high, 2),
        "drift_pct": round((high - low) / median * 100, 2),
    }


def to_dict(grid: Grid) -> dict:
    return {
        "version": GRID_VERSION,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": grid.source,
        "meter": {
            "beats_per_bar": grid.beats_per_bar,
            "beat_unit": grid.source.get("beat_unit", 4),
        },
        "downbeat_offset": grid.downbeat_offset,
        "bar_one_beat": grid.bar_one_beat,
        "count_in_bars": grid.count_in_bars,
        "bar_count": grid.bar_count,
        "score": grid.score.as_dict(),
        "video_offset_ms": grid.video_offset_ms,
        "repair": grid.repair,
        # Millisecond precision. Finer would be false precision -- the detector's
        # own frame hop is 20 ms -- and it keeps the lock file diffable.
        "beats": [round(float(t), 3) for t in grid.beats],
    }


def save(song: paths.Song, grid: Grid) -> Path:
    song.grid_lock.parent.mkdir(parents=True, exist_ok=True)
    song.grid_lock.write_text(json.dumps(to_dict(grid), indent=2), encoding="utf-8")
    return song.grid_lock


def load(song: paths.Song) -> Grid:
    """Read a pinned grid back. Bar indices must stay stable across pipeline runs."""
    if not song.grid_lock.exists():
        raise StageError(f"no grid at {song.grid_lock} -- run `drums grid` first")
    data = json.loads(song.grid_lock.read_text(encoding="utf-8"))
    if data.get("version") != GRID_VERSION:
        raise StageError(
            f"{song.grid_lock} is version {data.get('version')}, this build writes "
            f"{GRID_VERSION} -- re-run with --regrid (bar indices may move)"
        )
    score = data.get("score", {})
    return Grid(
        beats=np.asarray(data["beats"], dtype=float),
        beats_per_bar=data["meter"]["beats_per_bar"],
        downbeat_offset=data["downbeat_offset"],
        bar_one_beat=data["bar_one_beat"],
        bar_count=data["bar_count"],
        score=GridScore(
            bpm=score.get("bpm", 0.0),
            rotation=score.get("rotation", 0),
            backbeat_margin=score.get("backbeat_margin", 0.0),
            rotation_margins=score.get("rotation_margins", []),
            snare_alignment=score.get("snare_alignment", 0.0),
            coverage=score.get("coverage", 0.0),
            plausible_tempo=score.get("plausible_tempo", True),
        ),
        repair=data.get("repair", {}),
        source=data.get("source", {}),
        video_offset_ms=data.get("video_offset_ms"),
    )


def beat_position(grid: Grid, times: np.ndarray) -> np.ndarray:
    """Continuous beat index for each time -- the quantization primitive.

    For a time ``t`` between beats ``b_k`` and ``b_{k+1}``, this returns
    ``k + (t - b_k) / (b_{k+1} - b_k)``. Interpolating *within* each beat rather
    than against a global tempo is what makes quantization drift-immune: at 160
    BPM a 0.3% tempo error accumulates to half a beat over four minutes, which
    would flip notes to the wrong 16th through the whole back half of a song.

    Times outside the grid extrapolate from the nearest interval, so a fill that
    starts a hair before beat one doesn't blow up.
    """
    beats = grid.beats
    if beats.size < 2:
        raise StageError("grid has fewer than two beats")
    times = np.atleast_1d(np.asarray(times, dtype=float))
    index = np.clip(np.searchsorted(beats, times) - 1, 0, beats.size - 2)
    span = beats[index + 1] - beats[index]
    return index + (times - beats[index]) / span


def bar_position(grid: Grid, times: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(bar number, phase within the bar in beats) for each time.

    Bar numbers are 1-based and match what the score prints; the count-in gets
    zero and negative numbers, which is exactly the "offset, never a cut"
    invariant made visible.
    """
    position = (beat_position(grid, times) - grid.bar_one_beat) / grid.beats_per_bar
    bar = np.floor(position).astype(int) + 1
    phase = (position - np.floor(position)) * grid.beats_per_bar
    return bar, phase
