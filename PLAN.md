# drums-tabs — YouTube → drum tabs → practice player

## Context

Learning drums on a Roland kit, working through Drumeo, and learning songs from YouTube videos of
other drummers. The blocker: most of those videos have no tabs. Transcribing by ear for every song is
slow, and there's no good way to study a part at reduced tempo with a click.

This builds a local, personal tool that takes a YouTube URL and produces a readable drum score you can
play in a Guitar-Pro-style player: proper notation, a moving playhead, adjustable tempo, a drum
sampler, and a metronome. Notes stay hand-tunable in a text file, because no automatic transcription
will be perfect and fixing 5% by hand beats fighting a GUI.

Later: overlay that notation on a video — 4 bars at a time, playhead sweeping, jumping to the next 4.

**Decisions made:**
- **Runs entirely on the Windows machine with the RTX 5090**, which is also where the kit is. No file
  syncing, no LAN serving, no dual-platform support burden.
- Thin end-to-end slice first, then deepen.
- Text-file note editing first; in-browser Monaco editor later.
- Pluggable transcription **and** separation backends, so models can be swapped and compared.
  RoFormer is the first separation model.
- Live in-browser video overlay first; MP4 export later.

### Build here, on the GPU box

The implementation happens on the 5090 machine itself. Not for code-portability reasons — the
cross-platform habits that matter (`pathlib`, arg-list `subprocess`, no `shell=True`) are just good
Python and cost nothing either way. The reason is the **verify gap**: authoring anywhere else means
writing the DSP blind.

Phase 1a needs the grid validated against five real songs by *looking* at inspector PNGs, and Phase 3
is a tune-and-listen loop on onset thresholds. Both are worthless without being able to run the thing
and inspect output. Building where the GPU, the audio and the kit already are collapses author, run
and verify into one place.

Windows-only is an explicit simplification, not a constraint: no macOS fallbacks, no MPS paths, no
dual dependency setup.

---

## Architecture

Two halves joined by files on disk. No server, no database.

```
YouTube URL
   │  yt-dlp (bestaudio + video) + ffmpeg
   ▼
mix.wav (STEREO 44.1k) ── separation backend ──► drums.wav
   │                       (RoFormer, pluggable)  nodrums.wav  (play along to this)
   │
   ├── beat_this ──► beats ──► GRID REPAIR ──► grid.lock.json  ◄── THE KEYSTONE
   │
   └── drums.wav ──► drumsep (6 stems) ──► kick/snare/toms/hihat/ride/crash
                                                │
                              band-limited SuperFlux onsets, gated on drums.wav
                                                │
                                  quantize by beat phase → bars
                                                ▼
                     score.json ──► song.alphatex + drums.mid + sync.json
                                                │
                                                ▼
                                  Vite + alphaTab player in the browser
```

### The load-bearing idea: one beat map, two jobs

The repaired beat grid is used for **both**:

1. **Quantization.** Onsets snap by *beat phase* — for an onset at `t` between beats `b_k` and
   `b_{k+1}`, snap `phi = (t - b_k)/(b_{k+1} - b_k)` to the bar's subdivision. Drift-immune by
   construction.
2. **alphaTab sync points.** The score declares one clean tempo, but the cursor follows the real audio
   through sync points derived from the same beat times.

This is why the score can look clean while tracking a performance that breathes.

**Why not a single global BPM:** at 160 BPM over 4 minutes, a 0.3% tempo error accumulates to ~0.7 s —
half a beat by the outro, so notes flip to the wrong 16th in the back half of every song. Quantizing
per beat is non-negotiable.

---

## Stack

