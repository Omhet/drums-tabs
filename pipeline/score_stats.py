"""Repeatability statistics for a quantized score -- the Phase 3 scoreboard.

Snap error told Phase 1b whether the *grid* was right. It cannot tell you
whether the *notes* are, because a phantom hit snaps to a slot just as neatly as
a real one -- the false positives from stem bleed sit right on the beat, which is
precisely why they are false positives and not noise.

What separates a real hit from a phantom, without a ground-truth transcription
to compare against, is that **drummers repeat themselves**. A groove is the same
bar played over and over with variations; a bleed artefact is whatever the other
drum happened to do that time round. So the measurement here is *local
self-consistency*: for every note, how often does the same (slot, instrument)
occur in the bars either side of it?

Two numbers fall out, and they pull in opposite directions, which is what makes
them a scoreboard rather than a target:

- **one-offs** -- notes at a slot almost nothing nearby shares. Mostly false
  positives, but a fill is also made of one-offs, so this can never go to zero.
- **dropouts** -- slots nearly every neighbouring bar has that this bar lacks.
  Mostly missed hits, but a deliberate space in the groove looks identical.

Driving either to zero alone is easy and useless: detect nothing and one-offs
vanish, detect everything and dropouts do. Both falling together is the signal
that detection improved rather than that a threshold moved.

Neighbourhoods are counted in **non-empty** bars, not bar numbers, so a groove
either side of a four-bar silence is still each other's neighbour.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from pipeline.quantize import Bar, Score

# How many bars either side to compare against. Four is two-thirds of a typical
# eight-bar phrase: wide enough that a single busy bar can't dominate, narrow
# enough that the chorus isn't judged against the verse.
RADIUS = 4

# A note whose slot occurs in under a fifth of its neighbourhood is a one-off;
# a slot present in over four-fifths of the neighbourhood but missing here is a
# dropout. Deliberately far apart, leaving the middle band unjudged -- that band
# is where genuine variation lives and no verdict about it would be honest.
ONE_OFF_OCCUPANCY = 0.20
STABLE_OCCUPANCY = 0.80

# Below this the note is in ghost territory: Phase 2 will want to notate these
# as ghosts rather than full-weight hits, so the fraction is worth watching.
GHOST_VELOCITY = 0.35

# A snare this quiet, on a slot that also has a kick, is the signature of kick
# bleed into the snare stem's body band rather than a kick-and-snare unison.
# Coincidence alone proves nothing -- 90% of Stayin' Alive's snares share a slot
# with a kick, because the tune is four on the floor and the backbeat lands on
# two of them. It is coincidence *plus* a weak snare that says bleed.
QUIET_VELOCITY = 0.60

Key = tuple[int, str]


def bar_keys(bar: Bar) -> set[Key]:
    """The (slot, instrument) set a bar contains -- its pattern, ignoring velocity."""
    return {(hit.slot, hit.instrument) for hit in bar.hits}


def neighbourhood(patterns: list[set[Key]], position: int, *, radius: int = RADIUS) -> list[set[Key]]:
    """The up-to-``2*radius`` patterns surrounding ``position``, excluding it.

    Takes a list already filtered to non-empty bars, so the caller decides what
    counts as a bar worth comparing against and this stays arithmetic.
    """
    lo = max(0, position - radius)
    return patterns[lo:position] + patterns[position + 1 : position + 1 + radius]


def occupancy(neighbours: list[set[Key]], key: Key) -> float:
    """Fraction of neighbouring bars that contain ``key``."""
    if not neighbours:
        return 0.0
    return sum(1 for pattern in neighbours if key in pattern) / len(neighbours)


@dataclass
class InstrumentStats:
    notes: int = 0
    one_offs: int = 0
    dropouts: int = 0
    one_off_velocity: list[float] = field(default_factory=list)
    stable_velocity: list[float] = field(default_factory=list)

    def as_dict(self) -> dict:
        def mean(values: list[float]) -> float | None:
            return round(sum(values) / len(values), 3) if values else None

        return {
            "notes": self.notes,
            "one_offs": self.one_offs,
            "one_off_pct": round(100.0 * self.one_offs / self.notes, 1) if self.notes else 0.0,
            "dropouts": self.dropouts,
            "dropout_pct": round(100.0 * self.dropouts / self.notes, 1) if self.notes else 0.0,
            "one_off_velocity": mean(self.one_off_velocity),
            "stable_notes": len(self.stable_velocity),
            "stable_velocity": mean(self.stable_velocity),
        }


def analyse(score: Score, *, radius: int = RADIUS) -> dict:
    """Every repeatability number for one score, as a JSON-able dict."""
    played = [bar for bar in score.bars if bar.hits]
    patterns = [bar_keys(bar) for bar in played]

    per_instrument: dict[str, InstrumentStats] = {}

    def stats_for(instrument: str) -> InstrumentStats:
        return per_instrument.setdefault(instrument, InstrumentStats())

    for position, bar in enumerate(played):
        neighbours = neighbourhood(patterns, position, radius=radius)
        for hit in bar.hits:
            entry = stats_for(hit.instrument)
            entry.notes += 1
            share = occupancy(neighbours, (hit.slot, hit.instrument))
            if share < ONE_OFF_OCCUPANCY:
                entry.one_offs += 1
                entry.one_off_velocity.append(hit.velocity)
            elif share >= STABLE_OCCUPANCY:
                entry.stable_velocity.append(hit.velocity)
        # A slot nearly every neighbour has, that this bar does not: counted
        # against the instrument it belongs to, so the rate is comparable with
        # the one-off rate on the same denominator.
        here = patterns[position]
        candidates = {key for pattern in neighbours for key in pattern} - here
        for key in candidates:
            if occupancy(neighbours, key) >= STABLE_OCCUPANCY:
                stats_for(key[1]).dropouts += 1

    return {
        "bars": len(score.bars),
        "played_bars": len(played),
        "notes": score.note_count,
        "instruments": {
            name: per_instrument[name].as_dict() for name in sorted(per_instrument)
        },
        **_pattern_stats(score, played, patterns),
        **_velocity_stats(score),
        "snap_error_ms": score.stats.get("snap_error_ms", {}),
    }


def _pattern_stats(score: Score, played: list[Bar], patterns: list[set[Key]]) -> dict:
    """How much the score repeats itself, at whole-bar granularity.

    Not a target -- busy sixteenth funk genuinely differs bar to bar, and forcing
    repetition onto it would be a worse transcription that scored better. It is
    here because a *drop* in distinct patterns alongside a drop in one-offs says
    the same variation was spurious.
    """
    frozen = [frozenset(pattern) for pattern in patterns]
    identical = sum(1 for a, b in zip(frozen, frozen[1:]) if a == b)
    return {
        # Over played bars only: "silence" is not a groove variation, and
        # counting it as one makes a song with a breakdown look more varied.
        "distinct_patterns": len(set(frozen)),
        "adjacent_identical": identical,
        "adjacent_identical_pct": (
            round(100.0 * identical / (len(frozen) - 1), 1) if len(frozen) > 1 else 0.0
        ),
        "empty_bars": len(score.bars) - len(played),
    }


def _velocity_stats(score: Score) -> dict:
    """Ghost-territory share, and the kick-bleed signature on the snare."""
    velocities = [hit.velocity for bar in score.bars for hit in bar.hits]
    ghosts = sum(1 for v in velocities if v < GHOST_VELOCITY)

    snares = 0
    quiet_on_kick = 0
    for bar in score.bars:
        kicks = {hit.slot for hit in bar.hits if hit.instrument == "kick"}
        for hit in bar.hits:
            if hit.instrument != "snare":
                continue
            snares += 1
            if hit.slot in kicks and hit.velocity < QUIET_VELOCITY:
                quiet_on_kick += 1

    return {
        "below_ghost_velocity_pct": (
            round(100.0 * ghosts / len(velocities), 1) if velocities else 0.0
        ),
        "quiet_snare_on_kick": quiet_on_kick,
        "quiet_snare_on_kick_pct": (
            round(100.0 * quiet_on_kick / snares, 1) if snares else 0.0
        ),
    }


def totals(reports: list[dict]) -> dict:
    """Pool per-song reports into one row, weighting by note count, not by song.

    A song with 800 notes and one with 200 are not equal evidence about a
    detector, and averaging their percentages would pretend they were.
    """
    pooled: dict[str, dict] = {}
    for report in reports:
        for name, entry in report["instruments"].items():
            into = pooled.setdefault(
                name, {"notes": 0, "one_offs": 0, "dropouts": 0, "one_off_sum": 0.0,
                       "one_off_n": 0, "stable_sum": 0.0, "stable_n": 0}
            )
            into["notes"] += entry["notes"]
            into["one_offs"] += entry["one_offs"]
            into["dropouts"] += entry["dropouts"]
            # Re-weight the per-song means back into sums so the pooled mean is
            # over notes rather than over songs.
            if entry["one_off_velocity"] is not None:
                into["one_off_sum"] += entry["one_off_velocity"] * entry["one_offs"]
                into["one_off_n"] += entry["one_offs"]
            if entry["stable_velocity"] is not None:
                into["stable_sum"] += entry["stable_velocity"] * entry["stable_notes"]
                into["stable_n"] += entry["stable_notes"]

    out: dict[str, dict] = {}
    for name, entry in sorted(pooled.items()):
        notes = entry["notes"] or 1
        out[name] = {
            "notes": entry["notes"],
            "one_offs": entry["one_offs"],
            "one_off_pct": round(100.0 * entry["one_offs"] / notes, 1),
            "dropouts": entry["dropouts"],
            "dropout_pct": round(100.0 * entry["dropouts"] / notes, 1),
            "one_off_velocity": (
                round(entry["one_off_sum"] / entry["one_off_n"], 3) if entry["one_off_n"] else None
            ),
            "stable_velocity": (
                round(entry["stable_sum"] / entry["stable_n"], 3) if entry["stable_n"] else None
            ),
        }
    return out
