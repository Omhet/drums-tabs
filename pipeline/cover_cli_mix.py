"""Cover commands: mix. Registered on `pipeline.cli.app` at import."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import typer

from pipeline import chart as chart_mod
from pipeline import cover, cover_kit, cover_mix
from pipeline import reference as reference_mod
from pipeline.cli import _fail, _resolve, app, console
from pipeline.proc import StageError

#: Rendered past the attempt's last note, so the last crash rings out.
KIT_TAIL_S = 3.0

#: Backing track name -> mix role. The click is listed so it is passed in and
#: provably dropped, rather than silently never asked for.
ROLES = {"nodrums": "song", "drums": "song_drums", "click": "click"}


@dataclass
class Gathered:
    tracks: list[cover_mix.TrackIn]  # backing only; the kit is added per render
    kit_fader: object  # live_set.Fader of the SD3 track: the level the kit was heard at
    attempt: object  # live_set.Attempt
    rec: np.ndarray  # what SD3 rec recorded for the attempt, (ch, frames)
    rec_sr: int


def gather(session: cover.Session, sr: int, attempt_index: int | None = None) -> Gathered:
    """Everything the mix needs out of the saved Live set.

    The only place that knows the Live set, so a change to ``live_set``'s API
    lands here and nowhere else. The levels are what was heard: the kit at the
    SD3 track's fader (``SD3 rec`` records SD3's output before that fader, so
    its own fader played no part), the stems at theirs.
    """
    import soundfile as sf

    from pipeline import live_set

    live = live_set.read_set(session.als)
    found = live_set.attempts(session)
    if attempt_index is not None:
        chosen = next((a for a in found if a.index == attempt_index), None)
        if chosen is None:
            raise StageError(f"no attempt {attempt_index} (have {', '.join(str(a.index) for a in found)})")
    else:
        chosen = live_set.default_attempt(found)
        if chosen is None:
            raise StageError(f"no record passes in {session.als.name} yet")
    if chosen.audio is None:
        raise StageError(f"attempt {chosen.index} has no {live_set.REC_TRACK} audio")

    stem_start = session.stem_start_beats * 60.0 / live.tempo
    tracks = []
    for name, path in session.backing().items():
        fader = live.faders.get(name)
        tracks.append(
            cover_mix.TrackIn(
                name=name,
                role=ROLES[name],
                path=path,
                start_s=0.0 if name == "click" else stem_start,
                gain_db=fader.gain_db if fader else 0.0,
                pan=fader.pan if fader else 0.0,
                muted=fader.muted if fader else False,
            )
        )

    audio = cover.readable_recording(chosen.audio if chosen.audio.is_absolute() else session.root / chosen.audio)
    info = sf.info(str(audio))
    a = int(round(chosen.file_offset_s * info.samplerate))
    b = a + int(round((chosen.end_s - chosen.start_s) * info.samplerate))
    rec, rate = sf.read(str(audio), start=a, stop=b, dtype="float32", always_2d=True)
    return Gathered(
        tracks=tracks,
        kit_fader=live.faders[live_set.SD3_TRACK],
        attempt=chosen,
        rec=rec.T,
        rec_sr=int(rate),
    )


def _kit_events(attempt) -> tuple[list[cover_kit.Note], list[cover_kit.Controller]]:
    """The attempt's recorded MIDI, from its own start."""
    t0 = attempt.start_s
    notes = [cover_kit.Note(t - t0, dur, pitch, vel) for t, pitch, vel, dur in attempt.notes]
    ctl = [cover_kit.Controller(t - t0, "cc", cc, v) for t, cc, v in attempt.controllers]
    ctl += [
        cover_kit.Controller(t - t0, "aftertouch" if note < 0 else "polytouch", max(note, 0), v)
        for t, note, v in attempt.aftertouch
    ]
    return notes, ctl


def _kit_track(g: Gathered, audio: np.ndarray, sr: int) -> cover_mix.TrackIn:
    from pipeline import live_set

    f = g.kit_fader
    return cover_mix.TrackIn(
        name=live_set.SD3_TRACK,
        role="kit",
        audio=audio,
        sr=sr,
        start_s=g.attempt.start_s,
        gain_db=f.gain_db,
        pan=f.pan,
        muted=False,  # the kit is the point; a muted SD3 track still goes in
    )


