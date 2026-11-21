// The song map's words and shades: what kind of block a section is, and what
// the picker's line says about a range.
//
//   node --import ./scripts/ts-resolve.mjs --test scripts/test-songmap.mjs
//
// The map itself -- blocks, the tier, picking with the mouse -- is checked in
// a real browser (check-ui.mjs, check-loop.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kindOf, pickSaid } from '../src/songmap.ts';

const SONG2 = [
  { name: 'verse', start_bar: 1, end_bar: 7 },
  { name: 'into chorus', start_bar: 8, end_bar: 8 },
  { name: 'chorus', start_bar: 9, end_bar: 16 },
  { name: 'chorus to break', start_bar: 25, end_bar: 33 },
  { name: 'break', start_bar: 34, end_bar: 34 },
];

test('three shades: fills, choruses, the rest', () => {
  assert.equal(kindOf('into chorus'), 'fill');
  assert.equal(kindOf('break'), 'fill');
  assert.equal(kindOf('chorus to break'), 'chorus');
  assert.equal(kindOf('last chorus'), 'chorus');
  assert.equal(kindOf('verse'), 'verse');
  assert.equal(kindOf('build'), 'verse');
  // One For The Road's sections are letters.
  assert.equal(kindOf('A'), 'verse');
});

test('the picker says the section, the bars and how many', () => {
  assert.equal(pickSaid(SONG2, { startBar: 9, endBar: 16 }), 'chorus · bars 9–16 · 8 bars');
  assert.equal(pickSaid(SONG2, { startBar: 34, endBar: 34 }), 'break · bar 34 · 1 bar');
  // Not one section: the bars alone.
  assert.equal(pickSaid(SONG2, { startBar: 33, endBar: 34 }), 'bars 33–34 · 2 bars');
  assert.equal(pickSaid(SONG2, { startBar: 8, endBar: 16 }), 'bars 8–16 · 9 bars');
});
