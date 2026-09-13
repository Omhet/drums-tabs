# 3D avatar — requirements interview (COMPLETE)

An **extension** to the practice system designed in [`practice-plan.md`](practice-plan.md).
Both interviews are now complete: the parent is 19 decisions over five rounds (M0–M5), this
one is 16 decisions over four rounds, all on 2026-09-13. **The frontier is empty.**

Same method as the parent file: map the work as a design tree, ask every question whose
prerequisites are settled (the *frontier*) with a recommended answer for each, let the
answers push the frontier outward. Done when the frontier is empty. **Nothing gets built
until shared understanding is confirmed.**

References to `Q1`–`Q19` below point at decisions in `practice-plan.md`. Questions in this
file are numbered `A1`–`D4` to keep them distinct.

**To pick this up:** open Claude Code in this repo and say

> Read `avatar-plan.md`. The interview is complete — let's build the sticking solver.

---

## 1. The vision, as stated

Verbatim intent, reorganised but not reinterpreted:

- Start with a **simple 3D drum set and sticks in the air**, camera looking **top down** on
  the kit.
- **Feet on the pedals**, rendered by another camera into a **small fixed window**, so hand
  motion and foot motion are observable **simultaneously**.
- The avatar for now is **the sticks (or simplified hands holding sticks) and the feet**,
  **doing correct motions**.
- **Later**: "add" a body with a head to the hands, and move the camera around for a good
  shot, or a **fixed list of good shots**.
- Use **WebGPU probably, or whatever gives the best performance**.

## 2. Two reframings, accepted before Round 1

**The scene is not performance-bound.** Fifteen objects and four limbs is trivial in any
renderer; WebGPU will not make it faster than WebGL2 would. The renderer choice matters for
Three's forward path, headless testability and bundle size — not for frame rate. Framing it
as a performance decision leads to the wrong answer for the right-sounding reason.

**The hard problem is sticking, not rendering.** The chart says "snare at slot 12"; it does
not say *which hand*. A drummer makes hundreds of those decisions per song, and an avatar
that guesses wrong teaches bad technique — worse than no avatar at all.

**And sticking is unrecoverable from MIDI.** An e-kit sends the same note number whichever
hand hits the snare. So the avatar can **never** show *your* sticking, only a reference
sticking. This is permanent and shapes everything downstream: any "replay my take" feature
shows your real note times acted out with fictional hands.

## 3. Facts that carry over from the parent design

- **`app/` is plain DOM, no framework**, ~6,100 lines. Dependencies are four small packages:
  `@coderline/alphatab`, `fast-xml-parser`, `midi-file`, `smol-toml`. **Three.js would be the
  largest dependency this repo has ever taken on, by roughly 10×.**
- **`VideoClock.mixTimeMs` is the single clock** (Q1). The avatar is a *view* of that clock
  and must never become a second one.
- **The video slot is empty after M0.** The pivot to the original track removes the cover
  video; `ScoreWindow` still clips notation to N rows over the bottom of whatever media
  surface is there.
- **Velocity is captured in every take and in `tab.mid`, and deliberately not graded** (Q7).
- **The repo's established idiom is measure-once-then-freeze**: `grid.lock.json`,
  `drums sections` → `[[section]]` in `song.toml` (Q16). Proposed, reviewed by hand, then
  tracked and authoritative.
- **Headless verification needs real Chrome or Edge**, not bundled Chromium.

---

## 4. Design tree — status

