// Placing a written note in the mix, browser side.
//
//   node --import ./scripts/ts-resolve.mjs --test scripts/test-chart.mjs
//
// These are deliberately the same cases as `tests/test_reference.py`, against
// the same numbers, because `slotToMixMs` here and `slot_to_seconds` there are
// twins: the player marks a take against one and `drums reference` measures the
// record against the other. If they drift apart the difference shows up as a
// timing fault belonging to nobody. The only difference is the unit -- the
// browser works in milliseconds, the pipeline in seconds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slotToMixMs } from '../src/chart.ts';

const grid = (beats, barOne = 0) => ({
  beats,
  bar_one_beat: barOne,
  meter: { beats_per_bar: 4, beat_unit: 4 },
});

/** Half-second beats make every expected answer obvious by eye. */
const STEADY = Array.from({ length: 16 }, (_, i) => i * 0.5);

test('slot zero is the first beat of bar one', () => {
  assert.equal(slotToMixMs(grid(STEADY, 2), 0), 1000);
});

test('a whole beat is four slots', () => {
  assert.equal(slotToMixMs(grid(STEADY), 4), 500);
  assert.equal(slotToMixMs(grid(STEADY), 8), 1000);
});

test('a slot between beats is placed proportionally', () => {
  assert.equal(slotToMixMs(grid(STEADY), 2), 250);
  assert.equal(slotToMixMs(grid(STEADY), 1), 125);
});

test('an uneven beat stretches the slots inside it', () => {
  // The drummer slowed down: the second beat is twice as long as the first.
  const g = grid([0, 0.5, 1.5, 2]);
  assert.equal(slotToMixMs(g, 4), 500);
  assert.equal(slotToMixMs(g, 6), 1000, 'half way through the long beat, not 250 ms in');
});

test('past the beat map it carries on at the last tempo', () => {
  const g = grid([0, 0.5, 1]);
  assert.equal(slotToMixMs(g, 8), 1000);
  assert.equal(slotToMixMs(g, 12), 1500);
  assert.equal(slotToMixMs(g, 14), 1750);
});

test('before bar one there is nothing to place against', () => {
  assert.equal(slotToMixMs(grid(STEADY, 0), -4), undefined);
});

test('a beat map too short to interpolate places nothing', () => {
  assert.equal(slotToMixMs(grid([1]), 0), undefined);
});
