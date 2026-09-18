// Taking the intro bars off a Live set, authoring side.
//
//   node --import ./scripts/ts-resolve.mjs --test scripts/test-ableton.mjs
//
// `bar_offset` exists because a set can be written against the record from the
// top of the track while the notation starts at the first kick or snare. One
// song is written that way (One For The Road, 3 bars of intro), and getting the
// number wrong is silent -- the chart still renders, it just sits on the wrong
// bars -- so the arithmetic is pinned here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shiftBars } from '../plugins/ableton.ts';

/** A note per bar for four bars, 4/4, so every expected beat is obvious. */
const NOTES = [0, 4, 8, 12].map((beat) => ({ beat, duration: 0.25, key: 36, velocity: 100 }));

test('no offset is the notes untouched', () => {
  const { notes, dropped } = shiftBars(NOTES, 0);
  assert.deepEqual(
    notes.map((n) => n.beat),
    [0, 4, 8, 12]
  );
  assert.equal(dropped, 0);
});

test('an offset takes whole bars off the front', () => {
  const { notes, dropped } = shiftBars(NOTES, 2);
  assert.deepEqual(
    notes.map((n) => n.beat),
    [0, 4]
  );
  assert.equal(dropped, 2, 'the two notes now before bar 1 are gone, not stacked on it');
});

test('the rest of a note survives the move', () => {
  const [note] = shiftBars([{ beat: 12, duration: 0.5, key: 38, velocity: 97 }], 3).notes;
  assert.deepEqual(note, { beat: 0, duration: 0.5, key: 38, velocity: 97 });
});

test('an offbeat keeps its place inside the bar', () => {
  const { notes } = shiftBars([{ beat: 13.5, duration: 0.25, key: 37, velocity: 100 }], 3);
  assert.equal(notes[0].beat, 1.5);
});

test('a meter other than 4/4 counts its own beats', () => {
  const { notes } = shiftBars([{ beat: 9, duration: 0.25, key: 36, velocity: 100 }], 3, 3);
  assert.equal(notes[0].beat, 0);
});

test('One For The Road: bar 4 of the set is bar 1 of the song', () => {
  // The set's first note is at beat 12, and the probe against the drum stem
  // put the chart 3 bars early -- so the first note belongs on the downbeat.
  const { notes, dropped } = shiftBars(
    [{ beat: 12, duration: 0.25, key: 36, velocity: 100 }],
    3
  );
  assert.equal(notes[0].beat, 0);
  assert.equal(dropped, 0, 'nothing is written in the intro, so nothing is lost');
});
