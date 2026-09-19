// Exercises and drills, end to end, with no drum kit in the room.
//
// Usage: node scripts/check-exercise.mjs
//
// The fast end-to-end proof of the whole practice path. check-practice.mjs now
// records the *whole song*, which takes as long as the record does; a loop is
// three bars, so every verdict in the grading vocabulary is reached here
// instead, in half a minute.
//
// What it proves, in order of how much it would hurt to get wrong:
//
//  1. **The loop comes back to the same place.** Every rep is asserted to start
//     at the same absolute millisecond of mix.wav. That one assertion catches a
//     broken seek, a double-close at the seam and a stale clock anchor at once,
//     and it is the reason a rep can be graded against the same `expectedNotes`
//     array as the one before it.
//  2. **The seam keeps a late note.** A stroke played after the range ends --
//     which is what the last note of a fill routinely is -- arrives while the
//     transport is parked, so the clock cannot stamp it. It has to end up in
//     the rep that asked for it, at a time past the end, rather than as a very
//     early downbeat of the next one.
//  3. The cutting form refuses what cannot be fixed afterwards, the ladder
//     fills, the drill reaches disk, and a reload does not lose it.
//
// It cleans up the exercise it makes -- the pool is tracked in git and a check
// should leave nothing behind.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, pageUrl, waitForPlayer } from './browser.mjs';

const SLUG = process.env.SONG ?? 'hayley-williams-kill-me-official-visualizer';
const ID = 'check-exercise-tmp';
const NAME = 'check exercise tmp';
/** How late every replayed stroke is, in ms. Recovered as the drill's mean. */
const LATE_MS = 12;
/** How far past the end of the range the seam stroke lands. Inside EDGE_MS. */
const TAIL_MS = 60;
/** Reps to let run before stopping. Three is enough to have a median. */
const REPS = 3;

const root = fileURLToPath(new URL('../..', import.meta.url));
const poolDir = join(root, 'exercises');
const dir = join(poolDir, ID);
// Nothing of this check's should be here. A run that died half way could also
// have left a deduped `<ID>-2`, and inheriting one would put every count in
// this check out by one -- so the sweep is by prefix, not by exact name.
if (existsSync(poolDir)) {
  for (const name of readdirSync(poolDir)) {
    if (name.startsWith(ID)) rmSync(join(poolDir, name), { recursive: true, force: true });
  }
}

const problems = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(`http://localhost:5173/#${encodeURIComponent(SLUG)}`);
await waitForPlayer(page);
await page.waitForTimeout(1500);

// --- cutting one out -------------------------------------------------------------
// The picker is the section list, because every fill in a prepared song is
// already a [[section]] of its own -- so the form arrives mostly filled in.

const ready = await page.evaluate(() => ({
  sections: window.drums.current ? window.drums.songs.find((s) => s.slug === window.drums.current.slug)?.sections.length ?? 0 : 0,
  grid: !!window.drums.current?.grid,
  cells: window.drums.practice.cells.length,
}));
if (!ready.grid || ready.sections === 0) {
  console.log(`skip ${SLUG} has no sections or no beat map: nothing to cut out of it`);
  await browser.close();
  process.exit(0);
}

await page.locator('#exercise-new').click();
await page.waitForTimeout(200);

// A range with something written in it, which the form insists on. The check
// picks it rather than hardcoding bars, so renaming or renumbering a song's
// sections is the user's business and not a failing check.
const range = await page.evaluate(() => {
  const p = window.drums.practice;
  const grid = window.drums.current.grid;
  const song = window.drums.songs.find((s) => s.slug === window.drums.current.slug);
  for (const section of song.sections) {
    const bars = section.end_bar - section.start_bar + 1;
    if (bars < 1 || bars > 3) continue;
    if (p.notesIn(section.start_bar, section.end_bar) < 4) continue;
    // It has to be placeable in the mix at both ends, or it can never be played.
    const a = window.drums.barStartMs(grid, section.start_bar - 1);
    const b = window.drums.barStartMs(grid, section.end_bar);
    if (a === undefined || b === undefined) continue;
    return { startBar: section.start_bar, endBar: section.end_bar, name: section.name, endMs: b };
  }
  return null;
});
if (!range) {
  console.log(`skip ${SLUG} has no short section with notes in it to cut out`);
  await browser.close();
  process.exit(0);
}
console.log(`     cutting bars ${range.startBar}-${range.endBar} ("${range.name}")`);

