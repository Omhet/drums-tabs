# Handoff: M2 is done, M3 is next

Written 2026-09-13. Read this, then `README.md` "Where things stand", then
`practice-plan.md` §7 (Q11 how mistakes are shown) and §8 (Q14 what is compared
between two runs) for the decisions M3 has to honour.

---

## 1. Where things stand

M0, M1 and M2 of `practice-plan.md` are complete.

**M0** pivoted the clock onto `<audio>` on `mix.wav` (so the clock's time *is*
mix time), prepped the original track as its own song, and added `drums
sections` and `drums sticking`.

**M1** is the thin slice: Web MIDI in, the calibration ritual, a take on disk,
the scorer, and the grade drawn on the staff. One cell, hardcoded.

**M2** is the routine grid: the fixed set of cells one run walks, filled a cell
at a time, resumable across sittings and sealed by hand. The files:

```
app/src/routine.ts     the grid and the rules. Pure; the part with tests on it.
app/src/practice.ts    the panel that plays it: select, record, fill, seal
app/plugins/practice.ts  /practice/routine (GET/POST/DELETE) + virtual:kit
app/src/midi-in.ts     the module -> hits, stamped in mix time
app/src/chart.ts       tab.mid -> notes, placed in the mix, given limbs
app/src/grade.ts       the scorer. Pure, and the other part with tests on it.
app/src/calibrate.ts   tap-to-click, median of N, two clocks bridged
app/src/take.ts        the take format (Q8). The important one.
app/src/heatmap.ts     noteheads coloured by verdict + the extras lane
kit.toml [input]       what your module sends (NOT the chart's numbering)
pipeline/reference.py  how far behind the chart the record itself plays
songs/<slug>/routines/ the runs. The open one has `sealedAt: null`.
```

### Checks

From `app/`, with `npm run dev` running in its own terminal:

```
npm run smoke · check-sync · check-mix · check-ui out.png · check-practice
npm test                                   # scorer + chart + routine, 55, no browser
.venv/Scripts/python -m pytest -q tests    # 102, no browser
cd app && npm run typecheck
```

**Known-good as of 2026-09-13:** 102 pytest, 55 node tests, clean typecheck,
and all five browser checks on both songs. Run the important ones twice, once
per song (`SONG=<slug>`): the cover has a video, the original has none and is
the one with sections, sticking and a grid.

Gotchas, all previously bitten: the checks need **real Chrome or Edge**
(bundled Chromium has no H.264); the Ableton plugin reloads the page on every
`.als` save, so a page loaded mid-reload can look broken; and **never write
alphaTex or other backslash-heavy content through a shell heredoc** — use an
editor tool.

### Settled at the kit on 2026-09-13, so do not re-ask

- **Multi-client MIDI works.** The kit is a Roland TD-27 with Local Control off,
  driving Superior Drummer 3 in Ableton -- so two applications want the module
  at once. They get it: SD3 sounds and Chrome receives the same strokes, with no
  loopMIDI hop and no virtual-port splitter. Q2's fallbacks stay documented in
  `practice-plan.md` and are not needed on this machine.
- **The `[input]` note numbers are right**, checked pad by pad against the
  Monitor: no unmapped notes, no wrong names.
- **The WSOLA tempo question is closed.** 70% and 80% sound fine on the
  original's stems, so the tempo ladder costs nothing and no `drums ladder`
  pipeline step is needed.
- **Sections are named and cut**, by hand from the notation on 2026-09-13:
  twelve blocks under ten names, with every fill and pickup a block of its own.
  44 cells. `drums sticking --restick` has been run, so the lock's kit digest
  matches again. Re-running `drums sections --redetect` would throw the names
  away -- don't, unless the chart itself has changed shape.
- **Calibration on this machine is about +27 to +31 ms** with a ±20-25 ms
  spread, measured on the snare while cold. One number for the whole module, by
  the user's choice; per-pad stays possible later because takes keep raw stamps.

### What the user still owes the work

