// The grade, drawn where you read the music.
//
// Two halves, because one note cannot say two things (practice-plan Q11):
//
//  - **Every written note is coloured by its verdict**, using alphaTab's own
//    per-note styling (`Note.style.colors`) rather than an overlay. A re-render
//    costs about as much as a theme change and keeps the transport where it
//    was, so the colours simply appear.
//  - **Extras get a lane under the staff**, because a note you played that
//    nobody wrote has no notehead to colour. They are placed from alphaTab's
//    own bounds, the way the sticking letters are (sticking.ts).
//
// ## Which notehead is which drum
//
// Harder than it sounds, because this is the fourth numbering of the same
// drums: the module sends one set of note numbers, the drum rack another, the
// chart names instruments, and alphaTab identifies a notehead by an index into
// whichever articulations that particular score happens to use. See
// `articulationNumbers` at the bottom for how the correspondence is obtained
// without writing yet another table by hand.
import * as alphaTab from '@coderline/alphatab';
import { slotToMixMs, SLOTS_PER_BEAT, type ExpectedNote } from './chart';
import { ARTICULATION } from './midi-tab';
import type { ExtraVerdict, GradeResult, NoteVerdict } from './grade';
import type { Grid } from './syncpoints';

/** alphaTab counts 960 ticks to a quarter note, so a sixteenth is 240. */
const TICKS_PER_SLOT = 240;
/** A hit inside this many ms is on the beat rather than early or late. */
const TIGHT_MS = 25;
/**
 * How far under the bar the extras lane sits, in px.
 *
 * Clear of the sticking letters, which start 1px under the same edge and are
 * 11px tall -- an x landing on top of an R reads as neither.
 */
const GAP_PX = 15;

type Rgb = [number, number, number];

/**
 * One colour per verdict. `hit` splits three ways because a note that landed
 * 40 ms early is not the same finding as one that landed on time, and the two
 * directions are different findings again.
 */
interface Palette {
  tight: Rgb;
  early: Rgb;
  late: Rgb;
  missed: Rgb;
  wrongVoice: Rgb;
  extra: Rgb;
}

const LIGHT: Palette = {
  tight: [32, 140, 78],
  early: [40, 110, 190],
  late: [200, 120, 20],
  missed: [200, 45, 40],
  wrongVoice: [140, 70, 180],
  extra: [200, 45, 40],
};
const DARK: Palette = {
  tight: [80, 200, 130],
  early: [110, 170, 240],
  late: [240, 175, 80],
  missed: [245, 110, 100],
  wrongVoice: [195, 140, 235],
  extra: [245, 110, 100],
};

export const heatmapPalette = (dark: boolean): Palette => (dark ? DARK : LIGHT);

/** What a verdict is drawn as, and what the legend calls it. */
export function verdictColour(verdict: NoteVerdict, palette: Palette): Rgb {
  switch (verdict.verdict) {
    case 'missed':
      return palette.missed;
    case 'wrong-voice':
      return palette.wrongVoice;
    default: {
      const d = verdict.deltaMs ?? 0;
      if (Math.abs(d) <= TIGHT_MS) return palette.tight;
      return d < 0 ? palette.early : palette.late;
    }
  }
}

export class Heatmap {
  private readonly lane = document.createElement('div');
  /** The notes currently carrying a style, so they can be given back. */
  private styled: alphaTab.model.Note[] = [];
  private extras: ExtraVerdict[] = [];
  /** Mix time -> x, from the last render, for placing the extras lane. */
  private ruler: { tMs: number; x: number; top: number }[] = [];
  private grid: Grid | undefined;
  private dark = false;

  constructor(
    private readonly api: alphaTab.AlphaTabApi,
    scoreEl: HTMLElement
  ) {
    this.lane.className = 'extras';
    scoreEl.appendChild(this.lane);
    // The colours are baked into the render; the lane is placed from the
    // bounds that render produced, so it is rebuilt every time.
    api.postRenderFinished.on(() => this.drawLane());
  }

