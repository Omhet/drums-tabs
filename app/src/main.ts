import * as alphaTab from '@coderline/alphatab';
import songs from 'virtual:songs';
import { countIn, type CountIn } from './click';
import { say } from './icons';
import { Loop, snapTempo, type LoopMemory } from './loop';
import { MixClock } from './media';
import { midiToAlphaTex, type TabResult } from './midi-tab';
import { FADERS, Mixer, type Fader } from './mixer';
import { Practice, readPracticeSong } from './practice';
import { chartHash } from './chart';
import type { ReferenceLock } from './reference';
import { ScoreWindow, barAtTick, type Lines } from './score-window';
import { StickingLetters, type StickingLock } from './sticking';
import { barAtMs, barStartMs, gridSyncPoints, syncSafeTempo, type Grid } from './syncpoints';

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
const countInEl = byId<HTMLInputElement>('count-in');
const loopRestEl = byId<HTMLInputElement>('loop-rest');

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
window.addEventListener('error', (e) => setStatus(`Something broke: ${e.message}`, true));
window.addEventListener('unhandledrejection', (e) =>
  setStatus(`Something broke: ${e.reason}`, true)
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

// A song to start from, so the selector is never blank while the router works
// out where it is going (see `go`, at the bottom of this file).
songEl.value = playable[0]?.slug ?? '';

// --- the notation's layout ------------------------------------------------------
// Four faders in the rail's Layout group that decide how the score is
// engraved -- as against Lines, which decides how much of it you see at once.
// They are screen-fitting, not song-fitting: you set them once against the
// monitor you practise in front of and they are remembered as your defaults,
// which is why they are faders you nudge and look at rather than keys.
//
// Size and bars-a-line used to be one control: the zoom dropped bars off the
// line as the scale climbed, on the reasoning that alphaTab grows the glyphs
// but not the page, so at 2x the same four bars would have twice the ink and
// the same pixels to share. That is true, but the rate to trade one for the
// other is a property of the screen, not of the score, and guessing it took
// away the two settings worth asking for: six small bars on a line, or two
// big ones. They are separate now, and +/- move Size alone. A row is
// stretched to the width it is given whatever is on it, so bars-a-line is
// really how much width one bar gets.
const ZOOM_STEPS = [0.6, 0.7, 0.85, 1, 1.2, 1.4, 1.7, 2];
/** Which rung of the Size ladder is 100%. */
const ZOOM_HOME = ZOOM_STEPS.indexOf(1);

/** One of the four faders: where it is, what it is remembered as, and how it reads. */
interface Knob {
  el: HTMLInputElement;
  out: HTMLOutputElement;
  /** The localStorage key it is remembered under. */
  key: string;
  /** The value `0` puts it back to; also what the markup ships with. */
  home: number;
  /** The number beside the fader's name. */
  say: (v: number) => string;
  /**
   * Size only. It remembers the scale rather than the rung it is on, so
   * re-cutting the ladder cannot quietly turn a remembered 100% into 85%.
   * `load` returns -1 for a value that is no longer on the ladder, which is
   * out of the fader's range and so falls back to the default.
   */
  save?: (v: number) => string;
  load?: (raw: number) => number;
}

const knobs: Record<'size' | 'bars' | 'spacing' | 'gap', Knob> = {
  size: {
    el: byId('zoom'),
    out: byId('zoom-out'),
    key: 'zoom',
    home: ZOOM_HOME,
    say: (v) => `${Math.round(ZOOM_STEPS[v]! * 100)}%`,
    save: (v) => String(ZOOM_STEPS[v]!),
    load: (raw) => ZOOM_STEPS.indexOf(raw),
  },
  bars: {
    el: byId('bars'),
    out: byId('bars-out'),
    key: 'bars',
    home: 4,
    say: (v) => String(v),
  },
  spacing: {
    el: byId('spacing'),
    out: byId('spacing-out'),
    key: 'noteSpacing',
    home: 100,
    say: (v) => `${v}%`,
  },
  gap: {
    el: byId('gap'),
    out: byId('gap-out'),
    key: 'lineGap',
    home: 20,
    say: (v) => `${v}px`,
  },
};

/** Put a remembered value back on its fader, if it is one the fader can take. */
function restoreKnob(k: Knob) {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(k.key);
  } catch {
    /* private mode: there is nothing remembered */
  }
  if (raw === null) return;
  const n = k.load ? k.load(Number(raw)) : Number(raw);
  if (Number.isFinite(n) && n >= Number(k.el.min) && n <= Number(k.el.max)) k.el.value = String(n);
}
for (const k of Object.values(knobs)) restoreKnob(k);

