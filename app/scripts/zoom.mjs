// One-off high-DPI capture of one system, for eyeballing note placement.
//
// Usage: node scripts/zoom.mjs [out.png] [system index] [song slug]
// The slug goes in the URL hash, which is how the page selects a song.
import { chromium } from 'playwright';

const out = process.argv[2] ?? 'zoom.png';
const idx = Number(process.argv[3] ?? 0);
const slug = process.argv[4] ?? '';

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 4 });
await page.goto(`http://localhost:5173/${slug ? `#${encodeURIComponent(slug)}` : ''}`, {
  waitUntil: 'networkidle',
});
await page.waitForTimeout(3000);
const status = (await page.locator('#status').textContent())?.trim();
await page.locator('#score svg').nth(idx).screenshot({ path: out });
await browser.close();
console.log(`wrote ${out} (${status})`);
