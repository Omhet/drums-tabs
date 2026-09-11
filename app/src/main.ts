import * as alphaTab from '@coderline/alphatab';
import songs from 'virtual:songs';
import { midiToAlphaTex, type TabResult } from './midi-tab';

// Per-song inputs, imported straight from songs/ (outside the Vite root, which
// is why vite.config.ts opens server.fs.allow). tab.mid is rewritten by the
// Ableton plugin on every save of the Live set; grid.lock.json is the beat map.
const midiUrls = import.meta.glob('../../songs/*/tab.mid', {
  query: '?url',
  import: 'default',
}) as Record<string, () => Promise<string>>;
const grids = import.meta.glob('../../songs/*/grid.lock.json', {
  import: 'default',
}) as Record<string, () => Promise<Grid>>;

interface Grid {
  meter: { beats_per_bar: number; beat_unit: number };
  bar_one_beat: number;
  bar_count: number;
  score: { bpm: number };
  beats: number[];
}

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

// '../../songs/<slug>/tab.mid' -> '<slug>'
const slugOf = (path: string) => path.split('/').slice(-2)[0] ?? path;
const midiBySlug = new Map(Object.entries(midiUrls).map(([p, l]) => [slugOf(p), l]));
const gridBySlug = new Map(Object.entries(grids).map(([p, l]) => [slugOf(p), l]));
const playable = songs.filter((s) => midiBySlug.has(s.slug));

for (const song of playable) {
  songEl.add(new Option(song.title, song.slug));
}
if (playable.length === 0) {
  songEl.add(new Option('No songs with a tab.mid yet', ''));
  songEl.disabled = true;
}

// The hash is the song selector: it survives the full reload that a save in
// Ableton triggers, and it makes a particular song a link.
const fromHash = playable.find((s) => s.slug === decodeURIComponent(location.hash.slice(1)));
songEl.value = fromHash?.slug ?? playable[0]?.slug ?? '';
if (songEl.value) location.hash = encodeURIComponent(songEl.value);

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
    // Four bars per line: the unit you practise in, and what the video overlay
    // will show N lines of.
    barsPerRow: 4,
    resources: {
      // alphaTab draws secondary voices at 40% black, which is right for a
      // guitar counter-melody and wrong for drums: the feet are not a
      // background part, they are half of what is being played. Stems down
      // already distinguishes them.
      secondaryGlyphColor: new alphaTab.model.Color(0, 0, 0),
      // Bar numbers are for finding your place, not for reading; keep them
      // out of the way of the notes.
      barNumberColor: new alphaTab.model.Color(180, 180, 180),
    },
  },
  notation: {
    // One track, and its name ("Drums") in the margin says nothing.
    elements: new Map([[alphaTab.NotationElement.TrackNames, false]]),
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

let summary = '';

// Handlers must be attached *before* api.tex(), which fires renderStarted
// synchronously -- otherwise the first event is missed.
api.renderStarted.on(() => setStatus('Rendering…'));

api.renderFinished.on(() => {
  const staff = api.score?.tracks[0]?.staves[0];
  setStatus(staff ? `${summary} Rendered ${staff.bars.length} bars. Loading soundfont…` : 'Rendered.');
});

api.error.on((error) => setStatus(`alphaTab error: ${error.message ?? error}`, true));

// The soundfont loads asynchronously; playback stays disabled until the synth
// reports ready, so a click cannot silently no-op.
api.playerReady.on(() => {
  playBtn.disabled = false;
  stopBtn.disabled = false;
  const tempo = api.score?.tempo ?? 0;
  setStatus(`${summary} ${tempo} BPM, player loaded.`);
});

api.playerStateChanged.on((e) => {
  playBtn.textContent = e.state === alphaTab.synth.PlayerState.Playing ? 'Pause' : 'Play';
});

// Blur after a click so a following Space toggles playback once, not twice
// (the focused button would fire its own click on the same key).
playBtn.addEventListener('click', () => {
  api.playPause();
  playBtn.blur();
});
stopBtn.addEventListener('click', () => {
  api.stop();
  stopBtn.blur();
});

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

async function load(slug: string) {
  playBtn.disabled = true;
  stopBtn.disabled = true;
  api.stop();
  const song = playable.find((s) => s.slug === slug);
  const midiUrl = midiBySlug.get(slug);
  if (!song || !midiUrl) {
    setStatus('No song selected.');
    return;
  }
  setStatus(`Loading ${song.title}…`);
  const [url, grid] = await Promise.all([midiUrl(), gridBySlug.get(slug)?.()]);
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const tab = midiToAlphaTex(bytes, {
    title: song.title,
    bpm: grid ? Math.round(grid.score.bpm) : 120,
    map: song.map,
    beatsPerBar: grid?.meter.beats_per_bar ?? 4,
    barCount: grid?.bar_count ?? 0,
  });
  const problems = [
    tab.unmapped.length ? `unmapped MIDI keys: ${tab.unmapped.join(', ')}` : '',
    tab.unknown.length ? `no articulation for: ${tab.unknown.join(', ')}` : '',
  ].filter(Boolean);
  summary = `${tab.notes} notes.` + (problems.length ? ` ${problems.join('; ')}.` : '');
  api.renderScore(parseTex(tab.tex, tab.hiddenRests));
}

// alphaTex cannot mark a rest as hidden, so the converter says which rests are
// noise and we flag them as empty beats on the parsed score: the time is kept,
// nothing is drawn. (alphaTab would otherwise push every feet rest above the
// staff, because a hands note sits on the same beat.)
function parseTex(tex: string, hiddenRests: TabResult['hiddenRests']): alphaTab.model.Score {
  const importer = new alphaTab.importer.AlphaTexImporter();
  importer.initFromString(tex, api.settings);
  const score = importer.readScore();
  const bars = score.tracks[0]?.staves[0]?.bars ?? [];
  for (const { bar, voice, beat } of hiddenRests) {
    const target = bars[bar]?.voices[voice]?.beats[beat];
    if (target?.isRest) target.isEmpty = true;
  }
  return score;
}

// The percussion clef (two bars at the start of every line) is the one glyph
// alphaTab cannot switch off, and it is meaningless on a one-staff drum chart.
// It renders as the Bravura character U+E069 in a <text> element; hide those
// as they appear (alphaTab adds rows to the DOM lazily while you scroll).
const CLEF_GLYPH = '\uE069';
new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!(node instanceof Element)) continue;
      for (const text of node.querySelectorAll('text')) {
        if (text.textContent === CLEF_GLYPH) (text as SVGElement).style.display = 'none';
      }
    }
  }
}).observe(scoreEl, { childList: true, subtree: true });

// Space toggles playback from anywhere except a control that uses it itself.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  const target = e.target as HTMLElement | null;
  if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
  e.preventDefault();
  if (!playBtn.disabled) api.playPause();
});

songEl.addEventListener('change', () => {
  location.hash = encodeURIComponent(songEl.value);
  void load(songEl.value);
});
window.addEventListener('hashchange', () => {
  const slug = decodeURIComponent(location.hash.slice(1));
  if (slug !== songEl.value && playable.some((s) => s.slug === slug)) {
    songEl.value = slug;
    void load(slug);
  }
});

// Handle for the headless checks in scripts/ -- they drive playback and read
// the position back, which is the only way to verify the player from outside.
if (import.meta.env.DEV) {
  (window as unknown as { drums: unknown }).drums = { api, load, songs: playable, midiToAlphaTex };
}

void load(songEl.value);
