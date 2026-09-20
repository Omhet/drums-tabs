"""A bank of one-shots, rendered out of a drum plugin and sliced up.

What the app plays for an exercise -- and for a song's written part, over the
nodrums stem -- is ``kit/samples/``: a few hundred short files, several velocity
layers and several takes of each, so that a ghost note is a different recording
from a backbeat and the same hi-hat twice is two different hi-hats. This is
where they come from.

**No DAW is involved.** DawDreamer hosts the plugin offline -- no window, no
audio device, faster than real time -- and the audio comes back as an array
that never reaches disk. One command renders, slices, encodes and writes the
manifest.

The one thing that cannot be automated is *which kit*. That lives inside the
plugin's own saved state rather than in any parameter, so ``drums kit-pick``
opens the plugin's window once, you choose, and the state is written to
``kit/render/plugin.state``. That is the only time anyone has to look at the
plugin.

**Restoring that state needs the plugin's message loop**, which is the one
thing an offline host never runs. Superior Drummer boots with no kit, and
handing it the saved state changes nothing on its own -- it renders silence,
for as long as you care to wait, because the load it queued never gets
serviced. Opening its editor is what pumps that loop. So :func:`wake` opens the
window and closes it again from a watchdog thread a few seconds later, with
nobody touching it, and then checks that the plugin actually makes a sound
before a nine-minute render is started on the strength of it. A window does
flash up during a bake; that is this, and it is not waiting for you.

Nothing here is committed. The bank is rebuilt from software on this machine,
so ``kit/`` is ignored -- see ``.gitignore`` and ``kit.toml``'s ``[render]``.

Two things the layout is careful about:

* **A zero mark.** The render opens with one loud hit and two seconds of
  silence. A plugin may report latency, or begin a hair late; the slicer finds
  that first onset and measures everything from it, so the cuts cannot drift.
* **One gain for the whole bank.** Samples are *not* normalised individually.
  The whole point of rendering ten velocity layers is that they differ in
  loudness, and normalising each one would throw exactly that away.
"""

from __future__ import annotations

import ctypes
import json
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import soundfile as sf

from pipeline.kit import Kit, Render
from pipeline.paths import REPO_ROOT
from pipeline.proc import StageError

KIT_DIR = REPO_ROOT / "kit"
SAMPLES_DIR = KIT_DIR / "samples"
RENDER_DIR = KIT_DIR / "render"
AUDITION_DIR = RENDER_DIR / "audition"
MANIFEST = KIT_DIR / "kit.lock.json"
STATE = RENDER_DIR / "plugin.state"
PLAN = RENDER_DIR / "plan.json"

SR = 44100

#: Where the zero mark sits, and how long the silence after it lasts.
MARK_AT_S = 1.0
MARK_GAP_S = 2.0
#: How long each note is held. Drums ignore it; an open hi-hat might not.
NOTE_LEN_S = 0.1
#: Guaranteed silence after every tail, so no slice can catch the next attack.
GAP_S = 0.4
#: A hair before the attack, in case the plugin starts a note fractionally early.
LEAD_S = 0.02
#: Anything quieter than this much of a slice's peak is the tail, and is cut.
FLOOR = 0.004
#: A short fade at the cut, so trimming cannot leave a click of its own.
FADE_S = 0.01
#: The loudest sample in the bank ends up here, leaving room for a crash and a
#: kick and a snare to land together without the sum clipping.
HEADROOM_DB = -6.0
#: Below this a slice is silence, not a quiet drum, and something is wrong.
SILENT_PEAK = 1e-4
#: How long to hold the plugin's window open so it can finish loading its kit.
#: Ten seconds is enough for the Core Library; a heavier kit gets the later
#: tries. Each one costs only what it says, and only when the one before failed.
WAKE_HOLDS_S = (10.0, 25.0, 45.0)
WM_CLOSE = 0x0010

Log = Callable[[str], None]


@dataclass(frozen=True)
class Slot:
    """One sample to render: one strike, at one velocity, at one moment."""

    articulation: str
    instrument: str
    note: int
    #: Index into the articulation's velocity layers, quietest first.
    layer: int
    velocity: int
    #: Which take of this layer. The plugin cycles its own round-robins, so
    #: asking for the same thing four times running is what varies them.
    rr: int
    at_s: float
    tail_s: float
    stereo: bool

    @property
    def stem(self) -> str:
        return f"{self.articulation}/{self.layer}-{self.rr}"


