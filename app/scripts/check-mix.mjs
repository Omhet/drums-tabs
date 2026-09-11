// The mixer's contract: the stems stay on the video's clock at any tempo, the
// faders are the only thing that makes sound, and the click sounds when it is
// up. Plays 5 s at 100% and 5 s at 50%, sampling each stem's distance from
// `clock.mixTimeMs` every 100 ms; then checks the analyser on the graph is
// quiet with every fader at 0 and loud with only the click up.
// Needs `npm run dev` and an installed Chrome/Edge (see browser.mjs).
//
// Usage: node scripts/check-mix.mjs [tolerance-ms]
import { launch, waitForPlayer } from './browser.mjs';

const toleranceMs = Number(process.argv[2] ?? 20);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:5173/');
await waitForPlayer(page);
await page.waitForFunction(() => window.drums.video.readyState >= 1, null, { timeout: 30000 });

// A real key press: the AudioContext must be created inside a user gesture.
await page.keyboard.press('Space');
await page.waitForTimeout(500);
await page.keyboard.press('Space');
await page.waitForTimeout(300);

const result = await page.evaluate(async (toleranceMs) => {
  const { api, video, clock, mixer } = window.drums;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setSlider = (id, value) => {
    const el = document.getElementById(id);
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const rms = () => {
    const a = mixer.analyser;
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.sqrt(sum / buf.length);
  };
  // Peak RMS over a window, sampled every 20 ms.
  const peak = async (ms) => {
    let p = 0;
    const until = performance.now() + ms;
    while (performance.now() < until) {
      p = Math.max(p, rms());
      await sleep(20);
    }
    return p;
  };

  const out = { ctxState: mixer.ctx?.state ?? null, stems: {}, runs: [], quiet: null, click: null };
  for (const s of mixer.stems) out.stems[s.name] = { src: s.el.currentSrc, readyState: s.el.readyState, failed: s.failed };

  // Start a few bars in so the stems have something to play besides silence.
  const startS = 5;
  const seek = (s) =>
    new Promise((resolve) => {
      video.addEventListener('seeked', () => resolve(), { once: true });
      video.currentTime = s;
    });

  for (const percent of [100, 50]) {
    setSlider('fader-nodrums', 100);
    setSlider('fader-drums', 100);
    setSlider('fader-click', 0);
    setSlider('speed', percent);
    await seek(startS);
    api.play();
    // Let the stems start and the first correction settle.
    await sleep(1500);
    const samples = { nodrums: [], drums: [] };
    const stemStart = mixer.stems.map((s) => s.el.currentTime);
    let signal = 0;
    for (let i = 0; i < 35; i++) {
      const mixNow = clock.mixTimeMs;
      for (const s of mixer.stems) samples[s.name].push(s.el.currentTime * 1000 - mixNow);
      signal = Math.max(signal, rms());
      await sleep(100);
    }
    const stats = (xs) => ({
      mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10,
      worst: Math.round(Math.max(...xs.map(Math.abs)) * 10) / 10,
    });
    const run = {
      percent,
      videoRate: video.playbackRate,
      stemRates: mixer.stems.map((s) => s.el.playbackRate),
      stemsPaused: mixer.stems.map((s) => s.el.paused),
      drift: { nodrums: stats(samples.nodrums), drums: stats(samples.drums) },
      signalRms: Math.round(signal * 1000) / 1000,
      elapsedVideoS: Math.round((video.currentTime - startS) * 100) / 100,
      // The stems must have moved on their own, or a zero drift means nothing.
      elapsedStemsS: mixer.stems.map((s, i) => Math.round((s.el.currentTime - stemStart[i]) * 100) / 100),
      rawDriftMs: samples.drums.slice(0, 4).map((d) => Math.round(d * 1000) / 1000),
    };
    run.ok =
      run.drift.nodrums.worst <= toleranceMs &&
      run.drift.drums.worst <= toleranceMs &&
      run.signalRms > 0.01 &&
      run.elapsedStemsS.every((e) => e > (2.5 * percent) / 100) &&
      run.stemsPaused.every((p) => !p);
    out.runs.push(run);
    api.pause();
    await sleep(300);
  }

  // Everything at 0: silence, even while playing.
  setSlider('speed', 100);
  for (const f of ['nodrums', 'drums', 'click']) setSlider(`fader-${f}`, 0);
  await seek(startS);
  api.play();
  await sleep(1000);
  out.quiet = { peakRms: await peak(1500) };
  out.quiet.ok = out.quiet.peakRms < 0.001;

  // Only the click: blips on the beats.
  setSlider('fader-click', 100);
  await sleep(200);
  out.click = { peakRms: await peak(1500) };
  out.click.ok = out.click.peakRms > 0.05;
  api.pause();
  // The video's pause event reaches the stems a task later.
  await sleep(300);

  // Back to the defaults so the check leaves no trace in localStorage.
  setSlider('fader-nodrums', 100);
  setSlider('fader-drums', 100);
  setSlider('fader-click', 0);
  out.videoPausedAtEnd = video.paused;
  out.stemsPausedAtEnd = mixer.stems.map((s) => s.el.paused);
  return out;
}, toleranceMs);

console.log(JSON.stringify(result, null, 1));
if (errors.length) console.log('page errors:', errors);
await browser.close();

const ok =
  result.ctxState === 'running' &&
  result.runs.length === 2 &&
  result.runs.every((r) => r.ok) &&
  result.quiet.ok &&
  result.click.ok &&
  result.stemsPausedAtEnd.every(Boolean) &&
  errors.length === 0;
console.log(
  ok
    ? `OK: stems within ${toleranceMs} ms of the video at 100% and 50%, silent at 0, click audible`
    : 'FAILED'
);
process.exit(ok ? 0 : 1);
