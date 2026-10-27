"""The dress rehearsal: the whole cover pipeline on a fake session whose answers are known.

``drums cover-fake-session`` writes a session -- a false start and a full pass
rendered through SD3, two upright HEVC phones at 60 fps, each with its own
clock drift, a room mic and a flash on every kick and snare -- and
``work/truth.json``. Then the real commands run on it, as the user would run
them, and every result is checked against the truth:

1. the attempts list finds both passes and picks the full one;
2. sync finds each phone's offset within 5 ms and its drift within 10 ppm;
3. in every output video the flashes, the audio's hits and the tab strip's
   playhead coincide within a frame (16.7 ms at 60 fps), at the start, middle
   and end;
4. no click in the mix, -14 +-0.5 LUFS, and the timing report finds the
   lateness that was planted;
5. kit B's render sounds different from kit A's, but its hits land within
   2 ms of kit A's -- the recorded MIDI was complete;
6. the files: 1080x1920, 60 fps, H.264 + AAC, faststart, the right length.

Slow (SD3, ffmpeg, a browser for the tab; a few minutes a timing), so it runs
only with ``-m slow`` or ``DRUMS_SLOW=1``. ``DRUMS_E2E_REUSE=1`` keeps a
finished session and only re-checks it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from scipy import signal
from scipy.ndimage import uniform_filter1d

from pipeline import cover, cover_render, cover_strip, live_set, paths
from pipeline import cover_cli_mix
from pipeline import cover_mix
from pipeline.align import decode_mono

pytestmark = pytest.mark.slow

SLUG = "blur-song-2-official-music-video"
DRUMS = Path(sys.executable).parent / "drums"
FRAME = 1.0 / cover_render.FPS  # 16.7 ms
SYNC_SLACK = 0.004  # what the sync itself may be off by, on top of a frame
KITS = ("bake", "practice")
KIT_TAB = "flip"
WINDOW_S = 15.0
SR = 48000


def _drums(*args: str) -> str:
    run = subprocess.run([str(DRUMS), *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    assert run.returncode == 0, f"drums {' '.join(args)} failed:\n{run.stdout}\n{run.stderr}"
    return run.stdout


def _videos(sess: cover.Session) -> dict[str, Path]:
    out = {tab: cover_render.output_path(sess, tab, None, None) for tab in cover_render.TABS}
    for kit in KITS:
        out[f"{KIT_TAB}-{kit}"] = cover_render.output_path(sess, KIT_TAB, kit, None)
    return out


@pytest.fixture(scope="module", params=["straight", "original"])
def fake(request):
    timing = request.param
    name = f"fake-{timing[0]}"
    sess = cover.Session(paths.resolve(SLUG), name)
    reuse = os.environ.get("DRUMS_E2E_REUSE") and all(p.exists() for p in _videos(sess).values())
    if not reuse:
        _drums("cover-fake-session", SLUG, "--timing", timing, "--name", name)
        _drums("cover-attempts", SLUG, "--name", name, "--save")
        _drums("cover-mix", SLUG, "--name", name, "--no-chain")
        _drums("cover-mix", SLUG, "--name", name)
        _drums("cover-mix", SLUG, "--name", name, "--kit", ",".join(KITS))
        _drums("cover-sync", SLUG, "--name", name)
        _drums("cover-render", SLUG, "--name", name, "--all")
        _drums("cover-render", SLUG, "--name", name, "--tab", KIT_TAB, "--kit", ",".join(KITS))
    truth = json.loads((sess.work / "truth.json").read_text(encoding="utf-8"))
    return sess, truth


# --- 1. attempts -----------------------------------------------------------------


def test_attempts_finds_both_and_picks_the_full_one(fake):
    sess, truth = fake
    found = live_set.attempts(sess)
    assert len(found) == 2
    chosen = live_set.default_attempt(found)
    assert chosen.index == truth["chosen"] == 2
    assert not found[0].complete and found[0].bars == 5
    assert abs(chosen.end_s - truth["attempts"][1]["end_s"]) < 0.01
    assert int(sess.settings()["attempt"]["index"]) == 2
    # the faders were moved after recording; they read back
    faders = live_set.read_set(sess.als).faders
    for track, f in truth["faders"].items():
        assert abs(faders[track].gain_db - f["gain_db"]) < 0.01, track
        assert abs(faders[track].pan - f["pan"]) < 1e-6, track
        assert faders[track].muted == f["muted"], track


# --- 2. sync ---------------------------------------------------------------------


def test_sync_recovers_offsets_and_drift(fake):
    sess, truth = fake
    sync = sess.settings()["sync"]
    for cam, t in truth["cameras"].items():
        err_ms = (float(sync[f"{cam}_offset_s"]) - t["audio_offset_s"]) * 1000
        drift_err = float(sync[f"{cam}_drift_ppm"]) - t["drift_ppm"]
        print(f"{truth['timing']} {cam}: offset {err_ms:+.2f} ms, drift {drift_err:+.1f} ppm off the truth")
        assert abs(err_ms) < 5.0, cam
        assert abs(drift_err) < 10.0, cam


# --- 3. flashes, audio and playhead -------------------------------------------------


def _t0(sess: cover.Session) -> float:
    lay = sess.settings().get("layout", {})
    return float(sess.settings()["attempt"]["start_s"]) - float(lay.get("preroll_s", cover_render.PREROLL_S))


def _flash_boxes(truth: dict) -> dict[str, tuple[int, int, int, int]]:
    """Where each phone's flash square lands in the output frame (its inner half)."""
    L, b, m = cover_render.LAYOUT, cover_render.BORDER_PX, cover_render.MARGIN_PX
    out = {}
    # the main phone fills the main area: the default crop -- the main area's
    # shape, centred across, a quarter of the spare height above (ffmpeg puts
    # its corner on even pixels for 4:2:0) -- then scaled to fit
    w, h = truth["cameras"]["main"]["upright_size"]
    x, y, fw, fh = truth["cameras"]["main"]["flash_upright"]
    cw, ch = min(w, h * L.width / L.main_h), min(h, w * L.main_h / L.width)
    cx = int((w - cw) / 2) // 2 * 2
    cy = int((h - ch) * cover_render.MAIN_HEADROOM) // 2 * 2
    k = L.width / cw
    out["main"] = ((x - cx) * k, (y - cy) * k, fw * k, fh * k)
    # the foot phone: centre square, scaled into the bordered inset, top right
    w, h = truth["cameras"]["foot"]["upright_size"]
    x, y, fw, fh = truth["cameras"]["foot"]["flash_upright"]
    side = min(w, h)
    k = L.inset / side
    ox, oy = L.width - (L.inset + 2 * b) - m + b, m + b
    out["foot"] = (ox + (x - (w - side) / 2) * k, oy + (y - (h - side) / 2) * k, fw * k, fh * k)
    inner = {}
    for cam, (x, y, fw, fh) in out.items():
        even = lambda v: int(v) // 2 * 2  # noqa: E731 -- crop on 4:2:0 moves odd edges
        inner[cam] = (even(x + fw / 4), even(y + fh / 4), even(fw / 2), even(fh / 2))
    return inner


