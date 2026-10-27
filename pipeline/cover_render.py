"""Composite a cover video: the main phone on top, the foot phone in a corner, tab at the bottom.

The output is 9:16 only, 1080x1920 at 60 fps -- the phones record 60:

    +-----------------------+
    |              +------+ |   main area 1080x1500, from the main phone
    |              | foot | |   (side-front shot of the player), scaled to
    |              +------+ |   cover and cropped; the foot phone's square
    |        main           |   ~380x380 in a white border, top right
    |                       |
    +-----------------------+
    |  tab strip 1080x420   |
    +-----------------------+

One ffmpeg run per video. Its inputs:

* ``raw/main.*`` and ``raw/foot.*``, each seeked to where the video starts
  *on that phone's own clock* (``cover-sync``'s offset and drift), then
  re-timed onto the timeline (``setpts`` divides by the clock rate) and forced
  to a constant 60 fps. An iPhone's HEVC ``.mov`` is stored landscape with a
  rotation flag, which ffmpeg applies on decode, so every crop here is in the
  *upright* picture;
* the tab strip, drawn here frame by frame by :class:`cover_strip.Strip` and
  piped in on stdin as raw RGB;
* ``work/mix.wav`` (or ``mix-<kit>.wav``), which is on the timeline already;
* with ``face_emoji`` set in ``[layout]``, an emoji's PNG, laid over the
  player's face and moved with it every frame (:mod:`pipeline.cover_face`).

The video runs from ``preroll_s`` before the song's bar 1 (or before the
attempt, if it starts later than that) to ``tail_s`` after the attempt: the
count-in is cut, since without the click it is only silence.
Output time 0 is timeline ``t0 = max(attempt start, bar 1) - preroll``.

**Crops**, both ``[x, y, w, h]`` in the phone's upright pixels, in
``cover.toml [layout]``:

* ``main_crop`` -- what of the main phone fills the main area. Left out, it is
  the biggest 1080:1500 box, centred across and with only a quarter of the
  spare height above it (:data:`MAIN_HEADROOM`), so the top of the shot --
  the player's head -- survives rather than an even trim top and bottom. On a
  1080x1920 frame that is ``[0, 105, 1080, 1500]`` (ffmpeg rounds the 105 to
  104 on 4:2:0). A crop of another shape is scaled to cover and centre-cut.
* ``foot_crop`` -- what of the foot phone goes in the inset. Left out, the
  centre square.

The foot phone is optional (no inset without it); the main one is not.

Everything else tunable sits in ``[layout]`` too; the defaults are below.
"""

from __future__ import annotations

import re
import subprocess
import tempfile
import threading
from dataclasses import dataclass, replace
from pathlib import Path

import soundfile as sf

from pipeline import cover
from pipeline.cover_sync import camera_file
from pipeline.proc import StageError, require_on_path

FPS = 60
PREROLL_S = 0.3
TAIL_S = 2.0
BORDER_PX = 6
BORDER_COLOR = "white"
MARGIN_PX = 24
MAIN_HEADROOM = 0.25  # share of the main phone's spare height kept above the default crop
FACE_OVERLAY = "overlay@face"  # the emoji's overlay, by the name its sendcmd file addresses


@dataclass(frozen=True)
class Layout:
    width: int
    height: int
    main_h: int  # the main phone's area, from the top
    strip_h: int  # the tab strip, at the bottom
    inset: int  # the foot picture's side, inside its border


LAYOUT = Layout(1080, 1920, 1500, 420, 380)
TABS = ("scroll", "flip")


@dataclass(frozen=True)
class Camera:
    """One phone, already placed on the output's time axis."""

    path: Path
    seek_s: float  # where to start reading, on the phone's clock
    rate: float  # phone seconds per timeline second (1 + drift)
    pad_s: float = 0.0  # output seconds before the phone's first frame (it started late)
    crop: tuple[int, int, int, int] | None = None  # x, y, w, h in the phone's upright pixels


