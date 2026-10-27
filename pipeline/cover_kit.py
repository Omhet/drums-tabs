"""Kits for re-rendering a cover take, and the offline render that uses them.

A kit here is one Superior Drummer 3 state file under ``kit/cover-kits/``
(:func:`pipeline.cover.kit_state`). There are three ways to get one:

* :func:`pick` -- open SD3's own window, choose, close. The same flow as
  ``drums kit-pick`` (:func:`pipeline.bake.pick_kit`), saved under a name.
* :func:`kit_from_als` -- read the SD3 instance out of a saved Live set. Live
  keeps a VST3 plugin's state as the raw bytes the plugin's ``getState``
  handed it (``ProcessorState`` / ``ControllerState``, hex). DawDreamer is
  JUCE, and JUCE's VST3 host saves state as its own wrapper around those same
  bytes, so converting is re-wrapping, not translating -- see
  :func:`juce_vst3_state`.
* copying ``kit/render/plugin.state`` -- the kit the app's sampler was baked
  from.

:func:`render_midi` plays notes, controllers and aftertouch (cymbal chokes)
through SD3 offline with one of those kits. Every controller a take carries
goes through, whatever its number: the TD-27 sends more than the hi-hat pedal.
The user's first real session (``covers/dev-s``) has CC 4 (the hi-hat pedal's
opening), 16, 18, 19, 83 and 88; the everyday practice set's own recordings add
CC 17 and polyphonic aftertouch. Nothing here filters by number -- the attempt
reads every ``ControllerTargets`` envelope, :func:`midi_file` writes each
event, and DawDreamer is asked for all events, not only notes.
"""

from __future__ import annotations

import gzip
import re
import shutil
import struct
import tempfile
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import mido
import numpy as np

from pipeline import bake, cover
from pipeline.proc import StageError

Log = bake.Log

DEFAULT_PLUGIN = "C:/Program Files/Common Files/VST3/Toontrack/Superior Drummer 3.vst3"

#: SD3's kick, the note every proof render plays.
PROOF_NOTE = 36

#: Where the MIDI is laid out for DawDreamer. 120 BPM and a fine resolution, so
#: one tick is 52 microseconds -- far below a sample's worth of timing at 48 kHz
#: once rounded by the engine.
_MIDI_TEMPO_US = 500_000
_MIDI_TPB = 9600


# --- JUCE's VST3 state format -----------------------------------------------
#
# What `processor.save_state` writes for a VST3 plugin, and `load_state` reads:
#
#   "VC2!"  uint32 LE (bytes that follow, minus the trailing NUL)
#   <?xml version="1.0" encoding="UTF-8"?> <VST3PluginState>
#     <IComponent>N.xxxx</IComponent> <IEditController>N.xxxx</IEditController>
#   </VST3PluginState> NUL
#
# where N.xxxx is JUCE's MemoryBlock::toBase64Encoding: the byte count, a dot,
# then the bytes read as one little-endian bit stream, six bits a character,
# from JUCE's own alphabet (not RFC 4648's). Checked byte-for-byte against a
# state DawDreamer saved (tests/test_cover_mix.py).

_JUCE_B64 = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+"
_JUCE_MAGIC = b"VC2!"


def juce_base64(data: bytes) -> str:
    n = len(data)
    chars = ((n << 3) + 5) // 6
    bits = np.unpackbits(np.frombuffer(data, dtype=np.uint8), bitorder="little")
    bits = np.concatenate([bits, np.zeros(chars * 6 - bits.size, dtype=np.uint8)])
    values = bits.reshape(-1, 6) @ (1 << np.arange(6))
    table = np.frombuffer(_JUCE_B64.encode("ascii"), dtype=np.uint8)
    return f"{n}." + table[values].tobytes().decode("ascii")


def juce_unbase64(text: str) -> bytes:
    count, _, body = text.strip().partition(".")
    n = int(count)
    lut = np.zeros(256, dtype=np.uint8)
    lut[np.frombuffer(_JUCE_B64.encode("ascii"), dtype=np.uint8)] = np.arange(64, dtype=np.uint8)
    values = lut[np.frombuffer(body.encode("ascii"), dtype=np.uint8)]
    bits = np.unpackbits(values[:, None], axis=1, bitorder="little")[:, :6].reshape(-1)
    return np.packbits(bits[: n * 8], bitorder="little").tobytes()


def juce_vst3_state(component: bytes, controller: bytes = b"") -> bytes:
    """Wrap a VST3 plugin's raw state the way JUCE's host does."""
    body = "<VST3PluginState>"
    body += f"<IComponent>{juce_base64(component)}</IComponent>"
    if controller:
        body += f"<IEditController>{juce_base64(controller)}</IEditController>"
    body += "</VST3PluginState>"
    text = ('<?xml version="1.0" encoding="UTF-8"?> ' + body).encode("utf-8") + b"\x00"
    return _JUCE_MAGIC + struct.pack("<I", len(text) - 1) + text


