// Drive the player headless at the size it is read at (2194x1100, a 31.5" 4K
// screen at 175%): press Space, look at the cursor and the header, check the
// notation window follows the cursor a line at a time, the keys do what the
// list on the Settings page says, the header folds with the video without the paper
// changing width, and the layout knobs reach alphaTab. Writes a screenshot of
// the window on its second line (<out>), one with dark paper
// (<out>-dark-paper.png), the light interface (<out>-light.png), zen
// (<out>-zen.png), browsing while paused (<out>-browsing.png), the library
// (<out>-library.png), sized up (<out>-zoom.png), 8 and 2 bars a line
// (<out>-dense.png, <out>-loose.png), the song map as a picker
// (<out>-picker.png), Kill Me's three section lines (<out>-three.png), and
// Come As You Are at a wide line gap (<out>-caya.png).
// Also: the song map (a click jumps, the Loop pill opens the picker over the
// paper without moving it, and its picks), the paper's layers, the Mix
// panel over the header (M) and the Settings page (the gear). And with no kit
// connected -- which is how a headless Chrome always is -- nothing of the kit
// layer is on the page: no chip, no Record pill, no reading card.
//
// Usage: node scripts/check-ui.mjs <out.png>
import { launch, pageUrl, waitForPlayer } from './browser.mjs';
const out = process.argv[2];
const W = 2194;
const H = 1100;
const browser = await launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(pageUrl());
await waitForPlayer(page);
await page.waitForFunction(() => window.drums.mix.readyState >= 1, null, { timeout: 30000 });
// Every engraving, counted: the paper's width must never move mid-song, and a
// width that moved is a re-engrave.
await page.evaluate(() => {
  window.__renders = 0;
  window.drums.api.renderFinished.on(() => window.__renders++);
});

const problems = [];
const check = (ok, what) => {
  if (!ok) problems.push(what);
};
// What the page looks like from outside: transport, cursor, window, header.
const snapshot = () =>
  page.evaluate(() => {
    const d = window.drums;
    const rect = (el) => {
      const r = el?.getBoundingClientRect();
      return r && r.width > 0 ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
    };
    const box = document.getElementById('score-box');
    const c = rect(document.querySelector('.at-cursor-beat'));
    const b = rect(box);
    const inside = !!(c && b && c.y >= b.y && c.y + c.h <= b.y + b.h && c.x >= b.x && c.x + c.w <= b.x + b.w);
    const ticksPerBar = 960 * (d.current?.grid?.meter.beats_per_bar ?? 4);
    const texts = [...document.querySelectorAll('#score text')];
    const px = (id) => parseFloat(getComputedStyle(document.getElementById(id)).fontSize);
    // Everything in the header that has a box: none may run off the screen.
    const headRight = Math.max(
      ...[...document.querySelectorAll('#head *')].map((e) => e.getBoundingClientRect().right)
    );
    return {
      state: d.api.playerState,
      bar: Math.floor(d.api.tickPosition / ticksPerBar),
      row: d.scoreWindow.row,
      lines: d.scoreWindow.lines,
      mix: { time: Math.round(d.mix.currentTime * 1000) / 1000, paused: d.mix.paused, rate: d.mix.playbackRate },
      cursor: c,
      box: b,
      tabs: rect(document.getElementById('tabs')),
      video: rect(document.getElementById('video')),
      play: rect(document.getElementById('play')),
      steps: rect(document.getElementById('tempo-steps')),
      map: rect(document.getElementById('map')),
      head: document.getElementById('app').dataset.head,
      headRight: Math.round(headRight),
      type: { section: px('section-name'), bar: px('bar-of'), tempo: px('tempo-pct') },
      sectionText: document.getElementById('section-name').textContent,
      barText: document.getElementById('bar-of').textContent,
      font: getComputedStyle(document.body).fontFamily,
      zen: !!document.documentElement.dataset.zen,
      mixOpen: !document.getElementById('mix-panel').hidden,
      settings: !document.getElementById('settings').hidden,
      panel: rect(document.getElementById('mix-panel')),
      mixPill: rect(document.getElementById('mix-btn')),
      gear: rect(document.getElementById('settings-btn')),
      songsIcon: rect(document.getElementById('songs-btn')),
      renders: window.__renders,
      cursorInside: inside,
      speed: String(d.tempo),
      faders: Object.fromEntries(['nodrums', 'drums', 'click'].map((f) => [f, document.getElementById(`fader-${f}`).value])),
      muted: Object.fromEntries(
        ['nodrums', 'drums', 'click', 'kit'].map((f) => [f, document.getElementById(`mute-${f}`).getAttribute('aria-pressed') === 'true'])
      ),
      sticking: document.querySelectorAll('.sticking span').length,
      // The layout knobs, as alphaTab ended up engraving them (bars a line is
      // on the score, for the parchment layout), and what the three knobs say
      // they asked for.
      layout: {
        scale: d.api.settings.display.scale,
        bars: d.api.score?.defaultSystemsLayout,
        gap: d.api.settings.display.systemPaddingTop * 2,
      },
      knobs: Object.fromEntries(
        ['zoom', 'bars', 'gap'].map((k) => [
          k,
          { out: document.getElementById(`${k}-out`).textContent },
        ])
      ),
      overflowX: box ? box.scrollWidth - box.clientWidth : 0,
      barsOnRow0: (d.scoreWindow.firstBarOfRow(1) ?? 0) - (d.scoreWindow.firstBarOfRow(0) ?? 0),
      letterPx: (() => {
        const el = document.querySelector('.sticking span');
        return el ? Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10 : 0;
      })(),
      // The ink alphaTab engraved with, which the paper's tokens decide.
      ink: texts.find((t) => t.getAttribute('fill'))?.getAttribute('fill') ?? '',
      drumsLabel: texts.some((t) => t.textContent === 'Drums'),
      clefsVisible: texts.filter((t) => t.textContent === '' && t.style.display !== 'none').length,
    };
  });

// 0. The face is the spec's, self-hosted, and loaded.
const font = await page.evaluate(async () => {
  await document.fonts.ready;
  return {
    loaded: document.fonts.check('700 64px "Atkinson Hyperlegible Next"'),
    faces: [...document.fonts].filter((f) => f.family.includes('Atkinson') && f.status === 'loaded').length,
  };
});
check(font.loaded && font.faces >= 1, `Atkinson Hyperlegible Next is not loaded: ${JSON.stringify(font)}`);

// 1. Space plays; through the count-in the cursor is on line 1, in the window.
await page.keyboard.press('Space');
await page.waitForTimeout(4500);
let s = await snapshot();
console.log('playing:', JSON.stringify({ state: s.state, bar: s.bar, row: s.row, cursor: s.cursor, box: s.box, head: s.head }));
check(s.state === 1 && !s.mix.paused, 'Space did not start playback');
check(s.cursorInside, 'cursor not inside the window while playing');
check(s.row === 0, `window not on line 1 at the start (row ${s.row})`);
check(!s.drumsLabel, '"Drums" track name is drawn');
check(s.clefsVisible === 0, `${s.clefsVisible} percussion clefs visible`);

