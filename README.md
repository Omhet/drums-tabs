# drums-tabs

A drum practice player: hand-authored notation on the song's own clock, synced
to the drummer, with a mixer over the backing track, the drum stem and a click,
and a tempo control. A song may also have a video bound to its timeline -- a
cover to learn from now, your own cover later -- and then the notation sits over
the bottom of it.

It also marks you. With an electronic kit on a MIDI port, `Record` plays a
section and scores what you played against what is written. The reading is three
dials -- did you play the right notes, were you steady, where do you sit against
the record's own feel -- plus coloured noteheads and a map of the bars that went
wrong, with the numbers behind them folded away. The whole attempt is kept as
JSON so the history is readable by you and by an agent. A **routine** is the
fixed grid those attempts fill: the whole song at 70/80/90/100%, four cells, the
same set every run so that two runs can be compared, open across as many
sittings as it takes and sealed by hand. The stretch of bars you actually need
to drill is an **exercise** instead -- a few bars cut out of a chart and played
on a loop with a bar of click between the reps, graded every time round, with a
history of its own. An exercise **carries its own notes**, so it plays with no
song loaded at all, on a clock counted out at its own tempo and a kit of drum
samples; it also remembers the records it was cut from, and can be played
against one of those instead. Exercises live in a shared pool at the repo root
and one can name several songs, because the same lick turns up in more than one
tune. Two
things it needs: the dev server, because writing files is a Vite plugin's job here and not
a built page's; and a MIDI port Chrome can open **while your sampler is already
holding one** -- the kit is a controller for Superior Drummer in Ableton, so
two applications want the same module. See `handoff.md` §1 for the test and
the virtual-port fallback.

The earlier automatic-transcription work lives on the `transcriber` branch. What
is being built next is in [`practice-plan.md`](practice-plan.md) (practice mode,
M0-M5) and [`avatar-plan.md`](avatar-plan.md) (the sticking solver and the 3D
avatar). **Picking the work up: [`handoff.md`](handoff.md)** — where it stands,
how to run the checks, and what M3 has to honour.

## Per song

```
kit.toml                    where your drums are, what it costs to play them,
                            and what your module sends ([input])
calibration.local.json      (untracked) how late you play: this machine's
                            audio path, measured by the Calibrate button

songs/<slug>/
  song.toml                 what the song is (url, title, duration, sections)
  grid.lock.json            the real time of every beat the drummer played
  tab.mid                   your notation: constant-tempo MIDI, bar 1 = song bar 1
  sticking.lock.json        which hand plays what, and the hi-hat foot
  reference.lock.json       how far behind the chart the record itself plays
  takes/<when>-<cell>.json  every attempt you have recorded, and its grade
  routines/<when>.json      every run of the grid: the open one has sealedAt null
  audio/mix.wav             (untracked) the song, and the clock
  audio/video.mp4           (untracked, optional) a picture on that timeline
  stems/drums.wav, nodrums.wav          (untracked) separated stems
  stems/straight-*.wav, straight.json   (untracked) tempo-straightened renders for authoring
```

## The exercise pool

Shared across songs, so it sits at the repo root rather than under one of them:
an exercise can be played from several songs, and a file cannot live in two
directories.

```
exercises/<id>/exercise.json          what it is: kind, rest, backing, its own notes, every source
exercises/<id>/drills/<when>-<pct>.json   one sitting at one tempo, every rep in it

kit/samples/<instrument>.wav          what an exercise sounds like, played on its own
```

A **chart** is the exercise's own notes, re-based so its first bar is bar 1,
with the tempo and the meter it was written at. That is what makes it a thing
rather than a view: with a chart it plays on a grid built at that tempo
(`syntheticGrid`), a clock that is not a recording (`timer-clock.ts`) and a kit
of one-shot samples (`kit.ts`), and no song is loaded at all.

A **source** is `{slug, section, startBar, endBar, chartHash}` -- a record this
same figure can *also* be played against, with the drummer's own feel under it.
A song's page lists every exercise naming its slug, which is the whole of the
many-to-many link and leaves nothing to keep in step. `backing` says which of
the three you get: `kit` (its own notes), `record`, or `click` (the record with
the stems down). The choice on the page is for the sitting, like the tempo; the
file is not rewritten.

A **drill** is one sitting; it scores as the *median* of its complete reps and
fills one square of the exercise's own 70/80/90/100 ladder. There is nothing to
seal: the newest drill at a tempo simply is that square.

The sample bank is baked once, out of alphaTab's bundled soundfont, by
`npm run bake-kit` in `app/`. It is tracked, it is twelve mono files, and
replacing them is how you put your own kit under the exercises.

## Workflow

