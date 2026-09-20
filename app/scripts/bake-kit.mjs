// Bake one-shot drum samples out of alphaTab's bundled soundfont.
//
// The app plays an exercise's notes from a bank of one-shots booked on the
// audio clock (src/kit.ts) -- which is a sampler, and is the shape the user's
// own sampler will slot into. This is where today's bank comes from.
//
// Why bake rather than synthesise live: alphaTab's synthesizer only makes
// sound when alphaTab owns the transport, and it does not -- the page runs in
// PlayerMode.EnabledExternalMedia from end to end so that one clock, one set
// of sync points and one scorer serve both a song and an exercise (see
// src/clock.ts). `api.exportAudio` is the way out: it is documented to work
// with any player mode, renders offline through the synthesizer, and takes the
// soundfont explicitly. So the drums are reachable as PCM without giving
// alphaTab the transport back.
//
// One bar per articulation at 60 BPM, so every sample has four seconds to ring
// before the next one starts. The result is written to `kit/samples/`, at the
// repo root beside `kit.toml` -- `kit.toml` says what your kit *is*, and this
// is what it sounds like. Not `app/public/`, which is gitignored and rebuilt
// by the alphaTab vite plugin on every `npm run dev`.
//
// Usage: node scripts/bake-kit.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, pageUrl, waitForPlayer } from './browser.mjs';

/** Seconds a bar lasts at the tempo below: long enough for a crash to decay. */
const BAR_S = 4;
/**
 * How far before the bar line to start reading.
 *
 * The synthesizer starts a note a hair before the beat it is written on, so
 * slicing at the bar line exactly would shave the front off every attack --
 * which on a drum is most of what it sounds like.
 */
const LEAD_S = 0.12;
/**
 * ...and how far before the *next* bar line to stop.
 *
 * The same early start, seen from the other side: without this guard the end
 * of every window catches the next drum, the trim finds no silence to cut back
 * to, and each sample comes out a full bar long with somebody else's attack on
 * the end of it.
 */
const GUARD_S = 0.25;
/** Anything quieter than this much of the peak is the tail, and is cut. */
const FLOOR = 0.004;
/** A short fade at the cut, so trimming cannot leave a click of its own. */
const FADE_S = 0.01;

const out = fileURLToPath(new URL('../../kit/samples', import.meta.url));
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(pageUrl());
await waitForPlayer(page);
await page.waitForTimeout(1500);

