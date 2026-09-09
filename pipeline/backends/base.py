"""The transcription seam: audio -> a list of timed, labelled drum hits.

A backend answers one question -- *what was hit, when, how hard* -- in absolute
seconds, knowing nothing about bars, beats or notation. Quantization is a
separate, purely arithmetic stage on top, so an ML backend can be dropped in
later without touching a line of the notation code.

Timing is deliberately *not* snapped here. The distance between a played hit and
its grid slot is real information -- it's what a swing or push looks like -- and
throwing it away at detection time would make it unrecoverable downstream.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from pipeline import paths

DEFAULT_BACKEND = "stems"


@dataclass(frozen=True)
class OnsetEvent:
    """One detected hit.

    ``instrument`` is a key of :data:`pipeline.articulations.KIT` -- not a MIDI
    number and not an alphaTab articulation name, both of which are notation
    concerns that this layer stays out of.

    ``velocity`` is 0..1 relative to how hard that instrument gets hit in *this*
    song; ``confidence`` is how sure the detector is that the hit is real at all.
    Two different questions, so two numbers: a firmly-detected ghost note is
    velocity 0.2, confidence 0.9.
    """

    t: float
    instrument: str
    velocity: float
    confidence: float


@dataclass(frozen=True)
class Backend:
    key: str
    notes: str
    detect: Callable[[paths.Song], list[OnsetEvent]]


REGISTRY: dict[str, Backend] = {}


def register(backend: Backend) -> Backend:
    REGISTRY[backend.key] = backend
    return backend


def get(key: str | None) -> Backend:
    resolved = key or DEFAULT_BACKEND
    if resolved not in REGISTRY:
        known = ", ".join(sorted(REGISTRY))
        raise KeyError(f"unknown transcription backend {resolved!r} (have: {known})")
    return REGISTRY[resolved]


def available() -> list[Backend]:
    return [REGISTRY[key] for key in sorted(REGISTRY)]


def detect(song: paths.Song, *, backend: str | None = None) -> list[OnsetEvent]:
    """Run a backend over a song's audio and return its hits, sorted by time."""
    chosen = get(backend)
    events = chosen.detect(song)
    return sorted(events, key=lambda e: (e.t, e.instrument))


def save(path: Path, events: list[OnsetEvent], *, backend: str, extra: dict | None = None) -> Path:
    """Write raw onsets so the quantizer's decisions can be checked against them."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "backend": backend,
        "count": len(events),
        **(extra or {}),
        "events": [
            {
                # Millisecond precision: finer is meaningless at a 5.8 ms hop.
                "t": round(e.t, 3),
                "instrument": e.instrument,
                "velocity": round(e.velocity, 3),
                "confidence": round(e.confidence, 3),
            }
            for e in events
        ],
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


def load(path: Path) -> list[OnsetEvent]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return [
        OnsetEvent(
            t=float(e["t"]),
            instrument=e["instrument"],
            velocity=float(e["velocity"]),
            confidence=float(e["confidence"]),
        )
        for e in data["events"]
    ]
