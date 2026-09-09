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
  `htdemucs_ft` is the first separation model (see the Phase 1a correction — the drums RoFormer this
  originally named isn't available).
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
   │                     (htdemucs_ft, pluggable)  nodrums.wav  (play along to this)
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
| Fetch | `yt-dlp` + `ffmpeg` | **Stereo 44.1k, highest-bitrate `bestaudio`.** Grab the video too — needed for the overlay. Needs `--js-runtimes node`: YouTube now requires a JS runtime to solve player challenges, and without one formats resolve but downloads 403 |
| Python | `uv`, Python 3.11, **one env per tool** | Avoids torch/numpy/numba pin fights between tools |
| Separation | **`htdemucs_ft`** via `audio-separator`; pluggable | See the note below — the drums RoFormer this plan assumed does not exist in `audio-separator`'s registry |
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

**Percussion in alphaTex (verified against alphaTab 1.8.4, Phase 0).** The syntax is not what the
"articulation numbers" framing suggested:

- A percussion track needs **both** `\instrument percussion` **and** `\articulation defaults`.
  Without the second line the articulation table is empty and every note is rejected.
- Notes are written as **quoted articulation names** — `"snare (hit)".8`. A bare `38.8` is parsed as
  *fret 38, string 4* and rejected with "Wrong note kind 'Fretted' for staff with note kind
  'Articulation'". So numbers are not usable in alphaTex percussion at all.
- Chords group with parens: `("kick (hit) 2" "hi-hat (closed)").8`.
- Metadata takes parenthesised args: `\ts(4 4)`, not `\ts 4 4`.
- `Note.percussionArticulation` in the parsed model is an **index into `Track.percussionArticulations`**,
  built in order of first use — not a MIDI number. Don't treat it as stable across scores.
- alphaTab's names do **not** follow General MIDI. `kick (hit)` is MIDI 35 and `kick (hit) 2` is 36;
  GM calls 50 "High Tom" while alphaTab calls it "high floor tom (hit)". Since alphaTab decides the
  staff line, follow alphaTab's semantics rather than GM's.

The 94-entry table is generated from the installed build by `app/scripts/dump-articulations.mjs` into
`pipeline/data/alphatab_articulations.json`, and `pipeline/articulations.py` validates every voice
against it at emit time — an unlisted name renders as nothing rather than failing loudly, so this
check is what keeps a silent hole out of the score.

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
│   │   ├── demucs.py     # htdemucs_ft (default) + comparison checkpoints
│   │   ├── mdx.py        # MDX-Net, a different architecture to compare against
│   │   └── drumsep.py    # drums.wav → six kit stems (not a 2-way backend)
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

Note we only need a **2-way split** (drums / everything-else-for-play-along).

**Correction from Phase 1a — there is no drums RoFormer to use.** `audio-separator` 0.47's registry,
filtered by the `drums` stem, offers only Demucs v4 variants and two weak MDX-Net models. The
Mel-Band RoFormer checkpoints it ships are all vocals/instrumental separators. So the default is
`htdemucs_ft` (drums SDR 10.0, the best drums stem actually available), with `htdemucs`,
`hdemucs_mmi` and `kuielab_b_drums` registered alongside it so `compare-separation` has an
across-architecture comparison rather than only across-checkpoint. Adding a drums RoFormer when one
appears upstream is a single `register()` call in `pipeline/separation/`.

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
uv tool install beat-this       --python 3.11 --with torch --with soundfile --torch-backend=cu128
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
  grid. Both overrides fire only on positive evidence — a "correction" made on a weak signal is worse
  than none, because it fails plausibly.
- **Local octave check** (added in 1a, after observing it): the detector can also switch metrical
  level *mid-song* and switch back. A global multiplier can't express that, so stretches whose local
  median interval sits well below the song's get halved in place.
- **Trim isolated edge beats.** Beats the detector guessed over a silent intro, seconds apart with
  nothing between them, are not beats. Edges only — the same gap mid-song is a breakdown.
- **Force constant meter** — 4/4 with one global downbeat phase from the modal offset, rather than
  trusting per-bar downbeats. A single spurious 3-beat bar destroys everything after it. `--meter` and
  `--regrid` are the escape hatches.
- **Trim the count-in as an offset, never a cut** (see the invariant below): bar 1 is the first downbeat
  at or before the first kick/snare.
- Emit a **grid inspector PNG** (waveform + beat/downbeat grid) and a beat click track.

Validate on ~5 real songs before moving on. (Done on nine — see the Phase 1a status section.)

**1b. Thin end-to-end slice.** Deliberately crude: 3 classes only (kick 36 / snare 38 / closed hat 42),
straight 16ths, no open-hat or tom detection. drumsep → SuperFlux onsets → beat-phase quantize →
`song.alphatex` → renders and plays in alphaTab with a tempo slider and metronome, Vite HMR reloading
on save.

The slice exists to prove the **emitter** — the rest/voice machinery is the real risk, not the DSP.
Done when `drums all <url>` gives a recognisable, playable transcription. (Done on all nine songs —
see the Phase 1b status section.)

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

- ~~Exact drumsep model identifier~~ — `MDX23C-DrumSep-aufr33-jarredou.ckpt` (MDXC; kick, snare,
  toms, hh, ride, crash).
- ~~Which kick articulation sits on the conventional staff line~~ — **`kick (hit)`, MIDI 35.**
  alphaTab reports a `staffLine` per articulation (1 is the top line, counting down through lines
  *and* spaces), and 35 is on line 8 — the F4 space, where the bass drum has sat since the drum key
  was standardised — while `kick (hit) 2` (36) is a step higher on the G4 line. General MIDI numbers
  them the other way round, so following GM here would have put every kick in the wrong place.
  Confirmed by rendering. Same dump settles the rest of the kit: hi-hat −1, crash −2, china −3,
  ride 0, high tom 2, snare 3, mid tom 4, low tom 5, pedal hi-hat 9.
- ~~Precise alphaTex percussion syntax~~ — resolved in Phase 0, see the percussion section above.

## Phase 3 status: detection slice complete (arbitration, velocity, per-slot thresholds)

Taken **before Phase 2**, on purpose. Every remaining Phase 2 item — subdivision Viterbi, swing
detection, ghost classification, flam collapse — consumes the note list, so tuning notation against a
note list full of phantoms would have meant tuning it twice.

**`drums score-stats` is the scoreboard**, and it exists because the Phase 1b sign-off was done on
snap error, which cannot see this class of defect: a phantom hit snaps to a slot just as neatly as a
real one. The new measure is *local self-consistency* — for every note, how often the same
(slot, instrument) occurs in the ±4 neighbouring non-empty bars. Under 0.2 makes it a **one-off**;
a slot over 0.8 that a bar lacks is a **dropout**. The two pull against each other, which is what
makes them a scoreboard rather than a target: detect nothing and one-offs vanish, detect everything
and dropouts do. `--save` and `--compare` make a before/after a diff instead of a retyped table.

**Results on all nine songs.** One-offs down by a fifth to a half, dropouts flat:

| | notes | one-off % | dropout % |
|---|---|---|---|
| kick | 2605 → 2513 | 7.6 → **5.7** | 2.9 → 3.0 |
| snare | 1997 → 1707 | 14.1 → **11.0** | 3.0 → 3.0 |
| hi-hat | 4474 → 3991 | 4.6 → **2.5** | 5.8 → 5.8 |

Snap error did not regress anywhere, which was the constraint: it improved on eight songs and was
unchanged on the ninth. The worst median went 12.5 → 11.7 ms and the worst p90 36.2 → 31.4 ms.

Quiet snares sharing a slot with a kick — the Phase 1b headline defect — went from 13.9% of snare
notes to **5.5%**, and to zero on Engel, Karma Police and Starburster. Across Stayin' Alive's 104
bars the beat-1 and beat-3 snares fell from 48 and 42 to 4 and 17, with the backbeat untouched at
104 and 104. Engel's fell from 29 and 24 to 2 and 0, its backbeat untouched at 79 and 83. Distinct bar
patterns fell where the repetition was real (Engel 74 → 62, Karma Police 40 → 24, Starburster
37 → 16) and stayed put on the Vulfpeck tune (70 → 69), which is the song that genuinely does not
repeat.

**What the three changes are:**

- **Share, the measurement everything else rests on.** For each candidate: what fraction of the whole
  kit's energy in this band, at this moment, is in this stem? A real snare owns its band; a kick's
  shadow in the snare stem is a slice of a band the kick stem owns. It is comparable *between* stems
  because every share is a fraction of the same `drums.wav`, which is what the winner-take-all rule
  needs and what nothing in Phase 1b had. It also identifies an unplayed stem for free: in a song
  with no ride, the ride stem still yields 800 peaks and they sit at a share of 0.01.
- **Cross-stem winner-take-all**, clustering within 25 ms, keeping a stem only above 0.35 of the best
  share among drums it could be confused with, with tighter asymmetric ratios along the leaky pairs
  (kick into snare and toms, crash into hi-hat and ride, snare into toms). Ratios are fitted per song
  from *isolated* hits of the victim drum — the ones that occur with no suppressor anywhere near
  them, where it is unarguably itself — and clamped to [0.25, 0.60]. **Be aware the fit binds at the
  ceiling on seven of the nine songs**, so most of the time the clamp is what decides and the
  calibration is doing nothing. Where it does fire it fires in the useful direction: it *relaxes*
  kick-into-snare to 0.40 on Stayin' Alive and 0.43 on kill me, whose lone snares are themselves
  murky, rather than holding them to a bar their real snares could not clear. Fitting a ratio per
  song is worth keeping for that, but the honest summary is that a well-chosen constant does most of
  this job.
- **Velocity from post-onset band RMS**, normalised to the instrument's own 95th percentile, replacing
  flux peak height.
- **Per-slot adaptive thresholds** replacing the single 0.15/0.12 velocity floor. The floor slides
  from 0.32 at a slot no neighbouring bar plays to 0.02 at one they all do, squared so that support
  buys leniency quickly. Nothing here can *add* a note, and anything above 0.45 velocity is exempt
  from context entirely, so fills and section changes pass untouched.

**Four things the measurements said that the design did not:**

- **Velocity cannot do the anti-artefact job that flux peak height was doing.** A kick's pitch
  envelope drops as it decays and makes a second flux peak 60-90 ms behind the hit. That artefact is
  *loud* — the drum is still ringing through it — so no measure of level will ever reject it. Judging
  kicks on RMS alone added 64% more kicks to one song and took its p90 snap error from 24 ms to 40,
  the extra notes landing between the slots. Attack (relative flux height) and velocity (relative
  level) are now separate numbers answering separate questions, and both are kept per candidate.
- **Winner-take-all across the whole kit is wrong, because share is a fraction of a band.** A kick
  owning its 30-120 Hz says nothing about whether a hi-hat sounded at 8 kHz. Applied kit-wide the
  rule deleted 32 real hi-hats from Stayin' Alive's beats 2 and 4, where the snare's crack band is
  loud and dilutes the hat's share of the top end. It now applies only within a confusion group —
  heads together, cymbals together.
- **A confidence test on who may *vote* for a slot backfires, whatever the test.** By loudness, in
  sixteenth funk almost every hi-hat sits below any fixed line, so nothing voted, no slot looked
  supported, and the whole part fell through the strict floor: 716 notes to 315 on the Vulfpeck tune.
  By share, where a drum is systematically masked — dead horse plays its hi-hat on the backbeat under
  the snare, every bar — masking pushes the share below the line, the slot is never established, and
  every masked hit is cut: 32 of its 48 backbeat hi-hats. Both tests removed exactly the notes that
  most needed protecting. Every arbitration survivor votes now, which is safe *because* arbitration
  ran first: systematic bleed is the only phantom that could vote itself into existence, and
  systematic bleed is what arbitration removes.
- **Velocity is a linear amplitude ratio, so a dynamic part spans an enormous range of it.** Half the
  Vulfpeck hi-hats sit below a quarter of the loudest — that is what sixteenth funk sounds like, not
  a detector failing — where Stayin' Alive's sit at two thirds. A floor that is mild for one is
  brutal for the other, which is why the supported end of the band is as low as 0.02.

**Tried and rejected: PLAN's rolling median + k·MAD adaptive threshold.** Measured at k = 1 and k = 2
over a 1.5 s window on three songs, it changed *nothing* — not one note on any of them. librosa's
peak-picker already requires each peak to stand above a rolling local mean, and every peak that
survives that also clears a median plus two MADs. The threshold it was meant to replace is no longer
absolute either: every floor in the detector is now relative to a per-song percentile, which is the
problem the MAD threshold existed to solve. Left out.

**Known residuals:**

- **The Vulfpeck tune is the one song that got worse** on the metric: its hi-hat one-offs went 2.5% →
  5.0% and the part thinned from 716 notes to 618. Its hats are genuinely ghosted sixteenths at 20 dB
  below the accents, and the velocity floor takes the bottom off them. Every other song improved. If
  it needs fixing, the direction is a local rather than global velocity reference, not a lower floor.
- **The one-off rate is now partly self-referential.** The per-slot threshold uses the same
  neighbouring-bar idea the scoreboard grades with, so improving it is not entirely independent
  evidence. Mitigated three ways and worth remembering rather than trusting blindly: the detector
  looks ±3 bars where the metric looks ±4; arbitration and the velocity change improved the number
  before any per-slot logic existed; and the dropout rate, the snap error and the quiet-snare-on-kick
  rate are all uncoupled from it and all moved the right way. This is why the notation was checked by
  looking.
- **Toms, ride and crash are detected but still not notated.** They now earn their keep as evidence,
  which is a change of role rather than of scope: emitting them still needs the classification work
  (which tom, open or closed hat) that Phase 3 has not done.
- **19% of notes were in ghost territory and all notated full-weight; it is 16% now.** Still Phase 2's
  job — velocity is trustworthy enough to classify on, which was the point of changing it.

---

## Phase 1b status: complete

`drums all <url>` now goes from a YouTube URL to a playable score. The new stages are `kit`
(drumsep splits `drums.wav` into six per-drum stems), `transcribe` (per-stem SuperFlux onsets ->
beat-phase quantize -> `score.json`) and `emit` (`score.json` -> `song.alphatex`), plus per-instrument
onset click tracks in `debug/`. The app has a song picker, loads `songs/*/song.alphatex` straight
from disk, and re-renders when one is saved.

**Ran on all nine songs.** Snap error — how far the played hits sat from the slots they were
assigned — is the number that says whether the grid and the phase quantization actually work:

| song | bars | kick/bar | snare/bar | hat/bar | snap median | p90 | empty bars |
|---|---|---|---|---|---|---|---|
| Stayin' Alive | 104 | 3.95 | 3.07 | 7.90 | 9.3 ms | 26.0 | 0 |
| Song 2 | 66 | 3.82 | 2.33 | 3.56 | 10.8 ms | 27.6 | 0 |
| Engel | 97 | 3.43 | 2.79 | 6.25 | 9.2 ms | 25.3 | 2 |
| Beggin' | 105 | 3.07 | 3.37 | 5.01 | 12.5 ms | 30.0 | 6 |
| 1612 | 72 | 5.93 | 4.00 | 9.94 | 11.2 ms | 32.7 | 1 |
| dead horse | 68 | 4.09 | 2.88 | 8.37 | 10.7 ms | 31.9 | 0 |
| kill me | 62 | 2.68 | 2.53 | 4.02 | 8.6 ms | 24.4 | 4 |
| Karma Police | 77 | 2.52 | 1.83 | 5.79 | 11.8 ms | 36.2 | 10 |
| Starburster | 83 | 2.67 | 1.41 | 3.67 | 9.6 ms | 25.9 | 29 |

Median snap error is 9-13 ms everywhere and the p90 is 24-36 ms, against a sixteenth that is 94 ms
at 160 BPM and 175 at 86. Nothing is landing near a slot boundary, which is what "the grid is right
and phase quantization works" looks like as a number. Stayin' Alive's kick came out as 411 notes,
102/101/101/101 across the four quarters: four on the floor, for 104 bars, with no drift.

The empty bars are real. In Starburster the 29 empty bars are contiguous runs where the drum stem's
median RMS is 0.00008 against 0.12 in the played bars — the drummer has stopped, the detector
hasn't failed.

**What the validation exposed:**

- **Peak-picking a single-drum stem finds about three times what was played.** A kick's pitch
  envelope drops as it decays, and that movement makes its own flux peak 60-90 ms after the hit.
  On the first song this produced 13.4 kicks per bar, only 29% of them on a quarter. The fix is a
  *relative* velocity floor -- a peak below 15% of how hard that drum is hit elsewhere in the same
  song is not a hit -- which took it to 4.0 per bar, 99% on a quarter, and the song's snap error
  from 13.7 ms to 9.3. Same-slot merges dropped from 204 to 2, which is the same fact seen from the
  quantizer's side. An absolute threshold cannot do this job: the artefacts scale with the hit that
  caused them.
- **alphaTab draws secondary voices at 40% grey**, which is right for a guitar counter-melody and
  wrong for drums -- it made every kick look like an editorial suggestion. `secondaryGlyphColor` is
  now black; stems down already distinguishes the feet.
- **Vite's watcher only covers its root**, so a newly transcribed song never appeared in the picker
  and saving a score changed nothing on screen until the dev server was restarted. `songs/` is now
  explicitly added to the watcher.
- **Dynamics are noise until they carry information.** Every note is forte at this stage, so the
  emitter writes `\hidedynamics`; Phase 2 removes that line when ghosts and accents arrive.

**Known residuals, all Phase 2/3 work by design:**

- **Three classes means loud sections look sparse.** No toms, ride or crash, so Song 2's chorus --
  played almost entirely on cymbals -- reads as 3.56 hits per bar. The stems for all six drums are
  already split and on disk; only the detection and classification are missing.
- ~~**Snare bleed is the biggest quality defect.**~~ **Fixed** by the Phase 3 detection slice below.
  Between 2% and 24% of snare notes were quiet ones landing on a slot that also had a kick (Stayin'
  Alive 24%, Beggin' and Engel 16-19%, Starburster 2%). Some were real kick-snare unisons, but the
  pattern -- half-velocity snares on beats 1 and 3 of a song whose backbeat is on 2 and 4 -- said
  most were the kick leaking into the snare stem's body band. Cross-stem arbitration took it to
  5.5% overall, and to zero on Engel and Karma Police.
- **Straight sixteenths flatten shuffles.** Quantizing hits per beat, dead horse puts 23% of its
  notes on the last sixteenth of a beat against 7% on the first -- the signature of a swung eighth
  landing near 0.67 and rounding to 0.75. It notates as sixteenth hash, which is exactly the case
  Phase 2's swing detection is meant to catch. The straight songs are symmetric (Song 2: 61% / 0% /
  39% / 0%), so the measurement separates the two cleanly.
- **A count-in bar is bar 1.** Where a drummer counts off on the snare, bar 1 is four snare quarter
  notes. That follows from Phase 1a's rule (bar 1 is the first downbeat at or before the first
  kick/snare) and from the "offset, never a cut" invariant, so it is left alone.

