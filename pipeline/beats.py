"""Beat and downbeat detection via ``beat_this``.

Deliberately a thin wrapper. The model's raw output is written to
``analysis/raw.beats`` and never edited in place -- grid repair reads it and
writes somewhere else, so when a grid looks wrong you can always see whether the
detector or the repair introduced the problem.

``beat_this`` runs on the *mix*, not the drum stem. It was trained on full
mixes, and separation artefacts on an isolated drum track measurably hurt it.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pipeline.proc import StageError, note, run, tool_bin

# The checkpoint name is recorded in grid.lock.json, so a grid regenerated after
# a model change is distinguishable from one that isn't.
DEFAULT_CHECKPOINT = "final0"


@dataclass(frozen=True)
class RawBeats:
    """``beat_this``'s output, unmodified.

    ``times`` are seconds from the start of ``mix.wav``; ``positions`` are the
    model's within-bar beat numbers (1 = downbeat). The repair stage treats
    ``positions`` as a hint, not as truth -- a single spurious 3-beat bar would
    otherwise shift every bar after it.
    """

    times: np.ndarray
    positions: np.ndarray
    checkpoint: str

    @property
    def downbeat_times(self) -> np.ndarray:
        return self.times[self.positions == 1]


def detect(mix: Path, out_path: Path, *, checkpoint: str = DEFAULT_CHECKPOINT,
           force: bool = False) -> RawBeats:
    """Run ``beat_this`` on the mix, caching to ``out_path``."""
    if force or not out_path.exists():
        exe = tool_bin("beat-this", "beat_this")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        note(f"[beats] beat_this ({checkpoint}) on {mix.name}")
        run(
            [
                exe,
                str(mix),
                "--model",
                checkpoint,
                "--output",
                str(out_path),
                "--gpu",
                "0",
            ]
        )
    return load(out_path, checkpoint=checkpoint)


def load(path: Path, *, checkpoint: str = DEFAULT_CHECKPOINT) -> RawBeats:
    """Parse a ``.beats`` file.

    The format is whitespace-separated ``time [beat_number]``. The beat number
    is treated as optional so a hand-written or hand-corrected file still loads.
    """
    if not path.exists():
        raise StageError(f"no beats file at {path} -- run `drums beats` first")

    times: list[float] = []
    positions: list[int] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        fields = stripped.split()
        try:
            times.append(float(fields[0]))
            positions.append(int(float(fields[1])) if len(fields) > 1 else 0)
        except ValueError as exc:
            raise StageError(f"{path}:{line_no}: unparseable beat line {stripped!r}") from exc

    if len(times) < 8:
        raise StageError(
            f"{path}: only {len(times)} beats detected -- the audio is probably "
            "silent, or the wrong file was passed"
        )

    order = np.argsort(times)
    return RawBeats(
        times=np.asarray(times, dtype=float)[order],
        positions=np.asarray(positions, dtype=int)[order],
        checkpoint=checkpoint,
    )
