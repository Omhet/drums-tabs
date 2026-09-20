# Handoff: the grid and the reading are done; the rest of M3 is next

Written 2026-09-16. Read this, then `README.md` "Where things stand". The plan
files (`practice-plan.md`, `avatar-plan.md`) are the *reasoning*, not the status
— and §3 below records where the built thing now deliberately departs from them.

---

## 1. Where things stand

M0, M1 and M2 of `practice-plan.md` are complete, and M3 has been started from
the far end: the *reading* was rebuilt and a per-section history added, which is
what the user actually wanted from it. The per-cell trend lines and the
take-vs-take overlay Q14 specifies are still unbuilt.

**M0** pivoted the clock onto `<audio>` on `mix.wav`, prepped the original track
as its own song, and added `drums sections` and `drums sticking`.

**M1** is the thin slice: Web MIDI in, the calibration ritual, a take on disk,
the scorer, and the grade drawn on the staff.

**M2** is the routine grid: the fixed set of cells one run walks, filled a cell
at a time, resumable across sittings and sealed by hand. **Reshaped on
2026-09-19** -- it is four cells now, the whole song at each tempo, and the
stretch of bars you drill is an exercise instead.

**The reading** (2026-09-16) is three dials, a bar strip, three notehead colours
and a per-section trend column, replacing a table nobody could read. See §3.

```
app/src/routine.ts     the grid, the rules, and the history maths. Pure; tested.
app/src/grade.ts       the scorer. Pure, and the other part with tests on it.
app/src/reference.ts   the floor: how far behind the chart the record plays
app/src/practice.ts    the panel: select, record, fill, seal, and the reading
app/plugins/practice.ts  /practice/routine(s), /practice/take, virtual:kit
app/src/midi-in.ts     the module -> hits, stamped in mix time
app/src/chart.ts       tab.mid -> notes, placed in the mix, given limbs
app/src/calibrate.ts   tap-to-click, median of N, two clocks bridged
app/src/take.ts        the take format (Q8). The important one.
app/src/heatmap.ts     noteheads coloured by verdict + the extras lane
app/src/exercise.ts    the pool: what an exercise and a drill are. Pure; tested.
app/src/exercises.ts   the panels: the song's list, the cutting form, the pool page
app/src/clock.ts       what the page needs from a clock, whoever is counting
app/src/timer-clock.ts a clock with no media behind it: an exercise's own line
app/src/transport.ts   which of the two alphaTab follows, and the one swap
app/src/kit.ts         the written notes, sounded. The seam a sampler slots into.
exercises/<id>/        the pool itself, at the repo root: one dir per exercise
kit/samples/           twelve one-shots; `npm run bake-kit` writes them
kit.toml [input]       what your module sends (NOT the chart's numbering)
pipeline/reference.py  measures the floor, writes reference.lock.json
songs/<slug>/routines/ the runs. The open one has `sealedAt: null`.
```

### Checks

From `app/`, with `npm run dev` running in its own terminal:

```
npm run smoke · check-sync · check-mix · check-ui out.png · check-practice · check-exercise · check-solo
npm test                                   # scorer + chart + routine + exercise + bar_offset, 106, no browser
.venv/Scripts/python -m pytest -q tests    # 116, no browser
cd app && npm run typecheck
```

**Known-good as of 2026-09-19:** 116 pytest, 106 node tests, clean typecheck, and
every browser check. Run the important ones once per song (`SONG=<slug>`).
`check-practice` now records the whole song, so it takes about as long as the
record does; `check-exercise` is the fast proof of the same path, and
`check-solo` is the other half of it -- an exercise on its own notes, with no
song loaded at all. `check-solo` needs `kit/samples/`, so run `npm run bake-kit`
once if the directory is not there.

Gotchas, all previously bitten: the checks need **real Chrome or Edge** (bundled
Chromium has no H.264); the Ableton plugin reloads the page on every `.als` save,
so a page loaded mid-reload can look broken; and **never write alphaTex or other
backslash-heavy content through a shell heredoc** — use an editor tool.

### The songs

