# Pivot: from transcriber to practice player

## Context

The Phase 3 detection slice improved the generated tabs but they are still not
good enough to learn from. The realisation behind this plan is that **the tabs
were never the product** — the product is a _practice instrument_: notation
sweeping over a synced video, with a playhead, controllable tempo, and a mixer
over the original track, its stems, a drum sampler and a click. That thing is
valuable even if every tab in the catalogue is typed by hand, and it is the part
nothing else on the market gives you (Songsterr has no video, drum covers have no
notation, neither lets you mute the drums and slow it down).

So the project inverts:

|               | before                    | after                                  |
| ------------- | ------------------------- | -------------------------------------- |
| canonical tab | generated `score.json`    | **hand-authored file in the song dir** |
| generation    | the point                 | a _draft generator_ that saves typing  |
| player        | a way to check the output | the product                            |

Two things survive the inversion unchanged and they are the reason this repo is
worth continuing rather than restarting:

- **`grid.lock.json`** — the measured per-beat time map. It is what lets notation
  in musical time ride on top of a human drummer's drifting performance. Nine
  songs are already correct. Nothing else you could buy or download gives you
  this, and every feature on the wishlist (playhead, export, avatar, assessment)
  needs it.
- **The media pipeline** — `mix.wav`, `video.mp4`, `drums.wav`, `nodrums.wav`,
  `stems/kit/*` all on one sample-aligned timeline, from one command.

---

## The three decisions

### 1. Author in Ableton, export MIDI; keep Guitar Pro as a live alternative

Canonical hand-authored source is **`songs/<slug>/tab.mid`** — a constant-tempo
Type-1 MIDI where **bar 1 is grid bar 1**. You have an e-kit, so you can play
parts in rather than draw them, velocity comes along for free, and the same MIDI
later feeds the drum sampler, the play-assessment and the 3D avatar without
conversion.

Guitar Pro gets a genuinely cheap escape hatch rather than a second pipeline:
**alphaTab reads `.gp` natively**, so dropping `songs/<slug>/tab.gp` in makes the
player render your engraving exactly as you drew it, with zero converter. See
decision 3 for why that costs nothing.

Source precedence per song, first match wins:

```
tab.gp  >  tab.mid  >  song.alphatex (hand-edited)  >  song.alphatex (generated)
```

The generator keeps writing `song.alphatex`; a `tab.*` file simply shadows it.

