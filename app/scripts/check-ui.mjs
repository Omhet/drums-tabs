// Drive the player headless: press Space, look at the cursor and the chrome,
// then check the notation window follows the cursor a line at a time and the
// keyboard shortcuts do what the legend says. Writes a screenshot of the
// window on its second line in the light theme, and one in the dark theme
// next to it (<out>-dark.png).
//
// Usage: node scripts/check-ui.mjs <out.png>
import { launch, pageUrl, waitForPlayer } from './browser.mjs';
const out = process.argv[2];
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(pageUrl());
await waitForPlayer(page);
await page.waitForFunction(() => window.drums.mix.readyState >= 1, null, { timeout: 30000 });

const problems = [];
const check = (ok, what) => {
  if (!ok) problems.push(what);
};
// What the page looks like from outside: transport, cursor, window.
const snapshot = () =>
  page.evaluate(() => {
    const d = window.drums;
    const box = document.getElementById('score-box');
    const beat = document.querySelector('.at-cursor-beat');
    const rect = (el) => {
      const r = el?.getBoundingClientRect();
      return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
    };
    const c = rect(beat);
    const b = rect(box);
    const inside = !!(c && b && c.y >= b.y && c.y + c.h <= b.y + b.h && c.x >= b.x && c.x + c.w <= b.x + b.w);
    const ticksPerBar = 960 * (d.current?.grid?.meter.beats_per_bar ?? 4);
    const texts = [...document.querySelectorAll('#score text')];
    return {
      state: d.api.playerState,
      bar: Math.floor(d.api.tickPosition / ticksPerBar),
      row: d.scoreWindow.row,
      lines: d.scoreWindow.lines,
      mix: { time: Math.round(d.mix.currentTime * 1000) / 1000, paused: d.mix.paused, rate: d.mix.playbackRate },
      cursor: c,
      box: b,
      cursorInside: inside,
      speed: document.getElementById('speed').value,
      faders: Object.fromEntries(['nodrums', 'drums', 'click'].map((f) => [f, document.getElementById(`fader-${f}`).value])),
      sticking: document.querySelectorAll('.sticking span').length,
      drumsLabel: texts.some((t) => t.textContent === 'Drums'),
      clefsVisible: texts.filter((t) => t.textContent === '' && t.style.display !== 'none').length,
      clefsHidden: texts.filter((t) => t.textContent === '' && t.style.display === 'none').length,
    };
  });

// 1. Space plays; through the count-in the cursor is on line 1, in the window.
await page.keyboard.press('Space');
await page.waitForTimeout(4500);
let s = await snapshot();
console.log('playing:', JSON.stringify(s));
check(s.state === 1 && !s.mix.paused, 'Space did not start playback');
check(s.cursorInside, 'cursor not inside the window while playing');
check(s.row === 0, `window not on line 1 at the start (row ${s.row})`);
check(!s.drumsLabel, '"Drums" track name is drawn');
check(s.clefsVisible === 0, `${s.clefsVisible} percussion clefs visible`);

// 2. Seek to bar 5 while playing: line 2 goes to the top, cursor still in view.
await page.evaluate(() => window.drums.seekToBar(4));
await page.waitForTimeout(700);
s = await snapshot();
console.log('bar 5:', JSON.stringify({ bar: s.bar, row: s.row, cursor: s.cursor, box: s.box, inside: s.cursorInside }));
check(s.bar === 4, `seek to bar 5 landed on bar ${s.bar + 1}`);
check(s.row === 1, `window not on line 2 at bar 5 (row ${s.row})`);
check(s.cursorInside, 'cursor not inside the window at bar 5');

// 3. Space pauses.
await page.keyboard.press('Space');
await page.waitForTimeout(300);
s = await snapshot();
check(s.state === 0 && s.mix.paused, 'second Space did not pause');

// 4. Arrows seek by a bar and a line, paused, and the window follows.
const barAfter = async (key) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(400);
  return snapshot();
};
s = await barAfter('ArrowRight');
check(s.bar === 5, `ArrowRight went to bar ${s.bar + 1}, expected 6`);
s = await barAfter('ArrowLeft');
check(s.bar === 4, `ArrowLeft went to bar ${s.bar + 1}, expected 5`);
s = await barAfter('ArrowDown');
check(s.bar === 8 && s.row === 2, `ArrowDown went to bar ${s.bar + 1} row ${s.row}, expected bar 9 row 3`);
s = await barAfter('ArrowUp');
check(s.bar === 4 && s.row === 1, `ArrowUp went to bar ${s.bar + 1} row ${s.row}, expected bar 5 row 2`);
check(s.cursorInside, 'cursor not inside the window after arrow seeks');
console.log('after arrows:', JSON.stringify({ bar: s.bar, row: s.row, inside: s.cursorInside, mix: s.mix }));
await page.screenshot({ path: out });

