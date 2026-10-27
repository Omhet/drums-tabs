"""Capture for a cover: the raw MIDI log, the phones' files, and OBS behind ``--obs``.

A take is filmed by two iPhones, each recording on its own for the whole
session: ``main`` (the side-front shot of the player) and ``foot`` (the right
foot on the kick pedal). ``cover-take`` only runs the raw MIDI log while you
play; ``cover-import --as main|foot`` copies each phone's video in afterwards.

**The phones.** A phone is a portable device, not a drive, so Python cannot
open its files. :data:`PHONE_PS` walks it through the Windows Shell
(``Shell.Application``) from PowerShell instead. Two iPhones plugged in at once
both show up as "Apple iPhone", with nothing in the Shell's view of them to
say which is which, so an import refuses to guess: one phone at a time. Every
imported file is checked (:func:`check_video`): upright size, rotation flag,
frame rate and how even it is, duration.

**OBS** (``cover-take --obs``: a webcam as the main camera, recorded by OBS
into ``raw/main.mp4``). Everything OBS needs is generated, under the names
``DrumCover`` (profile) and ``DrumCover`` (scene collection) in
``%APPDATA%/obs-studio/basic``. The user's own ``Untitled`` profile and
collection are never read or written. OBS rewrites its config files when it
exits, so they are only written while OBS is closed (:func:`obs_running`). The
profile is ours and rewritten each take; the scene collection is written once
(or by ``--setup-webcam``) and then left alone, because the webcam's framing is
set by hand in the OBS preview and OBS saves it there.

**Remote control.** OBS's built-in obs-websocket server is switched on in
``plugin_config/obs-websocket/config.json``. Its password stays in that file --
OBS's own config, outside the repo -- and is read from there at connect time, so
there is no second copy to drift.

**Times.** The MIDI log stamps every message with ``time.perf_counter()`` and
the wall clock as it arrives; ``capture.json`` stamps when the take started
(the MIDI log opened, or OBS confirmed it was recording), on both clocks.
Neither is used for sync (``cover-sync`` lines the cameras up by audio); they
are there to find attempts and to check the set was saved after the last one.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pipeline.proc import StageError

OBS_EXE = Path(r"C:\Program Files\obs-studio\bin\64bit\obs64.exe")
NAME = "DrumCover"  # both the profile and the scene collection
SCENE = "Drum Cover"
WS_PORT = 4455
# The main canvas's fixed uuid, as OBS 31+ writes it on every scene.
MAIN_CANVAS = "6c69626f-6273-4c00-9d88-c5136d61696e"
# OBS 32's version number as it stamps sources (`prev_ver`): 32.2.2.
OBS_VERSION = (32 << 24) | (2 << 16) | 2

PLACEHOLDER_MIC = "In 1-2 (MOTU M Series)"
VIRTUAL_CAMERA = "OBS Virtual Camera"
FPS = 30
WIDTH, HEIGHT = 1920, 1080
RECORD_QUALITY = 18  # x264 CRF / NVENC CQP

FILENAME_FORMAT = "obs %CCYY-%MM-%DD %hh-%mm-%ss"
MAIN_FILE = "main.mp4"  # where an OBS recording lands: OBS films the main camera
MIDI_LOG = "midi-log.jsonl"
CAPTURE_JSON = "capture.json"
VIDEO_EXTS = {".mov", ".mp4", ".m4v"}


def obs_config_dir() -> Path:
    return Path(os.environ["APPDATA"]) / "obs-studio"


# --- devices -----------------------------------------------------------------


@dataclass(frozen=True)
class Device:
    """A DirectShow device as ``ffmpeg -list_devices`` names it."""

    name: str
    kind: str  # "video", "audio" or "none" (OBS's virtual camera reports none)
    alt: str = ""  # ffmpeg's "Alternative name": @device_pnp_<path> for a camera

    @property
    def path(self) -> str:
        """The device path OBS keys a dshow source on (the alt name, unprefixed)."""
        return re.sub(r"^@device_[a-z]+_", "", self.alt)


_DEVICE_LINE = re.compile(r'\]\s+"(?P<name>[^"]+)"\s+\((?P<kind>[^)]+)\)\s*$')
_ALT_LINE = re.compile(r'\]\s+Alternative name\s+"(?P<alt>[^"]+)"\s*$')


def parse_dshow_devices(text: str) -> list[Device]:
    """Read ``ffmpeg -list_devices true -f dshow -i dummy``'s stderr.

    ffmpeg 5+ prints each device as ``"Name" (video)`` / ``(audio)`` / ``(none)``
    with its alternative name on the next line; one device can be both
    ("video, audio"), which counts as each.
    """
    devices: list[Device] = []
    pending: list[tuple[str, str]] = []
    for line in text.splitlines():
        if m := _DEVICE_LINE.search(line):
            pending = [(m["name"], k.strip()) for k in m["kind"].split(",")]
            devices.extend(Device(n, k) for n, k in pending)
        elif (m := _ALT_LINE.search(line)) and pending:
            count = len(pending)
            devices[-count:] = [Device(d.name, d.kind, m["alt"]) for d in devices[-count:]]
            pending = []
    return devices


def list_dshow_devices() -> list[Device]:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise StageError("ffmpeg is not on PATH")
    run = subprocess.run(
        [ffmpeg, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return parse_dshow_devices(run.stderr)


def find_webcam(devices: list[Device]) -> Device | None:
    cams = [d for d in devices if d.kind == "video" and d.name != VIRTUAL_CAMERA]
    return cams[0] if cams else None


def _words(name: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", name.lower()) if len(w) > 2}


def find_webcam_mic(cam: Device, devices: list[Device]) -> Device | None:
    """The audio device that shares the camera's name, e.g. "Microphone (C920 HD Pro)"."""
    cam_words = _words(cam.name) - {"camera", "webcam", "video", "usb", "hd"}
    best, best_score = None, 0
    for d in devices:
        if d.kind != "audio" or "MOTU" in d.name:
            continue
        score = len(cam_words & _words(d.name))
        if score > best_score:
            best, best_score = d, score
    return best


