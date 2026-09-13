// The scorer, tested the way the pipeline's solvers are: numeric invariants on
// a pure function, no browser and no screenshots.
//
//   node --import ./scripts/ts-resolve.mjs --test scripts/test-grade.mjs
//
// The cases that matter most are the ones the design was argued over: that a
// consistent offset and a scattered one produce the same mean but different
// spreads, and that the match window widens with the music while the reported
// error does not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grade } from '../src/grade.ts';

/** Written notes every `gapMs` apart, cycling through `instruments`. */
function chart(instruments, gapMs, count, startMs = 0) {
  const notes = [];
  for (let i = 0; i < count; i++) {
    const instrument = instruments[i % instruments.length];
    notes.push({
      bar: Math.floor(i / 4) + 1,
      inBar: (i % 4) * 4,
      slot: i * 4,
      instrument,
      velocity: 100,
      tMs: startMs + i * gapMs,
      limb: instrument === 'kick' ? 'right_foot' : 'right_hand',
    });
  }
  return notes;
}

const NOTE = { snare: 38, kick: 36, tom_high: 48, hihat_closed: 42 };
/** Play the chart back, each note shifted by `offset(i)` ms. */
function play(notes, offset = () => 0) {
  return notes.map((n, i) => ({
    tMs: n.tMs + offset(i),
    note: NOTE[n.instrument] ?? 60,
    velocity: 90,
    instrument: n.instrument,
  }));
}

test('a perfect take is every note hit, dead on', () => {
  const notes = chart(['snare', 'kick'], 500, 8);
  const { grade: g } = grade(notes, play(notes));
  assert.equal(g.expected, 8);
  assert.equal(g.hit, 8);
  assert.equal(g.missed, 0);
  assert.equal(g.extra, 0);
  assert.equal(g.accuracy, 1);
  assert.equal(g.timing.overall.meanMs, 0);
  assert.equal(g.timing.overall.sdMs, 0);
});

test('consistently late and randomly late are the same mean, different spread', () => {
  const notes = chart(['snare'], 500, 8);
  // Every note 20 ms late: an audio-path artifact, not a playing fault.
  const steady = grade(notes, play(notes, () => 20)).grade.timing.overall;
  // Alternating early and late by the same amount: mean zero, all spread.
  const jittery = grade(notes, play(notes, (i) => (i % 2 ? 20 : -20))).grade.timing.overall;

  assert.equal(steady.meanMs, 20);
  assert.equal(steady.sdMs, 0, 'a constant offset has no spread');
  assert.equal(jittery.meanMs, 0);
  assert.equal(jittery.sdMs, 20, 'scatter shows up as spread, not as mean');
  // The point of keeping them apart: one number cannot tell these apart.
  assert.equal(steady.maxAbsMs, jittery.maxAbsMs);
});

test('calibration comes off before anything is measured', () => {
  const notes = chart(['snare'], 500, 8);
  const events = play(notes, () => 20);
  const raw = grade(notes, events).grade.timing.overall;
  const corrected = grade(notes, events, { calibrationMs: 20 }).grade.timing.overall;
  assert.equal(raw.meanMs, 20);
  assert.equal(corrected.meanMs, 0, 'the take keeps raw stamps; the grade subtracts');
  assert.equal(corrected.sdMs, 0);
});

test('a note not played is missed, not silently dropped', () => {
  const notes = chart(['snare'], 500, 6);
  const events = play(notes).filter((_, i) => i !== 3);
  const { notes: verdicts, grade: g } = grade(notes, events);
  assert.equal(g.missed, 1);
  assert.equal(g.hit, 5);
  assert.equal(verdicts[3].verdict, 'missed');
  assert.equal(g.accuracy, round(5 / 6));
});

test('a stroke with nothing written near it is extra', () => {
  const notes = chart(['snare'], 500, 4);
  const events = [...play(notes), { tMs: 1250, note: 38, velocity: 90, instrument: 'snare' }];
  const { grade: g } = grade(notes, events);
  assert.equal(g.hit, 4);
  assert.equal(g.extra, 1);
  assert.equal(g.flam, 0);
  // Extras are never netted off the accuracy; they are their own count.
  assert.equal(g.accuracy, 1);
});

