"""Song naming and URL handling.

Small, but the two places a mistake is expensive: a slug that Windows rejects
fails only once a title happens to contain a colon, and a video id parsed wrong
means re-fetching a song creates a second directory instead of reusing the first
-- which silently orphans a grid and everything pinned to it.
"""

from __future__ import annotations

import pytest

from pipeline.fetch import extract_video_id
from pipeline.paths import slugify

WINDOWS_FORBIDDEN = r'<>:"/\|?*'


@pytest.mark.parametrize(
    "title, expected",
    [
        ("Song 2 - Blur DRUM COVER", "song-2-blur-drum-cover"),
        ("ENGEL - Rammstein  DRUM COVER", "engel-rammstein-drum-cover"),
        ("Stayin' Alive - Bee Gees", "stayin-alive-bee-gees"),
        ("  leading and trailing  ", "leading-and-trailing"),
        ("Máneskin — Beggin'", "maneskin-beggin"),
    ],
)
def test_slugify(title, expected):
    assert slugify(title) == expected


def test_slugify_strips_characters_windows_rejects_in_paths():
    slug = slugify('AC/DC: "Back" in Black <live> | 100%?')
    assert not any(char in slug for char in WINDOWS_FORBIDDEN)
    assert slug == "ac-dc-back-in-black-live-100"


def test_slugify_never_returns_empty():
    """A title of nothing but symbols still needs a directory name."""
    assert slugify("???") == "untitled"
    assert slugify("") == "untitled"


def test_slugify_is_bounded():
    assert len(slugify("word " * 100)) <= 60


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/watch?v=6ma6WF_wtSM",
        "https://youtu.be/6ma6WF_wtSM",
        "https://www.youtube.com/watch?v=6ma6WF_wtSM&list=PLxyz&index=2",
        "https://www.youtube.com/embed/6ma6WF_wtSM",
        "https://www.youtube.com/shorts/6ma6WF_wtSM",
        "6ma6WF_wtSM",
    ],
)
def test_extract_video_id_handles_every_url_shape(url):
    assert extract_video_id(url) == "6ma6WF_wtSM"


@pytest.mark.parametrize("text", ["song-2-blur-drum-cover", "engel", "", "not a url"])
def test_slugs_are_not_mistaken_for_video_ids(text):
    """Commands accept a slug or a URL, so this is the discriminator."""
    assert extract_video_id(text) is None


def _info(uploader="Official Arctic Monkeys", title="Arctic Monkeys - One For The Road (Official Video)"):
    from pipeline.fetch import VideoInfo

    return VideoInfo(video_id="qN7gSMPQFss", title=title, uploader=uploader, duration=206.0)


def test_a_new_song_is_named_from_the_channel_and_the_whole_title():
    from pipeline.fetch import song_toml

    toml = song_toml("https://youtu.be/qN7gSMPQFss", _info(), {})
    assert toml["song"] == {
        "artist": "Official Arctic Monkeys",
        "title": "Arctic Monkeys - One For The Road (Official Video)",
    }
    # [song] first: it is the part of the file the user edits.
    assert next(iter(toml)) == "song"
    assert toml["source"]["uploader"] == "Official Arctic Monkeys"


def test_a_refetch_keeps_the_names_the_user_shortened():
    from pipeline.fetch import song_toml

    kept = {"song": {"artist": "Arctic Monkeys", "title": "One For The Road"}}
    toml = song_toml("https://youtu.be/qN7gSMPQFss", _info(), kept)
    assert toml["song"] == {"artist": "Arctic Monkeys", "title": "One For The Road"}


def test_the_names_round_trip_through_song_toml(tmp_path):
    import tomllib

    from pipeline import paths
    from pipeline.fetch import song_toml

    path = tmp_path / "song.toml"
    paths.write_toml(path, song_toml("u", _info(uploader="Blur", title='Blur - "Song 2"'), {}))
    with path.open("rb") as handle:
        assert tomllib.load(handle)["song"] == {"artist": "Blur", "title": 'Blur - "Song 2"'}
