"""Compositing: the 9:16 filter graph, and a tiny real render checked by ffprobe."""

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
from pipeline.proc import StageError


def test_graph_with_both_phones():
    frame = Frame(duration=10.0, audio_start=4.0)
    main = Camera(Path("m.mov"), seek_s=12.0, rate=1.00004, crop=(100, 50, 900, 1250))
    foot = Camera(Path("f.mov"), seek_s=3.0, rate=0.99994)
    g = filter_graph(frame, main, foot)
    assert "[0:v]setpts=PTS/1.000040000,fps=60:round=up,crop=900:1250:100:50," in g
    assert "scale=1080:1500:force_original_aspect_ratio=increase,crop=1080:1500" in g
    assert ("[1:v]setpts=PTS/0.999940000,fps=60:round=up,crop=w='min(iw,ih)':h='min(iw,ih)',"
            "scale=380:380,setsar=1,pad=392:392:6:6:color=white[inset]") in g  # fmt: skip
    assert "overlay=x=664:y=24" in g  # 1080 - 392 - 24
    assert "pad=1080:1920:0:0" in g
    assert "[2:v]setpts=PTS-STARTPTS[strip]" in g
    assert "overlay=x=0:y=1500" in g
    assert "[3:a]atrim=start=4.0000" in g and "adelay" not in g


def test_default_main_crop_keeps_the_top():
    """No main_crop: the main area's shape, centred across, a quarter of the spare height above."""
    g = filter_graph(Frame(duration=1.0), Camera(Path("m.mov"), seek_s=0.0, rate=1.0), None)
    assert "crop=w='min(iw,ih*1080/1500)':h='min(ih,iw*1500/1080)':x='(iw-ow)/2':y='(ih-oh)*0.25'" in g


def test_graph_without_the_foot_phone_and_starting_late():
    frame = Frame(duration=5.0, audio_start=-1.0)
    main = Camera(Path("m.mov"), seek_s=0.0, rate=1.0, pad_s=0.5)
    g = filter_graph(frame, main, None)
    assert "[0:v]setpts=PTS/1.000000000,tpad=start_duration=0.5000:color=black,fps=60:round=up," in g
    assert "[inset]" not in g
    assert "[1:v]setpts=PTS-STARTPTS[strip]" in g
    assert "[2:a]atrim=start=0.0000,asetpts=PTS-STARTPTS,adelay=1000:all=1" in g


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


def phone_file(path: Path, colour: str) -> None:
    """An upright 180x320 phone shot, 60 fps HEVC stored landscape with a -90 flag, as an iPhone writes it."""
    flat = path.with_name(path.stem + "-flat.mov")
    ffmpeg("-f", "lavfi", "-i", f"color=c={colour}:s=180x320:r=60:d=12", "-vf", "transpose=2", "-c:v", "libx265",
           "-tag:v", "hvc1", "-x265-params", "log-level=error", "-pix_fmt", "yuv420p", str(flat))  # fmt: skip
    ffmpeg("-display_rotation", "-90", "-i", str(flat), "-c", "copy", str(path))
    flat.unlink()


@pytest.fixture
def session(tmp_path):
    song = paths.Song("blur-song-2-official-music-video", tmp_path / "blur-song-2-official-music-video")
    song.root.mkdir()
    paths.write_toml(song.toml, {"source": {"uploader": "Blur"}})
    # The clock: 130 BPM, bar 1 at the arrangement's start, so the attempt
    # (starting later, at 2 s) is what the video starts from.
    song.stems_dir.mkdir()
    song.straight_json.write_text('{"bpm": 130.0}', encoding="utf-8")
    song.grid_lock.write_text(json.dumps({"bar_one_beat": 0, "beats": [i * 60 / 130 for i in range(64)]}), encoding="utf-8")
    sess = cover.Session(song, "take1")
    sess.ensure_dirs()
    sess.update("session", {"timing": "straight", "count_in_bars": 1, "stem_start_beats": 0.0})
    sess.update("attempt", {"start_s": 2.0, "end_s": 2.0 + 0.5})  # 0.3 s pre-roll + 0.5 s + 2 s tail = 2.8 s
    sess.update("sync", {"main_offset_s": 3.0, "main_drift_ppm": 40.0, "main_nudge_ms": 0.0,
                         "foot_offset_s": 4.0, "foot_drift_ppm": -60.0, "foot_nudge_ms": 0.0})  # fmt: skip
    tone = 0.1 * np.sin(2 * np.pi * 440 * np.arange(44100 * 8) / 44100)
    sf.write(sess.work / "mix.wav", np.stack([tone, tone], 1), 44100)
    phone_file(sess.raw / "main.mov", "red")
    phone_file(sess.raw / "foot.mov", "blue")
    return sess


def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )  # fmt: skip
    return json.loads(out.stdout)


def test_tiny_render(session):
    L = cover_render.LAYOUT
    out = cover_render.build(session, "scroll", strip=DummyStrip(L.width, L.strip_h))
    assert out == session.out / "song2-cover-scroll.mp4"
    info = probe(out)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    audio = next(s for s in info["streams"] if s["codec_type"] == "audio")
    assert (video["width"], video["height"]) == (1080, 1920)
    assert video["codec_name"] == "h264" and video["pix_fmt"] == "yuv420p"
    assert video["avg_frame_rate"] == "60/1"
    assert audio["codec_name"] == "aac"
    assert float(info["format"]["duration"]) == pytest.approx(2.8, abs=0.1)
    head = out.read_bytes()[:64 * 1024]
    assert head.find(b"moov") < head.find(b"mdat") or b"mdat" not in head  # +faststart


def test_preview_still(session):
    L = cover_render.LAYOUT
    out = cover_render.build(session, "flip", preview_t=2.2, strip=DummyStrip(L.width, L.strip_h))
    assert out == session.work / "song2-cover-flip-at-2.2s.png"
    with Image.open(out) as im:
        assert im.size == (1080, 1920)
        px = im.convert("RGB")
        r, g, b = px.getpixel((200, 800))  # the main phone: red, upright and filling the area
        assert r > 200 and g < 60 and b < 60
        r, g, b = px.getpixel((1080 - 24 - 6 - 190, 24 + 6 + 190))  # the foot inset's centre: blue
        assert b > 200 and r < 60
        assert px.getpixel((1080 - 24 - 2, 24 + 100)) == (255, 255, 255)  # its white border, top right
        assert px.getpixel((5, 1920 - 50))[0] > 200  # the strip is at the bottom


def test_no_main_phone_is_an_error(session):
    (session.raw / "main.mov").unlink()
    with pytest.raises(StageError, match="--as main"):
        cover_render.build(session, "scroll", strip=DummyStrip(1080, 420))


def test_short_name(session):
    assert cover_render.short_name(session) == "song2"