def wasapi_capture_ids() -> dict[str, str]:
    """Active capture endpoints, ``"In 1-2 (MOTU M Series)" -> endpoint id``.

    OBS's audio input source keys on the WASAPI endpoint id, which dshow does
    not show; the names in the MMDevices registry are the ones dshow prints.
    """
    import winreg

    base = r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture"
    found: dict[str, str] = {}
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base) as root:
        i = 0
        while True:
            try:
                guid = winreg.EnumKey(root, i)
            except OSError:
                break
            i += 1
            try:
                with winreg.OpenKey(root, guid) as key:
                    if winreg.QueryValueEx(key, "DeviceState")[0] != 1:  # active
                        continue
                with winreg.OpenKey(root, guid + r"\Properties") as props:
                    name = winreg.QueryValueEx(props, "{a45c254e-df1c-4efd-8020-67d146a850e0},2")[0]
                    iface = winreg.QueryValueEx(props, "{b3f8fa53-0004-438e-9003-51a46e139bfc},6")[0]
            except OSError:
                continue
            found[f"{name} ({iface})"] = "{0.0.1.00000000}." + guid.lower()
    return found


@dataclass(frozen=True)
class Mic:
    name: str  # dshow / Windows name
    endpoint: str  # WASAPI endpoint id


def resolve_mic(name: str) -> Mic:
    ids = wasapi_capture_ids()
    if name not in ids:
        raise StageError(f"no active audio input named {name!r} (have: {', '.join(sorted(ids))})")
    return Mic(name, ids[name])


# --- OBS config ----------------------------------------------------------------


def has_nvenc() -> bool:
    return shutil.which("nvidia-smi") is not None


def video_encoder(nvenc: bool) -> str:
    return "obs_nvenc_h264_tex" if nvenc else "obs_x264"


def record_encoder_settings(nvenc: bool) -> dict:
    """``recordEncoder.json``: constant quality, a keyframe a second (cheap seeking for sync)."""
    if nvenc:
        return {
            "rate_control": "CQP",
            "cqp": RECORD_QUALITY,
            "preset2": "p5",
            "tune": "hq",
            "multipass": "qres",
            "profile": "high",
            "keyint_sec": 1,
            "bf": 2,
        }
    return {"rate_control": "CRF", "crf": RECORD_QUALITY, "preset": "veryfast", "profile": "high", "keyint_sec": 1}


def _ini_path(p: Path) -> str:
    return str(p).replace("\\", "/")