test('the right moment on the wrong drum is wrong-voice, not a miss plus an extra', () => {
  const notes = chart(['snare'], 500, 4);
  const events = play(notes);
  events[2] = { ...events[2], note: NOTE.tom_high, instrument: 'tom_high' };
  const { notes: verdicts, grade: g } = grade(notes, events);
  assert.equal(g.wrongVoice, 1);
  assert.equal(g.missed, 0, 'the written note is explained, not missing');
  assert.equal(g.extra, 0, 'and the stroke is explained, not spare');
  assert.equal(verdicts[2].verdict, 'wrong-voice');
  assert.equal(verdicts[2].played, 'tom_high');
});

test('a double bounce is a flam, not an extra note', () => {
  const notes = chart(['snare'], 500, 4);
  const events = [...play(notes), { tMs: 530, note: 38, velocity: 40, instrument: 'snare' }];
  const { grade: g } = grade(notes, events);
  assert.equal(g.flam, 1);
  assert.equal(g.extra, 0);
  assert.equal(g.hit, 4, 'the stroke that was on the beat still counts');
});

test('stage 1 widens with the music: the same error is a hit slow and a miss fast', () => {
  const late = 70;
  // Notes 500 ms apart: the window reaches 250 ms, so 70 ms late is that note.
  const slow = chart(['snare'], 500, 6);
  assert.equal(grade(slow, play(slow, () => late)).grade.hit, 6);

  // The same 70 ms against notes 100 ms apart: the window is 50 ms, so the
  // stroke is past the midpoint and belongs to the next note instead.
  const fast = chart(['snare'], 100, 6);
  const g = grade(fast, play(fast, () => late)).grade;
  assert.ok(g.hit < 6, 'a window that did not narrow would call this clean');
  assert.ok(g.missed > 0);
});

test('stage 2 does not scale: the reported error is real milliseconds', () => {
  const slow = chart(['snare'], 800, 5);
  const fast = chart(['snare'], 200, 5);
  const a = grade(slow, play(slow, () => 30)).grade.timing.overall;
  const b = grade(fast, play(fast, () => 30)).grade.timing.overall;
  assert.equal(a.meanMs, 30);
  assert.equal(b.meanMs, 30, 'the same lateness reads the same at any tempo');
});

test('windows meet at the midpoint and never overlap', () => {
  const notes = chart(['snare'], 400, 3);
  // Exactly half way between note 0 and note 1. It must be claimed once.
  const { notes: verdicts, grade: g } = grade(notes, [
    { tMs: 200, note: 38, velocity: 90, instrument: 'snare' },
  ]);
  assert.equal(g.hit, 1);
  assert.equal(g.extra, 0);
  assert.equal(g.missed, 2);
  assert.equal(verdicts.filter((v) => v.verdict === 'hit').length, 1);
});

test('the window is capped, so a lone crash does not swallow the room', () => {
  // One note with no neighbours: without a cap its window would be infinite.
  const notes = chart(['crash'], 1000, 1);
  const { grade: g } = grade(notes, [
    { tMs: 900, note: 49, velocity: 90, instrument: 'crash' },
  ]);
  assert.equal(g.hit, 0, '900 ms out is not that note by any reading');
  assert.equal(g.extra, 1);
  assert.equal(g.missed, 1);
});

test('per-limb timing separates the feet from the hands', () => {
  const notes = chart(['snare', 'kick'], 400, 8);
  // The kick drags, the hands are on time. One mean would hide it.
  const { grade: g } = grade(
    notes,
    play(notes, (i) => (notes[i].instrument === 'kick' ? 30 : 0))
  );
  assert.equal(g.timing.perLimb.right_hand.meanMs, 0);
  assert.equal(g.timing.perLimb.right_foot.meanMs, 30);
  assert.equal(g.timing.overall.meanMs, 15, 'which the overall mean averages away');
});

test('velocity is captured on every hit and never scored', () => {
  const notes = chart(['snare'], 500, 3);
  const events = play(notes).map((e, i) => ({ ...e, velocity: 40 + i * 30 }));
  const { notes: verdicts, grade: g } = grade(notes, events);
  assert.deepEqual(
    verdicts.map((v) => v.velocity),
    [40, 70, 100]
  );
  assert.equal(g.accuracy, 1, 'playing quietly is not playing wrongly');
});

