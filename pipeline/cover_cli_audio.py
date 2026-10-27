"""Cover commands: audio. Registered on `pipeline.cli.app` at import."""

from __future__ import annotations

import typer

from pipeline import cover_audio
from pipeline.cli import _fail, _resolve, app, console
from pipeline.proc import StageError

# Past this, a hit is audibly off the click; the stretch needs another method.
DRIFT_LIMIT_MS = 3.0


@app.command("cover-audio")
def cover_audio_cmd(
    song: str = typer.Argument(..., help="Song slug or URL"),
    force: bool = typer.Option(False, "--force", help="Rebuild even what is up to date"),
) -> None:
    """Build the backing a cover set plays: pitch-kept stretched stems and both clicks.

    stems/stretched-{nodrums,drums,mix}.wav are the song at a constant 130 with
    bar 1 at 0 and the pitch unchanged; stems/click-straight.wav and
    click-original.wav are the two click tracks, each with its own count-in.
    """
    target = _resolve(song)
    try:
        built = cover_audio.build(target, force=force)
    except StageError as exc:
        _fail(exc)
    for path in built.written:
        console.print(f"[green]{path}[/green]")
    for path in built.skipped:
        console.print(f"[dim]{path} (up to date)[/dim]")
    a = built.accuracy
    colour = "green" if a.drift_ms <= DRIFT_LIMIT_MS else "red"
    console.print()
    console.print(
        f"stretch accuracy over {a.hits} drum hits: [{colour}]drift {a.drift_ms:.1f} ms[/{colour}] "
        f"(worst {cover_audio.DRIFT_WINDOW:g} s stretch), lag {a.offset_ms:+.1f} ms, "
        f"per hit median {a.median_ms:.1f} / p95 {a.p95_ms:.1f} / max {a.max_ms:.1f} ms"
    )
