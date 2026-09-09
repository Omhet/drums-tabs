"""Mapping between our internal drum voices and alphaTab percussion articulations.

alphaTex addresses percussion by *quoted articulation name*, not by number --
a bare ``38.4`` is parsed as "fret 38, string 4" and rejected on a percussion
staff. The names below come from ``data/alphatab_articulations.json``, which is
generated from the installed alphaTab build by
``app/scripts/dump-articulations.mjs``; regenerate it after upgrading alphaTab.

Note that alphaTab's tom naming does not follow General MIDI. GM calls 50 a
"High Tom"; alphaTab calls it "high floor tom (hit)". Since alphaTab decides
where the notehead lands on the staff, we follow alphaTab's semantics, not GM's.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_DATA_PATH = Path(__file__).parent / "data" / "alphatab_articulations.json"

# Internal voice -> alphaTab articulation MIDI key. These are the only ones the
# transcriber can emit; anything else is a bug, not a missing feature.
KIT: dict[str, int] = {
    "kick": 36,
    "snare": 38,
    "snare_rim": 91,
    "sidestick": 37,
    "hihat_closed": 42,
    "hihat_open": 46,
    "hihat_pedal": 44,
    "tom_high": 48,
    "tom_mid": 47,
    "tom_floor": 45,
    "crash": 49,
    "crash2": 57,
    "ride": 51,
    "ride_bell": 53,
    "china": 52,
    "splash": 55,
}

# Voices split across the two staff voices alphaTab renders. Voice 0 is hands
# (stems up), voice 1 is feet (stems down) -- the Guitar Pro convention.
FEET: frozenset[str] = frozenset({"kick", "hihat_pedal"})


@lru_cache(maxsize=1)
def _table() -> dict[int, dict]:
    raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    return {int(k): v for k, v in raw["byMidi"].items()}


@lru_cache(maxsize=1)
def _validate() -> None:
    """Fail loudly if KIT references an articulation alphaTab won't accept."""
    table = _table()
    missing = {voice: midi for voice, midi in KIT.items() if midi not in table}
    if missing:
        raise ValueError(
            "KIT references articulations absent from the alphaTab table "
            f"({missing}). Regenerate data/alphatab_articulations.json."
        )


def articulation_name(voice: str) -> str:
    """alphaTex articulation name for an internal voice, e.g. 'hi-hat (closed)'.

    Validated against the generated table, so an emitter bug surfaces here
    rather than as a note that silently renders as nothing.
    """
    _validate()
    try:
        midi = KIT[voice]
    except KeyError:
        raise KeyError(
            f"unknown drum voice {voice!r}; known: {sorted(KIT)}"
        ) from None
    return _table()[midi]["name"]


def midi_number(voice: str) -> int:
    """General MIDI note number, for the .mid export."""
    _validate()
    return KIT[voice]


def is_feet(voice: str) -> bool:
    return voice in FEET
