// An exercise that carries its own notes, played with no song at all.
//
// `check-exercise.mjs` is the record path: a cut out of a real chart, drilled
// against the recording, graded against the beat map the drummer actually
// played. This is the other half -- the same exercise with nothing behind it,
// which is the thing the pool was always meant to be and could not do while an
// exercise was a view of a song.
//
// Four things it proves, and they are the four that were not true before:
//
//  1. **No song is loaded.** Not muted, not paused -- never fetched. The mix
//     element's `src` is still empty when the exercise is playing.
//  2. **The notes came with it.** `exercise.json` carries a chart, re-based so
//     its own first bar is bar 1, and the scorer marks against that.
//  3. **It loops on Play**, on a clock that is not a recording (timer-clock.ts),
//     coming back to the same millisecond every time round.
//  4. **It makes a sound of its own** -- the kit bus, silent at 0 and loud when
//     it is up, measured on the graph's analyser the way check-mix does.
//
// And since the bank became a real sampler (bank.ts), three more, because all
// three fail silently and none of them is audible in a screenshot: the bank
// loaded at all, the same note twice is two different recordings, and a hit
// that should cut an open hi-hat short knows that it should.
//
// Needs `npm run dev`, an installed Chrome/Edge, and a baked bank (run
// `drums kit-bake` once).
//
// Usage: node scripts/check-solo.mjs
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, pageUrl, waitForPlayer } from './browser.mjs';

const ID = 'check-solo-tmp';
const NAME = 'check solo tmp';
/** Bars of the first playable song to cut. Two, so the loop is a loop. */
const FROM = 1;
const TO = 2;
/** Turn-rounds to wait for: two, so "it came back" is a pattern. */
const REPS = 2;

const root = fileURLToPath(new URL('../..', import.meta.url));
const dir = join(root, 'exercises', ID);
const samples = join(root, 'kit', 'samples');

const problems = [];
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
  if (!ok) problems.push(what + (detail ? ` (${detail})` : ''));
};

// A leftover from an interrupted run would be armed instead of the new one.
rmSync(dir, { recursive: true, force: true });

check(existsSync(samples), 'the kit has been baked', `kit/samples/ (${existsSync(samples) ? readdirSync(samples).length : 0} files)`);

const browser = await launch();
const pageErrors = [];

// --- cut one, off a real song ------------------------------------------------------
let page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => pageErrors.push(`cutting: ${e}`));
await page.goto(pageUrl());
await waitForPlayer(page);
await page.waitForTimeout(2500);

await page.locator('#exercise-new').click();
await page.waitForTimeout(300);
const field = (label) => page.locator(`#exercise-form [data-field="${label}"]`);
await field('Bars').fill(String(FROM));
await field('to').fill(String(TO));
await field('Name').fill(NAME);
await field('Kind').selectOption('groove');
await field('Rest bars').fill('1');
// Its own notes: the option that needs no song, and the default for a new cut.
await field('Backing').selectOption('kit');
await page.locator('#exercise-form button[type="submit"]').click();
await page.waitForTimeout(800);

check(existsSync(join(dir, 'exercise.json')), 'the cut is a file on disk', `exercises/${ID}/`);
const written = existsSync(join(dir, 'exercise.json'))
  ? JSON.parse(readFileSync(join(dir, 'exercise.json'), 'utf-8'))
  : {};
const chart = written.chart ?? {};
const perBar = (chart.meter?.beats_per_bar ?? 4) * 4;
check(written.version === 2, 'written as a v2 exercise', `version ${written.version}`);
check(written.backing === 'kit', 'played on its own notes', written.backing);
check((chart.hits?.length ?? 0) > 0, 'it carries its own notes', `${chart.hits?.length} hits`);
check(chart.bars === TO - FROM + 1, 'and knows how long it is', `${chart.bars} bars`);
check(
  (chart.hits ?? []).every((h) => h.slot >= 0 && h.slot < chart.bars * perBar),
  're-based so its own first bar is bar 1',
  `slots 0..${Math.max(...(chart.hits ?? [{ slot: -1 }]).map((h) => h.slot))} of ${chart.bars * perBar}`
);
check((chart.bpm ?? 0) > 0 && /^sha256:/.test(chart.hash ?? ''), 'with a tempo and a hash of its own', `${Math.round(chart.bpm)} BPM ${chart.hash}`);
check(
  (chart.hits ?? []).every((h) => h.note === undefined),
  "and no drum-rack keys: those were the song's, not the exercise's"
);
// It still remembers where it was cut from -- that is what a source is now.
check(written.sources?.[0]?.slug?.length > 0, 'it still names the record it came off', written.sources?.[0]?.slug);
await page.close();

