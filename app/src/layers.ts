// The page's own layers on the paper: what Lamp draws on top of alphaTab's
// engraving (design/lamp/notation/loop-bracket-2-lines.png).
//
//   - the section names, in a lane above the line each one starts in, at the
//     bar it starts at -- never over a note;
//   - the loop, as a brass bracket over its bars, with a tick down at each
//     real end, so a loop over two lines reads as one stretch;
//   - the current bar, as a light wash around its staff.
//
// Like the sticking letters (sticking.ts), these are spans placed from
// alphaTab's bounds lookup inside the score element: they scroll with it, and
// are rebuilt after every render (a resize, a theme switch, a re-coloured
// take). The lane itself is alphaTab's: a line a section starts in is engraved
// taller by one blank rehearsal mark (main.ts `load`), so the room is there
// only on the lines that need it.
import type * as alphaTab from '@coderline/alphatab';
import type { Section } from 'virtual:songs';
import type { LoopRange } from './loop';
import { barAtTick } from './score-window';

/** Pixels between two staff lines at alphaTab's scale 1. */
const STAFF_SPACE = 9;
/** The wash reaches this many staff spaces above the top line and below the bottom one. */
const WASH_SPACES = 3;

export class PaperLayers {
  private readonly labels = document.createElement('div');
  private readonly bracket = document.createElement('div');
  private readonly wash = document.createElement('span');
  private sections: readonly Section[] = [];
  private loop: LoopRange | undefined;
  private washBar = -1;

  constructor(
    private readonly api: alphaTab.AlphaTabApi,
    scoreEl: HTMLElement,
    /** The lane's height at scale 1 (main.ts LANE_PT, plus alphaTab's band padding). */
    private readonly lanePt: number
  ) {
    this.labels.className = 'tab-labels';
    this.bracket.className = 'tab-bracket';
    this.wash.className = 'tab-wash';
    this.wash.hidden = true;
    const washLayer = document.createElement('div');
    washLayer.className = 'tab-washes';
    washLayer.appendChild(this.wash);
    scoreEl.append(washLayer, this.labels, this.bracket);
    api.postRenderFinished.on(() => {
      this.washBar = -1;
      this.draw();
    });
    api.playerPositionChanged.on((e) => this.placeWash(e.currentTick));
  }

  /** A new song: its sections. Drawn once its score is engraved. */
  load(sections: readonly Section[]) {
    this.sections = sections;
    this.labels.replaceChildren();
    this.bracket.replaceChildren();
    this.wash.hidden = true;
    this.washBar = -1;
  }

  /** The loop on the paper, or none. */
  setLoop(range: LoopRange | undefined) {
    this.loop = range;
    this.drawBracket();
  }

  private get scale(): number {
    return this.api.settings.display.scale;
  }

  /** How tall the label lane is at the scale engraved. */
  private get lane(): number {
    return this.lanePt * this.scale;
  }

  private get systems(): alphaTab.rendering.StaffSystemBounds[] {
    return this.api.boundsLookup?.staffSystems ?? [];
  }

  private startsIn(system: alphaTab.rendering.StaffSystemBounds): boolean {
    return system.bars.some((b) => this.sections.some((s) => s.start_bar === b.index + 1 && s.name));
  }

  /** The top of a line's ink: under its label lane when it has one. */
  private inkTop(system: alphaTab.rendering.StaffSystemBounds): number {
    return system.realBounds.y + (this.startsIn(system) ? this.lane : 0);
  }

  private draw() {
    this.drawLabels();
    this.drawBracket();
    this.placeWash(this.api.tickPosition);
  }

  private drawLabels() {
    this.labels.replaceChildren();
    const inset = 6 * this.scale;
    for (const system of this.systems) {
      let after = -Infinity;
      for (const bar of system.bars) {
        const section = this.sections.find((s) => s.start_bar === bar.index + 1 && s.name);
        if (!section) continue;
        const span = document.createElement('span');
        span.textContent = section.name;
        // Two sections starting a bar apart push the second along the lane
        // rather than writing one name over the other.
        const left = Math.max(bar.realBounds.x + inset, after);
        span.style.left = `${left}px`;
        span.style.top = `${system.realBounds.y}px`;
        this.labels.appendChild(span);
        after = left + span.offsetWidth + 3 * inset;
      }
    }
  }

  /**
   * The loop's bracket: a line at the top of the ink of every line it covers,
   * broken where a section name sits in the lane above, with a tick down at
   * the loop's first and last bar lines.
   */
  private drawBracket() {
    this.bracket.replaceChildren();
    const r = this.loop;
    if (!r) return;
    const s = this.scale;
    const thick = 2 * s;
    const tick = 7 * s;
    const labelSpans = [...this.labels.children] as HTMLElement[];
    for (const system of this.systems) {
      const inside = system.bars.filter((b) => b.index + 1 >= r.startBar && b.index + 1 <= r.endBar);
      const first = inside[0];
      const last = inside[inside.length - 1];
      if (!first || !last) continue;
      const left = first.realBounds.x;
      const right = last.realBounds.x + last.realBounds.w;
      const y = this.inkTop(system) - thick / 2;
      // The names on this line, as gaps in the bracket.
      const gaps = labelSpans
        .filter((l) => Math.abs(parseFloat(l.style.top) - system.realBounds.y) < 1)
        .map((l) => [parseFloat(l.style.left) - 4 * s, parseFloat(l.style.left) + l.offsetWidth + 4 * s] as const)
        .sort((a, b) => a[0] - b[0]);
      let from = left;
      const piece = (a: number, b: number) => {
        if (b - a < 2) return;
        const line = document.createElement('span');
        line.style.left = `${a}px`;
        line.style.top = `${y}px`;
        line.style.width = `${b - a}px`;
        line.style.height = `${thick}px`;
        this.bracket.appendChild(line);
      };
      for (const [a, b] of gaps) {
        if (b <= from || a >= right) continue;
        piece(from, Math.min(a, right));
        from = Math.max(from, b);
      }
      piece(from, right);
      const end = (x: number, cls: string) => {
        const t = document.createElement('span');
        t.className = cls;
        t.style.left = `${x}px`;
        t.style.top = `${y}px`;
        t.style.width = `${thick}px`;
        t.style.height = `${tick + thick}px`;
        this.bracket.appendChild(t);
      };
      if (first.index + 1 === r.startBar) end(left, 'start');
      if (last.index + 1 === r.endBar) end(right - thick, 'end');
    }
  }

  /** The current bar's wash: around its staff, from bar line to bar line. */
  private placeWash(tick: number) {
    const score = this.api.score;
    if (!score) return;
    const index = barAtTick(score, tick);
    if (index === this.washBar) return;
    this.washBar = index;
    for (const system of this.systems) {
      const bar = system.bars.find((b) => b.index === index);
      if (!bar) continue;
      const pad = WASH_SPACES * STAFF_SPACE * this.scale;
      const lines = bar.lineAlignedBounds;
      const top = Math.max(this.inkTop(system), lines.y - pad);
      const bottom = lines.y + lines.h + pad;
      const w = this.wash.style;
      w.left = `${bar.realBounds.x}px`;
      w.width = `${bar.realBounds.w}px`;
      w.top = `${top}px`;
      w.height = `${bottom - top}px`;
      this.wash.hidden = false;
      return;
    }
    this.wash.hidden = true;
  }
}
