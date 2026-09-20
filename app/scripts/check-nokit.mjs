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
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
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
    };
  });

  check(!said.baked && said.size === 0, 'with no manifest the bank is empty', `${said.size} recordings`);
  check(said.present && said.hidden === false, 'the page says so under the Kit fader');
  check(/kit-bake/.test(said.text), 'and says which command fixes it', said.text);
  check(said.faderThere, 'the fader is still there: an empty bank is not a broken page');
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
