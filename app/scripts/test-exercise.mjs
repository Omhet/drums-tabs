// Exercises: the ladder, what a sitting scores, and which song an exercise is on.
//
//   node --import ./scripts/ts-resolve.mjs --test scripts/test-exercise.mjs
//
// The same split `routine.ts` has: the rules that decide what a number means
// live in a pure module, so they can be pinned down without a browser, a kit or
// a song. What is asserted here is the four frozen decisions at the top of
// `exercise.ts`, not any particular arithmetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeDrill,
  exercisesForSong,
  ladder,
  nextSquare,
  parseExercise,
  rebaseHits,
  rebaseStrokes,
  scoreReps,
  sourceFor,
  tempoSeries,
  uniqueId,
} from '../src/exercise.ts';
import { PASS, TEMPOS } from '../src/routine.ts';

const KILL_ME = 'hayley-williams-kill-me-official-visualizer';
const SONG_2 = 'blur-song-2-official-music-video';

const source = (slug = KILL_ME, startBar = 13, endBar = 15) => ({
  slug,
  section: 'into chorus',
  startBar,
  endBar,
  chartHash: 'sha256:chart',
});

/** The smallest chart that is a chart: one note, one bar, a tempo, a meter. */
const chart = (over = {}) => ({
  bpm: 91,
  meter: { beats_per_bar: 4, beat_unit: 4 },
  bars: 1,
  hits: [{ slot: 0, instrument: 'snare', velocity: 100 }],
  hash: 'sha256:0000000000000000',
  ...over,
});

const exercise = (over = {}) => ({
  version: 2,
  id: 'chorus-fill',
  name: 'the chorus fill',
  kind: 'fill',
  restBars: 1,
  backing: 'record',
  sources: [source()],
  chart: chart(),
  createdAt: '2026-09-19T17:52:04.118Z',
  ...over,
});

/** A rep that went `accuracy` well. Timing is flat unless a test cares. */
const rep = (n, accuracy, complete = true, meanMs = 10, sdMs = 12) => ({
  n,
  startedAt: `2026-09-19T18:0${n}:00.000Z`,
  complete,
  events: [],
  grade: { accuracy, timing: { overall: { meanMs, sdMs } } },
});

const drill = (tempo, accuracy, startedAt, over = {}) => ({
  version: 1,
  exercise: 'chorus-fill',
  startedAt,
  endedAt: startedAt,
  source: { slug: KILL_ME, startBar: 13, endBar: 15 },
  tempo,
  restBars: 1,
  backing: 'record',
  calibrationMs: 29,
  chartHash: 'sha256:chart',
  accuracy,
  completeReps: 5,
  timing: { meanMs: 4, sdMs: 16 },
  best: accuracy,
  worst: accuracy,
  ...over,
});

// --- what a sitting scores -----------------------------------------------------------

test('a drill scores as the median of its reps, not the last and not the best', () => {
  // Unlike a take, a drill is many attempts at once: one rep you fell apart in
  // should not decide the sitting, and neither should one you nailed.
  const out = scoreReps([rep(1, 0.625), rep(2, 0.75), rep(3, 0.875), rep(4, 1), rep(5, 1)]);
  assert.equal(out.accuracy, 0.875);
  assert.equal(out.completeReps, 5);
});

test('it reports the range the median sits in: even, or lucky', () => {
  const out = scoreReps([rep(1, 0.4), rep(2, 0.9), rep(3, 1)]);
  assert.equal(out.accuracy, 0.9);
  assert.equal(out.worst, 0.4);
  assert.equal(out.best, 1);
});

test('the rep you stopped half way through is kept and not scored', () => {
  // It is a measurement that happened. It just does not describe the sitting.
  const out = scoreReps([rep(1, 0.8), rep(2, 0.8), rep(3, 0, false)]);
  assert.equal(out.completeReps, 2);
  assert.equal(out.accuracy, 0.8);
});

test('a sitting with no complete rep has no score at all, rather than a zero', () => {
  assert.equal(scoreReps([rep(1, 0.2, false)]), undefined);
  assert.equal(scoreReps([]), undefined);
});

test('the reading is drawn from the rep nearest the median, so picture and number agree', () => {
  const out = scoreReps([rep(1, 0.5), rep(2, 0.9), rep(3, 0.7)]);
  assert.equal(out.accuracy, 0.7);
  assert.equal(out.medianRep, 3);
});

test('on a tie it picks the later rep: ending well is the more useful one to look at', () => {
  const out = scoreReps([rep(1, 0.8), rep(2, 0.8)]);
  assert.equal(out.medianRep, 2);
});

test('timing is medianed too, and the two numbers stay apart', () => {
  // Q7: consistently late is the audio path or the feel, randomly late is the
  // playing. One number averaging them sends you to practise the wrong thing.
  const out = scoreReps([rep(1, 1, true, 30, 5), rep(2, 1, true, 10, 20), rep(3, 1, true, 20, 9)]);
  assert.deepEqual(out.timing, { meanMs: 20, sdMs: 9 });
});

