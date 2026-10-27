"""Cover commands: the synthetic dress rehearsal. Registered on `pipeline.cli.app` at import."""

from __future__ import annotations

import typer

from pipeline import cover, cover_fake
from pipeline.cli import _fail, _resolve, app, console
from pipeline.proc import StageError


@app.command("cover-fake-session")
def cover_fake_session(
    song: str = typer.Argument(..., help="Song slug or URL"),
    timing: cover.Timing = typer.Option(..., "--timing", help="straight or original"),
    name: str = typer.Option(None, "--name", help="Session folder name (default: fake-s / fake-o)"),
    count_in: int = typer.Option(cover.COUNT_IN_BARS, "--count-in", help="Bars of click before bar 1"),
    seed: int = typer.Option(cover_fake.SEED, "--seed", help="Random seed for the performance"),
) -> None:
    """Fake a whole recorded session -- a false start and a full pass rendered
    through SD3, written into the generated set, and two phones -- with the
    right answers in work/truth.json, for the real commands to be checked on."""
    target = _resolve(song)
    try:
        truth = cover_fake.make(
            target, timing, name or f"fake-{timing.value[0]}", count_in_bars=count_in, seed=seed, log=console.print
        )
    except StageError as exc:
        _fail(exc)
    console.print(f"[green]{truth}[/green]")