  /** Whether anything is currently marked. */
  get marked(): boolean {
    return this.styled.length > 0 || this.extras.length > 0;
  }

  setTheme(dark: boolean) {
    this.dark = dark;
  }

  /** Colour a graded take onto the score. Re-renders once. */
  show(result: GradeResult, grid: Grid) {
    this.grid = grid;
    this.clearStyles();
    const palette = heatmapPalette(this.dark);
    const byAddress = this.resolve();
    let first = Infinity;
    for (const verdict of result.notes) {
      const note = byAddress.get(address(verdict.note));
      if (!note) continue;
      const [r, g, b] = verdictColour(verdict, palette);
      const style = new alphaTab.model.NoteStyle();
      style.colors.set(
        alphaTab.model.NoteSubElement.StandardNotationNoteHead,
        new alphaTab.model.Color(r, g, b)
      );
      note.style = style;
      this.styled.push(note);
      first = Math.min(first, verdict.note.bar - 1);
    }
    this.extras = result.extras;
    this.render(Number.isFinite(first) ? first : 0);
  }

  /** Put every notehead back to the ink colour and drop the lane. */
  clear() {
    if (!this.marked) return;
    const first = this.clearStyles();
    this.extras = [];
    this.render(first);
  }

  private clearStyles(): number {
    let first = Infinity;
    for (const note of this.styled) {
      note.style = undefined;
      const bar = note.beat?.voice?.bar?.index;
      if (bar !== undefined) first = Math.min(first, bar);
    }
    this.styled = [];
    return Number.isFinite(first) ? first : 0;
  }

  private render(firstChangedBar: number) {
    // `reuseViewport` keeps the drawn score on screen while the new one is
    // engraved, so a re-colour does not flash the page white.
    this.api.render({ reuseViewport: true, firstChangedMasterBar: Math.max(0, firstChangedBar) });
  }

  // --- articulation index -> instrument ---------------------------------------

  /**
   * Address every drawn note by `bar:slot:instrument` -- the same address the
   * sticking lock uses, so the two overlays agree about where a note is.
   */
  private resolve(): Map<string, alphaTab.model.Note> {
    const byAddress = new Map<string, alphaTab.model.Note>();
    const track = this.api.score?.tracks[0];
    const staff = track?.staves[0];
    if (!track || !staff) return byAddress;

    const names = articulationNumbers(this.api.settings);
    const perBar = (staff.bars[0]?.masterBar?.timeSignatureNumerator ?? 4) * SLOTS_PER_BEAT;
    for (const bar of staff.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          const slot = Math.round(beat.playbackStart / TICKS_PER_SLOT) % perBar;
          for (const note of beat.notes) {
            const out = track.percussionArticulations[note.percussionArticulation]?.outputMidiNumber;
            const instrument = out === undefined ? undefined : names.get(out);
            if (instrument) byAddress.set(`${bar.index + 1}:${slot}:${instrument}`, note);
          }
        }
      }
    }
    return byAddress;
  }

  // --- the extras lane ----------------------------------------------------------

  /**
   * A stroke that was not written has a time but no place on the staff, so its
   * place is worked out from the notes either side of it: every drawn beat
   * knows its x and (through the beat map) its millisecond, and an extra is
   * put proportionally between the two it fell between.
   */
  private drawLane() {
    this.lane.replaceChildren();
    this.lane.hidden = this.extras.length === 0;
    if (this.lane.hidden || !this.grid) return;

    this.ruler = [];
    const perBar = (this.api.score?.masterBars[0]?.timeSignatureNumerator ?? 4) * SLOTS_PER_BEAT;
    for (const system of this.api.boundsLookup?.staffSystems ?? []) {
      for (const masterBar of system.bars) {
        const top = masterBar.visualBounds.y + masterBar.visualBounds.h;
        for (const bar of masterBar.bars) {
          for (const beat of bar.beats) {
            const slot = Math.round(beat.beat.playbackStart / TICKS_PER_SLOT);
            const tMs = slotToMixMs(this.grid, masterBar.index * perBar + (slot % perBar));
            if (tMs === undefined) continue;
            this.ruler.push({ tMs, x: beat.onNotesX, top: top + GAP_PX });
          }
        }
      }
    }
    this.ruler.sort((a, b) => a.tMs - b.tMs);
    if (this.ruler.length === 0) return;

    for (const extra of this.extras) {
      const at = this.place(extra.tMs);
      if (!at) continue;
      const span = document.createElement('span');
      // A cross for a note that is not there, a smaller one for a bounce off
      // a note that is.
      span.textContent = extra.verdict === 'flam' ? '·×' : '×';
      span.title =
        `${extra.verdict === 'flam' ? 'Flam (bounce)' : 'Extra'}: ` +
        `${extra.instrument ?? `unmapped note ${extra.note}`}`;
      span.style.left = `${at.x}px`;
      span.style.top = `${at.y}px`;
      if (extra.verdict === 'flam') span.style.opacity = '0.65';
      this.lane.appendChild(span);
    }
  }

  private place(tMs: number): { x: number; y: number } | undefined {
    const r = this.ruler;
    let i = 0;
    while (i < r.length && r[i]!.tMs < tMs) i++;
    const after = r[Math.min(i, r.length - 1)]!;
    const before = r[Math.max(0, i - 1)]!;
    // Off the ends of the notated cell: pin to the nearest beat rather than
    // extrapolating an x that would land outside the staff.
    if (i === 0 || i >= r.length) {
      const edge = i === 0 ? after : before;
      return { x: edge.x, y: edge.top };
    }
    // Two beats on different rows have no meaningful x between them; put it on
    // the later one, which is the row the reader is heading into.
    if (before.top !== after.top) return { x: after.x, y: after.top };
    const span = after.tMs - before.tMs;
    const f = span > 0 ? (tMs - before.tMs) / span : 0;
    return { x: before.x + f * (after.x - before.x), y: before.top };
  }
}

