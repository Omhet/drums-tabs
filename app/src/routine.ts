// A routine: the fixed set of cells you walk, and what you have filled so far.
//
// This is practice-plan Q5 and Q10. The one decision everything here serves is
// that **a routine is the same shape every time, forever** -- if run 3 and run 4
// are different sets of cells then comparing them is comparing nothing, and the
// progress history is noise. So nothing in this file adapts to how you played:
// the grid is derived from the sections and the tempo ladder alone, a cell that
// went badly goes red and is not repeated for you, and the only thing a take
// changes is which cell is filled.
//
// Three rules are frozen here and should not be quietly revisited:
//
//  1. **The routine is the whole song, at every tempo on the ladder.** Four
//     cells, and the run is the piece played through, slow to fast.
//  2. **The whole song at 100% is the last cell of every routine.** The "record
//     the finished thing" artifact is not a separate feature; it is the last
//     thing you do on every run.
//  3. **Only a complete take fills a cell, and the last one counts, not the
//     best.** Farming a lucky take is exactly how a progress line stops meaning
//     anything.
//
// The grid used to be section-major -- every `[[section]]` up the ladder and
// then the whole song, which was twenty-eight to sixty cells and made a run
// something you spread over a week. Sections did not stop being the thing you
// drill; they stopped being what a *run* is made of. Drilling a stretch of bars
// is an exercise now (exercise.ts), where it is looped with a rest in it and
// graded rep by rep, which is how anybody actually practises a hard bar.
//
// Everything above the `--- disk ---` line at the bottom is pure: no DOM, no
// network, nothing to stub, so `node --test` runs it directly
// (scripts/test-routine.mjs). That is where the rules above live, and it is the
// part worth keeping right. The three fetch helpers under the line talk to the
// route in plugins/practice.ts, which is the only thing here that can write.
import type { Section } from 'virtual:songs';

/**
 * The tempo ladder, as fractions of the record's own tempo.
 *
 * Browser `playbackRate` with `preservesPitch` produces these, judged clean by
 * ear at 70% on this song's stems (practice-plan Q6), so there is no
 * pre-rendered ladder on disk and switching tempo costs nothing.
 */
export const TEMPOS = [0.7, 0.8, 0.9, 1] as const;

/**
 * Accuracy at or above which a cell reads green.
 *
 * A signal, not a gate: a red cell does not block you and does not make you
 * play it again (Q5). One number for every tempo, deliberately -- a ladder of
 * thresholds would let 70% pass on playing that 100% would fail, and then
 * "green" would mean something different in every column.
 */
export const PASS = 0.9;

/** The id of the whole-song row. Not a legal `[[section]]` name, so it cannot collide. */
const WHOLE = '*';

/** What the whole-song cell is called on screen and in a take's filename. */
export const WHOLE_SONG = 'whole song';

/** One attempt that counts: the take that fills a cell. */
export interface Fill {
  /** The file in `takes/`, which holds the strokes and the full grade. */
  take: string;
  startedAt: string;
  /** `hit / expected`, 0..1. The number the cell's colour comes from. */
  accuracy: number;
  hit: number;
  expected: number;
  /**
   * The chart this take was graded against. Kept per fill, not just per
   * routine: editing the chart mid-routine is allowed and sealing a routine
   * whose fills disagree marks it mixed (Q10).
   */
  chartHash: string;
}

export interface RoutineCell {
  /** `<section>@<percent>`, stable across sittings. Two same-named blocks share one. */
  id: string;
  /** The `[[section]]` name, or `whole song`. What a take records as its cell. */
  section: string;
  /** True for the four whole-song cells, so a reader need not match the name. */
  whole: boolean;
  tempo: number;
  /** 1-based and inclusive, as the section is written. */
  startBar: number;
  endBar: number;
  /** The last complete take played here, or nothing. */
  fill: Fill | null;
}

