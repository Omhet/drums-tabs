"""The separation seam: ``mix.wav`` -> (``drums.wav``, ``nodrums.wav``).

Only a 2-way split is needed -- drums, and everything-else-to-play-along-to --
even though most models produce four stems. Keeping the interface at two outputs
means a drum-specialised model can be dropped in later without any caller
changing.

Models register themselves in :data:`REGISTRY` at import time; the CLI's
``--model`` flag and ``song.toml``'s ``models.separation`` both select by key.
That indirection keeps the choice a lookup rather than a pile of branches, and
it is what ``drums models`` lists.

**On the default.** A Mel-Band RoFormer drums model would be the first choice. ``audio-separator`` 0.47's registry has no such model -- filtering
it by the ``drums`` stem returns only Demucs variants and two weak MDX-Net
models. So the default here is ``htdemucs_ft`` (drums SDR 10.0, the best drums
stem actually available). When a drums RoFormer appears upstream, adding it is
one :func:`register` call.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

DEFAULT_MODEL = "htdemucs_ft"


@dataclass(frozen=True)
class SeparationResult:
    drums: Path
    nodrums: Path
    model: str


@dataclass(frozen=True)
class SeparationModel:
    """One selectable separation model.

    ``run`` takes (mix, out_dir, model) and writes ``drums.wav``/``nodrums.wav``
    into ``out_dir``. Everything else on this record is for humans choosing
    between models.
    """

    key: str
    filename: str
    arch: str
    drums_sdr: float | None
    notes: str
    run: Callable[[Path, Path, "SeparationModel"], SeparationResult]


REGISTRY: dict[str, SeparationModel] = {}


def register(model: SeparationModel) -> SeparationModel:
    REGISTRY[model.key] = model
    return model


def get(key: str | None) -> SeparationModel:
    resolved = key or DEFAULT_MODEL
    if resolved not in REGISTRY:
        known = ", ".join(sorted(REGISTRY))
        raise KeyError(f"unknown separation model {resolved!r} (have: {known})")
    return REGISTRY[resolved]


def available() -> list[SeparationModel]:
    return [REGISTRY[key] for key in sorted(REGISTRY)]


def separate(
    mix: Path, out_dir: Path, *, model: str | None = None
) -> SeparationResult:
    """Split ``mix`` into a drum stem and a drumless backing track."""
    chosen = get(model)
    return chosen.run(mix, out_dir, chosen)
