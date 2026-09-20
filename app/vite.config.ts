import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { alphaTab } from '@coderline/alphatab-vite';
import { abletonTabs } from './plugins/ableton.ts';
import { untrackedFiles } from './plugins/media.ts';
import { practice } from './plugins/practice.ts';

const songsDir = fileURLToPath(new URL('../songs', import.meta.url));
const kitDir = fileURLToPath(new URL('../kit', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// The alphaTab plugin copies the music fonts, soundfont and audio worklets into
// the bundle. Wiring those asset paths by hand is the most common way an
// alphaTab setup fails, so let the official plugin own it.
//
// The Ableton plugin owns everything under songs/: it turns each saved Live set
// into tab.mid, serves the song catalogue as `virtual:songs`, and reloads the
// page when either changes. The media plugin serves what is untracked and
// outside the root -- the video and stems at /media/<slug>/..., and the
// sampler's bank at /kit/samples/... -- with range requests so the browser
// can seek.
export default defineConfig({
  plugins: [
    alphaTab(),
    abletonTabs(songsDir),
    untrackedFiles({ '/media/': songsDir, '/kit/': kitDir }),
    practice(songsDir, repoRoot),
  ],
  server: {
    port: 5173,
    // The tabs and beat maps live in songs/, outside the Vite root, and are
    // imported straight from there.
    fs: { allow: ['..'] },
  },
});
