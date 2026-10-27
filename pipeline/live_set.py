"""The cover's Live set: generated from the everyday practice set, and read back after a session.

**Generating** (:func:`build_set`). The everyday practice set
``Drum Practise SD3.als`` -- the one the user plays in every day, so a cover
sounds the way practice does -- is only ever *read*: its bytes are gunzipped
into memory and that copy is edited. Every clip goes (arrangement, session and
take lanes, on every track). The Superior Drummer track stays exactly as it is
-- plugin state, its whole device chain (SD3, Utility, Roar, Grain Delay),
fader, MIDI from all inputs -- armed; so do the returns and the main chain.
Every other track goes (the set's loops, the Black Squid kit). Its first audio
track is the pattern for the new ones: ``nodrums``, ``drums`` and ``click``,
one clip each, and ``SD3 rec``, armed, recording the SD3 track's output
post-FX. Each new track is switched on and its fader set (:data:`FADERS_DB`,
the balance the user settled on in their first real session). The result is
written to ``session.als`` and nowhere else.

**Warping** (straight timing only). The stretched stems and the straight click
are a constant ``LIVE_TEMPO`` from the file's first sample, so two warp markers
pin them exactly: the file's start on the clip's start, and its end
``seconds * LIVE_TEMPO / 60`` beats later -- plus the 1/32-beat marker past the
end that Live itself writes on a warped loop. At ``LIVE_TEMPO`` that plays
every sample where the unwarped clip did; at another tempo the song follows
Live, for slow practice. ``nodrums`` warps in Complex Pro, ``drums`` and the
click in Beats preserving transients, the click with its loop mode off so a
tick stays one tick when slowed (:data:`_WARP`). Original-timing clips stay
unwarped: the record's own timing is the point of them, so no tempo applies.
A take for the video is recorded at ``LIVE_TEMPO`` whatever the practice
tempo was: :func:`attempts` and :func:`check_tempo` refuse a set saved at
another.

**Reading back** (:func:`read_set`, :func:`attempts`). Live 12 keeps every
arrangement recording pass: each pass gets a take lane of its own holding the
clip, and the main lane gets a copy of it (the comp shows the newest pass).
That is what the user's own sets show -- ``Drum Experiment.als`` (SD3 MIDI and
audio, ten and five passes), ``Guitar - Holiday.als``, ``My Riff 1.als``.
So a pass is a take-lane clip; a main-lane clip is the same pass again when its
``TakeId`` is in a take lane, and a pass of its own otherwise.

**The XML.** Every structure written here is copied from a clip Live wrote, not
made up, in the template's schema (Live 12.4.7): the MIDI clip, its CC
envelope and its per-note pressure first from ``Blur - Song 2.als``'s take
lanes, the audio clip from ``Lootcycle.als`` -- and both checked against
``covers/dev-s/dev-s.als``, the user's first real session, opened, recorded
into and saved by Live 12.4.7: its recorded SD3 and ``SD3 rec`` clips differ
from these only in their values, and in two elements 12.4 adds
(``AutomationEnvelopesListWrapper``, ``FileRef/SourceHint``), which these now
carry. A recorded audio clip's fields (``RelativePathType`` 3, the 1/32-beat
second warp marker, ``Samples/Recorded/<track> 000N [date].wav``) from
``Drum Experiment.als`` and dev-s; ``AudioIn/Track.<id>/PostFxOut`` routing
from ``Bass Beat.als``. The warp markers of a warped file follow the
template's own ``Upright Bass Loop`` clip (start, end, end + 1/32 beat); Beats
with ``TransientResolution`` 6 (Transients) and ``TransientEnvelope`` 100 and
Complex Pro (``WarpMode`` 6, formants 100, envelope 128) are Live's defaults
in every set here. ``TransientLoopMode`` 0 (Loop Off) is the one value not
seen on disk: every clip here, and every clip in Live's own Core Library,
has the default 2; 0 is the first entry of the chooser (Off, Forward,
Back-and-Forth).

Facts about the format this relies on, each checked against those files:

* Clip times (notes, envelope breakpoints) are in the clip's own beats; a
  non-looping clip plays ``[LoopStart, LoopEnd)`` from ``CurrentStart`` on.
  For an *unwarped* audio clip ``LoopStart``/``LoopEnd`` are seconds of the
  file instead.
* A MIDI clip's CC envelope points at the track's
  ``MidiControllers/ControllerTargets.<n>``, and ``n`` is the CC number plus 2
  (a sustain-pedal envelope in ``Rhythmic Ambient.als`` is ``.66``; every
  TD-27 set has ``.6``, CC4, the hi-hat pedal, and ``.90``, CC88). ``.0`` and
  ``.1`` are pitch bend and channel pressure -- no set here uses either, so
  that order is Live's documented chooser order, not seen on disk.
* Polyphonic aftertouch (a TD-27 cymbal choke) is a ``PerNoteEventList`` with
  ``CC="-1"`` on the note, offsets in beats from the note's start.
* Ids in the "pointee" space (``AutomationTarget``, ``ModulationTarget``,
  ``Pointee``, ``ControllerTargets.n`` ...) are unique across the file and
  ``NextPointeeId`` is one above the largest; every set here obeys that.
  Track ids are a separate, small-number space.
"""

from __future__ import annotations

import copy
import gzip
import math
import os
import shutil
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import mido
import soundfile as sf

from pipeline import cover, paths
from pipeline.proc import StageError

#: The user's everyday practice set. Read-only, always: nothing here opens it for writing.
TEMPLATE = Path(
    "C:/Users/omhet/Music/Ableton/Projects/Drum Practise SD3/Drum Practise SD3 Project/Drum Practise SD3.als"
)
#: Nothing is ever written under here (the user's own Live projects).
PROTECTED = Path("C:/Users/omhet/Music/Ableton")

SD3_TRACK = "1-Superior Drummer 3"
REC_TRACK = "SD3 rec"