1. **Media and beat map** (once per song, needs the Python toolchain, see `drums doctor`):

   ```
   drums prep <youtube url>      # fetch, separate, detect beats, build the grid
   drums align <slug>            # measure where the video's sound sits vs the mix
   drums straighten <slug>       # render stems warped to a constant tempo
   drums sections <slug>         # propose sections from the repeats in tab.mid
   drums sticking <slug>         # work out which hand plays what
   drums reference <slug>        # how far behind the chart the record itself plays
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
   ```                           # tom_high, tom_mid, tom_floor, ride, sidestick

   Every save of the set (Ctrl+S) rewrites `songs/<slug>/tab.mid` from the
   arrangement clips on that track and reloads the player. A `tab.mid` exported
   by hand from any DAW works the same, without the `[author]` section.

   A set written the other way round -- against the record from the top of the
   track, so its first bars are the intro -- says so with `bar_offset`:

   ```toml
   [author]
   bar_offset = 3                # bar 4 of the set is bar 1 of the song
   ```

   Notation bar 1 is the first kick or snare and the count-in in front of it is
   not written, so those intro bars have to come off on the way to `tab.mid`.
   The number is measurable rather than a guess: slide the chart against the
   drum stem and the match rate peaks at the right one (`drums reference`
   prints `matched/written`, and 96% against 82% is not a close call). Notes
   that end up before bar 1 are dropped, not stacked on the downbeat, and the
   dev-server log says how many -- an offset one bar too big loses real notes.
   The straightened stems then go at bar `1 + bar_offset` of the set rather
   than at 1|1|1, because they start at the song's bar 1. Default 0, which is
   every set authored the usual way.

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

   `drums reference <slug>` answers a question that only comes up once you are
   being marked: the chart is written on a sixteenth grid, the record is played
   by a person, and if that person sits behind the grid then copying the feel
   you hear is scored as playing late. It finds the nearest onset in the drum
   stem for every written kick and snare and reports the gap. On the original of
   *Kill Me* it is +12.7 ms, so a faithful take would start 13 ms in the red; on
   *Song 2* it is +6.2 ms. It writes `reference.lock.json` and **the player
   subtracts it**, so zero means "sitting where the record sits" rather than
   "sitting on a grid nobody played to". Pinned to the chart hash like the
   sticking lock, so editing the notation means running it again.

3. **Play** with `cd app && npm run dev`. The window is three columns: the
   rail down the left for playing along -- song, transport, tempo, the mixer,
   the notation settings and the themes -- a rail down the right for practice
   mode end to end, and between them the stage: the picture on top and the
   notation under it, never over it. The Lines control is one to four lines of
   four bars or Fill; on Fill the notation takes the stage and the picture
   keeps a third of the screen, which is the default when there is no picture
   to make room for. The line being played is the top one, and the window moves
   down a line as soon as the cursor enters the next. Space plays and pauses,
   the arrow keys go a bar or a line back and forward, Home stops (rewinds to
   the start of the song), `[` and `]` step the tempo, `+` and `-` size the
   notation (`0` puts the whole Layout group back to its defaults), `1` `2` `3` mute and
   unmute the faders, `Z` is zen, a click on the score seeks there, and the
   mouse wheel over the notation browses it while paused. The faders mix the
   no-drums stem, the drums stem and a click on the beat map (the clock's own sound is muted: it
   is the full mix, and with no stem to play it is unmuted instead). Tempo
   slows all of it, pitch kept.

   **The Layout group fits the notation to your screen.** Four faders in the
   left rail, each remembered as a default: **Size** (a ladder from 60% to
   200%, also on `+` and `-`), **Bars a line** (1 to 8), **Note spacing**
   (alphaTab's `stretchForce` as a percentage: how hard the springs between
   the notes inside a bar push) and **Line gap** (the air between one row of
   notation and the next, split across the two paddings that make it). `0`
   puts all four back. They are screen-fitting, not song-fitting -- you set
   them once against the monitor you practise in front of -- which is why they
   are faders you nudge and look at rather than keys, and why the reading
   waits for the mouse to be let go before re-engraving.

   Size and Bars a line used to be one control: the zoom dropped bars off the
   line as the scale climbed (four, three, two), on the reasoning that alphaTab
   scales the glyphs but not the page and a row is stretched to the width it is
   given either way, so scale alone would give the same four bars twice the
   notehead and the same pixels to share. That is true, but the rate to trade
   one for the other is a property of the screen, not of the score, and
   guessing it took away the two settings worth asking for: six small bars on a
   line, or two big ones. Since the row is stretched to its width whatever is
   on it, Bars a line is really how much width one bar gets. A chosen number of
   lines stays that number of lines, which means a taller window and a smaller
   picture; on Fill the picture keeps its third and you see fewer lines. The
   sticking letters and the extras lane are drawn by the page rather than
   engraved by alphaTab, so they grow from a CSS variable Size sets.

   There are **two themes**, side by side in the rail's Theme group: one for
   the interface and one for the notation -- its paper, alphaTab's ink, the
   heatmap's noteheads, the sticking letters and the cursor. They do not have
   to agree, and the useful thing about having two is setting them against
   each other: a dark room usually wants a dark interface and a light score.
   The notation follows the interface until it is given a theme of its own.

   **Both rails get out of the way.** Each one has a button at the top that
   folds it down to one icon wide: the same controls, not a second set of them
   -- a button keeps its word for the tooltip and grows a glyph in place of it,
   a select keeps its native popup, a checkbox is already icon-sized. What has
   no icon is hidden until the rail is opened again: the faders (they are on
   `1` `2` `3`), the tempo (`[` and `]`), the readings and the routine grid.
   `Z` goes further -- **zen**: the picture and the notation edge to edge,
   everything else gone, and the browser taken fullscreen with it. `Esc` or `Z`
   leaves, as does the corner that appears when the mouse goes looking for it.
   An error on the status line is the one thing zen keeps.

   A collapsed rail is remembered and applied before the page first paints,
   which is not cosmetic: the width of the middle column is what alphaTab
   engraves the score against, so a rail that folded a moment after loading
   would re-engrave the whole score on every load. For the same reason none of
   this is animated. Zen is deliberately *not* remembered -- a page cannot ask
   for fullscreen without a gesture, so a remembered zen would come back
   half-applied. Faders, lines, the Layout group, sticking, both themes and
   both rails are remembered per browser.

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
N lines of four bars, the line being played on top. The page is one screen
(a grid: a rail, the stage, a rail; only the rails ever scroll), and the
stage is a vertical split -- the picture takes whatever the notation does
not want, and on Fill that reverses and the picture keeps a third of the
screen. The picture is a region rather than a panel: it has no background of
its own and the video is sized to its own shape inside it, so there are no
black bars at any setting and none of them widen on Fill. The
window is a clipped box, solid and themed on its own rather than a
translucent panel over the picture, and alphaTab's element keeps its full
height inside it. One line of the window is the *tallest* row, not the
first: a section name over the staff makes a row taller than its neighbours,
and a height taken from the first gap clips every row above it.
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
and letters what is left by content. Nine blocks for this song at first; re-run
at `--min-bars 8` it proposes six, lettered A-F. The letters are a seed: this
song's blocks were then named and re-cut by hand from the notation (below).

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

