// Marking a take: what you played against what is written.
//
// A pure function over numbers, deliberately: no AI, no DOM, no clock
// (practice-plan Q4). Everything downstream -- the colours on the staff, the
// timing strip, the coaching agent months from now -- is a rendering of what
// this returns, so this is the part with tests on it.
//
// ## Two stages, because either alone is wrong (Q7)
//
// **Stage 1 decides which note you were aiming at, and it scales with tempo.**
// A note's window reaches half way to its neighbour on each side -- so at 70%
// speed, where the notes are further apart, you have proportionally longer to
// be wrong about where the beat was before you are wrong about *which beat*.
// Because each side stops at the midpoint, one note's window can never overlap
// the next one's, and a hit therefore belongs to at most one written note. That
// is what makes the matching unambiguous rather than a search.
//
// **Stage 2 decides how tight you were, and it does not scale.** The error is
// reported in real milliseconds whatever the tempo, because 20 ms late is 20 ms
// late and a 70% take that scored well by a window that had widened with it
// would be flattering you.
//
// ## Matching is by instrument; reporting is by limb
//
// Which hand hit the snare is not in the MIDI and never can be -- a module
// sends a note, not a hand. So hits are matched to written notes by instrument,
// and a matched hit inherits the limb the sticking solver assigned to the note
// it matched. "Your right hand rushes the hats" is the sentence worth reading,
// and this is the only honest way to reach it.
//
// ## Two corrections come off before anything else
//
// Every timestamp is corrected by `calibrationMs` -- your audio path -- and by
// `referenceMs` -- how far behind the written grid the record's own drummer
// sits (reference.ts). Doing it before matching matters: 25 ms of systematic
// offset inside a window that is only 40 ms wide would invent misses out of
// nothing. A take stores raw timestamps and both numbers that were used (Q8),
// so either one later found to be wrong is a re-grade rather than a lost take.
//
// They are different kinds of thing and are kept apart everywhere but here:
// calibration is a property of this machine and is measured by the Calibrate
// button, while the reference is a property of this song and is measured by
// `drums reference`. Only their effect on a stroke's timestamp is the same.
import type { ExpectedNote, Limb } from './chart';

/** One stroke as it was recorded. `tMs` is raw mix time: uncorrected. */
export interface TakeEvent {
  tMs: number;
  note: number;
  velocity: number;
  /** What kit.toml `[input]` calls that note; absent means the table has a gap. */
  instrument?: string;
}

/** The fixed vocabulary (Q11). It is also how the coach groups exercises. */
export type Verdict = 'hit' | 'missed' | 'extra' | 'wrong-voice' | 'flam';

/** A written note, and what became of it. */
export interface NoteVerdict {
  note: ExpectedNote;
  verdict: Exclude<Verdict, 'extra' | 'flam'>;
  /** Signed, calibrated, in ms: **positive is late**. Only on a `hit`. */
  deltaMs?: number;
  velocity?: number;
  /**
   * What you actually struck, when that is not what is written.
   *
   * The verdict says how much it matters. On a `wrong-voice` it is a different
   * drum and the note is wrong. On a `hit` it is the same drum in its other
   * state (kit.toml's `same_drum`) -- an open hat where closed is written --
   * which is worth seeing but is not a wrong note.
   */
  played?: string;
}

/** A stroke with no written note to belong to. */
export interface ExtraVerdict {
  /** `flam` is an extra that landed on top of a hit you already played. */
  verdict: 'extra' | 'flam';
  /** Calibrated mix time, so it can be drawn next to the notes. */
  tMs: number;
  note: number;
  velocity: number;
  instrument?: string;
  /** 1-based bar it fell in, when it fell inside the cell at all. */
  bar?: number;
}

/** Mean and spread, always separate: they mean opposite things (Q7). */
export interface Timing {
  n: number;
  /** Average signed error. Consistently non-zero is the audio path, not you. */
  meanMs: number;
  /** Standard deviation: how scattered. This is the part that is playing. */
  sdMs: number;
  /** Robust to one flubbed hit in a way the mean is not. */
  medianMs: number;
  maxAbsMs: number;
}

export interface VoiceGrade {
  expected: number;
  hit: number;
  missed: number;
  wrongVoice: number;
  extra: number;
  flam: number;
  timing: Timing;
}

