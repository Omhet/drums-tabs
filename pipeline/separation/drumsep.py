"""drumsep: the second split, of ``drums.wav`` into the six kit pieces.

This is not a separation *backend* -- it doesn't produce a drums/no-drums pair,
so it isn't in the registry. It's a stage of its own that turns one drum stem
into six, which is what makes per-instrument onset detection tractable: a snare
onset detector run on a snare stem has almost no cymbal wash to reject.

**One model, and it is the only one.** ``MDX23C-DrumSep-aufr33-jarredou`` is the
only per-drum splitter in ``audio-separator``'s registry, so unlike separation
there is nothing here to compare against and no registry to speak of.

**Its labels are the model's, not ours.** It emits ``hh`` and ``toms``; the rest
of the pipeline speaks in the voice names from ``articulations.KIT``. The mapping
is explicit below rather than by position, because the order the tool writes its
stems in is not part of any contract.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import soundfile as sf

from pipeline import paths
from pipeline.proc import StageError, note
from pipeline.separation.audio_separator import _match_length, _read, separated_stems

MODEL_FILENAME = "MDX23C-DrumSep-aufr33-jarredou.ckpt"

# The model's stem label -> our name for that file. Toms/ride/crash are split and
# written even though Phase 1b transcribes only three classes: the split is the
# expensive part, and re-running it later to get the stems we skipped would be
# minutes wasted for no reason.
STEM_NAMES: dict[str, str] = {
    "kick": "kick",
    "snare": "snare",
    "toms": "toms",
    "hh": "hihat",
    "hi-hat": "hihat",
    "hihat": "hihat",
    "ride": "ride",
    "crash": "crash",
}

KIT_STEMS: tuple[str, ...] = ("kick", "snare", "toms", "hihat", "ride", "crash")


def is_split(song: paths.Song) -> bool:
    return all(song.kit_stem(name).exists() for name in KIT_STEMS)


def split(song: paths.Song, *, force: bool = False) -> dict[str, Path]:
    """Split ``stems/drums.wav`` into ``stems/kit/*.wav``.

    Every output is forced to the drum stem's exact sample count, for the same
    reason the 2-way split is: sample indices in ``mix.wav`` are the pipeline's
    one timeline, and a stem that is 300 samples short would put every onset in
    it 7 ms early by the end of the song.
    """
    if not song.drums.exists():
        raise StageError(f"no drum stem at {song.drums} -- run `drums separate` first")
    if is_split(song) and not force:
        return {name: song.kit_stem(name) for name in KIT_STEMS}

    song.kit_dir.mkdir(parents=True, exist_ok=True)
    drums, rate = _read(song.drums)
    target_len = drums.shape[0]

    written: dict[str, Path] = {}
    with separated_stems(song.drums, MODEL_FILENAME, label="kit") as by_label:
        for label, source in sorted(by_label.items()):
            name = STEM_NAMES.get(label)
            if name is None:
                note(f"[kit] ignoring unexpected stem {label!r}")
                continue
            data, stem_rate = _read(source)
            if stem_rate != rate:
                raise StageError(
                    f"drumsep returned {stem_rate} Hz stems for a {rate} Hz drum stem"
                )
            data = _match_length(data, target_len, f"{name} stem")
            out = song.kit_stem(name)
            sf.write(str(out), data, rate, subtype="PCM_16")
            written[name] = out

    missing = [name for name in KIT_STEMS if name not in written]
    if missing:
        raise StageError(
            f"drumsep produced no {', '.join(missing)} stem "
            f"(labels seen: {', '.join(sorted(by_label)) or 'none'})"
        )

    (song.kit_dir / "kit.json").write_text(
        json.dumps(
            {
                "model": MODEL_FILENAME,
                "source": song.drums.name,
                "sample_rate": rate,
                "samples": target_len,
                "stems": {name: str(path.name) for name, path in sorted(written.items())},
                "levels": {
                    name: round(float(np.sqrt(np.mean(_read(path)[0] ** 2))), 6)
                    for name, path in sorted(written.items())
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return written