@dataclass(frozen=True)
class Plan:
    """Everything the render will contain, and where."""

    slots: tuple[Slot, ...]
    mark_note: int
    duration_s: float

    def to_json(self) -> dict:
        return {
            "sampleRate": SR,
            "markNote": self.mark_note,
            "markAtS": MARK_AT_S,
            "durationS": round(self.duration_s, 3),
            "slots": [
                {
                    "articulation": s.articulation,
                    "instrument": s.instrument,
                    "note": s.note,
                    "layer": s.layer,
                    "velocity": s.velocity,
                    "rr": s.rr,
                    "atS": round(s.at_s, 4),
                    "tailS": s.tail_s,
                    "stereo": s.stereo,
                }
                for s in self.slots
            ],
        }


@dataclass
class Cut:
    """One sliced sample, before the bank's gain is applied."""

    slot: Slot
    #: Shape (channels, frames). One channel unless the articulation is stereo.
    data: np.ndarray
    peak: float

    @property
    def seconds(self) -> float:
        return self.data.shape[1] / SR


def build_plan(render: Render, only: str | None = None, smoke: bool = False) -> Plan:
    """Lay every sample out on a timeline, with room to ring between them."""
    articulations = list(render.articulations.values())
    if only is not None:
        if only not in render.articulations:
            known = ", ".join(sorted(render.articulations))
            raise StageError(
                f"kit.toml has no [render.articulation.{only}] (it has: {known})"
            )
        articulations = [render.articulations[only]]
    if not articulations:
        raise StageError("kit.toml has no [render.articulation.*] to render")

    if smoke:
        # Enough to prove the plugin makes sound and the slicing lands, and
        # short enough that finding out costs half a minute.
        articulations = articulations[:3]

    slots: list[Slot] = []
    at = MARK_AT_S + MARK_GAP_S
    for art in articulations:
        velocities = render.velocities(art)
        layers = range(min(2, art.layers)) if smoke else range(art.layers)
        takes = min(2, art.round_robin) if smoke else art.round_robin
        for layer in layers:
            for rr in range(takes):
                slots.append(
                    Slot(
                        articulation=art.name,
                        instrument=art.instrument,
                        note=art.note,
                        layer=layer,
                        velocity=velocities[layer],
                        rr=rr,
                        at_s=at,
                        tail_s=art.tail_s,
                        stereo=art.stereo,
                    )
                )
                at += art.tail_s + GAP_S

    return Plan(
        slots=tuple(slots),
        mark_note=articulations[0].note,
        duration_s=at + 1.0,
    )


def _editor_windows(needle: str = "DawDreamer") -> list[int]:
    """Whatever windows the plugin host has put on screen."""
    user32 = ctypes.windll.user32
    proc = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
    found: list[int] = []

    def visit(hwnd, _):
        length = user32.GetWindowTextLengthW(hwnd)
        if length:
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            if needle.lower() in buf.value.lower():
                found.append(hwnd)
        return 1

    user32.EnumWindows(proc(visit), 0)
    return found


def _close_editor_after(seconds: float, log: Log) -> threading.Thread:
    """Shut the plugin's window without anybody clicking anything."""

    def run():
        time.sleep(seconds)
        user32 = ctypes.windll.user32
        for _ in range(60):
            windows = _editor_windows()
            if windows:
                for hwnd in windows:
                    user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
                return
            time.sleep(0.25)
        log("  (could not find the plugin's window to close it)")

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


def wake(engine, processor, note: int, log: Log = print) -> None:
    """Make the plugin honour the state it was given, and prove that it did.

    Opening the editor is the only thing in an offline host that runs the
    plugin's message loop, and Superior Drummer needs that loop to finish
    loading a kit -- so the window goes up, a watchdog closes it, and a single
    note says whether it worked. Nobody has to be at the keyboard.
    """
    for attempt, hold in enumerate(WAKE_HOLDS_S, start=1):
        log(f"  waking the plugin ({hold:.0f}s)...")
        _close_editor_after(hold, log)
        processor.open_editor()

        processor.clear_midi()
        processor.add_midi_note(note, 115, 0.2, NOTE_LEN_S)
        engine.render(1.5)
        peak = float(np.abs(engine.get_audio()).max())
        if peak > SILENT_PEAK:
            log(f"  awake (peak {peak:.3f})")
            return
        if attempt < len(WAKE_HOLDS_S):
            log("  still silent; giving it longer")

    raise StageError(
        "the plugin still renders silence after being woken.\n"
        "It loaded, it took the notes, and it made no sound -- which means the\n"
        "state it was given has no kit in it. Run `drums kit-pick` again and make\n"
        "sure a kit is loaded and showing in the window before you close it."
    )


