import * as alphaTab from '@coderline/alphatab';
// Every emitted score, loaded as raw text so the .alphatex files stay the
// editable source of truth. The glob reaches outside the Vite root into
// songs/, which is why vite.config.ts opens server.fs.allow.
//
// Lazy, not eager: a hundred-bar score is a few hundred KB of text and there is
// no reason to ship all of them to load one. Saving a .alphatex triggers a full
// page reload rather than a hot swap -- the selected song lives in the URL hash,
// so a reload lands back on the same score.
import demoTex from '../fixtures/demo.alphatex?raw';

const scoreModules = import.meta.glob('../../songs/*/song.alphatex', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const scoreEl = document.getElementById('score') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const songEl = document.getElementById('song') as HTMLSelectElement;
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

// '../../songs/<slug>/song.alphatex' -> '<slug>'
const slugOf = (path: string) => path.split('/').slice(-2)[0] ?? path;
const songs = Object.keys(scoreModules).sort();

for (const path of songs) {
  songEl.add(new Option(slugOf(path), path));
}
if (songs.length === 0) {
  songEl.add(new Option('Phase 0 demo (no transcriptions yet)', ''));
  songEl.disabled = true;
}

// The hash is the song selector: it survives the full reload that saving a
// .alphatex triggers, and it makes a particular song a link.
const fromHash = songs.find((path) => slugOf(path) === decodeURIComponent(location.hash.slice(1)));
songEl.value = fromHash ?? songs[0] ?? '';
if (songEl.value) location.hash = encodeURIComponent(slugOf(songEl.value));

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
  display: {
    resources: {
      // alphaTab draws secondary voices at 40% black, which is right for a
      // guitar counter-melody and wrong for drums: the feet are not a
      // background part, they are half of what is being played. Stems down
      // already distinguishes them.
      secondaryGlyphColor: new alphaTab.model.Color(0, 0, 0),
    },
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
  const tempo = api.score?.tempo ?? 0;
  setStatus(`Ready — ${staff?.bars.length ?? 0} bars at ${tempo} BPM, player loaded.`);
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

async function load(path: string) {
  playBtn.disabled = true;
  stopBtn.disabled = true;
  api.stop();
  const load_ = scoreModules[path];
  if (!load_) {
    api.tex(demoTex);
    return;
  }
  setStatus(`Loading ${slugOf(path)}…`);
  api.tex(await load_());
}

songEl.addEventListener('change', () => {
  location.hash = encodeURIComponent(slugOf(songEl.value));
  void load(songEl.value);
});
window.addEventListener('hashchange', () => {
  const path = songs.find((p) => slugOf(p) === decodeURIComponent(location.hash.slice(1)));
  if (path && path !== songEl.value) {
    songEl.value = path;
    void load(path);
  }
});

// Handle for the headless checks in scripts/ -- they drive playback and read
// the position back, which is the only way to verify the player from outside.
if (import.meta.env.DEV) {
  (window as unknown as { drums: unknown }).drums = { api, load, songs };
}

void load(songEl.value);
