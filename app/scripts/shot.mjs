// Screenshot the loaded page and print a sample of the generated alphaTex.
import { launch, pageUrl, waitForPlayer } from './browser.mjs';
const out = process.argv[2];
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.goto(pageUrl());
await waitForPlayer(page);
// Wait for the notation to be engraved, and for the picture (when there is
// one) to have a frame to show, so the shot is not of an empty stage.
await page
  .waitForFunction(() => document.querySelectorAll('#score svg').length > 0, null, { timeout: 30000 })
  .catch(() => {});
await page
  .waitForFunction(() => !window.drums.current?.video || window.drums.mixer.picture.el.readyState >= 2, null, { timeout: 30000 })
  .catch(() => {});
await page.screenshot({ path: out, fullPage: false });
const tex = await page.evaluate(async () => {
  const d = window.drums; const s = d.songs[0];
  const r = await fetch(location.origin + '/@fs/C:/Users/omhet/Code/Music/drums-tabs/songs/' + s.slug + '/tab.mid');
  const bytes = new Uint8Array(await r.arrayBuffer());
  return d.midiToAlphaTex(bytes, { title: s.title, bpm: 91, map: s.map, beatsPerBar: 4, barCount: 62 }).tex;
});
console.log(tex.split('\n').slice(0, 11).join('\n'));
console.log('...');
console.log(tex.split('\n').filter(l => /^\/\* (1|13|14|15|16|23|41|42) \*\//.test(l)).join('\n'));
await browser.close();