export interface Grade {
  /** How many written notes there were, and how many you played cleanly. */
  expected: number;
  hit: number;
  missed: number;
  extra: number;
  wrongVoice: number;
  flam: number;
  /**
   * Hits played on the same drum in its other state -- an open hat where a
   * closed one is written (kit.toml `same_drum`). These are counted as hits,
   * because the drum and the moment were right; they are reported separately
   * because a groove full of them usually means the module's hi-hat threshold
   * is not where your foot thinks it is.
   */
  sameDrum: number;
  /** `hit / expected`, 0..1. Extras are counted separately, never netted off. */
  accuracy: number;
  perVoice: Record<string, VoiceGrade>;
  timing: { overall: Timing; perLimb: Partial<Record<Limb, Timing>> };
  /** Every bar that had anything in it, in bar order: what the bar strip draws. */
  bars: BarGrade[];
  /** The same bars, worst first: the ones to go and play again. */
  worstBars: BarGrade[];
  /** Notes the module sent that kit.toml `[input]` has no name for. */
  unmappedNotes: number[];
}

/** One bar of the cell, as it went. */
export interface BarGrade {
  bar: number;
  /** Written notes in this bar, and how many landed on the right drum. */
  expected: number;
  hit: number;
  /** Missed, wrong-voice and unwritten strokes together. */
  wrong: number;
  /** Root-mean-square of how far off the notes that did land were. */
  rmsMs: number;
}

export interface GradeOptions {
  /** Subtracted from every played timestamp before anything else. */
  calibrationMs?: number;
  /**
   * Also subtracted: how far behind the chart's grid the record itself plays.
   *
   * With it, zero means "you sat where the record sits"; without it, zero means
   * "you sat on a grid nobody played to" and a faithful take reads as late by
   * the whole floor. See `reference.ts`.
   */
  referenceMs?: number;
  /** The widest a stage-1 window may get, however sparse the notes. */
  capMs?: number;
  /** An unwritten stroke this close to one you played is a bounce, not a note. */
  flamMs?: number;
  /**
   * Groups of instruments that are one drum in different states, from
   * kit.toml's `[input].same_drum`. Matching treats a group as one drum, so an
   * open hat answers a written closed one; the verdict still records which was
   * struck. Without this a hi-hat's open/closed threshold -- which is the
   * module's opinion, not yours -- reads as a wrong note on every flicker.
   */
  sameDrum?: string[][];
}

const DEFAULTS = {
  calibrationMs: 0,
  referenceMs: 0,
  capMs: 200,
  flamMs: 60,
  sameDrum: [] as string[][],
};

export interface GradeResult {
  notes: NoteVerdict[];
  extras: ExtraVerdict[];
  grade: Grade;
}

/** Half way to the neighbour on each side, never more than the cap. */
interface Window {
  back: number;
  front: number;
}

function windows(times: number[], capMs: number): Window[] {
  return times.map((t, i) => {
    const prev = i > 0 ? times[i - 1]! : undefined;
    const next = i + 1 < times.length ? times[i + 1]! : undefined;
    return {
      back: Math.min(prev === undefined ? Infinity : (t - prev) / 2, capMs),
      front: Math.min(next === undefined ? Infinity : (next - t) / 2, capMs),
    };
  });
}

