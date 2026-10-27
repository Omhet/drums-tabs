"""The cover mix, its timing report, and the kit state conversion.

All synthetic and fast: no plugin is loaded here. The real SD3 checks -- both
kits sound, differ, and land on their notes -- need the plugin and a window,
and are run by hand.
"""

from __future__ import annotations

import gzip
import struct

import numpy as np
import pytest

from pipeline import bake, cover_kit, cover_mix
from pipeline.cover_mix import MixSettings, TrackIn

SR = 48000
RNG = np.random.default_rng(7)


def hits(times, sr=SR, length_s=6.0, freq=60.0, decay=0.08, noise=0.0):
    """Decaying sine bursts at the given times: a kick-ish drum."""
    out = np.zeros(int(length_s * sr), dtype=np.float32)
    n = int(0.4 * sr)
    t = np.arange(n) / sr
    burst = np.sin(2 * np.pi * freq * t) * np.exp(-t / decay)
    if noise:
        burst = burst + noise * RNG.standard_normal(n) * np.exp(-t / (decay / 2))
    for at in times:
        i = int(round(at * sr))
        out[i : i + n] += burst[: out.size - i]
    return out


def pink(n, tilt=1.0):
    """Noise with a 1/f**tilt power spectrum."""
    spec = np.fft.rfft(RNG.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    spec[1:] /= f[1:] ** (tilt / 2)
    spec[0] = 0
    y = np.fft.irfft(spec, n)
    return (y / np.abs(y).max() * 0.3).astype(np.float32)


def kit_and_song(seconds=8.0):
    beats = np.arange(0.5, seconds - 0.5, 0.5)
    kit = hits(beats, length_s=seconds, noise=0.3)
    song = pink(int(seconds * SR)) * 0.5
    return kit, song


# --- the mix ---------------------------------------------------------------------


def test_the_click_is_never_in_the_mix():
    kit, song = kit_and_song()
    click = hits(np.arange(0.25, 7.5, 0.5), length_s=8.0, freq=2000.0, decay=0.01)
    base = [
        TrackIn("SD3 rec", "kit", kit, SR),
        TrackIn("nodrums", "song", song, SR, gain_db=-3.0),
    ]
    settings = MixSettings(loudness=False, limiter=False, room=False, glue=False)
    without, _ = cover_mix.mix(base, settings, None)
    with_click, _ = cover_mix.mix(base + [TrackIn("click", "click", click * 10, SR)], settings, None)
    assert np.array_equal(without, with_click)


def test_loudness_comes_out_at_minus_14_with_the_chain_on():
    kit, song = kit_and_song()
    tracks = [TrackIn("SD3 rec", "kit", kit, SR), TrackIn("nodrums", "song", song, SR)]
    out, _ = cover_mix.mix(tracks, MixSettings(), kit * 0.5)
    assert cover_mix.loudness(out, SR) == pytest.approx(-14.0, abs=0.5)
    assert cover_mix.true_peak_db(out) <= -1.0 + 1e-3


def test_drums_shift_moves_the_kit_and_only_the_kit():
    one = np.zeros(SR * 2, dtype=np.float32)
    one[SR] = 1.0
    settings = MixSettings(drums_shift_ms=12.0, loudness=False, limiter=False).dry()
    out, dry = cover_mix.mix(
        [TrackIn("SD3 rec", "kit", one, SR, start_s=0.5), TrackIn("nodrums", "song", one * 0.5, SR)],
        settings,
        None,
    )
    assert int(np.argmax(dry[0])) == int(round((1.5 + 0.012) * SR))
    peaks = np.flatnonzero(out[0] > 0.25)
    assert set(peaks) == {SR, int(round((1.5 + 0.012) * SR))}


@pytest.mark.parametrize("fader_db", [-6.0, 1.5])
def test_the_kit_sits_at_its_fader_whatever_the_drum_stem(fader_db):
    """The faders are the balance the user set: nothing is matched over them,
    not even at the fader a new set starts at."""
    kit, song = kit_and_song()
    settings = MixSettings(loudness=False, limiter=False, room=False, glue=False, song_dip=False)
    settings.tone_match = settings.bus_comp = settings.hpf = False
    loud_stem = kit * 10.0
    out, _ = cover_mix.mix([TrackIn("1-Superior Drummer 3", "kit", kit, SR, gain_db=fader_db)], settings, loud_stem)
    at_unity = cover_mix.loudness(np.stack([kit, kit]), SR)
    assert cover_mix.loudness(out, SR) == pytest.approx(at_unity + fader_db, abs=0.05)


def test_tone_match_is_clamped_and_moves_the_kit_toward_the_record():
    n = SR * 6
    kit = pink(n, tilt=0.0)  # white
    record = pink(n, tilt=2.0)  # steep: tens of dB from the kit at the ends
    curve = cover_mix.tone_curve(kit[None], record[None], SR, amount=0.5, max_db=6.0)
    assert np.all(np.abs(curve) <= 6.0 + 1e-9)
    assert np.abs(curve).max() == pytest.approx(6.0)

    matched = cover_mix.apply_fir(kit[None], cover_mix.tone_fir(curve, SR))
    target = cover_mix.band_levels(record[None], SR)
    before = np.abs(cover_mix.band_levels(kit[None], SR) - target).mean()
    after = np.abs(cover_mix.band_levels(matched, SR) - target).mean()
    assert after < before - 3.0


def test_the_tone_match_does_not_move_a_hit():
    one = np.zeros(SR, dtype=np.float32)
    one[SR // 2] = 1.0
    curve = np.linspace(-6, 6, cover_mix.BAND_CENTRES.size)
    out = cover_mix.apply_fir(one[None], cover_mix.tone_fir(curve, SR))
    assert int(np.argmax(np.abs(out[0]))) == SR // 2


def test_settings_reject_a_misspelt_key():
    with pytest.raises(ValueError, match="tone_amout"):
        MixSettings.from_toml({"tone_amout": 0.3})
    assert MixSettings.from_toml({"tone_amount": 0.3}).tone_amount == 0.3


# --- timing --------------------------------------------------------------------------


def test_timing_report_recovers_a_planted_lateness():
    seconds = 40.0
    beats = np.arange(0.5, seconds - 1, 0.5)
    kicks, snares = beats[::2], beats[1::2]

    def drums(late_s, jitter_s):
        j = lambda t: t + late_s + RNG.normal(0, jitter_s, t.size)  # noqa: E731
        # A beater's click on the front, as a real kick has: a bare sine's
        # envelope says little about where it starts.
        kick = hits(j(kicks), length_s=seconds, freq=55.0, noise=0.5, decay=0.06)
        snare = hits(j(snares), length_s=seconds, freq=300.0, decay=0.05, noise=0.4)
        return kick + snare

    record = drums(0.0, 0.0)
    player = drums(0.015, 0.003)
    rows = {r.instrument: r for r in cover_mix.timing_report(player, record, SR)}
    for name in ("kick", "snare"):
        assert rows[name].matched >= 15
        assert rows[name].vs_record_ms == pytest.approx(15.0, abs=2.0)

    # The same question through the chart: the record sits 4 ms late on it.
    chart = {"kick": kicks - 0.004, "snare": snares - 0.004}
    rows = cover_mix.timing_report(player, record, SR, chart=chart, floor_ms={"kick": 4.0, "snare": 4.0})
    for row in rows:
        assert row.vs_chart_ms == pytest.approx(19.0, abs=2.0)
        assert row.vs_record_via_chart_ms == pytest.approx(15.0, abs=2.0)
        assert row.vs_record_ms == pytest.approx(15.0, abs=2.0)  # note by note, through the chart


def test_matched_offsets_drop_a_hit_with_no_partner():
    got = cover_mix.matched_offsets(np.array([1.010, 5.0]), np.array([1.0, 3.0]))
    assert got == pytest.approx([10.0])


# --- the kit state ----------------------------------------------------------------------


def test_juce_base64_round_trips_and_matches_juces_alphabet():
    data = bytes(RNG.integers(0, 256, 1001, dtype=np.uint8))
    assert cover_kit.juce_unbase64(cover_kit.juce_base64(data)) == data
    # JUCE writes the bytes as one little-endian bit stream: 0x01 -> 'A' then '.'.
    assert cover_kit.juce_base64(b"\x01") == "1.A."


@pytest.mark.skipif(not bake.STATE.exists(), reason="no state saved by DawDreamer on this machine")
def test_the_wrapper_reproduces_a_state_dawdreamer_saved_byte_for_byte():
    blob = bake.STATE.read_bytes()
    chunks = cover_kit.read_juce_vst3_state(blob)
    assert cover_kit.juce_vst3_state(chunks["IComponent"], chunks.get("IEditController", b"")) == blob


def _als_with(component: bytes, controller: bytes = b"") -> bytes:
    hexed = component.hex().upper()
    rows = "\n".join(hexed[i : i + 80] for i in range(0, len(hexed), 80))
    ctrl = f"<ControllerState>{controller.hex().upper()}</ControllerState>" if controller else "<ControllerState />"
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Ableton><LiveSet><Tracks>
<AudioTrack><Name><EffectiveName Value="nodrums" /></Name></AudioTrack>
<MidiTrack><Name><EffectiveName Value="1-Superior Drummer 3" /></Name>
<DeviceChain><DeviceChain><Devices><PluginDevice><PluginDesc><Vst3PluginInfo><Preset><Vst3Preset>
<ProcessorState>
{rows}
</ProcessorState>
{ctrl}
</Vst3Preset></Preset></Vst3PluginInfo></PluginDesc></PluginDevice></Devices></DeviceChain></DeviceChain>
</MidiTrack></Tracks></LiveSet></Ableton>"""
    return gzip.compress(xml.encode("utf-8"))


def test_a_live_set_plugin_state_becomes_a_juce_state(tmp_path, monkeypatch):
    component = b"VstW\x00\x00\x00\x08" + bytes(RNG.integers(0, 256, 3000, dtype=np.uint8))
    als = tmp_path / "set.als"
    als.write_bytes(_als_with(component, b"ctl"))
    monkeypatch.setattr(cover_kit.cover, "KITS_DIR", tmp_path / "kits")

    out = cover_kit.kit_from_als(als, "1-Superior Drummer 3", "practice")
    blob = out.read_bytes()
    assert out == tmp_path / "kits" / "practice.state"
    assert blob[:4] == b"VC2!"
    assert struct.unpack("<I", blob[4:8])[0] == len(blob) - 9
    assert cover_kit.read_juce_vst3_state(blob) == {"IComponent": component, "IEditController": b"ctl"}

    with pytest.raises(Exception, match="no MIDI track 'Drums'"):
        cover_kit.kit_from_als(als, "Drums", "x")


def test_midi_file_keeps_the_times_and_the_controllers(tmp_path):
    import mido

    notes = [cover_kit.Note(0.5, 0.1, 36, 100), cover_kit.Note(1.25, 0.1, 42, 80)]
    ctl = [cover_kit.Controller(1.0, "cc", 4, 127), cover_kit.Controller(2.0, "polytouch", 49, 127)]
    path = tmp_path / "t.mid"
    cover_kit.midi_file(notes, ctl, path)
    got, now = [], 0.0
    for msg in mido.MidiFile(path):
        now += msg.time
        if not msg.is_meta:
            got.append((round(now, 4), msg.type))
    assert (0.5, "note_on") in got and (1.25, "note_on") in got
    assert (1.0, "control_change") in got and (2.0, "polytouch") in got
