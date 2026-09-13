// The calibration ritual: how late you play, and why that is not your fault.
//
// Every timing score in the system is `played - written - calibrationMs`, so
// this one number is load-bearing for the whole history (practice-plan Q9).
// Get it wrong by 15 ms and every take ever played is wrong by 15 ms in the
// same direction, and the coach reads a machine's latency as a playing flaw.
//
// **What is actually being measured is your compensation, not the machine's
// latency.** You play to what you hear. What you hear comes out of the browser
// a little after the browser thinks it did, and what you play arrives in the
// browser a little after you hit it. Neither number is knowable on its own and
// neither matters: what matters is the offset that zeroes your error against a
// click you trust.
//
// This is why the number belongs to the whole setup rather than to the app.
// The kit is a controller for a sampler in a DAW, so your own drums reach your
// ears through that DAW's buffer while the click reaches them through the
// browser's -- and you will unconsciously push or drag to reconcile the two.
// **Re-run this whenever the audio interface, its buffer size, or the routing
// changes**, which is what the drift warning after a take is watching for.
//
// **The ritual.** A bare click at 100 BPM, two bars to find it and eight bars
// of steady quarters on one pad. The answer is the **median** of the offsets,
// not the mean, so one flubbed hit cannot move it.
//
// ## The one genuinely fiddly part: two clocks
//
// A blip is scheduled on the AudioContext clock. A hit is stamped on the
// `performance.now()` clock. They are different clocks, and the gap between
// them is not constant -- it *is* the output latency, which is most of what is
// being measured, so it must be read rather than assumed.
// `AudioContext.getOutputTimestamp()` gives the pair: the context time of the
// audio reaching the speakers right now, and the `performance.now()` reading of
// that same moment. With one pair, any scheduled blip can be converted into the
// moment it will be *heard*, on the same clock the hits are stamped on.
import { Click } from './click';
import type { MidiHit } from './midi-in';

/** Bars to let you find the tempo before anything counts. */
const COUNT_IN_BARS = 2;
const MEASURED_BARS = 8;
const BEATS_PER_BAR = 4;
const BPM = 100;
/** Half a beat: past this you were aiming at a different click. */
const CAPTURE_MS = (60_000 / BPM) / 2;

/** What gets written to calibration.local.json. */
export interface Calibration {
  /** How late you play, in ms. Subtracted from every take's timestamps. */
  offsetMs: number;
  /** How steady you were while measuring it. Big means measure again. */
  spreadMs: number;
  /** How many strokes it came from. */
  n: number;
  /** The pad it was measured on: latency is per input path (Q9). */
  note: number;
  measuredAt: string;
}

export interface CalibrationProgress {
  /** 0..1 through the ritual. */
  fraction: number;
  /** Beats counted so far, including the count-in. */
  beat: number;
  totalBeats: number;
  /** Strokes captured so far. */
  n: number;
  /** The running median, once there is anything to show. */
  offsetMs?: number;
}

export interface CalibrationRun {
  /** Resolves when the ritual finishes, or rejects if it is cancelled. */
  done: Promise<Calibration>;
  cancel: () => void;
  /**
   * When beat `n` reaches the speakers, on the `performance.now()` clock.
   *
   * The same conversion the ritual scores against, exposed because it is the
   * only way to check the ritual: a stroke injected at `heardAt(n) + d` must
   * come back as an offset of `d`. Also the honest answer to "when is the
   * click", which nothing else on the page can work out.
   */
  heardAt: (beat: number) => number;
  /** Beats before the measurement starts, and how many there are in total. */
  countIn: number;
  totalBeats: number;
}

/**
 * Run the ritual. `hits` subscribes to the module; `ctx` must already be
 * running (it is the mixer's, built on a user gesture).
 */
