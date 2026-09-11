// Headless check of the running dev server: loads the page, waits for alphaTab
// to render, and reports console errors, failed requests and what actually
// landed in the DOM.
//
// Usage: node scripts/smoke.mjs [url]
import { launch } from './browser.mjs';

const url = process.argv[2] ?? 'http://localhost:5173/';
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

const browser = await launch();
const page = await browser.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
  }
});
page.on('pageerror', (err) => pageErrors.push(String(err)));
page.on('requestfailed', (req) => {
  // The browser opens the video with an open-ended range request and aborts it
  // once it has the metadata it wanted; that is how media loading works, not
  // a failure.
  if (req.resourceType() === 'media' && req.failure()?.errorText === 'net::ERR_ABORTED') return;
  failedRequests.push(`${req.url()} (${req.failure()?.errorText ?? 'failed'})`);
});
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

// Give alphaTab a moment to finish rendering and the video to load metadata.
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

// Rendering is only half of it: the score has to *play*. Press play, let the
// video run past its count-in, and read the transport position back -- a
// cursor that never moves is the failure a screenshot cannot show.
await page.locator('#play').click();
await page.waitForTimeout(4500);
const playback = await page.evaluate(() => {
  const api = window.drums?.api;
  const video = window.drums?.video;
  return {
    state: api?.playerState ?? -1,
    position: Math.round(api?.timePosition ?? -1),
    videoTime: Math.round((video?.currentTime ?? -1) * 1000),
    videoPaused: video?.paused ?? null,
  };
});
await page.locator('#stop').click();

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
console.log(`playback     : state ${playback.state} at ${playback.position} ms (state 1 = playing, position > 0 = the transport moved)`);
console.log(`video        : at ${playback.videoTime} ms, paused ${playback.videoPaused}`);

const problems = [...pageErrors, ...consoleErrors, ...failedRequests];
if (problems.length) {
  console.log(`\nproblems (${problems.length}):`);
  for (const p of problems.slice(0, 15)) console.log(`  - ${p.slice(0, 220)}`);
} else {
  console.log('\nno console errors, page errors or failed assets.');
}

await browser.close();
const failed =
  pageErrors.length > 0 ||
  failedRequests.length > 0 ||
  dom.pathCount === 0 ||
  playback.position <= 0;
process.exit(failed ? 1 : 0);
