// Practice mode: play a cell, get marked.
//
// This is the thin vertical slice practice-plan Q19 calls M1 -- MIDI in, a
// calibration ritual, a take on disk, a grade, and the grade drawn on the
// staff -- built end to end for **one cell** so that the take format is proven
// against a real kit before twenty-four cells depend on it.
//
// The routine grid is deliberately not here. `CELL` below is one constant, and
// M2 is where it becomes a grid with sealing, resuming and epochs. The
// temptation is to build the grid first because it is easy; the grid is
// worthless if the take format is wrong.
import type * as alphaTab from '@coderline/alphatab';
import type { SongMeta } from 'virtual:songs';
import kitInput from 'virtual:kit';
import { expectedNotes, readChart, type ChartHit, type ExpectedNote, type Limb } from './chart';
import {
  calibrate,
  loadCalibration,
  saveCalibration,
  type Calibration,
  type CalibrationRun,
} from './calibrate';
import { Click } from './click';
import { grade, type GradeResult, type TakeEvent, type Timing } from './grade';
import { heatmapPalette, Heatmap } from './heatmap';
import type { MixClock } from './media';
import { MidiIn, type MidiHit } from './midi-in';
import type { Mixer } from './mixer';
import { chartHash, type StickingLock } from './sticking';
import { writeTake, type Take } from './take';
import { barStartMs, type Grid } from './syncpoints';

/**
 * The one cell M1 records: the song's first section, at the record's tempo.
 *
 * M2 replaces this with the fixed (section x 70/80/90/100%) grid. Until then a
 * different section is a one-word edit here, or `drums.practice.cell = 2` in
 * the console.
 */
const CELL = { sectionIndex: 0, tempo: 1 };

/** Bars of click before the cell starts. Not recorded, not graded. */
const COUNT_IN_BARS = 1;
/** Hits this far outside the cell still belong to it: a late last note counts. */
const EDGE_MS = 250;
/** A take whose mean is further than this from the stored calibration nags. */
const DRIFT_MS = 10;
/** How many hits the monitor keeps on screen. */
const MONITOR = 14;

const LIMB_NAMES: Record<Limb, string> = {
  right_hand: 'Right hand',
  left_hand: 'Left hand',
  right_foot: 'Right foot (kick)',
  left_foot: 'Left foot (hats)',
  hands: 'Hands',
};

export interface PracticeSong {
  song: SongMeta;
  grid: Grid | undefined;
  hits: ChartHit[];
  chartHash: string;
  sticking: StickingLock | undefined;
}

export interface PracticeElements {
  enable: HTMLButtonElement;
  port: HTMLSelectElement;
  calibrate: HTMLButtonElement;
  calibration: HTMLOutputElement;
  record: HTMLButtonElement;
  cell: HTMLOutputElement;
  monitorOn: HTMLInputElement;
  monitor: HTMLElement;
  report: HTMLElement;
  /**
   * The click fader, which the ritual needs audible. Driven by dispatching the
   * `input` event the page already listens for, so the slider, the mixer and
   * the remembered levels all stay in step with one setter rather than three.
   */
  clickFader: HTMLInputElement;
}

export class Practice {
  readonly midi: MidiIn;
  private readonly heatmap: Heatmap;
  private loaded: PracticeSong | undefined;
  private calibration: Calibration | undefined;
  private running: CalibrationRun | undefined;
  /** Armed or recording: the hits landing in the cell. */
  private capture: TakeEvent[] | undefined;
  private recording: { startMs: number; endMs: number; started: string } | undefined;
  private timer = 0;
  private countInTimer = 0;
  private recent: MidiHit[] = [];
  private dark = false;
  /** The last graded take, for the headless check and the console. */
  result: GradeResult | undefined;
  cell = CELL.sectionIndex;

