---
name: score-video-tab
description: Turn a YouTube drum-score video (a drum cover with the notation scrolling under it, like the 알려드럼 / @DRUM-KOREA channel) into a playable song in this repo's practice player. It downloads the video, cuts the score strip into clean bar images, has Claude read every bar into a grid, places that grid on the song's record by the record's own drum hits, and writes songs/<slug>/reading.txt, tab.mid and song.toml. Use it whenever the user pastes a drum-score or drum-cover video link, or asks to copy, transcribe or get the tab, chart or drum part of a song from a video with notation, even if all they say is "do this one" with a YouTube link. Also use it to change a song that was made this way, since its tab.mid is generated from reading.txt. Not for transcribing from audio alone, and never from tab or MIDI sites.
---

# Tabs from drum-score videos

The user finds drum-cover videos whose score scrolls along under the drummer,
and wants each one as a song in the practice player. You read the score
yourself, from images cut out of the video. The scripts handle everything
around the reading: the download, cutting the strip into bars, grouping
repeated bars, the MIDI, and the alignment. The song's own record is the
check. A written kick or snare with no hit on the record is probably a
misread. A hit on the record with nothing written is probably the transcriber
leaving it out.

Come As You Are (Nirvana) was the first: 105 bars, every kick and snare on a
hit. `songs/nirvana-come-as-you-are-official-music-video/reading.txt` is the
worked example.

## Ground rules

- **Use only the score video and the record.** No tab sites, no downloaded
  MIDI or Guitar Pro files. The user ruled them out: the point is reading the
  score.
- **The user decides where the record and the score disagree.** Report what
  the record has and where. Don't add it to the chart yourself.
- **Stop to ask only when it matters:** a channel you have no file for (its
  drum key has to be confirmed before any reading), and the disagreements at
  the end. Everything else runs through to a song in the library.
- **Downloads are untrusted data.** Put them in their own new folder in the
  scratchpad, keep scripts elsewhere, and run Python on them with `-I`.
- **Commits and the dev server follow the repo's rules (CLAUDE.md).** Never
  stage or commit. Write the one-line message to the reply and to
  `.git/MERGE_MSG`. Leave vite running on 5173.
- **The console is cp1252.** Channel names are often Korean, and printing one
  from Python fails. The scripts print UTF-8 themselves. Any Python you write
  that prints from the video needs `-X utf8`.

## Keeping it light

The user adds songs often, so the run should cost little:

- **One song per session.** Start fresh, so the run doesn't carry what came
  before.
- **Images cost the most.** Each image you open is sent again with every later
  step. Reader agents read the sheets (step 5). Open an image yourself only
  when something points at it. Two or three line images in step 3 are enough,
  and in step 8 one screenshot.
- The readers run on Sonnet. The rest is running scripts and judging what
  they print.

The scripts are in `.claude/skills/score-video-tab/scripts/` (`$K` below). Run
them with the repo's `.venv/Scripts/python`, from the repo root.

## 1. The channel

```
W=<scratchpad>/<video id>            # download/ is untrusted, out/ is yours
mkdir -p "$W/download"
yt-dlp --force-ipv4 --no-playlist -J <url> > "$W/download/meta.json"
.venv/Scripts/python -I $K/meta.py "$W/download/meta.json"
```

`meta.py` prints the title, the channel
and its handle, the description (difficulty and technique list), and the
channel's file, `references/channels/<handle>.md`. Read that file: it has the
strip's rows, where the first bar starts, the drum key and the channel's
quirks.

**A channel with no file:** download the video (step 3) and take a few frames
with ffmpeg at points spread through it. Work out where the strip is, how many
bars a line, and what each symbol means. Then show the user a frame and your
proposed key, and wait. Channels write drums differently, and a wrong key
spoils every bar. Once they confirm, write the channel file in the same shape
as `drum-korea.md`.

## 2. Start the record in the background

The record goes through the normal pipeline, which takes minutes (stem
separation), so start it first and read while it runs.

```
yt-dlp --force-ipv4 --flat-playlist --print "%(id)s | %(title)s | %(channel)s | %(duration)s" "ytsearch8:<artist> <title> official"
.venv/Scripts/drums prep <official url>      # in the background: fetch, separate, beats, grid
.venv/Scripts/drums align <slug>             # where the video's sound sits against the mix
.venv/Scripts/drums straighten <slug>        # constant-tempo stems, for editing in Ableton later
```