**Also worth knowing:** `drumsep` (MDX23C, the only per-drum splitter in `audio-separator`'s
registry) takes about a minute per song on the 5090 and all six stems get written even though three
of them are unused today -- re-running the split later to get the stems that were skipped would be
minutes wasted for nothing. And the headless smoke test now presses play and reads the transport
position back: a score that renders but does not play used to pass.

---

## Phase 1a status: complete

Validated on nine drum covers, chosen to span the failure modes: straight rock, metal with a silent
intro, fast punk, a hi-hat count-in, half-time and shuffle feels, disco, and two groove tunes.
Every grid was checked by looking at its inspector PNG.

**Results.** All nine landed on the correct tempo — the four with independently known values check
out exactly (Stayin' Alive 103.4, Karma Police 75.0, Song 2 130.4, Beggin' 136.4) — and all nine on
the correct downbeat phase, confirmed against the per-beat-of-bar profile: kick on 1, snare on 2 and
4. Tempo drift is under 6% everywhere and under 2% on seven of nine. `beat_this` needed no global
octave override on any of them.

**Four defects the validation exposed, all now fixed and covered by tests:**

- **A local tempo octave error.** `beat_this` tracked one cover at 167 BPM for 43 seconds of an
  88 BPM song — a third of the track, silently, with the rest correct. A global multiplier cannot
  express that, so `repair_local_octave` finds stretches whose local median interval is well under
  the song's, sustained long enough to be a section rather than a fill, and halves them in phase with
  the surrounding grid. This took that song from 97% tempo drift to 5.6%, and its backbeat margin
  from 0.60 to 0.86. Assume this is common on drum covers, not exotic.
