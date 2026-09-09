"""YouTube URL -> ``mix.wav`` (stereo 44.1 kHz) + ``video.mp4``.

Two things this stage must get right, because everything downstream inherits
them:

**Never trim.** ``mix.wav`` starts at the video's t=0, silence and all. Beat
times, stem samples, sync points and the eventual video overlay are all indices
into this one timeline; trimming leading silence here would desynchronise them
in a way that shows up much later as "the cursor drifts" and is miserable to
diagnose. Count-in handling is a bar-index offset in ``grid.lock.json``.

**Stereo, highest bitrate available.** Separation quality depends on it, and
mono-ing the input costs stereo cues that help the drum stem.
"""

from __future__ import annotations

import json
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from pipeline import paths
from pipeline.proc import StageError, capture, note, require_on_path, run

SAMPLE_RATE = 44100

_VIDEO_ID = re.compile(
    r"(?:youtu\.be/|v=|/shorts/|/embed/|/v/)([A-Za-z0-9_-]{11})"
)


def _yt_dlp_base() -> list[str]:
    """``yt-dlp`` invocation prefix.

    YouTube extraction now requires a JavaScript runtime to solve player
    challenges; without one, formats resolve but the download 403s. Only Deno is
    enabled by default, so point yt-dlp at Node when that's what's installed --
    which it is, since the app needs it anyway.
    """
    require_on_path("yt-dlp")
    cmd = ["yt-dlp", "--no-playlist"]
    if shutil.which("node"):
        cmd += ["--js-runtimes", "node"]
    return cmd


def extract_video_id(url_or_id: str) -> str | None:
    """Pull an 11-character YouTube id out of any of its URL shapes.

    Returns ``None`` for things that aren't URLs at all, which is how callers
    tell "this argument is a slug" from "this argument is a link".
    """
    match = _VIDEO_ID.search(url_or_id)
    if match:
        return match.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", url_or_id) and "-" != url_or_id[0]:
        return url_or_id
    return None


@dataclass
class VideoInfo:
    video_id: str
    title: str
    uploader: str
    duration: float


def probe(url: str) -> VideoInfo:
    """Read metadata without downloading, so the slug is known before any I/O."""
    raw = capture(_yt_dlp_base() + ["--skip-download", "--dump-single-json", url])
    data = json.loads(raw)
    return VideoInfo(
        video_id=data["id"],
        title=data.get("title") or data["id"],
        uploader=data.get("uploader") or data.get("channel") or "",
        duration=float(data.get("duration") or 0.0),
    )


def _download_audio(url: str, work: Path) -> Path:
    """Grab the best audio-only stream, whatever container it comes in."""
    run(
        _yt_dlp_base()
        + ["-f", "bestaudio/best", "-o", str(work / "audio.%(ext)s"), url]
    )
    downloaded = sorted(work.glob("audio.*"))
    if not downloaded:
        raise StageError("yt-dlp reported success but wrote no audio file")
    return downloaded[0]


def _download_video(url: str, dest: Path) -> None:
    """Best mp4 at <=1080p. Used by the Phase 6 overlay; muted, so audio here is irrelevant."""
    run(
        _yt_dlp_base()
        + [
            "-f",
            "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b",
            "--merge-output-format",
            "mp4",
            "-o",
            str(dest),
            url,
        ]
    )


def _to_mix_wav(source: Path, dest: Path) -> None:
    """Decode to stereo 44.1 kHz PCM without touching the start or end."""
    require_on_path("ffmpeg")
    run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "2",
            "-ar",
            str(SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            str(dest),
        ]
    )


def fetch(
    url: str, *, force: bool = False, with_video: bool = True
) -> paths.Song:
    """Fetch a song, reusing an existing directory when the video id matches."""
    info = probe(url)
    existing = paths.find_by_video_id(info.video_id)
    song = existing or paths.song_dir(paths.slugify(info.title))
    song.ensure_dirs()

    need_audio = force or not song.mix.exists()
    need_video = with_video and (force or not song.video.exists())

    if need_audio:
        note(f"[fetch] {info.title}")
        with tempfile.TemporaryDirectory(prefix="drums-fetch-") as tmp:
            work = Path(tmp)
            downloaded = _download_audio(url, work)
            _to_mix_wav(downloaded, song.mix)
    if need_video:
        note("[fetch] video")
        _download_video(url, song.video)

    existing_meta = song.meta()
    paths.write_toml(
        song.toml,
        {
            "source": {
                "url": url,
                "video_id": info.video_id,
                "title": info.title,
                "uploader": info.uploader,
                "duration": round(info.duration, 3),
            },
            # Per-song model overrides. Empty values mean "use the config default",
            # which is what makes `compare-separation` a per-song decision later.
            "models": {
                "separation": existing_meta.get("models", {}).get("separation", ""),
            },
            # Grid overrides, honoured by `drums grid`. Written once so the knobs
            # are discoverable in the file rather than only in --help.
            "grid": {
                "meter": existing_meta.get("grid", {}).get("meter", ""),
                "tempo_multiplier": existing_meta.get("grid", {}).get(
                    "tempo_multiplier", ""
                ),
                "downbeat_rotation": existing_meta.get("grid", {}).get(
                    "downbeat_rotation", -1
                ),
            },
        },
    )
    return song