**M1, the thin slice (2026-09-13).** One cell, end to end: you hit the pads,
the app marks you, and the marking goes to disk in a format built to outlive
everything above it. `Record` plays the hardcoded cell (the song's first
section, at full tempo, with a bar of lead-in) and stops itself at the last
bar; the noteheads then colour by verdict and a strip under the stage gives
mean ± spread per limb and the worst bars. The take lands in
`songs/<slug>/takes/<when>-<section>-<tempo>.json`, tracked in git.

The routine grid was deliberately left out -- `CELL` in `app/src/practice.ts`
was one constant, and M2 below is where it became a grid. The grid is worthless
if the take format is wrong, which is what this milestone existed to find out.
Six things learned:

- **The module's note numbers are not the chart's, and this was not in the
  plan.** The TD-27 sends Roland's layout, where 38 is the snare head; the
  chart's `[midi_map]` describes the drum rack in Ableton, where 38 is the
  hi-hat. So `kit.toml` gained an `[input]` table -- what *you hit* sends --
  next to the geometry, and the Monitor switch lists every note as it arrives
  so an unmapped pad is fixed by hitting it and reading the number. A take
  stores the module's raw numbers; `[input]` is only how they are read.
- **A hit is stamped when it arrives, not when it is handled**, and mix time is
  not wall time. `MixClock.mixTimeAt` converts a MIDI event's `timeStamp` using
  the same smoothed line the cursor runs on, scaled by the playback rate -- at
  80% a millisecond of wall clock is 0.8 ms of mix, and without that a slow
  take would read as played early.
- **The match window cannot overlap, which makes matching arithmetic rather
  than search.** Each note's window reaches half way to its neighbour, so the
  windows meet at midpoints and a stroke belongs to exactly one note. What is
  left over is then a bounce, a wrong drum, or a note that is not in the music,
  in that order.
- **Calibration has to come off before matching, not just before reporting.**
  25 ms of latency inside a 40 ms window invents misses out of nothing.
- **alphaTab colours its own noteheads** (`Note.style.colors`), and a full
  re-render of 62 bars costs ~30 ms and keeps the transport where it was, so no
  overlay was needed -- only the extras, which have no notehead to colour, get
  one. Which notehead is which drum is the fourth numbering of the same drums
  in this project, so rather than write another table by hand the app parses
  one throwaway bar per instrument and reads back the number alphaTab chose.
- **Chrome will not hand Web MIDI to an automated browser**, whatever the
  permission is set to, headless or not. So `check-practice.mjs` injects
  strokes through `MidiIn.inject` and everything after that is real; acquiring
  the port is the one part only a human at the kit can check.

`pipeline/kit.py`'s digest came along for the ride: it hashed the whole
`kit.toml`, so an `[input]` edit would have marked every sticking as solved
against a different kit. It now hashes the geometry and weights it actually
covers.

**Then it met the kit, and three things were wrong (2026-09-13).**

- **The first section of a song was unrecordable.** The lead-in was a bar of
  the record played before the cell, and bar 1 has no bar before it -- 360 ms
  of silence and then you are already late. It is a proper count-in now: one
  bar of clicks at the cell's tempo, then the transport starts exactly on the
  cell's first beat. Both go through the same audio graph, so they reach the
  ear with the same delay and nothing needs correcting. Nothing is captured
  during the count-in, because the transport is parked on the first beat and a
  stroke played over the clicks would otherwise be stamped exactly on it and
  recorded as an excellent hit.
- **The hi-hat was scored as a wrong note about half the time.** A module
  decides "open" or "closed" from the pedal position at the instant of the
  strike, and its threshold is nowhere near where a foot resting normally
  thinks closed is -- so an ordinary groove sends a mixture, and every flicker
  read as playing the wrong drum. `kit.toml` gained `[input].same_drum`: listed
  pairs are matched as one drum, so the note counts as a hit and the report
  says separately how many landed on the other side of the threshold. A tom
  where a snare is written is still wrong; only states of one instrument
  qualify.
- **Section names are drawn over the staff**, from the `[[section]]` blocks,
  through alphaTab's own rehearsal marks. You cannot sensibly rename a boundary
  you cannot see, and the routine M2 walks is built from those names.