**MIDI note mapping is a real task, not a detail.** Ableton's drum racks, your
e-kit module and General MIDI all disagree, and alphaTab's own numbering
disagrees with GM as well (`pipeline/articulations.py:29-36` — alphaTab puts the
kick on 35, not GM's 36, because that is where the notehead lands). So the
importer needs an explicit inbound map, `pipeline/data/midi_maps/*.json`
(`gm.json`, plus one for your module), selected per song in `song.toml`. The
existing `KIT` table in [articulations.py:37-54](pipeline/articulations.py#L37-L54)
already names 16 instruments — rim, sidestick, open hat, hat pedal, three toms,
two crashes, ride, bell, china, splash. The generator emits 3 of them. **You get
all 16 the day you hand-author.**

### 2. Author against a tempo-straightened render, not against the raw audio

The obstacle to writing MIDI in Ableton is that a human drummer's tempo drifts
~1% over the song — over Song 2's 66 bars that is roughly three beats of slip, so
Ableton's constant grid will not line up with the audio for more than a minute.

Fix it in the pipeline, not in the DAW: a new stage

```
drums straighten <slug> [--stems]
```

time-stretches each beat interval so beat _k_ lands exactly on
`k · 60/target_bpm`, writes `audio/straight.wav` **starting exactly at grid bar 1**,
and optionally `stems/straight-{drums,nodrums}.wav`. Then the whole authoring
workflow is: set the Ableton project to `target_bpm`, drop `straight-nodrums.wav`
at 1|1|1, play the part in, export MIDI. Bars line up for the whole song, and
because straightening is exactly invertible through the same beat array, the
imported MIDI maps back onto the real video with no drift.

This is the one piece of new Python the authoring path really needs, and it is
small: `librosa.effects.time_stretch` per beat segment with a short crossfade,
driven by the beat array already in `grid.lock.json`. `straight.wav` is a derived
authoring aid, so trimming to bar 1 does not violate the never-trim invariant
that governs `mix.wav`.

### 3. alphaTab owns the time map and the cursor; we own the audio

The old plan assumed we would have to build the playhead, the bar↔seconds
inverse and the A/B loop by hand on top of `BoundsLookup`. **We don't.** Reading
alphaTab 1.8.4's source turned up a first-class external-media mode that was
built for exactly this:

- `PlayerMode.EnabledExternalMedia` with an `IExternalMediaHandler` — you push
  media positions in (`output.updatePosition(ms)`), alphaTab pushes rate, seeks
  and play/pause back out.
- `Score.applyFlatSyncPoints()` takes `{barIndex, barPosition, millisecondOffset}`
  — **the exact shape of `grid.lock.json`'s beat array**. Feed the grid straight
  in and alphaTab interpolates piecewise-linearly between beats: the same
  arithmetic as `beat_position()` in [grid.py:762](pipeline/grid.py#L762), for
  free, in both directions.
- The beat cursor is a **CSS transform transition on the compositor**, its
  duration already scaled by playback speed. So the smooth playhead is not our
  code and never jitters — JS is not in the paint loop.
- Seek-by-bar (`api.tickPosition`), A/B loop (`api.playbackRange` +
  `api.isLooping`), drag-to-select a loop on the score, and tempo
  (`api.playbackSpeed`) are all existing API.

And in this mode alphaTab emits **no audio at all** (its synth is stubbed out), so
the two constraints PLAN.md recorded stop being constraints and become the
division of labour:

- **alphaTab:** notation, time map, cursor, loop, seek, rate.
- **us:** every sound — video/mix, drums stem, nodrums stem, drum sampler, click,
  as five gain nodes in one Web Audio graph.

Two further consequences worth calling out:

- Drop `player.soundFont`. The sonivox download is dead weight in this mode.
- **The player becomes source-agnostic and needs no new Python.** It reads
  alphaTab's _parsed_ score — which alphaTab produces identically from
  `.alphatex` and from `.gp` — plus `grid.lock.json`. That is why the Guitar Pro
  escape hatch is free, and why the previously-planned `sync.json` /
  `timeline.json` artifact is unnecessary. Two inputs per song, plus media.

---

## Housekeeping before starting

- Commit the working tree as it stands — the Phase 3 detection slice, `score_stats.py`
  and `test_arbitration.py` are written, run and unreviewed in git.
- Rewrite PLAN.md's phases 4–7 with the phases below. Phases 0–3 stay as the
  historical record; the status sections at the bottom are the most valuable
  thing in that file and should not be touched.

---

## Phase 4 — the player (next, and the whole point)

Milestone: run it against the nine existing generated tabs. You find out fast
whether the notation-quality bar is the real blocker before investing in
authoring tooling.

### Step 0 — one throwaway HTML page, before any of the rest

Two unknowns can invalidate the design, and both are answerable in under an hour
with a static page and no build. **Do this first.**

- **Does the backing sound acceptable at 0.5–0.7×?** Chromium time-stretches with
  WSOLA, which smears transients. If a snare at 0.6× is mush, the tempo control —
  the whole point of the app — needs pre-rendered fixed-rate stems
  (`ffmpeg -af rubberband=tempo=`) and becomes a discrete set of speeds instead of
  a slider. Also A/B 0.94 vs 0.97 vs 1.0: Chromium reportedly _bypasses_ the
  stretcher and plain-resamples in roughly `[0.95, 1.06]`, which pitch-shifts by
  up to ~0.9 semitone. If that is real in your build, the tempo control should
  snap to 100% or step outside that band rather than silently detuning.
- **Can two `<audio>` stems be kept within 20 ms of the `<video>`?** Log
  `audio.currentTime - video.currentTime` every frame for three minutes at 0.7×.
  Bounded, slowly-varying drift means a proportional correction works. Random
  100 ms jumps mean it doesn't — and the fallback is to **invert the master**:
  decode the stems into `AudioBuffer`s driven by one sample clock through a
  time-stretch `AudioWorklet`, and slave the (muted) video to them instead, since
  picture tolerates ~40 ms.

### Transport

Master clock is the `<video>` element at `playbackRate = r`, `preservesPitch = true`.
Its own audio track _is_ the "original mix" fader — same timeline, already
downloaded, one fewer drift loop, and `mix.wav` goes unused by the app. Drums and
nodrums are separate `<audio>` elements at the same rate, all three tapped with
`createMediaElementSource` into gain nodes.

Set the rate **through `api.playbackSpeed`**, never directly on the elements —
alphaTab derives its cursor animation speed from it, and bypassing it makes the
playhead stutter at every beat.

Drift correction runs once per frame per slave element, with hysteresis (the
`currentTime` read is quantised to the audio render quantum, so a naive
comparison chases ±10 ms of noise and you hear the rate warble):

```
> 250 ms   → hard seek to video.currentTime
20–250 ms  → proportional nudge, ±3% max, clamped so it never enters the
             0.95–1.06 resample band and detunes one stem against the others
< 10 ms    → lock back to exactly r
```

Push a _smoothed_ affine media clock into `updatePosition()`, not raw
`currentTime` — raw quantisation makes alphaTab's tick jitter across beat
boundaries and restart the cursor transition mid-beat.

Sampler and click use a classic 25 ms lookahead scheduler on `setInterval`
(**not** rAF, which throttles to ~1 Hz in a background tab and would stop the
audio). Do not drive the sampler from `api.midiEventsPlayed` — it fires at frame
granularity with no lookahead, giving every hit 0–16 ms of random latency.

### Notation window

The highest-leverage decision in the renderer: with `layoutMode = Horizontal`,
**force uniform bar widths** by setting `bar.displayWidth = pxPerBeat × beatsInBar`
on `scoreLoaded`. Without it a bar of 16ths is 2–3× the width of a bar of rests,
"4 bars" is not a fixed pixel width, and the playhead's px/sec pumps bar to bar.
With it the window is exactly 4 bars and motion is exactly linear in beats.

The sweep is then a **page-flip, not a scroll**: `scrollMode = Off` plus a custom
`IScrollHandler` whose `onBeatCursorUpdating` early-returns on ~99.99% of calls
and only animates a `translateX` when the 4-bar page changes. Explicitly reject
alphaTab's built-in smooth scroll — it animates `scrollLeft` in a JS loop on a
different timeline from the compositor-driven cursor, and its own source comments
admit this flickers.

Set `enableLazyLoading = false`. alphaTab already splits the score into 10-bar
partials and computes bounds for _all_ bars up front (only painting is lazy), so
66 bars is 7 cheap partials — and lazy loading would briefly show a blank window
on a page flip.

### Sync points and the sampler

`app/src/syncpoints.ts` converts `grid.lock.json`'s beat array to
`FlatSyncPoint[]` and hands it to alphaTab; the inverse (tick → seconds, for
scheduling sampler hits) comes back out of alphaTab's own
`MidiFileGenerator.generateSyncPoints`, so the sampler can never drift from what
the cursor shows.

The sampler reads notes from **alphaTab's parsed score**, not `score.json` — that
is what makes hand-edited `.alphatex` and `.gp` work identically.
`pipeline/data/alphatab_articulations.json` is already keyed by MIDI number, so
the sample map is a plain `Record<midi, AudioBuffer>`. Nothing in the repo
provides one-shots yet; add a `drums samples` subcommand rendering ~8 of them
into `app/public/samples/` (commit them — a few hundred KB), rather than slicing
them out of `stems/kit/*.wav`, whose separation artefacts make bad one-shots.

**One silent-failure guard.** `applyFlatSyncPoints` drops points whose bar index
exceeds the score's bar count _without warning_, and a too-long notation file
extrapolates its tail. A hand-edited song with one bar inserted would desync
progressively with no error anywhere. Assert `grid.bar_count == <bars in the
notation>` in both `pipeline/audit.py` and the app's status line.

### Module layout for `app/src/`

`main.ts` keeps its current shape (glob loading, hash routing, `#status`,
`window.drums` for the Playwright scripts) and becomes pure composition, plus:
`songs.ts` (the one place that knows the `songs/` layout), `notation.ts` (the
alphaTab instance), `syncpoints.ts`, `media.ts` (the element/gain graph and the
smoothed clock), `externalMedia.ts` (the handler + rAF pump), `sweep.ts` (the
scroll handler), `scheduler.ts`, `sampler.ts`, `metronome.ts`, `mixer.ts`,
`transport.ts`.

### Media serving

Song dirs sit outside Vite's root. Tracked KB-sized files (`song.alphatex`,
`grid.lock.json`) keep using `import.meta.glob`, which already works and gives
HMR. Media gets a `/media/<slug>/…` mount: ~50 lines of middleware in a new
`app/plugins/media.ts`, registered on **both** dev and preview servers, with a
path-containment check and **HTTP range support** — without `206` responses
Chrome cannot seek a 29 MB mp4 at all. `/@fs/` is rejected because it bakes in an
absolute machine path and does not exist in `vite preview` or a build; symlinks
are rejected because Windows needs Developer Mode for them.

Stems are 23–42 MB of PCM each. Fine on localhost; if this ever leaves the
machine, transcode to Opus-in-WebM — _not_ AAC, whose encoder delay and padding
shift the timeline and would violate the never-trim invariant.

### Ranked risks

1. **WSOLA quality at 0.5–0.7× is unusable.** Kills the tempo slider. → Step 0.
2. **Media-element drift is not correctable to <20 ms.** Changes the architecture,
   not a parameter. → Step 0, with the invert-the-master fallback named above.
3. **Audible gap at the A/B loop wrap** — the chain from position push to media
   seek is tens of ms. Mitigation: pre-roll the seek ~150 ms before the loop end
   instead of after it; heavier fallback is two ping-ponging video elements.
4. **Uniform `displayWidth` fights the engraver** — dense bars may clamp at an
   intrinsic minimum, quietly breaking linearity. Check by dumping bar widths from
   `boundsLookup` after `renderFinished`; fallback is a median-derived fixed scale
   and accepting 3.5–4.5 visible bars.
5. **Grid/notation bar-count divergence fails silently** → the assertion above.
6. **Per-beat sync-point density (266–800 points) is a path alphaTab may not have
   been exercised on.** Cheap to validate: assert `barToMedia(bar)` matches
   `Grid.bar_start(bar)` within 5 ms for every bar. One headless test, validates
   the whole timing contract.

### Media weight

A `drums webprep <slug>` stage transcoding to web-friendly media under
`songs/<slug>/web/` is a small ffmpeg job that makes the player feel instant.
Not needed for the first milestone.

---

## Phase 5 — the authoring pipeline

1. `drums straighten` (decision 2).
2. **score v2.** Today `score.json` can only express straight sixteenths
   (`SUBDIVISION = 4`, [quantize.py:44](pipeline/quantize.py#L44)). Hand-authored
   parts will immediately want triplets, 32nds, flams and open hats. Replace the
   `slot` integer with **ticks-within-bar at PPQ 960** (exact for 3-, 5- and
   7-tuplets), add optional per-bar meter, per-note flags (ghost, accent, flam,
   choke) and a `sections` list. Keep a v1→v2 upgrade so the nine existing songs
   still load.
3. `drums import-midi <slug>` → score v2, via the inbound MIDI map.
4. **Emitter upgrade.** `emit_alphatex.py`'s metric tree currently assumes a fixed
   16th grid. It needs arbitrary tick positions and tuplets. Note this is the
   _easy half_ of the old Phase 2: when positions are exact, picking the notation
   is deterministic (smallest grid that represents the bar), with no Viterbi and
   no guessing. The property tests in
   [tests/test_emit_alphatex.py](tests/test_emit_alphatex.py) already assert the
   invariants that matter and extend directly.
5. `drums export-midi <slug>` — write the _generated_ score back out as `tab.mid`.
   This is what makes the generator keep paying: open the machine draft in
   Ableton, fix it against the straightened audio, export, re-import.

Then hand-author two or three songs and compare the Ableton and Guitar Pro
workflows for real, on the same song.

---

## What to expect from generation from here

Be blunt with yourself about this: **published research and every shipping
product agree that automatic drum transcription is not accurate enough to read
from.** State of the art sits around 0.7-0.85 F-measure on kick/snare/hat and
markedly worse on toms and cymbals; nobody ships auto-generated drum tabs as a
finished product. Your own numbers (5-11% one-off errors on the three easy
classes, toms and cymbals not notated at all) are roughly where the field is.

So retarget the metric. Not "is the tab correct" but **"how many minutes of
authoring does the draft save."** Under that metric, ranked by value per unit of
work:

|     | work                                                                                                    | why it matters                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Structure / repeat detection** — cluster bars by pattern to find intro/verse/chorus and repeated bars | Dual-use: shortens the notation _and_ is required for "learn it in parts", difficulty tiers and the learn mode. Cheap (self-similarity over `score.json` bar patterns) and needs no audio work. **Do this one.** |
| 2   | **Hi-hat open/closed, ride, crash**                                                                     | Everything is a closed hat today. Cymbals are the most visually obvious wrongness and the fastest thing to notice as a reader. The `stems/kit/` splits already exist.                                            |
| 3   | **Toms**                                                                                                | Fills are where a learner's eyes go, and fills are toms. Needs 3-way pitch classification of the tom stem.                                                                                                       |
| 4   | **Ghost / accent dynamics**                                                                             | 16% of notes are in ghost territory and notated full-weight. Cheap, big readability win.                                                                                                                         |
| 5   | **Per-bar subdivision + swing**                                                                         | Only benefits the _generated_ path — the hand path gets exact positions for free.                                                                                                                                |
| 6   | **A neural backend spike** (ADTOF or similar)                                                           | The `Backend` seam in `pipeline/backends/base.py` already exists for exactly this. Possible step change; possible dead end. Time-box it.                                                                         |
| —   | Multi-source combining (several covers of one song)                                                     | Skip. High complexity, small payoff.                                                                                                                                                                             |

Recommendation: **commit the Phase 3 work as it stands, then freeze generation**
and do only item 1 (structure detection) in the near term, because the player
needs sections anyway. Return to 2-4 only when the player is something you use
daily and the authoring time actually annoys you.

---

## The wishlist, placed

Everything below is downstream of the player; ordered by how much each depends on
the ones above it.

**Phase 6 — practice modes.** Falls almost free out of owning the transport: A/B
bar loop, count-in bars, tempo ramp (loop that section starting at 70%, +2% per
pass), section navigation, "play just the fills". This is the single highest
learning-value phase after the player itself, and it is mostly UI over machinery
you already have. Sections come from item 1 above, or hand-written in `song.toml`.

**Phase 7 — MP4 export with notation baked in.** Well-scoped once the player
exists: Playwright frame-stepping the same page plus ffmpeg/NVENC. Same machinery
serves "drop a video of me playing and overlay the notes" — that is the export
path with a different video source and a hand-entered offset. Attaching your own
covers to a song in the catalogue is then just a `covers/` subdir per song with a
date, which also gives you the progress history.

**Phase 8 — difficulty score and tiers.** Difficulty is a heuristic over score v2
(note density, limb independence, subdivision, dynamic range, fill frequency),
calibrated against songs you rank by hand, with a manual override field. Tiers
are a _note-reduction pass_ over the same model — drop ghosts, collapse 16th hats
to 8ths, simplify fills to the downbeats — keeping structure. Deterministic rules
will get you tier-1 and tier-2 for most grooves; hand the odd case to an agent
rather than building an agent-first system.

**Phase 9 — play assessment and learn mode.** Your e-kit makes this cheap:
**Web MIDI**, not audio detection. Compare incoming note+timestamp against the
reference notes the player already schedules for the sampler, score per limb and
per section, feed the "which parts were hardest" report and the hit counter/XP.
Step-by-step mode (show note, wait, advance) is the same comparison with the
transport paused. Acoustic-kit assessment via microphone is a much harder,
much later thing — don't let it into scope.

**Phase 10+ — 3D avatar, catalogue/store, course, XP economy.** All genuinely
later. The avatar is a three.js scene driven by the same scheduled note stream
that drives the sampler.

### On migrating to Unity

**Don't.** The reason is alphaTab: it is the only production-quality drum
notation renderer with a usable API, and there is no Unity equivalent — you would
be writing an engraver. Meanwhile the things Unity is supposed to buy you are
available on the web: Web MIDI gives single-digit-millisecond input timing for an
e-kit (assessment is a comparison against a schedule, not DSP), Web Audio
scheduling is sample-accurate, and three.js handles a stylised drumming avatar.
For Steam, wrap the web app in Tauri. Revisit only if the avatar becomes the
centrepiece rather than a skin.

---

## Verification

- **Step 0's throwaway page** decides risks 1 and 2 before anything is built.
- **The timing contract, headless and cheap:** apply the grid's sync points, then
  assert `barToMedia(bar)` matches `Grid.bar_start(bar)` within 5 ms for every bar
  of every song. One assertion covers the whole score↔seconds design.
- `uv run pytest` — the pure tests stay green through score v1→v2 (add an upgrade
  test); emitter property tests in
  [tests/test_emit_alphatex.py](tests/test_emit_alphatex.py) extend to tuplets.
- `npm run typecheck`, and extend `npm run smoke` — it currently asserts
  `api.timePosition` advances; it should also assert `video.currentTime` advances,
  the sweep transform changes at a page boundary, and
  `|drums.currentTime - video.currentTime| < 0.02` after 5 s at 0.7×.
- Manual, and the one that actually decides it: **play along to Song 2 at 70%
  with the original drums muted, the sampler on and the click on, and see if the
  notation stays under your eyes.**
