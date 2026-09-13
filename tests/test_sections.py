"""Section detection, on charts written by hand as letters.

No MIDI file and no audio: the detector works on one fingerprint per bar, so a
test chart is a string like ``"AAAABBBBAAAA"`` where each letter is a bar that
looks a particular way on the page. That keeps the tests about the thing that
is actually hard -- where the boundaries land -- rather than about parsing.
"""

from __future__ import annotations

import pytest

from pipeline import sections as sections_mod
from pipeline.paths import Song
from pipeline.sections import Section


def chart(letters: str) -> list[tuple[tuple[int, int], ...]]:
    """One bar per letter; same letter means bars that are drawn the same."""
    return [((0, ord(letter)),) for letter in letters]


def ranges(found: list[Section]) -> list[tuple[str, int, int]]:
    return [(s.name, s.start_bar, s.end_bar) for s in found]


def test_a_song_that_never_repeats_is_one_section():
    assert ranges(sections_mod.detect(chart("abcdefgh"))) == [("A", 1, 8)]


def test_a_repeated_block_gets_its_own_boundaries():
    # Eight bars of one groove, eight of another, then the first one again.
    found = sections_mod.detect(chart("aaaaaaaabbbbbbbbaaaaaaaa"))
    assert ranges(found) == [("A", 1, 8), ("B", 9, 16), ("A", 17, 24)]


def test_a_block_that_comes_back_gets_the_same_letter():
    found = sections_mod.detect(chart("abcdabcdefghefghabcdabcd"), min_section=4)
    assert ranges(found) == [("A", 1, 8), ("B", 9, 16), ("A", 17, 24)]


def test_the_same_groove_a_different_number_of_times_is_a_different_section():
    # Eight bars of a groove and four bars of it are not interchangeable to
    # practise, so they are lettered apart even though the music is the same.
    found = sections_mod.detect(chart("abcdabcdefghabcd"), min_section=4)
    assert ranges(found) == [("A", 1, 8), ("B", 9, 12), ("C", 13, 16)]


def test_a_groove_and_its_own_repeats_are_one_section():
    # The same four bars four times is one sixteen-bar section, not four:
    # the repeats are how the section is built.
    found = sections_mod.detect(chart("abcdabcdabcdabcdefgh" + "efgh"), min_section=4)
    assert ranges(found) == [("A", 1, 16), ("B", 17, 24)]


def test_short_stretches_are_merged_into_a_neighbour():
    # A two-bar tag between two eight-bar blocks is not worth practising on
    # its own, so it goes in with the block it runs into.
    found = sections_mod.detect(chart("aaaaaaaaxybbbbbbbb"), min_section=4)
    assert ranges(found) == [("A", 1, 8), ("B", 9, 18)]


def test_no_boundary_inside_a_stretch_of_identical_bars():
    # Twelve bars of one groove is one section: a repeat can be found at every
    # offset inside it, and none of them is where a section starts.
    found = sections_mod.detect(chart("a" * 12 + "b" * 8), min_section=4)
    assert ranges(found) == [("A", 1, 12), ("B", 13, 20)]


def test_a_short_song_stays_one_section():
    assert ranges(sections_mod.detect(chart("abc"), min_section=4)) == [("A", 1, 3)]


def test_no_bars_no_sections():
    assert sections_mod.detect([]) == []


def test_letters_go_past_z():
    assert sections_mod._letter(0) == "A"
    assert sections_mod._letter(25) == "Z"
    assert sections_mod._letter(26) == "AA"


def test_repeats_do_not_overlap_themselves():
    # "aaaa" is the same bar four times: the repeat of bars 1-2 at bars 2-3
    # would overlap it, and a block cannot repeat inside itself.
    for first, second, length in sections_mod.maximal_repeats(chart("aaaa")):
        assert first + length <= second


# --- song.toml surgery -------------------------------------------------------

HAND_WRITTEN = """\
[source]
title = "a song"

# The Live set this is written in.
[author]
als = "C:/sets/song.als"

[midi_map]
36 = "kick"
"""


def write_toml(tmp_path, text: str) -> Song:
    song = Song(slug="test", root=tmp_path)
    song.toml.write_text(text, encoding="utf-8")
    return song


def test_writing_sections_keeps_everything_else(tmp_path):
    song = write_toml(tmp_path, HAND_WRITTEN)
    sections_mod.write(song, [Section("A", 1, 8), Section("B", 9, 16)])
    text = song.toml.read_text(encoding="utf-8")
    assert "# The Live set this is written in." in text
    assert 'als = "C:/sets/song.als"' in text
    assert '36 = "kick"' in text
    assert ranges(sections_mod.read(song)) == [("A", 1, 8), ("B", 9, 16)]


def test_rewriting_replaces_the_old_sections(tmp_path):
    song = write_toml(tmp_path, HAND_WRITTEN)
    sections_mod.write(song, [Section("A", 1, 8), Section("B", 9, 16)])
    sections_mod.write(song, [Section("Verse", 1, 16)])
    text = song.toml.read_text(encoding="utf-8")
    assert text.count("[[section]]") == 1
    assert text.count("proposed by `drums sections`") == 1
    assert ranges(sections_mod.read(song)) == [("Verse", 1, 16)]


def test_a_song_with_no_sections_reads_as_none(tmp_path):
    song = write_toml(tmp_path, HAND_WRITTEN)
    assert sections_mod.read(song) == []


def test_a_broken_section_is_reported_not_ignored(tmp_path):
    song = write_toml(tmp_path, HAND_WRITTEN + '\n[[section]]\nname = "A"\n')
    with pytest.raises(sections_mod.StageError):
        sections_mod.read(song)
