"""drums-tabs command line entry point.

Every stage is its own subcommand and communicates through files, so any of them
can be re-run alone, and the intermediate artifacts are all inspectable. ``prep``
chains the grid stages and ``all`` chains everything; neither does anything the
individual commands don't.

Two arguments are interchangeable everywhere a song is named: its slug, or the
original YouTube URL. Songs are matched by video id, so a renamed directory
still resolves.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import NoReturn

import typer
from rich.console import Console
from rich.table import Table

from pipeline import audit as audit_mod
from pipeline import backends
from pipeline import beats as beats_mod
from pipeline import doctor as doctor_mod
from pipeline import emit_alphatex as emit_mod
from pipeline import fetch as fetch_mod
from pipeline import grid as grid_mod
from pipeline import paths, separation
from pipeline import quantize as quantize_mod
from pipeline import score_stats as stats_mod
from pipeline.proc import StageError
from pipeline.separation import drumsep

app = typer.Typer(
    name="drums",
    help="YouTube -> isolated drums -> transcription -> alphaTex practice score.",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()


@app.callback()
def main() -> None:
    """Keep subcommands explicit even while only one exists."""


def _resolve(slug_or_url: str) -> paths.Song:
    song = paths.resolve(slug_or_url)
    if not song.toml.exists():
        known = ", ".join(s.slug for s in paths.all_songs()) or "none yet"
        raise typer.BadParameter(
            f"no song matching {slug_or_url!r} (have: {known}). Run `drums fetch <url>` first."
        )
    return song


def _fail(exc: StageError) -> NoReturn:
    console.print(f"[red]{exc}[/red]")
    raise typer.Exit(code=1)


def _parse_meter(text: str | None) -> tuple[int, int] | None:
    """Accept ``4/4``. Anything else is a typo worth catching here, not later."""
    if not text:
        return None
    try:
        numerator, denominator = (int(part) for part in text.split("/", 1))
    except ValueError as exc:
        raise typer.BadParameter(f"meter must look like 4/4, got {text!r}") from exc
    return numerator, denominator


@app.command()
def doctor() -> None:
    """Verify the toolchain, and that CUDA can actually execute kernels.

    Exits non-zero if any check fails, so a silent CPU fallback surfaces here
    rather than as an inexplicably slow pipeline later.
    """
    checks = doctor_mod.run_all()

    table = Table(show_header=True, header_style="bold", box=None, pad_edge=False)
    table.add_column("")
    table.add_column("check", style="bold")
    table.add_column("detail", overflow="fold")

    for check in checks:
        mark = "[green]OK[/green]" if check.ok else "[red]FAIL[/red]"
        table.add_row(mark, check.name, check.detail)
        if not check.ok and check.hint:
            table.add_row("", "", f"[yellow]try:[/yellow] {check.hint}")

    console.print(table)

    failed = [c for c in checks if not c.ok]
    if failed:
        console.print(
            f"\n[red]{len(failed)} of {len(checks)} checks failed.[/red] "
            "Fix these before running the pipeline."
        )
        raise typer.Exit(code=1)
    console.print(f"\n[green]All {len(checks)} checks passed.[/green]")


@app.command()
def fetch(
    url: str = typer.Argument(..., help="YouTube URL"),
    force: bool = typer.Option(False, "--force", help="Re-download even if present"),
    video: bool = typer.Option(True, "--video/--no-video", help="Also fetch the mp4"),
) -> None:
    """Download a song to songs/<slug>/ as stereo 44.1 kHz mix.wav (+ video.mp4)."""
    try:
        song = fetch_mod.fetch(url, force=force, with_video=video)
    except StageError as exc:
        _fail(exc)
    console.print(f"[green]{song.slug}[/green] -> {song.root}")


@app.command()
def separate(
    song: str = typer.Argument(..., help="Song slug or URL"),
    model: str = typer.Option(None, "--model", "-m", help="Separation model key"),
    force: bool = typer.Option(False, "--force", help="Re-run even if stems exist"),
) -> None:
    """Split mix.wav into drums.wav and nodrums.wav."""
    target = _resolve(song)
    chosen = model or target.meta().get("models", {}).get("separation") or None
    if target.drums.exists() and target.nodrums.exists() and not force:
        console.print("[dim]stems already present; --force to redo[/dim]")
        return
    try:
        result = separation.separate(target.mix, target.stems_dir, model=chosen)
    except (StageError, KeyError) as exc:
        _fail(exc if isinstance(exc, StageError) else StageError(str(exc)))
    console.print(f"[green]{result.model}[/green] -> {result.drums.name}, {result.nodrums.name}")


@app.command()
def beats(
    song: str = typer.Argument(..., help="Song slug or URL"),
    force: bool = typer.Option(False, "--force", help="Re-run the detector"),
) -> None:
    """Run beat_this on the mix, writing raw (unrepaired) beat times."""
    target = _resolve(song)
    try:
        raw = beats_mod.detect(target.mix, target.raw_beats, force=force)
    except StageError as exc:
        _fail(exc)
    console.print(
        f"[green]{raw.times.size}[/green] beats, "
        f"{raw.downbeat_times.size} downbeats -> {target.raw_beats}"
    )


@app.command()
def grid(
    song: str = typer.Argument(..., help="Song slug or URL"),
    regrid: bool = typer.Option(
        False, "--regrid", help="Overwrite an existing grid.lock.json (bar indices may move)"
    ),
    meter: str = typer.Option(None, "--meter", help="Force a meter, e.g. 4/4"),
    tempo_multiplier: str = typer.Option(
        None,
        "--tempo-multiplier",
        help="Force the tempo octave: half_even, half_odd, unit, double",
    ),
    rotate: int = typer.Option(
        None, "--rotate", help="Force the downbeat phase (0-3)"
    ),
) -> None:
    """Repair the beat grid and pin it to grid.lock.json.

    The lock file is the keystone: bar indices must stay stable across pipeline
    runs, because every hand edit in edits.yaml is bar-scoped. So an existing
    grid is never silently replaced -- --regrid is the deliberate act.
    """
    target = _resolve(song)
    if target.grid_lock.exists() and not regrid:
        console.print(
            f"[yellow]{target.grid_lock.name} already exists.[/yellow] "
            "Pass --regrid to replace it (bar indices may move, invalidating edits)."
        )
        raise typer.Exit(code=1)

    overrides = target.meta().get("grid", {})
    parsed_meter = _parse_meter(meter or overrides.get("meter") or None)
    multiplier = tempo_multiplier or overrides.get("tempo_multiplier") or None
    rotation = rotate if rotate is not None else overrides.get("downbeat_rotation", -1)
    rotation = None if rotation is None or rotation < 0 else rotation

    try:
        built = grid_mod.build(
            target,
            beats_per_bar=parsed_meter[0] if parsed_meter else 4,
            beat_unit=parsed_meter[1] if parsed_meter else 4,
            tempo_multiplier=multiplier,
            rotation=rotation,
        )
        grid_mod.save(target, built)
    except StageError as exc:
        _fail(exc)

    _print_grid(target, built)


@app.command()
def audit(song: str = typer.Argument(..., help="Song slug or URL")) -> None:
    """Render the grid inspector PNG and the beat click track."""
    target = _resolve(song)
    try:
        loaded = grid_mod.load(target)
        png = audit_mod.render_inspector(target, loaded)
        click = audit_mod.render_click_track(target, loaded)
    except StageError as exc:
        _fail(exc)
    console.print(f"[green]{png}[/green]\n[green]{click}[/green]")


@app.command()
def kit(
    song: str = typer.Argument(..., help="Song slug or URL"),
    force: bool = typer.Option(False, "--force", help="Re-run even if the stems exist"),
) -> None:
    """Split drums.wav into six per-drum stems with drumsep.

    A second separation pass, of the drum stem rather than the mix. It is what
    makes onset detection a matter of peak-picking one envelope per drum instead
    of guessing which drum a transient in a full kit belongs to.
    """
    target = _resolve(song)
    try:
        stems = drumsep.split(target, force=force)
    except StageError as exc:
        _fail(exc)
    console.print(f"[green]{len(stems)}[/green] stems -> {target.kit_dir}")


@app.command()
def transcribe(
    song: str = typer.Argument(..., help="Song slug or URL"),
    backend: str = typer.Option(None, "--backend", "-b", help="Transcription backend"),
    clicks: bool = typer.Option(
        True, "--clicks/--no-clicks", help="Also render per-instrument click tracks"
    ),
) -> None:
    """Detect onsets and snap them to the pinned grid, writing score.json."""
    target = _resolve(song)
    chosen = backend or target.meta().get("models", {}).get("backend") or None
    try:
        locked = grid_mod.load(target)
        events = backends.detect(target, backend=chosen)
        backends.save(
            target.onsets_json,
            events,
            backend=backends.get(chosen).key,
            extra={"song": target.slug},
        )
        score = quantize_mod.quantize(locked, events)
        quantize_mod.save(target, score)
        if clicks:
            audit_mod.render_onset_clicks(target, events)
    except (StageError, KeyError) as exc:
        _fail(exc if isinstance(exc, StageError) else StageError(str(exc)))
    _print_score(target, score)


@app.command()
def emit(song: str = typer.Argument(..., help="Song slug or URL")) -> None:
    """Write song.alphatex from score.json."""
    target = _resolve(song)
    try:
        score = quantize_mod.load(target)
        path = emit_mod.emit(target, score)
    except StageError as exc:
        _fail(exc)
    console.print(
        f"[green]{path}[/green] -- {len(score.bars)} bars, {score.note_count} notes"
    )


def _prepare(
    url: str, *, model: str | None, regrid: bool, video: bool
) -> tuple[paths.Song, grid_mod.Grid]:
    """Fetch, separate, detect beats, repair the grid, render the inspector."""
    if fetch_mod.extract_video_id(url):
        song = fetch_mod.fetch(url, with_video=video)
    else:
        song = _resolve(url)

    if not (song.drums.exists() and song.nodrums.exists()):
        separation.separate(song.mix, song.stems_dir, model=model)
    beats_mod.detect(song.mix, song.raw_beats)

    if song.grid_lock.exists() and not regrid:
        built = grid_mod.load(song)
        console.print("[dim]reusing pinned grid.lock.json (--regrid to replace)[/dim]")
    else:
        overrides = song.meta().get("grid", {})
        rotation = overrides.get("downbeat_rotation", -1)
        built = grid_mod.build(
            song,
            tempo_multiplier=overrides.get("tempo_multiplier") or None,
            rotation=None if rotation < 0 else rotation,
        )
        grid_mod.save(song, built)

    audit_mod.render_inspector(song, built)
    audit_mod.render_click_track(song, built)
    return song, built


@app.command()
def prep(
    url: str = typer.Argument(..., help="YouTube URL, or the slug of a fetched song"),
    model: str = typer.Option(None, "--model", "-m", help="Separation model key"),
    regrid: bool = typer.Option(False, "--regrid", help="Replace an existing grid"),
    video: bool = typer.Option(True, "--video/--no-video", help="Also fetch the mp4"),
) -> None:
    """The grid only: fetch, separate, detect beats, repair the grid, audit.

    Stops before transcription deliberately -- the grid is worth looking at
    before anything gets built on top of it.
    """
    try:
        song, built = _prepare(url, model=model, regrid=regrid, video=video)
    except StageError as exc:
        _fail(exc)

    _print_grid(song, built)
    console.print(f"\ninspect: {song.grid_png}\nlisten:  {song.beat_click}")


@app.command(name="all")
def run_all(
    url: str = typer.Argument(..., help="YouTube URL, or the slug of a fetched song"),
    model: str = typer.Option(None, "--model", "-m", help="Separation model key"),
    backend: str = typer.Option(None, "--backend", "-b", help="Transcription backend"),
    regrid: bool = typer.Option(False, "--regrid", help="Replace an existing grid"),
    video: bool = typer.Option(True, "--video/--no-video", help="Also fetch the mp4"),
) -> None:
    """Everything: a URL in, song.alphatex out."""
    try:
        song, built = _prepare(url, model=model, regrid=regrid, video=video)
        drumsep.split(song)
        events = backends.detect(song, backend=backend)
        backends.save(
            song.onsets_json, events, backend=backends.get(backend).key, extra={"song": song.slug}
        )
        score = quantize_mod.quantize(built, events)
        quantize_mod.save(song, score)
        audit_mod.render_onset_clicks(song, events)
        emit_mod.emit(song, score)
    except (StageError, KeyError) as exc:
        _fail(exc if isinstance(exc, StageError) else StageError(str(exc)))

    _print_grid(song, built)
    _print_score(song, score)
    console.print(
        f"\nnotation: {song.alphatex}\ninspect:  {song.grid_png}\n"
        f"listen:   {song.beat_click}, {song.debug_dir}/onset_*.wav"
    )


@app.command(name="score-stats")
def score_stats(
    song: str = typer.Argument(
        None, help="Song slug or URL; omit for every song with a score"
    ),
    save: str = typer.Option(None, "--save", help="Write the report to a JSON file"),
    compare: str = typer.Option(
        None, "--compare", help="Diff against a report saved earlier with --save"
    ),
    radius: int = typer.Option(
        stats_mod.RADIUS, "--radius", help="Bars either side to compare against"
    ),
) -> None:
    """Repeatability statistics: one-offs, dropouts, ghosts, snap error.

    The Phase 3 scoreboard. Snap error says whether the grid is right; these say
    whether the *notes* are, by asking how much each bar agrees with the bars
    around it. Run it before and after a detector change -- with --save then
    --compare, so the comparison is a diff and not a retyped table.
    """
    targets = [_resolve(song)] if song else [s for s in paths.all_songs() if s.score_json.exists()]
    if not targets:
        console.print("[dim]no songs with a score -- run `drums transcribe` first[/dim]")
        raise typer.Exit(code=1)

    reports: dict[str, dict] = {}
    for target in targets:
        try:
            reports[target.slug] = stats_mod.analyse(
                quantize_mod.load(target), radius=radius
            )
        except StageError as exc:
            console.print(f"[yellow]{target.slug}: {exc}[/yellow]")
    if not reports:
        raise typer.Exit(code=1)

    baseline = None
    if compare:
        baseline = json.loads(Path(compare).read_text(encoding="utf-8"))

    _print_stats(reports, baseline)

    if save:
        out = Path(save)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps({"songs": reports, "totals": stats_mod.totals(list(reports.values()))}, indent=2),
            encoding="utf-8",
        )
        console.print(f"\n[green]{out}[/green]")


def _delta(now: float, before: float | None, *, lower_is_better: bool = True) -> str:
    """Render a change against a baseline, coloured by whether it's an improvement."""
    if before is None:
        return ""
    change = now - before
    if abs(change) < 0.05:
        return " [dim]=[/dim]"
    good = (change < 0) if lower_is_better else (change > 0)
    return f" [{'green' if good else 'red'}]{change:+.1f}[/{'green' if good else 'red'}]"


