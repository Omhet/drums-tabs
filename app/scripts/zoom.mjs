// One-off high-DPI capture of the first system, for eyeballing note placement.
import { chromium } from 'playwright';

const out = process.argv[2] ?? 'zoom.png';
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 4 });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
const idx = Number(process.argv[3] ?? 0);
await page.locator('#score svg').nth(idx).screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