def profile_ini(record_dir: Path, nvenc: bool) -> str:
    """The DrumCover profile's ``basic.ini``: advanced output, MKV remuxed to MP4.

    Recording uses its own encoder (``RecEncoder``) so the CRF/CQP above applies;
    track 1 only, 48 kHz stereo, 1080p30 constant.
    """
    sections: dict[str, dict[str, object]] = {
        "General": {"Name": NAME},
        "Output": {"Mode": "Advanced", "FilenameFormatting": FILENAME_FORMAT, "DelayEnable": "false"},
        "AdvOut": {
            "RecType": "Standard",
            "RecFilePath": _ini_path(record_dir),
            "RecFormat2": "mkv",
            "RecEncoder": video_encoder(nvenc),
            "RecUseRescale": "false",
            "RecTracks": 1,
            "RecAudioEncoder": "ffmpeg_aac",
            "Track1Bitrate": 320,
            "RecSplitFile": "false",
            "RecRB": "false",
            "Encoder": video_encoder(nvenc),
            "AudioEncoder": "ffmpeg_aac",
            "TrackIndex": 1,
        },
        "Video": {
            "BaseCX": WIDTH,
            "BaseCY": HEIGHT,
            "OutputCX": WIDTH,
            "OutputCY": HEIGHT,
            "FPSType": 1,  # integer fps
            "FPSCommon": FPS,
            "FPSInt": FPS,
            "FPSNum": FPS,
            "FPSDen": 1,
            "ScaleType": "lanczos",
            "ColorFormat": "NV12",
            "ColorSpace": "709",
            "ColorRange": "Partial",
            "AutoRemux": "true",
        },
        "Audio": {
            "MonitoringDeviceId": "default",
            "MonitoringDeviceName": "Default",
            "SampleRate": 48000,
            "ChannelSetup": "Stereo",
        },
    }
    lines: list[str] = []
    for section, values in sections.items():
        lines.append(f"[{section}]")
        lines += [f"{k}={v}" for k, v in values.items()]
        lines.append("")
    return "\r\n".join(lines)


def _source(name: str, kind: str, settings: dict, mixers: int, hotkeys: dict | None = None) -> dict:
    return {
        "prev_ver": OBS_VERSION,
        "name": name,
        "uuid": str(uuid.uuid4()),
        "id": kind,
        "versioned_id": kind,
        "settings": settings,
        "mixers": mixers,
        "sync": 0,
        "flags": 0,
        "volume": 1.0,
        "balance": 0.5,
        "enabled": True,
        "muted": False,
        "push-to-mute": False,
        "push-to-mute-delay": 0,
        "push-to-talk": False,
        "push-to-talk-delay": 0,
        "hotkeys": hotkeys or {},
        "deinterlace_mode": 0,
        "deinterlace_field_order": 0,
        "monitoring_type": 0,
        "private_settings": {},
    }


def _scene_item(source: dict, item_id: int) -> dict:
    return {
        "name": source["name"],
        "source_uuid": source["uuid"],
        "visible": True,
        "locked": False,
        "rot": 0.0,
        "scale_ref": {"x": float(WIDTH), "y": float(HEIGHT)},
        "align": 5,
        "bounds_type": 2,  # scale to fit inside the canvas, whatever the camera gives
        "bounds_align": 0,
        "bounds_crop": False,
        "crop_left": 0,
        "crop_top": 0,
        "crop_right": 0,
        "crop_bottom": 0,
        "id": item_id,
        "group_item_backup": False,
        "pos": {"x": 0.0, "y": 0.0},
        "scale": {"x": 1.0, "y": 1.0},
        "bounds": {"x": float(WIDTH), "y": float(HEIGHT)},
        "scale_filter": "disable",
        "blend_method": "default",
        "blend_type": "normal",
        "show_transition": {"duration": 300},
        "hide_transition": {"duration": 300},
        "private_settings": {},
    }


