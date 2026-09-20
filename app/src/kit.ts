// The written notes, sounded: a drum part booked on the audio clock.
//
// `click.ts` is a timeline of beats; this is a timeline of notes, and it is
// deliberately the same shape -- same lookahead scheduler, same bus, same
// `load / rewind / book / forget`, driven from the same place in the mixer. A
// kit and a click that were scheduled differently could disagree about when a
// bar starts, and disagreeing about that is the one thing neither is allowed
// to do.
//
// **What sounds is `bank.ts`'s business; this file is about when.** The bank
// is rendered from a drum plugin by `drums kit-bake` -- velocity layers, so a
// ghost note is a different recording rather than a quiet one, and several
// takes of each, so the same hi-hat twice is two different hi-hats. That
// leaves three things for this file that a bag of one-shots never needed:
//
//   * **Choking.** An open hi-hat rings for most of a bar, and left alone it
//     rings straight through the closed hats that follow. Nothing else here
//     sounds as immediately mechanical. Which articulations cut which is
//     kit.toml's `[sampler] choke`, not a rule in this file.
//   * **A voice limit.** A song's whole chart now goes into the kit at once,
//     where this used to be handed eight bars at a time.
//   * **Somewhere to put taste.** A per-instrument trim, from
//     `[sampler.trim]`, and a limiter that should never be heard.
//
// `onNote` exists for a different reason: something has to be able to say
// "right hand, ride, 96, now" out loud, in time, for a thing that draws. That
// is the avatar's whole input, and it is defined here before the avatar exists
// so that the sound and the picture can never be reading two different
// timelines.
import type { Bank } from './bank';
import type { ExpectedNote } from './chart';

/** How far ahead of the wall clock notes are booked, in seconds. */
const LOOKAHEAD_S = 0.1;
/** A note this late is still played; later ones are skipped in silence. */
const LATE_S = 0.03;
/**
 * How long a choked voice takes to die.
 *
 * Not instant: cutting a ringing cymbal to zero in one sample is a click, and
 * a hand closing a hi-hat is not instant either.
 */
const CHOKE_S = 0.04;
/** How long a voice pushed out by the voice limit takes to die. */
const RETIRE_S = 0.02;
/** At once, per instrument and in total. Neither is reachable by real music. */
const MAX_PER_INSTRUMENT = 8;
const MAX_VOICES = 48;

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

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** What `gain` was set to, so a choke can ramp down from it. */
  level: number;
  /** Which strike this is, in the terms the choke groups are written in. */
  articulation: string;
  instrument: string;
  when: number;
  ends: number;
  stopping: boolean;
}

/**
 * A bank of recordings, booked on the audio clock.
 *
 * An instrument with no samples is silent rather than an error, because a
 * chart may name a cowbell the bank has never heard of and that is a thing to
 * notice, not a thing to stop playing over.
 */
export class SampleKit implements Kit {
  private notes: readonly ExpectedNote[] = [];
  /** Index into `notes` of the next one to book. */
  private next = 0;
  private voices: Voice[] = [];
  private readonly listeners = new Set<(note: PlayedNote) => void>();
  private readonly trims = new Map<string, GainNode>();
  private readonly bus: GainNode;

  constructor(
    private readonly ctx: AudioContext,
    readonly out: GainNode,
    /**
     * Owned by the mixer, not made here: it needs no AudioContext, so it can
     * start decoding at page load instead of waiting for the first click, and
     * the page can ask what it holds before there is a graph to hold it.
     */
    readonly bank: Bank
  ) {
    this.bus = ctx.createGain();
    // A backstop, not a sound. The bank is baked 6 dB below full scale so that
    // a crash landing on a kick and a snare still has room; this is only here
    // for the case that arithmetic did not foresee.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    this.bus.connect(limiter).connect(out);
  }

  /**
   * Fetch and decode the bank. Safe to call again; only the first one works.
   *
   * Not awaited by anything that plays: a note whose recording has not arrived
   * is skipped, and the files come off localhost.
   */
  ready(): Promise<void> {
    return this.bank.ready();
  }