// 5. Tempo and faders.
await page.keyboard.press('BracketRight');
await page.keyboard.press('BracketRight');
await page.keyboard.press('BracketLeft');
await page.keyboard.press('Digit3');
await page.keyboard.press('Digit1');
await page.waitForTimeout(200);
s = await snapshot();
console.log('keys:', JSON.stringify({ speed: s.speed, rate: s.mix.rate, faders: s.faders }));
check(s.speed === '105' && Math.abs(s.mix.rate - 1.05) < 1e-6, `brackets left the tempo at ${s.speed}% / rate ${s.mix.rate}`);
check(s.faders.click === '100', `Digit3 left the click at ${s.faders.click}%`);
check(s.faders.nodrums === '0', `Digit1 left no-drums at ${s.faders.nodrums}%`);
await page.keyboard.press('Digit1');
await page.keyboard.press('Digit3');
await page.keyboard.press('BracketLeft');
await page.waitForTimeout(200);
s = await snapshot();
check(s.faders.nodrums === '100' && s.faders.click === '0' && s.speed === '100', `toggling back left ${JSON.stringify(s.faders)} at ${s.speed}%`);

// 6. Home stops: the clock at 0, paused, window back on line 1.
await page.keyboard.press('Home');
await page.waitForTimeout(500);
s = await snapshot();
console.log('home:', JSON.stringify({ mix: s.mix, row: s.row, bar: s.bar }));
check(s.mix.paused && s.mix.time === 0, `Home left the clock at ${s.mix.time}s paused=${s.mix.paused}`);
check(s.row === 0, `Home left the window on row ${s.row}`);

// 7. Lines: 3 makes the window a line taller than 2, and Fill takes the whole
// stage (which is the default for a song with no video, so start from 2
// rather than from whatever this song loaded with).
await page.selectOption('#lines', '2');
await page.waitForTimeout(200);
const h2 = (await snapshot()).box.h;
await page.selectOption('#lines', '3');
await page.waitForTimeout(200);
s = await snapshot();
check(s.lines === 3 && s.box.h > h2 + 100, `3 lines made the window ${s.box.h}px (2 lines was ${h2}px)`);
await page.selectOption('#lines', 'fit');
await page.waitForTimeout(200);
s = await snapshot();
const stage = await page.evaluate(() => Math.round(document.getElementById('stage').getBoundingClientRect().height));
check(s.lines === 'fit' && Math.abs(s.box.h - stage) <= 2, `Fill made the window ${s.box.h}px of a ${stage}px stage`);
await page.selectOption('#lines', '2');

// 8. Sticking: R and L under the notation, and the switch turns them off. A
// song with no sticking.lock.json has none, and that is not a failure.
const hasSticking = await page.evaluate(() => window.drums.sticking.count > 0);
s = await snapshot();
if (hasSticking) {
  check(s.sticking > 0, 'sticking.lock.json is loaded but no letters are drawn');
  await page.uncheck('#sticking');
  await page.waitForTimeout(200);
  check((await snapshot()).sticking === 0, 'unchecking Sticking left the letters up');
  await page.check('#sticking');
  await page.waitForTimeout(200);
  check((await snapshot()).sticking > 0, 'checking Sticking back did not bring them back');
}
console.log('sticking:', hasSticking ? `${s.sticking} letters` : 'none for this song');

// 9. Dark theme screenshot of line 2 (a seek while paused moves the window too).
await page.evaluate(() => window.drums.seekToBar(4));
await page.waitForTimeout(400);
const dark = await page.evaluate(() => {
  const btn = document.getElementById('theme');
  const wasDark = document.documentElement.dataset.theme === 'dark';
  if (!wasDark) btn.click();
  return document.documentElement.dataset.theme;
});
await page.waitForTimeout(1500);
s = await snapshot();
check(dark === 'dark', `theme switch left data-theme=${dark}`);
check(s.row === 1 && s.cursorInside, `after the theme re-render the window is on row ${s.row}, cursor inside ${s.cursorInside}`);
await page.screenshot({ path: out.replace(/\.png$/, '-dark.png') });
await page.evaluate(() => {
  document.getElementById('theme').click();
  localStorage.removeItem('theme');
  localStorage.removeItem('lines');
  localStorage.removeItem('sticking');
});

console.log(errors.length ? `page errors: ${errors.join('; ')}` : 'no page errors');
console.log(problems.length ? `PROBLEMS:\n  - ${problems.join('\n  - ')}` : 'all checks passed');
await browser.close();
process.exit(problems.length || errors.length ? 1 : 0);