class Session:
    """A plugin, loaded and awake, that can be rendered through more than once.

    A session rather than a function because waking costs ten seconds and puts
    a window on the screen, and a bake renders twice -- the smoke pass and then
    the real thing. Doing that twice over was twenty seconds and two windows
    for no reason.
    """

    def __init__(self, plugin: str, state: Path, note: int, log: Log = print):
        try:
            import dawdreamer as daw
        except ImportError as exc:  # pragma: no cover - the dependency is declared
            raise StageError("dawdreamer is not installed; run `uv sync`") from exc

        if not Path(plugin).exists():
            raise StageError(
                f"no plugin at {plugin}.\nFix `plugin` in kit.toml's [render], or pass --plugin."
            )
        # Checked before the plugin loads, which takes seconds: with no state
        # there is nothing this could do anyway, and saying so at once is kinder.
        if not state.exists():
            raise StageError(
                f"no plugin state at {state}.\n"
                "A drum plugin boots with no kit loaded and renders silence, and which\n"
                "kit to use is not something that can be set from code. Run\n"
                "`drums kit-pick` once, choose a kit in the window, and close it."
            )

        self.log = log
        self.engine = daw.RenderEngine(SR, 512)
        log(f"loading {Path(plugin).stem}...")
        try:
            self.processor = self.engine.make_plugin_processor("kit", plugin)
        except Exception as exc:  # noqa: BLE001 - the plugin's own failure, verbatim
            raise StageError(f"the plugin would not load: {exc}") from exc

        self.processor.load_state(str(state))
        self.engine.load_graph([(self.processor, [])])
        # The state alone does nothing until the plugin's message loop has run.
        wake(self.engine, self.processor, note, log=log)

    def render(self, plan: Plan) -> np.ndarray:
        """Play a plan through, and hand back the plugin's stereo master.

        Returns shape (2, frames) -- the first output pair, which on a
        multi-out instrument like Superior Drummer is its master bus.
        """
        self.processor.clear_midi()
        self.processor.add_midi_note(plan.mark_note, 127, MARK_AT_S, NOTE_LEN_S)
        for slot in plan.slots:
            self.processor.add_midi_note(slot.note, slot.velocity, slot.at_s, NOTE_LEN_S)

        self.log(f"rendering {plan.duration_s / 60:.1f} min of audio...")
        started = time.time()
        self.engine.render(plan.duration_s)
        audio = self.engine.get_audio()
        wall = time.time() - started
        self.log(f"  done in {wall:.0f}s ({plan.duration_s / max(wall, 0.01):.0f}x realtime)")

        if audio.shape[0] < 2:
            raise StageError(f"the plugin returned {audio.shape[0]} channel(s); expected a pair")
        return np.asarray(audio[:2], dtype=np.float32)


def find_mark(audio: np.ndarray) -> float:
    """Where the zero mark actually landed, in seconds.

    Everything else is measured from here, so a plugin that reports latency or
    starts a hair late cannot walk the cuts off the ends of their samples.
    """
    mono = np.abs(audio).max(axis=0)
    peak = float(mono.max())
    if peak < SILENT_PEAK:
        raise StageError(
            "the whole render is silent.\n"
            "The plugin loaded and took the notes but made no sound. Usually that\n"
            "means the state it was given has no kit in it -- re-run `drums kit-pick`\n"
            "and make sure a kit is showing before you close the window."
        )
    threshold = max(SILENT_PEAK, peak * 0.02)
    hit = np.argmax(mono >= threshold)
    return float(hit) / SR