// A hi-hat module decides open or closed from the pedal position at the instant
// of the strike, and its threshold is not where your foot thinks closed is. So a
// normal groove sends a mixture, and scored literally every flicker is a wrong
// note -- which buries the mistakes you actually made.
const HATS = [['hihat_closed', 'hihat_open']];

test('an open hat where a closed one is written is a hit, not a wrong note', () => {
  const notes = chart(['hihat_closed'], 300, 6);
  const events = play(notes).map((e, i) =>
    i % 2 ? { ...e, note: 46, instrument: 'hihat_open' } : e
  );
  const { grade: g } = grade(notes, events, { sameDrum: HATS });
  assert.equal(g.hit, 6);
  assert.equal(g.wrongVoice, 0, 'the drum and the moment were both right');
  assert.equal(g.extra, 0);
  assert.equal(g.missed, 0);
  assert.equal(g.accuracy, 1);
});

test('...but it is counted and named, not waved through', () => {
  const notes = chart(['hihat_closed'], 300, 6);
  const events = play(notes).map((e, i) =>
    i % 2 ? { ...e, note: 46, instrument: 'hihat_open' } : e
  );
  const { notes: verdicts, grade: g } = grade(notes, events, { sameDrum: HATS });
  assert.equal(g.sameDrum, 3, 'three landed on the other side of the threshold');
  assert.equal(verdicts[1].played, 'hihat_open');
  assert.equal(verdicts[0].played, undefined, 'a literal match says nothing extra');
});

test('grouping the hats does not excuse a tom where a snare is written', () => {
  const notes = chart(['snare'], 400, 4);
  const events = play(notes);
  events[2] = { ...events[2], note: NOTE.tom_high, instrument: 'tom_high' };
  const { grade: g } = grade(notes, events, { sameDrum: HATS });
  assert.equal(g.wrongVoice, 1, 'a different drum is still a different drum');
  assert.equal(g.sameDrum, 0);
});

test('a bounce counts as a flam even if the two strokes disagree about the pedal', () => {
  const notes = chart(['hihat_closed'], 400, 4);
  const events = [
    ...play(notes),
    { tMs: 430, note: 46, velocity: 40, instrument: 'hihat_open' },
  ];
  const { grade: g } = grade(notes, events, { sameDrum: HATS });
  assert.equal(g.flam, 1);
  assert.equal(g.extra, 0);
});

test('timing is unaffected by which side of the threshold the hat landed on', () => {
  const notes = chart(['hihat_closed'], 300, 6);
  const events = play(notes, () => 15).map((e, i) =>
    i % 2 ? { ...e, note: 46, instrument: 'hihat_open' } : e
  );
  const { grade: g } = grade(notes, events, { sameDrum: HATS });
  assert.equal(g.timing.overall.meanMs, 15);
  assert.equal(g.timing.overall.sdMs, 0);
  assert.equal(g.timing.overall.n, 6, 'all six are measured, not just the literal ones');
});

test('a note the input map has no name for is reported, not swallowed', () => {
  const notes = chart(['snare'], 500, 2);
  const events = [...play(notes), { tMs: 1200, note: 57, velocity: 90 }];
  const { grade: g } = grade(notes, events);
  assert.deepEqual(g.unmappedNotes, [57]);
  assert.equal(g.extra, 1);
});

test('worst bars rank by wrong notes first, then by how loose the rest were', () => {
  const notes = chart(['snare'], 250, 12); // 4 notes to a bar, 3 bars
  const events = play(notes, (i) => (i >= 8 ? 40 : 0)).filter((_, i) => i !== 0);
  const { grade: g } = grade(notes, events);
  assert.equal(g.worstBars[0].bar, 1, 'a missed note outranks a loose one');
  assert.equal(g.worstBars[0].wrong, 1);
  assert.equal(g.worstBars.find((b) => b.bar === 3).rmsMs, 40);
});

test('an empty take misses everything rather than dividing by zero', () => {
  const notes = chart(['snare'], 500, 4);
  const { grade: g } = grade(notes, []);
  assert.equal(g.missed, 4);
  assert.equal(g.accuracy, 0);
  assert.equal(g.timing.overall.n, 0);
  assert.equal(g.timing.overall.meanMs, 0);
});

const round = (x) => Math.round(x * 1000) / 1000;