// --- the ladder ----------------------------------------------------------------------

test('the ladder is four squares whatever the drills hold', () => {
  assert.deepEqual(ladder([]).map((s) => s.tempo), [...TEMPOS]);
  assert.ok(ladder([]).every((s) => s.drill === undefined), 'an unplayed square is empty, not zero');
});

test('the newest drill at a tempo is that square, not the best one', () => {
  // The anti-farming rule, restated for drills: there is nothing to seal, so
  // the directory being newest-wins is what keeps a lucky sitting from sticking.
  const drills = [
    drill(0.8, 0.95, '2026-09-19T10:00:00.000Z'),
    drill(0.8, 0.6, '2026-09-21T10:00:00.000Z'),
  ];
  const square = ladder(drills).find((s) => s.tempo === 0.8);
  assert.equal(square.drill.accuracy, 0.6);
});

test('a drill at one tempo leaves the other three alone', () => {
  const filled = ladder([drill(0.7, 0.9, '2026-09-19T10:00:00.000Z')]);
  assert.equal(filled.find((s) => s.tempo === 0.7).drill.accuracy, 0.9);
  assert.ok(filled.filter((s) => s.drill).length === 1);
});

test('the line under a square is one point per drill, oldest first however the files arrived', () => {
  const drills = [
    drill(0.7, 0.8, '2026-09-21T10:00:00.000Z'),
    drill(0.7, 0.6, '2026-09-19T10:00:00.000Z'),
    drill(1, 0.4, '2026-09-20T10:00:00.000Z'),
  ];
  assert.deepEqual(tempoSeries(drills, 0.7), [0.6, 0.8]);
  assert.deepEqual(tempoSeries(drills, 1), [0.4]);
  assert.deepEqual(tempoSeries(drills, 0.9), [], 'a tempo you have never drilled has no line');
});

test('it aims at the first square you have not played', () => {
  assert.equal(nextSquare(ladder([])), 0.7);
  assert.equal(nextSquare(ladder([drill(0.7, 1, '2026-09-19T10:00:00.000Z')])), 0.8);
});

test('with every square played it aims at the first that is not green', () => {
  const drills = TEMPOS.map((t) => drill(t, t === 0.9 ? 0.5 : 1, '2026-09-19T10:00:00.000Z'));
  assert.equal(nextSquare(ladder(drills)), 0.9);
});

test('with every square green it aims at the top: there is nowhere easier left to go', () => {
  const drills = TEMPOS.map((t) => drill(t, PASS, '2026-09-19T10:00:00.000Z'));
  assert.equal(nextSquare(ladder(drills)), 1);
});

// --- songs and exercises point at each other -----------------------------------------

test('one exercise cut from two songs shows up on both pages', () => {
  // The whole of the many-to-many link: no table, nothing to keep in step.
  const shared = exercise({ sources: [source(KILL_ME), source(SONG_2, 30, 32)] });
  assert.equal(exercisesForSong([shared], KILL_ME).length, 1);
  assert.equal(exercisesForSong([shared], SONG_2).length, 1);
  assert.deepEqual(exercisesForSong([shared], 'some-other-song'), []);
});

test('an exercise naming one song twice is still one exercise on its page', () => {
  const twice = exercise({ sources: [source(KILL_ME, 13, 15), source(KILL_ME, 32, 34)] });
  assert.equal(exercisesForSong([twice], KILL_ME).length, 1);
});

test('grooves come before fills, then it is alphabetical', () => {
  // The order you warm up in: the thing you sit in, then the thing that
  // interrupts it.
  const all = [
    exercise({ id: 'z-fill', name: 'z fill', kind: 'fill' }),
    exercise({ id: 'b-groove', name: 'b groove', kind: 'groove' }),
    exercise({ id: 'a-fill', name: 'a fill', kind: 'fill' }),
  ];
  assert.deepEqual(
    exercisesForSong(all, KILL_ME).map((e) => e.id),
    ['b-groove', 'a-fill', 'z-fill']
  );
});

test('it plays from the song you are on, and falls back to its first source', () => {
  const shared = exercise({ sources: [source(KILL_ME), source(SONG_2, 30, 32)] });
  assert.equal(sourceFor(shared, SONG_2).startBar, 30);
  assert.equal(sourceFor(shared, KILL_ME).startBar, 13);
  assert.equal(sourceFor(shared, 'elsewhere').slug, KILL_ME, 'the first source, not nothing');
});

test('an exercise with no sources has nowhere to be played from, and says so', () => {
  assert.equal(sourceFor(exercise({ sources: [] })), undefined);
});

// --- names, ids and labels -----------------------------------------------------------