```
SETTLED (Round 1)
├── Data source ............... the reference chart; avatar plays it correctly
├── Sticking .................. solver proposes → hand-edited → sticking.lock.json
├── Layout ................... the avatar takes the empty video slot
└── Renderer ................. Three.js · WebGPU + WebGL2 fallback · procedural kit

SETTLED (Round 2)
├── Motion ................... physical stroke model; contact exactly on the beat
├── Rig ...................... solver emits end-effector transforms; rig renders at them
├── Cameras .................. one renderer, two scissored viewports, one scene
└── Milestones ............... solver in M0 (ships R/L annotations); renderer is M6

SETTLED (Round 3)
├── Kit geometry ............. hand-edited `kit.toml` at the repo root, default kit shipped
├── Testing .................. assert the transform stream; smoke-test the render
├── Export ................... two artifact kinds — the real cover, and the avatar render
└── v2 ....................... stylised body on IK; named shots beside the kit config

SETTLED (Round 4)
├── Affordances .............. hand colour-coding + next-hit target highlight
├── Cost model ............... one hard feasibility constraint, three soft weights
├── Hi-hat ................... a derived foot-state track, frozen beside sticking
└── Idle ..................... ready pose over the next instrument; no idle animation

FRONTIER: empty. The interview is complete.
```

### The design in one paragraph

The avatar plays **the chart**, correctly, so it is a teaching aid rather than a mirror — and
because sticking is unrecoverable from e-kit MIDI, it can only ever show a *reference* sticking.
A **solver assigns limbs** by minimum effort over a hard feasibility constraint, proposes, and
freezes into a chart-hash-pinned lock file you hand-edit — the repo's existing measure-once idiom
— and that same file carries a **derived hi-hat foot-state track**, because open versus closed is
instrument state the chart implies but never states. Both derivations **double as chart
validators**: a passage with no feasible sticking is physically unplayable, and a foot that must
be up and down at once is an error, and both name the bar. A **precomputed motion timeline**
turns those hits into **end-effector transforms** — every stroke a velocity-scaled prep-lift,
contact exactly on the beat, rebound — and the rig draws whatever it likes at those transforms:
**two sticks today, a stylised body on IK later**, with the solver untouched. It renders into the
**video slot the pivot empties**, with notation clipped over the bottom as it already is, a
**top-down camera** plus a **foot inset** that exists because hi-hat technique is the one thing
top-down cannot show. Hands are **colour-coded** and the **next pad glows a beat ahead**, because
a prep-lift telegraphs *when* but never *where*. It is **tested without pixels** — the tip is on
the surface at the hit time, no limb teleports — and it ships in **two halves**: the solver in M0,
where it delivers **R/L letters under the notation** with no 3D at all, and the renderer as M6,
where it also becomes a **second kind of export** — the illustration, next to the cover that
proves you played it.

### The milestone split

| | M0 — with the pivot | M6 — after the artifact |
|---|---|---|
| **Ships** | `drums sticking`, `sticking.lock.json`, foot-state track, `kit.toml`, **R/L under the notation** | Three.js surface, motion timeline, rig, cameras, affordances, avatar export |
| **Language** | Python, beside `drums sections` | TypeScript, beside `media.ts` |
| **Depends on** | `tab.mid`, kit geometry | M0's lock file, the M5 exporter |
| **Value alone** | Real — drummers read stickings | Real — but nothing depends on it |
| **Risk** | Weights overfit to one song | It is the fun half, and it is last |

---

## 5. Round 1 — asked and answered

### A1 — What drives the avatar's motion?

**Answer: (a) — the reference chart.**

The avatar plays what `tab.mid` says, correctly — the stated intent, *"doing correct
motions."* It has full information (chart, sticking, velocity), needs no MIDI capture to
exist, and is therefore buildable and useful **before M1 ever lands**. It is a teaching aid:
watch how the part is played, then play it.

**Consequences:**

- **The avatar has no dependency on the assessment spine at all.** It needs `tab.mid`, the
  clock, and a sticking source. Not Web MIDI, not calibration, not takes, not the scorer.
  That independence is what makes B4 (milestone placement) a real question rather than an
  obvious one.
- **"Replay my take" stays possible but permanently asterisked.** Real note times, fictional
  hands. Worth building later; worth labelling honestly when it is.
- **A live mirror mode is explicitly not the goal** and should not quietly become one — you
  cannot read notation and watch an avatar in the same glance, which is the same reason the
  foot inset exists rather than a second screen.