def _chart_times(session: cover.Session) -> dict[str, np.ndarray]:
    song = session.song
    mapping = {int(k): str(v) for k, v in (song.meta().get("midi_map") or {}).items()}
    clock = session.clock()
    per_slot = cover.TICKS_PER_BEAT / chart_mod.SLOTS_PER_BEAT
    out: dict[str, list[float]] = {}
    for hit in chart_mod.read_hits(song.tab_midi):
        name = mapping.get(hit.note)
        if name in reference_mod.BANDS:
            out.setdefault(name, []).append(float(clock.seconds_at(hit.slot * per_slot)))
    return {k: np.asarray(v) for k, v in out.items()}


def _print_timing(session: cover.Session, drums_only: np.ndarray, record: np.ndarray, sr: int) -> None:
    try:
        chart = _chart_times(session)
    except StageError:
        chart = None
    floor = cover_mix.floor_from_lock(reference_mod.load(session.song))
    rows = cover_mix.timing_report(drums_only, record, sr, chart=chart, floor_ms=floor)
    console.print("\n[bold]timing[/bold]  your hits against the original drummer's (+ is late)")
    # The headline goes through the chart and the record's floor, which
    # reference.py measured on the stem once and for all. Onset to onset in the
    # separated stem is shown beside it: a stem's hits are smeared by room and
    # separation, so its onsets read earlier than a dry kit's do.
    for r in rows:
        headline = r.vs_record_via_chart_ms if r.vs_record_via_chart_ms is not None else r.vs_record_ms
        if headline is None:
            console.print(f"  {r.instrument:5}  no hits matched")
            continue
        line = f"  {r.instrument:5}  [bold]{headline:+.1f} ms[/bold]"
        if r.vs_record_via_chart_ms is not None:
            line += f"  [dim]({r.vs_chart_ms:+.1f} on the chart, less the record's own {r.floor_ms:+.1f}"
            if r.vs_record_ms is not None:
                line += f"; onset to onset {r.vs_record_ms:+.1f} over {r.matched} hits"
            line += ")[/dim]"
        console.print(line)
    console.print(
        r"  [dim]a steady offset is usually monitoring latency: \[mix] drums_shift_ms moves the kit[/dim]"
    )


#: SD3's default notes for the two drums the timing is measured on.
SD3_NOTES = {"kick": {35, 36}, "snare": {38, 40}}


def _midi_check(rendered: np.ndarray, rec: np.ndarray, sr: int, kit: str, notes) -> None:
    """The kit render's hits against SD3 rec's, note by note.

    They line up if the recorded MIDI was complete. Each played kick and snare
    picks out its own hit in both, so the comparison is per note, not per
    whatever else is in the band. Against a different kit from the one SD3 rec
    was played on, a few ms is the two kits' attacks, not the MIDI.
    """
    written = {
        name: np.array([n.start_s for n in notes if n.pitch in pitches])
        for name, pitches in SD3_NOTES.items()
    }
    rows = cover_mix.timing_report(rendered, rec, sr, chart=written)
    parts = []
    for r in rows:
        total = written[r.instrument].size
        if r.vs_record_ms is None:
            parts.append(f"{r.instrument} no hits matched (of {total})")
        else:
            parts.append(f"{r.instrument} {r.vs_record_ms:+.1f} ms ({r.matched}/{total} notes)")
    console.print(f"  {kit} render vs SD3 rec: " + ", ".join(parts))