#: Live's "since forever" time: an envelope's value before its first breakpoint.
_BEFORE_ALL = -63072000.0
#: ControllerTargets.<n> is CC n-2; .0 pitch bend, .1 channel pressure.
_CC_OFFSET = 2
_CHANNEL_PRESSURE_TARGET = 1
#: Recorded audio: the second warp marker sits 1/32 beat in.
_MARKER_BEATS = 0.03125
#: Live's colour indices, so the four tracks tell apart at a glance.
_COLORS = {"nodrums": 14, "drums": 6, "click": 0, REC_TRACK: 25}
#: A new set's faders, in dB: where the user put them in their first real
#: session (covers/dev-s), finding the kit too quiet against the song at -6
#: each. The SD3 track keeps the template's own fader. SD3 rec records its
#: input before its fader, so its fader is only what it plays back at.
FADERS_DB = {"nodrums": -3.3, "drums": -9.2, "click": -10.0, REC_TRACK: 0.0}
#: Warp settings per backing track, for a straight set (see the module notes).
_BEATS = {"WarpMode": 0, "TransientResolution": 6, "TransientEnvelope": 100}
_WARP = {
    "nodrums": {"WarpMode": 6, "ComplexProFormants": 100, "ComplexProEnvelope": 128},
    "drums": {**_BEATS, "TransientLoopMode": 2},
    "click": {**_BEATS, "TransientLoopMode": 0},
}

_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n'


# --- skeletons, copied from clips Live wrote ---------------------------------

# Lootcycle.als (Live 12.2.6), an unwarped arrangement clip; the SourceContext
# browser history emptied the way a recorded clip has it. With the two elements
# Live 12.4.7 wrote into it on saving dev-s.als.
_AUDIO_CLIP = """<AudioClip Id="0" Time="0">
<LomId Value="0" /><LomIdView Value="0" /><CurrentStart Value="0" /><CurrentEnd Value="2" />
<Loop><LoopStart Value="0" /><LoopEnd Value="1" /><StartRelative Value="0" /><LoopOn Value="false" />
<OutMarker Value="1" /><HiddenLoopStart Value="0" /><HiddenLoopEnd Value="1" /></Loop>
<Name Value="" /><Annotation Value="" /><Color Value="22" /><LaunchMode Value="0" /><LaunchQuantisation Value="0" />
<TimeSignature><TimeSignatures><RemoteableTimeSignature Id="0"><Numerator Value="4" /><Denominator Value="4" />
<Time Value="0" /></RemoteableTimeSignature></TimeSignatures></TimeSignature>
<Envelopes><Envelopes /></Envelopes>
<ScrollerTimePreserver><LeftTime Value="0" /><RightTime Value="0" /></ScrollerTimePreserver>
<TimeSelection><AnchorTime Value="0" /><OtherTime Value="0" /></TimeSelection>
<Legato Value="false" /><Ram Value="false" /><GrooveSettings><GrooveId Value="-1" /></GrooveSettings>
<Disabled Value="false" /><VelocityAmount Value="0" />
<FollowAction><FollowTime Value="4" /><IsLinked Value="true" /><LoopIterations Value="1" /><FollowActionA Value="4" />
<FollowActionB Value="0" /><FollowChanceA Value="100" /><FollowChanceB Value="0" /><JumpIndexA Value="1" />
<JumpIndexB Value="1" /><FollowActionEnabled Value="false" /></FollowAction>
<Grid><FixedNumerator Value="1" /><FixedDenominator Value="16" /><GridIntervalPixel Value="20" /><Ntoles Value="2" />
<SnapToGrid Value="true" /><Fixed Value="false" /></Grid>
<FreezeStart Value="0" /><FreezeEnd Value="0" /><IsWarped Value="false" /><TakeId Value="1" /><IsInKey Value="true" />
<ScaleInformation><Root Value="0" /><Name Value="0" /></ScaleInformation><AutomationEnvelopesListWrapper LomId="0" />
<SampleRef><FileRef><RelativePathType Value="1" /><RelativePath Value="" /><Path Value="" /><Type Value="1" />
<LivePackName Value="" /><LivePackId Value="" /><OriginalFileSize Value="0" /><OriginalCrc Value="0" />
<SourceHint Value="" /></FileRef>
<LastModDate Value="0" /><SourceContext /><SampleUsageHint Value="0" /><DefaultDuration Value="0" />
<DefaultSampleRate Value="48000" /><SamplesToAutoWarp Value="0" /></SampleRef>
<Onsets><UserOnsets /><HasUserOnsets Value="false" /></Onsets>
<WarpMode Value="0" /><GranularityTones Value="30" /><GranularityTexture Value="65" /><FluctuationTexture Value="25" />
<TransientResolution Value="6" /><TransientLoopMode Value="2" /><TransientEnvelope Value="100" />
<ComplexProFormants Value="100" /><ComplexProEnvelope Value="128" /><Sync Value="true" /><HiQ Value="true" />
<Fade Value="true" />
<Fades><FadeInLength Value="0" /><FadeOutLength Value="0" /><ClipFadesAreInitialized Value="true" />
<CrossfadeInState Value="0" /><FadeInCurveSkew Value="0" /><FadeInCurveSlope Value="0" /><FadeOutCurveSkew Value="0" />
<FadeOutCurveSlope Value="0" /><IsDefaultFadeIn Value="true" /><IsDefaultFadeOut Value="true" /></Fades>
<PitchCoarse Value="0" /><PitchFine Value="0" /><SampleVolume Value="1" />
<WarpMarkers><WarpMarker Id="0" SecTime="0" BeatTime="0" /><WarpMarker Id="1" SecTime="0.015625" BeatTime="0.03125" /></WarpMarkers>
<SavedWarpMarkersForStretched /><MarkersGenerated Value="false" /><IsSongTempoLeader Value="false" />
</AudioClip>"""

