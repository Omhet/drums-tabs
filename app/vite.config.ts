import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { alphaTab } from '@coderline/alphatab-vite';

const songsDir = fileURLToPath(new URL('../songs', import.meta.url));

// Vite's watcher only covers its root, which is app/. The scores live outside
// it, in songs/, so without this a re-run of the pipeline changes nothing in
// the browser until the dev server is restarted -- and worse, a *newly*
// transcribed song never appears in the picker, because the import.meta.glob
// that builds it is only re-evaluated when one of its files changes.
function watchSongs(): Plugin {
  return {
    name: 'drums-watch-songs',
    configureServer(server) {
      server.watcher.add(songsDir);
    },
  };
}

// The alphaTab plugin copies the music fonts, soundfont and audio worklets into
// the bundle. Wiring those asset paths by hand is the most common way an
// alphaTab setup fails, so let the official plugin own it.
export default defineConfig({
  plugins: [alphaTab(), watchSongs()],
  server: {
    port: 5173,
    // The scores live in songs/, outside the Vite root, and are imported
    // straight from there so that editing one is the whole edit loop.
    fs: { allow: ['..'] },
  },
});