- **Spectral flux on a dB scale rewards quiet noise.** `power_to_db` puts silence at the floor, so a
  barely-audible sound in an intro produces a *larger* flux than a real hit does in a chorus. A level
  gate now weights flux by the band's absolute level. This raised the backbeat margin on every song.
- **Counting envelope frames is not counting hits.** The "is the drummer actually playing here" test
  counted frames above threshold, so one loud transient smeared across five frames looked like a
  burst of playing, and put bar 1 on it. It peak-picks first now.
- **The detector guesses beats over silent intros.** Two or three beats seconds apart, with nothing
  between them, became bars 1 and 2. `trim_isolated_edges` drops beats separated from the body of the
  song by a gap — at the edges only, since the same gap mid-song is a breakdown.

**Known residual.** In the song with the double-time stretch, 8 intervals of 291 remain 1.4-1.5x wide,
at the boundary where the detector itself was flip-flopping between metrical levels. Those bars have a
stretched beat. It is logged in `grid.lock.json` and visible in the inspector's tempo panel rather
than silent, and `--tempo-multiplier` / `--regrid` are the escape hatches.

**What the inspector PNG shows,** in the order it answers questions: tempo per beat across the song
(an octave error is a flat line in the wrong place, a dropped beat is a spike, a real tempo change is
a slope); mean kick and snare strength per beat of the bar (the downbeat-phase evidence); every onset's
position within the bar plotted against bar number (drift shows as a diagonal smear long before it is
audible); the full repair log as text, so the image is self-contained; and four zoom strips of the drum
stem with the grid drawn over it, taken from the start, two thirds through, and the very end.

The click track is verified sample-accurate against the grid, not just eyeballed.

**Also worth knowing:** `beat_this` installs without any audio decoder and dies on its first file with
three import errors and a generic "Could not load audio" — CUDA checks all pass first. `drums doctor`
now has an audio-i/o check per tool env, and is at 11 checks.

---

## Phase 0 status: complete

Verified on this machine, not assumed:

- `drums doctor` passes all 10 checks. torch 2.11.0+cu128 in both tool envs, **sm_120 matmul actually
  executing on the 5090** — the check runs a real CUDA kernel rather than trusting `is_available()`.
- onnxruntime 1.29.0 exposes `CUDAExecutionProvider` (needed for `audio-separator`'s ONNX models).
- Driver env is Python 3.11.14 in `.venv`; the system 3.12.10 was never touched.
- `app` builds clean (`vite build` bundles the alphaTab worker + worklet) and typechecks clean.
- A 4-bar drum groove parses to a percussion staff via the alphaTex importer.

Known wrinkle for future sessions: writing `.mjs`/`.ts` files containing alphaTex through a shell
heredoc silently collapses `\\` to `\`, turning `\title` into a TAB. Keep alphaTex in `.alphatex`
files and load it with `?raw`; write JS/TS with an editor tool, not a heredoc.