@app.command("cover-mix")
def cover_mix_cmd(
    song: str = typer.Argument(..., help="Song slug or URL"),
    name: str = typer.Option(None, "--name", help="Cover session (default: the newest)"),
    kit: str = typer.Option(None, "--kit", help="Re-render the kit through SD3: NAME or NAME,NAME"),
    preview: float = typer.Option(None, "--preview", help="Only an excerpt this many seconds long"),
    at: float = typer.Option(None, "--at", help=r"Where the excerpt starts (default \[mix] preview_at_s, else the attempt)"),
    no_chain: bool = typer.Option(False, "--no-chain", help="Levels and loudness only, no processing"),
    attempt: int = typer.Option(
        None, "--attempt", help="Which record pass (default: the last complete one, else the longest)"
    ),
) -> None:
    """Mix the cover's audio: your kit over the song, the click left out.

    The levels are the Live faders, as heard: the kit at the SD3 track's, the
    stems at theirs. Writes work/mix.wav and work/drums-only.wav (the dry kit
    the video syncs to). With --kit, the attempt's recorded MIDI is played
    through SD3 with each saved kit instead, into mix-<kit>.wav, and checked
    against what SD3 rec recorded. A re-render is SD3 alone -- the SD3 track's
    Utility and Roar are not in it -- so every kit compared with --kit is
    re-rendered, the one you played on included.
    """
    target = _resolve(song)
    try:
        session = cover.session(target, name)
        mix_section = session.settings().get("mix", {})
        settings = cover_mix.MixSettings.from_toml(mix_section)
        if no_chain:
            settings = settings.dry()
        sr = settings.sr
        if attempt is None:  # the pass `cover-attempts --save` chose, if it did
            attempt = session.settings().get("attempt", {}).get("index")
        g = gather(session, sr, attempt)
        console.print(
            f"attempt {g.attempt.index}: {g.attempt.start_s:.1f}-{g.attempt.end_s:.1f} s, "
            f"{g.attempt.bars} bars"
            + ("" if g.attempt.complete or attempt is not None else
               " [yellow](none reached the end of the chart: the longest)[/yellow]")
        )

        window = None
        if preview:
            start = at if at is not None else float(mix_section.get("preview_at_s", g.attempt.start_s))
            window = (start, start + preview)

        drums_stem = next(t for t in g.tracks if t.role == "song_drums")
        kits: list[str | None] = [k.strip() for k in kit.split(",")] if kit else [None]
        rec = cover_mix.resample(g.rec, g.rec_sr, sr)
        record_on_timeline = None
        for which in kits:
            if which is None:
                audio = rec
            else:
                console.print(f"[bold]{which}[/bold]  rendering the recorded MIDI through SD3")
                notes, ctl = _kit_events(g.attempt)
                length = g.attempt.end_s - g.attempt.start_s
                audio = cover_kit.render_midi(notes, ctl, which, length + KIT_TAIL_S, sr, log=console.print)
                _midi_check(audio[:, : rec.shape[1]], rec, sr, which, notes)

            console.print("mixing..." + (" (no chain)" if no_chain else ""))
            out, dry = cover_mix.mix(
                g.tracks + [_kit_track(g, audio, sr)],
                settings,
                drums_stem.path,
                window=window,
                log=console.print,
            )
            stem = "mix" + (f"-{which}" if which else "") + ("-nochain" if no_chain else "")
            stem += "-preview" if window else ""
            session.ensure_dirs()
            path = session.work / f"{stem}.wav"
            cover_mix.write(path, out, sr)
            console.print(f"[green]{path}[/green]")
            if window is None:
                dry_path = session.work / ("drums-only" + (f"-{which}" if which else "") + ".wav")
                cover_mix.write(dry_path, dry, sr)
                console.print(f"[green]{dry_path}[/green]")
                if which is None:
                    if record_on_timeline is None:
                        stem_audio = cover_mix.stereo(cover_mix.load(drums_stem.path, sr))
                        record_on_timeline = cover_mix._place(
                            stem_audio, drums_stem.start_s, sr, dry.shape[1]
                        )
                    _print_timing(session, dry, record_on_timeline, sr)
    except StageError as exc:
        _fail(exc)


@app.command("cover-kit")
def cover_kit_cmd(
    name: str = typer.Argument(..., help="The kit's name, e.g. a, b, practice"),
    from_als: Path = typer.Option(
        None, "--from-als", help="Take SD3's state out of this Live set, read only (default: the everyday practice set)"
    ),
    track: str = typer.Option("1-Superior Drummer 3", "--track", help="The SD3 track in --from-als"),
    pick: bool = typer.Option(False, "--pick", help="Choose the kit in SD3's own window instead"),
    from_bake: bool = typer.Option(False, "--from-bake", help="Copy the kit the app's sampler was baked from"),
    plugin: str = typer.Option(cover_kit.DEFAULT_PLUGIN, "--plugin", help="The SD3 VST3"),
) -> None:
    """Save an SD3 kit for re-rendering takes: take it out of a Live set (the
    everyday practice set unless --from-als says another), choose it in SD3's
    window, or copy the baked one. Saved to kit/cover-kits/<name>.state and
    proved to make a sound. Only SD3's own state comes out of a set: a
    re-render has none of the track's other devices (Utility, Roar)."""
    from pipeline import live_set

    try:
        if sum([bool(from_als), pick, from_bake]) > 1:
            raise StageError("one of --from-als, --pick or --from-bake")
        if pick:
            path = cover_kit.pick(name, plugin, log=console.print)
        elif from_bake:
            path = cover_kit.kit_from_bake(name)
        else:
            path = cover_kit.kit_from_als(from_als or live_set.TEMPLATE, track, name)
        console.print(f"saved {path} ({path.stat().st_size / 1024:.0f} KB); checking it loads")
        cover_kit.Renderer(name, plugin, log=console.print)
    except StageError as exc:
        _fail(exc)
    console.print(f"[green]kit {name} ready[/green]  use it with [bold]drums cover-mix <song> --kit {name}[/bold]")
