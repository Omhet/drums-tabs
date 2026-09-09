"""Separation backends. Importing this package registers every available model."""

from __future__ import annotations

from pipeline.separation import demucs as _demucs  # noqa: F401  (registers models)
from pipeline.separation import mdx as _mdx  # noqa: F401  (registers models)
from pipeline.separation.base import (
    DEFAULT_MODEL,
    REGISTRY,
    SeparationModel,
    SeparationResult,
    available,
    get,
    separate,
)

__all__ = [
    "DEFAULT_MODEL",
    "REGISTRY",
    "SeparationModel",
    "SeparationResult",
    "available",
    "get",
    "separate",
]
