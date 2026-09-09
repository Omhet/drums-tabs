"""MDX-Net drum models.

Meaningfully worse than Demucs on SDR, but a genuinely different architecture,
which is the point: a comparison between two Demucs checkpoints tells you much
less than one across architectures. These also split 2-way natively, so their
"no drums" stem is the backing track rather than a sum of three others.
"""

from __future__ import annotations

from pipeline.separation.audio_separator import run_audio_separator
from pipeline.separation.base import SeparationModel, register

register(
    SeparationModel(
        key="kuielab_b_drums",
        filename="kuielab_b_drums.onnx",
        arch="MDX-Net",
        drums_sdr=7.1,
        notes="native 2-stem drums/no-drums; fast, different artefacts to Demucs",
        run=run_audio_separator,
    )
)
