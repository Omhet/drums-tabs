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
   drums align <slug>            # measure where the video's sound sits vs the mix
   drums straighten <slug>       # render stems warped to a constant tempo
   ```

   Listen to `debug/straight_click.wav`: a click that sits on every hit for the
   whole song means the beat map is right. `align` pins `video_offset_ms` in
   `grid.lock.json`: the beat map and the stems are on `mix.wav`'s timeline,
   and the separately downloaded video is cut a few tens of ms differently.

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
play/pause, light/dark switch, and the video as the clock: `audio/video.mp4`
plays in the page (served by `app/plugins/media.ts` at `/media/<slug>/...`,
with range requests), alphaTab runs in `PlayerMode.EnabledExternalMedia` with
the video element as its `IExternalMediaHandler` (`app/src/media.ts`,
`VideoClock`), and the beat map goes in as one sync point per played beat
(`app/src/syncpoints.ts`). The cursor follows the drummer, clicking the score
seeks the video, the tempo slider slows the video, Stop rewinds to the top of
the count-in. No soundfont, no synth; the sound is the video's own track.

Three things learned on the way, all encoded in code comments: notation bar 1
is the beat at `grid.bar_one_beat` and the count-in has no place in the score
(the cursor waits on bar 1); alphaTab truncates each beat's duration to whole
milliseconds in its sync table, so the notation is written at the nearest
tempo whose beat is a whole number of ms (`syncSafeTempo`, 96 here) with the
tempo marking hidden; and the video's soundtrack is not the mix -- for this
song it runs 36.28 ms behind it (`drums align`), and `VideoClock` converts
between video time and mix time so that alphaTab, the beat map and (next) the
stems all share one timeline.

Next, in order, each reviewable in the browser:

4. **Mixer and tempo.** Three faders in one Web Audio graph: no-drums stem,
   drums stem, and a click synthesised on the beat map; the video's own
   soundtrack goes through a gain at 0 (it is the full mix, so it would
   double everything). What is already in place, and what to build on:

   - The stems are served at `/media/<slug>/stems/nodrums.wav` and
     `drums.wav` (30 MB PCM each, range requests work, Chrome seeks them
     fine). They are on mix time. The video is on mix time +
     `grid.video_offset_ms`; `clock.mixTimeMs` gives the current mix time
     and `clock.seekTo()` takes mix time, so a stem should always satisfy
     `stem.currentTime == clock.mixTimeMs / 1000`.
   - Two `<audio>` elements plus the video, each through
     `ctx.createMediaElementSource()` into its own `GainNode`. Create the
     `AudioContext` lazily on the first Play (it needs a user gesture);
     verified in headless Chrome that tapping the video this way works and
     carries signal. Set `preservesPitch = true` on all three elements.
   - Transport stays alphaTab's: `api.playbackSpeed` -> `VideoClock.playbackRate`,
     which must now also set the stems' `playbackRate`; play/pause/seek can be
     mirrored from the video element's own `play`, `pause`, `seeked` events, so
     the mixer needs no new hooks in `VideoClock`.
   - Drift correction, once per frame per stem, with hysteresis because
     `currentTime` reads are quantised: more than 250 ms off -> hard seek to
     the video; 20-250 ms -> nudge the stem's rate by up to 3%; under 10 ms ->
     rate back to exactly the master rate.
   - Click: a 25 ms `setInterval` lookahead scheduler (not rAF, which stops in
     a background tab) that books `OscillatorNode` blips at
     `ctx.currentTime + (beat - mixNow) / rate` for beats within the next
     100 ms; accent beats at `bar_one_beat + k * beats_per_bar`. Forget booked
     beats on seek and pause.
   - Faders in the controls row, remembered in localStorage like the theme.
   - Suggested files: `app/src/mixer.ts` (graph, stems, drift),
     `app/src/click.ts` (scheduler); `main.ts` wires the sliders.
   - Verify with a new `app/scripts/check-mix.mjs`: play 5 s at 100% and at
     50%, assert each stem stays within 20 ms of `clock.mixTimeMs`, and that
     an `AnalyserNode` on the graph goes quiet when all faders are at 0.
5. **Overlay layout.** Notation over the video: 4 bars per line, N lines
   visible (2 by default), auto-scroll to the next line when the current one
   ends. Keyboard shortcuts. Today the score is a scroll box under the video
   that alphaTab scrolls to keep the cursor in view (the box wraps alphaTab's
   element; alphaTab's scroll maths needs that).

The archived research on drift correction between media elements and the sweep
is in the old plan: `git show transcriber:player-plan.md` (sections
"Transport", "Sync points", "Notation window").

Headless checks in `app/scripts/`, all needing `npm run dev`: `smoke.mjs`
(render + playback), `shot.mjs <png>` (screenshot + sample alphaTex),
`check-ui.mjs <png>` (drives Space, inspects cursor and chrome), and
`check-sync.mjs` (seeks every bar both ways and asserts video and cursor agree
within 15 ms, then plays through the count-in). They launch the installed
Chrome or Edge (`browser.mjs`): Playwright's own Chromium cannot decode the
H.264 video. Pipeline tests: `.venv/Scripts/python -m pytest -q tests`.
