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

  constructor(
    private readonly ctx: AudioContext,
    readonly out: GainNode
  ) {}

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
