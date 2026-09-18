import * as alphaTab from '@coderline/alphatab';
import songs from 'virtual:songs';
import { say } from './icons';
import { MixClock } from './media';
import { midiToAlphaTex, type TabResult } from './midi-tab';
import { FADERS, Mixer, type Fader } from './mixer';
import { Practice, readPracticeSong } from './practice';
import type { ReferenceLock } from './reference';
import { ScoreWindow, barAtTick, type Lines } from './score-window';
import { StickingLetters, chartHash, type StickingLock } from './sticking';
import { barStartMs, gridSyncPoints, syncSafeTempo, type Grid } from './syncpoints';

// Per-song inputs, imported straight from songs/ (outside the Vite root, which
// is why vite.config.ts opens server.fs.allow). tab.mid is rewritten by the
// Ableton plugin on every save of the Live set; grid.lock.json is the beat map.
// The audio is far too big to import: plugins/media.ts serves it from the same
// directory at /media/<slug>/audio/mix.wav (and the video, when there is one).
const midiUrls = import.meta.glob('../../songs/*/tab.mid', {
  query: '?url',
  import: 'default',
}) as Record<string, () => Promise<string>>;
const grids = import.meta.glob('../../songs/*/grid.lock.json', {
  import: 'default',
}) as Record<string, () => Promise<Grid>>;
const stickings = import.meta.glob('../../songs/*/sticking.lock.json', {
  import: 'default',
}) as Record<string, () => Promise<StickingLock>>;
// How far behind the written grid the record itself plays, so a take's timing
// can be read against the record's feel rather than against the grid
// (reference.ts). Absent for a song `drums reference` has not been run on.
const references = import.meta.glob('../../songs/*/reference.lock.json', {
  import: 'default',
}) as Record<string, () => Promise<ReferenceLock>>;

const scoreEl = document.getElementById('score') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const songEl = document.getElementById('song') as HTMLSelectElement;
const stageEl = document.getElementById('stage') as HTMLElement;
const mixEl = document.getElementById('mix') as HTMLAudioElement;
const videoEl = document.getElementById('video') as HTMLVideoElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const speedEl = document.getElementById('speed') as HTMLInputElement;
const speedOut = document.getElementById('speed-out') as HTMLOutputElement;
const linesEl = document.getElementById('lines') as HTMLSelectElement;
const stickingEl = document.getElementById('sticking') as HTMLInputElement;
const themeBtn = document.getElementById('theme') as HTMLButtonElement;
const tabThemeBtn = document.getElementById('tab-theme') as HTMLButtonElement;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// --- themes -------------------------------------------------------------------
// Two of them, and they do not have to agree: the chrome is one thing to look
// at and the notation is another, and a dark room wants a dark page with the
// notes still on white paper. Both are CSS variables (--* and --tab-*), but
// alphaTab paints the notes in its own colours, so only the notation's theme
// re-renders the score.

const systemDark = matchMedia('(prefers-color-scheme: dark)');
const chosenTheme = () => document.documentElement.dataset.theme as 'light' | 'dark' | undefined;
const isDark = () => chosenTheme()?.startsWith('dark') ?? systemDark.matches;
// Nothing chosen for the notation means it follows the chrome, which is what
// the stylesheet's :root:not([data-tab-theme]) block does for the CSS half.
const chosenTabTheme = () =>
  document.documentElement.dataset.tabTheme as 'light' | 'dark' | undefined;
const isTabDark = () => chosenTabTheme()?.startsWith('dark') ?? isDark();

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
  // One line with an ellipsis; the tooltip has all of it.
  statusEl.title = text;
  statusEl.classList.toggle('err', isError);
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
const stickingBySlug = new Map(Object.entries(stickings).map(([p, l]) => [slugOf(p), l]));
const referenceBySlug = new Map(Object.entries(references).map(([p, l]) => [slugOf(p), l]));
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