@dataclass(frozen=True)
class Emoji:
    """The emoji over the face (:mod:`pipeline.cover_face`): a square PNG laid
    on the main picture, moved every frame by a ``sendcmd`` file."""

    image: Path
    side: int  # in output pixels
    commands: Path
    at: tuple[int, int]  # its top-left on the first frame


@dataclass(frozen=True)
class Frame:
    """Where everything goes, and how long the video is."""

    duration: float
    layout: Layout = LAYOUT
    fps: int = FPS
    border: int = BORDER_PX
    border_color: str = BORDER_COLOR
    margin: int = MARGIN_PX
    corner: str = "top-right"
    inset: int | None = None  # overrides the layout's inset size
    audio_start: float = 0.0  # timeline second of output 0 (negative: the mix starts later)
    emoji: Emoji | None = None

    @property
    def inset_px(self) -> int:
        return int(self.inset or self.layout.inset)


# --- the filter graph (pure) -------------------------------------------------


def _retime(cam: Camera, fps: int) -> str:
    """Onto the output's time axis, frame for frame.

    Not ``PTS-STARTPTS``: an input ``-ss`` already puts the seek point at 0,
    and the first frame kept lies up to a frame after it -- subtracting its
    own time would pull the whole picture that much early. And ``fps`` rounds
    up: output frame ``n`` shows the phone frame whose interval holds ``n``,
    not the next one that is merely nearest (half a frame early on average).
    """
    steps = [f"setpts=PTS/{cam.rate:.9f}"]
    if cam.pad_s > 0:
        steps.append(f"tpad=start_duration={cam.pad_s:.4f}:color=black")
    steps.append(f"fps={fps}:round=up")
    return ",".join(steps)


def _box_crop(box: tuple[int, int, int, int]) -> str:
    x, y, w, h = box
    return f"crop={w}:{h}:{x}:{y}"


def _main_crop(box: tuple[int, int, int, int] | None, w: int, h: int) -> str:
    """``box``, or the biggest ``w``:``h`` box: centred across, headroom kept above."""
    if box:
        return _box_crop(box)
    return (f"crop=w='min(iw,ih*{w}/{h})':h='min(ih,iw*{h}/{w})'"
            f":x='(iw-ow)/2':y='(ih-oh)*{MAIN_HEADROOM}'")  # fmt: skip


def _foot_crop(box: tuple[int, int, int, int] | None) -> str:
    return _box_crop(box) if box else "crop=w='min(iw,ih)':h='min(iw,ih)'"


def _filter_path(path: Path) -> str:
    """A file path as a filter option: quoted for the graph, the drive's colon
    escaped for the option (``'C\\:/Users/...'``)."""
    return "'" + path.as_posix().replace(":", "\\:") + "'"


def _fill(w: int, h: int) -> list[str]:
    """Scale to cover ``w`` x ``h`` and centre-crop what spills over."""
    return [f"scale={w}:{h}:force_original_aspect_ratio=increase", f"crop={w}:{h}", "setsar=1"]


