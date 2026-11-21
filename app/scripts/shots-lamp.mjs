// The player at the size it is read at -- 2194x1100, a 31.5" 4K screen at 175%
// -- in the states the Lamp frames draw, for putting side by side with
// design/lamp/Lamp-01..04. Each redesign stage ends with these.
//
// Usage: node scripts/shots-lamp.mjs [out-dir]   (default ../design/built)
//
//   song2-video.png      Lamp-01: Song 2 playing, the video shown
//   song2-no-video.png   Lamp-02: the same, the video hidden (V)
//   kill-me.png          Lamp-03: a song with no video
//   kill-me-three-lines.png  the compact header with three lines that each
//                        start a section (bars 45-56: build, into last chorus,
//                        last chorus)
//   picker-empty.png     Lamp-07 top: the map as a picker, nothing picked
//   picker-chorus.png    Lamp-07 middle: the picker, the chorus picked
//   loop-ramp.png        Lamp-04: the chorus at 80% on its third pass, the
//                        ramp's ladder (70 to 100 in 5s) in place of the pills
//   loop-ramp-no-video.png  the same in the compact header (no frame draws it)
//   count-in.png         Lamp-05: the count-in into the chorus at 80%, on beat 3
//   count-in-no-video.png   the same in the compact header (no frame draws it)
//   browsing.png         Lamp-06: paused at bar 11, the paper turned to bars 25-32
//   browsing-no-video.png   the same in the compact header (no frame draws it)
//   zen.png              Lamp-11: Song 2 in zen, the picture over the paper
//   zen-no-video.png     zen with no picture (Kill Me): the paper has the screen
//   library.png          Lamp-09: the Songs page, Song 2 played last
//   mix.png              Lamp-08: Song 2, the Mix panel open over the header
//   mix-no-video.png     the panel in the compact header (no frame draws it)
//   mix-no-stems.png     Lamp-08b: Song 2 with its stems refused, so the
//                        panel's one Record row (no song is without stems)
//   settings.png         Lamp-10: the Settings page
//
// The kit layer (Lamp-12), with strokes injected as the checks do (a headless
// Chrome gets no Web MIDI) and a stand-in calibration, both put back after;
// the takes these passes write are removed again:
//   recording.png        Song 2, the whole song recording at 125%: the pill
//                        filled, "Recording", the chip in the corner
//   recording-no-video.png  the same in the compact header
//   scored.png           Lamp-12: the chorus looped at 80%, pass 2 just
//                        played (two missed in bar 12, one in 14, one on the
//                        wrong drum), pass 3 recording
//   scored-no-video.png  the same in the compact header: the card in the map's slot
//   scored-stopped.png   Record stopped: the noteheads coloured, the card's close
//   scored-song.png      the whole song's reading, the strip closed up
//
// ONLY=player or ONLY=kit runs one group.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, waitForPlayer } from './browser.mjs';

const outDir = process.argv[2] ?? fileURLToPath(new URL('../../design/built', import.meta.url));
mkdirSync(outDir, { recursive: true });
const SONG2 = 'blur-song-2-official-music-video';
const KILLME = 'hayley-williams-kill-me-official-visualizer';
const ONLY = process.env.ONLY;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 2194, height: 1100 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

async function open(slug) {
  await page.goto(`http://localhost:5173/#${encodeURIComponent(slug)}`);
  await waitForPlayer(page, slug);
  await page.waitForFunction(() => window.drums.mix.readyState >= 1, null, { timeout: 30000 });
  await page.waitForTimeout(1000);
}
/** Play from a bar, past the count-in, and let the picture catch up. */
async function playFrom(bar) {
  await page.evaluate((b) => window.drums.seekToBar(b - 1), bar);
  await page.waitForTimeout(300);
  await page.locator('#play').click();
  await page.waitForFunction(() => !window.drums.mix.paused, null, { timeout: 10000 });
  await page.waitForTimeout(1500);
}
const shot = async (name) => {
  // Out of the way, so nothing is drawn hovered.
  await page.mouse.move(2190, 1096);
  await page.screenshot({ path: join(outDir, name) });
  console.log(`wrote ${join(outDir, name)}`);
};

