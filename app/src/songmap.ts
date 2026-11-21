// The song map (design/lamp/LampMap): the whole song as one strip of blocks,
// each section as long as it lasts, in the 80 px slot between the header and
// the paper.
//
//   - a section's name sits in its block when it fits, and on a tier above
//     when it does not, nudged apart so no two names overlap;
//   - verses, choruses and fills (`into ...`, `break`) in three shades, the
//     looped bars in brass with an outline, the playhead a bar of the text
//     colour;
//   - a click on a block jumps to its first bar.
//
// Picker mode (Loop, or L) grows it to 164 px over the top of the paper --
// laid over it, never pushing it down, since the paper's height and width
// must not move mid-song -- with a mark at every bar, a number every four,
// and a handle at each end of the loop. There a click loops a section,
// shift-click stretches the loop over both, a click inside the loop turns it
// off (the prototype's rules), a drag across the bar marks picks a range of
// bars, and a handle drags either end by a bar. The line under it says what
// is picked. What a pick does is main.ts's: this only says which bars.
import type { Section } from 'virtual:songs';
import type { LoopRange } from './loop';

export interface MapHost {
  /** A block clicked with no picking: go to its first bar (1-based). */
  jump(bar: number): void;
  /** A section clicked in the picker; `stretch` with Shift. */
  pickSection(index: number, stretch: boolean): void;
  /** A run of bars dragged out, or an end moved by a handle. */
  pickRange(range: LoopRange): void;
  /** The picker's Loop off. */
  off(): void;
  /** The picker's Done. */
  done(): void;
}

/** 80 tall: a 32 px tier for names that do not fit, the 44 px strip under it. */
const STRIP_TOP = 36;
const STRIP_H = 44;
const PICK_STRIP_H = 88;
/** Room a name needs inside its block: its width, the 12 px inset, and some air. */
const NAME_PAD = 27;
/** Least room between two names on the tier. */
const TIER_GAP = 18;
const FONT = '400 32px "Atkinson Hyperlegible Next"';

type Kind = 'verse' | 'chorus' | 'fill';
/** LampMap's three shades: the fills (`into ...`, `break`), anything with a chorus, the rest. */
export const kindOf = (name: string): Kind =>
  /^(into|break)/i.test(name) ? 'fill' : /chorus/i.test(name) ? 'chorus' : 'verse';

/** `bars 9–16`, or `bar 34`. */
const barsSaid = (r: LoopRange) =>
  r.startBar === r.endBar ? `bar ${r.startBar}` : `bars ${r.startBar}–${r.endBar}`;

/** What the picker's line says about a range: `chorus · bars 9–16 · 8 bars`. */
export function pickSaid(sections: readonly Section[], r: LoopRange): string {
  const n = r.endBar - r.startBar + 1;
  const exact = sections.find((s) => s.start_bar === r.startBar && s.end_bar === r.endBar && s.name);
  return [exact?.name, barsSaid(r), n === 1 ? '1 bar' : `${n} bars`].filter(Boolean).join(' · ');
}

type Drag =
  | { kind: 'range'; from: number; moved: boolean; shift: boolean }
  | { kind: 'start' | 'end'; moved: boolean };

export class SongMap {
  private readonly body = document.createElement('div');
  private readonly line = document.createElement('div');
  private readonly head = document.createElement('div');
  private sections: readonly Section[] = [];
  private bars = 0;
  private _loop: LoopRange | undefined;
  private _view: LoopRange | undefined;
  /** The loop as a drag has it so far, drawn in place of the real one. */
  private preview: LoopRange | undefined;
  private _picking = false;
  private at: number | undefined;
  private nowIndex = -1;
  private drag: Drag | undefined;
  private readonly measure = document.createElement('canvas').getContext('2d');
  private readonly el: HTMLElement;
  private readonly host: MapHost;

