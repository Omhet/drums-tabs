"""Per-stem SuperFlux detection with cross-stem arbitration: the Phase 3 backend.

drumsep has already split the drum stem into kick, snare, toms, hi-hat, ride and
crash, so most of the hard part of drum transcription -- deciding *which* drum
made a transient -- is answered by which file the transient is in.

That answer is not free of doubt, though, and Phase 1b's numbers said so: 14% of
its snare notes had no counterpart in the bars either side, and up to a quarter
of them were quiet ones sitting on a slot that also had a kick. A separator
splits by learned timbre, not by microphone, so a kick's fundamental leaves a
shadow in the snare stem's body band, and peak-picking each stem alone has no
way to tell that shadow from a soft snare. **The stems have to be read
together.** Three mechanisms do that here, in this order:

1. **Share.** For each candidate, what fraction of the *whole kit's* energy in
   this band, at this moment, is in this stem? A real snare owns its band; a
   kick's shadow in the snare stem is a slice of a band the kick stem owns. That
   single ratio is what makes strengths from different drums comparable at all,
   because every stem's share is a fraction of the same signal.
2. **Winner-take-all across stems** (:func:`arbitrate`), clustering candidates
   that land within a few tens of milliseconds of each other and dropping the
   ones the cluster's winner explains, with extra suspicion along the pairs
   where the physics says leakage goes one way -- kick into snare and toms,
   crash into hi-hat and ride, snare into toms.
3. **Per-slot thresholds** (:func:`slot_floors`). Drummers repeat themselves. A
   marginal hit on a slot the surrounding bars agree on is probably real; the
   same marginal hit where nothing nearby plays probably isn't. Loud hits are
   never judged this way, so fills and section changes survive intact.

**Still three emitted classes**: kick, snare and closed hi-hat. Toms, ride and
crash are detected but not notated -- they are here as *evidence*, because you
cannot tell that a hi-hat candidate is crash wash without looking at the crash.
Emitting them needs the classification work Phase 3 hasn't done yet (which tom,
open or closed hat), and a crude guess there produces notation that looks
authoritative and is wrong.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np

from pipeline import grid as grid_mod
from pipeline import onsets, paths
from pipeline.backends.base import Backend, OnsetEvent, register
from pipeline.grid import bar_position
from pipeline.proc import StageError, note
from pipeline.separation import drumsep


@dataclass(frozen=True)
class _Detector:
    """How one instrument is picked out of its stem.

    ``delta`` is the peak-picking threshold on the normalised flux envelope and
    ``min_ioi`` the shortest gap between two hits on the same drum -- the kick's
    is the tightest, because double-kick sixteenths at 180 BPM are 83 ms apart
    and anything laxer collapses a fast passage into single notes.

    ``min_attack`` is a *relative* floor on flux peak height: a transient below
    this fraction of the sharpest this drum gets hit in the same song is not an
    attack. It is the anti-artefact test, and it is not interchangeable with the
    velocity floor further down even though Phase 1b used one number for both.
    A kick's pitch envelope drops as it decays and makes a second flux peak
    60-90 ms behind the hit; that artefact is *loud*, because the drum is still
    ringing through it, so no measure of level will ever reject it. What it is
    not is sharp. (Measured: dropping this floor and judging kicks on level
    alone added 64% more kicks to one song and took its p90 snap error from
    24 ms to 40 -- the extra notes were the decays, landing between the slots.)

    ``emit`` is what separates the three notated classes from the three that
    exist only to argue against them.
    """

    stem: str
    bands: tuple[str, ...]
    delta: float
    min_ioi: float
    min_attack: float = 0.15
    emit: bool = True


DETECTORS: dict[str, _Detector] = {
    "kick": _Detector("kick", ("kick",), delta=0.14, min_ioi=0.055),
    # Both snare bands: the shell's body tone and the wire rattle. Summing them
    # separates a snare from a floor tom, which shares the body band and has
    # nothing above 2 kHz -- and it is what makes the kick-bleed case decidable,
    # since a kick reaches into the body band and not into the crack band.
    "snare": _Detector("snare", ("snare_body", "snare_crack"), delta=0.14, min_ioi=0.050),
    # Lower delta, because hats are played quietly on purpose. A hat floor as
    # high as the snare's erases the soft notes between the accents, which is
    # most of what a hi-hat part is.
    "hihat_closed": _Detector("hihat", ("hihat",), delta=0.12, min_ioi=0.045, min_attack=0.12),
    # Evidence only -- never notated. Thresholds match the drums they argue
    # against, so a cymbal that outranks a hi-hat was picked on equal terms.
    "toms": _Detector("toms", ("toms",), delta=0.14, min_ioi=0.060, emit=False),
    "ride": _Detector("ride", ("ride",), delta=0.12, min_ioi=0.045, min_attack=0.12, emit=False),
    "crash": _Detector("crash", ("crash",), delta=0.12, min_ioi=0.060, min_attack=0.12, emit=False),
}

# A hit must show up in the *unsplit* drum stem too, at least this strongly.
# drumsep occasionally invents quiet material in a stem where the drum in
# question is silent -- an intro, a breakdown -- and those inventions have no
# counterpart in drums.wav. Share cannot catch this on its own: in silence both
# numerator and denominator are near zero and their ratio means nothing.
GATE_SUPPORT = 0.08

# How far either side of a detected peak to look for that support. Wide enough
# to absorb the few-millisecond disagreement between two envelopes computed from
# different audio, narrow enough not to borrow the neighbouring beat's evidence.
GATE_WINDOW = 0.030

# --- cross-stem arbitration ------------------------------------------------

# Two candidates this close are one event seen from two stems, not two hits.
# The frame hop is 5.8 ms and separated stems disagree by a frame or two even
# when they agree, so anything much tighter splits an event in half; much wider
# and a fast sixteenth-note pair merges into one.
CLUSTER_WINDOW = 0.025

# The generic rule: within a cluster, a stem whose share is under this fraction
# of the best share present is explained by the winner rather than by a drum of
# its own.
KEEP_RATIO = 0.35

# ...but "present" means present *among drums this one could be mistaken for*.
# Share is a fraction of a band, so it is only comparable between stems whose
# bands are the same region -- a kick owning its 30-120 Hz says nothing about
# whether a hi-hat is sounding at 8 kHz. Compared across the whole kit the rule
# produces false negatives at exactly the moments a drummer plays two things at
# once: on Stayin' Alive it deleted 32 hi-hats from beats 2 and 4, because the
# snare's crack band is loud there and dilutes the hat's share of the top end.
# The backbeat hi-hat of a disco tune is not an artefact of the backbeat.
CONFUSION_GROUPS: tuple[frozenset[str], ...] = (
    # Heads. Their bodies all live below about 500 Hz, which is where a
    # separator has the least to go on.
    frozenset({"kick", "snare", "toms"}),
    # Cymbals. Nothing distinguishes these but decay shape, and a 128 kbps
    # YouTube encode has already smeared that.
    frozenset({"hihat_closed", "ride", "crash"}),
)

# The floor a candidate has to clear on its own, in a cluster where nothing is
# confident. Unplayed stems are the reason this exists: in a song with no ride,
# the ride stem still yields hundreds of peaks, and they sit at a share of about
# 0.01 -- they are the ride stem's portion of somebody else's cymbal.
MIN_SHARE = 0.12

# Where the separator's leakage is directional, the generic ratio is too kind.
# Each entry reads "for this suppressor, the victim must hold at least this
# fraction of the suppressor's share, or it is that suppressor's shadow". The
# defaults are starting points; :func:`calibrate` replaces them per song.
SUPPRESSION: dict[tuple[str, str], float] = {
    # The one Phase 1b measured: half-velocity snares on the beats where the
    # kick lands, in songs whose backbeat is elsewhere.
    ("kick", "snare"): 0.45,
    ("kick", "toms"): 0.45,
    ("snare", "toms"): 0.45,
    # A crash covers the hi-hat and ride bands whole. You hit a crash *instead
    # of* the hat, so the prior is against both sounding at once.
    ("crash", "hihat_closed"): 0.45,
    ("crash", "ride"): 0.45,
}

# Calibration: what a *real* victim hit looks like in this song, measured on the
# ones that occur with no suppressor anywhere near them. The low percentile is
# deliberate -- the threshold should sit under the weakest genuine hits, not at
# the typical one.
CALIBRATION_PERCENTILE = 10.0
CALIBRATION_MIN_EVENTS = 12
CALIBRATION_CLAMP = (0.25, 0.60)

# --- per-slot thresholds ---------------------------------------------------

# Bars either side to ask about a slot. Deliberately narrower than the +/-4 the
# `drums score-stats` scoreboard uses, so the detector is not simply optimising
# the number that grades it.
SLOT_RADIUS = 3

# A candidate at or above this velocity is never judged by its context. This is
# the line between "evidence-weighted" and "snap to a template": a fill, a
# section change, a crash on a slot nothing else in the song touches, all clear
# this on their own and are kept whatever the neighbouring bars do. Only hits
# too quiet to speak for themselves are asked whether anything agrees with them.
EVIDENCE_VELOCITY = 0.45

# Who votes on where a drum plays: everything that survived arbitration, with
# no further confidence test. Two attempts at a stricter electorate both failed,
# and in the same way -- whatever test they used, the hits it excluded were the
# ones that most needed the slot established:
#
# - By loudness: in sixteenth funk almost every hi-hat sits below any fixed
#   loudness line, so nothing voted, no slot looked supported, and the whole
#   part fell through the strict floor (the Vulfpeck tune: 716 notes to 315).
# - By share: where a drum is *systematically* masked -- dead horse plays its
#   hi-hat on the backbeat, under the snare, every bar -- masking pushes the
#   share below the line, so the slot is never established, so every masked hit
#   is cut. Exactly the notes to protect, removed for being hard to see. It
#   cost 32 of the 48 backbeat hi-hats in that song.
#
# What makes an open electorate safe is that arbitration has already run.
# Systematic bleed is what would vote itself into existence, and systematic
# bleed is precisely what cross-stem arbitration removes: Stayin' Alive's
# phantom snares on beat 1 are down from 104 to 17 before a single vote is
# cast. Letting the remaining 17 vote costs 3 notes and buys back 29 real
# hi-hats in the other song.

# The band the context moves the floor across. A slot every neighbouring bar
# plays gets the low floor; a slot none of them do gets the high one. The old
# single global floor was 0.15 (0.12 for hats) and sat, necessarily, at neither.
#
# The bottom of the band is *low*, because velocity is now a linear amplitude
# ratio and a genuinely dynamic part spans an enormous range of it: on the
# Vulfpeck tune half the hi-hat notes sit below a quarter of the loudest, which
# is what sixteenth funk sounds like and not a detector failing. Once the
# surrounding bars agree that a slot is played, loudness has little left to add.
#
# At full support the floor is a sanity check and not a judgement: by the time a
# candidate is measured against it, it has already shown up in the unsplit drum
# stem, been sharp enough to be a strike, held its band against every other stem
# and landed on a slot the neighbouring bars all play. Asking it to also clear
# 2% of the loudest hit in the song excludes near-silence and nothing else.
SUPPORTED_FLOOR = 0.02
UNSUPPORTED_FLOOR = 0.32

# How fast support buys leniency. Squared rather than linear because the
# evidence saturates early: a slot played in half the neighbouring bars is
# already part of the groove, not half of a one-off, and a linear ramp keeps
# treating it as though it were halfway to being spurious.
SUPPORT_EXPONENT = 2.0

assert UNSUPPORTED_FLOOR < EVIDENCE_VELOCITY, "loud hits must clear the strictest floor"


@dataclass(frozen=True)
class Candidate:
    """One peak in one stem, before anything has decided whether it is a note.

    Three measurements, because three different things can be wrong with a peak,
    and one number cannot answer for all of them:

    - ``share`` -- *whose sound is this?* The fraction of the kit's energy in
      this band that this stem holds. Comparable between stems, because every
      share is a fraction of the same drums.wav. Low means another drum's
      shadow.
    - ``attack`` -- *is this a strike at all?* Flux peak height relative to the
      sharpest this drum is struck in this song. Low means a decay, a ring, a
      rebound: something the drum is still doing, not something done to it.
    - ``velocity`` -- *how hard?* Post-onset band level, relative to how hard
      this drum gets hit elsewhere in this song. This is the musical one, the
      one that becomes a ghost note or an accent, and the only one of the three
      a listener would recognise.
    """

    t: float
    instrument: str
    share: float
    attack: float
    level: float
    support: float
    velocity: float = 0.0


def cluster(times: list[float] | np.ndarray, *, window: float = CLUSTER_WINDOW) -> list[list[int]]:
    """Group indices into runs no wider than ``window``, earliest first.

    A run is closed as soon as a candidate falls more than ``window`` after the
    one that opened it, rather than after its predecessor: chaining off the
    latest member would let a dense sixteenth passage merge into a single
    cluster spanning half a beat.
    """
    order = sorted(range(len(times)), key=lambda i: times[i])
    groups: list[list[int]] = []
    for index in order:
        if groups and times[index] - times[groups[-1][0]] <= window:
            groups[-1].append(index)
        else:
            groups.append([index])
    return groups


def _confusable(one: str, other: str) -> bool:
    """Whether two instruments occupy a band region a separator can mix up."""
    return any(one in group and other in group for group in CONFUSION_GROUPS)


def calibrate(
    candidates: list[Candidate],
    *,
    suppression: dict[tuple[str, str], float] = SUPPRESSION,
    window: float = CLUSTER_WINDOW,
    min_share: float = MIN_SHARE,
) -> dict[tuple[str, str], float]:
    """Fit each suppression ratio to this song, from its isolated victim hits.

    The bleed level a separator leaks along one pair depends on the kit, the
    mix and the model's mood that day, so a constant is a guess. What the song
    can be asked directly is the other side of the same question: *when this
    drum is hit with no suppressor anywhere near it -- when it is unarguably
    itself -- how much of its band does it hold?* A low percentile of that is a
    floor genuine hits clear, so a coincident hit that falls below it is not
    behaving like a hit of that drum.

    Isolated in the strict sense: no suppressor candidate in the cluster at all.
    Songs where a drum never sounds alone (a snare only ever with a kick) yield
    too few such events to fit anything, and keep the default.

    Peaks below ``min_share`` are left out of the fit entirely. They are the
    unplayed stems' portion of other people's cymbals -- an unplayed ride offers
    hundreds of "isolated" peaks at a share of 0.01, and averaged in they drag
    every ratio to the clamp floor and say nothing about a real hit. Excluding
    them moved the fitted kick-into-snare ratio from a flat 0.25 everywhere to
    0.28 on Song 2, 0.35 on Engel and 0.40 on Stayin' Alive -- which is the
    right ordering: those are the songs' bleed severities, in order.
    """
    candidates = [c for c in candidates if c.share >= min_share]
    groups = cluster([c.t for c in candidates], window=window)
    isolated: dict[tuple[str, str], list[float]] = {}
    for group in groups:
        present = {candidates[i].instrument for i in group}
        for i in group:
            victim = candidates[i]
            for suppressor, target in suppression:
                if target == victim.instrument and suppressor not in present:
                    isolated.setdefault((suppressor, target), []).append(victim.share)

    fitted = dict(suppression)
    lo, hi = CALIBRATION_CLAMP
    for pair, default in suppression.items():
        shares = isolated.get(pair, [])
        if len(shares) < CALIBRATION_MIN_EVENTS:
            continue
        measured = float(np.percentile(shares, CALIBRATION_PERCENTILE))
        fitted[pair] = float(np.clip(measured, lo, hi))
    return fitted


def arbitrate(
    candidates: list[Candidate],
    *,
    ratio: float = KEEP_RATIO,
    min_share: float = MIN_SHARE,
    suppression: dict[tuple[str, str], float] | None = None,
    window: float = CLUSTER_WINDOW,
) -> list[str | None]:
    """Decide, per candidate, whether another stem already explains it.

    Returns one entry per input candidate in the input's order: ``None`` if it
    survives, otherwise a short reason. Pure -- no audio, no files, no ordering
    assumptions about the input -- so the rule can be tested against invented
    clusters rather than against a three-minute pipeline run.

    Every test is made against the *original* shares, never against a set that
    earlier drops have already thinned. Cascading would make the outcome depend
    on the order the pairs happen to be written in, and a suppressor that has
    itself just been ruled bleed should not go on to silence a third stem.
    """
    rules = SUPPRESSION if suppression is None else suppression
    verdicts: list[str | None] = [None] * len(candidates)

    for group in cluster([c.t for c in candidates], window=window):
        strongest: dict[str, float] = {}
        for i in group:
            entry = candidates[i]
            strongest[entry.instrument] = max(
                strongest.get(entry.instrument, 0.0), entry.share
            )
        for i in group:
            entry = candidates[i]
            if entry.share < min_share:
                verdicts[i] = "no share"
                continue
            rivals = [
                share
                for name, share in strongest.items()
                if name != entry.instrument and _confusable(name, entry.instrument)
            ]
            if rivals and entry.share < ratio * max(max(rivals), entry.share):
                verdicts[i] = "outranked"
                continue
            for (suppressor, target), pair_ratio in rules.items():
                if target != entry.instrument or suppressor not in strongest:
                    continue
                if entry.share < pair_ratio * strongest[suppressor]:
                    verdicts[i] = f"{suppressor} bleed"
                    break
    return verdicts


def slot_floors(
    bars: np.ndarray,
    slots: np.ndarray,
    instruments: list[str],
    *,
    radius: int = SLOT_RADIUS,
    supported: float = SUPPORTED_FLOOR,
    unsupported: float = UNSUPPORTED_FLOOR,
    exponent: float = SUPPORT_EXPONENT,
) -> np.ndarray:
    """The velocity floor each candidate has to clear, given its neighbours.

    A groove is one bar played over and over. So for a candidate at bar *b*,
    slot *s*, look at the nearest ``radius`` bars either side in which this
    instrument played at all, and ask what fraction of them also have something
    on *s*. The floor slides from ``unsupported`` at none of them to
    ``supported`` at all of them.

    Every candidate given to this function votes; the note above the constants
    says why an open electorate is the right one, and what it rests on -- that
    cross-stem arbitration has already removed the systematic bleed, which is
    the only kind of phantom that could vote itself into existence.

    Nothing here can *add* a note. A slot every neighbouring bar plays does not
    get one written into a bar where the detector found nothing -- it only means
    a hit that was found there is judged gently. That is the whole difference
    between weighting evidence and snapping to a template.

    Neighbours are counted in bars where the instrument *played*, not in bar
    numbers, so a groove either side of a four-bar break still has neighbours.
    """
    floors = np.full(len(instruments), unsupported, dtype=float)

    by_instrument: dict[str, dict[int, set[int]]] = {}
    for bar, slot, name in zip(bars, slots, instruments):
        by_instrument.setdefault(name, {}).setdefault(int(bar), set()).add(int(slot))

    for index, (bar, slot, name) in enumerate(zip(bars, slots, instruments)):
        played = by_instrument.get(name)
        if not played:
            continue
        numbers = sorted(played)
        # The neighbourhood is the played bars nearest this one, excluding it --
        # bisect on the sorted bar numbers so a bar with no hits of its own
        # (which is not in `played`) still gets the bars around it.
        position = int(np.searchsorted(numbers, bar))
        before = [n for n in numbers[max(0, position - radius) : position] if n != bar]
        after = [n for n in numbers[position : position + radius + 1] if n != bar][:radius]
        neighbours = before + after
        if not neighbours:
            continue
        agree = sum(1 for n in neighbours if int(slot) in played[n]) / len(neighbours)
        floors[index] = supported + (unsupported - supported) * (1.0 - agree) ** exponent
    return floors


@dataclass(frozen=True)
class _Reference:
    """What the unsplit ``drums.wav`` says, per band. Computed once.

    It is the denominator of every share and the evidence behind every support
    check, so all six stems need it and it is the same signal each time.
    """

    sample_rate: int
    level: dict[str, np.ndarray]
    flux: dict[str, np.ndarray]

    @classmethod
    def measure(cls, path: Path) -> "_Reference":
        y, sr = onsets.load_mono(path)
        spectrum = onsets.magnitudes(y)
        wanted = {band for detector in DETECTORS.values() for band in detector.bands}
        return cls(
            sample_rate=sr,
            level={
                band: onsets.band_rms(y, sr, *onsets.BANDS[band], spectrum=spectrum)
                for band in wanted
            },
            flux={
                band: onsets.normalize(
                    onsets.superflux(y, sr, *onsets.BANDS[band], spectrum=spectrum)
                )
                for band in wanted
            },
        )


def _sum_bands(source: dict[str, np.ndarray], bands: tuple[str, ...]) -> np.ndarray:
    """Add a detector's bands together. Both snare bands, or a cymbal's one."""
    return np.sum([source[band] for band in bands], axis=0)


def _stem_candidates(song: paths.Song, reference: _Reference) -> list[Candidate]:
    """Peak-pick every stem and measure each peak three ways."""
    found: list[Candidate] = []
    for instrument, detector in DETECTORS.items():
        y, sr = onsets.load_mono(song.kit_stem(detector.stem))
        spectrum = onsets.magnitudes(y)

        flux = onsets.normalize(
            _sum_bands(
                {
                    band: onsets.normalize(
                        onsets.superflux(y, sr, *onsets.BANDS[band], spectrum=spectrum)
                    )
                    for band in detector.bands
                },
                detector.bands,
            )
        )
        times = onsets.envelope_times(flux.size, sr)
        peaks = onsets.pick_onsets(flux, times, delta=detector.delta, wait=detector.min_ioi)
        if peaks.size == 0:
            note(f"[transcribe] {instrument}: no onsets above delta {detector.delta}")
            continue

        # Support is read off the *unsplit* stem's flux -- the same quantity the
        # peak was picked on. Share is read off levels, which is what makes it a
        # meaningful fraction of one signal rather than a ratio of two slopes.
        support_flux = onsets.normalize(_sum_bands(reference.flux, detector.bands))
        support = onsets.support_at(
            support_flux,
            onsets.envelope_times(support_flux.size, reference.sample_rate),
            peaks,
            window=GATE_WINDOW,
        )

        level = _sum_bands(
            {
                band: onsets.band_rms(y, sr, *onsets.BANDS[band], spectrum=spectrum)
                for band in detector.bands
            },
            detector.bands,
        )
        rms_times = onsets.envelope_times(level.size, sr)
        stem_level = onsets.post_onset_level(level, rms_times, peaks)
        kit_level = onsets.post_onset_level(
            _sum_bands(reference.level, detector.bands), rms_times, peaks
        )
        share = np.clip(stem_level / np.maximum(kit_level, 1e-9), 0.0, 1.0)

        # How sharp the transient was, against the sharpest this drum gets in
        # this song. Normalised over the peaks with support, so that a stem full
        # of invented material in a silent intro can't set the reference.
        heights = onsets.support_at(flux, times, peaks, window=detector.min_ioi / 2)
        backed = support >= GATE_SUPPORT
        attack = onsets.relative_to_loud(
            heights, percentile=95.0
        ) if not backed.any() else np.clip(
            heights / max(float(np.percentile(heights[backed], 95.0)), 1e-9), 0.0, 1.0
        )

        found.extend(
            Candidate(
                t=float(t),
                instrument=instrument,
                share=float(s),
                attack=float(a),
                level=float(lv),
                support=float(sup),
            )
            for t, s, a, lv, sup in zip(peaks, share, attack, stem_level, support)
        )
    return found


def _with_velocity(candidates: list[Candidate]) -> list[Candidate]:
    """Fill in velocity from post-onset level, per instrument.

    Called after arbitration on purpose. Velocity is normalised against the 95th
    percentile of this drum's own hits, and a set still full of another drum's
    shadows is not this drum's own hits -- the reference would be set partly by
    the neighbour that made them.
    """
    out = list(candidates)
    for instrument in {c.instrument for c in candidates}:
        indices = [i for i, c in enumerate(candidates) if c.instrument == instrument]
        levels = np.array([candidates[i].level for i in indices], dtype=float)
        for i, velocity in zip(indices, onsets.relative_to_loud(levels)):
            out[i] = replace(out[i], velocity=float(velocity))
    return out


def detect_stems(song: paths.Song) -> list[OnsetEvent]:
    if not drumsep.is_split(song):
        raise StageError(
            f"no per-drum stems in {song.kit_dir} -- run `drums kit {song.slug}` first"
        )
    if not song.grid_lock.exists():
        raise StageError(
            f"no grid at {song.grid_lock} -- run `drums grid {song.slug}` first "
            "(the detector needs bar positions for its per-slot thresholds)"
        )
    grid = grid_mod.load(song)

    candidates = _stem_candidates(song, _Reference.measure(song.drums))

    # 1. The context-free gates: is there anything in the unsplit stem at all,
    #    and was this a strike rather than something still ringing.
    invented = sum(1 for c in candidates if c.support < GATE_SUPPORT)
    soft = sum(
        1
        for c in candidates
        if c.support >= GATE_SUPPORT and c.attack < DETECTORS[c.instrument].min_attack
    )
    candidates = [
        c
        for c in candidates
        if c.support >= GATE_SUPPORT and c.attack >= DETECTORS[c.instrument].min_attack
    ]

    # 2. Cross-stem arbitration.
    ratios = calibrate(candidates)
    verdicts = arbitrate(candidates, suppression=ratios)
    _report_arbitration(candidates, verdicts, ratios, invented, soft)
    candidates = [c for c, verdict in zip(candidates, verdicts) if verdict is None]

    # 3. Velocity, then the per-slot floors -- emitted instruments only. The
    #    other three have done their job by now.
    candidates = _with_velocity([c for c in candidates if DETECTORS[c.instrument].emit])
    return _apply_slot_floors(grid, candidates)


def _apply_slot_floors(grid: grid_mod.Grid, candidates: list[Candidate]) -> list[OnsetEvent]:
    """Judge the quiet candidates by their neighbours and emit what survives."""
    if not candidates:
        return []
    times = np.array([c.t for c in candidates], dtype=float)
    # Sixteenths, matching the quantizer. Slot identity only has to be
    # consistent within this function -- it decides which hits are "the same
    # place in the bar", not where any note is finally written.
    bars, phase = bar_position(grid, times)
    slots = np.rint(phase * 4).astype(int)
    # The same carry the quantizer applies: a hit that rounded up past the end
    # of its bar belongs to the next bar's downbeat. Both stages have to agree
    # about which slot a hit is on, or a note is judged against one bar's
    # neighbours and then written into another's.
    carry = slots >= grid.beats_per_bar * 4
    bars = bars + carry
    slots = np.where(carry, 0, slots)
    instruments = [c.instrument for c in candidates]
    velocity = np.array([c.velocity for c in candidates], dtype=float)
    floors = slot_floors(bars, slots, instruments)
    kept = (velocity >= floors) | (velocity >= EVIDENCE_VELOCITY)

    for instrument in sorted(set(instruments)):
        mine = np.array([name == instrument for name in instruments])
        loud = mine & (velocity >= EVIDENCE_VELOCITY)
        note(
            f"[transcribe] {instrument}: {int((mine & kept).sum())} hits "
            f"({int(loud.sum())} loud enough to stand alone, "
            f"{int((mine & ~kept).sum())} quiet ones with nothing nearby agreeing)"
        )

    return [
        OnsetEvent(
            t=candidate.t,
            instrument=candidate.instrument,
            velocity=candidate.velocity,
            confidence=candidate.share,
        )
        for candidate, keep in zip(candidates, kept)
        if keep
    ]


def _report_arbitration(
    candidates: list[Candidate],
    verdicts: list[str | None],
    ratios: dict[tuple[str, str], float],
    invented: int,
    soft: int,
) -> None:
    fitted = ", ".join(
        f"{suppressor}>{target} {value:.2f}" for (suppressor, target), value in sorted(ratios.items())
    )
    note(f"[transcribe] arbitration ratios: {fitted}")
    if invented or soft:
        note(
            f"[transcribe] {invented} peaks with no support in drums.wav, "
            f"{soft} too soft to be a strike"
        )
    for instrument in sorted(DETECTORS):
        reasons: dict[str, int] = {}
        for candidate, verdict in zip(candidates, verdicts):
            if candidate.instrument == instrument and verdict is not None:
                reasons[verdict] = reasons.get(verdict, 0) + 1
        kept = sum(
            1
            for candidate, verdict in zip(candidates, verdicts)
            if candidate.instrument == instrument and verdict is None
        )
        detail = ", ".join(f"{count} {reason}" for reason, count in sorted(reasons.items()))
        note(f"[transcribe] {instrument}: {kept} survive arbitration" + (f" -- {detail}" if detail else ""))


register(
    Backend(
        key="stems",
        notes="drumsep stems, band-limited SuperFlux, cross-stem arbitration; "
        "kick/snare/closed hat emitted, toms/ride/crash as evidence",
        detect=detect_stems,
    )
)
