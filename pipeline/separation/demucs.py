"""Demucs v4 models -- the best drum separation available in audio-separator 0.47.

``htdemucs_ft`` is the default: it's the fine-tuned bag-of-four variant, so it
costs roughly 4x a single Demucs pass, which on this machine is still well under
a minute. Buying the best drum stem available is the right trade -- every later
stage (drumsep, onsets, hi-hat classification) inherits its quality ceiling.
"""

from __future__ import annotations

from pipeline.separation.audio_separator import run_audio_separator
from pipeline.separation.base import SeparationModel, register

register(
    SeparationModel(
        key="htdemucs_ft",
        filename="htdemucs_ft.yaml",
        arch="Demucs v4",
        drums_sdr=10.0,
        notes="fine-tuned 4-model bag; best drums stem available, ~4x slower",
        run=run_audio_separator,
    )
)

register(
    SeparationModel(
        key="htdemucs",
        filename="htdemucs.yaml",
        arch="Demucs v4",
        drums_sdr=9.4,
        notes="single-pass; the fast comparison point against htdemucs_ft",
        run=run_audio_separator,
    )
)

register(
    SeparationModel(
        key="hdemucs_mmi",
        filename="hdemucs_mmi.yaml",
        arch="Demucs v4",
        drums_sdr=9.6,
        notes="hybrid Demucs trained on MMI; different failure modes to htdemucs",
        run=run_audio_separator,
    )
)