  constructor(
    private readonly api: alphaTab.AlphaTabApi,
    private readonly clock: MixClock,
    private readonly mixer: Mixer,
    private readonly el: PracticeElements,
    scoreEl: HTMLElement,
    private readonly onStatus: (text: string, isError?: boolean) => void
  ) {
    this.midi = new MidiIn(clock, { notes: kitInput.note, preferPort: kitInput.port });
    this.heatmap = new Heatmap(api, scoreEl);
    this.midi.onHit((hit) => this.onHit(hit));
    this.midi.onState(() => this.showPorts());

    el.enable.addEventListener('click', () => void this.enable());
    el.port.addEventListener('change', () => this.midi.open(el.port.value));
    el.calibrate.addEventListener('click', () => void this.runCalibration());
    el.record.addEventListener('click', () => this.toggleRecord());
    el.monitorOn.addEventListener('change', () => {
      el.monitor.hidden = !el.monitorOn.checked;
      this.drawMonitor();
    });

    void this.reloadCalibration();
  }

  setTheme(dark: boolean) {
    this.dark = dark;
    this.heatmap.setTheme(dark);
    if (this.result) this.drawReport(this.result);
  }

  /** Point practice mode at the song the player just loaded. */
  load(loaded: PracticeSong) {
    this.stopRecording(false);
    this.heatmap.clear();
    this.result = undefined;
    this.el.report.hidden = true;
    this.loaded = loaded;
    this.showCell();
  }

  // --- MIDI ---------------------------------------------------------------------

  private async enable() {
    const state = await this.midi.start();
    if (state.kind === 'unsupported') {
      this.onStatus('This browser has no Web MIDI. Chrome or Edge can read the kit.', true);
    } else if (state.kind === 'denied') {
      this.onStatus(`MIDI was refused: ${state.message}`, true);
    }
    this.showPorts();
  }

  private showPorts() {
    const state = this.midi.state;
    const ports = state.kind === 'ready' ? state.ports : [];
    this.el.port.replaceChildren();
    for (const port of ports) this.el.port.add(new Option(port.name, port.id, false, port.open));
    if (ports.length === 0) this.el.port.add(new Option('No MIDI inputs', ''));
    this.el.port.disabled = ports.length === 0;
    this.el.enable.disabled = state.kind === 'ready';
    this.el.enable.textContent = state.kind === 'ready' ? 'MIDI on' : 'Enable MIDI';
    this.showCell();
  }

  private onHit(hit: MidiHit) {
    this.recent.push(hit);
    if (this.recent.length > MONITOR) this.recent.shift();
    this.drawMonitor();
    // A stroke arriving is itself news: it means there is something to record
    // from, which `showPorts` cannot know before the first one lands.
    if (this.el.record.disabled) this.showCell();
    const take = this.capture;
    const window = this.recording;
    if (!take || !window) return;
    if (hit.tMs < window.startMs - EDGE_MS || hit.tMs > window.endMs + EDGE_MS) return;
    // Raw, uncorrected, and the module's own note number: the take stores the
    // measurement, and the grade is a reading of it (practice-plan Q8).
    take.push({ tMs: hit.tMs, note: hit.note, velocity: hit.velocity, instrument: hit.instrument });
  }

  private drawMonitor() {
    if (this.el.monitor.hidden) return;
    this.el.monitor.replaceChildren();
    // Newest first: the row is wider than the strip, and the hit worth seeing
    // is the one just played.
    for (const hit of [...this.recent].reverse()) {
      const span = document.createElement('span');
      const name = hit.instrument ?? 'unmapped';
      if (!hit.instrument) span.className = 'unmapped';
      const b = document.createElement('b');
      b.textContent = String(hit.note);
      span.append(b, ` ${name} · ${hit.velocity}`);
      span.title = hit.instrument
        ? `note ${hit.note} -> ${hit.instrument}`
        : `note ${hit.note} has no entry in kit.toml [input.note]`;
      this.el.monitor.appendChild(span);
    }
  }