def slice_render(audio: np.ndarray, plan: Plan) -> list[Cut]:
    """Cut the render into one array per slot, trimmed to the sound."""
    delta = find_mark(audio) - MARK_AT_S
    cuts: list[Cut] = []
    for slot in plan.slots:
        start = int(round((slot.at_s + delta - LEAD_S) * SR))
        stop = int(round((slot.at_s + delta + slot.tail_s) * SR))
        window = audio[:, max(0, start) : min(audio.shape[1], stop)]
        if window.size == 0:
            raise StageError(f"{slot.stem}: the render is shorter than the plan")

        envelope = np.abs(window).max(axis=0)
        peak = float(envelope.max())
        if peak < SILENT_PEAK:
            cuts.append(Cut(slot=slot, data=window[:, :1] * 0, peak=0.0))
            continue

        floor = peak * FLOOR
        loud = np.flatnonzero(envelope >= floor)
        first, last = int(loud[0]), int(loud[-1])
        # Back off a touch so the attack itself is never clipped off.
        first = max(0, first - int(LEAD_S * SR))
        last = min(last, first + int(slot.tail_s * SR))
        data = np.array(window[:, first : last + 1], dtype=np.float32)

        if not slot.stereo:
            data = data.mean(axis=0, keepdims=True)

        fade = min(int(FADE_S * SR), data.shape[1])
        if fade > 1:
            data[:, -fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)

        cuts.append(Cut(slot=slot, data=data, peak=float(np.abs(data).max())))
    return cuts


def check_audible(cuts: Iterable[Cut]) -> None:
    """A slice that came back silent means something is wrong, not quiet."""
    dead = [c.slot for c in cuts if c.peak < SILENT_PEAK]
    if not dead:
        return
    names = sorted({f"{s.articulation} (note {s.note})" for s in dead})
    raise StageError(
        f"{len(dead)} of the slices came back silent: {', '.join(names)}.\n"
        "The plugin is awake and the rest of the bank sounded, so this is about\n"
        "these notes in particular: check `note` in kit.toml's\n"
        "[render.articulation.*] against the kit you picked -- a kit with three\n"
        "toms has nothing on the fourth. `drums kit-bake --audition` writes one\n"
        "wav per articulation if the numbers are not enough."
    )


def round_robin_spread(cuts: list[Cut]) -> dict[str, float]:
    """How different the takes of one layer are, per articulation, 0..1.

    Near zero means the plugin handed back the same recording every time --
    its round-robin is off, or that kit has none. That is the exact failure
    this whole bank exists to avoid, so it is reported rather than assumed.
    """
    by_layer: dict[tuple[str, int], list[Cut]] = {}
    for cut in cuts:
        by_layer.setdefault((cut.slot.articulation, cut.slot.layer), []).append(cut)

    spreads: dict[str, list[float]] = {}
    for (articulation, _), takes in by_layer.items():
        if len(takes) < 2:
            continue
        first = takes[0].data.mean(axis=0)
        for other in takes[1:]:
            second = other.data.mean(axis=0)
            n = min(len(first), len(second))
            if n == 0:
                continue
            a, b = first[:n], second[:n]
            denom = float(np.sqrt(np.mean(a**2)))
            if denom <= 0:
                continue
            diff = float(np.sqrt(np.mean((a - b) ** 2))) / denom
            spreads.setdefault(articulation, []).append(diff)
    return {name: float(np.median(v)) for name, v in spreads.items()}


def write_bank(
    cuts: list[Cut],
    kit: Kit,
    *,
    gain: float | None = None,
    merge: bool = False,
    log: Log = print,
) -> dict:
    """Write the samples and the manifest, and hand the manifest back.

    `gain` pins the bank's single gain. An incremental `--only` bake must pass
    the gain the rest of the bank already used, or the one articulature it
    re-rendered would sit at a different level from everything around it.
    """
    peak = max((c.peak for c in cuts), default=0.0)
    if peak <= 0:
        raise StageError("nothing to write: every slice was silent")
    if gain is None:
        gain = float(10 ** (HEADROOM_DB / 20) / peak)

    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for cut in cuts:
        path = SAMPLES_DIR / f"{cut.slot.stem}.flac"
        path.parent.mkdir(parents=True, exist_ok=True)
        data = np.clip(cut.data * gain, -1.0, 1.0)
        sf.write(str(path), data.T, SR, subtype="PCM_16", format="FLAC")
        written += 1

    manifest: dict = {}
    if merge and MANIFEST.exists():
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    manifest.setdefault("name", Path(kit.render.plugin).stem)
    manifest["sampleRate"] = SR
    manifest["gain"] = round(gain, 6)
    manifest["renderedAt"] = datetime.now(UTC).isoformat(timespec="seconds")
    articulations = manifest.setdefault("articulations", {})

    by_articulation: dict[str, list[Cut]] = {}
    for cut in cuts:
        by_articulation.setdefault(cut.slot.articulation, []).append(cut)

    for name, group in by_articulation.items():
        spec = kit.render.articulations[name]
        layers: list[dict] = []
        for layer in sorted({c.slot.layer for c in group}):
            takes = sorted((c for c in group if c.slot.layer == layer), key=lambda c: c.slot.rr)
            layers.append(
                {
                    "velocity": takes[0].slot.velocity,
                    "peak": round(max(t.peak for t in takes) * gain, 5),
                    "files": [f"{t.slot.stem}.flac" for t in takes],
                }
            )
        articulations[name] = {
            "instrument": spec.instrument,
            "default": spec.default,
            "stereo": spec.stereo,
            "layers": layers,
        }

    # Beside it and then renamed, because the dev server watches this file and
    # re-reads it the moment it changes: a half-written manifest parses as "no
    # kit has ever been baked", and the page believes it until the next reload.
    tmp = MANIFEST.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    tmp.replace(MANIFEST)
    log(f"  {written} samples -> {SAMPLES_DIR.relative_to(REPO_ROOT)}")
    return manifest