### A2 — Where does sticking come from?

**Answer: (a) — a solver proposes, you edit, a lock file freezes it.**

`drums sticking <slug>` assigns a limb to every hit by **minimum-effort path**: dynamic
programming over limb positions, honouring **simultaneity** (two notes at one instant means
two limbs) and **physical limits** (one hand cannot cross the kit in 30 ms). It writes
`sticking.lock.json`, pinned to the chart hash; you hand-fix what it gets wrong; it is
authoritative from then on.

This is exactly the repo's existing idiom — `grid.lock.json` and `drums sections` are both
measure-once-then-freeze — and it is a well-understood problem shape, the same one guitar-tab
fingering generators solve.

**Consequences:**

- **`sticking.lock.json` must be pinned to `chartHash`, and re-running must be explicit.**
  Same reasoning as Q8 and Q16: the chart changes every time you Ctrl+S in Ableton, and
  sticking derived from a chart that no longer exists is worse than none.
- **Sticking is not only avatar input — it is notation annotation.** R/L letters under the
  staff are a feature in their own right, one drummers read constantly, and they need no 3D
  whatsoever. **The solver delivers value even if the renderer never ships.** This is the
  strongest argument in the whole extension and it drives B4.
- **The solver needs a kit geometry to measure "effort" against** — distances between
  instruments. That geometry is the same data the renderer needs for positions, so it must
  exist before either, and it is a property of **your kit**, not of a song.
  **Assumed: a single global kit-layout config, not per-song, not in `song.toml`.
  Flag if wrong.**
- **The solver needs a cost model with real numbers** — how expensive is a crossover, how far
  can a hand move in 100 ms. These are tunables with no principled defaults; expect to tune
  them by watching the output, which is another reason the R/L annotation matters: it is
  readable without the 3D.
- **Feet are nearly free.** Q11 already fixed the mapping — kick is right foot, hi-hat pedal
  is left foot — so foot "sticking" is a lookup, not a search. The solver only searches hands.

### A3 — Where does the avatar live on screen?

**Answer: (a) — it takes the video slot.**

After M0 that slot is empty. `ScoreWindow` already clips notation to N rows over the bottom of
a media surface, so dropping the 3D canvas in gives **notation-over-avatar for free**, with no
new layout code.

**Consequences:**

- **This makes Q1's abstraction real.** "A video bound to this timeline" becomes "a media
  surface bound to this timeline" with **three** implementations: nothing (M0), the 3D canvas
  (this extension), and your own cover video (M5). Building the second one is what proves the
  seam before M5 depends on it.
- **The surface interface is narrow and should stay that way**: it gets a position from the
  clock, it fills a rect, it does not own time. A `<video>` satisfies this by being seeked; a
  canvas satisfies it by being drawn. Nothing else should leak in.
- **`ScoreWindow` is driven by `playerPositionChanged`, not `playedBeatChanged`** (§3 of the
  parent file) — so the avatar must be driven the same way, or notation and avatar will
  disagree while paused, which is exactly when you are studying a bar.

### A4 — Renderer and kit assets?

**Answer: (a) — Three.js, WebGPURenderer with WebGL2 fallback, procedural kit.**

Three.js because hand-writing matrices, lighting and a scene graph is months better spent on
the motion solver. WebGPU because it is Three's forward path (TSL), **with WebGL2 fallback as
a one-line swap** — which also rescues headless Playwright, where WebGPU support is far
patchier than WebGL2. The kit is built from **procedural primitives** (cylinders and discs),
not a downloaded model: photoreal viewed top-down is *less* legible than a clean diagram,
positions must be per-kit configurable anyway, and it keeps a 5–20 MB GLTF out of a repo whose
`.git` is 4.6 MB.

**Consequences:**

- **The fallback must be exercised, not merely present.** If every check runs on WebGPU the
  WebGL2 path will rot silently. Cheapest insurance: force the fallback in the headless script
  and let it be the tested path.