// --- zoom ---------------------------------------------------------------------
// How big the notes are: +/- step the ladder, 0 goes back to 100%.
//
// Size and room are one control here, not two. alphaTab's `scale` grows the
// glyphs but not the page, and a row is stretched to the width it is given
// either way -- so at 2x the noteheads would be twice the size with the same
// pixels to share, and a bar of sixteenths would run into itself. Dropping
// bars-per-row as the scale climbs keeps roughly the density four bars have at
// 100%, which is what "bigger notes" has to mean to be worth reading. Below
// 100% the row stays at four: the phrase you practise in is four bars, and
// there is no crowding left to relieve.
const ZOOM_STEPS = [0.6, 0.7, 0.85, 1, 1.2, 1.4, 1.7, 2];
/** Which rung is 100%. */
const ZOOM_HOME = ZOOM_STEPS.indexOf(1);
/** Bars on a line at 100%: the unit you practise in. */
const BARS_PER_ROW = 4;
const barsAtZoom = (scale: number) =>
  Math.max(1, Math.min(BARS_PER_ROW, Math.round(BARS_PER_ROW / scale)));

/** The remembered rung; anything that is not one of them is 100%. */
function savedZoom(): number {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem('zoom');
  } catch {
    /* private mode: there is nothing remembered */
  }
  const step = ZOOM_STEPS.indexOf(Number(raw));
  return step < 0 ? ZOOM_HOME : step;
}
let zoomStep = savedZoom();

/**
 * Engrave at rung `step`.
 *
 * Costs a full re-render, like a theme change, and like a theme change it
 * leaves the transport alone. The notation window re-measures itself
 * afterwards (postRenderFinished), so N lines stays N lines -- taller ones,
 * which the picture above them gives up the room for.
 */
function applyZoom(step: number) {
  zoomStep = Math.max(0, Math.min(ZOOM_STEPS.length - 1, step));
  const scale = ZOOM_STEPS[zoomStep]!;
  // The overlays are our own pixels, not alphaTab's: the sticking letters and
  // the extras lane read this to grow with the notes they belong to.
  scoreEl.style.setProperty('--tab-zoom', String(scale));
  const bars = barsAtZoom(scale);
  if (scale === api.settings.display.scale && bars === api.settings.display.barsPerRow) return;
  api.settings.display.scale = scale;
  api.settings.display.barsPerRow = bars;
  api.updateSettings();
  if (api.score) api.render();
}

/** Step the ladder from the keyboard, and remember where it lands. */
function setZoom(step: number) {
  applyZoom(step);
  remember('zoom', String(ZOOM_STEPS[zoomStep]));
}

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
    // Four bars per line at 100%, and what the window over the video shows N
    // lines of. Both of these are the zoom's to move; they are set here rather
    // than after construction so that a remembered zoom is engraved once, the
    // same way a remembered rail width is.
    barsPerRow: barsAtZoom(ZOOM_STEPS[zoomStep]!),
    scale: ZOOM_STEPS[zoomStep]!,
    resources: palette(isDark()),
  },
  notation: {
    elements: new Map([
      // One track, and its name ("Drums") in the margin says nothing.
      [alphaTab.NotationElement.TrackNames, false],
      // The song's title is in the song selector; in the window over the
      // video it would only take a line from the notes.
      [alphaTab.NotationElement.ScoreTitle, false],
      // The written tempo is a sync-friendly stand-in (see syncSafeTempo), not
      // the song's; the status line shows the drummer's real one.
      [alphaTab.NotationElement.EffectTempo, false],
    ]),
  },
  player: {
    // The mix is the clock and the sound; alphaTab only draws the cursor
    // and owns the transport. No synth, so no soundfont.
    playerMode: alphaTab.PlayerMode.EnabledExternalMedia,
    enableCursor: true,
    enableUserInteraction: true,
    // The notation window (score-window.ts) does the following: a whole
    // line at a time, the line being played on top. alphaTab's own smooth
    // scroll would fight it.
    scrollMode: alphaTab.ScrollMode.Off,
  },
});

// The settings above were already built at the remembered zoom; this only
// publishes it to the overlays, and re-renders nothing.
applyZoom(zoomStep);

// --- the notation window ------------------------------------------------------
// N lines of the score under the picture, the picture taking what is left --
// or, on Fill, the notation taking what is left and the picture keeping a
// strip. A chosen number is remembered like the theme; with nothing remembered
// each song gets the default its media implies (see `load`).

