import * as alphaTab from '@coderline/alphatab';
import songs, { type Section } from 'virtual:songs';
import { countIn, watchCountIns, type CountIn, type CountInShown } from './click';
import { PaperLayers } from './layers';
import { Library, type SongMemory } from './library';
import { Loop, rampLadder, rampNext, rangeName, snapTempo, type LoopRange } from './loop';
import { MixClock } from './media';
import { midiToAlphaTex, type TabResult } from './midi-tab';
import { FADERS, Mixer, type Fader } from './mixer';
import { Practice, readPracticeSong } from './practice';
import { chartHash } from './chart';
import type { ReferenceLock } from './reference';
import { ScoreWindow, barAtTick } from './score-window';
import { SongMap } from './songmap';
import { StickingLetters, type StickingLock } from './sticking';
import { barAtMs, barStartMs, gridSyncPoints, syncSafeTempo, type Grid } from './syncpoints';
import { tokenRgb } from './tokens';

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

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scoreEl = byId<HTMLElement>('score');
const statusEl = byId<HTMLElement>('status');
const appEl = byId<HTMLElement>('app');
const mixEl = byId<HTMLAudioElement>('mix');
const videoEl = byId<HTMLVideoElement>('video');
const playBtn = byId<HTMLButtonElement>('play');
const playWord = byId<HTMLElement>('play-word');
const stickingEl = byId<HTMLInputElement>('sticking');
const themeSeg = byId<HTMLElement>('theme');
const tabThemeSeg = byId<HTMLElement>('tab-theme');
const pairsEl = byId<HTMLElement>('pairs');
const countInEl = byId<HTMLInputElement>('count-in');
const countInLoopEl = byId<HTMLInputElement>('count-in-loop');
const loopBetween = byId<HTMLElement>('loop-between');
const loopBtn = byId<HTMLButtonElement>('loop');
const mixPanel = byId<HTMLElement>('mix-panel');
const settingsEl = byId<HTMLElement>('settings');
const mixBtn = byId<HTMLButtonElement>('mix-btn');
const settingsBtn = byId<HTMLButtonElement>('settings-btn');
const rampBtn = byId<HTMLButtonElement>('ramp-btn');
const videoBtn = byId<HTMLButtonElement>('video-btn');
/** The header's readouts: where, the pass, the tempo. */
const head = {
  section: byId<HTMLElement>('section-name'),
  barNow: byId<HTMLElement>('bar-now'),
  barTotal: byId<HTMLElement>('bar-total'),
  barPass: byId<HTMLElement>('bar-pass'),
  pass: byId<HTMLElement>('pass'),
  passMain: byId<HTMLElement>('loop-pass'),
  passSub: byId<HTMLElement>('pass-sub'),
  tempoNum: byId<HTMLElement>('tempo-num'),
  tempoBpm: byId<HTMLElement>('tempo-bpm'),
  title: byId<HTMLElement>('song-title'),
  titleState: byId<HTMLElement>('title-state'),
  steps: byId<HTMLElement>('tempo-steps'),
  ladder: byId<HTMLElement>('ladder'),
  countSays: byId<HTMLElement>('count-says'),
  countBeats: byId<HTMLElement>('count-beats'),
  browse: byId<HTMLElement>('browse'),
  browseMain: byId<HTMLElement>('browse-bars'),
  browseSub: byId<HTMLElement>('browse-sub'),
  back: byId<HTMLButtonElement>('back-btn'),
  backBar: byId<HTMLElement>('back-bar'),
};

interface Loaded {
  slug: string;
  grid: Grid | undefined;
  syncPoints: alphaTab.model.FlatSyncPoint[];
  bars: number;
  sections: readonly Section[];
  /** Whether the song has a picture to show. */
  video: boolean;
}
/** The song on the page, once `load` has read it. */
let current: Loaded | undefined;
/** The tempo, in percent of the record's (`applySpeed`). */
let tempo = 100;
/** `ahead` or `back` while the paper is turned away from the cursor's line (`paintBrowse`). */
let browsing: 'ahead' | 'back' | undefined;
/** Zen: the picture and the paper, nothing else (`setZen`). */
let zen = false;

// --- themes -------------------------------------------------------------------
// Two of them, and they do not have to agree: the interface (data-theme, dark
// unless set to light) and the paper (data-tab-theme, cream unless set to
// dark). A dark room wants a dark page with the notes still on cream paper,
// which is what the defaults are. Both are CSS custom properties from the Lamp
// spec, and alphaTab paints the notes from the paper's (palette), so only the
// paper's switch re-renders the score.

const isDark = () => document.documentElement.dataset.theme !== 'light';
const isTabDark = () => document.documentElement.dataset.tabTheme === 'dark';

/** alphaTab's colours, from the paper's tokens. */
function palette(): Partial<alphaTab.RenderingResources> {
  const C = alphaTab.model.Color;
  const token = (name: string) => {
    const [r, g, b] = tokenRgb(name);
    return new C(r, g, b);
  };
  const ink = token('--tab-ink');
  return {
    mainGlyphColor: ink,
    // alphaTab draws secondary voices at 40% black, which is right for a
    // guitar counter-melody and wrong for drums: the feet are not a
    // background part, they are half of what is being played. Stems down
    // already distinguishes them.
    secondaryGlyphColor: ink,
    scoreInfoColor: ink,
    staffLineColor: token('--tab-staff'),
    barSeparatorColor: ink,
    // Bar numbers are for finding your place, not for reading; keep them
    // out of the way of the notes.
    barNumberColor: token('--tab-barno'),
  };
}

/**
 * The page's one face for the words alphaTab engraves: the bar numbers, and
 * the blank rehearsal mark that holds the label lane open (`load`), whose
 * size is the lane's height. Sizes are at scale 1; at the default 2.25 the
 * bar numbers come out at about 22 px.
 */
function engravedFonts(): Partial<alphaTab.RenderingResources> {
  const { Font, FontStyle, FontWeight } = alphaTab.model;
  const family = 'Atkinson Hyperlegible Next';
  return {
    markerFont: new Font(family, LANE_PT, FontStyle.Plain, FontWeight.Bold),
    barNumberFont: new Font(family, 10, FontStyle.Plain, FontWeight.Regular),
  };
}

/** The label lane's height at scale 1, as the size of the mark that holds it open. */
const LANE_PT = 13;

function setStatus(text: string, isError = false) {
  statusEl.textContent = text;
  // Two lines at most; the tooltip has all of it.
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

// --- the notation's layout ------------------------------------------------------
// Four knobs that decide how the score is engraved, on the Settings page.
// They are screen-fitting, not song-fitting: set once against the monitor you
// practise in front of and remembered (Size is also + and - on the player).
//
// Size is the distance between two staff lines: alphaTab's scale times the 9
// px it draws at scale 1. The Lamp spec's 2.25 -- 20.25 px, read from two
// metres -- is the default, and the ladder reaches past it both ways.
const SIZES = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3];
/** Which rung of the Size ladder is the default: 2.25, 20.25 px. */
const SIZE_HOME = SIZES.indexOf(2.25);
/** Pixels between two staff lines at alphaTab's scale 1. */
const STAFF_SPACE_PX = 9;