/** What the four faders are asking for, in alphaTab's own terms. */
const asked = () => ({
  scale: ZOOM_STEPS[Number(knobs.size.el.value)]!,
  barsPerRow: Number(knobs.bars.el.value),
  stretchForce: Number(knobs.spacing.el.value) / 100,
  // What you see between two rows is one row's bottom padding plus the next
  // one's top, so the fader's number is split across the pair.
  systemPadding: Number(knobs.gap.el.value) / 2,
});

/**
 * Engrave at what the faders say.
 *
 * Costs a full re-render, like a theme change, and like a theme change it
 * leaves the transport alone. The notation window re-measures itself
 * afterwards (postRenderFinished), so N lines stays N lines -- taller or
 * shorter ones, which the picture above them gives up or takes back the room
 * for.
 */
function applyLayout() {
  for (const k of Object.values(knobs)) k.out.textContent = k.say(Number(k.el.value));
  const want = asked();
  // The overlays are our own pixels, not alphaTab's: the sticking letters and
  // the extras lane read this to grow with the notes they belong to.
  scoreEl.style.setProperty('--tab-zoom', String(want.scale));
  const d = api.settings.display;
  if (
    d.scale === want.scale &&
    d.barsPerRow === want.barsPerRow &&
    d.stretchForce === want.stretchForce &&
    d.systemPaddingTop === want.systemPadding
  ) {
    return;
  }
  d.scale = want.scale;
  d.barsPerRow = want.barsPerRow;
  d.stretchForce = want.stretchForce;
  d.systemPaddingTop = want.systemPadding;
  d.systemPaddingBottom = want.systemPadding;
  api.updateSettings();
  if (api.score) api.render();
}

/** Engrave, and remember where this fader landed. */
function settle(k: Knob) {
  applyLayout();
  remember(k.key, (k.save ?? String)(Number(k.el.value)));
}

/** Move Size from the keyboard; the fader follows. */
function setSize(step: number) {
  knobs.size.el.value = String(Math.max(0, Math.min(ZOOM_STEPS.length - 1, step)));
  settle(knobs.size);
}
const sizeStep = () => Number(knobs.size.el.value);

/** The whole group back to the defaults: the one key the group keeps. */
function resetLayout() {
  for (const k of Object.values(knobs)) k.el.value = String(k.home);
  applyLayout();
  for (const k of Object.values(knobs)) remember(k.key, (k.save ?? String)(k.home));
}

for (const k of Object.values(knobs)) {
  // Two events, not one: `input` fires on every pixel of a drag and only
  // moves the number beside the fader, so the reading keeps up with the
  // thumb, while the re-engrave waits for `change` -- the mouse being let go,
  // or one press of an arrow key. Re-laying out the whole score on every
  // pixel would be a slideshow. (The mix faders are on `input` alone; setting
  // a gain costs nothing.)
  k.el.addEventListener('input', () => {
    k.out.textContent = k.say(Number(k.el.value));
  });
  k.el.addEventListener('change', () => settle(k));
}

/** What the faders say before alphaTab exists, to build it with. */
const start = asked();

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
    // The Layout group's four, read straight off the faders. They are set
    // here rather than after construction so that remembered settings are
    // engraved once, the same way a remembered rail width is.
    scale: start.scale,
    barsPerRow: start.barsPerRow,
    stretchForce: start.stretchForce,
    systemPaddingTop: start.systemPadding,
    systemPaddingBottom: start.systemPadding,
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

// The settings above were already built from the faders; this only writes
// their numbers beside them and publishes the scale to the overlays. It
// re-renders nothing -- everything it would set is already set.
applyLayout();

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

// What each song remembers: its tempo and its loop. Live reloads the page on
// every Ctrl+S of the set, so without this a save in the middle of looping a
// fill at 70% would land you on the whole song at 100%. It comes back as it
// was left -- the same loop on, the same tempo -- but never playing: a reload
// is not a gesture, and the browser would not let it make a sound anyway.
interface SongMemory {
  /** Percent of the record's tempo. */
  tempo?: number;
  loop?: LoopMemory;
}
const memoryKey = (slug: string) => `song:${slug}`;