**And the first real take produced a finding worth more than the fixes.** It
read as 38 ms late across every limb, against a player who felt on time. So the
chart was measured against the record it was written from: every kick and snare
in it, matched to the nearest onset in the original's drum stem. The record's
own drummer sits **+12.7 ms behind** the chart's grid position -- kick +16.3,
snare +6.1 -- so playing along with what you hear scores as late by that much
before you have done anything. The corroboration is in the split: the kick sits
furthest back in the record, and the kick came out as the latest limb in the
take. About a third of the number belonged to the reference, not the player.
Nothing was changed for it -- whether "in time" means the chart's grid or the
record's feel is a decision, not a bug -- but it is the reason the mean and the
spread are kept apart, and the script that measured it is worth keeping.

**The recorded kit digest changed once** -- `drums sticking <slug> --restick`
refreshes it and produces identical letters.

**M2, the routine grid (2026-09-13).** A routine is the fixed set of cells one
run walks: every section at 70/80/90/100%, then the whole song at each tempo,
walked section-major, with the whole song at 100% as the last cell of every run.
Fixed is the whole point -- if run 3 and run 4 are different sets of cells then
comparing them is comparing nothing -- so `app/src/routine.ts` derives the grid
from the `[[section]]` blocks and the ladder alone and nothing in it adapts to
how you played. A cell below 90% goes red and is not in your way. Only a take
that reached the last bar fills a cell, and **the last complete take counts, not
the best**: farming a lucky take is exactly how a progress line stops meaning
anything.

The run itself lives in `songs/<slug>/routines/<when>.json`, tracked, with the
open one marked by `sealedAt: null`, and it is rewritten after **every** cell --
not at the end of a sitting, which is not an event this program ever sees, since
Live reloads the page on every Ctrl+S. Sealing is by hand and refuses a routine
with holes in it; a sealed routine records its date span, so a run spread over a
week is visible next to its score rather than forbidden. Discarding throws away
the run and never the takes. The grid is drawn under the controls -- sections
down, the ladder across, green above 90% and red below, click a cell to go
there -- and folds away while a take is running, because the thing that needs
the stage then is the notation. Five things learned:

- **The grid shrinks by naming, and grows by cutting.** Two `[[section]]` blocks
  with the same name are one cell, practised once against the first of them, so
  naming both verses `verse` halves them. Cutting the fills out into blocks of
  their own does the opposite and is worth it: a fill is the bar you actually
  drop, and a fill inside an eight-bar section is a bar you play once per
  attempt. The names are in `song.toml` and the player draws them over the
  staff, so the grid is edited by reading the score.
- **"Where next" is two rules, not one.** Finishing a cell walks *forwards* from
  it, so someone working up section D stays in section D. Picking a run up in a
  new sitting has no such context and goes to the first hole in the grid. One
  rule for both cases is wrong in one of them.
- **"At most one open routine" belongs on the server, not the page.** The page
  is the thing that keeps being reloaded, and a second tab is a real case, so
  the route scans `routines/` for `sealedAt: null` and refuses to write a second
  open one (409). The app has no way to produce two, which is why finding two is
  worth reporting rather than guessing between them.
- **An epoch break and a chart edit are different severities.** Moving a section
  boundary changes the *shape* of the grid, so its filled and empty cells no
  longer describe the same music: the routine cannot be resumed at all, only
  sealed or discarded. Editing the chart only changes the notes: the run carries
  on, each fill records the chart it was graded against, and sealing a run that
  spans two of them marks it **mixed** and keeps it off the comparison line.
- **A cell's tempo goes through the page's own tempo slider**, not straight at
  alphaTab. Otherwise the slider, its readout and the media's actual rate can
  disagree about what speed you are playing at -- and at 70% the count-in has to
  slow down with it, or four clicks hand you the wrong speed to start in.

**The sections were then named from the notation (2026-09-13).** A-F became
twelve blocks under ten names: `verse` (bars 1-12 and 24-31, the same sparse
groove both times, so one cell), `chorus` (15-22 and 34-40, likewise), `bridge`,
`build`, `last chorus` -- and **every fill and pickup as a block of its own**:
`into chorus`, `into verse`, `into chorus 2`, `into bridge`, `into last chorus`.
Each of those is one to four bars and starts with the empty bar in front of it,
so drilling a fill gives you the bar of air to hear it coming. Ten names is 44
cells, more than the lettered grid's 28 -- but the new cells are one to four
bars each, so a full run is about 47 bars per tempo rather than 62, and a
sitting works out shorter, not longer. Renaming **starts a new epoch**, which is
why it was done before any take worth keeping was recorded.

**Blur - Song 2 was added as a second song (2026-09-16).** Two minutes, 64 bars
of 4/4 at 130.4 BPM, video bound at +36.28 ms -- exactly the same offset as the
other song, across all five correlation windows, so that number is a constant of
the fetch path rather than a per-song measurement. 886 notes authored in Live,
thirteen blocks under seven names, 32 cells. Its reference floor is **+6.2 ms**
against Kill Me's +12.7: this record was played close to a click, so a take on it
is very nearly all yours. One authoring detail worth knowing: the chart is 65
bars and the beat map is 64, because the last crash sits on the downbeat of 65
and the detector found no beats past it, so the sections stop at 64 and playing
that final crash logs two extras. Extras never touch accuracy, so it costs
nothing but a line in the report.

**Then the reading was rebuilt, because it was not being read (2026-09-16).**
Played against the real kit, the take report turned out to be a measurement dump:
five notehead colours plus a legend, a totals line, and a six-by-four table --
twenty-four numbers, none of which said whether the take was good or what to go
and play again. This is a deliberate departure from practice-plan Q11 and Q14,
which specified the heatmap-plus-timing-strip and two lines per cell. Those
answers were right about *what is measurable* and wrong about *what is legible*.

