// The routine grid: shape, order, filling, sealing, epochs.
//
//   node --import ./scripts/ts-resolve.mjs --test scripts/test-routine.mjs
//
// Everything asserted here is a decision from practice-plan Q5 and Q10 rather
// than an implementation detail, which is the point of `routine.ts` being pure:
// the rules that make two runs comparable are the ones worth pinning down, and
// they can be pinned down without a browser, a kit or a song.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCells,
  cellId,
  cellScore,
  cellSeries,
  chartsUsed,
  comparableRuns,
  describeCell,
  fillCell,
  median,
  nextCell,
  openRoutine,
  progress,
  resumeProblem,
  rollingMedian,
  sealRoutine,
  spanOf,
  PASS,
  TEMPOS,
} from '../src/routine.ts';

/** A song shaped like the real one: six blocks, named A-F. */
const SECTIONS = [
  { name: 'A', start_bar: 1, end_bar: 12 },
  { name: 'B', start_bar: 13, end_bar: 21 },
  { name: 'C', start_bar: 22, end_bar: 31 },
  { name: 'D', start_bar: 32, end_bar: 40 },
  { name: 'E', start_bar: 41, end_bar: 53 },
  { name: 'F', start_bar: 54, end_bar: 62 },
];

const song = (sections = SECTIONS, sectionsHash = 'sha256:sections') => ({ sections, sectionsHash });
const open = (sections = SECTIONS) => openRoutine(song(sections), 'sha256:chart', '2026-09-13T10:00:00.000Z');

const fill = (accuracy = 1, at = '2026-09-13T10:00:00.000Z', chart = 'sha256:chart') => ({
  take: 'a.json',
  startedAt: at,
  accuracy,
  hit: Math.round(accuracy * 10),
  expected: 10,
  chartHash: chart,
});

/** Fill every cell, so that sealing and completeness have something to work on. */
const fillAll = (routine, make = () => fill()) =>
  routine.cells.reduce((r, cell) => fillCell(r, cell.id, make(cell)), routine);

/** The span every routine here covers, for the epoch tests. */
const SPAN = '1-62';

// --- the shape ----------------------------------------------------------------------

test('the routine is the whole song at each tempo, whatever the sections are', () => {
  // Sections stopped being cells: a stretch of bars is drilled as an exercise
  // now, and a run is the piece played through.
  const cells = buildCells(SECTIONS);
  assert.equal(cells.length, TEMPOS.length);
  assert.ok(cells.every((c) => c.whole));
  assert.deepEqual([...new Set(cells.map((c) => c.section))], ['whole song']);
});

test('the number of sections makes no difference to the number of cells', () => {
  assert.equal(buildCells([{ name: 'A', start_bar: 1, end_bar: 8 }]).length, TEMPOS.length);
  assert.equal(buildCells(SECTIONS).length, TEMPOS.length);
});

test('the ladder is 70/80/90/100', () => {
  assert.deepEqual([...TEMPOS], [0.7, 0.8, 0.9, 1]);
});

test('it is walked slow to fast, and 100% is the last cell of the routine', () => {
  const cells = buildCells(SECTIONS);
  assert.deepEqual(cells.map((c) => c.id), ['*@70', '*@80', '*@90', '*@100']);
  assert.equal(cells.at(-1).tempo, 1);
});

test('the cells span every bar the sections cover, not the whole chart', () => {
  // A tab with trailing empty bars should not add silence to the run.
  const cells = buildCells(SECTIONS);
  assert.ok(cells.every((c) => c.startBar === 1 && c.endBar === 62));
});

test('a song with no sections has no grid at all: nothing knows where the music is', () => {
  assert.deepEqual(buildCells([]), []);
});

test('a cell says what to play in one line', () => {
  assert.equal(describeCell(buildCells(SECTIONS)[0]), 'whole song · bars 1-62 · 70%');
});

test('the whole-song id cannot collide with a section called "whole song"', () => {
  assert.notEqual(buildCells([{ name: 'whole song', start_bar: 1, end_bar: 8 }])[0].id, 'whole song@70');
  assert.equal(cellId('whole song', 1), 'whole song@100');
});

test('the span is the bars covered, and nothing at all without a grid', () => {
  assert.equal(spanOf(buildCells(SECTIONS)), SPAN);
  assert.equal(spanOf([]), '');
});

// --- filling ------------------------------------------------------------------------

test('a fresh routine is empty and incomplete', () => {
  const r = open();
  assert.deepEqual(progress(r), { filled: 0, total: 4, complete: false });
  assert.equal(r.sealedAt, null);
});