// --- open it cold, on a page that has never loaded a song --------------------------
page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => pageErrors.push(`solo: ${e}`));
await page.goto(`${pageUrl()}#exercise/${ID}`);
await waitForPlayer(page);
await page.waitForTimeout(3500);

const cold = await page.evaluate(() => {
  const d = window.drums;
  return {
    page: document.documentElement.dataset.page,
    standalone: d.transport.standalone,
    // Never fetched, as opposed to fetched and silenced.
    mixSrc: d.mix.getAttribute('src') ?? '',
    slug: d.current?.slug ?? null,
    bars: d.current?.bars ?? 0,
    engraved: document.querySelectorAll('#score svg').length,
    armed: d.practice.armed?.exercise.id ?? '',
    source: d.practice.armed?.source ?? null,
    expected: d.practice.expected().length,
    unplayable: d.mixer.unplayable(d.practice.expected()),
    drillState: document.getElementById('drill-state').textContent,
    against: document.getElementById('drill-against').value,
    recordDisabled: document.getElementById('record').disabled,
  };
});
console.log(`     ${cold.drillState}`);
check(cold.page === 'exercise' && cold.armed === ID, 'the link armed it', `${cold.page} ${cold.armed}`);
check(cold.standalone, 'on its own clock, not the record’s');
check(cold.mixSrc === '' && cold.slug === '', 'no song was loaded at all', `mix src ${JSON.stringify(cold.mixSrc)}`);
check(cold.source === null, 'and it is aimed at no record', JSON.stringify(cold.source));
check(cold.bars === chart.bars && cold.engraved > 0, 'its own bars are engraved', `${cold.bars} bars, ${cold.engraved} systems`);
check(cold.expected === chart.hits.length, 'the scorer sees every note it carries', `${cold.expected} of ${chart.hits.length}`);
check(cold.unplayable.length === 0, 'and the kit can play all of them', cold.unplayable.join(', '));
check(cold.against === 'kit', 'the page says what it is playing against', cold.against);
check(cold.recordDisabled, 'with no kit connected there is still nothing to Drill');

// --- the bank is a sampler, not a bag of one-shots ----------------------------------
// Every one of these fails as silence or as a machine gun, and neither shows
// up in any other check here.
const bank = await page.evaluate(() => {
  const b = window.drums.mixer.bank;
  // The same note twenty times over. A sampler answers with several different
  // recordings and never the same one twice running; a bag of one-shots
  // answers with one buffer, twenty times.
  const picks = [];
  for (let i = 0; i < 20; i++) picks.push(b.pick('snare', 100));
  const buffers = picks.map((p) => p && p.buffer);
  const distinct = new Set(buffers.filter(Boolean)).size;
  let repeated = 0;
  for (let i = 1; i < buffers.length; i++) if (buffers[i] && buffers[i] === buffers[i - 1]) repeated++;

  // A ghost note and an accent must not be the same recording turned down.
  const soft = b.pick('snare', 40);
  const hard = b.pick('snare', 115);

  return {
    baked: b.baked,
    name: b.name,
    size: b.size,
    missing: b.missing.length,
    distinct,
    repeated,
    layered: Boolean(soft && hard && soft.buffer !== hard.buffer),
    softSeconds: soft ? soft.buffer.duration : 0,
    chokes: b.chokes('hihat_closed'),
  };
});
console.log(`     bank "${bank.name}": ${bank.size} recordings`);
check(bank.baked && bank.size > 0, 'the bank loaded', `${bank.size} recordings, ${bank.missing} missing`);
check(bank.missing === 0, 'and every recording the manifest promised arrived', `${bank.missing} missing`);
check(bank.distinct > 1, 'one note picks more than one recording', `${bank.distinct} distinct in 20 picks`);
check(bank.repeated === 0, 'and never the same one twice running', `${bank.repeated} repeats`);
check(bank.layered, 'a ghost note is a different recording from an accent, not a quieter one');
check(
  bank.chokes.includes('hihat_open'),
  'a closed hi-hat knows it cuts a ringing open one short',
  bank.chokes.join(', ') || 'nothing'
);

// --- it loops, and it sounds -------------------------------------------------------
// A real key press: it is the user gesture an AudioContext needs.
await page.keyboard.press('Space');
await page.waitForTimeout(400);
check(
  await page.evaluate(() => window.drums.practice.looping),
  'Play loops it, with no MIDI and nothing being marked'
);

