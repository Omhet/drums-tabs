"""Transcription backends. Importing this package registers every available one."""

from __future__ import annotations

from pipeline.backends import stems as _stems  # noqa: F401  (registers the backend)
from pipeline.backends.base import (
    DEFAULT_BACKEND,
    REGISTRY,
    Backend,
    OnsetEvent,
    available,
    detect,
    get,
    load,
    register,
    save,
)

__all__ = [
    "DEFAULT_BACKEND",
    "REGISTRY",
    "Backend",
    "OnsetEvent",
    "available",
    "detect",
    "get",
    "load",
    "register",
    "save",
]
