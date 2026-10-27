"""Composite a cover video: webcam on top, the foot shot in a corner, tab at the bottom.

One ffmpeg run per video. Its inputs:

* the webcam file and the iPhone file, each seeked to where the video starts
  *on that camera's own clock* (``cover-sync``'s offset and drift), then
  re-timed onto the timeline (``setpts`` divides by the clock rate) and forced
  to a constant 30 fps -- the iPhone records variable frame rate, and its HEVC
  ``.mov`` carries a rotation flag that ffmpeg applies on decode;
* the tab strip, drawn here frame by frame by :class:`cover_strip.Strip` and
  piped in on stdin as raw RGB;
* ``work/mix.wav`` (or ``mix-<kit>.wav``), which is on the timeline already.

The video runs from ``preroll_s`` before the attempt to ``tail_s`` after it.
Output time 0 is timeline ``t0 = attempt start - preroll``.

The webcam is not connected yet, so the main area falls back to the iPhone's
whole frame, or to a dark card when there is no camera at all.

Everything tunable sits in ``cover.toml [layout]``; the defaults are below.
"""

from __future__ import annotations

import re
import subprocess
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path

import soundfile as sf

from pipeline import cover
from pipeline.cover_sync import camera_file
from pipeline.proc import StageError, require_on_path

FPS = 30
PREROLL_S = 1.0
TAIL_S = 2.0
BORDER_PX = 6
BORDER_COLOR = "white"
MARGIN_PX = 24
CARD_COLOR = "0x1c1c1e"


@dataclass(frozen=True)
class Layout:
    name: str
    width: int
    height: int
    main_h: int  # the webcam area, from the top
    strip_h: int  # the tab strip, at the bottom
    inset: int  # the foot picture's side, inside its border


LAYOUTS = {
    "16x9": Layout("16x9", 1920, 1080, 780, 300, 460),
    "9x16": Layout("9x16", 1080, 1920, 1500, 420, 380),
}
TABS = ("scroll", "flip")


@dataclass(frozen=True)
class Camera:
    """One camera input, already placed on the output's time axis."""

    path: Path
    seek_s: float  # where to start reading, on the camera's clock
    rate: float  # camera seconds per timeline second (1 + drift)
    pad_s: float = 0.0  # output seconds before the camera's first frame (it started late)
    crop: tuple[int, int, int, int] | None = None  # x, y, w, h in the camera's upright pixels


@dataclass(frozen=True)
class Frame:
    """Where everything goes, and how long the video is."""

    layout: Layout
    duration: float
    fps: int = FPS
    border: int = BORDER_PX
    border_color: str = BORDER_COLOR
    margin: int = MARGIN_PX
    corner: str = "top-right"
    inset: int | None = None  # overrides the layout's inset size
    audio_start: float = 0.0  # timeline second of output 0 (negative: the mix starts later)
    extra: dict = field(default_factory=dict)

    @property
    def inset_px(self) -> int:
        return int(self.inset or self.layout.inset)


# --- the filter graph (pure) -------------------------------------------------


def _retime(cam: Camera, fps: int) -> str:
    """Onto the output's time axis, frame for frame.

    Not ``PTS-STARTPTS``: an input ``-ss`` already puts the seek point at 0,
    and the first frame kept lies up to a frame after it -- subtracting its
    own time would pull the whole picture that much early. And ``fps`` rounds
    up: output frame ``n`` shows the camera frame whose interval holds ``n``,
    not the next one that is merely nearest (half a frame early on average).
    """
    steps = [f"setpts=PTS/{cam.rate:.9f}"]
    if cam.pad_s > 0:
        steps.append(f"tpad=start_duration={cam.pad_s:.4f}:color=black")
    steps.append(f"fps={fps}:round=up")
    return ",".join(steps)


def _crop(box: tuple[int, int, int, int] | None, square: bool) -> list[str]:
    if box:
        x, y, w, h = box
        return [f"crop={w}:{h}:{x}:{y}"]
    return ["crop=w='min(iw,ih)':h='min(iw,ih)'"] if square else []