# Blur - Song 2.als (Live 12.2.7), take lane 0's recorded SD3 clip, emptied; with
# the element a Live 12.4.7 recording carries (dev-s.als, the SD3 track's passes).
_MIDI_CLIP = """<MidiClip Id="0" Time="0">
<LomId Value="0" /><LomIdView Value="0" /><CurrentStart Value="0" /><CurrentEnd Value="1" />
<Loop><LoopStart Value="0" /><LoopEnd Value="1" /><StartRelative Value="0" /><LoopOn Value="false" />
<OutMarker Value="1" /><HiddenLoopStart Value="0" /><HiddenLoopEnd Value="1" /></Loop>
<Name Value="" /><Annotation Value="" /><Color Value="6" /><LaunchMode Value="0" /><LaunchQuantisation Value="0" />
<TimeSignature><TimeSignatures><RemoteableTimeSignature Id="0"><Numerator Value="4" /><Denominator Value="4" />
<Time Value="0" /></RemoteableTimeSignature></TimeSignatures></TimeSignature>
<Envelopes><Envelopes /></Envelopes>
<ScrollerTimePreserver><LeftTime Value="0" /><RightTime Value="0" /></ScrollerTimePreserver>
<TimeSelection><AnchorTime Value="0" /><OtherTime Value="0" /></TimeSelection>
<Legato Value="false" /><Ram Value="false" /><GrooveSettings><GrooveId Value="-1" /></GrooveSettings>
<Disabled Value="false" /><VelocityAmount Value="0" />
<FollowAction><FollowTime Value="4" /><IsLinked Value="true" /><LoopIterations Value="1" /><FollowActionA Value="4" />
<FollowActionB Value="0" /><FollowChanceA Value="100" /><FollowChanceB Value="0" /><JumpIndexA Value="1" />
<JumpIndexB Value="1" /><FollowActionEnabled Value="false" /></FollowAction>
<Grid><FixedNumerator Value="1" /><FixedDenominator Value="16" /><GridIntervalPixel Value="20" /><Ntoles Value="2" />
<SnapToGrid Value="true" /><Fixed Value="true" /></Grid>
<FreezeStart Value="0" /><FreezeEnd Value="0" /><IsWarped Value="true" /><TakeId Value="1" /><IsInKey Value="true" />
<ScaleInformation><Root Value="0" /><Name Value="0" /></ScaleInformation><AutomationEnvelopesListWrapper LomId="0" />
<Notes><KeyTracks /><PerNoteEventStore><EventLists /></PerNoteEventStore><NoteProbabilityGroups />
<ProbabilityGroupIdGenerator><NextId Value="1" /></ProbabilityGroupIdGenerator>
<NoteIdGenerator><NextId Value="1" /></NoteIdGenerator></Notes>
<BankSelectCoarse Value="-1" /><BankSelectFine Value="-1" /><ProgramChange Value="-1" />
<NoteEditorFoldInZoom Value="-1" /><NoteEditorFoldInScroll Value="0" /><NoteEditorFoldOutZoom Value="-1" />
<NoteEditorFoldOutScroll Value="0" /><NoteEditorFoldScaleZoom Value="-1" /><NoteEditorFoldScaleScroll Value="0" />
<NoteSpellingPreference Value="0" /><AccidentalSpellingPreference Value="3" /><PreferFlatRootNote Value="false" />
<ExpressionGrid><FixedNumerator Value="1" /><FixedDenominator Value="16" /><GridIntervalPixel Value="20" />
<Ntoles Value="2" /><SnapToGrid Value="false" /><Fixed Value="false" /></ExpressionGrid>
</MidiClip>"""

_CLIP_ENVELOPE = """<ClipEnvelope Id="0"><EnvelopeTarget><PointeeId Value="0" /></EnvelopeTarget>
<Automation><Events /><AutomationTransformViewState><IsTransformPending Value="false" /><TimeAndValueTransforms />
</AutomationTransformViewState></Automation><LoopSlot><Value /></LoopSlot>
<ScrollerTimePreserver><LeftTime Value="0" /><RightTime Value="0" /></ScrollerTimePreserver></ClipEnvelope>"""

_TAKE_LANE = """<TakeLane Id="0"><LomId Value="0" /><Height Value="51" /><IsContentSelectedInDocument Value="false" />
<ClipAutomation><Events /><AutomationTransformViewState><IsTransformPending Value="false" /><TimeAndValueTransforms />
</AutomationTransformViewState></ClipAutomation><Name Value="Lane" /><Annotation Value="" /><Audition Value="false" />
<ArrangementClipsListWrapper LomId="0" /></TakeLane>"""


# --- small XML helpers -------------------------------------------------------


def _num(value: float) -> str:
    """Numbers as Live writes them: integers bare, floats at full precision."""
    v = float(value)
    return str(int(v)) if v.is_integer() and abs(v) < 1e15 else repr(v)


def _get(el: ET.Element, path: str, default: str | None = None) -> str | None:
    found = el.find(path)
    if found is None:
        return default
    return found.get("Value", default)


def _fget(el: ET.Element, path: str, default: float = 0.0) -> float:
    v = _get(el, path)
    return default if v is None else float(v)


def _set(el: ET.Element, path: str, value: object) -> None:
    found = el.find(path)
    if found is None:
        raise StageError(f"Live set: no <{path}> under <{el.tag}>")
    if isinstance(value, bool):
        found.set("Value", "true" if value else "false")
    elif isinstance(value, (int, float)):
        found.set("Value", _num(value))
    else:
        found.set("Value", str(value))


def _is_pointee(tag: str) -> bool:
    return tag.endswith("Target") or tag == "Pointee" or tag.startswith("ControllerTargets.")


def _guard(path: Path) -> None:
    resolved = Path(os.path.abspath(path))
    try:
        resolved.relative_to(Path(os.path.abspath(PROTECTED)))
    except ValueError:
        return
    raise StageError(f"refusing to write {resolved}: it is inside the Ableton projects folder")


def load(path: Path) -> ET.Element:
    """A saved set's XML root. Only ever reads ``path``."""
    try:
        data = gzip.decompress(Path(path).read_bytes())
    except (OSError, gzip.BadGzipFile) as exc:
        raise StageError(f"cannot read the Live set {path}: {exc}") from exc
    return ET.fromstring(data)


def save(root: ET.Element, path: Path) -> None:
    _guard(path)
    _renumber_check(root)
    text = _DECLARATION + ET.tostring(root, encoding="unicode")
    tmp = Path(path).with_suffix(".als.tmp")
    tmp.write_bytes(gzip.compress(text.encode("utf-8")))
    os.replace(tmp, path)


def _renumber_check(root: ET.Element) -> None:
    """Pointee ids unique and ``NextPointeeId`` above them, or no write at all."""
    ids = [int(e.get("Id")) for e in root.iter() if "Id" in e.attrib and _is_pointee(e.tag)]
    if len(ids) != len(set(ids)):
        raise StageError("Live set: duplicate pointee ids (a bug in live_set.py)")
    nxt = root.find("LiveSet/NextPointeeId")
    if int(nxt.get("Value")) <= max(ids, default=0):
        nxt.set("Value", str(max(ids) + 1))


class _Ids:
    """Hands out fresh pointee ids from the set's ``NextPointeeId``."""

    def __init__(self, root: ET.Element):
        self.el = root.find("LiveSet/NextPointeeId")
        used = [int(e.get("Id")) for e in root.iter() if "Id" in e.attrib and _is_pointee(e.tag)]
        self.next = max(int(self.el.get("Value")), max(used, default=0) + 1)

    def take(self) -> int:
        n = self.next
        self.next += 1
        self.el.set("Value", str(self.next))
        return n

    def renumber(self, subtree: ET.Element) -> None:
        """Give a cloned subtree its own pointee ids, and its references to them."""
        mapping: dict[str, str] = {}
        for e in subtree.iter():
            if "Id" in e.attrib and _is_pointee(e.tag):
                new = str(self.take())
                mapping[e.get("Id")] = new
                e.set("Id", new)
        for ref in subtree.iter("PointeeId"):
            if ref.get("Value") in mapping:
                ref.set("Value", mapping[ref.get("Value")])