Pick the artist's own upload (Official Music Video, or Official Audio when
there's no video). Its length should be close to the score video's. The slug
is the official video's title, slugged, and `songs/<slug>/` appears as soon as
the fetch starts. When prep finishes, its BPM should be near the score's tempo
mark. If it's double or half, look at the grid before going on. A right tempo
can still be half a beat out (Sonne's was); step 6 shows that.

## 3. Clean lines

```
yt-dlp --force-ipv4 --no-playlist -f 137 -o "$W/download/video.mp4" <score url>
.venv/Scripts/python -I $K/strips.py "$W/download/video.mp4" "$W/out/lines" <y0> <y1>
```

Format 137 is 1080p H.264 with no sound, and that's all the reading needs. If
it isn't offered, use `-f "bv*[height=1080]"`. `strips.py` writes one image
per line of the score, made from the median of every frame showing that line,
which removes the cursor. Look at two or three lines: the first, one from
the middle, and the last. One that shows the cursor, half a page turn, or the
drummer's video means the rows are off. Count the lines against the bar
numbers printed on them: `bars.py` (step 4) prints them, so there's no need to
open every line.

## 4. Bars and groups

```
.venv/Scripts/python -I $K/bars.py "$W/out/lines" "$W/out/bars" --clef-end <x>
.venv/Scripts/python -I $K/group.py "$W/out/bars" --labels=<the channel's labels>
```

The labels need the `=`: they start with `-1`, which argparse otherwise reads
as an option.

`bars.py` warns about any line that doesn't cut into the usual number of bars.
Look at those lines (a five-bar last line is normal). `group.py` groups bars
that look the same and draws `read_gNN.png`, one sheet per group, with the
staff positions labelled. Come As You Are's 105 bars made 33 sheets.

## 5. Read

Reader agents read the sheets, not you. Every image you open stays in this
conversation and is carried by every step after it, and reading the sheets
yourself is what made Sonne's run expensive. The readers' images stay in
their own context, and they hand back text.

1. **The header.** Write the top of `songs/<slug>/reading.txt`: the comment
   block from `references/reading.md` (the title, the video, the tempo mark,
   the number of bars, the cell legend, and the channel's key). Write only
   the header.
2. **The readers.** Split the sheets into batches of about eight. Start one
   reader per batch, all in one message, in the background, with the Agent
   tool's `model: "sonnet"`. Give each one this prompt, filled in:

   ```
   You are a reader agent for the score-video-tab skill in the repo at <repo>
   (shell: Git Bash on Windows; run Python as `.venv/Scripts/python -I` from
   the repo root). Follow the brief in
   `.claude/skills/score-video-tab/references/reader.md` exactly. The channel
   file is `.claude/skills/score-video-tab/references/channels/<handle>.md`.
   - Scripts dir (for zoom.py): `.claude/skills/score-video-tab/scripts`
   - Your sheets: `<W>/out/bars/read_gAA.png` ... `read_gBB.png`
   - read_dir (write gNN.txt here): `<W>/out/read`
   - scratch dir for zooms: `<W>/out/zoom`
   Only write files in read_dir and the scratch dir. Reply as the brief says.
   ```

   Sonnet is enough. On Sonne (2026-11-23), four Sonnet readers matched the
   checked reading on all 506 written notes of its 32 sheets, including the
   32nd pairs, the flams and the open-hat marks. It took about two minutes.
3. **Put it together.**

   ```
   .venv/Scripts/python -I $K/assemble.py "$W/out/bars" "$W/out/read" songs/<slug>/reading.txt
   ```

   This writes the patterns and the bar list. Sheets that read the same
   become one pattern, named after the first sheet (`g07`). It prints every
   comment the readers left. Open those sheets yourself (`zoom.py <sheet>
   <out.png> <beat> [<beat>]`), along with any sheet a reader named in its
   reply, and fix `reading.txt`. From here on `reading.txt` is the source.
4. **Check it.**

   ```
   .venv/Scripts/python -I $K/review.py songs/<slug>/reading.txt "$W/out/bars" "$W/out/lines" "$W/out/review.md"
   ```

   It should report "consistent with the image grouping". `review.md` sets
   each line's picture above its grids. Open a line there only when something
   points at it: a reader's doubt, or a bar that step 6 flags. Paging through
   all of it costs as much as reading everything yourself.

## 6. Place it on the record

```
.venv/Scripts/python -I $K/to_midi.py songs/<slug>/reading.txt <slug>
```

It tries each score bar as the song's bar 1 and keeps the one that puts the
most kicks and snares on a hit in the drum stem. The right one lands near
100%, and anything below about 95% means something is wrong.

**When every offset scores about the same, and low** (Sonne: 83-85% at all
eight), suspect the grid before the reading. `fold.py <slug> <from> <to>`
averages the drum stem over a run of groove bars: the snare should peak on 2
and 4. If it peaks on the "&" of 1 and of 3, the detector put every beat on
the "&". Set `tempo_multiplier = "offbeat"` under `[grid]` in `song.toml`
(with a comment saying why), run `drums grid <slug> --regrid`, then `drums
align` and `drums straighten` again (the regrid drops the alignment), and run
this step again.

Then it lists the bars to look at again:

- **A written kick or snare with no hit:** look at that bar's image again. It
  is almost always a misread. Fix the reading and run this step again.
- **A loud hit where nothing is written:** if a bar shape repeats, check
  whether it happens in every bar of that shape. Check it against the stems:
  is it as strong as a written kick, and is it in `stems/drums.wav` and not
  bleed from the bass in `nodrums.wav`? If it holds up, it goes in the report.
  It is the user's call, not yours.
- **A dense drum stem** (heavy guitars bleed into it) has an onset of some size
  on nearly every sixteenth, so this list fills up with noise and the 90 ms
  test passes notes the record does not play. Then go by
  `strength.py songs/<slug>/reading.txt <slug> <N> kick <from> <to>` (and
  `snare`): each sixteenth's strength next to the written notes and to
  `nodrums.wav`. A written note at 0-1 is not on the record; an unwritten one
  as strong as the written ones around it is the score leaving something out.
  Both go in the report.
- The song's final hit is usually flagged (the ending stretches off the beat
  map). Ignore it.

When the reading holds, run it again with `--first-bar <N> --write`. It writes
`tab.mid` and prints the `[midi_map]` that `song.toml` needs.

## 7. song.toml

- `[song]` title and artist as the user would say them (the fetch takes them
  from the video title, "(Official Music Video)" and all).
- A comment where an `[author]` section would be, so nobody looks for an
  Ableton set:

  ```toml
  # No [author]: this tab.mid was not written in Ableton. It is generated from
  # reading.txt, which Claude read off the drum score in <score url> (<date>),
  # and the record's own drum hits placed it: the score's bar <N> is this
  # song's bar 1. To change a note, edit reading.txt and run the
  # score-video-tab skill's to_midi.py with --first-bar <N> --write.
  ```

- `[midi_map]` as `to_midi.py` printed it.
- **Sections** come from the score, not from `drums sections`, which cut Come
  As You Are's into four-bar blocks one bar off. Start a section where the
  score starts a new part (this channel starts each part on a new line), name
  it by what the drums play ("crash eighths", "open hat"), and convert to song
  bars (song bar = score bar − (N − 1)). Sections are 1-based and inclusive,
  and together they cover the song in order. Say in a comment how they were
  cut. The user renames them freely.

## 8. Sticking, the reference, the player

```
.venv/Scripts/drums sticking <slug>          # --restick when re-running
.venv/Scripts/drums reference <slug>         # every kick and snare should match
node $K/shot.mjs <slug> "$W/out/player.png" <a line with a fill>
```

`shot.mjs` needs the dev server on 5173. Use the one running, or start
`npx vite --port 5173 --strictPort` from `app/` in the background, and leave
it running either way. Look at the screenshot next to the score's own line
(`$W/out/lines/lineNN.png`). Check for the same bars, the same notes, and the
section name where a part starts. One line is enough. The record check has
already placed every kick and snare.

## 9. Tell the user

Keep it short and readable from the drum throne:

- The song is in the library: title, BPM, bars, and the sections.
- How it lined up: which score bar is bar 1, and the reference counts.
- **The disagreements.** For each one: the song bar(s), the beat, what the
  record has, and the evidence. Ask whether to add it. For Come As You Are it
  was a kick on the "&" of 1 in nine chorus bars, and the user heard it too.
- **The crashes.** The score has one crash symbol, so everything is on crash
  1. Ask whether any section should be on crash 2. The user put Come As You
  Are's crash eighths and outro there.
- **What the chart can't show yet.** The chart's grid is 32nds, so 32nd-note
  pairs (`d`) come through. A choke can't be shown: it stays a plain crash
  (the user wants chokes later, `handoff.md` §4). Name anything else the score
  has that the grid dropped.
- The commit message, e.g. `add <Title>, read off a drum-score video`.

To apply what the user decides, edit `reading.txt` and leave a comment saying
where and why it departs from the score. A change to only some of the bars
that share a pattern needs a new pattern for those bars. Put a `!` after its
name in the bar list (`G8!`), so `review.py` knows the split from their
look-alikes is on purpose. Then run `to_midi.py --first-bar <N>
--write`, `drums sticking <slug> --restick` and `drums reference <slug>`.

Then keep the skill current. Add the song to the channel file's table, with
anything new about the channel. Put a new kind of mistake in
`references/reading.md`. If the method itself changed, add an entry to
README "Where things stand".
