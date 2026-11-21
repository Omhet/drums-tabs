// The loop's arithmetic: which bars it can play, what they are called, how a
// ramp climbs, and which bar a paused transport is in.
//
//   node --import ./scripts/ts-resolve.mjs --test scripts/test-loop.mjs
//
// The loop going round is checked in a real browser (check-loop.mjs). These
// are the rules under it that a browser check would only ever hit one case of.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkRange,
  normaliseRamp,
  rampAfterPass,
  rampSays,
  rangeLabel,
  rangeName,
  snapTempo,
} from '../src/loop.ts';
import { barAtMs } from '../src/syncpoints.ts';

/** Two-second bars, bar 1 a second in, eight bars and the beat after them. */
const grid = {
  beats: [1, 1.5, ...Array.from({ length: 33 }, (_, i) => 2 + i * 0.5)],
  bar_one_beat: 2,
  bar_count: 8,
  meter: { beats_per_bar: 4, beat_unit: 4 },
};
const sections = [
  { name: 'verse', start_bar: 1, end_bar: 4 },
  { name: 'fill', start_bar: 5, end_bar: 5 },
  { name: 'verse', start_bar: 6, end_bar: 8 },
];

test('the tempo lives on the slider rungs', () => {
  assert.equal(snapTempo(72), 70);
  assert.equal(snapTempo(73), 75);
  assert.equal(snapTempo(10), 25);
  assert.equal(snapTempo(200), 125);
});

test('a range is whole bars, the right way round, inside the song', () => {
  assert.deepEqual(checkRange(grid, 8, { startBar: 5, endBar: 6 }), { startBar: 5, endBar: 6 });
  assert.match(checkRange(grid, 8, { startBar: 6, endBar: 5 }), /wrong way round/);
  assert.match(checkRange(grid, 8, { startBar: 0, endBar: 2 }), /bars 1 to 8/);
  assert.match(checkRange(grid, 8, { startBar: 7, endBar: 9 }), /bars 1 to 8/);
  assert.match(checkRange(undefined, 8, { startBar: 1, endBar: 2 }), /no beat map/);
});

test('a range has to end on a bar the beat map can close', () => {
  // Notation one bar longer than the beat map: bar 9 has no beat after it.
  assert.match(checkRange(grid, 9, { startBar: 8, endBar: 9 }), /cannot come back round/);
  // Without the beat after bar 8, bar 8 cannot end a loop either.
  const short = { ...grid, beats: grid.beats.slice(0, -1) };
  assert.match(checkRange(short, 8, { startBar: 8, endBar: 8 }), /cannot come back round/);
  assert.deepEqual(checkRange(short, 8, { startBar: 6, endBar: 7 }), { startBar: 6, endBar: 7 });
});

test('a range is named after its section only when it is exactly one', () => {
  assert.equal(rangeName(sections, { startBar: 5, endBar: 5 }), 'fill');
  assert.equal(rangeName(sections, { startBar: 6, endBar: 8 }), 'verse');
  // A fill and the bar before it, or two sections in a row: the bars.
  assert.equal(rangeName(sections, { startBar: 4, endBar: 5 }), 'bars 4-5');
  assert.equal(rangeName(sections, { startBar: 1, endBar: 5 }), 'bars 1-5');
  assert.equal(rangeName(sections, { startBar: 7, endBar: 7 }), 'bar 7');
  assert.equal(rangeLabel(sections, { startBar: 6, endBar: 8 }), 'verse, bars 6-8');
  assert.equal(rangeLabel(sections, { startBar: 5, endBar: 5 }), 'fill, bar 5');
  assert.equal(rangeLabel(sections, { startBar: 4, endBar: 5 }), 'bars 4-5');
});

test('whatever was stored comes back as a ramp the slider can play', () => {
  assert.deepEqual(normaliseRamp(undefined), {
    on: false, from: 70, step: 5, every: 2, to: 100, gate: false,
  });
  const r = normaliseRamp({ on: true, from: 72, step: 7, every: 0, to: 60, gate: true });
  assert.equal(r.from, 70);
  assert.equal(r.step, 5);
  assert.equal(r.every, 1);
  // A ramp asked to go down stops where it starts.
  assert.equal(r.to, 70);
  assert.equal(normaliseRamp({ from: 'x' }).from, 70);
});