def read_juce_vst3_state(blob: bytes) -> dict[str, bytes]:
    """The raw chunks inside a JUCE VST3 state, by element name."""
    if blob[:4] != _JUCE_MAGIC:
        raise StageError("not a JUCE plugin state (no VC2! header)")
    (length,) = struct.unpack("<I", blob[4:8])
    text = blob[8 : 8 + length].decode("utf-8")
    return {tag: juce_unbase64(value) for tag, value in re.findall(r"<(\w+)>([^<]+)</\1>", text)}


# --- getting a kit -----------------------------------------------------------


def _hex(element: ET.Element | None) -> bytes:
    if element is None or not (element.text or "").strip():
        return b""
    return bytes.fromhex(re.sub(r"\s+", "", element.text))


def als_plugin_state(als_path: Path, track_name: str) -> tuple[bytes, bytes]:
    """The VST3 ``ProcessorState`` and ``ControllerState`` of a track's plugin.

    Only reads the set. The first VST3 device on the named MIDI track is taken.
    """
    try:
        root = ET.fromstring(gzip.open(als_path).read())
    except (OSError, ET.ParseError) as exc:
        raise StageError(f"could not read {als_path}: {exc}") from exc
    names = []
    for track in root.iter("MidiTrack"):
        name = track.find("Name/EffectiveName")
        names.append(name.get("Value") if name is not None else "?")
        if name is None or name.get("Value") != track_name:
            continue
        for preset in track.iter("Vst3Preset"):
            component = _hex(preset.find("ProcessorState"))
            if component:
                return component, _hex(preset.find("ControllerState"))
        raise StageError(f"{track_name!r} in {als_path.name} has no VST3 plugin with a state")
    raise StageError(f"no MIDI track {track_name!r} in {als_path.name} (has: {', '.join(names)})")


def kit_from_als(als_path: Path, track_name: str, out_name: str) -> Path:
    """Save the plugin state of a Live track as the cover kit ``out_name``."""
    component, controller = als_plugin_state(Path(als_path), track_name)
    out = cover.kit_state(out_name)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(juce_vst3_state(component, controller))
    return out


def kit_from_bake(out_name: str) -> Path:
    """The kit the app's sampler was baked from, as a cover kit."""
    if not bake.STATE.exists():
        raise StageError(f"no {bake.STATE}; run `drums kit-pick` first")
    out = cover.kit_state(out_name)
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(bake.STATE, out)
    return out


def _processor(plugin: str, log: Log):
    try:
        import dawdreamer as daw
    except ImportError as exc:  # pragma: no cover - the dependency is declared
        raise StageError("dawdreamer is not installed; run `uv sync`") from exc
    if not Path(plugin).exists():
        raise StageError(f"no plugin at {plugin}")
    engine = daw.RenderEngine(bake.SR, 512)
    log(f"loading {Path(plugin).stem}...")
    try:
        processor = engine.make_plugin_processor("kit", plugin)
    except Exception as exc:  # noqa: BLE001 - the plugin's own failure, verbatim
        raise StageError(f"the plugin would not load: {exc}") from exc
    return engine, processor


def pick(name: str, plugin: str = DEFAULT_PLUGIN, log: Log = print) -> Path:
    """Choose a kit in SD3's window and keep it as the cover kit ``name``.

    :func:`pipeline.bake.pick_kit`'s flow -- start from the last choice, open
    the editor, prove four kicks sound with it closed, then save -- writing to
    ``kit/cover-kits/<name>.state`` instead of the sampler's state.
    """
    engine, processor = _processor(plugin, log)
    out = cover.kit_state(name)
    start = out if out.exists() else bake.STATE
    if start.exists():
        try:
            processor.load_state(str(start))
        except Exception:  # noqa: BLE001 - it is about to be replaced
            log("  (the saved state would not load; starting from the plugin's default)")

    log("opening the plugin's window -- choose a kit, then close the window")
    processor.open_editor()
    processor.clear_midi()
    for i in range(4):
        processor.add_midi_note(PROOF_NOTE, 110, 0.2 + i * 0.5, bake.NOTE_LEN_S)
    engine.load_graph([(processor, [])])
    engine.render(2.5)
    peak = float(np.abs(engine.get_audio()).max())
    if peak < bake.SILENT_PEAK:
        raise StageError(
            "the window closed but the plugin still renders silence.\n"
            f"Nothing has been saved. Run `drums cover-kit {name}` again and make sure\n"
            "a kit is loaded and showing in the window before you close it."
        )
    log(f"  it sounds with the window closed (peak {peak:.3f})")
    out.parent.mkdir(parents=True, exist_ok=True)
    processor.save_state(str(out))
    return out


