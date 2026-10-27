"""An emoji over the player's face in the main picture, following the head.

Turned on by ``face_emoji`` in ``cover.toml [layout]``: the emoji itself
(``"😎"``), or ``true`` for that one. Also in ``[layout]``:

* ``face_scale`` -- the emoji's side over the face's size, brow to chin
  (:data:`FACE_SCALE`). The emoji is round and the face turns, so it takes
  2 -- about the head's width with the headphones -- for the face's whole box
  to stay under it nearly all the time; at 1.6 the box's corners peek out a
  quarter of the time;
* ``face_dx``, ``face_dy`` -- a nudge, in output pixels.

**The track**, in four steps:

1. *Frames.* The main phone decoded through the very chain the render puts it
   through (:func:`cover_render._retime`): seek, re-time onto the timeline,
   constant 60 fps -- so a detection is of the very picture an output frame
   shows, numbered by its timestamp as the render's commands are
   (:func:`first_frame`). Every :data:`DETECT_EVERY`-th one, upright and
   uncropped, so a head at the edge of ``main_crop`` is still found.
2. *Detection.* MediaPipe's pose landmarker (the heavy model) finds the body,
   which survives what a face detector does not -- a head turned away, looking
   down at the kit, the headphones over the ears. The mean of its eleven head
   points (nose, eyes, ears, mouth) is the centre: on this footage it sits
   within a twentieth of a face of where YuNet boxes the face, and holds
   steadier than any one point. OpenCV's YuNet face detector, run on a box
   around that centre, measures the face where it is seen: one size for the
   whole video, the median, since the player sits at one distance.
3. *Cleaning* (:func:`clean`). A centre further than :data:`OUTLIER_FACES`
   faces from the median of its neighbours is dropped, gaps are bridged in a
   straight line, and a short Savitzky-Golay filter (a moving polynomial fit:
   it smooths jitter without lagging a fast move) runs over the rest.
4. *Cache.* ``work/face-track.json`` holds the detections, keyed by what they
   depend on: the main phone's file, where it is read from and how fast
   (``[sync]`` and the video's range), the frame rate and the detector. The
   crop is not in the key: detections are in the phone's upright pixels and
   are carried into the output (:func:`to_output`) when used, so moving
   ``main_crop`` or changing the emoji re-renders without re-detecting.

**The emoji** is Google's Noto Emoji PNG (Apache-2.0), fetched once into
``kit/emoji/``. In the render it is one ``overlay`` on the main picture, moved
every frame by a ``sendcmd`` file (:func:`commands`).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.request
import warnings
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.signal import savgol_filter

from pipeline import cover, paths
from pipeline import cover_render as render
from pipeline.proc import StageError, note, require_on_path

DEFAULT_EMOJI = "😎"
FACE_SCALE = 2.0
DETECT_EVERY = 2  # output frames per detection: 30 a second at 60 fps
OUTLIER_FACES = 1.0  # a centre this many face sizes off its neighbours' median is a misdetection
NEIGHBOURS = 9  # detections in that median
SMOOTH = 5  # detections in the Savitzky-Golay window: 1/6 s at 30 a second
TRACK_FILE = "face-track.json"

EMOJI_DIR = paths.REPO_ROOT / "kit" / "emoji"
MODEL_DIR = paths.REPO_ROOT / "kit" / "models"
EMOJI_URLS = (  # the repository's own, then a mirror of the last release before it moved them
    "https://raw.githubusercontent.com/googlefonts/noto-emoji/main/2D/png/512/{name}.png",
    "https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@v2.047/png/512/{name}.png",
)
POSE_MODEL = (
    "pose_landmarker_heavy.task",
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task",
)
FACE_MODEL = (
    "face_detection_yunet_2023mar.onnx",
    "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
)
DETECTOR = "pose_landmarker_heavy+yunet_2023mar/2"  # bump when detection changes: the cache is keyed on it
HEAD_POINTS = range(11)  # the pose landmarks of the head: nose, eyes, ears, mouth
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


# --- the emoji ---------------------------------------------------------------


def emoji_name(emoji: str) -> str:
    """Noto's file name for ``emoji``: ``emoji_u`` and its code points in hex,
    at least four digits, joined by ``_``, without the U+FE0F variation
    selector (``❤️`` is ``emoji_u2764``, ``👋🏽`` is ``emoji_u1f44b_1f3fd``)."""
    points = [f"{ord(c):04x}" for c in emoji.strip() if ord(c) != 0xFE0F]
    if not points:
        raise StageError("face_emoji is empty")
    return "emoji_u" + "_".join(points)


def _download(urls: list[str], dest: Path, check=lambda data: True) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    for url in urls:
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = r.read()
        except OSError:
            continue
        if check(data):
            part = dest.with_name(dest.name + ".part")
            part.write_bytes(data)
            part.replace(dest)
            return dest
    raise StageError(f"could not download {dest.name} from {urls[0]}")


def emoji_png(emoji: str) -> Path:
    """The 512-pixel Noto PNG for ``emoji``, cached in ``kit/emoji/``."""
    name = emoji_name(emoji)
    path = EMOJI_DIR / f"{name}.png"
    if path.exists():
        return path
    try:
        return _download([u.format(name=name) for u in EMOJI_URLS], path, lambda d: d.startswith(PNG_MAGIC))
    except StageError:
        raise StageError(f"Noto Emoji has no {name}.png (no flags, say), or it is offline") from None


def _model(name: str, url: str) -> Path:
    path = MODEL_DIR / name
    return path if path.exists() else _download([url], path, lambda d: len(d) > 1000)


# --- cleaning a track (pure) -------------------------------------------------


def _rolling_median(v: np.ndarray, width: int) -> np.ndarray:
    half = width // 2
    padded = np.pad(v, half, constant_values=np.nan)
    windows = np.lib.stride_tricks.sliding_window_view(padded, width)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # an all-gap window is NaN, as it should be
        return np.nanmedian(windows, axis=1)


def clean(frames: np.ndarray, x: np.ndarray, y: np.ndarray, size: float, count: int) -> tuple[np.ndarray, np.ndarray]:
    """The face's centre on every output frame ``0 .. count-1``.

    ``frames`` are the output frames detected, ascending; ``x``, ``y`` the
    centres found, NaN where none was. ``size`` is the face's, which sets how
    far off its neighbours a centre may be before it counts as a misdetection.
    Before the first detection and after the last, the nearest one stands in.
    """
    frames = np.asarray(frames, float)
    x, y = np.asarray(x, float).copy(), np.asarray(y, float).copy()
    ok = np.isfinite(x) & np.isfinite(y)
    if not ok.any():
        raise StageError("the face was not found in any frame")
    x[~ok] = y[~ok] = np.nan
    off = np.hypot(x - _rolling_median(x, NEIGHBOURS), y - _rolling_median(y, NEIGHBOURS))
    ok &= ~(off > OUTLIER_FACES * size)
    x = np.interp(frames, frames[ok], x[ok])
    y = np.interp(frames, frames[ok], y[ok])
    if len(frames) >= SMOOTH:
        x, y = (savgol_filter(v, SMOOTH, 2, mode="interp") for v in (x, y))
    every = np.arange(count, dtype=float)
    return np.interp(every, frames, x), np.interp(every, frames, y)


# --- detection ---------------------------------------------------------------


def upright_size(path: Path) -> tuple[int, int]:
    """The video's width and height as ffmpeg decodes it: rotation applied."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height:stream_side_data=rotation", "-of", "json", str(path)],
        capture_output=True, text=True, check=False,
    )  # fmt: skip
    if probe.returncode != 0:
        raise StageError(f"ffprobe cannot read {path}: {probe.stderr.strip()}")
    stream = json.loads(probe.stdout)["streams"][0]
    w, h = int(stream["width"]), int(stream["height"])
    rotation = next((int(s.get("rotation", 0)) for s in stream.get("side_data_list", []) if "rotation" in s), 0)
    return (h, w) if abs(rotation) % 180 == 90 else (w, h)


