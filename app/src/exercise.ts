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
//  1. **An exercise was a pair of scissors. It is a small score now, and it
//     remembers where it was cut from.** The first version took its notes from
//     the song's chart at the moment you played it -- the record was playing
//     anyway and `grid.lock.json` already knew when every bar happened, so the
//     loop was a seek and there was nothing to synthesise. That made every
//     exercise a *view* of a song, and three things followed from it that were
//     not meant: it could not be played without one, the "several sources" of
//     decision 2 never meant anything you could see, and the loop lived inside
//     the recording path, so the one thing an exercise is for needed a kit
//     plugged in before it would happen.
//
//     So the notes, the tempo and the meter are written into the file now
//     (`ExerciseChart`), re-based so the exercise's first bar is bar 1, and a
//     grid built at that tempo puts them in time. What did *not* change is
//     that there is still one `Grid` and one `slotToMixMs`: a constructed grid
//     and a measured one are the same shape, which is why this cost about
//     forty lines rather than the rewrite it was budgeted as.
//  2. **Several sources, and now they mean something.** The same lick turns up
//     in more than one song, and practising it twice under two names is
//     practising it twice. A source is no longer where the notes come from --
//     it is a record you can *also* play this against. A song's page shows
//     every exercise naming its slug, which is the whole of the many-to-many
//     link, with no table to keep in step.
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
import { chartHash, SLOTS_PER_BEAT, type ChartHit } from './chart';
import type { Grade, TakeEvent } from './grade';
import { median, PASS, TEMPOS } from './routine';
import type { StickingStroke } from './sticking';

/**
 * The notes an exercise is made of, and enough about them to place them in
 * time without a song.
 *
 * Hits rather than alphaTex, and the reason is one-way: the scorer wants
 * `{slot, instrument, velocity}` and the staff wants alphaTex, and
 * `hitsToAlphaTex` goes one way while nothing comes back. So the side that
 * generates the other is the side that is written down. It also means an
 * exercise an agent writes is a JSON array rather than a backslash-heavy
 * string, which retires a standing hazard (practice-plan Q13, ground rule 11).
 */
export interface ExerciseChart {
  /**
   * The tempo it is written at, in BPM. Absolute, unlike everything else
   * about an exercise: a cut takes the song's own `grid.score.bpm`, and the
   * ladder's 70/80/90/100 are percentages of *this* rather than of a song.
   */
  bpm: number;
  meter: { beats_per_bar: number; beat_unit: number };
  /** How many bars long it is. Its own bar 1 is the first of them. */
  bars: number;
  /** Re-based: `slot` counts sixteenths from the exercise's own first bar. */
  hits: ChartHit[];
  /**
   * Which limb plays what, re-based the same way.
   *
   * Shaped exactly like `sticking.lock.json`'s strokes so `expectedNotes`
   * takes it unchanged -- the R/L letters and, later, the avatar both work
   * with no new code.
   */
  strokes?: StickingStroke[];
  /** The notes themselves, hashed: what a drill says it was graded against. */
  hash: string;
}

/** Where an exercise can also be played: a stretch of bars in a real song. */
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

/**
 * What the loop plays under you.
 *
 * `kit` is the exercise's own notes, sounded from its own chart -- the only
 * one of the three that needs no song. `record` is the song it was cut from;
 * `click` is that same record with the stems pulled down, so the metronome
 * still ticks with the drummer's own feel rather than against a grid nobody
 * played to. The last two need a source; the first does not.
 */
export type Backing = 'kit' | 'record' | 'click';

