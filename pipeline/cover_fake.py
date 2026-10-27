"""A synthetic cover session where every answer is known: the dress rehearsal.

``drums cover-fake-session`` makes a session folder the real commands cannot
tell from one recorded in front of the kit, and writes down what they ought to
find in ``work/truth.json``:

* **The performance.** The chart (``tab.mid``) played with each hit up to
  +-10 ms off, varied strength, and a steady :data:`LATENESS_MS` on top for
  the timing report to find. The chart's own instruments are turned into the
  notes the TD-27 sends SD3 (``kit.toml``'s render notes), and the hi-hat foot
  into CC4 (127 down, low up). Four hard closed hats in the count-in are the
  slate. It is played twice, the way a session goes: a false start stopped
  in bar 6, then the whole song. Both start at 1|1|1, since a retake is Stop
  twice and Record.
* **The recordings.** Each pass is rendered through SD3 offline with kit
  ``bake`` -- what ``SD3 rec`` would have recorded -- and written into the
  generated set by :func:`live_set.add_recorded_attempt`, as Live writes a
  pass. Then the faders are moved off where the set left them.
* **The cameras.** Two ffmpeg test patterns with their clock burned in, each
  started some unknown time before the first pass and running through the
  gap between passes. ``raw/webcam.mp4`` is 1920x1080 30 fps H.264;
  ``raw/iphone.mov`` is HEVC stored 1920x1080 with a 90 degree rotation
  flag (upright it is portrait), and its clock runs :data:`IPHONE_PPM` fast.
  Each has a room mic: the kit render muffled, a few ms late (the distance to
  the mic) and noisy. Every kick and snare lights a white square in a known
  place in both pictures, black otherwise -- the visual truth.

Times: ``real`` seconds run from the first pass's Record press; a pass's
arrangement time is ``real - pass start``. A camera's own time is
``(preroll + real) * (1 + ppm * 1e-6)``.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tomllib
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import mido
import numpy as np
import soundfile as sf
from scipy import signal

from pipeline import cover, cover_kit, live_set, paths
from pipeline.proc import StageError, require_on_path

SR = 48000
FPS = 30
SEED = 7

LATENESS_MS = 15.0
JITTER_MS = 10.0
FALSE_START_BAR = 6  # the first pass stops half way through this bar
GAP_S = 9.4  # Stop twice, F9: from the end of one pass to the next Record
TAIL_S = 4.0  # the last crash rings this long before Stop
CAMERA_TAIL_S = 5.0  # the cameras roll on after the last pass

KIT = "bake"

#: Per camera: how long it ran before the first pass, its clock error, how far
#: its mic is from the kit, and where its flash square is in the *upright*
#: picture. Each square is inside what every layout keeps of that camera: the
#: webcam's is visible after both the 16:9 and 9:16 main-area crops, the
#: iPhone's inside the centre square the inset takes. So is each burned-in clock.
CAMERAS = {
    "webcam": {"file": "webcam.mp4", "preroll_s": 7.3, "ppm": 0.0, "mic_ms": 9.0,
               "size": (1920, 1080), "flash": (620, 420, 120, 120), "clock": (600, 200)},
    "iphone": {"file": "iphone.mov", "preroll_s": 12.9, "ppm": 80.0, "mic_ms": 11.0,
               "size": (1080, 1920), "flash": (40, 460, 160, 160), "clock": (40, 1380)},
}  # fmt: skip
IPHONE_PPM = CAMERAS["iphone"]["ppm"]

#: The SD3 notes that count as a "true" kick or snare hit (they flash).
FLASH_NOTES = {"kick": 36, "snare": 38}

#: Fader moves made after recording, so reading them back is tested.
FADERS = {
    "nodrums": {"gain_db": -3.0, "pan": 0.0, "muted": False},
    "drums": {"gain_db": -6.0, "pan": 0.0, "muted": True},
    live_set.REC_TRACK: {"gain_db": -2.0, "pan": 0.1, "muted": False},
    "Main": {"gain_db": -1.0, "pan": 0.0, "muted": False},
}

KIT_TOML = Path(__file__).resolve().parent.parent / "kit.toml"
FONT = "C\\:/Windows/Fonts/consola.ttf"


# --- the performance -----------------------------------------------------------


@dataclass(frozen=True)
class Hit:
    tick: float  # chart tick (negative: the count-in)
    instrument: str


def sd3_notes() -> dict[str, int]:
    """Instrument -> the note SD3 plays it on, from ``kit.toml`` (default articulations)."""
    arts = tomllib.loads(KIT_TOML.read_text(encoding="utf-8"))["render"]["articulation"]
    return {a["instrument"]: int(a["note"]) for a in arts.values() if a.get("default")}


def chart_hits(song: paths.Song) -> list[Hit]:
    """Every written note, as instrument names, at 480 ticks a beat."""
    mapping = {int(k): str(v) for k, v in (song.meta().get("midi_map") or {}).items()}
    midi = mido.MidiFile(str(song.tab_midi))
    scale = cover.TICKS_PER_BEAT / midi.ticks_per_beat
    hits = []
    for track in midi.tracks:
        tick = 0
        for msg in track:
            tick += msg.time
            if msg.type == "note_on" and msg.velocity > 0 and msg.note in mapping:
                hits.append(Hit(tick * scale, mapping[msg.note]))
    return sorted(hits, key=lambda h: h.tick)


def perform(
    hits: list[Hit], clock: cover.Clock, rng: np.random.Generator, stop_tick: float | None
) -> tuple[list[live_set.Note], list[live_set.Control]]:
    """One pass, in arrangement seconds: notes and the hi-hat foot (CC4)."""
    notes_for = sd3_notes()
    slate = [Hit(-k * cover.TICKS_PER_BEAT, "hihat_closed") for k in (4, 3, 2, 1)]
    played = [h for h in slate + hits if stop_tick is None or h.tick < stop_tick]
    late = LATENESS_MS / 1000.0
    notes: list[live_set.Note] = []
    for h in played:
        t = float(clock.seconds_at(h.tick)) + late + rng.uniform(-JITTER_MS, JITTER_MS) / 1000.0
        base = 118 if h.tick < 0 else (105 if h.instrument in ("kick", "snare", "crash") else 88)
        vel = int(np.clip(round(rng.normal(base, 10)), 30, 127))
        notes.append((t, notes_for[h.instrument], vel, 0.1))
    notes.sort()

    # The foot: down (127) for a closed hat, up for an open one, moved over
    # 30 ms just before the hit that needs it, as a pedal travels.
    hat = {notes_for["hihat_closed"]: 127, notes_for["hihat_open"]: 12}
    controllers: list[live_set.Control] = [(0.0, 4, 127)]
    state = 127
    for t, pitch, _, _ in notes:
        want = hat.get(pitch)
        if want is None or want == state:
            continue
        for k, frac in enumerate((0.33, 0.66, 1.0)):
            value = int(round(state + (want - state) * frac + rng.uniform(-3, 3) * (frac < 1)))
            controllers.append((max(0.0, t - 0.04 + 0.01 * k), 4, int(np.clip(value, 0, 127))))
        state = want
    return notes, sorted(controllers)


# --- the cameras ---------------------------------------------------------------


def _room(drums: np.ndarray, mic_ms: float, rng: np.random.Generator) -> np.ndarray:
    """A room mic: muffled, late by the distance, with a noise floor under it."""
    sos = signal.butter(4, 1800, "lowpass", fs=SR, output="sos")
    y = signal.sosfilt(sos, drums).astype(np.float32)
    y = np.concatenate([np.zeros(int(round(mic_ms / 1000 * SR)), np.float32), y])[: drums.size]
    y *= 0.3 / max(float(np.abs(y).max()), 1e-9)
    return y + rng.normal(0, 0.004, y.size).astype(np.float32)


def _on_camera_clock(real_audio: np.ndarray, preroll_s: float, ppm: float, duration_s: float) -> np.ndarray:
    """``real_audio`` (starting at real ``-preroll_s``) resampled onto a camera's clock."""
    n = int(round(duration_s * SR))
    real_idx = np.arange(n, dtype=np.float64) / (1.0 + ppm * 1e-6)
    return np.interp(real_idx, np.arange(real_audio.size), real_audio, right=0.0).astype(np.float32)


