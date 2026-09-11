// Drive the player headless: press Space, look at the cursor and the chrome.
import { launch, waitForPlayer } from './browser.mjs';
const out = process.argv[2];
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:5173/');
await waitForPlayer(page);
await page.keyboard.press('Space');
// Long enough to get through the count-in, so the cursor has left bar 1.
await page.waitForTimeout(4500);
const info = await page.evaluate(() => {
  const d = window.drums;
  const beat = document.querySelector('.at-cursor-beat');
  const r = beat?.getBoundingClientRect();
  const texts = [...document.querySelectorAll('#score text')];
  return {
    state: d.api.playerState, position: d.api.tickPosition,
    video: { time: Math.round(d.video.currentTime * 1000) / 1000, paused: d.video.paused, rate: d.video.playbackRate },
    cursor: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    drumsLabel: texts.some((t) => t.textContent === 'Drums'),
    clefsVisible: texts.filter((t) => t.textContent === '\uE069' && t.style.display !== 'none').length,
    clefsHidden: texts.filter((t) => t.textContent === '\uE069' && t.style.display === 'none').length,
  };
});
console.log(JSON.stringify(info), errors.length ? errors : 'no page errors');
await page.screenshot({ path: out });
await page.keyboard.press('Space');
await page.waitForTimeout(300);
console.log('after 2nd space:', await page.evaluate(() => ({ state: window.drums.api.playerState, videoPaused: window.drums.video.paused })));
await browser.close();
