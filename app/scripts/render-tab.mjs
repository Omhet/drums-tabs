// Engrave a song's tab.mid for the strip under a cover video (cover-tab.html)
// and save the picture plus where every beat landed on it.
//
//   node scripts/render-tab.mjs --song <slug> --layout scroll|flip \
//        --scale 1.4 --width 1920 [--bars-per-row 4] --out <dir>
//
// Writes into <dir>:
//   tab.json         the page's `coverTab`: beats (tick, bar, x, row), bars,
//                    row boxes, image size; plus `tiles`
//   tile-<n>.png     the picture, cut into vertical slices left to right (a
//                    whole song on one line is far wider than one screenshot
//                    can be); pipeline/cover_strip.py glues them back together
//
// Needs vite on http://localhost:5173 (pipeline/cover_strip.py starts it).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch } from './browser.mjs';

function args() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) out[a[i].replace(/^--/, '')] = a[i + 1];
  return out;
}

const opt = args();
const song = opt.song;
const layout = opt.layout === 'flip' ? 'flip' : 'scroll';
const scale = Number(opt.scale ?? 1);
const width = Number(opt.width ?? 1920);
const barsPerRow = Number(opt['bars-per-row'] ?? 4);
const outDir = resolve(opt.out ?? '.');
const base = opt.base ?? 'http://localhost:5173/';
if (!song) {
  console.error('--song is required');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const TILE = 4000;
// Greyscale antialiasing: LCD subpixel text leaves coloured fringes on the
// noteheads, which show once the strip is scaled into a video.
const browser = await launch({ args: ['--disable-lcd-text'] });
try {
  const page = await browser.newPage({ viewport: { width: Math.max(width, 800), height: 800 } });
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('page:', m.text());
  });
  const params = new URLSearchParams({ song, layout, scale: String(scale), width: String(width), barsPerRow: String(barsPerRow) });
  await page.goto(`${base}cover-tab.html?${params}`);
  await page.waitForFunction(() => window.coverTab, null, { timeout: 90000 });
  // Fonts settle after the first paint; give the last glyphs a frame.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const tab = await page.evaluate(() => window.coverTab);

  const tiles = [];
  for (let x = 0, n = 0; x < tab.width; x += TILE, n++) {
    const w = Math.min(TILE, tab.width - x);
    await page.setViewportSize({ width: w, height: tab.height });
    await page.evaluate((x) => window.scrollTo(x, 0), x);
    const sx = await page.evaluate(() => window.scrollX);
    if (Math.abs(sx - x) > 0.5) throw new Error(`could not scroll to ${x} (at ${sx})`);
    const name = `tile-${n}.png`;
    await page.screenshot({ path: join(outDir, name), clip: { x: 0, y: 0, width: w, height: tab.height } });
    tiles.push({ file: name, x, w, h: tab.height });
  }
  writeFileSync(join(outDir, 'tab.json'), JSON.stringify({ song, ...tab, tiles }, null, 1));
  console.log(`${layout}: ${tab.width}x${tab.height}, ${tab.rows.length} rows, ${tab.bars.length} bars, ${tab.beats.length} beats, ${tiles.length} tiles -> ${outDir}`);
} finally {
  await browser.close();
}