// 2. The header with the video (Lamp-01): sizes from the spec.
console.log('header:', JSON.stringify({ video: s.video, play: s.play, steps: s.steps, map: s.map, tabs: s.tabs, type: s.type, right: s.headRight }));
check(s.head === 'full', `a song with a video starts with the ${s.head} header`);
check(s.video && Math.abs(s.video.x - 40) <= 1 && Math.abs(s.video.y - 24) <= 1 && s.video.w === 588 && s.video.h === 331, `the video is ${JSON.stringify(s.video)}, not 588x331 at 40,24`);
check(s.play && s.play.w === 76 && s.play.h === 76 && Math.abs(s.play.y - 279) <= 1, `Play is ${JSON.stringify(s.play)}, not 76x76 at top 279`);
check(s.map && Math.abs(s.map.y - 372) <= 1 && s.map.h === 80, `the song map's slot is ${JSON.stringify(s.map)}, not 80 tall at 372`);
check(s.tabs && s.tabs.x === 40 && s.tabs.w === W - 80 && Math.abs(s.tabs.y - 466) <= 1, `the paper is ${JSON.stringify(s.tabs)}, not 2114 wide at 40,466`);
check(s.tabs && s.tabs.y + s.tabs.h <= H, 'the paper runs off the bottom of the screen');
check([120, 88, 64].includes(s.type.section) && s.type.bar === 64 && s.type.tempo === 176, `type sizes ${JSON.stringify(s.type)}, not section 120/88/64, bar 64, tempo 176`);
check(s.headRight <= W - 40 + 1, `something in the header runs to ${s.headRight}px, past the margin at ${W - 40}`);
check(/Atkinson Hyperlegible Next/.test(s.font), `the page is set in ${s.font}`);
check(s.lines === 2, `${s.lines} lines of notation under the video, not 2`);
// The lines stand in the middle of the paper: as much room over the notes as
// under them.
const over = s.box.y - s.tabs.y;
const under = s.tabs.y + s.tabs.h - (s.box.y + s.box.h);
check(Math.abs(over - under) <= 2, `the paper has ${over}px over the notes and ${under}px under them`);

// 2b. No kit, no kit layer (Lamp-12): nothing to read past mid-song.
const kitLayer = () =>
  page.evaluate(() => {
    const shown = (id) => {
      const el = document.getElementById(id);
      return !!el && el.getClientRects().length > 0;
    };
    return {
      kit: document.getElementById('app').hasAttribute('data-kit'),
      chip: shown('kit-chip'),
      record: shown('record'),
      card: shown('reading'),
      words: /Kit connected|Record\b|Recording/.test(document.getElementById('head').innerText),
    };
  });
const noKit = await kitLayer();
check(
  !noKit.kit && !noKit.chip && !noKit.record && !noKit.card && !noKit.words,
  `with no kit connected the kit layer shows: ${JSON.stringify(noKit)}`
);

// 3. Seek to bar 5 while playing: line 2 goes to the top, cursor still in view,
// and the header says where.
await page.evaluate(() => window.drums.seekToBar(4));
await page.waitForTimeout(700);
s = await snapshot();
console.log('bar 5:', JSON.stringify({ bar: s.bar, row: s.row, inside: s.cursorInside, barText: s.barText }));
check(s.bar === 4, `seek to bar 5 landed on bar ${s.bar + 1}`);
check(s.row === 1, `window not on line 2 at bar 5 (row ${s.row})`);
check(s.cursorInside, 'cursor not inside the window at bar 5');
check(/^bar 5of \d+$/.test(s.barText), `the header says "${s.barText}" at bar 5`);

// 4. Space pauses: this is where play stopped, which Home comes back to.
await page.keyboard.press('Space');
await page.waitForTimeout(300);
s = await snapshot();
check(s.state === 0 && s.mix.paused, 'second Space did not pause');
const stoppedBar = s.bar;

// 5. Arrows seek by a bar and a line, paused, and the window follows.
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
await page.screenshot({ path: out });

// 6. Tempo and faders.
await page.keyboard.press('BracketRight');
await page.keyboard.press('BracketRight');
await page.keyboard.press('BracketLeft');
await page.keyboard.press('Digit3');
await page.keyboard.press('Digit1');
await page.waitForTimeout(200);
s = await snapshot();
console.log('keys:', JSON.stringify({ speed: s.speed, rate: s.mix.rate, faders: s.faders }));
check(s.speed === '105' && Math.abs(s.mix.rate - 1.05) < 1e-6, `brackets left the tempo at ${s.speed}% / rate ${s.mix.rate}`);
check(!s.muted.click, 'Digit3 did not unmute the click (muted by default)');
check(s.muted.nodrums && s.faders.nodrums === '100', `Digit1 left the band ${JSON.stringify({ muted: s.muted.nodrums, level: s.faders.nodrums })}, not muted at its level`);
await page.keyboard.press('Digit1');
await page.keyboard.press('Digit3');
await page.keyboard.press('BracketLeft');
await page.waitForTimeout(200);
s = await snapshot();
check(!s.muted.nodrums && s.muted.click && s.speed === '100', `toggling back left ${JSON.stringify(s.muted)} at ${s.speed}%`);

// 7. Home: browse away, Home comes back to where play stopped; again, the top.
await barAfter('ArrowDown');
s = await barAfter('ArrowDown');
check(s.bar >= 12, `two ArrowDowns only browsed to bar ${s.bar + 1}`);
await page.keyboard.press('Home');
await page.waitForTimeout(500);
s = await snapshot();
console.log('home once:', JSON.stringify({ bar: s.bar, row: s.row, stoppedBar }));
check(s.bar === stoppedBar && s.row === 1 && s.mix.paused, `Home went to bar ${s.bar + 1} row ${s.row}, not back to bar ${stoppedBar + 1} where play stopped`);
await page.keyboard.press('Home');
await page.waitForTimeout(500);
s = await snapshot();
console.log('home twice:', JSON.stringify({ mix: s.mix, row: s.row }));
check(s.mix.paused && s.mix.time === 0, `Home again left the clock at ${s.mix.time}s paused=${s.mix.paused}`);
check(s.row === 0, `Home again left the window on row ${s.row}`);