const scoreWindow = new ScoreWindow(api, document.getElementById('score-box') as HTMLElement);
function applyLines(lines: Lines) {
  linesEl.value = String(lines);
  scoreWindow.lines = lines;
  // Which of the two panes grows. ScoreWindow puts `fit` on the box itself
  // (it stops setting a pixel height); this is the other half of the same
  // decision, and the stage is where both panes can be reached from.
  stageEl.classList.toggle('fill', lines === 'fit');
}
/** The remembered choice, if there is one that still means something. */
function savedLines(): Lines | undefined {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem('lines');
  } catch {
    /* private mode: there is nothing remembered */
  }
  if (raw === 'fit') return 'fit';
  const n = Number(raw);
  return n >= 1 && n <= 4 ? n : undefined;
}
applyLines(savedLines() ?? 2);
linesEl.addEventListener('change', () => {
  applyLines(linesEl.value === 'fit' ? 'fit' : Number(linesEl.value));
  try {
    localStorage.setItem('lines', linesEl.value);
  } catch {
    /* private mode: the choice lasts for this page */
  }
  linesEl.blur();
});

// --- sticking -------------------------------------------------------------------
// R and L under the notation, worked out by `drums sticking` and frozen in
// songs/<slug>/sticking.lock.json. On by default -- they are what the file is
// for -- and remembered like the theme.

const sticking = new StickingLetters(api, scoreEl);
function applySticking(on: boolean) {
  stickingEl.checked = on;
  sticking.visible = on;
}
try {
  applySticking(localStorage.getItem('sticking') !== 'off');
} catch {
  applySticking(true);
}
stickingEl.addEventListener('change', () => {
  applySticking(stickingEl.checked);
  try {
    localStorage.setItem('sticking', stickingEl.checked ? 'on' : 'off');
  } catch {
    /* private mode: the choice lasts for this page */
  }
});

// Set once practice mode exists: the heatmap has a palette of its own that has
// to be re-read on a theme change, and it is built further down the file than
// the first applyTheme call.
let onThemeChange: ((dark: boolean) => void) | undefined;

const glyph = (dark: boolean) => (dark ? '☀' : '☾');

/** The chrome. Cheap: nothing here touches alphaTab. */
function applyUiTheme(theme: 'light' | 'dark' | undefined) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  themeBtn.textContent = glyph(isDark());
  themeBtn.title = isDark() ? 'Switch to light' : 'Switch to dark';
  // The notation follows the chrome until it is given a theme of its own, so
  // a change here is a change there too.
  if (!chosenTabTheme()) applyTabTheme(undefined);
}

/** The notation. Costs a full re-render: alphaTab bakes the colours in. */
function applyTabTheme(theme: 'light' | 'dark' | undefined) {
  if (theme) document.documentElement.dataset.tabTheme = theme;
  else delete document.documentElement.dataset.tabTheme;
  const dark = isTabDark();
  tabThemeBtn.textContent = glyph(dark);
  tabThemeBtn.title = dark ? 'Light notation' : 'Dark notation';
  Object.assign(api.settings.display.resources, palette(dark));
  onThemeChange?.(dark);
  api.updateSettings();
  if (api.score) api.render();
}

/** Remember a choice, or forget it in private mode. */
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the choice lasts for this page */
  }
}
themeBtn.addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  remember('theme', next);
  applyUiTheme(next);
  themeBtn.blur();
});
tabThemeBtn.addEventListener('click', () => {
  const next = isTabDark() ? 'light' : 'dark';
  remember('tabTheme', next);
  applyTabTheme(next);
  tabThemeBtn.blur();
});
// Nothing chosen: follow the system as it changes.
systemDark.addEventListener('change', () => {
  if (!chosenTheme()) applyUiTheme(undefined);
});
applyUiTheme(chosenTheme());
applyTabTheme(chosenTabTheme());

// --- the rails ----------------------------------------------------------------
// Either rail folds down to one icon wide (the [data-rail="icons"] rules in
// index.html do the work). Remembered like the themes, and applied before
// first paint by the same script in the head: the middle column's width is
// what alphaTab engraves against, so the page has to start at the width it
// means to keep. Collapsing later costs one re-engrave, which is what a
// deliberate click is allowed to cost -- but nothing here may be animated.

type Side = 'rail' | 'desk';
const SIDES: readonly Side[] = ['rail', 'desk'];
const sideToggle: Record<Side, HTMLButtonElement> = {
  rail: byId('rail-toggle'),
  desk: byId('desk-toggle'),
};

