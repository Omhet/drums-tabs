// Drive the player headless: press Space, look at the cursor and the chrome.
import { chromium } from 'playwright';
const out = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:5173/');
await page.waitForFunction(() => /player loaded/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
await page.keyboard.press('Space');
await page.waitForTimeout(2500);
const info = await page.evaluate(() => {
  const d = window.drums;
  const beat = document.querySelector('.at-cursor-beat');
  const r = beat?.getBoundingClientRect();
  const texts = [...document.querySelectorAll('#score text')];
  return {
    state: d.api.playerState, position: d.api.tickPosition,
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
console.log('after 2nd space: state', await page.evaluate(() => window.drums.api.playerState));
await browser.close();