  // --- calibration ----------------------------------------------------------------

  /** Re-read calibration.local.json: it can be edited, or re-measured. */
  async reloadCalibration() {
    this.calibration = await loadCalibration();
    this.showCalibration();
  }

  private showCalibration(note?: string) {
    const c = this.calibration;
    this.el.calibration.textContent =
      note ?? (c ? `${signed(c.offsetMs)} ms ±${c.spreadMs}` : 'uncalibrated');
    this.el.calibration.title = c
      ? `You play ${signed(c.offsetMs)} ms against the click (median of ${c.n} on note ${c.note}), ` +
        `measured ${c.measuredAt}. Subtracted from every take.`
      : 'No calibration: takes will be graded with no latency correction.';
  }

  private async runCalibration() {
    if (this.running) {
      this.running.cancel();
      return;
    }
    this.mixer.ensureGraph();
    const ctx = this.mixer.ctx;
    const out = this.mixer.clickOut;
    if (!ctx || !out) {
      this.onStatus('No audio graph yet: press play once, then calibrate.', true);
      return;
    }
    this.api.pause();
    // A ritual you cannot hear is not a ritual. The click fader starts at 0,
    // which is right for playing along and useless here.
    const raised = this.ensureClickAudible() ? 'Raised the Click fader. ' : '';
    this.el.calibrate.textContent = 'Stop';
    this.el.record.disabled = true;
    const run = calibrate(ctx, out, (fn) => this.midi.onHit(fn), (p) =>
      this.showCalibration(
        `bar ${Math.floor(p.beat / 4) + 1}/10 · ${p.n} hits` +
          (p.offsetMs === undefined ? '' : ` · ${signed(p.offsetMs)} ms`)
      )
    );
    this.running = run;
    this.onStatus(
      `${raised}Calibrating: two bars to find the click, then eight bars of ` +
        'steady quarters on one pad.'
    );
    try {
      this.calibration = await run.done;
      await saveCalibration(this.calibration);
      const c = this.calibration;
      this.onStatus(
        `Calibrated: you play ${signed(c.offsetMs)} ms against the click ` +
          `(median of ${c.n} hits on note ${c.note}, spread ±${c.spreadMs} ms). ` +
          (c.spreadMs > 25 ? 'That spread is wide -- worth measuring again.' : '')
      );
    } catch (err) {
      const message = (err as Error).message;
      if (message !== 'cancelled') this.onStatus(`Calibration failed: ${message}`, true);
    } finally {
      this.running = undefined;
      this.el.calibrate.textContent = 'Calibrate';
      this.showCalibration();
      this.showCell();
    }
  }

  // --- the cell -------------------------------------------------------------------

  /** What this cell is, and whether it can be played. */
  private section() {
    const song = this.loaded?.song;
    return song?.sections[this.cell];
  }

  /** kit.toml's `[input]`: what the module sends, for anything that asks. */
  get input() {
    return kitInput;
  }

  /** The calibration ritual while it is running, or nothing. */
  get calibrating(): CalibrationRun | undefined {
    return this.running;
  }

  /** The notes this cell asks for, placed in the mix. Empty if it cannot be played. */
  expected(): ExpectedNote[] {
    const loaded = this.loaded;
    const section = this.section();
    if (!loaded?.grid || !section) return [];
    return expectedNotes(
      loaded.hits,
      loaded.grid,
      { start: section.start_bar, end: section.end_bar },
      loaded.sticking
    );
  }

