"""Compositing: the filter graph per layout, and a tiny real render checked by ffprobe."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from PIL import Image

from pipeline import cover, cover_render, paths
from pipeline.cover_render import Camera, Frame, filter_graph


def test_graph_16x9_with_webcam():
    frame = Frame(cover_render.LAYOUTS["16x9"], duration=10.0, audio_start=4.0)
    web = Camera(Path("w.mp4"), seek_s=12.0, rate=1.0, crop=(100, 50, 1600, 650))
    phone = Camera(Path("p.mov"), seek_s=3.0, rate=1.00008)
    g = filter_graph(frame, web, phone)
    assert "[0:v]setpts=PTS/1.000000000,fps=30:round=up,crop=1600:650:100:50," in g
    assert "scale=1920:780:force_original_aspect_ratio=increase,crop=1920:780" in g
    assert "[1:v]setpts=PTS/1.000080000,fps=30:round=up[foot]" in g
    assert "crop=w='min(iw,ih)':h='min(iw,ih)',scale=460:460,setsar=1,pad=472:472:6:6:color=white" in g
    assert "overlay=x=1424:y=24" in g  # 1920 - 472 - 24
    assert "[2:v]setpts=PTS-STARTPTS[strip]" in g
    assert "overlay=x=0:y=780" in g
    assert "[3:a]atrim=start=4.0000" in g and "adelay" not in g


def test_graph_9x16_without_webcam_uses_the_iphone_as_placeholder():
    frame = Frame(cover_render.LAYOUTS["9x16"], duration=5.0, audio_start=-1.0)
    phone = Camera(Path("p.mov"), seek_s=0.0, rate=1.0, pad_s=0.5, crop=(10, 20, 300, 300))
    g = filter_graph(frame, None, phone)
    assert "[0:v]setpts=PTS/1.000000000,tpad=start_duration=0.5000:color=black,fps=30:round=up,split=2[ph][foot]" in g
    assert "[ph]scale=1080:1500:force_original_aspect_ratio=increase,crop=1080:1500" in g
    assert "[foot]crop=300:300:10:20,scale=380:380" in g
    assert "pad=1080:1920:0:0" in g
    assert "overlay=x=0:y=1500" in g
    assert "[1:v]setpts=PTS-STARTPTS[strip]" in g
    assert "[2:a]atrim=start=0.0000,asetpts=PTS-STARTPTS,adelay=1000:all=1" in g


def test_graph_with_no_camera_is_a_dark_card():
    g = filter_graph(Frame(cover_render.LAYOUTS["16x9"], duration=3.0), None, None)
    assert g.startswith("color=c=0x1c1c1e:s=1920x780:r=30:d=3.0000[main]")
    assert "[inset]" not in g and "[0:v]setpts=PTS-STARTPTS[strip]" in g and "[1:a]" in g


class DummyStrip:
    """Stands in for cover_strip.Strip: a grey bar with a red playhead moving across."""

    def __init__(self, width: int, height: int):
        self.width, self.height = width, height

    def frame(self, t: float) -> Image.Image:
        a = np.full((self.height, self.width, 3), 235, np.uint8)
        x = int((t * 200) % self.width)
        a[:, x : x + 4] = (230, 30, 40)
        return Image.fromarray(a, "RGB")


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


@pytest.fixture
def session(tmp_path):
    song = paths.Song("blur-song-2-official-music-video", tmp_path / "blur-song-2-official-music-video")
    song.root.mkdir()
    paths.write_toml(song.toml, {"source": {"uploader": "Blur"}})
    sess = cover.Session(song, "take1")
    sess.ensure_dirs()
    sess.update("session", {"timing": "straight"})
    sess.update("attempt", {"start_s": 2.0, "end_s": 2.0 + 0.5})  # 1 s pre-roll + 0.5 s + 2 s tail = 3.5 s
    sess.update("sync", {"iphone_offset_s": 4.0, "iphone_drift_ppm": 80.0, "iphone_nudge_ms": 0.0})
    tone = 0.1 * np.sin(2 * np.pi * 440 * np.arange(44100 * 8) / 44100)
    sf.write(sess.work / "mix.wav", np.stack([tone, tone], 1), 44100)
    # the iPhone: HEVC in a .mov at 25 fps, flagged as rotated, like a portrait phone file
    flat = sess.raw / "flat.mov"
    ffmpeg("-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=12", "-c:v", "libx265", "-tag:v", "hvc1",
           "-x265-params", "log-level=error", "-pix_fmt", "yuv420p", str(flat))  # fmt: skip
    ffmpeg("-display_rotation", "90", "-i", str(flat), "-c", "copy", str(sess.raw / "iphone.mov"))
    flat.unlink()
    return sess


def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )  # fmt: skip
    return json.loads(out.stdout)


def test_tiny_render(session):
    L = cover_render.LAYOUTS["16x9"]
    out = cover_render.build(session, "16x9", "scroll", strip=DummyStrip(L.width, L.strip_h))
    assert out == session.out / "song2-cover-16x9-scroll.mp4"
    info = probe(out)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    audio = next(s for s in info["streams"] if s["codec_type"] == "audio")
    assert (video["width"], video["height"]) == (1920, 1080)
    assert video["codec_name"] == "h264" and video["pix_fmt"] == "yuv420p"
    assert video["avg_frame_rate"] == "30/1"
    assert audio["codec_name"] == "aac"
    assert float(info["format"]["duration"]) == pytest.approx(3.5, abs=0.1)
    head = out.read_bytes()[:64 * 1024]
    assert head.find(b"moov") < head.find(b"mdat") or b"mdat" not in head  # +faststart


def test_preview_still_9x16(session):
    L = cover_render.LAYOUTS["9x16"]
    out = cover_render.build(session, "9x16", "flip", preview_t=2.2, strip=DummyStrip(L.width, L.strip_h))
    assert out == session.work / "song2-cover-9x16-flip-at-2.2s.png"
    with Image.open(out) as im:
        assert im.size == (1080, 1920)
        px = im.convert("RGB")
        # the inset's white border, top right
        assert px.getpixel((1080 - 24 - 2, 24 + 100)) == (255, 255, 255)
        # the strip is at the bottom
        assert px.getpixel((5, 1920 - 50))[0] > 200


def test_short_name(session):
    assert cover_render.short_name(session) == "song2"