def _region_means(video: Path, box: tuple[int, int, int, int]) -> np.ndarray:
    x, y, w, h = box
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video),
           "-vf", f"crop={w}:{h}:{x}:{y},format=gray", "-f", "rawvideo", "-"]  # fmt: skip
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, w * h).mean(axis=1)


def _rising(means: np.ndarray) -> np.ndarray:
    lit = means > 128
    return np.flatnonzero(lit[1:] & ~lit[:-1]) + 1


def _strip_frames(video: Path, frames: list[int]) -> np.ndarray:
    layout = cover_render.LAYOUT
    sel = "+".join(f"eq(n\\,{k})" for k in frames)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(video),
           "-vf", f"select='{sel}',crop={layout.width}:{layout.strip_h}:0:{layout.main_h}",
           "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]  # fmt: skip
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(len(frames), layout.strip_h, layout.width, 3)


def _strip_time(pixels: np.ndarray, strip, around: float) -> tuple[float, float]:
    """The run of timeline seconds whose strip drawing matches ``pixels`` best.

    Wider than a few ms only where the strip holds still (before bar 1)."""
    ts = around + np.arange(-0.15, 0.15, 0.001)
    target = pixels.astype(np.float32)
    err = np.array([np.abs(np.asarray(strip.frame(t), np.float32) - target).mean() for t in ts])
    best = ts[err <= err.min() + 1e-6]
    return float(best.min()), float(best.max())