def _flash_track(frames: list[int], count: int, size: tuple[int, int], path: Path) -> None:
    """Raw grey frames for the square: white on each listed frame and the one after, black otherwise.

    A file ffmpeg overlays, rather than an ``enable`` expression: hundreds of
    hits make an expression ffmpeg will not parse.
    """
    lit = np.zeros(count, dtype=bool)
    for f in frames:
        lit[max(f, 0) : min(f + 2, count)] = True
    w, h = size
    black, white = bytes(w * h), bytes([255]) * (w * h)
    with open(path, "wb") as out:
        for on in lit:
            out.write(white if on else black)


def _camera_video(name: str, cam: dict, audio: Path, duration_s: float, frames: list[int], out: Path, tmp: Path) -> None:
    ffmpeg = require_on_path("ffmpeg")
    w, h = cam["size"]
    x, y, fw, fh = cam["flash"]
    count = int(np.ceil(duration_s * FPS)) + 1
    flash = tmp / f"{name}-flash.gray"
    _flash_track(frames, count, (fw, fh), flash)
    graph = (
        f"[0:v]drawtext=fontfile='{FONT}':text='{name} %{{pts\\:hms}}':fontsize=64:fontcolor=white"
        f":box=1:boxcolor=black:x={cam['clock'][0]}:y={cam['clock'][1]}[pat];"
        f"[2:v]format=yuv420p[sq];[pat][sq]overlay=x={x}:y={y}:eof_action=pass"
        + (",transpose=1" if name == "iphone" else "")  # stored landscape, shown upright by the rotation flag
        + "[v]"
    )
    script = tmp / f"{name}-filter.txt"
    script.write_text(graph, encoding="utf-8")
    src = [
        "-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate={FPS}:duration={duration_s:.3f}",
        "-i", str(audio),
        "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{fw}x{fh}", "-r", str(FPS), "-i", str(flash),
    ]  # fmt: skip
    if name == "iphone":
        target = tmp / "iphone-stored.mov"
        codec = ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-tag:v", "hvc1"]
    else:
        target = out
        codec = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23"]
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *src, "-/filter_complex", str(script),
           "-map", "[v]", "-map", "1:a", *codec, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
           "-t", f"{duration_s:.3f}", str(target)]  # fmt: skip
    _ffmpeg(cmd)
    if name == "iphone":
        _ffmpeg([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-display_rotation", "90",
                 "-i", str(target), "-c", "copy", str(out)])  # fmt: skip