/** One of the four knobs: where it is, what it is remembered as, and how it reads. */
interface Knob {
  /** The slider, for the three that are sliders; Bars a line is a stepper. */
  el?: HTMLInputElement;
  out: HTMLOutputElement;
  /** The localStorage key it is remembered under. */
  key: string;
  /** The value `0` puts it back to. */
  home: number;
  min: number;
  max: number;
  value: number;
  /** The number beside the knob's name. */
  say: (v: number) => string;
  /**
   * Size only. It remembers the scale rather than the rung it is on, so
   * re-cutting the ladder cannot quietly turn a remembered size into another.
   * `load` returns -1 for a value that is no longer on the ladder, which is
   * out of range and so falls back to the default.
   */
  save?: (v: number) => string;
  load?: (raw: number) => number;
}

/** A slider knob, its range read off the markup. */
function slider(id: string, k: Omit<Knob, 'el' | 'out' | 'min' | 'max' | 'value'>): Knob {
  const el = byId<HTMLInputElement>(id);
  return { ...k, el, out: byId(`${id}-out`), min: Number(el.min), max: Number(el.max), value: k.home };
}

const knobs: Record<'size' | 'bars' | 'spacing' | 'gap', Knob> = {
  size: slider('zoom', {
    key: 'notationSize',
    home: SIZE_HOME,
    say: (v) => `${Number((SIZES[v]! * STAFF_SPACE_PX).toFixed(2))} px`,
    save: (v) => String(SIZES[v]!),
    load: (raw) => SIZES.indexOf(raw),
  }),
  bars: { out: byId('bars-out'), key: 'bars', home: 4, min: 1, max: 8, value: 4, say: (v) => String(v) },
  spacing: slider('spacing', { key: 'noteSpacing', home: 100, say: (v) => `${v}%` }),
  // 12 (27 px at 2.25) is exactly the sticking letters' lane under a line,
  // and no more: it is what lets three lines that each start a section fit
  // the compact paper's 870 px (Kill Me's tallest three: 866). Said in the
  // pixels it comes out at on the screen, which depends on the size too.
  gap: slider('gap', { key: 'lineGap', home: 12, say: (v) => `${Math.round(v * asked().scale)} px` }),
};

/** Put a knob at a value, if it is one the knob can take. */
function setKnob(k: Knob, v: number) {
  if (!Number.isFinite(v) || v < k.min || v > k.max) return;
  k.value = v;
  if (k.el) k.el.value = String(v);
}

/** Put a remembered value back on its knob. */
function restoreKnob(k: Knob) {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(k.key);
  } catch {
    /* private mode: there is nothing remembered */
  }
  if (raw === null) return;
  setKnob(k, k.load ? k.load(Number(raw)) : Number(raw));
}
for (const k of Object.values(knobs)) {
  setKnob(k, k.home);
  restoreKnob(k);
}

/** What the four knobs are asking for, in alphaTab's own terms. */
function asked() {
  return {
    scale: SIZES[knobs.size.value]!,
    barsPerRow: knobs.bars.value,
    stretchForce: knobs.spacing.value / 100,
    // What you see between two rows is one row's bottom padding plus the next
    // one's top, so the knob's number is split across the pair.
    systemPadding: knobs.gap.value / 2,
  };
}

/** The numbers beside the knobs, and the stepper's ends. */
function sayKnobs() {
  for (const k of Object.values(knobs)) k.out.textContent = k.say(k.value);
  byId<HTMLButtonElement>('bars-less').disabled = knobs.bars.value <= knobs.bars.min;
  byId<HTMLButtonElement>('bars-more').disabled = knobs.bars.value >= knobs.bars.max;
}

/**
 * Engrave at what the knobs say.
 *
 * Costs a full re-render, like a theme change, and like a theme change it
 * leaves the transport alone. The notation window re-measures itself
 * afterwards (postRenderFinished), so N lines stays N lines -- taller or
 * shorter ones.
 */
function applyLayout() {
  sayKnobs();
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

/** Engrave, and remember where this knob landed. */
function settle(k: Knob) {
  applyLayout();
  remember(k.key, (k.save ?? String)(k.value));
}

/** Move Size from the keyboard; the slider follows. */
function setSize(step: number) {
  setKnob(knobs.size, Math.max(knobs.size.min, Math.min(knobs.size.max, step)));
  settle(knobs.size);
}
const sizeStep = () => knobs.size.value;

/** All four back to the defaults: the one key the group keeps. */
function resetLayout() {
  for (const k of Object.values(knobs)) setKnob(k, k.home);
  applyLayout();
  for (const k of Object.values(knobs)) remember(k.key, (k.save ?? String)(k.home));
}

for (const k of Object.values(knobs)) {
  const el = k.el;
  if (!el) continue;
  // Two events, not one: `input` fires on every pixel of a drag and only
  // moves the number beside the slider, while the re-engrave waits for
  // `change` -- the mouse being let go, or one press of an arrow key.
  el.addEventListener('input', () => {
    k.value = Number(el.value);
    k.out.textContent = k.say(k.value);
  });
  el.addEventListener('change', () => {
    k.value = Number(el.value);
    settle(k);
  });
}
for (const [id, delta] of [
  ['bars-less', -1],
  ['bars-more', 1],
] as const) {
  byId<HTMLButtonElement>(id).addEventListener('click', () => {
    setKnob(knobs.bars, knobs.bars.value + delta);
    settle(knobs.bars);
  });
}

/** What the knobs say before alphaTab exists, to build it with. */
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
    // The four layout knobs, read straight off them, so that remembered
    // settings are engraved once.
    scale: start.scale,
    barsPerRow: start.barsPerRow,
    stretchForce: start.stretchForce,
    systemPaddingTop: start.systemPadding,
    systemPaddingBottom: start.systemPadding,
    resources: palette(),
  },
  notation: {
    elements: new Map([
      // One track, and its name ("Drums") in the margin says nothing.
      [alphaTab.NotationElement.TrackNames, false],
      // The song's title is in the header.
      [alphaTab.NotationElement.ScoreTitle, false],
      // The written tempo is a sync-friendly stand-in (see syncSafeTempo), not
      // the song's; the header shows the drummer's real one.
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

// The settings above were already built from the knobs; this only writes
// their numbers beside them and publishes the scale to the overlays.
applyLayout();

// --- the notation window ------------------------------------------------------
// Two lines of the score under the video, three without it (`applyHead`).
const scoreWindow = new ScoreWindow(api, byId<HTMLElement>('score-box'));

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
  remember('sticking', stickingEl.checked ? 'on' : 'off');
  stickingEl.blur();
});

// --- the paper's layers -------------------------------------------------------
// Section names in the label lane, the loop's bracket, the current bar's wash
// (layers.ts). The lane is the blank mark's band: LANE_PT, and alphaTab's
// padding under it (effectBandPaddingBottom, 2 at scale 1 -- measured, it
// comes out nearer 1).
const layers = new PaperLayers(api, scoreEl, LANE_PT + 1);

// Set once practice mode exists: the heatmap's noteheads are drawn from the
// paper's tokens, and it is built further down the file than the first
// applyTabTheme call.
let onTabThemeChange: (() => void) | undefined;

/**
 * Light up the chosen one of a row of choices (Settings' `.seg`): the button
 * whose `data-value` is `value`.
 */
function paintSeg(seg: HTMLElement, value: string) {
  for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.value === value));
  }
}
/** A row of choices: `pick` gets the `data-value` of the one clicked. */
function onSeg(seg: HTMLElement, pick: (value: string) => void) {
  for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) {
    b.addEventListener('click', () => {
      pick(b.dataset.value ?? '');
      b.blur();
    });
  }
}

