import * as alphaTab from '@coderline/alphatab';
import songs from 'virtual:songs';
import { VideoClock } from './media';
import { midiToAlphaTex, type TabResult } from './midi-tab';
import { barStartMs, gridSyncPoints, syncSafeTempo, type Grid } from './syncpoints';

// Per-song inputs, imported straight from songs/ (outside the Vite root, which
// is why vite.config.ts opens server.fs.allow). tab.mid is rewritten by the
// Ableton plugin on every save of the Live set; grid.lock.json is the beat map.
// The video is too big to import: plugins/media.ts serves it from the same
// directory at /media/<slug>/audio/video.mp4.
const midiUrls = import.meta.glob('../../songs/*/tab.mid', {
  query: '?url',
  import: 'default',
}) as Record<string, () => Promise<string>>;
const grids = import.meta.glob('../../songs/*/grid.lock.json', {
  import: 'default',
}) as Record<string, () => Promise<Grid>>;

const scoreEl = document.getElementById('score') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const songEl = document.getElementById('song') as HTMLSelectElement;
const videoEl = document.getElementById('video') as HTMLVideoElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const speedEl = document.getElementById('speed') as HTMLInputElement;
const speedOut = document.getElementById('speed-out') as HTMLOutputElement;
const themeBtn = document.getElementById('theme') as HTMLButtonElement;

// --- theme --------------------------------------------------------------------
// The page is themed by CSS variables, but alphaTab paints the notation in its
// own colours, so a theme change also re-renders the score with a palette
// that reads on that background.

const systemDark = matchMedia('(prefers-color-scheme: dark)');
const chosenTheme = () => document.documentElement.dataset.theme as 'light' | 'dark' | undefined;
const isDark = () => chosenTheme()?.startsWith('dark') ?? systemDark.matches;

function palette(dark: boolean): Partial<alphaTab.RenderingResources> {
  const C = alphaTab.model.Color;
  const ink = dark ? new C(236, 236, 240) : new C(0, 0, 0);
  return {
    mainGlyphColor: ink,
    // alphaTab draws secondary voices at 40% black, which is right for a
    // guitar counter-melody and wrong for drums: the feet are not a
    // background part, they are half of what is being played. Stems down
    // already distinguishes them.
    secondaryGlyphColor: ink,
    scoreInfoColor: ink,
    staffLineColor: dark ? new C(110, 110, 120) : new C(165, 165, 165),
    barSeparatorColor: dark ? new C(190, 190, 200) : new C(34, 34, 17),
    // Bar numbers are for finding your place, not for reading; keep them
    // out of the way of the notes.
    barNumberColor: dark ? new C(110, 110, 120) : new C(180, 180, 180),
  };
}

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
    // Draw every row up front. Lazy loading skips the row already in view
    // when the score is re-rendered for a theme change, and a song is only a
    // few dozen rows anyway.
    enableLazyLoading: false,
  },
  display: {
    // Four bars per line: the unit you practise in, and what the video overlay
    // will show N lines of.
    barsPerRow: 4,
    resources: palette(isDark()),
  },
  notation: {
    elements: new Map([
      // One track, and its name ("Drums") in the margin says nothing.
      [alphaTab.NotationElement.TrackNames, false],
      // The written tempo is a sync-friendly stand-in (see syncSafeTempo), not
      // the song's; the status line shows the drummer's real one.
      [alphaTab.NotationElement.EffectTempo, false],
    ]),
  },
  player: {
    // The video is the clock and the sound; alphaTab only draws the cursor
    // and owns the transport. No synth, so no soundfont.
    playerMode: alphaTab.PlayerMode.EnabledExternalMedia,
    enableCursor: true,
    enableUserInteraction: true,
    // Follow the cursor by scrolling the score box, not the page: the video
    // above it has to stay on screen.
    scrollElement: document.getElementById('score-box') as HTMLElement,
  },
});

function applyTheme(theme: 'light' | 'dark' | undefined) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const dark = isDark();
  themeBtn.textContent = dark ? '☀' : '☾';
  themeBtn.title = dark ? 'Switch to light' : 'Switch to dark';
  Object.assign(api.settings.display.resources, palette(dark));
  api.updateSettings();
  if (api.score) api.render();
}
themeBtn.addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  try {
    localStorage.setItem('theme', next);
  } catch {
    /* private mode: the choice lasts for this page */
  }
  applyTheme(next);
  themeBtn.blur();
});
// Nothing chosen: follow the system as it changes.
systemDark.addEventListener('change', () => {
  if (!chosenTheme()) applyTheme(undefined);
});
applyTheme(chosenTheme());

// alphaTab's external-media output has no idea what the media is; it calls
// play/pause/seek on whatever handler it is given and waits for positions to
// be pushed back. The video element plays that part.
const clock = new VideoClock(videoEl, {
  onPlayError: (err) => {
    api.pause();
    setStatus(`The browser refused to start the video: ${err}`, true);
  },
});
const attachClock = () => {
  const output = api.player?.output as alphaTab.synth.IExternalMediaSynthOutput | undefined;
  if (output && 'handler' in output) clock.attach(output);
};
attachClock();

