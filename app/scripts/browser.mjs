// Playwright's bundled Chromium has no H.264/AAC decoders, so the cover video
// neither plays nor loads in it. Prefer the installed Chrome or Edge, which
// do, and fall back to the bundled build (score-only checks still work there).
import { chromium } from 'playwright';

export async function launch(options = {}) {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, ...options });
    } catch {
      /* not installed */
    }
  }
  return chromium.launch(options);
}

/**
 * The page, on a particular song: the hash is the song selector, so
 * `SONG=<slug> node scripts/check-sync.mjs` checks that one instead of the
 * first in the list.
 */
export function pageUrl(base = 'http://localhost:5173/') {
  return process.env.SONG ? `${base}#${encodeURIComponent(process.env.SONG)}` : base;
}

/** Wait until the page reports the player ready. */
export async function waitForPlayer(page, timeout = 60000) {
  await page.waitForFunction(
    () => /Player loaded/.test(document.getElementById('status')?.textContent ?? ''),
    null,
    { timeout }
  );
}
