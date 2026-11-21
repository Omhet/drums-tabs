// A metronome synthesised on the beat map.
//
// Every beat the drummer played is booked as a short sine blip on the Web
// Audio clock, converted from mix time: a beat `d` seconds ahead in the mix
// is `d / rate` seconds ahead on the wall. The mixer calls `book` every
// 25 ms (a lookahead scheduler: audio is scheduled a little ahead of time so
// timer jitter never reaches the ear) and `forget` on pause and seek, so a
// booked blip never sounds at a moment the video has left.

/** How far ahead of the wall clock beats are booked, in seconds. */
const LOOKAHEAD_S = 0.1;
/** A beat this late is still played; later ones are skipped in silence. */
const LATE_S = 0.03;
const BLIP_S = 0.05;

interface Booked {
  osc: OscillatorNode;
  env: GainNode;
  ends: number;
}

export class Click {
  /** Mix time of every beat, in seconds, ascending. */
  private beats: number[] = [];
  private accent = (_beat: number): boolean => false;
  /** Index into `beats` of the next beat to book. */
  private next = 0;
  private booked: Booked[] = [];

  private readonly ctx: AudioContext;
  readonly out: GainNode;

  // Spelled out rather than as parameter properties, which Node's type
  // stripping refuses: loop.ts imports this, and its arithmetic is tested
  // under plain `node --test` (scripts/test-loop.mjs).
  constructor(ctx: AudioContext, out: GainNode) {
    this.ctx = ctx;
    this.out = out;
  }

  /** `accent(i)` says whether beat `i` is the first of a bar. */
  load(beats: number[], accent: (beat: number) => boolean) {
    this.forget();
    this.beats = beats;
    this.accent = accent;
    this.next = 0;
  }

  /** Drop what is booked and continue from `mixNow` (seconds) next time. */
  rewind(mixNow: number) {
    this.forget();
    let lo = 0;
    let hi = this.beats.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.beats[mid]! < mixNow) lo = mid + 1;
      else hi = mid;
    }
    this.next = lo;
  }

  /** Book the beats that fall within the lookahead of `mixNow` at `rate`. */
  book(mixNow: number, rate: number) {
    const now = this.ctx.currentTime;
    while (this.next < this.beats.length) {
      const beat = this.beats[this.next]!;
      const when = now + (beat - mixNow) / rate;
      if (when > now + LOOKAHEAD_S) break;
      if (when >= now - LATE_S) this.blip(Math.max(when, now), this.accent(this.next));
      this.next++;
    }
    // Let go of blips that have sounded, so `forget` only stops live ones.
    this.booked = this.booked.filter((b) => b.ends > now);
  }

  /** Silence every blip that has not sounded yet. */
  forget() {
    for (const b of this.booked) {
      try {
        b.osc.stop();
      } catch {
        /* already stopped */
      }
      b.osc.disconnect();
      b.env.disconnect();
    }
    this.booked = [];
  }

  private blip(when: number, accent: boolean) {
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = accent ? 1760 : 1175;
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(accent ? 1 : 0.7, when + 0.001);
    env.gain.exponentialRampToValueAtTime(0.001, when + BLIP_S * 0.8);
    env.gain.setValueAtTime(0, when + BLIP_S);
    osc.connect(env).connect(this.out);
    osc.start(when);
    osc.stop(when + BLIP_S);
    this.booked.push({ osc, env, ends: when + BLIP_S });
  }
}

/** A count-in under way: what it resolves to, and the way to call it off. */
export interface CountIn {
  /**
   * True at the moment the music should start, false if it was called off.
   * The beat after the last click is where the music lands.
   */
  readonly done: Promise<boolean>;
  cancel(): void;
}

/**
 * A count-in as the page shows it (main.ts, the 1 2 3 4 in the header): the
 * clicks' own times on the audio clock, so the numbers are lit by the clicks
 * as booked rather than by a timer of their own that could drift from them.
 */
export interface CountInShown {
  ctx: AudioContext;
  /** When the first click sounds, in `ctx` time. */
  first: number;
  beatS: number;
  beats: number;
  done: Promise<boolean>;
}

let shown: ((c: CountInShown) => void) | undefined;

/** Be told of every count-in as it starts: a loop's, one from a pause, Record's. */
export function watchCountIns(fn: (c: CountInShown) => void) {
  shown = fn;
}

/**
 * Click for `beats` beats with nothing else moving, then say when to go.
 *
 * Both the clicks and the song go through the same audio graph, so they reach
 * the speakers with the same delay and nothing has to be corrected for. A Click
 * of its own rather than the beat-map one in the mixer: that one follows the
 * clock, and through a count-in the clock is parked.
 */
export function countIn(ctx: AudioContext, out: GainNode, beatS: number, beats: number): CountIn {
  if (beatS <= 0 || beats <= 0) return { done: Promise.resolve(true), cancel: () => {} };
  const click = new Click(ctx, out);
  click.load(
    Array.from({ length: beats }, (_, i) => i * beatS),
    (beat) => beat === 0
  );
  // A moment's grace so the first click is not clipped by the scheduler.
  const first = ctx.currentTime + 0.25;
  const music = first + beats * beatS;
  let pump = 0;
  let timer = 0;
  let settle: (go: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => {
    settle = (go) => {
      clearInterval(pump);
      clearTimeout(timer);
      if (!go) click.forget();
      resolve(go);
    };
    pump = window.setInterval(() => click.book(ctx.currentTime - first, 1), 25);
    timer = window.setTimeout(() => settle(true), Math.max(0, (music - ctx.currentTime) * 1000));
  });
  shown?.({ ctx, first, beatS, beats, done });
  return { done, cancel: () => settle(false) };
}
