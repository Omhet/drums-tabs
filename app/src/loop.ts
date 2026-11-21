// The loop: a stretch of bars played, waited on, and played again.
//
// Pick a section -- or any run of bars: a fill and the bar before it, two
// sections in a row -- turn the loop on and press Play. A bar of count-in, the
// bars, then back to the top of them, round and round until you stop it. The
// pass counter says how many times round; a bar of click between passes is a
// setting; and the ramp, when it is on, raises the tempo between passes the way
// you would by hand.
//
// It runs on the record's own clock rather than on a timeline of its own:
// every pass plays the same milliseconds of mix.wav, so one list of written
// notes marks every pass (practice.ts), and the cursor, the stems and the click
// follow it for nothing. Turning round is a pause, a short wait, a seek back
// and a play -- a paused seek is the only kind this app does.
//
// This is the loop the exercises had (`git show 5c21a14:app/src/practice.ts`,
// `endRep` and `nextRep`), lifted out of practice mode. Looping is a play-along
// feature and needs no kit; being marked on each pass is an option on top of
// it, which practice mode plugs in as a `Grader`.
import type * as alphaTab from '@coderline/alphatab';
import type { Section } from 'virtual:songs';
import { countIn, type CountIn } from './click';
import type { PlayClock } from './clock';
import { PASS } from './grade';
import type { Mixer } from './mixer';
import { barAtMs, barStartMs, type Grid } from './syncpoints';

/** Bars of click before the first pass. */
const COUNT_IN_BARS = 1;
/**
 * How long a pass stays open after the transport crosses its end, in ms. A
 * fill's last note is routinely a hair late, and it is still the note it was
 * written as -- not a very early downbeat of the next pass. Record's
 * whole-song take keeps the same margin at both of its ends (practice.ts).
 */
export const EDGE_MS = 250;
/** The tempo slider's rungs, in percent (index.html). A ramp lives on the same ones. */
export const TEMPO_MIN = 25;
export const TEMPO_MAX = 125;
export const TEMPO_STEP = 5;

/** A stretch of bars, 1-based and inclusive, the way a section is written. */
export interface LoopRange {
  startBar: number;
  endBar: number;
}

/**
 * Raise the tempo between passes: start at `from`, add `step` every `every`
 * passes, stop at `to`. All in percent of the record's tempo.
 */
export interface Ramp {
  on: boolean;
  from: number;
  step: number;
  every: number;
  to: number;
  /**
   * Count only the passes marked at `PASS` or better. Only a pass Record is
   * marking has a mark, so on a loop nobody is marking every pass counts.
   */
  gate: boolean;
}

export const DEFAULT_RAMP: Ramp = { on: false, from: 70, step: 5, every: 2, to: 100, gate: false };

/** What a song remembers of its loop (main.ts keeps one per song). */
export interface LoopMemory {
  /** The bars last looped, if any ever were. */
  range?: LoopRange;
  /** Whether the loop was on. It comes back on, but never going round. */
  on: boolean;
  ramp: Ramp;
}

// --- the arithmetic, pure and tested (scripts/test-loop.mjs) ---------------------

/** A tempo on the slider's rungs: a multiple of 5, from 25 to 125. */
export function snapTempo(percent: number): number {
  const p = Math.round(percent / TEMPO_STEP) * TEMPO_STEP;
  return Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, p));
}

/**
 * A range the loop can play, or the reason it cannot: whole bars inside the
 * notation, the right way round, and both ends placed by the beat map. A pass
 * ends where the bar after its last bar begins, so that bar needs a beat --
 * the same rule Record's whole-song take has (practice.ts `target`), and the
 * one that rules out One For The Road's bar 73.
 */
export function checkRange(grid: Grid | undefined, bars: number, r: LoopRange): LoopRange | string {
  if (!grid) return 'This song has no beat map, so nothing can be looped.';
  const startBar = Math.round(r.startBar);
  const endBar = Math.round(r.endBar);
  if (!Number.isFinite(startBar) || !Number.isFinite(endBar)) return 'A loop needs a first and a last bar.';
  if (startBar > endBar) return `Bar ${startBar} comes after bar ${endBar}: the loop is the wrong way round.`;
  if (startBar < 1 || endBar > bars) return `The song has bars 1 to ${bars}.`;
  if (barStartMs(grid, startBar - 1) === undefined) return `The beat map does not reach bar ${startBar}.`;
  if (barStartMs(grid, endBar) === undefined) {
    return `The beat map ends with bar ${endBar}, so a loop cannot come back round from it.`;
  }
  return { startBar, endBar };
}

