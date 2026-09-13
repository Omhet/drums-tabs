// Practice mode, end to end, with no drum kit in the room.
//
// Usage: node scripts/check-practice.mjs
//
// The one thing a headless check cannot do is hit a pad, so it injects strokes
// through `MidiIn.inject` instead -- but everything after that is the real
// thing: the real clock stamps them, the real scorer marks them, the real
// alphaTab colours the noteheads and the real dev-server route writes the take
// to disk. It plays a deliberately imperfect take -- every note a little late,
// one note skipped, one stroke nobody wrote, one note on the wrong drum and
// one double bounce -- so that every verdict in the vocabulary has to be
// reached, and every one of them has to be drawn.
//
// Strokes are placed by converting a target mix time back into the
// `performance.now()` moment that maps to it, so they land where they are
// meant to rather than wherever the timer happened to fire.
//
// It cleans up the take it writes: takes/ is tracked in git and a check should
// not leave anything behind.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, pageUrl, waitForPlayer } from './browser.mjs';

const SLUG = process.env.SONG ?? 'hayley-williams-kill-me-official-visualizer';
/** How late every injected stroke is, in ms. Recovered as the take's mean. */
const LATE_MS = 18;
// One of each mistake, by index into the cell's written notes, so that all
// five verdicts have to be reached and all five have to be drawn.
const SKIP = 5; // played not at all      -> missed
const EXTRA_AFTER = 9; // plus a stroke nobody wrote  -> extra
const WRONG = 15; // played on a tom instead     -> wrong-voice
const FLAM = 21; // played twice, a bounce      -> flam

const songs = fileURLToPath(new URL('../../songs', import.meta.url));
const takesDir = join(songs, SLUG, 'takes');
const before = new Set(existsSync(takesDir) ? readdirSync(takesDir) : []);

const problems = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

