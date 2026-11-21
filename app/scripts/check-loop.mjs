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
//     top, the tempo keys and pills agree with the readout, a loop is picked
//     on the song map and a pick made while the song plays waits for the next
//     bar line (or, from L, loops the section being played), a reload comes
//     back to the same loop and tempo without playing, and Record writes one
//     take per pass with the right cell.
//
// It deletes the takes it wrote and puts the machine's calibration back --
// takes/ is a record and a check should leave nothing in it.
//
// Screenshots, at the size of the screen the user practises in front of:
// `<out>` (the loop going round, the ramp running) and `<out>-scored.png`
// (the reading card after a marked loop, the noteheads coloured).
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
/** The Settings page (the gear), where the loop's numbers and the count-ins live. */
const settings = async (open) => {
  await page.evaluate((open) => window.drums.setSettings(open), open);
  await page.waitForTimeout(100);
};
/** Settings' "Between passes": a bar of click (true) or straight back. */
const between = (rest) =>
  page.evaluate((rest) => document.querySelector(`#loop-between [data-value="${rest ? 'click' : 'straight'}"]`).click(), rest);
const state = () =>
  page.evaluate(() => {
    const d = window.drums;
    return {
      speed: String(d.tempo),
      speedOut: document.getElementById('tempo-pct').textContent,
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
      passSub: document.getElementById('pass-sub').textContent,
      bpmLine: document.getElementById('tempo-bpm').textContent,
      // The header's count-in (Lamp-05) and the ramp's ladder (Lamp-04).
      counting: document.getElementById('app').dataset.counting ?? '',
      countSays: document.getElementById('count-says').textContent,
      countNow: document.querySelector('#count-beats [data-beat="now"]')?.textContent ?? '',
      steps: !document.getElementById('tempo-steps').hidden,
      ladder: document.getElementById('ladder').hidden
        ? ''
        : [...document.querySelectorAll('#ladder .rung')]
            .map((r) => `${r.textContent}${{ done: '-', now: '*', next: '>', later: '' }[r.dataset.state]}`)
            .join(' '),
      rampBtn: (() => {
        const b = document.getElementById('ramp-btn');
        return { shown: !b.hidden, pressed: b.getAttribute('aria-pressed') };
      })(),
      pressed: document.getElementById('loop').getAttribute('aria-pressed'),
      bracket: document.querySelectorAll('.tab-bracket span').length,
      outline: document.querySelectorAll('#map .map-loop').length,
      picking: document.getElementById('map').hasAttribute('data-picking'),
      line: document.querySelector('#map .map-line')?.textContent ?? '',
      from: String(d.loop.armed ? d.loop.range?.startBar ?? '' : ''),
      to: String(d.loop.armed ? d.loop.range?.endBar ?? '' : ''),
      rest: document.querySelector('#loop-between [aria-pressed="true"]')?.dataset.value === 'click',
      ramp: { ...d.loop.ramp },
      rampState: d.loop.rampSaid(),
      reading: document.getElementById('reading').hidden ? '' : document.querySelector('#reading .rd-title').textContent,
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
  await page.locator('#bar-of').click();
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
    '[ ] step 5, with Shift 10, \\ goes home -- the tempo, its readout and alphaTab agree',
    tempos.join(' ')
  );
  // `{` and `}` as characters, the way a layout without them on Shift+[ ]
  // sends them: the character decides, not the key it came from.
  const braces = [];
  for (const key of ['}', '{', '{', 'Backslash']) {
    await page.keyboard.press(key);
    braces.push((await state()).speed);
  }
  check(braces.join(' ') === '110 100 90 100', '{ } step 10 typed as characters too', braces.join(' '));
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
  check(s.counting === 'on' && /^count-in · then .*bar 10$/.test(s.countSays), 'the header says it is counting in, and into what', s.countSays);
  check(!/Counting in/.test(s.status), 'and the status line does not repeat it', s.status);
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
  await settings(true);
  await page.locator('#count-in').uncheck();
  await settings(false);
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
  await settings(true);
  await page.locator('#count-in').check();
  await settings(false);
  await page.waitForTimeout(300);

  // --- a pick while the song plays ---------------------------------------------------
  // It is not cut off mid-bar. L in the middle of a section loops the section
  // around the bar being played: no pause, pass 1 is the one under way.
  const here = await page.evaluate(() => {
    const d = window.drums;
    const song = d.songs.find((x) => x.slug === d.current.slug);
    const grid = d.current.grid;
    const sec = song.sections.find(
      (x) => x.end_bar - x.start_bar >= 3 && d.barStartMs(grid, x.start_bar - 1) !== undefined && d.barStartMs(grid, x.end_bar) !== undefined
    );
    return { name: sec.name, startBar: sec.start_bar, endBar: sec.end_bar, ms: d.barStartMs(grid, sec.start_bar) + 300 };
  });
  await settings(true);
  await page.locator('#count-in').uncheck();
  await settings(false);
  await seekMix(here.ms);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !window.drums.mix.paused, null, { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => (window.__log = []));
  await page.keyboard.press('KeyL');
  await page.waitForTimeout(400);
  s = await state();
  log = await transportLog();
  check(
    s.armed && s.running && s.pass === 1 && s.phase === 'playing' && !s.paused && log.length === 0,
    'L while playing loops the section being played, without stopping the music',
    `${s.from}-${s.to} pass ${s.pass} ${s.phase}, ${log.length} transport events`
  );
  check(
    s.from === String(here.startBar) && s.to === String(here.endBar) && s.picking,
    'that section, and the map opens as the picker to adjust it',
    `${s.from}-${s.to}, picking ${s.picking}`
  );
  // A click on another section while it plays: the music carries on to the
  // next bar line, then pass 1 of the new loop starts on its first bar.
  const other = await page.evaluate((here) => {
    const d = window.drums;
    const song = d.songs.find((x) => x.slug === d.current.slug);
    const grid = d.current.grid;
    const i = song.sections.findIndex(
      (x) => x.start_bar > here.endBar + 1 && d.barStartMs(grid, x.start_bar - 1) !== undefined && d.barStartMs(grid, x.end_bar) !== undefined
    );
    const sec = song.sections[i];
    return { i, startBar: sec.start_bar, endBar: sec.end_bar, startMs: d.barStartMs(grid, sec.start_bar - 1) };
  }, here);
  await page.evaluate(() => (window.__log = []));
  // Where the music was at the click, and when on the wall clock: the
  // pause's own event comes after the seek, so its position is the new one.
  const clicked = await page.evaluate(() => ({ wall: performance.now(), ms: window.drums.clock.mixTimeAt(performance.now()), rate: window.drums.mix.playbackRate }));
  const clickedMs = clicked.ms;
  await page.locator(`#map .map-block[data-index="${other.i}"]`).click();
  await page.waitForFunction(() => window.__log.some((e) => e.type === 'play'), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  log = await transportLog();
  s = await state();
  const lineAfter = await page.evaluate((ms) => {
    const d = window.drums;
    const grid = d.current.grid;
    for (let b = 0; b < grid.bar_count; b++) {
      const t = d.barStartMs(grid, b);
      if (t !== undefined && t > ms) return t;
    }
    return undefined;
  }, clickedMs);
  const cut = log.find((e) => e.type === 'pause');
  const went = log.find((e) => e.type === 'play');
  const cutAt = cut ? clicked.ms + (cut.wall - clicked.wall) * clicked.rate : -1;
  check(
    cut && lineAfter !== undefined && cutAt >= lineAfter - 30 && cutAt <= lineAfter + 80,
    'a pick somewhere else waits for the next bar line',
    `cut at ${Math.round(cutAt)} ms, bar line at ${Math.round(lineAfter ?? -1)} ms (clicked at ${Math.round(clicked.ms)})`
  );
  check(
    went && Math.abs(went.ms - other.startMs) < 30 && s.pass === 1 && s.phase === 'playing' && s.from === String(other.startBar),
    'then plays pass 1 of the new loop from its first bar, no count-in',
    `${Math.round((went?.ms ?? 0) - other.startMs)} ms off its start, pass ${s.pass} ${s.phase}`
  );
  await page.keyboard.press('Space');
  await page.keyboard.press('KeyL');
  await page.waitForTimeout(300);
  s = await state();
  check(!s.armed && !s.picking && s.outline === 0 && s.bracket === 0, 'L with a loop on turns it off, and closes the picker', `${s.armed} ${s.picking}`);
  await settings(true);
  await page.locator('#count-in').check();
  await settings(false);

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

  // Picked on the song map: the Loop pill opens it as the picker, and a
  // click on the section's block loops it.
  await page.locator('#loop').click();
  await page.waitForTimeout(200);
  s = await state();
  check(s.picking && !s.armed && /^Click a section to loop it/.test(s.line), 'the Loop pill opens the picker, nothing picked', s.line);
  await page.locator(`#map .map-block[data-index="${range.index}"]`).click();
  await page.waitForTimeout(400);
  s = await state();
  check(
    s.armed && s.pressed === 'true' && s.from === String(range.startBar) && s.to === String(range.endBar),
    'a click on a section loops it',
    `${s.from}-${s.to}`
  );
  check(s.line.startsWith(`Loop: ${range.name} · `), 'the line under the picker says what is looped', s.line);
  check(s.outline === 1 && s.bracket >= 1, 'outlined on the map and bracketed on the paper', `${s.outline} outline, ${s.bracket} bracket piece(s)`);
  check(s.rest, 'a bar of rest between passes is the default');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check(!(await state()).picking, 'Esc closes the picker');
  check(
    s.passOut === 'loop on' && s.passSub.includes(`${range.startBar}`) && s.rampBtn.shown,
    'the header says the loop is on, which bars, and offers the ramp',
    `${s.passOut} / ${s.passSub} / ramp pill ${s.rampBtn.shown}`
  );
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
  check(
    s.counting === 'on' && /^count-in · then .*, pass 1$/.test(s.countSays),
    'the header shows the count-in into pass 1',
    s.countSays
  );
  // Three passes with the rest bar, then two straight back.
  await page.waitForFunction(() => window.drums.loop.pass >= 3 && window.drums.loop.phase === 'playing', null, { timeout: 40000 });
  s = await state();
  check(s.passOut === 'pass 3', 'the pass counter counts', s.passOut);
  check(/^looping /.test(s.passSub), 'and the line under it says what is looping', s.passSub);
  await between(false);
  await page.waitForFunction(() => window.drums.loop.pass >= 5 && window.drums.loop.phase === 'playing', null, { timeout: 30000 });
  await page.screenshot({ path: out.replace(/\.png$/, '-going.png') });
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  s = await state();
  log = await transportLog();
  check(!s.running && s.armed && s.paused && s.play === 'Play', 'Space stops it, and the loop stays on', `${s.play}`);
  check(s.reading === '', 'a loop nobody is marking draws no reading', s.reading);

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

  // --- no count-in before the first pass (a Settings switch, on by default) -----------
  await settings(true);
  await page.locator('#count-in-loop').uncheck();
  await settings(false);
  const asked = await now();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.drums.loop.pass === 1 && window.drums.loop.phase === 'playing', null, { timeout: 5000 });
  const straightIn = (await now()) - asked;
  check(straightIn < 700, 'with that count-in off, pass 1 starts at once', `${Math.round(straightIn)} ms`);
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  await settings(true);
  await page.locator('#count-in-loop').check();
  await settings(false);

  // --- the ramp -----------------------------------------------------------------------
  await setField('ramp-from', 80);
  await setField('ramp-to', 100);
  await setField('ramp-step', 10);
  await setField('ramp-every', 1);
  await page.locator('#ramp-btn').click();
  s = await state();
  check(s.rampState === '80% → 100%, +10% every pass', 'the ramp says what it will do', s.rampState);
  check(s.rampBtn.pressed === 'true', 'the Ramp pill shows it on', s.rampBtn.pressed);
  check(!s.steps && s.ladder !== '', 'the ladder takes the tempo pills\' place', `steps ${s.steps}, ladder ${s.ladder}`);
  await page.keyboard.press('KeyR');
  s = await state();
  check(!s.ramp.on && s.rampBtn.pressed === 'false', 'R turns the ramp off', JSON.stringify(s.rampBtn));
  await page.keyboard.press('KeyR');
  s = await state();
  check(s.ramp.on && s.ramp.from === 80 && s.ramp.step === 10, 'and on again, its numbers kept', JSON.stringify(s.ramp));
  await page.evaluate(() => (window.__log = []));
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.drums.loop.pass === 1 && window.drums.loop.phase === 'playing', null, { timeout: 10000 });
  s = await state();
  check(s.speed === '80', 'it starts at its own first tempo', `${s.speed}%`);
  check(s.ladder === '80* 90> 100', 'the ladder: here now, the next step dashed, the top', s.ladder);
  check(s.rampState === '80% → 100%, next step after this pass', 'and says where it is', s.rampState);
  check(
    s.passSub === 'next step after this pass' && /BPM · ramp to 100%$/.test(s.bpmLine),
    'the header says it too: under the pass, and beside the BPM',
    `${s.passSub} / ${s.bpmLine}`
  );
  await page.waitForFunction(() => window.drums.loop.pass >= 4 && window.drums.loop.phase === 'playing', null, { timeout: 40000 });
  s = await state();
  check(s.rampState === '100%, ramp done: full speed', 'until it reaches the top', s.rampState);
  check(s.passSub === 'ramp done: full speed' && s.ladder === '80- 90- 100*', 'and the header says the ramp is done', `${s.passSub} / ${s.ladder}`);
  await page.screenshot({ path: out });
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  log = await transportLog();
  const rates = log.filter((e) => e.type === 'play').map((e) => Math.round(e.rate * 100));
  check(rates.slice(0, 4).join(' ') === '80 90 100 100', 'it steps every pass and stops at its top', rates.join(' '));
  s = await state();
  check(
    s.speed === '100' && s.speedOut === '100%' && s.playbackSpeed === 1,
    'through the one setter, so the tempo, the readout and alphaTab agree',
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
    s.armed && s.from === String(range.startBar) && s.to === String(range.endBar) && s.bracket >= 1 && s.outline === 1,
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
  await page.locator('#bar-of').click();
  await between(true);
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
    target: window.drums.practice.plan,
    shown: !document.getElementById('record').hidden,
    disabled: document.getElementById('record').disabled,
    title: document.getElementById('record').title,
  }));
  check(
    /every pass/.test(s.target) && s.shown && !s.disabled,
    'the kit brings the Record pill, offering to mark every pass of the loop',
    `${s.target} (${s.title})`
  );

  await watchTransport();
  // Every reading the card shows while the loop goes round, as it shows it.
  await page.evaluate(() => {
    window.__readings = [];
    const card = document.getElementById('reading');
    new MutationObserver(() => {
      if (card.hidden) return;
      const said = {
        title: card.querySelector('.rd-title').textContent,
        notes: card.querySelector('.rd-big').textContent,
        recording: !card.querySelector('.rd-rec').hidden,
        close: !card.querySelector('.rd-close').hidden,
        bars: card.querySelectorAll('.rd-bar').length,
      };
      const last = window.__readings.at(-1);
      if (!last || last.title !== said.title || last.notes !== said.notes) window.__readings.push(said);
    }).observe(card, { subtree: true, childList: true, characterData: true, attributes: true });
  });
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
  const recordingSaid = await page.evaluate(() => ({
    pressed: document.getElementById('record').getAttribute('aria-pressed'),
    word: document.getElementById('record-word').textContent,
  }));
  check(recordingSaid.pressed === 'true' && recordingSaid.word === 'Recording', 'the pill says Recording', JSON.stringify(recordingSaid));
  // The card comes up as a pass closes, at the start of the rest. Wait for the
  // third, then for the music to come back, then stop part way through the fourth.
  await page.waitForFunction(
    () => document.querySelector('#reading .rd-title')?.textContent === 'Pass 3, just played' && !document.getElementById('reading').hidden,
    null,
    { timeout: 60000 }
  );
  await page.waitForFunction(() => !window.drums.mix.paused, null, { timeout: 15000 });
  await page.waitForTimeout(Math.min(900, span / 2));
  await page.locator('#record').click();
  await page.evaluate(() => clearInterval(window.__injector));
  await page.waitForTimeout(2000);

  const marked = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('#score svg text')].map((t) => t.getAttribute('fill'));
    const css = getComputedStyle(document.documentElement);
    // The paper's own colours: anything else on a notehead is a verdict.
    const neutral = new Set(['--tab-ink', '--tab-staff', '--tab-barno'].map((v) => css.getPropertyValue(v).trim().toUpperCase()));
    const fills = new Set(heads.filter((f) => f && /^#/.test(f) && !neutral.has(f.toUpperCase())));
    const card = document.getElementById('reading');
    return {
      readings: window.__readings,
      shown: !card.hidden,
      title: card.querySelector('.rd-title').textContent,
      dials: [...card.querySelectorAll('.rd-label')].map((e) => e.textContent),
      stripBars: card.querySelectorAll('.rd-bar').length,
      recording: !card.querySelector('.rd-rec').hidden,
      close: !card.querySelector('.rd-close').hidden,
      colours: fills.size,
      record: document.getElementById('record-word').textContent,
      running: window.drums.loop.running,
      status: document.getElementById('status').textContent.trim(),
    };
  });
  const titles = marked.readings.map((r) => r.title);
  check(!marked.running && marked.record === 'Record', 'Record stops a marked loop', marked.record);
  check(
    ['Pass 1, just played', 'Pass 2, just played', 'Pass 3, just played'].every((t) => titles.includes(t)),
    'the card follows the passes as they close',
    titles.join(' | ')
  );
  const during = marked.readings.filter((r) => /just played/.test(r.title) && r.title !== marked.title);
  check(
    during.length >= 3 && during.every((r) => r.recording && !r.close),
    'while it records the card says so, and has no close',
    JSON.stringify(during.map((r) => [r.recording, r.close]))
  );
  const notesOf = (n) => Number(marked.readings.find((r) => r.title === `Pass ${n}, just played`)?.notes.replace('%', '') ?? -1);
  check(
    notesOf(1) < 90 && notesOf(2) >= 90 && notesOf(3) >= 90,
    'the half-played pass reads as one, and the clean ones as clean',
    `${notesOf(1)}% ${notesOf(2)}% ${notesOf(3)}%`
  );
  check(marked.shown && marked.title === 'Pass 3, the last one played through', 'stopped, it shows the last pass that reached its end, and says so', marked.title);
  check(!marked.recording && marked.close, 'and can be put away', `recording ${marked.recording}, close ${marked.close}`);
  check(marked.dials.join(' ') === 'Notes Steady Feel', 'the reading is the same three readings', marked.dials.join(' '));
  check(marked.stripBars === range.endBar - range.startBar + 1, 'the bar strip covers the loop', `${marked.stripBars} blocks`);
  check(marked.colours >= 1, 'and the noteheads are coloured once it stops', `${marked.colours} colours`);
  // A block of the strip puts the cursor on its bar.
  await page.locator('#reading .rd-bar').last().click();
  await page.waitForTimeout(500);
  const jumped = await page.evaluate(() => document.getElementById('bar-now').textContent);
  check(jumped === `bar ${range.endBar}`, 'a block of the strip jumps to its bar', jumped);
  await page.screenshot({ path: out.replace(/\.png$/, '-scored.png') });
  await page.locator('#reading .rd-close').click();
  await page.waitForTimeout(1500);
  const putAway = await page.evaluate(() => ({
    card: !document.getElementById('reading').hidden,
    reading: document.getElementById('app').hasAttribute('data-reading'),
  }));
  check(!putAway.card && !putAway.reading, 'its close puts the reading away', JSON.stringify(putAway));

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