1. **Play a routine and see whether the sections are cut where you would cut
   them.** They were named from the notation, not from the record, and the names
   are a guess at the song's form: `verse` / `into chorus` / `chorus` /
   `into verse` / `verse` / `into chorus 2` / `chorus` / `into bridge` /
   `bridge` / `build` / `into last chorus` / `last chorus`. `bridge` (42-45) and
   `build` (46-49) are the least certain. Renaming is free *now* and expensive
   later: it changes `sectionsHash`, which **starts a new epoch** -- any open
   routine refuses to resume and old runs leave the comparison line. Two knobs
   worth knowing: naming `build` `chorus` would merge it away (it is the same
   plain groove) and take the routine to 40 cells; naming `into chorus 2`
   `into chorus` would merge the two pickups, which differ only by two hi-hat
   notes, for 36.
2. **Re-calibrate warmed up.** The first measurement had a ±20-25 ms spread,
   wide enough that the offset it produced is itself uncertain by several ms --
   and every take in the history is corrected by that number.
3. **Check the module's hi-hat offset** (parked, the user will do it later).
   Closed only registers under heavy pressure, which is either a miscalibrated
   offset or honest reporting of a loose-hat playing style. The Monitor tells
   them apart: press to what *you* call closed and see whether note 42 or 46
   comes out. If 42 arrives at normal pressure, nothing is wrong and
   `same_drum` is already the right answer. Nothing in the app depends on the
   outcome -- `[input]` maps both notes, and takes re-grade from raw stamps.
4. **Read the R/L letters** and tune `kit.toml` if they are not what they would
   play, then `drums sticking <slug> --restick`.

### Open, small, and offered but not built

- **Show the hi-hat pedal's position live.** The module streams it as CC4,
  which `midi-in.ts` currently drops on the floor (it only reads note-ons).
  Surfacing it in the Monitor would turn the offset check above from probing
  hit-by-hit into watching a number. Perhaps twenty lines; the user has not
  asked for it yet.
- **Whether to shift the reference** by the offset `drums reference` measures.
  Deliberately not decided in M1 -- see §4.
- **The grid folds away while a take is running** and comes back when it stops,
  so the notation gets the stage exactly when it is being read. Eleven rows is
  about 240 px otherwise. If it ever needs to fold on demand as well, that is
  one checkbox next to Monitor.

---

## 2. What M2 built, and the decisions inside it

The rules live in `app/src/routine.ts`, which is pure and has 27 tests on it
(`app/scripts/test-routine.mjs`). Read that file first: every rule below is a
named export with the reasoning above it.

- **The grid** is `[[section]]` blocks x 70/80/90/100, walked section-major,
  then the whole song at each tempo, with the whole song at 100% last. Ten
  distinct sections is 44 cells. **Two blocks with the same name are one cell**,
  practised against the first of them -- that is the only lever that makes a
  routine smaller, and cutting fills into blocks of their own is the one that
  makes it bigger.
- **Only a complete take fills a cell** (the transport reached the last bar),
  and **the last complete take counts, not the best**. An abandoned take is
  still written to `takes/`; it just fills nothing.
- **A cell below 90% (`PASS`) goes red and blocks nothing.** The threshold is
  one number for every tempo on purpose: a ladder of thresholds would make
  "green" mean something different in each column.
- **Where next:** finishing a cell walks *forwards* from it, so someone working
  up section D stays in D. Picking a run up in a new sitting goes to the first
  hole in the grid instead -- there is no "where you were" after a reload.
- **The open routine is a file**, rewritten after every cell, because Live
  reloads the page on every Ctrl+S. At most one per song, and that rule is
  enforced by the route (a second open routine is a 409), not by the page --
  the page is the thing that keeps being reloaded, and a second tab is real.
- **Two grades of epoch break.** Sections moved -> the grid is a different
  shape, the routine cannot be resumed at all, only sealed or discarded. Chart
  edited -> the run carries on, each fill records the chart it was graded
  against, and sealing across two of them marks the routine `mixed` and keeps
  it off the comparison line.
- **Sealing** refuses a routine with holes, stamps `sealedAt`, and records the
  date span. **Discarding** deletes the run and never the takes.