def _fill(w: int, h: int) -> list[str]:
    """Scale to cover ``w`` x ``h`` and centre-crop what spills over."""
    return [f"scale={w}:{h}:force_original_aspect_ratio=increase", f"crop={w}:{h}", "setsar=1"]


def filter_graph(frame: Frame, webcam: Camera | None, iphone: Camera | None, *, audio: bool = True) -> str:
    """The ``-filter_complex`` string. Inputs, in order: webcam (if any), iPhone
    (if any), the strip pipe, the mix (unless ``audio`` is off, for a still).
    Outputs ``[v]`` and ``[a]``."""
    L = frame.layout
    idx = 0
    chains: list[str] = []
    web_i = phone_i = None
    if webcam:
        web_i, idx = idx, idx + 1
    if iphone:
        phone_i, idx = idx, idx + 1
    strip_i, audio_i = idx, idx + 1

    # the main area
    if webcam:
        main = ",".join([_retime(webcam, frame.fps), *_crop(webcam.crop, False), *_fill(L.width, L.main_h)])
        chains.append(f"[{web_i}:v]{main}[main]")
        if iphone:
            chains.append(f"[{phone_i}:v]{_retime(iphone, frame.fps)}[foot]")
    elif iphone:  # placeholder: the iPhone's whole frame
        chains.append(f"[{phone_i}:v]{_retime(iphone, frame.fps)},split=2[ph][foot]")
        chains.append(f"[ph]{','.join(_fill(L.width, L.main_h))}[main]")
    else:
        chains.append(f"color=c={CARD_COLOR}:s={L.width}x{L.main_h}:r={frame.fps}:d={frame.duration:.4f}[main]")
    chains.append(f"[main]pad={L.width}:{L.height}:0:0:color=black[base]")
    last = "base"

    # the foot inset, bordered, in a top corner
    if iphone:
        s, b = frame.inset_px, frame.border
        inset = [*_crop(iphone.crop, True), f"scale={s}:{s}", "setsar=1",
                 f"pad={s + 2 * b}:{s + 2 * b}:{b}:{b}:color={frame.border_color}"]
        chains.append(f"[foot]{','.join(inset)}[inset]")
        x = L.width - (s + 2 * b) - frame.margin if frame.corner.endswith("right") else frame.margin
        chains.append(f"[{last}][inset]overlay=x={x}:y={frame.margin}:eof_action=repeat[withinset]")
        last = "withinset"

    # the strip along the bottom
    chains.append(f"[{strip_i}:v]setpts=PTS-STARTPTS[strip]")
    chains.append(f"[{last}][strip]overlay=x=0:y={L.main_h}:eof_action=repeat,"
                  f"trim=duration={frame.duration:.4f},format=yuv420p[v]")

    if not audio:
        return ";".join(chains)

    # the mix, cut to the same stretch of the timeline
    a = frame.audio_start
    audio = [f"atrim=start={max(a, 0.0):.4f}", "asetpts=PTS-STARTPTS"]
    if a < 0:
        audio.append(f"adelay={round(-a * 1000)}:all=1")
    audio += ["apad", f"atrim=duration={frame.duration:.4f}"]
    chains.append(f"[{audio_i}:a]{','.join(audio)}[a]")
    return ";".join(chains)


def camera_input(cam: Camera, frame: Frame) -> list[str]:
    read = frame.duration * cam.rate + 2.0
    args = ["-ss", f"{cam.seek_s:.4f}"] if cam.seek_s > 0 else []
    return [*args, "-t", f"{read:.4f}", "-i", str(cam.path)]


def strip_input(frame: Frame) -> list[str]:
    L = frame.layout
    return ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{L.width}x{L.strip_h}", "-r", str(frame.fps), "-i", "-"]


