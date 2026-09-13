# Practice mode — requirements interview (COMPLETE)

Started 2026-09-12, finished 2026-09-13 over five rounds and nineteen questions.
**The frontier is empty: every open decision has been answered.**

**The method** (the "grill me" skill): map the work as a design tree. Each round asks
every question whose prerequisites are already settled — the *frontier* — with a
recommended answer for each. The user's answers push the frontier outward and unblock
the next round. The interview is done when the frontier is empty. **Nothing gets built
until the user confirms shared understanding.**

**What this file is now.** §4 is the settled design at a glance; §5–§9 are the nineteen
decisions with their reasoning and their consequences; §3 is the codebase as it stood
before any of this was built. It is a requirements document, not an implementation plan:
the milestones in Q19 are the *order*, not the steps.

**Open items that are not decisions** — three five-minute checks and two facts about the
machine, all in §10. None of them can change an answer above; they can only change
whether a recommended technique survives contact with the hardware.

**To pick this up:** open Claude Code in this repo and say

> Read `practice-plan.md`. The interview is complete — let's start M0.

---

## 1. The vision, as stated

Verbatim intent from the user, reorganised but not reinterpreted:

- The **original song** is the practice material. Drum-cover videos by other people are
  **only a writing aid** for authoring MIDI in Ableton — they play imperfectly and make
  mistakes, so they are not a reference for what is correct.
- Break a song into **sections** to learn one at a time.
- The song exists at **several tempos** — 70%, 80%, 90%, 100% — and you record your
  playing at each.
- Playing is **recorded as MIDI** while you play (e-kit into Ableton, Superior Drummer
  making the sound).
- The recording is **assessed for accuracy**, and mistakes are **shown visually** — a
  comparison of your MIDI against the reference — legible both to you and to an AI agent,
  so both can see which parts are weak.
- From that assessment the AI builds a **personalised lesson**: exercises grouped by
  theme, ordered easy → hard, each with generated tabs. Doing the exercises should
  measurably improve your playing of the song.
- Then you **run the routine again** and compare against the previous run. There is a
  **history of runs** so progress is visible.
- You decide **after** finishing a routine whether to save and analyse it. **Incomplete
  play-throughs are never saved or analysed.**
- Every tab has a **step-by-step mode** to help learn the notes.
- **The final artifact for any song**: a recording of yourself playing it at original
  tempo with a high accuracy score. The flow should be: start a phone video and the
  app's recording at the same time, play, then press a button in the app to **copy the
  MIDI into Ableton**; because you played through Superior Drummer you now have correct
  MIDI and can export the take as an audio file. Later you upload the phone video and
  that audio back into the app, the app **syncs them automatically** and overlays the
  tabs — giving you your own cover with notation, kept as history and proof you learned
  the song, and **exportable as a video** to share.

## 2. Where this lands against what already exists

Most of this was already designed once. `git show transcriber:player-plan.md` contains:

- **Phase 6 — practice modes.** A/B bar loop, count-in, tempo ramp, section navigation.
  *"the single highest learning-value phase after the player itself, and it is mostly UI
  over machinery you already have."*
- **Phase 7 — MP4 export with notation baked in.** Playwright frame-stepping the player
  plus ffmpeg/NVENC. Explicitly notes the same machinery serves *"drop a video of me
  playing and overlay the notes"*, and that attaching your own covers is *"just a
  `covers/` subdir per song with a date, which also gives you the progress history."*
- **Phase 9 — play assessment and learn mode.** *"Your e-kit makes this cheap: **Web
  MIDI**, not audio detection. Compare incoming note+timestamp against the reference
  notes the player already schedules... score per limb and per section... Step-by-step
  mode is the same comparison with the transport paused."*

So the vision is largely a recommitment to an existing design, with one genuine
departure: **the practice backing changes from the cover video to the original track.**

## 3. Facts established from the codebase (do not re-explore)

### Shape of the repo

Two halves, no shared runtime. `app/` is a Vite + TypeScript browser player with **no
framework** (plain DOM, one screen). `pipeline/` is a Python CLI (`drums`, Typer, run via
`uv`) that prepares song assets. There is **no application server** — only two Vite
dev/preview plugins. Tracked source is ~6,100 lines across 48 files. One song exists:
`songs/hayley-williams-kill-me-drum-cover/`.

### The per-song contract

```
songs/<slug>/
  song.toml          tracked — identity, [author] Ableton pointer, [midi_map]
  grid.lock.json     tracked — the beat map (the keystone)
  tab.mid            tracked — hand-authored notation, constant tempo
  analysis/raw.beats tracked
  audio/mix.wav      untracked — the timeline everything refers to
  audio/video.mp4    untracked — the cover video (the app's clock + picture)
  stems/{drums,nodrums}.wav              untracked — the two mixer stems
  stems/straight-*.wav, straight.json    untracked — tempo-straightened, for DAW authoring
  debug/*                                untracked
```

`.gitignore` drops `songs/*/audio/`, `songs/*/stems/`, `*.wav`, `*.mp4`, `debug/`. The
only tracked binary is `tab.mid` (~5 KB). `.git` is 4.6 MB; `songs/` is 283 MB on disk.

### The architecture that matters for this work

- **alphaTab 1.8.4 in `PlayerMode.EnabledExternalMedia`.** alphaTab makes no sound and
  keeps no time — it only draws notation and a cursor, and issues play/pause/seek/rate to
  a handler we own. This is what makes everything below possible.
- **The `<video>` element is the master clock.** `VideoClock` in `app/src/media.ts`
  implements `IExternalMediaHandler`, pushes smoothed positions into alphaTab on rAF, and
  converts between **video time** and **mix time** via `video_offset_ms` (36.28 ms for the
  one song, measured by `drums align`).
- **`grid.lock.json` is a measured per-beat time map** — `beats: number[]`, absolute
  seconds into the mix of every played beat, plus meter, `bar_one_beat`, `count_in_bars`,
  `bar_count`, `video_offset_ms`. It is the tempo map; there is no tempo curve in the
  notation.
