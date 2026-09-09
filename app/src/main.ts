import * as alphaTab from '@coderline/alphatab';
// Loaded as raw text so the .alphatex file stays the editable source of truth.
// Vite hot-reloads this module when the file changes on disk.
import tex from '../fixtures/demo.alphatex?raw';

const scoreEl = document.getElementById('score') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const speedEl = document.getElementById('speed') as HTMLInputElement;
const speedOut = document.getElementById('speed-out') as HTMLOutputElement;
const metroEl = document.getElementById('metronome') as HTMLInputElement;
const metroOut = document.getElementById('metronome-out') as HTMLOutputElement;

const api = new alphaTab.AlphaTabApi(scoreEl, {
  core: { tex: true },
  player: {
    // The vite plugin resolves these asset paths; don't hand-write them.
    enablePlayer: true,
    enableCursor: true,
    enableUserInteraction: true,
  },
});

api.tex(tex);

api.renderStarted.on(() => {
  statusEl.textContent = 'Rendering…';
});

api.renderFinished.on(() => {
  const staff = api.score?.tracks[0]?.staves[0];
  statusEl.textContent = staff
    ? `Rendered ${staff.bars.length} bars, percussion=${staff.isPercussion}.`
    : 'Rendered.';
});

api.error.on((error) => {
  statusEl.textContent = `alphaTab error: ${error.message ?? error}`;
});

// The soundfont loads asynchronously; playback controls stay disabled until the
// synth reports it is ready, so a click can't silently no-op.
api.playerReady.on(() => {
  playBtn.disabled = false;
  stopBtn.disabled = false;
  statusEl.textContent = `${statusEl.textContent} Player ready.`;
});

api.playerStateChanged.on((e) => {
  playBtn.textContent = e.state === alphaTab.synth.PlayerState.Playing ? 'Pause' : 'Play';
});

playBtn.addEventListener('click', () => api.playPause());
stopBtn.addEventListener('click', () => api.stop());

speedEl.addEventListener('input', () => {
  const percent = Number(speedEl.value);
  api.playbackSpeed = percent / 100;
  speedOut.textContent = `${percent}%`;
});

metroEl.addEventListener('input', () => {
  const percent = Number(metroEl.value);
  api.metronomeVolume = percent / 100;
  metroOut.textContent = percent === 0 ? 'off' : `${percent}%`;
});

if (import.meta.hot) {
  import.meta.hot.accept('../fixtures/demo.alphatex?raw', (mod) => {
    if (mod) api.tex((mod as unknown as { default: string }).default);
  });
}
