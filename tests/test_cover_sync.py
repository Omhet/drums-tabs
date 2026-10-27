"""Finding an attempt in a long camera recording, on synthetic audio.

The "camera" hears a muffled room version of the same hits the dry reference
holds, with its own clock (offset and drift), a false start before the real
attempt, and noise throughout -- as a phone on the floor would.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import butter, sosfilt

from pipeline import cover_sync

SR = 44100
BPM = 130.0


def hit_times(start: float, seconds: float, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Eighth notes from ``start``, played by a human: +-10 ms, uneven, some left out."""
    rng = np.random.default_rng(seed)
    grid = start + np.arange(0, seconds, 30.0 / BPM)
    keep = rng.random(grid.size) > 0.15
    times = grid[keep] + rng.normal(0, 0.006, keep.sum()).clip(-0.01, 0.01)
    return times, rng.uniform(0.3, 1.0, times.size)


def render(times: np.ndarray, gains: np.ndarray, seconds: float, seed: int, *, room: bool) -> np.ndarray:
    rng = np.random.default_rng(seed)
    y = np.zeros(int(seconds * SR), np.float32)
    n = 2200
    shape = np.exp(-np.arange(n) / 300.0).astype(np.float32)
    for t, g in zip(times, gains):
        i = int(round(t * SR))
        if 0 <= i < y.size - n:
            y[i : i + n] += g * shape * rng.normal(0, 1, n).astype(np.float32)
    if room:  # pads heard across the room: dull, a tail, and the room's hiss
        y = sosfilt(butter(4, 1200, "low", fs=SR, output="sos"), y).astype(np.float32)
        tail = np.exp(-np.arange(int(0.08 * SR)) / (0.02 * SR)).astype(np.float32) * 0.3
        y = np.convolve(y, tail)[: y.size].astype(np.float32)
        y = 0.3 * y + rng.normal(0, 0.01, y.size).astype(np.float32)
    return y


def write(path: Path, y: np.ndarray) -> Path:
    sf.write(path, y, SR, subtype="FLOAT")
    return path


def session(tmp_path: Path, *, offset: float, drift_ppm: float, attempt: float, gap: float):
    """A reference wav on the timeline and a camera wav with a false start before it.

    The attempt starts at 2 s on the timeline (after the count-in silence).
    """
    start = 2.0
    times, gains = hit_times(start, attempt, seed=3)
    ref = render(times, gains, start + attempt + 1, seed=4, room=False)

    rate = 1 + drift_ppm * 1e-6
    cam_times = offset + times * rate
    # a false start: the same opening, played a little differently, that stops after ~6 bars
    f_times, f_gains = hit_times(0, 11.0, seed=5)
    f_times = f_times + (cam_times[0] - gap)
    length = cam_times[-1] + 20
    cam = render(np.concatenate([f_times, cam_times]), np.concatenate([f_gains, gains]), length, seed=6, room=True)
    return write(tmp_path / "ref.wav", ref), write(tmp_path / "cam.wav", cam), (start, start + attempt)


def test_recovers_offset_and_drift(tmp_path):
    ref, cam, span = session(tmp_path, offset=47.3217, drift_ppm=80.0, attempt=150.0, gap=40.0)
    res = cover_sync.find_offset(cam, ref, span=span)
    assert abs(res.offset_s - 47.3217) * 1000 < 5
    assert abs(res.drift_ppm - 80.0) < 10
    assert res.confidence > cover_sync.MIN_CONFIDENCE
    assert abs(res.start_err_ms) < 2 and abs(res.end_err_ms) < 2


def test_short_attempt_hidden_in_long_session(tmp_path):
    # six minutes of camera, a 25 s attempt in the middle, a false start before it
    ref, cam, span = session(tmp_path, offset=185.004, drift_ppm=-30.0, attempt=25.0, gap=90.0)
    res = cover_sync.find_offset(cam, ref, span=span)
    assert abs(res.offset_s - 185.004) * 1000 < 5
    assert res.confidence > cover_sync.MIN_CONFIDENCE


def test_camera_time_model():
    res = cover_sync.SyncResult(10.0, 100.0, 5.0, 0.0, 0.0)
    assert res.camera_time(0) == 10.0
    assert res.camera_time(100.0) == pytest.approx(110.01)


def test_envelope_chunks_dont_show():
    rng = np.random.default_rng(0)
    y = rng.normal(0, 0.1, int(cover_sync.SR * 130)).astype(np.float32)
    env = cover_sync.envelope(y, cover_sync.HOP)
    assert env.size == int(np.ceil(y.size / cover_sync.HOP))
    assert np.isfinite(env).all()


def test_sync_session_writes_settings_and_frames(tmp_path):
    import subprocess

    from pipeline import cover, paths

    song = paths.Song("x-y", tmp_path / "x-y")
    song.root.mkdir()
    sess = cover.Session(song, "take1")
    sess.ensure_dirs()
    ref, cam, span = session(tmp_path, offset=21.25, drift_ppm=0.0, attempt=40.0, gap=15.0)
    (sess.work / "drums-only.wav").write_bytes(ref.read_bytes())
    sess.update("attempt", {"start_s": span[0], "end_s": span[1]})
    seconds = sf.info(str(cam)).duration
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         f"testsrc2=s=320x180:r=30:d={seconds:.2f}", "-i", str(cam), "-c:v", "libx264", "-preset", "ultrafast",
         "-c:a", "aac", "-b:a", "128k", "-shortest", str(sess.raw / "foot.mp4")],
        check=True,
    )  # fmt: skip
    results = cover_sync.sync_session(sess)
    assert set(results) == {"foot"}
    sync = sess.settings()["sync"]
    assert abs(sync["foot_offset_s"] - 21.25) * 1000 < 5  # AAC's priming is trimmed by ffmpeg
    assert sync["foot_file"] == "foot.mp4" and sync["foot_nudge_ms"] == 0.0
    assert (sess.work / "foot-frame.png").exists()