- **Notation is time-aligned by sync points, not a formula.** `app/src/syncpoints.ts`
  emits one `FlatSyncPoint` per played beat (`barIndex`, fractional `barPosition`,
  absolute ms) and `score.applyFlatSyncPoints()` runs *before* `renderScore`. alphaTab
  interpolates between them, so a drummer who drifts is tracked bar by bar.
- **The written tempo is a fiction.** `syncSafeTempo()` picks the nearest tempo that
  divides 60000 (96 for this song, real tempo 90.91) because alphaTab truncates beat
  durations to whole ms; the tempo marking is hidden from the page.
- **Audio is one Web Audio graph** (`app/src/mixer.ts`): video + two stem `<audio>`
  elements through gains into a master. Stems chase `clock.mixTimeMs` on a 25 ms
  `setInterval` (not rAF, so it survives a background tab) with hysteresis — hard seek
  above 250 ms, a 1–3% rate nudge between 20 and 250 ms, exact rate under 10 ms.
- **Tempo control already works.** A slider drives `api.playbackSpeed` (never the element
  directly), alphaTab forwards it to `VideoClock` → `video.playbackRate`, the mixer
  mirrors it onto each stem, and `preservesPitch = true` is set on all three. **25–125%
  is already reachable today.**
- **The click is a lookahead scheduler** (`app/src/click.ts`) reading `grid.beats`
  directly, booking sine blips 100 ms ahead and scaling correctly with playback rate.
- **`ScoreWindow`** (`app/src/score-window.ts`) clips the score to N rows over the bottom
  of the video and keeps the cursor's row on top, driven by `playerPositionChanged` (not
  `playedBeatChanged`, which only fires while playing).

### The chart and where it comes from

Chain: **Ableton `.als` → `tab.mid` → alphaTex → alphaTab `Score`**.

- `app/plugins/ableton.ts` (Vite plugin, 282 lines) watches the `.als` named in
  `song.toml [author]`, gunzips it, walks the arrangement (expanding looped clips), and
  writes `songs/<slug>/tab.mid` — format 0, 480 PPQ, channel 9 — only when bytes change,
  then triggers a page reload. **Every Ctrl+S in Ableton regenerates the notation.**
- `app/src/midi-tab.ts` converts `tab.mid` → alphaTex in the browser. Internal unit is a
  **16th-note slot counted from bar 1** (`SLOTS_PER_BEAT = 4`). Feet (`kick`,
  `hihat_pedal`) go to voice 1, everything else voice 0.
- Vocabulary is 11 articulations: kick, snare, hihat closed/open/pedal, tom high/mid/floor,
  crash, crash2, ride. **Not modelled:** ghosts, accents, flams, rimshots, sidestick, ride
  bell, china, splash, chokes.
- **Velocity is written into `tab.mid` (`ableton.ts:124`) and then discarded** —
  `midi-tab.ts` only tests `velocity !== 0`, and `\hidedynamics` is emitted
  unconditionally. The archived `score.json` format *did* carry per-hit velocity.
- The MIDI-key → instrument map is per song, in `song.toml [midi_map]`.

### Live MIDI / recording: none of it exists

A repo-wide search for `requestMIDIAccess`, `MIDIAccess`, `onmidimessage`, `getUserMedia`,
`MediaRecorder`, `createMediaStreamSource`, `AudioWorklet` returns **zero matches**. All
MIDI in the repo is file-based and offline. This is greenfield.

Natural seams for it: the `Mixer`'s `AudioContext`, `VideoClock.mixTimeMs` as the shared
timeline to stamp incoming events against, and the hit list already extracted in
`midiToAlphaTex` (`midi-tab.ts:137-156`, slot + instrument) as the expected notes.

### Pipeline commands that already exist

`drums doctor | fetch | separate | beats | grid | audit | align | straighten | prep | songs | models`

- `drums prep <url>` chains fetch → separate → beats → grid → audit.
- `drums align <slug>` cross-correlates the video's soundtrack against `mix.wav` in five
  20 s windows and pins `video_offset_ms`. **This is already "the app syncs them
  automatically"** for the final-artifact flow — it refuses if correlation is poor or the
  spread exceeds 5 ms.
- `drums straighten <slug>` warps stems onto a constant grid (Ableton "Re-Pitch" style) so
  a DAW's bars line up with the song's bars, for authoring.
- Invariant repeated across the pipeline: **never trim audio, only offset.**

### Testing

`tests/` — 47 pytest functions, pure arithmetic, no audio/GPU. `app/scripts/*.mjs` —
Playwright checks needing `npm run dev` on :5173 and **real Chrome or Edge** (bundled
Chromium has no H.264/AAC). `check-sync.mjs` asserts the bar↔time round trip both
directions for every bar within 15 ms; `check-mix.mjs` asserts stem drift at 100% and 50%.
No TypeScript unit tests; `npm run typecheck` is the static check. Nothing is wired to CI.

### Roadmap as it stands in README.md

First milestone complete. Candidates listed, none started: a loop (two keys marking start
and end bar), bigger notes (`display.scale` + a Zoom control), and a count-in on a paused
start.

---

## 4. Design tree — status

```
SETTLED (Round 1)
├── Backing material .......... original track; video slot kept for YOUR cover
├── MIDI path ................. Windows MIDI Services (multi-client), to be verified
├── Sections .................. detected from repeats in the chart
└── Assessment ................ deterministic scoring + Claude Code agent as coach

SETTLED (Round 2)
├── Routine shape ............. fixed cell grid, walked section-major, gate is a signal
├── Completeness .............. every cell filled or the routine cannot be saved
├── Hit contract .............. two-stage window; grade notes + timing; capture velocity
└── Take format ............... MIDI events only, git-tracked JSON per take

SETTLED (Round 3)
├── Calibration ............... tap-to-click, median of N, per machine, untracked
├── Sittings .................. routines resume across days, sealed by hand, span recorded
├── Mistake display ........... score-as-heatmap + per-limb mean/spread strip
└── Step-by-step .............. note gate, chord-aware, correctness only

SETTLED (Round 4)
├── Exercises ................. one descriptor, two sources (excerpt | generated alphaTex)
├── Comparison ............... the cell is the unit; epochs break the line
├── Ableton handoff .......... .mid written to disk, warped onto the straight grid
└── Sections ................. `drums sections` proposes, song.toml freezes

SETTLED (Round 5)
├── Cover sync ............... onset-envelope correlation vs take MIDI (headphones + e-kit)
├── Export mix ............... nodrums stem + your SD3 bounce, faders exposed
└── Build order ............. pivot, then one thin vertical slice, then widen

PARKED (needs a five-minute listening test, blocks nothing)
└── Q6 tempo ladder ........... browser playbackRate vs pre-rendered stems

FRONTIER: empty. The interview is complete.
```