const shape = await page.evaluate(() => {
  const d = window.drums;
  return {
    endMs: d.barStartMs(d.current.grid, d.current.bars),
    barMs: d.barStartMs(d.current.grid, 1),
    // The ladder aims at the first rung you have not played, which is 70% on
    // a fresh exercise -- so a rep takes half again as long as its bars do.
    tempo: d.practice.armed.tempo,
  };
});
const repMs = (shape.endMs + shape.barMs) / shape.tempo;
const watchMs = shape.barMs / shape.tempo + REPS * repMs + 3000;
console.log(
  `     ${Math.round(shape.endMs)}ms of music at ${Math.round(shape.tempo * 100)}%, ` +
    `${Math.round(repMs)}ms a rep; watching ${Math.ceil(watchMs / 1000)}s for ${REPS}`
);

await page.evaluate(() => {
  const d = window.drums;
  window.__samples = [];
  window.__rms = [];
  const a = d.mixer.analyser;
  const buf = new Float32Array(a.fftSize);
  window.__watch = setInterval(() => {
    window.__samples.push(Math.round(d.playClock.mixTimeMs));
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    window.__rms.push(Math.sqrt(sum / buf.length));
  }, 40);
});
await page.waitForTimeout(watchMs);
const watched = await page.evaluate(() => {
  clearInterval(window.__watch);
  return {
    samples: window.__samples,
    loud: Math.max(...window.__rms),
    kit: Number(document.getElementById('fader-kit').value),
  };
});

// A turn-round is the clock going back to the top. Measured against half the
// exercise's own length, because the pause at the end of every rep re-pins the
// clock by a few milliseconds and that is not a rep.
const back = [];
for (let i = 1; i < watched.samples.length; i++) {
  if (watched.samples[i] < watched.samples[i - 1] - shape.endMs / 2) back.push(watched.samples[i]);
}
const furthest = Math.max(...watched.samples);
console.log(`     clock 0..${furthest} ms, came back to ${back.join(', ') || 'nowhere'}`);
check(back.length >= REPS, 'it goes round', `${back.length} turn-rounds`);
check(back.every((ms) => ms <= 40), 'coming back to its own bar 1 every time', back.join(', '));
check(furthest <= shape.endMs + 250, 'and never running past its last bar', `${furthest} vs ${Math.round(shape.endMs)} ms`);
check(watched.kit > 0, 'the kit fader came up on its own, since nothing else is playing', `${watched.kit}%`);
check(watched.loud > 0.005, 'and the graph is making a sound', `peak RMS ${watched.loud.toFixed(4)}`);

// ...and it is the kit making it, not something else on the bus.
const quiet = await page.evaluate(async () => {
  const el = document.getElementById('fader-kit');
  el.value = '0';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('fader-click').value = '0';
  document.getElementById('fader-click').dispatchEvent(new Event('input', { bubbles: true }));
  const a = window.drums.mixer.analyser;
  const buf = new Float32Array(a.fftSize);
  // Let the fader's ramp finish and the analyser's window clear before asking.
  // `setLevel` ramps over about 10 ms and the analyser holds 2048 samples --
  // some 46 ms -- so reading it straight away reads the bar that was playing a
  // moment ago, not the silence that followed it.
  await new Promise((r) => setTimeout(r, 300));
  let peak = 0;
  for (let i = 0; i < 100; i++) {
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    peak = Math.max(peak, Math.sqrt(sum / buf.length));
    await new Promise((r) => setTimeout(r, 20));
  }
  return peak;
});
check(quiet < 0.002, 'with the faders down it is silent: the kit is what was playing', `peak RMS ${quiet.toFixed(4)}`);

await page.keyboard.press('Space');
await page.waitForTimeout(800);
const stopped = await page.evaluate(() => ({
  looping: window.drums.practice.looping,
  armed: window.drums.practice.armed?.exercise.id ?? '',
  drills: 0,
}));
check(!stopped.looping && stopped.armed === ID, 'Space stops it and leaves it armed');
check(
  !existsSync(join(dir, 'drills')) || readdirSync(join(dir, 'drills')).length === 0,
  'nothing reached disk: a listen is not a sitting'
);

// --- cleaning up --------------------------------------------------------------------
page.on('dialog', (d) => void d.accept());
await page.locator('#drill-delete').click();
await page.waitForTimeout(1200);
rmSync(dir, { recursive: true, force: true });
check(!existsSync(dir), 'the exercise it made is gone');

check(pageErrors.length === 0, 'no page errors', pageErrors.join(' | '));
await browser.close();

if (problems.length) {
  console.log(`\n${problems.length} problem${problems.length > 1 ? 's' : ''}:`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\nall checks passed');
