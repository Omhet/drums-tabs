// R and L under the notation, from songs/<slug>/sticking.lock.json.
//
// Which hand plays what is worked out by `drums sticking` (pipeline/sticking.py)
// and frozen in a lock file pinned to the chart it was solved from. This draws
// it: one letter under each beat the hands play, the way a drum book prints it.
//
// The letters are an overlay rather than part of the score. alphaTab engraves
// the notation and then reports where everything landed, so a beat's x comes
// from its bounds and the letter is a <span> placed there inside the same
// element -- which means it scrolls with the score, survives a re-render (the
// overlay is rebuilt from the new bounds), and needs no change to the alphaTex
// the notation is generated from.
import type * as alphaTab from '@coderline/alphatab';

/** alphaTab counts 960 ticks to a quarter note, so a sixteenth is 240. */
const TICKS_PER_SLOT = 240;
/** The hands are voice 0 (stems up); voice 1 is the feet, which need no letter. */
const HANDS_VOICE = 0;
/** How far under the bar's notation the letters sit, in px. */
const GAP_PX = 1;

/** One entry per note in the chart. Bars are 1-based; slots are sixteenths. */
export interface StickingStroke {
  bar: number;
  slot: number;
  instrument: string;
  limb: 'left_hand' | 'right_hand' | 'left_foot' | 'right_foot';
  velocity: number;
}

/** songs/<slug>/sticking.lock.json. */
export interface StickingLock {
  version: number;
  /** The chart it was solved from: sha256 of tab.mid, first 16 hex digits. */
  chart: string;
  kit: string;
  tempo_bpm: number;
  beats_per_bar: number;
  cost: number;
  notes: string[];
  strokes: StickingStroke[];
  hat: { bar: number; slot: number; open: boolean }[];
}

const LETTER: Record<string, string> = { right_hand: 'R', left_hand: 'L' };

export class StickingLetters {
  private readonly overlay = document.createElement('div');
  /** `${bar}:${slot}` -> the letters played there, in stroke order. */
  private byBeat = new Map<string, string>();
  private _visible = true;

  constructor(
    private readonly api: alphaTab.AlphaTabApi,
    scoreEl: HTMLElement
  ) {
    this.overlay.className = 'sticking';
    scoreEl.appendChild(this.overlay);
    // postRenderFinished, not renderFinished: the rows are in the DOM by then
    // and their bounds are final. It fires again after the re-render a resize
    // or a theme change triggers, which is when the letters have to move.
    api.postRenderFinished.on(() => this.draw());
  }

  /** How many beats have a letter: 0 when the song has no sticking. */
  get count(): number {
    return this.byBeat.size;
  }

  /** Whether to draw them at all. */
  get visible(): boolean {
    return this._visible;
  }
  set visible(on: boolean) {
    this._visible = on;
    this.draw();
  }

  /** Point it at a song's sticking, or at none. */
  load(lock: StickingLock | undefined) {
    this.byBeat.clear();
    for (const stroke of lock?.strokes ?? []) {
      const letter = LETTER[stroke.limb];
      if (!letter) continue; // a foot: no letter, the notation says which
      const key = `${stroke.bar}:${stroke.slot}`;
      this.byBeat.set(key, (this.byBeat.get(key) ?? '') + letter);
    }
    this.draw();
  }

  private draw() {
    this.overlay.replaceChildren();
    this.overlay.hidden = !this._visible || this.byBeat.size === 0;
    if (this.overlay.hidden) return;
    // Zoomed, the bounds arrive already scaled but our own gap does not: a
    // letter 1px under a staff twice the size is 1px under the wrong thing.
    // (The letter itself grows in CSS, from --tab-zoom.)
    const gap = GAP_PX * this.api.settings.display.scale;
    for (const system of this.api.boundsLookup?.staffSystems ?? []) {
      for (const masterBar of system.bars) {
        // Under everything the bar draws, including the feet's stems.
        const under = masterBar.visualBounds.y + masterBar.visualBounds.h + gap;
        for (const bar of masterBar.bars) {
          for (const beat of bar.beats) {
            if (beat.beat.voice.index !== HANDS_VOICE) continue;
            const slot = Math.round(beat.beat.playbackStart / TICKS_PER_SLOT);
            const letters = this.byBeat.get(`${masterBar.index + 1}:${slot}`);
            if (!letters) continue;
            const span = document.createElement('span');
            span.textContent = letters;
            span.style.left = `${beat.onNotesX}px`;
            span.style.top = `${under}px`;
            this.overlay.appendChild(span);
          }
        }
      }
    }
  }
}

/**
 * Whether a lock file was solved from the chart that is loaded.
 *
 * Every Ctrl+S in Ableton rewrites tab.mid, so sticking can quietly come to
 * describe a chart that no longer exists -- letters under notes that have
 * moved. The lock file records what it was solved from; this is the other half
 * of that check.
 */
export async function chartHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex.slice(0, 16)}`;
}
