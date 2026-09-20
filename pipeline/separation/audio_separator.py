"""Shared driver for every model that ``audio-separator`` can run.

The tool lives in its own ``uv`` environment and speaks in files, so this is a
thin shell-out plus the two bits of bookkeeping that actually matter:

**Stem identification by filename, not by position.** ``audio-separator`` names
outputs ``<input>_(Drums)_<model>.wav``. The set and order of stems varies by
architecture (Demucs gives four, MDX-Net gives two), so we classify by the
parenthesised label rather than assuming a layout.

**Sample-exact length.** The whole pipeline treats sample indices in
``mix.wav`` as the one true timeline. Model chunking can hand back a stem a few
samples long or short; that gets corrected here, loudly if it's more than a
rounding error, rather than becoming a slow drift downstream.
"""

from __future__ import annotations

import json
import re
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import soundfile as sf

from pipeline.proc import StageError, note, run, tool_bin
from pipeline.separation.base import SeparationModel, SeparationResult

# Anything within this many samples is model chunking noise, not a real
# misalignment. 64 samples is 1.5 ms at 44.1 kHz -- well under an onset's
# own resolution.
LENGTH_TOLERANCE_SAMPLES = 64

_STEM_LABEL = re.compile(r"\(([^)]+)\)")


def _stem_label(path: Path) -> str:
    """The parenthesised stem name from an audio-separator output filename."""
    labels = _STEM_LABEL.findall(path.stem)
    return labels[-1].strip().lower() if labels else path.stem.lower()


def _read(path: Path) -> tuple[np.ndarray, int]:
    data, rate = sf.read(str(path), always_2d=True, dtype="float32")
    return data, rate


def _match_length(data: np.ndarray, target: int, what: str) -> np.ndarray:
    """Force a stem to the mix's exact sample count, complaining if it's way off."""
    delta = target - data.shape[0]
    if delta == 0:
        return data
    if abs(delta) > LENGTH_TOLERANCE_SAMPLES:
        note(
            f"[separate] warning: {what} is {abs(delta)} samples "
            f"{'short of' if delta > 0 else 'longer than'} the mix; "
            "padding/trimming to keep the timeline aligned"
        )
    if delta > 0:
        return np.pad(data, ((0, delta), (0, 0)))
    return data[:target]


@contextmanager
def separated_stems(
    source: Path, model_filename: str, *, label: str
) -> Iterator[dict[str, Path]]:
    """Run one ``audio-separator`` model and yield its stems by label.

    Stems live in a temporary directory that is removed on exit, so callers copy
    or resample what they want out of it. Two callers exist: the 2-way split of
    the mix, and drumsep's 6-way split of the drum stem.
    """
    exe = tool_bin("audio-separator", "audio-separator")
    with tempfile.TemporaryDirectory(prefix="drums-sep-") as tmp:
        work = Path(tmp)
        note(f"[{label}] {model_filename} on {source.name}")
        run(
            [
                exe,
                str(source),
                "-m",
                model_filename,
                "--output_dir",
                str(work),
                "--output_format",
                "WAV",
                # Peak-normalisation is on by default and would rescale each stem
                # independently, so summing the non-drum stems would no longer
                # reconstruct the mix. 1.0 leaves levels alone.
                "--normalization",
                "1.0",
            ]
        )
        produced = sorted(work.glob("*.wav"))
        if not produced:
            raise StageError(
                f"audio-separator produced no stems for {source.name} "
                f"with model {model_filename}"
            )
        yield {_stem_label(path): path for path in produced}


def run_audio_separator(
    mix: Path, out_dir: Path, model: SeparationModel
) -> SeparationResult:
    out_dir.mkdir(parents=True, exist_ok=True)
    with separated_stems(mix, model.filename, label="separate") as by_label:
        return _assemble(mix, by_label, out_dir, model)


def _assemble(
    mix: Path, by_label: dict[str, Path], out_dir: Path, model: SeparationModel
) -> SeparationResult:
    """Pick the drum stem out of the model's output and build its complement."""
    mix_data, rate = _read(mix)
    target_len = mix_data.shape[0]

    drums_path = next(
        (path for label, path in by_label.items() if "drum" in label and "no" not in label),
        None,
    )
    if drums_path is None:
        raise StageError(
            f"model {model.key} produced no drums stem "
            f"(got: {', '.join(sorted(by_label)) or 'nothing'})"
        )

    drums, drum_rate = _read(drums_path)
    if drum_rate != rate:
        raise StageError(
            f"{model.key} returned {drum_rate} Hz stems for a {rate} Hz mix"
        )
    drums = _match_length(drums, target_len, "drums stem")

    # Two-stem models hand back the complement directly; four-stem models don't,
    # so we sum the rest. Summing beats mix-minus-drums: separation residue ends
    # up dropped rather than doubled into the backing track.
    explicit = next(
        (path for label, path in by_label.items() if "no drum" in label or "nodrum" in label),
        None,
    )
    if explicit is not None:
        nodrums, _ = _read(explicit)
        nodrums = _match_length(nodrums, target_len, "nodrums stem")
    else:
        others = [p for label, p in by_label.items() if p != drums_path and "drum" not in label]
        if not others:
            raise StageError(f"model {model.key} produced only a drums stem")
        nodrums = np.zeros_like(drums)
        for path in others:
            data, _ = _read(path)
            nodrums = nodrums + _match_length(data, target_len, path.name)

    peak = float(np.max(np.abs(nodrums))) if nodrums.size else 0.0
    if peak > 0.99:
        nodrums = nodrums * (0.99 / peak)

    drums_out = out_dir / "drums.wav"
    nodrums_out = out_dir / "nodrums.wav"
    sf.write(str(drums_out), drums, rate, subtype="PCM_16")
    sf.write(str(nodrums_out), nodrums, rate, subtype="PCM_16")

    (out_dir / "separation.json").write_text(
        json.dumps(
            {
                "model": model.key,
                "model_filename": model.filename,
                "arch": model.arch,
                "sample_rate": rate,
                "samples": target_len,
                "stems_produced": sorted(by_label),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return SeparationResult(drums=drums_out, nodrums=nodrums_out, model=model.key)