  private showCell() {
    const section = this.section();
    const grid = this.loaded?.grid;
    this.el.cell.textContent = section
      ? `${section.name} · bars ${section.start_bar}-${section.end_bar} · ${Math.round(CELL.tempo * 100)}%`
      : 'no sections in song.toml';
    const ready =
      !!section && !!grid && !this.running && this.midi.hasSource && import.meta.env.DEV;
    this.el.record.disabled = !ready && !this.recording;
    // Calibrating needs something sending strokes and nothing else running --
    // not a song, which is the point: the click it measures against is its own.
    if (!this.running) this.el.calibrate.disabled = !this.midi.hasSource || !!this.recording;
    // A disabled button should say what would enable it.
    this.el.record.title = !import.meta.env.DEV
      ? 'Recording needs the dev server (npm run dev)'
      : !section
        ? 'No [[section]] blocks in song.toml -- run `drums sections <slug>`'
        : !grid
          ? 'No grid.lock.json: nothing can be placed in the mix'
          : !this.midi.hasSource
            ? 'Enable MIDI first: there is nothing to record'
            : 'Play this cell and be marked on it';
  }

  private toggleRecord() {
    if (this.recording) this.stopRecording(false);
    else this.startRecording();
  }

  private startRecording() {
    const loaded = this.loaded;
    const section = this.section();
    if (!loaded?.grid || !section) return;
    const grid = loaded.grid;
    const startMs = barStartMs(grid, section.start_bar - 1);
    // The cell ends where the bar after its last bar begins.
    const endMs = barStartMs(grid, section.end_bar);
    if (startMs === undefined || endMs === undefined) {
      this.onStatus('The beat map does not cover this section.', true);
      return;
    }

    this.heatmap.clear();
    this.result = undefined;
    this.el.report.hidden = true;
    // `capture` stays unset until the music actually starts: the transport is
    // parked on the cell's first beat through the count-in, so a stroke played
    // over the count-in would otherwise be stamped exactly on that beat and
    // recorded as a very good hit.
    this.capture = undefined;
    this.recording = { startMs, endMs, started: new Date().toISOString() };

    this.mixer.ensureGraph();
    this.api.playbackSpeed = CELL.tempo;
    this.clock.seekTo(startMs);

    this.el.record.textContent = 'Stop';
    this.el.record.dataset.armed = '1';
    this.el.record.disabled = false;
    this.onStatus(
      `Counting in ${section.name}, bars ${section.start_bar}-${section.end_bar}` +
        (this.calibration ? '' : ' -- uncalibrated, so the mean offset will include the audio path')
    );

    // One bar of clicks, then the music, starting exactly on the cell's first
    // beat. A count-in rather than a bar of the record itself, because the
    // first section of a song has no bar before it to play -- and because the
    // clicks give you the tempo, which the run-up only implies.
    const perBar = grid.meter.beats_per_bar;
    const barMs = (barStartMs(grid, section.start_bar) ?? startMs + 2000) - startMs;
    const beatS = barMs / perBar / 1000 / CELL.tempo;
    void this.countIn(beatS, perBar * COUNT_IN_BARS).then((go) => {
      if (!go) return; // stopped during the count-in
      this.capture = [];
      this.api.play();
      clearInterval(this.timer);
      this.timer = window.setInterval(() => {
        if (this.clock.mixTimeMs >= endMs) this.stopRecording(true);
      }, 25);
      this.onStatus(
        `Recording ${section.name}, bars ${section.start_bar}-${section.end_bar}.`
      );
    });
  }

  /**
   * Click for `beats` beats, then resolve at the moment the music should start.
   *
   * Both the clicks and the song go through the same audio graph, so they reach
   * the speakers with the same delay and nothing has to be corrected for: the
   * beat after the last click is where bar one lands.
   */
  private countIn(beatS: number, beats: number): Promise<boolean> {
    const ctx = this.mixer.ctx;
    const out = this.mixer.clickOut;
    if (!ctx || !out || beatS <= 0) return Promise.resolve(true);
    this.ensureClickAudible();
    const click = new Click(ctx, out);
    click.load(
      Array.from({ length: beats }, (_, i) => i * beatS),
      (beat) => beat === 0
    );
    // A moment's grace so the first click is not clipped by the scheduler.
    const first = ctx.currentTime + 0.25;
    const music = first + beats * beatS;
    return new Promise<boolean>((resolve) => {
      const pump = window.setInterval(() => {
        if (!this.recording) {
          clearInterval(pump);
          clearTimeout(this.countInTimer);
          click.forget();
          resolve(false);
          return;
        }
        click.book(ctx.currentTime - first, 1);
      }, 25);
      this.countInTimer = window.setTimeout(
        () => {
          clearInterval(pump);
          resolve(this.recording !== undefined);
        },
        Math.max(0, (music - ctx.currentTime) * 1000)
      );
    });
  }

