# drums-tabs

A drum practice player: hand-authored notation on the song's own clock, synced
to the drummer, with a mixer over the backing track, the drum stem and a click,
and a tempo control. A song may also have a video bound to its timeline -- a
cover to learn from now, your own cover later -- and then the notation sits over
the bottom of it.

The earlier automatic-transcription work lives on the `transcriber` branch. What
is being built next is in [`practice-plan.md`](practice-plan.md) (practice mode,
M0-M5) and [`avatar-plan.md`](avatar-plan.md) (the sticking solver and the 3D
avatar).

## Per song

```
kit.toml                    where your drums are, and what it costs to play them

songs/<slug>/
  song.toml                 what the song is (url, title, duration, sections)
  grid.lock.json            the real time of every beat the drummer played
  tab.mid                   your notation: constant-tempo MIDI, bar 1 = song bar 1
  sticking.lock.json        which hand plays what, and the hi-hat foot
  audio/mix.wav             (untracked) the song, and the clock
  audio/video.mp4           (untracked, optional) a picture on that timeline
  stems/drums.wav, nodrums.wav          (untracked) separated stems
  stems/straight-*.wav, straight.json   (untracked) tempo-straightened renders for authoring
```

## Workflow

1. **Media and beat map** (once per song, needs the Python toolchain, see `drums doctor`):

   ```
   drums prep <youtube url>      # fetch, separate, detect beats, build the grid
   drums align <slug>            # measure where the video's sound sits vs the mix
   drums straighten <slug>       # render stems warped to a constant tempo
   drums sections <slug>         # propose sections from the repeats in tab.mid
   drums sticking <slug>         # work out which hand plays what
   ```

   Listen to `debug/straight_click.wav`: a click that sits on every hit for the
   whole song means the beat map is right. `align` pins `video_offset_ms` in
   `grid.lock.json`: everything is on `mix.wav`'s timeline, and a separately
   downloaded video is cut a few tens of ms differently, so that is how far the
   picture is held from the clock. A song with no video needs no `align`.

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

   Then `drums sections <slug>` reads the repeats out of the notation and
   proposes `[[section]]` blocks -- the stretches a practice routine is built
   from. It is a seed, not an answer: rename A/B/C to verse/chorus, nudge the
   bar numbers, and give two blocks the same name to say they are one section
   the song plays twice. After that `song.toml` is the truth, because a routine
   is a fixed grid of (section x tempo) cells and a boundary that moves makes
   old runs incomparable -- which is why re-running needs `--redetect`.

   `drums sticking <slug>` then works out which hand plays what and writes
   `sticking.lock.json`, which the player draws as R and L under the notation.
   It measures effort against `kit.toml` at the repo root -- where your drums
   are, and what a crossover or a rushed move costs -- so if the letters are
   not what you would play, change a weight there and re-run with `--restick`.
   `--bars 15-22` prints them in the terminal.

3. **Play** with `cd app && npm run dev`. With a video the notation sits over
   the bottom of it, two lines of four bars; with none it fills the stage
   (the Lines control is one to four lines or Fill, and Fill is the default
   when there is no picture to make room for). The line being played is the
   top one, and the window moves down a line as soon as the cursor enters the
   next. Space plays and pauses, the arrow keys go a bar or a line back and
   forward, Home stops (rewinds to the start of the song), `[` and `]` step
   the tempo, `1` `2` `3` mute and unmute the faders, a click on the score
   seeks there, and the mouse wheel over the notation browses it while
   paused. The faders mix the no-drums stem, the drums stem and a click on
   the beat map (the clock's own sound is muted: it is the full mix, and with
   no stem to play it is unmuted instead). Tempo slows all of it, pitch kept.
   Faders, lines and theme are remembered per browser.

## Where things stand

Done: media pipeline, straightened authoring stems, Ableton set -> `tab.mid`
-> notation (`app/src/midi-tab.ts`), four bars per line, cursor, space to
play/pause, light/dark switch, and the media as the clock: an element plays in
the page (served by `app/plugins/media.ts` at `/media/<slug>/...`, with range
requests), alphaTab runs in `PlayerMode.EnabledExternalMedia` with that element
as its `IExternalMediaHandler` (`app/src/media.ts`), and the beat map goes in as
one sync point per played beat (`app/src/syncpoints.ts`). The cursor follows the
drummer, clicking the score seeks, the tempo slider slows everything, Stop
rewinds to the top of the count-in. No soundfont, no synth. And the mixer (step
4, 2026-09-12): faders for the no-drums stem, the drums stem and a click, on
that clock at any tempo, remembered in localStorage.

