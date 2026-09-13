# Handoff: M1 is done, M2 is next

Written 2026-09-13. Read this, then `README.md` "Where things stand", then
`practice-plan.md` §6 (Q5 the routine) and §7 (Q10 resuming) for the decisions
M2 has to honour.

---

## 1. Where things stand

M0 and M1 of `practice-plan.md` are complete.

**M0** pivoted the clock onto `<audio>` on `mix.wav` (so the clock's time *is*
mix time), prepped the original track as its own song, and added `drums
sections` and `drums sticking`. All of it is commit `fe4ff10`, whose title
mentions only the sticking.

**M1** is the thin slice: Web MIDI in, the calibration ritual, a take on disk,
the scorer, and the grade drawn on the staff. One cell, hardcoded. The files:

```
app/src/midi-in.ts     the module -> hits, stamped in mix time
app/src/chart.ts       tab.mid -> notes, placed in the mix, given limbs
app/src/grade.ts       the scorer. Pure, and the part with tests on it.
app/src/calibrate.ts   tap-to-click, median of N, two clocks bridged
app/src/take.ts        the take format (Q8). The important one.
app/src/heatmap.ts     noteheads coloured by verdict + the extras lane
app/src/practice.ts    the panel that wires it together
app/plugins/practice.ts  virtual:kit, and the routes that write to disk
kit.toml [input]       what your module sends (NOT the chart's numbering)
pipeline/reference.py  how far behind the chart the record itself plays
```

### Checks

From `app/`, with `npm run dev` running in its own terminal:

```
npm run smoke · check-sync · check-mix · check-ui out.png · check-practice
npm test                                   # scorer + chart, 28, no browser
.venv/Scripts/python -m pytest -q tests    # 102, no browser
cd app && npm run typecheck
```

**Known-good as of 2026-09-13:** 102 pytest, 28 node tests, clean typecheck,
and all five browser checks on both songs. Run the important ones twice, once
per song (`SONG=<slug>`): the cover has a video, the original has none and is
the one with sticking.

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
  original's stems, so M2's tempo ladder costs nothing and no `drums ladder`
  pipeline step is needed.
- **Sections were re-detected** at `--min-bars 8` -- six blocks, six distinct, a
  28-cell routine -- and `drums sticking --restick` has been run, so the lock's
  kit digest matches again.
- **Calibration on this machine is about +27 to +31 ms** with a ±20-25 ms
  spread, measured on the snare while cold. One number for the whole module, by
  the user's choice; per-pad stays possible later because takes keep raw stamps.

### What the user still owes the work

1. **Rename the sections** in the original song's `song.toml`. They are A-F, and
   the song is closer to verse / prechorus / afterchorus / verse and then a
   near-repeat -- and **two blocks given the same name become one section
   practised once**, which is how a 28-cell routine gets smaller. The player now
   draws the names over the staff, so it can be done by reading the score.
   **This blocks M2**: the cell grid is derived from the sections and
   `sectionsHash` pins every take to them, so change them *before* recording
   takes worth keeping.
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
  Deliberately not decided in M1 -- see §3.

---

## 2. What M2 is

From `practice-plan.md` Q5 and Q10: **the routine grid.**

- A song's routine is a **fixed, unchanging set of cells** — every section at
  70/80/90/100%, plus the whole song at each tempo. Identical every run,
  forever, or runs stop being comparable. Six blocks, six distinct, is 28 cells
  for this song -- fewer once two of them are given the same name.
- **Walked section-major**: section 1 at 70/80/90/100, then section 2.
- A cell below threshold goes **red and does not block you**.
- **Complete = every cell has one take played to the end**, and the **last
  complete take counts, not the best**.
- **Resumable across sittings, sealed by hand.** An open routine is a file on
  disk (`songs/<slug>/routines/`, `sealedAt: null`), written after every cell,
  because the Ableton watcher reloads the page on every Ctrl+S.
- At most one open routine per song. A chart edit mid-routine warns; sealing a
  routine whose cells span more than one `chartHash` marks it **mixed**.

### Two real takes already exist, and they are the proof of the format

`songs/hayley-williams-kill-me-official-visualizer/takes/` holds the first two
takes played on the real kit, before the hi-hat fix. **Do not delete them** and
do not re-write their `grade` field: they are the evidence that Q8's "store raw
timestamps, record the calibration beside them" decision works. Re-graded under
today's rules the second one goes 56/72 → 66/72 with wrong-voice 10 → 0, purely
because the hi-hat pair is now grouped — a scoring rule fixed afterwards re-read
an old attempt instead of invalidating it.

They also carry the **pre-redetect `sectionsHash`**, so M2's epoch handling has
a real case to get right on day one: same chart, same bars 1-12, different
section grid.

### Where it plugs in

`CELL` in `app/src/practice.ts` is the one constant to replace — the section
index and the tempo. Everything under it already takes the cell as data:
`expected()` builds the notes for any bar range, `startRecording` seeks and
stops on any range, and the take already records `cell.section`, `cell.tempo`,
`cell.startBar`, `cell.endBar` and both hashes. The grade already carries
`accuracy`, which is what a cell's red/green needs.

`song.sections` and `song.sectionsHash` are already on `SongMeta`
(`app/plugins/ableton.ts`), so the grid can be built without touching the
plugin. Writing a routine file needs one more route in
`app/plugins/practice.ts`, next to `/practice/take`.

### The check that gated it, now passed

**WSOLA listening.** Chrome's time-stretch with `preservesPitch = true` was
judged clean at 70% and 80% on the original's stems, so the tempo ladder is free
and the `drums ladder` pre-render fallback (~850 MB per song) is not needed.

---

## 3. Things M1 learned that M2 should not relearn

- **A hit is stamped when it arrives**, and mix time is not wall time.
  `MixClock.mixTimeAt` does the conversion, scaled by the playback rate — which
  M2 needs, because 70% is the whole point of the grid.
- **Calibration comes off before matching**, not just before reporting.
- **Match windows meet at midpoints and never overlap**, which is what makes
  matching arithmetic rather than a search. Do not widen one side without
  widening the other.
- **Chrome refuses Web MIDI to an automated browser**, however the permission
  is set, headless or not. The checks inject strokes through `MidiIn.inject`;
  acquiring a port is the one part only a human at the kit can verify.
- **alphaTab colours its own noteheads** and a full 62-bar re-render costs
  ~30 ms with the transport preserved, so no overlay is needed for notes. Only
  extras — which have no notehead — get one.
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
  so a faithful take reads as late by that much. Before believing a take's mean,
  check what the floor is. Whether to shift the reference is an open decision,
  deliberately not taken in M1.

---

## 4. Ground rules carried into this work

- **Concepts get explained plainly.** The reader is a drummer, not a DSP
  engineer; define jargon at first use.
- **The user knows the songs.** Measurements from a recording are not ground
  truth about what was played.
- **Write commit messages out; the user stages and commits.**
- `README.md` "Where things stand" is the authoritative status log, written as
  a running narrative with a "things learned" list per step. Keep it updated as
  part of the work, not afterwards.