- **Bundle size becomes a thing this repo has to think about for the first time.** Three should
  be dynamically imported so the player still loads instantly when the avatar is not shown.
- **Procedural means kit geometry is data, not a model file** — which is the same data A2's
  solver needs for its cost model. One config, two consumers.
- **Lighting and readability are a design problem, not a tech problem.** Top-down with 11
  articulations means colour and silhouette carry the meaning. Worth an early screenshot pass
  before any motion work.

---

## 6. Round 2 — asked and answered

### B1 — What does a stroke actually look like?

**Answer: (a) — a physical stroke model.**

Each hit gets a **prep-lift** whose height scales with velocity and whose start is bounded by
the gap to the previous hit, then a downstroke, then contact **exactly on the beat**, then
rebound. Travel between instruments is an eased path laid under the strokes. A deterministic
function of (hits, sticking, velocity). Contact-on-the-beat is non-negotiable for a teaching
tool, which rules out spring simulation however good it looks.

Driven by the clock, so at 70% the motion slows with the music — but **lift heights do not
change with tempo**, only durations. When the gap to the next hit is too short for a full prep,
**the lift is truncated; the contact never moves.**

**Consequences:**

- **This is the first real consumer of velocity**, which Q7 said to capture and not grade.
  Ghosts become small lifts, accents become big ones, and dynamics become visible for free from
  data already being stored.
- **But `midi-tab.ts` throws velocity away today.** It only tests `velocity !== 0`
  (`midi-tab.ts:137-156`) and emits `\hidedynamics` unconditionally. The avatar needs a hit
  extraction that **preserves velocity** — either that path is widened or a second extractor
  exists beside it. Small, but it is a real change to code the notation depends on.
- **The lift requires lookahead**, so motion cannot be a streaming function of "now". Cleanest
  form: **precompute the entire motion timeline once per song** — it is deterministic — and make
  sampling at time *t* a lookup. That also makes it a pure function, which is what C2 needs to
  test it. (The alternative, a lookahead window, is the shape `click.ts` already uses at 100 ms.)
- **Lift height is bounded twice, not once** — by velocity *and* by available time. A 16th-note
  hat pattern at 100% leaves ~150 ms between hits, which is barely a stroke. Both constraints
  apply, and the smaller wins.

### B2 — How does "add a body later" stay cheap?

Your staging is sticks now, body with a head later. Whether that is a small addition or a
rewrite is decided now, not later.

**Answer: (a) — the solver emits end-effector transforms; a rig renders at them.**

Motion produces a stream of transforms — stick-tip **position and orientation**, per limb, per
frame. v1's rig is two sticks and two feet drawn at those transforms. v2's rig is arms, legs and
a torso solved by IK **to the same transforms**. The motion solver never changes. It is the same
split the repo already lives by: `grid.lock.json` holds measured truth, everything else is a
view of it.

**A transform, not a point** — a stick has a direction, and without orientation the v2 IK has
nothing to aim the forearm at.

**Consequences:**

- **The transform stream is the testable artifact.** Everything worth asserting about the
  avatar — is the tip on the drum at the beat, did a limb teleport, are two limbs in the same
  place — is a statement about this stream, with no pixels involved. This is what makes C2
  answerable at all.
- **Feet are a different shape of problem.** A foot on a pedal has essentially one degree of
  freedom, so it could be an angle rather than a free transform. Uniform is simpler,
  specialised is more accurate. **Assumed uniform; flag if the pedal mechanism should be
  modelled properly.**
- **v1's stick is drawn backwards from the tip** along the transform's direction. That means
  the tip is the authoritative point and the grip end is derived — which is the right way round,
  since the tip is what contacts the drum and what the test asserts on.

### B3 — How are the two views produced?

You asked for a top-down main view plus a small fixed window showing the feet, both visible at
once.

**Answer: (a) — one renderer, two scissored viewports.**