function applyRail(side: Side, icons: boolean) {
  const root = document.documentElement;
  if (icons) root.dataset[side] = 'icons';
  else delete root.dataset[side];
  sideToggle[side].setAttribute('aria-expanded', String(!icons));
  sideToggle[side].title = icons ? 'Show the labels' : 'Collapse to icons';
}

for (const side of SIDES) {
  // The attribute is already set (or not) by the head script; this only
  // catches the button up with it, so there is one source of truth for the
  // width the score is first engraved against.
  applyRail(side, document.documentElement.dataset[side] === 'icons');
  sideToggle[side].addEventListener('click', () => {
    const icons = document.documentElement.dataset[side] !== 'icons';
    applyRail(side, icons);
    remember(side, icons ? 'icons' : 'wide');
    sideToggle[side].blur();
  });
}

// alphaTab's external-media output has no idea what the media is; it calls
// play/pause/seek on whatever handler it is given and waits for positions to
// be pushed back. The video element plays that part.
const clock = new MixClock(mixEl, {
  onPlayError: (err) => {
    api.pause();
    setStatus(`The browser refused to start the audio: ${err}`, true);
  },
});
const attachClock = () => {
  const output = api.player?.output as alphaTab.synth.IExternalMediaSynthOutput | undefined;
  if (output && 'handler' in output) clock.attach(output);
};
attachClock();

// --- mixer --------------------------------------------------------------------
// The stems, the click and the picture follow the clock on their own (see
// mixer.ts); the page only owns the faders, remembered like the theme.

let stemsMissing: string[] = [];
let pictureFailed = '';
let stickingStale = '';
const mixer = new Mixer(mixEl, videoEl, clock, {
  onStemError: (name) => {
    stemsMissing.push(name);
    showStatus();
  },
  onPictureError: () => {
    const err = videoEl.error;
    pictureFailed = `Video failed to load: ${err?.message || `code ${err?.code}`}.`;
    showStatus();
  },
});

const faderEl = (f: Fader) => document.getElementById(`fader-${f}`) as HTMLInputElement;
const faderOut = (f: Fader) => document.getElementById(`fader-${f}-out`) as HTMLOutputElement;

function savedLevels(): Partial<Record<Fader, number>> {
  try {
    const raw = localStorage.getItem('mix');
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const out: Partial<Record<Fader, number>> = {};
    for (const f of FADERS) {
      const v = parsed[f];
      if (typeof v === 'number' && v >= 0 && v <= 100) out[f] = v;
    }
    return out;
  } catch {
    return {};
  }
}
function applyFader(f: Fader, percent: number) {
  faderEl(f).value = String(percent);
  faderOut(f).textContent = `${percent}%`;
  mixer.setLevel(f, percent / 100);
}
function saveFaders() {
  try {
    localStorage.setItem(
      'mix',
      JSON.stringify(Object.fromEntries(FADERS.map((g) => [g, Number(faderEl(g).value)])))
    );
  } catch {
    /* private mode: the levels last for this page */
  }
}
const saved = savedLevels();
for (const f of FADERS) {
  applyFader(f, saved[f] ?? Number(faderEl(f).value));
  faderEl(f).addEventListener('input', () => {
    applyFader(f, Number(faderEl(f).value));
    saveFaders();
  });
}
// Mute from the keyboard: a fader at 0 comes back where it was, or at full
// if it was never anywhere else (the click starts at 0).
const unmuted: Partial<Record<Fader, number>> = {};
function toggleFader(f: Fader) {
  const now = Number(faderEl(f).value);
  if (now > 0) {
    unmuted[f] = now;
    applyFader(f, 0);
  } else {
    applyFader(f, unmuted[f] ?? 100);
  }
  saveFaders();
}

let summary = '';
let rendered = '';
let playerLoaded = false;
// What practice mode last had to say. It goes through the composed status
// rather than straight to the element because drawing a heatmap re-renders the
// score, and a re-render would otherwise wipe the result that caused it.
let practiceNote = '';
let practiceError = false;
// Render and player readiness arrive in either order (with external media the
// player is ready before the first row is drawn), so the status is composed
// rather than written by whichever event came last.
const showStatus = () =>
  setStatus(
    [
      summary,
      rendered,
      playerLoaded ? 'Player loaded.' : '',
      stemsMissing.length ? `No ${stemsMissing.join(' or ')} stem: playing the mix itself.` : '',
      pictureFailed,
      stickingStale,
      practiceNote,
    ]
      .filter(Boolean)
      .join(' '),
    practiceError
  );

