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

3. **Play** with `cd app && npm run dev`. The notation sits over the bottom
   of the video, two lines of four bars (the Lines control makes it one to
   four); the line being played is the top one, and the window moves down a
   line as soon as the cursor enters the next. Space plays and pauses, the
   arrow keys go a bar or a line back and forward, Home stops (rewinds to the
   start of the video), `[` and `]` step the tempo, `1` `2` `3` mute and
   unmute the faders, a click on the score seeks the video there, and the
   mouse wheel over the notation browses it while paused. The faders mix the
   no-drums stem, the drums stem and a click on the beat map (the video's own
   sound is muted: it is the full mix). Tempo slows all of it, pitch kept.
   Faders, lines and theme are remembered per browser.

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
the count-in. No soundfont, no synth. And the mixer (step 4, 2026-09-12):
faders for the no-drums stem, the drums stem and a click, on the video's
clock at any tempo, remembered in localStorage.

Three things learned on the way, all encoded in code comments: notation bar 1
is the beat at `grid.bar_one_beat` and the count-in has no place in the score
(the cursor waits on bar 1); alphaTab truncates each beat's duration to whole
milliseconds in its sync table, so the notation is written at the nearest
tempo whose beat is a whole number of ms (`syncSafeTempo`, 96 here) with the
tempo marking hidden; and the video's soundtrack is not the mix -- for this
song it runs 36.28 ms behind it (`drums align`), and `VideoClock` converts
between video time and mix time so that alphaTab, the beat map and the
stems all share one timeline.

The mixer (`app/src/mixer.ts`, `app/src/click.ts`) is one Web Audio graph:
the video and two `<audio>` elements for the stems, each through a
`GainNode`, plus a click synthesised on the beat map. The video's own
soundtrack goes through a gain at 0 (it is the full mix), or 1 when no stem
loads. The graph is built on the first key or pointer gesture (an
`AudioContext` made earlier stays suspended). Transport is still alphaTab's:
the stems follow the video element's `play`/`pause`/`seeked`/`ratechange`
events and `VideoClock` is untouched. Two things learned:

- Chrome keeps media elements that share one `AudioContext` on one clock:
  once a stem is placed at `clock.mixTimeMs`, it stays within 0.1 ms of the
  video at 100% and at 50%, measured over 3.5 s in `check-mix.mjs`. The
  drift correction (hard seek beyond 250 ms, a 1-3% rate nudge between 20
  and 250 ms, exact rate again under 10 ms) is there for the cases it will
  not be that clean: a stall, a background tab, a different browser. It
  runs on the click's 25 ms timer rather than rAF so it goes on in a
  background tab.
- The click is a lookahead scheduler: every 25 ms it books sine blips for
  the beats in the next 100 ms at `ctx.currentTime + (beat - mixNow) /
  rate`, accented on `bar_one_beat + k * beats_per_bar` (the count-in gets
  clicks too), and forgets booked blips on seek and pause.

And the notation window (step 5, 2026-09-12, `app/src/score-window.ts`):
the score sits over the bottom of the video, N lines of four bars, the line
being played on top. The page is one screen (a flex column: header,
controls, then the stage takes the rest, the video filling it), the window
is a clipped box positioned over the stage with a translucent panel and a
backdrop blur, and alphaTab's element keeps its full height inside it.
alphaTab's own follow-cursor is off (`ScrollMode.Off`); the window reads the
row geometry from `api.boundsLookup.staffSystems` after `postRenderFinished`
(each row's top and the bars on it, so the height is `lines` times the row
pitch and the scroll target for a row is its top) and sets `scrollTop`
whenever the bar under the cursor is on another row. The keyboard is one
table in `main.ts` (`keys`), ignored while a select or slider has the
focus; sliders give the focus up on pointer-up so the arrows go back to the
player after a drag. Two things learned:

- `playedBeatChanged` only fires while playing (alphaTab gates it on the
  player state), so a window driven by it does not follow an arrow key, a
  click on the score or Stop while paused. `playerPositionChanged` fires on
  every position push, seeks included; the bar comes from its tick through
  `masterBars[i].start`.
- The staff systems' `realBounds` are in the score element's coordinates:
  the first row starts 35 px down (alphaTab's top padding), the rest are
  121 px apart at scale 1, and the same rows are re-measured after the
  re-render a resize or a theme switch triggers, which is when the window
  is resized and put back on its row.

The first milestone is complete: the song can be learned from the player as
it is. Candidates for what comes next, none started:

- **A loop.** Two keys to mark the bar the loop starts and ends on, and the
  video jumps back at the end. The seek chain (tick -> `VideoClock.seekTo`
  -> `seeked` -> stems realign) is tens of ms; pre-rolling the seek a beat
  early, or a second video element, if the gap is audible.
- **Bigger notes.** alphaTab's `display.scale` makes the rows taller; the
  window already measures whatever it is given. A Zoom control next to
  Lines.
- **A count-in on a paused start.** Playing from the middle of the song
  starts the video at once; a bar of click before it would give time to
  pick the sticks up.

The archived research on drift correction between media elements and the sweep
is in the old plan: `git show transcriber:player-plan.md` (sections
"Transport", "Sync points", "Notation window").

Headless checks in `app/scripts/`, all needing `npm run dev`: `smoke.mjs`
(render + playback), `shot.mjs <png>` (screenshot + sample alphaTex),
`check-ui.mjs <png>` (drives Space, every shortcut and the Lines control,
asserts the window follows the cursor a line at a time playing and paused,
and screenshots line 2 in both themes: `<png>` and `<png minus .png>-dark.png`), and
`check-sync.mjs` (seeks every bar both ways and asserts video and cursor agree
within 15 ms, then plays through the count-in), and `check-mix.mjs` (plays at
100% and 50% and asserts the stems stay within 20 ms of the video, the graph
is silent with every fader at 0, and the click is audible). They launch the installed
Chrome or Edge (`browser.mjs`): Playwright's own Chromium cannot decode the
H.264 video. Pipeline tests: `.venv/Scripts/python -m pytest -q tests`.
