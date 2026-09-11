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

3. **Play** with `cd app && npm run dev`. Space plays and pauses, a click on
   the score seeks the video there, Stop rewinds to the start of the video.

## Where things stand

Done: media pipeline, straightened authoring stems, Ableton set -> `tab.mid`
-> notation (`app/src/midi-tab.ts`), four bars per line, cursor, space to
play/pause, and the video as the clock: `audio/video.mp4` plays in the page
(served by `app/plugins/media.ts` at `/media/<slug>/...`, with range requests),
alphaTab runs in `PlayerMode.EnabledExternalMedia` with the video element as
its `IExternalMediaHandler` (`app/src/media.ts`), and the beat map goes in as
one sync point per played beat (`app/src/syncpoints.ts`). The cursor follows
the drummer, clicking the score seeks the video, the tempo slider slows the
video, Stop rewinds to the top of the count-in. No soundfont, no synth.

Two things learned on the way, both encoded in `syncpoints.ts`: notation bar 1
is the beat at `grid.bar_one_beat`, the count-in before it has no place in the
score (the cursor waits on bar 1); and alphaTab truncates each beat's duration
to whole milliseconds when it builds its sync table, so the notation is written
at the nearest tempo whose beat is a whole number of milliseconds (96 for this
song) and the tempo marking is hidden. The status line shows the real BPM.

Next, in order, each reviewable in the browser:

4. **Mixer and tempo.** Three gains in one Web Audio graph over
   `<audio>`/`<video>` elements: no-drums stem, drums stem, click synthesised
   on the beat map. Tempo stays on `api.playbackSpeed` (alphaTab derives the
   cursor animation from it and forwards it to the video), `preservesPitch`
   on the elements. The stems are already reachable at
   `/media/<slug>/stems/<name>.wav`.
5. **Overlay layout.** Notation over the video: 4 bars per line, N lines
   visible (2 by default), auto-scroll to the next line when the current one
   ends. Keyboard shortcuts. Today the score is a scroll box under the video
   that alphaTab scrolls to keep the cursor in view.

The archived research on drift correction between media elements and the sweep
is in the old plan: `git show transcriber:player-plan.md` (sections
"Transport", "Sync points", "Notation window").

Headless checks in `app/scripts/`, all needing `npm run dev`: `smoke.mjs`
(render + playback), `shot.mjs <png>` (screenshot + sample alphaTex),
`check-ui.mjs <png>` (drives Space, inspects cursor and chrome), and
`check-sync.mjs` (seeks every bar both ways and asserts video and cursor agree
within 15 ms, then plays through the count-in). They launch the installed
Chrome or Edge (`browser.mjs`): Playwright's own Chromium cannot decode the
H.264 video.