### The two real takes are still the proof of the format

`songs/hayley-williams-kill-me-official-visualizer/takes/` holds the first two
takes played on the real kit, before the hi-hat fix. **Do not delete them** and
do not re-write their `grade` field: they are the evidence that Q8's "store raw
timestamps, record the calibration beside them" decision works. They carry the
pre-redetect `sectionsHash` and no `cell.id`, which is exactly right -- a take
is never rewritten, and `cell.id` is optional for that reason.

---

## 3. What M3 is

From `practice-plan.md` Q11 and Q14: **the history.** Per-cell trend lines and
a take-vs-take overlay -- the first time anything in this project answers "am I
getting better", which is the question the whole take format exists to serve.

What is already there to build on:

- Every sealed routine is a file in `songs/<slug>/routines/`, each cell
  pointing at the take that filled it (`fill.take` is the filename), with
  `accuracy`, `hit`, `expected` and the `chartHash` it was graded under.
- Every take holds the raw strokes, so any two takes can be re-compared in full
  without re-playing anything, and a scoring rule fixed later re-reads old
  attempts instead of invalidating them.
- `mixed` and `sectionsHash` already say which runs belong on one line.
- The routes are in `app/plugins/practice.ts`; M3 needs a *list* route
  (`GET /practice/routines`) next to the open-routine one, and probably a way
  to read a take back.

The thing to decide before building: **a sealed routine has one number per
cell, but a take has a grade, a timing distribution and 70 strokes.** Q14 says
what is compared; check it before designing the trend line, because "accuracy
per cell over time" and "this take against that take" are different pictures
and only one of them fits on the grid that already exists.

---

## 4. Things M1 and M2 learned that M3 should not relearn

- **A hit is stamped when it arrives**, and mix time is not wall time.
  `MixClock.mixTimeAt` does the conversion, scaled by the playback rate.
- **Calibration comes off before matching**, not just before reporting.
- **Match windows meet at midpoints and never overlap**, which is what makes
  matching arithmetic rather than a search. Do not widen one side without
  widening the other.
- **A cell's tempo goes through the page's tempo slider**, not straight at
  alphaTab, or the slider and the real rate drift apart. The count-in has to
  scale with it too.
- **Chrome refuses Web MIDI to an automated browser**, however the permission
  is set, headless or not. The checks inject strokes through `MidiIn.inject`;
  acquiring a port is the one part only a human at the kit can verify.
- **alphaTab colours its own noteheads** and a full 62-bar re-render costs
  ~30 ms with the transport preserved, so no overlay is needed for notes. Only
  extras -- which have no notehead -- get one.
- **Four numberings of the same drums now exist**: the module's, the drum
  rack's (`[midi_map]`), the chart's instrument names, and alphaTab's GM
  articulations. Never add a fifth, and never assume two of them agree.
- **A "wrong voice" is often the module disagreeing with the foot.** A hi-hat
  sends open or closed by pedal position at the instant of the strike, and the
  threshold is not where a resting foot thinks closed is. `kit.toml`'s
  `[input].same_drum` groups the pair so it scores as a hit and is reported
  separately. Expect the same class of problem from any instrument with states.
- **The reference is not neutral.** `drums reference` measures how far behind
  the chart's grid the record's own drummer sits; on this song it is +12.7 ms,
  so a faithful take reads as late by that much. Before believing a take's
  mean, check what the floor is. Whether to shift the reference is an open
  decision, deliberately not taken -- and M3 is where it starts to matter,
  because a trend line drawn against a biased floor is biased for its whole
  length.

---

## 5. Ground rules carried into this work

- **Concepts get explained plainly.** The reader is a drummer, not a DSP
  engineer; define jargon at first use.
- **The user knows the songs.** Measurements from a recording are not ground
  truth about what was played.
- **Write commit messages out; the user stages and commits.**
- `README.md` "Where things stand" is the authoritative status log, written as
  a running narrative with a "things learned" list per step. Keep it updated as
  part of the work, not afterwards.