def first_frame(cam: render.Camera, fps: int) -> int:
    """The output frame ``cam``'s first picture is: 1, mostly, not 0.

    The first frame kept after a seek lies up to a frame past it, and the
    render's ``fps`` rounds up (:func:`cover_render._retime`), so the picture
    starts at timestamp ``1/fps``. Everything in the render is keyed on
    timestamps -- the strip's frames, the emoji's commands -- so the track is too.
    """
    cmd = [require_on_path("ffmpeg"), "-hide_banner", "-loglevel", "info",
           *render.camera_input(cam, render.Frame(duration=1 / fps)),
           "-vf", f"{render._retime(cam, fps)},showinfo", "-frames:v", "1", "-f", "null", "-"]  # fmt: skip
    probe = subprocess.run(cmd, capture_output=True, text=True, errors="replace", check=False)
    found = re.search(r"\bn:\s*0\s+pts:\s*(-?\d+)", probe.stderr)
    if probe.returncode != 0 or not found:
        raise StageError(f"ffmpeg could not read {cam.path.name}: {probe.stderr.strip()[-1000:]}")
    return int(found.group(1))


def _frames(cam: render.Camera, fps: int, count: int, every: int, size: tuple[int, int]):
    """Every ``every``-th output frame of the main phone, upright and uncropped:
    ``(output frame, RGB array)``."""
    w, h = size
    first = first_frame(cam, fps)
    wanted = (count - first + every - 1) // every
    chain = f"{render._retime(cam, fps)},select='not(mod(n\\,{every}))'"
    cmd = [require_on_path("ffmpeg"), "-hide_banner", "-loglevel", "error",
           *render.camera_input(cam, render.Frame(duration=count / fps)),
           "-vf", chain, "-frames:v", str(wanted), "-fps_mode", "passthrough",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]  # fmt: skip
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for k in range(wanted):
            data = proc.stdout.read(w * h * 3)
            if len(data) < w * h * 3:
                break  # the phone stopped recording before the video ends
            # fps leaves no gaps, so the n-th frame out is the first's timestamp plus n
            yield first + k * every, np.frombuffer(data, np.uint8).reshape(h, w, 3)
    finally:
        proc.stdout.close()
        err = proc.stderr.read().decode(errors="replace").strip()
        code = proc.wait()
    # only reached with every frame taken: a reader that stops early is not ffmpeg failing
    if code != 0 and err:
        raise StageError(f"ffmpeg could not read {cam.path.name}: {err[-1000:]}")


