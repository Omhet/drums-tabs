// The tab strip under a cover video, engraved once for scripts/render-tab.mjs.
//
// Not part of the app: no transport, no player, no chrome. It draws a song's
// tab.mid with the same notation settings the player uses (main.ts), on white
// paper, and then publishes where every beat landed so pipeline/cover_strip.py
// can move a playhead across the picture in step with the video.
//
// Query parameters:
//   song         the slug (songs/<slug>/tab.mid)
//   layout       `scroll`: the whole song on one endless line, every bar the
//                same width so that `barsPerRow` bars fill `width` exactly;
//                `flip`: page layout, `barsPerRow` bars to a row, rows `width`
//                wide.
//   scale        alphaTab's display scale (staff size)
//   barsPerRow   4 by default
//   width        CSS px the strip is shown at (= output video width)
//
// When engraved it sets `window.coverTab = { beats, bars, rows, width, height,
// ticksPerBeat }`; positions are CSS px from the top-left of #score.
import * as alphaTab from '@coderline/alphatab';
import songs from 'virtual:songs';
import { midiToAlphaTex, type TabResult } from './midi-tab';
import type { Grid } from './syncpoints';

const midiUrls = import.meta.glob('../../songs/*/tab.mid', {
  query: '?url',
  import: 'default',
}) as Record<string, () => Promise<string>>;
const grids = import.meta.glob('../../songs/*/grid.lock.json', {
  import: 'default',
}) as Record<string, () => Promise<Grid>>;
const slugOf = (path: string) => path.split('/').at(-2)!;

/** tab.mid's resolution (pipeline/cover.py TICKS_PER_BEAT). alphaTab counts 960. */
const TAB_TICKS_PER_BEAT = 480;
const ALPHATAB_TICKS_PER_BEAT = 960;
const TO_TAB = TAB_TICKS_PER_BEAT / ALPHATAB_TICKS_PER_BEAT;

const q = new URLSearchParams(location.search);
const slug = q.get('song') ?? '';
const layout = q.get('layout') === 'flip' ? 'flip' : 'scroll';
const scale = Number(q.get('scale') ?? 1);
const barsPerRow = Number(q.get('barsPerRow') ?? 4);
const width = Number(q.get('width') ?? 1080);

