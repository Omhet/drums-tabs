// An exercise: a stretch of bars you drill on a loop, with a rest in it.
//
// The routine is the song played through (routine.ts). This is the other half
// of practising, and it is the half that actually fixes anything: take the two
// bars you keep dropping, play them, wait a bar, play them again, twenty times.
// A sitting of those reps is a **drill**, and a drill fills one square of the
// exercise's own 70/80/90/100 ladder.
//
// Four decisions are frozen here:
//
//  1. **An exercise is a pair of scissors, not notation.** The notes come from
//     a real song's chart at the moment you play it, so there is no alphaTex
//     here and no grid to synthesise: the record is playing, `grid.lock.json`
//     knows when every bar happens, and the loop is a seek.
//  2. **Several sources.** The same lick turns up in more than one song, and
//     practising it twice under two names is practising it twice. A song's page
//     shows every exercise naming its slug -- that is the whole of the
//     many-to-many link, with no table to keep in step.
//  3. **A drill scores as the median of its complete reps.** One rep you fell
//     apart in should not decide a sitting, and neither should one you nailed.
//     Not the *last* one either: unlike a take, a drill is many attempts at
//     once, and the middle one describes how the sitting went.
//  4. **The newest drill at a tempo is that square.** There is nothing to seal
//     and no ceremony -- the directory already knows which file is newest. Same
//     anti-farming rule as a routine cell, for free.
//
// Everything above the `--- disk ---` line is pure, so `node --test` runs it
// directly (scripts/test-exercise.mjs).
import type { Grade, TakeEvent } from './grade';
import { median, PASS, TEMPOS } from './routine';

/** Where an exercise can be played from: a stretch of bars in a real song. */
export interface ExerciseSource {
  slug: string;
  /** The `[[section]]` it was cut from, for the label. Not its identity. */
  section?: string;
  /** 1-based and inclusive, the way a `[[section]]` is written. */
  startBar: number;
  endBar: number;
  /**
   * The song's tab.mid when the scissors came out.
   *
   * Not a lock: the bars are still there whatever the chart says now, so a
   * mismatch warns and never refuses. Every drill records the chart it was
   * actually graded against, which is the number that matters.
   */
  chartHash: string;
}

/** Grooves you sit in, fills you have to land. The pool's two shelves. */
export type Kind = 'groove' | 'fill';

/** What the loop plays under you. */
export type Backing = 'record' | 'click';

export interface Exercise {
  version: 1;
  /** The directory name under `exercises/`. Made from the name; unique by construction. */
  id: string;
  /** What you call it. "the chorus fill", not "exercise 3". */
  name: string;
  kind: Kind;
  /**
   * Bars of click between one rep and the next: play it, wait, play it again.
   *
   * This is how the thing is actually practised, and it is also what makes the
   * loop honest -- the transport pauses, seeks back and counts in during the
   * rest, so the seek is the only kind this app already does (a paused one) and
   * nothing has to be gapless. One bar by default. Zero is a continuous loop,
   * which suits a groove and puts the seek back in the middle of the music.
   */
  restBars: number;
  /**
   * `click` pulls the stems down and leaves the metronome.
   *
   * The beat map is the song's either way, so a click-only drill still ticks
   * with the record's own feel rather than against a grid nobody played to.
   */
  backing: Backing;
  sources: ExerciseSource[];
  createdAt: string;
  /** Why this one is hard, in one line. Shown under the name. */
  note?: string;
}

/** One time round the loop. */
export interface Rep {
  /** 1-based, in the order you played them. */
  n: number;
  startedAt: string;
  /**
   * Whether it reached the end of the range.
   *
   * The rep you stop half way through is written -- it is a measurement that
   * happened -- and it is not in the median. Same rule as an abandoned take
   * filling no cell (practice-plan Q5).
   */
  complete: boolean;
  /** Raw mix time, raw module note numbers, raw velocity (take.ts, rule 2). */
  events: TakeEvent[];
  grade: Grade;
}