| Layer | Choice | Notes |
|---|---|---|
| OS / compute | Windows + **RTX 5090 (CUDA)** | Every model stage runs on GPU |
| Fetch | `yt-dlp` + `ffmpeg` | **Stereo 44.1k, highest-bitrate `bestaudio`.** Grab the video too — needed for the overlay |
| Python | `uv`, Python 3.11, **one env per tool** | Avoids torch/numpy/numba pin fights between tools |
| Separation | **Mel-Band RoFormer drums model** via `audio-separator`; pluggable | Beats BS-RoFormer specifically on drums; ~1.3 dB SDR over htdemucs |
| Per-drum stems | **drumsep** 6-stem (MDX23C) | kick/snare/toms/hihat/ride/crash |
| Beat/downbeat | **`beat_this`** (`--gpu=0`) | pip `beat-this`, CLI `beat_this`, outputs `.beats` TSV |
| Onsets | `librosa` + `scipy`, SuperFlux per stem | Deterministic and debuggable |
| Notation + player | **alphaTab `^1.8.4`** | `latest` on npm. *Not* 1.9.0 — that's alpha-only |
| App shell | Vite + TS + `@coderline/alphatab-vite` | The official plugin handles soundfont/font/worklet assets — hand-rolling those paths is the most common alphaTab setup failure |
| Video export (later) | Playwright frame-stepping + ffmpeg | Deterministic frames beat screen recording |

**Do not install `madmom`.** Effectively unmaintained, doesn't build cleanly on Python >=3.10, and
pins `numpy<2`, which fights torch. `beat_this` covers beats/downbeats; librosa+scipy covers onsets.

**Separate `uv` environment per tool** (`uv tool install`), driven by a thin orchestrator that shells
out and passes file paths. The stages already communicate through files, so coupling is loose. uv
hardlinks from a shared cache, so the several-GB torch install isn't duplicated on disk.

### The one Blackwell gotcha

sm_120 has been supported in stable CUDA wheels since torch 2.7 (current PyPI torch is 2.14), so the
alarming "no kernel image is available" threads are stale 2025 artifacts. The live risk is different:
**pip's default index can hand you a CPU-only build on Windows, and letting demucs/audio-separator
resolve torch themselves can quietly clobber a good install.** So in every env, install torch
explicitly from the CUDA index *first*, then the tool, and verify before trusting it:

```
python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_capability())"
# expect: 2.x.y True (12, 0)
```

Make that check a `drums doctor` subcommand so a silent CPU fallback shows up as a failed check rather
than a pipeline that's mysteriously 30x slower.

### Why alphaTab decides most of this

A Guitar-Pro-grade engine that already ships nearly everything the player needs: native percussion
notation with correct noteheads, an SF2/SF3 synth with playback cursor (the "drum sampler" is a
swappable soundfont), metronome, count-in, `playbackSpeed`, looping, and the `alphaTex` text language —
which *is* the hand-editing story, so there's no editor to build.

Two features settle the hard parts outright:
- **Backing-track sync (1.6+):** sync points plus `IExternalMediaHandler` (`seekTo`/`play`/`pause`/
  `playbackRate`; app calls `updatePosition()` ~every 50 ms) drive the cursor from an HTML `<video>`.
- **`@coderline/alphatab-monaco`** + an alphaTex language server, so the in-browser editor is wiring.

**Articulation numbers.** alphaTab resolves percussion as *number -> articulation -> staff line +
notehead* using Guitar Pro's table. For the common kit these coincide with GM (36 kick, 38 snare,
42/46/44 hats, 48/47/45/43 toms, 49 crash, 51 ride), so MIDI and notation share one number space — but
the table also holds non-GM entries (91 rimshot, 92 half-open hat), and **an unlisted number renders as
nothing rather than falling back**. Generate the mapping from alphaTab's own defaults and validate
every number at emit time.

**Two constraints to design around:**
- alphaTab can't mix its synth with a backing track -> the player needs two explicit modes.
- Its metronome is part of the synth, so **in play-along mode you generate the click yourself** in Web
  Audio. Silver lining: schedule it from *measured* beat times, so it stays glued to the audio even
  where the grid drifts — better than what alphaTab would give you.

---

## Repo layout

