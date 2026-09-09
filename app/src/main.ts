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

function setStatus(text: string, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#c0392b' : '';
}

// Surface failures in the page, not only the devtools console -- otherwise a
// broken init just looks like a page stuck on its initial message.
window.addEventListener('error', (e) => setStatus(`Script error: ${e.message}`, true));
window.addEventListener('unhandledrejection', (e) =>
  setStatus(`Unhandled rejection: ${e.reason}`, true)
);

const api = new alphaTab.AlphaTabApi(scoreEl, {
  core: {
    tex: true,
    // alphaTab derives its font path from its own script URL. In Vite dev mode
    // that is the pre-bundled dep under /node_modules/.vite/deps/, so it looks
    // for /node_modules/.vite/deps/font/Bravura.woff2, gets index.html back
    // from the dev-server fallback, and fails to decode it ("invalid
    // sfntVersion" == the ASCII of "<!DO"). Rendering then never starts.
    // The vite plugin copies the fonts to <root>/font/ but does not point
    // alphaTab at them, so we do it here.
    fontDirectory: '/font/',
  },
  player: {
    // `enablePlayer` is deprecated in favour of `playerMode`.
    playerMode: alphaTab.PlayerMode.EnabledAutomatic,
    // Required: soundFont defaults to null and the vite plugin does not set it,
    // it only copies the file into /public. Without this the synth never loads
    // and `playerReady` never fires.
    soundFont: '/soundfont/sonivox.sf3',
    enableCursor: true,
    enableUserInteraction: true,
  },
});

// Handlers must be attached *before* api.tex(), which fires renderStarted
// synchronously -- otherwise the first event is missed.
api.renderStarted.on(() => setStatus('Rendering…'));

api.renderFinished.on(() => {
  const staff = api.score?.tracks[0]?.staves[0];
  setStatus(
    staff
      ? `Rendered ${staff.bars.length} bars (percussion=${staff.isPercussion}). Loading soundfont…`
      : 'Rendered.'
  );
});

api.error.on((error) => setStatus(`alphaTab error: ${error.message ?? error}`, true));

// The soundfont loads asynchronously; playback stays disabled until the synth
// reports ready, so a click cannot silently no-op.
api.playerReady.on(() => {
  playBtn.disabled = false;
  stopBtn.disabled = false;
  const staff = api.score?.tracks[0]?.staves[0];
  setStatus(`Ready — ${staff?.bars.length ?? 0} bars, player loaded.`);
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

api.tex(tex);

if (import.meta.hot) {
  import.meta.hot.accept('../fixtures/demo.alphatex?raw', (mod) => {
    if (mod) api.tex((mod as unknown as { default: string }).default);
  });
}
