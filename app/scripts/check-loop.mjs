// The loop, the tempo steps and the count-ins, end to end, with no drum kit in
// the room.
//
// Usage: node scripts/check-loop.mjs [out.png]
//
// The fast proof of everything the play-along half of the page does on top of
// playing the song. A one-bar section goes round a few times, so it takes
// about a minute and a half rather than the length of a record.
//
// What it proves, in order of how much it would hurt to get wrong:
//
//  1. **The loop comes back to the same place.** Every pass starts on the same
//     millisecond of mix.wav. That one assertion catches a broken seek, a
//     double turn-round and a stale clock, and it is what lets every pass be
//     marked against the same list of written notes.
//  2. **The seam keeps a late note.** A stroke played just after the range
//     ends arrives while the transport is parked, so the clock cannot stamp
//     it. It has to end up in the pass that asked for it, still as late as it
//     was played, rather than as a very early downbeat of the next one.
//  3. The count-ins happen where they should (before the first pass, before
//     every pass when a rest bar is set, and when Play starts from a pause,
//     on a bar line), the ramp moves the tempo on schedule and stops at its
//     top, the tempo keys and buttons agree with the slider, a reload comes
//     back to the same loop and tempo without playing, and Record writes one
//     take per pass with the right cell.
//
// It deletes the takes it wrote and puts the machine's calibration back --
// takes/ is a record and a check should leave nothing in it.
//
// Screenshots, at the size of the screen the user practises in front of:
// `<out>` (the loop going round, the ramp running) and `<out>-scored.png`
// (the reading after a marked loop, with its row of passes).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, waitForPlayer } from './browser.mjs';

const SLUG = process.env.SONG ?? 'hayley-williams-kill-me-official-visualizer';
/** Another song, to show the memory is kept per song. Any other one will do. */
const OTHER = process.env.OTHER_SONG ?? 'blur-song-2-official-music-video';
const out = process.argv[2] ?? fileURLToPath(new URL('../shots/loop.png', import.meta.url));
mkdirSync(dirname(out), { recursive: true });
/** How late every injected stroke is, in ms. */
const LATE_MS = 12;
/** How far past the end of the range the seam stroke lands. Inside the grace window. */
const TAIL_MS = 60;
/** The loop's own grace window (loop.ts EDGE_MS). */
const EDGE_MS = 250;

const songsDir = fileURLToPath(new URL('../../songs', import.meta.url));
const takesDir = join(songsDir, SLUG, 'takes');
const before = new Set(existsSync(takesDir) ? readdirSync(takesDir) : []);
const CALIBRATION = 'http://localhost:5173/practice/calibration';

const problems = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 2194, height: 1100 } });
const pageErrors = [];
const consoleInfo = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'info') consoleInfo.push(m.text());
});

const url = `http://localhost:5173/#${encodeURIComponent(SLUG)}`;
const savedCalibration = await (await fetch(CALIBRATION)).json();

/** Every play and pause of the clock, with when it happened and where. */
const watchTransport = () =>
  page.evaluate(() => {
    const mix = window.drums.mix;
    window.__log = [];
    for (const type of ['play', 'pause']) {
      mix.addEventListener(type, () =>
        window.__log.push({
          type,
          wall: performance.now(),
          ms: mix.currentTime * 1000,
          rate: mix.playbackRate,
        })
      );
    }
  });
