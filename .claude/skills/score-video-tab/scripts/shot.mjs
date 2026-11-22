// Screenshot a song in the player at the throne's size (2194x1100), with
// given lines of the score on top, and say whether the page complained.
// Needs the dev server on 5173 (leave it running: the user plays from it).
//
// usage (repo root): node .claude/skills/score-video-tab/scripts/shot.mjs <slug> <out.png> [line ...]
//   line   0-based line of the score to put on top; one picture each,
//          <out>-lineN.png. None: the first line, <out>.png.
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const [slug, out, ...lines] = process.argv.slice(2);
if (!slug || !out) {
  console.error('usage: shot.mjs <slug> <out.png> [line ...]');
  process.exit(2);
}
const repo = resolve(import.meta.dirname, '../../../..');
const { launch, waitForPlayer } = await import(pathToFileURL(join(repo, 'app', 'scripts', 'browser.mjs')).href);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 2194, height: 1100 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await page.goto('http://localhost:5173/#' + encodeURIComponent(slug));
await waitForPlayer(page, slug);
await page.waitForTimeout(1000);
const said = await page.evaluate(() => ({
  status: document.getElementById('status')?.textContent ?? '',
  bars: window.drums?.current?.bars,
  lines: window.drums?.api.boundsLookup?.staffSystems.length,
}));
console.log(`${slug}: ${said.bars} bars on ${said.lines} lines; status: ${said.status || '(nothing to say)'}`);
for (const line of lines.length ? lines : [null]) {
  const path = line === null ? out : out.replace(/\.png$/, `-line${line}.png`);
  if (line !== null) {
    await page.evaluate((n) => window.drums.scoreWindow.show(n), Number(line));
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path });
  console.log(`wrote ${path}`);
}
console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
await browser.close();