// 8. V hides the video: the compact header (Lamp-02), three lines, and the
// paper exactly as wide as it was -- not one re-engrave.
await page.evaluate(() => window.drums.seekToBar(4));
await page.waitForTimeout(400);
const withVideo = await snapshot();
await page.keyboard.press('KeyV');
await page.waitForTimeout(600);
s = await snapshot();
console.log('video hidden:', JSON.stringify({ head: s.head, lines: s.lines, tabs: s.tabs, box: s.box, renders: s.renders, was: withVideo.renders, right: s.headRight }));
check(s.head === 'compact' && !s.video, `V left the ${s.head} header, video ${JSON.stringify(s.video)}`);
const noKitCompact = await kitLayer();
check(
  !noKitCompact.chip && !noKitCompact.record && !noKitCompact.card,
  `with no kit the compact header shows the kit layer: ${JSON.stringify(noKitCompact)}`
);
check(s.lines === 3 && s.box.h > withVideo.box.h + 150, `V left ${s.lines} lines in a ${s.box.h}px window (was ${withVideo.box.h}px)`);
check(s.tabs.w === withVideo.tabs.w && s.tabs.x === withVideo.tabs.x, `V moved the paper's width: ${withVideo.tabs.w} -> ${s.tabs.w}`);
check(s.renders === withVideo.renders, `V re-engraved the score (${withVideo.renders} -> ${s.renders} renders)`);
check(s.row === 1 && s.cursorInside, `with the video hidden the window is on row ${s.row}, cursor inside ${s.cursorInside}`);
check(s.headRight <= W - 40 + 1, `the compact header runs to ${s.headRight}px`);
check(s.tabs.y + s.tabs.h <= H, 'the paper runs off the bottom with the video hidden');
check((await page.evaluate(() => localStorage.getItem('video'))) === 'hidden', 'the hidden video was not remembered');
check(s.gear && s.songsIcon && s.gear.x + s.gear.w <= W - 40 + 1, `the corner icons in the compact header: ${JSON.stringify({ gear: s.gear, songs: s.songsIcon })}`);
await page.keyboard.press('KeyM');
await page.waitForTimeout(300);
s = await snapshot();
console.log('compact mix:', JSON.stringify({ panel: s.panel, pill: s.mixPill }));
check(s.mixOpen && s.mixPill && s.panel && s.mixPill.x + s.mixPill.w <= s.panel.x, `in the compact header the Mix panel ${JSON.stringify(s.panel)} covers the Mix pill ${JSON.stringify(s.mixPill)}`);
check(s.renders === withVideo.renders, 'opening the mix in the compact header re-engraved the score');
await page.keyboard.press('KeyM');
await page.waitForTimeout(200);
await page.keyboard.press('KeyV');
await page.waitForTimeout(600);
s = await snapshot();
check(s.head === 'full' && s.lines === 2 && s.renders === withVideo.renders, `V again left the ${s.head} header with ${s.lines} lines`);

// 9. Sticking: R and L under the notation, off until the switch (on the
// Settings page) turns them on. Left on for the size and three-line checks
// below, which measure the letters; the remembered "on" is wiped at the end.
// A song with no sticking.lock.json has none.
const hasSticking = await page.evaluate(() => window.drums.sticking.count > 0);
s = await snapshot();
check(s.sticking === 0, `${s.sticking} sticking letters are up before the switch is on`);
if (hasSticking) {
  await page.locator('#settings-btn').click();
  await page.check('#sticking');
  await page.waitForTimeout(200);
  s = await snapshot();
  check(s.sticking > 0, 'sticking.lock.json is loaded but checking Sticking drew no letters');
  await page.uncheck('#sticking');
  await page.waitForTimeout(200);
  check((await snapshot()).sticking === 0, 'unchecking Sticking left the letters up');
  await page.check('#sticking');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
}
console.log('sticking:', hasSticking ? `${s.sticking} letters` : 'none for this song');

// 10. The Mix panel (M, Lamp-08): over the header's right side -- 960 wide at
// the right margin, top 20 -- never moving the paper; Esc, M, Done close it.
// Then Settings (the gear, Lamp-10): the whole window, playing or not, and
// Done or Esc closes it.
s = await snapshot();
const beforeMix = s;
await page.keyboard.press('KeyM');
await page.waitForTimeout(300);
s = await snapshot();
console.log('mix:', JSON.stringify({ panel: s.panel, pill: s.mixPill }));
check(s.mixOpen, 'M did not open the mix');
check(s.panel && s.panel.x === W - 40 - 960 && s.panel.y === 20 && s.panel.w === 960, `the Mix panel is ${JSON.stringify(s.panel)}, not 960 wide at ${W - 1000},20`);
check(s.mixPill && s.mixPill.x + s.mixPill.w <= s.panel.x, 'the Mix panel covers the Mix pill');
check(s.tabs.w === beforeMix.tabs.w && s.tabs.y === beforeMix.tabs.y && s.renders === beforeMix.renders, 'opening the mix moved the paper');
const rows = await page.evaluate(() =>
  [...document.querySelectorAll('#mix-panel .mix-row:not([hidden])')].map((r) => ({
    name: r.querySelector('.mix-name').textContent,
    mute: Math.round(r.querySelector('.mute').getBoundingClientRect().height),
    key: r.querySelector('.mute kbd').textContent,
  }))
);
check(
  rows.map((r) => r.name).join(',') === 'Band,Drums,Click,Kit' && rows.every((r, i) => r.mute === 76 && r.key === String(i + 1)),
  `the mix rows are ${JSON.stringify(rows)}`
);
await page.locator('#mute-drums').click();
s = await snapshot();
check(s.muted.drums && s.faders.drums === '100', 'the Drums pill did not mute it at its level');
check((await page.locator('#mute-drums span').textContent()) === 'Muted', 'a muted row does not say Muted');
await page.locator('#mute-drums').click();
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check(!(await snapshot()).mixOpen, 'Esc did not close the mix');
await page.locator('#mix-btn').click();
check((await snapshot()).mixOpen, 'the Mix pill did not open the mix');
await page.locator('#mix-done').click();
check(!(await snapshot()).mixOpen, 'Done did not close the mix');

// Past the bar of count-in from a pause, so the song is really playing.
await page.keyboard.press('Space');
await page.waitForFunction(() => !window.drums.mix.paused, null, { timeout: 10000 });
await page.waitForTimeout(500);
await page.locator('#settings-btn').click();
await page.waitForTimeout(300);
const set = await page.evaluate(() => {
  const r = document.getElementById('settings').getBoundingClientRect();
  return {
    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    playing: !window.drums.mix.paused,
    heads: [...document.querySelectorAll('#settings h2')].map((h) => h.textContent),
    keys: [...document.querySelectorAll('#settings .keys dt')].map((d) => d.textContent),
  };
});
console.log('settings:', JSON.stringify(set));
check(set.rect.join() === `0,0,${W},${H}`, `Settings covers ${set.rect}, not the whole window`);
check(set.playing, 'opening Settings stopped the song');
check(['Notation', 'Look', 'Loop', 'Kit', 'Keys'].every((h) => set.heads.includes(h)), `Settings has ${set.heads}`);
check(set.keys.includes('M') && set.keys.includes('1 2 3 4'), `the keys list is ${set.keys}`);
check(!set.heads.includes('Record'), 'Settings still has the temporary Record section');
await page.keyboard.press('KeyM');
check(!(await snapshot()).mixOpen, 'M opened the mix under Settings');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check(!(await snapshot()).settings, 'Esc did not close Settings');
await page.locator('#settings-btn').click();
await page.locator('#settings-done').click();
check(!(await snapshot()).settings, 'Done did not close Settings');
await page.keyboard.press('Space');
await page.waitForTimeout(300);