def scene_collection(webcam: Device | None, mic: Mic) -> dict:
    """The DrumCover scene collection: one scene, the webcam in it, one mic.

    No desktop audio: what the headphones hear (the click, the stems) must stay
    out of the camera's sound. The mic is the only thing on track 1. Without a
    webcam the scene is empty and records black, which is enough to test the
    flow with the mic alone.
    """
    sources: list[dict] = []
    items: list[dict] = []
    hotkeys: dict = {"OBSBasic.SelectScene": []}
    if webcam is not None:
        cam = _source(
            "Webcam",
            "dshow_input",
            {
                "video_device_id": f"{webcam.name}:{webcam.path}",
                "last_video_device_id": f"{webcam.name}:{webcam.path}",
                "res_type": 1,  # custom
                "resolution": f"{WIDTH}x{HEIGHT}",
                "last_resolution": f"{WIDTH}x{HEIGHT}",
                "frame_interval": 10_000_000 // FPS,
                "video_format": 0,  # any: the camera picks MJPEG at 1080p30 itself
                "audio_output_mode": 0,
                "deactivate_when_not_showing": False,
                "buffering": 2,  # off: lowest, steadiest latency
            },
            mixers=0,
        )
        sources.append(cam)
        items.append(_scene_item(cam, 1))
        hotkeys |= {"libobs.show_scene_item.1": [], "libobs.hide_scene_item.1": []}
    mic_source = _source(
        "Mic",
        "wasapi_input_capture",
        {"device_id": mic.endpoint, "use_device_timing": False},
        mixers=1,
        hotkeys={"libobs.mute": [], "libobs.unmute": [], "libobs.push-to-mute": [], "libobs.push-to-talk": []},
    )
    sources.append(mic_source)
    items.append(_scene_item(mic_source, 2))
    scene = _source(SCENE, "scene", {"id_counter": len(items) + 1, "custom_size": False, "items": items}, 0, hotkeys)
    scene["canvas_uuid"] = MAIN_CANVAS
    sources.append(scene)
    return {
        "name": NAME,
        "sources": sources,
        "groups": [],
        "scene_order": [{"name": SCENE}],
        "current_scene": SCENE,
        "current_program_scene": SCENE,
        "canvases": [],
        "current_transition": "Cut",
        "transition_duration": 300,
        "transitions": [],
        "quick_transitions": [],
        "saved_projectors": [],
        "preview_locked": False,
        "scaling_enabled": False,
        "scaling_level": 0,
        "scaling_off_x": 0.0,
        "scaling_off_y": 0.0,
        "modules": {},
        "resolution": {"x": WIDTH, "y": HEIGHT},
        "version": 2,
    }


def websocket_config(existing: dict | None) -> dict:
    """obs-websocket switched on, with auth; an existing password is kept."""
    cfg = dict(existing or {})
    cfg["server_enabled"] = True
    cfg["auth_required"] = True
    cfg["server_port"] = WS_PORT
    cfg.setdefault("alerts_enabled", False)
    cfg["first_load"] = False
    if not cfg.get("server_password"):
        cfg["server_password"] = secrets.token_urlsafe(12)
    return cfg


@dataclass(frozen=True)
class ObsFiles:
    root: Path

    @property
    def profile_dir(self) -> Path:
        return self.root / "basic" / "profiles" / NAME

    @property
    def basic_ini(self) -> Path:
        return self.profile_dir / "basic.ini"

    @property
    def record_encoder(self) -> Path:
        return self.profile_dir / "recordEncoder.json"

    @property
    def collection(self) -> Path:
        return self.root / "basic" / "scenes" / f"{NAME}.json"

    @property
    def websocket(self) -> Path:
        return self.root / "plugin_config" / "obs-websocket" / "config.json"

    @property
    def user_ini(self) -> Path:
        return self.root / "user.ini"


def _read_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_profile(files: ObsFiles, record_dir: Path, nvenc: bool) -> None:
    files.profile_dir.mkdir(parents=True, exist_ok=True)
    files.basic_ini.write_text(profile_ini(record_dir, nvenc), encoding="utf-8-sig", newline="")
    files.record_encoder.write_text(json.dumps(record_encoder_settings(nvenc), indent=4), encoding="utf-8")


def write_collection(files: ObsFiles, webcam: Device | None, mic: Mic) -> None:
    files.collection.parent.mkdir(parents=True, exist_ok=True)
    files.collection.write_text(json.dumps(scene_collection(webcam, mic), indent=4), encoding="utf-8")


def enable_websocket(files: ObsFiles) -> str:
    """Switch the server on; returns the password (kept in OBS's own config)."""
    cfg = websocket_config(_read_json(files.websocket))
    files.websocket.parent.mkdir(parents=True, exist_ok=True)
    files.websocket.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return cfg["server_password"]


def websocket_password(files: ObsFiles) -> str:
    cfg = _read_json(files.websocket)
    if not cfg or not cfg.get("server_enabled"):
        raise StageError(f"obs-websocket is not enabled in {files.websocket}")
    return cfg.get("server_password", "") if cfg.get("auth_required") else ""


# OBS writes the last-used profile and collection to user.ini when it exits, so
# launching it with --profile DrumCover would make DrumCover the default the
# next time the user opens OBS. These keys are put back afterwards.
USER_INI_KEYS = ("Profile", "ProfileDir", "SceneCollection", "SceneCollectionFile")


def read_user_choice(user_ini: Path) -> dict[str, str]:
    if not user_ini.exists():
        return {}
    text = user_ini.read_text(encoding="utf-8-sig")
    m = re.search(r"^\[Basic\]\s*$(.*?)(?=^\[|\Z)", text, re.M | re.S)
    if not m:
        return {}
    pairs = dict(re.findall(r"^([^=\r\n]+)=(.*?)\r?$", m.group(1), re.M))
    return {k: pairs[k] for k in USER_INI_KEYS if k in pairs}