```
drums-tabs/
├── PLAN.md               # this file
├── pipeline/
│   ├── cli.py            # typer: doctor/fetch/separate/beats/transcribe/emit/audit/compare/diff/all
│   ├── fetch.py          # yt-dlp + ffmpeg → mix.wav (stereo) + video.mp4
│   ├── separation/
│   │   ├── base.py       # audio → (drums.wav, nodrums.wav)
│   │   ├── roformer.py   # default
│   │   └── demucs.py     # fallback / comparison
│   ├── grid.py           # * beat-grid repair + grid.lock.json — highest-risk module
│   ├── backends/
│   │   ├── base.py       # audio → list[OnsetEvent{t, instrument, velocity, confidence}]
│   │   ├── stems.py      # v1: drumsep + per-stem SuperFlux
│   │   └── adtof.py      # ML backend, same protocol
│   ├── onsets.py         # band-limited SuperFlux, gating, cross-stem arbitration
│   ├── classify.py       # hat open/closed (GMM), toms via F0, dynamics
│   ├── quantize.py       # beat-phase snap, per-bar grid Viterbi, flam/roll/ghost collapse
│   ├── emit_alphatex.py  # * 2-voice metric-tree rests, articulation validation
│   ├── emit_midi.py      # quantized + raw-onset MIDI
│   ├── edits.py          # apply edits.yaml ops; --from-alphatex diff-back
│   └── audit.py          # grid PNG, per-8-bar spectrogram overlay, click tracks
├── app/src/
│   ├── player.ts         # alphaTab bootstrap
│   ├── transport.ts      # play/pause/tempo/loop/count-in
│   ├── metronome.ts      # Web Audio click (play-along) / alphaTab (study)
│   ├── sync.ts           # IExternalMediaHandler + rAF cursor extrapolation
│   └── overlay/          # 4-bar horizontal windowing over video
├── songs/<slug>/         # git-init'd per song
└── soundfonts/
```

### Pluggable models

Separation and transcription both sit behind a one-function interface, selected by a config field and
overridable per-song in `song.toml`. Two comparison commands make swapping models a decision made with
evidence rather than vibes:

- `drums compare-separation <slug> --models roformer,htdemucs,scnet` — runs each, writes drum stems
  side by side plus A/B click tracks.
- `drums compare-backends <slug> --backends stems,adtof` — emits both scores for the same grid, plus a
  note-level diff.

On a 5090 both are minutes, not hours, which is what makes "compare properly" realistic rather than
aspirational. Worth reading before investing in the ML backend: arXiv **2509.24853**, *Enhanced
Automatic Drum Transcription via Drum Stem Source Separation* — it studies exactly this hybrid.

Note we only need a **2-way split** (drums / everything-else-for-play-along), so a drum-specific
RoFormer is both better *and* faster than a full 4-stem demucs pass.

### Artifacts and how hand edits survive re-runs

| File | Owner | Regenerated? |
|---|---|---|
| `analysis.json` | machine | yes — cache-keyed on (video id, pipeline version, model versions) |
| `grid.lock.json` | machine, then **pinned** | only with `--regrid` |
| `edits.yaml` | **you** | never written by the pipeline |
| `score.json`, `song.alphatex`, `drums.mid`, `sync.json` | machine | yes, deterministically |

`grid.lock.json` is the keystone: it pins beat times, downbeat phase, meter and bar count. **Every
edit-preservation scheme dies the moment the pipeline decides the intro is one bar longer**, so once a
grid is accepted, re-runs reuse it and bar indices stay stable.

`edits.yaml` is an ordered list of bar-scoped ops — `{op: add, bar: 17, voice: 0, pos: "3/4", art: 46}`,
`remove`, `retype`, `set_grid`, plus `replace_bar` (raw alphaTex escape hatch) and `freeze_bars`. Ops
beat a frozen hand-edited file: improving the onset detector then fixes the 180 bars you haven't
touched while preserving the 12 you have.

The ergonomic that makes this painless: edit `song.alphatex` directly, then run
`drums edits --from-alphatex`, which diffs your file against the generated one and **writes the
difference into `edits.yaml` as ops**. You edit notation; the tool persists durable ops.

`git init` each song directory — `git diff song.alphatex` then shows exactly what a pipeline change
moved.

---

## Phase 0 — Environment

Already present on this machine: ffmpeg 8.1.1, yt-dlp 2026.03.17, uv 0.9.22, Node 24.14.0, git 2.50.0,
RTX 5090 (driver 591.86, 32 GB). The CUDA Toolkit is *not* needed separately — torch wheels bundle
their own CUDA runtime.

```
uv python install 3.11
# in each tool env: CUDA torch FIRST, from the CUDA index, then the tool
uv tool install audio-separator --python 3.11 --with torch --torch-backend=cu128
uv tool install beat-this       --python 3.11 --with torch --torch-backend=cu128
uv init --python 3.11    # driver env: librosa scipy numpy soundfile mido typer rich matplotlib pyyaml
npm create vite@latest app -- --template vanilla-ts
npm i @coderline/alphatab@^1.8.4 @coderline/alphatab-vite
```