Three things learned on the way, all encoded in code comments: notation bar 1
is the beat at `grid.bar_one_beat` and the count-in has no place in the score
(the cursor waits on bar 1); alphaTab truncates each beat's duration to whole
milliseconds in its sync table, so the notation is written at the nearest
tempo whose beat is a whole number of ms (`syncSafeTempo`, 96 here) with the
tempo marking hidden; and a downloaded video's soundtrack is not the mix --
for this song it runs 36.28 ms behind it (`drums align`), which is why every
timeline conversion in the app is between mix time and one media's own time.

The mixer (`app/src/mixer.ts`, `app/src/click.ts`) is one Web Audio graph:
the clock element and two `<audio>` elements for the stems, each through a
`GainNode`, plus a click synthesised on the beat map. The clock's own sound
goes through a gain at 0 (it is the full mix), or 1 when no stem loads. The
graph is built on the first key or pointer gesture (an `AudioContext` made
earlier stays suspended). Transport is still alphaTab's: everything else
follows the clock element's `play`/`pause`/`seeked`/`ratechange` events. Two
things learned:

- Chrome keeps media elements that share one `AudioContext` on one clock:
  once a stem is placed at `clock.mixTimeMs`, it stays within a couple of ms
  of the clock at 100% and at 50%, measured over 3.5 s in `check-mix.mjs`.
  The drift correction (hard seek beyond 250 ms, a 1-3% rate nudge between 20
  and 250 ms, exact rate again under 10 ms) is there for the cases it will
  not be that clean: a stall, a background tab, a different browser. It
  runs on the click's 25 ms timer rather than rAF so it goes on in a
  background tab.
- The click is a lookahead scheduler: every 25 ms it books sine blips for
  the beats in the next 100 ms at `ctx.currentTime + (beat - mixNow) /
  rate`, accented on `bar_one_beat + k * beats_per_bar` (the count-in gets
  clicks too), and forgets booked blips on seek and pause.

And the notation window (step 5, 2026-09-12, `app/src/score-window.ts`):
the score sits over the bottom of the stage, N lines of four bars, the line
being played on top. The page is one screen (a flex column: header,
controls, then the stage takes the rest, the picture filling it), the window
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