// 11. Themes. The interface is dark and the paper cream unless told; each
// switch moves its own and only its own, and the paper's re-engraves the ink.
await page.evaluate(() => window.drums.seekToBar(4));
await page.waitForTimeout(400);
s = await snapshot();
const themes0 = await page.evaluate(() => ({ ...document.documentElement.dataset }));
check(!themes0.theme && !themes0.tabTheme, `not at the default themes to start: ${JSON.stringify(themes0)}`);
check(s.ink.toUpperCase() === '#211B14', `cream paper engraved in ${s.ink}, not --tab-ink #211b14`);
const paper = await page.evaluate(() => {
  document.querySelector('#tab-theme [data-value="dark"]').click();
  const d = document.documentElement.dataset;
  return { ui: d.theme ?? 'dark', tabs: d.tabTheme };
});
await page.waitForTimeout(1500);
s = await snapshot();
check(paper.tabs === 'dark' && paper.ui === 'dark', `the paper switch left ${JSON.stringify(paper)}`);
check(s.ink.toUpperCase() === '#ECE2CF', `dark paper engraved in ${s.ink}, not --tab-ink #ece2cf`);
check(s.row === 1 && s.cursorInside, `after the paper re-render the window is on row ${s.row}, cursor inside ${s.cursorInside}`);
await page.screenshot({ path: out.replace(/\.png$/, '-dark-paper.png') });
const ui = await page.evaluate(() => {
  document.querySelector('#tab-theme [data-value="light"]').click();
  document.querySelector('#theme [data-value="light"]').click();
  const d = document.documentElement.dataset;
  return { ui: d.theme, tabs: d.tabTheme ?? 'light', bg: getComputedStyle(document.body).backgroundColor };
});
await page.waitForTimeout(1500);
check(ui.ui === 'light' && ui.tabs === 'light' && ui.bg === 'rgb(239, 232, 219)', `the interface switch left ${JSON.stringify(ui)}`);
await page.screenshot({ path: out.replace(/\.png$/, '-light.png') });
await page.evaluate(() => document.querySelector('#theme [data-value="dark"]').click());

// 12. Zen: the picture over the paper, nothing else (Lamp-11), the paper as
// wide as ever. Headless Chromium does not do real fullscreen, so this checks
// the half the page owns and leaves through the shortcut.
await page.evaluate(() => window.drums.seekToBar(4));
await page.waitForTimeout(400);
const beforeZen = await snapshot();
await page.keyboard.press('KeyZ');
await page.waitForTimeout(1500);
const z = await page.evaluate(() => {
  const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
  const el = document.getElementById('status');
  el.classList.add('err');
  const errShown = getComputedStyle(el).display !== 'none' || el.textContent === '';
  el.classList.remove('err');
  const r = (id) => {
    const b = document.getElementById(id).getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  };
  return {
    controls: shown('controls'),
    tempo: shown('tempo'),
    map: shown('map'),
    title: shown('title'),
    errShown,
    bg: getComputedStyle(document.body).backgroundColor,
    picture: r('video'),
    paper: r('tabs'),
    hasVideo: window.drums.current.video,
  };
});
s = await snapshot();
console.log('zen:', JSON.stringify({ ...z, tabs: s.tabs, video: s.video }));
check(z.bg === 'rgb(15, 13, 10)', `zen's ground is ${z.bg}, not Lamp-11's #0f0d0a`);
check(!z.title, 'zen left the title up');
if (z.hasVideo) {
  check(
    z.picture.w === 718 && z.picture.h === 404 && z.picture.y === 24 && Math.abs(z.picture.x + 359 - W / 2) <= 1,
    `zen's picture is ${JSON.stringify(z.picture)}, not 718x404 centred at the top`
  );
  check(z.paper.y === 452, `zen's paper starts at ${z.paper.y}, not 452`);
} else {
  check(z.paper.y === 24, `zen without a picture starts the paper at ${z.paper.y}, not 24`);
}
check(s.zen, 'Z did not turn zen on');
check(!z.controls && !z.tempo && !z.map, `zen left the chrome up: ${JSON.stringify(z)}`);
check(s.tabs.w === beforeZen.tabs.w, `zen changed the paper's width (${beforeZen.tabs.w} -> ${s.tabs.w})`);
check(z.errShown, 'zen hides the status line even when it is an error');
await page.screenshot({ path: out.replace(/\.png$/, '-zen.png') });
await page.keyboard.press('KeyZ');
await page.waitForTimeout(1500);
s = await snapshot();
check(!s.zen, 'Z did not turn zen off');
check(s.row === 1 && s.cursorInside, `after leaving zen the window is on row ${s.row}, cursor inside ${s.cursorInside}`);

// 12b. Browsing while paused (Lamp-06): the wheel turns the paper away from
// the cursor's line, and the page says so -- the bars on show and where play
// goes on from in the pass block's place, Back to bar N, a dashed edge on the
// paper and a dashed box on the map, " · paused" after the title, the
// picture dimmed. The Back pill, or Home, brings it back.
const browse = () =>
  page.evaluate(() => {
    const vis = (id) => {
      const el = document.getElementById(id);
      return !el.hidden && getComputedStyle(el).display !== 'none';
    };
    const view = document.querySelector('#map .map-view');
    return {
      on: document.getElementById('app').dataset.browsing ?? '',
      row: window.drums.scoreWindow.row,
      bars: window.drums.scoreWindow.bars,
      main: document.getElementById('browse-bars').textContent,
      sub: document.getElementById('browse-sub').textContent,
      browseShown: vis('browse'),
      passShown: vis('pass'),
      back: vis('back-btn') ? document.getElementById('back-btn').textContent.replace(/\s+/g, ' ').trim() : '',
      title: document.getElementById('title').textContent,
      outline: getComputedStyle(document.getElementById('tabs'), '::after').borderTopStyle,
      view: view ? Math.round(view.getBoundingClientRect().width) : 0,
      opacity: getComputedStyle(document.getElementById('video')).opacity,
    };
  });
{
  await page.mouse.move(W / 2, 800);
  for (let i = 0; i < 2; i++) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(300);
  const b = await browse();
  console.log('browsing:', JSON.stringify(b));
  const shown = `bars ${b.bars[0] + 1}–${b.bars[1] + 1}`;
  check(b.on === 'ahead' && b.row === 3, `two wheel notches down left browsing ${JSON.stringify(b.on)} on row ${b.row}`);
  check(b.main === shown && b.sub === 'looking ahead; play goes on from bar 5', `the pass block says ${b.main} / ${b.sub}`);
  check(b.browseShown && !b.passShown, 'the browse block is not in the pass block\'s place');
  check(b.back === 'Back to bar 5Home' || b.back === 'Back to bar 5 Home', `the Back pill says ${JSON.stringify(b.back)}`);
  check(/ · paused$/.test(b.title), `the title says ${JSON.stringify(b.title)}`);
  check(b.outline === 'dashed' && b.view > 0, `the paper's edge is ${b.outline}, the map's box ${b.view} px`);
  check(b.opacity === '0.6', `the picture is at ${b.opacity}`);
  await page.screenshot({ path: out.replace(/\.png$/, '-browsing.png') });
  await page.keyboard.press('Home');
  await page.waitForTimeout(300);
  let back = await browse();
  check(!back.on && back.row === 1 && !back.title.includes('paused'), `Home left browsing ${back.on} on row ${back.row}`);
  // Looking back, then the pill.
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(300);
  back = await browse();
  check(back.on === 'back' && /^looking back;/.test(back.sub), `a notch up says ${back.on}: ${back.sub}`);
  await page.locator('#back-btn').click();
  await page.waitForTimeout(300);
  back = await browse();
  check(!back.on && back.row === 1 && back.view === 0 && back.outline === 'none', `the Back pill left ${JSON.stringify(back)}`);
  s = await snapshot();
  check(s.bar === 4, `browsing moved the cursor: bar ${s.bar + 1}`);
}