/** Settings' Look: the two switches and the three pairings, from the page. */
function paintLook() {
  const ui = isDark() ? 'dark' : 'light';
  const paper = isTabDark() ? 'dark' : 'light';
  paintSeg(themeSeg, ui);
  paintSeg(tabThemeSeg, paper);
  for (const b of pairsEl.querySelectorAll<HTMLButtonElement>('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.ui === ui && b.dataset.paper === paper));
  }
}

/** The interface. Cheap: nothing here touches alphaTab. */
function applyUiTheme(light: boolean) {
  if (light) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  paintLook();
}

/** The paper. Costs a full re-render: alphaTab bakes the colours in. */
function applyTabTheme(dark: boolean) {
  if (dark) document.documentElement.dataset.tabTheme = 'dark';
  else delete document.documentElement.dataset.tabTheme;
  paintLook();
  // The fonts with it: Font objects given to the constructor's settings are
  // dropped on the way in (it reads them as JSON), so they go on here.
  Object.assign(api.settings.display.resources, palette(), engravedFonts());
  onTabThemeChange?.();
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

// What each song remembers: its tempo and its loop, and when it last played
// (library.ts `SongMemory`). Live reloads the page on every Ctrl+S of the set,
// so without this a save in the middle of looping a fill at 70% would land you
// on the whole song at 100%. It comes back as it was left -- the same loop on,
// the same tempo -- but never playing: a reload is not a gesture, and the
// browser would not let it make a sound anyway. The library reads it too:
// "chorus looped at 80%", and the song played last.
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
/** Set either or both; only a paper that actually changes is re-engraved. */
function setLook(ui: string | undefined, paper: string | undefined) {
  if (ui && (ui === 'light') !== !isDark()) {
    remember('theme', ui);
    applyUiTheme(ui === 'light');
  }
  if (paper && (paper === 'dark') !== isTabDark()) {
    remember('tabTheme', paper);
    applyTabTheme(paper === 'dark');
  }
}
onSeg(themeSeg, (v) => setLook(v, undefined));
onSeg(tabThemeSeg, (v) => setLook(undefined, v));
for (const b of pairsEl.querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => {
    setLook(b.dataset.ui, b.dataset.paper);
    b.blur();
  });
}
applyUiTheme(!isDark());
applyTabTheme(isTabDark());

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
// mixer.ts); the page only owns the Mix panel, remembered like the theme.

let stemsMissing: string[] = [];
let pictureFailed = '';
let stickingStale = '';
const mixer = new Mixer(mixEl, videoEl, clock, {
  onStemError: (name) => {
    stemsMissing.push(name);
    paintStems();
    showStatus();
  },
  onPictureError: () => {
    const err = videoEl.error;
    console.warn(`[drums] video: ${err?.message || `code ${err?.code}`}`);
    pictureFailed = 'The video would not load, so there is no picture.';
    showStatus();
  },
});

// --- the Mix panel ----------------------------------------------------------------
// Four channels (Lamp-08): a level and a mute each, remembered together as
// `mixer` in localStorage. A mute is not a level of 0: the level stays where it
// was set, dimmed, and 1-4 put the channel back at it. Muted, the mixer hears
// 0; moving a muted channel's slider unmutes it, since a slider you drag and
// cannot hear is the more confusing of the two.
//
// The click and the kit start muted: over a record each is a thing you ask
// for, not a thing that should start happening.
const LEVEL_HOME: Record<Fader, number> = { nodrums: 100, drums: 100, click: 60, kit: 80 };
const MUTED_HOME: readonly Fader[] = ['click', 'kit'];

// Built, not written: `#fader-drums` and friends look unreferenced to a grep.
const faderEl = (f: Fader) => document.getElementById(`fader-${f}`) as HTMLInputElement;
const faderOut = (f: Fader) => document.getElementById(`fader-${f}-out`) as HTMLOutputElement;
const muteEl = (f: Fader) => document.getElementById(`mute-${f}`) as HTMLButtonElement;
const rowEl = (f: Fader) => document.getElementById(`row-${f}`) as HTMLElement;

const mix = {
  level: { ...LEVEL_HOME },
  muted: new Set<Fader>(MUTED_HOME),
  /** Channels with nothing to play: the Kit with no bank baked. Said, not muted. */
  silent: new Set<Fader>(),
};

function recallMix() {
  try {
    const raw = localStorage.getItem('mixer');
    if (!raw) return;
    const parsed = JSON.parse(raw) as { level?: Record<string, unknown>; muted?: unknown };
    for (const f of FADERS) {
      const v = parsed.level?.[f];
      if (typeof v === 'number' && v >= 0 && v <= 100) mix.level[f] = v;
    }
    if (Array.isArray(parsed.muted)) {
      mix.muted = new Set(FADERS.filter((f) => (parsed.muted as unknown[]).includes(f)));
    }
  } catch {
    /* private mode, or nothing usable: the defaults */
  }
}

function saveMix() {
  remember('mixer', JSON.stringify({ level: mix.level, muted: [...mix.muted] }));
}

/** One channel, from the state: its row, and what the mixer hears. */
function paintFader(f: Fader) {
  const level = mix.level[f];
  const muted = mix.muted.has(f);
  const silent = mix.silent.has(f);
  faderEl(f).value = String(level);
  faderOut(f).textContent = silent ? '—' : `${level}%`;
  const mute = muteEl(f);
  mute.setAttribute('aria-pressed', String(muted));
  mute.firstElementChild!.textContent = muted ? 'Muted' : 'On';
  mute.title = `${muted ? 'Unmute' : 'Mute'} (${FADERS.indexOf(f) + 1})`;
  rowEl(f).toggleAttribute('data-muted', muted);
  rowEl(f).toggleAttribute('data-silent', silent);
  mixer.setLevel(f, muted ? 0 : level / 100);
}

/** Mute or unmute: the buttons and 1 2 3 4. */
function toggleMute(f: Fader) {
  if (mix.muted.has(f)) mix.muted.delete(f);
  else mix.muted.add(f);
  paintFader(f);
  saveMix();
}

/**
 * Make the click heard, for the calibration ritual: unmuted, and up if it was
 * at 0. True if it had to do anything.
 */
function clickAudible(): boolean {
  if (!mix.muted.has('click') && mix.level.click > 0) return false;
  mix.muted.delete('click');
  if (mix.level.click === 0) mix.level.click = LEVEL_HOME.click;
  paintFader('click');
  saveMix();
  return true;
}

recallMix();
for (const f of FADERS) {
  paintFader(f);
  faderEl(f).addEventListener('input', () => {
    mix.level[f] = Number(faderEl(f).value);
    mix.muted.delete(f);
    paintFader(f);
    saveMix();
  });
  muteEl(f).addEventListener('click', (e) => {
    toggleMute(f);
    if (e.detail > 0) muteEl(f).blur();
  });
}

/**
 * The stems as the panel shows them. Neither there (Lamp-08b): one row,
 * "Record", band and drums together -- the nodrums channel, which the mixer
 * then puts on the whole record -- and the reason under it. One missing: that
 * row says it is silent.
 */
function paintStems() {
  const none = stemsMissing.length > 1;
  rowEl('drums').hidden = none;
  byId('name-nodrums').textContent = none ? 'Record' : 'Band';
  byId('desc-nodrums').textContent = none ? 'band and drums together' : 'the record without its drums';
  faderEl('nodrums').setAttribute('aria-label', none ? 'Record level' : 'Band level');
  const say = byId<HTMLElement>('stems-note');
  say.textContent = none
    ? "This song's stems haven't been separated, so it plays the full record: its drummer can't be muted yet."
    : stemsMissing.length === 1
      ? stemsMissing[0] === 'drums'
        ? "The record's drum track is missing, so Drums is silent (drums separate)."
        : 'The record without its drums is missing, so Band is silent (drums separate).'
      : '';
  say.hidden = !say.textContent;
  // Under the row it is about: the Record row, or the missing one.
  rowEl(stemsMissing[0] === 'drums' && !none ? 'drums' : 'nodrums').after(say);
  mixPanel.toggleAttribute('data-no-stems', none);
}

let mixOpen = false;
function setMix(open: boolean) {
  mixOpen = open;
  mixPanel.hidden = !open;
  mixBtn.setAttribute('aria-expanded', String(open));
  // The picker lays over the top of the paper and the panel over the header
  // and down past it: one at a time.
  if (open && map.picking) setPicker(false);
}
const toggleMix = () => setMix(!mixOpen);
mixBtn.addEventListener('click', (e) => {
  toggleMix();
  if (e.detail > 0) mixBtn.blur();
});
byId<HTMLButtonElement>('mix-done').addEventListener('click', () => setMix(false));

// --- the status line ----------------------------------------------------------
// Only what a drummer needs, in plain words: something missing or wrong with
// the song's files, and what the loop, a count-in or practice mode last had to
// say. One small line at the right of the header's top row, not there at all when it
// has nothing to say. The numbers a developer wants go to the console when the
// song is ready, and "ready" itself is an attribute on <html> (`markReady`).

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
    return "This song's stems haven't been separated, so the whole record plays: its drummer can't be muted.";
  }
  return stemsMissing[0] === 'drums'
    ? "The record's drum track is missing, so Drums is silent."
    : 'The record without its drums is missing, so Band is silent.';
}

