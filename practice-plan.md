# Practice mode — requirements interview (in progress)

This is a **live requirements interview**, not a finished plan. It was started on
2026-09-12 and is parked mid-way so it can be picked up on another machine.

**To resume:** open Claude Code in this repo and say

> Continue the grill-me interview in `practice-plan.md`. I'm answering Round 2.

The agent should read this file, skip re-exploring the codebase (§3 has the facts),
and take the Round 2 answers. Answer format is free — `Q5: a, Q6: b, Q7: a, Q8: a`
works, and so does prose that argues with the recommendation.

**The method** (the "grill me" skill): map the work as a design tree. Each round asks
every question whose prerequisites are already settled — the *frontier* — with a
recommended answer for each. The user's answers push the frontier outward and unblock
the next round. The interview is done when the frontier is empty. Nothing gets built
until the user confirms shared understanding.

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

OPEN — Round 2 (asked, awaiting answers)
├── Q5 routine shape & completeness
├── Q6 how the tempo ladder is produced
├── Q7 what counts as a correct hit
└── Q8 what a take contains and where it lives

HELD — Round 3+ (blocked on Round 2)
├── step-by-step mode: exact behaviour
├── latency calibration ritual
├── history & progress-comparison UI
├── the visual mistake display (score heatmap vs timeline vs both)
├── exercise generation: format, where they live, how they're playable
├── final-artifact chain: copy-to-Ableton, video upload, auto-sync, overlay, MP4 export
├── section naming/override once detection proposes boundaries
└── build order and milestone slicing
```

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

## 6. Round 2 — asked, NOT YET ANSWERED

**These four are the next thing to answer.**

### ❓ Q5 — What exactly is one "routine", and what makes it complete?

A routine walks a grid of *(section × tempo)*. There are two incompatible orderings:

- **(a) Section-major** — section 1 at 70/80/90/100, then section 2 at 70/80/90/100. You
  master each part before moving on.
- **(b) Tempo-major** — every section at 70%, then every section at 80%. You climb the
  whole song four times.
- **(c) Adaptive** — a section only unlocks the next tempo once you clear an accuracy
  threshold. The routine is a queue, not a list.
- **(d) Fixed grid + adaptive suggestions** — fixed comparable cell set, but the app
  reorders what it suggests next based on where you're failing.

**The tension to resolve, and it is the crux of the feature:** you also want to *"go
through the play routine again and compare results with the previous one."* **Comparison
only works if the routine is a fixed, identical set of cells every time.** Adaptive gating
makes every run a different shape — run 3 and run 4 stop being comparable and the progress
history becomes noise.

➡️ **Recommended: fixed grid, walked section-major, with the accuracy gate as a signal
rather than a gate.** The routine for a song is a defined set of cells — every section at
every tempo, plus the full song at every tempo — identical every run, forever. A cell below
threshold goes **red** and the coach sees it; it does not block you. "Complete" = every
cell has one take played to the end. Abandoning a cell (stopping early, closing the page)
discards that take silently and leaves the cell unfilled; **a routine with unfilled cells
cannot be saved.** The **full song at 100% is the last cell of every routine** — so the
final artifact isn't a separate feature, it's the last thing done on every run.

Sub-decision assumed unless objected to: any cell can be retried freely within a run, and
**the last complete take counts, not the best** — "best" lets you farm a lucky take and
corrupts the progress line.

### ❓ Q6 — How are the 70/80/90% versions of the original produced?

- **(a) Live in the browser** — `playbackRate` with `preservesPitch = true`. **Already
  works today**, zero new code, instant tempo switching. But it is Chrome's built-in WSOLA
  and on a dense studio mix at 0.7× it can smear. **The archived plan flagged exactly this
  as risk #1** — *"WSOLA quality at 0.5-0.7×"* was one of two Step 0 questions and appears
  never to have been answered.
- **(b) Pre-rendered offline** — a `drums ladder <slug>` step writing `stems/70/*.wav` etc.
  with a proper phase vocoder. Better quality, ~850 MB more per song on top of the current
  283 MB, a pipeline run per song, and switching tempo needs a reload and reseek.
- **(c) Hybrid** — browser rate while exploring, pre-rendered for recorded takes.

➡️ **Recommended: (a) now, (b) only if your ears say so.** This is a five-minute listening
test that only you can judge and it is already built — open the app, drag the slider to
70%, listen. If it is fine, that skips a whole pipeline stage and ~850 MB per song. Note
the click is what actually holds you together at 70% anyway, and `app/src/click.ts`
already scales correctly with rate.

### ❓ Q7 — What counts as a correct hit? (the contract everything else reads)

Three sub-decisions that only make sense together:

**1. The match window.** Fixed milliseconds (±60 ms at every tempo) or tempo-relative
(±a 32nd note, widening as you slow down)? Fixed-ms is how *tightness* actually works — a
30 ms flam is a 30 ms flam at any tempo. Tempo-relative is how *"which note did you mean"*
works.

➡️ **Both, in two stages.** A tempo-relative window (half the distance to the neighbouring
reference note, capped) decides **which note you were aiming at**; then the raw
millisecond error against that note decides **how tight you were**. Either stage alone
fails: fixed-only mis-assigns notes at slow tempos, relative-only scores a sloppy 70% take
as "accurate" because the window widened with it.

**2. What gets graded.** (i) note accuracy — right voice, no misses, no extras; (ii)
timing — mean offset and spread, **per limb**; (iii) dynamics — ghosts and accents.

➡️ **Grade (i) and (ii). Capture velocity in every take from day one but don't grade it
yet.** `tab.mid` already carries velocity from Ableton and `midi-tab.ts` throws it away.
Grading dynamics requires having authored *honest* velocities in Live, a discipline not
yet adopted — but recording your own velocities costs nothing and **cannot be recovered
retroactively.**

**3. Systematic lateness vs randomness.** Playing 20 ms consistently late is a **latency
calibration artifact**. Playing ±20 ms randomly is a **playing problem**. Opposite
diagnoses from the same number.

➡️ **Always report mean offset and standard deviation separately, and always subtract
calibrated latency first.** Without this the coach will spend your life telling you to
"play on top of the beat" when the audio interface is the problem.

### ❓ Q8 — What's in a take, and where does it live?

Capture: MIDI events only / MIDI + a rendered audio of the take / MIDI + the full mix you
heard. Storage: git-tracked, untracked, or browser IndexedDB.

➡️ **Recommended: MIDI events only, as one git-tracked JSON per take under
`songs/<slug>/takes/`.** Shape roughly:

```jsonc
{ "cell": { "section": "B", "tempo": 0.8 },
  "startedAt": "2026-09-12T18:04:11Z",
  "calibrationMs": 12.4,
  "chartHash": "<sha256 of tab.mid>",
  "events": [ { "tMs": 1203.4, "note": 38, "velocity": 96 } ],
  "grade": { "perVoice": {}, "timing": {}, "missed": 0, "extra": 0 } }
```

Tens of kilobytes. Audio is always regenerable from MIDI + SD3, so storing it is waste.
Tracking it in git gives the entire progress history with **zero storage code written**,
and gives the coaching agent something it can read directly off disk.

**`chartHash` is not optional.** You will fix the chart in Ableton after a bad take reveals
you wrote a fill wrong — and when you do, every historical take must keep its original
grade rather than silently re-grading against a chart that did not exist when you played.
Without it the progress history quietly lies to you.

---

## 7. Pending environment fact-find

A sub-agent was dispatched on the original machine (Windows 11 Pro 10.0.26200) to check,
read-only: whether Windows MIDI Services is installed; what MIDI hardware the OS can see;
whether loopMIDI / Bome / MIDI-OX are present; Chrome and Edge versions; Ableton and
Superior Drummer installs. **Its result was not received before the session was parked —
re-run this check on whichever machine the e-kit is plugged into, since the answer is
machine-specific.**

Two facts the agent cannot look up and that are still needed from the user:

1. **Which drum module**, and is it connected by USB to the machine that runs Ableton?
2. **Is the e-kit on this machine or the other one?** That decides where the Web MIDI
   spike gets built and tested.

---

## 8. Ground rules carried into this work

- Concepts get explained plainly — the reader is a drummer, not a DSP engineer; jargon
  gets defined at first use.
- The user knows the songs. Measurements from the band's playing are not ground truth for
  what was actually played.
- Commit messages get written out; the user stages and commits.
- Headless verification scripts need real Chrome or Edge, not bundled Chromium.
- Do not write files containing alphaTex or backslash-heavy content through a shell
  heredoc — it silently collapses `\\` to `\`. Use an editor tool.
