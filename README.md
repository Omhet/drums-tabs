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
fixed grid those attempts fill: every section at 70/80/90/100% and then the
whole song, the same set of cells every run so that two runs can be compared,
open across as many sittings as it takes and sealed by hand. Two things it
needs:
the dev server, because writing files is a Vite plugin's job here and not a
built page's; and a MIDI port Chrome can open **while your sampler is already
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
is the thing you think of yourself as working on. Three things learned:

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

Older candidates, still unstarted: a loop (two keys marking the start and end
bar), bigger notes (`display.scale` and a Zoom control next to Lines), and a
count-in on a paused start. Next is M3 in `practice-plan.md`: the history --
per-cell trend lines and a take-vs-take overlay.

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
within 15 ms, then plays through the count-in), `check-mix.mjs` (plays at
100% and 50% and asserts the stems stay within 20 ms of the clock and the
picture settles within 60 ms of it, the graph is silent with every fader at 0,
and the click is audible), and `check-practice.mjs` (opens a routine,
records one of its cells with injected strokes -- one of each mistake -- and
asserts the grade, the colours, the extras lane, the take on disk and the cell
it filled; **reloads the page** the way a Ctrl+S in Live does and asserts the
run came back with the cell still in it; then runs the calibration ritual with
strokes placed a known lateness after each click is *heard* and asserts that
number comes back. It deletes the take and the routine it wrote and restores the
machine's own calibration). They
launch the installed Chrome or Edge (`browser.mjs`): Playwright's own Chromium
cannot decode the H.264 video. Each checks the first song in the list unless
`SONG=<slug>` names another.

Tests that need no browser: `.venv/Scripts/python -m pytest -q tests` for the
pipeline, and `npm test` in `app/` for the scorer, the chart reader and the
routine grid -- Node runs the TypeScript source directly, with
`scripts/ts-resolve.mjs` supplying the file extensions a bundler would.