// The Kit row's own message, under it in the Mix panel, shown only when there
// is something wrong with it.
//
// It has its own place rather than joining the status above because the thing
// it reports is a property of the *bank*, not of the song: a channel that has
// nothing to play looks exactly like one turned down, and there is no other
// way to tell them apart.
const kitNoteEl = byId<HTMLParagraphElement>('kit-note');

async function showKitNote() {
  await mixer.bank.ready();
  const bank = mixer.bank;
  const lines: string[] = [];
  if (!bank.baked) {
    lines.push(
      "Kit is silent: the drum samples haven't been made yet. Run <code>drums kit-bake</code> in a terminal."
    );
  } else {
    const cannot = mixer.unplayable(practice.wholeSong());
    if (cannot.length) lines.push(`Kit has no sample for ${cannot.join(', ')}, so those notes are silent.`);
    if (bank.missing.length) {
      lines.push(`${bank.missing.length} of the kit's recordings would not load.`);
    }
  }
  kitNoteEl.innerHTML = lines.join('<br>');
  kitNoteEl.hidden = lines.length === 0;
  if (bank.baked) mix.silent.delete('kit');
  else mix.silent.add('kit');
  paintFader('kit');
}

// --- the loop -----------------------------------------------------------------------
// A section or a run of bars, round and round on the record's own clock
// (loop.ts). What happens between passes and whether the first one is counted
// in are habits rather than properties of a song, so they are remembered once
// for all of them (Settings); the range, whether it is on and the ramp are
// remembered per song (`memorise`).
const recalled = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
/** Between passes: a bar of click (the default) or straight back. */
let loopRest = recalled('loopRest') !== 'off';
paintSeg(loopBetween, loopRest ? 'click' : 'straight');
onSeg(loopBetween, (v) => {
  loopRest = v === 'click';
  remember('loopRest', loopRest ? 'on' : 'off');
  paintSeg(loopBetween, v);
});
countInLoopEl.checked = recalled('countInLoop') !== 'off';
countInLoopEl.addEventListener('change', () => {
  remember('countInLoop', countInLoopEl.checked ? 'on' : 'off');
  countInLoopEl.blur();
});
const loop: Loop = new Loop(
  api,
  clock,
  mixer,
  {
    pill: loopBtn,
    rampFrom: byId('ramp-from'),
    rampStep: byId('ramp-step'),
    rampEvery: byId('ramp-every'),
    rampTo: byId('ramp-to'),
    rampGate: byId('ramp-gate'),
  },
  {
    tempo: () => tempo,
    setTempo: (percent) => applySpeed(percent),
    say: tell,
    restBar: () => loopRest,
    countInFirst: () => countInLoopEl.checked,
    changed: () => {
      paintPlay();
      practice.refresh();
      if (current) memorise(current.slug, { loop: loop.snapshot() });
    },
    painted: () => {
      paintPass();
      paintTempo();
    },
    busy: (): boolean => practice.busy,
    drawn: () => {
      const on = loop.armed ? loop.range : undefined;
      map.loop = on;
      layers.setLoop(on);
    },
  }
);
rampBtn.addEventListener('click', () => {
  loop.toggleRamp();
  rampBtn.blur();
});

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
    kitState: byId('kit-state'),
    port: byId('midi-port'),
    calibrate: byId('calibrate'),
    calibration: byId('calibration'),
    record: byId('record'),
    recordWord: byId('record-word'),
    chip: byId('kit-chip'),
    chipSays: byId('kit-chip-says'),
    card: byId('reading'),
    app: appEl,
    monitorOn: byId('monitor-on'),
    monitor: byId('monitor'),
    clickAudible,
    // The card takes the pass block's room, and the section name has less;
    // the pass block says when the whole song is being recorded.
    relaid: () => {
      fitSection();
      paintPass();
    },
  },
  scoreEl,
  tell
);
onTabThemeChange = () => practice.retheme();

// --- the header ---------------------------------------------------------------------
// Lamp-01: where you are (the section, bar N of M), the loop's pass, the tempo.
// Each is painted from the state it shows, on the event that moves it: the
// cursor for where, the loop's repaint for the pass, applySpeed for the tempo.

