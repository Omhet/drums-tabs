// Which recording to play for a note, and getting them all into memory.
//
// `kit.ts` is about *when* a note sounds; this is about *what* sounds. They
// are separate because the timing is the part that must never be wrong and the
// choosing is the part that will keep changing.
//
// The bank is `drums kit-bake`'s output: several hundred files, keyed by
// articulation, each articulation holding velocity layers quietest first and
// each layer holding a few takes. Two things follow from that, and they are
// most of this file:
//
// **A layer already carries its own loudness.** The plugin applied its own
// velocity response when it rendered each one, so a quiet layer is a quieter
// *and different* recording. The old one-sample bank had to fake that with
// `(v/127)²`; doing both would bury the ghost notes twice over. All that is
// left here is the gap between the note's velocity and the nearest layer's,
// which is at most half a layer and worth about a decibel.
//
// **A take must not repeat.** The whole reason for rendering four of each is
// that a drummer does not hit the same hi-hat twice, so the choice is "any
// take but the one I just used" rather than a random index that will happily
// come up twice running.
//
// The bank is keyed by articulation although nothing upstream has more than
// one per instrument yet: `ExpectedNote` has no room for "snare, but on the
// rim", and teaching it one means moving the notation, both MIDI maps, the
// sticking solver and the scorer together. `pick` takes an articulation that
// nothing passes, so that when that day comes this file is already finished.
import { bank as MANIFEST, sampler as SAMPLER } from 'virtual:kit';

/** How many samples are fetched at once. Politeness, not a limit that matters. */
const CONCURRENCY = 8;

/**
 * How far the per-note trim may stray from the layer it picked.
 *
 * Half a layer either way. Wider would mean the layers are too far apart and
 * the answer is more of them, not more gain.
 */
const TRIM_MIN = 0.85;
const TRIM_MAX = 1.18;

export interface Pick {
  buffer: AudioBuffer;
  /** Covers the gap between the note's velocity and the layer's own. */
  gain: number;
  /** What was chosen -- the choke groups are in these terms. */
  articulation: string;
}

interface Layer {
  velocity: number;
  buffers: AudioBuffer[];
}

interface Loaded {
  name: string;
  instrument: string;
  layers: Layer[];
}

/**
 * The baked bank, or an empty one when nothing has been baked.
 *
 * Empty is not an error here. The page says so once, plainly, and everything
 * else goes on working in silence -- the cursor still moves, a take still
 * records, and the notation still draws.
 */
export class Bank {
  private readonly loaded = new Map<string, Loaded>();
  /** Instrument -> the articulation played when nothing asks for one. */
  private readonly fallback = new Map<string, string>();
  /** Articulation -> the take index used last, so the next one differs. */
  private readonly lastTake = new Map<string, number>();
  private readonly failed = new Set<string>();
  private loading: Promise<void> | undefined;

  /** Articulation -> the ringing articulations a hit on it cuts short. */
  private readonly chokeMap = new Map<string, readonly string[]>();

  constructor() {
    const ring = new Set(SAMPLER.ring);
    for (const group of SAMPLER.choke) {
      for (const member of group) {
        const cuts = group.filter((other) => ring.has(other));
        if (cuts.length) this.chokeMap.set(member, cuts);
      }
    }
  }

  /** What the bank is called, for the one line the page shows about it. */
  get name(): string {
    return MANIFEST?.name ?? '';
  }

  /** Whether `drums kit-bake` has ever run. */
  get baked(): boolean {
    return MANIFEST !== null;
  }

  /** How many recordings are in memory. */
  get size(): number {
    let n = 0;
    for (const a of this.loaded.values()) for (const l of a.layers) n += l.buffers.length;
    return n;
  }

  /** Files the manifest promised and the browser could not get. */
  get missing(): readonly string[] {
    return [...this.failed].sort();
  }