console.log('rendering the kit through the soundfont…');
const baked = await page.evaluate(
  async ({ BAR_S, LEAD_S, GUARD_S, FLOOR, FADE_S }) => {
    const d = window.drums;
    const api = d.api;
    const names = Object.keys(d.articulations);
    // One note per bar, on the downbeat. `hitsToAlphaTex` is the same engraver
    // the page uses, so an articulation that would not render is an
    // articulation that is not in the app either.
    const hits = names.map((instrument, bar) => ({ slot: bar * 16, instrument, velocity: 110 }));
    const tab = d.hitsToAlphaTex(hits, {
      title: 'kit',
      bpm: 60,
      map: {},
      beatsPerBar: 4,
      barCount: names.length,
    });
    const score = d.parseTex(tab.tex, tab.hiddenRests);
    await new Promise((resolve) => {
      const done = api.renderFinished.on(() => {
        done();
        resolve();
      });
      api.renderScore(score);
    });

    const sf = new Uint8Array(await (await fetch('/soundfont/sonivox.sf3')).arrayBuffer());
    const rate = 44100;
    const exporter = await api.exportAudio({
      soundFonts: [sf],
      sampleRate: rate,
      // The score is written at a flat 60 BPM and has no sync points; asking
      // for them back would only reintroduce a song's timing to a bank of
      // one-shots.
      useSyncPoints: false,
      masterVolume: 1,
      metronomeVolume: 0,
      trackVolume: new Map(),
      trackTranspositionPitches: new Map(),
    });

    // Interleaved stereo, folded to mono on the way in: a one-shot is a sound,
    // not a placement, and the page puts it where it goes.
    const frames = [];
    for (;;) {
      const chunk = await exporter.render(1000);
      if (!chunk) break;
      const s = chunk.samples;
      for (let i = 0; i + 1 < s.length; i += 2) frames.push((s[i] + s[i + 1]) / 2);
      if (frames.length > rate * BAR_S * (names.length + 2)) break;
    }
    exporter.destroy?.();

    const result = [];
    for (let i = 0; i < names.length; i++) {
      const window_ = frames.slice(
        Math.max(0, Math.round((i * BAR_S - LEAD_S) * rate)),
        Math.round(((i + 1) * BAR_S - GUARD_S) * rate)
      );
      let peak = 0;
      for (const v of window_) peak = Math.max(peak, Math.abs(v));
      if (peak === 0) {
        result.push({ name: names[i], silent: true });
        continue;
      }
      // Trim to the sound: from the first sample that is not silence to the
      // last, then fade the cut so the end of the file is not a step.
      const floor = peak * FLOOR;
      let from = 0;
      while (from < window_.length && Math.abs(window_[from]) < floor) from++;
      let to = window_.length - 1;
      while (to > from && Math.abs(window_[to]) < floor) to--;
      const cut = window_.slice(from, to + 1);
      const fade = Math.min(Math.round(FADE_S * rate), cut.length);
      for (let j = 0; j < fade; j++) cut[cut.length - fade + j] *= 1 - j / fade;

      // 16-bit PCM mono, the plainest thing decodeAudioData will take.
      const pcm = new Int16Array(cut.length);
      for (let j = 0; j < cut.length; j++) {
        pcm[j] = Math.max(-1, Math.min(1, cut[j])) * 0x7fff;
      }
      const header = new DataView(new ArrayBuffer(44));
      const put = (off, text) => {
        for (let j = 0; j < text.length; j++) header.setUint8(off + j, text.charCodeAt(j));
      };
      put(0, 'RIFF');
      header.setUint32(4, 36 + pcm.byteLength, true);
      put(8, 'WAVEfmt ');
      header.setUint32(16, 16, true);
      header.setUint16(20, 1, true);
      header.setUint16(22, 1, true);
      header.setUint32(24, rate, true);
      header.setUint32(28, rate * 2, true);
      header.setUint16(32, 2, true);
      header.setUint16(34, 16, true);
      put(36, 'data');
      header.setUint32(40, pcm.byteLength, true);

      const bytes = new Uint8Array(44 + pcm.byteLength);
      bytes.set(new Uint8Array(header.buffer), 0);
      bytes.set(new Uint8Array(pcm.buffer), 44);
      let binary = '';
      for (let j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
      result.push({
        name: names[i],
        seconds: Math.round((cut.length / rate) * 1000) / 1000,
        peak: Math.round(peak * 1000) / 1000,
        wav: btoa(binary),
      });
    }
    return result;
  },
  { BAR_S, LEAD_S, GUARD_S, FLOOR, FADE_S }
);

mkdirSync(out, { recursive: true });
const silent = [];
for (const sample of baked) {
  if (sample.silent) {
    silent.push(sample.name);
    continue;
  }
  const bytes = Buffer.from(sample.wav, 'base64');
  writeFileSync(join(out, `${sample.name}.wav`), bytes);
  console.log(`  ${sample.name.padEnd(14)} ${String(sample.seconds).padStart(6)}s  peak ${sample.peak}  ${(bytes.length / 1024).toFixed(0)} KB`);
}
if (silent.length) console.log(`\nno sound for: ${silent.join(', ')} -- the soundfont has no such drum`);
if (errors.length) console.log(`\npage errors: ${errors.join(' | ')}`);
console.log(`\n${baked.length - silent.length} samples -> kit/samples/`);
await browser.close();
process.exit(silent.length || errors.length ? 1 : 0);