  constructor(el: HTMLElement, host: MapHost) {
    this.el = el;
    this.host = host;
    this.body.className = 'map-body';
    this.line.className = 'map-line';
    this.head.className = 'map-head';
    el.replaceChildren(this.body, this.line);
    new ResizeObserver(() => this.render()).observe(this.body);
    // The names are fitted to their blocks by measuring them, which is wrong
    // in the fallback face.
    void document.fonts.ready.then(() => this.render());

    this.body.addEventListener('pointerdown', (e) => this.down(e));
    this.body.addEventListener('pointermove', (e) => this.move(e));
    this.body.addEventListener('pointerup', (e) => this.up(e));
    this.body.addEventListener('pointercancel', () => {
      this.drag = undefined;
      this.preview = undefined;
      this.render();
    });
  }

  get picking(): boolean {
    return this._picking;
  }

  /** A new song: its sections and how many bars the notation has. */
  load(sections: readonly Section[], bars: number) {
    this.sections = sections;
    this.bars = bars;
    this.at = undefined;
    this.nowIndex = -1;
    this.render();
  }

  /** The loop while it is on, or undefined. */
  set loop(r: LoopRange | undefined) {
    this._loop = r;
    this.render();
  }

  /**
   * The bars the paper shows while it is browsed away from the cursor
   * (Lamp-06): a dashed box over them. Undefined when it shows the cursor.
   */
  set view(r: LoopRange | undefined) {
    if (r?.startBar === this._view?.startBar && r?.endBar === this._view?.endBar) return;
    this._view = r;
    this.render();
  }

  open() {
    if (this._picking) return;
    this._picking = true;
    this.render();
  }

  close() {
    if (!this._picking) return;
    this._picking = false;
    this.drag = undefined;
    this.preview = undefined;
    this.render();
  }

  /** Where the playhead is, in bars: 1 is the start of bar 1, 11.5 half way through bar 11. */
  setAt(bar: number) {
    this.at = bar;
    this.placeHead();
    const now = this.sections.findIndex((s) => bar >= s.start_bar && bar < s.end_bar + 1);
    if (now !== this.nowIndex) {
      this.nowIndex = now;
      for (const n of this.body.querySelectorAll<HTMLElement>('[data-index]')) {
        n.classList.toggle('now', Number(n.dataset.index) === now);
      }
    }
  }

  // --- drawing ----------------------------------------------------------------

  private get width(): number {
    return this.body.clientWidth;
  }

  private get per(): number {
    return this.bars > 0 ? this.width / this.bars : 0;
  }

  private textWidth(text: string): number {
    const c = this.measure;
    if (!c) return text.length * 19;
    c.font = FONT;
    return c.measureText(text).width;
  }