# --- tracks ------------------------------------------------------------------

_TRACK_TAGS = ("MidiTrack", "AudioTrack", "ReturnTrack", "GroupTrack")


def _tracks(root: ET.Element) -> list[ET.Element]:
    return [t for t in root.find("LiveSet/Tracks") if t.tag in _TRACK_TAGS]


def track_name(track: ET.Element) -> str:
    return _get(track, "Name/EffectiveName", "") or ""


def _track(root: ET.Element, name: str) -> ET.Element:
    for t in _tracks(root):
        if track_name(t) == name:
            return t
    have = ", ".join(track_name(t) for t in _tracks(root))
    raise StageError(f"the Live set has no track named {name!r} (have: {have})")


def _main_events(track: ET.Element) -> ET.Element:
    seq = track.find("DeviceChain/MainSequencer")
    holder = seq.find("ClipTimeable") if track.tag == "MidiTrack" else seq.find("Sample")
    return holder.find("ArrangerAutomation/Events")


def _take_lanes(track: ET.Element) -> ET.Element:
    return track.find("TakeLanes/TakeLanes")


def _clear_clips(root: ET.Element) -> None:
    """Every clip out: arrangement, session slots and take lanes, all tracks."""
    for holder in root.iter():
        if holder.tag in ("ClipTimeable", "Sample") and holder.find("ArrangerAutomation/Events") is not None:
            events = holder.find("ArrangerAutomation/Events")
            for clip in list(events):
                events.remove(clip)
    for slot in root.iter("ClipSlot"):
        value = slot.find("ClipSlot/Value")
        if value is not None:
            for clip in list(value):
                value.remove(clip)
    for lanes in root.iter("TakeLanes"):
        inner = lanes.find("TakeLanes")
        if inner is not None:
            for lane in list(inner):
                inner.remove(lane)
    for rec in root.iter("Recorder"):
        _set(rec, "TakeCounter", 1)


def _name_track(track: ET.Element, name: str) -> None:
    _set(track, "Name/EffectiveName", name)
    _set(track, "Name/UserName", name)
    _set(track, "Name/MemorizedFirstClipName", "")


def _arm(track: ET.Element, on: bool = True) -> None:
    _set(track, "DeviceChain/MainSequencer/Recorder/IsArmed", on)


def _relative(target: Path, base: Path) -> str:
    try:
        return Path(os.path.relpath(target, base)).as_posix()
    except ValueError:  # another drive
        return ""


def _file_ref(clip: ET.Element, wav: Path, project: Path, *, in_project: bool) -> sf._SoundFileInfo:
    info = sf.info(str(wav))
    ref = clip.find("SampleRef")
    absolute = Path(os.path.abspath(wav))
    _set(ref, "FileRef/RelativePathType", 3 if in_project else 1)
    _set(ref, "FileRef/RelativePath", _relative(absolute, project))
    _set(ref, "FileRef/Path", absolute.as_posix())
    _set(ref, "LastModDate", int(absolute.stat().st_mtime))
    _set(ref, "DefaultDuration", int(info.frames))
    _set(ref, "DefaultSampleRate", int(info.samplerate))
    return info


def _audio_clip(
    wav: Path, project: Path, start_beats: float, tempo: float, name: str, color: int, warp: dict | None = None
) -> ET.Element:
    """One clip playing the whole file from ``start_beats``.

    Unwarped, or -- given ``warp``, its warp-mode fields -- warped so that at
    ``tempo`` it plays exactly as the unwarped clip would: markers at the file's
    start, at its end, and 1/32 beat past it, as Live marks a warped loop.
    """
    clip = ET.fromstring(_AUDIO_CLIP)
    info = _file_ref(clip, wav, project, in_project=False)
    seconds = info.frames / info.samplerate
    beats = seconds * tempo / 60.0
    clip.set("Time", _num(start_beats))
    _set(clip, "CurrentStart", start_beats)
    _set(clip, "CurrentEnd", start_beats + beats)
    for tag in ("LoopEnd", "OutMarker", "HiddenLoopEnd"):
        # Unwarped, the loop is in seconds of the file; warped, in clip beats.
        _set(clip, f"Loop/{tag}", beats if warp else seconds)
    _set(clip, "Name", name)
    _set(clip, "Color", color)
    markers = clip.find("WarpMarkers")
    if warp:
        _set(clip, "IsWarped", True)
        for key, value in warp.items():
            _set(clip, key, value)
        for marker in list(markers)[1:]:
            markers.remove(marker)
        past = _MARKER_BEATS * 60.0 / tempo
        for i, (sec, beat) in enumerate([(seconds, beats), (seconds + past, beats + _MARKER_BEATS)], start=1):
            ET.SubElement(markers, "WarpMarker", {"Id": str(i), "SecTime": _num(sec), "BeatTime": _num(beat)})
    else:
        markers[1].set("SecTime", _num(_MARKER_BEATS * 60.0 / tempo))
    return clip


def _set_input_from_track(track: ET.Element, source: ET.Element) -> None:
    """Record ``source``'s output, after its devices (Live's "Post FX")."""
    routing = track.find("DeviceChain/AudioInputRouting")
    _set(routing, "Target", f"AudioIn/Track.{source.get('Id')}/PostFxOut")
    _set(routing, "UpperDisplayString", track_name(source))
    _set(routing, "LowerDisplayString", "Post FX")


def _sd3_track(root: ET.Element) -> ET.Element:
    for t in _tracks(root):
        if t.tag == "MidiTrack" and track_name(t) == SD3_TRACK:
            return t
    raise StageError(f"the everyday practice set has no MIDI track named {SD3_TRACK!r}")


