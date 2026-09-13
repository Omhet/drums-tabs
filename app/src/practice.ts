// Practice mode: play a cell, get marked, fill the grid.
//
// M1 was one hardcoded cell end to end -- MIDI in, a calibration ritual, a take
// on disk, a grade, and the grade drawn on the staff -- built that way so the
// take format was proven against a real kit before the grid depended on it.
// M2 is the grid: the fixed set of cells a run walks (practice-plan Q5), open
// across sittings and sealed by hand (Q10).
//
// The division of labour is worth keeping: `routine.ts` knows what a routine
// *is* and has no idea a browser exists, this file knows how to play one. Every
// rule about shape, order, filling and sealing belongs over there where
// `node --test` can reach it.
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
import {
  buildCells,
  cellById,
  describeCell,
  discardRoutine,
  fillCell,
  nextCell,
  openRoutine,
  progress,
  readRoutine,
  resumeProblem,
  sealRoutine,
  writeRoutine,
  PASS,
  TEMPOS,
  type Routine,
  type RoutineCell,
} from './routine';
import { chartHash, type StickingLock } from './sticking';
import { writeTake, type Take } from './take';
import { barStartMs, type Grid } from './syncpoints';

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
  /** The tempo slider, driven the same way: a cell's tempo *is* the page's tempo. */
  speedFader: HTMLInputElement;
  /** The grid itself, drawn from the cells. */
  grid: HTMLElement;
  start: HTMLButtonElement;
  seal: HTMLButtonElement;
  discard: HTMLButtonElement;
  routineState: HTMLOutputElement;
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
  /**
   * The grid, always -- it comes from the sections and the tempo ladder, so it
   * exists whether or not a run is open. Without an open routine the cells are
   * simply somewhere to aim: you can play any of them, and nothing is filled.
   */
  cells: RoutineCell[] = [];
  /** The run in progress, read from disk on load. At most one per song (Q10). */
  routine: Routine | undefined;
  /** The cell id you are on. */
  at = '';
  /** Why the open routine cannot be resumed, or why it is about to go mixed. */
  private resumeNote: { fatal: boolean; message: string } | undefined;

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
    el.start.addEventListener('click', () => void this.startRoutine());
    el.seal.addEventListener('click', () => void this.seal());
    el.discard.addEventListener('click', () => void this.discard());

    void this.reloadCalibration();
  }

  setTheme(dark: boolean) {
    this.dark = dark;
    this.heatmap.setTheme(dark);
    if (this.result) this.drawReport(this.result);
  }

  /** Point practice mode at the song the player just loaded. */
  async load(loaded: PracticeSong) {
    this.stopRecording(false);
    this.heatmap.clear();
    this.result = undefined;
    this.el.report.hidden = true;
    this.loaded = loaded;
    this.cells = buildCells(loaded.song.sections);
    this.routine = undefined;
    this.resumeNote = undefined;
    this.at = this.cells[0]?.id ?? '';
    this.showCell();
    this.drawGrid();

    // The open routine is on disk, not in this page: a Ctrl+S in Live reloads
    // the page, and a run you cannot pick up afterwards is a run you cannot
    // spread over a week (Q10).
    let open: Routine | undefined;
    try {
      open = await readRoutine(loaded.song.slug);
    } catch {
      // No dev server, or a page built by `npm run build`. Recording needs the
      // server anyway, so the grid stays as something to read.
    }
    // The song may have been switched while that was in flight.
    if (this.loaded !== loaded || !open) return this.drawGrid();
    this.adopt(open);
  }

  /**
   * Take up an open routine read from disk -- or refuse to, and say why.
   *
   * The refusal that matters is the section grid: a boundary that moved means
   * the filled cells and the empty ones are no longer describing the same
   * music, and quietly carrying on would put two epochs on one progress line
   * (Q5 consequence 1).
   */
  private adopt(open: Routine) {
    const loaded = this.loaded!;
    const problem = resumeProblem(open, loaded.song, loaded.chartHash);
    this.resumeNote = problem;
    if (problem?.fatal) {
      this.routine = undefined;
      this.onStatus(problem.message, true);
    } else {
      // The cells are rebuilt from today's sections and the fills are carried
      // across by id, so a routine written by an older build still resumes.
      this.routine = { ...open, cells: this.cells.map((cell) => cellById(open, cell.id) ?? cell) };
      this.cells = this.routine.cells;
      this.at = nextCell(this.routine, '') ?? this.at;
      if (problem) this.onStatus(problem.message, true);
    }
    this.showCell();
    this.drawGrid();
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

  /** The cell you are on, or nothing when the song has no sections to build a grid from. */
  cell(): RoutineCell | undefined {
    return this.cells.find((cell) => cell.id === this.at) ?? this.cells[0];
  }

  /**
   * Aim at another cell.
   *
   * Any cell, at any time, filled or not: the grid is walked in order by
   * default because that is the order that teaches, not because the others are
   * locked (Q5). Re-recording a filled cell replaces what is in it.
   */
  select(id: string) {
    if (this.recording || !this.cells.some((cell) => cell.id === id)) return;
    this.at = id;
    this.showCell();
    this.drawGrid();
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
    const cell = this.cell();
    if (!loaded?.grid || !cell) return [];
    return expectedNotes(
      loaded.hits,
      loaded.grid,
      { start: cell.startBar, end: cell.endBar },
      loaded.sticking
    );
  }

  private showCell() {
    const cell = this.cell();
    const grid = this.loaded?.grid;
    this.el.cell.textContent = cell ? describeCell(cell) : 'no sections in song.toml';
    const ready = !!cell && !!grid && !this.running && this.midi.hasSource && import.meta.env.DEV;
    this.el.record.disabled = !ready && !this.recording;
    // Calibrating needs something sending strokes and nothing else running --
    // not a song, which is the point: the click it measures against is its own.
    if (!this.running) this.el.calibrate.disabled = !this.midi.hasSource || !!this.recording;
    // A disabled button should say what would enable it.
    this.el.record.title = !import.meta.env.DEV
      ? 'Recording needs the dev server (npm run dev)'
      : !cell
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
    const cell = this.cell();
    if (!loaded?.grid || !cell) return;
    const grid = loaded.grid;
    const startMs = barStartMs(grid, cell.startBar - 1);
    // The cell ends where the bar after its last bar begins.
    const endMs = barStartMs(grid, cell.endBar);
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
    // Through the page's own tempo slider rather than straight at alphaTab: the
    // slider, its readout and the media's rate then cannot disagree about what
    // speed you are playing at, and the cell's tempo is visible where every
    // other tempo on this page is.
    this.setSpeed(cell.tempo);
    this.clock.seekTo(startMs);

    this.el.record.textContent = 'Stop';
    this.el.record.dataset.armed = '1';
    this.el.record.disabled = false;
    this.onStatus(
      `Counting in ${describeCell(cell)}` +
        (this.calibration ? '' : ' -- uncalibrated, so the mean offset will include the audio path')
    );

    // One bar of clicks, then the music, starting exactly on the cell's first
    // beat. A count-in rather than a bar of the record itself, because the
    // first section of a song has no bar before it to play -- and because the
    // clicks give you the tempo, which the run-up only implies.
    const perBar = grid.meter.beats_per_bar;
    const barMs = (barStartMs(grid, cell.startBar) ?? startMs + 2000) - startMs;
    // The count-in is in the cell's tempo, not the record's: four clicks at
    // 100% would hand you the wrong speed to start a 70% cell in.
    const beatS = barMs / perBar / 1000 / cell.tempo;
    void this.countIn(beatS, perBar * COUNT_IN_BARS).then((go) => {
      if (!go) return; // stopped during the count-in
      this.capture = [];
      this.api.play();
      clearInterval(this.timer);
      this.timer = window.setInterval(() => {
        if (this.clock.mixTimeMs >= endMs) this.stopRecording(true);
      }, 25);
      this.onStatus(`Recording ${describeCell(cell)}.`);
    });
  }

  /** The tempo slider is the one place a playback rate is set (see `startRecording`). */
  private setSpeed(tempo: number) {
    const percent = String(Math.round(tempo * 100));
    if (this.el.speedFader.value === percent) return;
    this.el.speedFader.value = percent;
    this.el.speedFader.dispatchEvent(new Event('input'));
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
    const cell = this.cell()!;
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
        id: cell.id,
        section: cell.section,
        tempo: cell.tempo,
        startBar: cell.startBar,
        endBar: cell.endBar,
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

    // A take that reached the end of the cell fills it, replacing whatever was
    // there: the last complete take counts, not the best (Q5). A take that did
    // not is still on disk -- it is a measurement that happened -- but the cell
    // stays empty.
    const filled = complete && written_ ? await this.fill(cell, take, written_) : '';

    const g = result.grade;
    const drift = this.calibration ? Math.abs(g.timing.overall.meanMs) : 0;
    this.onStatus(
      [
        complete ? 'Take complete.' : 'Take stopped early (it does not fill the cell).',
        `${g.hit}/${g.expected} notes, ${g.missed} missed, ${g.extra} extra.`,
        `Mean ${signed(g.timing.overall.meanMs)} ms, spread ±${g.timing.overall.sdMs} ms.`,
        written_ ? `Written to takes/${written_}.` : '',
        filled,
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

  // --- the routine ------------------------------------------------------------------

  /**
   * Put a completed take in its cell, and write the run to disk.
   *
   * After every cell rather than at the end of the sitting, because the end of
   * the sitting is not an event this program ever sees: the page is reloaded by
   * Live on every Ctrl+S, and the browser is closed without ceremony (Q10).
   */
  private async fill(cell: RoutineCell, take: Take, name: string): Promise<string> {
    const routine = this.routine;
    if (!routine) return 'It fills no cell: no routine is open (press Start routine).';
    const next = fillCell(routine, cell.id, {
      take: name,
      startedAt: take.startedAt,
      accuracy: take.grade.accuracy,
      hit: take.grade.hit,
      expected: take.grade.expected,
      chartHash: take.chartHash,
    });
    try {
      await writeRoutine(this.loaded!.song.slug, next);
    } catch (err) {
      // The take is on disk either way, so this loses a cell, not the playing.
      return `The cell was not filled: ${(err as Error).message}`;
    }
    this.routine = next;
    this.cells = next.cells;
    const { filled, total, complete } = progress(next);
    this.at = nextCell(next, cell.id) ?? cell.id;
    this.showCell();
    this.drawGrid();
    return complete
      ? `Routine complete: ${filled}/${total} cells. Seal it to put it in the history.`
      : `Cell filled: ${filled}/${total}. Next up: ${describeCell(this.cell()!)}.`;
  }

  /**
   * Open a run.
   *
   * A button rather than something the first take does for you: whether a take
   * counts towards a run should never be a surprise in either direction.
   */
  async startRoutine() {
    const loaded = this.loaded;
    if (!loaded || this.routine || this.cells.length === 0) return;
    const routine = openRoutine(loaded.song, loaded.chartHash);
    try {
      await writeRoutine(loaded.song.slug, routine);
    } catch (err) {
      this.onStatus(`No routine started: ${(err as Error).message}`, true);
      return;
    }
    this.routine = routine;
    this.cells = routine.cells;
    this.resumeNote = undefined;
    this.at = this.cells[0]!.id;
    this.showCell();
    this.drawGrid();
    const ladder = TEMPOS.map((t) => Math.round(t * 100)).join('/');
    this.onStatus(
      `Routine open: ${routine.cells.length} cells -- ${this.sectionCount()} sections at ${ladder}%, ` +
        'then the whole song at each. It stays open until you seal it, over as many sittings as it takes.'
    );
  }

  /** Distinct sections in the grid: the whole-song row is not one of them. */
  private sectionCount(): number {
    return new Set(this.cells.filter((cell) => !cell.whole).map((cell) => cell.section)).size;
  }

  /** Finish the run: it enters the history and stops being the open one. */
  async seal() {
    const routine = this.routine;
    const loaded = this.loaded;
    if (!routine || !loaded) return;
    let sealed: Routine;
    try {
      sealed = sealRoutine(routine);
    } catch (err) {
      // Q10: no incomplete routine is analysed. The rule is about not grading a
      // half-played song, so the button says why rather than doing it anyway.
      this.onStatus((err as Error).message, true);
      return;
    }
    try {
      await writeRoutine(loaded.song.slug, sealed);
    } catch (err) {
      this.onStatus(`Routine not sealed: ${(err as Error).message}`, true);
      return;
    }
    const red = sealed.cells.filter((cell) => (cell.fill?.accuracy ?? 0) < PASS).length;
    const days = spanDays(sealed.openedAt, sealed.sealedAt ?? sealed.lastPlayedAt);
    this.routine = undefined;
    this.resumeNote = undefined;
    this.cells = buildCells(loaded.song.sections);
    this.at = this.cells[0]?.id ?? '';
    this.showCell();
    this.drawGrid();
    this.onStatus(
      [
        `Routine sealed: ${sealed.cells.length} cells over ${days === 1 ? 'one sitting' : `${days} days`}.`,
        red ? `${red} below ${Math.round(PASS * 100)}%.` : 'Every cell green.',
        // Q10: a run whose cells were graded against different notation is
        // still a run, but it is not on the same line as the others.
        sealed.mixed
          ? 'The chart changed part-way through, so it is marked mixed and stays out of the comparison line.'
          : '',
      ]
        .filter(Boolean)
        .join(' ')
    );
  }

  /** Throw the run away. The takes it filled stay on disk: they happened. */
  async discard() {
    const routine = this.routine;
    const loaded = this.loaded;
    if (!routine || !loaded) return;
    const { filled, total } = progress(routine);
    const ok = window.confirm(
      `Discard this routine? ${filled} of ${total} cells are filled. ` +
        'The takes stay in takes/; the run they belong to does not.'
    );
    if (!ok) return;
    try {
      await discardRoutine(loaded.song.slug, routine.openedAt);
    } catch (err) {
      this.onStatus(`Routine not discarded: ${(err as Error).message}`, true);
      return;
    }
    this.routine = undefined;
    this.resumeNote = undefined;
    this.cells = buildCells(loaded.song.sections);
    this.at = this.cells[0]?.id ?? '';
    this.showCell();
    this.drawGrid();
    this.onStatus('Routine discarded. The takes it filled are still in takes/.');
  }

  /**
   * The grid: sections down, the tempo ladder across, the whole song last.
   *
   * Drawn from `cells` whether or not a routine is open, because the grid is a
   * property of the song and not of the run -- seeing the shape of the work is
   * useful before you commit to walking it.
   */
  private drawGrid() {
    const el = this.el.grid;
    const routine = this.routine;
    const { filled, total, complete } = routine
      ? progress(routine)
      : { filled: 0, total: this.cells.length, complete: false };

    this.el.start.hidden = !!routine;
    this.el.start.disabled = this.cells.length === 0 || !import.meta.env.DEV;
    this.el.start.title = !import.meta.env.DEV
      ? 'A routine is written to disk, which needs the dev server (npm run dev)'
      : this.cells.length === 0
        ? 'No [[section]] blocks in song.toml -- run `drums sections <slug>`'
        : 'Open a run of this grid. It stays open until you seal it.';
    this.el.seal.hidden = !routine;
    this.el.seal.disabled = !complete;
    this.el.seal.title = complete
      ? 'Finish the run and put it in the history'
      : `Every cell needs a take played to the end: ${filled}/${total} so far`;
    this.el.discard.hidden = !routine;

    this.el.routineState.textContent = routine
      ? `${filled}/${total} cells · opened ${day(routine.openedAt)}` +
        (day(routine.lastPlayedAt) === day(routine.openedAt) ? '' : `, last played ${day(routine.lastPlayedAt)}`)
      : this.cells.length
        ? `${total} cells, nothing open`
        : 'no sections to build a grid from';

    el.replaceChildren();
    el.hidden = this.cells.length === 0;
    if (el.hidden) return;

    const table = document.createElement('table');
    const head = document.createElement('tr');
    head.appendChild(document.createElement('th'));
    for (const tempo of TEMPOS) {
      const th = document.createElement('th');
      th.textContent = `${Math.round(tempo * 100)}%`;
      head.appendChild(th);
    }
    const thead = document.createElement('thead');
    thead.appendChild(head);
    table.appendChild(thead);

    // Cells arrive section-major, so consecutive runs of one section are a row.
    const rows = new Map<string, RoutineCell[]>();
    for (const cell of this.cells) {
      const row = rows.get(cell.section);
      if (row) row.push(cell);
      else rows.set(cell.section, [cell]);
    }
    const body = document.createElement('tbody');
    for (const [section, cells] of rows) {
      const tr = document.createElement('tr');
      if (cells[0]?.whole) tr.className = 'whole';
      const th = document.createElement('th');
      th.textContent = section;
      th.title = `bars ${cells[0]?.startBar}-${cells[0]?.endBar}`;
      tr.appendChild(th);
      for (const cell of cells) tr.appendChild(this.drawCell(cell, !!routine));
      body.appendChild(tr);
    }
    table.appendChild(body);
    el.appendChild(table);

    // Only when it has something to say: during a run the grid is the thing
    // worth looking at, and a line of standing advice under it is a line of the
    // notation given away for nothing.
    const message =
      this.resumeNote?.message ??
      (routine ? '' : 'Takes recorded with no routine open are written to takes/ but fill nothing.');
    if (message) {
      const note = document.createElement('p');
      note.className = this.resumeNote ? 'note warn' : 'note';
      note.textContent = message;
      el.appendChild(note);
    }
  }

  private drawCell(cell: RoutineCell, open: boolean): HTMLTableCellElement {
    const td = document.createElement('td');
    const button = document.createElement('button');
    const fill = cell.fill;
    button.className =
      'cell' +
      (fill ? (fill.accuracy >= PASS ? ' pass' : ' fail') : '') +
      (cell.id === this.at ? ' at' : '');
    // The accuracy, not the count: the cell is one column of a ladder and the
    // thing being compared across a row is how much of it you got.
    button.textContent = fill ? `${Math.round(fill.accuracy * 100)}%` : '·';
    button.title =
      describeCell(cell) +
      (fill
        ? ` · ${fill.hit}/${fill.expected} on ${day(fill.startedAt)} (takes/${fill.take})`
        : open
          ? ' · not yet played'
          : ' · no routine open');
    button.addEventListener('click', () => this.select(cell.id));
    td.appendChild(button);
    return td;
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

/** `2026-09-13`. A routine's dates are days, not moments. */
const day = (iso: string) => iso.slice(0, 10);

/** How many days a run was spread over, inclusive: one sitting is 1 (Q10). */
function spanDays(from: string, to: string): number {
  const ms = Date.parse(`${day(to)}T00:00:00Z`) - Date.parse(`${day(from)}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.max(1, Math.round(ms / 86400000) + 1) : 1;
}

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
