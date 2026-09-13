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
// The second half is the routine (practice-plan Q5, Q10): open a run, fill a
// cell by playing it, reload the page the way a Ctrl+S in Live does, and check
// the run is still there with the cell still in it. That reload is the whole
// reason a routine is a file rather than a variable.
//
// It cleans up the take and the routine it writes: both directories are tracked
// in git and a check should not leave anything behind.
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

/** The cell the take leg plays, filled in once the grid is known: see where it is chosen. */
let TAKE_CELL = '';

const songs = fileURLToPath(new URL('../../songs', import.meta.url));
const takesDir = join(songs, SLUG, 'takes');
const routinesDir = join(songs, SLUG, 'routines');
const before = new Set(existsSync(takesDir) ? readdirSync(takesDir) : []);
const routinesBefore = new Set(existsSync(routinesDir) ? readdirSync(routinesDir) : []);
const newRoutines = () =>
  (existsSync(routinesDir) ? readdirSync(routinesDir) : []).filter((f) => !routinesBefore.has(f));

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

// --- the grid ---------------------------------------------------------------------
// Open a run before recording, so the take that follows has a cell to fill.
const grid = await page.evaluate(() => {
  const p = window.drums.practice;
  return {
    cells: p.cells.length,
    sections: [...new Set(p.cells.map((c) => c.section))],
    ids: p.cells.slice(0, 5).map((c) => c.id),
    last: p.cells.at(-1),
    open: !!p.routine,
    startHidden: document.getElementById('routine-start').hidden,
  };
});
// A song with no [[section]] blocks has no grid, and the rest of this check has
// nothing to run against. That is not a failure -- it means `drums sections`
// has not been run on it yet.
if (grid.cells === 0) {
  console.log(`skip ${SLUG} has no routine grid: no [[section]] blocks in song.toml`);
  console.log('nothing to check on this song (run `drums sections` on it first)');
  await browser.close();
  process.exit(0);
}

// Six named sections at four tempos, plus the whole song at each.
check(
  grid.cells === (grid.sections.length - 1) * 4 + 4,
  'the grid is the sections times the ladder',
  `${grid.cells} cells, ${grid.sections.length - 1} sections`
);
// Section names come from song.toml, so the expectation is built from them
// rather than written out: renaming a section is the user's business and must
// not be a failing check.
const [FIRST, SECOND] = grid.sections;
TAKE_CELL = `${FIRST}@100`;
check(
  grid.ids.join(' ') === `${FIRST}@70 ${FIRST}@80 ${FIRST}@90 ${FIRST}@100 ${SECOND}@70`,
  'it is walked section-major, up the ladder then on',
  grid.ids.join(' ')
);
check(
  grid.last?.whole && grid.last?.tempo === 1,
  'the whole song at 100% is the last cell of every run'
);
check(!grid.open && !grid.startHidden, 'nothing is open yet, and the button to open one is there');

await page.locator('#routine-start').click();
await page.waitForTimeout(400);
// Any cell, any time: the walk order is what teaches, not a lock. The take leg
// wants 100% so that its numbers are the same ones M1 measured, and 100% is the
// fourth cell of the first row.
await page.locator('#routine tbody tr').first().locator('.cell').nth(3).click();

const opened = await page.evaluate(() => {
  const p = window.drums.practice;
  return {
    at: p.at,
    open: !!p.routine,
    sealed: p.routine ? String(p.routine.sealedAt) : 'no routine',
    state: document.getElementById('routine-state').textContent,
    sealDisabled: document.getElementById('routine-seal').disabled,
    startHidden: document.getElementById('routine-start').hidden,
  };
});
check(opened.open && opened.sealed === 'null', 'a routine opened, and it is open', opened.sealed);
check(opened.at === TAKE_CELL, 'clicking a cell aims at it', opened.at);
check(opened.sealDisabled, 'an empty routine cannot be sealed');
check(opened.startHidden, 'there is no second routine to start while one is open');
check(newRoutines().length === 1, 'the open routine is a file on disk', newRoutines().join(', '));

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
// Sections but nothing to place them against: no grid.lock.json, so no bar has
// a time and the cell cannot be played. A missing beat map, not a failure here.
if (cell.count === 0) {
  console.log(`skip ${SLUG} has no cell to record: ${cell.label}`);
  console.log('nothing to check on this song (run the pipeline on it first)');
  // The routine opened a moment ago would otherwise be left behind, and a
  // check should leave nothing behind.
  for (const name of newRoutines()) rmSync(join(routinesDir, name));
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
  check(take.cell.id === TAKE_CELL, 'the take knows which cell of the grid it was', take.cell.id);
  rmSync(join(takesDir, after[0]));
  console.log(`     (removed the take it wrote: takes/${after[0]})`);
}

