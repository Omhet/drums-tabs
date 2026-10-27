"""The generated cover set, and reading record passes back out of a saved one.

These build from the real everyday practice set (read-only; a test checks its
bytes do not change) into a fake song under tmp, with tiny generated wavs.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import sys
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

import mido
import numpy as np
import pytest
import soundfile as sf

from pipeline import cover, live_set, paths
from pipeline.proc import StageError

pytestmark = pytest.mark.skipif(not live_set.TEMPLATE.exists(), reason="the practice set is not on this machine")

SR = 8000
BARS = 8
SPB = 60.0 / cover.LIVE_TEMPO


def _wav(path: Path, seconds: float) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    t = np.arange(int(seconds * SR)) / SR
    sf.write(str(path), 0.1 * np.sin(2 * np.pi * 220 * t).astype(np.float32), SR)
    return path


def _song(tmp_path: Path) -> paths.Song:
    song = paths.Song("fake-song", tmp_path / "songs" / "fake-song")
    song.ensure_dirs()
    # Bar 1 at 0.5 s, steady 130, a few bars past the chart.
    beats = 0.5 + np.arange((BARS + 4) * 4) * SPB
    song.grid_lock.write_text(json.dumps({"beats": beats.tolist(), "bar_one_beat": 0}), encoding="utf-8")
    song.straight_json.write_text(json.dumps({"bpm": cover.LIVE_TEMPO}), encoding="utf-8")
    seconds = 0.5 + (BARS + 1) * 4 * SPB
    for timing in cover.Timing:
        for bars in (1, 2):
            for p in cover.backing(song, timing, bars).values():
                _wav(p, seconds)
    # tab.mid: a kick on every beat for BARS bars, the last one a crash.
    track = mido.MidiTrack()
    for k in range(BARS * 4):
        note = 49 if k == BARS * 4 - 1 else 36
        track.append(mido.Message("note_on", channel=9, note=note, velocity=100, time=0 if k == 0 else 360))
        track.append(mido.Message("note_off", channel=9, note=note, velocity=0, time=120))
    midi = mido.MidiFile(ticks_per_beat=480)
    midi.tracks.append(track)
    midi.save(str(song.tab_midi))
    return song


def _session(song: paths.Song, timing: cover.Timing, count_in: int = cover.COUNT_IN_BARS) -> cover.Session:
    sess = cover.Session(song, f"t-{timing.value}-{count_in}")
    sess.ensure_dirs()
    sess.update("session", {
        "song": song.slug, "timing": timing.value, "name": sess.name, "count_in_bars": count_in,
        "stem_start_beats": cover.stem_start_for(song, timing, count_in),
    })  # fmt: skip
    return sess


def _root(path: Path) -> ET.Element:
    return ET.fromstring(gzip.decompress(path.read_bytes()))


def _by_name(root: ET.Element) -> dict[str, ET.Element]:
    return {live_set.track_name(t): t for t in root.find("LiveSet/Tracks")}


def _set_tempo_manual(als: Path, bpm: float) -> None:
    root = live_set.load(als)
    root.find("LiveSet/MainTrack/DeviceChain/Mixer/Tempo/Manual").set("Value", str(bpm))
    live_set.save(root, als)


# --- the generated set ----------------------------------------------------------


@pytest.mark.parametrize("count_in", [1, 2])
@pytest.mark.parametrize("timing", list(cover.Timing))
def test_built_set(tmp_path, timing, count_in):
    before = hashlib.sha256(live_set.TEMPLATE.read_bytes()).hexdigest()
    song = _song(tmp_path)
    sess = _session(song, timing, count_in)
    als = live_set.build_set(sess)
    assert hashlib.sha256(live_set.TEMPLATE.read_bytes()).hexdigest() == before
    assert als == sess.als

    root = _root(als)
    template = live_set.load(live_set.TEMPLATE)
    tracks = list(root.find("LiveSet/Tracks"))
    names = [live_set.track_name(t) for t in tracks]
    # SD3 and the four new tracks; of the template's others only its returns.
    assert names[:5] == [live_set.SD3_TRACK, "nodrums", "drums", "click", live_set.REC_TRACK]
    template_returns = [t for t in template.find("LiveSet/Tracks") if t.tag == "ReturnTrack"]
    assert [t.tag for t in tracks[5:]] == ["ReturnTrack"] * len(template_returns)
    for got, want in zip(tracks[5:], template_returns):
        assert ET.tostring(got) == ET.tostring(want)
    track_ids = [t.get("Id") for t in tracks]
    assert len(set(track_ids)) == len(track_ids)

    # SD3 untouched but for its clips: plugin state, devices, fader, MIDI input.
    by, tby = _by_name(root), _by_name(template)
    sd3, tsd3 = by[live_set.SD3_TRACK], tby[live_set.SD3_TRACK]
    for path in ("DeviceChain/DeviceChain", "DeviceChain/Mixer", "DeviceChain/MidiInputRouting"):
        assert ET.tostring(sd3.find(path)) == ET.tostring(tsd3.find(path)), path
    # ... and the main chain.
    main_chain = "LiveSet/MainTrack/DeviceChain/DeviceChain"
    assert ET.tostring(root.find(main_chain)) == ET.tostring(template.find(main_chain))

    for name in (live_set.SD3_TRACK, live_set.REC_TRACK):
        assert by[name].find("DeviceChain/MainSequencer/Recorder/IsArmed").get("Value") == "true"
    for name in ("nodrums", "drums", "click"):
        assert by[name].find("DeviceChain/MainSequencer/Recorder/IsArmed").get("Value") == "false"
    sd3_id = sd3.get("Id")
    assert by[live_set.REC_TRACK].find("DeviceChain/AudioInputRouting/Target").get("Value") == (
        f"AudioIn/Track.{sd3_id}/PostFxOut"
    )

    # The faders: SD3 the template's, the rest the set balance, every track on.
    faders = live_set.read_set(als).faders
    assert faders[live_set.SD3_TRACK] == live_set._fader(tsd3)
    for name, gain in live_set.FADERS_DB.items():
        assert faders[name].gain_db == pytest.approx(gain, abs=1e-9), name
        assert not faders[name].muted, name

    # Exactly one clip each on the backing tracks, none anywhere else.
    clips = [c for c in root.iter() if c.tag in ("AudioClip", "MidiClip")
             and c not in set(root.find("LiveSet/GroovePool").iter())]
    assert len(clips) == 3
    backing = sess.backing()
    assert backing["click"].name == f"click-{timing.value}-{count_in}bar.wav"
    for name, wav in backing.items():
        (clip,) = by[name].findall("DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events/AudioClip")
        ref = Path(clip.find("SampleRef/FileRef/Path").get("Value"))
        assert ref.exists() and ref.samefile(wav)
        rel = clip.find("SampleRef/FileRef/RelativePath").get("Value")
        assert (sess.root / rel).resolve() == wav.resolve()
        start = float(clip.find("CurrentStart").get("Value"))
        assert start == (0.0 if name == "click" else sess.stem_start_beats)
        seconds = sf.info(str(wav)).duration
        assert float(clip.find("CurrentEnd").get("Value")) - start == pytest.approx(seconds / SPB)
        _check_warp(clip, name, timing, seconds)

    # Pointee ids unique and below NextPointeeId.
    ids = [int(e.get("Id")) for e in root.iter() if "Id" in e.attrib and live_set._is_pointee(e.tag)]
    assert len(ids) == len(set(ids))
    assert max(ids) < int(root.find("LiveSet/NextPointeeId").get("Value"))
    refs = {int(e.get("Value")) for e in root.iter("PointeeId")}
    assert refs <= set(ids) | {int(e.get("Id")) for e in root.iter() if "Id" in e.attrib}

    assert live_set.read_set(als).tempo == cover.LIVE_TEMPO
    live_set.check_tempo(sess)
    assert root.find("LiveSet/Transport/LoopOn").get("Value") == "false"
    assert float(root.find("LiveSet/Transport/CurrentTime").get("Value")) == 0


def _check_warp(clip: ET.Element, name: str, timing: cover.Timing, seconds: float) -> None:
    """Straight: warped so that at 130 every sample plays where it did unwarped. Original: unwarped."""
    value = lambda tag: clip.find(tag).get("Value")  # noqa: E731
    loop_end = float(value("Loop/LoopEnd"))
    if timing is cover.Timing.original:
        assert value("IsWarped") == "false"
        assert loop_end == pytest.approx(seconds)  # seconds of the file, unwarped
        return
    assert value("IsWarped") == "true"
    for key, want in live_set._WARP[name].items():
        assert value(key) == str(want), (name, key)
    assert {"nodrums": "6", "drums": "0", "click": "0"}[name] == value("WarpMode")
    assert value("TransientLoopMode") == ("0" if name == "click" else "2")
    beats = seconds * cover.LIVE_TEMPO / 60.0
    assert loop_end == pytest.approx(beats)  # clip beats, warped
    marks = [(float(m.get("SecTime")), float(m.get("BeatTime"))) for m in clip.find("WarpMarkers")]
    assert marks[0] == (0.0, 0.0)
    assert marks[1] == pytest.approx((seconds, beats), abs=1e-12)
    assert marks[2] == pytest.approx((seconds + live_set._MARKER_BEATS * SPB, beats + live_set._MARKER_BEATS), abs=1e-12)
    # At 130 a file second lands on the arrangement exactly where it did unwarped.
    for (s0, b0), (s1, b1) in zip(marks, marks[1:]):
        assert (b1 - b0) * SPB == pytest.approx(s1 - s0, abs=1e-12)


def test_the_stems_start_after_the_count_in(tmp_path):
    song = _song(tmp_path)  # bar 1 at 0.5 s into the stems, 0.46 s a beat
    bar = 4.0
    assert cover.stem_start_for(song, cover.Timing.straight, 1) == bar
    assert cover.stem_start_for(song, cover.Timing.straight, 2) == 2 * bar
    # Original: a 1-bar count-in needs 1.85 s before bar 1, a 2-bar one 3.69 s.
    assert cover.stem_start_for(song, cover.Timing.original, 1) == bar
    assert cover.stem_start_for(song, cover.Timing.original, 2) == 2 * bar
    with pytest.raises(StageError, match="at least one"):
        cover.stem_start_for(song, cover.Timing.straight, 0)


@pytest.mark.parametrize("count_in", [1, 2])
@pytest.mark.parametrize("timing", list(cover.Timing))
def test_the_clock_starts_bar_one_where_the_session_says(tmp_path, timing, count_in):
    song = _song(tmp_path)
    sess = _session(song, timing, count_in)
    start_s = sess.stem_start_beats * SPB
    expect = start_s + (0.0 if timing is cover.Timing.straight else 0.5)
    assert sess.clock().bar_start(1) == pytest.approx(expect)
    assert sess.clock().bar_start(2) - sess.clock().bar_start(1) == pytest.approx(4 * SPB)


def test_missing_stems_say_so(tmp_path):
    song = _song(tmp_path)
    cover.stretched(song, "drums").unlink()
    sess = _session(song, cover.Timing.straight)
    with pytest.raises(StageError, match="stretched-drums.wav"):
        live_set.build_set(sess)
    assert not sess.als.exists()


def test_refuses_to_write_into_ableton_projects(tmp_path):
    song = paths.Song("x", live_set.PROTECTED / "Projects" / "nope")
    with pytest.raises(StageError):
        live_set._guard(cover.Session(song, "s").als)


def test_faders_round_trip(tmp_path):
    song = _song(tmp_path)
    sess = _session(song, cover.Timing.original)
    als = live_set.build_set(sess)
    root = live_set.load(als)
    drums = live_set._track(root, "drums")
    drums.find("DeviceChain/Mixer/Volume/Manual").set("Value", "0.5011872053")
    drums.find("DeviceChain/Mixer/Pan/Manual").set("Value", "-0.25")
    live_set._track(root, "click").find("DeviceChain/Mixer/Speaker/Manual").set("Value", "false")
    live_set.save(root, als)

    faders = live_set.read_set(als).faders
    assert faders["drums"].gain_db == pytest.approx(-6.0, abs=0.01)
    assert faders["drums"].pan == -0.25
    assert faders["click"].muted and not faders["drums"].muted
    assert faders["nodrums"].gain_db == pytest.approx(live_set.FADERS_DB["nodrums"], abs=1e-9)


# --- reading passes back ---------------------------------------------------------


def _performance(bar_one: float, bars: int, seed: int):
    """Kicks and hats with CC4 moving and one choked crash, in arrangement seconds."""
    rng = np.random.default_rng(seed)
    notes, ccs, touch = [], [], []
    for k in range(bars * 4):
        t = bar_one + k * SPB + float(rng.uniform(-0.01, 0.01))
        notes.append((t, 36, int(rng.integers(60, 127)), 0.1))
        notes.append((t + SPB / 2, 42, int(rng.integers(30, 90)), 0.05))
        ccs.append((t + 0.02, 4, int(rng.integers(0, 127))))
    crash = bar_one + (bars * 4 - 1) * SPB
    notes.append((crash, 49, 120, 0.5))
    touch += [(crash + 0.2, 49, 127), (crash + 0.3, 49, 0)]
    return notes, ccs, touch


def _full_take(sess: cover.Session, tmp_path: Path, seed: int = 3) -> Path:
    bar_one = float(sess.clock().bar_start(1))
    wav = _wav(tmp_path / f"take-{seed}.wav", bar_one + (BARS + 0.5) * 4 * SPB)
    return live_set.add_recorded_attempt(sess, wav, 0.0, *_performance(bar_one, BARS, seed))


def test_attempts_from_recorded_passes(tmp_path):
    song = _song(tmp_path)
    sess = _session(song, cover.Timing.original)
    live_set.build_set(sess)
    bar_one = float(sess.clock().bar_start(1))

    # A false start that stops in bar 3, then a full take, both from 1|1|1.
    short = _performance(bar_one, 2, seed=1)
    full = _performance(bar_one, BARS, seed=2)
    wav1 = live_set.add_recorded_attempt(
        sess, _wav(tmp_path / "a.wav", bar_one + 2.5 * 4 * SPB), 0.0, *short, when=datetime(2026, 10, 26, 20, 0, 0)
    )
    wav2 = live_set.add_recorded_attempt(
        sess, _wav(tmp_path / "b.wav", bar_one + (BARS + 0.5) * 4 * SPB), 0.0, *full,
        when=datetime(2026, 10, 26, 20, 1, 0),
    )  # fmt: skip
    assert wav1.parent == sess.recorded and wav1.name == "SD3 rec 0001 [2026-10-26 200000].wav"
    assert wav2.name.startswith("SD3 rec 0002 ")

    root = live_set.load(sess.als)
    for name in (live_set.REC_TRACK, live_set.SD3_TRACK):
        track = live_set._track(root, name)
        assert len(track.findall("TakeLanes/TakeLanes/TakeLane")) == 2
        # The main lane shows the newest pass only: it covers the first.
        assert len(list(live_set._main_events(track))) == 1
    ids = [int(e.get("Id")) for e in root.iter() if "Id" in e.attrib and live_set._is_pointee(e.tag)]
    assert len(ids) == len(set(ids)) and max(ids) < int(root.find("LiveSet/NextPointeeId").get("Value"))

    found = live_set.attempts(sess)
    assert [a.index for a in found] == [1, 2]
    first, second = found
    assert not first.complete and first.bars == 2
    assert second.complete and second.bars == BARS
    assert live_set.default_attempt(found) is second
    assert first.audio == wav1 and second.audio == wav2
    assert second.file_offset_s == pytest.approx(0.0)
    assert second.end_s == pytest.approx(sf.info(str(wav2)).duration)

    want = sorted(full[0], key=lambda n: (n[0], n[1]))
    assert len(second.notes) == len(want)
    for got, exp in zip(second.notes, want):
        assert got[0] == pytest.approx(exp[0], abs=1e-9)
        assert got[1:3] == exp[1:3]
        assert got[3] == pytest.approx(exp[3], abs=1e-9)

    cc4 = [(t, v) for t, cc, v in second.controllers if cc == 4]
    # The first value holds from the clip start; every later change is where it was played.
    expected = [(0.0, full[1][0][2])] + [
        (t, v) for (t, _, v), (_, _, prev) in zip(full[1][1:], full[1]) if v != prev
    ]
    assert len(cc4) == len(expected)
    for (t, v), (et, ev) in zip(cc4, expected):
        assert t == pytest.approx(et, abs=1e-9) and v == ev

    assert [(round(t, 9), n, v) for t, n, v in second.aftertouch] == [
        (round(t, 9), n, v) for t, n, v in full[2]
    ]
    assert len(first.notes) == len(short[0])


#: The controllers the TD-27 sent in the first real session (covers/dev-s) and
#: in the everyday practice set's own recordings.
TD27_CCS = (4, 16, 17, 18, 19, 83, 88)


def test_every_td27_controller_survives_the_set_and_reaches_the_render(tmp_path):
    from pipeline import cover_cli_mix, cover_kit

    song = _song(tmp_path)
    sess = _session(song, cover.Timing.straight)
    live_set.build_set(sess)
    notes = [(1.0 + 0.25 * k, 38, 100, 0.05) for k in range(8)]
    ccs = sorted((1.0 + 0.1 * k + 0.01 * i, cc, (17 * k + cc) % 128) for k in range(5) for i, cc in enumerate(TD27_CCS))
    touch = [(2.6, 38, 127)]
    live_set.add_recorded_attempt(sess, _wav(tmp_path / "a.wav", 4.0), 0.0, notes, ccs, touch)
    (got,) = live_set.attempts(sess)
    for cc in TD27_CCS:
        sent = [(t, v) for t, c, v in ccs if c == cc]
        read = [(t, v) for t, c, v in got.controllers if c == cc]
        # Read back as Live holds it: the first value from the clip start, then each change.
        assert read[0] == (0.0, sent[0][1]) and [v for _, v in read[1:]] == [v for _, v in sent[1:]], cc
        for (t, _), (et, _) in zip(read[1:], sent[1:]):
            assert t == pytest.approx(et, abs=1e-9)

    events, ctl = cover_cli_mix._kit_events(got)
    path = tmp_path / "take.mid"
    cover_kit.midi_file(events, ctl, path)
    on_file = {(m.type, getattr(m, "control", None)) for m in mido.MidiFile(path) if not m.is_meta}
    for cc in TD27_CCS:
        assert ("control_change", cc) in on_file, cc
    assert ("polytouch", None) in on_file


def test_main_lane_clip_without_take_lane_is_a_pass(tmp_path):
    """A main-lane clip no take lane holds (lanes deleted) still counts."""
    song = _song(tmp_path)
    sess = _session(song, cover.Timing.original, 1)
    live_set.build_set(sess)
    _full_take(sess, tmp_path)
    root = live_set.load(sess.als)
    for name in (live_set.REC_TRACK, live_set.SD3_TRACK):
        lanes = live_set._track(root, name).find("TakeLanes/TakeLanes")
        for lane in list(lanes):
            lanes.remove(lane)
    live_set.save(root, sess.als)
    (only,) = live_set.attempts(sess)
    assert only.complete and only.audio is not None and only.notes


def _attempt(index: int, length: float, complete: bool) -> live_set.Attempt:
    return live_set.Attempt(index, 0.0, length / SPB, 0.0, length, None, 0.0, complete=complete)


def test_default_attempt_is_the_last_complete_one_else_the_longest():
    a, b, c = _attempt(1, 30.0, True), _attempt(2, 12.0, False), _attempt(3, 31.0, True)
    assert live_set.default_attempt([a, b, c]) is c
    assert live_set.default_attempt([a, b]) is a
    # None complete: the longest, the later of two as long.
    short, long_, also = _attempt(1, 7.2, False), _attempt(2, 33.6, False), _attempt(3, 20.0, False)
    assert live_set.default_attempt([short, long_, also]) is long_
    tie = _attempt(4, 33.6, False)
    assert live_set.default_attempt([short, long_, tie]) is tie
    assert live_set.default_attempt([]) is None


# --- the guards -------------------------------------------------------------------


def test_a_set_saved_at_another_tempo_is_refused(tmp_path):
    song = _song(tmp_path)
    sess = _session(song, cover.Timing.straight)
    live_set.build_set(sess)
    _full_take(sess, tmp_path)
    _set_tempo_manual(sess.als, 100)
    want = r"saved at 100 BPM\. The video is built at 130 — set Live's tempo back to 130"
    with pytest.raises(StageError, match=want):
        live_set.attempts(sess)
    with pytest.raises(StageError, match=want):
        live_set.check_tempo(sess)
    _set_tempo_manual(sess.als, 130)
    live_set.check_tempo(sess)
    assert len(live_set.attempts(sess)) == 1

    # A tempo envelope that moves counts as well.
    root = live_set.load(sess.als)
    target = root.find("LiveSet/MainTrack/DeviceChain/Mixer/Tempo/AutomationTarget").get("Id")
    env = next(e for e in root.find("LiveSet/MainTrack/AutomationEnvelopes/Envelopes")
               if e.find("EnvelopeTarget/PointeeId").get("Value") == target)  # fmt: skip
    ET.SubElement(env.find("Automation/Events"), "FloatEvent", {"Id": "1", "Time": "64", "Value": "90"})
    live_set.save(root, sess.als)
    with pytest.raises(StageError, match="saved at 90 BPM"):
        live_set.check_tempo(sess)


@pytest.mark.parametrize("command", ["cover-attempts", "cover-mix", "cover-sync", "cover-render"])
def test_each_command_refuses_a_set_saved_at_another_tempo(tmp_path, monkeypatch, command):
    from typer.testing import CliRunner

    from pipeline import cli, cover_cli_mix, cover_cli_set, cover_cli_video

    song = _song(tmp_path)
    sess = _session(song, cover.Timing.straight)
    live_set.build_set(sess)
    _set_tempo_manual(sess.als, 112)
    for module in (cover_cli_set, cover_cli_mix, cover_cli_video):
        monkeypatch.setattr(module, "_resolve", lambda _: song)
    result = CliRunner().invoke(cli.app, [command, song.slug, "--name", sess.name])
    assert result.exit_code == 1
    assert "The set is saved at 112 BPM. The video is built at 130" in " ".join(result.output.split())


def _hold_like_live(path: Path):
    """Open ``path`` the way Live holds a recording: no sharing at all."""
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.restype = wintypes.HANDLE
    handle = kernel32.CreateFileW(str(path), 0x40000000, 0, None, 3, 0x80, None)  # GENERIC_WRITE, no share, OPEN_EXISTING
    assert handle not in (None, wintypes.HANDLE(-1).value), ctypes.get_last_error()
    return handle, kernel32


@pytest.mark.skipif(sys.platform != "win32", reason="Live's exclusive open is a Windows lock")
def test_a_recording_live_holds_is_a_clear_error_for_mix_and_sync(tmp_path):
    from pipeline import cover_cli_mix, cover_sync

    song = _song(tmp_path)
    sess = _session(song, cover.Timing.straight)
    live_set.build_set(sess)
    wav = _full_take(sess, tmp_path)
    sess.update("attempt", {"index": 1, "start_s": 0.0, "end_s": sf.info(str(wav)).duration, "audio": str(wav), "file_offset_s": 0.0})
    handle, kernel32 = _hold_like_live(wav)
    try:
        with pytest.raises(PermissionError):
            wav.read_bytes()
        for read in (lambda: cover_cli_mix.gather(sess, 48000), lambda: cover_sync.reference_for(sess)):
            with pytest.raises(StageError, match="Live is holding this session's recordings"):
                read()
    finally:
        kernel32.CloseHandle(handle)
    assert cover_cli_mix.gather(sess, 48000).rec.size
    assert cover_sync.reference_for(sess)[0] == wav


def test_the_kit_is_mixed_at_the_sd3_tracks_fader_not_sd3_recs(tmp_path):
    from pipeline import cover_cli_mix

    song = _song(tmp_path)
    sess = _session(song, cover.Timing.straight)
    live_set.build_set(sess)
    _full_take(sess, tmp_path)
    root = live_set.load(sess.als)
    for name, gain in ((live_set.SD3_TRACK, 1.5), (live_set.REC_TRACK, -20.0)):
        live_set._track(root, name).find("DeviceChain/Mixer/Volume/Manual").set("Value", str(10 ** (gain / 20)))
    live_set.save(root, sess.als)

    g = cover_cli_mix.gather(sess, 48000)
    assert g.kit_fader.gain_db == pytest.approx(1.5)
    kit = cover_cli_mix._kit_track(g, g.rec, 48000)
    assert kit.name == live_set.SD3_TRACK and kit.gain_db == pytest.approx(1.5)
    stems = {t.name: t for t in g.tracks}
    assert stems["drums"].gain_db == pytest.approx(live_set.FADERS_DB["drums"])
    assert stems["nodrums"].start_s == pytest.approx(sess.stem_start_beats * SPB)
    assert math.isclose(stems["click"].start_s, 0.0)
