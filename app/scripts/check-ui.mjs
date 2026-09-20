// Drive the player headless: press Space, look at the cursor and the chrome,
// then check the notation window follows the cursor a line at a time and the
// keyboard shortcuts do what the legend says. Writes a screenshot of the
// window on its second line in the light theme, one in the dark theme next to
// it (<out>-dark.png), and one of the pairing the second theme is for: a dark
// interface with light notation (<out>-dark-light-tabs.png).
//
// Usage: node scripts/check-ui.mjs <out.png>
import { launch, pageUrl, waitForPlayer } from './browser.mjs';
const out = process.argv[2];
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
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
    const picture = rect(document.getElementById('picture'));
    const tabs = rect(document.getElementById('tabs'));
    const video = rect(document.getElementById('video'));
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
      picture,
      tabs,
      video,
      rail: rect(document.getElementById('rail')),
      desk: rect(document.getElementById('desk')),
      zen: !!document.documentElement.dataset.zen,
      screen: window.innerHeight,
      // The point of the split: the notation is under the picture, never on
      // top of it. A song with no video has no picture to compare against.
      overlap: !!(picture && tabs) && picture.y + picture.h > tabs.y,
      cursorInside: inside,
      speed: document.getElementById('speed').value,
      faders: Object.fromEntries(['nodrums', 'drums', 'click'].map((f) => [f, document.getElementById(`fader-${f}`).value])),
      sticking: document.querySelectorAll('.sticking span').length,
      // The Layout group, as alphaTab ended up engraving it, and what the
      // four faders say they asked for.
      layout: {
        scale: d.api.settings.display.scale,
        bars: d.api.settings.display.barsPerRow,
        stretch: d.api.settings.display.stretchForce,
        gap: d.api.settings.display.systemPaddingTop * 2,
      },
      knobs: Object.fromEntries(
        ['zoom', 'bars', 'spacing', 'gap'].map((k) => [
          k,
          { value: document.getElementById(k).value, out: document.getElementById(`${k}-out`).textContent },
        ])
      ),
      // The engraved score against the box that clips it: bars packed onto a
      // line have to still fit the width, not run off the side of the pane.
      overflowX: box ? box.scrollWidth - box.clientWidth : 0,
      // Bars actually on the first row, which is what barsPerRow asked for.
      barsOnRow0: (d.scoreWindow.firstBarOfRow(1) ?? 0) - (d.scoreWindow.firstBarOfRow(0) ?? 0),
      // The letters are ours, not alphaTab's: they grow from a CSS variable.
      letterPx: (() => {
        const el = document.querySelector('.sticking span');
        return el ? Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10 : 0;
      })(),
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

// 7. The stage is a split, not an overlay: the notation sits under the
// picture at every setting. 3 lines makes the window a line taller than 2, and
// Fill turns the split round -- the notation takes what is left and the
// picture keeps the third of the screen --fill-picture sets. The video itself
// is sized to its own shape inside that region, so one of its two dimensions
// fills the region exactly and neither overflows it: that is the check that
// there are no black bars. (Fill is the default for a song with no video, so
// start from 2 rather than from whatever this song loaded with.)
await page.selectOption('#lines', '2');
await page.waitForTimeout(200);
s = await snapshot();
const h2 = s.box.h;
check(!s.overlap, `the notation overlaps the picture at 2 lines: ${JSON.stringify({ picture: s.picture, tabs: s.tabs })}`);
await page.selectOption('#lines', '3');
await page.waitForTimeout(200);
s = await snapshot();
check(s.lines === 3 && s.box.h > h2 + 60, `3 lines made the window ${s.box.h}px (2 lines was ${h2}px)`);
// The video is sized to its own shape, so it fills its region on one axis and
// is inside it on the other. A letterboxed video would be short of it on both.
const hugs = (v, p) =>
  !v || !p || ((Math.abs(v.h - p.h) <= 2 || Math.abs(v.w - p.w) <= 2) && v.h <= p.h + 2 && v.w <= p.w + 2);