What replaced it:

- **Three dials, never blended into a score.** `Notes` is accuracy, `Steady` is
  the spread, `Feel` is where you sit -- drawn as a needle rather than a signed
  number, because a position reads at a glance and a sign has to be decoded.
  Each one answers a single question, and mean and spread stay apart for the
  reason Q7 gave in the first place: consistently late is the audio path or the
  song's feel, randomly late is the playing.
- **A bar strip.** One block per bar of the cell, coloured by whether the notes
  landed, click one to put the cursor there. Drummers think in bars, and this is
  the half of "what went wrong" that a per-limb table cannot show.
- **Three notehead colours instead of five.** Colour now answers one question --
  did the note happen -- and the early/late split is gone from it. Hue has no
  natural direction, so "is orange early or late?" was a question asked on every
  take; *when* a note landed is a quantity and is shown as one.
- **The old table is still there**, folded into a `the numbers` toggle.

**The reference floor is now subtracted automatically.** `drums reference` used
to print a number and stop, which made it something you had to remember and
apply in your head to every take forever. It now writes `reference.lock.json`,
pinned to the chart hash the way the sticking lock is, and the player takes it
off every stroke before matching -- so **zero on the Feel dial means "sitting
where the record sits"** instead of "sitting on a grid nobody played to". Takes
record the floor they were graded against beside the calibration, so a floor
later found wrong is a re-grade, not a lost take. It is one number for the whole
kit, which is a simplification worth stating: only kick and snare are
measurable, and Song 2's kick is +10.7 ms behind the grid while its snare is
-1.3, so the pooled +6.2 is exactly right for neither. The split is in the lock
for a later version to use.

**And the history: one line per section.** A trend column appears in the routine
grid once a run has been sealed -- one sparkline per section row, oldest run on
the left, on a fixed 0-100% scale with the pass threshold dotted across it so
two rows can be compared by eye. The unit is the *section*, not the cell: a cell
is one square of a 44-square grid and nobody reads 44 sparklines, while a section
is the thing you think of yourself as working on. (The grid became four cells in
2026-09-19, and with it the line became one *per cell* -- see the last entry.)
Three things learned:

- **What makes the grid honest makes the history jumpy.** The routine counts
  your last complete take, not your best, so a lucky run cannot be farmed -- and
  the price is a series where one good run makes the next look like a
  regression. The line is a **rolling median of the last three**, which keeps the
  trend and drops a single outlier in either direction. That matches the question
  being asked: "am I getting better", not "what did I do on Tuesday".
- **A section's score is the mean over all four of its tempos.** A section is
  only learned when it is learned at speed, so the 100% cell dragging the mean
  down is the line telling the truth rather than a flaw in it.
- **Epochs are breaks, not points.** A run whose sections were a different shape,
  or one sealed `mixed`, stays readable on disk and is simply not on the line --
  otherwise the history lies exactly when you have been most active.

Sealing a routine means recording every cell, so the headless check posts
synthetic sealed runs to the route instead and asserts the *reading* of a
history -- the per-section line and the median that steadies it -- which is the
part that can be wrong without anyone noticing.

**Arctic Monkeys - One For The Road was added as a third song (2026-09-18).**
Three and a half minutes, 72 bars of 4/4 at 90.9 BPM, 853 notes authored in
Live, video bound at **+36.28 ms** -- the same number as both other songs, to
the hundredth, across all five correlation windows, which retires the question:
it is a constant of the fetch path, not a measurement. Its reference floor is
**+10.5 ms**, between Song 2's +6.2 and Kill Me's +12.7, and the split behind it
is the widest of the three -- the kick sits +16.8 ms behind the grid while the
snare is +2.6, so the pooled number is a compromise on this record more than on
either other. Every one of its 422 written kick and snare hits lands on an onset
in the drum stem. The chart is 73 bars against a 72-bar beat map, the same shape
as Song 2's 65 against 64, and it costs the same nothing.

Its grid drifts about **2.5%**, against Song 2's and Kill Me's fraction of a
percent -- this is a band playing, not a band playing to a click -- and the
straightened render absorbs all of it: the bar-to-time round trip is still
within 0.6 ms over all 72 bars. Drift is what `straighten` is for, so a large
number there is not a warning about the grid; `debug/straight_click.wav` is.
It is also authored at **91 BPM**, which is what 90.91 rounds to.

Three things learned:

- **A half-beat seam is not a local blemish, and this one had been documented as
  harmless.** The straightened render's pitch lurched around, which is how the
  bug surfaced: the warp's playback speed follows the beat spacing, so an
  interval 1.5x its neighbours is a 1.5x jump in speed -- about a fifth of pitch,
  at one beat's notice. Four such intervals were in the beat map, all inside the
  two stretches where the detector had run at double time and
  `repair_local_octave` had halved them.

  Halving a run keeps every other beat, and which parity survives is fixed at
  the run's start, so a run spanning an odd number of half-beats leaves the
  beats *after* it half a beat out of phase. The old docstring called that
  leftover "the boundary estimate's own uncertainty" and left it, which is wrong
  in a way that hides: the lateness does not stay at the seam, it rides to the
  end of the song, and each further seam adds another half beat. Here four seams
  had the last beat **1.3 s late**, and the chart had drifted off the record
  through the back half -- the fit fell to 84% after 177 s while the front of the
  song was at 100%, which reads like a bad outro rather than like a grid fault.

  `realign_seams` closes each one by pulling everything after it back by the
  excess. No beat is invented or lost, so bar numbering is untouched; the fit
  went to **100% in every 20-second window of the song**, the reference floor
  tightened from +13.1 to +10.5 ms with its spread down with it, and the pitch
  now moves at most 26 cents from one beat to the next where it had moved 145.
  Two guards matter. It runs again after `repair_intervals`, because that stage
  works in whole beats and can re-open a seam it cannot itself fix. And it only
  closes intervals *near* 1.5x: a breakdown with the drums out is a real hole in
  the beat map, and pulling the song back across one would be silently wrong from
  there to the end.