/** Fill one of the form's fields, which are keyed by the word on screen. */
const field = (label) => page.locator(`#exercise-form [data-field="${label}"]`);

// First, the refusals -- none of them can be fixed after the file exists.
// `endBar + 1` rather than swapping the two, because a section can be one bar
// long and swapping those is not an inversion -- it is a valid exercise, and
// the form would cheerfully make one.
await field('From').selectOption('');
await field('Bars').fill(String(range.endBar + 1));
await field('to').fill(String(range.startBar));
await field('Name').fill(NAME);
await page.locator('#exercise-form button[type="submit"]').click();
await page.waitForTimeout(200);
check(
  /wrong way round/i.test(await page.locator('#exercise-form .why').textContent()),
  'bars the wrong way round are refused'
);

const silent = await page.evaluate(() => {
  const p = window.drums.practice;
  const last = window.drums.current.bars;
  for (let bar = last; bar > 1; bar--) if (p.notesIn(bar, bar) === 0) return bar;
  return 0;
});
if (silent) {
  await field('Bars').fill(String(silent));
  await field('to').fill(String(silent));
  await page.locator('#exercise-form button[type="submit"]').click();
  await page.waitForTimeout(200);
  check(
    /nothing written in them/i.test(await page.locator('#exercise-form .why').textContent()),
    'an exercise over bars with nothing in them is refused',
    `bar ${silent}`
  );
}

await field('Bars').fill('1');
await field('to').fill('40');
await page.locator('#exercise-form button[type="submit"]').click();
await page.waitForTimeout(200);
check(
  /a section, not an exercise/i.test(await page.locator('#exercise-form .why').textContent()),
  'a loop you cannot hold in your head is refused'
);

// Now the real one.
await field('Bars').fill(String(range.startBar));
await field('to').fill(String(range.endBar));
await field('Name').fill(NAME);
await field('Kind').selectOption('fill');
await field('Rest bars').fill('1');
await page.locator('#exercise-form button[type="submit"]').click();
await page.waitForTimeout(600);

check(existsSync(join(dir, 'exercise.json')), 'the exercise is a file on disk', `exercises/${ID}/`);
const written = existsSync(join(dir, 'exercise.json'))
  ? JSON.parse(readFileSync(join(dir, 'exercise.json'), 'utf-8'))
  : {};
check(written.version === 1 && written.id === ID, 'it is a v1 exercise with the id the name made', written.id);
check(
  written.sources?.length === 1 && written.sources[0].slug === SLUG,
  'it names the song it was cut from',
  written.sources?.[0]?.slug
);
check(
  /^sha256:/.test(written.sources?.[0]?.chartHash ?? ''),
  'the chart it was cut from is stamped on the source',
  written.sources?.[0]?.chartHash
);
check(
  written.sources?.[0]?.section === range.name,
  'the section it came out of is kept for the label',
  written.sources?.[0]?.section
);

const listed = await page.evaluate(() => ({
  rows: document.querySelectorAll('#exercises .ex').length,
  pips: document.querySelectorAll('#exercises .ex .pips i').length,
}));
check(listed.rows === 1, "it is on the song's list", `${listed.rows} rows`);
check(listed.pips === 4, 'with its four squares in miniature', `${listed.pips} pips`);

// --- the pool ---------------------------------------------------------------------

await page.evaluate(() => (location.hash = '#exercises'));
await page.waitForTimeout(800);
const pool = await page.evaluate(() => ({
  page: document.documentElement.dataset.page,
  rows: document.querySelectorAll('#pool .ex').length,
  shelves: [...document.querySelectorAll('#pool h2')].map((e) => e.textContent),
  stageHidden: getComputedStyle(document.getElementById('stage')).display === 'none',
  routineHidden: getComputedStyle(document.getElementById('routine').closest('.group')).display === 'none',
}));
check(pool.page === 'pool' && pool.stageHidden, 'the pool takes over the stage', pool.page);
check(pool.rows === 1, 'the exercise is in the pool', `${pool.rows}`);
check(pool.shelves.join(' ') === 'Fills', 'it is shelved by kind', pool.shelves.join(' '));
check(pool.routineHidden, 'the routine is not on the pool page: it belongs to a song');

// --- arming ---------------------------------------------------------------------

await page.evaluate((id) => (location.hash = `#exercise/${id}`), ID);
await page.waitForTimeout(1200);
// Drill it at 100%: the ladder would suggest 70%, and this check should not
// take longer than it has to.
await page.evaluate(() => {
  const squares = document.querySelectorAll('#ladder .cell');
  squares[squares.length - 1].click();
});
await page.waitForTimeout(400);

