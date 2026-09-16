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
  chartsUsed,
  comparableRuns,
  describeCell,
  fillCell,
  nextCell,
  openRoutine,
  progress,
  resumeProblem,
  rollingMedian,
  sealRoutine,
  sectionScore,
  sectionSeries,
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

// --- the shape ----------------------------------------------------------------------

test('six distinct sections is twenty-eight cells', () => {
  // 6 x 4 tempos, plus the whole song at each tempo.
  assert.equal(buildCells(SECTIONS).length, 6 * TEMPOS.length + TEMPOS.length);
});

test('the ladder is 70/80/90/100', () => {
  assert.deepEqual([...TEMPOS], [0.7, 0.8, 0.9, 1]);
});

test('it is walked section-major: one section up the ladder, then the next', () => {
  const ids = buildCells(SECTIONS).map((c) => c.id);
  assert.deepEqual(ids.slice(0, 5), ['A@70', 'A@80', 'A@90', 'A@100', 'B@70']);
});

test('the whole song is the last row, and 100% is the last cell of the routine', () => {
  const cells = buildCells(SECTIONS);
  const last = cells.at(-1);
  assert.equal(last.whole, true);
  assert.equal(last.tempo, 1);
  assert.equal(cells.filter((c) => c.whole).length, TEMPOS.length);
});

test('the whole-song cell spans every bar the sections cover', () => {
  const whole = buildCells(SECTIONS).find((c) => c.whole);
  assert.equal(whole.startBar, 1);
  assert.equal(whole.endBar, 62);
});

test('two blocks with the same name are one cell, practised against the first', () => {
  // The real reason the grid shrinks: naming both choruses `chorus` is how a
  // 28-cell routine becomes a 20-cell one.
  const named = [
    { name: 'verse', start_bar: 1, end_bar: 12 },
    { name: 'chorus', start_bar: 13, end_bar: 21 },
    { name: 'verse', start_bar: 22, end_bar: 33 },
  ];
  const cells = buildCells(named);
  assert.equal(cells.length, 2 * TEMPOS.length + TEMPOS.length);
  const verse = cells.find((c) => c.id === 'verse@70');
  assert.equal(verse.startBar, 1, 'the first block of the pair is the one you play');
  assert.equal(verse.endBar, 12);
});

test('a nameless block is left out rather than merged with the next one', () => {
  const cells = buildCells([
    { name: '', start_bar: 1, end_bar: 4 },
    { name: 'B', start_bar: 5, end_bar: 8 },
  ]);
  assert.deepEqual([...new Set(cells.map((c) => c.section))], ['B', 'whole song']);
});

test('a song with no sections has no grid at all, not an empty whole-song row', () => {
  assert.deepEqual(buildCells([]), []);
});

test('a cell says what to play in one line', () => {
  const cells = buildCells(SECTIONS);
  assert.equal(describeCell(cells[0]), 'A · bars 1-12 · 70%');
});

test('the whole-song id cannot collide with a section called "whole song"', () => {
  const cells = buildCells([{ name: 'whole song', start_bar: 1, end_bar: 8 }]);
  const ids = cells.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(cellId('whole song', 1), 'whole song@100');
});

// --- filling ------------------------------------------------------------------------

test('a fresh routine is empty and incomplete', () => {
  const r = open();
  assert.deepEqual(progress(r), { filled: 0, total: 28, complete: false });
  assert.equal(r.sealedAt, null);
});

test('filling a cell leaves every other cell alone', () => {
  const r = fillCell(open(), 'B@80', fill(0.5));
  assert.equal(progress(r).filled, 1);
  assert.equal(r.cells.find((c) => c.id === 'B@80').fill.accuracy, 0.5);
  assert.equal(r.cells.find((c) => c.id === 'B@70').fill, null);
});

test('the last complete take counts, not the best', () => {
  // Farming a lucky take is exactly how a progress line stops meaning anything,
  // so a later take replaces a better earlier one without comment.
  let r = fillCell(open(), 'A@70', fill(0.98, '2026-09-13T10:00:00.000Z'));
  r = fillCell(r, 'A@70', fill(0.61, '2026-09-14T10:00:00.000Z'));
  assert.equal(r.cells[0].fill.accuracy, 0.61);
  assert.equal(progress(r).filled, 1, 'a replacement does not fill a second cell');
});

test('filling moves the run’s last-played date, which is half its date span', () => {
  const r = fillCell(open(), 'A@70', fill(1, '2026-09-20T21:00:00.000Z'));
  assert.equal(r.openedAt, '2026-09-13T10:00:00.000Z');
  assert.equal(r.lastPlayedAt, '2026-09-20T21:00:00.000Z');
});

test('fillCell does not mutate the routine it was given', () => {
  // The one in memory has to survive a failed write to disk.
  const before = open();
  fillCell(before, 'A@70', fill());
  assert.equal(progress(before).filled, 0);
});

// --- where to go next ---------------------------------------------------------------

test('the walk starts at the top of the grid', () => {
  assert.equal(nextCell(open()), 'A@70');
});

test('after a cell it is the next unfilled one in grid order', () => {
  const r = fillCell(open(), 'A@70', fill());
  assert.equal(nextCell(r, 'A@70'), 'A@80');
});