/** `bar 23`, `bars 12-14`: hyphenated, because it also ends up in a filename. */
const barsOf = (r: LoopRange) =>
  r.startBar === r.endBar ? `bar ${r.startBar}` : `bars ${r.startBar}-${r.endBar}`;

/**
 * What a range is called: a section's own name when it is exactly one section,
 * else its bars. Names repeat (a song has three verses), so where the words
 * are all there is -- a take's `cell.section` -- the bars go beside them.
 */
export function rangeName(sections: readonly Section[], r: LoopRange): string {
  const exact = sections.find((s) => s.start_bar === r.startBar && s.end_bar === r.endBar);
  return exact?.name || barsOf(r);
}

/** The range in words for the screen: `chorus, bars 15-22` or `bars 12-14`. */
export function rangeLabel(sections: readonly Section[], r: LoopRange): string {
  const name = rangeName(sections, r);
  return name === barsOf(r) ? name : `${name}, ${barsOf(r)}`;
}

/** Whatever was stored, as a ramp the slider can play: on its rungs, the right way up. */
export function normaliseRamp(r: Partial<Ramp> | undefined): Ramp {
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const from = snapTempo(num(r?.from, DEFAULT_RAMP.from));
  const step = Math.max(
    TEMPO_STEP,
    Math.min(50, Math.round(num(r?.step, DEFAULT_RAMP.step) / TEMPO_STEP) * TEMPO_STEP)
  );
  return {
    on: r?.on === true,
    from,
    step,
    every: Math.max(1, Math.min(20, Math.round(num(r?.every, DEFAULT_RAMP.every)))),
    // A ramp goes up. One asked to go down stops where it starts.
    to: Math.max(from, snapTempo(num(r?.to, DEFAULT_RAMP.to))),
    gate: r?.gate === true,
  };
}

/**
 * Where a ramp goes after a finished pass: the tempo for the next one, and how
 * many passes have counted towards the step after that.
 *
 * It steps from the tempo actually set rather than from a schedule, so a tempo
 * nudged by hand in the middle of a loop is where the ramp carries on from.
 * `accuracy` is the pass's mark, when it had one.
 */
