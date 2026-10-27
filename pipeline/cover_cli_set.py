"""Cover commands: set. Registered on `pipeline.cli.app` at import."""

from __future__ import annotations

import os

import typer
from rich.table import Table

from pipeline import cover
from pipeline import live_set
from pipeline.cli import _fail, _resolve, app, console  # noqa: F401
from pipeline.proc import StageError


@app.command("cover-session")
def cover_session(
    song: str = typer.Argument(..., help="Song slug or URL"),
    timing: cover.Timing = typer.Option(..., "--timing", help="straight (stretched stems, steady 130) or original"),
    name: str = typer.Option(None, "--name", help="Session folder name (default: the timing)"),
    open_set: bool = typer.Option(False, "--open", help="Open the set in Live afterwards"),
    force: bool = typer.Option(False, "--force", help="Rebuild even if the set already holds recordings"),
) -> None:
    """Make a cover session: its folder, cover.toml, and the Live set to record in.

    The set is built from the practice set, which is only read. It has the SD3
    track (your kit, armed), nodrums, drums and click, and `SD3 rec` armed to
    record SD3's output.
    """
    target = _resolve(song)
    sess = cover.Session(target, name or timing.value)
    try:
        missing = live_set.missing_backing(target, timing)
        if missing:
            live_set.build_set(sess, timing)  # raises with the list and the hints
        if sess.als.exists() and not force:
            count = live_set.pass_count(sess.als)
            if count:
                raise StageError(
                    f"{sess.als} already holds {count} recorded clip(s); "
                    "rebuilding would drop them. Use another --name, or --force."
                )
        sess.ensure_dirs()
        sess.update(
            "session",
            {"song": target.slug, "timing": timing.value, "name": sess.name, "live_tempo": cover.LIVE_TEMPO},
        )
        als = live_set.build_set(sess, timing)
        read = live_set.read_set(als)
    except StageError as exc:
        _fail(exc)

    console.print(f"[green]{als}[/green]  {read.tempo:g} BPM")
    for track in read.faders:
        if track != "Main":
            console.print(f"  {track}")
    if open_set:
        os.startfile(als)  # noqa: S606 -- hands the .als to Live, as a double-click would
        console.print("opening in Live")


@app.command("cover-attempts")
def cover_attempts(
    song: str = typer.Argument(..., help="Song slug or URL"),
    name: str = typer.Option(None, "--name", help="Session name (default: the latest session)"),
    pick: int = typer.Option(None, "--pick", help="Choose this attempt instead of the default"),
    save: bool = typer.Option(False, "--save", help="Write the chosen attempt into cover.toml [attempt]"),
) -> None:
    """List every record pass in the saved set, and which one the video uses."""
    target = _resolve(song)
    try:
        sess = cover.session(target, name)
        found = live_set.attempts(sess)
        recorded = live_set.recorded_files(sess)
    except StageError as exc:
        _fail(exc)
    if not found:
        console.print(f"no record passes in {sess.als.name} yet (did you Ctrl+S in Live?)")
        raise typer.Exit(code=1)

    chosen = live_set.default_attempt(found)
    if pick is not None:
        chosen = next((a for a in found if a.index == pick), None)
        if chosen is None:
            _fail(StageError(f"no attempt {pick}; there are {len(found)}"))

    table = Table(show_header=True, header_style="bold", box=None, pad_edge=False)
    for col in ("", "#", "starts", "length", "bars", "end?", "notes", "audio"):
        table.add_column(col, justify="right" if col in ("#", "starts", "length", "bars", "notes") else "left")
    for a in found:
        table.add_row(
            "[green]>[/green]" if a is chosen else "",
            str(a.index),
            f"{a.start_s:.1f}s",
            f"{a.end_s - a.start_s:.1f}s",
            str(a.bars),
            "[green]yes[/green]" if a.complete else "no",
            str(len(a.notes)),
            a.audio.name if a.audio else "[yellow]none[/yellow]",
        )
    console.print(table)
    unused = {p.name for p in recorded} - {a.audio.name for a in found if a.audio}
    if unused:
        console.print(f"[yellow]in Samples/Recorded but not in the set: {', '.join(sorted(unused))}[/yellow]")
    if chosen is None:
        console.print("[yellow]no attempt reached the end of the chart; choose one with --pick[/yellow]")
        return
    console.print(f"using attempt {chosen.index}" + (" (the last one that reached the end)" if pick is None else ""))
    if save:
        sess.update(
            "attempt",
            {
                "index": chosen.index,
                "start_s": chosen.start_s,
                "end_s": chosen.end_s,
                "audio": str(chosen.audio) if chosen.audio else None,
                "file_offset_s": chosen.file_offset_s,
            },
        )
        console.print(rf"saved to {sess.toml.name} \[attempt]")