check(hugs(s.video, s.picture), `at 3 lines the video ${JSON.stringify(s.video)} does not fill its region ${JSON.stringify(s.picture)}`);
await page.selectOption('#lines', 'fit');
await page.waitForTimeout(300);
s = await snapshot();
const third = Math.round(s.screen / 3);
console.log('fill:', JSON.stringify({ picture: s.picture, video: s.video, tabs: s.tabs, box: s.box, third }));
check(s.lines === 'fit' && s.box.h > h2, `Fill made the window ${s.box.h}px (2 lines was ${h2}px)`);
check(!s.overlap, `the notation overlaps the picture on Fill: ${JSON.stringify({ picture: s.picture, tabs: s.tabs })}`);
check(
  !s.picture || Math.abs(s.picture.h - third) <= 2,
  `Fill left the picture ${s.picture?.h}px, expected a third of the ${s.screen}px screen (${third}px)`
);
check(hugs(s.video, s.picture), `on Fill the video ${JSON.stringify(s.video)} does not fill its region ${JSON.stringify(s.picture)}`);
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

// 9. Dark theme screenshot of line 2 (a seek while paused moves the window
// too). The interface switch takes the notation with it while the notation has
// no theme of its own, so this is both of them going dark.
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

// 10. The notation's own switch: light paper on a dark page, with the
// interface left where it was. This is the pairing the second theme is for.
const themes = await page.evaluate(() => {
  document.getElementById('tab-theme').click();
  const d = document.documentElement.dataset;
  return { ui: d.theme, tabs: d.tabTheme };
});
await page.waitForTimeout(1500);
s = await snapshot();
check(themes.tabs === 'light', `the notation switch left data-tab-theme=${themes.tabs}`);
check(themes.ui === 'dark', `the notation switch changed the interface to ${themes.ui}`);
check(
  s.row === 1 && s.cursorInside,
  `after the notation re-render the window is on row ${s.row}, cursor inside ${s.cursorInside}`
);
console.log('themes:', JSON.stringify(themes));
await page.screenshot({ path: out.replace(/\.png$/, '-dark-light-tabs.png') });

// 11. Both rails fold to one icon wide, the stage takes the room they leave,
// and the score is re-engraved for the width it lands on -- keeping the row it
// was on, the same way it does across a theme switch. The controls are still
// controls: what cannot be an icon is hidden, what can is still clickable.
await page.evaluate(() => window.drums.seekToBar(4));
await page.waitForTimeout(400);
const wide = await snapshot();
await page.locator('#rail-toggle').click();
await page.locator('#desk-toggle').click();
await page.waitForTimeout(1500);
s = await snapshot();
console.log('icons:', JSON.stringify({ rail: s.rail, desk: s.desk, tabs: s.tabs, row: s.row }));
check(s.rail.w <= 48 && s.desk.w <= 48, `collapsed rails are ${s.rail.w}px / ${s.desk.w}px, expected ~46`);
check(s.tabs.w > wide.tabs.w + 300, `collapsing did not widen the stage (${wide.tabs.w} -> ${s.tabs.w})`);
check(s.row === 1 && s.cursorInside, `after the collapse re-render the window is on row ${s.row}, cursor inside ${s.cursorInside}`);
check(!s.overlap, 'the notation overlaps the picture with the rails collapsed');
check(await page.locator('#play').isVisible(), 'the Play button went with the labels');
check(await page.locator('#lines').isVisible(), 'the Lines select went with the labels');
check(await page.locator('#routine').isHidden(), 'the routine grid is still drawn in a collapsed rail');
await page.screenshot({ path: out.replace(/\.png$/, '-icons.png') });
// Remembered, and applied before first paint: the score is engraved once, for
// the width the page is going to keep.
await page.reload();
await waitForPlayer(page);
await page.waitForFunction(() => window.drums.mix.readyState >= 1, null, { timeout: 30000 });
check((await snapshot()).rail.w <= 48, 'the collapse was not remembered across a reload');
await page.locator('#rail-toggle').click();
await page.locator('#desk-toggle').click();
await page.waitForTimeout(1500);