test('the id is made from the name, in characters a directory can hold', () => {
  assert.equal(uniqueId('the chorus fill'), 'the-chorus-fill');
  assert.equal(uniqueId('  Fill #2 (into chorus!)  '), 'fill-2-into-chorus');
});

test('a name already taken gets a number rather than overwriting it', () => {
  assert.equal(uniqueId('the chorus fill', ['the-chorus-fill']), 'the-chorus-fill-2');
  assert.equal(uniqueId('the chorus fill', ['the-chorus-fill', 'the-chorus-fill-2']), 'the-chorus-fill-3');
});

test('a name with nothing usable in it still gets an id', () => {
  assert.equal(uniqueId('!!!'), 'exercise');
});

test('a drill says what you are about to play in one line', () => {
  // The same shape `describeCell` uses, and no song title: arming an exercise
  // loads the song it is played from, so the record on screen is always it.
  assert.equal(describeDrill(exercise(), source(), 0.8), 'the chorus fill · bars 13-15 · 80%');
  assert.equal(
    describeDrill(exercise(), source(KILL_ME, 14, 14), 1),
    'the chorus fill · bar 14 · 100%',
    'one bar is "bar", not "bars 14-14"'
  );
});

// --- reading an older file -----------------------------------------------------------

test('an exercise written before the rest existed still reads, with one bar of it', () => {
  // These are tracked files that outlive the code that wrote them.
  const old = exercise();
  delete old.restBars;
  assert.equal(parseExercise(old).restBars, 1);
});

test('a file from a version nobody here knows is refused rather than guessed at', () => {
  assert.equal(parseExercise({ ...exercise(), version: 3 }), undefined);
  assert.equal(parseExercise(null), undefined);
  assert.equal(parseExercise({ ...exercise(), version: 1 }), undefined, 'including the one before this');
});

// --- notes of its own -----------------------------------------------------------------

test('an exercise needs no source: its notes are its own', () => {
  const solo = parseExercise(exercise({ sources: [] }));
  assert.equal(solo.sources.length, 0);
  assert.equal(solo.chart.hits.length, 1);
  assert.equal(solo.chart.bars, 1);
});

test('...but a file with no notes at all is nothing to play', () => {
  assert.equal(parseExercise(exercise({ sources: [], chart: undefined })), undefined);
  assert.equal(parseExercise(exercise({ chart: undefined })), undefined, 'a source is not notes');
});

test('a half-written chart is not half usable', () => {
  const missing = (over) => parseExercise(exercise({ sources: [], chart: chart(over) }));
  assert.equal(missing({ hits: undefined }), undefined, 'no hits');
  assert.equal(missing({ bpm: undefined }), undefined, 'no tempo');
  assert.equal(missing({ bars: 0 }), undefined, 'no bars');
  assert.equal(missing({ meter: undefined }), undefined, 'no meter');
});

test('the kit is the default backing: every exercise has notes to sound', () => {
  assert.equal(parseExercise(exercise({ backing: undefined })).backing, 'kit');
  assert.equal(parseExercise(exercise({ backing: 'record' })).backing, 'record', 'and it is honoured');
});

test('hits are re-based so the first bar of the cut becomes bar 1', () => {
  // Bars 3-4 of a 4/4 chart: sixteenths 32..63 become 0..31.
  const hits = [
    { slot: 16, instrument: 'kick', velocity: 100 },
    { slot: 32, instrument: 'snare', velocity: 100 },
    { slot: 48, instrument: 'kick', velocity: 90 },
    { slot: 64, instrument: 'snare', velocity: 100 },
  ];
  const cut = rebaseHits(hits, 4, 3, 4);
  assert.deepEqual(
    cut.map((h) => [h.slot, h.instrument]),
    [
      [0, 'snare'],
      [16, 'kick'],
    ],
    'the bar before and the bar after are both left behind'
  );
  assert.ok(
    cut.every((h) => h.note === undefined),
    "the song's drum-rack key means nothing away from that song"
  );
});

test('the sticking moves with the notes, by whole bars', () => {
  const strokes = [
    { bar: 2, slot: 0, instrument: 'snare', limb: 'right_hand', velocity: 100 },
    { bar: 3, slot: 4, instrument: 'kick', limb: 'right_foot', velocity: 100 },
    { bar: 4, slot: 8, instrument: 'snare', limb: 'left_hand', velocity: 100 },
    { bar: 5, slot: 0, instrument: 'snare', limb: 'right_hand', velocity: 100 },
  ];
  assert.deepEqual(
    rebaseStrokes(strokes, 3, 4).map((s) => [s.bar, s.slot, s.limb]),
    [
      [1, 4, 'right_foot'],
      [2, 8, 'left_hand'],
    ],
    'the bar number moves; the slot inside the bar does not'
  );
});

test('a rest of nought is kept: a continuous loop is a real thing to want', () => {
  assert.equal(parseExercise(exercise({ restBars: 0 })).restBars, 0);
});
