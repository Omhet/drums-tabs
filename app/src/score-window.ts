// The notation window: N lines of the score, the line being played on top.
//
// alphaTab lays the score out as rows ("staff systems") of `barsPerRow` bars,
// stacked in one tall element. The window is a clipped box over the video
// that shows `lines` of those rows and is scrolled, one whole row at a time,
// so that the row the cursor is in is the top one: the line you are playing
// and the ones after it, never a line you have finished. alphaTab's own
// follow-cursor scrolling is off (it would fight this), and its bounds
// lookup provides the row geometry: where every row starts and which bars
// it holds, in the coordinates of the score element.
import type * as alphaTab from '@coderline/alphatab';

interface Row {
  /** Top of the row's staff in the score element, in px. */
  top: number;
  /** Indices of the bars on this row. */
  bars: number[];
}

/** The 0-based bar that holds tick `tick` (a master bar knows its first tick). */
export function barAtTick(score: alphaTab.model.Score, tick: number): number {
  const bars = score.masterBars;
  let i = 0;
  while (i + 1 < bars.length && bars[i + 1]!.start <= tick) i++;
  return i;
}

/**
 * How tall the window is: a number of rows, or 'fit' to fill the box it was
 * given. A song with a video keeps the notation to a few lines over the
 * picture; with no video there is nothing to make room for, so it fills the
 * stage and 'fit' is the default.
 */
export type Lines = number | 'fit';

/** Whitespace kept above the top row's staff, in px. */
const GAP_PX = 6;
/** A wheel has to travel this far (in deltaY units) to move one row. */
const WHEEL_STEP = 40;

export class ScoreWindow {
  private rows: Row[] = [];
  private rowOfBar: number[] = [];
  /** Distance from one row's top to the next, in px. */
  private pitch = 0;
  private topRow = 0;
  private wheelAcc = 0;
  private _lines: Lines = 2;

  constructor(
    private readonly api: alphaTab.AlphaTabApi,
    /** The clipped box that wraps alphaTab's element. */
    readonly box: HTMLElement
  ) {
    // postRenderFinished, not renderFinished: the rows are in the DOM by then
    // and the box can be sized and scrolled. It also fires after the
    // re-render that a resize or a theme change triggers.
    api.postRenderFinished.on(() => this.measure());
    // playerPositionChanged, not playedBeatChanged: the latter only fires
    // while playing, and the window has to follow a seek while paused too
    // (arrow keys, a click on the score, Stop).
    api.playerPositionChanged.on((e) => {
      if (api.score) this.follow(barAtTick(api.score, e.currentTick));
    });
    // Browsing while paused: a wheel notch is one row. The box itself is
    // overflow: hidden so nothing else moves it.
    box.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.wheelAcc += e.deltaY;
        if (Math.abs(this.wheelAcc) < WHEEL_STEP) return;
        this.show(this.topRow + Math.sign(this.wheelAcc));
        this.wheelAcc = 0;
      },
      { passive: false }
    );
  }

  /** How many rows the window shows, or 'fit' for as many as there is room for. */
  get lines(): Lines {
    return this._lines;
  }
  set lines(n: Lines) {
    this._lines = n === 'fit' ? n : Math.max(1, Math.min(8, Math.round(n)));
    this.resize();
    this.show(this.topRow);
  }

  /** The row shown at the top, 0-based. */
  get row(): number {
    return this.topRow;
  }

  get rowCount(): number {
    return this.rows.length;
  }

  /** The row that holds bar `barIndex`, or undefined before the first render. */
  rowOf(barIndex: number): number | undefined {
    return this.rowOfBar[barIndex];
  }

  /** The first bar of row `row`, clamped to the score. */
  firstBarOfRow(row: number): number | undefined {
    const r = this.rows[Math.max(0, Math.min(this.rows.length - 1, row))];
    return r?.bars[0];
  }

  /** Put the row holding `barIndex` at the top, if it is not already. */
  follow(barIndex: number) {
    const row = this.rowOfBar[barIndex];
    if (row !== undefined && row !== this.topRow) this.show(row);
  }

  /** Scroll so that `row` is the top line. */
  show(row: number) {
    const last = Math.max(0, this.rows.length - 1);
    this.topRow = Math.max(0, Math.min(last, row));
    const r = this.rows[this.topRow];
    if (r) this.box.scrollTop = Math.max(0, r.top - GAP_PX);
  }

  private measure() {
    const systems = this.api.boundsLookup?.staffSystems ?? [];
    this.rows = systems.map((s) => ({
      top: s.realBounds.y,
      bars: s.bars.map((b) => b.index),
    }));
    this.rowOfBar = [];
    this.rows.forEach((r, i) => {
      for (const b of r.bars) this.rowOfBar[b] = i;
    });
    // Rows are equally spaced; a one-row score is as tall as that row.
    const first = this.rows[0];
    const second = this.rows[1];
    this.pitch = second && first ? second.top - first.top : (systems[0]?.realBounds.h ?? 0);
    this.resize();
    this.show(this.topRow);
  }

  private resize() {
    // 'fit' is the stylesheet's job -- the box is stretched over the whole
    // stage and there is no row count to compute a height from.
    const lines = this._lines;
    this.box.classList.toggle('fit', lines === 'fit');
    if (lines === 'fit') this.box.style.height = '';
    else if (this.pitch > 0) {
      this.box.style.height = `${Math.round(this.pitch * lines + GAP_PX)}px`;
    }
  }
}