| slug | bars | BPM | cells | floor |
|---|---|---|---|---|
| `hayley-williams-kill-me-official-visualizer` | 62 | 90.9 | 44 | +12.7 ms |
| `blur-song-2-official-music-video` | 64 | 130.4 | 32 | +6.2 ms |
| `arctic-monkeys-one-for-the-road-official-video` | 72 | 90.9 | 60 | +10.5 ms |
| `hayley-williams-kill-me-drum-cover` | 62 | 90.9 | — | — |

The cover is the original video-bound song and has no sections; it is kept
because `VideoClock`'s two-timeline conversion is what M5 needs.

**Song 2's Live set lives in the Kill Me project folder.** It was saved there,
and moving a `.als` out of its Ableton project by hand breaks its sample links,
so `[author]` points at where it actually is. Each song watches its own set by
filename, so two in one folder do not collide. Moving it properly means *Save As*
from inside Live, then updating the path.

**One For The Road's set starts three bars before the notation does.** It was
written against the record from the top of the track, so its bars 1-3 are the
intro and its bar 4 is the song's bar 1. `bar_offset = 3` in `[author]` takes
them off on the way to `tab.mid`; the value was measured by sliding the chart
against the drum stem (a clean peak at -3.00 bars — on the repaired grid, 100%
of the 422 kick and snare hits matched against 91.5% one bar either way), not
eyeballed. Two consequences: the straightened stems go at **bar 4** of that set
rather than at 1|1|1, and the renders are at **91 BPM**, so the Live project
needs to be at 91 — it was written at 90. Changing a project's tempo does not
move a note; the clips are on the bar grid.

**The beat map had four half-beat seams, and they are why the grid repair
changed** (2026-09-18). `repair_local_octave` halves a stretch the detector ran
at double time, and a run spanning an odd number of half-beats used to leave one
1.5x interval behind, documented as harmless. It is not: every beat after such a
seam is half a beat late and the error rides to the end of the song. Four of them
had this grid's last beat 1.3 s late and the chart 84% off the record through the
back half. `realign_seams` (in `pipeline/grid.py`, 6 tests) closes them by
pulling the remainder back; no beat is invented or lost, so bar numbering is
untouched. The fit is now 100% in every 20-second window. **No other song has an
octave run at all**, so the change is a no-op for them — do not regrid them
expecting a difference.

**Song 2's chart is 65 bars and its beat map is 64.** The last crash sits on the
downbeat of 65 and the detector found no beats past it, so a cell ending at 65
could not be placed and the sections stop at 64. Playing that crash on a
whole-song take logs two extras, which never touch accuracy.

### Settled, so do not re-ask

- **Multi-client MIDI works.** TD-27 with Local Control off, driving Superior
  Drummer 3 in Ableton, and Chrome receives the same strokes — no loopMIDI hop,
  no virtual-port splitter. Q2's fallbacks are documented and not needed here.
- **The `[input]` note numbers are right**, checked pad by pad.
- **The WSOLA tempo question is closed.** 70% and 80% sound fine, so the tempo
  ladder is free and no `drums ladder` pipeline step is needed.
- **Calibration is about +29 ms with a ±17 ms spread**, measured warm. One number
  for the whole module, by the user's choice.
- **Sections are named by hand from the notation** on both songs, with every
  fill and pickup cut out as a block of its own so it can be drilled. Re-running
  `drums sections --redetect` would throw the names away.
- **A cross-stick is its own instrument, not a snare** (2026-09-18). One For The
  Road writes one for four bars, so `sidestick` is in `ARTICULATION`
  (`snare (side stick)`, a cross notehead), in `kit.toml` as geometry, and in
  `[input.note]` where the module's note 37 now reads as `sidestick` rather than
  `snare`. Both ends had to move together: a chart asking for a drum the scorer
  cannot receive marks every correct stroke wrong. The pair is **not** in
  `same_drum` — that is for a threshold the module sets, like an open or closed
  hat, and nothing flickers here. The cost is that a cross-stick played on the
  other two songs, whose charts never ask for one, is now a wrong drum instead
  of a snare; that is the intended trade.

### What the user still owes the work