The main top-down camera fills the surface; an inset camera on the **same scene** draws the
pedals into a corner rect. One scene, one render loop, two passes. It is the cheapest thing that
does what you asked, and it makes the v2 "good shots" feature nearly free — a shot becomes a
named camera, and the foot inset is just one that happens to be pinned on.

**Consequences:**

- **The two views cannot desynchronise, by construction.** One scene, updated once per frame,
  drawn twice. There is no second clock and no second state to keep in step.
- **The inset must not collide with the notation.** `ScoreWindow` clips notation to N rows over
  the **bottom** of the surface, so the foot inset belongs in a **top** corner. Worth fixing now
  rather than discovering it when the two are first shown together.
- **The shot system is the camera system.** There is no separate feature to build later — v2's
  "fixed list of good shots" is more entries in the same list, which is what C4 has to specify.

### B4 — Where does this slot into M0–M5?

Q19 fixed the order: M0 pivot, M1 thin slice, M2 routine, M3 history, M4 coach, M5 artifact.
A1 established the avatar needs none of the assessment spine — only the chart, the clock and
sticking. So it can go almost anywhere, which makes this a real choice.

**Answer: (a) — split it. The solver goes in M0; the renderer becomes M6.**

`drums sticking` is built in **M0** beside `drums sections` — both are pattern analysis over
`tab.mid`, both produce a chart-hash-pinned lock file, both are Python sharing the same parsing
— and it immediately ships **R/L annotations under the notation**, useful on its own with no 3D
at all. The 3D renderer becomes **M6**, after the artifact. The solver is cheap, shares code
with work already scheduled, and delivers a real feature alone; the renderer is the expensive
half with no dependants, so it waits and nothing waits on it.

**The accepted risk, stated plainly:** the avatar is the fun half and it is now last. It may
never happen. That was weighed and the ordering logic won.

**Consequences:**

- **Kit geometry is now a Milestone 0 dependency**, because the sticking solver needs distances
  to measure effort against. It is the nearest-term open decision in this file → **C1**.
- **The R/L annotation needs alphaTab to decorate individual notes**, which is unverified. This
  is very likely **the same spike** already listed in `practice-plan.md` §10 for the Q11 heatmap
  — per-note styling and per-note text are the same capability question. Worth folding into one
  check rather than discovering it twice.
- **M0's scope grows.** The parent file already called M0 "not small and mostly deletion-shaped"
  (clock move, `media.ts`/`mixer.ts`/`score-window.ts`, both Playwright checks). Adding
  `drums sticking` and kit geometry on top is real. Acceptable because it is Python work beside
  Python work, but it should be a known addition rather than a surprise.

---

## 7. Round 3 — asked and answered

### C1 — Kit geometry: what does it hold, where does it live, how is it authored?

**Answer: (a) — a hand-edited `kit.toml` at the repo root, with a default kit shipped.**

Both halves already read TOML — Python `tomllib` in the pipeline, `smol-toml` in the app — so it
costs no new parsing anywhere. It maps each of the chart's **11 articulations** onto a physical
target: position, how it is struck, which limb can reach it.

The decisive detail: **the M0 consumer is tolerant.** The sticking solver only needs *relative*
distances — is the ride further from the snare than the hat is — so rough numbers are enough to
get R/L right. Precision only starts to matter in M6, when a stick has to visibly land on a
drum. Ship a plausible default, get the annotations working, refine when there is something to
look at.

**Consequences:**

- **Articulation → position is many-to-one, and that exposes a gap.** Closed hat, open hat and
  hat pedal share one position, so the difference between them is *not* positional — it is
  **instrument state**. The config can say where the hat is but not how open it is. → **D3.**
- **Verify how the app is served before choosing the path.** The app reads `song.toml` over HTTP
  from `songs/`, and `app/` is the Vite root while `kit.toml` would sit above it. Put `kit.toml`
  wherever `song.toml` already resolves from, or add the `fs.allow` entry deliberately — this is
  a five-minute check, not a design question, but it will bite on day one of M0 otherwise.