// --- practice mode ----------------------------------------------------------------
// What you play, marked against what is written (practice.ts). Everything it
// needs is already on the page: the clock stamps the hits, the mixer's graph
// carries the calibration click, and alphaTab colours its own noteheads.
const practice = new Practice(
  api,
  clock,
  mixer,
  {
    enable: byId('midi-enable'),
    port: byId('midi-port'),
    calibrate: byId('calibrate'),
    calibration: byId('calibration'),
    record: byId('record'),
    cell: byId('cell'),
    monitorOn: byId('monitor-on'),
    monitor: byId('monitor'),
    report: byId('report'),
    clickFader: byId('fader-click'),
    speedFader: byId('speed'),
    grid: byId('routine'),
    start: byId('routine-start'),
    seal: byId('routine-seal'),
    discard: byId('routine-discard'),
    routineState: byId('routine-state'),
  },
  scoreEl,
  (text, isError = false) => {
    practiceNote = text;
    practiceError = isError;
    showStatus();
  }
);
onThemeChange = (dark) => practice.setTheme(dark);
practice.setTheme(isTabDark());

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
  const playing = e.state === alphaTab.synth.PlayerState.Playing;
  // The word and the glyph that stands in for it when the rail is collapsed,
  // written together so they cannot disagree (icons.ts).
  if (playing) say(playBtn, 'Pause', '⏸');
  else say(playBtn, 'Play', '▶');
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

// Stop means the top of the song, count-in included. alphaTab's own stop
// seeks to the score's tick 0, which is the first beat of bar 1, a couple of
// seconds in.
function stop() {
  api.stop();
  mixEl.currentTime = 0;
}

// The picture has no native controls (they would bypass alphaTab's transport);
// a click on it is play/pause. Clicks on the notation stay alphaTab's, which
// takes them as a seek -- so with no picture, clicking seeks and Space plays.
videoEl.addEventListener('click', () => {
  if (!playBtn.disabled) api.playPause();
});
// The score may be longer than the mix (an unfinished beat map, or a tab with
// trailing bars); tell alphaTab when the media runs out.
mixEl.addEventListener('ended', () => api.pause());
mixEl.addEventListener('error', () => {
  const err = mixEl.error;
  setStatus(
    `The mix failed to load (${mixEl.currentSrc}): ${err?.message || `code ${err?.code}`}`,
    true
  );
});

function applySpeed(percent: number) {
  const p = Math.max(Number(speedEl.min), Math.min(Number(speedEl.max), percent));
  speedEl.value = String(p);
  // Through alphaTab, never straight onto the element: alphaTab derives the
  // cursor animation speed from playbackSpeed and forwards it to the video.
  api.playbackSpeed = p / 100;
  speedOut.textContent = `${p}%`;
}
speedEl.addEventListener('input', () => applySpeed(Number(speedEl.value)));

// A slider keeps the focus after a drag, and then the arrow keys move it
// instead of the cursor. Hand the keyboard back to the player once the drag
// is over (the sliders are for the mouse; the keys have their own controls).
for (const slider of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
  slider.addEventListener('pointerup', () => slider.blur());
}

interface Loaded {
  slug: string;
  grid: Grid | undefined;
  syncPoints: alphaTab.model.FlatSyncPoint[];
  bars: number;
  /** Whether the stage has a picture on it. */
  video: boolean;
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
  const [url, grid, lock, reference] = await Promise.all([
    midiUrl(),
    gridBySlug.get(slug)?.(),
    stickingBySlug.get(slug)?.(),
    referenceBySlug.get(slug)?.(),
  ]);
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

  // The section names over the staff, from song.toml's [[section]] blocks.
  // alphaTab draws these as rehearsal marks, which is exactly what they are:
  // you cannot sensibly rename a boundary you cannot see, and the routine a
  // practice run walks is built from these names (practice-plan Q5).
  for (const section of song.sections) {
    const bar = score.masterBars[section.start_bar - 1];
    if (!bar || !section.name) continue;
    const marker = new alphaTab.model.Section();
    // alphaTab draws `[marker] text`, so filling both prints the name twice.
    // The name is a word like "chorus", not a rehearsal letter, so it reads
    // better without the brackets.
    marker.marker = '';
    marker.text = section.name;
    bar.section = marker;
  }