const transportLog = () => page.evaluate(() => window.__log);
const now = () => page.evaluate(() => performance.now());
/** Set a number field or a checkbox the way a person commits one: a `change`. */
const setField = (id, value) =>
  page.evaluate(
    ([id, value]) => {
      const el = document.getElementById(id);
      if (el.type === 'checkbox') el.checked = value;
      else el.value = String(value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [id, value]
  );
const state = () =>
  page.evaluate(() => {
    const d = window.drums;
    return {
      speed: document.getElementById('speed').value,
      speedOut: document.getElementById('speed-out').textContent,
      playbackSpeed: d.api.playbackSpeed,
      paused: d.mix.paused,
      mixMs: d.mix.currentTime * 1000,
      play: document.getElementById('play').textContent.trim(),
      status: document.getElementById('status').textContent.trim(),
      armed: d.loop.armed,
      running: d.loop.running,
      pass: d.loop.pass,
      phase: d.loop.phase ?? '',
      passOut: document.getElementById('loop-pass').textContent,
      pressed: document.getElementById('loop').getAttribute('aria-pressed'),
      band: document.querySelectorAll('.loop-band span').length,
      bandShown: !document.querySelector('.loop-band').hidden,
      from: document.getElementById('loop-from').value,
      to: document.getElementById('loop-to').value,
      rest: document.getElementById('loop-rest').checked,
      ramp: { ...d.loop.ramp },
      rampState: document.getElementById('ramp-state').textContent,
      chips: [...document.querySelectorAll('#passes .pass')].map((e) => ({
        text: e.textContent,
        cls: e.className,
      })),
    };
  });

try {
  await page.goto(url);
  await page.waitForTimeout(500);
  await waitForPlayer(page, SLUG);
  await page.waitForFunction(() => window.drums.mix.readyState >= 1, null, { timeout: 30000 });
  await page.waitForTimeout(1500);

  // --- ready, and the status line in plain words ---------------------------------
  const first = await state();
  check(
    !/Player loaded|sync points|Rendered|BPM/.test(first.status),
    'the status line has no developer numbers on it',
    JSON.stringify(first.status)
  );
  check(
    consoleInfo.some((t) => /\[drums\].*sync points.*engraved \d+ bars/.test(t)),
    'they went to the console instead',
    consoleInfo.find((t) => t.includes('[drums]')) ?? 'nothing'
  );

  // The audio graph is built on a gesture. A click on the header is one that
  // does nothing else.
  await page.mouse.click(40, 33);
  await page.waitForTimeout(300);
  await watchTransport();

  // --- tempo steps ----------------------------------------------------------------
  const tempos = [];
  for (const key of ['BracketRight', 'Shift+BracketRight', 'BracketLeft', 'Shift+BracketLeft', 'Shift+BracketLeft', 'Backslash']) {
    await page.keyboard.press(key);
    const s = await state();
    tempos.push(`${s.speed}/${s.speedOut}/${Math.round(s.playbackSpeed * 100)}`);
  }
  check(
    tempos.join(' ') === '105/105%/105 115/115%/115 110/110%/110 100/100%/100 90/90%/90 100/100%/100',
    '[ ] step 5, with Shift 10, \\ goes home -- slider, readout and alphaTab agree',
    tempos.join(' ')
  );
  await page.locator('#tempo-steps button[data-step="-10"]').click();
  await page.locator('#tempo-steps button[data-step="5"]').click();
  let s = await state();
  check(s.speed === '95' && s.playbackSpeed === 0.95, 'the step buttons do the same', `${s.speed}%`);
  await page.locator('#tempo-steps button[data-step="0"]').click();
  s = await state();
  check(s.speed === '100' && s.playbackSpeed === 1, 'and 100% is the way home', `${s.speed}%`);

  // --- count-in from a pause -------------------------------------------------------
  const bar = await page.evaluate(() => {
    const d = window.drums;
    const grid = d.current.grid;
    const start = d.barStartMs(grid, 9);
    return { start, ms: d.barStartMs(grid, 10) - start };
  });
  const seekMix = (ms) =>
    page.evaluate(
      (ms) =>
        new Promise((resolve) => {
          const mix = window.drums.mix;
          mix.addEventListener('seeked', () => resolve(), { once: true });
          window.drums.clock.seekTo(ms);
        }),
      ms
    );
  await seekMix(bar.start + bar.ms / 2);
  await page.evaluate(() => (window.__log = []));
  // Listen to the graph through the count-in: everything else is parked, so
  // anything on the analyser is a click.
  await page.evaluate(() => {
    const a = window.drums.mixer.analyser;
    const buf = new Float32Array(a.fftSize);
    window.__peak = 0;
    window.__listen = setInterval(() => {
      if (!window.drums.mix.paused) return;
      a.getFloatTimeDomainData(buf);
      for (const v of buf) window.__peak = Math.max(window.__peak, Math.abs(v));
    }, 20);
  });
  const pressedAt = await now();
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  s = await state();
  check(
    s.paused && Math.abs(s.mixMs - bar.start) < 3,
    'Play from mid-bar parks on the start of that bar for the count-in',
    `${Math.round(s.mixMs)} ms vs bar 10 at ${Math.round(bar.start)} ms`
  );
  check(s.play === 'Pause', 'and the button says so from the first click', s.play);
  check(/Counting in/.test(s.status), 'the status says it is counting in', s.status);
  await page.waitForFunction(() => window.__log.some((e) => e.type === 'play'), null, { timeout: 8000 });
  let log = await transportLog();
  const started = log.find((e) => e.type === 'play');
  const countInMs = started.wall - pressedAt;
  check(
    countInMs >= bar.ms * 0.95 && countInMs <= bar.ms + 700,
    'the music comes in a bar later',
    `${Math.round(countInMs)} ms for a ${Math.round(bar.ms)} ms bar`
  );
  check(Math.abs(started.ms - bar.start) < 30, 'on the downbeat the clicks led to', `${Math.round(started.ms)} ms`);
  const peak = await page.evaluate(() => {
    clearInterval(window.__listen);
    return window.__peak;
  });
  check(peak > 0.02, 'the count-in is heard with the Click fader down', `peak ${peak.toFixed(3)}`);
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);

  // Called off half way: nothing plays.
  await page.evaluate(() => (window.__log = []));
  await page.keyboard.press('Space');
  await page.waitForTimeout(600);
  await page.keyboard.press('Space');
  await page.waitForTimeout(bar.ms + 600);
  log = await transportLog();
  s = await state();
  check(
    !log.some((e) => e.type === 'play') && s.paused && s.play === 'Play',
    'Space during the count-in calls it off',
    `${log.length} transport events, button ${s.play}`
  );

  // Turned off, Play is Play again: from where it is, straight away.
  await page.locator('#count-in').uncheck();
  await seekMix(bar.start + bar.ms / 2);
  await page.evaluate(() => (window.__log = []));
  const plainAt = await now();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__log.some((e) => e.type === 'play'), null, { timeout: 5000 });
  log = await transportLog();
  const plain = log.find((e) => e.type === 'play');
  check(
    plain.wall - plainAt < 400 && Math.abs(plain.ms - (bar.start + bar.ms / 2)) < 40,
    'with the setting off, Play starts at once from where the cursor is',
    `${Math.round(plain.wall - plainAt)} ms later, at ${Math.round(plain.ms)} ms`
  );
  await page.keyboard.press('Space');
  await page.locator('#count-in').check();
  await page.waitForTimeout(300);

  // --- the loop, nobody marking it ---------------------------------------------------
  // A short section with notes in it, which both ends of the beat map can
  // place. Picked rather than hardcoded, so naming the song's sections is the
  // user's business and not a failing check.
  const range = await page.evaluate(() => {
    const d = window.drums;
    const grid = d.current.grid;
    const song = d.songs.find((x) => x.slug === d.current.slug);
    const notes = d.practice.wholeSong();
    const candidates = song.sections
      .map((sec, i) => ({ ...sec, i, n: notes.filter((x) => x.bar >= sec.start_bar && x.bar <= sec.end_bar).length }))
      .filter((sec) => sec.n >= 6)
      .filter((sec) => d.barStartMs(grid, sec.start_bar - 1) !== undefined && d.barStartMs(grid, sec.end_bar) !== undefined)
      .sort((a, b) => a.end_bar - a.start_bar - (b.end_bar - b.start_bar));
    const sec = candidates[0];
    if (!sec) return null;
    const startMs = d.barStartMs(grid, sec.start_bar - 1);
    return {
      index: sec.i,
      name: sec.name,
      startBar: sec.start_bar,
      endBar: sec.end_bar,
      notes: sec.n,
      startMs,
      endMs: d.barStartMs(grid, sec.end_bar),
      firstBarMs: d.barStartMs(grid, sec.start_bar) - startMs,
    };
  });
  if (!range) throw new Error(`${SLUG} has no short section with notes in it to loop`);
  const span = range.endMs - range.startMs;
  console.log(`     looping "${range.name}", bars ${range.startBar}-${range.endBar}: ${range.notes} notes, ${Math.round(span)} ms`);

  await page.selectOption('#loop-section', String(range.index));
  await page.waitForTimeout(300);
  s = await state();
  check(
    s.from === String(range.startBar) && s.to === String(range.endBar),
    'picking a section fills in its bars',
    `${s.from}-${s.to}`
  );
  check(!s.armed && !s.bandShown, 'and does not turn the loop on by itself');
  check(s.rest, 'a bar of rest between passes is the default');
  await page.keyboard.press('KeyL');
  await page.waitForTimeout(400);
  s = await state();
  check(s.armed && s.pressed === 'true', 'L turns the loop on');
  check(s.bandShown && s.band >= 1, 'it is drawn over the notation', `${s.band} block(s)`);
  check(
    s.paused && Math.abs(s.mixMs - range.startMs) < 5,
    'and the cursor goes to it, not playing',
    `${Math.round(s.mixMs)} vs ${Math.round(range.startMs)} ms`
  );

  await page.evaluate(() => {
    window.__log = [];
    // How far the media itself got, sampled while it plays. Not the position
    // a pause leaves it at: alphaTab puts a paused transport back on the start
    // of the written beat under the cursor, which can be a beat before the end.
    window.__reached = [];
    window.__sampler = setInterval(() => {
      const mix = window.drums.mix;
      if (!mix.paused) window.__reached.push({ wall: performance.now(), ms: mix.currentTime * 1000 });
    }, 5);
  });
  const loopAt = await now();
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  s = await state();
  check(s.running && s.play === 'Pause', 'Space plays the loop', `${s.play}, ${s.passOut}`);
  check(s.passOut === 'counting in', 'starting with a count-in', s.passOut);
  // Three passes with the rest bar, then two straight back.
  await page.waitForFunction(() => window.drums.loop.pass >= 3 && window.drums.loop.phase === 'playing', null, { timeout: 40000 });
  s = await state();
  check(s.passOut === 'pass 3', 'the pass counter counts', s.passOut);
  await setField('loop-rest', false);
  await page.waitForFunction(() => window.drums.loop.pass >= 5 && window.drums.loop.phase === 'playing', null, { timeout: 30000 });
  await page.screenshot({ path: out.replace(/\.png$/, '-going.png') });
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  s = await state();
  log = await transportLog();
  check(!s.running && s.armed && s.paused && s.play === 'Play', 'Space stops it, and the loop stays on', `${s.play}`);
  check(s.chips.length === 0, 'a loop nobody is marking draws no passes', `${s.chips.length} chips`);

  const plays = log.filter((e) => e.type === 'play');
  const pauses = log.filter((e) => e.type === 'pause');
  check(plays.length >= 5, 'five passes went round', `${plays.length} plays`);
  check(
    plays.every((e) => Math.abs(e.ms - range.startMs) <= 30),
    'every pass starts on the same millisecond of the record',
    plays.map((e) => Math.round(e.ms - range.startMs)).join(', ') + ' ms off'
  );
  const reached = await page.evaluate(() => {
    clearInterval(window.__sampler);
    return window.__reached;
  });
  const furthest = plays.slice(0, 4).map((p, i) => {
    const until = pauses[i]?.wall ?? Infinity;
    return Math.max(...reached.filter((r) => r.wall >= p.wall && r.wall <= until).map((r) => r.ms));
  });
  check(
    furthest.every((ms) => ms >= range.endMs - 15 && ms <= range.endMs + 80),
    'each pass plays to the end of its bars, and no further',
    furthest.map((ms) => Math.round(ms - range.endMs)).join(', ') + ' ms past the end'
  );
  const firstBar = range.firstBarMs;
  check(
    plays[0].wall - loopAt >= firstBar * 0.95,
    'a bar of count-in before the first pass',
    `${Math.round(plays[0].wall - loopAt)} ms for a ${Math.round(firstBar)} ms bar`
  );
  // The turn-rounds: pause at the end, then play again at the top.
  const gaps = [];
  for (let i = 0; i + 1 < plays.length && i < pauses.length; i++) gaps.push(plays[i + 1].wall - pauses[i].wall);
  check(
    gaps[0] >= EDGE_MS + firstBar * 0.95 && gaps[1] >= EDGE_MS + firstBar * 0.95,
    'and a bar of count-in before every pass while the rest bar is set',
    gaps.slice(0, 2).map(Math.round).join(', ') + ' ms'
  );
  check(
    gaps[2] < EDGE_MS + firstBar * 0.5 && gaps[3] < EDGE_MS + firstBar * 0.5,
    'without it, straight back after the grace window',
    gaps.slice(2, 4).map(Math.round).join(', ') + ' ms'
  );

  // --- the ramp -----------------------------------------------------------------------
  await setField('ramp-from', 80);
  await setField('ramp-to', 100);
  await setField('ramp-step', 10);
  await setField('ramp-every', 1);
  await setField('ramp', true);
  s = await state();
  check(s.rampState === '80% → 100%, +10% every pass', 'the ramp says what it will do', s.rampState);
  await page.evaluate(() => (window.__log = []));
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.drums.loop.pass === 1 && window.drums.loop.phase === 'playing', null, { timeout: 10000 });
  s = await state();
  check(s.speed === '80', 'it starts at its own first tempo', `${s.speed}%`);
  check(s.rampState === '80% → 100%, next step after this pass', 'and says where it is', s.rampState);
  await page.waitForFunction(() => window.drums.loop.pass >= 4 && window.drums.loop.phase === 'playing', null, { timeout: 40000 });
  s = await state();
  check(s.rampState === '100%, the top of the ramp', 'until it reaches the top', s.rampState);
  await page.screenshot({ path: out });
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  log = await transportLog();
  const rates = log.filter((e) => e.type === 'play').map((e) => Math.round(e.rate * 100));
  check(rates.slice(0, 4).join(' ') === '80 90 100 100', 'it steps every pass and stops at its top', rates.join(' '));
  s = await state();
  check(
    s.speed === '100' && s.speedOut === '100%' && s.playbackSpeed === 1,
    'through the slider, so the slider, the readout and alphaTab agree',
    `${s.speed} / ${s.speedOut} / ${s.playbackSpeed}`
  );

  // --- a reload ---------------------------------------------------------------------
  // Live reloads the page on every Ctrl+S. It has to land on the same loop at
  // the same tempo, with nothing playing.
  for (let i = 0; i < 3; i++) await page.keyboard.press('BracketLeft');
  await page.reload();
  await waitForPlayer(page, SLUG);
  await page.waitForTimeout(2500);
  s = await state();
  check(s.speed === '85' && s.playbackSpeed === 0.85, 'a reload keeps the tempo', `${s.speed}%`);
  check(
    s.armed && s.from === String(range.startBar) && s.to === String(range.endBar) && s.bandShown,
    'and the loop, on',
    `${s.armed} ${s.from}-${s.to}`
  );
  check(
    s.ramp.on && s.ramp.from === 80 && s.ramp.step === 10 && s.ramp.every === 1 && !s.rest,
    'and the ramp and the rest bar as they were set',
    JSON.stringify({ ...s.ramp, rest: s.rest })
  );
  check(!s.running && s.paused && s.play === 'Play', 'and nothing playing', s.play);

  // Per song: another song has its own (none), and this one's comes back.
  await page.evaluate((slug) => (location.hash = encodeURIComponent(slug)), OTHER);
  await waitForPlayer(page, OTHER);
  await page.waitForTimeout(800);
  s = await state();
  check(s.speed === '100' && !s.armed, 'another song has its own tempo and loop', `${s.speed}% armed ${s.armed}`);
  await page.evaluate((slug) => (location.hash = encodeURIComponent(slug)), SLUG);
  await waitForPlayer(page, SLUG);
  await page.waitForTimeout(1500);
  s = await state();
  check(s.speed === '85' && s.armed, 'and coming back finds this one where it was', `${s.speed}% armed ${s.armed}`);

  // --- the loop, marked ---------------------------------------------------------------
  // Record with the loop on marks every pass and writes each as a take. The
  // ramp waits for a good pass: the first is played half wrong and must not
  // move it, the second is clean and must.
  await page.mouse.click(40, 33);
  await setField('loop-rest', true);
  await setField('ramp-from', 90);
  await setField('ramp-to', 100);
  await setField('ramp-step', 10);
  await setField('ramp-every', 1);
  await setField('ramp-gate', true);
  await fetch(CALIBRATION, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' });
  await page.evaluate(() => window.drums.practice.reloadCalibration());
  await page.evaluate(() => window.drums.practice.midi.inject(38, 1));
  await page.waitForTimeout(300);
  s = await page.evaluate(() => ({
    target: document.getElementById('take-target').textContent,
    disabled: document.getElementById('record').disabled,
    title: document.getElementById('record').title,
  }));
  check(/every pass/.test(s.target) && !s.disabled, 'Record offers to mark every pass of the loop', `${s.target} (${s.title})`);

  await watchTransport();
  await page.locator('#record').click();
  await page.evaluate(
    ({ LATE_MS, TAIL_MS }) => {
      const d = window.drums;
      const p = d.practice;
      const notes = p.expected();
      const noteOf = (instrument) => {
        for (const [n, name] of Object.entries(p.input.note)) if (name === instrument) return Number(n);
        return 38;
      };
      const endMs = d.loop.window.endMs;
      const planned = notes.map((n, i) => ({ i, tMs: n.tMs + LATE_MS, note: noteOf(n.instrument) }));
      let done = new Set();
      let tailQueued = false;
      window.__injector = setInterval(() => {
        if (d.mix.paused) {
          // Parked at the end of a pass, or counting the next one in: every
          // note is playable again when the music comes back.
          done = new Set();
          tailQueued = false;
          return;
        }
        const pass = d.loop.pass;
        const now = performance.now();
        const mixNow = d.clock.mixTimeAt(now);
        const rate = d.mix.playbackRate || 1;
        for (const n of planned) {
          if (done.has(n.i) || n.tMs > mixNow + 30) continue;
          done.add(n.i);
          if (n.tMs < mixNow - 300) continue; // too far gone to place honestly
          // The first pass is played half wrong: every other note left out.
          if (pass === 1 && n.i % 2 === 1) continue;
          d.practice.midi.inject(n.note, 100, now + (n.tMs - mixNow) / rate);
        }
        // The seam: booked on the wall clock to arrive while the transport is
        // parked, which is when a fill's last note arrives.
        if (!tailQueued && mixNow >= endMs - 400) {
          tailQueued = true;
          const fireAt = now + (endMs - mixNow) / rate + TAIL_MS / rate;
          setTimeout(() => d.practice.midi.inject(noteOf('crash'), 100, performance.now()), Math.max(0, fireAt - performance.now()));
        }
      }, 15);
    },
    { LATE_MS, TAIL_MS }
  );
  await page.waitForFunction(() => document.querySelectorAll('#passes .pass').length >= 3, null, { timeout: 60000 });
  // A chip appears when a pass closes, at the start of the rest. Wait for the
  // music to come back, then stop part way through the fourth.
  await page.waitForFunction(() => !window.drums.mix.paused, null, { timeout: 15000 });
  await page.waitForTimeout(Math.min(900, span / 2));
  await page.locator('#record').click();
  await page.evaluate(() => clearInterval(window.__injector));
  await page.waitForTimeout(2000);

  const marked = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('#score svg text')].map((t) => t.getAttribute('fill'));
    const fills = new Set(heads.filter((f) => f && /^#/.test(f) && f !== '#B4B4B4'));
    return {
      chips: [...document.querySelectorAll('#passes .pass')].map((e) => ({ text: e.textContent, cls: e.className })),
      dials: [...document.querySelectorAll('#report .dial .label')].map((e) => e.textContent),
      notesSub: document.querySelector('#report .dial .sub')?.textContent ?? '',
      stripBars: document.querySelectorAll('#report .strip .bar').length,
      colours: fills.size,
      record: document.getElementById('record').textContent.trim(),
      running: window.drums.loop.running,
      status: document.getElementById('status').textContent.trim(),
    };
  });
  check(!marked.running && marked.record === 'Record', 'Record stops a marked loop', marked.record);
  check(marked.chips.length === 4, 'one chip per pass, the one stopped part way included', marked.chips.map((c) => c.text).join(' '));
  check(
    /bad/.test(marked.chips[0]?.cls) && /good/.test(marked.chips[1]?.cls) && /good/.test(marked.chips[2]?.cls),
    'coloured against the same line the dials use',
    marked.chips.map((c) => c.cls.replace('pass ', '')).join(' ')
  );
  check(/part/.test(marked.chips[3]?.cls), 'the stopped pass is drawn as unfinished', marked.chips[3]?.cls);
  check(marked.dials.join(' ') === 'Notes Steady Feel', 'the reading is the same three dials', marked.dials.join(' '));
  check(/^pass 3 of 4/.test(marked.notesSub), 'showing the last pass that reached its end, and saying which', marked.notesSub);
  check(marked.stripBars === range.endBar - range.startBar + 1, 'the bar strip covers the loop', `${marked.stripBars} blocks`);
  check(marked.colours >= 1, 'and the noteheads are coloured once it stops', `${marked.colours} colours`);
  await page.locator('#passes .pass').nth(1).click();
  await page.waitForTimeout(800);
  const picked = await page.evaluate(() => ({
    sub: document.querySelector('#report .dial .sub')?.textContent ?? '',
    at: [...document.querySelectorAll('#passes .pass')].findIndex((e) => e.classList.contains('at')),
  }));
  check(/^pass 2 of 4/.test(picked.sub) && picked.at === 1, 'a chip puts its own pass on show', picked.sub);
  await page.screenshot({ path: out.replace(/\.png$/, '-scored.png') });

  // What reached the disk.
  const written = (existsSync(takesDir) ? readdirSync(takesDir) : []).filter((f) => !before.has(f)).sort();
  check(written.length === 4, 'one take per pass reached the disk', written.join(', ') || 'none');
  const takes = written.map((f) => JSON.parse(readFileSync(join(takesDir, f), 'utf-8')));
  const slugOf = range.name.replace(/[^A-Za-z0-9._-]+/g, '-');
  check(
    written.every((f, i) => f.endsWith(`-${slugOf}-${[90, 90, 100, 100][i]}.json`)),
    'named for the section and the tempo each was played at',
    written.join(', ')
  );
  check(
    takes.every((t) => t.cell.section === range.name && t.cell.startBar === range.startBar && t.cell.endBar === range.endBar && !('id' in t.cell)),
    'each says which bars it played',
    JSON.stringify(takes[0]?.cell)
  );
  check(
    takes.map((t) => t.cell.tempo).join(' ') === '0.9 0.9 1 1',
    'a bad pass did not move the gated ramp; a good one did',
    takes.map((t) => t.cell.tempo).join(' ')
  );
  check(
    takes.map((t) => t.complete).join(' ') === 'true true true false',
    'the pass stopped part way is on disk, marked unfinished',
    takes.map((t) => t.complete).join(' ')
  );
  check(
    takes.every((t) => t.version === 1 && /^sha256:/.test(t.chartHash) && /^sha256:/.test(t.sectionsHash)),
    'in the take format, both hashes on'
  );
  const complete = takes.filter((t) => t.complete);
  // Every pass plays the same milliseconds of the record. Pass 1 left out
  // every other note, but never the first.
  const firsts = complete.map((t) => t.events[0]?.tMs ?? 0);
  check(
    Math.max(...firsts) - Math.min(...firsts) <= 30,
    'every marked pass starts on the same millisecond of the record',
    firsts.map((ms) => Math.round(ms - range.startMs)).join(', ') + ' ms in'
  );
  const tails = complete.map((t) => t.events.filter((e) => e.tMs > range.endMs).map((e) => Math.round(e.tMs - range.endMs)));
  check(
    tails.every((t) => t.length === 1),
    'a stroke just past the end stays in the pass that asked for it',
    tails.map((t) => t.join('/') || 'none').join(', ')
  );
  check(
    tails.every((t) => t[0] !== undefined && Math.abs(t[0] - TAIL_MS) <= 40),
    'still as late as it was played',
    `${tails.map((t) => t[0]).join(', ')} ms vs ${TAIL_MS}`
  );
  check(
    takes.every((t) => t.events.every((e) => e.tMs >= range.startMs - EDGE_MS && e.tMs <= range.endMs + EDGE_MS)),
    'no pass caught a stroke from another'
  );
  check(
    complete[0].grade.accuracy < 0.9 && complete[1].grade.accuracy >= 0.9 && complete[2].grade.accuracy >= 0.9,
    'the half-played pass is marked as one',
    complete.map((t) => t.grade.accuracy.toFixed(2)).join(' ')
  );
  const floored = LATE_MS - (complete[1].referenceMs ?? 0);
  check(
    complete.slice(1).every((t) => Math.abs(t.grade.timing.overall.meanMs - floored) <= 6),
    'the injected lateness comes back with the reference floor taken off',
    `${complete.slice(1).map((t) => t.grade.timing.overall.meanMs).join(', ')} ms vs ${floored.toFixed(1)}`
  );
  console.log(`\nstatus: ${marked.status}`);
} catch (err) {
  check(false, 'the check ran to the end', String(err?.message ?? err).split('\n')[0]);
} finally {
  // The takes this run wrote, and nothing else: takes/ is a record.
  const mine = (existsSync(takesDir) ? readdirSync(takesDir) : []).filter((f) => !before.has(f));
  for (const f of mine) rmSync(join(takesDir, f));
  if (mine.length) console.log(`     (removed the ${mine.length} take(s) it wrote)`);
  await fetch(CALIBRATION, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(savedCalibration),
  });
  check(pageErrors.length === 0, 'no page errors', pageErrors.slice(0, 3).join(' | '));
  await browser.close();
}

if (problems.length) {
  console.log(`\n${problems.length} failed: ${problems.join('; ')}`);
  process.exit(1);
}
console.log('\nall checks passed');