Then `drums doctor` — verifies ffmpeg/yt-dlp on PATH, CUDA visible, compute capability `(12, 0)`, and
each tool env importing a CUDA-enabled torch.

## Phase 1 — Grid first, then a thin slice

**Nothing downstream matters until the grid is right**, so build and validate it before transcription.

**1a. Fetch → separate → beats → grid inspector.** Run `beat_this --gpu=0`, then repair the grid:
- Median-filter beat intervals; dt ~ 2x median -> insert a beat, ~ 0.5x -> drop one.
- **Octave/phase check.** `beat_this` can lock to half or double tempo on drum covers. Cross-check
  against the snare: in most rock/pop covers snares sit on 2 and 4. If they land on 1 and 3, rotate the
  downbeat phase by one beat; if snare autocorrelation implies twice the detected beat rate, double the
  grid.
- **Force constant meter** — 4/4 with one global downbeat phase from the modal offset, rather than
  trusting per-bar downbeats. A single spurious 3-beat bar destroys everything after it. `--meter` and
  `--regrid` are the escape hatches.
- **Trim the count-in as an offset, never a cut** (see the invariant below): bar 1 is the first downbeat
  at or before the first kick/snare.
- Emit a **grid inspector PNG** (waveform + beat/downbeat grid) and a beat click track.

Validate on ~5 real songs before moving on.

**1b. Thin end-to-end slice.** Deliberately crude: 3 classes only (kick 36 / snare 38 / closed hat 42),
straight 16ths, no open-hat or tom detection. drumsep → SuperFlux onsets → beat-phase quantize →
`song.alphatex` → renders and plays in alphaTab with a tempo slider and metronome, Vite HMR reloading
on save.

The slice exists to prove the **emitter** — the rest/voice machinery is the real risk, not the DSP.
Done when `drums all <url>` gives a recognisable, playable transcription.

## Phase 2 — Notation correctness

Where the subtle bugs live.

- **Rest and duration generation is the #1 bug source.** With two voices you must fill *both* voices in
  *every* bar to exactly the bar duration. Use a metric-tree splitter: divide the bar half → beat →
  subdivision, merging rests only *within* a level, so no rest straddles beats 2–3. One pure function
  with property tests: durations sum to bar length; nothing crosses the midpoint unless it starts there.
  Keep it free of audio and I/O so it can be tested without running the pipeline.
- **Exactly 2 voices.** Voice 0 = hands (cymbals, snare, toms, stems up), voice 1 = feet (kick, hi-hat
  pedal, stems down). GP convention, renders correctly. Don't attempt 3–4.
- **Same-slot dedup is mandatory.** Two onsets on one instrument closer than the grid resolution (a 16th
  at 160 BPM is 94 ms) both snap to one slot and emit a duplicate note.
- **Per-bar subdivision via Viterbi.** Candidates `{16th, 8th-triplet, 16th-triplet}`, 32nds opt-in.
  Cost = velocity-weighted snap error + complexity penalty, with a transition penalty across bars so the
  score doesn't flip between straight and triplet every other bar. Never mix straight and triplet within
  a beat.
- **Swing detection** — ~30 lines, big readability payoff. If offbeat 8ths cluster around phi ~ 0.60–0.68
  across the song, notate straight 8ths plus a swing marking instead of triplet hash.
- **Collapse, don't transcribe:** flams (two same-instrument onsets <45 ms apart) → one note with a flam
  flag; buzz rolls (>=4 snare onsets in a 16th) → one note plus a roll marking.
- **Ghost notes are a velocity flag, not rhythm** — below ~35% of the bar's snare max. If a ghost is the
  only thing forcing a bar to 32nds, drop it. Readability beats completeness.
- **Three dynamic levels only** (ghost / normal / accent). Continuous velocity is visual noise.
- **No automatic repeat detection.** Repeats break the linear bar→time mapping that sync points and the
  4-bar window depend on. Write every bar out.

## Phase 3 — Transcription quality

