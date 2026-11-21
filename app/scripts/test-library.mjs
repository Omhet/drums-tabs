// The library's words: a song's facts, and where you left off.
//
//   node --import ./scripts/ts-resolve.mjs --test scripts/test-library.mjs
//
// The page itself -- the rows, the pictures, the keys -- is checked in a real
// browser (check-ui.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { factsSaid, lastPlayed, leftOffSaid, lengthSaid } from '../src/library.ts';

const SONG2 = [
  { name: 'verse', start_bar: 1, end_bar: 7 },
  { name: 'into chorus', start_bar: 8, end_bar: 8 },
  { name: 'chorus', start_bar: 9, end_bar: 16 },
];
const ramp = { on: false, from: 70, step: 5, every: 2, to: 100, gate: false };

test('a length in minutes and seconds', () => {
  assert.equal(lengthSaid(123), '2:03');
  assert.equal(lengthSaid(206), '3:26');
  assert.equal(lengthSaid(59.6), '1:00');
});

test('the facts line, as Lamp-09 has it', () => {
  assert.equal(factsSaid({ seconds: 123, bpm: 130.43, bars: 65, video: true }), '2:03 · 130 BPM · 65 bars · video');
  assert.equal(factsSaid({ seconds: 167, bpm: 90.91, bars: 62, video: false }), '2:47 · 91 BPM · 62 bars');
  // No beat map: no tempo to say.
  assert.equal(factsSaid({ seconds: 167, bpm: 0, bars: 62, video: false }), '2:47 · 62 bars');
});

test('a song never played says nothing, even if it was opened', () => {
  assert.equal(leftOffSaid({}, SONG2), undefined);
  // Opening a song remembers its tempo; that is not playing it.
  assert.equal(leftOffSaid({ tempo: 100 }, SONG2), undefined);
});

test('where you left off: the whole song, or the loop by its name', () => {
  assert.equal(leftOffSaid({ played: 1, tempo: 85 }, SONG2), 'whole song at 85%');
  assert.equal(leftOffSaid({ played: 1 }, SONG2), 'whole song at 100%');
  const chorus = { range: { startBar: 9, endBar: 16 }, on: true, ramp };
  assert.equal(leftOffSaid({ played: 1, tempo: 80, loop: chorus }, SONG2), 'chorus looped at 80%');
  // Not one section: its bars.
  const bars = { range: { startBar: 9, endBar: 12 }, on: true, ramp };
  assert.equal(leftOffSaid({ played: 1, tempo: 70, loop: bars }, SONG2), 'bars 9–12 looped at 70%');
  // A loop remembered but off is the whole song.
  assert.equal(leftOffSaid({ played: 1, tempo: 90, loop: { ...chorus, on: false } }, SONG2), 'whole song at 90%');
});

test('the song played last is the latest one played', () => {
  const songs = [
    { slug: 'a', memory: { played: 5 } },
    { slug: 'b', memory: { tempo: 80 } },
    { slug: 'c', memory: { played: 9 } },
  ];
  assert.equal(lastPlayed(songs), 'c');
  assert.equal(lastPlayed([{ slug: 'b', memory: {} }]), undefined);
});