def filter_graph(frame: Frame, main: Camera, foot: Camera | None, *, audio: bool = True) -> str:
    """The ``-filter_complex`` string. Inputs, in order: the main phone, the
    foot phone (if any), the strip pipe, the mix (unless ``audio`` is off, for
    a still), the emoji's PNG (if the frame has one). Outputs ``[v]`` and ``[a]``."""
    L = frame.layout
    foot_i = 1 if foot else None
    strip_i = 2 if foot else 1
    audio_i = strip_i + 1
    emoji_i = audio_i + 1 if audio else audio_i

    camera = (f"[0:v]{_retime(main, frame.fps)},{_main_crop(main.crop, L.width, L.main_h)},"
              f"{','.join(_fill(L.width, L.main_h))}")  # fmt: skip
    if frame.emoji:
        # the commands ride on the picture's frames, so each lands on its own
        e = frame.emoji
        chains = [
            f"{camera},sendcmd=f={_filter_path(e.commands)}[camera]",
            f"[{emoji_i}:v]scale={e.side}:{e.side}:flags=lanczos,format=rgba[emoji]",
            f"[camera][emoji]{FACE_OVERLAY}=x={e.at[0]}:y={e.at[1]}[main]",
        ]
    else:
        chains = [f"{camera}[main]"]
    chains.append(f"[main]pad={L.width}:{L.height}:0:0:color=black[base]")
    last = "base"

    # the foot inset, bordered, in a corner of the main picture
    if foot:
        s, b = frame.inset_px, frame.border
        inset = [_retime(foot, frame.fps), _foot_crop(foot.crop), f"scale={s}:{s}", "setsar=1",
                 f"pad={s + 2 * b}:{s + 2 * b}:{b}:{b}:color={frame.border_color}"]  # fmt: skip
        chains.append(f"[{foot_i}:v]{','.join(inset)}[inset]")
        x = L.width - (s + 2 * b) - frame.margin if frame.corner.endswith("right") else frame.margin
        y = L.main_h - (s + 2 * b) - frame.margin if frame.corner.startswith("bottom") else frame.margin
        chains.append(f"[{last}][inset]overlay=x={x}:y={y}:eof_action=repeat[withinset]")
        last = "withinset"

    # the strip along the bottom
    chains.append(f"[{strip_i}:v]setpts=PTS-STARTPTS[strip]")
    chains.append(f"[{last}][strip]overlay=x=0:y={L.main_h}:eof_action=repeat,"
                  f"trim=duration={frame.duration:.4f},format=yuv420p[v]")  # fmt: skip

    if not audio:
        return ";".join(chains)

    # the mix, cut to the same stretch of the timeline
    a = frame.audio_start
    audio_steps = [f"atrim=start={max(a, 0.0):.4f}", "asetpts=PTS-STARTPTS"]
    if a < 0:
        audio_steps.append(f"adelay={round(-a * 1000)}:all=1")
    audio_steps += ["apad", f"atrim=duration={frame.duration:.4f}"]
    chains.append(f"[{audio_i}:a]{','.join(audio_steps)}[a]")
    return ";".join(chains)


def camera_input(cam: Camera, frame: Frame) -> list[str]:
    read = frame.duration * cam.rate + 2.0
    args = ["-ss", f"{cam.seek_s:.4f}"] if cam.seek_s > 0 else []
    return [*args, "-t", f"{read:.4f}", "-i", str(cam.path)]


def strip_input(frame: Frame) -> list[str]:
    L = frame.layout
    return ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{L.width}x{L.strip_h}", "-r", str(frame.fps), "-i", "-"]


def command(frame: Frame, main: Camera, foot: Camera | None, mix: Path, out: Path, *, still: bool) -> list[str]:
    ffmpeg = require_on_path("ffmpeg")
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *camera_input(main, frame)]
    if foot:
        cmd += camera_input(foot, frame)
    cmd += strip_input(frame)
    if not still:
        cmd += ["-i", str(mix)]
    if frame.emoji:
        cmd += ["-i", str(frame.emoji.image)]
    cmd += ["-filter_complex", filter_graph(frame, main, foot, audio=not still), "-map", "[v]"]
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


def cameras(session: cover.Session, t0: float) -> dict[str, Camera]:
    """Each synced phone, placed so its frame at output 0 is timeline ``t0``."""
    settings = session.settings()
    sync, lay = settings.get("sync", {}), settings.get("layout", {})
    found: dict[str, Camera] = {}
    for cam in cover.CAMERAS:
        media = camera_file(session.raw, cam)
        if media is None:
            continue
        if f"{cam}_offset_s" not in sync:
            raise StageError(f"{media.name} is not synced yet; run `drums cover-sync {session.song.slug}`")
        rate = 1.0 + float(sync.get(f"{cam}_drift_ppm", 0.0)) * 1e-6
        offset = float(sync[f"{cam}_offset_s"]) + float(sync.get(f"{cam}_nudge_ms", 0.0)) / 1000.0
        start = offset + rate * t0
        found[cam] = Camera(
            path=media,
            seek_s=max(start, 0.0),
            rate=rate,
            pad_s=max(-start, 0.0) / rate,
            crop=_box(lay.get(f"{cam}_crop")),
        )
    if "main" not in found:
        raise StageError(
            f"no main.* in {session.raw}; run `drums cover-import {session.song.slug} --as main`"
            " (or record with `drums cover-take --obs`)"
        )
    return found


