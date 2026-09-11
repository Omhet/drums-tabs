"""Per-song directory layout, and the tiny bit of metadata that pins it.

Every stage communicates through files under ``songs/<slug>/``. Nothing in the
pipeline holds state between stages, so a run can be resumed, inspected, or
partially redone with a shell and an audio editor.

What is tracked in git per song is deliberately small: ``song.toml`` (what this
song is and which models to use) and ``grid.lock.json`` (the keystone). Audio,
stems and debug renders are large and regenerable, so ``.gitignore`` drops them.
"""

from __future__ import annotations

import re
import tomllib
import unicodedata
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SONGS_DIR = REPO_ROOT / "songs"


def slugify(text: str) -> str:
    """A filesystem- and URL-safe directory name derived from a video title.

    Windows path components can't contain ``<>:"/\\|?*``, and song titles are
    full of them, so this is stricter than a typical slugifier: ASCII letters,
    digits and single hyphens only.
    """
    normalized = unicodedata.normalize("NFKD", text)
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_only).strip("-").lower()
    slug = re.sub(r"-{2,}", "-", slug)
    return slug[:60].strip("-") or "untitled"


@dataclass(frozen=True)
class Song:
    """Paths for one song. Construct via :func:`song_dir`, not directly."""

    slug: str
    root: Path

    # --- inputs -------------------------------------------------------------
    @property
    def toml(self) -> Path:
        return self.root / "song.toml"

    @property
    def mix(self) -> Path:
        """Stereo 44.1 kHz mixdown. The timeline everything else refers to."""
        return self.root / "audio" / "mix.wav"

    @property
    def video(self) -> Path:
        return self.root / "audio" / "video.mp4"

    # --- separation ---------------------------------------------------------
    @property
    def stems_dir(self) -> Path:
        return self.root / "stems"

    @property
    def drums(self) -> Path:
        return self.stems_dir / "drums.wav"

    @property
    def nodrums(self) -> Path:
        """Everything except drums -- the play-along backing track."""
        return self.stems_dir / "nodrums.wav"

    def straight(self, name: str) -> Path:
        """Tempo-straightened render of mix/drums/nodrums for DAW authoring."""
        return self.stems_dir / f"straight-{name}.wav"

    @property
    def straight_json(self) -> Path:
        """What tempo the straightened renders were made at, and where bar 1 sits."""
        return self.stems_dir / "straight.json"

    @property
    def tab_midi(self) -> Path:
        """The hand-authored notation: constant-tempo MIDI whose bar 1 is grid bar 1."""
        return self.root / "tab.mid"

    # --- analysis -----------------------------------------------------------
    @property
    def raw_beats(self) -> Path:
        """``beat_this`` output, before any repair. Kept so grid repair is auditable."""
        return self.root / "analysis" / "raw.beats"

    @property
    def grid_lock(self) -> Path:
        return self.root / "grid.lock.json"

    # --- debug artifacts ----------------------------------------------------
    @property
    def debug_dir(self) -> Path:
        return self.root / "debug"

    @property
    def grid_png(self) -> Path:
        return self.debug_dir / "grid.png"

    @property
    def beat_click(self) -> Path:
        return self.debug_dir / "beat_click.wav"

    def ensure_dirs(self) -> None:
        for path in (
            self.root,
            self.root / "audio",
            self.stems_dir,
            self.root / "analysis",
            self.debug_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)

    def meta(self) -> dict:
        """Parsed ``song.toml``, or an empty dict if the song hasn't been fetched."""
        if not self.toml.exists():
            return {}
        with self.toml.open("rb") as handle:
            return tomllib.load(handle)


def song_dir(slug: str) -> Song:
    return Song(slug=slug, root=SONGS_DIR / slug)


def all_songs() -> list[Song]:
    if not SONGS_DIR.exists():
        return []
    return [
        song_dir(child.name)
        for child in sorted(SONGS_DIR.iterdir())
        if (child / "song.toml").exists()
    ]


def find_by_video_id(video_id: str) -> Song | None:
    """Locate an already-fetched song by YouTube id.

    Titles get edited and slugs change; the video id doesn't. This is what makes
    re-running ``fetch`` on the same URL idempotent instead of producing a second
    directory with a slightly different name.
    """
    for song in all_songs():
        if song.meta().get("source", {}).get("video_id") == video_id:
            return song
    return None


def resolve(slug_or_url: str) -> Song:
    """Accept either a slug or the original URL wherever a song is named."""
    from pipeline.fetch import extract_video_id  # local: avoids an import cycle

    video_id = extract_video_id(slug_or_url)
    if video_id:
        found = find_by_video_id(video_id)
        if found:
            return found
    return song_dir(slug_or_url)


def _toml_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_toml_value(v) for v in value) + "]"
    text = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{text}"'


def write_toml(path: Path, sections: dict[str, dict]) -> None:
    """Serialise the flat, one-level-of-sections subset of TOML we actually use.

    Python 3.11 ships ``tomllib`` for reading but nothing for writing, and
    ``song.toml`` is shallow enough that a dependency for this would be silly.
    """
    lines: list[str] = []
    for name, body in sections.items():
        lines.append(f"[{name}]")
        for key, value in body.items():
            if value is None:
                continue
            lines.append(f"{key} = {_toml_value(value)}")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")