export function calibrate(
  ctx: AudioContext,
  out: GainNode,
  onHit: (fn: (hit: MidiHit) => void) => () => void,
  onProgress?: (progress: CalibrationProgress) => void
): CalibrationRun {
  const beatS = 60 / BPM;
  const totalBeats = (COUNT_IN_BARS + MEASURED_BARS) * BEATS_PER_BAR;
  const countIn = COUNT_IN_BARS * BEATS_PER_BAR;

  // A click of its own, on a synthetic beat map: `Click` books blips against a
  // "mix time" that here is just seconds since the ritual started, so a beat
  // `i` is booked to sound at exactly `start + i * beatS` on the context clock.
  const beats = Array.from({ length: totalBeats }, (_, i) => i * beatS);
  const click = new Click(ctx, out);
  click.load(beats, (beat) => beat % BEATS_PER_BAR === 0);

  const start = ctx.currentTime + 0.7;
  const offsets: number[] = [];
  const notes: number[] = [];
  let stopped = false;

  let settle: (value: Calibration) => void;
  let fail: (err: Error) => void;
  const done = new Promise<Calibration>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const unsubscribe = onHit((hit) => {
    if (stopped) return;
    const heardAt = whenHeard(ctx, start);
    // Which click was it aimed at? The nearest one, and only if it is close
    // enough that there is no doubt.
    const beat = Math.round((hit.wallMs - heardAt) / (beatS * 1000));
    if (beat < countIn || beat >= totalBeats) return;
    const offset = hit.wallMs - (heardAt + beat * beatS * 1000);
    if (Math.abs(offset) > CAPTURE_MS) return;
    offsets.push(offset);
    notes.push(hit.note);
    report();
  });

  const report = () => {
    const elapsed = (ctx.currentTime - start) / beatS;
    onProgress?.({
      fraction: Math.max(0, Math.min(1, elapsed / totalBeats)),
      beat: Math.max(0, Math.floor(elapsed)),
      totalBeats,
      n: offsets.length,
      offsetMs: offsets.length ? round(median(offsets)) : undefined,
    });
  };

  // The same 25 ms lookahead pump the mixer runs for the song's click.
  const timer = window.setInterval(() => {
    if (stopped) return;
    click.book(ctx.currentTime - start, 1);
    report();
    if (ctx.currentTime - start > totalBeats * beatS + 0.3) finish();
  }, 25);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    click.forget();
    unsubscribe();
  };

  const finish = () => {
    stop();
    if (offsets.length < 4) {
      fail(new Error(`only ${offsets.length} hits landed near the click; play quarter notes on one pad`));
      return;
    }
    settle({
      offsetMs: round(median(offsets)),
      spreadMs: round(spread(offsets)),
      n: offsets.length,
      note: commonest(notes),
      measuredAt: new Date().toISOString(),
    });
  };

  return {
    done,
    cancel: () => {
      stop();
      fail(new Error('cancelled'));
    },
    heardAt: (beat) => whenHeard(ctx, start + beat * beatS),
    countIn,
    totalBeats,
  };
}

/**
 * The `performance.now()` moment at which audio scheduled for context time
 * `contextTime` reaches the speakers.
 *
 * `getOutputTimestamp()` pairs the two clocks at the output, so the gap it
 * reports already contains the buffer the browser is holding -- which is the
 * latency being calibrated, not an error to be corrected away.
 */
function whenHeard(ctx: AudioContext, contextTime: number): number {
  const stamp = ctx.getOutputTimestamp();
  if (stamp.contextTime === undefined || stamp.performanceTime === undefined) {
    // No timestamp pair (older engines): fall back to the two clocks' current
    // readings, which loses only the output buffer -- and a wrong constant
    // here is absorbed by the very offset being measured.
    return performance.now() + (contextTime - ctx.currentTime) * 1000;
  }
  return stamp.performanceTime + (contextTime - stamp.contextTime) * 1000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Spread as the median absolute deviation, scaled to read like a standard
 * deviation. Same reason the offset is a median: one bad hit should not decide
 * whether you are told to measure again.
 */
function spread(values: number[]): number {
  const m = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - m)));
}

function commonest(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0] ?? 0;
  for (const [v, c] of counts) if (c > (counts.get(best) ?? 0)) best = v;
  return best;
}

const round = (x: number) => Math.round(x * 10) / 10;

// --- where it is kept ---------------------------------------------------------
// Untracked and per machine: it measures this audio path, not this song and not
// this drummer. Every take stamps the value it used, so a take played on
// another machine stays comparable.

export async function loadCalibration(): Promise<Calibration | undefined> {
  try {
    const res = await fetch('/practice/calibration');
    return ((await res.json()) as Calibration | null) ?? undefined;
  } catch {
    return undefined; // built, not served by the dev server: no calibration
  }
}

export async function saveCalibration(calibration: Calibration): Promise<void> {
  await fetch('/practice/calibration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(calibration, null, 1),
  });
}