function recall(slug: string): SongMemory {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(memoryKey(slug)) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as SongMemory) : {};
  } catch {
    return {};
  }
}

function memorise(slug: string, patch: SongMemory) {
  remember(memoryKey(slug), JSON.stringify({ ...recall(slug), ...patch }));
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
/** Hand alphaTab's external-media output to the clock. Safe to call again. */
function attachClock() {
  const output = api.player?.output as alphaTab.synth.IExternalMediaSynthOutput | undefined;
  if (output && 'handler' in output) clock.attach(output);
}
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
    console.warn(`[drums] video: ${err?.message || `code ${err?.code}`}`);
    pictureFailed = 'The video would not load, so there is no picture.';
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

// --- the status line ----------------------------------------------------------
// Only what a drummer needs, in plain words: something missing or wrong with
// the song's files, and what the loop, a count-in or practice mode last had to
// say. The numbers a developer wants -- notes, sync points, bars engraved, the
// notation against the beat map -- go to the console when the song is ready,
// and "ready" itself is an attribute on <html> rather than a sentence (see
// `markReady`), so nothing has to read the status line to know.

/** What is wrong with this song's files, in words, from `load`. */
let problems = '';
/**
 * What the loop, a count-in or practice mode last had to say. It goes through
 * the composed status rather than straight to the element, so the song's own
 * problems stay on the line beside it.
 */
let note = '';
let noteError = false;
const showStatus = () =>
  setStatus(
    [problems, stemsNote(), pictureFailed, stickingStale, note].filter(Boolean).join(' '),
    noteError
  );
/** Say something on the status line, replacing whatever was said last. */
function tell(text: string, isError = false) {
  note = text;
  noteError = isError;
  showStatus();
}

/** A stem that would not load, as what it means for the faders. */
function stemsNote(): string {
  if (stemsMissing.length === 0) return '';
  if (stemsMissing.length > 1) {
    return 'This song has no separated tracks, so the whole record plays and No drums and Drums cannot be set apart.';
  }
  return stemsMissing[0] === 'drums'
    ? "The record's drum track is missing, so the Drums fader is silent."
    : 'The record without its drums is missing, so the No drums fader is silent.';
}

// The Kit fader's own line, shown only when there is something wrong with it.
//
// It has its own place rather than joining the status above because the thing
// it reports is a property of the *bank*, not of the song: a fader that has
// nothing to play looks exactly like a fader turned down, and there is no
// other way to tell them apart.
const kitNoteEl = document.getElementById('kit-note') as HTMLParagraphElement;

async function showKitNote() {
  await mixer.bank.ready();
  const bank = mixer.bank;
  const lines: string[] = [];
  if (!bank.baked) {
    lines.push('No kit baked, so this fader is silent. Run <code>drums kit-bake</code>.');
  } else {
    const cannot = mixer.unplayable(practice.wholeSong());
    if (cannot.length) lines.push(`No sample for: ${cannot.join(', ')}.`);
    if (bank.missing.length) {
      lines.push(`${bank.missing.length} recording${bank.missing.length > 1 ? 's' : ''} failed to load.`);
    }
  }
  kitNoteEl.innerHTML = lines.join('<br>');
  kitNoteEl.hidden = lines.length === 0;
}

// --- the loop -----------------------------------------------------------------------
// A section or a run of bars, round and round on the record's own clock
// (loop.ts). The rest bar between passes is a habit rather than a property of
// a song, so it is remembered once for all of them; the range, whether it is
// on and the ramp are remembered per song (`memorise`).
try {
  loopRestEl.checked = localStorage.getItem('loopRest') !== 'off';
} catch {
  /* private mode: the default, a bar of rest */
}
const loop: Loop = new Loop(
  api,
  clock,
  mixer,
  {
    section: byId('loop-section'),
    from: byId('loop-from'),
    to: byId('loop-to'),
    toggle: byId('loop'),
    pass: byId('loop-pass'),
    rest: loopRestEl,
    ramp: byId('ramp'),
    rampFrom: byId('ramp-from'),
    rampStep: byId('ramp-step'),
    rampEvery: byId('ramp-every'),
    rampTo: byId('ramp-to'),
    rampGate: byId('ramp-gate'),
    rampState: byId('ramp-state'),
  },
  scoreEl,
  {
    tempo: () => Number(speedEl.value),
    setTempo: (percent) => applySpeed(percent),
    say: tell,
    changed: () => {
      paintPlay();
      practice.refresh();
      remember('loopRest', loopRestEl.checked ? 'on' : 'off');
      if (current) memorise(current.slug, { loop: loop.snapshot() });
    },
    busy: (): boolean => practice.busy,
  }
);

// --- practice mode ----------------------------------------------------------------
// What you play, marked against what is written (practice.ts). Everything it
// needs is already on the page: the clock stamps the hits, the mixer's graph
// carries the calibration click, and alphaTab colours its own noteheads.
const practice: Practice = new Practice(
  api,
  clock,
  mixer,
  loop,
  {
    enable: byId('midi-enable'),
    port: byId('midi-port'),
    calibrate: byId('calibrate'),
    calibration: byId('calibration'),
    record: byId('record'),
    target: byId('take-target'),
    monitorOn: byId('monitor-on'),
    monitor: byId('monitor'),
    report: byId('report'),
    passes: byId('passes'),
    clickFader: byId('fader-click'),
  },
  scoreEl,
  tell
);
onThemeChange = (dark) => practice.setTheme(dark);
practice.setTheme(isTabDark());

// --- ready ----------------------------------------------------------------------
// A song is ready when its score is engraved and the player can play it. The
// two arrive in either order (with external media the player is ready before
// the first row is drawn), so each one checks for the other.
//
// It is said with `data-ready="<slug>"` on <html>, not on the status line:
// the headless checks wait for it (scripts/browser.mjs `waitForPlayer`), and
// they used to wait for the words "Player loaded", which is a sentence for a
// developer that a drummer then had to read on every load.

/** The song `load` is waiting to see engraved, and what to log once it is. */
let pending: { slug: string; score: alphaTab.model.Score; rendered: boolean; diagnostics: string } | undefined;
let playerLoaded = false;
/** The count-in from a pause under way, if there is one (`resume`, further down). */
let resuming: CountIn | undefined;
const COUNTING_IN = 'Counting in.';

function markReady() {
  const p = pending;
  if (!p || !p.rendered || !playerLoaded) return;
  pending = undefined;
  const staff = api.score?.tracks[0]?.staves[0];
  console.info(`[drums] ${p.diagnostics}; engraved ${staff?.bars.length ?? 0} bars.`);
  document.documentElement.dataset.ready = p.slug;
  showStatus();
}

// Handlers must be attached *before* api.tex(), which fires renderStarted
// synchronously -- otherwise the first event is missed.
api.renderFinished.on(() => {
  // Only the render of the score `load` asked for: a re-render of the song
  // being left (a theme switch a moment before) is not this one being ready.
  if (pending && api.score === pending.score) {
    pending.rendered = true;
    markReady();
  }
});

api.error.on((error) => setStatus(`The notation could not be drawn: ${error.message ?? error}`, true));

// Playback stays disabled until the player reports ready, so a click cannot
// silently no-op. (With external media that is immediate; the video itself
// buffers on demand.)
api.playerReady.on(() => {
  attachClock();
  playBtn.disabled = false;
  stopBtn.disabled = false;
  playerLoaded = true;
  markReady();
});

/**
 * What the Play button says.
 *
 * Not only alphaTab's own state: a loop pauses the transport at the end of
 * every pass, and a count-in -- a loop's, or one from a pause -- clicks before
 * the transport has moved at all, so alphaTab is legitimately stopped while
 * the thing you asked for is very much still going.
 */
function paintPlay(state = api.playerState) {
  const playing = state === alphaTab.synth.PlayerState.Playing || loop.running || !!resuming;
  // The word and the glyph that stands in for it when the rail is collapsed,
  // written together so they cannot disagree (icons.ts).
  if (playing) say(playBtn, 'Pause', '⏸');
  else say(playBtn, 'Play', '▶');
}

api.playerStateChanged.on((e) => paintPlay(e.state));
// The end of the score. A loop over the last bars ends there, and alphaTab
// rewinds as it says so -- which is why the loop is told rather than left to
// notice (loop.ts `reachedEnd`).
api.playerFinished.on(() => {
  loop.reachedEnd();
  paintPlay();
});

/**
 * Play, or stop, wherever it is pressed from: the button, Space, the picture.
 *
 *   - a loop going round stops (where it is; the loop stays on);
 *   - a count-in under way is called off;
 *   - with the loop on, Play plays the loop: a bar of count-in, then pass 1;
 *   - playing, it pauses;
 *   - paused, it plays -- after a bar of count-in, unless that is turned off.
 *
 * While practice mode has the transport (a whole-song take, the calibration)
 * it is a plain play/pause, as it always was: those have count-ins of their
 * own and a second one would fight them.
 */
function togglePlay() {
  if (playBtn.disabled) return;
  if (loop.running) loop.stop();
  else if (resuming) cancelResume();
  else if (loop.armed && !practice.busy) loop.start();
  else if (api.playerState === alphaTab.synth.PlayerState.Playing) api.pause();
  else if (countInEl.checked && !practice.busy) resume();
  else api.play();
  // A count-in moves no transport and so fires no state change: without this
  // the button would still say Play for the bar it takes, which is the bar you
  // are most likely to press it again in.
  paintPlay();
}

// --- count-in from a pause ---------------------------------------------------------
// Play from a pause gives a bar of click at the tempo set before the music
// comes back, so you come in with it instead of chasing it. A setting, on by
// default, remembered once for every song.

try {
  countInEl.checked = localStorage.getItem('countIn') !== 'off';
} catch {
  /* private mode: the default, on */
}
countInEl.addEventListener('change', () => {
  remember('countIn', countInEl.checked ? 'on' : 'off');
  countInEl.blur();
});

/**
 * Count in, then play.
 *
 * It resumes from the start of the bar the cursor is in, not from where the
 * cursor is. A bar of clicks ends on a downbeat, so the music has to start on
 * one: four clicks and then the record half way through a bar would put the
 * record's beat between yours, which is worse than no count-in at all. The
 * cost is hearing again up to a bar you have just heard -- and that is the bar
 * you want to hear to come back in anyway.
 *
 * Before bar 1 it depends on the record. One with a run-up of its own (One For
 * The Road has three bars of intro with a beat in them) plays it as it is:
 * the record is the count-in. One that starts on its first beat (Kill Me,
 * 0.36 s in) has nothing to come in on, so it is counted in to bar 1 -- the
 * same reason Record counts a take in.
 */
function resume() {
  const grid = current?.grid;
  mixer.ensureGraph();
  const ctx = mixer.ctx;
  const out = mixer.countInOut();
  if (!grid || !ctx || !out) {
    api.play();
    return;
  }
  let bar = barAtMs(grid, clock.mixTimeMs);
  if (bar < 0) {
    if (grid.bar_one_beat > 0) {
      api.play();
      return;
    }
    bar = 0;
  }
  const startMs = barStartMs(grid, bar);
  if (startMs === undefined) {
    api.play();
    return;
  }
  // The bar's own length, at the tempo it is about to be played at: the
  // drummer's tempo moves, and a 70% count-in is a 70% count-in.
  const nextMs = barStartMs(grid, bar + 1);
  const prevMs = barStartMs(grid, bar - 1);
  const barMs =
    nextMs !== undefined ? nextMs - startMs : prevMs !== undefined ? startMs - prevMs : 2000;
  const perBar = grid.meter.beats_per_bar;
  clock.seekTo(startMs);
  const c = countIn(ctx, out, barMs / perBar / 1000 / (api.playbackSpeed || 1), perBar);
  resuming = c;
  tell(COUNTING_IN);
  void c.done.then((go) => {
    if (resuming !== c) return;
    resuming = undefined;
    if (note === COUNTING_IN) tell('');
    // Unless something else took the transport during the bar: Record, or
    // the loop turned on. Those have count-ins of their own.
    if (go && !loop.armed && !loop.running && !practice.busy) api.play();
    paintPlay();
  });
}

/** Call off a count-in from a pause: the transport stays where it was put. */
function cancelResume() {
  const c = resuming;
  if (!c) return;
  resuming = undefined;
  c.cancel();
  if (note === COUNTING_IN) tell('');
  paintPlay();
}

// Blur after a click so a following Space toggles playback once, not twice
// (the focused button would fire its own click on the same key).
playBtn.addEventListener('click', () => {
  togglePlay();
  playBtn.blur();
});
stopBtn.addEventListener('click', () => {
  stop();
  stopBtn.blur();
});

// Stop means the top of the song, count-in included. alphaTab's own stop
// seeks to the score's tick 0, which is the first beat of bar 1, a couple of
// seconds in. A loop going round stops too, and stays on: Play starts it again.
function stop() {
  loop.stop();
  cancelResume();
  api.stop();
  mixEl.currentTime = 0;
}

// The picture has no native controls (they would bypass alphaTab's transport);
// a click on it is play/pause. Clicks on the notation stay alphaTab's, which
// takes them as a seek -- so with no picture, clicking seeks and Space plays.
videoEl.addEventListener('click', () => {
  togglePlay();
});
// The score may be longer than the mix (an unfinished beat map, or a tab with
// trailing bars); tell alphaTab when the media runs out.
mixEl.addEventListener('ended', () => api.pause());
mixEl.addEventListener('error', () => {
  const err = mixEl.error;
  console.warn(`[drums] ${mixEl.currentSrc}: ${err?.message || `code ${err?.code}`}`);
  // Through the composed line, so the song becoming ready a moment later does
  // not write over the one thing that says why nothing plays.
  tell("The song's audio would not load, so nothing can play (is audio/mix.wav there?).", true);
});

/**
 * The tempo, in percent of the record's. The one setter: the slider, its
 * readout, alphaTab and the song's memory all move here and nowhere else, so
 * the keys, the step buttons and a loop's ramp can never disagree about it.
 */
function applySpeed(percent: number) {
  // On the slider's rungs: a number between them would be shown as the rung
  // the slider snaps to while the record played at the other.
  const p = snapTempo(percent);
  speedEl.value = String(p);
  // Through alphaTab, never straight onto the element: alphaTab derives the
  // cursor animation speed from playbackSpeed and forwards it to the video.
  api.playbackSpeed = p / 100;
  speedOut.textContent = `${p}%`;
  if (current) memorise(current.slug, { tempo: p });
  loop.refresh();
}
speedEl.addEventListener('input', () => applySpeed(Number(speedEl.value)));
/** A step up or down from where the tempo is. */
const stepTempo = (delta: number) => applySpeed(Number(speedEl.value) + delta);
// The small buttons beside the slider: -10 -5 100% +5 +10. The steps are the
// way the tempo is actually moved in practice -- slower to learn a part, then
// back up a notch at a time -- and 100% is the way home.
for (const btn of document.querySelectorAll<HTMLButtonElement>('#tempo-steps button')) {
  btn.addEventListener('click', () => {
    const step = Number(btn.dataset.step);
    if (step === 0) applySpeed(100);
    else stepTempo(step);
    btn.blur();
  });
}

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
  // Whatever was going round belongs to the song being left -- stopped before
  // `current` moves on, so it is remembered under that song and not this one.
  loop.stop();
  cancelResume();
  api.stop();
  delete document.documentElement.dataset.ready;
  pending = undefined;
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
  // you cannot sensibly rename a boundary you cannot see.
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
      stickingStale =
        'The R and L letters were worked out for an older version of the notation (drums sticking --restick).';
    }
  }

  // The loop and the tempo this song was left at. The loop first, so that
  // practice mode, loading next, offers to record what is actually on.
  const memory = recall(slug);
  loop.load({ sections: song.sections, grid, bars }, memory.loop);

  // Practice mode reads the same bytes: the notes you are marked against are
  // the notes on the page, from one parse.
  note = '';
  noteError = false;
  practice.load(await readPracticeSong(song, bytes, grid, lock, reference));
  applySpeed(typeof memory.tempo === 'number' ? memory.tempo : 100);
  void showKitNote();

  // What is wrong with the song's files, for the drummer: each one changes
  // what the page can do, and each names the command that fixes it.
  problems = [
    !song.media.mix ? 'This song has no audio yet, so there is nothing to play (drums fetch).' : '',
    !grid
      ? 'This song has no beat map, so the notation keeps a steady tempo instead of following the drummer (drums prep).'
      : '',
    hasVideo && grid && grid.video_offset_ms == null
      ? 'The video has not been lined up with the audio yet, so it may run early or late (drums align).'
      : '',
    tab.unmapped.length
      ? `Notes on MIDI keys ${tab.unmapped.join(', ')} are not drawn: song.toml's [midi_map] does not name those keys.`
      : '',
    tab.unknown.length ? `The notation has no way to draw ${tab.unknown.join(', ')}, so those notes are missing.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  // And for whoever is building it, in the console.
  const diagnostics = [
    `${song.title}: ${grid ? `${Math.round(grid.score.bpm)} BPM` : 'no beat map'}`,
    `${tab.notes} notes`,
    `${syncPoints.length} sync points`,
    // applyFlatSyncPoints drops points past the last bar without a word, and
    // bars past the last point run at an extrapolated tempo. Either way the
    // cursor quietly parts from the drummer there, so it is said somewhere.
    grid && bars !== grid.bar_count
      ? `notation has ${bars} bars, beat map has ${grid.bar_count}`
      : `${bars} bars`,
  ].join(', ');

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
  pending = { slug, score, rendered: false, diagnostics };
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
  // A count-in leads into the bar it was started from; moving away from that
  // bar under it would bring the music in somewhere the clicks did not lead.
  cancelResume();
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
// The way in for the mouse, beside the two rail toggles: zen is the third
// thing that decides how much of the window the stage gets, so it belongs in
// the same corner as the other two rather than being a key you have to know.
const zenBtn = byId<HTMLButtonElement>('zen');
zenBtn.addEventListener('click', () => {
  setZen(true);
  zenBtn.blur();
});

// --- keyboard -------------------------------------------------------------------
// From anywhere except a control that uses the key itself (a select, a
// slider being dragged). Space is play/pause; Home is Stop; arrows seek by a
// bar or a line; brackets step the tempo by 5, with Shift by 10, and
// backslash puts it back to 100%; L turns the loop on and off; +/- size the
// notation and 0 puts the whole Layout group back to its defaults; 1/2/3/4
// mute a fader; Z is zen.
const keys: Record<string, (e: KeyboardEvent) => void> = {
  Space: togglePlay,
  Home: stop,
  ArrowLeft: () => seekBars(-1),
  ArrowRight: () => seekBars(1),
  ArrowUp: () => seekLines(-1),
  ArrowDown: () => seekLines(1),
  // Shift is let through by the handler below, so Shift+[ arrives here too:
  // the same key, a bigger step. 10% is the step a session climbs back up in.
  BracketLeft: (e) => stepTempo(e.shiftKey ? -10 : -5),
  BracketRight: (e) => stepTempo(e.shiftKey ? 10 : 5),
  // Beside the brackets on most keyboards: the way home from any tempo.
  Backslash: () => applySpeed(100),
  KeyL: () => loop.toggle(),
  // `+` is Shift and the `=` key on most layouts, and the handler below lets
  // Shift through, so both spellings of the same key arrive as Equal.
  Equal: () => setSize(sizeStep() + 1),
  Minus: () => setSize(sizeStep() - 1),
  NumpadAdd: () => setSize(sizeStep() + 1),
  NumpadSubtract: () => setSize(sizeStep() - 1),
  // The rest of the Layout group is set in the rail and left alone; 0 is the
  // way back from a setting that turned out to be a bad idea.
  Digit0: resetLayout,
  Numpad0: resetLayout,
  Digit1: () => toggleFader('nodrums'),
  Digit2: () => toggleFader('drums'),
  Digit3: () => toggleFader('click'),
  Digit4: () => toggleFader('kit'),
  KeyZ: () => setZen(!zen),
};
document.addEventListener('keydown', (e) => {
  const action = keys[e.code];
  if (!action || e.ctrlKey || e.metaKey || e.altKey) return;
  // A held key repeats; a switch should not flicker while it is held.
  if (e.repeat && (e.code === 'Space' || e.code === 'KeyL')) return;
  const target = e.target as HTMLElement | null;
  if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
  e.preventDefault();
  action(e);
});

// --- the router -------------------------------------------------------------------
// The hash is the song's slug, and that is the whole of it. It survives the
// full reload Ableton triggers on every Ctrl+S, and it makes a song a link you
// can keep.

const slugOfHash = (hash: string) => decodeURIComponent(hash.replace(/^#/, ''));

async function go(wanted: string) {
  const slug = playable.some((s) => s.slug === wanted) ? wanted : playable[0]?.slug ?? '';
  if (!slug) return;
  // Against the song actually loaded, not the picker: picking a song has
  // already changed the picker by the time its hash arrives here, so comparing
  // with the picker meant the header's song list changed the address and
  // nothing else until the next reload.
  if (slug !== current?.slug) {
    songEl.value = slug;
    await load(slug);
  }
}

songEl.addEventListener('change', () => {
  location.hash = encodeURIComponent(songEl.value);
});
window.addEventListener('hashchange', () => void go(slugOfHash(location.hash)));

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
    loop,
    go,
    seekToBar,
    // The bar->ms primitive, so a check can work out where a range starts and
    // ends without reimplementing the beat map.
    barStartMs,
    get current() {
      return current;
    },
  };
}

void go(slugOfHash(location.hash));