  private render() {
    const el = this.el;
    el.toggleAttribute('data-picking', this._picking);
    const body = this.body;
    body.replaceChildren();
    const per = this.per;
    if (per <= 0) return;
    const r = (v: number) => Math.round(v * 10) / 10;
    const loop = this.preview ?? this._loop;
    const stripH = this._picking ? PICK_STRIP_H : STRIP_H;

    const tier: { span: HTMLElement; l: number; tw: number }[] = [];
    this.sections.forEach((s, i) => {
      const left = (s.start_bar - 1) * per;
      const width = (s.end_bar - s.start_bar + 1) * per;
      const inLoop = !!loop && s.start_bar >= loop.startBar && s.end_bar <= loop.endBar;
      const tw = this.textWidth(s.name);
      const fits = tw + NAME_PAD <= width;
      const block = document.createElement('button');
      block.type = 'button';
      block.className = 'map-block';
      block.dataset.kind = kindOf(s.name);
      block.dataset.index = String(i);
      block.classList.toggle('in-loop', inLoop);
      block.classList.toggle('now', i === this.nowIndex);
      block.style.left = `${r(left)}px`;
      block.style.width = `${r(width)}px`;
      block.textContent = fits ? s.name : '';
      const bars = s.start_bar === s.end_bar ? `bar ${s.start_bar}` : `bars ${s.start_bar} to ${s.end_bar}`;
      block.setAttribute('aria-label', `${s.name}, ${bars}`);
      block.title = this._picking
        ? `Loop ${s.name} (Shift: stretch the loop over it)`
        : `Go to ${s.name}, bar ${s.start_bar}`;
      block.addEventListener('click', (e) => this.clicked(e, i));
      body.appendChild(block);
      if (!fits) {
        const span = document.createElement('span');
        span.className = 'map-tier';
        span.dataset.index = String(i);
        span.classList.toggle('in-loop', inLoop);
        span.classList.toggle('now', i === this.nowIndex);
        span.textContent = s.name;
        span.setAttribute('aria-hidden', 'true');
        tier.push({ span, l: left + width / 2 - tw / 2, tw });
      }
    });
    // LampMap's relaxation: neighbours that overlap move apart by half the
    // overlap each, until none do.
    for (let pass = 0; pass < 30; pass++) {
      let moved = false;
      for (let k = 1; k < tier.length; k++) {
        const a = tier[k - 1]!;
        const b = tier[k]!;
        const over = a.l + a.tw + TIER_GAP - b.l;
        if (over > 0.5) {
          a.l -= over / 2;
          b.l += over / 2;
          moved = true;
        }
      }
      if (!moved) break;
    }
    for (const t of tier) {
      t.span.style.left = `${r(Math.max(0, Math.min(this.width - t.tw, t.l)))}px`;
      body.appendChild(t.span);
    }

    if (this._picking) {
      for (let b = 1; b <= this.bars; b++) {
        const x = (b - 1) * per;
        const four = (b - 1) % 4 === 0;
        const tick = document.createElement('i');
        tick.className = 'map-tick';
        tick.style.left = `${r(x)}px`;
        tick.style.top = `${STRIP_TOP + stripH - 22}px`;
        tick.style.height = `${four ? 22 : 12}px`;
        body.appendChild(tick);
        if (four) {
          const num = document.createElement('span');
          num.className = 'map-num';
          num.textContent = String(b);
          num.style.left = `${r(x + 4)}px`;
          num.style.top = `${STRIP_TOP + stripH + 10}px`;
          body.appendChild(num);
        }
      }
    }

    if (loop) {
      const outline = document.createElement('div');
      outline.className = 'map-loop';
      outline.style.left = `${r((loop.startBar - 1) * per)}px`;
      outline.style.width = `${r((loop.endBar - loop.startBar + 1) * per)}px`;
      outline.style.height = `${stripH + 10}px`;
      body.appendChild(outline);
      if (this._picking) {
        for (const end of ['start', 'end'] as const) body.appendChild(this.handle(end, loop, per, stripH));
      }
    }
    const view = this._view;
    if (view && !this._picking) {
      const box = document.createElement('div');
      box.className = 'map-view';
      box.style.left = `${r((view.startBar - 1) * per)}px`;
      box.style.width = `${r((view.endBar - view.startBar + 1) * per)}px`;
      box.style.height = `${stripH + 10}px`;
      body.appendChild(box);
    }
    this.head.style.height = `${stripH + 20}px`;
    body.appendChild(this.head);
    this.placeHead();
    this.paintLine();
  }

  private handle(end: 'start' | 'end', loop: LoopRange, per: number, stripH: number): HTMLElement {
    const h = document.createElement('button');
    h.type = 'button';
    h.className = 'map-handle';
    h.dataset.end = end;
    const x = end === 'start' ? (loop.startBar - 1) * per : loop.endBar * per;
    h.style.left = `${Math.round(x * 10) / 10}px`;
    h.style.height = `${stripH + 24}px`;
    const bar = end === 'start' ? loop.startBar : loop.endBar;
    h.setAttribute('aria-label', `${end === 'start' ? 'First' : 'Last'} bar of the loop, bar ${bar}`);
    h.title = 'Drag, or the arrow keys: a bar at a time';
    h.addEventListener('keydown', (e) => {
      const step = e.code === 'ArrowLeft' ? -1 : e.code === 'ArrowRight' ? 1 : 0;
      if (!step || !this._loop) return;
      // The arrows are the page's seek keys everywhere else.
      e.preventDefault();
      e.stopPropagation();
      const moved = this.moveEnd(this._loop, end, bar + step);
      if (moved) this.host.pickRange(moved);
      // Back on the handle the repaint just rebuilt, to keep going.
      this.body.querySelector<HTMLElement>(`.map-handle[data-end="${end}"]`)?.focus();
    });
    return h;
  }