- **A set can be written from the top of the track, and the offset is
  measurable.** This one was authored before the song was prepped, so it was
  written against the record from its beginning: its bars 1-3 are the intro and
  the drums come in at its bar 4, where the notation's bar 1 is the first kick
  or snare. That is `bar_offset` in `[author]` (above), and the right value is
  not a thing to eyeball -- slide the chart against the drum stem a sixteenth at
  a time and the fraction of written kick and snare hits that land on an onset
  peaks at exactly -3.00 bars: on the repaired grid, 100% against 91.5% one bar
  either way and 83.6% unshifted. The absolute numbers are not the point and
  never can be: a busy kick-and-snare part finds *something* to match at any
  offset, which is why the floor of that sweep is in the eighties rather than at
  zero. The peak is the point.
- **The cross-stick became an instrument, and it had to be added at both ends.**
  This chart plays its backbeat as a cross-stick for four bars -- section J,
  bars 54-57 -- on a tenth drum-rack pad the other two songs do not use. The
  first pass folded it into `snare`, on the grounds that the project already
  treated the two as one drum. That was wrong about what is worth practising: a
  cross-stick is a different thing to play, and a chart that does not ask for it
  cannot mark you on it. So `sidestick` is now an instrument of its own,
  engraved as the cross notehead alphaTab calls `snare (side stick)`.

  The half that is easy to miss is the **input** side. The staff and the module
  are two different numberings of the same kit, and writing a cross-stick on the
  page while `kit.toml` still read the module's cross-stick (note 37) as `snare`
  would have marked every correctly-played one as the wrong drum -- the chart
  asking for a drum the scorer could not receive. Both moved together, and the
  pair is deliberately **not** in `same_drum`: that list is for one drum caught
  in two states by a threshold you did not set, like an open or closed hat,
  where the flicker is the module's doing. Nothing flickers here. You choose a
  cross-stick, so an ordinary backbeat in those four bars is a wrong drum, which
  is the whole point of writing it.

The sections are still the lettered seed `drums sections` proposed -- fifteen
blocks, A-N. They want naming from the notation the way the other two were.
(Renaming used to start a new comparison epoch and throw the history away; as of
2026-09-19 it does not, so this can be done whenever you like -- see below.)

**The routine became the song, and the drilling became exercises (2026-09-19).**
The grid was every section at four tempos -- 28 to 60 cells, a run you spread
over a week. Sections did not stop being the thing worth drilling; they stopped
being what a *run* is made of. So `buildCells` now returns four cells, the whole
song at 70/80/90/100, and a stretch of bars is an **exercise**: a few bars cut
out of a chart, looped with a bar of click between the reps, graded every time
round. A drill fills a square of the exercise's own ladder and touches no cell,
which keeps the two histories apart -- "can I play the piece" and "have I got
that fill yet" are different questions and were never one number.

Five things learned, in the order they bit:

- **The rest bar is what makes the loop buildable at all.** The plan had the
  transport seeking back mid-playback, with an audible bump at the seam and a
  real risk the `<audio>` element would stutter every rep. Asking for a bar of
  click between reps -- which is how the thing is practised anyway -- turned
  that into a *paused* seek, which is the only kind this app has ever done. The
  feature that was wanted for musical reasons removed the engineering risk
  entirely. The check asserts every rep starts on the same millisecond of the
  record, and the spread is 0.
- **A fill's last note arrives after the transport has stopped.** It is written
  on the last sixteenth and played a hair behind, so it lands while the clock is
  parked at the end of the range -- where `mixTimeAt` would stamp it as `endMs`
  however late it actually was, or, worse, as a very early downbeat of the next
  rep. `MidiHit` already carries `wallMs`, so the rep stays open for `EDGE_MS`
  after the pause and anything arriving in that window is placed from the wall
  clock instead. `EDGE_MS` is now deliberately one number doing two jobs -- the
  matching window and the grace -- because they are the same question.
- **Four cells is what makes the per-cell trend lines readable.** Q14's lines
  were unbuilt because 44 sparklines is not a reading. Four is four, so the trend
  moved from a column of one line per *section* -- the mean of that section's
  four tempos -- to a row of four lines, one under each square. The mean was
  hiding the only thing worth knowing: whether the fast one is catching up.
- **The epoch key had to move from the section hash to the bar span.** Renaming a
  section used to end a comparison epoch, which was right when sections *were*
  the cells. In a four-cell grid a rename changes nothing at all, and One For The
  Road's sections are still unnamed. Under the old rule, naming them would have
  thrown away every run on it. The span (`spanOf`, `1-62`) still ends an epoch
  when the first or last boundary moves, which is when the cells genuinely change.
