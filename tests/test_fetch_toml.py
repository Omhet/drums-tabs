"""Re-fetching a song keeps everything in song.toml that fetch does not own.

``drums fetch`` on a song already here used to write song.toml from its own
four tables, and with them gone went the [author] and [midi_map] the user
typed, the [[section]]s they named, and the comments explaining them. Now it
sets its own keys in place and every other line comes back as it was.
"""

from __future__ import annotations

import tomllib

from pipeline.fetch import VideoInfo, song_toml
from pipeline.paths import update_toml

EXISTING = """\
# What the player and the library call the song.
[song]
artist = "Blur"
title = "Song 2"

[source]
url = "https://www.youtube.com/watch?v=old"
video_id = "SSbBvKaM6sk"
title = "Blur - Song 2 (Official Music Video)"
uploader = "Blur"
duration = 121.0

[models]
separation = "htdemucs_ft"

[grid]
meter = ""
tempo_multiplier = ""
downbeat_rotation = 2

# Where the notation is authored.
[author]
als = "C:/sets/Song 2.als"
track = "1-Sticks Kit"

# MIDI key -> instrument.
[midi_map]
36 = "kick"
37 = "snare"

# The song's sections: yours to rename.

[[section]]
name = "verse"
start_bar = 1
end_bar = 7

[[section]]
name = "chorus"  # the loud one
start_bar = 8
end_bar = 16

[cover]
title = "a table fetch has never heard of"
"""

INFO = VideoInfo(
    video_id="SSbBvKaM6sk",
    title="Blur - Song 2 (Official Music Video) [Remastered]",
    uploader="Blur Official",
    duration=122.5,
)


def refetch(tmp_path, text: str) -> tuple[str, dict]:
    path = tmp_path / "song.toml"
    path.write_text(text, encoding="utf-8")
    meta = tomllib.loads(text) if text else {}
    update_toml(path, song_toml("https://www.youtube.com/watch?v=SSbBvKaM6sk", INFO, meta))
    after = path.read_text(encoding="utf-8")
    return after, tomllib.loads(after)


def test_a_refetch_keeps_every_table_it_does_not_own(tmp_path):
    _, meta = refetch(tmp_path, EXISTING)
    before = tomllib.loads(EXISTING)
    for table in ("author", "midi_map", "section", "cover"):
        assert meta[table] == before[table], table


def test_a_refetch_keeps_the_comments(tmp_path):
    after, _ = refetch(tmp_path, EXISTING)
    for line in EXISTING.splitlines():
        if line.lstrip().startswith("#") or "#" in line.split("=", 1)[-1]:
            assert line in after.splitlines(), line


def test_it_updates_what_it_owns_and_keeps_what_was_shortened(tmp_path):
    _, meta = refetch(tmp_path, EXISTING)
    # The source is the video as it is now.
    assert meta["source"]["url"] == "https://www.youtube.com/watch?v=SSbBvKaM6sk"
    assert meta["source"]["title"] == INFO.title
    assert meta["source"]["duration"] == 122.5
    # The names the user shortened them to, and the knobs they set, stay.
    assert meta["song"] == {"artist": "Blur", "title": "Song 2"}
    assert meta["models"]["separation"] == "htdemucs_ft"
    assert meta["grid"]["downbeat_rotation"] == 2


def test_only_the_lines_it_owns_change(tmp_path):
    after, _ = refetch(tmp_path, EXISTING)
    old = EXISTING.splitlines()
    new = after.splitlines()
    assert len(old) == len(new)
    changed = [(a, b) for a, b in zip(old, new) if a != b]
    assert [b for _, b in changed] == [
        'url = "https://www.youtube.com/watch?v=SSbBvKaM6sk"',
        'title = "Blur - Song 2 (Official Music Video) [Remastered]"',
        'uploader = "Blur Official"',
        "duration = 122.5",
    ]


def test_a_table_it_owns_that_is_missing_is_added(tmp_path):
    text = EXISTING.replace("[models]\nseparation = \"htdemucs_ft\"\n\n", "")
    _, meta = refetch(tmp_path, text)
    assert meta["models"] == {"separation": ""}
    assert meta["midi_map"] == {"36": "kick", "37": "snare"}


def test_a_new_song_is_written_whole(tmp_path):
    path = tmp_path / "song.toml"
    update_toml(path, song_toml("https://youtu.be/x", INFO, {}))
    meta = tomllib.loads(path.read_text(encoding="utf-8"))
    assert meta["song"] == {"artist": INFO.uploader, "title": INFO.title}
    assert set(meta) == {"song", "source", "models", "grid"}