- **State a unit convention once and never again** — proposed: centimetres, origin at the kick
  drum centre, +Y away from the stool. Arbitrary, but it has to be written down somewhere.
- **`kit.toml` will grow a `[body]` section** (arm and leg lengths). Those numbers are used by
  the sticking cost model for reach *and* by v2's IK rig for bone lengths — the same convergence
  as the geometry itself. One source, two consumers, again.

### C2 — What can a headless check actually assert about an avatar?

The repo's testing culture is numeric invariants, not screenshots: `check-sync.mjs` asserts the
bar↔time round trip within 15 ms in both directions for every bar; `check-mix.mjs` asserts stem
drift at two rates. There is no visual regression anywhere, and adding one would be a new kind
of thing to maintain.

**Answer: (a) — assert the transform stream; smoke-test the render.**

The motion solver is a pure function (hits, sticking, kit) → transforms over time, so a check
asserts: **at every hit time the assigned limb's tip is within ε of that instrument's surface**;
no limb exceeds a maximum speed; no two limbs occupy the same space; every hit has exactly one
limb. Zero pixels. Separately, one smoke test that the scene renders without throwing.

It matches the repo exactly, and it turns B1's teaching requirement into a machine-checkable
invariant: *"contact exactly on the beat"* stops being a design intention and becomes an
assertion that fails when it stops being true. It is the payoff for B2's separation — the solver
is testable **because** it does not touch the renderer.

**Consequences:**

- **The motion solver must not import Three.js.** It emits plain `{pos, quat}` numbers, not
  `THREE.Vector3`. That keeps it importable from a plain Node script with **no browser at all** —
  stronger and far faster than the existing Playwright checks, and the first test in this repo
  that needs neither audio nor a GPU.
- **Beware the tautological assertion.** If the sticking solver enforces a maximum limb speed
  using constant `K`, and the test asserts limb speed ≤ `K`, the test proves nothing but that
  the code ran. The assertions that carry real weight are the ones the solver does **not**
  enforce directly — above all *tip on the surface at the hit time*, which is a property of the
  motion model rather than of the assignment.
- **ε needs a value and it is a design statement, not a tolerance.** "Within 2 cm of the head"
  and "within 2 mm" are different claims about what the avatar promises.

### C3 — Does the avatar become a second kind of M5 export?

M5 exports your phone video, your SD3 audio and the notation overlay — proof you played it. But
once a 3D surface exists, the same exporter could render the **avatar** instead of the phone
video: your audio, the notation, and a clean visualisation of the part. No phone, no room
recording, no onset-envelope alignment.

**Answer: (a) — yes, two artifact kinds.**

The real cover (phone video, your audio, notation — **proof you played it**) and the avatar
render (your audio, notation, a clean **illustration of the part**). Nearly free once both exist.
Replacing the phone flow entirely was tempting because it deletes the hardest part of M5, but it
abandons the one property the parent vision actually asked for: an avatar cannot prove you played
anything.

**Consequences:**

- **The M5 exporter must be surface-agnostic**, which is the same seam A3 already created. Three
  surfaces now — nothing, the 3D canvas, your cover video — and the exporter takes any of them.
  Write it that way from the start in M5, before the second surface exists.
- **The avatar export is the *easy* export**, and that is worth remembering if M5 goes badly.
  Frame-stepping a canvas is deterministic; frame-stepping a decoder and seeking it is where the
  archived Phase 7 expected trouble. If the video path proves painful, the canvas path is the
  one that would have proved the ffmpeg machinery first — a reason to revisit the M5/M6 order
  rather than to fight the decoder.
- **The two kinds must be visually distinguishable at a glance**, or an illustration will
  eventually get shared as if it were proof. Not a hard problem — but decide it when building,
  not after.

### C4 — What is v2: the body, and the "good shots"?

Your words: *"later we can add a body with a head to the hands with sticks and change the camera
around for a good shot or a fixed list of good shots."*

**Answer: (a) — a stylised body, with named shots beside the kit config.**