  /** The click bus at zero is right for playing along and wrong for counting in. */
  private ensureClickAudible(): boolean {
    if (Number(this.el.clickFader.value) > 0) return false;
    this.el.clickFader.value = '70';
    this.el.clickFader.dispatchEvent(new Event('input'));
    return true;
  }

  private stopRecording(complete: boolean) {
    clearInterval(this.timer);
    clearTimeout(this.countInTimer);
    this.timer = 0;
    const window_ = this.recording;
    const events = this.capture;
    this.recording = undefined;
    this.capture = undefined;
    this.el.record.textContent = 'Record';
    delete this.el.record.dataset.armed;
    if (!window_ || !events) {
      this.showCell();
      return;
    }
    this.api.pause();
    void this.finish(window_, events, complete);
  }

  private async finish(
    window_: { startMs: number; endMs: number; started: string },
    events: TakeEvent[],
    complete: boolean
  ) {
    const loaded = this.loaded!;
    const section = this.section()!;
    const grid = loaded.grid!;
    const written = this.expected();
    const calibrationMs = this.calibration?.offsetMs ?? 0;
    const result = grade(written, events, { calibrationMs, sameDrum: kitInput.same_drum });
    this.result = result;

    this.heatmap.show(result, grid);
    this.drawReport(result);
    this.el.report.hidden = false;

    const take: Take = {
      version: 1,
      cell: {
        section: section.name,
        tempo: CELL.tempo,
        startBar: section.start_bar,
        endBar: section.end_bar,
      },
      startedAt: window_.started,
      calibrationMs,
      calibrationNote: this.calibration?.note,
      chartHash: loaded.chartHash,
      sectionsHash: loaded.song.sectionsHash,
      complete,
      events,
      grade: result.grade,
    };

    let written_ = '';
    try {
      written_ = await writeTake(loaded.song.slug, take);
    } catch (err) {
      this.onStatus(`Take not written: ${(err as Error).message}`, true);
    }

    const g = result.grade;
    const drift = this.calibration ? Math.abs(g.timing.overall.meanMs) : 0;
    this.onStatus(
      [
        complete ? 'Take complete.' : 'Take stopped early (it does not fill the cell).',
        `${g.hit}/${g.expected} notes, ${g.missed} missed, ${g.extra} extra.`,
        `Mean ${signed(g.timing.overall.meanMs)} ms, spread ±${g.timing.overall.sdMs} ms.`,
        written_ ? `Written to takes/${written_}.` : '',
        // Q9: a mean that has walked away from the stored calibration usually
        // means the audio path changed, not that you started rushing.
        drift > DRIFT_MS
          ? `The mean has drifted ${Math.round(drift)} ms from the calibration -- worth re-running it.`
          : '',
        g.unmappedNotes.length
          ? `Unmapped module notes: ${g.unmappedNotes.join(', ')} (add them to kit.toml [input.note]).`
          : '',
      ]
        .filter(Boolean)
        .join(' ')
    );
    this.showCell();
  }

  // --- the timing strip -------------------------------------------------------------