def command(frame: Frame, webcam: Camera | None, iphone: Camera | None, mix: Path, out: Path, *, still: bool) -> list[str]:
    ffmpeg = require_on_path("ffmpeg")
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
    for cam in (webcam, iphone):
        if cam:
            cmd += camera_input(cam, frame)
    cmd += strip_input(frame)
    if not still:
        cmd += ["-i", str(mix)]
    cmd += ["-filter_complex", filter_graph(frame, webcam, iphone, audio=not still), "-map", "[v]"]
    if still:
        return [*cmd, "-frames:v", "1", "-update", "1", str(out)]
    return [*cmd, "-map", "[a]",
            "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", str(frame.fps),
            "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart",
            "-t", f"{frame.duration:.4f}", str(out)]  # fmt: skip


# --- from the session --------------------------------------------------------


def _box(value) -> tuple[int, int, int, int] | None:
    if not value:
        return None
    if len(value) != 4:
        raise StageError(f"a crop is [x, y, w, h], not {value!r}")
    return tuple(int(v) for v in value)  # type: ignore[return-value]


def _layout_value(lay: dict, key: str, layout: str, default=None):
    return lay.get(f"{key}_{layout}", lay.get(key, default))


def attempt_range(session: cover.Session, mix: Path) -> tuple[float, float]:
    attempt = session.settings().get("attempt", {})
    if "start_s" in attempt and "end_s" in attempt:
        return float(attempt["start_s"]), float(attempt["end_s"])
    return 0.0, float(sf.info(str(mix)).duration)


def mix_path(session: cover.Session, kit: str | None) -> Path:
    path = session.work / (f"mix-{kit}.wav" if kit else "mix.wav")
    if not path.exists():
        hint = f" --kit {kit}" if kit else ""
        raise StageError(f"no {path.name} in {session.work}; run `drums cover-mix{hint}` first")
    return path


def cameras(session: cover.Session, layout: str, t0: float) -> dict[str, Camera]:
    """Each synced camera, placed so its frame at output 0 is timeline ``t0``."""
    settings = session.settings()
    sync, lay = settings.get("sync", {}), settings.get("layout", {})
    found: dict[str, Camera] = {}
    for cam in ("webcam", "iphone"):
        media = camera_file(session.raw, cam)
        if media is None:
            continue
        if f"{cam}_offset_s" not in sync:
            raise StageError(f"{media.name} is not synced yet; run `drums cover-sync {session.song.slug}`")
        rate = 1.0 + float(sync.get(f"{cam}_drift_ppm", 0.0)) * 1e-6
        offset = float(sync[f"{cam}_offset_s"]) + float(sync.get(f"{cam}_nudge_ms", 0.0)) / 1000.0
        start = offset + rate * t0
        crop_key = "webcam_crop" if cam == "webcam" else "foot_crop"
        found[cam] = Camera(
            path=media,
            seek_s=max(start, 0.0),
            rate=rate,
            pad_s=max(-start, 0.0) / rate,
            crop=_box(_layout_value(lay, crop_key, layout) if cam == "webcam" else lay.get(crop_key)),
        )
    return found


def frame_for(session: cover.Session, layout: str, duration: float, audio_start: float) -> Frame:
    lay = session.settings().get("layout", {})
    return Frame(
        layout=LAYOUTS[layout],
        duration=duration,
        fps=int(lay.get("fps", FPS)),
        border=int(lay.get("border_px", BORDER_PX)),
        border_color=str(lay.get("border_color", BORDER_COLOR)),
        margin=int(_layout_value(lay, "inset_margin_px", layout, MARGIN_PX)),
        corner=str(lay.get("inset_corner", "top-right")),
        inset=_layout_value(lay, "inset_px", layout),
        audio_start=audio_start,
    )


def make_strip(session: cover.Session, layout: Layout, tab: str):
    from pipeline import cover_strip

    assets = cover_strip.assets_dir(session, tab, layout.width)
    if not (assets / "tab.json").exists() or not (assets / "strip.png").exists():
        assets = cover_strip.render_assets(session, tab, width=layout.width)
    return cover_strip.Strip(assets, tab, layout.width, layout.strip_h, session.clock())