if (ONLY !== 'kit') {
  await open(SONG2);
  await playFrom(19);
  await shot('song2-video.png');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(800);
  await shot('song2-no-video.png');
  await page.keyboard.press('KeyV');
  await page.keyboard.press('Space');

  await open(KILLME);
  await playFrom(18);
  await shot('kill-me.png');
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.drums.seekToBar(46));
  await page.waitForTimeout(800);
  await shot('kill-me-three-lines.png');

  // The chorus of Song 2 at 80%, the ramp on, on its second pass.
  await open(SONG2);
  const chorus = await page.evaluate(() => {
    const d = window.drums;
    const song = d.songs.find((s) => s.slug === d.current.slug);
    const exact = song.sections.findIndex((s) => /^chorus$/i.test(s.name));
    return exact >= 0 ? exact : song.sections.findIndex((s) => /chorus/i.test(s.name));
  });
  // Paused in the chorus (Lamp-07 has the playhead at 11.4), the map opened
  // as the picker: nothing picked, then a click on the chorus.
  await page.evaluate(() => window.drums.seekToBar(10));
  await page.waitForTimeout(500);
  await page.locator('#loop').click();
  await page.waitForTimeout(400);
  await shot('picker-empty.png');
  await page.locator(`#map .map-block[data-index="${Math.max(0, chorus)}"]`).click();
  await page.waitForTimeout(600);
  await shot('picker-chorus.png');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el.type === 'checkbox') el.checked = v;
      else el.value = String(v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('ramp-from', 70);
    set('ramp-to', 100);
    set('ramp-step', 5);
    set('ramp-every', 1);
    if (!window.drums.loop.ramp.on) window.drums.loop.toggleRamp();
  });
  await page.locator('#play').click();
  await page.waitForFunction(() => window.drums.loop.pass >= 3 && window.drums.loop.phase === 'playing', null, {
    timeout: 150000,
  });
  await page.waitForTimeout(1200);
  await shot('loop-ramp.png');
  // Not a frame of its own: the compact band with the Ramp pill in it.
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(600);
  await shot('loop-ramp-no-video.png');
  await page.keyboard.press('KeyV');
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  // The count-in (Lamp-05): the chorus looped at 80%, the ramp off, Play from
  // the top of it -- caught on its third beat.
  await page.evaluate(() => {
    const d = window.drums;
    if (d.loop.ramp.on) d.loop.toggleRamp();
    d.setTempo(80);
  });
  const onBeat = async (n) => {
    await page.locator('#play').click();
    await page.waitForFunction(
      (n) => document.querySelector('#count-beats [data-beat="now"]')?.textContent === n,
      String(n),
      { timeout: 15000 }
    );
  };
  await onBeat(3);
  await shot('count-in.png');
  await page.waitForFunction(() => !document.getElementById('app').dataset.counting, null, { timeout: 10000 });
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(400);
  await onBeat(3);
  await shot('count-in-no-video.png');
  await page.waitForFunction(() => !document.getElementById('app').dataset.counting, null, { timeout: 10000 });
  await page.keyboard.press('Space');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(400);

  // Browsing (Lamp-06): paused at bar 11 of the looped chorus, the wheel turns
  // the paper to bars 25-32.
  await page.evaluate(() => window.drums.seekToBar(10));
  await page.waitForTimeout(500);
  const browseTo = async (bar) => {
    await page.mouse.move(1100, 800);
    for (let i = 0; i < 12; i++) {
      const top = await page.evaluate(() => window.drums.scoreWindow.bars?.[0] ?? 0);
      if (top + 1 >= bar) break;
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(400);
  };
  await browseTo(25);
  await shot('browsing.png');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(600);
  await shot('browsing-no-video.png');
  await page.keyboard.press('KeyV');
  await page.keyboard.press('Home');
  await page.waitForTimeout(300);

  // Leave the song as it was found: no loop, no ramp, 100%.
  await page.evaluate(() => {
    const d = window.drums;
    if (d.loop.ramp.on) d.loop.toggleRamp();
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = String(v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('ramp-from', 70);
    set('ramp-step', 5);
    set('ramp-every', 2);
    set('ramp-to', 100);
    d.loop.off();
    d.setTempo(100);
  });

  // Zen (Lamp-11): the chorus playing, the picture over the paper; then a song
  // with no picture, where the paper has the screen.
  await open(SONG2);
  await playFrom(11);
  await page.keyboard.press('KeyZ');
  await page.waitForTimeout(1000);
  await shot('zen.png');
  await page.keyboard.press('KeyZ');
  await page.keyboard.press('Space');
  await open(KILLME);
  await page.evaluate(() => window.drums.seekToBar(16));
  await page.waitForTimeout(500);
  await page.keyboard.press('KeyZ');
  await page.waitForTimeout(1000);
  await shot('zen-no-video.png');
  await page.keyboard.press('KeyZ');

  // The mix, open over the header (Lamp-08), playing in the chorus.
  await open(SONG2);
  await playFrom(11);
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(400);
  await shot('mix.png');
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(600);
  await shot('mix-no-video.png');
  await page.keyboard.press('KeyV');
  await page.keyboard.press('KeyM');
  await page.keyboard.press('Space');

  // Settings (Lamp-10), over the player.
  await page.locator('#settings-btn').click();
  await page.waitForTimeout(400);
  await shot('settings.png');
  await page.keyboard.press('Escape');

  // Every song here has its stems, so refuse them: the page then plays the
  // whole record and the panel has its one Record row (Lamp-08b).
  await page.route('**/stems/*.wav', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto('about:blank');
  await open(SONG2);
  await page.waitForFunction(() => document.getElementById('mix-panel').hasAttribute('data-no-stems'), null, { timeout: 15000 });
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(400);
  await shot('mix-no-stems.png');
  await page.unroute('**/stems/*.wav');

  // The library (Lamp-09): Song 2 played last, so outlined, and where it was
  // left off; the others as this fresh browser has them. Via about:blank: the
  // same URL again is not a reload, and the stems-refused page has its Mix open.
  await page.goto('about:blank');
  await open(SONG2);
  await page.evaluate(() => {
    window.drums.loop.setRange({ startBar: 9, endBar: 16 });
    window.drums.setTempo(80);
  });
  await playFrom(11);
  await page.keyboard.press('Space');
  await page.locator('#songs-btn').click();
  await page.waitForFunction(
    () =>
      !document.getElementById('library').hidden &&
      [...document.querySelectorAll('.lib-pic')].every((p) => p.querySelector('canvas') || p.classList.contains('none')),
    null,
    { timeout: 20000 }
  );
  await page.waitForTimeout(500);
  await shot('library.png');
  await page.evaluate(() => {
    window.drums.loop.off();
    window.drums.setTempo(100);
  });
}

if (ONLY !== 'player') await kitShots();


/**
 * The kit layer: strokes fed in through `MidiIn.inject`, aimed at the written
 * notes, with `miss` choosing which to leave out (or `wrong` to play on a tom).
 * Loop-aware: every note is playable again when the music comes back for the
 * next pass.
 */
async function inject(plan) {
  await page.evaluate((plan) => {
    const d = window.drums;
    const p = d.practice;
    const notes = p.expected();
    const noteOf = (instrument) => {
      for (const [n, name] of Object.entries(p.input.note)) if (name === instrument) return Number(n);
      return 38;
    };
    // Which notes of a bar to leave out or play wrong: the nth of that bar.
    const nth = new Map();
    const planned = notes.map((n, i) => {
      const k = (nth.get(n.bar) ?? 0) + 1;
      nth.set(n.bar, k);
      const miss = plan.miss.some(([bar, j]) => bar === n.bar && j === k);
      const wrong = plan.wrong.some(([bar, j]) => bar === n.bar && j === k);
      return { i, tMs: n.tMs + 6, note: noteOf(wrong ? 'tom_high' : n.instrument), skip: miss };
    });
    let done = new Set();
    clearInterval(window.__injector);
    window.__injector = setInterval(() => {
      if (d.mix.paused) {
        done = new Set();
        return;
      }
      const now = performance.now();
      const mixNow = d.clock.mixTimeAt(now);
      const rate = d.mix.playbackRate || 1;
      for (const n of planned) {
        if (done.has(n.i) || n.tMs > mixNow + 30) continue;
        done.add(n.i);
        if (n.skip || n.tMs < mixNow - 300) continue;
        p.midi.inject(n.note, 100, now + (n.tMs - mixNow) / rate);
      }
    }, 15);
  }, plan);
}
function stopInjecting() {
  return page.evaluate(() => clearInterval(window.__injector));
}

async function kitShots() {
  const CALIBRATION = 'http://localhost:5173/practice/calibration';
  const saved = await (await fetch(CALIBRATION)).json();
  const takesDir = fileURLToPath(new URL(`../../songs/${SONG2}/takes`, import.meta.url));
  const before = new Set(existsSync(takesDir) ? readdirSync(takesDir) : []);
  const post = (body) =>
    fetch(CALIBRATION, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    // A stand-in calibration, so the chip says what Lamp-12 says.
    await post({ offsetMs: 23, spreadMs: 4, n: 32, note: 38, measuredAt: new Date().toISOString() });
    await page.goto('about:blank');
    await open(SONG2);
    await page.evaluate(() => window.drums.practice.midi.inject(38, 1));
    await page.waitForFunction(() => document.getElementById('app').hasAttribute('data-kit'));

    // Recording the whole song, at 125% so it is over in a minute and a half.
    await page.evaluate(() => {
      const d = window.drums;
      d.loop.off();
      d.setTempo(125);
    });
    await page.locator('#record').click();
    await inject({ miss: [[20, 3], [33, 1], [33, 4]], wrong: [[41, 2]] });
    await page.waitForFunction(() => !window.drums.mix.paused, null, { timeout: 15000 });
    await page.waitForTimeout(4000);
    await shot('recording.png');
    await page.keyboard.press('KeyV');
    await page.waitForTimeout(800);
    await shot('recording-no-video.png');
    await page.keyboard.press('KeyV');
    await page.waitForFunction(() => document.getElementById('record').getAttribute('aria-pressed') === 'false', null, {
      timeout: 150000,
    });
    await stopInjecting();
    await page.waitForTimeout(2500);
    await shot('scored-song.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);

    // Lamp-12: the chorus at 80%, pass 2 just played, pass 3 under way.
    await page.evaluate(() => {
      const d = window.drums;
      d.loop.setRange({ startBar: 9, endBar: 16 });
      if (d.loop.ramp.on) d.loop.toggleRamp();
      d.setTempo(80);
    });
    await page.locator('#record').click();
    await inject({ miss: [[12, 5], [12, 6], [14, 8]], wrong: [[14, 7]] });
    await page.waitForFunction(() => window.drums.loop.pass >= 3 && window.drums.loop.phase === 'playing', null, {
      timeout: 120000,
    });
    await page.waitForTimeout(1500);
    await shot('scored.png');
    await page.keyboard.press('KeyV');
    await page.waitForTimeout(800);
    await shot('scored-no-video.png');
    await page.keyboard.press('KeyV');
    await page.waitForTimeout(400);
    await page.locator('#record').click();
    await stopInjecting();
    await page.evaluate(() => window.drums.seekToBar(8));
    await page.waitForTimeout(2500);
    await shot('scored-stopped.png');
    await page.keyboard.press('Escape');
  } finally {
    await stopInjecting();
    await post(saved);
    await page.evaluate(() => {
      const d = window.drums;
      d.loop.off();
      d.setTempo(100);
    });
    const mine = (existsSync(takesDir) ? readdirSync(takesDir) : []).filter((f) => !before.has(f));
    for (const f of mine) rmSync(join(takesDir, f));
    console.log(`removed the ${mine.length} take(s) these shots wrote`);
  }
}

console.log(errors.length ? `page errors: ${errors.join('; ')}` : 'no page errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
