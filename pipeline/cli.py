"""drums-tabs command line entry point.

Every stage is its own subcommand and communicates through files, so any of them
can be re-run alone, and the intermediate artifacts are all inspectable. ``prep``
chains them all; it does nothing the individual commands don't.

Two arguments are interchangeable everywhere a song is named: its slug, or the
original YouTube URL. Songs are matched by video id, so a renamed directory
still resolves.
"""

from __future__ import annotations

from typing import NoReturn

import typer
from rich.console import Console
from rich.table import Table

from pipeline import align as align_mod
from pipeline import audit as audit_mod
from pipeline import beats as beats_mod
from pipeline import doctor as doctor_mod
from pipeline import fetch as fetch_mod
from pipeline import grid as grid_mod
from pipeline import kit as kit_mod
from pipeline import paths, separation
from pipeline import sections as sections_mod
from pipeline import sticking as sticking_mod
from pipeline import straighten as straighten_mod
from pipeline.proc import StageError

app = typer.Typer(
    name="drums",
    help="YouTube -> mix, stems, video and a beat grid, ready for the practice player.",
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
def align(song: str = typer.Argument(..., help="Song slug or URL")) -> None:
    """Measure the video's soundtrack against mix.wav and pin the offset.

    The stems and the beat map live on mix.wav's timeline; the video is a
    separate download cut a few tens of milliseconds differently. The player
    clocks off the video, so it needs this number to put the cursor, the
    stems and the click on what the video shows.
    """
    target = _resolve(song)
    try:
        loaded = grid_mod.load(target)
        info = align_mod.measure(target)
        written = align_mod.save(target, loaded, info)
    except StageError as exc:
        _fail(exc)
    for window in info.windows:
        console.print(
            f"  [dim]{window.start_s:6.1f}s[/dim]  {window.offset_ms:+8.2f} ms"
            f"  [dim](corr {window.correlation:.2f})[/dim]"
        )
    console.print(
        f"video is [bold]{info.offset_ms:+.2f} ms[/bold] from the mix "
        f"-> {written.name}"
    )


@app.command()
def sections(
    song: str = typer.Argument(..., help="Song slug or URL"),
    redetect: bool = typer.Option(
        False, "--redetect", help="Replace the sections already in song.toml"
    ),
    min_bars: int = typer.Option(
        sections_mod.MIN_SECTION_BARS, "--min-bars", help="Shortest section to propose"
    ),
) -> None:
    """Propose sections from the repeats in tab.mid and write them to song.toml.

    A routine is a fixed grid of (section x tempo) cells, so the sections decide
    the shape of every run and of the progress history: this proposes them once,
    you rename and nudge them by hand, and song.toml is the truth from then on.
    Re-detecting can move a boundary, which changes the grid and makes old runs
    incomparable -- hence --redetect, like --regrid.
    """
    target = _resolve(song)
    existing = sections_mod.read(target)
    if existing and not redetect:
        console.print(
            f"[yellow]{target.toml.name} already has {len(existing)} sections.[/yellow] "
            "Edit them by hand, or pass --redetect to replace them (this starts a new "
            "comparison epoch: old routines stay readable but leave the progress line)."
        )
        _print_sections(existing)
        raise typer.Exit(code=1)

    try:
        loaded = grid_mod.load(target)
        bars = sections_mod.bar_fingerprints(
            target.tab_midi, loaded.beats_per_bar, loaded.bar_count
        )
        found = sections_mod.detect(bars, min_section=min_bars)
        if not found:
            raise StageError(f"{target.tab_midi} has no bars to divide up")
        sections_mod.write(target, found)
    except StageError as exc:
        _fail(exc)

    if len(bars) != loaded.bar_count:
        console.print(
            f"[yellow]the notation is {len(bars)} bars and the beat map is "
            f"{loaded.bar_count}[/yellow]"
        )
    _print_sections(found)
    # Not cosmetic: a routine is every section at 70/80/90/100% plus the whole
    # song at each, and every cell is played to the end. A section the song
    # plays twice is one thing to practise, so the cells count the names.
    cells = _cells(found)
    console.print(
        f"\n{len(found)} blocks, {len(sections_mod.distinct(found))} sections to practise"
        f" -> a routine of [bold]{cells} cells[/bold]"
        f" (roughly {cells * 2}-{cells * 4} minutes a run)."
    )
    alternatives = [
        f"--min-bars {other}: {_cells(sections_mod.detect(bars, min_section=other))} cells"
        for other in (4, 6, 8, 12, 16)
        if other != min_bars
    ]
    console.print("[dim]" + "  |  ".join(alternatives) + "[/dim]")
    console.print(f"written to {target.toml} -- rename and nudge them by hand.")


def _cells(found: list[sections_mod.Section]) -> int:
    """How big a routine these sections make: each at four tempos, plus the
    whole song at four."""
    return len(sections_mod.distinct(found)) * 4 + 4


def _print_sections(found: list[sections_mod.Section]) -> None:
    table = Table(box=None, header_style="bold", pad_edge=False)
    for column in ("name", "bars", "length", "same as"):
        table.add_column(column)
    seen: dict[str, int] = {}
    for index, section in enumerate(found, start=1):
        first = seen.setdefault(section.name, index)
        table.add_row(
            section.name,
            f"{section.start_bar}-{section.end_bar}",
            str(section.bars),
            "" if first == index else f"#{first}",
        )
    console.print(table)


@app.command()
def sticking(
    song: str = typer.Argument(..., help="Song slug or URL"),
    restick: bool = typer.Option(
        False, "--restick", help="Replace an existing sticking.lock.json"
    ),
    bars: str = typer.Option(None, "--bars", help="Print the letters for a bar range, e.g. 15-18"),
) -> None:
    """Work out which hand plays what, and what the hi-hat foot is doing.

    Reads the chart and kit.toml, assigns a limb to every note by minimum
    effort, and writes songs/<slug>/sticking.lock.json pinned to the chart it
    was solved from. The player draws R and L under the notation from it. It is
    a proposal: fix what it gets wrong by hand, or change the weights in
    kit.toml and re-run with --restick.
    """
    target = _resolve(song)
    existing = sticking_mod.load(target)
    if existing and not restick:
        console.print(
            f"[yellow]{sticking_mod.path_for(target).name} already exists.[/yellow] "
            "Edit it by hand, or pass --restick to solve it again."
        )
        raise typer.Exit(code=1)

    try:
        loaded = grid_mod.load(target)
        the_kit = kit_mod.load()
        solved = sticking_mod.solve(
            target, the_kit, tempo_bpm=loaded.score.bpm, beats_per_bar=loaded.beats_per_bar
        )
        sticking_mod.save(target, solved)
    except StageError as exc:
        _fail(exc)

    hands = [s for s in solved.strokes if s.limb in kit_mod.HANDS]
    right = sum(1 for s in hands if s.limb == "right_hand")
    table = Table(box=None, show_header=False, pad_edge=False)
    table.add_column(style="bold")
    table.add_column(overflow="fold")
    table.add_row("notes", f"{len(solved.strokes)} ({len(hands)} by hand, {len(solved.strokes) - len(hands)} by foot)")
    table.add_row("hands", f"{right} right, {len(hands) - right} left")
    table.add_row("hi-hat", f"{len(solved.hat)} foot changes")
    table.add_row("cost", f"{solved.cost:g} at {solved.tempo_bpm:.1f} BPM")
    table.add_row("chart", solved.chart)
    console.print(table)
    for note in solved.notes:
        console.print(f"[yellow]{note}[/yellow]")
    if bars:
        _print_sticking(solved, bars)
    console.print(f"\nwritten to {sticking_mod.path_for(target)}")


def _print_sticking(solved: sticking_mod.Sticking, bars: str) -> None:
    """The letters for a few bars, as a drummer would read them."""
    try:
        first, _, last = bars.partition("-")
        low, high = int(first), int(last or first)
    except ValueError as exc:
        raise typer.BadParameter(f"--bars wants something like 15-18, got {bars!r}") from exc
    console.print()
    per_bar = solved.beats_per_bar * 4
    for bar in range(low, high + 1):
        letters = [""] * per_bar
        for stroke in solved.strokes:
            if stroke.bar != bar or stroke.limb not in kit_mod.HANDS:
                continue
            # Two hands on one sixteenth is a two-letter cell, e.g. "RL".
            letters[stroke.slot] += "R" if stroke.limb == "right_hand" else "L"
        console.print(f"  [dim]{bar:3d}[/dim]  " + " ".join((c or ".").ljust(2) for c in letters))


@app.command()
def straighten(
    song: str = typer.Argument(..., help="Song slug or URL"),
    bpm: float = typer.Option(None, "--bpm", help="Target tempo; default rounds the grid tempo"),
) -> None:
    """Render tempo-straightened stems to author MIDI against in a DAW.

    Set the DAW to the printed BPM, drop stems/straight-nodrums.wav (or -mix,
    -drums) at 1|1|1, and bar k of the DAW is bar k of the song. Check the
    alignment by ear with debug/straight_click.wav first.
    """
    target = _resolve(song)
    try:
        loaded = grid_mod.load(target)
        info = straighten_mod.straighten(target, loaded, bpm=bpm)
        click = straighten_mod.render_check_click(target, info)
    except StageError as exc:
        _fail(exc)
    for path in info.written:
        console.print(f"[green]{path}[/green]")
    console.print()
    console.print(
        f"DAW tempo: [bold]{info.bpm:g} BPM[/bold], {info.beats_per_bar}/4, "
        f"bar 1 at 1|1|1 (= {info.start_time:.2f}s in the video)"
    )
    console.print(f"check by ear: {click}")


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


@app.command(name="songs")
def list_songs() -> None:
    """List fetched songs and how far each has got."""
    found = paths.all_songs()
    if not found:
        console.print("[dim]no songs yet -- `drums fetch <url>`[/dim]")
        return
    table = Table(box=None, header_style="bold", pad_edge=False)
    for column in ("slug", "mix", "video", "stems", "beats", "grid", "bpm", "bars"):
        table.add_column(column)
    for song in found:
        locked = None
        if song.grid_lock.exists():
            try:
                locked = grid_mod.load(song)
            except StageError:
                locked = None
        table.add_row(
            song.slug,
            "OK" if song.mix.exists() else "-",
            "OK" if song.video.exists() else "-",
            "OK" if song.drums.exists() else "-",
            "OK" if song.raw_beats.exists() else "-",
            "OK" if song.grid_lock.exists() else "-",
            f"{locked.score.bpm:.1f}" if locked else "-",
            str(locked.bar_count) if locked else "-",
        )
    console.print(table)


@app.command(name="models")
def list_models() -> None:
    """List the separation models the pipeline can use."""
    table = Table(box=None, header_style="bold", pad_edge=False)
    for column in ("key", "arch", "drums SDR", "notes"):
        table.add_column(column, overflow="fold")
    for model in separation.available():
        key = model.key + (" (default)" if model.key == separation.DEFAULT_MODEL else "")
        table.add_row(key, model.arch, f"{model.drums_sdr:.1f}" if model.drums_sdr else "-", model.notes)
    console.print(table)


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
