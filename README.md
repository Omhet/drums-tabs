# drums-tabs

A drum practice player: hand-authored notation scrolling over a drum-cover
video, synced to the drummer, with a mixer over the backing track, the drum stem
and a click, and a tempo control.

The earlier automatic-transcription work lives on the `transcriber` branch.

## Per song

```
songs/<slug>/
  song.toml                 what the song is (url, title, duration)
  grid.lock.json            the real time of every beat the drummer played
  tab.mid                   your notation: constant-tempo MIDI, bar 1 = song bar 1
  audio/mix.wav, video.mp4  (untracked) the media
  stems/drums.wav, nodrums.wav          (untracked) separated stems
  stems/straight-*.wav, straight.json   (untracked) tempo-straightened renders for authoring
```

## Workflow

1. **Media and beat map** (once per song, needs the Python toolchain, see `drums doctor`):

   ```
   drums prep <youtube url>      # fetch, separate, detect beats, build the grid
   drums straighten <slug>       # render stems warped to a constant tempo
   ```

   Listen to `debug/straight_click.wav`: a click that sits on every hit for the
   whole song means the beat map is right.

2. **Author** in Ableton: set the project tempo to the BPM `straighten` printed,
   drop `stems/straight-nodrums.wav` (or `-drums`, `-mix`) at 1|1|1, write or
   play in the part on a drum rack. Point `song.toml` at the set and name the
   pads' MIDI keys:

   ```toml
   [author]
   als = "C:/Users/me/Music/Ableton/Projects/Song Project/Song.als"
   track = "1-Sticks Kit"        # the MIDI track to read

   [midi_map]
   36 = "kick"
   37 = "snare"
   38 = "hihat_closed"           # hihat_open, hihat_pedal, crash, crash2,
   ```                           # tom_high, tom_mid, tom_floor, ride

   Every save of the set (Ctrl+S) rewrites `songs/<slug>/tab.mid` from the
   arrangement clips on that track and reloads the player. A `tab.mid` exported
   by hand from any DAW works the same, without the `[author]` section.

3. **Play** with `cd app && npm run dev`.

## Where things stand

Done: media pipeline, straightened authoring stems, Ableton set -> `tab.mid`
-> notation (`app/src/midi-tab.ts`), four bars per line, cursor, space to
play/pause. Playback is still alphaTab's own synth; the video is not in the
page yet.

Next, in order, each reviewable in the browser:

3. **Video and sync.** `audio/video.mp4` in the page as the master clock;
   alphaTab in `PlayerMode.EnabledExternalMedia` with an `IExternalMediaHandler`
   (we push media time in, alphaTab pushes play/pause/seek/rate out); the beat
   map fed through `Score.applyFlatSyncPoints()` as `{barIndex, barPosition,
   millisecondOffset}` (bar 1 = `beats[bar_one_beat]`, the count-in bar before
   it is bar index 0 of the grid, not of the notation). Cursor follows the
   drummer, click on the score seeks. Drop the soundfont.
4. **Mixer and tempo.** Three gains in one Web Audio graph over
   `<audio>`/`<video>` elements: no-drums stem, drums stem, click synthesised
   on the beat map. Tempo via `api.playbackSpeed` only (alphaTab derives the
   cursor animation from it), `preservesPitch` on the elements.
5. **Overlay layout.** Notation over the video: 4 bars per line, N lines
   visible (2 by default), auto-scroll to the next line when the current one
   ends. Keyboard shortcuts.

The archived research on alphaTab's external-media mode, drift correction
between media elements and the sweep is in the old plan:
`git show transcriber:player-plan.md` (sections "Transport", "Sync points",
"Notation window").

Headless checks in `app/scripts/`: `smoke.mjs` (render + playback),
`shot.mjs <png>` (screenshot + sample alphaTex), `check-ui.mjs <png>` (drives
Space, inspects cursor and chrome). They need `npm run dev` running.