test('it steps over cells already filled', () => {
  let r = fillCell(open(), 'A@70', fill());
  r = fillCell(r, 'A@80', fill());
  r = fillCell(r, 'A@90', fill());
  assert.equal(nextCell(r, 'A@70'), 'A@100');
});

test('it wraps, so a hole left earlier in the grid is still found', () => {
  // Every cell filled but one in the middle: walking on from a cell near the
  // end comes back round to the hole rather than running out of grid.
  const r = open().cells.reduce(
    (acc, cell) => (cell.id === 'B@90' ? acc : fillCell(acc, cell.id, fill())),
    open()
  );
  assert.equal(nextCell(r, 'F@100'), 'B@90');
});

test('a complete routine has nowhere to send you', () => {
  assert.equal(nextCell(fillAll(open()), 'A@70'), undefined);
});

// --- sealing ------------------------------------------------------------------------

test('a routine with unfilled cells cannot be sealed', () => {
  assert.throws(() => sealRoutine(fillCell(open(), 'A@70', fill())), /unfilled/);
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
  r = fillCell(r, 'C@90', fill(1, '2026-09-14T10:00:00.000Z', 'sha256:edited'));
  assert.deepEqual(chartsUsed(r).sort(), ['sha256:chart', 'sha256:edited']);
  assert.equal(sealRoutine(r).mixed, true);
});

// --- epochs -------------------------------------------------------------------------

test('an untouched song resumes without a word', () => {
  assert.equal(resumeProblem(open(), song(), 'sha256:chart'), undefined);
});

test('moving a section boundary ends the epoch: the routine cannot be resumed', () => {
  // The grid is derived from the sections, so a boundary that moved means the
  // filled cells and the empty ones describe different music.
  const problem = resumeProblem(open(), song(SECTIONS, 'sha256:moved'), 'sha256:chart');
  assert.equal(problem.fatal, true);
  assert.match(problem.message, /sections moved/i);
});

test('editing the chart mid-routine warns but is allowed', () => {
  const problem = resumeProblem(open(), song(), 'sha256:edited');
  assert.equal(problem.fatal, false);
  assert.match(problem.message, /mixed/);
});


// --- the history --------------------------------------------------------------------
// One line per section across sealed runs. What is asserted here is the shape of
// the question -- "am I getting better" -- rather than any particular arithmetic.

const sealed = (accuracyBySection, at, extra = {}) => {
  let r = open();
  for (const cell of r.cells) {
    const a = accuracyBySection[cell.section];
    if (a !== undefined) r = fillCell(r, cell.id, fill(a, at));
  }
  return { ...r, sealedAt: at, ...extra };
};

test('a section scores as the mean over its cells, all four tempos together', () => {
  // A section is only learned when it is learned at speed, so the 100% cell
  // dragging the mean down is the line telling the truth.
  let r = open();
  r = fillCell(r, 'A@70', fill(1));
  r = fillCell(r, 'A@80', fill(1));
  r = fillCell(r, 'A@90', fill(1));
  r = fillCell(r, 'A@100', fill(0.6));
  assert.equal(sectionScore(r, 'A'), 0.9);
});

test('a section nobody has played has no score, rather than a zero', () => {
  assert.equal(sectionScore(open(), 'A'), undefined);
});

test('the series is one point per run, oldest first', () => {
  const runs = [
    sealed({ A: 0.6 }, '2026-09-01T10:00:00.000Z'),
    sealed({ A: 0.8 }, '2026-09-08T10:00:00.000Z'),
  ];
  assert.deepEqual(sectionSeries(runs, 'A'), [0.6, 0.8]);
});

test('a run that skipped a section leaves a gap in its line, not a zero', () => {
  const runs = [sealed({ A: 0.9 }, '2026-09-01T10:00:00.000Z'), sealed({ B: 0.9 }, '2026-09-08T10:00:00.000Z')];
  assert.deepEqual(sectionSeries(runs, 'A'), [0.9, undefined]);
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
  const runs = [sealed({ A: 0.9 }, '2026-09-01T10:00:00.000Z'), open()];
  assert.equal(comparableRuns(runs, 'sha256:sections').length, 1);
});

test('a mixed run is readable but is not a point on the line', () => {
  // Q10: it was graded against two different charts, so it is not comparable
  // with the runs either side of it.
  const runs = [sealed({ A: 0.9 }, '2026-09-01T10:00:00.000Z', { mixed: true })];
  assert.deepEqual(comparableRuns(runs, 'sha256:sections'), []);
});

test('a run from a previous epoch is not on the line either', () => {
  const runs = [sealed({ A: 0.9 }, '2026-09-01T10:00:00.000Z')];
  assert.deepEqual(comparableRuns(runs, 'sha256:moved'), [], 'the sections were a different shape');
});

test('the line is drawn oldest first however the files arrived', () => {
  const runs = [
    sealed({ A: 0.8 }, '2026-09-08T10:00:00.000Z'),
    sealed({ A: 0.6 }, '2026-09-01T10:00:00.000Z'),
  ];
  assert.deepEqual(sectionSeries(comparableRuns(runs, 'sha256:sections'), 'A'), [0.6, 0.8]);
});