def build_set(session: cover.Session, *, template: Path = TEMPLATE) -> Path:
    """Write ``session.als`` from the everyday practice set. Returns its path.

    The session's ``cover.toml`` says the timing, the count-in and where the
    stems start.
    """
    timing = session.timing
    backing = session.backing()
    missing = [p for p in backing.values() if not p.exists()]
    if missing:
        raise StageError(
            "the cover set needs files that are not there yet:\n  "
            + "\n  ".join(str(p) for p in missing)
            + f"\n`drums cover-audio {session.song.slug}` makes the stretched stems and the clicks"
        )
    _guard(session.als)
    if Path(os.path.abspath(session.als)) == Path(os.path.abspath(template)):
        raise StageError("refusing to write over the template set")

    root = load(template)  # read-only: bytes in, edited in memory
    tempo = cover.LIVE_TEMPO
    ids = _Ids(root)
    tracks_el = root.find("LiveSet/Tracks")
    sd3 = _sd3_track(root)
    proto = next((t for t in _tracks(root) if t.tag == "AudioTrack"), None)
    if proto is None:
        raise StageError("the everyday practice set has no audio track to copy")

    _clear_clips(root)
    _arm(sd3, True)

    # Only the SD3 track and the returns stay; the new tracks go right after SD3.
    for t in _tracks(root):
        if t is not sd3 and t.tag != "ReturnTrack":
            tracks_el.remove(t)
    at = list(tracks_el).index(sd3) + 1
    next_track_id = max(int(t.get("Id")) for t in _tracks(root)) + 1
    start = session.stem_start_beats
    made: list[ET.Element] = []
    for name, wav in [*backing.items(), (REC_TRACK, None)]:
        track = copy.deepcopy(proto)
        ids.renumber(track)
        track.set("Id", str(next_track_id))
        next_track_id += 1
        _name_track(track, name)
        _set(track, "Color", _COLORS.get(name, 25))
        _arm(track, name == REC_TRACK)
        mixer = track.find("DeviceChain/Mixer")
        _set(mixer, "Volume/Manual", 10.0 ** (FADERS_DB[name] / 20.0))
        _set(mixer, "Speaker/Manual", True)  # the template's loops are switched off
        if wav is not None:
            begin = 0.0 if name == "click" else start
            warp = _WARP[name] if timing is cover.Timing.straight else None
            _main_events(track).append(_audio_clip(wav, session.root, begin, tempo, name, _COLORS[name], warp))
        else:
            _set_input_from_track(track, sd3)
            # Monitoring off: SD3 is already heard through its own track.
            _set(track, "DeviceChain/MainSequencer/MonitoringEnum", 2)
        made.append(track)
    for offset, track in enumerate(made):
        tracks_el.insert(at + offset, track)

    _set_tempo(root, tempo)
    transport = root.find("LiveSet/Transport")
    _set(transport, "LoopOn", False)
    _set(transport, "CurrentTime", 0)
    _set(root, "LiveSet/ArrangementOverdub", False)

    session.root.mkdir(parents=True, exist_ok=True)
    # The folder Live looks for to call a directory a project. Without it a
    # set is loose, and Live may record into its temp folder rather than this
    # session's Samples/Recorded. In a real project it holds only an icon.
    (session.root / "Ableton Project Info").mkdir(exist_ok=True)
    save(root, session.als)
    return session.als


def _set_tempo(root: ET.Element, tempo: float) -> None:
    mixer = root.find("LiveSet/MainTrack/DeviceChain/Mixer")
    _set(mixer, "Tempo/Manual", tempo)
    target = mixer.find("Tempo/AutomationTarget").get("Id")
    for env in root.find("LiveSet/MainTrack/AutomationEnvelopes/Envelopes"):
        if _get(env, "EnvelopeTarget/PointeeId") == target:
            events = env.find("Automation/Events")
            for ev in list(events):
                events.remove(ev)
            ET.SubElement(events, "FloatEvent", {"Id": "0", "Time": _num(_BEFORE_ALL), "Value": _num(tempo)})


# --- reading a saved set -----------------------------------------------------


@dataclass(frozen=True)
class Fader:
    gain_db: float
    pan: float
    muted: bool


@dataclass(frozen=True)
class LiveSet:
    path: Path
    tempo: float
    faders: dict[str, Fader]


def _fader(track: ET.Element) -> Fader:
    mixer = track.find("DeviceChain/Mixer")
    gain = _fget(mixer, "Volume/Manual", 1.0)
    return Fader(
        gain_db=20.0 * math.log10(gain) if gain > 0 else -math.inf,
        pan=_fget(mixer, "Pan/Manual", 0.0),
        muted=_get(mixer, "Speaker/Manual", "true") == "false",
    )


def tempo_of(root: ET.Element) -> float:
    return _fget(root, "LiveSet/MainTrack/DeviceChain/Mixer/Tempo/Manual", cover.LIVE_TEMPO)


def _saved_tempos(root: ET.Element) -> list[float]:
    """The tempo control, and every point of an envelope on it."""
    mixer = root.find("LiveSet/MainTrack/DeviceChain/Mixer")
    target = mixer.find("Tempo/AutomationTarget").get("Id")
    found = [tempo_of(root)]
    for env in root.find("LiveSet/MainTrack/AutomationEnvelopes/Envelopes"):
        if _get(env, "EnvelopeTarget/PointeeId") == target:
            found += [float(ev.get("Value")) for ev in env.iter("FloatEvent")]
    return found


def _require_video_tempo(root: ET.Element) -> None:
    off = next((t for t in _saved_tempos(root) if abs(t - cover.LIVE_TEMPO) > 1e-6), None)
    if off is not None:
        raise StageError(
            f"The set is saved at {off:g} BPM. The video is built at {cover.LIVE_TEMPO:g} — set Live's tempo "
            f"back to {cover.LIVE_TEMPO:g}, save, and run this again. "
            f"(Practise at any tempo; record the take for the video at {cover.LIVE_TEMPO:g}.)"
        )


def check_tempo(session: cover.Session) -> None:
    """Refuse a session whose set is saved at another tempo than the video's.

    The timeline -- the attempts, the clock, the mix -- is arrangement seconds at
    ``LIVE_TEMPO``. A straight set follows Live's tempo for practice, but a take
    recorded at another tempo is on another timeline.
    """
    if not session.als.exists():
        raise StageError(f"no {session.als}; run `drums cover-session` first")
    _require_video_tempo(load(session.als))


def read_set(path: Path) -> LiveSet:
    """Tempo and every track's fader (``Main`` is the main track)."""
    root = load(path)
    faders = {track_name(t): _fader(t) for t in _tracks(root)}
    faders["Main"] = _fader(root.find("LiveSet/MainTrack"))
    return LiveSet(path=Path(path), tempo=tempo_of(root), faders=faders)


# --- attempts ----------------------------------------------------------------