def _audio_lag(out_audio: np.ndarray, mix_audio: np.ndarray, out_at: float, mix_at: float) -> float:
    """How late the output's audio runs against the mix, over one window (s)."""
    n, pad = int(WINDOW_S * SR), int(0.1 * SR)
    a, b = int(out_at * SR), int(mix_at * SR)
    seg = out_audio[a - pad : a + n + pad]
    ref = mix_audio[b : b + n]
    corr = signal.correlate(seg, ref, mode="valid", method="fft")
    return (int(np.argmax(corr)) - pad) / SR


def _isolated(hits: list[dict], gap: float = 0.1) -> list[dict]:
    out, last = [], -1e9
    for h in sorted(hits, key=lambda h: h["t"]):
        if h["t"] - last > gap:
            out.append(h)
        last = h["t"]
    return out


@pytest.mark.parametrize("video", ["scroll", "flip", "flip-practice"])
def test_flashes_audio_and_playhead_coincide(fake, video):
    sess, truth = fake
    path = _videos(sess)[video]
    tab, _, kit = video.partition("-")
    kit = kit or None
    t0 = _t0(sess)
    hits = _isolated(truth["hits"])
    duration = float(sess.settings()["attempt"]["end_s"]) - t0
    first, last = hits[0]["t"], hits[-1]["t"]
    windows = {"start": first, "middle": (first + last) / 2 - WINDOW_S / 2, "end": last - WINDOW_S}

    edges = {cam: _rising(_region_means(path, box)) * FRAME for cam, box in _flash_boxes(truth).items()}
    # The audio: where the output's track sits against the mix it was cut
    # from, and where each hit's attack is in the dry kit the mix was made of.
    # (Onset picking on the finished mix would mostly measure the song's
    # guitars and bass.)
    out_audio = decode_mono(path, SR)
    mix_audio = decode_mono(sess.work / (f"mix-{kit}.wav" if kit else "mix.wav"), SR)
    dry = sess.work / (f"drums-only-{kit}.wav" if kit else "drums-only.wav")
    attack = dict(zip((h["t"] for h in hits), _attacks(dry, [h["t"] for h in hits])))
    strip = cover_render.make_strip(sess, tab)

    report = []
    for where, a in windows.items():
        in_window = [h for h in hits if a <= h["t"] < a + WINDOW_S]
        assert len(in_window) > 10, where
        flash_err, audio_err, flash_audio = {c: [] for c in edges}, [], []
        lag = _audio_lag(out_audio, mix_audio, a - t0, a)
        assert abs(lag) < 0.002, f"{where}: the output's audio is {lag * 1000:+.1f} ms off the mix"
        for h in in_window:
            expect = h["t"] - t0  # output seconds
            onset = expect + attack[h["t"]] + lag  # the hit as heard in the output
            audio_err.append(onset - expect)
            for cam, e in edges.items():
                k = e[np.argmin(np.abs(e - expect))]
                # The phone's frame holding the hit is lit; the output samples
                # the phone at 60 fps at a phase of its own, so the first lit
                # output frame starts within a frame either side of the hit.
                # Sync locks to the room mic, which hears the kit a few ms after
                # the camera sees it, so the picture is that much early.
                early = truth["cameras"][cam]["mic_delay_ms"] / 1000
                flash_err[cam].append(expect - (k + early))
                flash_audio.append(onset - (k + early))
        audio_err = np.abs(np.asarray(audio_err))
        flash_audio = np.abs(np.asarray(flash_audio))
        for cam, errs in flash_err.items():
            errs = np.asarray(errs)
            assert np.all(np.abs(errs) < FRAME + SYNC_SLACK), f"{where} {cam} flash off its hit: {errs}"
        assert np.mean(audio_err < 0.005) >= 0.9, f"{where} audio hits off: {np.sort(audio_err)[-5:]}"
        assert np.median(audio_err) < 0.003, where
        assert np.mean(flash_audio <= FRAME + SYNC_SLACK) >= 0.95, f"{where} flash vs audio: {np.sort(flash_audio)[-5:]}"

        # the playhead: read the strip's time out of the output pixels at a few lit frames
        picks = in_window[:: max(1, len(in_window) // 4)][:4]
        frames = [int(round(edges["main"][np.argmin(np.abs(edges["main"] - (h["t"] - t0)))] / FRAME)) for h in picks]
        pixels = _strip_frames(path, frames)
        for h, k, px in zip(picks, frames, pixels):
            at = t0 + k * FRAME
            lo, hi = _strip_time(px, strip, at)
            assert lo - 0.005 <= at <= hi + 0.005, f"{where}: strip shows {lo:.3f}-{hi:.3f}, frame is at {at:.3f}"
            shown = min(max(at, lo), hi)
            # the lit frame starts up to a frame (plus the mic's early) before the hit
            early = truth["cameras"]["main"]["mic_delay_ms"] / 1000
            lag = h["t"] - shown
            assert abs(lag - early) <= FRAME + SYNC_SLACK, f"{where}: playhead {-lag:+.3f}s off the hit"
            # ... and on the written note the hit belongs to
            tick = float(strip.clock.tick_at(shown))
            written = float(strip.clock.seconds_at(round(tick / 120) * 120))
            assert abs(shown - written) <= FRAME + (truth["lateness_ms"] + truth["jitter_ms"]) / 1000 + SYNC_SLACK
        report.append(
            f"{where}: flash-hit {max(np.max(np.abs(np.asarray(v))) for v in flash_err.values()) * 1000:.0f} ms max, "
            f"audio {np.median(audio_err) * 1000:.1f} ms median"
        )
    print(f"{truth['timing']} {video}: " + "; ".join(report))
    assert duration > 0


# --- 4. the mix ---------------------------------------------------------------------


def test_mix_has_no_click_right_loudness_and_finds_the_lateness(fake):
    sess, truth = fake
    mix, sr = sf.read(str(sess.work / "mix.wav"), dtype="float32", always_2d=True)
    click = cover_mix.load(sess.backing()["click"], sr).mean(axis=0)
    m = mix.mean(axis=1)[: click.size]
    c = click[: m.size]
    gain = float(np.dot(m, c) / np.dot(c, c))
    assert abs(gain) < 0.02, f"the click is in the mix (gain {gain:.3f})"

    for name in ("mix.wav", "mix-nochain.wav", "mix-bake.wav", "mix-practice.wav"):
        audio, rate = sf.read(str(sess.work / name), dtype="float32", always_2d=True)
        lufs = cover_mix.loudness(audio.T, rate)
        assert abs(lufs + 14.0) <= 0.5, f"{name}: {lufs:.2f} LUFS"

    dry, rate = sf.read(str(sess.work / "drums-only.wav"), dtype="float32", always_2d=True)
    rows = cover_mix.timing_report(dry.T, None, rate, chart=cover_cli_mix._chart_times(sess))
    for r in rows:
        print(f"{truth['timing']} timing {r.instrument}: {r.vs_chart_ms:+.1f} ms on the chart (planted {truth['lateness_ms']:+.0f})")
        assert abs(r.vs_chart_ms - truth["lateness_ms"]) <= 8.0, r


# --- 5. kit B -----------------------------------------------------------------------


def _attacks(path: Path, times: list[float]) -> np.ndarray:
    """Each hit's attack in the 5 kHz-up band: where the stick lands, whatever the drum."""
    x, sr = sf.read(str(path), dtype="float32", always_2d=True)
    x = signal.sosfilt(signal.butter(4, 5000, "highpass", fs=sr, output="sos"), x.mean(axis=1))
    env = uniform_filter1d(np.abs(x), int(0.0005 * sr))
    out = []
    for t in times:
        i = int(t * sr)
        pre = np.median(env[i - int(0.010 * sr) : i - int(0.002 * sr)])
        seg = env[i - int(0.002 * sr) : i + int(0.025 * sr)]
        out.append(np.argmax(seg >= pre + 0.3 * (seg.max() - pre)) / sr - 0.002)
    return np.asarray(out)


def test_kit_b_differs_but_lines_up(fake):
    sess, truth = fake
    a, _ = sf.read(str(sess.work / "drums-only-bake.wav"), dtype="float32", always_2d=True)
    b, _ = sf.read(str(sess.work / "drums-only-practice.wav"), dtype="float32", always_2d=True)
    n = min(len(a), len(b))
    difference = np.linalg.norm(a[:n] - b[:n]) / np.linalg.norm(a[:n])
    assert difference > 0.3, f"kit B sounds like kit A ({difference:.2f})"
    for inst in ("kick", "snare"):
        times = [h["t"] for h in truth["hits"] if h["instrument"] == inst]
        d = (_attacks(sess.work / "drums-only-practice.wav", times) - _attacks(sess.work / "drums-only-bake.wav", times)) * 1000
        print(f"{truth['timing']} kit B {inst}: {np.median(d):+.2f} ms median, {np.mean(np.abs(d) < 5):.0%} within 5 ms")
        assert abs(np.median(d)) < 2.0, inst
        assert np.mean(np.abs(d) < 5.0) >= 0.85, inst


# --- 6. the files -------------------------------------------------------------------


def _top_level_boxes(path: Path) -> list[str]:
    boxes = []
    with open(path, "rb") as f:
        size_total = path.stat().st_size
        pos = 0
        while pos < size_total:
            f.seek(pos)
            head = f.read(16)
            size, kind = int.from_bytes(head[:4], "big"), head[4:8].decode("latin-1")
            if size == 1:
                size = int.from_bytes(head[8:16], "big")
            boxes.append(kind)
            if size == 0:
                break
            pos += size
    return boxes


def test_files_are_right(fake):
    sess, truth = fake
    attempt = sess.settings()["attempt"]
    expect = float(attempt["end_s"]) - float(attempt["start_s"]) + cover_render.PREROLL_S + cover_render.TAIL_S
    layout = cover_render.LAYOUT
    for name, path in _videos(sess).items():
        probe = json.loads(subprocess.run(
            ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
            capture_output=True, check=True, text=True).stdout)  # fmt: skip
        video = next(s for s in probe["streams"] if s["codec_type"] == "video")
        audio = next(s for s in probe["streams"] if s["codec_type"] == "audio")
        assert (video["width"], video["height"]) == (layout.width, layout.height), name
        assert video["codec_name"] == "h264" and video["pix_fmt"] == "yuv420p", name
        assert video["r_frame_rate"] == "60/1" and video["avg_frame_rate"] == "60/1", name
        assert audio["codec_name"] == "aac", name
        assert abs(float(probe["format"]["duration"]) - expect) < 0.1, f"{name}: {probe['format']['duration']} vs {expect:.2f}"
        boxes = _top_level_boxes(path)
        assert boxes.index("moov") < boxes.index("mdat"), f"{name} is not faststart: {boxes}"