def restore_user_choice(user_ini: Path, choice: dict[str, str]) -> bool:
    """Put the [Basic] keys back as they were; True when something changed."""
    if not choice or not user_ini.exists():
        return False
    raw = user_ini.read_bytes()
    bom = raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8-sig")
    m = re.search(r"^\[Basic\]\s*$(.*?)(?=^\[|\Z)", text, re.M | re.S)
    if not m:
        return False
    body = m.group(1)
    new_body = body
    for key, value in choice.items():
        new_body = re.sub(rf"^{re.escape(key)}=.*?(\r?)$", lambda mm, v=value, k=key: f"{k}={v}{mm.group(1)}", new_body, flags=re.M)
    if new_body == body:
        return False
    text = text[: m.start(1)] + new_body + text[m.end(1) :]
    user_ini.write_bytes((b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8"))
    return True


# --- OBS process and remote control -------------------------------------------


def obs_pids() -> list[int]:
    run = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq obs64.exe", "/FO", "CSV", "/NH"],
        capture_output=True,
        text=True,
    )
    return [int(row.split('","')[1]) for row in run.stdout.splitlines() if row.startswith('"obs64.exe"')]


def obs_running() -> bool:
    return bool(obs_pids())


def launch_obs(minimized: bool = False) -> subprocess.Popen:
    if not OBS_EXE.exists():
        raise StageError(f"OBS not found at {OBS_EXE}")
    args = [str(OBS_EXE), "--profile", NAME, "--collection", NAME, "--disable-shutdown-check", "--disable-updater"]
    if minimized:
        args.append("--minimize-to-tray")
    # OBS finds its locale and data relative to the working directory.
    return subprocess.Popen(args, cwd=OBS_EXE.parent)


def _obs_main_windows(pids: list[int]) -> list[int]:
    """OBS's main window handles, hidden ones included (in the tray it is hidden).

    ``taskkill`` without ``/F`` only reaches visible windows, so it misses OBS in
    the tray; posting WM_CLOSE to the main window is the same as clicking its X.
    """
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    found: list[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in pids:
            title = ctypes.create_unicode_buffer(256)
            cls = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, title, 256)
            user32.GetClassNameW(hwnd, cls, 256)
            if title.value.startswith("OBS ") and cls.value.endswith("QWindowIcon"):
                found.append(hwnd)
        return True

    user32.EnumWindows(visit, 0)
    return found


def close_obs(timeout: float = 30.0) -> bool:
    """Ask OBS to quit as if its window were closed; True once it is gone."""
    import ctypes

    WM_CLOSE = 0x0010
    for hwnd in _obs_main_windows(obs_pids()):
        ctypes.windll.user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not obs_running():
            return True
        time.sleep(0.5)
    return False


def connect(password: str, timeout: float = 45.0):
    """An obs-websocket request client, retrying while OBS starts up."""
    import obsws_python as obs

    logging.getLogger("obsws_python").disabled = True  # it logs every refused retry
    deadline = time.monotonic() + timeout
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            return obs.ReqClient(host="localhost", port=WS_PORT, password=password, timeout=5)
        except Exception as exc:  # noqa: BLE001 - refused, reset, timeout: all mean "not up yet"
            last = exc
            time.sleep(1.0)
    raise StageError(f"could not reach OBS's remote control on port {WS_PORT}: {last}")


NOT_READY = 207  # obs-websocket's "OBS is not ready", while it is still loading


def wait_until_ready(client, timeout: float = 60.0) -> None:
    """The server answers before OBS has loaded its scenes; wait out "not ready"."""
    from obsws_python.error import OBSSDKRequestError

    deadline = time.monotonic() + timeout
    while True:
        try:
            client.get_record_status()
            return
        except OBSSDKRequestError as exc:
            if exc.code != NOT_READY or time.monotonic() > deadline:
                raise StageError(f"OBS refused a request: {exc}") from exc
            time.sleep(0.5)


def start_recording(client, record_dir: Path, timeout: float = 10.0) -> None:
    wait_until_ready(client)
    client.set_record_directory(str(record_dir))
    client.start_record()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if client.get_record_status().output_active:
            return
        time.sleep(0.25)
    raise StageError("OBS was told to record but does not report recording")


def stop_recording(client) -> Path:
    resp = client.stop_record()
    return Path(resp.output_path)


def probe(path: Path) -> dict:
    run = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate",
         "-of", "json", str(path)],
        capture_output=True,
        text=True,
    )
    if run.returncode != 0:
        raise StageError(f"ffprobe cannot read {path}: {run.stderr.strip()}")
    return json.loads(run.stdout)


