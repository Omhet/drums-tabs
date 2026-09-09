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

# Internal instrument -> alphaTab articulation MIDI key. These are the only ones
# the transcriber can emit; anything else is a bug, not a missing feature.
#
# "instrument", not "voice": *voice* means one of the two staff voices (hands and
# feet) throughout the emitter, and the two would otherwise be indistinguishable
# in every function signature that takes one.
#
# **On the kick.** alphaTab offers two, and they land on different staff lines:
# 35 "kick (hit)" on staffLine 8 -- the F4 space, where a bass drum has been
# written since the drum key was standardised -- and 36 "kick (hit) 2" on
# staffLine 7, the G4 line above it. 36 is the General MIDI kick and 35 the
# GM "acoustic bass drum", so following GM here would put the kick in the wrong
# place on the staff; alphaTab decides the notehead, so alphaTab's numbering
# wins. (Settled in Phase 1b by dumping every articulation's staffLine from the
# installed build and rendering both.)
KIT: dict[str, int] = {
    "kick": 35,
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

# Which instruments go in staff voice 1. Voice 0 is hands (stems up), voice 1 is
# feet (stems down) -- the Guitar Pro convention.
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


def articulation_name(instrument: str) -> str:
    """alphaTex articulation name for an instrument, e.g. 'hi-hat (closed)'.

    Validated against the generated table, so an emitter bug surfaces here
    rather than as a note that silently renders as nothing.
    """
    _validate()
    try:
        midi = KIT[instrument]
    except KeyError:
        raise KeyError(
            f"unknown drum instrument {instrument!r}; known: {sorted(KIT)}"
        ) from None
    return _table()[midi]["name"]


def midi_number(instrument: str) -> int:
    """MIDI note number as alphaTab numbers it, for the .mid export."""
    _validate()
    return KIT[instrument]


def is_feet(instrument: str) -> bool:
    """True if the instrument belongs in staff voice 1 (stems down)."""
    return instrument in FEET
