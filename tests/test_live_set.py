"""The generated cover set, and reading record passes back out of a saved one.

These build from the real practice set (read-only; a test checks its bytes do
not change) into a fake song under tmp, with tiny generated wavs.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

import mido
import numpy as np
import pytest
import soundfile as sf

from pipeline import cover, live_set, paths

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
        for p in cover.backing(song, timing).values():
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


def _session(song: paths.Song, timing: cover.Timing) -> cover.Session:
    sess = cover.Session(song, f"t-{timing.value}")
    sess.ensure_dirs()
    sess.update("session", {"song": song.slug, "timing": timing.value, "name": sess.name})
    return sess


def _root(path: Path) -> ET.Element:
    return ET.fromstring(gzip.decompress(path.read_bytes()))


@pytest.mark.parametrize("timing", list(cover.Timing))
def test_built_set(tmp_path, timing):
    before = hashlib.sha256(live_set.TEMPLATE.read_bytes()).hexdigest()
    song = _song(tmp_path)
    sess = _session(song, timing)
    als = live_set.build_set(sess, timing)
    assert hashlib.sha256(live_set.TEMPLATE.read_bytes()).hexdigest() == before
    assert als == sess.als

    root = _root(als)
    tracks = [t for t in root.find("LiveSet/Tracks")]
    names = [live_set.track_name(t) for t in tracks]
    assert names[:5] == [live_set.SD3_TRACK, "nodrums", "drums", "click", live_set.REC_TRACK]
    assert [t.tag for t in tracks[5:]] == ["ReturnTrack", "ReturnTrack"]
    track_ids = [t.get("Id") for t in tracks]
    assert len(set(track_ids)) == len(track_ids)

    # SD3 untouched but for its clips: same plugin state as the template.
    template = live_set.load(live_set.TEMPLATE)
    def state(r):
        sd3 = next(t for t in r.find("LiveSet/Tracks") if live_set.track_name(t) == live_set.SD3_TRACK)
        return ET.tostring(sd3.find("DeviceChain/DeviceChain"))
    assert state(root) == state(template)

    by = dict(zip(names, tracks))
    for name in (live_set.SD3_TRACK, live_set.REC_TRACK):
        assert by[name].find("DeviceChain/MainSequencer/Recorder/IsArmed").get("Value") == "true"
    for name in ("nodrums", "drums", "click"):
        assert by[name].find("DeviceChain/MainSequencer/Recorder/IsArmed").get("Value") == "false"
    sd3_id = by[live_set.SD3_TRACK].get("Id")
    assert by[live_set.REC_TRACK].find("DeviceChain/AudioInputRouting/Target").get("Value") == (
        f"AudioIn/Track.{sd3_id}/PostFxOut"
    )

    # Exactly one clip each on the backing tracks, none anywhere else.
    clips = [c for c in root.iter() if c.tag in ("AudioClip", "MidiClip")
             and c not in set(root.find("LiveSet/GroovePool").iter())]
    assert len(clips) == 3
    backing = cover.backing(song, timing)
    for name, wav in backing.items():
        (clip,) = by[name].findall("DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events/AudioClip")
        ref = Path(clip.find("SampleRef/FileRef/Path").get("Value"))
        assert ref.exists() and ref.samefile(wav)
        rel = clip.find("SampleRef/FileRef/RelativePath").get("Value")
        assert (sess.root / rel).resolve() == wav.resolve()
        assert clip.find("IsWarped").get("Value") == "false"
        start = float(clip.find("CurrentStart").get("Value"))
        assert start == (0.0 if name == "click" else cover.stem_start_beats(timing))
        seconds = sf.info(str(wav)).duration
        assert float(clip.find("Loop/LoopEnd").get("Value")) == pytest.approx(seconds)
        assert float(clip.find("CurrentEnd").get("Value")) - start == pytest.approx(seconds / SPB)

    # Pointee ids unique and below NextPointeeId.
    ids = [int(e.get("Id")) for e in root.iter() if "Id" in e.attrib and live_set._is_pointee(e.tag)]
    assert len(ids) == len(set(ids))
    assert max(ids) < int(root.find("LiveSet/NextPointeeId").get("Value"))
    refs = {int(e.get("Value")) for e in root.iter("PointeeId")}
    assert refs <= set(ids) | {int(e.get("Id")) for e in root.iter() if "Id" in e.attrib}

    s = live_set.read_set(als)
    assert s.tempo == cover.LIVE_TEMPO
    assert root.find("LiveSet/Transport/LoopOn").get("Value") == "false"
    assert float(root.find("LiveSet/Transport/CurrentTime").get("Value")) == 0


def test_missing_stems_say_so(tmp_path):
    song = _song(tmp_path)
    cover.stretched(song, "drums").unlink()
    sess = _session(song, cover.Timing.straight)
    with pytest.raises(live_set.StageError, match="stretched-drums.wav"):
        live_set.build_set(sess, cover.Timing.straight)
    assert not sess.als.exists()


def test_refuses_to_write_into_ableton_projects(tmp_path):
    song = paths.Song("x", live_set.PROTECTED / "Projects" / "nope")
    with pytest.raises(live_set.StageError):
        live_set._guard(cover.Session(song, "s").als)


def test_faders_round_trip(tmp_path):
    song = _song(tmp_path)
    sess = _session(song, cover.Timing.original)
    als = live_set.build_set(sess, cover.Timing.original)
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
    assert faders["nodrums"].gain_db == pytest.approx(
        20 * math.log10(float(live_set.load(live_set.TEMPLATE).find(
            "LiveSet/Tracks/AudioTrack/DeviceChain/Mixer/Volume/Manual").get("Value"))), abs=1e-6)


def _performance(start_s: float, bars: int, seed: int):
    """Kicks and hats with CC4 moving and one choked crash, in arrangement seconds."""
    rng = np.random.default_rng(seed)
    bar_one = 0.5
    notes, ccs, touch = [], [], []
    for k in range(bars * 4):
        t = bar_one + k * SPB + float(rng.uniform(-0.01, 0.01))
        notes.append((t, 36, int(rng.integers(60, 127)), 0.1))
        notes.append((t + SPB / 2, 42, int(rng.integers(30, 90)), 0.05))
        ccs.append((t + 0.02, 4, int(rng.integers(0, 127))))
    crash = bar_one + (bars * 4 - 1) * SPB
    notes.append((crash, 49, 120, 0.5))
    touch += [(crash + 0.2, 49, 127), (crash + 0.3, 49, 0)]
    return [n for n in notes if n[0] >= start_s], ccs, touch


def test_attempts_from_recorded_passes(tmp_path):
    song = _song(tmp_path)
    sess = _session(song, cover.Timing.original)
    live_set.build_set(sess, cover.Timing.original)

    # A false start that stops in bar 3, then a full take, both from 1|1|1.
    short = _performance(0.0, 2, seed=1)
    full = _performance(0.0, BARS, seed=2)
    wav1 = live_set.add_recorded_attempt(
        sess, _wav(tmp_path / "a.wav", 0.5 + 2.5 * 4 * SPB), 0.0, *short, when=datetime(2026, 10, 26, 20, 0, 0)
    )
    wav2 = live_set.add_recorded_attempt(
        sess, _wav(tmp_path / "b.wav", 0.5 + (BARS + 0.5) * 4 * SPB), 0.0, *full, when=datetime(2026, 10, 26, 20, 1, 0)
    )
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


def test_main_lane_clip_without_take_lane_is_a_pass(tmp_path):
    """A main-lane clip no take lane holds (lanes deleted) still counts."""
    song = _song(tmp_path)
    sess = _session(song, cover.Timing.original)
    live_set.build_set(sess, cover.Timing.original)
    live_set.add_recorded_attempt(sess, _wav(tmp_path / "a.wav", 20.0), 0.0, *_performance(0.0, BARS, 3))
    root = live_set.load(sess.als)
    for name in (live_set.REC_TRACK, live_set.SD3_TRACK):
        lanes = live_set._track(root, name).find("TakeLanes/TakeLanes")
        for lane in list(lanes):
            lanes.remove(lane)
    live_set.save(root, sess.als)
    (only,) = live_set.attempts(sess)
    assert only.complete and only.audio is not None and only.notes