/** `bars 9–16`, the way the header says a range. */
const barsSaid = (r: LoopRange) =>
  r.startBar === r.endBar ? `bar ${r.startBar}` : `bars ${r.startBar}–${r.endBar}`;

/** `chorus · bars 9–16`, or just the bars when they are not one section. */
function loopSaid(): string {
  const r = loop.range;
  if (!r) return '';
  const name = rangeName(current?.sections ?? [], r);
  return name.startsWith('bar') ? barsSaid(r) : `${name} · ${barsSaid(r)}`;
}

function paintPass() {
  const armed = loop.armed;
  head.barPass.textContent = '';
  head.pass.toggleAttribute('data-on', armed);
  rampBtn.hidden = !armed;
  rampBtn.setAttribute('aria-pressed', String(loop.ramp.on));
  if (!armed) {
    head.passMain.textContent = 'loop off';
    head.passSub.textContent = appEl.hasAttribute('data-recording') ? 'recording the whole song' : 'playing the whole song';
    return;
  }
  if (!loop.running) {
    head.passMain.textContent = 'loop on';
    head.passSub.textContent = loopSaid();
    return;
  }
  const pass = loop.pass;
  head.passMain.textContent = pass === 0 ? 'counting in' : `pass ${pass}`;
  // Lamp-12: with the reading card in the pass block's place, the pass
  // number goes beside the bar.
  head.barPass.textContent = pass === 0 ? '' : `pass ${pass}`;
  const at = loop.rampAt();
  head.passSub.textContent = at && pass > 0 ? rampNext(loop.ramp, at) : `looping ${loopSaid()}`;
}

function paintTempo() {
  head.tempoNum.textContent = String(tempo);
  paintLadder();
  const bpm = current?.grid?.score.bpm;
  if (!bpm) {
    head.tempoBpm.textContent = current ? 'no beat map' : '';
    return;
  }
  const now = document.createElement('b');
  now.textContent = String(Math.round((bpm * tempo) / 100));
  const ramp = loop.ramp;
  const then = document.createElement('span');
  then.className = 'then';
  then.textContent = ` · ${loop.armed && ramp.on ? `ramp to ${ramp.to}%` : `record ${Math.round(bpm)}`}`;
  // The second half steps aside beside the reading card (Lamp-12: "104 BPM").
  head.tempoBpm.replaceChildren(now, ' BPM', then);
}

/**
 * The ramp's ladder in place of the tempo pills while the ramp is on
 * (Lamp-04): the rungs climbed in a wash, the one playing filled and wider,
 * the next one dashed, the rest outlined. Not buttons: the ramp sets the tempo,
 * and the keys still move it by hand.
 */
function paintLadder() {
  const on = loop.armed && loop.ramp.on;
  head.steps.hidden = on;
  head.ladder.hidden = !on;
  if (!on) return;
  const rungs = rampLadder(loop.ramp, tempo);
  head.ladder.replaceChildren(
    ...rungs.map((r) => {
      const el = document.createElement('span');
      el.className = 'rung';
      el.dataset.state = r.state;
      el.textContent = String(r.tempo);
      return el;
    })
  );
  const r = loop.ramp;
  head.ladder.setAttribute(
    'aria-label',
    `Ramp: ${r.from}% to ${r.to}%, ${r.step}% up every ${r.every === 1 ? 'pass' : `${r.every} passes`}; now at ${tempo}%`
  );
}

/** The bar the header last painted, so a position event mid-bar costs nothing. */
let shownBar = -1;
let shownSection: string | undefined;

/** Where the cursor is: the section's name and bar N of M. */
function paintWhere(tick = api.tickPosition) {
  if (!current || !api.score) return;
  const bar = barAtTick(api.score, tick);
  if (bar === shownBar) return;
  shownBar = bar;
  head.barNow.textContent = `bar ${bar + 1}`;
  head.barTotal.textContent = `of ${current.bars}`;
  const name = current.sections.find((s) => bar + 1 >= s.start_bar && bar + 1 <= s.end_bar)?.name ?? '';
  if (name !== shownSection) {
    shownSection = name;
    // A space rather than nothing: an empty line would let the bar number
    // jump up into its place.
    head.section.textContent = name || ' ';
    fitSection();
  }
}

/**
 * The section name at 120, or 88, or 64 if that is what it takes to fit its
 * space ("chorus to break" is 880 px at 120). Never below 64: past that it is
 * cut with an ellipsis instead.
 */
function fitSection() {
  const el = head.section;
  delete el.dataset.step;
  if (appEl.dataset.head !== 'full') return;
  for (const step of ['1', '2']) {
    if (el.scrollWidth <= el.clientWidth) return;
    el.dataset.step = step;
  }
}
// Measured in the fallback face, a name would be fitted to the wrong width.
void document.fonts.ready.then(fitSection);

// --- the song map ---------------------------------------------------------------------
// The whole song as blocks (songmap.ts): a click jumps to a section; the Loop
// pill, or L with no loop on, opens it as the picker. The picker's rules are
// the prototype's (design/lamp/Lamp-Prototype): a click loops a section,
// shift-click stretches the loop over both, a click inside the loop turns it
// off. What a pick does while the song plays is loop.ts's (`setRange`).

const map = new SongMap(byId<HTMLElement>('map'), {
  jump: (bar) => seekToBar(bar - 1),
  pickSection: (i, stretch) => {
    const s = current?.sections[i];
    if (!s) return;
    const cur = loop.armed ? loop.range : undefined;
    if (stretch && cur) {
      loop.setRange({ startBar: Math.min(cur.startBar, s.start_bar), endBar: Math.max(cur.endBar, s.end_bar) });
    } else if (cur && s.start_bar >= cur.startBar && s.end_bar <= cur.endBar) {
      loop.off();
    } else {
      loop.setRange({ startBar: s.start_bar, endBar: s.end_bar });
    }
  },
  pickRange: (r) => loop.setRange(r),
  off: () => loop.off(),
  done: () => setPicker(false),
});

function setPicker(open: boolean) {
  if (open && mixOpen) setMix(false);
  if (open) map.open();
  else map.close();
  loopBtn.setAttribute('aria-expanded', String(map.picking));
}

// The pill opens and closes the picker; the loop itself is turned on by a
// pick and off in the picker (or L).
loopBtn.addEventListener('click', (e) => {
  setPicker(!map.picking);
  if (e.detail > 0) loopBtn.blur();
});

/**
 * L. With a loop on, off. With none, loop the section the cursor is in --
 * the one you are playing, or looking at -- and open the picker to adjust it.
 */
function loopKey() {
  if (loop.armed) {
    loop.off();
    setPicker(false);
    return;
  }
  const bar = currentBar() + 1;
  const s = current?.sections.find((x) => bar >= x.start_bar && bar <= x.end_bar);
  loop.setRange(s ? { startBar: s.start_bar, endBar: s.end_bar } : { startBar: bar, endBar: bar });
  setPicker(true);
}

/** Where the playhead is, in bars, for the map: the bar and how far through it. */
function mapAt(tick: number): number | undefined {
  const score = api.score;
  if (!score) return undefined;
  const i = barAtTick(score, tick);
  const bar = score.masterBars[i];
  if (!bar) return undefined;
  const len = bar.calculateDuration();
  return i + 1 + (len > 0 ? Math.max(0, Math.min(1, (tick - bar.start) / len)) : 0);
}