  // Sync the score to the drummer before alphaTab generates its playback
  // model from it. Without a beat map the video would run against the
  // notation's constant tempo, and the cursor would drift off within bars.
  const syncPoints = grid ? gridSyncPoints(grid, bars) : [];
  if (syncPoints.length > 0) score.applyFlatSyncPoints(syncPoints);
  clock.floorMs = grid ? (barStartMs(grid, 0) ?? 0) : 0;
  clock.fallbackDurationMs = grid ? grid.source.audio_duration * 1000 : 0;
  const hasVideo = song.media.video;
  current = { slug, grid, syncPoints, bars, video: hasVideo };

  // The letters come from a file solved against one particular chart, and
  // every save in Ableton writes a new one, so say so rather than drawing R
  // and L under notes that have moved since.
  sticking.load(lock);
  stickingStale = '';
  if (lock) {
    const hash = await chartHash(bytes);
    if (hash !== lock.chart) {
      stickingStale = 'Sticking is from an older chart (drums sticking --restick).';
    }
  }

  // Practice mode reads the same bytes: the notes you are marked against are
  // the notes on the page, from one parse.
  practiceNote = '';
  practiceError = false;
  // Not awaited: it ends by reading the open routine off the dev server, and
  // the page should finish loading whether or not there is one to read.
  void practice.load(await readPracticeSong(song, bytes, grid, lock, reference));

  const problems = [
    tab.unmapped.length ? `unmapped MIDI keys: ${tab.unmapped.join(', ')}` : '',
    tab.unknown.length ? `no articulation for: ${tab.unknown.join(', ')}` : '',
    !song.media.mix ? 'no audio/mix.wav: nothing to play (drums fetch)' : '',
    !grid ? 'no grid.lock.json, cursor runs at the written tempo' : '',
    hasVideo && grid && grid.video_offset_ms == null
      ? 'video offset not measured (drums align)'
      : '',
    // applyFlatSyncPoints drops points past the last bar without a word, and
    // bars past the last point run at an extrapolated tempo. Either way the
    // cursor quietly parts from the drummer, so say so.
    grid && bars !== grid.bar_count ? `notation has ${bars} bars, beat map has ${grid.bar_count}` : '',
  ].filter(Boolean);
  const tempo = grid ? `${Math.round(grid.score.bpm)} BPM, ` : '';
  summary = `${tempo}${tab.notes} notes, ${syncPoints.length} sync points.` + (problems.length ? ` ${problems.join('; ')}.` : '');

  // The clock, and with it everything that follows it. The click plays every
  // beat the drummer played, count-in included, with the first beat of each
  // bar accented.
  mixEl.src = `/media/${encodeURIComponent(slug)}/audio/mix.wav`;
  stemsMissing = [];
  pictureFailed = '';
  const perBar = grid?.meter.beats_per_bar ?? 4;
  const barOne = grid?.bar_one_beat ?? 0;
  mixer.load({
    slug,
    video: hasVideo,
    videoOffsetMs: grid?.video_offset_ms ?? 0,
    beats: grid?.beats ?? [],
    accent: (beat) => (beat - barOne) % perBar === 0,
  });
  // With no picture there is nothing to make room for, so the notation has the
  // stage to itself unless a number of lines was chosen by hand.
  stageEl.classList.toggle('no-video', !hasVideo);
  applyLines(savedLines() ?? (hasVideo ? 2 : 'fit'));
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

// --- seeking by bar -------------------------------------------------------------
// Positions are alphaTab ticks; a master bar knows its first tick. Seeking
// through tickPosition goes out to the video through VideoClock, and the
// cursor (and the stems) follow the video's seek, playing or paused.

function seekToBar(barIndex: number) {
  const bars = api.score?.masterBars ?? [];
  if (bars.length === 0 || playBtn.disabled) return;
  const target = bars[Math.max(0, Math.min(bars.length - 1, barIndex))]!;
  api.tickPosition = target.start;
}
const currentBar = () => (api.score ? barAtTick(api.score, api.tickPosition) : 0);
function seekBars(delta: number) {
  seekToBar(currentBar() + delta);
}
/** A line back or forward: the first bar of the row `delta` rows away. */
function seekLines(delta: number) {
  const row = scoreWindow.rowOf(currentBar());
  if (row === undefined) return;
  const bar = scoreWindow.firstBarOfRow(row + delta);
  if (bar !== undefined) seekToBar(bar);
}

// --- zen --------------------------------------------------------------------
// The picture and the notation, nothing else, and the browser's own fullscreen
// under them. Two states that have to agree and only one of them is ours: the
// browser can leave fullscreen without asking (Esc, F11, a policy, the OS). So
// zen is only ever *entered* deliberately here, and fullscreenchange is the
// one thing allowed to end it.

const zenExitBtn = byId<HTMLButtonElement>('zen-exit');
let zen = false;

/** The page's half of it: the chrome goes, the stage takes the window. */
function paintZen(on: boolean) {
  zen = on;
  // A value, not the bare attribute: the CSS only asks whether it is there,
  // but an empty string reads back as false to anything checking dataset.zen.
  if (on) document.documentElement.dataset.zen = 'on';
  else delete document.documentElement.dataset.zen;
}

function setZen(on: boolean) {
  if (on === zen) return;
  paintZen(on);
  if (on) {
    // Nothing awaited before this: requestFullscreen is only allowed while the
    // gesture that led here is still live, and an await would spend it.
    void document.documentElement.requestFullscreen().catch((err: Error) => {
      // Refused -- no gesture, a kiosk policy, an OS that says no. Stay in zen
      // rather than snapping back: the page is still the page, and this
      // message is visible because an error is the one thing zen keeps.
      setStatus(`Fullscreen refused: ${err.message}. Z or Esc leaves zen.`, true);
    });
  } else if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {
      /* already out: fullscreenchange has the last word either way */
    });
  }
}