/** One sitting at one tempo. */
export interface Drill {
  version: 1;
  /** The exercise's id. It is the directory too; here so a stray file says what it is. */
  exercise: string;
  startedAt: string;
  endedAt: string;
  /** Which source it was played from, copied not referenced: sources can move. */
  source: { slug: string; section?: string; startBar: number; endBar: number };
  tempo: number;
  restBars: number;
  backing: Backing;
  /** Both corrections in force, recorded beside the raw stamps, never baked in. */
  calibrationMs: number;
  calibrationNote?: number;
  referenceMs?: number;
  /**
   * The source song's tab.mid.
   *
   * No `sectionsHash`: an exercise is bars, and moving a section boundary does
   * not move them. Editing the chart does, which is why this is here.
   */
  chartHash: string;
  /** The median accuracy over the complete reps: the number the square shows. */
  accuracy: number;
  completeReps: number;
  /** The same median over the two numbers the reading keeps apart (Q7). */
  timing: { meanMs: number; sdMs: number };
  /** The range the median sits in: whether the sitting was even, or lucky. */
  best: number;
  worst: number;
  reps: Rep[];
}

/**
 * A drill with `reps` left off: what the ladder and the trend are drawn from.
 *
 * The route strips them on the way out, because a twenty-rep drill is hundreds
 * of strokes and nothing reads them yet.
 */
export type DrillSummary = Omit<Drill, 'reps'>;

/** An exercise and its history, as the pool reads them. */
export interface ExerciseFile {
  exercise: Exercise;
  /** Oldest first, which is the order a line is drawn in. */
  drills: DrillSummary[];
}

/** One rung of an exercise's ladder. */
export interface Square {
  tempo: number;
  /** The most recent drill at this tempo, or nothing. */
  drill: DrillSummary | undefined;
}

/** Rounded to the three places `accuracy` carries, so a median is not noisier than its parts. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * `the chorus fill` -> `the-chorus-fill`, then `-2` if that is taken.
 *
 * Lowercase letters, digits and hyphens only, which is what the route's own
 * path-safety filter leaves alone -- so the id the page picks and the directory
 * the server makes cannot come out different.
 */
export function uniqueId(name: string, taken: readonly string[] = []): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'exercise';
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.includes(id)) return id;
  }
}

/**
 * How a sitting went, from its reps alone.
 *
 * Nothing when no rep reached the end: a sitting you abandoned in the first
 * bar is a thing that happened, not a score, and it should fill no square.
 */
export function scoreReps(reps: Rep[]):
  | {
      accuracy: number;
      completeReps: number;
      timing: { meanMs: number; sdMs: number };
      best: number;
      worst: number;
      /** The `n` of the rep to draw the reading from: the one nearest the median. */
      medianRep: number;
    }
  | undefined {
  const done = reps.filter((rep) => rep.complete);
  if (done.length === 0) return undefined;
  const accuracies = done.map((rep) => rep.grade.accuracy);
  const middle = median(accuracies);
  // The rep whose reading goes on the staff, so the picture matches the number
  // in the square. On a tie the later one, because ending well is the more
  // useful of two equally typical reps to look at.
  let pick = done[0]!;
  for (const rep of done) {
    if (Math.abs(rep.grade.accuracy - middle) <= Math.abs(pick.grade.accuracy - middle)) pick = rep;
  }
  return {
    accuracy: round3(middle),
    completeReps: done.length,
    timing: {
      meanMs: round1(median(done.map((rep) => rep.grade.timing.overall.meanMs))),
      sdMs: round1(median(done.map((rep) => rep.grade.timing.overall.sdMs))),
    },
    best: Math.max(...accuracies),
    worst: Math.min(...accuracies),
    medianRep: pick.n,
  };
}

/**
 * The four squares, from the drills alone.
 *
 * The newest drill at a tempo *is* that square. No sealing, no ceremony, and
 * the last one counts rather than the best -- so a lucky sitting cannot be
 * farmed any more than a lucky take can.
 */
export function ladder(
  drills: DrillSummary[],
  tempos: readonly number[] = TEMPOS
): Square[] {
  return tempos.map((tempo) => {
    let newest: DrillSummary | undefined;
    for (const drill of drills) {
      if (drill.tempo !== tempo) continue;
      if (!newest || drill.startedAt >= newest.startedAt) newest = drill;
    }
    return { tempo, drill: newest };
  });
}

/** Every drill at one tempo, oldest first: the line under that square. */
export function tempoSeries(drills: DrillSummary[], tempo: number): number[] {
  return drills
    .filter((drill) => drill.tempo === tempo)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((drill) => drill.accuracy);
}

/**
 * Which rung to aim at: the first you have not played, else the first that is
 * not green, else the top.
 *
 * A suggestion and not a lock -- every square is clickable, the same way every
 * cell of the routine is.
 */