class Detector:
    """The pose landmarker for where the face is, YuNet for how big."""

    def __init__(self):
        os.environ.setdefault("GLOG_minloglevel", "2")  # MediaPipe's start-up chatter
        import cv2
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision

        self._mp = mp
        self.pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(_model(*POSE_MODEL))),
            running_mode=vision.RunningMode.IMAGE, num_poses=1,
            min_pose_detection_confidence=0.3, min_pose_presence_confidence=0.3,
        ))  # fmt: skip
        self.face = cv2.FaceDetectorYN.create(str(_model(*FACE_MODEL)), "", (320, 320), 0.6, 0.3, 20)

    def look(self, rgb: np.ndarray) -> tuple[float, float, float]:
        """The face's centre and size in this frame; NaN for what was not found."""
        h, w = rgb.shape[:2]
        found = self.pose.detect(self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb))
        if not found.pose_landmarks:
            return np.nan, np.nan, np.nan
        marks = found.pose_landmarks[0]
        pts = np.array([[marks[i].x * w, marks[i].y * h] for i in HEAD_POINTS])
        cx, cy = pts.mean(axis=0)
        # YuNet on a box around it: a face it finds elsewhere is not this one
        half = int(np.clip(3 * np.ptp(pts, axis=0).max(), 100, 300))
        x0, y0 = max(int(cx) - half, 0), max(int(cy) - half, 0)
        roi = np.ascontiguousarray(rgb[y0 : int(cy) + half, x0 : int(cx) + half, ::-1])
        if roi.shape[0] < 32 or roi.shape[1] < 32:
            return cx, cy, np.nan
        self.face.setInputSize((roi.shape[1], roi.shape[0]))
        _, faces = self.face.detect(roi)
        sizes = [max(f[2], f[3]) for f in (faces if faces is not None else [])
                 if f[0] <= cx - x0 <= f[0] + f[2] and f[1] <= cy - y0 <= f[1] + f[3]]  # fmt: skip
        return cx, cy, (max(sizes) if sizes else np.nan)