def _print_stats(reports: dict[str, dict], baseline: dict | None = None) -> None:
    old_songs = (baseline or {}).get("songs", {})

    table = Table(box=None, header_style="bold", pad_edge=False)
    for column in ("song", "instrument", "notes", "one-off %", "dropout %", "vel one-off/stable"):
        table.add_column(column, overflow="fold")
    for slug, report in reports.items():
        old = old_songs.get(slug, {}).get("instruments", {})
        for name, entry in report["instruments"].items():
            was = old.get(name, {})
            table.add_row(
                slug if name == next(iter(report["instruments"])) else "",
                name,
                str(entry["notes"]),
                f"{entry['one_off_pct']}{_delta(entry['one_off_pct'], was.get('one_off_pct'))}",
                f"{entry['dropout_pct']}{_delta(entry['dropout_pct'], was.get('dropout_pct'))}",
                f"{entry['one_off_velocity']} / {entry['stable_velocity']}",
            )
    console.print(table)

    shape = Table(box=None, header_style="bold", pad_edge=False)
    for column in ("song", "bars", "distinct", "adj same %", "quiet snare on kick %", "< ghost %", "snap med/p90"):
        shape.add_column(column, overflow="fold")
    for slug, report in reports.items():
        was = old_songs.get(slug, {})
        error = report.get("snap_error_ms", {})
        shape.add_row(
            slug,
            f"{report['bars']} ({report['empty_bars']} empty)",
            f"{report['distinct_patterns']}",
            f"{report['adjacent_identical_pct']}",
            f"{report['quiet_snare_on_kick_pct']}"
            f"{_delta(report['quiet_snare_on_kick_pct'], was.get('quiet_snare_on_kick_pct'))}",
            f"{report['below_ghost_velocity_pct']}",
            f"{error.get('median', '-')} / {error.get('p90', '-')}",
        )
    console.print()
    console.print(shape)

    pooled = stats_mod.totals(list(reports.values()))
    old_pooled = (baseline or {}).get("totals", {})
    summary = Table(box=None, header_style="bold", pad_edge=False, title="all songs pooled")
    for column in ("instrument", "notes", "one-off %", "dropout %", "vel one-off/stable"):
        summary.add_column(column)
    for name, entry in pooled.items():
        was = old_pooled.get(name, {})
        summary.add_row(
            name,
            str(entry["notes"]),
            f"{entry['one_off_pct']}{_delta(entry['one_off_pct'], was.get('one_off_pct'))}",
            f"{entry['dropout_pct']}{_delta(entry['dropout_pct'], was.get('dropout_pct'))}",
            f"{entry['one_off_velocity']} / {entry['stable_velocity']}",
        )
    console.print()
    console.print(summary)

    notes = sum(r["notes"] for r in reports.values())
    ghosts = sum(r["below_ghost_velocity_pct"] * r["notes"] for r in reports.values()) / max(notes, 1)
    snares = sum(r["instruments"].get("snare", {}).get("notes", 0) for r in reports.values())
    bleed = sum(r["quiet_snare_on_kick"] for r in reports.values())
    console.print(
        f"\n{notes} notes, {ghosts:.1f}% below ghost velocity; "
        f"{bleed} of {snares} snares ({100.0 * bleed / max(snares, 1):.1f}%) "
        "are quiet ones sharing a slot with a kick"
    )