Note = tuple[float, int, int, float]  # (time_s, pitch, velocity, duration_s)
Control = tuple[float, int, int]  # (time_s, cc, value)
Touch = tuple[float, int, int]  # (time_s, note, value); note -1 = channel pressure


@dataclass(frozen=True)
class Attempt:
    """One record pass: what ``SD3 rec`` heard and what the SD3 track got.

    Times are arrangement seconds (0 at 1|1|1, at the set's tempo).
    ``file_offset_s`` is where in ``audio`` the clip starts playing.
    """

    index: int
    start_beats: float
    end_beats: float
    start_s: float
    end_s: float
    audio: Path | None
    file_offset_s: float
    notes: list[Note] = field(default_factory=list)
    controllers: list[Control] = field(default_factory=list)
    aftertouch: list[Touch] = field(default_factory=list)
    bars: int = 0
    complete: bool = False
    audio_take: int | None = None
    midi_take: int | None = None


@dataclass
class _Pass:
    take: int
    start: float
    end: float
    clip: ET.Element


def _passes(track: ET.Element) -> list[_Pass]:
    """A track's record passes: take-lane clips, plus main-lane clips no lane holds."""
    def one(clip: ET.Element) -> _Pass:
        return _Pass(int(_fget(clip, "TakeId", 0)), _fget(clip, "CurrentStart"), _fget(clip, "CurrentEnd"), clip)

    lanes = _take_lanes(track)
    laned = [one(c) for lane in (lanes if lanes is not None else []) for c in lane.find("ClipAutomation/Events")]
    known = {p.take for p in laned}
    main = [one(c) for c in _main_events(track) if int(_fget(c, "TakeId", 0)) not in known]
    return sorted(laned + main, key=lambda p: (p.take, p.start))


def _clip_beat_to_arrangement(clip: ET.Element, t: float) -> float:
    return _fget(clip, "CurrentStart") + (t - _fget(clip, "Loop/LoopStart"))


def _visible(clip: ET.Element, t: float) -> bool:
    return _fget(clip, "Loop/LoopStart") <= t < _fget(clip, "Loop/LoopEnd") + 1e-9


def _collapse(points: list[tuple[float, int]]) -> list[tuple[float, int]]:
    """Live writes a recorded step as two breakpoints at one time; keep the changes."""
    out: list[tuple[float, int]] = []
    for t, v in points:
        if out and abs(out[-1][0] - t) < 1e-9:
            out[-1] = (t, v)
        else:
            out.append((t, v))
    deduped: list[tuple[float, int]] = []
    for t, v in out:
        if not deduped or deduped[-1][1] != v:
            deduped.append((t, v))
    return deduped


def _midi_content(clip: ET.Element, track: ET.Element, spb: float) -> tuple[list[Note], list[Control], list[Touch]]:
    """Notes, CCs and aftertouch of one MIDI clip, in arrangement seconds."""
    start = _fget(clip, "CurrentStart")
    end = _fget(clip, "CurrentEnd")
    notes: list[Note] = []
    by_id: dict[int, tuple[float, int]] = {}
    for kt in clip.iter("KeyTrack"):
        pitch = int(_fget(kt, "MidiKey"))
        for ev in kt.iter("MidiNoteEvent"):
            if ev.get("IsEnabled") == "false":
                continue
            t = float(ev.get("Time"))
            if not _visible(clip, t):
                continue
            beat = _clip_beat_to_arrangement(clip, t)
            notes.append((beat * spb, pitch, int(round(float(ev.get("Velocity")))), float(ev.get("Duration")) * spb))
            if ev.get("NoteId") is not None:
                by_id[int(ev.get("NoteId"))] = (t, pitch)
    notes.sort(key=lambda n: (n[0], n[1]))

    targets = {
        e.get("Id"): int(e.tag.split(".")[1])
        for e in track.find("DeviceChain/MainSequencer/MidiControllers")
    }
    controllers: list[Control] = []
    touch: list[Touch] = []
    for env in clip.iter("ClipEnvelope"):
        index = targets.get(_get(env, "EnvelopeTarget/PointeeId"))
        if index is None:
            continue
        points = []
        for ev in env.iter("FloatEvent"):
            t = float(ev.get("Time"))
            beat = start if t <= _BEFORE_ALL / 2 else _clip_beat_to_arrangement(clip, t)
            if beat > end + 1e-9 or (t > _BEFORE_ALL / 2 and not _visible(clip, t)):
                continue
            points.append((max(beat, start), int(round(float(ev.get("Value"))))))
        points.sort(key=lambda p: p[0])
        for beat, v in _collapse(points):
            if index >= _CC_OFFSET and index - _CC_OFFSET < 128:
                controllers.append((beat * spb, index - _CC_OFFSET, v))
            elif index == _CHANNEL_PRESSURE_TARGET:
                touch.append((beat * spb, -1, v))
    for lst in clip.iter("PerNoteEventList"):
        if lst.get("CC") != "-1" or int(lst.get("NoteId")) not in by_id:
            continue
        t0, pitch = by_id[int(lst.get("NoteId"))]
        points = [(t0 + float(ev.get("TimeOffset")), int(round(float(ev.get("Value"))))) for ev in lst.iter("PerNoteEvent")]
        for t, v in _collapse(points):
            touch.append((_clip_beat_to_arrangement(clip, t) * spb, pitch, v))
    controllers.sort(key=lambda c: (c[0], c[1]))
    touch.sort(key=lambda c: (c[0], c[1]))
    return notes, controllers, touch


def _audio_file(clip: ET.Element) -> Path | None:
    path = _get(clip, "SampleRef/FileRef/Path")
    return Path(path) if path else None


def _file_offset_s(clip: ET.Element) -> float:
    """Where in its file a clip starts playing: seconds for an unwarped clip,
    beats through the warp markers (extrapolated past the last) for a warped one."""
    loop_start = _fget(clip, "Loop/LoopStart")
    if _get(clip, "IsWarped") == "false":
        return loop_start
    marks = sorted(
        ((float(m.get("BeatTime")), float(m.get("SecTime"))) for m in clip.iter("WarpMarker")),
        key=lambda m: m[0],
    )
    if len(marks) < 2:
        return loop_start * 60.0 / cover.LIVE_TEMPO
    for (b0, s0), (b1, s1) in zip(marks, marks[1:]):
        if loop_start <= b1:
            break
    return s0 + (loop_start - b0) * (s1 - s0) / (b1 - b0)


@dataclass(frozen=True)
class Chart:
    """How much of the arrangement the chart covers, for "how far did it get"."""

    last_note_s: float
    bars: int
    clock: cover.Clock