const armed = await page.evaluate(() => {
  const p = window.drums.practice;
  return {
    page: document.documentElement.dataset.page,
    id: p.armed?.exercise.id ?? '',
    tempo: p.armed?.tempo ?? 0,
    bars: p.armed ? `${p.armed.source.startBar}-${p.armed.source.endBar}` : '',
    expected: p.expected().length,
    label: document.getElementById('cell').textContent,
    word: document.getElementById('record').textContent.trim(),
    squares: document.querySelectorAll('#ladder .cell').length,
    empty: [...document.querySelectorAll('#ladder .cell')].every((e) => e.textContent === '·'),
    drillShown: getComputedStyle(document.getElementById('desk-drill')).display !== 'none',
    routineHidden: getComputedStyle(document.getElementById('routine').closest('.group')).display === 'none',
    speed: document.getElementById('speed').value,
  };
});
check(armed.page === 'exercise' && armed.id === ID, 'the link armed the exercise', `${armed.page} ${armed.id}`);
check(armed.bars === `${range.startBar}-${range.endBar}`, 'at the bars it was cut from', armed.bars);
check(armed.squares === 4 && armed.empty, 'its ladder is four squares, none of them played yet');
check(armed.drillShown && armed.routineHidden, 'the desk shows the drill, not the routine');
check(armed.word === 'Drill', 'the transport says what it is aimed at', armed.word);
check(armed.tempo === 1 && armed.speed === '100', 'picking a square sets the tempo', `${armed.speed}%`);
check(armed.expected > 0, 'the range has notes to be marked on', `${armed.expected} notes`);

// --- the drill --------------------------------------------------------------------
// Strokes go in through MidiIn.inject; everything after that is the real thing.
// Every written note is replayed LATE_MS late, and one extra stroke lands
// TAIL_MS past the end of the range -- the fill's last note, played a hair
// behind, which the transport is already parked for when it arrives.

await page.evaluate(() => window.drums.practice.midi.inject(38, 1));
await page.waitForTimeout(200);
await page.locator('#record').click();

await page.evaluate(
  ({ LATE_MS, TAIL_MS }) => {
    const p = window.drums.practice;
    const clock = window.drums.clock;
    const notes = p.expected();
    const noteOf = (instrument) => {
      for (const [n, name] of Object.entries(p.input.note)) if (name === instrument) return Number(n);
      return 38;
    };
    const endMs = notes.length
      ? window.drums.barStartMs(window.drums.current.grid, p.armed.source.endBar)
      : 0;
    window.__endMs = endMs;
    const planned = notes.map((n) => ({ tMs: n.tMs + LATE_MS, note: noteOf(n.instrument) }));
    const tailNote = noteOf('crash');
    window.__planned = planned.length + 1;
    let done = new Set();
    let tailQueued = false;
    window.__injector = setInterval(() => {
      if (window.drums.mix.paused) {
        // Parked at the end of a rep, or counting the next one in. Everything
        // is playable again when it comes back.
        done = new Set();
        tailQueued = false;
        return;
      }
      const now = performance.now();
      const mixNow = clock.mixTimeAt(now);
      const rate = window.drums.mix.playbackRate || 1;
      for (let i = 0; i < planned.length; i++) {
        if (done.has(i)) continue;
        const t = planned[i].tMs;
        if (t > mixNow + 30) continue;
        done.add(i);
        // Too far gone to place honestly -- the rep started mid-stream.
        if (t < mixNow - 300) continue;
        p.midi.inject(planned[i].note, 100, now + (t - mixNow) / rate);
      }
      // The seam. This one cannot be placed the way the others are: by the
      // time the clock reads `endMs + TAIL_MS` the transport has already
      // stopped, so there is no mix time to convert from. It is booked on the
      // wall clock instead, to *arrive* while the transport is parked -- which
      // is the whole point, because that is when a fill's last note arrives.
      if (!tailQueued && mixNow >= endMs - 400) {
        tailQueued = true;
        const wallAtEnd = now + (endMs - mixNow) / rate;
        const fireAt = wallAtEnd + TAIL_MS / rate;
        setTimeout(
          () => p.midi.inject(tailNote, 100, performance.now()),
          Math.max(0, fireAt - performance.now())
        );
      }
    }, 15);
  },
  { LATE_MS, TAIL_MS }
);