api.playerPositionChanged.on((e) => {
  paintWhere(e.currentTick);
  const at = mapAt(e.currentTick);
  if (at !== undefined) map.setAt(at);
  // A click on the line being looked at puts the cursor there: no longer away.
  if (browsing) paintBrowse();
});

// --- the video, shown or hidden ----------------------------------------------------
// V and the Video button. Hidden, the header folds to the compact band of
// Lamp-02 and the paper gets a third line; a song with no video is always
// like that (Lamp-03) and has no Video button. The paper's width is the same
// either way, so this never re-engraves -- only the window's height moves.
let videoHidden = false;
try {
  videoHidden = localStorage.getItem('video') === 'hidden';
} catch {
  /* private mode: shown */
}

function applyHead() {
  const hasVideo = !!current?.video;
  const full = hasVideo && !videoHidden;
  appEl.dataset.head = full ? 'full' : 'compact';
  videoBtn.hidden = !hasVideo;
  videoBtn.classList.toggle('off', videoHidden);
  videoBtn.setAttribute('aria-pressed', String(!videoHidden));
  // Zen (Lamp-11) keeps the picture's two lines under it; without one the
  // paper has the whole screen, and as many whole lines as fit there.
  scoreWindow.lines = full ? 2 : zen ? 4 : 3;
  fitSection();
  // Two lines or three: browsing shows other bars.
  paintBrowse();
}

function toggleVideo() {
  if (!current?.video) return;
  videoHidden = !videoHidden;
  remember('video', videoHidden ? 'hidden' : 'shown');
  applyHead();
}
videoBtn.addEventListener('click', () => {
  toggleVideo();
  videoBtn.blur();
});

// --- Settings ------------------------------------------------------------------------
// A page over the whole player (Lamp-10): between songs, so it may cover it --
// and only covers it: whatever is playing goes on. The gear opens it; Done and
// Esc close it. While it is up, the player's keys are off but for Space.
function setSettings(open: boolean) {
  settingsEl.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    setMix(false);
    if (map.picking) setPicker(false);
    settingsEl.scrollTop = 0;
  }
}
settingsBtn.addEventListener('click', () => {
  setSettings(true);
  settingsBtn.blur();
});
byId<HTMLButtonElement>('settings-done').addEventListener('click', () => setSettings(false));

// --- the library ---------------------------------------------------------------------
// The songs (Lamp-09, library.ts): the home page, the route with no song in it.
// The Songs icon goes there; a row, or Enter on it, goes to the song's own
// route. Whatever was playing stops: the library is between songs.
const LIBRARY_ROUTE = '#/songs';
const libraryEl = byId<HTMLElement>('library');
const library = new Library(libraryEl, byId<HTMLElement>('lib-list'), {
  songs: () =>
    playable.map((s) => ({
      slug: s.slug,
      artist: s.artist,
      title: s.title,
      seconds: s.seconds,
      bpm: s.bpm,
      bars: s.bars,
      video: s.media.video,
      sections: s.sections,
      memory: recall(s.slug),
    })),
  href: (slug) => `#${encodeURIComponent(slug)}`,
});

function showLibrary() {
  halt();
  setMix(false);
  setSettings(false);
  if (map.picking) setPicker(false);
  setZen(false);
  library.show(current?.slug);
}
const songsBtn = byId<HTMLButtonElement>('songs-btn');
songsBtn.addEventListener('click', () => {
  songsBtn.blur();
  location.hash = LIBRARY_ROUTE;
});
byId<HTMLButtonElement>('lib-settings').addEventListener('click', (e) => {
  setSettings(true);
  (e.currentTarget as HTMLElement).blur();
});

// --- ready ----------------------------------------------------------------------
// A song is ready when its score is engraved and the player can play it. The
// two arrive in either order (with external media the player is ready before
// the first row is drawn), so each one checks for the other.
//
// It is said with `data-ready="<slug>"` on <html>, not on the status line:
// the headless checks wait for it (scripts/browser.mjs `waitForPlayer`).

/** The song `load` is waiting to see engraved, and what to log once it is. */
let pending: { slug: string; score: alphaTab.model.Score; rendered: boolean; diagnostics: string } | undefined;
let playerLoaded = false;
/** The count-in from a pause under way, if there is one (`resume`, further down). */
let resuming: CountIn | undefined;

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
  playerLoaded = true;
  markReady();
});

/**
 * What the Play button shows.
 *
 * Not only alphaTab's own state: a loop pauses the transport at the end of
 * every pass, and a count-in -- a loop's, or one from a pause -- clicks before
 * the transport has moved at all, so alphaTab is legitimately stopped while
 * the thing you asked for is very much still going.
 */
function paintPlay(state = api.playerState) {
  const playing = state === alphaTab.synth.PlayerState.Playing || loop.running || !!resuming;
  const word = playing ? 'Pause' : 'Play';
  playBtn.dataset.state = playing ? 'pause' : 'play';
  playBtn.setAttribute('aria-label', word);
  playWord.textContent = word;
}

/**
 * Where play last stopped, in ticks: what Home goes back to (Lamp-06's "Back
 * to bar 11"). A pause, a loop stopped, the end of a take -- but not a loop's
 * own turn-round, which is a pause nobody asked for.
 */
let stoppedTick: number | undefined;

api.playerStateChanged.on((e) => {
  paintPlay(e.state);
  if (e.state === alphaTab.synth.PlayerState.Paused && !loop.running && !resuming) {
    stoppedTick = api.tickPosition;
  }
  // For the library: played, and so where it was left off, and when.
  if (e.state === alphaTab.synth.PlayerState.Playing && current) memorise(current.slug, { played: Date.now() });
  paintBrowse();
});
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
  void c.done.then((go) => {
    if (resuming !== c) return;
    resuming = undefined;
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
  paintPlay();
}

// --- the count-in, shown -------------------------------------------------------------
// Lamp-05: while a count-in clicks -- a loop's first pass, the rest bar
// between passes, Play from a pause, Record -- the section's name gives way to
// "count-in · then chorus, bar 9, pass 1" and 1 2 3 4 at 160 px: the beats
// counted in faint, the one sounding in brass, the ones to come dim. Each
// number is lit by its click: the clicks' own times on the audio clock
// (click.ts `CountInShown`), read against what the speakers are playing now,
// not a timer started beside them.

let counting: CountInShown | undefined;
let countFrame = 0;

/** "then chorus, bar 9, pass 1": what the count-in leads into. */
function countSays(): DocumentFragment {
  const grid = current?.grid;
  const running = loop.running && loop.range;
  const bar = running
    ? loop.range!.startBar
    : grid
      ? Math.max(0, barAtMs(grid, clock.mixTimeMs)) + 1
      : currentBar() + 1;
  const name = current?.sections.find((s) => bar >= s.start_bar && bar <= s.end_bar)?.name;
  const f = document.createDocumentFragment();
  const b = document.createElement('b');
  b.textContent = name ? `${name}, bar ${bar}` : `bar ${bar}`;
  const after = running ? `, pass ${loop.pass + 1}` : practice.busy ? ', recording' : '';
  f.append('count-in · then ', b, after);
  return f;
}

/** The moment the speakers are playing, in the audio clock's seconds. */
function heardS(ctx: AudioContext): number {
  const ts = ctx.getOutputTimestamp();
  if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
    return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
  }
  return ctx.currentTime - (ctx.outputLatency || 0) - ctx.baseLatency;
}