const scoreEl = document.getElementById('score') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const say = (text: string) => {
  statusEl.textContent = text;
};
window.addEventListener('error', (e) => say(`Script error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => say(`Unhandled rejection: ${e.reason}`));

// Flip rows are exactly `width` wide; the scroll line is as long as it needs.
if (layout === 'flip') scoreEl.style.width = `${width}px`;

const C = alphaTab.model.Color;
const ink = new C(0, 0, 0);
const PAD_X = 12;

const api = new alphaTab.AlphaTabApi(scoreEl, {
  core: { tex: true, fontDirectory: '/font/', enableLazyLoading: false },
  display: {
    scale,
    layoutMode: layout === 'flip' ? alphaTab.LayoutMode.Page : alphaTab.LayoutMode.Horizontal,
    // Horizontal layout sizes each bar by its displayWidth only in model mode.
    systemsLayoutMode:
      layout === 'flip' ? alphaTab.SystemsLayoutMode.Automatic : alphaTab.SystemsLayoutMode.UseModelLayout,
    barsPerRow: layout === 'flip' ? barsPerRow : -1,
    padding: [PAD_X, 8, PAD_X, 8],
    firstSystemPaddingTop: 0,
    systemPaddingTop: 6,
    systemPaddingBottom: 6,
    lastSystemPaddingBottom: 0,
    // A short last row keeps its bars at their natural width rather than one
    // closing bar stretched across the whole strip.
    justifyLastSystem: false,
    resources: {
      mainGlyphColor: ink,
      secondaryGlyphColor: ink,
      scoreInfoColor: ink,
      staffLineColor: new C(150, 150, 150),
      barSeparatorColor: ink,
      barNumberColor: new C(150, 150, 150),
    },
  },
  notation: {
    elements: new Map([
      [alphaTab.NotationElement.TrackNames, false],
      [alphaTab.NotationElement.ScoreTitle, false],
      [alphaTab.NotationElement.EffectTempo, false],
    ]),
  },
  player: { playerMode: alphaTab.PlayerMode.Disabled },
});

// The percussion clef cannot be switched off; hide its glyph as main.ts does.
// The credit line under the last system goes too: the strip is cropped to
// the staff and it would only stick out under it.
const CLEF_GLYPH = '';
const CREDIT = 'rendered by alphaTab';
new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!(node instanceof Element)) continue;
      for (const text of node.querySelectorAll('text')) {
        if (text.textContent === CLEF_GLYPH || text.textContent === CREDIT) (text as SVGElement).style.display = 'none';
      }
    }
  }
}).observe(scoreEl, { childList: true, subtree: true });

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

const box = (b: alphaTab.rendering.Bounds) => ({ x: b.x, y: b.y, w: b.w, h: b.h });

function publish() {
  const lookup = api.renderer.boundsLookup;
  const score = api.score;
  if (!lookup || !score) return;
  // The horizontal layout reports its one system once per partial render, so
  // systems, bars and beats are all keyed and taken once.
  const rowOf = new Map<string, number>();
  const rows: ReturnType<typeof box>[] = [];
  const bars: unknown[] = [];
  const beats: unknown[] = [];
  const seenBar = new Set<number>();
  for (const system of lookup.staffSystems) {
    const r = box(system.realBounds);
    const key = `${r.x},${r.y},${r.w},${r.h}`;
    if (!rowOf.has(key)) {
      rowOf.set(key, rows.length);
      rows.push(r);
    }
    const row = rowOf.get(key)!;
    for (const mb of system.bars) {
      if (seenBar.has(mb.index)) continue;
      seenBar.add(mb.index);
      const master = score.masterBars[mb.index]!;
      bars.push({
        index: mb.index,
        tick: master.start * TO_TAB,
        duration: master.calculateDuration() * TO_TAB,
        row,
        box: box(mb.lineAlignedBounds),
      });
      for (const bar of mb.bars) {
        for (const bb of bar.beats) {
          beats.push({
            tick: bb.beat.absolutePlaybackStart * TO_TAB,
            bar: mb.index,
            x: bb.onNotesX,
            visualX: bb.visualBounds.x,
            voice: bb.beat.voice.index,
            rest: bb.beat.isRest,
            row,
            rowBox: r,
          });
        }
      }
    }
  }
  // alphaTab sizes its surface from the unscaled widths when bars carry a
  // displayWidth, and clips the rest of the line (at scale 1.8, everything
  // past bar 36). The partials themselves are drawn in full; unclip them.
  const right = Math.max(...rows.map((r) => r.x + r.w + PAD_X));
  const surface = scoreEl.querySelector('.at-surface') as HTMLElement | null;
  if (surface && surface.getBoundingClientRect().width < right) {
    surface.style.width = `${right}px`;
    surface.style.overflow = 'visible';
  }
  (window as unknown as { coverTab: unknown }).coverTab = {
    layout,
    scale,
    barsPerRow,
    width: Math.ceil(Math.max(scoreEl.scrollWidth, right)),
    height: Math.ceil(Math.max(scoreEl.scrollHeight, ...rows.map((r) => r.y + r.h))),
    ticksPerBeat: TAB_TICKS_PER_BEAT,
    rows,
    bars,
    beats,
  };
  // Let the window scroll over the whole line, so it can be shot in slices.
  document.body.style.minWidth = `${(window as any).coverTab.width}px`;
  say('Rendered');
  statusEl.style.display = 'none';
}

api.postRenderFinished.on(() => publish());

async function main() {
  const midiPath = Object.keys(midiUrls).find((p) => slugOf(p) === slug);
  const song = songs.find((s) => s.slug === slug);
  if (!midiPath || !song) {
    say(`No song ${slug}`);
    return;
  }
  const gridPath = Object.keys(grids).find((p) => slugOf(p) === slug);
  const grid = gridPath ? await grids[gridPath]!() : undefined;
  const url = await midiUrls[midiPath]!();
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const tab = midiToAlphaTex(bytes, {
    title: song.title,
    bpm: 120,
    map: song.map,
    beatsPerBar: grid?.meter.beats_per_bar ?? 4,
    barCount: grid?.bar_count ?? 0,
  });
  const score = parseTex(tab.tex, tab.hiddenRests);
  if (score.masterBars.length > 1 && score.masterBars[1]!.start !== score.masterBars[0]!.calculateDuration()) {
    say('Unexpected bar starts');
    return;
  }
  if (layout === 'scroll') {
    // Every bar the same width, so barsPerRow of them fill `width` exactly.
    // displayWidth is in unscaled units.
    const barWidth = width / barsPerRow / scale;
    for (const mb of score.masterBars) mb.displayWidth = barWidth;
    for (const bar of score.tracks[0]!.staves[0]!.bars) bar.displayWidth = barWidth;
  }
  api.renderScore(score, [0]);
}

void main();
