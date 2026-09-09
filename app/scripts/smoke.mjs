// Headless check of the running dev server: loads the page, waits for alphaTab
// to render, and reports console errors, failed requests and what actually
// landed in the DOM.
//
// Usage: node scripts/smoke.mjs [url]
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/';
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

const browser = await chromium.launch();
const page = await browser.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
  }
});
page.on('pageerror', (err) => pageErrors.push(String(err)));
page.on('requestfailed', (req) =>
  failedRequests.push(`${req.url()} (${req.failure()?.errorText ?? 'failed'})`)
);
// A dev server answers missing paths with index.html rather than a 404, so a
// broken asset shows up as a 200 of the wrong content type, not as a failure.
page.on('response', (res) => {
  const u = res.url();
  if (/\.(woff2?|otf|sf2|sf3)(\?|$)/.test(u)) {
    const type = res.headers()['content-type'] ?? '';
    if (type.includes('html')) failedRequests.push(`${u} -> served HTML, not a binary asset`);
  }
});

await page.goto(url, { waitUntil: 'networkidle' });

// Give alphaTab a moment to finish rendering and load the soundfont.
await page.waitForTimeout(4000);

const status = await page.locator('#status').textContent();
const dom = await page.evaluate(() => {
  const score = document.getElementById('score');
  return {
    svgCount: score ? score.querySelectorAll('svg').length : 0,
    pathCount: score ? score.querySelectorAll('svg path').length : 0,
    // alphaTab draws noteheads as Bravura glyphs in <text>, not as paths, so
    // this is the count that actually says whether notes were engraved.
    glyphCount: score ? score.querySelectorAll('svg text').length : 0,
    innerLength: score ? score.innerHTML.length : 0,
    playDisabled: document.querySelector('#play')?.disabled ?? null,
  };
});

const shot = process.env.SMOKE_SHOT;
if (shot) {
  await page.locator('#score').screenshot({ path: shot });
  console.log(`screenshot   : ${shot}`);
}

console.log(`url          : ${url}`);
console.log(`status text  : ${status?.trim()}`);
console.log(`score <svg>  : ${dom.svgCount}`);
console.log(`score paths  : ${dom.pathCount}   (glyphs/noteheads; 0 means nothing engraved)`);
console.log(`#score html  : ${dom.innerLength} bytes`);
console.log(`glyphs (text): ${dom.glyphCount}   (noteheads are Bravura glyphs)`);
console.log(`play enabled : ${dom.playDisabled === false}`);

const problems = [...pageErrors, ...consoleErrors, ...failedRequests];
if (problems.length) {
  console.log(`\nproblems (${problems.length}):`);
  for (const p of problems.slice(0, 15)) console.log(`  - ${p.slice(0, 220)}`);
} else {
  console.log('\nno console errors, page errors or failed assets.');
}

await browser.close();
process.exit(pageErrors.length || failedRequests.length || dom.pathCount === 0 ? 1 : 0);