Build the debug artifacts *first*; without them, threshold tuning is guesswork. This is the loop you'll
live in, and it's the phase the 5090 transforms — a full re-run is seconds, so it's genuinely
interactive.

- **Audit output:** per-8-bar spectrogram PNGs with beat grid, raw onsets, accepted onsets and quantized
  positions overlaid; per-instrument click tracks mixed against the drum stem so you can *hear* a false
  positive; and **two MIDI files** — quantized and raw-onset — whose diff against the audio in a DAW is
  how you debug quantization.
- **Gate on the parent drums stem** — reject any per-stem candidate with no local maximum in
  `drums.wav`'s onset envelope within +/-25 ms. Cheapest, highest-value trick; implement it first.
- **Band-limited SuperFlux per stem**, not full-band (kick 30–120 Hz, snare 150–400 Hz + 2–6 kHz, toms
  80–350 Hz, hats 5–12 kHz, ride 3–10 kHz, crash 2–8 kHz). SuperFlux specifically suppresses false
  positives on decaying broadband content — i.e. cymbal wash, the main enemy.
- **Cross-stem winner-take-all:** cluster candidates within +/-20–25 ms; keep a stem only if its
  normalized strength is >= ~0.35 of the cluster max, with physically-motivated asymmetries (kick
  suppresses floor tom, crash suppresses hats and ride, snare suppresses toms). Calibrate ratios from
  isolated events in that song.
- **Post-crash relaxing threshold:** after accepting a crash, decay a threshold boost on
  crash/hat/ride over ~600 ms.
- **Adaptive thresholds** (rolling median + k*MAD over 1–2 s). Absolute thresholds don't survive a
  compressed YouTube mix.
- **Min IOI:** kick 55 ms, snare 40 ms, hats 35 ms, toms 60 ms. Drop a kick onset <80 ms after a strong
  one at <40% velocity — beater bounce, not a note.
- **Velocity from post-onset band RMS**, not flux peak height (contaminated by bleed); normalize to the
  per-instrument 95th percentile.
- **Toms via F0, not spectral centroid** — toms are pitched, and centroid conflates pitch with EQ and
  bleed. Run pYIN on the tom stem, cluster fundamentals (k=1..3 by silhouette), order by pitch.
- **Hats via a per-song 2-cluster GMM** on (decay time, HF ratio). Kits and mixes vary far more between
  songs than open-vs-closed does within one. **Skip pedal hi-hat (44) in v1** — essentially undetectable
  after separation, and false pedal notes actively mislead.

Quality ceiling to keep in mind: drumsep sees separation output, not real drums, and YouTube Opus at
128 kbps already smears cymbals. That's a hard limit on hi-hat/ride/crash discrimination — hence
`edits.yaml`. RoFormer raises this ceiling relative to htdemucs, which is exactly where it matters.

## Phase 4 — Practice player

Two explicit modes, because alphaTab can't mix synth and backing audio:

- **Study mode.** alphaTab's synth plays the transcribed part from a dedicated drum SF2 (its bundled GM
  kit is mediocre), with its own metronome and count-in. Tempo via `playbackSpeed`. Bar-range looping.
- **Play-along mode.** An `HTMLMediaElement` plays `nodrums.wav` (drumless — you supply the drums) or
  the full mix. alphaTab runs in external-media mode and only moves the cursor, driven by our
  `IExternalMediaHandler` and sync points. Tempo via `preservesPitch = true` + `playbackRate`. **Our own
  Web Audio metronome**, scheduled from measured beat times scaled by rate, rescheduled on rate change
  and seek.

Caveat on `preservesPitch`: the browser's WSOLA-class stretcher smears transients — at 0.7x a snare gets
mushy. Fine for v1; if it bothers you, pre-render slowed stems offline with rubberband
(`ffmpeg -af rubberband=tempo=0.75`) at fixed speeds — cheap on this machine.

## Phase 5 — In-browser editing

Split pane with `@coderline/alphatab-monaco` + the alphaTex language server: highlighting, articulation
autocomplete, live re-render, save back to `song.alphatex` through a small Vite dev-server endpoint,
then `--from-alphatex` to persist ops. Purely additive — editing the file in an editor keeps working.

## Phase 6 — Live video overlay