def wait_for_remux(mkv: Path, timeout: float = 600.0) -> Path:
    """OBS remuxes ``x.mkv`` to ``x.mp4`` after it stops; wait until it is whole."""
    mp4 = mkv.with_suffix(".mp4")
    deadline = time.monotonic() + timeout
    last_size = -1
    while time.monotonic() < deadline:
        if mp4.exists():
            size = mp4.stat().st_size
            if size == last_size and size > 0:
                try:
                    probe(mp4)
                    return mp4
                except StageError:
                    pass
            last_size = size
        time.sleep(1.0)
    raise StageError(f"OBS did not remux {mkv.name} to mp4 within {timeout:.0f} s; the mkv is still there")


def keep_as(src: Path, dest: Path) -> Path | None:
    """Move ``src`` to ``dest``; an earlier ``dest`` is renamed aside, not lost."""
    moved_aside = None
    if dest.exists():
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(dest.stat().st_mtime))
        moved_aside = dest.with_name(f"{dest.stem}.{stamp}{dest.suffix}")
        dest.rename(moved_aside)
    src.rename(dest)
    return moved_aside


# --- MIDI log ------------------------------------------------------------------


def pick_midi_port(names: list[str], wanted: str | None = None) -> str | None:
    """The TD-27's input port, or the one whose name contains ``wanted``."""
    needle = (wanted or "TD-27").lower()
    for n in names:
        if needle in n.lower():
            return n
    return None


def midi_log_record(data: list[int], perf: float, wall: float) -> dict:
    """One line of ``midi-log.jsonl``: both clocks, the raw bytes, and mido's reading."""
    import mido

    record: dict = {"perf": round(perf, 6), "wall": round(wall, 6), "bytes": list(data)}
    try:
        msg = mido.Message.from_bytes(list(data))
        fields = msg.dict()
        fields.pop("time", None)
        record.update(fields)
    except (ValueError, TypeError):
        record["type"] = "unparsed"
    return record


class MidiLogger:
    """Writes every incoming message from one port, stamped as it arrives."""

    def __init__(self, port: str, path: Path):
        self.port_name = port
        self.path = path
        self.count = 0
        self.last_wall: float | None = None
        self._lock = threading.Lock()
        self._file = None
        self._port = None

    def _on(self, msg) -> None:
        perf, wall = time.perf_counter(), time.time()
        line = json.dumps(midi_log_record(msg.bytes(), perf, wall))
        with self._lock:
            if self._file is None:
                return
            self._file.write(line + "\n")
            self._file.flush()
            self.count += 1
            self.last_wall = wall

    def start(self) -> None:
        import mido

        self._file = self.path.open("a", encoding="utf-8")
        self._port = mido.open_input(self.port_name, callback=self._on)

    def stop(self) -> None:
        if self._port is not None:
            self._port.close()
        with self._lock:
            if self._file is not None:
                self._file.close()
                self._file = None


def midi_input_names() -> list[str]:
    import mido

    return list(mido.get_input_names())


def capture_record(started_perf: float, started_wall: float, midi_port: str | None, obs: bool) -> dict:
    """``capture.json``: when the take started -- OBS confirmed it was recording
    (``obs``), or else the MIDI log opened -- on both clocks."""
    return {
        "started": {"perf": round(started_perf, 6), "wall": round(started_wall, 6)},
        "obs": obs,
        "midi_port": midi_port,
    }


# --- the phones ----------------------------------------------------------------

ONE_AT_A_TIME = "connect one phone at a time"