### The design in one paragraph

You practise against the **original track**, not a cover. The app breaks the song into
**sections frozen in `song.toml`**, and a **routine** is a fixed grid of *(section × tempo)*
cells — identical every run, so runs are comparable — walked section-major, ending on the
full song at 100%. You play an **e-kit into Ableton**, Superior Drummer makes the sound, and
the browser reads the same MIDI stream. Every hit is matched to the chart in **two stages** —
a tempo-relative window decides *which note you meant*, raw milliseconds decide *how tight you
were* — after subtracting a **tap-to-click calibration offset**, and mean and spread are always
reported separately so latency never masquerades as sloppiness. Each attempt is a **git-tracked
JSON take** of raw MIDI events pinned to a **chart hash and a sections hash**, so history can
never silently re-grade itself. Mistakes appear as a **coloured score plus a per-limb timing
strip**. When the routine is sealed, a **Claude Code agent reads the takes off disk** and writes
**exercises** — song excerpts or generated alphaTex — and you run the routine again and watch
**per-cell trend lines**. When you can play it at 100%, the take's MIDI is **written back out to
Ableton on the straight grid**, SD3 renders it, your phone video is **aligned by onset-envelope
correlation against your own note times**, and the app exports a **cover with notation overlaid,
your drums in place of theirs.**

---

## 5. Round 1 — asked and answered

### Q1 — What plays while you practise, and what happens to the video slot?

Today `songs/<slug>/` is built around a YouTube drum cover: the video is the clock, its
soundtrack is `mix.wav`, the stems are separated from it, and `grid.lock.json` holds that
drummer's real drifting beat times (90.91 BPM, ~1% drift — which is why `straighten.py`
exists). `tab.mid` was authored against a straightened render of that cover.

**Answer: (a) — pivot to the original track, keep the video slot and re-point it.**

`drums prep` the official audio; stems and grid come from the original; the cover video
stays outside the repo as something watched in Ableton while writing MIDI. There is no
video in the player for now, so the master clock moves from `<video>` to an `<audio>`
element (or the stems), and notation goes full-screen.

Generalise "the video" into "a video bound to this timeline" — today none, at the end
*yours*. The `#score-box`-over-video work and `VideoClock`'s two-timeline conversion are
then reused verbatim for the final artifact rather than thrown away. This is the `covers/`
subdir the archived plan already proposed.

**Consequence to remember:** studio originals are usually click-locked, so the grid
becomes near-constant-tempo. `straighten` becomes nearly a no-op, bar↔time maths gets
exact, and the 70/80/90/100% ladder becomes honest instead of "70% of a drifting tempo."

### Q2 — How do your hits reach the browser while Superior Drummer makes the sound?

The constraint: Ableton must hold the MIDI input (so SD3 makes the sound you play to) and
the browser must read the same stream (so it can score you). On Windows a class-compliant
USB-MIDI port under the legacy WinMM stack is **single-client** — whoever opens it first
locks the other out.

**Answer: Windows MIDI Services** — the new multi-client MIDI stack in Win11, so Chrome
and Ableton open the same port natively with no hops.

**Caveat that must be tested before anything is built on it:** Chrome's Web MIDI still
talks to the legacy stack, so what matters is whether the multi-client compatibility shim
covers the specific drum module. **This is a five-minute test, not a research project:**
open Ableton with the module as input, then open a Web MIDI test page in Chrome, and see
whether both receive hits simultaneously.

**Documented fallback if it doesn't:** loopMIDI (free) — module → Ableton → a MIDI track
routed out to a loopMIDI port → Chrome reads that port. One extra hop, ~1–3 ms, constant
and calibratable.

Separate but related, and part of the design from day one: what you *hear* is delayed by
the monitoring chain (module → Ableton → SD3 → ASIO out) and you naturally play to what
you hear, so a **one-time latency calibration offset** is required.

### Q3 — Where do sections and exercises live, structurally?

**Answer: detect sections from repeats in the chart** (`tab.mid` pattern detection), not
hand-written and not audio structure detection.

**Consequence stated and accepted:** repeat detection finds *pattern boundaries*, not
*musical structure*. It will say "bars 15–22 repeat at 42–49" and call them A and B; it
will never know one is a verse and the other the last chorus. A `[[section]]` override in
`song.toml` for renaming and nudging boundaries is assumed to be part of the design —
**flag this if full automation was intended instead.**

### Q4 — Who does the assessing, and where does "AI" actually sit?

**Answer: deterministic scoring + Claude Code agent as coach.** Three separated layers:

1. **Alignment + scoring** — plain code in the app. Match each recorded hit to a reference
   hit per limb within a window, emit `{expected, actual, deltaMs, verdict}` where verdict
   is hit / missed / extra / wrong-voice / flam. **No AI belongs here.** Everything else
   is downstream of this being exactly right.
2. **The take report** — a JSON artifact per attempt on disk, plus the in-app view.
3. **The coaching** — a Claude Code agent reads `takes/` off disk and writes `exercises/`
   and a lesson plan.

**The crucial consequence: the take report format is the most important thing designed in
this whole project.** It is read by the user, by the UI, and by an agent. Get it right and
everything else is replaceable. Moving coaching to an in-app API call later is then a
small change, not a rewrite.

---

## 6. Round 2 — asked and answered

### Q5 — What exactly is one "routine", and what makes it complete?