let summary = '';
let rendered = '';
let playerLoaded = false;
// Render and player readiness arrive in either order (with external media the
// player is ready before the first row is drawn), so the status is composed
// rather than written by whichever event came last.
const showStatus = () => setStatus([summary, rendered, playerLoaded ? 'Player loaded.' : ''].filter(Boolean).join(' '));

// Handlers must be attached *before* api.tex(), which fires renderStarted
// synchronously -- otherwise the first event is missed.
api.renderStarted.on(() => {
  rendered = '';
  setStatus('Rendering…');
});

api.renderFinished.on(() => {
  const staff = api.score?.tracks[0]?.staves[0];
  rendered = staff ? `Rendered ${staff.bars.length} bars.` : 'Rendered.';
  showStatus();
});

api.error.on((error) => setStatus(`alphaTab error: ${error.message ?? error}`, true));

// Playback stays disabled until the player reports ready, so a click cannot
// silently no-op. (With external media that is immediate; the video itself
// buffers on demand.)
api.playerReady.on(() => {
  attachClock();
  playBtn.disabled = false;
  stopBtn.disabled = false;
  playerLoaded = true;
  showStatus();
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
  stop();
  stopBtn.blur();
});

// Stop means the top of the video, count-in included. alphaTab's own stop
// seeks to the score's tick 0, which is the first beat of bar 1, a couple of
// seconds in.
function stop() {
  api.stop();
  videoEl.currentTime = 0;
}

// The video has no native controls (they would bypass alphaTab's transport);
// a click on it is play/pause.
videoEl.addEventListener('click', () => {
  if (!playBtn.disabled) api.playPause();
});
// The score may be longer than the video (an unfinished beat map, or a tab
// with trailing bars); tell alphaTab when the media runs out.
videoEl.addEventListener('ended', () => api.pause());
videoEl.addEventListener('error', () => {
  const err = videoEl.error;
  setStatus(`Video failed to load (${videoEl.currentSrc}): ${err?.message || `code ${err?.code}`}`, true);
});

speedEl.addEventListener('input', () => {
  const percent = Number(speedEl.value);
  // Through alphaTab, never straight onto the element: alphaTab derives the
  // cursor animation speed from playbackSpeed and forwards it to the video.
  api.playbackSpeed = percent / 100;
  speedOut.textContent = `${percent}%`;
});

interface Loaded {
  slug: string;
  grid: Grid | undefined;
  syncPoints: alphaTab.model.FlatSyncPoint[];
  bars: number;
}
let current: Loaded | undefined;

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
    bpm: grid ? syncSafeTempo(grid.score.bpm) : 120,
    map: song.map,
    beatsPerBar: grid?.meter.beats_per_bar ?? 4,
    barCount: grid?.bar_count ?? 0,
  });
  const score = parseTex(tab.tex, tab.hiddenRests);
  const bars = score.masterBars.length;

  // Sync the score to the drummer before alphaTab generates its playback
  // model from it. Without a beat map the video would run against the
  // notation's constant tempo, and the cursor would drift off within bars.
  const syncPoints = grid ? gridSyncPoints(grid, bars) : [];
  if (syncPoints.length > 0) score.applyFlatSyncPoints(syncPoints);
  clock.floorMs = grid ? (barStartMs(grid, 0) ?? 0) : 0;
  clock.fallbackDurationMs = grid ? grid.source.audio_duration * 1000 : 0;
  current = { slug, grid, syncPoints, bars };

  const problems = [
    tab.unmapped.length ? `unmapped MIDI keys: ${tab.unmapped.join(', ')}` : '',
    tab.unknown.length ? `no articulation for: ${tab.unknown.join(', ')}` : '',
    !grid ? 'no grid.lock.json, cursor runs at the written tempo' : '',
    // applyFlatSyncPoints drops points past the last bar without a word, and
    // bars past the last point run at an extrapolated tempo. Either way the
    // cursor quietly parts from the drummer, so say so.
    grid && bars !== grid.bar_count ? `notation has ${bars} bars, beat map has ${grid.bar_count}` : '',
  ].filter(Boolean);
  const tempo = grid ? `${Math.round(grid.score.bpm)} BPM, ` : '';
  summary = `${tempo}${tab.notes} notes, ${syncPoints.length} sync points.` + (problems.length ? ` ${problems.join('; ')}.` : '');

  videoEl.src = `/media/${encodeURIComponent(slug)}/audio/video.mp4`;
  api.renderScore(score);
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
  (window as unknown as { drums: unknown }).drums = {
    api,
    load,
    stop,
    songs: playable,
    midiToAlphaTex,
    video: videoEl,
    get current() {
      return current;
    },
  };
}

void load(songEl.value);