And the clock came off the video (step 6, 2026-09-13, the first half of the
pivot in `practice-plan.md` M0). Practice is against the original track, not
against somebody's cover, so the video stopped being the thing that keeps time:
the master clock is now an `<audio>` element on `audio/mix.wav` (`MixClock` in
`app/src/media.ts`), which means the clock's time *is* mix time and there is
nothing to convert. Everything else in the page is a `Follower`
(`app/src/follow.ts`) held on that clock: the two stems, and -- when the song
has one -- the picture, which is muted, hidden when absent, and held
`video_offset_ms` away from mix time. A song with no video is not a degraded
case: the notation simply takes the whole stage (the Lines control's Fill).
Three things learned:

- **Seeking audio is exact; seeking video is not.** The bar-to-time round trip
  in `check-sync.mjs` went from tens of ms to 0.05 ms worst over 62 bars,
  because an `<audio>` element lands on the sample you asked for while a video
  lands on a frame.
- **A video element starts about 100 ms late.** Seeking it and calling `play()`
  takes that long to put a frame on the screen, and the clock does not wait, so
  the picture begins every playback a tenth of a second behind. Measured with
  `requestVideoFrameCallback`, which reports the media timestamp of the frame
  actually being presented: the lag was real, not an artifact of reading
  `currentTime` (that reads only ~14 ms behind the presented frame).
- **A silent picture can be driven back hard.** 3% is the most you can nudge
  audio without anyone hearing it, but nobody can see a picture run 15% fast
  for a second, so the picture gets `maxNudge: 0.15` and is back on the clock
  within about a second, then locks inside 30 ms and holds around 30-40 ms.
  `check-mix.mjs` holds the stems to 20 ms at all times and the picture to
  60 ms once it has settled.

The rest of the pivot came with it (2026-09-13): the original track is prepped
as its own song (`hayley-williams-kill-me-official-visualizer`, no video, 62
bars at 90.91 BPM with 0.37% drift where the cover drifts 1%), the notation is
reused as it stands -- both songs point `[author]` at the same Live set, and
99.7% of the chart's 305 kick and snare hits land within 60 ms of an onset in
the original's drum stem, against 97.4% for the cover it was written to -- and
`drums sections` (`pipeline/sections.py`) proposes the sections. It reads one
fingerprint per bar out of `tab.mid` on the same sixteenth grid the notation is
drawn on, cuts at the ends of every repeated block, throws away cuts that fall
inside a stretch of identical bars (a groove repeated twelve times offers a
boundary at every offset and none of them is where a section starts), merges a
groove with its own immediate repeats, merges what is too short to practise,
and letters what is left by content. Nine blocks for this song, eight of them
distinct: a 36-cell routine.

And the sticking solver (2026-09-13, `avatar-plan.md`'s half of M0). The chart
says "snare on the 2" and never says which hand, so `pipeline/sticking.py`
works it out: a limb for every note, chosen as the cheapest path through the
whole song rather than note by note, because the right hand for this hit is
decided by where the other hand has to be for the next one. Effort is measured
against `kit.toml` -- one hard rule (a hand cannot exceed `max_speed_cm_s`, and
a passage needing more is reported as unplayable, naming the bar) over three
preferences (a rushed move, crossed arms, and the same hand twice when there is
no time for it). It also derives the **hi-hat foot**, the other thing the chart
implies but never states: `hihat_open` means the foot was up at that moment.
Both are frozen in `songs/<slug>/sticking.lock.json`, pinned to the chart hash,
and the player draws the letters under the notation from it (`app/src/sticking.ts`,
the Sticking switch) -- with the page hashing `tab.mid` itself so it can say
when the letters belong to a chart you have since edited. Three things learned:

- **A crossover penalty is wrong on a right-handed kit.** The hats are on your
  left and the right hand reaches over to play them: taken literally, "penalise
  crossed arms" makes the solver play everything open-handed. So the kit names
  a **lead hand** and the instruments the time is kept on, the lead hand prefers
  those, and crossing only counts away from them.
- **The letters are an overlay, not notation.** alphaTab reports where every
  beat landed (`boundsLookup`), so a `<span>` at that x under the staff needs no
  change to the alphaTex and survives a re-render. The same bounds the notation
  window already uses.
- **Feet are a lookup, not a search** -- one pedal, one foot -- so the solver
  only searches the hands, and 599 notes solve instantly.

Older candidates, still unstarted: a loop (two keys marking the start and end
bar), bigger notes (`display.scale` and a Zoom control next to Lines), and a
count-in on a paused start. After that, M1 in `practice-plan.md`: Web MIDI
capture, the calibration ritual, and the take format.

The archived research on drift correction between media elements and the sweep
is in the old plan: `git show transcriber:player-plan.md` (sections
"Transport", "Sync points", "Notation window").

Headless checks in `app/scripts/`, all needing `npm run dev`: `smoke.mjs`
(render + playback), `shot.mjs <png>` (screenshot + sample alphaTex),
`check-ui.mjs <png>` (drives Space, every shortcut, the Lines control and the
Sticking switch, asserts the window follows the cursor a line at a time playing
and paused, and screenshots line 2 in both themes: `<png>` and
`<png minus .png>-dark.png`), and
`check-sync.mjs` (seeks every bar both ways and asserts clock and cursor agree
within 15 ms, then plays through the count-in), and `check-mix.mjs` (plays at
100% and 50% and asserts the stems stay within 20 ms of the clock and the
picture settles within 60 ms of it, the graph is silent with every fader at 0,
and the click is audible). They launch the installed
Chrome or Edge (`browser.mjs`): Playwright's own Chromium cannot decode the
H.264 video. Each checks the first song in the list unless `SONG=<slug>` names
another. Pipeline tests: `.venv/Scripts/python -m pytest -q tests`.