export function nextSquare(squares: Square[]): number {
  const empty = squares.find((square) => !square.drill);
  if (empty) return empty.tempo;
  const red = squares.find((square) => (square.drill?.accuracy ?? 0) < PASS);
  return red?.tempo ?? squares[squares.length - 1]?.tempo ?? 1;
}

/**
 * Every exercise that can be played from a song, grooves before fills.
 *
 * Grooves first because they are the thing you sit in and the fill is the
 * thing that interrupts it, which is also the order you warm up in.
 */
export function exercisesForSong(all: Exercise[], slug: string): Exercise[] {
  return all
    .filter((ex) => ex.sources.some((source) => source.slug === slug))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'groove' ? -1 : 1));
}

/** Where to play it from: this song if it is one of them, else the first source. */
export function sourceFor(ex: Exercise, slug?: string): ExerciseSource | undefined {
  return ex.sources.find((source) => source.slug === slug) ?? ex.sources[0];
}

/**
 * `the chorus fill · bars 13-15 · 80%`: the one line saying what you are about
 * to play, in the same shape `describeCell` says it.
 *
 * No song title: arming an exercise loads the song it is played from, so the
 * record on screen is always this one -- and the full title of a song is long
 * enough to wrap the line it would be saying nothing on.
 */
export function describeDrill(ex: Exercise, source: ExerciseSource, tempo: number): string {
  const where =
    source.startBar === source.endBar
      ? `bar ${source.startBar}`
      : `bars ${source.startBar}-${source.endBar}`;
  return `${ex.name} · ${where} · ${Math.round(tempo * 100)}%`;
}

/**
 * Read an exercise written by an older build, or reject it.
 *
 * These are tracked files that outlive the code that wrote them, so the version
 * is checked rather than assumed, and `restBars` is defaulted rather than
 * required -- a file that predates the rest still describes a real exercise.
 */
export function parseExercise(value: unknown): Exercise | undefined {
  const ex = value as Exercise | null;
  if (!ex || typeof ex !== 'object' || ex.version !== 1) return undefined;
  if (!ex.id || !Array.isArray(ex.sources)) return undefined;
  return {
    ...ex,
    kind: ex.kind === 'groove' ? 'groove' : 'fill',
    backing: ex.backing === 'click' ? 'click' : 'record',
    restBars: Number.isFinite(ex.restBars) ? Math.max(0, Math.round(ex.restBars)) : 1,
  };
}

// --- disk ---------------------------------------------------------------------------
// Through the dev server, the same way a take and a routine reach disk: a static
// page cannot write files, so drilling is a dev-mode feature (Q15).
//
// The pool lives at the repo root rather than under a song, because an exercise
// can belong to several songs and a file cannot live in two directories.

const ROUTE = '/practice/exercise';

/** Every exercise in the pool, each with its drills. Empty without a dev server. */
export async function readExercises(): Promise<ExerciseFile[]> {
  const res = await fetch(`${ROUTE}s`);
  if (!res.ok) return [];
  const body = (await res.json()) as { exercises?: { exercise?: unknown; drills?: unknown }[] };
  const files: ExerciseFile[] = [];
  for (const entry of body.exercises ?? []) {
    const exercise = parseExercise(entry.exercise);
    if (exercise) files.push({ exercise, drills: (entry.drills ?? []) as DrillSummary[] });
  }
  return files;
}

/** Write `exercises/<id>/exercise.json`. An upsert: it is how a source is added too. */
export async function writeExercise(exercise: Exercise): Promise<string> {
  const res = await fetch(ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(exercise),
  });
  const body = (await res.json()) as { id?: string; error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `exercise not written (${res.status})`);
  return body.id ?? exercise.id;
}

/** Throw the exercise away, drills and all. The page's confirm says so out loud. */
export async function deleteExercise(id: string): Promise<void> {
  const res = await fetch(`${ROUTE}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  const body = (await res.json()) as { error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `exercise not deleted (${res.status})`);
}

/** Write a sitting to `exercises/<id>/drills/`, named for when and how fast. */
export async function writeDrill(drill: Drill): Promise<string> {
  const res = await fetch('/practice/drill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(drill),
  });
  const body = (await res.json()) as { name?: string; error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `drill not written (${res.status})`);
  return body.name ?? 'written';
}