- **Horizontal layout with our own 4-bar windowing**, not `barsPerRow` in page layout. Compute window
  offsets from `BoundsLookup` and translate in steps. Same page-flip behaviour, but avoids the bug class
  where a resize re-flows systems and window boundaries silently stop matching bars — and x(t) becomes
  strictly monotone instead of jumping backwards at every system break.
- **Play the local video file** `yt-dlp` already downloaded, not the YouTube IFrame player (~250 ms-
  granular time, fixed discrete rate set, seek weirdness). A real `HTMLMediaElement` gives arbitrary
  rate and precise `currentTime` — and you can mute it and play the drumless stem on the same timeline.
- **Smoothness comes from rAF, not faster polling.** Don't read `currentTime` every frame (jittery):
  run a `requestAnimationFrame` loop extrapolating from the last known media time plus wall-clock delta
  x rate, resyncing every ~200–500 ms.
- **On "linear":** a playhead over engraved notation can't be exactly linear in time — a bar of rests
  occupies far less width per second than a bar of 16ths. The standard approach (alphaTab's own) lerps
  between beat x-positions by elapsed beat fraction: smooth within a beat, slight slope changes at beat
  boundaries. For typical drum grooves the note density is uniform enough that this reads as linear. If
  it ever bothers you, the fix is a piano-roll renderer, not engraved notation.
- Use the **SVG renderer and keep alphaTab's partial-render chunks as separate absolutely-positioned
  nodes** — browsers cap a single canvas at ~32767 px and a 200-bar horizontal score blows past it.
- Theme via `display.resources` (staff lines, noteheads, bar numbers) for light-on-dark over video,
  rather than CSS-filtering the SVG.
- Recompute window offsets on every `renderFinished` — resize invalidates `BoundsLookup`.

## Phase 7 — Video export

Playwright loads the overlay page and seeks frame by frame (deterministic, no dropped frames),
screenshots each, then ffmpeg assembles and muxes audio. Reuses all the Phase 6 layout code. NVENC
makes the encode step trivial on this machine.

---

## Pipeline invariant

**Never trim audio, only offset.** The moment you trim silence off `mix.wav`, video/stem/sync-point
alignment silently breaks. Count-in handling is a bar-index offset in `grid.lock.json`, never a cut.

## Verification

**Fast unit tests (no audio, no GPU — run on every change):** property tests on the metric-tree rest
generator (durations sum to bar length; no rest straddles the midpoint); articulation-number validation
against alphaTab's defaults; quantization math against synthetic onset fixtures; alphaTex emitter
snapshot tests. Keeping this logic pure is what makes the notation layer debuggable without a 3-minute
pipeline run in the loop.

**Full pipeline (needs CUDA + real audio):**
- `drums doctor` first — a silent CPU fallback should fail a check, not just be slow.
- **Grid:** inspector PNG plus a beat click track against the mix — validate on 5 songs before anything
  downstream. A wrong downbeat phase makes every bar unusable.
- **Onsets:** per-instrument click tracks are the primary check — play them against the drum stem and
  listen for missed or phantom hits.
- **Sync:** in play-along mode the cursor must stay locked through a full song — end-of-song drift
  means the grid or sync points are wrong.
- **End-to-end:** two contrasting songs — a straight-8ths rock groove (should be near-perfect) and one
  with fast double-kick and heavy cymbal work (will expose bleed and subdivision issues).

## Main risks

1. **Beat-grid errors are the single point of failure** — wrong downbeat phase or a tempo octave error
   misaligns every bar. Mitigated by grid repair, the inspector PNG, `grid.lock.json`, and `--meter` /
   `--regrid` overrides. This is why Phase 1a exists.
2. **Cymbal-stem bleed** producing phantom hi-hat/ride notes is the most likely quality complaint; the
   audit tooling exists to make it fast to diagnose.
3. **Rest/duration generation bugs** in the emitter — mitigated by property tests on one pure function.
4. **A silent CPU torch install** turning a seconds-long loop into a minutes-long one — caught by
   `drums doctor`.

## Open questions to resolve by looking, not guessing

- Exact drumsep model identifier in `audio-separator --list_models`.
- Precise alphaTex percussion syntax. The articulation *numbers* are confirmed from alphaTab's
  `PercussionMapper.ts`; the surrounding syntax (instrument declaration, chords, voices) is not.