def write_audition(cuts: list[Cut], log: Log = print) -> None:
    """One labelled wav per articulation, for checking the notes by ear."""
    AUDITION_DIR.mkdir(parents=True, exist_ok=True)
    loudest: dict[str, Cut] = {}
    for cut in cuts:
        best = loudest.get(cut.slot.articulation)
        if best is None or cut.slot.layer > best.slot.layer:
            loudest[cut.slot.articulation] = cut
    for name, cut in sorted(loudest.items()):
        path = AUDITION_DIR / f"{name}.wav"
        sf.write(str(path), cut.data.T, SR, subtype="PCM_16")
    log(f"  {len(loudest)} auditions -> {AUDITION_DIR.relative_to(REPO_ROOT)}")


def pick_kit(plugin: str, log: Log = print) -> Path:
    """Open the plugin's own window, and keep whatever it is holding when it shuts.

    This is the one step with a window in it, and it is here because *which
    kit* is not a plugin parameter -- it lives in the plugin's internal state,
    which nothing but its own interface can set. Once saved, every render is
    headless.

    The saved state is proved before it is written: four kicks are rendered
    with the window closed, and a silent result is reported here rather than
    nine minutes into a bake.
    """
    try:
        import dawdreamer as daw
    except ImportError as exc:  # pragma: no cover - the dependency is declared
        raise StageError("dawdreamer is not installed; run `uv sync`") from exc

    if not Path(plugin).exists():
        raise StageError(
            f"no plugin at {plugin}.\nFix `plugin` in kit.toml's [render], or pass --plugin."
        )

    engine = daw.RenderEngine(SR, 512)
    log(f"loading {Path(plugin).stem}...")
    try:
        processor = engine.make_plugin_processor("kit", plugin)
    except Exception as exc:  # noqa: BLE001 - the plugin's own failure, verbatim
        raise StageError(f"the plugin would not load: {exc}") from exc

    # Start from last time's choice, so this is "change the kit", not "pick one
    # again from scratch". A state the plugin no longer likes is not worth
    # failing over -- it is about to be replaced.
    if STATE.exists():
        try:
            processor.load_state(str(STATE))
        except Exception:  # noqa: BLE001
            log("  (the saved state would not load; starting from the plugin's default)")

    log("opening the plugin's window -- choose a kit, then close the window")
    processor.open_editor()

    processor.clear_midi()
    note = 36
    for i in range(4):
        processor.add_midi_note(note, 110, 0.2 + i * 0.5, NOTE_LEN_S)
    engine.load_graph([(processor, [])])
    engine.render(2.5)
    peak = float(np.abs(engine.get_audio()).max())
    if peak < SILENT_PEAK:
        raise StageError(
            "the window closed but the plugin still renders silence.\n"
            "Nothing has been saved. Run `drums kit-pick` again and make sure a kit\n"
            "is loaded and showing in the window before you close it."
        )
    log(f"  it sounds with the window closed (peak {peak:.3f})")

    RENDER_DIR.mkdir(parents=True, exist_ok=True)
    processor.save_state(str(STATE))
    log(f"  saved {STATE.relative_to(REPO_ROOT)} ({STATE.stat().st_size / 1024:.0f} KB)")
    return STATE