  /**
   * Fetch and decode the whole bank. Safe to call again; only the first works.
   *
   * Decoded through an `OfflineAudioContext` rather than the live one because
   * that needs no user gesture -- so the bank is already warm by the time the
   * first click builds the real graph. An `AudioBuffer` is not bound to the
   * context that decoded it, and a source node resamples on the way out if the
   * output device happens to run at 48 kHz.
   */
  ready(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    if (!MANIFEST) return;
    const rate = MANIFEST.sampleRate || 44100;
    const ctx = new OfflineAudioContext(1, 1, rate);

    const jobs: { articulation: string; layer: number; take: number; file: string }[] = [];
    for (const [name, spec] of Object.entries(MANIFEST.articulations)) {
      const shell: Loaded = {
        name,
        instrument: spec.instrument,
        layers: spec.layers.map((l) => ({ velocity: l.velocity, buffers: [] })),
      };
      this.loaded.set(name, shell);
      if (spec.default) this.fallback.set(spec.instrument, name);
      spec.layers.forEach((layer, i) =>
        layer.files.forEach((file, take) =>
          jobs.push({ articulation: name, layer: i, take, file })
        )
      );
    }

    let next = 0;
    const worker = async () => {
      for (let i = next++; i < jobs.length; i = next++) {
        const job = jobs[i]!;
        try {
          const url = `/kit/samples/${job.file.split('/').map(encodeURIComponent).join('/')}`;
          const bytes = await (await fetch(url)).arrayBuffer();
          const buffer = await ctx.decodeAudioData(bytes);
          this.loaded.get(job.articulation)!.layers[job.layer]!.buffers[job.take] = buffer;
        } catch {
          this.failed.add(job.file);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // A take that failed leaves a hole in the array, and a hole is not a
    // sample. Close them up so `pick` can index without checking.
    for (const articulation of this.loaded.values()) {
      for (const layer of articulation.layers) layer.buffers = layer.buffers.filter(Boolean);
      articulation.layers = articulation.layers.filter((l) => l.buffers.length > 0);
    }
  }

  /** Instruments in `notes` the bank cannot play a single note of. */
  unplayable(instruments: Iterable<string>): string[] {
    const names = new Set<string>();
    for (const instrument of instruments) {
      const articulation = this.fallback.get(instrument);
      if (!articulation || !this.loaded.get(articulation)?.layers.length) names.add(instrument);
    }
    return [...names].sort();
  }

  /** Which sounding articulations a hit on this one should cut short. */
  chokes(articulation: string): readonly string[] {
    return this.chokeMap.get(articulation) ?? [];
  }

  /** Per-instrument trim from kit.toml's [sampler.trim], as a linear gain. */
  trim(instrument: string): number {
    const db = SAMPLER.trim[instrument];
    return db === undefined ? 1 : 10 ** (db / 20);
  }

  /**
   * The recording to play for one note, or nothing if the bank cannot.
   *
   * `articulation` is how a caller asks for a particular strike. Nothing does
   * yet; leaving it out means "whatever this instrument's default is", which
   * is the only thing a chart can currently express.
   */
  pick(instrument: string, velocity: number, articulation?: string): Pick | undefined {
    const name = articulation ?? this.fallback.get(instrument);
    if (!name) return undefined;
    const found = this.loaded.get(name);
    if (!found || found.layers.length === 0) return undefined;

    const v = Math.max(1, Math.min(127, velocity));
    let layer = found.layers[0]!;
    for (const candidate of found.layers) {
      if (Math.abs(candidate.velocity - v) < Math.abs(layer.velocity - v)) layer = candidate;
    }

    const takes = layer.buffers;
    let index = 0;
    if (takes.length > 1) {
      // Any take but the one before it. With four takes this is a choice of
      // three, which is what keeps a run of sixteenths from pulsing.
      const previous = this.lastTake.get(name);
      index = Math.floor(Math.random() * (takes.length - (previous === undefined ? 0 : 1)));
      if (previous !== undefined && index >= previous) index += 1;
    }
    this.lastTake.set(name, index);

    const gain = Math.max(TRIM_MIN, Math.min(TRIM_MAX, v / layer.velocity));
    return { buffer: takes[index]!, gain, articulation: name };
  }
}