Two-bone IK arms and legs on a simple torso and head — recognisably a drummer, no facial detail,
no individually rigged fingers — plus three to five named cameras. B3 already made the shots half
nearly free: a shot is another named camera in the system that already draws the foot inset.

**The tension worth keeping in view:** a body is *presentation*, affordances are *pedagogy*.
Telegraphing the next hit and colour-coding which hand are what make the avatar **teach** rather
than merely depict, they are cheap, and they belong in **v1** — which is why they are D1 below
rather than an alternative to the body.

**Consequences:**

- **Shots live in `kit.toml` as `[shot.*]` tables**, alongside the geometry — both are global,
  neither is per-song. Assumed; flag if shots should be per-song instead (they would then need
  to survive a kit change, which is a worse problem than it sounds).
- **v2's IK bone lengths are the same numbers as the solver's reach model** — the `[body]`
  section from C1. If they ever disagree, the avatar will visibly strain for a drum the solver
  believed was comfortable, which is a good bug to have made structurally impossible.
- **Two shots already exist before v2 does**: top-down and the foot inset. v2 adds entries; it
  does not add a system.

---

## 8. Round 4 — asked and answered. **The last round.**

### D1 — What does the avatar do to actually *teach*?

B1's prep-lift telegraphs **when** a hit is coming. It does not telegraph **where** — a lift
looks identical regardless of destination until the downstroke commits, which is far too late to
follow. That gap is exactly what an affordance fills.

**Answer: (a) — hand colour-coding plus a next-hit target highlight.**

Left and right are visually distinct (the feet a matching pair), and the pad about to be struck
glows a beat ahead. Two cheap additions filling the two gaps the stroke model leaves: *which
hand* and *which drum*. Motion trails were rejected as the tempting-then-regretted option — at
16th-note hi-hat speed they smear into a solid band that hides the strokes they were meant to
clarify — and a ghost preview means two sets of sticks on screen.

**Consequences:**

- **The highlight needs lookahead**, exactly like B1's prep-lift and D4's idle pose. Three
  separate features now require "what happens next", which confirms the precomputed motion
  timeline as the central abstraction rather than an optimisation.
- **Colour identity has to survive v2.** When the body arrives (C4) and hands gain sleeves, the
  left/right colour must live on the stick or the glove, not on a bare forearm that is about to
  be covered up.
- **Two colour systems will share one screen, and they must not collide.** The notation sits
  directly below the avatar and Q11 already spends colour on verdicts — missed, extra, wrong
  voice, early, late. If "left hand" and "played early" are the same hue, both displays get
  harder to read at once. **Pick the avatar's two hand colours out of whatever the heatmap
  palette does not use.**

### D2 — What does the sticking cost model actually contain, and how is it tuned?

A2 chose a minimum-effort solver but not what "effort" means. This is where the solver is right
or wrong in practice.

**Answer: (a) — three soft terms over one hard constraint.**

**Hard:** a move is **infeasible** above the limb's maximum speed — those paths are excluded, not
penalised. **Soft:** travel distance weighted by available time; a **crossover penalty**; a
**same-hand-repeat penalty** at speed, so fills alternate the way a drummer would. Weights live
in `kit.toml`, editable without a rebuild.

**Feasibility is physics and belongs in the constraint; preference is taste and belongs in the
weights.** Mixing them means a bad weight can produce impossible motion — the one failure mode
that must not be reachable.

**The tuning loop is already scheduled:** B4 ships R/L letters under the notation in M0, so you
read the letters, see whether they are what you would play, and change a weight. Without that
there is no way to judge a sticking solver except by watching 3D that will not exist for five
more milestones.

**Consequences:**

- **The solver can now legitimately fail**, and that failure is a *feature*. If no feasible
  assignment exists, the passage is physically unplayable — which happens, because nothing stops
  you writing MIDI in Ableton that no human can play. **The sticking solver is therefore also a
  playability checker for the chart**, and it should say *which bar* rather than throwing.