  /** A loop with one end moved to `bar`, never past the other end. */
  private moveEnd(loop: LoopRange, end: 'start' | 'end', bar: number): LoopRange | undefined {
    const b = Math.max(1, Math.min(this.bars, bar));
    const next =
      end === 'start'
        ? { startBar: Math.min(b, loop.endBar), endBar: loop.endBar }
        : { startBar: loop.startBar, endBar: Math.max(b, loop.startBar) };
    return next.startBar === loop.startBar && next.endBar === loop.endBar ? undefined : next;
  }

  private placeHead() {
    const at = this.at;
    this.head.hidden = at === undefined || this.bars === 0;
    if (at !== undefined) this.head.style.left = `${Math.round((at - 1) * this.per * 10) / 10}px`;
  }

  /** The line under the picker: what is picked, and how to pick. */
  private paintLine() {
    const line = this.line;
    line.replaceChildren();
    if (!this._picking) return;
    const loop = this.preview ?? this._loop;
    const says = document.createElement('span');
    const hint = document.createElement('span');
    hint.className = 'map-hint';
    if (loop) {
      says.className = 'map-says';
      says.textContent = `Loop: ${pickSaid(this.sections, loop)}`;
      hint.textContent = 'drag a handle to move either end by a bar';
    } else {
      hint.textContent =
        'Click a section to loop it · shift-click another to stretch the loop over both · drag across bar marks for a range of bars';
    }
    if (loop) line.appendChild(says);
    line.appendChild(hint);
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    line.appendChild(spacer);
    if (this._loop) line.appendChild(this.lineButton('Loop off', 'Turn the loop off (L)', () => this.host.off()));
    line.appendChild(this.lineButton('Done', 'Close the picker (Esc)', () => this.host.done()));
  }

  private lineButton(text: string, title: string, act: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', (e) => {
      act();
      if (e.detail > 0) b.blur();
    });
    return b;
  }

  // --- picking --------------------------------------------------------------------

  /**
   * A block's click. Off the picker it is a jump. In it, a mouse pick is
   * the pointer handlers' (a press can turn into a drag), so only the
   * keyboard's click -- Enter on a focused block, `detail` 0 -- is taken here.
   */
  private clicked(e: MouseEvent, i: number) {
    const section = this.sections[i];
    if (!section) return;
    if (!this._picking) {
      this.host.jump(section.start_bar);
      // Give Space back to Play.
      if (e.detail > 0) (e.currentTarget as HTMLElement).blur();
      return;
    }
    if (e.detail === 0) this.host.pickSection(i, e.shiftKey);
  }

  private barAt(e: PointerEvent): number {
    const x = e.clientX - this.body.getBoundingClientRect().left;
    return Math.max(1, Math.min(this.bars, Math.floor(x / this.per) + 1));
  }

  private down(e: PointerEvent) {
    if (!this._picking || e.button !== 0 || this.bars === 0) return;
    const handle = (e.target as HTMLElement).closest<HTMLElement>('.map-handle');
    if (handle && this._loop) {
      this.drag = { kind: handle.dataset.end === 'start' ? 'start' : 'end', moved: false };
    } else {
      this.drag = { kind: 'range', from: this.barAt(e), moved: false, shift: e.shiftKey };
    }
    this.body.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  private move(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    const bar = this.barAt(e);
    if (d.kind === 'range') {
      if (bar === d.from && !d.moved) return;
      d.moved = true;
      this.preview = { startBar: Math.min(d.from, bar), endBar: Math.max(d.from, bar) };
    } else {
      const base = this._loop;
      if (!base) return;
      const next = this.moveEnd(base, d.kind, bar);
      d.moved = !!next;
      this.preview = next;
    }
    this.render();
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    this.drag = undefined;
    const picked = this.preview;
    this.preview = undefined;
    if (d.kind === 'range' && !d.moved) {
      // A click: the section under it, or the one bar if no section holds it.
      const bar = this.barAt(e);
      const i = this.sections.findIndex((s) => bar >= s.start_bar && bar <= s.end_bar);
      if (i >= 0) this.host.pickSection(i, d.shift);
      else this.host.pickRange({ startBar: bar, endBar: bar });
      return;
    }
    if (picked && d.moved) this.host.pickRange(picked);
    else this.render();
  }
}
