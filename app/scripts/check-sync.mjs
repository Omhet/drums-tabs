// The timing contract, both ways, for every bar of the loaded song:
//   - seek the mix to the beat map's start of bar N -> alphaTab must report
//     the first tick of notation bar N (the cursor is where the drummer is);
//   - seek alphaTab to notation bar N -> the mix must land on that beat
//     (clicking the score takes you to the right moment in the song).
// Then plays for a few seconds and checks the cursor actually moved with the
// clock. The clock is an <audio> element on audio/mix.wav, so its time is mix
// time and the beat map's seconds go in as they are.
// Needs `npm run dev` and an installed Chrome/Edge (see browser.mjs).
//
// Usage: node scripts/check-sync.mjs [tolerance-ms]
import { launch, pageUrl, waitForPlayer } from './browser.mjs';

const toleranceMs = Number(process.argv[2] ?? 15);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(pageUrl());
await waitForPlayer(page);
await page.waitForFunction(() => window.drums.mix.readyState >= 1, null, { timeout: 30000 });

const result = await page.evaluate(async (toleranceMs) => {
  const { api, mix, current } = window.drums;
  const grid = current.grid;
  if (!grid) return { error: 'no grid loaded' };
  const perBar = grid.meter.beats_per_bar;
  const ticksPerBar = 960 * perBar; // alphaTab: 960 ticks per quarter, 4/4
  // The written tempo, not the drummer's: ticks live on the notation's clock.
  const ticksPerMs = (960 * api.score.tempo) / 60000;
  const seekMix = (s) =>
    new Promise((resolve) => {
      mix.addEventListener('seeked', () => resolve(), { once: true });
      mix.currentTime = s;
    });
  const worst = { mediaToScore: 0, scoreToMedia: 0 };
  const bad = [];
  const bars = Math.min(current.bars, grid.bar_count);
  for (let bar = 0; bar < bars; bar++) {
    const beatS = grid.beats[grid.bar_one_beat + bar * perBar];
    // Media -> score. A hair after the beat so we are inside this bar, not
    // on the boundary where either answer is right.
    await seekMix(beatS + 0.002);
    const tickErrMs = (api.tickPosition - bar * ticksPerBar) / ticksPerMs - 2;
    worst.mediaToScore = Math.max(worst.mediaToScore, Math.abs(tickErrMs));
    if (Math.abs(tickErrMs) > toleranceMs) bad.push({ bar: bar + 1, dir: 'media->score', errMs: Math.round(tickErrMs) });
    // Score -> media.
    const seeked = new Promise((resolve) => mix.addEventListener('seeked', () => resolve(), { once: true }));
    api.tickPosition = bar * ticksPerBar;
    await seeked;
    const mediaErrMs = (mix.currentTime - beatS) * 1000;
    worst.scoreToMedia = Math.max(worst.scoreToMedia, Math.abs(mediaErrMs));
    if (Math.abs(mediaErrMs) > toleranceMs) bad.push({ bar: bar + 1, dir: 'score->media', errMs: Math.round(mediaErrMs) });
  }

  // Play through the count-in and the first bars; the cursor must follow.
  await seekMix(0);
  const tickAtStart = api.tickPosition;
  api.play();
  await new Promise((r) => setTimeout(r, 5000));
  const tickAfter = api.tickPosition;
  const mixAfter = mix.currentTime;
  const beatEl = document.querySelector('.at-cursor-beat');
  const r = beatEl?.getBoundingClientRect();
  api.pause();
  return {
    bars,
    syncPoints: current.syncPoints.length,
    hasVideo: current.video,
    videoOffsetMs: grid.video_offset_ms ?? null,
    worst,
    bad,
    tempo: api.score.tempo,
    play: { tickAtStart, tickAfter, mixAfter, state: api.playerState, mixPaused: mix.paused,
      cursor: r ? { x: Math.round(r.x), y: Math.round(r.y), h: Math.round(r.height) } : null },
  };
}, toleranceMs);

console.log(JSON.stringify(result, null, 1));
if (errors.length) console.log('page errors:', errors);
await browser.close();

const ok =
  !result.error &&
  result.bad.length === 0 &&
  result.play.tickAtStart <= 2 &&
  result.play.tickAfter > 0 &&
  result.play.mixAfter > 3 &&
  errors.length === 0;
console.log(ok ? `OK: ${result.bars} bars within ${toleranceMs} ms both ways, cursor moved during playback` : 'FAILED');
process.exit(ok ? 0 : 1);