The tension: the vision wants *"go through the play routine again and compare results with
the previous one"*, and **comparison only works if the routine is a fixed, identical set of
cells every time.** Adaptive gating makes every run a different shape, so run 3 and run 4
stop being comparable and the progress history becomes noise.

**Answer: (a) — fixed grid, walked section-major, accuracy gate as a signal not a gate.**

- A song's routine is a **defined, unchanging set of cells**: every section at
  70/80/90/100%, plus the full song at every tempo. Identical every run, forever.
- **Walked section-major**: section 1 at 70/80/90/100, then section 2 at 70/80/90/100.
- A cell below threshold goes **red** and the coach sees it; **it does not block you**.
- **Complete = every cell has one take played to the end.** Abandoning a cell discards that
  take silently and leaves the cell unfilled; a routine with unfilled cells cannot be saved.
- **The full song at 100% is the last cell of every routine** — the final artifact is not a
  separate feature, it is the last thing done on every run.
- Any cell can be retried freely within a run, and **the last complete take counts, not the
  best** — "best" lets you farm a lucky take and corrupts the progress line.

**Consequence 1 — section boundaries must freeze.** The cell set is derived from the
sections, and the sections come from repeat detection (Q3). If detection is re-run and
proposes different boundaries, **the grid changes shape and the entire progress history
becomes incomparable.** So detection is a *seeding* step, not a runtime step: the accepted
sections get written into `song.toml` as tracked data and that is the source of truth from
then on. The `[[section]]` block is promoted from "override" to "the definition". Changing
it deliberately starts a **new comparison epoch** — old routines stay readable but are not
plotted on the same line.

**Consequence 2 — the routine is big.** A 5-section song is 5×4 + 4 = **24 cells**, each a
take played to the end, plus retries. That is a 45–90 minute sitting. Combined with "a
routine with unfilled cells cannot be saved", this raises a question the answer does not
settle on its own → **Q10 below.**

**Consequence 3 — "played to the end" needs a definition** at implementation time: a cell's
take is complete when the transport reaches the last bar of the cell's range, not when you
stop hitting things. Pausing mid-cell and resuming is the open edge case; assumed allowed,
assumed recorded as one take with the pause in it, **flag if that is wrong.**

### Q6 — How are the 70/80/90% versions of the original produced?

**Answer: parked pending a listening test.** Nothing downstream is blocked by it.

The test, which only the user can judge and which needs no new code: open the app, drag
the tempo slider to 70% and 80% on a real mix, and listen for smearing. Chrome's built-in
time-stretch (WSOLA) is already wired up with `preservesPitch = true`, so **(a) browser
`playbackRate` works today at zero cost**. The archived plan flagged exactly this as
risk #1 — *"WSOLA quality at 0.5–0.7×"* — and it appears never to have been answered.

If the ears say no, fallback is **(b) a `drums ladder <slug>` pipeline step** writing
`stems/70/*.wav` etc. with a proper phase vocoder: better quality, ~850 MB more per song
on top of the current 283 MB, a pipeline run per song, and tempo switching then costs a
reload and reseek.

Worth remembering during the test: **the click is what actually holds you together at 70%
anyway**, and `app/src/click.ts` already scales correctly with rate.

### Q7 — What counts as a correct hit?

**Answer: (a) — two-stage window, grade notes and timing, capture velocity ungraded.**

**1. The match window — two stages, because either alone fails.**

- **Stage 1 (tempo-relative) decides *which note you were aiming at*.** The window is half
  the distance to the neighbouring reference note, capped. This widens as you slow down,
  which is correct for note assignment.
- **Stage 2 (raw milliseconds) decides *how tight you were*.** The error against the
  assigned note is measured in real milliseconds and is not scaled by tempo.

Fixed-only mis-assigns notes at slow tempos and invents phantom misses and extras;
relative-only scores a sloppy 70% take as accurate because the window widened with it.

**2. What gets graded: note accuracy and timing, per limb.** Right voice, no misses, no
extras; mean offset and spread. **Velocity is captured in every take from day one but not
graded.** `tab.mid` already carries velocity from Ableton and `midi-tab.ts` throws it away;
grading dynamics needs *honest* authored velocities in Live, a discipline not yet adopted —
but recording your own velocities costs nothing and **cannot be recovered retroactively.**

**3. Mean and standard deviation are always reported separately, and calibrated latency is
always subtracted first.** Playing 20 ms consistently late is a **calibration artifact**;
playing ±20 ms randomly is a **playing problem**. Same number, opposite diagnoses. Without
this separation the coach will spend your life telling you to "play on top of the beat"
when the audio interface is the problem.

➡️ This makes the calibration number load-bearing for every score in the system → **Q9.**

### Q8 — What's in a take, and where does it live?

**Answer: (a) — MIDI events only, one git-tracked JSON per take under
`songs/<slug>/takes/`.**

```jsonc
{ "cell": { "section": "B", "tempo": 0.8 },
  "startedAt": "2026-09-12T18:04:11Z",
  "calibrationMs": 12.4,
  "chartHash": "<sha256 of tab.mid>",
  "events": [ { "tMs": 1203.4, "note": 38, "velocity": 96 } ],
  "grade": { "perVoice": {}, "timing": {}, "missed": 0, "extra": 0 } }
```

Tens of kilobytes per take. Audio is always regenerable from MIDI + SD3, so storing it is
waste. Git-tracking gives the entire progress history with **zero storage code written**,
and gives the coaching agent something it reads directly off disk.

**`chartHash` is not optional.** You will fix the chart in Ableton after a bad take reveals
you wrote a fill wrong — and when you do, every historical take must keep its original
grade rather than silently re-grading against a chart that did not exist when you played.
Without it the progress history quietly lies to you.

**Consequences to carry forward:**

- `events[].tMs` needs a stated origin. Assumed: **mix time**, the same timeline
  `VideoClock.mixTimeMs` already exposes, so a take is directly comparable to `grid.beats`
  and to the chart without a second conversion. Raw, *uncorrected* timestamps are stored
  and `calibrationMs` is recorded alongside — so the correction can be re-applied or
  revised later without losing the original measurement.
- Takes are stored **at the tempo they were played**, not normalised to 100%. Normalising
  would destroy the distinction Q7 stage 2 exists to preserve.
