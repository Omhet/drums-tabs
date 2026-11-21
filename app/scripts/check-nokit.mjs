// What the page says when no kit has been baked.
//
// A Kit fader with an empty bank behaves exactly like a Kit fader turned down:
// it makes no sound and gives no reason. That is the one thing about the
// sampler a fresh checkout is guaranteed to hit -- `kit/` is ignored, so the
// bank is never there until `drums kit-bake` has run -- and it is the one
// message nobody would otherwise ever see, because the moment you bake a kit
// it stops being reachable.
//
// So this hides the manifest, reloads, reads the line, and puts it back. The
// restore is in a `finally`: leaving somebody's bank hidden would be a much
// worse bug than the one this is checking for.
//
// And the other message nobody sees once it is fixed: a song whose stems have
// not been separated (Lamp-08b). Every song here has them, so the stems are
// refused (a 404 from the route) and the Mix panel has to fold Band and Drums
// into one "Record" row that still sets the level of the whole record.
//
// Needs `npm run dev` and an installed Chrome/Edge (see browser.mjs).
//
// Usage: node scripts/check-nokit.mjs
import { existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch, pageUrl, waitForPlayer } from './browser.mjs';

const manifest = fileURLToPath(new URL('../../kit/kit.lock.json', import.meta.url));
const hidden = `${manifest}.hidden`;

const problems = [];
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
  if (!ok) problems.push(what);
};

if (!existsSync(manifest)) {
  console.log(`no bank at ${manifest}; run \`drums kit-bake\` first`);
  process.exit(1);
}

let browser;
try {
  renameSync(manifest, hidden);
  // The practice plugin watches the manifest and reloads the page on a change;
  // give it a moment to notice before the browser asks for anything.
  await new Promise((r) => setTimeout(r, 1500));

  browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2194, height: 1100 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(pageUrl());
  await waitForPlayer(page);
  await page.waitForTimeout(2000);

  const said = await page.evaluate(() => {
    const el = document.getElementById('kit-note');
    return {
      present: Boolean(el),
      hidden: el?.hidden ?? null,
      text: el?.textContent?.trim() ?? '',
      baked: window.drums.mixer.bank.baked,
      size: window.drums.mixer.bank.size,
      // The fader still exists and still moves; it just has nothing to play.
      faderThere: Boolean(document.getElementById('fader-kit')),
      kitOut: document.getElementById('fader-kit-out').textContent,
      kitRowSilent: document.getElementById('row-kit').hasAttribute('data-silent'),
    };
  });

  check(!said.baked && said.size === 0, 'with no manifest the bank is empty', `${said.size} recordings`);
  check(said.present && said.hidden === false, 'the page says so under the Kit fader');
  check(/kit-bake/.test(said.text), 'and says which command fixes it', said.text);
  check(said.faderThere, 'the fader is still there: an empty bank is not a broken page');
  check(said.kitRowSilent && said.kitOut === '—', 'the Kit row reads as silent, not as a level', said.kitOut);


  // --- a song without stems -----------------------------------------------------
  await page.route('**/stems/*.wav', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto('about:blank');
  await page.goto(pageUrl());
  await waitForPlayer(page);
  await page.waitForFunction(() => document.getElementById('mix-panel').hasAttribute('data-no-stems'), null, {
    timeout: 15000,
  });
  // A gesture, so the graph exists and the record's own gain can be read.
  await page.keyboard.press('KeyM');
  await page.locator('#fader-nodrums').click();
  await page.waitForTimeout(300);
  const bare = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll('#mix-panel .mix-row')].filter((r) => !r.hidden);
    const el = document.getElementById('fader-nodrums');
    el.value = '40';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const m = window.drums.mixer;
    // Heard, not just set: the whole record through the Record row, and
    // nothing with it at 0.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const peak = async (ms) => {
      const buf = new Float32Array(m.analyser.fftSize);
      let p = 0;
      for (const until = performance.now() + ms; performance.now() < until; await sleep(20)) {
        m.analyser.getFloatTimeDomainData(buf);
        p = Math.max(p, Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length));
      }
      return p;
    };
    window.drums.mix.currentTime = 30;
    window.drums.api.play();
    await sleep(800);
    const loud = await peak(1200);
    el.value = '0';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    const quiet = await peak(1000);
    window.drums.api.pause();
    el.value = '40';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      loud,
      quiet,
      rows: rows.map((r) => r.querySelector('.mix-name').textContent),
      note: document.getElementById('stems-note').textContent,
      noteShown: !document.getElementById('stems-note').hidden,
      noStems: m.noStems,
      // The mix's own gain is private; the level the page set is what it follows.
      level: m.level('nodrums'),
    };
  });
  check(bare.noStems, 'with the stems refused the mixer knows it has none');
  check(bare.rows.join(',') === 'Record,Click,Kit', 'the panel folds Band and Drums into one Record row', bare.rows.join(', '));
  check(bare.noteShown && /stems haven't been separated/.test(bare.note), 'and says why under it', bare.note);
  check(Math.abs(bare.level - 0.4) < 1e-6, 'the Record row sets the level of the whole record', String(bare.level));
  check(bare.loud > 0.01 && bare.quiet < 0.001, 'which is heard through it, and silent at 0', `peak ${bare.loud.toFixed(3)} / ${bare.quiet.toFixed(4)}`);
  check(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  if (existsSync(hidden)) renameSync(hidden, manifest);
  console.log(`\nbank restored: ${existsSync(manifest)}`);
  await browser?.close();
}

if (problems.length) {
  console.log(`\n${problems.length} problem${problems.length > 1 ? 's' : ''}:`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('all checks passed');
