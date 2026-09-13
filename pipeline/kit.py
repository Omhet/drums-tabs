"""``kit.toml``: where your kit is, and what it costs to play it.

Geometry is a property of you and your kit, not of a song, so unlike everything
else the pipeline reads this lives once at the repo root. Two things use it:
the sticking solver, which needs distances to work out which hand plays what,
and -- later -- the renderer, which needs the same numbers to draw the kit.
One source, two consumers.
"""

from __future__ import annotations

import hashlib
import json
import math
import tomllib
from dataclasses import dataclass
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
class Kit:
    instruments: dict[str, Instrument]
    hands: Weights
    #: Identifies the geometry and weights a sticking was solved against.
    digest: str

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
    hand plays what -- a reworded comment, or a pad number in ``[input]``, which
    the player reads and this module never looks at -- and mark every lock file
    stale for it.
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

    return Kit(instruments=instruments, hands=weights, digest=_digest(instruments, weights))