test('a ramp steps every N passes and stops at its top', () => {
  const ramp = normaliseRamp({ on: true, from: 70, step: 5, every: 2, to: 80 });
  let at = { tempo: 70, counted: 0 };
  const seen = [];
  for (let pass = 0; pass < 7; pass++) {
    at = rampAfterPass(ramp, at.tempo, at.counted, undefined);
    seen.push(at.tempo);
  }
  assert.deepEqual(seen, [70, 75, 75, 80, 80, 80, 80]);
});

test('a step never overshoots the top', () => {
  const ramp = normaliseRamp({ on: true, from: 70, step: 20, every: 1, to: 85 });
  assert.equal(rampAfterPass(ramp, 70, 0, undefined).tempo, 85);
});

test('a ramp carries on from a tempo nudged by hand', () => {
  const ramp = normaliseRamp({ on: true, from: 70, step: 5, every: 1, to: 100 });
  assert.equal(rampAfterPass(ramp, 85, 0, undefined).tempo, 90);
  // Above the top already: it leaves it alone.
  assert.equal(rampAfterPass(ramp, 110, 0, undefined).tempo, 110);
});

test('a gated ramp only counts good passes', () => {
  const ramp = normaliseRamp({ on: true, from: 70, step: 10, every: 2, to: 100, gate: true });
  let at = rampAfterPass(ramp, 70, 0, 0.95);
  assert.deepEqual(at, { tempo: 70, counted: 1 });
  at = rampAfterPass(ramp, at.tempo, at.counted, 0.5);
  assert.deepEqual(at, { tempo: 70, counted: 1 }, 'a bad pass does not count, and does not reset');
  at = rampAfterPass(ramp, at.tempo, at.counted, 0.9);
  assert.deepEqual(at, { tempo: 80, counted: 0 }, 'exactly 90% is good enough');
  // Nobody marking: every pass counts.
  assert.deepEqual(rampAfterPass(ramp, 70, 1, undefined), { tempo: 80, counted: 0 });
});

test('the ramp says where it is', () => {
  const ramp = normaliseRamp({ on: true, from: 70, step: 5, every: 2, to: 100 });
  assert.equal(rampSays(ramp), '70% → 100%, +5% every 2 passes');
  assert.equal(rampSays(ramp, { tempo: 80, counted: 1, marked: false }), '80% → 100%, next step after this pass');
  assert.equal(rampSays(ramp, { tempo: 80, counted: 0, marked: false }), '80% → 100%, next step after 2 more passes');
  assert.equal(rampSays(ramp, { tempo: 100, counted: 0, marked: false }), '100%, the top of the ramp');
  const gated = normaliseRamp({ on: true, from: 70, step: 5, every: 1, to: 100, gate: true });
  assert.equal(rampSays(gated), '70% → 100%, +5% every pass of 90% or better');
  assert.equal(
    rampSays(gated, { tempo: 75, counted: 0, marked: true }),
    '75% → 100%, next step after this pass, if it is 90% or better'
  );
  // The gate only means something while Record is marking.
  assert.equal(rampSays(gated, { tempo: 75, counted: 0, marked: false }), '75% → 100%, next step after this pass');
});

test('a paused transport is in the bar whose start it is not before', () => {
  assert.equal(barAtMs(grid, 0), -1, 'before bar 1');
  assert.equal(barAtMs(grid, 1998), -1);
  assert.equal(barAtMs(grid, 2000), 0);
  assert.equal(barAtMs(grid, 3000), 0);
  assert.equal(barAtMs(grid, 5999.6), 2, 'a hair before a bar it was seeked to is that bar');
  assert.equal(barAtMs(grid, 6500), 2);
  assert.equal(barAtMs(grid, 99999), 7, 'never past the last bar');
});