@app.command(name="songs")
def list_songs() -> None:
    """List fetched songs and how far each has got."""
    found = paths.all_songs()
    if not found:
        console.print("[dim]no songs yet -- `drums fetch <url>`[/dim]")
        return
    table = Table(box=None, header_style="bold", pad_edge=False)
    for column in ("slug", "mix", "stems", "kit", "beats", "grid", "score", "tex", "bpm", "bars", "notes"):
        table.add_column(column)
    for song in found:
        locked = None
        if song.grid_lock.exists():
            try:
                locked = grid_mod.load(song)
            except StageError:
                locked = None
        notes = "-"
        if song.score_json.exists():
            try:
                notes = str(quantize_mod.load(song).note_count)
            except StageError:
                notes = "old"
        table.add_row(
            song.slug,
            "OK" if song.mix.exists() else "-",
            "OK" if song.drums.exists() else "-",
            "OK" if drumsep.is_split(song) else "-",
            "OK" if song.raw_beats.exists() else "-",
            "OK" if song.grid_lock.exists() else "-",
            "OK" if song.score_json.exists() else "-",
            "OK" if song.alphatex.exists() else "-",
            f"{locked.score.bpm:.1f}" if locked else "-",
            str(locked.bar_count) if locked else "-",
            notes,
        )
    console.print(table)


