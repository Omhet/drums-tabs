"""``kit.toml``: where your kit is, what it costs to play it, and what it sounds like.

Geometry is a property of you and your kit, not of a song, so unlike everything
else the pipeline reads this lives once at the repo root. Three things use it:
the sticking solver, which needs distances to work out which hand plays what;
``drums kit-bake``, which needs ``[render]`` to know what to ask a drum plugin
for; and -- later -- the renderer, which needs the same geometry to draw the
kit. One source, three consumers.

``[render]`` and ``[sampler]`` are deliberately not part of :func:`_digest`.
That hash pins a ``sticking.lock.json`` to the geometry it was solved against,
and what the kit *sounds* like cannot change which hand plays what.
"""

from __future__ import annotations

import hashlib
import json
import math
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from pipeline.paths import REPO_ROOT
from pipeline.proc import StageError

KIT_PATH = REPO_ROOT / "kit.toml"

HANDS = ("left_hand", "right_hand")
FEET = ("left_foot", "right_foot")
LIMBS = (*HANDS, *FEET)


@dataclass(frozen=True)
class Instrument:
    name: str
    #: Centimetres, looking down: origin at the kick, +x right, +y away from you.
    x: float
    y: float
    limbs: tuple[str, ...]
    #: Whether the time is kept on it -- the hats and the ride (see `lead`).
    time_keeper: bool

    @property
    def foot(self) -> str | None:
        """The one foot that plays it, if it is a pedal."""
        return self.limbs[0] if len(self.limbs) == 1 and self.limbs[0] in FEET else None


@dataclass(frozen=True)
class Weights:
    """What "effort" means. Hard rule first, preferences after."""

    max_speed_cm_s: float
    travel: float
    crossover: float
    repeat: float
    repeat_below_ms: float
    #: Which hand keeps time. On a right-handed kit the hats are on your left
    #: and the right hand crosses over to play them: that is not a crossing to
    #: be avoided, it is how the kit is played.
    lead: str
    lead_bias: float

    @property
    def lead_hand(self) -> str:
        return f"{self.lead}_hand"

    @property
    def other_hand(self) -> str:
        return "left_hand" if self.lead == "right" else "right_hand"


@dataclass(frozen=True)
class Articulation:
    """One way of striking one instrument, and what it costs to sample it.

    An instrument is the identity everywhere else in the project; this is the
    one place that can afford to know that a rim shot and a head hit are two
    different recordings of the same drum.
    """

    name: str
    #: Which `[instrument.*]` this sounds for. Several may name the same one.
    instrument: str
    #: The one the sampler picks when nothing asks for a particular strike.
    default: bool
    #: The MIDI note the *plugin* listens on -- not the module's, not the rack's.
    note: int
    layers: int
    round_robin: int
    tail_s: float
    stereo: bool
    #: Still sounding when the next note lands, so a choke group may cut it off.
    ring: bool

    @property
    def count(self) -> int:
        """How many samples this articulation is worth."""
        return self.layers * self.round_robin


@dataclass(frozen=True)
class Render:
    """What to ask the plugin for."""

    articulations: dict[str, Articulation]
    velocity_low: int
    velocity_high: int
    #: The drum plugin to render from, as a path on this machine.
    plugin: str = ""

    def velocities(self, articulation: Articulation) -> tuple[int, ...]:
        """The MIDI velocity each layer is rendered at, quietest first.

        Spread over `velocity_low..velocity_high` rather than 1..127 because
        the charts on disk sit between 50 and 102 -- layers spread over the
        full range would put most of themselves where no note ever lands.
        """
        n = articulation.layers
        if n == 1:
            return (self.velocity_high,)
        span = self.velocity_high - self.velocity_low
        return tuple(round(self.velocity_low + span * i / (n - 1)) for i in range(n))

    @property
    def count(self) -> int:
        return sum(a.count for a in self.articulations.values())

    def default_for(self, instrument: str) -> Articulation | None:
        for a in self.articulations.values():
            if a.instrument == instrument and a.default:
                return a
        return None


@dataclass(frozen=True)
class Sampler:
    """How the bank is played, as opposed to how it was made."""

    #: Groups whose members cut each other off -- but only members that `ring`.
    choke: tuple[tuple[str, ...], ...]
    #: Per-instrument trim in dB.
    trim: dict[str, float]