// 12c. The count-in from a pause (Lamp-05): where you are gives way to what
// it leads into and 1 2 3 4 at 160 px, lit beat by beat; the picture dims.
{
  await page.evaluate(() => window.drums.seekToBar(4));
  await page.waitForTimeout(300);
  await page.keyboard.press('Space');
  const seen = [];
  for (let i = 0; i < 40 && seen.length < 4; i++) {
    const c = await page.evaluate(() => ({
      on: document.getElementById('app').dataset.counting ?? '',
      now: document.querySelector('#count-beats [data-beat="now"]')?.textContent ?? '',
      done: [...document.querySelectorAll('#count-beats [data-beat="done"]')].map((n) => n.textContent).join(''),
      says: document.getElementById('count-says').textContent,
      size: parseFloat(getComputedStyle(document.getElementById('count-beats')).fontSize),
      where: getComputedStyle(document.getElementById('where')).visibility,
      opacity: getComputedStyle(document.getElementById('video')).opacity,
    }));
    if (c.on && c.now && !seen.some((x) => x.now === c.now)) seen.push(c);
    await page.waitForTimeout(60);
  }
  console.log('count-in:', JSON.stringify(seen));
  check(seen.map((c) => c.now).join(' ') === '1 2 3 4', `the count-in lit ${seen.map((c) => c.now).join(' ')}, not 1 2 3 4 in turn`);
  check(seen.every((c, i) => c.done === '1234'.slice(0, i)), `the beats before the one sounding are not all marked done: ${seen.map((c) => c.done)}`);
  const first = seen[0] ?? {};
  check(/^count-in · then .*bar 5$/.test(first.says ?? ''), `the count-in says ${JSON.stringify(first.says)}`);
  check(first.size === 160 && first.where === 'hidden', `the numbers are ${first.size} px, where you are ${first.where}`);
  check(first.opacity === '0.45', `the picture is at ${first.opacity} through the count-in`);
  await page.waitForFunction(() => !document.getElementById('app').dataset.counting, null, { timeout: 5000 });
  check(await page.evaluate(() => !window.drums.mix.paused), 'the music did not come in after the count-in');
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
}

// 13. Size: the default is the spec's 2.25 (20.25 px between staff lines) and
// the sticking letters 25 px with it. + makes the notes bigger and the window
// grows to hold its lines; - comes back; the rung is remembered.
await page.evaluate(() => window.drums.seekToBar(4));
await page.waitForTimeout(400);
const home = await snapshot();
check(
  home.layout.scale === 2.25 && home.layout.bars === 4 && home.layout.gap === 12,
  `not at the layout defaults to start: ${JSON.stringify(home.layout)}`
);
check(home.knobs.zoom.out === '20.25 px', `the Size fader reads ${home.knobs.zoom.out}, not 20.25 px`);
if (hasSticking) check(Math.abs(home.letterPx - 24.75) < 0.1, `the sticking letters are ${home.letterPx}px, not ~25`);
await page.keyboard.press('Equal');
await page.waitForTimeout(1500);
s = await snapshot();
console.log('size up:', JSON.stringify({ layout: s.layout, knobs: s.knobs.zoom, box: s.box.h, letterPx: s.letterPx, was: { box: home.box.h, letterPx: home.letterPx } }));
check(s.layout.scale === 2.5, `+ left the notation at ${s.layout.scale}x`);
check(s.layout.bars === 4, `+ moved the line to ${s.layout.bars} bars`);
check(s.knobs.zoom.out === '22.5 px', `the Size fader reads ${s.knobs.zoom.out} at ${s.layout.scale}x`);
check(s.tabs.w === home.tabs.w, 'sizing up changed the paper width');
check(s.cursorInside, 'cursor not inside the window after sizing up');
if (hasSticking) check(s.letterPx > home.letterPx, `the sticking letters stayed ${s.letterPx}px through the size change`);
await page.screenshot({ path: out.replace(/\.png$/, '-zoom.png') });
await page.keyboard.press('Minus');
await page.waitForTimeout(1500);
s = await snapshot();
check(s.layout.scale === 2.25 && s.layout.bars === 4, `- did not come back to 2.25/4 bars: ${JSON.stringify(s.layout)}`);
await page.keyboard.press('Minus');
await page.keyboard.press('Minus');
await page.waitForTimeout(1500);
s = await snapshot();
check(s.layout.scale === 1.75, `two - left the notation at ${s.layout.scale}x`);
const remembered = await page.evaluate(() => localStorage.getItem('notationSize'));
check(remembered === String(s.layout.scale), `the size remembered ${remembered}, but is engraving at ${s.layout.scale}x`);

// 14. The other two layout knobs, the gap dragged the way a mouse drags one --
// `input` moves the number, `change` re-engraves.
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