1. **Cut the first real exercises.** The pool holds six near-duplicate test
   cuts of bars 1-2 of One For The Road, made while the panels were being
   tried. They are `version: 1` — from before the notes moved into the file —
   so they play against the record only, and the ✕ on each row throws them
   away. Every fill in the two prepared songs is already a `[[section]]` of its
   own, so `Cut bars…` is one click each. Nothing about the loop's *feel* —
   chiefly whether one bar of rest is the right amount, and whether the baked
   samples are good enough to practise to — can be settled without playing it,
   and `restBars` is per-exercise precisely so it can be argued with.
2. **Play a run and seal it.** Nothing has been sealed yet on any song, so the
   trend row has never appeared outside a headless check. It needs one sealed
   run to show anything and three to start smoothing. A run is four cells now,
   not forty-four, so this is an afternoon rather than a week.
3. **Name One For The Road's sections.** It still has the lettered seed
   `drums sections` proposed -- fifteen blocks, A-N. This used to be urgent
   because renaming changed `sectionsHash` and threw the history away; since
   2026-09-19 the epoch key is the bar span, so a rename costs nothing and this
   can be done whenever the names come to you.
4. **Check the module's hi-hat offset** (parked). Closed only registers under
   heavy pressure, which is either a miscalibrated offset or honest reporting of
   a loose-hat style. The Monitor tells them apart: press to what *you* call
   closed and see whether note 42 or 46 comes out. Nothing depends on the
   outcome — `[input]` maps both and takes re-grade from raw stamps.
5. **Read the R/L letters** and tune `kit.toml` if they are not what they would
   play, then `drums sticking <slug> --restick`.

---

## 2. What M2 built

The rules live in `app/src/routine.ts`, which is pure and has 39 tests on it.
Read that file first: every rule below is a named export with its reasoning above
it.

- **The grid** is `[[section]]` blocks × 70/80/90/100, walked section-major, then
  the whole song at each tempo, with the whole song at 100% last. **Two blocks
  with the same name are one cell**, practised against the first — the only lever
  that makes a routine smaller; cutting fills out is the one that makes it bigger.
- **Only a complete take fills a cell**, and **the last complete take counts, not
  the best**. An abandoned take is still written; it just fills nothing.
- **A cell below 90% (`PASS`) goes red and blocks nothing.**
- **Where next:** finishing a cell walks *forwards* from it; picking a run up in a
  new sitting goes to the first hole in the grid.
- **The open routine is a file**, rewritten after every cell, because Live
  reloads the page on every Ctrl+S. At most one per song, enforced by the route
  rather than the page — the page is the thing that keeps being reloaded.
- **Two grades of epoch break.** Sections moved → the grid is a different shape
  and the routine cannot be resumed at all. Chart edited → the run carries on,
  each fill records the chart it was graded against, and sealing across two marks
  the routine `mixed`.
- **Sealing** refuses a routine with holes and records the date span.
  **Discarding** deletes the run and never the takes.

### The two oldest takes are the proof of the format

`songs/hayley-williams-kill-me-official-visualizer/takes/` holds the first two
takes played on the real kit. **Do not delete them** and do not rewrite their
`grade`: they are the evidence that Q8's "store raw timestamps, record the
corrections beside them" decision works. They carry a pre-redetect
`sectionsHash`, no `cell.id` and no `referenceMs` — all exactly right, because a
take is never rewritten and every one of those fields is optional for that
reason.

---

## 3. Where the build now departs from the plan, and why

**Q11 said score-as-heatmap plus a per-limb timing strip. Q14 said two lines per
cell.** Both were right about what is measurable and wrong about what is legible.
Played against the real kit, the report was five notehead colours plus a legend,
a totals line and a six-by-four table — twenty-four numbers, none of which said
whether the take was good or what to go and play again. The user's verdict was
that they could not read it, and that is the only verdict that matters here.

What it is now:

- **Three dials** — `Notes` (accuracy), `Steady` (spread), `Feel` (where you sit,
  as a needle). Each answers one question; they are never blended into a score.
  Mean and spread stay apart for Q7's original reason.