- `.gitignore` currently drops `songs/*/audio/` and `songs/*/stems/` but nothing would
  exclude `takes/` — good, but it means take JSON churn lands in a repo whose `.git` is
  currently 4.6 MB. At tens of KB × 24 cells × N runs this is fine for years.
- Sections are named in `cell.section`, so **the section identity in `song.toml` must be
  stable** — the same freeze Q5 consequence 1 requires.

---

## 7. Round 3 — asked and answered

### Q9 — What is the latency calibration ritual?

Q7 made this number load-bearing: every timing score in the system is
`played − reference − calibrationMs`. Get it wrong by 15 ms and every take in the history
is wrong by 15 ms in the same direction, and the coach reads it as a playing flaw.

What is actually being measured is not the machine's latency — it is **your compensation**.
You play to what you hear, and what you hear is delayed by module → Ableton → SD3 → ASIO
(plus a loopMIDI hop if Q2's fallback is used). The offset that matters is the one that
zeroes your median error against a source you trust.

**Answer: (a) — tap-to-click, median of N.**

The app plays a bare click at 100%, you play steady quarter notes on one pad for ~8 bars,
and it takes the **median** offset — median, not mean, so one flubbed hit cannot move it.
Stored in an untracked per-machine file; each take stamps the value it used into
`calibrationMs`. Re-run when the interface or buffer size changes, and the app nags if a
take's mean offset drifts more than ~10 ms from the stored value. It reuses the click
scheduler that already exists and takes fifteen seconds.

**Rejected and worth remembering why:** per-take auto-subtraction (subtract each take's own
mean) needs no ritual at all, and makes systematic lateness mathematically invisible —
every take scores as perfectly centred no matter how late you played. It destroys exactly
the mean-vs-spread distinction Q7 was answered to preserve. **Acoustic loopback** (record
SD3's output through `getUserMedia`, cross-correlate against the MIDI timestamps) is the
honest upgrade if tap-to-click proves unstable between sessions.

**Consequences:**

- Calibration is **per machine, per input path** — not a property of the song or the user.
  Untracked local state. A take played on a different machine stays comparable because it
  stamped its own number.
- The ritual needs a **click that is not tied to a song**, or at least a song-independent
  entry point into `app/src/click.ts`, which today reads `grid.beats` from a loaded song.
  Small, but it is the first thing that will need writing.
- **The pad used matters and should be recorded.** Latency is per input path, and a mesh
  snare and a rubber kick trigger do not necessarily report at the same moment. Assumed: one
  calibration value covering the whole module, measured on the snare. **Flag if per-pad
  calibration is wanted** — the data supports it later, since takes store raw timestamps.
- Because Q8 stores **uncorrected** timestamps, a calibration discovered to be wrong can be
  revised and old takes re-graded. The number is fixable; the measurement is not.

### Q10 — Can a routine span sittings?

Q5 consequence 2: a 5-section song is 24 cells, 45–90 minutes, and **a routine with
unfilled cells cannot be saved.** So today's answer implies "finish it all tonight or lose
the evening", which will not survive contact with real life.

**Answer: (a) — resumable, sealed manually. Record, don't enforce.**

An in-progress routine is a record on disk; you fill cells across days; **"finish routine"
seals it** and it enters the history. The routine records its **date span**, so a run spread
over a week is *visible* next to its score rather than forbidden. The rule "no incomplete
routine is analysed" is about not grading a half-played song, not about stopwatch
discipline. An expiry was rejected: it adds a config knob and an awkward "your routine went
stale" moment, and destroys work that resumability would have kept.

**Consequences:**

- **At most one routine is in progress per song at a time.** Starting a fresh one while
  another is open asks you to seal or discard the old one.
- **An in-progress routine is now persistent state that must survive a page reload** — and
  the Ableton watch plugin reloads the page on every Ctrl+S. So the open routine is a file
  on disk, written after every completed cell, not in-memory state.
- **It also must survive a chart edit,** which is the nastier case: Q8 pins every take to a
  `chartHash`, so editing the chart mid-routine leaves an open routine whose filled cells
  were graded against a chart that no longer exists. Proposed rule, **flag if wrong:** the
  routine records the `chartHash` it opened with; a chart edit mid-routine warns you, and
  sealing a routine whose cells span more than one hash marks it **mixed** and keeps it out
  of the comparison line.
- Where it lives: `songs/<slug>/routines/` alongside `takes/`, tracked, with the open one
  distinguished by a `sealedAt: null`.

### Q11 — How are mistakes shown visually?

This is the deliverable the vision names directly — *"mistakes are shown visually, legible
both to you and to an AI agent"*. The agent half is already answered: it reads the take
JSON from Q8. This question is only about the human half.

**Answer: (a) — score-as-heatmap plus a per-limb timing strip.**

Every notated note in the alphaTab render is coloured by verdict — missed, extra, wrong
voice, early, late — and under it a compact per-limb readout of **mean ± spread** plus a
"worst bars" list. You read your mistakes where you read the music. The strip is where
mean-vs-spread lives, which is the one thing a heatmap structurally cannot show: colour per
note cannot display a distribution. A full dual view with a scrubable linked timeline is
the natural later upgrade, not the starting point.

**Consequences:**

- **The verdict vocabulary is now fixed by this display**, and it is the same vocabulary the
  coach groups exercises by (→ Q13). Q4 named hit / missed / extra / wrong-voice / flam;
  this display adds the **early/late split of "hit"**, since a note that landed 40 ms early
  is not the same finding as one that landed on time. Proposed final set:
  `hit` (with signed `deltaMs`), `missed`, `extra`, `wrong-voice`, `flam`.
- **"Extra" notes have no notated position to colour.** They must be drawn somewhere — a
  marker between notes, or on a lane under the staff. Unresolved detail, left to build time.
- **This is the first thing in the project that needs per-note styling in alphaTab.**
  Everything built so far only positions a cursor over a static render. Worth a spike before
  committing: confirm alphaTab 1.8.4 can colour individual notes in
  `PlayerMode.EnabledExternalMedia` and that re-colouring does not force a full re-render.
- **The limb grouping is a new mapping.** The chart has 11 articulations and voices split
  feet/hands (`midi-tab.ts`); a per-limb readout needs articulation → limb, and hi-hat pedal
  vs kick both being "feet" is a decision — assumed **four limbs**, with hi-hat pedal as left
  foot and kick as right foot. **Flag if you play double kick or open-handed.**

### Q12 — What exactly does step-by-step mode do?

The archived plan's one-liner is *"the same comparison with the transport paused"* — true
but underspecified.

**Answer: (a) — note gate, chord-aware, correctness only.**

Transport paused. The cursor sits at the next notated position and waits. You play it — all
simultaneous notes within a small window count as **one chord** — and the cursor advances.
**Correctness only, no timing grade, no tempo, no click.** A wrong voice flashes and does
not advance. **Feet and hands are gated together:** kick and snare on the same slot means
both must land inside the chord window. Call-and-response (the app plays the next bar of the
original, then waits for you to echo it) is the natural follow-on once this exists — it is
nearly free given the app has the audio and the bar boundaries — but it teaches *feel*
rather than the notes, which is a different job.

**Consequences:**

- **This is the only place in the system where MIDI input drives the transport** instead of
  being scored against it. Everywhere else the clock leads and hits are compared to it; here
  hits lead and the cursor follows. That is a genuinely separate mode in the code, not a flag
  on the practice loop — and it means the alphaTab cursor must be movable by
  note index, not just by seeking a time.
- **The chord window is a new tunable with no principled default.** It is *not* Q7's match
  window — nothing is graded here. It only answers "did you mean these together", so it can
  be generous (~50–80 ms) without consequence. One number, not per tempo.
- **Step-by-step produces no take.** It is practice, not measurement: nothing is written to
  `takes/`, nothing enters a routine, nothing is graded. Assumed, and worth stating so the
  routine's "every cell filled" rule cannot be satisfied by stepping through.
- **Rolls and buzz strokes will fight the gate** — a notated single stroke answered by a
  double bounce reads as an extra note. Assumed behaviour: **extra notes are ignored, not
  penalised** — the gate only waits for the right ones to appear. **Flag if the gate should
  be strict.**

---

## 8. Round 4 — asked and answered

### Q13 — What is an exercise, where does it live, and how is it playable?

The vision: *"exercises grouped by theme, ordered easy → hard, each with generated tabs."*
Q4 put the coach outside the app — a Claude Code agent reading `takes/` off disk and writing
`exercises/`. Q11 just fixed the vocabulary it groups by.

**Answer: (a) — one descriptor, two sources.**

An exercise is a small tracked file in `songs/<slug>/exercises/` carrying theme, order,
target tempo range and a pass threshold. Its notation comes from *either* a **song excerpt**
(bars 14–17 of section B, looped) *or* **generated notation** the agent wrote. Both render
through the same alphaTab path and are graded by the same scorer; excerpts play against the
original audio, generated ones against the click alone. The two sources cost one `kind` field
and share everything downstream. **Generated notation is authored as alphaTex, not MIDI** —
human-readable, agent-writable, and the app already renders alphaTex (`midi-tab.ts` exists
only to *reach* alphaTex from Ableton).

**Consequences:**

- **The grid must become constructible, not only loadable.** Everything in the app hangs off
  `grid.lock.json` — a measured array of beat times. A generated exercise has no recording
  and no measured beats, so it needs a **synthesised** grid at constant tempo. That turns
  `grid` from "a file we load" into "an interface with two implementations", and it is the
  single largest structural consequence in Round 4.
- **The click must run song-independently** — the same requirement Q9's calibration ritual
  already created. Good convergence: one piece of work serves both.
- **Exercise attempts are graded but are not routine cells.** Proposed: they write take JSON
  like anything else, tagged `kind: "exercise"`, and are excluded from the routine comparison
  in Q14. **Flag if exercise attempts should not be persisted at all.**
- **Agent-written alphaTex needs validating before it reaches the page** — a syntax error
  renders as a blank score with no useful error. A `drums lint-exercise` or a parse check at
  load time is cheap insurance.
- Standing ground rule (§11) now bites for real: alphaTex is backslash-heavy and must never
  be written through a shell heredoc. The coach agent writes these files.

### Q14 — What is actually compared between two runs?

Q5 bought a fixed cell grid so runs are comparable; Q10 made a run a sealed record. This asks
what the comparison actually *shows*.

**Answer: (a) — the cell is the unit, with the take-vs-take overlay as the drill-down.**

Each sealed routine contributes one score per cell; the history view is a grid of trend
lines, one per cell, with the same red/green threshold colouring as the routine itself. Click
any cell to drill into that take's heatmap, or overlay it against the previous run's note for
note. The cell is already the atom of the routine, so it is the atom of the comparison.
**Comparison respects epochs:** a cell whose `chartHash` changed, or a routine sealed as
**mixed** (Q10), is drawn as a **break in the line** rather than a data point — otherwise the
history lies exactly when you have been most active.

**Consequences:**

- **"One score per cell" is not yet defined, and defining it is a real decision.** Q7 grades
  note accuracy *and* timing, per limb. Collapsing that to a single scalar requires a
  weighting, and any weighting hides which half improved. **Proposed: never blend them.** Two
  lines per cell — *accuracy* (fraction of reference notes hit with the right voice) and
  *timing spread* (ms standard deviation, latency-corrected) — plotted together. Mean offset
  is a calibration diagnostic, not a progress metric, so it is not plotted. **Flag if a
  single headline number is wanted anyway.**
- The red/green threshold from Q5 therefore needs to be **a threshold on accuracy**,
  with spread reported beside it rather than gated on.
- The comparison grid is the first thing in the project that reads **across** takes rather
  than one at a time — an index over `takes/` and `routines/`, cheap while these are tens of
  KB each, worth revisiting if a song ever accumulates thousands.

### Q15 — How does a recorded take get into Ableton?

The vision says *"press a button in the app to copy the MIDI into Ableton"*, so SD3 renders
your take as audio for the final artifact. But the backing plays in the **browser**, not in
Ableton — Ableton's transport is not running with the song, so a take recorded there lands at
an arbitrary place on an unsynchronised timeline.

**Answer: (a) — export a `.mid` warped onto the straight grid.**

The app writes `songs/<slug>/takes/<id>.mid` through a dev-server endpoint — the same trick
`app/plugins/ableton.ts` already uses to write `tab.mid` — with the take's mix-time stamps
warped onto the constant-tempo grid using the existing `stems/straight.json`. Drop it at
bar 1 of the authoring session and it lines up with the straightened audio **and** with
`tab.mid`, because that is the grid the chart was authored on. `straighten` exists,
`straight.json` exists, the file-writing pattern exists: this is reuse, not new machinery.

Worth keeping: **parallel recording in Ableton is still a good safety net**, since Ableton is
already receiving every hit you play. It is not the answer because of *alignment*, not
capture.

**Consequences:**

- **`drums straighten` is promoted from an authoring convenience to a hard dependency** of
  the final artifact. `stems/straight.json` must exist for any song you intend to finish.
  Q1's consequence softens this — a click-locked original makes the warp near-identity — but
  the file must still be there, and the warp must be applied even when it is nearly nothing.
- **The file-writing endpoint only exists in dev.** There is no application server (§3), just
  Vite plugins. So the Ableton handoff, and by extension the final-artifact flow, is a
  **dev-mode-only feature**. Acceptable — this is a single-user tool run from `npm run dev` —
  but it should be a stated limitation rather than a surprise.
- **Note numbers pass straight through.** The app records raw MIDI note numbers; writing them
  back out is the identity. `[midi_map]` is only needed to interpret them as instruments for
  scoring, never to translate them for SD3.
- Two grids now exist per song and code must never confuse them: **mix time** (real, measured,
  what takes and `grid.beats` use) and **straight time** (constant, what Ableton and `tab.mid`
  use). `straight.json` is the only bridge. Name them explicitly in the code.

### Q16 — How do sections get seeded, named and frozen?

Q3 chose repeat detection; Q5 then made section identity load-bearing — change a boundary and
the cell grid changes shape and the history stops being comparable.

**Answer: (a) — `drums sections <slug>` proposes, you edit, `song.toml` freezes.**

A pipeline command runs repeat detection over `tab.mid` and writes `[[section]]` blocks with
placeholder names (A, B, C) and bar ranges. You rename and nudge by hand. From then on **the
file is the truth** and nothing recomputes; re-running needs an explicit flag and bumps the
comparison epoch. This matches how the repo already works — `grid.lock.json` is exactly this
pattern: measured once, then frozen and tracked, hence "lock". A visual section editor is a
good later addition; the `.toml` is enough to start, and you rename A/B/C to verse/chorus
once per song, not continuously.

**Consequences:**

- **Routines must record a `sectionsHash` as well as a `chartHash`.** Q8's hash covers
  `tab.mid`; sections live in `song.toml`, which `tab.mid` knows nothing about. Move a
  boundary and the cell grid changes shape while `chartHash` stays identical — the exact
  silent-lie failure `chartHash` exists to prevent. **Two hashes, or the epoch logic has a
  hole in it.**
- `song.toml` is read today only for `[author]` and `[midi_map]`; the app now needs to read
  `[[section]]` too, and to fail loudly rather than silently when it is absent.
- **Detection runs over `tab.mid`, which the Ableton plugin rewrites on every Ctrl+S.** So
  `drums sections` is explicitly *not* part of that watch loop — it is a deliberate,
  occasional command, like `drums grid`.
- A song with no `[[section]]` block has no routine at all. Proposed: that is a hard error
  with a message telling you to run `drums sections`, not a fallback to "one section, the
  whole song".

---

## 9. Round 5 — asked and answered. **The last round.**

### Q17 — How does your own cover get bound to the song timeline?

**Answer: (b) — align against your own playing, not against the backing, because you record
in headphones. Manual nudge always available. Clap sync held in reserve.**

Two user facts arrived with this answer and both matter:

1. **You record in headphones**, so the backing track is *not* audible in the room. That kills
   the recommended option outright — `drums align` correlates the video's soundtrack against
   `mix.wav`, and there is no `mix.wav` signal in your room to find.
2. **You play an e-kit**, so the room does not sound like a drum kit at all. The phone captures
   sticks on mesh and rubber, pedal mechanics, and whatever leaks from the headphones.

**Consequence — this is not the same correlation, and it should not pretend to be.** Point 2
breaks the technique as much as point 1 does. `drums align` does **waveform cross-correlation**,
which works because it is matching a recording of `mix.wav` against `mix.wav` itself — the same
signal twice. Correlating stick-on-mesh clicks against a Superior Drummer render is matching two
completely different timbres, and waveform correlation will produce mush.

➡️ **What to build instead: onset-envelope correlation against the take MIDI.** Extract an
onset-strength envelope from the phone audio; build the reference envelope **directly from the
take's MIDI note times**, which you already have to the sample. Correlate the two envelopes.
This works *because* of the e-kit rather than despite it: a stick hitting a pad is a sharp, dry
transient with no decay, landing at exactly the instant the note-on was stamped. The reference
side is noise-free by construction, so **the SD3 bounce is not needed for alignment at all** —
it is only needed for the finished audio.

**What is reused and what is new:**

- **Reused:** the five-window structure, the spread check, and the refuse-if-poor behaviour of
  `drums align`. These are the valuable part — they catch phone clock drift and fail loudly
  instead of producing a silently drifting cover. Also reused: `video_offset_ms` as the output
  field, and `VideoClock`'s two-timeline conversion unchanged.
- **New:** the correlation core (onset envelopes, not waveforms) and the MIDI-to-envelope step.
  So this is a new mode of `drums align`, not a straight reuse — the earlier claim that this
  part of the vision was "already built" was too generous.

**Also settled here:**

- **A manual nudge is always available**, not just as a fallback for failure. Cheap, and it
  means a poor correlation never blocks finishing a song.
- **Clap sync is held in reserve, in a drummer-native form.** A literal clap is invisible to
  the MIDI reference. The version that works: **four stick hits on a pad before the count-in** —
  loud in the room, present in the MIDI, and a strong unambiguous anchor at a known place.
  Costs nothing, so it is worth adopting as habit even if correlation succeeds without it.
- **Known risk to test early:** headphone leakage and pedal noise may swamp the pad transients
  on a phone mic across the room. If the envelope correlation proves unreliable, the stick-count
  anchor is promoted from optional to required, which still solves it.

### Q18 — What does the exported video actually contain?

**Answer: (a) — your drums replacing theirs.**

The `nodrums` stem plus your SD3 bounce, with the notation overlaid on the phone video. This is
literally what the existing mixer already does — two stems through gains into a master — with
your bounce substituted for the `drums` stem, so the faders keep working and you can balance
yourself against the band. It is the definition of a drum cover, it reuses the mixer graph
verbatim, and because both stems are already bound to mix time nothing new has to be synced.
Keep the faders exposed in the export UI so the balance is yours.

**Consequence, revised by Q17's e-kit fact:** the "keep the phone's raw audio as a toggle,
because it proves the video and audio are really you" argument **does not survive.** On an
e-kit played in headphones the room audio is sticks on mesh and headphone bleed — it proves
nothing musically and sounds like nothing. Keep the raw phone audio available as an
**alignment and debugging aid**, not as a presentation option.

### Q19 — What gets built first?

Everything above is settled; this is the ordering. Note §10: three five-minute checks
(multi-client MIDI, WSOLA listening, alphaTab per-note styling) should land before anything
depending on them is committed to.

**Answer: (a) — pivot first, then one thin vertical slice.**

```
M0  PIVOT        re-prep on the original audio · master clock <video> → <audio>
                 notation full-screen · `drums sections` · song.toml [[section]]
                 ↓ the ground stops moving
M1  THIN SLICE   ONE cell, end to end:
                 Web MIDI capture → calibration ritual → take JSON
                 → scorer → score-as-heatmap + timing strip
                 ↓ proves the take format against reality
M2  ROUTINE      the 24-cell grid · seal · resume across sittings · epochs
M3  HISTORY      per-cell trend lines · take-vs-take overlay
M4  COACH        exercises (excerpt | generated) · step-by-step note gate
M5  ARTIFACT     .mid out to Ableton · onset-envelope align · overlay · export
```

The pivot is a genuine prerequisite: today the app cannot practise against the original track
at all, and every cell in every routine is defined against it — building capture on top of the
cover-video song means re-testing everything after the ground moves. After that, the thin slice
is what proves the take format (Q4: *"the most important thing designed in this whole
project"*) against reality **before twenty-four cells depend on it**.

Step-by-step mode (Q12) needs no scoring, no take format and no calibration, so it is the right
thing to build *during* M0 if you want something playable early.

**Consequences:**

- **M0 is not small and is mostly deletion-shaped.** Moving the master clock off `<video>`
  touches `media.ts`, `mixer.ts` and `score-window.ts`, and `check-sync.mjs` / `check-mix.mjs`
  both assume a video element. The existing Playwright checks are the safety net for exactly
  this change — run them before and after.
- **The `covers/` path must not be deleted during M0.** `VideoClock`'s two-timeline conversion
  and the `#score-box`-over-video layout are what M5 needs; the pivot should *generalise* them
  to "a video bound to this timeline, possibly absent", not remove them.
- **M1 should be one cell of one section at one tempo, with the routine hardcoded.** The
  temptation is to build the grid first because it is easy; the grid is worthless if the take
  format is wrong.
- The three §10 checks gate different milestones: **multi-client MIDI** gates M1, **alphaTab
  per-note styling** gates M1's heatmap, **WSOLA listening** gates M2.

---

## 10. Pending environment fact-find

A sub-agent was dispatched on the original machine (Windows 11 Pro 10.0.26200) to check,
read-only: whether Windows MIDI Services is installed; what MIDI hardware the OS can see;
whether loopMIDI / Bome / MIDI-OX are present; Chrome and Edge versions; Ableton and
Superior Drummer installs. **Its result was not received before the session was parked —
re-run this check on whichever machine the e-kit is plugged into, since the answer is
machine-specific.**

Two facts the agent cannot look up and that are **still needed from the user**:

1. **Which drum module**, and is it connected by USB to the machine that runs Ableton?
2. **Is the e-kit on this machine or the other one?** That decides where the Web MIDI
   spike gets built and tested.

**Three five-minute checks. None can change a decision above — they can only change whether a
recommended technique survives contact with the hardware.**

| Check | Question | Gates | If it fails |
|---|---|---|---|
| **Multi-client MIDI** | Ableton open on the module, then a Web MIDI test page in Chrome — do both receive hits at once? | M1 | loopMIDI hop (Q2), ~1–3 ms and calibratable |
| **alphaTab per-note styling** | Can alphaTab 1.8.4 colour individual notes in `PlayerMode.EnabledExternalMedia` without forcing a full re-render? | M1's heatmap | The display (Q11) needs a different mechanism — a canvas overlay, or verdicts injected into the alphaTex |
| **WSOLA listening** | Drag the tempo slider to 70% and 80% on a real mix — does it smear? | M2 | `drums ladder` pre-render (Q6), ~850 MB per song |

A fourth check is not five minutes but should happen early in M5, and its failure mode is
already planned for: **does onset-envelope correlation actually lock onto e-kit pad transients
recorded across a room by a phone, with headphone bleed in the signal?** (Q17). If not, the
four-stick-hit anchor is promoted from habit to requirement, and the manual nudge is the floor
underneath both.

---

## 11. Ground rules carried into this work

- Concepts get explained plainly — the reader is a drummer, not a DSP engineer; jargon
  gets defined at first use.
- The user knows the songs. Measurements from the band's playing are not ground truth for
  what was actually played.
- Commit messages get written out; the user stages and commits.
- Headless verification scripts need real Chrome or Edge, not bundled Chromium.
- Do not write files containing alphaTex or backslash-heavy content through a shell
  heredoc — it silently collapses `\\` to `\`. Use an editor tool.