  /** Instruments the chart asks for that the bank cannot play. */
  unplayable(notes: readonly ExpectedNote[]): string[] {
    return this.bank.unplayable(notes.map((n) => n.instrument));
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
    this.voices = this.voices.filter((v) => v.ends > now);
  }

  forget() {
    for (const voice of this.voices) this.kill(voice);
    this.voices = [];
  }

  onNote(fn: (note: PlayedNote) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private strike(note: ExpectedNote, when: number) {
    // Said whether or not it sounds: a drum the bank cannot play is still a
    // note that was played, and a picture of it should still move.
    for (const fn of this.listeners) fn({ ...note, when });

    const chosen = this.bank.pick(note.instrument, note.velocity);
    if (!chosen) return;

    this.choke(chosen.articulation, when);
    this.limit(note.instrument, when);

    const source = this.ctx.createBufferSource();
    source.buffer = chosen.buffer;
    const gain = this.ctx.createGain();
    // The layer already carries the loudness the plugin gave that velocity.
    // All this covers is the gap to the nearest layer -- about a decibel.
    // Squaring it here, as a one-sample-per-drum bank had to, would bury the
    // ghost notes a second time.
    gain.gain.setValueAtTime(chosen.gain, when);
    source.connect(gain).connect(this.trimFor(note.instrument));
    source.start(when);

    this.voices.push({
      source,
      gain,
      level: chosen.gain,
      articulation: chosen.articulation,
      instrument: note.instrument,
      when,
      ends: when + chosen.buffer.duration,
      stopping: false,
    });
  }

  /** One gain per instrument, from kit.toml's [sampler.trim]. */
  private trimFor(instrument: string): GainNode {
    let node = this.trims.get(instrument);
    if (!node) {
      node = this.ctx.createGain();
      node.gain.value = this.bank.trim(instrument);
      node.connect(this.bus);
      this.trims.set(instrument, node);
    }
    return node;
  }

  /**
   * Cut short whatever this strike silences -- an open hat, mostly.
   *
   * Scheduled at `when`, not at `ctx.currentTime`: notes are booked up to a
   * tenth of a second ahead, and choking at "now" would cut the open hat off
   * before the hand that closes it has landed.
   */
  private choke(articulation: string, when: number) {
    const cuts = this.bank.chokes(articulation);
    if (cuts.length === 0) return;
    for (const voice of this.voices) {
      if (voice.stopping || voice.when > when || !cuts.includes(voice.articulation)) continue;
      this.fade(voice, when, CHOKE_S);
    }
  }

  /** Keep the oldest voices from piling up. Never reached by real music. */
  private limit(instrument: string, when: number) {
    const live = this.voices.filter((v) => !v.stopping && v.ends > when);
    const same = live.filter((v) => v.instrument === instrument);
    const overs: Voice[] = [];
    if (same.length >= MAX_PER_INSTRUMENT) overs.push(...oldest(same, same.length - MAX_PER_INSTRUMENT + 1));
    if (live.length >= MAX_VOICES) overs.push(...oldest(live, live.length - MAX_VOICES + 1));
    for (const voice of overs) this.fade(voice, when, RETIRE_S);
  }

  /** Ramp a sounding voice away, from `at`, and stop it when it is gone. */
  private fade(voice: Voice, at: number, seconds: number) {
    if (voice.stopping) return;
    voice.stopping = true;
    const done = at + seconds;
    try {
      voice.gain.gain.cancelScheduledValues(at);
      voice.gain.gain.setValueAtTime(voice.level, at);
      voice.gain.gain.linearRampToValueAtTime(0, done);
      voice.source.stop(done);
    } catch {
      /* already stopped */
    }
    voice.ends = Math.min(voice.ends, done);
  }

  private kill(voice: Voice) {
    try {
      voice.source.stop();
    } catch {
      /* already stopped */
    }
    voice.source.disconnect();
    voice.gain.disconnect();
  }
}

/** The `n` voices that started earliest. */
function oldest(voices: Voice[], n: number): Voice[] {
  return [...voices].sort((a, b) => a.when - b.when).slice(0, Math.max(0, n));
}