test('filling a cell leaves every other cell alone', () => {
  const r = fillCell(open(), '*@80', fill(0.5));
  assert.equal(progress(r).filled, 1);
  assert.equal(r.cells.find((c) => c.id === '*@80').fill.accuracy, 0.5);
  assert.equal(r.cells.find((c) => c.id === '*@70').fill, null);
});

test('the last complete take counts, not the best', () => {
  // Farming a lucky take is exactly how a progress line stops meaning anything,
  // so a later take replaces a better earlier one without comment.
  let r = fillCell(open(), '*@70', fill(0.98, '2026-09-13T10:00:00.000Z'));
  r = fillCell(r, '*@70', fill(0.61, '2026-09-14T10:00:00.000Z'));
  assert.equal(r.cells[0].fill.accuracy, 0.61);
  assert.equal(progress(r).filled, 1, 'a replacement does not fill a second cell');
});

test('filling moves the run’s last-played date, which is half its date span', () => {
  const r = fillCell(open(), '*@70', fill(1, '2026-09-20T21:00:00.000Z'));
  assert.equal(r.openedAt, '2026-09-13T10:00:00.000Z');
  assert.equal(r.lastPlayedAt, '2026-09-20T21:00:00.000Z');
});

test('fillCell does not mutate the routine it was given', () => {
  // The one in memory has to survive a failed write to disk.
  const before = open();
  fillCell(before, '*@70', fill());
  assert.equal(progress(before).filled, 0);
});

// --- where to go next ---------------------------------------------------------------

test('the walk starts at the top of the grid', () => {
  assert.equal(nextCell(open()), '*@70');
});

test('after a cell it is the next unfilled one in grid order', () => {
  const r = fillCell(open(), '*@70', fill());
  assert.equal(nextCell(r, '*@70'), '*@80');
});

test('it steps over cells already filled', () => {
  let r = fillCell(open(), '*@70', fill());
  r = fillCell(r, '*@80', fill());
  assert.equal(nextCell(r, '*@70'), '*@90');
});

test('it wraps, so a hole left earlier in the grid is still found', () => {
  // Every cell filled but one near the top: walking on from the last cell comes
  // back round to the hole rather than running out of grid.
  const r = open().cells.reduce(
    (acc, cell) => (cell.id === '*@80' ? acc : fillCell(acc, cell.id, fill())),
    open()
  );
  assert.equal(nextCell(r, '*@100'), '*@80');
});

test('a complete routine has nowhere to send you', () => {
  assert.equal(nextCell(fillAll(open()), '*@70'), undefined);
});

// --- sealing ------------------------------------------------------------------------

test('a routine with unfilled cells cannot be sealed', () => {
  assert.throws(() => sealRoutine(fillCell(open(), '*@70', fill())), /unfilled/);
});

test('sealing a complete routine stamps it and closes it', () => {
  const sealed = sealRoutine(fillAll(open()), '2026-09-20T22:00:00.000Z');
  assert.equal(sealed.sealedAt, '2026-09-20T22:00:00.000Z');
  assert.equal(sealed.mixed, undefined);
});

test('a red cell does not stop a routine being complete', () => {
  // Q5: the accuracy gate is a signal, not a gate. Nothing here consults it.
  const sealed = sealRoutine(fillAll(open(), () => fill(0.2)));
  assert.equal(progress(sealed).complete, true);
  assert.ok(sealed.cells.every((c) => c.fill.accuracy < PASS));
});

test('cells graded against two charts seal as mixed', () => {
  let r = fillAll(open());
  r = fillCell(r, '*@90', fill(1, '2026-09-14T10:00:00.000Z', 'sha256:edited'));
  assert.deepEqual(chartsUsed(r).sort(), ['sha256:chart', 'sha256:edited']);
  assert.equal(sealRoutine(r).mixed, true);
});

// --- epochs -------------------------------------------------------------------------

test('an untouched song resumes without a word', () => {
  assert.equal(resumeProblem(open(), song(), 'sha256:chart'), undefined);
});

test('renaming a section does not end the epoch: it changes no cell', () => {
  // The rule that used to live here hashed the [[section]] blocks, so a rename
  // threw away every run on the song. With a four-cell grid a name is not part
  // of the grid at all.
  const renamed = SECTIONS.map((s, i) => ({ ...s, name: i === 2 ? 'chorus' : s.name }));
  assert.equal(resumeProblem(open(), song(renamed, 'sha256:renamed'), 'sha256:chart'), undefined);
});

test('the song covering different bars ends the epoch', () => {
  // The span moved, so the cells you filled and the ones you have not are no
  // longer the same music.
  const trimmed = SECTIONS.slice(0, -1);
  const problem = resumeProblem(open(), song(trimmed), 'sha256:chart');
  assert.equal(problem.fatal, true);
  assert.match(problem.message, /different bars/i);
});