export function grade(
  expected: ExpectedNote[],
  events: TakeEvent[],
  options: GradeOptions = {}
): GradeResult {
  const { calibrationMs, referenceMs, capMs, flamMs, sameDrum } = { ...DEFAULTS, ...options };

  // Which drum an instrument belongs to. Everything not named in `sameDrum` is
  // a drum of its own, so this is the identity map for most kits.
  const drumOf = new Map<string, string>();
  for (const group of sameDrum) {
    for (const name of group) drumOf.set(name, group[0]!);
  }
  const drum = (instrument: string) => drumOf.get(instrument) ?? instrument;

  const written = [...expected].sort((a, b) => a.tMs - b.tMs);
  const played = events
    .map((e) => ({ ...e, tMs: e.tMs - calibrationMs - referenceMs }))
    .sort((a, b) => a.tMs - b.tMs);

  // --- stage 1: which written note did each stroke mean? ----------------------
  // Bucketed by drum, because a window only has to separate a note from the
  // next note *on the same drum*: a kick and a snare on the same beat are not
  // competing to explain one stroke.
  const byVoice = new Map<string, { index: number; note: ExpectedNote }[]>();
  written.forEach((note, index) => {
    const key = drum(note.instrument);
    const list = byVoice.get(key) ?? [];
    list.push({ index, note });
    byVoice.set(key, list);
  });
  const window = new Map<number, Window>();
  for (const [, list] of byVoice) {
    const w = windows(
      list.map((x) => x.note.tMs),
      capMs
    );
    list.forEach((x, i) => window.set(x.index, w[i]!));
  }

  /** Written note index -> the strokes that landed in its window. */
  const landed = new Map<number, number[]>();
  /** Stroke index -> the written note it landed on, if any. */
  const home = new Array<number | undefined>(played.length);

  for (let p = 0; p < played.length; p++) {
    const event = played[p]!;
    if (!event.instrument) continue;
    const list = byVoice.get(drum(event.instrument));
    if (!list) continue;
    for (const { index, note } of list) {
      const w = window.get(index)!;
      const d = event.tMs - note.tMs;
      if (d >= -w.back && d <= w.front) {
        home[p] = index;
        const bucket = landed.get(index) ?? [];
        bucket.push(p);
        landed.set(index, bucket);
        // Windows meet at the midpoint and never overlap, so there is no
        // second candidate to weigh. A stroke exactly on a midpoint is shared
        // ground and goes to the earlier note, which is arbitrary but fixed.
        break;
      }
    }
  }

  // --- the verdicts -----------------------------------------------------------
  const notes: NoteVerdict[] = written.map((note) => ({ note, verdict: 'missed' }));
  const extras: ExtraVerdict[] = [];
  /** Strokes not yet explained by a written note. */
  const spare: number[] = [];
  /** The stroke that counted, per written note, for the flam test. */
  const counted = new Map<number, number>();

  for (let p = 0; p < played.length; p++) if (home[p] === undefined) spare.push(p);

  for (const [index, strokes] of landed) {
    const note = written[index]!;
    // More than one stroke in a window: the nearest is the note, the rest are
    // spare and get judged below.
    let best = strokes[0]!;
    for (const p of strokes) {
      if (Math.abs(played[p]!.tMs - note.tMs) < Math.abs(played[best]!.tMs - note.tMs)) best = p;
    }
    const struck = played[best]!.instrument;
    notes[index] = {
      note,
      verdict: 'hit',
      deltaMs: played[best]!.tMs - note.tMs,
      velocity: played[best]!.velocity,
      // The same drum in its other state: a hit, and worth seeing.
      ...(struck && struck !== note.instrument ? { played: struck } : {}),
    };
    counted.set(index, best);
    for (const p of strokes) if (p !== best) spare.push(p);
  }
  spare.sort((a, b) => a - b);

  // A spare stroke is one of three things, in this order: a bounce off a note
  // you did play, a stroke on the wrong drum at the right moment, or a note
  // that is simply not in the music.
  const playedCounted = [...counted.values()].map((p) => played[p]!);
  for (const p of spare) {
    const event = played[p]!;
    const struckDrum = event.instrument === undefined ? undefined : drum(event.instrument);
    const bounce =
      struckDrum !== undefined &&
      playedCounted.some(
        (other) =>
          other.instrument !== undefined &&
          drum(other.instrument) === struckDrum &&
          Math.abs(other.tMs - event.tMs) <= flamMs
      );
    if (bounce) {
      extras.push({ verdict: 'flam', tMs: event.tMs, note: event.note, velocity: event.velocity, instrument: event.instrument, bar: barOf(written, event.tMs) });
      continue;
    }
    // The right moment, the wrong drum: a still-missed written note whose own
    // window this stroke falls inside.
    let swapped = -1;
    let bestGap = Infinity;
    for (let i = 0; i < written.length; i++) {
      if (notes[i]!.verdict !== 'missed') continue;
      const w = window.get(i)!;
      const d = event.tMs - written[i]!.tMs;
      if (d < -w.back || d > w.front) continue;
      if (Math.abs(d) < bestGap) {
        bestGap = Math.abs(d);
        swapped = i;
      }
    }
    if (swapped >= 0) {
      notes[swapped] = {
        note: written[swapped]!,
        verdict: 'wrong-voice',
        deltaMs: event.tMs - written[swapped]!.tMs,
        velocity: event.velocity,
        played: event.instrument ?? `note ${event.note}`,
      };
      continue;
    }
    extras.push({ verdict: 'extra', tMs: event.tMs, note: event.note, velocity: event.velocity, instrument: event.instrument, bar: barOf(written, event.tMs) });
  }
  extras.sort((a, b) => a.tMs - b.tMs);

  return { notes, extras, grade: summarise(notes, extras, played) };
}

/** The bar a moment falls in, from the written notes around it. */
function barOf(written: ExpectedNote[], tMs: number): number | undefined {
  let bar: number | undefined;
  for (const note of written) {
    if (note.tMs <= tMs) bar = note.bar;
    else return bar ?? note.bar;
  }
  return bar;
}

