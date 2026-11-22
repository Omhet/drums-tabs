// The notation window: N lines of the score, the line being played on top.
//
// alphaTab lays the score out as rows ("staff systems") of so many bars,
// stacked in one tall element. The window is a clipped box over the video
// that shows `lines` of those rows and is scrolled, one whole row at a time,
// so that the row the cursor is in is the top one: the line you are playing
// and the ones after it, never a line you have finished. alphaTab's own
// follow-cursor scrolling is off (it would fight this), and its bounds
// lookup provides the row geometry: where every row's ink starts and ends
// and which bars it holds, in the coordinates of the score element.
//
// The box is cut to the ink of the rows it shows -- from the top one's label
// lane or stem tips to the bottom one's lowest stem, and the sticking letters
// under it when they are drawn -- and stands in the middle of the paper, so
// the space over the notes and under them is the same (asked 2026-11-22: the
// first line sat against the top edge with all the room below the last).
import type * as alphaTab from '@coderline/alphatab';

interface Row {
  /** Top of the row's ink in the score element, in px: its label lane or its highest stem. */
  top: number;
  /** Bottom of the row's ink, in px: its lowest stem. */
  bottom: number;
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

/** A wheel has to travel this far (in deltaY units) to move one row. */
const WHEEL_STEP = 40;

export class ScoreWindow {
  private rows: Row[] = [];
  private rowOfBar: number[] = [];
  /**
   * The widest step from one row's top to the next, in px: the room a row the
   * score has run out of is given, so that the last lines stay where they were.
   */
  private pitch = 0;
  private topRow = 0;
  private wheelAcc = 0;
  private _lines = 2;
  private shown = 2;
  /** Told whenever the top row changes: browsing is the window away from the cursor's row. */
  onMove: (() => void) | undefined;

  constructor(
    private readonly api: alphaTab.AlphaTabApi,
    /** The clipped box that wraps alphaTab's element. */
    readonly box: HTMLElement,
    /** What is drawn under every row's ink, in px: the sticking letters' lane, or 0. */
    private readonly below: () => number
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
    // The paper's height changes without a re-render: the stage is a vertical
    // split and alphaTab only re-engraves when its *width* moves. The rows
    // that fit, and the middle they stand in, move with it. No loop: show()
    // sizes the box, not the paper.
    const paper = box.parentElement;
    if (paper) new ResizeObserver(() => this.show(this.topRow)).observe(paper);
  }

  /**
   * How many rows the window shows: 2 under the video, 3 without it (main.ts).
   * The paper's width is fixed for the song, so this changes the height only.
   */
  get lines(): number {
    return this._lines;
  }
  set lines(n: number) {
    this._lines = Math.max(1, Math.min(8, Math.round(n)));
    this.show(this.topRow);
  }

  /** The row shown at the top, 0-based. */
  get row(): number {
    return this.topRow;
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
    const was = this.topRow;
    this.topRow = Math.max(0, Math.min(last, row));
    if (this.topRow !== was) queueMicrotask(() => this.onMove?.());
    const r = this.rows[this.topRow];
    if (!r) return;
    // Exactly the rows shown, and not a sliver of the one before or after:
    // the box is their ink. Only whole rows: when the next `lines` rows are
    // taller than the paper has room for (three that each start a section,
    // at a big size), the window shows one fewer rather than the top of the
    // last one. The line gap between the rows counts, the gap after the last
    // does not -- that is the paper's to give, above and below alike.
    const room = this.box.parentElement?.clientHeight ?? Infinity;
    let n = this._lines;
    let h = this.heightOf(n);
    while (n > 1 && h > room + 1) h = this.heightOf(--n);
    this.shown = n;
    h = Math.min(h, room);
    // Height first: scrollTop is clamped against it.
    this.box.style.height = `${Math.round(h)}px`;
    this.box.style.marginTop = `${Math.max(0, Math.floor((room - h) / 2))}px`;
    this.box.scrollTop = r.top;
  }

  /** The first and last bar on show, 0-based, or undefined before the first render. */
  get bars(): [number, number] | undefined {
    const top = this.rows[this.topRow];
    const bottom = this.rows[Math.min(this.rows.length - 1, this.topRow + this.shown - 1)];
    if (!top || !bottom) return undefined;
    return [top.bars[0]!, bottom.bars[bottom.bars.length - 1]!];
  }

  /** How many rows are on show: `lines`, or fewer where they would not fit. */
  get visible(): number {
    return this.shown;
  }

  /**
   * The ink of `n` rows from the top row, in px: from the first one's top to
   * the last one's bottom and what is drawn under it. Near the end of the
   * score there may be fewer than `n` left, and each missing one counts as a
   * row's pitch: the last lines stay where they stood instead of moving down
   * to the middle of the paper.
   */
  private heightOf(n: number): number {
    const first = this.rows[this.topRow]!;
    const lastIndex = Math.min(this.rows.length - 1, this.topRow + n - 1);
    const last = this.rows[lastIndex]!;
    const missing = this.topRow + n - 1 - lastIndex;
    return last.bottom + this.below() - first.top + missing * this.pitch;
  }

  private measure() {
    const systems = this.api.boundsLookup?.staffSystems ?? [];
    // A row's top is where its ink starts (alphaTab counts the line gap
    // above it as the row before's); its bottom is the lowest thing its bars
    // draw, which every bar of a row shares.
    this.rows = systems.map((s) => {
      const ink = s.bars[0]?.visualBounds;
      return {
        top: s.realBounds.y,
        bottom: ink ? ink.y + ink.h : s.realBounds.y + s.realBounds.h,
        bars: s.bars.map((b) => b.index),
      };
    });
    this.rowOfBar = [];
    this.rows.forEach((r, i) => {
      for (const b of r.bars) this.rowOfBar[b] = i;
    });
    // Rows are *not* equally spaced: a section name over the staff, or a note
    // reaching far above or below it, makes a row taller than its neighbours.
    let pitch = 0;
    for (let i = 1; i < this.rows.length; i++) {
      pitch = Math.max(pitch, this.rows[i]!.top - this.rows[i - 1]!.top);
    }
    this.pitch = pitch;
    // The line the cursor is in goes on top, as it does while playing. Not
    // the same row number as before: a re-engrave at another number of bars
    // a line puts different bars in it.
    const score = this.api.score;
    const row = score ? this.rowOfBar[barAtTick(score, this.api.tickPosition)] : undefined;
    this.show(row ?? this.topRow);
  }
}
