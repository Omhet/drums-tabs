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
at a time, resumable across sittings and sealed by hand.

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
kit.toml [input]       what your module sends (NOT the chart's numbering)
pipeline/reference.py  measures the floor, writes reference.lock.json
songs/<slug>/routines/ the runs. The open one has `sealedAt: null`.
```

### Checks

From `app/`, with `npm run dev` running in its own terminal:

```
npm run smoke · check-sync · check-mix · check-ui out.png · check-practice
npm test                                   # scorer + chart + routine, 67, no browser
.venv/Scripts/python -m pytest -q tests    # 110, no browser
cd app && npm run typecheck
```

**Known-good as of 2026-09-16:** 110 pytest, 67 node tests, clean typecheck, and
every browser check on all three songs. Run the important ones once per song
(`SONG=<slug>`).

Gotchas, all previously bitten: the checks need **real Chrome or Edge** (bundled
Chromium has no H.264); the Ableton plugin reloads the page on every `.als` save,
so a page loaded mid-reload can look broken; and **never write alphaTex or other
backslash-heavy content through a shell heredoc** — use an editor tool.

### The songs

| slug | bars | BPM | cells | floor |
|---|---|---|---|---|
| `hayley-williams-kill-me-official-visualizer` | 62 | 90.9 | 44 | +12.7 ms |
| `blur-song-2-official-music-video` | 64 | 130.4 | 32 | +6.2 ms |
| `hayley-williams-kill-me-drum-cover` | 62 | 90.9 | — | — |

The cover is the original video-bound song and has no sections; it is kept
because `VideoClock`'s two-timeline conversion is what M5 needs.

**Song 2's Live set lives in the Kill Me project folder.** It was saved there,
and moving a `.als` out of its Ableton project by hand breaks its sample links,
so `[author]` points at where it actually is. Each song watches its own set by
filename, so two in one folder do not collide. Moving it properly means *Save As*
from inside Live, then updating the path.

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

### What the user still owes the work

1. **Play a run on Song 2 and seal it.** Nothing has been sealed yet on either
   song, so the trend column has never appeared outside a headless check. It
   needs one sealed run to show anything and three to start smoothing.
2. **Check the section names** on both songs against how you hear the songs.
   Renaming is free until a run worth keeping is sealed: it changes
   `sectionsHash`, which starts a new epoch, and old runs then leave the line.
3. **Check the module's hi-hat offset** (parked). Closed only registers under
   heavy pressure, which is either a miscalibrated offset or honest reporting of
   a loose-hat style. The Monitor tells them apart: press to what *you* call
   closed and see whether note 42 or 46 comes out. Nothing depends on the
   outcome — `[input]` maps both and takes re-grade from raw stamps.
4. **Read the R/L letters** and tune `kit.toml` if they are not what they would
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

**The rest of M3.** Per-cell trend lines and the take-vs-take overlay (Q14).
Worth doing only if the per-section lines turn out to be too coarse in use —
check that before building it.

**M4, the coach.** Two halves that do not belong together:
- **Step-by-step** (Q12) — transport paused, the cursor waits for you to play the
  next note. No scoring, no take, no calibration. Nearer to a play-along feature
  than a coaching one, and buildable on its own.
- **Exercises** (Q13) — excerpt or agent-generated alphaTex. The structural cost
  is that `grid` must become an interface with two implementations, because
  generated notation has no recording and so no measured beats.

**M5, the artifact.** Take → `.mid` warped onto the straight grid for Ableton
(small, all the machinery exists); phone-video alignment by onset-envelope
correlation against the take's MIDI (new — the existing `drums align` correlates
waveforms, which will not work on stick-on-mesh against an SD3 render); the
export itself.

**M6, the avatar.** Three.js sticks over a top-down kit, driven by the sticking
lock. Explicitly last.

**Small and unscheduled, but wanted:** the user has said the thing they actually
value is playing along with the notation at different tempos. Against that, the
highest-value unbuilt things are **a loop** (mark two bars, repeat them), a
**tempo ramp** on that loop, **bigger notes**, and a **count-in on a paused
start**. None are in the plan; all serve the stated need better than M4 does.

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