// Let REPS go round, then stop mid-rep so the abandoned-rep rule is exercised
// too. A rep is the range plus a bar of rest, at the tempo it is drilled at.
const repMs = await page.evaluate((startBar) => {
  const grid = window.drums.current.grid;
  const p = window.drums.practice;
  const a = window.drums.barStartMs(grid, startBar - 1);
  const perBar = (window.drums.barStartMs(grid, startBar) ?? a + 2000) - a;
  return ((window.__endMs - a) + perBar * p.armed.exercise.restBars) / p.armed.tempo;
}, range.startBar);
console.log(`     about ${Math.ceil(repMs / 1000)}s a rep; running ${REPS} of them`);
await page.waitForFunction(
  (n) => document.querySelectorAll('#reps .rep').length >= n,
  REPS,
  { timeout: repMs * (REPS + 2) + 30000 }
);
// A chip appears when a rep *closes*, which is the start of the rest -- so
// stopping right now would stop during the rest, with no rep open to abandon.
// Wait for the music to come back, then stop part way through it.
await page.waitForFunction(() => !window.drums.mix.paused, null, { timeout: 30000 });
await page.waitForTimeout(900);
await page.locator('#record').click();
await page.evaluate(() => clearInterval(window.__injector));
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const chips = [...document.querySelectorAll('#reps .rep')];
  const heads = [...document.querySelectorAll('#score svg text')].map((t) => t.getAttribute('fill'));
  const fills = {};
  for (const f of heads) if (f) fills[f] = (fills[f] ?? 0) + 1;
  return {
    chips: chips.length,
    part: chips.filter((e) => e.className.includes('part')).length,
    ladder: [...document.querySelectorAll('#ladder .cell')].map((e) => e.textContent),
    dials: [...document.querySelectorAll('#report .dial .label')].map((e) => e.textContent),
    notesSub: document.querySelector('#report .dial .sub')?.textContent ?? '',
    stripBars: document.querySelectorAll('#report .strip .bar').length,
    coloured: Object.entries(fills).filter(([f]) => /^#/.test(f) && f !== '#B4B4B4').length,
    status: document.getElementById('status').textContent.trim(),
    armedStill: window.drums.practice.armed?.exercise.id ?? '',
  };
});

check(out.chips === REPS + 1, 'one chip per rep, the abandoned one included', `${out.chips} chips`);
check(out.part === 1, 'the rep you stop in is drawn as unfinished', `${out.part} partial`);
check(
  out.dials.join(' ') === 'Notes Steady Feel',
  'the reading is the same three dials a take gets',
  out.dials.join(' ')
);
check(/^rep \d+ of \d+$/.test(out.notesSub), 'and it says which rep it is of', out.notesSub);
check(
  out.stripBars === range.endBar - range.startBar + 1,
  'the bar strip covers the range, not the song',
  `${out.stripBars} blocks`
);
check(out.coloured >= 1, 'the noteheads are coloured by verdict', `${out.coloured} colours`);

// --- what reached disk --------------------------------------------------------------