export interface Routine {
  version: 1;
  /** ISO, and the routine's identity on disk: the filename is made from it. */
  openedAt: string;
  /** The last day a cell was filled -- with `openedAt`, the run's date span (Q10). */
  lastPlayedAt: string;
  /** Null while the routine is in progress. Sealing is by hand and by hand only. */
  sealedAt: string | null;
  /** The chart the routine opened against. A mid-routine edit warns; see `mixed`. */
  chartHash: string;
  /**
   * The `[[section]]` blocks it opened against.
   *
   * A true record of what the song looked like, and no longer what ends an
   * epoch -- that is the bar span now (`spanOf`), because renaming a section
   * changes no cell in a four-cell grid.
   */
  sectionsHash: string;
  /**
   * Set at sealing when the fills were graded against more than one chart. Such
   * a routine stays readable and is kept out of the comparison line.
   */
  mixed?: boolean;
  cells: RoutineCell[];
}

/** `chorus@70`. The whole-song row uses a name no section can have. */
export function cellId(section: string, tempo: number): string {
  return `${section}@${Math.round(tempo * 100)}`;
}

/**
 * The fixed grid: the whole song, once at each tempo on the ladder. Four cells.
 *
 * The sections are still what says where the song *is* -- the grid spans the
 * bars they cover, not bar 1 to the last bar of the chart, so a tab with
 * trailing empty bars does not add silence to the run. They are no longer cells
 * themselves; see the note at the top of this file.
 *
 * A song with no `[[section]]` blocks has no grid at all rather than a
 * whole-song row over guessed bars: without them nothing knows where the music
 * starts or stops.
 */
export function buildCells(sections: Section[], tempos: readonly number[] = TEMPOS): RoutineCell[] {
  if (sections.length === 0) return [];
  const startBar = Math.min(...sections.map((s) => s.start_bar));
  const endBar = Math.max(...sections.map((s) => s.end_bar));
  return tempos.map((tempo) => ({
    id: cellId(WHOLE, tempo),
    section: WHOLE_SONG,
    whole: true,
    tempo,
    startBar,
    endBar,
    fill: null,
  }));
}

/**
 * The bars a routine covers, as one string: `1-62`.
 *
 * This is the epoch key -- two runs over the same span are measuring the same
 * music and belong on one line. It used to be the `[[section]]` hash, which was
 * right when the sections *were* the cells: a boundary that moved changed which
 * cells existed. Now a rename changes nothing at all, and the sections are
 * about to be renamed on One For The Road. Moving the first or last boundary
 * still ends an epoch, because that moves the span.
 */
export function spanOf(cells: RoutineCell[]): string {
  const cell = cells[0];
  return cell ? `${cell.startBar}-${cell.endBar}` : '';
}

/** A new, empty routine over a song's sections. */
export function openRoutine(
  song: { sections: Section[]; sectionsHash: string },
  chartHash: string,
  now = new Date().toISOString()
): Routine {
  return {
    version: 1,
    openedAt: now,
    lastPlayedAt: now,
    sealedAt: null,
    chartHash,
    sectionsHash: song.sectionsHash,
    cells: buildCells(song.sections),
  };
}

/**
 * Record a complete take against a cell, replacing whatever was there.
 *
 * Replacing is the point: the last complete take counts, not the best (Q5).
 * Returns a new routine so a failed write leaves the one in memory untouched.
 */
export function fillCell(routine: Routine, id: string, fill: Fill): Routine {
  return {
    ...routine,
    lastPlayedAt: fill.startedAt,
    cells: routine.cells.map((cell) => (cell.id === id ? { ...cell, fill } : cell)),
  };
}

export function cellById(routine: Routine, id: string): RoutineCell | undefined {
  return routine.cells.find((cell) => cell.id === id);
}

/** Filled, total, and whether every cell has a take played to the end. */
export function progress(routine: Routine) {
  const filled = routine.cells.filter((cell) => cell.fill).length;
  return { filled, total: routine.cells.length, complete: filled === routine.cells.length };
}

/**
 * Where to go after finishing a cell: the next unfilled one in grid order.
 *
 * Walking from the cell just played and wrapping, so filling a hole in the
 * middle of a run carries on from the hole rather than jumping back to the top.
 * Nothing when the routine is complete -- there is nowhere to send you.
 */