/** Bars a line is a stepper: press − or + until it says `n`. */
const bars = async (n) => {
  await page.evaluate((n) => {
    for (let i = 0; i < 10; i++) {
      const now = Number(document.getElementById('bars-out').textContent);
      if (now === n) break;
      document.getElementById(now < n ? 'bars-more' : 'bars-less').click();
    }
  }, n);
  await page.waitForTimeout(2000);
  return snapshot();
};
s = await bars(8);
console.log('bars 8:', JSON.stringify({ layout: s.layout, out: s.knobs.bars.out, barsOnRow0: s.barsOnRow0, overflowX: s.overflowX }));
check(s.layout.bars === 8 && s.knobs.bars.out === '8', `the Bars fader asked for 8 and alphaTab has ${s.layout.bars}`);
check(s.barsOnRow0 === 8, `asked for 8 bars a line and the first row holds ${s.barsOnRow0}`);
check(s.overflowX <= 2, `8 bars a line runs ${s.overflowX}px off the side of the paper`);
await page.screenshot({ path: out.replace(/\.png$/, '-dense.png') });
s = await bars(2);
check(s.layout.bars === 2 && s.barsOnRow0 === 2, `asked for 2 bars a line and got ${s.layout.bars}/${s.barsOnRow0}`);
await page.screenshot({ path: out.replace(/\.png$/, '-loose.png') });
s = await drag('gap', 48);
check(s.layout.gap === 48 && s.knobs.gap.out === '108 px', `the Gap knob: ${s.layout.gap} / ${s.knobs.gap.out}, not 108 px on the screen`);
check(s.cursorInside, 'cursor not inside the window after the line gap widened');
const kept = await page.evaluate(() => ({
  bars: localStorage.getItem('bars'),
  gap: localStorage.getItem('lineGap'),
}));
check(kept.bars === '2' && kept.gap === '48', `the layout knobs remembered ${JSON.stringify(kept)}`);
await page.keyboard.press('Digit0');
await page.waitForTimeout(1500);
s = await snapshot();
check(
  s.layout.scale === 2.25 && s.layout.bars === 4 && s.layout.gap === 12,
  `0 did not put the layout back: ${JSON.stringify(s.layout)}`
);
check(Math.abs(s.box.h - home.box.h) <= 2, `0 left the window at ${s.box.h}px (was ${home.box.h}px)`);

// 15. The library (Lamp-09): the Songs icon goes there, a row a song with its
// names and facts, the one played last outlined; ↓ and Enter open another
// song on its own route, so a reload (every Ctrl+S in Live) lands on it; Esc
// goes back. The header's title is "Title — Artist", not a picker.
const picker = async () =>
  page.evaluate(() => ({
    hash: decodeURIComponent(location.hash.slice(1)),
    slugs: window.drums.songs.map((s) => s.slug),
  }));
const lib = () =>
  page.evaluate(() => {
    const el = document.getElementById('library');
    const rows = [...el.querySelectorAll('.lib-row')];
    return {
      shown: !el.hidden,
      ready: document.documentElement.dataset.ready ?? '',
      title: document.getElementById('title').textContent,
      hash: decodeURIComponent(location.hash.slice(1)),
      focused: document.activeElement?.dataset?.slug ?? '',
      rows: rows.map((r) => {
        const box = r.getBoundingClientRect();
        return {
          slug: r.dataset.slug,
          name: r.querySelector('.lib-name').textContent,
          facts: r.querySelector('.lib-facts').textContent,
          left: r.querySelector('.lib-left').textContent,
          go: r.querySelector('.lib-go').textContent,
          last: r.hasAttribute('data-last'),
          picture: r.querySelector('.lib-pic canvas') ? 'frame' : r.querySelector('.lib-pic.none') ? 'none' : 'waiting',
          h: Math.round(box.height),
        };
      }),
    };
  });
{
  let h = await picker();
  const from = h.hash;
  const song = await page.evaluate(() => {
    const d = window.drums;
    const s = d.songs.find((x) => x.slug === d.current.slug);
    return { title: s.title, artist: s.artist };
  });
  let L = await lib();
  check(L.title === `${song.title} — ${song.artist}`, `the header's title is ${JSON.stringify(L.title)}, not "Title — Artist"`);
  check(!(await page.$('#song')), 'the title is still a select');
  await page.locator('#songs-btn').click();
  await page.waitForFunction(() => !document.getElementById('library').hidden);
  // The pictures are frames grabbed from the videos: give them a moment.
  await page.waitForFunction(
    () => [...document.querySelectorAll('.lib-pic')].every((p) => p.querySelector('canvas') || p.classList.contains('none')),
    null,
    { timeout: 15000 }
  ).catch(() => {});
  L = await lib();
  console.log('library:', JSON.stringify(L));
  check(L.shown && L.hash === '/songs', `the Songs icon went to ${JSON.stringify(L.hash)}, the library ${L.shown ? 'shown' : 'hidden'}`);
  check(L.rows.length === h.slugs.length && L.rows.length >= 3, `the library has ${L.rows.length} rows for ${h.slugs.length} songs`);
  check(!L.rows.some((r) => r.slug === 'windhorse'), 'Windhorse (no song.toml) is in the library');
  check(L.rows.every((r) => r.h === 200), `rows are not 200 tall: ${L.rows.map((r) => r.h)}`);
  const song2 = L.rows.find((r) => r.slug === 'blur-song-2-official-music-video');
  check(song2?.name === 'Blur — Song 2', `Song 2's row says ${song2?.name}`);
  check(song2?.facts === '2:03 · 130 BPM · 65 bars · video', `Song 2's facts: ${song2?.facts}`);
  check(song2?.picture === 'frame', `Song 2's picture is ${song2?.picture}, not a frame from its video`);
  const killme = L.rows.find((r) => r.slug === 'hayley-williams-kill-me-official-visualizer');
  check(killme?.picture === 'none' && !/video$/.test(killme.facts), `Kill Me (no video) has picture ${killme?.picture}, facts ${killme?.facts}`);
  // This check has been playing `from`: it is the song played last.
  const lasts = L.rows.filter((r) => r.last).map((r) => r.slug);
  check(lasts.length === 1 && lasts[0] === from, `the outlined row is ${lasts}, not ${from}, the one just played`);
  const fromRow = L.rows.find((r) => r.slug === from);
  check(fromRow?.go === 'Resume' && /where you left off/.test(fromRow.left), `the song played says ${JSON.stringify(fromRow)}`);
  check(L.focused === from, `the library opened on ${L.focused}, not the song it came from`);
  // Nothing plays under it, and the player's keys are off.
  const quiet = await page.evaluate(() => window.drums.mix.paused);
  check(quiet, 'the song still plays under the library');
  await page.screenshot({ path: out.replace(/\.png$/, '-library.png') });
  // ↓ (wrapping at neither end) and Enter: another song, on its own route.
  const at = L.rows.findIndex((r) => r.slug === from);
  const other = L.rows[at + 1 < L.rows.length ? at + 1 : at - 1].slug;
  await page.keyboard.press(at + 1 < L.rows.length ? 'ArrowDown' : 'ArrowUp');
  check((await lib()).focused === other, `the arrow did not move to ${other}`);
  await page.keyboard.press('Enter');
  await waitForPlayer(page, other);
  await page.waitForTimeout(1500);
  h = await picker();
  L = await lib();
  check(h.hash === other && !L.shown, `Enter went to ${h.hash} (library ${L.shown ? 'shown' : 'hidden'}), not ${other}`);
  s = await snapshot();
  const noVideo = await page.evaluate(() => !window.drums.current.video);
  check(!noVideo || (s.head === 'compact' && s.lines === 3), `a song with no video has the ${s.head} header and ${s.lines} lines`);
  // And Esc from the library goes back to the song it was opened from.
  await page.locator('#songs-btn').click();
  await page.waitForFunction(() => !document.getElementById('library').hidden);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('library').hidden);
  check((await picker()).hash === other, 'Esc did not go back to the song');
  await page.evaluate((slug) => (location.hash = encodeURIComponent(slug)), from);
  await waitForPlayer(page, from);
  await page.waitForTimeout(1500);
  check((await picker()).hash === from, 'the route did not come back to the first song');
  // No hash at all is the library too: the home page.
  await page.goto('http://localhost:5173/');
  await page.waitForFunction(() => !document.getElementById('library').hidden && document.querySelector('.lib-row'));
  L = await lib();
  check(L.shown && L.ready === '', `with no hash the page is the library (${L.shown}), and no song loads (${L.ready})`);
  await page.goto(`http://localhost:5173/#${encodeURIComponent(from)}`);
  await waitForPlayer(page, from);
  await page.waitForFunction(() => window.drums.mix.readyState >= 1, null, { timeout: 30000 });
  await page.waitForTimeout(1000);
}