// 12. Zen: the picture and the notation, nothing else, edge to edge. Headless
// Chromium does not do real fullscreen, so this checks the half the page owns
// -- and leaves through the shortcut, because Esc-exits-fullscreen is the
// browser's behaviour and headless does not have it either.
await page.evaluate(() => window.drums.seekToBar(4));
await page.waitForTimeout(400);
await page.keyboard.press('KeyZ');
await page.waitForTimeout(1500);
const z = await page.evaluate(() => ({
  rail: getComputedStyle(document.getElementById('rail')).display,
  desk: getComputedStyle(document.getElementById('desk')).display,
  status: getComputedStyle(document.getElementById('status')).display,
  columns: getComputedStyle(document.getElementById('app')).gridTemplateColumns.split(' ').length,
  // An error is the one thing zen keeps: it is how a refused fullscreen is
  // escapable at all.
  errShown: (() => {
    const el = document.getElementById('status');
    el.classList.add('err');
    const shown = getComputedStyle(el).display !== 'none';
    el.classList.remove('err');
    return shown;
  })(),
}));
s = await snapshot();
console.log('zen:', JSON.stringify({ ...z, tabs: s.tabs }));
check(s.zen, 'Z did not turn zen on');
check(z.rail === 'none' && z.desk === 'none' && z.status === 'none', `zen left rail=${z.rail} desk=${z.desk} status=${z.status}`);
check(z.columns === 1, `zen left the grid at ${z.columns} columns`);
check(s.tabs.x <= 2, `zen left the notation ${s.tabs.x}px from the edge`);
check(!s.overlap, 'the notation overlaps the picture in zen');
check(z.errShown, 'zen hides the status line even when it is an error');
await page.screenshot({ path: out.replace(/\.png$/, '-zen.png') });
await page.keyboard.press('KeyZ');
await page.waitForTimeout(1500);
s = await snapshot();
check(!s.zen, 'Z did not turn zen off');
check(s.row === 1 && s.cursorInside, `after leaving zen the window is on row ${s.row}, cursor inside ${s.cursorInside}`);

// 13. Size: + makes the notes bigger, the window still holds the lines it was
// asked for so its box grows, the letters we draw ourselves grow with the
// notes, the fader in the rail reads the new percentage, - comes back, and
// the rung is remembered. Bars a line is no longer along for the ride: it is
// its own fader now (check 14), so + must leave it alone.
await page.evaluate(() => window.drums.seekToBar(4));
await page.waitForTimeout(400);
const home = await snapshot();
check(
  home.layout.scale === 1 && home.layout.bars === 4 && home.layout.stretch === 1 && home.layout.gap === 20,
  `not at the Layout defaults to start: ${JSON.stringify(home.layout)}`
);
await page.keyboard.press('Equal');
await page.waitForTimeout(1500);
s = await snapshot();
console.log('size up:', JSON.stringify({ layout: s.layout, knobs: s.knobs, box: s.box.h, letterPx: s.letterPx, was: { box: home.box.h, letterPx: home.letterPx } }));
check(s.layout.scale > 1, `+ left the notation at ${s.layout.scale}x`);
check(s.layout.bars === 4, `+ moved the line to ${s.layout.bars} bars; that is the Bars fader's job now`);
check(s.knobs.zoom.out === `${Math.round(s.layout.scale * 100)}%`, `the Size fader reads ${s.knobs.zoom.out} at ${s.layout.scale}x`);
check(s.box.h > home.box.h + 10, `+ did not make the window taller (${home.box.h} -> ${s.box.h}px)`);
check(!s.overlap, 'the notation overlaps the picture when sized up');
check(s.cursorInside, 'cursor not inside the window after sizing up');
if (hasSticking) check(s.letterPx > home.letterPx, `the sticking letters stayed ${s.letterPx}px through the size change`);
await page.screenshot({ path: out.replace(/\.png$/, '-zoom.png') });
await page.keyboard.press('Minus');
await page.waitForTimeout(1500);
s = await snapshot();
check(s.layout.scale === 1 && s.layout.bars === 4, `- did not come back to 100%/4 bars: ${JSON.stringify(s.layout)}`);
check(Math.abs(s.box.h - home.box.h) <= 2, `- left the window at ${s.box.h}px (was ${home.box.h}px)`);
await page.keyboard.press('Minus');
await page.keyboard.press('Minus');
await page.waitForTimeout(1500);
s = await snapshot();
console.log('size down:', JSON.stringify({ layout: s.layout, box: s.box.h }));
check(s.layout.scale < 1, `two - left the notation at ${s.layout.scale}x`);
check(s.layout.bars === 4, `sizing down changed the line to ${s.layout.bars} bars`);
check(s.box.h < home.box.h, `sizing down did not make the window shorter (${home.box.h} -> ${s.box.h}px)`);
const remembered = await page.evaluate(() => localStorage.getItem('zoom'));
check(remembered === String(s.layout.scale), `the size remembered ${remembered}, but is engraving at ${s.layout.scale}x`);

