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

/** The song a check opens unless told otherwise: the first in the library. */
export const FIRST_SONG = 'arctic-monkeys-one-for-the-road-official-video';

/**
 * The page, on a particular song: the hash is the song, so
 * `SONG=<slug> node scripts/check-sync.mjs` checks that one instead of the
 * first in the library. (No hash at all is the library, which has no player.)
 */
export function pageUrl(base = 'http://localhost:5173/') {
  return `${base}#${encodeURIComponent(process.env.SONG || FIRST_SONG)}`;
}

/**
 * Wait until the page says a song is ready: engraved, and the player able to
 * play it. main.ts puts the song's slug on `<html data-ready>` when it is, and
 * takes it off when another song starts loading -- so `slug` waits for that
 * particular song, which is what a check that has just changed songs needs.
 */
export async function waitForPlayer(page, slug = undefined, timeout = 60000) {
  await page.waitForFunction(
    (want) => {
      const ready = document.documentElement.dataset.ready;
      return want ? ready === want : !!ready;
    },
    slug,
    { timeout }
  );
}
