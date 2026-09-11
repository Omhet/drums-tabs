"""Video/mix offset measurement on synthetic audio."""

from __future__ import annotations

import numpy as np
import pytest

from pipeline import align
from pipeline.proc import StageError

SR = 44100


def performance(seconds: float, seed: int = 1) -> np.ndarray:
    """Something with transients, like a drum take: bursts of noise on a grid."""
    rng = np.random.default_rng(seed)
    y = rng.normal(0, 0.02, int(seconds * SR)).astype(np.float32)
    for hit in np.arange(0.1, seconds, 0.33):
        i = int(hit * SR)
        y[i : i + 800] += rng.normal(0, 1.0, 800).astype(np.float32) * np.linspace(1, 0, 800)
    return y


def shifted(y: np.ndarray, offset_ms: float) -> np.ndarray:
    """``y`` as it would sound in a file cut ``offset_ms`` differently at the start."""
    n = int(round(offset_ms / 1000 * SR))
    if n >= 0:
        return np.concatenate([np.zeros(n, dtype=np.float32), y])
    return y[-n:]


@pytest.mark.parametrize("offset_ms", [36.28, -20.0, 0.0, 480.0])
def test_measures_a_constant_offset(offset_ms: float) -> None:
    mix = performance(70.0)
    video = shifted(mix, offset_ms)
    info = align.measure_offset(video, mix, SR)
    assert info.offset_ms == pytest.approx(offset_ms, abs=0.05)
    assert all(w.correlation > 0.9 for w in info.windows)


def test_refuses_unrelated_audio() -> None:
    mix = performance(70.0, seed=1)
    other = performance(70.0, seed=2)
    with pytest.raises(StageError, match="do not correlate"):
        align.measure_offset(other, mix, SR)


def test_refuses_an_offset_that_changes_mid_song() -> None:
    mix = performance(70.0)
    # A chunk dropped from the video half way: the offset jumps by 30 ms.
    half = mix.size // 2
    video = np.concatenate([shifted(mix[:half], 10.0), shifted(mix[half:], 40.0)])
    with pytest.raises(StageError, match="not constant"):
        align.measure_offset(video, mix, SR)


def test_lag_sign_convention() -> None:
    # Positive lag: the reference (video) is behind the signal (mix).
    mix = performance(70.0)
    ms, corr = align.lag_ms(shifted(mix, 25.0), mix, SR, start_s=10.0)
    assert ms == pytest.approx(25.0, abs=0.05)
    assert corr > 0.9
