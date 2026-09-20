// The mixer's contract: everything that follows the mix clock stays on it at
// any tempo, the faders are the only thing that makes sound, and the click
// sounds when it is up. Plays 5 s at 100% and 5 s at 50%, sampling each
// follower's distance from `clock.mixTimeMs` every 100 ms; then checks the
// analyser on the graph is quiet with every fader at 0 and loud with only the
// click up.
//
// And one thing that is about the sampler rather than the mixer, but is only
// true here: on a song page the kit holds the *whole* chart, so dropping Drums
// to nothing and bringing Kit up plays the written part over the nodrums stem.
// That is the whole of what used to be described as a switch -- there is no
// mode, only three faders and somebody having handed the kit the notes.
//
// Followers are the two stems and, when the song has a video, the picture.
// The two are held to different contracts: a stem must be on the clock the
// whole time, while the picture only has to have caught up by the end of the
// run and stayed there -- it starts a tenth of a second behind, because that
// is how long a video element takes to present its first frame, and it is
// driven back over the following second (see follow.ts).
// Needs `npm run dev` and an installed Chrome/Edge (see browser.mjs).
//
// Usage: node scripts/check-mix.mjs [tolerance-ms] [picture-tolerance-ms]
import { launch, pageUrl, waitForPlayer } from './browser.mjs';

const toleranceMs = Number(process.argv[2] ?? 20);
const pictureToleranceMs = Number(process.argv[3] ?? 60);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(pageUrl());
await waitForPlayer(page);
await page.waitForFunction(() => window.drums.mix.readyState >= 1, null, { timeout: 30000 });

// A real key press: the AudioContext must be created inside a user gesture.
await page.keyboard.press('Space');
await page.waitForTimeout(500);
await page.keyboard.press('Space');
await page.waitForTimeout(300);

const result = await page.evaluate(
  async ({ toleranceMs, pictureToleranceMs }) => {
    const { api, mix, clock, mixer } = window.drums;
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

    // Only what is actually playing: a song with no video has no picture, and
    // a stem that failed to load is reported instead of measured.
    const following = mixer.followers.filter((f) => f.following);

    const out = { ctxState: mixer.ctx?.state ?? null, followers: {}, runs: [], quiet: null, click: null };
    for (const f of mixer.followers) {
      out.followers[f.name] = {
        src: f.el.currentSrc,
        readyState: f.el.readyState,
        failed: f.failed,
        following: f.following,
        offsetMs: f.offsetMs,
      };
    }

    // Start a few bars in so the stems have something to play besides silence.
    const startS = 5;
    const seek = (s) =>
      new Promise((resolve) => {
        mix.addEventListener('seeked', () => resolve(), { once: true });
        mix.currentTime = s;
      });

    for (const percent of [100, 50]) {
      setSlider('fader-nodrums', 100);
      setSlider('fader-drums', 100);
      setSlider('fader-click', 0);
      setSlider('speed', percent);
      await seek(startS);
      api.play();
      // Let the followers start and the first correction settle.
      await sleep(1500);
      const samples = Object.fromEntries(following.map((f) => [f.name, []]));
      const startedAt = following.map((f) => f.el.currentTime);
      let signal = 0;
      for (let i = 0; i < 35; i++) {
        const mixNow = clock.mixTimeMs;
        // Where it should be is mix time plus its own offset (0 for a stem;
        // the cut difference `drums align` measured for a picture).
        for (const f of following) samples[f.name].push(f.el.currentTime * 1000 - mixNow - f.offsetMs);
        signal = Math.max(signal, rms());
        await sleep(100);
      }
      const stats = (xs) => ({
        mean: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10,
        worst: Math.round(Math.max(...xs.map(Math.abs)) * 10) / 10,
        // The last 1.5 s, once a follower that had to catch up has: a stem
        // lands on the clock at once, but a video element needs about a
        // second of running 6% fast to make up the tenth of a second it
        // takes to present its first frame (see follow.ts).
        settled: Math.round(Math.max(...xs.slice(-15).map(Math.abs)) * 10) / 10,
      });
      const run = {
        percent,
        clockRate: mix.playbackRate,
        rates: Object.fromEntries(following.map((f) => [f.name, f.el.playbackRate])),
        paused: Object.fromEntries(following.map((f) => [f.name, f.el.paused])),
        drift: Object.fromEntries(following.map((f) => [f.name, stats(samples[f.name])])),
        signalRms: Math.round(signal * 1000) / 1000,
        elapsedClockS: Math.round((mix.currentTime - startS) * 100) / 100,
        // They must have moved on their own, or a zero drift means nothing.
        elapsedS: Object.fromEntries(
          following.map((f, i) => [f.name, Math.round((f.el.currentTime - startedAt[i]) * 100) / 100])
        ),
        rawDriftMs: samples.drums.slice(0, 4).map((d) => Math.round(d * 1000) / 1000),
      };
      run.ok =
        // A stem is on the clock the whole time; the picture has to have got
        // there by the end and stayed.
        following.every((f) =>
          f === mixer.picture
            ? run.drift[f.name].settled <= pictureToleranceMs
            : run.drift[f.name].worst <= toleranceMs
        ) &&
        run.signalRms > 0.01 &&
        following.every((f) => run.elapsedS[f.name] > (2.5 * percent) / 100) &&
        following.every((f) => !run.paused[f.name]);
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

    // The written part, over the record with its drums taken out.
    setSlider('fader-click', 0);
    setSlider('fader-nodrums', 100);
    setSlider('fader-drums', 0);
    setSlider('fader-kit', 80);
    await sleep(200);
    const kitNotes = window.drums.practice.wholeSong();
    out.sampler = {
      bank: window.drums.mixer.bank.name,
      recordings: window.drums.mixer.bank.size,
      // The kit was handed the whole song on load, not the selected cell.
      notes: kitNotes.length,
      unplayable: window.drums.mixer.unplayable(kitNotes),
      peakRms: await peak(2500),
    };
    out.sampler.ok =
      out.sampler.recordings > 0 &&
      out.sampler.notes > 100 &&
      out.sampler.unplayable.length === 0 &&
      out.sampler.peakRms > 0.02;
    setSlider('fader-kit', 0);
    api.pause();
    // The clock's pause event reaches the followers a task later.
    await sleep(300);

    // Back to the defaults so the check leaves no trace in localStorage.
    setSlider('fader-nodrums', 100);
    setSlider('fader-drums', 100);
    setSlider('fader-click', 0);
    out.clockPausedAtEnd = mix.paused;
    out.pausedAtEnd = Object.fromEntries(following.map((f) => [f.name, f.el.paused]));
    return out;
  },
  { toleranceMs, pictureToleranceMs }
);

console.log(JSON.stringify(result, null, 1));
if (errors.length) console.log('page errors:', errors);
await browser.close();

const ok =
  result.ctxState === 'running' &&
  result.runs.length === 2 &&
  result.runs.every((r) => r.ok) &&
  result.quiet.ok &&
  result.click.ok &&
  result.sampler.ok &&
  Object.values(result.pausedAtEnd).every(Boolean) &&
  errors.length === 0;
console.log(
  ok
    ? `OK: stems within ${toleranceMs} ms of the mix clock at 100% and 50% (picture ${pictureToleranceMs} ms), silent at 0, click audible, and the kit plays ${result.sampler.notes} written notes over nodrums`
    : 'FAILED'
);
process.exit(ok ? 0 : 1);