def frame_for(session: cover.Session, duration: float, audio_start: float) -> Frame:
    lay = session.settings().get("layout", {})
    return Frame(
        duration=duration,
        fps=int(lay.get("fps", FPS)),
        border=int(lay.get("border_px", BORDER_PX)),
        border_color=str(lay.get("border_color", BORDER_COLOR)),
        margin=int(lay.get("inset_margin_px", MARGIN_PX)),
        corner=str(lay.get("inset_corner", "top-right")),
        inset=lay.get("inset_px"),
        audio_start=audio_start,
    )


def make_strip(session: cover.Session, tab: str):
    from pipeline import cover_strip

    L = LAYOUT
    lay = session.settings().get("layout", {})
    # How many bars fill the strip's width, and alphaTab's staff size for them:
    # fewer bars on screen means bigger notes, so the scale goes up with them.
    bars = int(lay.get("tab_bars", cover_strip.BARS))
    scale = float(lay.get("tab_scale", cover_strip.SCALE))
    assets = cover_strip.assets_dir(session, tab, L.width, bars, scale)
    if not (assets / "tab.json").exists() or not (assets / "strip.png").exists():
        assets = cover_strip.render_assets(session, tab, L.width, scale, bars)
    return cover_strip.Strip(assets, tab, L.width, L.strip_h, session.clock())


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


def output_path(session: cover.Session, tab: str, kit: str | None, preview_t: float | None) -> Path:
    stem = f"{short_name(session)}-cover-{tab}" + (f"-{kit}" if kit else "")
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
    tab: str = "scroll",
    kit: str | None = None,
    preview_t: float | None = None,
    out: Path | None = None,
    *,
    strip=None,
) -> Path:
    """Render one video (or, with ``preview_t`` in timeline seconds, one PNG still).

    ``strip`` is anything with ``frame(seconds) -> PIL.Image`` of the strip's
    size; by default the song's real tab strip.
    """
    if tab not in TABS:
        raise StageError(f"tab must be one of {TABS}, not {tab!r}")
    session.ensure_dirs()
    lay = session.settings().get("layout", {})
    mix = mix_path(session, kit)
    start, end = attempt_range(session, mix)
    # An attempt opens with the count-in, which is silence once the click
    # is left out of the mix; the video starts just before the song does.
    start = max(start, session.clock().bar_start(1))
    video_t0 = start - float(lay.get("preroll_s", PREROLL_S))
    video = (video_t0, end + float(lay.get("tail_s", TAIL_S)) - video_t0)
    t0, duration = video if preview_t is None else (float(preview_t), 1.0 / int(lay.get("fps", FPS)))
    frame = frame_for(session, duration, audio_start=t0)
    cams = cameras(session, t0)
    out = out or output_path(session, tab, kit, preview_t)
    out.parent.mkdir(parents=True, exist_ok=True)
    count = 1 if preview_t is not None else int(round(duration * frame.fps)) + 1
    if lay.get("face_emoji"):
        from pipeline import cover_face

        cmd_file = session.work / f"{out.stem}-face.cmd"
        frame = replace(frame, emoji=cover_face.emoji_for(session, video, t0, count, frame.fps, cmd_file))
    strip = strip or make_strip(session, tab)
    cmd = command(frame, cams["main"], cams.get("foot"), mix, out, still=preview_t is not None)
    run(cmd, strip, t0, frame.fps, count)
    return out