# Walks "This PC\<phone>\Internal Storage\DCIM\*" through the Shell namespace.
# -Mode list prints every video as JSON; -Mode copy copies one (by DCIM-relative
# path) into -Dest and waits, because CopyHere returns at once and dies with
# the process that started it. More than one iPhone is refused: they all show
# up as "Apple iPhone", so there is no telling which phone a file came from.
PHONE_PS = r"""
param([string]$Mode = "list", [string]$Rel = "", [string]$Dest = "")
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject Shell.Application
$pc = $shell.Namespace(17)
$phones = @($pc.Items() | Where-Object { $_.Name -like "*iPhone*" -or $_.Name -like "*Apple*" })
if ($phones.Count -eq 0) { Write-Output (ConvertTo-Json -Compress @{ error = "no iPhone under This PC (plugged in, unlocked, Trust this computer?)" }); exit 0 }
if ($phones.Count -gt 1) { Write-Output (ConvertTo-Json -Compress @{ error = "several"; phones = @($phones | ForEach-Object { $_.Name }) }); exit 0 }
$phone = $phones[0]
$storage = $phone.GetFolder.Items() | Select-Object -First 1
if (-not $storage) { Write-Output (ConvertTo-Json -Compress @{ error = "the iPhone shows no storage; unlock it and tap Trust"; phone = $phone.Name }); exit 0 }
$dcim = $storage.GetFolder.Items() | Where-Object { $_.Name -eq "DCIM" } | Select-Object -First 1
if (-not $dcim) { Write-Output (ConvertTo-Json -Compress @{ error = "no DCIM folder on the iPhone"; phone = $phone.Name }); exit 0 }
$found = @()
foreach ($sub in $dcim.GetFolder.Items()) {
  if (-not $sub.IsFolder) { continue }
  foreach ($it in $sub.GetFolder.Items()) {
    $fname = $it.ExtendedProperty("System.FileName")
    if (-not $fname) { $fname = $it.Name }
    $found += [pscustomobject]@{
      folder = $sub.Name; name = $it.Name; filename = [string]$fname
      size = [int64]$it.ExtendedProperty("System.Size")
      modified = $it.ModifyDate.ToString("o"); type = $it.Type
    }
  }
}
if ($Mode -eq "list") {
  Write-Output (ConvertTo-Json -Compress @{ phone = $phone.Name; storage = $storage.Name; items = @($found) })
  exit 0
}
$folderName, $itemName = $Rel.Split("/", 2)
$sub = $dcim.GetFolder.Items() | Where-Object { $_.Name -eq $folderName } | Select-Object -First 1
$item = $sub.GetFolder.Items() | Where-Object { $_.Name -eq $itemName } | Select-Object -First 1
if (-not $item) { Write-Output (ConvertTo-Json -Compress @{ error = "$Rel is gone from the phone" }); exit 0 }
$size = [int64]$item.ExtendedProperty("System.Size")
$fname = $item.ExtendedProperty("System.FileName"); if (-not $fname) { $fname = $item.Name }
$target = Join-Path $Dest $fname
$shell.Namespace($Dest).CopyHere($item, 4 + 16 + 1024)
$deadline = (Get-Date).AddMinutes(60)
while ((Get-Date) -lt $deadline) {
  if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target).Length -eq $size)) {
    Start-Sleep -Seconds 2
    Write-Output (ConvertTo-Json -Compress @{ copied = $target; size = $size }); exit 0
  }
  Start-Sleep -Milliseconds 500
}
Write-Output (ConvertTo-Json -Compress @{ error = "copy did not finish within an hour"; partial = $target })
"""


def _run_phone_ps(*args: str) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "phone.ps1"
        script.write_text(PHONE_PS, encoding="utf-8-sig")
        run = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    out = run.stdout.strip().splitlines()
    if run.returncode != 0 or not out:
        return {"error": (run.stderr.strip() or "PowerShell gave no answer").splitlines()[-1]}
    try:
        return explain(json.loads(out[-1]))
    except json.JSONDecodeError:
        return {"error": f"unexpected PowerShell output: {out[-1][:200]}"}


def explain(answer: dict) -> dict:
    """The script's answer, with "several phones" turned into what to do about it."""
    if answer.get("error") == "several":
        phones = answer.get("phones") or []
        answer["error"] = (
            f"{len(phones)} iPhones are connected ({', '.join(phones)}) and Windows names them alike, "
            f"so there is no telling main from foot: {ONE_AT_A_TIME}"
        )
    return answer


def _item_ext(item: dict) -> str:
    return Path(item.get("filename") or item.get("name") or "").suffix.lower()


def newest_video(items: list[dict]) -> dict | None:
    videos = [i for i in items if _item_ext(i) in VIDEO_EXTS or "video" in str(i.get("type", "")).lower()]
    return max(videos, key=lambda i: i["modified"]) if videos else None


def phone_videos() -> dict:
    """``{"phone", "items": [...]}``, or ``{"error": ...}`` unless exactly one phone is connected."""
    return _run_phone_ps("-Mode", "list")


def copy_from_phone(item: dict, dest_dir: Path) -> Path:
    result = _run_phone_ps("-Mode", "copy", "-Rel", f"{item['folder']}/{item['name']}", "-Dest", str(dest_dir))
    if "error" in result:
        raise StageError(result["error"])
    return Path(result["copied"])