- **A bar strip** — one block per bar of the cell, coloured by whether the notes
  landed, click one to put the cursor there.
- **Three notehead colours, not five.** Colour answers *did the note happen*;
  *when* it happened is a quantity and is shown as one. Hue has no direction, so
  the early/late split was a decode step on every take.
- **The old table survives** behind a `the numbers` toggle.
- **The history is one line per section**, not per cell: 44 sparklines is not
  something anyone reads, and a section is the unit you think in.

**The reference floor is applied, not just reported.** This reverses a decision
M1 left deliberately open. `drums reference` writes `reference.lock.json`, pinned
to the chart hash, and `grade.ts` subtracts it alongside the calibration before
matching — so zero on the Feel dial means "where the record sits". It is one
number for the whole kit, which is a real simplification: only kick and snare are
measurable, and Song 2's kick is +10.7 while its snare is −1.3. The per-instrument
split is in the lock for a later version to use without re-measuring.

**The progress line is a rolling median of three.** What makes the grid honest —
counting your last take, not your best — makes a raw series jumpy, where one good
run makes the next look like a regression. The median keeps the trend and drops a
single outlier either way.

---

## 4. What is left

**The rest of M3.** The take-vs-take overlay (Q14). The per-cell trend lines it
also asked for were built on 2026-09-19, when the grid shrank to four cells and
four sparklines became a reading rather than a wall.

**M4, the coach.** Two halves that do not belong together:
- **Step-by-step** (Q12) — transport paused, the cursor waits for you to play the
  next note. No scoring, no take, no calibration. Nearer to a play-along feature
  than a coaching one, and buildable on its own.
- **Exercises** (Q13) — **both halves are built** (2026-09-19). An exercise is a
  few bars looped with a bar of click between the reps and graded every time
  round; drills fill its own tempo ladder and touch no routine cell. The
  constructible grid Q13 called the largest structural consequence **arrived and
  was small**: `syntheticGrid` in `syncpoints.ts`, because everything already
  goes through `slotToMixMs` and `barStartMs`. An exercise now carries its own
  notes (`version: 2`, `ExerciseChart`) and plays with no song loaded, on
  `TimerClock` and a bank of samples (`kit.ts`). What an agent writing exercises
  needs is the file format (`app/src/exercise.ts`) and `POST /practice/exercise`
  — and note it can now write the **notes** too, as a `chart` of re-based
  `ChartHit`s rather than as alphaTex, which retires the heredoc hazard.

**M5, the artifact.** Take → `.mid` warped onto the straight grid for Ableton
(small, all the machinery exists); phone-video alignment by onset-envelope
correlation against the take's MIDI (new — the existing `drums align` correlates
waveforms, which will not work on stick-on-mesh against an SD3 render); the
export itself.

**M6, the avatar.** Three.js sticks over a top-down kit, driven by the sticking
lock. Explicitly last.

**Small and unscheduled, but wanted:** the user has said the thing they actually
value is playing along with the notation at different tempos. **Bigger notes**
(2026-09-16) and **the loop** are done — and the loop is no longer only a drill:
Play on an armed exercise loops it with no MIDI and no dev server (2026-09-19).
What is left of that list is a **tempo ramp** across a drill's reps — the loop
and the ladder both exist now, so it is a small thing on top of them — and a
**count-in on a paused start**, which is still only inside a run.

**The avatar's input already exists.** `Kit.onNote` (`app/src/kit.ts`) fires per
note as it is booked, carrying instrument, limb, velocity and the AudioContext
time it will sound at — which is exactly what avatar-plan B1 asks for, and it is
handed the whole part up front rather than as a stream. Whoever builds M6
subscribes to `mixer.onNote` and needs nothing else from the transport.

---

## 5. Ground rules carried into this work

- **Concepts get explained plainly.** The reader is a drummer, not a DSP
  engineer; define jargon at first use.
- **The user knows the songs.** Measurements from a recording are not ground
  truth about what was played.
- **Write commit messages out; the user stages and commits.**
- `README.md` "Where things stand" is the authoritative status log, written as a
  running narrative with a "things learned" list per step. Keep it updated as
  part of the work, not afterwards.
