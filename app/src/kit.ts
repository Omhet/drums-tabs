// The written notes, sounded: a drum part booked on the audio clock.
//
// `click.ts` is a timeline of beats; this is a timeline of notes, and it is
// deliberately the same shape -- same lookahead scheduler, same bus, same
// `load / rewind / book / forget`, driven from the same place in the mixer. A
// kit and a click that were scheduled differently could disagree about when a
// bar starts, and disagreeing about that is the one thing neither is allowed
// to do.
//
// **This is a seam, not a feature.** Today's bank is twelve one-shots baked out
// of alphaTab's bundled soundfont (scripts/bake-kit.mjs). Replacing it with a
// real sampler means another `Kit`, and nothing else in the app changes -- the
// notes it is handed, the clock it books against and the gain it plays through
// are all already someone else's decision.
//
// `onNote` exists for the same reason: something has to be able to say "right
// hand, ride, 96, now" out loud, in time, for a thing that draws. That is the
// avatar's whole input, and it is defined here before the avatar exists so
// that the sound and the picture can never be reading two different timelines.
import type { ExpectedNote } from './chart';

/** How far ahead of the wall clock notes are booked, in seconds. */
const LOOKAHEAD_S = 0.1;
/** A note this late is still played; later ones are skipped in silence. */
const LATE_S = 0.03;

/** A note as it is booked, with the moment it will actually sound. */
export interface PlayedNote extends ExpectedNote {
  /** When it sounds, on the AudioContext clock, in seconds. */
  when: number;
}

export interface Kit {
  /** The whole part, in time order. Set once per arm; the same every rep. */
  load(notes: readonly ExpectedNote[]): void;
  /** Drop what is booked and continue from `mixNow` (seconds) next time. */
  rewind(mixNow: number): void;
  /** Book the notes that fall within the lookahead of `mixNow` at `rate`. */
  book(mixNow: number, rate: number): void;
  /** Silence every note that has not sounded yet. */
  forget(): void;
  /** Told about each note as it is booked, until the returned function is called. */
  onNote(fn: (note: PlayedNote) => void): () => void;
}

/** The files `scripts/bake-kit.mjs` writes, one per articulation. */
const SAMPLE_URLS = import.meta.glob('../../kit/samples/*.wav', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

interface Booked {
  source: AudioBufferSourceNode;
  gain: GainNode;
  ends: number;
}

/**
 * A bank of one-shots, one per instrument.
 *
 * Buffers are fetched once and kept; an instrument with no sample is silent
 * rather than an error, because a chart may name a cowbell the bank has never
 * heard of and that is a thing to notice, not a thing to stop playing over.
 */
export class SampleKit implements Kit {
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly missing = new Set<string>();
  private notes: readonly ExpectedNote[] = [];
  /** Index into `notes` of the next one to book. */
  private next = 0;
  private booked: Booked[] = [];
  private readonly listeners = new Set<(note: PlayedNote) => void>();
  private loading: Promise<void> | undefined;

  constructor(
    private readonly ctx: AudioContext,
    readonly out: GainNode
  ) {}

  /**
   * Fetch and decode the bank. Safe to call again; only the first one works.
   *
   * Not awaited by anything that plays: a note whose buffer has not arrived is
   * skipped, and the bank is a few hundred kilobytes off localhost, so the
   * only thing that can miss is the first bar of the first exercise of a
   * session.
   */
  ready(): Promise<void> {
    this.loading ??= (async () => {
      await Promise.all(
        Object.entries(SAMPLE_URLS).map(async ([path, url]) => {
          const name = path.split('/').pop()?.replace(/\.wav$/, '') ?? '';
          try {
            const bytes = await (await fetch(url)).arrayBuffer();
            this.buffers.set(name, await this.ctx.decodeAudioData(bytes));
          } catch {
            this.missing.add(name);
          }
        })
      );
    })();
    return this.loading;
  }

  /** Instruments the chart asks for that the bank cannot play. */
  unplayable(notes: readonly ExpectedNote[]): string[] {
    const names = new Set<string>();
    for (const note of notes) if (!this.buffers.has(note.instrument)) names.add(note.instrument);
    return [...names].sort();
  }

  load(notes: readonly ExpectedNote[]) {
    this.forget();
    // Time order, because `book` walks it forwards and stops at the first note
    // past the lookahead. `expectedNotes` already sorts, but a kit that only
    // works on a sorted array should say so by sorting.
    this.notes = [...notes].sort((a, b) => a.tMs - b.tMs);
    this.next = 0;
  }

  rewind(mixNow: number) {
    this.forget();
    const at = mixNow * 1000;
    let lo = 0;
    let hi = this.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid]!.tMs < at) lo = mid + 1;
      else hi = mid;
    }
    this.next = lo;
  }

  book(mixNow: number, rate: number) {
    const now = this.ctx.currentTime;
    while (this.next < this.notes.length) {
      const note = this.notes[this.next]!;
      const when = now + (note.tMs / 1000 - mixNow) / rate;
      if (when > now + LOOKAHEAD_S) break;
      if (when >= now - LATE_S) this.strike(note, Math.max(when, now));
      this.next++;
    }
    this.booked = this.booked.filter((b) => b.ends > now);
  }

  forget() {
    for (const b of this.booked) {
      try {
        b.source.stop();
      } catch {
        /* already stopped */
      }
      b.source.disconnect();
      b.gain.disconnect();
    }
    this.booked = [];
  }

  onNote(fn: (note: PlayedNote) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private strike(note: ExpectedNote, when: number) {
    // Said whether or not it sounds: a drum the bank cannot play is still a
    // note that was played, and a picture of it should still move.
    for (const fn of this.listeners) fn({ ...note, when });
    const buffer = this.buffers.get(note.instrument);
    if (!buffer) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    // Velocity as written, 1-127, squared: loudness is not linear in amplitude
    // and a chart's ghost notes at 30 would otherwise sit a quarter as loud as
    // an accent instead of a sixteenth.
    const v = Math.max(1, Math.min(127, note.velocity)) / 127;
    gain.gain.setValueAtTime(v * v, when);
    source.connect(gain).connect(this.out);
    source.start(when);
    this.booked.push({ source, gain, ends: when + buffer.duration });
  }
}