const drillsDir = join(dir, 'drills');
const drills = existsSync(drillsDir) ? readdirSync(drillsDir) : [];
check(drills.length === 1, 'exactly one drill was written', drills.join(', ') || 'none');
if (drills.length === 1) {
  const d = JSON.parse(readFileSync(join(drillsDir, drills[0]), 'utf-8'));
  check(/-100\.json$/.test(drills[0]), 'its name says when and how fast', drills[0]);
  check(d.version === 1 && d.exercise === ID, 'it is a v1 drill and knows what it is');
  check(d.reps.length === REPS + 1, 'every rep is in it, finished or not', `${d.reps.length} reps`);
  check(d.completeReps === REPS, 'only the finished ones are counted', `${d.completeReps}`);
  check(
    d.reps.filter((r) => r.complete).length === REPS,
    'the abandoned rep is on disk and marked'
  );

  // (1) The loop comes back to the same place. Every rep plays the same
  // milliseconds of mix.wav, which is what lets one expectedNotes array serve
  // all of them.
  const firsts = d.reps.filter((r) => r.complete && r.events.length).map((r) => r.events[0].tMs);
  const spread = Math.max(...firsts) - Math.min(...firsts);
  check(
    spread <= 30,
    'every rep starts at the same millisecond of the record',
    `${firsts.map(Math.round).join(', ')} ms`
  );

  // (2) The seam keeps a late note. It arrived after the transport parked, so
  // the clock could not stamp it -- it is placed from the wall clock instead.
  const endMs = range.endMs;
  const tails = d.reps
    .filter((r) => r.complete)
    .map((r) => r.events.filter((e) => e.tMs > endMs).map((e) => Math.round(e.tMs - endMs)));
  check(
    tails.every((t) => t.length === 1),
    'a stroke played after the range ends stays in the rep that asked for it',
    tails.map((t) => t.join('/') || 'none').join(', ')
  );
  check(
    tails.every((t) => t[0] !== undefined && Math.abs(t[0] - TAIL_MS) <= 40),
    'and it keeps how late it was, rather than collapsing onto the end',
    `${tails.map((t) => t[0]).join(', ')} ms vs ${TAIL_MS}`
  );
  check(
    d.reps.every((r) => r.events.every((e) => e.tMs >= endMs - 60000)),
    'no rep caught a stroke from the one before it'
  );

  // The score, and the rules it is made of.
  const accuracies = d.reps.filter((r) => r.complete).map((r) => r.grade.accuracy).sort((a, b) => a - b);
  const mid = accuracies[accuracies.length >> 1];
  check(
    Math.abs(d.accuracy - mid) < 1e-9,
    'the drill scores as the median of its complete reps',
    `${d.accuracy} of ${accuracies.join(', ')}`
  );
  check(d.best === accuracies[accuracies.length - 1] && d.worst === accuracies[0], 'with the range it sits in');
  check(/^sha256:/.test(d.chartHash), 'the chart it was graded against is on it', d.chartHash);
  check(d.restBars === 1 && d.backing === 'record', 'so is how it was played');
  check(
    d.reps.every((r) => r.events.every((e) => typeof e.velocity === 'number' && e.velocity > 0)),
    'velocity is captured on every stroke'
  );
  // The song's reference floor comes off every stroke before it is matched
  // (reference.ts), so the number that comes back is the lateness minus it.
  // Asserting the arithmetic is how we know the floor is applied to a drill and
  // not only to a take.
  const floored = LATE_MS - (d.referenceMs ?? 0);
  check(
    Math.abs((d.timing?.meanMs ?? 99) - floored) <= 6,
    'the injected lateness comes back with the reference floor taken off',
    `${d.timing?.meanMs} ms vs ${floored.toFixed(1)} ms (${LATE_MS} injected - ${d.referenceMs ?? 0} floor)`
  );
  check(out.ladder[3] === `${Math.round(d.accuracy * 100)}%`, 'the square shows the drill', out.ladder.join(' '));
}

// --- click only -------------------------------------------------------------------------
// The stems come down through the mixer directly, never through the sliders --
// the sliders persist to localStorage, and Ableton reloads this page on every
// Ctrl+S, so a drill interrupted half way would otherwise leave the song
// silently muted with nothing on screen to say why. That is what the "put them
// back" half of this checks; it matters more than the "pull them down" half.

await page.evaluate(async (id) => {
  const res = await fetch('/practice/exercises');
  const { exercises } = await res.json();
  const ex = exercises.find((e) => e.exercise.id === id).exercise;
  await fetch('/practice/exercise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...ex, backing: 'click' }),
  });
}, ID);
await page.reload();
await waitForPlayer(page);
await page.waitForTimeout(2000);

const before = await page.evaluate(() => ({
  nodrums: window.drums.mixer.level('nodrums'),
  drums: window.drums.mixer.level('drums'),
}));
await page.evaluate(() => window.drums.practice.midi.inject(38, 1));
await page.waitForTimeout(200);
await page.locator('#record').click();
await page.waitForTimeout(700);
const during = await page.evaluate(() => ({
  nodrums: window.drums.mixer.level('nodrums'),
  drums: window.drums.mixer.level('drums'),
  held: document.getElementById('mix-group').dataset.held === '1',
  disabled: document.getElementById('fader-nodrums').disabled,
  // The sliders must not have moved: moving them is what writes to storage.
  slider: document.getElementById('fader-drums').value,
  stored: JSON.parse(localStorage.getItem('mix') ?? '{}').drums,
}));
check(
  during.nodrums === 0 && during.drums === 0,
  'a click-only drill pulls both stems down',
  `${during.nodrums}/${during.drums}`
);
check(during.held && during.disabled, 'and the page shows it is holding them');
check(
  during.slider !== '0' && during.stored !== 0,
  'without moving the sliders, which is what would persist it',
  `slider ${during.slider}, stored ${during.stored}`
);