test('editing the chart mid-routine warns but is allowed', () => {
  const problem = resumeProblem(open(), song(), 'sha256:edited');
  assert.equal(problem.fatal, false);
  assert.match(problem.message, /mixed/);
});

// --- the history --------------------------------------------------------------------
// One line per cell across sealed runs. What is asserted here is the shape of
// the question -- "am I getting better" -- rather than any particular arithmetic.

const sealed = (accuracyByCell, at, extra = {}) => {
  let r = open();
  for (const cell of r.cells) {
    const a = accuracyByCell[cell.id];
    if (a !== undefined) r = fillCell(r, cell.id, fill(a, at));
  }
  return { ...r, sealedAt: at, ...extra };
};

test('a cell scores as the take that filled it, with nothing averaged in', () => {
  // The four tempos used to be meaned into one number per section, which hid
  // whether the fast one was catching up with the slow one.
  let r = fillCell(open(), '*@70', fill(1));
  r = fillCell(r, '*@100', fill(0.6));
  assert.equal(cellScore(r, '*@70'), 1);
  assert.equal(cellScore(r, '*@100'), 0.6);
});

test('a cell nobody has played has no score, rather than a zero', () => {
  assert.equal(cellScore(open(), '*@70'), undefined);
});

test('the series is one point per run, oldest first', () => {
  const runs = [
    sealed({ '*@70': 0.6 }, '2026-09-01T10:00:00.000Z'),
    sealed({ '*@70': 0.8 }, '2026-09-08T10:00:00.000Z'),
  ];
  assert.deepEqual(cellSeries(runs, '*@70'), [0.6, 0.8]);
});

test('a run that skipped a tempo leaves a gap in its line, not a zero', () => {
  const runs = [
    sealed({ '*@70': 0.9 }, '2026-09-01T10:00:00.000Z'),
    sealed({ '*@80': 0.9 }, '2026-09-08T10:00:00.000Z'),
  ];
  assert.deepEqual(cellSeries(runs, '*@70'), [0.9, undefined]);
});

test('the median is the middle, and averages the middle two of an even count', () => {
  assert.equal(median([0.6, 0.9, 0.7]), 0.7, 'it sorts first: the middle, not the middle one given');
  assert.equal(median([0.9, 0.5, 0.8, 0.6]), 0.7);
  assert.equal(median([]), 0, 'nothing to take a middle of');
});

test('the rolling median keeps the trend and drops a single outlier', () => {
  // The grid counts your last take, not your best, so one lucky run must not
  // read as progress and one bad one must not read as a collapse.
  assert.deepEqual(rollingMedian([0.5, 0.6, 0.9, 0.6, 0.7]), [0.5, 0.55, 0.6, 0.6, 0.7]);
});

test('it smooths over three, so the fourth run cannot see the first', () => {
  assert.deepEqual(rollingMedian([0, 1, 1, 1]), [0, 0.5, 1, 1]);
});

test('early runs are smoothed against what exists rather than held back', () => {
  const smoothed = rollingMedian([0.4]);
  assert.deepEqual(smoothed, [0.4], 'the first run plots as itself');
});

test('a gap stays a gap after smoothing', () => {
  assert.deepEqual(rollingMedian([0.4, undefined, 0.8]), [0.4, undefined, 0.6]);
});

test('only sealed runs are on the line', () => {
  const runs = [sealed({ '*@70': 0.9 }, '2026-09-01T10:00:00.000Z'), open()];
  assert.equal(comparableRuns(runs, SPAN).length, 1);
});

test('a mixed run is readable but is not a point on the line', () => {
  // Q10: it was graded against two different charts, so it is not comparable
  // with the runs either side of it.
  const runs = [sealed({ '*@70': 0.9 }, '2026-09-01T10:00:00.000Z', { mixed: true })];
  assert.deepEqual(comparableRuns(runs, SPAN), []);
});

test('a run from a previous epoch is not on the line either', () => {
  const runs = [sealed({ '*@70': 0.9 }, '2026-09-01T10:00:00.000Z')];
  assert.deepEqual(comparableRuns(runs, '1-53'), [], 'the song covered different bars');
});

test('the line is drawn oldest first however the files arrived', () => {
  const runs = [
    sealed({ '*@70': 0.8 }, '2026-09-08T10:00:00.000Z'),
    sealed({ '*@70': 0.6 }, '2026-09-01T10:00:00.000Z'),
  ];
  assert.deepEqual(cellSeries(comparableRuns(runs, SPAN), '*@70'), [0.6, 0.8]);
});