function showCount(c: CountInShown) {
  counting = c;
  const perBar = Math.min(c.beats, current?.grid?.meter.beats_per_bar ?? 4);
  head.countSays.replaceChildren(countSays());
  head.countBeats.replaceChildren(
    ...Array.from({ length: perBar }, (_, i) => {
      const n = document.createElement('span');
      n.textContent = String(i + 1);
      return n;
    })
  );
  appEl.dataset.counting = 'on';
  let lit = -2;
  const frame = () => {
    if (counting !== c) return;
    const beat = Math.min(c.beats - 1, Math.floor((heardS(c.ctx) - c.first) / c.beatS + 1e-6));
    if (beat !== lit) {
      lit = beat;
      const at = beat < 0 ? -1 : beat % perBar;
      head.countBeats.querySelectorAll('span').forEach((n, i) => {
        n.dataset.beat = i < at ? 'done' : i === at ? 'now' : 'to-come';
      });
      head.countBeats.setAttribute('aria-label', beat < 0 ? 'Count-in' : `Count-in, beat ${at + 1} of ${perBar}`);
    }
    countFrame = requestAnimationFrame(frame);
  };
  cancelAnimationFrame(countFrame);
  frame();
  void c.done.then(() => {
    if (counting !== c) return;
    counting = undefined;
    cancelAnimationFrame(countFrame);
    delete appEl.dataset.counting;
  });
}
watchCountIns(showCount);

// Blur after a click so a following Space toggles playback once, not twice
// (the focused button would fire its own click on the same key).
playBtn.addEventListener('click', () => {
  togglePlay();
  playBtn.blur();
});

/** Whatever is going stops where it is: the library is between songs. */
function halt() {
  loop.stop(true);
  cancelResume();
  if (api.playerState === alphaTab.synth.PlayerState.Playing) api.pause();
}

// Stop means the top of the song, count-in included. alphaTab's own stop
// seeks to the score's tick 0, which is the first beat of bar 1, a couple of
// seconds in. A loop going round stops too, and stays on: Play starts it again.
function stop() {
  loop.stop();
  cancelResume();
  api.stop();
  mixEl.currentTime = 0;
  stoppedTick = undefined;
}

/**
 * Home: back to where play stopped, and pressed again, the top. Browsing
 * while paused -- the arrows, the wheel, a click on the score -- is a look
 * ahead, and this is the way back to the bar you were playing. Playing, it
 * is Stop, as it always was.
 */
function home() {
  if (browsing) {
    backToCursor();
    return;
  }
  const playing = isPlaying();
  // Ticks rather than bars: a sixteenth of slack for the round trip through
  // the media clock, and anything further is somewhere else.
  if (!playing && stoppedTick !== undefined && Math.abs(api.tickPosition - stoppedTick) > 240) {
    api.tickPosition = stoppedTick;
    return;
  }
  stop();
}

/** Whether anything is going: the transport, a loop between passes, a count-in. */
const isPlaying = () => api.playerState === alphaTab.synth.PlayerState.Playing || loop.running || !!resuming;

// --- browsing while paused -----------------------------------------------------------
// Lamp-06. Paused, the wheel turns the paper a line at a time without moving
// the cursor: a look ahead (or back) while play waits where it stopped. The
// page says so everywhere at once -- the bars on show and "play goes on from
// bar 11" in place of the pass, a dashed edge round the paper and a dashed box
// over those bars on the map, "paused" after the title, the picture dimmed --
// and a "Back to bar 11" pill, or Home, brings the paper back to the cursor.


function paintBrowse() {
  // Nothing to browse before a song, and alphaTab says its state before the
  // rest of this file has run.
  if (!current && !browsing) return;
  const cursorRow = scoreWindow.rowOf(currentBar());
  const shown = scoreWindow.bars;
  const away =
    !!current && !zen && !isPlaying() && cursorRow !== undefined && !!shown && scoreWindow.row !== cursorRow;
  const was = browsing;
  browsing = away ? (scoreWindow.row > cursorRow! ? 'ahead' : 'back') : undefined;
  if (browsing) appEl.dataset.browsing = browsing;
  else delete appEl.dataset.browsing;
  head.titleState.textContent = browsing ? ' · paused' : '';
  head.browse.hidden = !browsing;
  head.back.hidden = !browsing;
  map.view = browsing && shown ? { startBar: shown[0] + 1, endBar: shown[1] + 1 } : undefined;
  if (!browsing || !shown) return;
  const bar = currentBar() + 1;
  head.browseMain.textContent = shown[0] === shown[1] ? `bar ${shown[0] + 1}` : `bars ${shown[0] + 1}–${shown[1] + 1}`;
  head.browseSub.textContent = `looking ${browsing}; play goes on from bar ${bar}`;
  head.backBar.textContent = `Back to bar ${bar}`;
  head.back.title = `Back to bar ${bar}, where play goes on from (Home)`;
  if (!was) fitSection();
}

/** The paper back on the cursor's line. */
function backToCursor() {
  const row = scoreWindow.rowOf(currentBar());
  if (row !== undefined) scoreWindow.show(row);
  paintBrowse();
}
scoreWindow.onMove = paintBrowse;
head.back.addEventListener('click', () => {
  backToCursor();
  head.back.blur();
});

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
 * Set the tempo. The one setter: the readout, alphaTab and the song's memory
 * all move here and nowhere else, so the keys, the pills and a loop's ramp can
 * never disagree about it.
 */
function applySpeed(percent: number) {
  // On the 5% rungs the steps and the ramp move in.
  const p = snapTempo(percent);
  tempo = p;
  // Through alphaTab, never straight onto the element: alphaTab derives the
  // cursor animation speed from playbackSpeed and forwards it to the video.
  api.playbackSpeed = p / 100;
  paintTempo();
  if (current) memorise(current.slug, { tempo: p });
  loop.refresh();
}
/** A step up or down from where the tempo is. */
const stepTempo = (delta: number) => applySpeed(tempo + delta);
// The pills: -10 -5 100% +5 +10. The steps are the way the tempo is actually
// moved in practice -- slower to learn a part, then back up a notch at a time
// -- and 100% is the way home.
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