await page.locator('#record').click();
await page.waitForTimeout(800);
const after = await page.evaluate(() => ({
  nodrums: window.drums.mixer.level('nodrums'),
  drums: window.drums.mixer.level('drums'),
  held: document.getElementById('mix-group').dataset.held === '1',
  disabled: document.getElementById('fader-nodrums').disabled,
}));
check(
  after.nodrums === before.nodrums && after.drums === before.drums,
  'and gives them back when it ends',
  `${after.nodrums}/${after.drums} was ${before.nodrums}/${before.drums}`
);
check(!after.held && !after.disabled, 'with the sliders yours again');

// --- the reload -----------------------------------------------------------------------
// Every Ctrl+S in Live reloads this page. A drill is a file, not a variable.

await page.reload();
await waitForPlayer(page);
await page.waitForTimeout(2500);
const resumed = await page.evaluate(() => ({
  page: document.documentElement.dataset.page,
  armed: window.drums.practice.armed?.exercise.id ?? '',
  ladder: [...document.querySelectorAll('#ladder .cell')].map((e) => e.textContent),
}));
check(resumed.page === 'exercise' && resumed.armed === ID, 'the link re-arms it after a reload', resumed.armed);
check(
  resumed.ladder[3] !== '·',
  'the square it filled is still filled: a drill is a file, not a variable',
  resumed.ladder.join(' ')
);

// --- the trend ------------------------------------------------------------------------
// Drilling three more sittings for real would take three more minutes, so they
// are posted straight to the route. What this checks is the *reading* of a
// history, not the making of one.

const SCORES = [0.5, 0.9, 0.7];
await page.evaluate(
  async ({ ID, SCORES }) => {
    for (let i = 0; i < SCORES.length; i++) {
      const at = `2026-08-0${i + 1}T10:00:00.000Z`;
      await fetch('/practice/drill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          exercise: ID,
          startedAt: at,
          endedAt: at,
          source: { slug: 'x', startBar: 1, endBar: 2 },
          tempo: 0.7,
          restBars: 1,
          backing: 'record',
          calibrationMs: 0,
          chartHash: 'sha256:synthetic',
          accuracy: SCORES[i],
          completeReps: 4,
          timing: { meanMs: 3, sdMs: 14 },
          best: SCORES[i],
          worst: SCORES[i],
          reps: [],
        }),
      });
    }
  },
  { ID, SCORES }
);
await page.reload();
await waitForPlayer(page);
await page.waitForTimeout(2500);

const trend = await page.evaluate(() => ({
  head: document.querySelector('#ladder th.trend-head')?.textContent ?? '',
  lines: document.querySelectorAll('#ladder tr.trends td.trend svg').length,
  points: [...document.querySelectorAll('#ladder tr.trends polyline')].map(
    (e) => e.getAttribute('points').split(' ').length
  ),
  slow: [...document.querySelectorAll('#ladder .cell')][0]?.textContent ?? '',
}));
check(trend.head === '4 drills', 'the ladder says how many sittings are on it', trend.head);
check(trend.lines >= 1, 'the tempo with a history has a line under it', `${trend.lines} lines`);
check(trend.points[0] === SCORES.length, 'one point per sitting at that tempo', `${trend.points[0]}`);
// 0.5, 0.9, 0.7 -> medians 0.5, 0.7, 0.7: the spike is absorbed.
check(trend.slow === '70%', 'the newest sitting is the square, not the best one', trend.slow);

// --- cleaning up ------------------------------------------------------------------------

await page.evaluate((id) => window.drums.exercises.remove(id), ID);
// `remove` confirms first, and a dialog with nobody listening blocks the page.
page.on('dialog', (d) => void d.accept());
await page.waitForTimeout(600);
for (const name of existsSync(poolDir) ? readdirSync(poolDir) : []) {
  if (name.startsWith(ID)) rmSync(join(poolDir, name), { recursive: true, force: true });
}
check(!existsSync(dir), 'the exercise it made is gone, drills and all');
check(
  !(existsSync(poolDir) ? readdirSync(poolDir) : []).some((n) => n.startsWith(ID)),
  'and it made exactly the one it meant to'
);

const shots = fileURLToPath(new URL('../shots', import.meta.url));
mkdirSync(shots, { recursive: true });
await page.screenshot({ path: join(shots, 'exercise.png') });

check(pageErrors.length === 0, 'no page errors', pageErrors.join(' | '));
console.log(`\nstatus: ${out.status}`);
await browser.close();

if (problems.length) {
  console.log(`\n${problems.length} problem${problems.length > 1 ? 's' : ''}:`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\nall checks passed');
