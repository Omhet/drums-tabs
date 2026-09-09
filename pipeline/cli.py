"""drums-tabs command line entry point."""

from __future__ import annotations

import typer
from rich.console import Console
from rich.table import Table

from pipeline import doctor as doctor_mod

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


if __name__ == "__main__":
    app()