const browser = await launch();
const context = await browser.newContext();
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(pageUrl(`http://localhost:5173/`).replace(/#.*$/, '') + `#${encodeURIComponent(SLUG)}`);
await waitForPlayer(page);
await page.waitForTimeout(2500);

// The audio graph is built on a user gesture, and the recording needs it.
await page.locator('#play').click();
await page.waitForTimeout(300);
await page.locator('#stop').click();

// Chrome will not hand Web MIDI to an automated browser however the permission
// is set, so this primes the injector instead. The stroke lands before
// recording starts and is therefore never counted -- it only tells practice
// mode that something is feeding it strokes.
const ready = await page.evaluate(() => {
  const p = window.drums.practice;
  p.midi.inject(38, 1);
  return p.midi.hasSource;
});
check(ready, 'practice mode has a stroke source');

// Whatever calibration this machine has is a real measurement of someone's
// audio path; it is put back at the end. The take leg needs a *known* one, so
// it runs against none at all.
const CALIBRATION = 'http://localhost:5173/practice/calibration';
const savedCalibration = await (await fetch(CALIBRATION)).json();
const setCalibration = async (value) => {
  await fetch(CALIBRATION, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  await page.evaluate(() => window.drums.practice.reloadCalibration());
};
await setCalibration(null);

const cell = await page.evaluate(() => {
  const p = window.drums.practice;
  const notes = p.expected();
  return {
    count: notes.length,
    first: notes[0]?.tMs ?? 0,
    last: notes[notes.length - 1]?.tMs ?? 0,
    label: document.getElementById('cell').textContent,
    instruments: [...new Set(notes.map((n) => n.instrument))],
    limbs: [...new Set(notes.map((n) => n.limb))],
  };
});
// A song with no [[section]] blocks has no cell to practise, which is not a
// failure -- it means `drums sections <slug>` has not been run on it yet.
if (cell.count === 0) {
  console.log(`skip ${SLUG} has no cell to record: ${cell.label}`);
  console.log('nothing to check on this song (run `drums sections` on it first)');
  await browser.close();
  process.exit(0);
}
check(cell.count > 0, 'the cell has notes to play', `${cell.count} notes in ${cell.label}`);
check(cell.limbs.every((l) => l !== 'hands'), 'every note has a real limb from the sticking lock', cell.limbs.join(', '));

// Start recording, then feed the cell back in, with one of each mistake.
await page.locator('#record').click();
await page.evaluate(
  ({ LATE_MS, SKIP, EXTRA_AFTER, WRONG, FLAM }) => {
    const p = window.drums.practice;
    const clock = window.drums.clock;
    const notes = p.expected();
    // instrument -> a module note number that means it, from kit.toml.
    const noteFor = {};
    for (const [n, name] of Object.entries(p.input.note)) noteFor[name] ??= Number(n);

    const planned = [];
    notes.forEach((note, i) => {
      if (i === SKIP) return;
      // The cell is kick/snare/hats, so a tom is unambiguously the wrong drum
      // at a moment when something was written.
      const instrument = i === WRONG ? 'tom_high' : note.instrument;
      planned.push({ tMs: note.tMs + LATE_MS, note: noteFor[instrument] ?? 38, velocity: 90 });
      if (i === EXTRA_AFTER) {
        // A stroke on the snare a 32nd later: nothing is written there.
        planned.push({ tMs: note.tMs + 90, note: noteFor.snare, velocity: 70 });
      }
      if (i === FLAM) {
        // The same drum again 30 ms later: a bounce, not a second note.
        planned.push({ tMs: note.tMs + LATE_MS + 30, note: noteFor[note.instrument], velocity: 35 });
      }
    });
    planned.sort((a, b) => a.tMs - b.tMs);

    let next = 0;
    window.__armedAt = performance.now();
    window.__injector = setInterval(() => {
      // The count-in runs with the transport parked on the cell's first beat.
      // Nothing is captured then, so nothing is played then either.
      if (window.drums.mix.paused) return;
      window.__startedAt ??= performance.now();
      const now = performance.now();
      const mixNow = clock.mixTimeAt(now);
      const rate = window.drums.mix.playbackRate || 1;
      while (next < planned.length && planned[next].tMs <= mixNow + 30) {
        const target = planned[next];
        // The performance.now() moment that maps to this mix time, so the
        // stroke lands where it is aimed rather than where the timer fired.
        p.midi.inject(target.note, target.velocity, now + (target.tMs - mixNow) / rate);
        next++;
      }
    }, 15);
    window.__planned = planned.length;
  },
  { LATE_MS, SKIP, EXTRA_AFTER, WRONG, FLAM }
);

// Let the cell play out. The recorder stops itself at the end of the last bar.
await page.waitForFunction(() => !document.getElementById('record').dataset.armed, null, {
  timeout: 120000,
});
await page.evaluate(() => clearInterval(window.__injector));
await page.waitForTimeout(1200);

const out = await page.evaluate(() => {
  const g = window.drums.practice.result?.grade;
  const heads = [...document.querySelectorAll('#score svg text')].map((t) => t.getAttribute('fill'));
  const fills = {};
  for (const f of heads) if (f) fills[f] = (fills[f] ?? 0) + 1;
  return {
    grade: g,
    planned: window.__planned,
    fills,
    reportShown: !document.getElementById('report').hidden,
    reportText: document.getElementById('report').textContent.replace(/\s+/g, ' ').trim(),
    extrasDrawn: document.querySelectorAll('.extras span').length,
    countInMs: (window.__startedAt ?? 0) - (window.__armedAt ?? 0),
    status: document.getElementById('status').textContent.trim(),
  };
});

const g = out.grade ?? {};
check(!!out.grade, 'the take was graded');
// One bar at 90.91 BPM is 2.64 s. Without it the first section of a song is
// unrecordable: bar 1 starts 360 ms into the mix, with no run-up to play.
check(
  out.countInMs > 1500,
  'a bar of count-in ran before the music',
  `${Math.round(out.countInMs)} ms`
);
check(g.expected === cell.count, 'every written note in the cell was judged', `${g.expected}`);
check(g.hit === cell.count - 2, 'every note played on the right drum was matched', `hit ${g.hit}/${g.expected}`);
check(g.missed === 1, 'the skipped note is missed', `missed ${g.missed}`);
check(g.extra === 1, 'the unwritten stroke is extra', `extra ${g.extra}`);
check(g.wrongVoice === 1, 'the tom is wrong-voice, not a miss plus an extra', `wrong-voice ${g.wrongVoice}`);
check(g.flam === 1, 'the bounce is a flam, not a second note', `flam ${g.flam}`);
check(g.hit + g.missed + g.wrongVoice === g.expected, 'every written note got exactly one verdict');

// Stage 2: the lateness that went in is the lateness that comes out.
const mean = g.timing?.overall?.meanMs ?? 0;
check(Math.abs(mean - LATE_MS) <= 4, 'the injected offset is recovered as the mean', `${mean} ms vs ${LATE_MS} ms`);
check((g.timing?.overall?.sdMs ?? 99) <= 4, 'a steady take reads as steady, not scattered', `sd ${g.timing?.overall?.sdMs} ms`);
check(Object.keys(g.timing?.perLimb ?? {}).length >= 2, 'timing is split per limb', Object.keys(g.timing?.perLimb ?? {}).join(', '));

// The heatmap: the noteheads are no longer all one colour.
const coloured = Object.entries(out.fills).filter(([f]) => /^#/.test(f) && f !== '#B4B4B4');
const colouredCount = coloured.reduce((a, [, n]) => a + n, 0);
check(colouredCount >= cell.count, 'noteheads are coloured by verdict', `${colouredCount} coloured: ${coloured.map(([f, n]) => `${f}x${n}`).join(' ')}`);
check(coloured.length >= 3, 'hit, missed and wrong-voice are all distinguishable', `${coloured.length} colours`);
check(out.extrasDrawn === 2, 'the extra and the flam both got a marker in the lane', `${out.extrasDrawn}`);
check(out.reportShown && /Mean|mean/.test(out.reportText), 'the timing strip is on screen');

// And the take reached the disk, with both hashes on it.
const after = existsSync(takesDir) ? readdirSync(takesDir).filter((f) => !before.has(f)) : [];
check(after.length === 1, 'exactly one take was written', after.join(', ') || 'none');
if (after.length === 1) {
  const take = JSON.parse(readFileSync(join(takesDir, after[0]), 'utf-8'));
  check(take.version === 1 && take.complete === true, 'it is a complete v1 take');
  check(/^sha256:/.test(take.chartHash), 'chartHash is on it', take.chartHash);
  check(/^sha256:/.test(take.sectionsHash), 'sectionsHash is on it', take.sectionsHash);
  check(take.events.length === out.planned, 'every stroke is in it', `${take.events.length} events`);
  check(
    take.grade.wrongVoice === 1 && take.grade.flam === 1,
    'the grade on disk is the grade on screen'
  );
  check(
    take.events.every((e) => typeof e.velocity === 'number' && e.velocity > 0),
    'velocity is captured on every stroke'
  );
  check(!('slug' in take), 'the slug is in the path, not duplicated in the file');
  // Raw, uncorrected: the grade is a reading of the take, not baked into it.
  const firstWritten = cell.first;
  const drift = Math.abs(take.events[0].tMs - (firstWritten + LATE_MS));
  check(drift < 25, 'timestamps are raw mix time', `first event ${Math.round(take.events[0].tMs)} ms vs written ${Math.round(firstWritten)} ms`);
  rmSync(join(takesDir, after[0]));
  console.log(`     (removed the take it wrote: takes/${after[0]})`);
}

// --- the calibration ritual -----------------------------------------------------
// The number every take in the history is corrected by, so it is checked rather
// than trusted: strokes go in exactly `CAL_LATE_MS` after each click is *heard*
// (which is not when it was scheduled -- the output buffer sits between), and
// that is what has to come back out.
const CAL_LATE_MS = 23;
await page.locator('#calibrate').click();
const cal = await page.evaluate(
  ({ CAL_LATE_MS }) =>
    new Promise((resolve) => {
      const p = window.drums.practice;
      const run = p.calibrating;
      if (!run) return resolve({ error: 'the ritual did not start' });
      // One stroke per measured beat, each the same lateness after its click.
      for (let beat = run.countIn; beat < run.totalBeats; beat++) {
        const at = run.heardAt(beat) + CAL_LATE_MS;
        setTimeout(() => p.midi.inject(38, 90, at), Math.max(0, at - performance.now()) + 5);
      }
      run.done.then(resolve, (e) => resolve({ error: String(e.message) }));
    }),
  { CAL_LATE_MS }
);

check(!cal.error, 'the calibration ritual completed', cal.error ?? `${cal.n} hits`);
check(
  Math.abs((cal.offsetMs ?? 0) - CAL_LATE_MS) <= 3,
  'the lateness played is the lateness measured',
  `${cal.offsetMs} ms vs ${CAL_LATE_MS} ms`
);
check((cal.spreadMs ?? 99) <= 3, 'a steady ritual reports a tight spread', `±${cal.spreadMs} ms`);
check(cal.note === 38, 'the pad it was measured on is recorded', `note ${cal.note}`);
check(cal.n >= 28, 'it measured the eight bars and not the count-in', `${cal.n} hits`);

await setCalibration(savedCalibration);
check(true, 'the machine calibration was put back', JSON.stringify(savedCalibration));

check(pageErrors.length === 0, 'no page errors', pageErrors.slice(0, 3).join(' | '));

console.log(`\nstatus: ${out.status}`);
console.log(`report: ${out.reportText.slice(0, 240)}`);

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} failed: ${problems.join('; ')}`);
  process.exit(1);
}
console.log('\nall checks passed');