@app.command(name="models")
def list_models() -> None:
    """List the separation models and transcription backends the pipeline can use."""
    table = Table(box=None, header_style="bold", pad_edge=False)
    for column in ("key", "arch", "drums SDR", "notes"):
        table.add_column(column, overflow="fold")
    for model in separation.available():
        key = model.key + (" (default)" if model.key == separation.DEFAULT_MODEL else "")
        table.add_row(key, model.arch, f"{model.drums_sdr:.1f}" if model.drums_sdr else "-", model.notes)
    console.print(table)

    backend_table = Table(box=None, header_style="bold", pad_edge=False)
    for column in ("backend", "notes"):
        backend_table.add_column(column, overflow="fold")
    for backend in backends.available():
        key = backend.key + (" (default)" if backend.key == backends.DEFAULT_BACKEND else "")
        backend_table.add_row(key, backend.notes)
    console.print(backend_table)


def _print_grid(song: paths.Song, built: grid_mod.Grid) -> None:
    repair = built.repair
    table = Table(box=None, show_header=False, pad_edge=False)
    table.add_column(style="bold")
    table.add_column(overflow="fold")
    table.add_row("song", song.slug)
    table.add_row("tempo", f"{built.score.bpm:.1f} BPM (drift {repair.get('tempo', {}).get('drift_pct')}%)")
    table.add_row("meter", f"{built.beats_per_bar}/{built.source.get('beat_unit', 4)}")
    table.add_row("bars", f"{built.bar_count} (count-in {built.count_in_bars})")
    table.add_row("beats", f"{repair.get('raw_beat_count')} raw -> {repair.get('beat_count')}")
    table.add_row("octave", str(repair.get("octave", {}).get("decision")))
    table.add_row("rotation", str(repair.get("rotation", {}).get("decision")))
    table.add_row("bar one", str(repair.get("bar_one", {}).get("decision")))
    table.add_row(
        "confidence",
        f"backbeat margin {built.score.backbeat_margin:+.3f}, "
        f"coverage {built.score.coverage:.0%}",
    )
    console.print(table)


def _print_score(song: paths.Song, score: quantize_mod.Score) -> None:
    stats = score.stats
    table = Table(box=None, show_header=False, pad_edge=False)
    table.add_column(style="bold")
    table.add_column(overflow="fold")
    table.add_row("song", song.slug)
    table.add_row(
        "notes",
        ", ".join(f"{name} {count}" for name, count in stats.get("by_instrument", {}).items())
        or "none",
    )
    table.add_row(
        "bars", f"{len(score.bars)} ({stats.get('empty_bars', 0)} with nothing in them)"
    )
    error = stats.get("snap_error_ms", {})
    if error:
        # How far the played hits sat from their slots. A large median means the
        # subdivision is too coarse for what was played; a large *signed* mean
        # means the grid itself is early or late.
        table.add_row(
            "snap error",
            f"median {error.get('median')} ms, p90 {error.get('p90')} ms, "
            f"signed mean {error.get('signed_mean'):+} ms",
        )
    table.add_row(
        "dropped",
        f"{stats.get('before_bar_one', 0)} before bar 1, "
        f"{stats.get('after_last_bar', 0)} past the last bar, "
        f"{stats.get('merged_duplicates', 0)} merged into an occupied slot",
    )
    console.print(table)


if __name__ == "__main__":
    app()