export function nextCell(routine: Routine, from = ''): string | undefined {
  const n = routine.cells.length;
  if (n === 0) return undefined;
  // An unknown `from` -- picking a routine up at the start of a sitting -- walks
  // from the top of the grid, so the first cell is a candidate like any other.
  const at = routine.cells.findIndex((cell) => cell.id === from);
  for (let i = 1; i <= n; i++) {
    const cell = routine.cells[(at + i + n) % n];
    if (cell && !cell.fill) return cell.id;
  }
  return undefined;
}

/** The distinct charts the fills were graded against. More than one is `mixed`. */
export function chartsUsed(routine: Routine): string[] {
  return [...new Set(routine.cells.flatMap((cell) => (cell.fill ? [cell.fill.chartHash] : [])))];
}

/**
 * Seal it: the routine enters the history and stops being the open one.
 *
 * Refuses an incomplete routine, because "no incomplete routine is analysed"
 * (Q10) -- grading a half-played song is the thing the rule exists to prevent.
 * A routine whose fills span more than one chart is sealed but marked `mixed`.
 */
export function sealRoutine(routine: Routine, now = new Date().toISOString()): Routine {
  if (!progress(routine).complete) throw new Error('the routine has unfilled cells');
  const charts = chartsUsed(routine);
  return { ...routine, sealedAt: now, ...(charts.length > 1 ? { mixed: true } : {}) };
}

/**
 * Why an open routine cannot be picked up again, or nothing if it can.
 *
 * The span is the hard stop: the song now starts or ends somewhere else, so the
 * cells you filled and the ones you have not are no longer the same music. A
 * chart edit is the soft one -- it is allowed, it warns, and it comes out at
 * sealing as `mixed`.
 */
export function resumeProblem(
  routine: Routine,
  song: { sections: Section[] },
  chartHash: string
): { fatal: boolean; message: string } | undefined {
  const today = spanOf(buildCells(song.sections));
  if (spanOf(routine.cells) !== today) {
    return {
      fatal: true,
      message:
        'The song covers different bars than when this routine was opened, so its cells are ' +
        'no longer the same music. Seal it or discard it to start a new one.',
    };
  }
  if (routine.chartHash !== chartHash) {
    return {
      fatal: false,
      message:
        'The chart changed since this routine was opened. Cells filled before the edit were ' +
        'graded against the old notation, and sealing it will mark the run mixed.',
    };
  }
  return undefined;
}

/** `A · bars 1-12 · 70%`, the one line that says what you are about to play. */
export function describeCell(cell: RoutineCell): string {
  return `${cell.section} · bars ${cell.startBar}-${cell.endBar} · ${Math.round(cell.tempo * 100)}%`;
}

// --- the history ------------------------------------------------------------------
//
// One line per cell, across sealed runs. It used to be one line per *section* --
// the mean of that section's four tempos -- which was the right call against a
// forty-four square grid, because forty-four sparklines is not a thing anyone
// reads. Four squares is four lines, and nothing is averaged on the way to them:
// a mean over 70% and 100% hid the only thing worth knowing, which is whether
// the fast one is catching up with the slow one (practice-plan Q14).

/** How a cell went in one run: the accuracy of the take that filled it. */
export function cellScore(routine: Routine, id: string): number | undefined {
  return cellById(routine, id)?.fill?.accuracy;
}

/** A cell's score in each run, oldest first. `undefined` where it was not played. */
export function cellSeries(runs: Routine[], id: string): (number | undefined)[] {
  return runs.map((run) => cellScore(run, id));
}

/**
 * The middle value, averaging the middle two when there is no single middle.
 *
 * Shared, because the two places this project reaches for a middle are asking
 * the same question: what happened, with the one freak result set aside. Here it
 * smooths a progress line; in exercise.ts it scores a sitting of many reps.
 */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Rolling median of the last three, which is what makes a progress line honest.
 *
 * The routine counts your *last* complete take, not your best (Q5), so that a
 * lucky take cannot be farmed -- and the price of that is a jumpy series, where
 * one good run makes the next look like a regression. A median of three keeps
 * the trend and drops the single outlier in either direction, which is the
 * shape of the question being asked: "am I getting better", not "what did I do
 * on Tuesday". Runs with no score are skipped rather than treated as zero.
 */