def detect(cam: render.Camera, fps: int, count: int, every: int, size: tuple[int, int]) -> list[list]:
    """``[frame, x, y, face size]`` per detection, upright pixels, ``None`` for not found."""
    detector = Detector()
    rows = []
    for k, rgb in _frames(cam, fps, count, every, size):
        if len(rows) % (fps * 10 // every) == 0:
            note(f"  face: {k / fps:5.0f} s of {count / fps:.0f}")
        rows.append([k, *(None if np.isnan(v) else round(float(v), 1) for v in detector.look(rgb))])
    return rows


# --- the track, cached -------------------------------------------------------


@dataclass(frozen=True)
class Track:
    """The face on every output frame of the video, in the main phone's upright pixels."""

    x: np.ndarray
    y: np.ndarray
    size: float  # brow to chin, one for the whole video
    width: int  # the upright frame's
    height: int


def _key(cam: render.Camera, fps: int, count: int) -> dict:
    stat = cam.path.stat()
    return {
        "file": cam.path.name, "bytes": stat.st_size, "mtime": int(stat.st_mtime),
        "seek_s": round(cam.seek_s, 6), "rate": round(cam.rate, 9), "pad_s": round(cam.pad_s, 6),
        "fps": fps, "frames": count, "every": DETECT_EVERY, "detector": DETECTOR,
    }  # fmt: skip


def track(session: cover.Session, cam: render.Camera, fps: int, count: int) -> Track:
    """The face over ``count`` output frames, ``cam`` placed so its output 0 is the video's.

    Detected once and cached in ``work/face-track.json``; cleaned on every load.
    """
    key = _key(cam, fps, count)
    cache = session.work / TRACK_FILE
    saved = json.loads(cache.read_text(encoding="utf-8")) if cache.exists() else {}
    if saved.get("key") != key:
        note(f"following the face in {cam.path.name} (once; cached in {cache.name})")
        width, height = upright_size(cam.path)
        rows = detect(cam, fps, count, DETECT_EVERY, (width, height))
        saved = {"key": key, "width": width, "height": height, "detections": rows}
        cache.write_text(json.dumps(saved, separators=(",", ":")), encoding="utf-8")
    rows = np.array([[np.nan if v is None else v for v in r] for r in saved["detections"]], float)
    if not len(rows) or not np.isfinite(rows[:, 1]).any():
        raise StageError(f"no face found in {cam.path.name} over the video; leave face_emoji out")
    sizes = rows[:, 3][np.isfinite(rows[:, 3])]
    if not len(sizes):
        raise StageError(f"the face in {cam.path.name} was never seen whole, so its size is unknown")
    size = float(np.median(sizes))
    x, y = clean(rows[:, 0], rows[:, 1], rows[:, 2], size, count)
    return Track(x, y, size, int(saved["width"]), int(saved["height"]))


# --- into the output ---------------------------------------------------------


def main_box(width: int, height: int, crop: tuple[int, int, int, int] | None, layout: render.Layout):
    """``main_crop``, or what :func:`cover_render._main_crop` cuts without one, as ``x, y, w, h``."""
    if crop:
        return crop
    w = min(width, height * layout.width / layout.main_h)
    h = min(height, width * layout.main_h / layout.width)
    return (width - w) / 2, (height - h) * render.MAIN_HEADROOM, w, h


def to_output(x, y, box, layout: render.Layout):
    """Upright pixels to output pixels -- the crop, then :func:`cover_render._fill`
    (scale to cover the main area, centre-cut) -- and the scale."""
    bx, by, bw, bh = box
    s = max(layout.width / bw, layout.main_h / bh)
    return (np.asarray(x) - bx) * s - (bw * s - layout.width) / 2, (np.asarray(y) - by) * s - (bh * s - layout.main_h) / 2, s


def commands(xs, ys, fps: int) -> str:
    """A ``sendcmd`` file putting the overlay's top-left at ``xs[n], ys[n]``
    on the frame stamped ``n / fps``.

    Each command is due half a frame before its frame, so rounding cannot
    land it on the neighbour; a frame where nothing moves gets none.
    """
    target, lines, last = render.FACE_OVERLAY, [], None
    for n, at in enumerate(zip(xs, ys)):
        if at == last:
            continue
        due = max(n - 0.5, 0.0) / fps
        lines.append(f"{due:.6f} {target} x {at[0]}, {target} y {at[1]};")
        last = at
    return "\n".join(lines) + "\n"


def emoji_for(
    session: cover.Session, video: tuple[float, float], start: float, count: int, fps: int, cmd_file: Path
) -> render.Emoji:
    """The emoji over the face for ``count`` output frames from timeline ``start``.

    ``video`` is the whole video's ``(t0, duration)``: the track always covers
    all of it, so a ``--preview`` still shares the video's cache.
    """
    lay = session.settings().get("layout", {})
    choice = lay.get("face_emoji")
    emoji = DEFAULT_EMOJI if choice is True else str(choice)
    image = emoji_png(emoji)
    t0, duration = video
    whole = int(round(duration * fps)) + 1
    face = track(session, render.cameras(session, t0)["main"], fps, whole)
    box = main_box(face.width, face.height, render._box(lay.get("main_crop")), render.LAYOUT)
    # this render's frames on the whole video's: the same frames for the video, one for a still;
    # one more, for the picture starts a frame in (first_frame)
    at = (start - t0) * fps + np.arange(count + 1)
    x, y, s = to_output(np.interp(at, np.arange(whole), face.x), np.interp(at, np.arange(whole), face.y),
                        box, render.LAYOUT)  # fmt: skip
    side = max(int(round(float(lay.get("face_scale", FACE_SCALE)) * face.size * s)), 2)
    left = np.round(x + float(lay.get("face_dx", 0)) - side / 2).astype(int)
    top = np.round(y + float(lay.get("face_dy", 0)) - side / 2).astype(int)
    cmd_file.write_text(commands(left.tolist(), top.tolist(), fps), encoding="utf-8")
    return render.Emoji(image=image, side=side, commands=cmd_file, at=(int(left[0]), int(top[0])))