@dataclass(frozen=True)
class Kit:
    instruments: dict[str, Instrument]
    hands: Weights
    #: Identifies the geometry and weights a sticking was solved against.
    digest: str
    #: What the kit sounds like. Both default to empty because a Kit built for
    #: the sticking solver -- which is what `tests/test_sticking.py` builds --
    #: has no sampler in it, and the solver never looks.
    render: Render = field(
        default_factory=lambda: Render(articulations={}, velocity_low=20, velocity_high=120)
    )
    sampler: Sampler = field(default_factory=lambda: Sampler(choke=(), trim={}))

    def get(self, name: str) -> Instrument:
        found = self.instruments.get(name)
        if found is None:
            known = ", ".join(sorted(self.instruments)) or "none"
            raise StageError(
                f"{KIT_PATH.name} has no instrument called {name!r} "
                f"(it has: {known}). Add it, or fix the [midi_map] that names it."
            )
        return found

    def distance(self, a: str, b: str) -> float:
        """Centimetres between two instruments, as a hand travels."""
        first, second = self.get(a), self.get(b)
        return math.hypot(first.x - second.x, first.y - second.y)


def _digest(instruments: dict[str, Instrument], hands: Weights) -> str:
    """What a sticking is pinned to: the geometry and the weights, nothing else.

    Hashing the file would tie every sticking to edits that cannot change which
    hand plays what -- a reworded comment, a pad number in ``[input]``, or the
    whole of ``[render]``, none of which this module's callers look at -- and
    mark every lock file stale for it.
    """
    shape = json.dumps(
        {
            "instruments": {
                name: [i.x, i.y, list(i.limbs), i.time_keeper]
                for name, i in sorted(instruments.items())
            },
            "hands": [
                hands.max_speed_cm_s,
                hands.travel,
                hands.crossover,
                hands.repeat,
                hands.repeat_below_ms,
                hands.lead,
                hands.lead_bias,
            ],
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    return "sha256:" + hashlib.sha256(shape.encode("utf-8")).hexdigest()[:16]


def _read_render(data: dict, instruments: dict[str, Instrument], name: str) -> Render:
    body = data.get("render") or {}
    low = int(body.get("velocity_low", 20))
    high = int(body.get("velocity_high", 120))
    if not 1 <= low < high <= 127:
        raise StageError(
            f"{name}: [render] needs 1 <= velocity_low < velocity_high <= 127, "
            f"got {low}..{high}"
        )

    articulations: dict[str, Articulation] = {}
    by_note: dict[int, str] = {}
    for art, spec in (body.get("articulation") or {}).items():
        instrument = str(spec.get("instrument", art))
        if instrument not in instruments:
            known = ", ".join(sorted(instruments))
            raise StageError(
                f"{name}: [render.articulation.{art}] sounds for {instrument!r}, "
                f"which is not an [instrument.*] (it has: {known})"
            )
        if "note" not in spec:
            raise StageError(
                f"{name}: [render.articulation.{art}] needs a `note` -- "
                "the MIDI note the drum plugin listens on"
            )
        note = int(spec["note"])
        if not 0 <= note <= 127:
            raise StageError(f"{name}: [render.articulation.{art}] note {note} is not 0-127")
        if note in by_note:
            raise StageError(
                f"{name}: [render.articulation.{art}] and .{by_note[note]} both "
                f"use note {note}. One render cannot tell them apart -- give "
                "them different notes, or drop one."
            )
        by_note[note] = art

        layers = int(spec.get("layers", body.get("layers", 6)))
        round_robin = int(spec.get("round_robin", body.get("round_robin", 4)))
        if layers < 1 or round_robin < 1:
            raise StageError(
                f"{name}: [render.articulation.{art}] needs layers >= 1 and "
                f"round_robin >= 1, got {layers} and {round_robin}"
            )
        tail_s = float(spec.get("tail_s", body.get("tail_s", 2.0)))
        if tail_s <= 0:
            raise StageError(f"{name}: [render.articulation.{art}] tail_s must be positive")
        articulations[art] = Articulation(
            name=art,
            instrument=instrument,
            default=bool(spec.get("default", False)),
            note=note,
            layers=layers,
            round_robin=round_robin,
            tail_s=tail_s,
            stereo=bool(spec.get("stereo", body.get("stereo", False))),
            ring=bool(spec.get("ring", False)),
        )

    # One default per instrument that has any articulation at all. Silence is
    # the worst way to find out that a drum has no sample, so it is an error
    # here rather than a shrug in the browser.
    seen: dict[str, list[str]] = {}
    for art in articulations.values():
        if art.default:
            seen.setdefault(art.instrument, []).append(art.name)
    for instrument in {a.instrument for a in articulations.values()}:
        chosen = seen.get(instrument, [])
        if not chosen:
            raise StageError(
                f"{name}: {instrument!r} has articulations but none is `default = true`. "
                "The sampler would have nothing to play for a plain note."
            )
        if len(chosen) > 1:
            raise StageError(
                f"{name}: {instrument!r} has more than one default articulation "
                f"({', '.join(sorted(chosen))}). Exactly one, please."
            )

    return Render(
        articulations=articulations,
        velocity_low=low,
        velocity_high=high,
        plugin=str(body.get("plugin", "")),
    )


def _read_sampler(
    data: dict, instruments: dict[str, Instrument], render: Render, name: str
) -> Sampler:
    body = data.get("sampler") or {}

    groups: list[tuple[str, ...]] = []
    for group in body.get("choke") or []:
        members = tuple(str(m) for m in group)
        unknown = [m for m in members if m not in render.articulations]
        if unknown:
            raise StageError(
                f"{name}: [sampler] choke group names {unknown}, which are not "
                "[render.articulation.*]. A choke group is articulations, not "
                "instruments -- an open hi-hat is what rings, not 'the hi-hat'."
            )
        if len(members) > 1:
            groups.append(members)

    trim: dict[str, float] = {}
    for instrument, db in (body.get("trim") or {}).items():
        if instrument not in instruments:
            raise StageError(
                f"{name}: [sampler.trim] has {instrument!r}, which is not an [instrument.*]"
            )
        trim[str(instrument)] = float(db)

    return Sampler(choke=tuple(groups), trim=trim)


def load(path: Path = KIT_PATH) -> Kit:
    if not path.exists():
        raise StageError(f"no kit at {path}. It is tracked in git; restore it or write one.")
    data = tomllib.loads(path.read_bytes().decode("utf-8"))

    instruments: dict[str, Instrument] = {}
    for name, body in (data.get("instrument") or {}).items():
        pos = body.get("pos")
        if not (isinstance(pos, list) and len(pos) == 2):
            raise StageError(f"{path.name}: [instrument.{name}] needs pos = [x, y] in cm")
        limbs = tuple(body.get("limbs") or HANDS)
        unknown = [limb for limb in limbs if limb not in LIMBS]
        if unknown:
            raise StageError(
                f"{path.name}: [instrument.{name}] has unknown limbs {unknown}; "
                f"use any of {', '.join(LIMBS)}"
            )
        instruments[name] = Instrument(
            name=name,
            x=float(pos[0]),
            y=float(pos[1]),
            limbs=limbs,
            time_keeper=bool(body.get("time_keeper", name.startswith("hihat") or name == "ride")),
        )
    if not instruments:
        raise StageError(f"{path.name}: no [instrument.*] sections")

    hands = data.get("hands") or {}
    lead = str(hands.get("lead", "right"))
    if lead not in ("left", "right"):
        raise StageError(f'{path.name}: [hands] lead must be "left" or "right", got {lead!r}')
    weights = Weights(
        max_speed_cm_s=float(hands.get("max_speed_cm_s", 700)),
        travel=float(hands.get("travel", 1.0)),
        crossover=float(hands.get("crossover", 2.0)),
        repeat=float(hands.get("repeat", 1.5)),
        repeat_below_ms=float(hands.get("repeat_below_ms", 260)),
        lead=lead,
        lead_bias=float(hands.get("lead_bias", 2.5)),
    )
    if weights.max_speed_cm_s <= 0:
        raise StageError(f"{path.name}: [hands] max_speed_cm_s must be positive")

    render = _read_render(data, instruments, path.name)
    sampler = _read_sampler(data, instruments, render, path.name)

    return Kit(
        instruments=instruments,
        hands=weights,
        render=render,
        sampler=sampler,
        digest=_digest(instruments, weights),
    )
