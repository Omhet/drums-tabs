"""Subprocess plumbing shared by the stages that shell out.

Every model stage lives in its own ``uv`` tool environment, so most of what this
pipeline does is "run that executable, pass it file paths, wait". Two rules hold
throughout: argument lists, never ``shell=True``; and stream the child's output
so a five-minute separation pass isn't a silent hang.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


class StageError(RuntimeError):
    """A stage's external tool failed. Message is meant for the user, not a stack trace."""


def tool_bin(tool: str, executable: str) -> Path:
    """Path to an executable inside a ``uv tool install`` environment.

    Resolved rather than assumed: the tools are deliberately *not* on PATH, so
    that upgrading one can't silently change what another stage runs.
    """
    proc = subprocess.run(
        ["uv", "tool", "dir"], capture_output=True, text=True, check=False
    )
    if proc.returncode != 0:
        raise StageError("`uv tool dir` failed -- is uv installed and on PATH?")
    root = Path(proc.stdout.strip()) / tool
    for candidate in (
        root / "Scripts" / f"{executable}.exe",
        root / "bin" / executable,
    ):
        if candidate.exists():
            return candidate
    raise StageError(
        f"{executable} not found in the '{tool}' tool environment ({root}).\n"
        f"  try: uv tool install {tool} --python 3.11 --torch-backend=cu128"
    )


def run(cmd: list[str | Path], *, quiet: bool = False, cwd: Path | None = None) -> None:
    """Run a command, streaming its output, and raise :class:`StageError` on failure."""
    argv = [str(part) for part in cmd]
    proc = subprocess.run(
        argv,
        cwd=str(cwd) if cwd else None,
        check=False,
        stdout=subprocess.DEVNULL if quiet else None,
        stderr=subprocess.STDOUT if quiet else None,
    )
    if proc.returncode != 0:
        raise StageError(f"{Path(argv[0]).name} failed (exit {proc.returncode})")


def capture(cmd: list[str | Path]) -> str:
    """Run a command and return stdout, raising :class:`StageError` on failure."""
    argv = [str(part) for part in cmd]
    proc = subprocess.run(argv, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        tail = detail[-1] if detail else f"exit {proc.returncode}"
        raise StageError(f"{Path(argv[0]).name} failed: {tail}")
    return proc.stdout


def require_on_path(name: str) -> str:
    found = shutil.which(name)
    if found is None:
        raise StageError(f"{name} is not on PATH -- run `drums doctor`")
    return found


def note(message: str) -> None:
    """Progress line for long stages. Goes to stderr so stdout stays pipeable."""
    print(message, file=sys.stderr, flush=True)