def _ffmpeg(cmd: list[str]) -> None:
    run = subprocess.run(cmd, capture_output=True, check=False)
    if run.returncode != 0:
        raise StageError(f"ffmpeg failed: {run.stderr.decode(errors='replace').strip()[-1500:]}")


# --- the session ---------------------------------------------------------------


def _move_faders(session: cover.Session) -> None:
    root = live_set.load(session.als)
    tracks = {live_set.track_name(t): t for t in live_set._tracks(root)}
    tracks["Main"] = root.find("LiveSet/MainTrack")
    for name, f in FADERS.items():
        mixer = tracks[name].find("DeviceChain/Mixer")
        live_set._set(mixer, "Volume/Manual", 10 ** (f["gain_db"] / 20))
        live_set._set(mixer, "Pan/Manual", f["pan"])
        live_set._set(mixer, "Speaker/Manual", not f["muted"])
    live_set.save(root, session.als)


def _ensure_kits(log) -> None:
    if not cover.kit_state(KIT).exists():
        log(f"kit {KIT}: copying the baked kit's state")
        cover_kit.kit_from_bake(KIT)


def make(song: paths.Song, timing: cover.Timing, name: str, *, seed: int = SEED, log=print) -> Path:
    """Build the fake session ``name``. Returns ``work/truth.json``."""
    sess = cover.Session(song, name)
    if sess.root.exists():
        if not (sess.work / "truth.json").exists():
            raise StageError(f"{sess.root} exists and is not a fake session; pick another --name")
        shutil.rmtree(sess.root)
    rng = np.random.default_rng(seed)
    _ensure_kits(log)

    sess.ensure_dirs()
    (sess.work / "truth.json").write_text("{}", encoding="utf-8")  # marks the folder as fake until it is filled in
    sess.update("session", {"song": song.slug, "timing": timing.value, "name": name, "live_tempo": cover.LIVE_TEMPO})
    live_set.build_set(sess, timing)
    clock = sess.clock()
    hits = chart_hits(song)
    per_bar = cover.TICKS_PER_BEAT * cover.BEATS_PER_BAR
    stop_tick = (FALSE_START_BAR - 1 + 0.5) * per_bar

    # Two passes, both from 1|1|1.
    passes = []
    for stop in (stop_tick, None):
        notes, ctl = perform(hits, clock, rng, stop)
        end = float(clock.seconds_at(stop)) + 0.2 if stop is not None else notes[-1][0] + TAIL_S
        passes.append({"notes": notes, "controllers": ctl, "start_s": 0.0, "end_s": end})

    renderer = cover_kit.Renderer(KIT, log=log)
    fake_dir = sess.work / "fake"
    fake_dir.mkdir(parents=True, exist_ok=True)
    real = 0.0
    when = datetime(2026, 10, 26, 20, 0, 0)
    for k, p in enumerate(passes, start=1):
        log(f"pass {k}: {p['end_s']:.1f} s, {len(p['notes'])} notes; rendering through SD3 ({KIT})")
        cn = [cover_kit.Note(t, d, pitch, vel) for t, pitch, vel, d in p["notes"]]
        cc = [cover_kit.Controller(t, "cc", n, v) for t, n, v in p["controllers"]]
        audio = renderer.render(cn, cc, p["end_s"], SR)
        wav = fake_dir / f"pass-{k}.wav"
        sf.write(str(wav), audio.T, SR, subtype="FLOAT")
        p["real_start_s"] = real
        p["audio"] = audio.mean(axis=0)
        live_set.add_recorded_attempt(
            sess, wav, p["start_s"], p["notes"], p["controllers"], when=when + timedelta(seconds=real)
        )
        real += p["end_s"] + GAP_S
    _move_faders(sess)

    # The room, on real time from the earliest camera's start.
    first = max(c["preroll_s"] for c in CAMERAS.values())
    session_end = passes[-1]["real_start_s"] + passes[-1]["end_s"] + CAMERA_TAIL_S
    real_audio = np.zeros(int(round((first + session_end) * SR)), np.float32)
    for p in passes:
        a = int(round((first + p["real_start_s"]) * SR))
        real_audio[a : a + p["audio"].size] += p["audio"]

    chosen = passes[-1]
    truth_cams = {}
    for cam_name, cam in CAMERAS.items():
        pre, ppm, rate = cam["preroll_s"], cam["ppm"], 1.0 + cam["ppm"] * 1e-6
        duration = (pre + session_end) * rate
        room = _room(real_audio, cam["mic_ms"], rng)[int(round((first - pre) * SR)) :]
        wav = fake_dir / f"{cam_name}-room.wav"
        sf.write(str(wav), _on_camera_clock(room, pre, ppm, duration), SR, subtype="PCM_16")
        frames = [
            int(np.floor((pre + p["real_start_s"] + t) * rate * FPS))
            for p in passes
            for t, pitch, _, _ in p["notes"]
            if pitch in FLASH_NOTES.values()
        ]
        log(f"camera {cam_name}: {duration:.1f} s, {len(frames)} flashes")
        _camera_video(cam_name, cam, wav, duration, frames, sess.raw / cam["file"], fake_dir)
        video_offset = (pre + chosen["real_start_s"]) * rate
        truth_cams[cam_name] = {
            "file": cam["file"],
            "preroll_s": pre,
            "drift_ppm": ppm,
            "mic_delay_ms": cam["mic_ms"],
            "video_offset_s": video_offset,
            # what an audio sync should find: the picture's offset plus the sound's trip to the mic
            "audio_offset_s": video_offset + cam["mic_ms"] / 1000.0 * rate,
            "flash_upright": list(cam["flash"]),
            "upright_size": list(cam["size"]),
        }

    names = {v: k for k, v in FLASH_NOTES.items()}
    truth = {
        "song": song.slug,
        "timing": timing.value,
        "seed": seed,
        "kit": KIT,
        "lateness_ms": LATENESS_MS,
        "jitter_ms": JITTER_MS,
        "fps": FPS,
        "attempts": [
            {"index": k, "real_start_s": p["real_start_s"], "start_s": p["start_s"], "end_s": p["end_s"],
             "notes": len(p["notes"]), "complete": p is chosen}
            for k, p in enumerate(passes, start=1)
        ],  # fmt: skip
        "chosen": len(passes),
        "faders": FADERS,
        "cameras": truth_cams,
        # the chosen pass's kicks and snares, arrangement seconds
        "hits": [
            {"t": t, "instrument": names[pitch], "velocity": vel}
            for t, pitch, vel, _ in chosen["notes"]
            if pitch in names
        ],
        "first_bar_s": float(clock.bar_start(1)),
    }
    path = sess.work / "truth.json"
    path.write_text(json.dumps(truth, indent=1), encoding="utf-8")
    return path