async function load(slug: string) {
  playBtn.disabled = true;
  // Whatever was going round belongs to the song being left -- stopped before
  // `current` moves on, so it is remembered under that song and not this one.
  loop.stop();
  cancelResume();
  api.stop();
  stoppedTick = undefined;
  delete document.documentElement.dataset.ready;
  pending = undefined;
  const song = playable.find((s) => s.slug === slug);
  const midiUrl = midiBySlug.get(slug);
  if (!song || !midiUrl) {
    setStatus('No song selected.');
    return;
  }
  setStatus(`Loading ${song.title} — ${song.artist}…`);
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

  // The label lane: a line a section starts in is engraved taller by one lane,
  // and the page writes the section's name in it (layers.ts). alphaTab's own
  // rehearsal mark is what makes the room -- it puts its band above everything
  // else on the line, and only on lines that have one -- but it is given a
  // blank to draw, so the name is ours: our face, our colour, never over a
  // note, and the same lane the loop bracket is drawn under.
  for (const section of song.sections) {
    const bar = score.masterBars[section.start_bar - 1];
    if (!bar || !section.name) continue;
    const marker = new alphaTab.model.Section();
    marker.marker = '';
    marker.text = ' ';
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
  // Lamp-01: "Song 2 — Blur", the title the louder of the two.
  const name = document.createElement('b');
  name.textContent = song.title;
  head.title.replaceChildren(name, ` — ${song.artist}`);
  document.title = `${song.title} — ${song.artist}`;
  current = { slug, grid, syncPoints, bars, sections: song.sections, video: hasVideo };
  map.load(song.sections, bars);
  layers.load(song.sections);
  shownBar = -1;
  shownSection = undefined;

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
  paintStems();
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
  applyHead();
  paintPass();
  pending = { slug, score, rendered: false, diagnostics };
  api.renderScore(score);
  paintWhere(0);
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
const CLEF_GLYPH = '';
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
// one thing allowed to end it. (C5 designs it; this is the old one, re-laid.)

const zenExitBtn = byId<HTMLButtonElement>('zen-exit');

/** The page's half of it: the chrome goes, the stage takes the window. */
function paintZen(on: boolean) {
  zen = on;
  // A value, not the bare attribute: the CSS only asks whether it is there,
  // but an empty string reads back as false to anything checking dataset.zen.
  if (on) document.documentElement.dataset.zen = 'on';
  else delete document.documentElement.dataset.zen;
  if (on && map.picking) setPicker(false);
  applyHead();
  paintBrowse();
}

function setZen(on: boolean) {
  if (on === zen) return;
  paintZen(on);
  if (on) {
    setMix(false);
    setSettings(false);
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
// the listener above is what Esc is really wired to. This covers the cases it
// cannot: zen that never got fullscreen, Settings, the mix and the picker.
// Its own listener rather than an entry in `keys`, which preventDefaults
// everything in it -- Escape belongs to the browser.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape') return;
  if (!settingsEl.hidden) setSettings(false);
  // Out of the library, back to the song it was opened from.
  else if (library.shown && current) location.hash = encodeURIComponent(current.slug);
  else if (mixOpen) setMix(false);
  else if (map.picking) setPicker(false);
  // The reading card, once the recording is over (practice.ts `dismiss`).
  else if (practice.dismissible) practice.dismiss();
  else if (zen && !document.fullscreenElement) paintZen(false);
});
zenExitBtn.addEventListener('click', () => {
  setZen(false);
  zenExitBtn.blur();
});

// --- keyboard -------------------------------------------------------------------
// From anywhere except a control that uses the key itself (a select, a
// number field, a slider being dragged). The list is on the Settings page,
// and in design/lamp/Lamp-10-settings.
const keys: Record<string, (e: KeyboardEvent) => void> = {
  Space: togglePlay,
  Home: home,
  ArrowLeft: () => seekBars(-1),
  ArrowRight: () => seekBars(1),
  ArrowUp: () => seekLines(-1),
  ArrowDown: () => seekLines(1),
  // Shift is let through by the handler below, so Shift+[ -- which is what
  // `{` is on most layouts -- arrives here too: the same key, a bigger step.
  BracketLeft: (e) => stepTempo(e.shiftKey ? -10 : -5),
  BracketRight: (e) => stepTempo(e.shiftKey ? 10 : 5),
  // Beside the brackets on most keyboards: the way home from any tempo.
  Backslash: () => applySpeed(100),
  KeyL: loopKey,
  KeyR: () => loop.toggleRamp(),
  KeyM: toggleMix,
  KeyV: toggleVideo,
  // `+` is Shift and the `=` key on most layouts, and the handler below lets
  // Shift through, so both spellings of the same key arrive as Equal.
  Equal: () => setSize(sizeStep() + 1),
  Minus: () => setSize(sizeStep() - 1),
  NumpadAdd: () => setSize(sizeStep() + 1),
  NumpadSubtract: () => setSize(sizeStep() - 1),
  // 0 is the way back from a layout that turned out to be a bad idea.
  Digit0: resetLayout,
  Numpad0: resetLayout,
  Digit1: () => toggleMute('nodrums'),
  Digit2: () => toggleMute('drums'),
  Digit3: () => toggleMute('click'),
  Digit4: () => toggleMute('kit'),
  KeyZ: () => setZen(!zen),
};
/**
 * `{` and `}` by the character, checked before the key's code: the character
 * is what was meant, whether it came as Shift and a bracket, from a layout
 * where it is somewhere else, or from something that sends the character
 * without saying Shift was held (which the code alone would read as 5).
 */
const keysByChar: Record<string, () => void> = {
  '{': () => stepTempo(-10),
  '}': () => stepTempo(10),
};
/** Switches: a held key repeats, and a switch should not flicker while it is held. */
const NO_REPEAT = new Set(['Space', 'KeyL', 'KeyR', 'KeyM', 'KeyV', 'KeyZ']);
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // The library has its own keys (↑ ↓, Home, End; Enter is the row's), and
  // none of the player's: there is no song under it to play.
  if (library.shown) {
    if (settingsEl.hidden && library.key(e.code)) e.preventDefault();
    return;
  }
  const action = keysByChar[e.key] ?? keys[e.code];
  if (!action) return;
  if (e.repeat && NO_REPEAT.has(e.code)) return;
  const target = e.target as HTMLElement | null;
  if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
  // Settings covers the player: nothing on it moves under the page but play.
  if (!settingsEl.hidden && e.code !== 'Space') return;
  e.preventDefault();
  action(e);
});

// --- the router -------------------------------------------------------------------
// The hash is the song's slug, and that is the whole of it. It survives the
// full reload Ableton triggers on every Ctrl+S, and it makes a song a link you
// can keep.

const slugOfHash = (hash: string) => decodeURIComponent(hash.replace(/^#/, ''));

/**
 * Where the hash says to be: a song's slug is that song; nothing, `/songs`, or
 * a slug that is no song here is the library.
 */
async function go(wanted: string) {
  const song = playable.find((s) => s.slug === wanted);
  if (!song) {
    showLibrary();
    return;
  }
  library.hide();
  if (song.slug !== current?.slug) await load(song.slug);
}
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
    setMix,
    setSettings,
    library,
    // The tempo's one setter, in percent, for a check that wants one exactly.
    setTempo: applySpeed,
    // The bar->ms primitive, so a check can work out where a range starts and
    // ends without reimplementing the beat map.
    barStartMs,
    get current() {
      return current;
    },
    get tempo() {
      return tempo;
    },
  };
}

void go(slugOfHash(location.hash));