  /**
   * Mean and spread per limb, and the bars worth playing again.
   *
   * Kept apart on purpose: a mean of +20 ms is the audio path and a spread of
   * ±20 ms is the playing, and one number that averaged them would send you to
   * practise a problem you do not have (practice-plan Q7).
   */
  private drawReport(result: GradeResult) {
    const g = result.grade;
    const palette = heatmapPalette(this.dark);
    const el = this.el.report;
    el.replaceChildren();

    const totals = document.createElement('p');
    totals.className = 'totals';
    totals.innerHTML =
      `<b>${g.hit}/${g.expected}</b> notes · ` +
      `${g.missed} missed · ${g.extra} extra · ${g.wrongVoice} wrong voice · ${g.flam} flam · ` +
      `mean <b>${signed(g.timing.overall.meanMs)} ms</b> ± ${g.timing.overall.sdMs}`;
    el.appendChild(totals);

    // Not a mistake, but not nothing either: a groove full of these usually
    // means the module's hi-hat threshold is not where your foot thinks it is.
    if (g.sameDrum > 0) {
      const shades = document.createElement('p');
      shades.className = 'worst';
      shades.style.margin = '0 0 6px';
      shades.textContent =
        `${g.sameDrum} of those hits landed on the same drum in its other state ` +
        '(an open hat where closed is written). Counted as hits.';
      el.appendChild(shades);
    }

    const legend = document.createElement('p');
    legend.className = 'heads';
    for (const [label, colour] of [
      ['on time', palette.tight],
      ['early', palette.early],
      ['late', palette.late],
      ['missed', palette.missed],
      ['wrong voice', palette.wrongVoice],
    ] as const) {
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = `rgb(${colour.join(',')})`;
      legend.append(swatch, `${label} `);
    }
    el.appendChild(legend);

    const table = document.createElement('table');
    table.appendChild(
      row('th', ['Limb', 'Notes', 'Mean', 'Spread', 'Median', 'Worst'])
    );
    const limbs = Object.entries(g.timing.perLimb) as [Limb, Timing][];
    for (const [limb, t] of limbs.sort((a, b) => b[1].n - a[1].n)) {
      table.appendChild(
        row('td', [
          LIMB_NAMES[limb] ?? limb,
          String(t.n),
          `${signed(t.meanMs)} ms`,
          `± ${t.sdMs} ms`,
          `${signed(t.medianMs)} ms`,
          `${t.maxAbsMs} ms`,
        ])
      );
    }
    el.appendChild(table);

    const worst = g.worstBars.filter((b) => b.wrong > 0 || b.rmsMs > 0).slice(0, 4);
    if (worst.length) {
      const p = document.createElement('p');
      p.className = 'worst';
      p.textContent =
        'Worst bars: ' +
        worst
          .map((b) => `${b.bar} (${b.wrong ? `${b.wrong} wrong, ` : ''}±${b.rmsMs} ms)`)
          .join(' · ');
      el.appendChild(p);
    }
  }
}

function row(cell: 'th' | 'td', values: string[]): HTMLTableRowElement {
  const tr = document.createElement('tr');
  values.forEach((value, i) => {
    const td = document.createElement(cell);
    td.textContent = value;
    if (i > 0) td.className = 'num';
    tr.appendChild(td);
  });
  return tr;
}

/** `+12` / `-12` / `0`: the sign is the whole point, so it is never dropped. */
const signed = (ms: number) => (ms > 0 ? `+${ms}` : String(ms));

/** Everything practice mode needs about a song, read once when it loads. */
export async function readPracticeSong(
  song: SongMeta,
  bytes: Uint8Array,
  grid: Grid | undefined,
  sticking: StickingLock | undefined
): Promise<PracticeSong> {
  const hash = await chartHash(bytes);
  return {
    song,
    grid,
    hits: readChart(bytes, song.map).hits,
    chartHash: hash,
    // Letters solved against a different chart would put the wrong limb on
    // every note in the report, which is worse than not naming the limb.
    sticking: sticking && sticking.chart === hash ? sticking : undefined,
  };
}

export type { ExpectedNote };