def short_name(session: cover.Session) -> str:
    """``song2`` for ``blur-song-2-official-music-video``: the artist and the
    "official video" tail come off, and the hyphens."""
    slug = session.song.slug
    uploader = str(session.song.meta().get("source", {}).get("uploader", ""))
    artist = re.sub(r"[^a-z0-9]+", "-", uploader.lower()).strip("-")
    if artist and slug.startswith(artist + "-"):
        slug = slug[len(artist) + 1 :]
    slug = re.split(r"-(official|lyric|music-video|visualizer)", slug)[0]
    return slug.replace("-", "") or session.song.slug


def output_path(session: cover.Session, layout: str, tab: str, kit: str | None, preview_t: float | None) -> Path:
    stem = f"{short_name(session)}-cover-{layout}-{tab}" + (f"-{kit}" if kit else "")
    if preview_t is not None:
        return session.work / f"{stem}-at-{preview_t:g}s.png"
    return session.out / f"{stem}.mp4"


def _feed(proc: subprocess.Popen, strip, t0: float, fps: int, count: int, errors: list) -> None:
    try:
        for k in range(count):
            proc.stdin.write(strip.frame(t0 + k / fps).tobytes())
    except (BrokenPipeError, OSError) as exc:  # ffmpeg stopped reading: its own error says why
        errors.append(exc)
    except Exception as exc:  # noqa: BLE001 -- surfaced after ffmpeg exits
        errors.append(exc)
    finally:
        try:
            proc.stdin.close()
        except OSError:
            pass


def run(cmd: list[str], strip, t0: float, fps: int, count: int) -> None:
    """Run ffmpeg, drawing ``count`` strip frames into its stdin as it goes."""
    with tempfile.TemporaryFile() as log:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log)
        errors: list = []
        feeder = threading.Thread(target=_feed, args=(proc, strip, t0, fps, count, errors), daemon=True)
        feeder.start()
        code = proc.wait()
        feeder.join()
        log.seek(0)
        text = log.read().decode(errors="replace").strip()
    if code != 0:
        raise StageError(f"ffmpeg failed (exit {code}): {text[-2000:]}")
    real = [e for e in errors if not isinstance(e, OSError)]
    if real:
        raise StageError(f"drawing the tab strip failed: {real[0]!r}")


def build(
    session: cover.Session,
    layout: str = "16x9",
    tab: str = "scroll",
    kit: str | None = None,
    preview_t: float | None = None,
    out: Path | None = None,
    *,
    strip=None,
) -> Path:
    """Render one video (or, with ``preview_t`` in timeline seconds, one PNG still).

    ``strip`` is anything with ``frame(seconds) -> PIL.Image`` of the layout's
    strip size; by default the song's real tab strip.
    """
    if layout not in LAYOUTS:
        raise StageError(f"layout must be one of {sorted(LAYOUTS)}, not {layout!r}")
    if tab not in TABS:
        raise StageError(f"tab must be one of {TABS}, not {tab!r}")
    session.ensure_dirs()
    lay = session.settings().get("layout", {})
    mix = mix_path(session, kit)
    if preview_t is None:
        start, end = attempt_range(session, mix)
        t0 = start - float(lay.get("preroll_s", PREROLL_S))
        duration = end + float(lay.get("tail_s", TAIL_S)) - t0
    else:
        t0, duration = float(preview_t), 1.0 / int(lay.get("fps", FPS))
    frame = frame_for(session, layout, duration, audio_start=t0)
    cams = cameras(session, layout, t0)
    out = out or output_path(session, layout, tab, kit, preview_t)
    out.parent.mkdir(parents=True, exist_ok=True)
    strip = strip or make_strip(session, frame.layout, tab)
    cmd = command(frame, cams.get("webcam"), cams.get("iphone"), mix, out, still=preview_t is not None)
    count = 1 if preview_t is not None else int(round(duration * frame.fps)) + 1
    run(cmd, strip, t0, frame.fps, count)
    return out