# --- rendering ----------------------------------------------------------------


@dataclass(frozen=True)
class Note:
    start_s: float
    duration_s: float
    pitch: int
    velocity: int


@dataclass(frozen=True)
class Controller:
    """A control event. ``kind`` is ``cc`` (``number`` is the controller, any of
    0-127: 4 is the hi-hat pedal), ``polytouch`` (``number`` is the note: SD3's
    cymbal choke) or ``aftertouch`` (channel pressure, ``number`` unused)."""

    time_s: float
    kind: str
    number: int
    value: int


def midi_file(notes: Iterable[Note], controllers: Iterable[Controller], path: Path) -> None:
    """Lay the events out on a 120 BPM file, in seconds, for DawDreamer."""
    per_s = _MIDI_TPB * 1_000_000 / _MIDI_TEMPO_US
    events: list[tuple[int, int, mido.Message]] = []
    # At one tick, offs go before controllers before ons, so a retrigger and a
    # pedal move that land together reach the plugin in a sensible order.
    for n in notes:
        on = max(0, round(n.start_s * per_s))
        off = max(on + 1, round((n.start_s + max(n.duration_s, 0.01)) * per_s))
        vel = int(np.clip(n.velocity, 1, 127))
        events.append((on, 2, mido.Message("note_on", note=n.pitch, velocity=vel)))
        events.append((off, 0, mido.Message("note_off", note=n.pitch, velocity=0)))
    for c in controllers:
        tick = max(0, round(c.time_s * per_s))
        value = int(np.clip(c.value, 0, 127))
        if c.kind == "cc":
            msg = mido.Message("control_change", control=c.number, value=value)
        elif c.kind == "polytouch":
            msg = mido.Message("polytouch", note=c.number, value=value)
        elif c.kind == "aftertouch":
            msg = mido.Message("aftertouch", value=value)
        else:
            raise StageError(f"unknown controller kind {c.kind!r}")
        events.append((tick, 1, msg))
    events.sort(key=lambda e: (e[0], e[1]))

    track = mido.MidiTrack([mido.MetaMessage("set_tempo", tempo=_MIDI_TEMPO_US, time=0)])
    last = 0
    for tick, _, msg in events:
        track.append(msg.copy(time=tick - last))
        last = tick
    out = mido.MidiFile(ticks_per_beat=_MIDI_TPB)
    out.tracks.append(track)
    out.save(str(path))


class Renderer:
    """SD3 loaded with one kit and awake, for rendering MIDI more than once."""

    def __init__(self, kit_name: str, plugin: str = DEFAULT_PLUGIN, log: Log = print):
        state = cover.kit_state(kit_name)
        if not state.exists():
            raise StageError(
                f"no kit {kit_name!r} at {state}.\n"
                f"Run `drums cover-kit {kit_name}` to choose one in SD3's window."
            )
        self.kit = kit_name
        self.session = bake.Session(plugin, state, PROOF_NOTE, log=log)

    @property
    def latency_samples(self) -> int:
        return int(self.session.processor.get_latency_samples())

    def render(
        self,
        notes: Iterable[Note],
        controllers: Iterable[Controller],
        duration_s: float,
        sr: int = 48000,
    ) -> np.ndarray:
        """Stereo (2, frames) at ``sr``, sample 0 at time 0 of the events."""
        processor, engine = self.session.processor, self.session.engine
        lag = self.latency_samples
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "take.mid"
            midi_file(notes, controllers, path)
            processor.clear_midi()
            processor.load_midi(str(path), clear_previous=True, beats=False, all_events=True)
        engine.render(duration_s + lag / bake.SR)
        audio = np.asarray(engine.get_audio()[:2], dtype=np.float32)
        audio = audio[:, lag : lag + int(round(duration_s * bake.SR))]
        if sr != bake.SR:
            from math import gcd

            from scipy.signal import resample_poly

            g = gcd(sr, bake.SR)
            audio = resample_poly(audio, sr // g, bake.SR // g, axis=1).astype(np.float32)
        return audio


def render_midi(
    notes: Iterable[Note],
    controllers: Iterable[Controller],
    kit_name: str,
    duration_s: float,
    sr: int = 48000,
    plugin: str = DEFAULT_PLUGIN,
    log: Log = print,
) -> np.ndarray:
    """Play events through SD3 with a cover kit, offline. Stereo (2, frames)."""
    return Renderer(kit_name, plugin, log).render(notes, controllers, duration_s, sr)