- **`kit.toml` is becoming the global config**, not merely a kit description: geometry, `[body]`
  reach, `[shot.*]` cameras, and now solver weights. That is fine — they are all properties of
  you-and-your-kit rather than of a song — but the name undersells it and the file deserves a
  header comment saying so.
- **Weights are tuned against one song today.** There is exactly one song in the repo, so early
  weights will be overfitted to it. Expect to revisit them at song two, and do not treat the
  first set as settled.

### D3 — How is hi-hat openness modelled? It is *state*, not a hit.

C1 exposed this: closed hat, open hat and hat pedal share one position, so the difference between
them is not positional. The hat's openness is controlled by the **left foot**, and the chart
implies it rather than stating it — `hihat_open` means the foot was up *at that moment*,
`hihat_closed` means it was down, and `hihat_pedal` is an explicit chick with no hand involved.

**Answer: (a) — derive a continuous foot-state track, precomputed like sticking.**

Default foot down; lift before each `hihat_open` and return after; `hihat_pedal` notes are
explicit closures. The cymbals visibly separate **and the left foot moves to cause it**. It is
the same shape of problem as sticking — deriving a hidden variable the chart implies but never
states — so it belongs beside it, computed once and frozen.

**This is the strongest justification for the foot inset.** Hi-hat foot technique is precisely
what a top-down view of the hands cannot show, and it is the most commonly mislearned part of a
groove. The inset stops being a nice-to-have and becomes the view that teaches the thing nothing
else can.

**The hi-hat is the only instrument in the 11-articulation vocabulary with state.** Ride bell
versus bow is position; chokes are not in the vocabulary at all. One special case, not the first
of many.

**Consequences:**

- **It lives beside sticking in the same lock file**, since both are hidden variables derived
  from the same chart and invalidated by the same `chartHash`. Assumed; the file is then less
  "sticking" than "the performance the chart implies", and may deserve the broader name.
- **Foot state and pedal notes can contradict each other**, and that contradiction is a chart
  error worth reporting: an `hihat_open` simultaneous with a `hihat_pedal` says the foot is up
  and down at the same instant. Like D2's infeasible passages, **the deriver doubles as a
  validator** — and both should name the bar.
- **Lookahead again.** Lifting *before* the open note is the fourth feature requiring knowledge
  of what comes next.

### D4 — What does the avatar do when nothing is being played?

`grid.lock.json` carries `count_in_bars`, and real songs have long rests where a limb does nothing
for bars at a time. Something has to be on screen.

**Answer: (a) — an idle-ready pose with anticipation.**

Each limb rests in a neutral ready position **over its next instrument**, and lifts into
readiness on the beat before it plays. Explicitly no idle motion of any other kind. A limb parked
over its next instrument **is itself an affordance** — it telegraphs an entry several bars ahead,
which is the single hardest thing to read off notation. Idle animation was rejected as actively
harmful: motion carrying no information trains you to stop reading motion, which is the one thing
this whole feature depends on you doing.

**Adopted aside:** the parent plan's Q17 made four stick hits on a pad before the count-in a
recording habit. The avatar performs those during the count-in bars, teaching the ritual for free.

**Consequences:**

- **"Over its next instrument" needs a drift time**, and it is a tunable with no obvious default.
  Too early and it commits before the music does; too late and the telegraph is worthless.
  **Assumed: drift begins one bar ahead. Flag if that should scale with tempo.**
- **Lookahead, a fourth time.** Every open behavioural question in this file resolved to "the
  solver must know what is coming", which retroactively justifies B1's precomputed-timeline
  conclusion far better than B1 alone did.
- **Idle is not a special case in the rig** — a ready pose is just another end-effector transform,
  so B2's abstraction absorbs it without a mode flag.

---

## 9. Ground rules carried into this work

Same as [`practice-plan.md`](practice-plan.md) §11. The one that will bite here:
**do not write files containing alphaTex or backslash-heavy content through a shell heredoc.**
Shader source has the same hazard.
