"""Cover commands: video. Registered on `pipeline.cli.app` at import."""

from __future__ import annotations

import typer

from pipeline import cover, live_set
from pipeline import cover_render as render_mod
from pipeline import cover_sync as sync_mod
from pipeline.cli import _fail, _resolve, app, console  # noqa: F401
from pipeline.proc import StageError


@app.command("cover-sync")
def cover_sync(
    song: str = typer.Argument(..., help="Song slug or URL"),
    name: str = typer.Option(None, "--name", help="Session name (default: the latest session)"),
) -> None:
    """Find the chosen attempt in raw/main.* and raw/foot.*; write the sync section and sample frames."""
    try:
        sess = cover.session(_resolve(song), name)
        live_set.check_tempo(sess)
        results = sync_mod.sync_session(sess)
    except StageError as exc:
        _fail(exc)
    span = sync_mod.attempt_span(sess)
    length = (span[1] - span[0]) if span else 0.0
    for cam, res in results.items():
        weak = res.confidence < sync_mod.MIN_CONFIDENCE
        colour = "yellow" if weak else "green"
        drift_ms = abs(res.drift_ppm) * 1e-6 * length * 1000
        console.print(
            f"[{colour}]{cam}[/{colour}] offset {res.offset_s:.4f}s  drift {res.drift_ppm:+.1f} ppm"
            f" ({drift_ms:.1f} ms over the take)  confidence {res.confidence:.2f}"
            f"  start/end {res.start_err_ms:+.1f}/{res.end_err_ms:+.1f} ms"
        )
        if weak:
            console.print(f"[yellow]  {cam}: the match is not clear -- check {cam}'s frame and the render[/yellow]")
    console.print(rf"frames in {sess.work}; crops are main_crop / foot_crop in {sess.toml.name} \[layout]")


@app.command("cover-render")
def cover_render(
    song: str = typer.Argument(..., help="Song slug or URL"),
    name: str = typer.Option(None, "--name", help="Session name (default: the latest session)"),
    tab: str = typer.Option("scroll", "--tab", help="scroll or flip"),
    all_: bool = typer.Option(False, "--all", help="Both tabs: scroll and flip"),
    kit: str = typer.Option(None, "--kit", help="Comma-separated kits: one video per kit (work/mix-<kit>.wav)"),
    preview: float = typer.Option(None, "--preview", help="Write one PNG still at this timeline second instead"),
) -> None:
    """Composite the cover video(s) into out/: 9:16, 1080x1920, 60 fps."""
    tabs = list(render_mod.TABS) if all_ else [tab]
    kits = [k.strip() for k in kit.split(",") if k.strip()] if kit else [None]
    try:
        sess = cover.session(_resolve(song), name)
        live_set.check_tempo(sess)
        for k in kits:
            for t in tabs:
                out = render_mod.build(sess, t, kit=k, preview_t=preview)
                console.print(f"[green]{out}[/green]")
    except StageError as exc:
        _fail(exc)