// 16. The song map: a block per section, and a click on one goes to its
// first bar. The Loop pill opens it as the picker -- 164 tall, laid over the
// paper, which does not move -- and there a click loops a section,
// shift-click stretches the loop, a click inside it clears it, a drag across
// the bar marks picks bars, and a handle moves an end a bar at a time.
const mapInfo = () =>
  page.evaluate(() => {
    const d = window.drums;
    const m = document.getElementById('map');
    const body = m.querySelector('.map-body').getBoundingClientRect();
    return {
      blocks: m.querySelectorAll('.map-block').length,
      names: [...m.querySelectorAll('.map-block')].map((b) => b.getAttribute('aria-label')),
      sections: d.songs.find((x) => x.slug === d.current.slug).sections,
      body: { x: body.x, y: body.y, w: body.width, h: Math.round(body.height) },
      slotH: Math.round(m.getBoundingClientRect().height),
      picking: m.hasAttribute('data-picking'),
      ticks: m.querySelectorAll('.map-tick').length,
      bars: d.current.bars,
      handles: m.querySelectorAll('.map-handle').length,
      line: m.querySelector('.map-line').textContent,
      armed: d.loop.armed,
      range: d.loop.armed ? `${d.loop.range.startBar}-${d.loop.range.endBar}` : '',
      expanded: document.getElementById('loop').getAttribute('aria-expanded'),
    };
  });
await page.evaluate(() => window.drums.seekToBar(0));
await page.waitForTimeout(500);
let m = await mapInfo();
const secs = m.sections;
check(m.blocks === secs.length && m.slotH === 80 && m.body.h === 80, `the map has ${m.blocks} blocks for ${secs.length} sections, ${m.slotH}/${m.body.h} tall`);
const jumpTo = secs[Math.min(2, secs.length - 1)];
await page.locator('#map .map-block').nth(Math.min(2, secs.length - 1)).click();
await page.waitForTimeout(500);
s = await snapshot();
check(s.bar === jumpTo.start_bar - 1 && !s.mixOpen, `a click on "${jumpTo.name}" went to bar ${s.bar + 1}, not ${jumpTo.start_bar}`);