def role_target(raw: Path, role: str, ext: str) -> Path:
    return raw / f"{role}{ext.lower() or '.mov'}"


# --- checking an imported file -------------------------------------------------

WANT_FPS = 60.0
FPS_SLACK = 1.0  # 59..61 counts as 60: a phone's 60 is 59.94 or 60.00
IRREGULAR_SHARE = 0.01  # more frame gaps than this off the beat is "variable frame rate"
LONG_GAP_FRAMES = 4  # a hole longer than this many frames is a drop worth knowing about


@dataclass(frozen=True)
class VideoCheck:
    """What a camera file holds, as the cover render will see it."""

    codec: str
    width: int  # upright, after the rotation flag
    height: int
    rotation: int  # the rotation flag, degrees (0 when there is none)
    nominal_fps: float  # what the container claims
    fps: float  # from the median gap between frames
    irregular: float  # share of frame gaps more than a quarter off the median
    longest_gap_ms: float
    duration_s: float

    @property
    def vertical(self) -> bool:
        return self.height > self.width

    def summary(self) -> str:
        flag = f", stored rotated {self.rotation} deg" if self.rotation else ""
        return (f"{self.width}x{self.height} upright{flag}, {self.codec}, {self.fps:.2f} fps "
                f"({self.irregular:.1%} of frame gaps off the beat, longest {self.longest_gap_ms:.0f} ms), "
                f"{self.duration_s / 60:.1f} min")  # fmt: skip

    def warnings(self) -> list[str]:
        out = []
        if not self.vertical:
            out.append(f"not vertical ({self.width}x{self.height} upright): the 9:16 video wants the phone upright")
        if abs(self.fps - WANT_FPS) > FPS_SLACK:
            out.append(f"{self.fps:.2f} fps, not 60: Settings > Camera > Record Video > 1080p at 60 fps")
        if self.irregular > IRREGULAR_SHARE or self.longest_gap_ms > LONG_GAP_FRAMES * 1000 / max(self.fps, 1.0):
            out.append(f"the frame rate varies ({self.irregular:.1%} of frame gaps off the beat, one of "
                       f"{self.longest_gap_ms:.0f} ms): is Auto FPS off?")  # fmt: skip
        return out


def _ratio(text: str) -> float:
    num, _, den = str(text).partition("/")
    d = float(den or 1)
    return float(num) / d if d else 0.0


def video_check(stream: dict, duration_s: float, pts: list[float]) -> VideoCheck:
    """From ffprobe's video stream entry, the file's duration and every frame's time."""
    rotation = 0
    for side in stream.get("side_data_list") or []:
        if "rotation" in side:
            rotation = int(round(float(side["rotation"])))
    w, h = int(stream["width"]), int(stream["height"])
    if abs(rotation) % 180 == 90:
        w, h = h, w
    gaps = np.diff(np.sort(np.asarray(pts, dtype=np.float64)))
    gaps = gaps[gaps > 0]
    if gaps.size:
        median = float(np.median(gaps))
        fps, longest = 1.0 / median, float(gaps.max()) * 1000
        irregular = float(np.mean(np.abs(gaps - median) > 0.25 * median))
    else:
        fps, irregular, longest = 0.0, 0.0, 0.0
    return VideoCheck(
        codec=str(stream.get("codec_name", "?")),
        width=w,
        height=h,
        rotation=rotation,
        nominal_fps=_ratio(stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "0/1"),
        fps=fps,
        irregular=irregular,
        longest_gap_ms=longest,
        duration_s=duration_s,
    )


def _ffprobe_video(path: Path, *args: str) -> str:
    run = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", *args, str(path)],
                         capture_output=True, text=True)  # fmt: skip
    if run.returncode != 0:
        raise StageError(f"ffprobe cannot read {path}: {run.stderr.strip()}")
    return run.stdout


def check_video(path: Path) -> VideoCheck:
    """ffprobe ``path``: its first video stream, and the time of every frame in it."""
    info = json.loads(_ffprobe_video(
        path, "-show_entries",
        "stream=codec_name,width,height,r_frame_rate,avg_frame_rate:stream_side_data=rotation:format=duration",
        "-of", "json"))  # fmt: skip
    if not info.get("streams"):
        raise StageError(f"{path} has no video in it")
    lines = _ffprobe_video(path, "-show_entries", "packet=pts_time", "-of", "csv=p=0").split()
    pts = [float(t.strip(",")) for t in lines if t.strip(",") not in ("", "N/A")]
    return video_check(info["streams"][0], float(info.get("format", {}).get("duration", 0.0)), pts)