function stats(values: number[]): Timing {
  const n = values.length;
  if (n === 0) return { n: 0, meanMs: 0, sdMs: 0, medianMs: 0, maxAbsMs: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  // Population spread: this is the whole take, not a sample drawn from one.
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const sorted = [...values].sort((a, b) => a - b);
  const mid = n >> 1;
  const median = n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return {
    n,
    meanMs: round(mean),
    sdMs: round(sd),
    medianMs: round(median),
    maxAbsMs: round(Math.max(...values.map(Math.abs))),
  };
}

const round = (x: number) => Math.round(x * 10) / 10;

function summarise(notes: NoteVerdict[], extras: ExtraVerdict[], played: TakeEvent[]): Grade {
  const perVoice: Record<string, VoiceGrade> = {};
  const voiceDeltas: Record<string, number[]> = {};
  const limbDeltas: Partial<Record<Limb, number[]>> = {};
  const all: number[] = [];
  const wrongPerBar = new Map<number, number>();
  const deltasPerBar = new Map<number, number[]>();
  // Written and landed, per bar: what the bar strip colours itself from. Kept
  // separately from `wrongPerBar` because a bar with two written notes and one
  // wrong is a worse bar than one with twenty written and one wrong, and a
  // count alone cannot say that.
  const expectedPerBar = new Map<number, number>();
  const hitPerBar = new Map<number, number>();
  const bump = (m: Map<number, number>, bar: number) => m.set(bar, (m.get(bar) ?? 0) + 1);

  const voice = (name: string): VoiceGrade =>
    (perVoice[name] ??= {
      expected: 0,
      hit: 0,
      missed: 0,
      wrongVoice: 0,
      extra: 0,
      flam: 0,
      timing: stats([]),
    });

  for (const v of notes) {
    const g = voice(v.note.instrument);
    g.expected++;
    bump(expectedPerBar, v.note.bar);
    if (v.verdict === 'hit') {
      g.hit++;
      bump(hitPerBar, v.note.bar);
      const d = v.deltaMs!;
      (voiceDeltas[v.note.instrument] ??= []).push(d);
      (limbDeltas[v.note.limb] ??= []).push(d);
      all.push(d);
      (deltasPerBar.get(v.note.bar) ?? setGet(deltasPerBar, v.note.bar)).push(d);
    } else {
      if (v.verdict === 'missed') g.missed++;
      else g.wrongVoice++;
      wrongPerBar.set(v.note.bar, (wrongPerBar.get(v.note.bar) ?? 0) + 1);
    }
  }
  for (const e of extras) {
    const g = voice(e.instrument ?? 'unmapped');
    if (e.verdict === 'flam') g.flam++;
    else g.extra++;
    if (e.bar !== undefined) wrongPerBar.set(e.bar, (wrongPerBar.get(e.bar) ?? 0) + 1);
  }
  for (const [name, deltas] of Object.entries(voiceDeltas)) perVoice[name]!.timing = stats(deltas);

  // Every bar that had anything in it, worst first. A bar where nothing was
  // wrong but everything was loose belongs on this list too -- that is half of
  // what it is for -- so it is ranked by wrong notes and then by how far off
  // the notes that did land were.
  const touched = new Set([
    ...expectedPerBar.keys(),
    ...wrongPerBar.keys(),
    ...deltasPerBar.keys(),
  ]);
  const bars: BarGrade[] = [...touched]
    .sort((a, b) => a - b)
    .map((bar) => ({
      bar,
      expected: expectedPerBar.get(bar) ?? 0,
      hit: hitPerBar.get(bar) ?? 0,
      wrong: wrongPerBar.get(bar) ?? 0,
      rmsMs: rms(deltasPerBar.get(bar) ?? []),
    }));
  const worstBars = [...bars].sort(
    (a, b) => b.wrong - a.wrong || b.rmsMs - a.rmsMs || a.bar - b.bar
  );

  const hit = notes.filter((v) => v.verdict === 'hit').length;
  return {
    expected: notes.length,
    hit,
    missed: notes.filter((v) => v.verdict === 'missed').length,
    wrongVoice: notes.filter((v) => v.verdict === 'wrong-voice').length,
    sameDrum: notes.filter((v) => v.verdict === 'hit' && v.played !== undefined).length,
    extra: extras.filter((e) => e.verdict === 'extra').length,
    flam: extras.filter((e) => e.verdict === 'flam').length,
    accuracy: notes.length === 0 ? 0 : Math.round((hit / notes.length) * 1000) / 1000,
    perVoice,
    timing: {
      overall: stats(all),
      perLimb: Object.fromEntries(
        Object.entries(limbDeltas).map(([limb, deltas]) => [limb, stats(deltas)])
      ) as Partial<Record<Limb, Timing>>,
    },
    bars,
    worstBars,
    unmappedNotes: [...new Set(played.filter((e) => !e.instrument).map((e) => e.note))].sort(
      (a, b) => a - b
    ),
  };
}

function setGet(map: Map<number, number[]>, key: number): number[] {
  const list: number[] = [];
  map.set(key, list);
  return list;
}

function rms(values: number[]): number {
  if (values.length === 0) return 0;
  return round(Math.sqrt(values.reduce((a, b) => a + b * b, 0) / values.length));
}