// 14. The other three faders in the Layout group. Each is dragged the way a
// mouse drags one -- `input` moves the number, `change` re-engraves -- and
// each has to reach alphaTab, be remembered, and leave the other two alone.
const drag = async (id, value) => {
  await page.evaluate(
    ([id, value]) => {
      const el = document.getElementById(id);
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [id, value]
  );
  await page.waitForTimeout(1500);
  return snapshot();
};
await page.keyboard.press('Digit0');
await page.waitForTimeout(1500);

// Bars a line: eight bars share the same row width, so the row holds eight
// and the score still fits the pane rather than running off the side of it.
s = await drag('bars', 8);
console.log('bars 8:', JSON.stringify({ layout: s.layout, out: s.knobs.bars.out, barsOnRow0: s.barsOnRow0, overflowX: s.overflowX }));
check(s.layout.bars === 8, `the Bars fader asked for 8 and alphaTab has ${s.layout.bars}`);
check(s.knobs.bars.out === '8', `the Bars fader reads ${s.knobs.bars.out}`);
check(s.barsOnRow0 === 8, `asked for 8 bars a line and the first row holds ${s.barsOnRow0}`);
check(s.overflowX <= 2, `8 bars a line runs ${s.overflowX}px off the side of the pane`);
check(s.layout.scale === 1, `the Bars fader moved the size to ${s.layout.scale}x`);
await page.screenshot({ path: out.replace(/\.png$/, '-dense.png') });
s = await drag('bars', 2);
check(s.layout.bars === 2 && s.barsOnRow0 === 2, `asked for 2 bars a line and got ${s.layout.bars}/${s.barsOnRow0}`);
await page.screenshot({ path: out.replace(/\.png$/, '-loose.png') });

// Note spacing: alphaTab's stretchForce, as a percentage.
s = await drag('spacing', 60);
console.log('spacing 60:', JSON.stringify({ layout: s.layout, out: s.knobs.spacing.out }));
check(s.layout.stretch === 0.6, `the Spacing fader asked for 60% and alphaTab has ${s.layout.stretch}`);
check(s.knobs.spacing.out === '60%', `the Spacing fader reads ${s.knobs.spacing.out}`);

// Line gap: air between the rows, which the window has to pay for in height.
const beforeGap = s.box.h;
s = await drag('gap', 48);
console.log('gap 48:', JSON.stringify({ layout: s.layout, out: s.knobs.gap.out, box: s.box.h, was: beforeGap }));
check(s.layout.gap === 48, `the Gap fader asked for 48 and alphaTab has ${s.layout.gap}`);
check(s.knobs.gap.out === '48px', `the Gap fader reads ${s.knobs.gap.out}`);
check(s.box.h > beforeGap, `a wider line gap did not make the window taller (${beforeGap} -> ${s.box.h}px)`);
check(s.cursorInside, 'cursor not inside the window after the line gap widened');

const kept = await page.evaluate(() => ({
  bars: localStorage.getItem('bars'),
  spacing: localStorage.getItem('noteSpacing'),
  gap: localStorage.getItem('lineGap'),
}));
check(
  kept.bars === '2' && kept.spacing === '60' && kept.gap === '48',
  `the Layout group remembered ${JSON.stringify(kept)}`
);

// 0 puts the whole group back, not just the size.
await page.keyboard.press('Digit0');
await page.waitForTimeout(1500);
s = await snapshot();
console.log('layout home:', JSON.stringify({ layout: s.layout, knobs: s.knobs, box: s.box.h }));
check(
  s.layout.scale === 1 && s.layout.bars === 4 && s.layout.stretch === 1 && s.layout.gap === 20,
  `0 did not put the Layout group back: ${JSON.stringify(s.layout)}`
);
check(Math.abs(s.box.h - home.box.h) <= 2, `0 left the window at ${s.box.h}px (was ${home.box.h}px)`);
check(s.cursorInside, 'cursor not inside the window after the Layout group went home');

// 15. The header: the only part of the page that knows there is more than one
// page. Every route has to be able to reach every other one from it -- before
// it existed the pool was behind a button on the song page and neither the
// pool nor an exercise page had any way back at all.
const header = async () =>
  page.evaluate(() => {
    const nav = document.getElementById('nav');
    const link = document.getElementById('nav-exercises');
    return {
      page: document.documentElement.dataset.page ?? 'song',
      shown: getComputedStyle(nav).display !== 'none',
      // The current page marks itself off [data-page]; `lit` is that marking,
      // asked by the filled background, which is the one thing hovering the
      // link does not also do.
      lit: getComputedStyle(link).backgroundColor !== 'rgba(0, 0, 0, 0)',
      song: !!document.getElementById('song'),
      rails: !!document.getElementById('rail-toggle') && !!document.getElementById('desk-toggle'),
      zen: !!document.getElementById('zen'),
    };
  });

let h = await header();
console.log('header on a song:', JSON.stringify(h));
check(h.shown && h.song && h.rails && h.zen, `the header is missing controls on a song page: ${JSON.stringify(h)}`);
check(!h.lit, 'Exercises is marked as the current page while on a song');

// Song -> pool, from the header.
await page.locator('#nav-exercises').click();
await page.waitForTimeout(800);
h = await header();
console.log('header on the pool:', JSON.stringify(h));
check(h.page === 'pool', `Exercises went to ${h.page}`);
check(h.shown && h.song, 'the pool page lost the header');
check(h.lit, 'the pool page does not mark Exercises as where you are');

// Pool -> an exercise -> back out again. The exercise page is the one that
// used to be a dead end: its own group is hidden there by [data-page].
const first = page.locator('#pool .ex-open').first();
if (await first.count()) {
  await first.click();
  await page.waitForTimeout(2500);
  h = await header();
  console.log('header on an exercise:', JSON.stringify(h));
  check(h.page === 'exercise', `a pool row went to ${h.page}`);
  check(h.shown && h.song, 'the exercise page lost the header');
  check(h.lit, 'an exercise does not mark Exercises as where you are');
  await page.locator('#nav-exercises').click();
  await page.waitForTimeout(800);
  check((await header()).page === 'pool', 'there is no way back to the pool from an exercise');
} else {
  console.log('header on an exercise: skipped, the pool is empty');
}

// ...and the song picker still navigates from its new home in the header.
// The pointer goes somewhere neutral first: a link left under the mouse draws
// its hover, and the marking has to be read with nothing else painting it.
await page.mouse.move(0, 0);
await page.selectOption('#song', { index: 0 });
await page.waitForTimeout(2500);
h = await header();
console.log('header back to a song:', JSON.stringify(h));
check(h.page === 'song', `the header's song picker left the page on ${h.page}`);
check(!h.lit, 'Exercises is still marked after going back to a song');

// Zen takes the header with the rails.
await page.locator('#zen').click();
await page.waitForTimeout(600);
check(!(await header()).shown, 'zen left the header on screen');
await page.keyboard.press('KeyZ');
await page.waitForTimeout(600);
check((await header()).shown, 'leaving zen did not bring the header back');

await page.evaluate(() => {
  document.getElementById('theme').click();
  for (const key of ['theme', 'tabTheme', 'lines', 'sticking', 'rail', 'desk', 'zoom', 'bars', 'noteSpacing', 'lineGap'])
    localStorage.removeItem(key);
});

console.log(errors.length ? `page errors: ${errors.join('; ')}` : 'no page errors');
console.log(problems.length ? `PROBLEMS:\n  - ${problems.join('\n  - ')}` : 'all checks passed');
await browser.close();
process.exit(problems.length || errors.length ? 1 : 0);