export function rampAfterPass(
  ramp: Ramp,
  tempo: number,
  counted: number,
  accuracy: number | undefined
): { tempo: number; counted: number } {
  if (tempo >= ramp.to) return { tempo, counted: 0 };
  const counts = !ramp.gate || accuracy === undefined || accuracy >= PASS;
  const n = counted + (counts ? 1 : 0);
  if (n < ramp.every) return { tempo, counted: n };
  return { tempo: Math.min(ramp.to, tempo + ramp.step), counted: 0 };
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
const passes = (n: number) => (n === 1 ? 'pass' : `${n} passes`);

/**
 * The ramp in words: the plan before the loop runs, and where it has got to
 * while it does -- "80% → 100%, next step after this pass".
 */
export function rampSays(
  ramp: Ramp,
  at?: { tempo: number; counted: number; marked: boolean }
): string {
  if (!at) {
    return (
      `${ramp.from}% → ${ramp.to}%, +${ramp.step}% every ${passes(ramp.every)}` +
      (ramp.gate ? ` of ${percent(PASS)} or better` : '')
    );
  }
  if (at.tempo >= ramp.to) return `${at.tempo}%, ${rampNext(ramp, at)}`;
  return `${at.tempo}% → ${ramp.to}%, ${rampNext(ramp, at)}`;
}

/**
 * Only the part of `rampSays` that changes pass to pass -- "next step after
 * this pass" -- for the line under the pass counter, where the tempo is
 * already the biggest number on the screen.
 */
export function rampNext(ramp: Ramp, at: { tempo: number; counted: number; marked: boolean }): string {
  if (at.tempo >= ramp.to) return ramp.to >= 100 ? 'ramp done: full speed' : `ramp done: ${ramp.to}%`;
  const left = ramp.every - at.counted;
  const gated = ramp.gate && at.marked;
  const when =
    left <= 1
      ? gated
        ? `after this pass, if it is ${percent(PASS)} or better`
        : 'after this pass'
      : `after ${left} passes${gated ? ` of ${percent(PASS)} or better` : ''}`;
  return `next step ${when}`;
}

/** One rung of the ramp's ladder (Lamp-04): a tempo, and where the ramp is against it. */
export interface Rung {
  tempo: number;
  /** Played (`done`), playing (`now`), the step after this (`next`), or to come. */
  state: 'done' | 'now' | 'next' | 'later';
}

/** The most rungs the controls row has room for beside the switches. */
export const LADDER_MAX = 7;

/**
 * The ramp as a ladder, `from` to `to` in its steps, marked against the tempo
 * playing -- which a hand on the tempo keys can put between two rungs, and
 * then none is `now` and the next one up is still `next`. A long ramp shows
 * the `LADDER_MAX` rungs around where it is, two already climbed where it can.
 */
export function rampLadder(ramp: Ramp, tempo: number): Rung[] {
  const values: number[] = [];
  for (let v = ramp.from; v < ramp.to; v += ramp.step) values.push(v);
  values.push(ramp.to);
  let nextSeen = false;
  const rungs = values.map((v): Rung => {
    if (v < tempo) return { tempo: v, state: 'done' };
    if (v === tempo) return { tempo: v, state: 'now' };
    if (!nextSeen) {
      nextSeen = true;
      return { tempo: v, state: 'next' };
    }
    return { tempo: v, state: 'later' };
  });
  if (rungs.length <= LADDER_MAX) return rungs;
  const at = rungs.findIndex((r) => r.state !== 'done');
  const first = Math.max(0, Math.min(rungs.length - LADDER_MAX, (at < 0 ? rungs.length : at) - 2));
  return rungs.slice(first, first + LADDER_MAX);
}

// --- the loop on the page -----------------------------------------------------------

export interface LoopElements {
  /** The Loop pill. Only painted here: what a press does is main.ts's (it opens the picker). */
  pill: HTMLButtonElement;
  /** The ramp's numbers, on the Settings page. Whether it is on is the Ramp pill's (R). */
  rampFrom: HTMLInputElement;
  rampStep: HTMLInputElement;
  rampEvery: HTMLInputElement;
  rampTo: HTMLInputElement;
  rampGate: HTMLInputElement;
}

/** What the loop asks of the page around it (main.ts). */
export interface LoopHost {
  /**
   * The tempo slider in percent, and its one setter: the slider, its readout
   * and alphaTab's playbackSpeed move together or not at all.
   */
  tempo(): number;
  setTempo(percent: number): void;
  /** A line for the status. */
  say(text: string, isError?: boolean): void;
  /** Between passes, a bar of click to come back in on (Settings); else straight back. */
  restBar(): boolean;
  /** A bar of count-in before the first pass (Settings). */
  countInFirst(): boolean;
  /** Something about the loop changed: repaint Play, remember it for this song. */
  changed(): void;
  /**
   * The loop's own controls were just repainted: anything that shows its state
   * somewhere else (the header's pass block) catches up. Cheaper and more
   * frequent than `changed` -- every pass, every count-in.
   */
  painted(): void;
  /** Whether something else has the transport: a whole-song take, or the calibration. */
  busy(): boolean;
  /** The loop's bars changed, or it went on or off: the song map and the paper redraw it. */
  drawn(): void;
}

/** Whoever marks the passes, when somebody does (practice.ts). */
export interface Grader {
  /** A pass's music starts now: strokes from here are its. */
  open(pass: number): void;
  /**
   * It is over -- `complete` if it reached its end. Returns its mark when it
   * had one, which is what a gated ramp steps on.
   */
  close(pass: number, complete: boolean): number | undefined;
  /** The loop has stopped. */
  done(): void;
}

/** The song under the loop. */
export interface LoopSong {
  sections: readonly Section[];
  grid: Grid | undefined;
  /** Bars in the notation. */
  bars: number;
}

/**
 * Where a loop going round is.
 *
 *   count-in  the bar of click before the first pass, transport parked
 *   playing   a pass: the transport running from the first bar to the end
 *   grace     parked at the end, the pass still open for a late last note
 *   rest      wound back, and the bar of click before the next pass if there is one
 */
type Phase = 'count-in' | 'playing' | 'grace' | 'rest';

interface Run {
  range: LoopRange;
  startMs: number;
  endMs: number;
  grader: Grader | undefined;
  /** The pass playing, or the last one played. 0 until the first starts. */
  pass: number;
  phase: Phase;
  /**
   * The `performance.now()` moment the transport really crossed `endMs`.
   *
   * The clock is parked from here until the next pass, so it cannot stamp a
   * stroke: one arriving in the grace window is placed from this instead.
   */
  parkedAt: number;
  /** The playback rate of the pass under way. */
  rate: number;
  /** Finished passes that have counted towards the ramp's next step. */
  counted: number;
  countIn: CountIn | undefined;
  timer: number;
  grace: number;
}

export class Loop {
  private readonly api: alphaTab.AlphaTabApi;
  private readonly clock: PlayClock;
  private readonly mixer: Mixer;
  private readonly el: LoopElements;
  private readonly host: LoopHost;
  private song: LoopSong | undefined;
  private _range: LoopRange | undefined;
  private _armed = false;
  private _ramp: Ramp = { ...DEFAULT_RAMP };
  private run: Run | undefined;
  /** A pick made while the song plays, waiting for the next bar line (`retarget`). */
  private waiting = 0;

  constructor(api: alphaTab.AlphaTabApi, clock: PlayClock, mixer: Mixer, el: LoopElements, host: LoopHost) {
    this.api = api;
    this.clock = clock;
    this.mixer = mixer;
    this.el = el;
    this.host = host;

    // Every control gives the keyboard back once it has been used: the keys
    // table ignores anything typed into a form control, so a focused checkbox
    // would take the next Space for itself.
    for (const input of [el.rampFrom, el.rampStep, el.rampEvery, el.rampTo, el.rampGate]) {
      input.addEventListener('change', () => {
        this.readRamp();
        input.blur();
      });
    }
  }

  // --- what it is set to --------------------------------------------------------

  /** Whether the loop is on: Play plays it rather than the song. */
  get armed(): boolean {
    return this._armed;
  }

  /** Whether it is going round, count-ins and turn-rounds included. */
  get running(): boolean {
    return this.run !== undefined;
  }

  /** Whether the passes going round are being marked. */
  get graded(): boolean {
    return this.run?.grader !== undefined;
  }

  /** The pass playing or last played, 0 before the first. */
  get pass(): number {
    return this.run?.pass ?? 0;
  }

  get phase(): Phase | undefined {
    return this.run?.phase;
  }

  get range(): LoopRange | undefined {
    return this._range;
  }

  get ramp(): Ramp {
    return this._ramp;
  }

  /** Where the range starts and ends in the mix, in ms. */
  get window(): { startMs: number; endMs: number } | undefined {
    const grid = this.song?.grid;
    const r = this._range;
    if (!grid || !r) return undefined;
    const startMs = barStartMs(grid, r.startBar - 1);
    const endMs = barStartMs(grid, r.endBar);
    return startMs === undefined || endMs === undefined ? undefined : { startMs, endMs };
  }

  /** The range in words, as the screen says it. */
  describe(): string {
    return this._range ? rangeLabel(this.song?.sections ?? [], this._range) : 'nothing';
  }

  /** The range as a take names it: the section, or `bars 12-14`. */
  name(): string {
    return this._range ? rangeName(this.song?.sections ?? [], this._range) : '';
  }

  /** What this song should remember: the range, whether it was on, the ramp. */
  snapshot(): LoopMemory {
    const r = this._range;
    return { range: r ? { ...r } : undefined, on: this._armed && !!r, ramp: { ...this._ramp } };
  }

  /** Repaint the rail: the tempo moved, and the ramp's readout says where from. */
  refresh() {
    this.paint();
  }

  /** Point the loop at a song, and put back what it remembered of its own loop. */
  load(song: LoopSong, memory: LoopMemory | undefined) {
    this.stop();
    this.song = song;
    this._ramp = normaliseRamp(memory?.ramp);
    const kept = memory?.range ? checkRange(song.grid, song.bars, memory.range) : undefined;
    this._range = typeof kept === 'object' ? kept : undefined;
    this._armed = typeof kept === 'object' && memory?.on === true;
    this.paint();
    this.host.drawn();
  }

  /**
   * Loop these bars: the song map's picks. It turns the loop on.
   *
   * Parked, the cursor goes to the first bar and Play starts it. Playing, the
   * music is not cut off mid-bar (`retarget`): a pick that holds the bar being
   * played becomes the loop around it, and one somewhere else starts at the
   * next bar line. A loop Record is marking is stopped: that take was of the
   * other bars.
   */
  setRange(r: LoopRange) {
    const song = this.song;
    if (!song) return;
    const fit = checkRange(song.grid, song.bars, r);
    if (typeof fit === 'string') {
      this.host.say(fit, true);
      this.paint();
      return;
    }
    if (this.host.busy()) {
      this.host.say('Stop the take first: the loop and Record cannot both have the transport.', true);
      return;
    }
    const playing = this.clock.running || (this.run !== undefined && !this.run.grader);
    if (!playing || this.run?.grader) this.stop();
    this._range = fit;
    this._armed = true;
    if (playing && !this.run?.grader) this.retarget();
    else if (!this.clock.running) this.cursorTo(fit.startBar);
    this.paint();
    this.host.drawn();
    this.host.changed();
  }

  /** Off: the L key with a loop on, the picker's Loop off, a click inside the loop. */
  off() {
    if (!this._armed) return;
    this._armed = false;
    this.stop();
    this.paint();
    this.host.drawn();
    this.host.changed();
  }

  /**
   * A new range while the music is going.
   *
   *   - parked in a loop's count-in or rest: start over on the new bars, with
   *     the count-in, since nothing is sounding to keep time with;
   *   - the bar being played is in it: carry on, and turn round at its end;
   *   - anywhere else: at the next bar line, straight into pass 1.
   */
  private retarget() {
    const r = this._range;
    const at = this.window;
    const grid = this.song?.grid;
    if (!r || !at || !grid) return;
    this.cancelWait();
    const run = this.run;
    if (run && run.phase !== 'playing') {
      this.stop(true);
      this.start();
      return;
    }
    const now = this.clock.mixTimeMs;
    if (now >= at.startMs && now < at.endMs) {
      if (run) {
        run.range = r;
        run.startMs = at.startMs;
        run.endMs = at.endMs;
      } else {
        this.begin(at, 'playing');
      }
      return;
    }
    const nextLine = barStartMs(grid, barAtMs(grid, now) + 1) ?? at.startMs;
    this.waiting = window.setInterval(() => {
      // Paused before it came: nothing to wait for. Play starts the loop.
      if (!this.clock.running && !this.run) {
        this.cancelWait();
        return;
      }
      if (this.clock.mixTimeAt(performance.now()) < nextLine) return;
      this.cancelWait();
      this.stop(true);
      const go = this.window;
      if (!go || !this._armed) return;
      // A paused seek, the only kind: the song may be playing with no loop yet.
      this.api.pause();
      if (this._ramp.on) this.host.setTempo(this._ramp.from);
      this.openPass(this.begin(go, 'count-in'));
    }, 10);
  }

  private cancelWait() {
    clearInterval(this.waiting);
    this.waiting = 0;
  }

  /**
   * A run with no count-in: `playing`, joined part way through a pass that is
   * already sounding, or `count-in` for one `openPass` is about to start.
   */
  private begin(at: { startMs: number; endMs: number }, phase: 'playing' | 'count-in'): Run {
    const run: Run = {
      range: this._range!,
      startMs: at.startMs,
      endMs: at.endMs,
      grader: undefined,
      pass: phase === 'playing' ? 1 : 0,
      phase,
      parkedAt: 0,
      rate: this.host.tempo() / 100,
      counted: 0,
      countIn: undefined,
      timer: 0,
      grace: 0,
    };
    this.run = run;
    run.timer = window.setInterval(() => this.tick(run), 25);
    if (phase === 'playing') this.host.say('');
    this.paint();
    this.host.changed();
    return run;
  }

  /** The ramp on or off: the R key and the Ramp button. The numbers stay as set. */
  toggleRamp() {
    this._ramp = { ...this._ramp, on: !this._ramp.on };
    this.paint();
    this.host.changed();
  }

  /** What the ramp will do, or where it has got to: "80% → 100%, +10% every pass". Empty when off. */
  rampSaid(): string {
    return this._ramp.on ? rampSays(this._ramp, this.rampAt()) : '';
  }

  /**
   * Where the ramp has got to, while a loop with one goes round: what
   * `rampSays` and `rampNext` read. Undefined when there is no ramp running.
   */
  rampAt(): { tempo: number; counted: number; marked: boolean } | undefined {
    const run = this.run;
    if (!run || !this._ramp.on) return undefined;
    return { tempo: this.host.tempo(), counted: run.counted, marked: !!run.grader };
  }

  private readRamp() {
    const el = this.el;
    this._ramp = normaliseRamp({
      on: this._ramp.on,
      from: Number(el.rampFrom.value),
      step: Number(el.rampStep.value),
      every: Number(el.rampEvery.value),
      to: Number(el.rampTo.value),
      gate: el.rampGate.checked,
    });
    this.paint();
    this.host.changed();
  }

  private cursorTo(bar: number) {
    const target = this.api.score?.masterBars[bar - 1];
    if (target) this.api.tickPosition = target.start;
  }

  // --- going round ----------------------------------------------------------------

  /**
   * Start going round: a bar of count-in (unless Settings turns it off), then pass 1.
   *
   * With a ramp on, at the ramp's first tempo -- "start at 70%" -- whatever
   * the slider said before. With a `grader`, every pass is marked (Record).
   */
  start(grader?: Grader): boolean {
    const song = this.song;
    const r = this._range;
    const at = this.window;
    if (!this._armed || !song?.grid || !r || !at || this.run) return false;
    this.cancelWait();
    this.mixer.ensureGraph();
    this.api.pause();
    if (this._ramp.on) this.host.setTempo(this._ramp.from);
    this.clock.seekTo(at.startMs);
    const run: Run = {
      range: r,
      startMs: at.startMs,
      endMs: at.endMs,
      grader,
      pass: 0,
      phase: 'count-in',
      parkedAt: 0,
      rate: this.host.tempo() / 100,
      counted: 0,
      countIn: undefined,
      timer: 0,
      grace: 0,
    };
    this.run = run;
    run.timer = window.setInterval(() => this.tick(run), 25);
    if (!this.host.countInFirst()) {
      // Straight in: pass 1 from its first bar, now.
      this.paint();
      this.host.changed();
      this.openPass(run);
      return true;
    }
    // Nothing on the status line: the header shows the count-in itself, as
    // 1 2 3 4 and what it leads into (main.ts `showCount`).
    this.host.say('');
    this.paint();
    this.host.changed();
    void this.countInto(run, COUNT_IN_BARS).then((go) => {
      if (go) this.openPass(run);
    });
    return true;
  }

  /**
   * Stop going round, and leave the transport parked where it is. The loop
   * stays on: Play starts it again from pass 1.
   */
  stop(quiet = false) {
    this.cancelWait();
    const run = this.run;
    if (!run) return;
    this.run = undefined;
    clearInterval(run.timer);
    clearTimeout(run.grace);
    run.countIn?.cancel();
    this.api.pause();
    // A pass stopped part way through still happened, and is closed as
    // unfinished. One that had reached its end and was only waiting out the
    // grace window is finished. Between passes there is nothing open.
    if (run.phase === 'playing') run.grader?.close(run.pass, false);
    else if (run.phase === 'grace') run.grader?.close(run.pass, true);
    run.grader?.done();
    if (!run.grader && !quiet) {
      this.host.say(run.pass ? `Loop stopped after ${run.pass === 1 ? 'one pass' : passes(run.pass)}.` : 'Loop stopped.');
    }
    this.paint();
    this.host.changed();
  }

  /**
   * alphaTab says there is no more score to play. A range that ends on the
   * last bar of the notation ends there, and alphaTab rewinds as it says so,
   * so the clock never crosses `endMs` for `tick` to see. This is that moment,
   * told rather than watched for.
   */
  reachedEnd() {
    const run = this.run;
    if (run?.phase === 'playing') this.endPass(run, performance.now());
  }

  /**
   * Where a stroke belongs in the mix, if it belongs to the pass under way.
   *
   * Playing, the clock's own stamp is right. Parked in the grace window, the
   * clock reads the end however late the stroke was, so it is placed from the
   * wall clock instead -- the fill's last note, a few milliseconds behind,
   * lands in the pass that asked for it, still as late as it was played.
   * Through a count-in or a rest it belongs to no pass at all.
   */
  placeStroke(wallMs: number, tMs: number): number | undefined {
    const run = this.run;
    if (run?.phase === 'playing') {
      return tMs >= run.startMs - EDGE_MS && tMs <= run.endMs + EDGE_MS ? tMs : undefined;
    }
    if (run?.phase === 'grace') {
      const since = wallMs - run.parkedAt;
      if (since < -EDGE_MS || since > EDGE_MS) return undefined;
      return run.endMs + since * run.rate;
    }
    return undefined;
  }

  /** The only place the transport is watched: the end of a pass. */
  private tick(run: Run) {
    if (this.run !== run || run.phase !== 'playing') return;
    const now = performance.now();
    const at = this.clock.mixTimeAt(now);
    if (at < run.endMs) return;
    // This fires every 25 ms, so the clock is past the end by up to that much.
    // Back it out to get the moment it really crossed: that is what a late
    // stroke is placed against (`placeStroke`). At the rate playing now, which
    // a tempo key in the middle of the pass may have changed.
    const rate = this.clock.playbackRate || run.rate;
    this.endPass(run, now - (at - run.endMs) / rate, rate);
  }

  /** A pass is over: park, and wait a moment for a note that was a hair late. */
  private endPass(run: Run, parkedAt: number, rate = this.clock.playbackRate || run.rate) {
    run.phase = 'grace';
    run.parkedAt = parkedAt;
    run.rate = rate;
    this.api.pause();
    clearTimeout(run.grace);
    run.grace = window.setTimeout(() => void this.turn(run), EDGE_MS);
  }

  /** Close the pass that just ended, step the ramp, wind back, and go again. */
  private async turn(run: Run) {
    if (this.run !== run) return;
    const accuracy = run.grader?.close(run.pass, true);
    // Between passes, with the transport parked: a tempo change here is heard
    // from the next count-in on, never half way through a bar.
    if (this._ramp.on) {
      const next = rampAfterPass(this._ramp, this.host.tempo(), run.counted, accuracy);
      run.counted = next.counted;
      if (next.tempo !== this.host.tempo()) this.host.setTempo(next.tempo);
    }
    this.clock.seekTo(run.startMs);
    run.phase = 'rest';
    this.paint();
    // No rest bar still turns round through a pause and a seek: as quick as
    // the transport goes, which is a short gap rather than none.
    const go = this.host.restBar() ? await this.countInto(run, 1) : true;
    if (go) this.openPass(run);
  }

  /** A pass begins: the transport runs, and strokes from here are its. */
  private openPass(run: Run) {
    if (this.run !== run) return;
    run.pass++;
    run.phase = 'playing';
    run.rate = this.host.tempo() / 100;
    // Back on the first bar if anything moved the transport while it was
    // parked -- an arrow key or a click on the score during the count-in --
    // so that every pass really is the same stretch of the record.
    if (Math.abs(this.clock.mixTimeMs - run.startMs) > 1) this.clock.seekTo(run.startMs);
    run.grader?.open(run.pass);
    this.api.play();
    // Nothing on the status line: the header's pass block says "pass N" in
    // 64 px, and the line would only repeat it over the paper. The count-in
    // message before it is cleared for the same reason.
    if (!run.grader) this.host.say('');
    this.paint();
  }

  /**
   * A count-in of `bars` bars at the tempo the next pass will be played at --
   * four clicks at 100% would hand you the wrong speed for a 70% pass -- and
   * at the length of the range's own first bar, since the drummer's tempo is
   * not the same everywhere.
   */
  private countInto(run: Run, bars: number): Promise<boolean> {
    const grid = this.song?.grid;
    const ctx = this.mixer.ctx;
    const out = this.mixer.countInOut();
    if (!grid || !ctx || !out) return Promise.resolve(this.run === run);
    const perBar = grid.meter.beats_per_bar;
    const barMs = (barStartMs(grid, run.range.startBar) ?? run.startMs + 2000) - run.startMs;
    const beatS = barMs / perBar / 1000 / (this.host.tempo() / 100);
    const c = countIn(ctx, out, beatS, perBar * bars);
    run.countIn = c;
    return c.done.then((go) => {
      if (run.countIn === c) run.countIn = undefined;
      return go && this.run === run;
    });
  }

  // --- drawing ----------------------------------------------------------------------

  /** The loop's controls, from the state: one place, so they cannot disagree. */
  private paint() {
    const el = this.el;
    el.pill.disabled = !this.song?.grid;
    el.pill.setAttribute('aria-pressed', String(this._armed));

    const ramp = this._ramp;
    el.rampFrom.value = String(ramp.from);
    el.rampStep.value = String(ramp.step);
    el.rampEvery.value = String(ramp.every);
    el.rampTo.value = String(ramp.to);
    el.rampGate.checked = ramp.gate;
    this.host.painted();
  }
}