const beforePick = await snapshot();
await page.locator('#loop').click();
await page.waitForTimeout(300);
m = await mapInfo();
s = await snapshot();
console.log('picker:', JSON.stringify({ body: m.body, ticks: m.ticks, line: m.line.slice(0, 60), tabs: s.tabs }));
check(m.picking && m.body.h === 164 && m.slotH === 80 && m.expanded === 'true', `the Loop pill left the map ${JSON.stringify({ picking: m.picking, h: m.body.h, slot: m.slotH })}`);
check(JSON.stringify(s.tabs) === JSON.stringify(beforePick.tabs) && s.renders === beforePick.renders, 'opening the picker moved the paper');
check(m.ticks === m.bars && !m.armed && /^Click a section to loop it/.test(m.line), `the picker opened with ${m.ticks} bar marks for ${m.bars} bars, armed ${m.armed}, saying "${m.line}"`);
await page.screenshot({ path: out.replace(/\.png$/, '-picker.png') });
const barX = (b) => m.body.x + ((b - 0.5) * m.body.w) / m.bars;
const stripY = m.body.y + 36 + 44;
const [s1, s2, s3] = [secs[1], secs[2], secs[3]];
if (s1 && s2 && s3) {
  await page.mouse.click(barX(s1.start_bar), stripY);
  await page.waitForTimeout(300);
  m = await mapInfo();
  check(m.armed && m.range === `${s1.start_bar}-${s1.end_bar}` && m.handles === 2, `a click on "${s1.name}" looped ${m.range}, ${m.handles} handles`);
  check(m.line.startsWith(`Loop: ${s1.name} · `), `the picker's line says "${m.line}"`);
  await page.keyboard.down('Shift');
  await page.mouse.click(barX(s3.start_bar), stripY);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
  m = await mapInfo();
  check(m.range === `${s1.start_bar}-${s3.end_bar}`, `shift-click on "${s3.name}" stretched the loop to ${m.range}`);
  await page.mouse.click(barX(s2.start_bar), stripY);
  await page.waitForTimeout(300);
  m = await mapInfo();
  check(!m.armed && m.handles === 0, `a click inside the loop left it ${m.range || 'off'}`);
}
// A drag across the bar marks: bars 5 to 8.
await page.mouse.move(barX(5), stripY);
await page.mouse.down();
await page.mouse.move(barX(6.5), stripY, { steps: 4 });
await page.mouse.move(barX(8), stripY, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(300);
m = await mapInfo();
check(m.range === '5-8', `a drag from bar 5 to bar 8 picked ${m.range}`);
// A handle: from the keyboard, then dragged.
const barBefore = (await snapshot()).bar;
await page.locator('#map .map-handle[data-end="end"]').focus();
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(300);
m = await mapInfo();
s = await snapshot();
check(m.range === '5-9' && s.bar === barBefore, `ArrowRight on the end handle left ${m.range}, and the cursor on bar ${s.bar + 1} (was ${barBefore + 1})`);
await page.evaluate(() => document.activeElement?.blur());
const hb = await page.locator('#map .map-handle[data-end="start"]').boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(barX(3), hb.y + hb.height / 2, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
m = await mapInfo();
check(m.range === '3-9', `dragging the start handle to bar 3 left ${m.range}`);

// The paper's layers: the names in the lane (and none of alphaTab's own),
// the bracket over the loop, the current bar's wash in place of alphaTab's.
const layer = await page.evaluate(() => {
  const d = window.drums;
  const names = new Set(d.songs.find((x) => x.slug === d.current.slug).sections.map((x) => x.name));
  const shown = (sel) => {
    const e = document.querySelector(sel);
    return !!e && !e.hidden && getComputedStyle(e).display !== 'none';
  };
  return {
    labels: [...document.querySelectorAll('.tab-labels span')].map((e) => e.textContent),
    engraved: [...document.querySelectorAll('#score svg text')].filter((t) => names.has(t.textContent)).length,
    bracket: document.querySelectorAll('.tab-bracket span').length,
    ticks: document.querySelectorAll('.tab-bracket span.start, .tab-bracket span.end').length,
    wash: shown('.tab-wash'),
    alphaTabBar: shown('.at-cursor-bar'),
    labelPx: parseFloat(getComputedStyle(document.querySelector('.tab-labels span') ?? document.body).fontSize),
  };
});
console.log('paper layers:', JSON.stringify({ ...layer, labels: layer.labels.length }));
check(layer.labels.length >= secs.filter((x) => x.name).length && layer.engraved === 0, `${layer.labels.length} names in the lane, ${layer.engraved} engraved by alphaTab`);
check(Math.abs(layer.labelPx - 31.5) < 1, `the names are ${layer.labelPx}px, not ~32`);
check(layer.bracket >= 1 && layer.ticks === 2, `the loop has ${layer.bracket} bracket pieces and ${layer.ticks} end ticks`);
check(layer.wash && !layer.alphaTabBar, `the current bar's wash shown ${layer.wash}, alphaTab's ${layer.alphaTabBar}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
m = await mapInfo();
check(!m.picking && m.body.h === 80 && m.expanded === 'false' && m.armed, 'Esc closed the picker and kept the loop');
await page.keyboard.press('KeyL');
await page.waitForTimeout(300);
check(!(await mapInfo()).armed, 'L did not turn the loop off');

// 17. Three lines that each start a section, in the compact header (Kill
// Me's bridge, build, into last chorus, last chorus): all three whole, and
// the label lane above each.
const KILLME = 'hayley-williams-kill-me-official-visualizer';
if ((await picker()).slugs.includes(KILLME)) {
  await page.evaluate((slug) => (location.hash = encodeURIComponent(slug)), KILLME);
  await waitForPlayer(page, KILLME);
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.drums.seekToBar(44));
  await page.waitForTimeout(800);
  const three = await page.evaluate(() => {
    const d = window.drums;
    const box = document.getElementById('score-box').getBoundingClientRect();
    const tabs = document.getElementById('tabs').getBoundingClientRect();
    const map = document.getElementById('map').getBoundingClientRect();
    const letters = [...document.querySelectorAll('.sticking span')].map((e) => e.getBoundingClientRect()).filter((r) => r.bottom > box.top && r.top < box.bottom);
    const labels = [...document.querySelectorAll('.tab-labels span')].map((e) => e.getBoundingClientRect()).filter((r) => r.bottom > box.top && r.top < box.bottom);
    return {
      head: document.getElementById('app').dataset.head,
      visible: d.scoreWindow.visible,
      row: d.scoreWindow.row,
      box: [Math.round(box.top), Math.round(box.height)],
      tabs: [Math.round(tabs.top), Math.round(tabs.height)],
      map: Math.round(map.top),
      lowest: Math.round(Math.max(...letters.map((r) => r.bottom))),
      cut: letters.filter((r) => r.bottom > box.bottom + 0.5).length,
      labels: labels.length,
    };
  });
  console.log('three lines:', JSON.stringify(three));
  check(three.head === 'compact' && three.visible === 3, `Kill Me at bar 45 shows ${three.visible} lines in the ${three.head} header`);
  check(three.labels >= 3, `only ${three.labels} section names over the three lines`);
  check(three.cut === 0 && three.box[0] + three.box[1] <= three.tabs[0] + three.tabs[1], `the third line is cut: ${three.cut} letters below the window, ${JSON.stringify(three)}`);
  check(three.map === 130 && three.tabs[0] === 220, `the compact map at ${three.map} and paper at ${three.tabs[0]}, not Lamp-03's 130 and 220`);
  await page.screenshot({ path: out.replace(/\.png$/, '-three.png') });
}

// 18. Come As You Are (2026-11-22): its ride is drawn as triangles; every bar
// of a full line is as wide as the same bar on any other line, give or take
// the room alphaTab keeps before a bar's first note (a crash's ledger line
// takes more: up to 17 px); and with the letters off, at the 108 px line gap
// the user plays at, the window still holds two lines where the second
// starts the chorus (bars 17-20 and 21-24) -- in the middle of the paper.
const CAYA = 'nirvana-come-as-you-are-official-music-video';
if ((await picker()).slugs.includes(CAYA)) {
  await page.evaluate(() => {
    const el = document.getElementById('sticking');
    el.checked = false;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await drag('gap', 48);
  await page.evaluate((slug) => (location.hash = encodeURIComponent(slug)), CAYA);
  await waitForPlayer(page, CAYA);
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.drums.seekToBar(16));
  await page.waitForTimeout(800);
  const caya = await page.evaluate(() => {
    const d = window.drums;
    const systems = d.api.boundsLookup.staffSystems;
    // Lines but the first (the time signature widens its first bar) and the
    // last (a short line keeps its natural width).
    const full = systems.slice(1, -1).filter((s) => s.bars.length === 4);
    const spread = (ws) => Math.round(Math.max(...ws) - Math.min(...ws));
    const box = document.getElementById('score-box').getBoundingClientRect();
    const tabs = document.getElementById('tabs').getBoundingClientRect();
    return {
      triangles: [...document.querySelectorAll('#score text')].filter((t) => t.textContent === '').length,
      firstBars: spread(full.map((s) => s.bars[0].realBounds.w)),
      otherBars: spread(full.flatMap((s) => s.bars.slice(1).map((b) => b.realBounds.w))),
      visible: d.scoreWindow.visible,
      bars: d.scoreWindow.bars,
      over: Math.round(box.top - tabs.top),
      under: Math.round(tabs.bottom - box.bottom),
    };
  });
  console.log('come as you are:', JSON.stringify(caya));
  check(caya.triangles > 100, `the ride is drawn with ${caya.triangles} triangles`);
  check(caya.firstBars <= 20 && caya.otherBars <= 20, `bar widths spread ${caya.firstBars}px (first of a line) and ${caya.otherBars}px (the rest)`);
  check(caya.visible === 2 && caya.bars?.[0] === 16 && caya.bars?.[1] === 23, `at a 108 px line gap the window shows ${caya.visible} lines, bars ${JSON.stringify(caya.bars)}`);
  check(Math.abs(caya.over - caya.under) <= 2, `the paper has ${caya.over}px over the notes and ${caya.under}px under them`);
  await page.screenshot({ path: out.replace(/\.png$/, '-caya.png') });
}

await page.evaluate(() => {
  for (const key of ['theme', 'tabTheme', 'sticking', 'notationSize', 'bars', 'lineGap', 'video'])
    localStorage.removeItem(key);
});

console.log(errors.length ? `page errors: ${errors.join('; ')}` : 'no page errors');
console.log(problems.length ? `PROBLEMS:\n  - ${problems.join('\n  - ')}` : 'all checks passed');
await browser.close();
process.exit(problems.length || errors.length ? 1 : 0);