- **Click-only backing must not go through the sliders.** Every other level
  change on the page dispatches the slider's `input` event, which persists the
  mix to localStorage -- and Ableton reloads the page on every Ctrl+S. A drill
  interrupted half way would have left the song playing silently with nothing on
  screen to say why. The stems come down through `mixer.setLevel` directly and
  the sliders are disabled under a `data-held` attribute, so the page shows it is
  holding them rather than lying about them.

Deliberately not built: alphaTab's `display.startBar`, which would slice the
engraving to the exercise's bars. Four separate things index bars by score
position -- the sync points, the sticking letters, the heatmap and
`barAtTick` -- and all four would need re-basing at once, for a view the
notation window already gives by parking on the right row. The comment saying so
is in `practice.ts`, because somebody will reach for it.

**An exercise became a thing of its own (2026-09-19).** The pool was built a
day earlier and immediately ran into the four things the user reported: cuts did
not loop, "songs can share exercises" did not mean anything you could see, there
was no way to delete one, and there was no link to the pool at all. Three of
those turned out to be one cause. An exercise was *a pair of scissors, not
notation* -- frozen decision 1 in `exercise.ts` -- so its notes came from the
song's chart at the moment you played it. That made every exercise a view of a
song, and the rest followed: it could not be played without one, its several
sources were a link with nothing at either end, and the loop lived inside the
recording path, so the one thing an exercise is for needed a kit plugged in and
a dev server before it would happen.

So decision 1 is reversed. An exercise is a small score now, and it remembers
where it was cut from: the notes, the tempo and the meter are written into
`exercise.json` (`version: 2`), re-based so its own first bar is bar 1. A
`sources` entry stopped being where the notes come from and became *a record
this can also be played against* -- which is what it was always described as.
`backing` gained a third value, `kit`, and it is the default for a new cut.

Six things learned, in the order they bit:

- **The constructible grid cost about forty lines, not the rewrite it was
  budgeted as.** Q13 called it "the single largest structural consequence in
  Round 4", because everything in the app hangs off `grid.lock.json` and an
  exercise with no recording has no measured beats. But everything already
  funnels through `slotToMixMs` and `barStartMs`, and `Grid` is a plain
  interface -- so `syntheticGrid` fills an array at a constant tempo and the
  scorer, the heatmap, the sync points and the cursor all carry on without
  knowing. The estimate was wrong because it counted the *reach* of the type
  rather than the width of its interface.
- **Fork at the clock, not at the player.** The obvious way to make a song-less
  exercise sound is to hand alphaTab back the transport (`EnabledSynthesizer`
  plus its bundled soundfont). That works, and it is the wrong shape: in
  synthesizer mode `updateSyncPoints` is a no-op, so the layer that corrects
  alphaTab's tick-to-ms truncation is gone and the written tempo becomes the
  playing tempo; and `MidiIn` stamps every stroke through the clock. Staying in
  `EnabledExternalMedia` for ever and swapping *which clock* it follows
  (`clock.ts`, `timer-clock.ts`, `transport.ts`) keeps one transport, one set
  of sync points and one scorer for both halves.
- **...which left the sound to be solved by baking.** alphaTab's synthesizer
  only makes sound when alphaTab owns the transport -- but `api.exportAudio`
  renders offline, takes a soundfont explicitly, and is documented to work with
  any player mode. Verified: peak 0.58, interleaved stereo, in
  `EnabledExternalMedia` with no soundfont ever loaded into the player. So
  `scripts/bake-kit.mjs` renders one bar per articulation and writes twelve
  one-shots to `kit/samples/`, and `kit.ts` plays them on the audio clock with
  `click.ts`'s own lookahead scheduler. A bank of one-shots booked on a clock
  *is* a sampler, which is the shape the user's own sampler slots into: it
  replaces a `Kit`, and nothing else moves.
- **The end of the score is not the end of the media, and the loop only ever
  watched for one of them.** `tick` closed a rep when the clock crossed
  `endMs` -- fine on a song, where the mix runs on for minutes past the cut.
  For a standalone exercise the score *is* the range, so alphaTab reached the
  end, fired `playerFinished` and rewound to 0 before the 25 ms poll ever saw
  the crossing. The clock sat at 0 and the loop never turned round. The end of
  a rep is now told (`reachedEnd`) as well as watched for, which also fixes an
  old stall on the song side: a cut whose last bar ran past the end of the
  recording used to hang for exactly this reason.
- **Grading was the loop's reason for existing, and should only have been a
  property of it.** `Recording` became `Run` with a `grading` flag; four
  already-isolated points fall out when it is off, and Play on an armed
  exercise opens the same run unmarked -- same seek, same rest, same count-in,
  nothing written down. The loop never needed MIDI or the dev server. Only the
  button in front of it did.
- **Delete had been finished for a day and had no button.** The route, the
  client call and a confirm naming the drill count all existed; the only caller
  in the repo was the headless check, through the DEV-only `window.drums`
  handle. That is what a back door in a test costs: it looks like coverage of
  the feature and it is coverage of the stack under it. `check-exercise` now
  presses the real button.

The nav header is the fourth thing, and it is unrelated to all of the above: a
`<header id="nav">` spanning the grid, carrying Songs (the picker -- choosing
one *is* the navigation) and Exercises, plus the two rail toggles and zen. The
pool used to be reachable only from a button inside the song page's Exercises
group, which CSS hides on the exercise page, so the pool and an exercise both
had a way in and no way out.