def chart_for(session: cover.Session) -> Chart:
    midi_path = session.song.tab_midi
    if not midi_path.exists():
        raise StageError(f"no {midi_path}; the attempts list measures against the chart")
    midi = mido.MidiFile(str(midi_path))
    scale = cover.TICKS_PER_BEAT / midi.ticks_per_beat
    last_on = 0
    last_off = 0
    for track in midi.tracks:
        tick = 0
        for msg in track:
            tick += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                last_on = max(last_on, tick)
            if msg.type in ("note_on", "note_off"):
                last_off = max(last_off, tick)
    clock = session.clock()
    per_bar = cover.TICKS_PER_BEAT * cover.BEATS_PER_BAR
    bars = max(1, math.ceil((last_off * scale) / per_bar))
    return Chart(float(clock.seconds_at(last_on * scale)), bars, clock)


def _overlap(a: _Pass, b: _Pass) -> float:
    shorter = min(a.end - a.start, b.end - b.start)
    if shorter <= 0:
        return 0.0
    return max(0.0, min(a.end, b.end) - max(a.start, b.start)) / shorter


def attempts(session: cover.Session, *, chart: Chart | None = None) -> list[Attempt]:
    """Every record pass in the saved set, oldest first."""
    if not session.als.exists():
        raise StageError(f"no {session.als}; run `drums cover-session` first")
    root = load(session.als)
    _require_video_tempo(root)
    spb = 60.0 / tempo_of(root)
    rec = _track(root, REC_TRACK)
    sd3 = _track(root, SD3_TRACK)
    audio = _passes(rec)
    midi = _passes(sd3)
    chart = chart or chart_for(session)

    # Pair each audio pass with the MIDI pass that overlaps it most.
    pairs: list[tuple[_Pass | None, _Pass | None]] = []
    free = list(midi)
    for a in audio:
        best = max(free, key=lambda m: _overlap(a, m), default=None)
        if best is not None and _overlap(a, best) > 0.5:
            free.remove(best)
            pairs.append((a, best))
        else:
            pairs.append((a, None))
    pairs += [(None, m) for m in free]
    pairs.sort(key=lambda p: ((p[0] or p[1]).take, (p[0] or p[1]).start))

    per_bar = cover.TICKS_PER_BEAT * cover.BEATS_PER_BAR
    out: list[Attempt] = []
    for i, (a, m) in enumerate(pairs, start=1):
        span = a or m
        notes, controllers, touch = _midi_content(m.clip, sd3, spb) if m else ([], [], [])
        end_s = span.end * spb
        reached = int(float(chart.clock.tick_at(end_s)) // per_bar)
        out.append(
            Attempt(
                index=i,
                start_beats=span.start,
                end_beats=span.end,
                start_s=span.start * spb,
                end_s=end_s,
                audio=_audio_file(a.clip) if a else None,
                file_offset_s=_file_offset_s(a.clip) if a else 0.0,
                notes=notes,
                controllers=controllers,
                aftertouch=touch,
                bars=max(0, min(chart.bars, reached)),
                complete=end_s >= chart.last_note_s,
                audio_take=a.take if a else None,
                midi_take=m.take if m else None,
            )
        )
    return out


def pass_count(path: Path) -> int:
    """How many record passes a saved set holds, on either recording track."""
    root = load(path)
    names = {track_name(t): t for t in _tracks(root)}
    return sum(len(_passes(names[n])) for n in (REC_TRACK, SD3_TRACK) if n in names)


def default_attempt(found: list[Attempt]) -> Attempt | None:
    """The last pass that reached the end of the chart; failing that, the longest
    (the later of two as long). ``None`` only when there are no passes.

    Whether it fell back is ``not chosen.complete``.
    """
    complete = [a for a in found if a.complete]
    if complete:
        return complete[-1]
    return max(found, key=lambda a: (a.end_s - a.start_s, a.index), default=None)


# --- writing a pass the way Live does (for the synthetic session) ------------


def _recorded_name(track: str, number: int, when: datetime) -> str:
    """``SD3 rec 0001 [2026-05-21 211400].wav``, as Live names a recording."""
    return f"{track} {number:04d} [{when:%Y-%m-%d %H%M%S}].wav"


def _next_lane(track: ET.Element) -> ET.Element:
    lanes = _take_lanes(track)
    lane = ET.fromstring(_TAKE_LANE)
    lane.set("Id", str(max((int(l.get("Id")) for l in lanes), default=-1) + 1))
    lanes.append(lane)
    return lane


def _take_id(track: ET.Element) -> int:
    clips = list(_main_events(track)) + [c for l in _take_lanes(track) for c in l.find("ClipAutomation/Events")]
    return max((int(_fget(c, "TakeId", 0)) for c in clips), default=0) + 1


def _clip_name(base: str, take: int) -> str:
    return base if take == 1 else f"{base} {take}"


def _comp_into_main(track: ET.Element, clip: ET.Element) -> None:
    """The main lane shows the newest pass: what it covers is cut out of older clips."""
    events = _main_events(track)
    start, end = _fget(clip, "CurrentStart"), _fget(clip, "CurrentEnd")
    for old in list(events):
        s, e = _fget(old, "CurrentStart"), _fget(old, "CurrentEnd")
        if e <= start or s >= end:
            continue
        if s < start:  # keep its head
            _set(old, "CurrentEnd", start)
        else:
            events.remove(old)
    main = copy.deepcopy(clip)
    main.set("Id", str(max((int(c.get("Id")) for c in events), default=-1) + 1))
    events.append(main)


def _step_events(events: ET.Element, points: list[tuple[float, int]]) -> None:
    """A recorded controller as Live writes one: a value before everything, then
    each change as two breakpoints at one time (old value, new value)."""
    ids = iter(range(10**9))
    ET.SubElement(events, "FloatEvent", {"Id": str(next(ids)), "Time": _num(_BEFORE_ALL), "Value": _num(points[0][1])})
    prev = points[0][1]
    for t, v in points:
        ET.SubElement(events, "FloatEvent", {"Id": str(next(ids)), "Time": _num(t), "Value": _num(prev)})
        ET.SubElement(events, "FloatEvent", {"Id": str(next(ids)), "Time": _num(t), "Value": _num(v)})
        prev = v


def _midi_clip(
    sd3: ET.Element,
    take: int,
    start_beats: float,
    length_beats: float,
    notes: list[Note],
    controllers: list[Control],
    aftertouch: list[Touch],
    start_s: float,
    bps: float,
) -> ET.Element:
    clip = ET.fromstring(_MIDI_CLIP)
    clip.set("Time", _num(start_beats))
    _set(clip, "CurrentStart", start_beats)
    _set(clip, "CurrentEnd", start_beats + length_beats)
    for tag in ("LoopEnd", "OutMarker", "HiddenLoopEnd"):
        _set(clip, f"Loop/{tag}", length_beats)
    _set(clip, "Name", _clip_name("Superior Drummer 3", take))
    _set(clip, "TakeId", take)

    beat = lambda s: (s - start_s) * bps  # noqa: E731 -- arrangement seconds -> clip beats
    key_tracks = clip.find("Notes/KeyTracks")
    by_pitch: dict[int, list[Note]] = {}
    for n in sorted(notes):
        by_pitch.setdefault(n[1], []).append(n)
    note_id = 1
    placed: list[tuple[float, int, int]] = []  # (clip beat, pitch, NoteId)
    for k, (pitch, group) in enumerate(sorted(by_pitch.items())):
        kt = ET.SubElement(key_tracks, "KeyTrack", {"Id": str(k)})
        ns = ET.SubElement(kt, "Notes")
        for t, _, vel, dur in group:
            ET.SubElement(ns, "MidiNoteEvent", {
                "Time": _num(beat(t)), "Duration": _num(dur * bps), "Velocity": _num(vel),
                "OffVelocity": "64", "NoteId": str(note_id),
            })
            placed.append((beat(t), pitch, note_id))
            note_id += 1
        ET.SubElement(kt, "MidiKey", {"Value": str(pitch)})
    _set(clip, "Notes/NoteIdGenerator/NextId", note_id)

    targets = {int(e.tag.split(".")[1]): e.get("Id") for e in sd3.find("DeviceChain/MainSequencer/MidiControllers")}
    envelopes = clip.find("Envelopes/Envelopes")
    channels: dict[int, list[tuple[float, int]]] = {}
    for t, cc, v in sorted(controllers):
        channels.setdefault(cc + _CC_OFFSET, []).append((beat(t), v))
    poly: dict[int, list[tuple[float, int]]] = {}
    for t, note, v in sorted(aftertouch):
        if note < 0:
            channels.setdefault(_CHANNEL_PRESSURE_TARGET, []).append((beat(t), v))
            continue
        owner = [p for p in placed if p[1] == note and p[0] <= beat(t) + 1e-9]
        if not owner:
            raise StageError(f"aftertouch at {t:.3f}s on note {note} has no note before it")
        b0, _, nid = max(owner)
        poly.setdefault(nid, []).append((beat(t) - b0, v))
    for k, (index, points) in enumerate(sorted(channels.items())):
        env = ET.fromstring(_CLIP_ENVELOPE)
        env.set("Id", str(k))
        _set(env, "EnvelopeTarget/PointeeId", targets[index])
        _step_events(env.find("Automation/Events"), points)
        envelopes.append(env)

    lists = clip.find("Notes/PerNoteEventStore/EventLists")
    for k, (nid, points) in enumerate(sorted(poly.items())):
        lst = ET.SubElement(lists, "PerNoteEventList", {"Id": str(k), "NoteId": str(nid), "CC": "-1"})
        evs = ET.SubElement(lst, "Events")
        prev = 0
        for off, v in points:
            ET.SubElement(evs, "PerNoteEvent", {"TimeOffset": _num(off), "Value": _num(prev)})
            ET.SubElement(evs, "PerNoteEvent", {"TimeOffset": _num(off), "Value": _num(v)})
            prev = v
    return clip


def add_recorded_attempt(
    session: cover.Session,
    audio: Path,
    start_s: float,
    notes: list[Note],
    controllers: list[Control] = (),
    aftertouch: list[Touch] = (),
    *,
    when: datetime | None = None,
) -> Path:
    """Put one record pass into the saved set as Live would have.

    ``audio`` is copied into ``Samples/Recorded`` under a Live-style name and
    becomes a clip on ``SD3 rec``; the MIDI (times in arrangement seconds) a
    clip on the SD3 track. Each goes into a new take lane and is comped onto
    the main lane. Returns the recorded wav's path.
    """
    _guard(session.als)
    root = load(session.als)
    tempo = tempo_of(root)
    bps = tempo / 60.0
    rec = _track(root, REC_TRACK)
    sd3 = _track(root, SD3_TRACK)
    when = when or datetime.now()

    session.recorded.mkdir(parents=True, exist_ok=True)
    number = len(list(session.recorded.glob(f"{REC_TRACK} *.wav"))) + 1
    wav = session.recorded / _recorded_name(REC_TRACK, number, when)
    _guard(wav)
    shutil.copyfile(audio, wav)

    start_beats = start_s * bps
    take = _take_id(rec)
    clip = ET.fromstring(_AUDIO_CLIP)
    info = _file_ref(clip, wav, session.root, in_project=True)
    length = info.frames / info.samplerate * bps
    clip.set("Time", _num(start_beats))
    _set(clip, "CurrentStart", start_beats)
    _set(clip, "CurrentEnd", start_beats + length)
    for tag in ("LoopEnd", "OutMarker", "HiddenLoopEnd"):
        _set(clip, f"Loop/{tag}", length)
    _set(clip, "Name", _clip_name(REC_TRACK, take))
    _set(clip, "Color", _COLORS[REC_TRACK])
    _set(clip, "IsWarped", True)
    _set(clip, "TakeId", take)
    clip.find("WarpMarkers")[1].set("SecTime", _num(_MARKER_BEATS / bps))
    _next_lane(rec).find("ClipAutomation/Events").append(clip)
    _comp_into_main(rec, clip)
    _set(rec, "DeviceChain/MainSequencer/Recorder/TakeCounter", take + 1)

    mtake = _take_id(sd3)
    mclip = _midi_clip(sd3, mtake, start_beats, length, list(notes), list(controllers), list(aftertouch), start_s, bps)
    _next_lane(sd3).find("ClipAutomation/Events").append(mclip)
    _comp_into_main(sd3, mclip)
    _set(sd3, "DeviceChain/MainSequencer/Recorder/TakeCounter", mtake + 1)

    save(root, session.als)
    return wav


def recorded_files(session: cover.Session) -> list[Path]:
    """What Live wrote into ``Samples/Recorded`` -- a cross-check on the set."""
    if not session.recorded.exists():
        return []
    return sorted(session.recorded.glob("*.wav"))