export function rollingMedian(series: (number | undefined)[], window = 3): (number | undefined)[] {
  return series.map((value, i) => {
    if (value === undefined) return undefined;
    const recent = series
      .slice(Math.max(0, i - window + 1), i + 1)
      .filter((v): v is number => v !== undefined);
    if (recent.length === 0) return undefined;
    // Rounded to the same three places `accuracy` itself carries: averaging two
    // of them otherwise produces 0.6000000000000001, which is not a different
    // reading, only a noisier one.
    return Math.round(median(recent) * 1000) / 1000;
  });
}

/**
 * Which runs belong on one line with today's grid.
 *
 * A run over a different span of bars is measuring different music, and a run
 * sealed `mixed` was graded against two charts (Q10). Both stay readable on
 * disk; neither is a point on this line.
 */
export function comparableRuns(runs: Routine[], span: string): Routine[] {
  return runs
    .filter((run) => run.sealedAt && !run.mixed && spanOf(run.cells) === span)
    .sort((a, b) => a.sealedAt!.localeCompare(b.sealedAt!));
}

/**
 * Read a routine written by an older build, or reject it.
 *
 * Routines are tracked files that outlive the code that wrote them, so the
 * version is checked rather than assumed. There is only one version so far;
 * this exists so that the day there are two, the reader is already here.
 */
export function parseRoutine(value: unknown): Routine | undefined {
  const r = value as Routine | null;
  if (!r || typeof r !== 'object' || r.version !== 1 || !Array.isArray(r.cells)) return undefined;
  return r;
}

// --- disk ---------------------------------------------------------------------------
// Through the dev server, the same way a take reaches disk (take.ts): a static
// page cannot write files, so practising is a dev-mode feature (Q15).
//
// The open routine is a *file*, not memory, and it is written after every
// completed cell. That is not caution -- the Ableton watch plugin reloads the
// page on every Ctrl+S in Live, so an in-memory routine would be lost by the
// ordinary act of editing the chart (Q10).

const ROUTE = '/practice/routine';

/**
 * The sealed runs of a song, oldest first: the history.
 *
 * Empty for a song with nothing finished yet, and empty without a dev server,
 * which is the same answer the grid gives -- there is nothing to plot.
 */
export async function readRoutines(slug: string): Promise<Routine[]> {
  const res = await fetch(`${ROUTE}s?slug=${encodeURIComponent(slug)}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { routines?: unknown[] };
  return (body.routines ?? [])
    .map((r) => parseRoutine(r))
    .filter((r): r is Routine => r !== undefined);
}

/** The open routine for a song, or nothing. At most one can exist (the route enforces it). */
export async function readRoutine(slug: string): Promise<Routine | undefined> {
  const res = await fetch(`${ROUTE}?slug=${encodeURIComponent(slug)}`);
  if (!res.ok) return undefined;
  const body = (await res.json()) as { routine?: unknown };
  return parseRoutine(body.routine);
}

/** Write it to `songs/<slug>/routines/`, named after `openedAt`. */
export async function writeRoutine(slug: string, routine: Routine): Promise<string> {
  const res = await fetch(ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, ...routine }),
  });
  const body = (await res.json()) as { name?: string; error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `routine not written (${res.status})`);
  return body.name ?? 'written';
}

/**
 * Delete an open routine.
 *
 * Only an open one: a sealed routine is history and history is not editable
 * from the app. The takes it filled stay on disk either way -- discarding a
 * routine throws away the run, never the playing.
 */
export async function discardRoutine(slug: string, openedAt: string): Promise<void> {
  const res = await fetch(
    `${ROUTE}?slug=${encodeURIComponent(slug)}&openedAt=${encodeURIComponent(openedAt)}`,
    { method: 'DELETE' }
  );
  const body = (await res.json()) as { error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `routine not discarded (${res.status})`);
}