export interface Exercise {
  /**
   * 2 since the notes moved into the file.
   *
   * Bumped rather than extended, because the meaning of `sources` changed with
   * it: it stopped being required. A version-1 reader handed a file with no
   * sources would draw a row with nothing to play.
   */
  version: 1 | 2;
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
  /**
   * Its own notes. Present from version 2 on.
   *
   * Absent means an exercise cut before the notes moved into the file: still
   * perfectly playable, just only against one of its `sources`.
   */
  chart?: ExerciseChart;
  /** Records this same figure can also be played against. May be empty. */
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
  /**
   * Which source it was played from, copied not referenced: sources can move.
   *
   * Absent when it was played on its own notes, with no record in the room.
   */
  source?: { slug: string; section?: string; startBar: number; endBar: number };
  /**
   * Set when there was no song behind it.
   *
   * Said out loud rather than inferred from the missing `source`: a file that
   * lost a field and a file that never had one are different accidents, and a
   * history should not need the difference guessed at.
   */
  standalone?: true;
  tempo: number;
  restBars: number;
  backing: Backing;
  /** Both corrections in force, recorded beside the raw stamps, never baked in. */
  calibrationMs: number;
  calibrationNote?: number;
  referenceMs?: number;
  /**
   * What it was graded against: the source song's tab.mid, or -- for a
   * standalone sitting -- the exercise's own `chart.hash`.
   *
   * No `sectionsHash`: an exercise is bars, and moving a section boundary does
   * not move them. Editing the notes does, which is why this is here.
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
 * A song's hits over a stretch of bars, moved so the first of them is bar 1.
 *
 * `slot` counts sixteenths from the start of the chart, so re-basing is one
 * subtraction -- and doing it here, once, at the moment of the cut, is what
 * lets everything downstream stay in one coordinate system. `note` is dropped:
 * it is the *song's* drum-rack key and means nothing away from that song.
 */
export function rebaseHits(
  hits: readonly ChartHit[],
  beatsPerBar: number,
  startBar: number,
  endBar: number
): ChartHit[] {
  const perBar = beatsPerBar * SLOTS_PER_BEAT;
  const from = (startBar - 1) * perBar;
  const to = endBar * perBar;
  return hits
    .filter((hit) => hit.slot >= from && hit.slot < to)
    .map(({ slot, instrument, velocity }) => ({ slot: slot - from, instrument, velocity }))
    .sort((a, b) => a.slot - b.slot || a.instrument.localeCompare(b.instrument));
}

/**
 * The sticking over the same bars, moved the same way.
 *
 * A stroke is addressed by (bar, slot-in-bar), so only the bar number moves --
 * which is why this is a separate function and not a branch of the one above.
 */
export function rebaseStrokes(
  strokes: readonly StickingStroke[],
  startBar: number,
  endBar: number
): StickingStroke[] {
  return strokes
    .filter((stroke) => stroke.bar >= startBar && stroke.bar <= endBar)
    .map((stroke) => ({ ...stroke, bar: stroke.bar - startBar + 1 }));
}

/**
 * The notes themselves, hashed.
 *
 * Over a canonical spelling of the hits rather than the file, so re-saving an
 * exercise with a new name or a new rest does not read as the notes having
 * changed -- the hash answers "am I being marked on what I was marked on
 * before", and only that.
 */
export function hashHits(hits: readonly ChartHit[]): Promise<string> {
  const canonical = hits.map((h) => `${h.slot}:${h.instrument}:${h.velocity}`).join(',');
  return chartHash(new TextEncoder().encode(canonical));
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
export function describeDrill(
  ex: Exercise,
  source: ExerciseSource | undefined,
  tempo: number
): string {
  // Bar numbers are a song's, so without one they would be saying "bars 1-3"
  // about a thing that is only ever three bars long -- which is a length, and
  // reads better as one.
  const bars = ex.chart?.bars ?? 1;
  const where = !source
    ? `${bars} bar${bars > 1 ? 's' : ''}`
    : source.startBar === source.endBar
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
 *
 * A version-1 file has no notes of its own and must name at least one song to
 * borrow them from; a version-2 file carries them and need not name anybody.
 * Both keep working, and a v1 file is not rewritten on sight: it is still an
 * accurate description of an exercise that is played against a record.
 */
export function parseExercise(value: unknown): Exercise | undefined {
  const ex = value as Exercise | null;
  if (!ex || typeof ex !== 'object') return undefined;
  if (ex.version !== 1 && ex.version !== 2) return undefined;
  if (!ex.id) return undefined;
  const sources = Array.isArray(ex.sources) ? ex.sources : [];
  const chart = parseChart(ex.chart);
  if (ex.version === 1 && sources.length === 0) return undefined;
  if (!chart && sources.length === 0) return undefined;
  return {
    ...ex,
    sources,
    ...(chart ? { chart } : {}),
    kind: ex.kind === 'groove' ? 'groove' : 'fill',
    backing: parseBacking(ex.backing, !!chart),
    restBars: Number.isFinite(ex.restBars) ? Math.max(0, Math.round(ex.restBars)) : 1,
  };
}

/**
 * The kit is the default for anything carrying its own notes, and `record` for
 * anything that is still a cut -- so no file on disk changes meaning by being
 * read by a newer build.
 */
function parseBacking(value: unknown, standalone: boolean): Backing {
  if (value === 'kit' || value === 'click' || value === 'record') return value;
  return standalone ? 'kit' : 'record';
}

/** Notes of its own, or nothing. A half-written chart is not half usable. */
function parseChart(value: unknown): ExerciseChart | undefined {
  const chart = value as ExerciseChart | null;
  if (!chart || typeof chart !== 'object') return undefined;
  if (!Array.isArray(chart.hits) || !Number.isFinite(chart.bpm)) return undefined;
  const beats = chart.meter?.beats_per_bar;
  if (!Number.isFinite(beats) || !Number.isFinite(chart.bars) || chart.bars < 1) return undefined;
  return {
    bpm: chart.bpm,
    meter: { beats_per_bar: beats, beat_unit: chart.meter.beat_unit || 4 },
    bars: Math.round(chart.bars),
    hits: chart.hits,
    ...(Array.isArray(chart.strokes) ? { strokes: chart.strokes } : {}),
    hash: chart.hash ?? '',
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