// Whatever caused it, the browser leaving fullscreen is the end of zen. Never
// the reverse: F11 is browser fullscreen, which sets no fullscreenElement and
// is not zen.
document.addEventListener('fullscreenchange', () => {
  if (zen && !document.fullscreenElement) paintZen(false);
});
// Esc while fullscreen is eaten by the browser and never reaches the page, so
// the listener above is what Esc is really wired to. This covers the one case
// it cannot: zen that never got fullscreen. Its own listener rather than an
// entry in `keys`, which preventDefaults everything in it -- Escape belongs to
// the browser.
document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && zen && !document.fullscreenElement) paintZen(false);
});
zenExitBtn.addEventListener('click', () => {
  setZen(false);
  zenExitBtn.blur();
});

// --- keyboard -------------------------------------------------------------------
// From anywhere except a control that uses the key itself (a select, a
// slider being dragged). Space is play/pause; Home is Stop; arrows seek by a
// bar or a line; brackets step the tempo; +/- zoom the notation and 0 puts it
// back at 100%; 1/2/3 mute a fader; Z is zen.
const keys: Record<string, () => void> = {
  Space: () => {
    if (!playBtn.disabled) api.playPause();
  },
  Home: stop,
  ArrowLeft: () => seekBars(-1),
  ArrowRight: () => seekBars(1),
  ArrowUp: () => seekLines(-1),
  ArrowDown: () => seekLines(1),
  BracketLeft: () => applySpeed(Number(speedEl.value) - Number(speedEl.step)),
  BracketRight: () => applySpeed(Number(speedEl.value) + Number(speedEl.step)),
  // `+` is Shift and the `=` key on most layouts, and the handler below lets
  // Shift through, so both spellings of the same key arrive as Equal.
  Equal: () => setZoom(zoomStep + 1),
  Minus: () => setZoom(zoomStep - 1),
  NumpadAdd: () => setZoom(zoomStep + 1),
  NumpadSubtract: () => setZoom(zoomStep - 1),
  Digit0: () => setZoom(ZOOM_HOME),
  Numpad0: () => setZoom(ZOOM_HOME),
  Digit1: () => toggleFader('nodrums'),
  Digit2: () => toggleFader('drums'),
  Digit3: () => toggleFader('click'),
  KeyZ: () => setZen(!zen),
};
document.addEventListener('keydown', (e) => {
  const action = keys[e.code];
  if (!action || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.repeat && e.code === 'Space') return;
  const target = e.target as HTMLElement | null;
  if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
  e.preventDefault();
  action();
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
    mix: mixEl,
    video: videoEl,
    clock,
    mixer,
    scoreWindow,
    sticking,
    practice,
    seekToBar,
    get current() {
      return current;
    },
  };
}

void load(songEl.value);