Deliberately not built: upgrading the six v1 exercises already on disk to carry
their own notes. They parse, they play against the record exactly as before, and
rewriting a tracked file on sight to add a field nothing is asking for is the
kind of migration that is discovered in a diff rather than chosen. Adding a
source to one gives it a chart, which is the one moment the notes are in hand
anyway.

What is left of M3 in `practice-plan.md` is the take-vs-take overlay. The
per-cell trend lines it also asked for are done.

Against that sit the small unscheduled things, which the user has said serve the
thing they actually value -- playing along with the notation at different tempos
-- better than the coach milestone does: **a loop** (mark two bars, repeat them),
a **tempo ramp** on that loop, **bigger notes** (`display.scale` and a Zoom
control next to Lines), and a **count-in on a paused start**. Step-by-step mode
(Q12) belongs with them rather than with M4: it needs no scoring, no take format
and no calibration.

The archived research on drift correction between media elements and the sweep
is in the old plan: `git show transcriber:player-plan.md` (sections
"Transport", "Sync points", "Notation window").

Headless checks in `app/scripts/`, all needing `npm run dev`: `smoke.mjs`
(render + playback), `shot.mjs <png>` (screenshot + sample alphaTex),
`check-ui.mjs <png>` (drives Space, every shortcut, the Lines control and the
Sticking switch, asserts the window follows the cursor a line at a time playing
and paused, asserts the notation never overlaps the picture, that Fill leaves
the picture the third of the screen `--fill-picture` sets and that the video
fills that region on one axis rather than sitting letterboxed in it, then
collapses both rails -- asserting they reach one icon wide, that the stage
takes the room, that the controls survive as icons and the grid does not, and
that it is remembered across a reload -- enters zen, asserting the
rails and the status line go, the grid drops to one column and an error on the
status line is still shown, and finally works the Layout group: that `+`
enlarges the notation and leaves Bars a line alone, that the window grows to
keep the lines it was asked for, that the sticking letters grow with the notes,
that `-` and the remembered rung agree, that each of the other three faders
reaches alphaTab and is remembered (eight bars a line really puts eight on the
row and still fits the pane; a wider line gap makes the window taller), and
that `0` puts all four back. Screenshots line 2 eight times:
`<png>`, `<png minus
.png>-dark.png`, `-dark-light-tabs.png` (the dark interface with light notation
the two themes are for), `-icons.png`, `-zen.png`, `-zoom.png`, `-dense.png`
and `-loose.png`), and
`check-sync.mjs` (seeks every bar both ways and asserts clock and cursor agree
within 15 ms, then plays through the count-in), `check-mix.mjs` (plays at
100% and 50% and asserts the stems stay within 20 ms of the clock and the
picture settles within 60 ms of it, the graph is silent with every fader at 0,
and the click is audible), `check-practice.mjs` (opens a routine,
records one of its cells with injected strokes -- one of each mistake -- and
asserts the grade, the three dials, the bar strip, the take on disk and the cell
it filled, including that the lateness which comes back is the lateness that
went in *minus the song's reference floor*; screenshots the reading in its rail
to `app/shots/practice.png`, because whether it fits is not a thing a count can
answer; **reloads the page** the way a
Ctrl+S in Live does and asserts the run came back with the cell still in it;
posts synthetic sealed runs and asserts the trend row reads them and smooths
them; then runs the calibration ritual with strokes placed a known lateness
after each click is *heard* and asserts that number comes back. It deletes
everything it wrote and restores the machine's own calibration -- **and note
that its cell is now the whole song, so it sits there for the length of the
record**), and `check-exercise.mjs`, which is the fast end-to-end proof of the
same path because a loop is three bars: it cuts an exercise out through the real
form, asserts the three refusals that cannot be fixed afterwards, drills it for
three reps and stops part way through a fourth, and then asserts the two things
the loop lives or dies on -- that **every rep starts on the same millisecond of
the record**, and that a stroke played past the end of the range **stays in the
rep that asked for it, still as late as it was played**. It also asserts the
drill on disk, the median rule, the ladder, that a click-only drill gives the
faders back, that a reload does not lose the square, and that the trend reads a
posted history. It deletes the exercise it made, drills and all -- **through
the button on the page**, because that is the only place delete is exercised.
Before any of that, and before MIDI is ever enabled, it asserts the loop works
with no kit in the room: Play alone turns it round, every time to the same
millisecond, writing nothing. `check-solo.mjs` is the other half -- an exercise
carrying its own notes, opened on a page whose first hash is that exercise, and
asserting the four things that were not true before: no song is ever fetched
(the mix element's `src` is still empty), the notes came with the file and the
scorer marks against them, it loops on a clock that is not a recording, and it
makes a sound of its own -- the kit bus, loud when it is up and silent at 0,
measured on the graph's analyser. They
launch the installed Chrome or Edge (`browser.mjs`): Playwright's own Chromium
cannot decode the H.264 video. Each checks the first song in the list unless
`SONG=<slug>` names another.

There is also `bake-kit.mjs`, which is not a check: it renders one bar per
articulation through alphaTab's bundled soundfont and writes `kit/samples/`. Run
it once (`npm run bake-kit`); `check-solo` needs what it leaves behind.

Tests that need no browser: `.venv/Scripts/python -m pytest -q tests` for the
pipeline, and `npm test` in `app/` for the scorer, the chart reader, the routine
grid and the exercise ladder -- Node runs the TypeScript source directly, with
`scripts/ts-resolve.mjs` supplying the file extensions a bundler would.