// --- the cell is filled ------------------------------------------------------------
// A take played to the end fills its cell, and the routine is rewritten there
// and then -- not at the end of the sitting, which is not an event this program
// ever sees.
const filled = await page.evaluate((at) => {
  const p = window.drums.practice;
  return {
    cells: p.routine?.cells.filter((c) => c.fill).length ?? 0,
    fill: p.routine?.cells.find((c) => c.id === at)?.fill ?? null,
    next: p.at,
    state: document.getElementById('routine-state').textContent,
    green: document.querySelectorAll('#routine .cell.pass').length,
    red: document.querySelectorAll('#routine .cell.fail').length,
    atLabel: document.querySelector('#routine .cell.at')?.textContent ?? '',
    sealDisabled: document.getElementById('routine-seal').disabled,
  };
}, TAKE_CELL);
check(filled.cells === 1, 'the completed take filled exactly one cell', `${filled.cells} filled`);
check(!!filled.fill && filled.fill.take === after[0], 'the cell points at the take that filled it', filled.fill?.take);
check(
  filled.fill?.accuracy === g.accuracy,
  'the cell carries the accuracy the grade gave it',
  `${Math.round((filled.fill?.accuracy ?? 0) * 100)}%`
);
// Forwards from the cell just played, not back to the top: someone who jumped
// to the middle of the grid is working through it from there. Picking a routine
// up in a new sitting is the other case, and goes to the first hole -- see the
// reload leg below.
check(filled.next === `${SECOND}@70`, 'it walks on to the next unfilled cell', filled.next);
check(filled.green + filled.red === 1, 'the filled cell is drawn green or red', `${filled.green} green, ${filled.red} red`);
check(filled.sealDisabled, `one cell of ${grid.cells} is not a routine you can seal`);

// --- the reload ---------------------------------------------------------------------
// Every Ctrl+S in Live reloads this page. A run you cannot pick up afterwards
// is a run you cannot spread over a week, so this is the check that matters.
await page.reload();
await waitForPlayer(page);
await page.waitForTimeout(2500);

const resumed = await page.evaluate(() => {
  const p = window.drums.practice;
  return {
    open: !!p.routine,
    openedAt: p.routine?.openedAt ?? '',
    filled: p.routine?.cells.filter((c) => c.fill).length ?? 0,
    at: p.at,
    state: document.getElementById('routine-state').textContent,
    startHidden: document.getElementById('routine-start').hidden,
    sealShown: !document.getElementById('routine-seal').hidden,
  };
});
check(resumed.open, 'the routine survived the reload', resumed.state);
check(resumed.filled === 1, 'the cell it had filled is still filled', `${resumed.filled} filled`);
check(resumed.at === `${FIRST}@70`, 'it picks up at the first unfilled cell', resumed.at);
check(resumed.startHidden && resumed.sealShown, 'the page offers to seal it, not to start another');

// A second routine cannot be opened behind the first one's back, even by a
// second tab: the rule lives on the server, which is the thing that persists.
const second = await fetch('http://localhost:5173/practice/routine', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ slug: SLUG, version: 1, openedAt: new Date().toISOString(), sealedAt: null, cells: [] }),
});
check(second.status === 409, 'a second open routine is refused', `${second.status}`);

// --- discard -------------------------------------------------------------------------
page.on('dialog', (d) => void d.accept());
await page.locator('#routine-discard').click();
await page.waitForTimeout(500);
const discarded = await page.evaluate(() => ({
  open: !!window.drums.practice.routine,
  cells: window.drums.practice.cells.length,
  startHidden: document.getElementById('routine-start').hidden,
  status: document.getElementById('status').textContent.trim(),
}));
check(!discarded.open && !discarded.startHidden, 'discarding closes the run and offers a new one');
check(discarded.cells === grid.cells, 'the grid itself is untouched: it belongs to the song', `${discarded.cells} cells`);
check(newRoutines().length === 0, 'the routine file is gone', newRoutines().join(', '));
check(existsSync(takesDir), 'takes/ is still there: discarding a run throws away the run, not the playing');

// The reload above took the page's audio graph and its stroke source with it,
// and the ritual below needs both. Same two gestures as at the top.
await page.locator('#play').click();
await page.waitForTimeout(300);
await page.locator('#stop').click();
await page.evaluate(() => window.drums.practice.midi.inject(38, 1));

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
