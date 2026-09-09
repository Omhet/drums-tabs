import { defineConfig } from 'vite';
import { alphaTab } from '@coderline/alphatab-vite';

// The alphaTab plugin copies the music fonts, soundfont and audio worklets into
// the bundle. Wiring those asset paths by hand is the most common way an
// alphaTab setup fails, so let the official plugin own it.
export default defineConfig({
  plugins: [alphaTab()],
  server: { port: 5173 },
});