const address = (note: ExpectedNote) => `${note.bar}:${note.inBar}:${note.instrument}`;

/** Worked out once, then reused: it depends on alphaTab, not on the song. */
let articulationCache: Map<number, string> | undefined;

/**
 * `outputMidiNumber` -> instrument name, asked of alphaTab rather than tabled.
 *
 * A percussion note carries an index into `track.percussionArticulations`, and
 * that array holds only the articulations a particular score happens to use --
 * so the index means nothing across scores. `outputMidiNumber` does mean
 * something, but it is General MIDI, which is a *third* numbering after the
 * drum rack's and the module's. Rather than write out a fourth table to be
 * kept in step with `ARTICULATION`, this parses one throwaway bar per
 * instrument and reads back the number alphaTab itself chose. Exact by
 * construction, and it cannot drift.
 */
function articulationNumbers(settings: alphaTab.Settings): Map<number, string> {
  if (articulationCache) return articulationCache;
  const names = Object.entries(ARTICULATION);
  const tex = [
    '\\track "probe"',
    '\\instrument percussion',
    '\\articulation defaults',
    '\\clef neutral',
    ...names.map(([, name]) => `"${name}".4 r.4 r.4 r.4 |`),
  ].join('\n');

  const map = new Map<number, string>();
  try {
    const importer = new alphaTab.importer.AlphaTexImporter();
    importer.initFromString(tex, settings);
    const score = importer.readScore();
    const track = score.tracks[0]!;
    const bars = track.staves[0]?.bars ?? [];
    names.forEach(([instrument], i) => {
      const note = bars[i]?.voices[0]?.beats[0]?.notes[0];
      if (!note) return;
      const out = track.percussionArticulations[note.percussionArticulation]?.outputMidiNumber;
      if (out !== undefined) map.set(out, instrument);
    });
  } catch {
    /* nothing to colour by: the heatmap degrades to the extras lane */
  }
  articulationCache = map;
  return map;
}
