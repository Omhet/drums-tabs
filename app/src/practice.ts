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
import { grade, type Grade, type GradeResult, type TakeEvent, type Timing } from './grade';
import { Heatmap } from './heatmap';
import { say } from './icons';
import type { MixClock } from './media';
import { MidiIn, type MidiHit } from './midi-in';
import type { Mixer } from './mixer';
import {
  buildCells,
  cellById,
  cellSeries,
  comparableRuns,
  describeCell,
  discardRoutine,
  fillCell,
  nextCell,
  openRoutine,
  progress,
  readRoutine,
  readRoutines,
  resumeProblem,
  rollingMedian,
  sealRoutine,
  spanOf,
  writeRoutine,
  PASS,
  TEMPOS,
  type Routine,
  type RoutineCell,
} from './routine';
import { referenceMs as floorOf, referenceNote, type ReferenceLock } from './reference';
import { chartHash, type StickingLock } from './sticking';
import { writeTake, type Take } from './take';
import { barStartMs, type Grid } from './syncpoints';
import {
  describeDrill,
  scoreReps,
  writeDrill,
  type Drill,
  type Exercise,
  type ExerciseSource,
  type Rep,
} from './exercise';

/** Bars of click before the cell starts. Not recorded, not graded. */
const COUNT_IN_BARS = 1;
/**
 * Hits this far outside the range still belong to it: a late last note counts.
 *
 * It does two jobs, deliberately as one number. Matching one: a stroke this far
 * past the end of a cell is still that cell's. Looping one: after the transport
 * pauses at the end of a rep, this is how long the rep stays open for a fill's
 * last note to land in. They are the same question -- how late can a note be
 * and still be the note that was written -- so tuning one for the other's
 * reasons would break both.
 */
const EDGE_MS = 250;
/** Reps a drill stops itself at. A file is not a place for an afternoon. */
const MAX_REPS = 64;
/** A take whose mean is further than this from the stored calibration nags. */
const DRIFT_MS = 10;
/**
 * Inside this many milliseconds nobody hears it; beyond `LOOSE_MS` everybody
 * does. Two thresholds serve both the spread and the offset, because the ear
 * does not hold separate opinions about them -- and because a reading with two
 * scales in it is a reading you have to decode twice.
 */
const TIGHT_MS = 15;
const LOOSE_MS = 30;
/** Where the Feel needle pegs. Past this the take is not a near miss. */
const NEEDLE_MS = 60;
/** The trend sparklines are SVG, which needs its namespace spelled out. */
const SVG = 'http://www.w3.org/2000/svg';
/** How many hits the monitor keeps on screen. */
const MONITOR = 14;

const LIMB_NAMES: Record<Limb, string> = {
  right_hand: 'Right hand',
  left_hand: 'Left hand',
  right_foot: 'Right foot (kick)',
  left_foot: 'Left foot (hats)',
  hands: 'Hands',
};

/**
 * A take in progress, and -- for a drill -- the loop it keeps coming back round.
 *
 * The loop is a seek, not a second timeline: every rep happens at the same
 * absolute milliseconds of mix.wav, so one `expectedNotes` array serves all of
 * them and there is nothing to re-base and nothing to convert.
 */
interface Recording {
  startMs: number;
  endMs: number;
  started: string;
  /** The notes the range asks for. Computed once; the same every rep. */
  written: ExpectedNote[];
  /** Seconds a beat lasts at this tempo, for the count-in and the rest. */
  beatS: number;
  beatsPerBar: number;
  loop?: {
    restBars: number;
    /** Every rep closed so far. The open one is still in `capture`. */
    reps: Rep[];
    /**
     * Wall-clock moment the transport really crossed `endMs` -- the poller's
     * own moment minus its overshoot.
     *
     * The clock is parked from here until the next rep starts, so it cannot
     * stamp a stroke: anything arriving in the grace window gets its mix time
     * reconstructed from this instead (see `onHit`).
     */
    pausedAt: number;
    /** Between crossing `endMs` and the next rep starting. */
    resting: boolean;
  };
}

export interface PracticeSong {
  song: SongMeta;
  grid: Grid | undefined;
  hits: ChartHit[];
  chartHash: string;
  sticking: StickingLock | undefined;
  /** The song's reference lock, for the note under the timing dial. */
  reference: ReferenceLock | undefined;
  /**
   * How far behind the written grid the record itself plays, already resolved
   * against this chart: zero when unmeasured or measured from another chart.
   * Subtracted from every stroke, so timing reads against the record's feel.
   */
  referenceMs: number;
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
  /** One chip per rep of the drill in progress. */
  reps: HTMLElement;
  /** The Mix group, so a click-only drill can show it is holding the stems. */
  mix: HTMLElement;
  /** The two stem faders, disabled while a click-only drill holds them down. */
  stemFaders: HTMLInputElement[];
}

export class Practice {
  readonly midi: MidiIn;
  private readonly heatmap: Heatmap;
  private loaded: PracticeSong | undefined;
  private calibration: Calibration | undefined;
  private running: CalibrationRun | undefined;
  /** Armed or recording: the hits landing in the open rep (a take is one rep). */
  private capture: TakeEvent[] | undefined;
  private recording: Recording | undefined;
  private timer = 0;
  private countInTimer = 0;
  private graceTimer = 0;
  /**
   * The exercise Record is aimed at, or nothing when it is aimed at the grid.
   *
   * One field, because a routine cell and a drill must never both be armed:
   * whether a take counts towards a run should not be a surprise in either
   * direction (the same reasoning that made opening a routine a button).
   */
  armed: { exercise: Exercise; source: ExerciseSource; tempo: number } | undefined;
  /** The mix levels a click-only drill pulled down, to be put back when it ends. */
  private heldFaders: { nodrums: number; drums: number } | undefined;
  /**
   * The full result of every rep, for the heatmap.
   *
   * Kept beside `Rep`, which carries only the `Grade` that goes on disk: the
   * noteheads need the per-note verdicts, and those are the bulk of a result
   * and are rederivable from the take, so they are not written down.
   */
  private repResults: GradeResult[] = [];
  /**
   * Told when a drill reaches disk, so the panel can re-read the pool.
   *
   * A callback rather than the panel being reachable from here: this class owns
   * the kit and the clock, and the pool is somebody else's list.
   */
  onDrilled: ((exerciseId: string) => void) | undefined;
  private recent: MidiHit[] = [];
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
  /** The sealed runs, oldest first: what the trend column is drawn from. */
  history: Routine[] = [];
  /** The cell id you are on. */
  at = '';
  /** Why the open routine cannot be resumed, or why it is about to go mixed. */
  private resumeNote: { fatal: boolean; message: string } | undefined;
  /**
   * The bars the last graded take covered, for the strip.
   *
   * Kept rather than re-read from the current cell, because filling a cell
   * walks on to the next one -- and a theme switch redraws the report, which
   * would then draw the strip over a range the take never played.
   */
  private reportRange: { startBar: number; endBar: number } | undefined;

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
    // Only the notation needs telling: alphaTab paints noteheads itself, while
    // the report is drawn from CSS variables and re-themes with the interface.
    this.heatmap.setTheme(dark);
    // The heatmap bakes its colours into a render, so a take already on the
    // staff would keep the old palette's noteheads until the next take. That
    // was easy to miss when the switch was up in the header; it is not now
    // that it sits on the notation itself.
    const grid = this.loaded?.grid;
    if (this.result && grid) this.heatmap.show(this.result, grid);
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
    this.history = [];
    try {
      const [inProgress, sealed] = await Promise.all([
        readRoutine(loaded.song.slug),
        readRoutines(loaded.song.slug),
      ]);
      open = inProgress;
      this.history = sealed;
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
    // The word, and the glyph that stands in for it when the rail is collapsed
    // to one icon wide (icons.ts).
    if (state.kind === 'ready') say(this.el.enable, 'MIDI on', '✓');
    else say(this.el.enable, 'Enable MIDI', '♪');
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
    const rec = this.recording;
    if (!take || !rec) return;
    // Raw, uncorrected, and the module's own note number: the take stores the
    // measurement, and the grade is a reading of it (practice-plan Q8).
    const stroke = { note: hit.note, velocity: hit.velocity, instrument: hit.instrument };
    const loop = rec.loop;
    if (loop?.resting) {
      // The transport is parked at the end of the range, so the clock's own
      // stamp would read `endMs` however late the stroke is. Reconstruct it
      // from the wall clock instead -- this is the fill's last note landing.
      // Anything later than the grace window is rest-bar noise and is dropped
      // rather than filed against a rep nobody played it in.
      const since = hit.wallMs - loop.pausedAt;
      if (since < 0 || since > EDGE_MS) return;
      take.push({ tMs: rec.endMs + since * (this.clock.playbackRate || 1), ...stroke });
      return;
    }
    if (hit.tMs < rec.startMs - EDGE_MS || hit.tMs > rec.endMs + EDGE_MS) return;
    take.push({ tMs: hit.tMs, ...stroke });
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
    say(this.el.calibrate, 'Stop', '⏹');
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
      say(this.el.calibrate, 'Calibrate', '◎');
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

  /**
   * Aim Record at an exercise instead of the grid.
   *
   * The routine and the exercises are two separate histories, so this is the
   * one switch between them: with something armed, Record drills it on a loop
   * and writes a drill; with nothing armed, Record plays a cell and writes a
   * take. Never both.
   */
  armExercise(exercise: Exercise, source: ExerciseSource, tempo: number) {
    if (this.recording) return;
    this.armed = { exercise, source, tempo };
    this.repResults = [];
    this.el.reps.hidden = true;
    this.el.reps.replaceChildren();
    this.heatmap.clear();
    this.result = undefined;
    this.el.report.hidden = true;
    this.setSpeed(tempo);
    this.showCell();
    this.drawGrid();
  }

  /** Back to the grid. The exercise keeps its history; you are just not aimed at it. */
  disarm() {
    if (this.recording) return;
    this.armed = undefined;
    this.releaseStems();
    this.el.reps.hidden = true;
    this.el.reps.replaceChildren();
    this.showCell();
    this.drawGrid();
  }

  /**
   * How far behind the written grid this song's record plays, in ms.
   *
   * Taken off every stroke before matching, so a take's timing reads against
   * the record's feel rather than against a grid nobody played to. Zero for a
   * song `drums reference` has not been run on (reference.ts).
   */
  get referenceMs(): number {
    return this.loaded?.referenceMs ?? 0;
  }

  /** kit.toml's `[input]`: what the module sends, for anything that asks. */
  get input() {
    return kitInput;
  }

  /** The loaded song's tab.mid hash, for stamping a source when bars are cut. */
  get chartHash(): string {
    return this.loaded?.chartHash ?? '';
  }

  /**
   * How many notes are written in a stretch of bars.
   *
   * The cutting form asks before it writes: an exercise over bars with nothing
   * in them would score 0% for ever and there is no fixing it afterwards.
   */
  notesIn(startBar: number, endBar: number): number {
    const loaded = this.loaded;
    if (!loaded?.grid) return 0;
    return expectedNotes(loaded.hits, loaded.grid, { start: startBar, end: endBar }).length;
  }

  /** The calibration ritual while it is running, or nothing. */
  get calibrating(): CalibrationRun | undefined {
    return this.running;
  }

  /**
   * The notes the armed range asks for, placed in the mix.
   *
   * The exercise if one is armed, else the routine cell. Empty when there is
   * nothing to play or no beat map to place it against.
   */
  expected(): ExpectedNote[] {
    const loaded = this.loaded;
    const at = this.aim();
    if (!loaded?.grid || !at) return [];
    return expectedNotes(
      loaded.hits,
      loaded.grid,
      { start: at.startBar, end: at.endBar },
      loaded.sticking
    );
  }

  /**
   * Pull the two stems down for a click-only drill, and remember where they were.
   *
   * Straight at the mixer rather than through the sliders' `input` event, which
   * is what every other level change on this page goes through. That event
   * writes the levels to localStorage -- and Ableton reloads this page on every
   * Ctrl+S, so a drill interrupted half way would otherwise leave the song
   * muted with nothing on screen to say why. The sliders are disabled instead,
   * so the page shows it is holding them rather than lying about them.
   */
  private holdStems() {
    if (this.heldFaders) return;
    this.heldFaders = {
      nodrums: this.mixer.level('nodrums'),
      drums: this.mixer.level('drums'),
    };
    this.mixer.setLevel('nodrums', 0);
    this.mixer.setLevel('drums', 0);
    this.el.mix.dataset.held = '1';
    for (const fader of this.el.stemFaders) fader.disabled = true;
    this.ensureClickAudible();
  }

  /** Give them back. Every exit from a drill goes through here, errors included. */
  private releaseStems() {
    const held = this.heldFaders;
    this.heldFaders = undefined;
    if (!held) return;
    this.mixer.setLevel('nodrums', held.nodrums);
    this.mixer.setLevel('drums', held.drums);
    delete this.el.mix.dataset.held;
    for (const fader of this.el.stemFaders) fader.disabled = false;
  }

  private showCell() {
    const at = this.aim();
    const grid = this.loaded?.grid;
    this.el.cell.textContent = at?.label ?? 'no sections in song.toml';
    // The word on the button follows what it is aimed at, which is what
    // icons.ts exists for -- one transport, one meaning per page, rather than a
    // second Record button that is only sometimes the right one.
    if (!this.recording) say(this.el.record, this.armed ? 'Drill' : 'Record', '⏺');
    const ready = !!at && !!grid && !this.running && this.midi.hasSource && import.meta.env.DEV;
    this.el.record.disabled = !ready && !this.recording;
    // Calibrating needs something sending strokes and nothing else running --
    // not a song, which is the point: the click it measures against is its own.
    if (!this.running) this.el.calibrate.disabled = !this.midi.hasSource || !!this.recording;
    // A disabled button should say what would enable it.
    this.el.record.title = !import.meta.env.DEV
      ? 'Recording needs the dev server (npm run dev)'
      : !at
        ? 'No [[section]] blocks in song.toml -- run `drums sections <slug>`'
        : !grid
          ? 'No grid.lock.json: nothing can be placed in the mix'
          : !this.midi.hasSource
            ? 'Enable MIDI first: there is nothing to record'
            : this.armed
              ? 'Loop these bars and be marked on every time round'
              : 'Play this cell and be marked on it';
  }

  private toggleRecord() {
    if (this.recording) this.stopRecording(false);
    else this.startRecording();
  }

  /** What Record is aimed at: the range, the tempo, and the words for it. */
  private aim():
    | { startBar: number; endBar: number; tempo: number; label: string; restBars?: number }
    | undefined {
    const armed = this.armed;
    if (armed) {
      return {
        startBar: armed.source.startBar,
        endBar: armed.source.endBar,
        tempo: armed.tempo,
        label: describeDrill(armed.exercise, armed.source, armed.tempo),
        restBars: armed.exercise.restBars,
      };
    }
    const cell = this.cell();
    return cell
      ? {
          startBar: cell.startBar,
          endBar: cell.endBar,
          tempo: cell.tempo,
          label: describeCell(cell),
        }
      : undefined;
  }

  private startRecording() {
    const loaded = this.loaded;
    const at = this.aim();
    if (!loaded?.grid || !at) return;
    const grid = loaded.grid;
    const startMs = barStartMs(grid, at.startBar - 1);
    // The range ends where the bar after its last bar begins.
    const endMs = barStartMs(grid, at.endBar);
    if (startMs === undefined || endMs === undefined) {
      this.onStatus('The beat map does not cover those bars.', true);
      return;
    }

    this.heatmap.clear();
    this.result = undefined;
    this.el.report.hidden = true;
    this.repResults = [];
    this.el.reps.replaceChildren();
    this.el.reps.hidden = true;
    // `capture` stays unset until the music actually starts: the transport is
    // parked on the range's first beat through the count-in, so a stroke played
    // over the count-in would otherwise be stamped exactly on that beat and
    // recorded as a very good hit.
    this.capture = undefined;
    const perBar = grid.meter.beats_per_bar;
    const barMs = (barStartMs(grid, at.startBar) ?? startMs + 2000) - startMs;
    // The count-in is in the range's tempo, not the record's: four clicks at
    // 100% would hand you the wrong speed to start a 70% run in.
    const beatS = barMs / perBar / 1000 / at.tempo;
    const rec: Recording = {
      startMs,
      endMs,
      started: new Date().toISOString(),
      written: this.expected(),
      beatS,
      beatsPerBar: perBar,
      ...(at.restBars === undefined
        ? {}
        : { loop: { restBars: at.restBars, reps: [], pausedAt: 0, resting: false } }),
    };
    this.recording = rec;

    this.mixer.ensureGraph();
    if (this.armed?.exercise.backing === 'click') this.holdStems();
    // Through the page's own tempo slider rather than straight at alphaTab: the
    // slider, its readout and the media's rate then cannot disagree about what
    // speed you are playing at, and the tempo is visible where every other
    // tempo on this page is.
    this.setSpeed(at.tempo);
    this.clock.seekTo(startMs);

    say(this.el.record, 'Stop', '⏹');
    this.el.record.dataset.armed = '1';
    this.el.record.disabled = false;
    this.drawGrid();
    this.onStatus(
      `Counting in ${at.label}` +
        (this.calibration ? '' : ' -- uncalibrated, so the mean offset will include the audio path')
    );

    // One bar of clicks, then the music, starting exactly on the first beat of
    // the range. A count-in rather than a bar of the record itself, because the
    // first section of a song has no bar before it to play -- and because the
    // clicks give you the tempo, which the run-up only implies.
    void this.countIn(beatS, perBar * COUNT_IN_BARS).then((go) => {
      if (!go || this.recording !== rec) return; // stopped during the count-in
      this.openRep();
      this.api.play();
      clearInterval(this.timer);
      this.timer = window.setInterval(() => this.tick(), 25);
      this.onStatus(`Recording ${at.label}.`);
    });
  }

  /**
   * The only place the transport is watched: the end of a take, or of a rep.
   *
   * A take stops at the end of the range. A drill pauses there, waits a moment
   * for a last note that was a hair late, grades the rep, seeks back and counts
   * you in again -- play it, wait, play it again, which is how the thing is
   * actually practised. The pause is also what makes the seek safe: a paused
   * seek is the only kind this app has ever done, and a bar of click covers
   * whatever the audio element needs to do to get back.
   */
  private tick() {
    const rec = this.recording;
    if (!rec) return;
    const loop = rec.loop;
    if (!loop) {
      if (this.clock.mixTimeMs >= rec.endMs) this.stopRecording(true);
      return;
    }
    // The rest is driven by the count-in's own promise, not by this timer.
    if (loop.resting || this.clock.mixTimeMs < rec.endMs) return;
    loop.resting = true;
    const rate = this.clock.playbackRate || 1;
    // This fires every 25 ms, so it has overshot by up to that much. Back the
    // overshoot out to get the moment the clock really crossed the end.
    loop.pausedAt = performance.now() - (this.clock.mixTimeMs - rec.endMs) / rate;
    this.api.pause();
    // The rep stays open through the grace window, so that a fill's last note
    // -- routinely a few milliseconds late -- is still the note it was written
    // as rather than a very early downbeat of the next rep.
    clearTimeout(this.graceTimer);
    this.graceTimer = window.setTimeout(() => void this.nextRep(rec), EDGE_MS);
  }

  /** Close the rep that just ended, wind back, and count in the next one. */
  private async nextRep(rec: Recording) {
    if (this.recording !== rec || !rec.loop) return;
    const loop = rec.loop;
    this.closeRep(rec, true);
    this.drawReps(loop.reps);
    if (loop.reps.length >= MAX_REPS) {
      this.onStatus(`That is ${MAX_REPS} reps -- stopping there and writing the drill.`);
      this.stopRecording(true);
      return;
    }
    this.clock.seekTo(rec.startMs);
    // A rest of nought still turns round through a pause and a seek; it is as
    // fast as the transport goes, not instant. One bar is the default because
    // waiting for your entry is part of the exercise.
    const beats = rec.beatsPerBar * loop.restBars;
    const go = beats > 0 ? await this.countIn(rec.beatS, beats) : true;
    if (!go || this.recording !== rec) return;
    this.openRep();
    this.api.play();
    loop.resting = false;
  }

  /** A rep begins: hits from here land in it. */
  private openRep() {
    this.capture = [];
  }

  /**
   * A rep ends, and is graded there and then.
   *
   * Per rep rather than all at the end, because the strip of chips has to
   * colour itself as you play and because twenty grades at once is twenty
   * grades the page does in one frame.
   */
  private closeRep(rec: Recording, complete: boolean) {
    const events = this.capture;
    this.capture = undefined;
    if (!events || !rec.loop) return;
    const result = grade(rec.written, events, {
      calibrationMs: this.calibration?.offsetMs ?? 0,
      referenceMs: this.loaded?.referenceMs ?? 0,
      sameDrum: kitInput.same_drum,
    });
    rec.loop.reps.push({
      n: rec.loop.reps.length + 1,
      startedAt: new Date().toISOString(),
      complete,
      events,
      grade: result.grade,
    });
    this.repResults.push(result);
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
    clearTimeout(this.graceTimer);
    this.timer = 0;
    const rec = this.recording;
    const events = this.capture;
    this.recording = undefined;
    say(this.el.record, 'Record', '⏺');
    delete this.el.record.dataset.armed;
    this.drawGrid();
    if (!rec) {
      this.capture = undefined;
      this.releaseStems();
      this.showCell();
      return;
    }
    this.api.pause();
    if (rec.loop) {
      // The rep you press Stop in is kept -- it is a measurement that happened
      // -- and it is not in the median. Nothing to close if the loop was already
      // resting when you stopped it.
      this.closeRep(rec, false);
      void this.finishDrill(rec, rec.loop);
      return;
    }
    this.capture = undefined;
    if (!events) {
      this.showCell();
      return;
    }
    void this.finish(rec, events, complete);
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
    const referenceMs = loaded.referenceMs;
    const result = grade(written, events, {
      calibrationMs,
      referenceMs,
      sameDrum: kitInput.same_drum,
    });
    this.result = result;

    this.heatmap.show(result, grid);
    this.reportRange = { startBar: cell.startBar, endBar: cell.endBar };
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
      referenceMs,
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

  // --- the drill --------------------------------------------------------------------

  /**
   * A sitting ends: score it, write it, and put the median rep on the staff.
   *
   * The median rather than the last or the best, because unlike a take a drill
   * is many attempts at once and the middle one is the honest description of
   * how it went (exercise.ts). Drawing the *median* rep's reading rather than
   * the last one is the same decision seen from the other side: the picture on
   * the notation and the number in the square should be the same rep.
   */
  private async finishDrill(rec: Recording, loop: NonNullable<Recording['loop']>) {
    this.releaseStems();
    const armed = this.armed;
    const loaded = this.loaded;
    if (!armed || !loaded) {
      this.showCell();
      return;
    }
    this.drawReps(loop.reps);
    const scored = scoreReps(loop.reps);
    if (!scored) {
      this.onStatus(
        'No rep reached the end, so there is nothing to score. The drill was not written.'
      );
      this.showCell();
      return;
    }
    this.showRep(scored.medianRep, loop.reps.length);

    const drill: Drill = {
      version: 1,
      exercise: armed.exercise.id,
      startedAt: rec.started,
      endedAt: new Date().toISOString(),
      source: {
        slug: armed.source.slug,
        ...(armed.source.section ? { section: armed.source.section } : {}),
        startBar: armed.source.startBar,
        endBar: armed.source.endBar,
      },
      tempo: armed.tempo,
      restBars: loop.restBars,
      backing: armed.exercise.backing,
      calibrationMs: this.calibration?.offsetMs ?? 0,
      calibrationNote: this.calibration?.note,
      referenceMs: loaded.referenceMs,
      chartHash: loaded.chartHash,
      accuracy: scored.accuracy,
      completeReps: scored.completeReps,
      timing: scored.timing,
      best: scored.best,
      worst: scored.worst,
      reps: loop.reps,
    };

    let written = '';
    try {
      written = await writeDrill(drill);
    } catch (err) {
      this.onStatus(`Drill not written: ${(err as Error).message}`, true);
    }
    // The ladder is read back off disk rather than patched in memory: the
    // square *is* the newest file, and a page that believed otherwise would be
    // the one thing that can disagree with the directory.
    if (written) this.onDrilled?.(armed.exercise.id);

    const pct = (v: number) => `${Math.round(v * 100)}%`;
    this.onStatus(
      [
        `${scored.completeReps} rep${scored.completeReps === 1 ? '' : 's'}, ${pct(scored.accuracy)}.`,
        scored.best === scored.worst
          ? 'Every one the same.'
          : `${pct(scored.worst)} to ${pct(scored.best)}.`,
        `Mean ${signed(scored.timing.meanMs)} ms, spread ±${scored.timing.sdMs} ms.`,
        written ? `Written to exercises/${armed.exercise.id}/drills/${written}.` : '',
      ]
        .filter(Boolean)
        .join(' ')
    );
    this.showCell();
  }

  /** Put one rep's reading on the staff and in the panel. */
  private showRep(n: number, of: number) {
    const result = this.repResults[n - 1];
    const grid = this.loaded?.grid;
    const source = this.armed?.source;
    if (!result || !grid || !source) return;
    this.result = result;
    this.heatmap.show(result, grid);
    this.reportRange = { startBar: source.startBar, endBar: source.endBar };
    this.drawReport(result, { rep: n, of });
    this.el.report.hidden = false;
  }

  /**
   * One chip per rep, in the order you played them.
   *
   * The only question a sitting really asks is whether it got better over the
   * twenty, and twenty numbers in a row answers it in one look where a single
   * median cannot. Clicking one puts that rep's reading on the staff.
   */
  private drawReps(reps: Rep[]) {
    const el = this.el.reps;
    el.replaceChildren();
    el.hidden = reps.length === 0;
    for (const rep of reps) {
      const chip = document.createElement('button');
      const accuracy = rep.grade.accuracy;
      chip.className = `rep ${!rep.complete ? 'part' : accuracy >= PASS ? 'pass' : 'fail'}`;
      chip.textContent = rep.complete ? `${Math.round(accuracy * 100)}%` : '–';
      chip.title = rep.complete
        ? `Rep ${rep.n}: ${rep.grade.hit}/${rep.grade.expected} notes · ±${rep.grade.timing.overall.sdMs} ms`
        : `Rep ${rep.n}: stopped part way, so it is not in the score`;
      chip.addEventListener('click', () => {
        if (this.recording) return;
        this.showRep(rep.n, reps.length);
        for (const other of el.querySelectorAll('.rep')) other.classList.remove('at');
        chip.classList.add('at');
      });
      el.appendChild(chip);
    }
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
      `Routine open: the whole song at ${ladder}%. It stays open until you seal it, over as ` +
        'many sittings as it takes. A stretch of bars you want to drill is an exercise, not a cell.'
    );
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
   * The grid: the whole song across the tempo ladder, and its four lines.
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
    // Folded away while a take is running. The grid is for choosing what to
    // play; once you are playing it, the thing that needs the room is the
    // notation, and a song with ten sections and a fill between each of them
    // has a tall grid.
    el.hidden = this.cells.length === 0 || !!this.recording;
    if (el.hidden) return;

    const table = document.createElement('table');
    table.className = 'grid';
    // The trend row appears only once there is something to plot: an empty row
    // on a song you have never finished a run of is a promise, not a reading.
    const runs = comparableRuns(this.history, spanOf(this.cells));
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

    // One row, because the routine is one thing played four times. The bars it
    // covers go in the row's own heading, where the section name used to be.
    const first = this.cells[0]!;
    const body = document.createElement('tbody');
    const tr = document.createElement('tr');
    tr.className = 'whole';
    const th = document.createElement('th');
    th.textContent = first.section;
    th.title = `bars ${first.startBar}-${first.endBar}`;
    tr.appendChild(th);
    for (const cell of this.cells) tr.appendChild(this.drawCell(cell, !!routine));
    body.appendChild(tr);

    // A line under each square rather than one at the end of the row: four
    // tempos are four separate questions, and a mean over 70% and 100% hides
    // whether the fast one is catching up (practice-plan Q14).
    if (runs.length) {
      const trends = document.createElement('tr');
      trends.className = 'trends';
      const label = document.createElement('th');
      label.className = 'trend-head';
      label.textContent = runs.length === 1 ? '1 run' : `${runs.length} runs`;
      label.title =
        'How each tempo has gone across your sealed runs, oldest on the left. ' +
        'Smoothed as a median of the last three, because the grid counts your last ' +
        'take and not your best -- so one lucky run should not look like progress ' +
        'and one bad one should not look like a collapse. The dotted line is ' +
        `${Math.round(PASS * 100)}%.`;
      trends.appendChild(label);
      for (const cell of this.cells) trends.appendChild(this.drawTrend(cell, runs));
      body.appendChild(trends);
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

  /**
   * One cell's line across the sealed runs.
   *
   * Accuracy, on a fixed 0-100% scale with the pass threshold drawn on it, so
   * that the four can be compared by eye -- a line that rescaled itself to its
   * own range would make every tempo look equally close to done.
   */
  private drawTrend(cell: RoutineCell, runs: Routine[]): HTMLTableCellElement {
    const td = document.createElement('td');
    td.className = 'trend';
    const smoothed = rollingMedian(cellSeries(runs, cell.id));
    const points = smoothed
      .map((value, i) => ({ value, i }))
      .filter((p): p is { value: number; i: number } => p.value !== undefined);
    if (points.length === 0) return td;

    // The width of a square, so the line sits exactly under the number it
    // belongs to rather than letterboxing inside it.
    const W = 54;
    const H = 18;
    const PAD = 2;
    const x = (i: number) => (runs.length < 2 ? W / 2 : PAD + (i / (runs.length - 1)) * (W - 2 * PAD));
    const y = (v: number) => H - PAD - Math.max(0, Math.min(1, v)) * (H - 2 * PAD);

    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));

    const mark = document.createElementNS(SVG, 'line');
    mark.setAttribute('x1', '0');
    mark.setAttribute('x2', String(W));
    mark.setAttribute('y1', String(y(PASS)));
    mark.setAttribute('y2', String(y(PASS)));
    mark.setAttribute('class', 'pass-line');
    svg.appendChild(mark);

    if (points.length > 1) {
      const line = document.createElementNS(SVG, 'polyline');
      line.setAttribute('points', points.map((p) => `${x(p.i)},${y(p.value)}`).join(' '));
      line.setAttribute('class', 'line');
      svg.appendChild(line);
    }
    const last = points[points.length - 1]!;
    const dot = document.createElementNS(SVG, 'circle');
    dot.setAttribute('cx', String(x(last.i)));
    dot.setAttribute('cy', String(y(last.value)));
    dot.setAttribute('r', '2.4');
    dot.setAttribute('class', 'dot');
    svg.appendChild(dot);

    td.classList.add(last.value >= PASS ? 'pass' : 'fail');
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const first = points[0]!;
    td.title =
      `${Math.round(cell.tempo * 100)}%: ${pct(first.value)} to ${pct(last.value)} over ` +
      `${runs.length} run${runs.length > 1 ? 's' : ''}` +
      (points.length > 1 && last.value > first.value
        ? ', going the right way.'
        : points.length > 1 && last.value < first.value
          ? ', going the wrong way.'
          : '.');
    td.appendChild(svg);
    return td;
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

  // --- the reading --------------------------------------------------------------------

  /**
   * What the take says, in the order you want to know it.
   *
   * Three dials, then a map of the bars, then the numbers folded away. What
   * this replaced put twenty-four numbers on the screen and never said whether
   * the take was good or what to go and play again -- all true, and unreadable.
   *
   * The rule: **each dial answers exactly one question, and they are never
   * blended into a single score.**
   *
   *   Notes   did you play the right things?   accuracy
   *   Steady  were you consistent?             spread
   *   Feel    where do you sit?                mean, against the record
   *
   * Mean and spread stay apart for the reason practice-plan Q7 gives:
   * consistently late is the audio path or the feel of the song, randomly late
   * is the playing, and one number averaging them would send you off to
   * practise a problem you do not have.
   */
  private drawReport(result: GradeResult, rep?: { rep: number; of: number }) {
    const g = result.grade;
    const el = this.el.report;
    el.replaceChildren();

    const dials = document.createElement('div');
    dials.className = 'dials';
    dials.append(
      dial({
        label: 'Notes',
        big: `${Math.round(g.accuracy * 100)}%`,
        // Which rep this is, because after a drill the staff shows one of many
        // and a reading that did not say which would be a reading of nothing.
        sub: rep ? `rep ${rep.rep} of ${rep.of}` : `${g.hit} of ${g.expected}`,
        tone: g.accuracy >= PASS ? 'good' : 'bad',
        title:
          `${g.hit} of ${g.expected} written notes landed on the right drum. ` +
          `${g.missed} missed, ${g.wrongVoice} on the wrong drum, ${g.extra} nobody wrote` +
          (g.flam ? `, ${g.flam} bounce${g.flam > 1 ? 's' : ''}` : '') +
          '. Extras are counted but never taken off this number.',
      }),
      dial({
        label: 'Steady',
        big: `±${g.timing.overall.sdMs} ms`,
        sub: steadiness(g.timing.overall.sdMs),
        tone: toneOf(g.timing.overall.sdMs),
        title:
          'How much your timing wandered over the take. This is the dial that is ' +
          'the playing: it is what practice actually moves, and no calibration can ' +
          'flatter it.',
      }),
      this.feelDial(g.timing.overall.meanMs)
    );
    el.appendChild(dials);

    const range = this.reportRange;
    if (range) el.appendChild(this.drawStrip(g, range));

    // The one actionable sentence, in words rather than as a ranked table.
    const worst = g.worstBars.filter((b) => b.wrong > 0 || b.rmsMs > LOOSE_MS).slice(0, 3);
    if (worst.length) {
      const p = document.createElement('p');
      p.className = 'again';
      const bars = worst.map((b) => String(b.bar));
      p.textContent = `Go again at bar${bars.length > 1 ? 's' : ''} ${list(bars)}.`;
      el.appendChild(p);
    }

    el.appendChild(drawDetails(g));
  }

  /** Where you sit, as a needle rather than a number you have to interpret. */
  private feelDial(meanMs: number): HTMLElement {
    const floor = this.loaded?.referenceMs ?? 0;
    const against = floor === 0 ? 'the written grid' : "the record's own feel";
    const node = dial({
      label: 'Feel',
      big: placement(meanMs),
      sub: `${signed(meanMs)} ms`,
      tone: toneOf(meanMs),
      title:
        `Where you sat against ${against}. ` +
        referenceNote(this.loaded?.reference, this.loaded?.chartHash ?? '') +
        ' A steady offset is the audio path or your feel, not your accuracy -- ' +
        'Steady is the dial to practise against.',
    });
    // A track with a centre mark and a marker on it. Clamped, because a wild
    // take should peg the needle rather than quietly rescale the dial.
    const track = document.createElement('span');
    track.className = 'needle';
    const mark = document.createElement('i');
    const at = Math.max(-1, Math.min(1, meanMs / NEEDLE_MS));
    mark.style.left = `${50 + at * 50}%`;
    track.appendChild(mark);
    node.insertBefore(track, node.querySelector('.sub'));
    return node;
  }

  /**
   * One block per bar of the cell: a map of where the take went wrong.
   *
   * Colour is accuracy, the same question the noteheads answer, because a strip
   * speaking a second colour vocabulary would be a second thing to learn. How
   * tight each bar was is in its tooltip, and clicking a block puts the cursor
   * on that bar so you can play it again straight away.
   */
  private drawStrip(g: Grade, range: { startBar: number; endBar: number }): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'strip';
    const byBar = new Map(g.bars.map((b) => [b.bar, b]));
    for (let bar = range.startBar; bar <= range.endBar; bar++) {
      const b = byBar.get(bar);
      // A bar with nothing written in it is neither good nor bad. Silent bars
      // are real here: a fill's cell starts with the empty bar before it.
      const empty = !b || (b.expected === 0 && b.wrong === 0);
      const accuracy = b && b.expected > 0 ? b.hit / b.expected : 1;
      const block = document.createElement('button');
      block.className = `bar ${
        empty ? 'none' : accuracy >= PASS && b.wrong === 0 ? 'good' : accuracy >= 0.5 ? 'ok' : 'bad'
      }`;
      block.textContent = String(bar);
      block.title = empty
        ? `Bar ${bar} -- nothing written here`
        : `Bar ${bar} -- ${b.hit}/${b.expected} notes` +
          (b.wrong ? `, ${b.wrong} wrong` : '') +
          (b.rmsMs ? ` · ±${b.rmsMs} ms` : '');
      block.addEventListener('click', () => this.seekToBar(bar));
      wrap.appendChild(block);
    }
    return wrap;
  }

  /** Put the cursor on a bar, the way the player's own arrow keys do. */
  private seekToBar(bar: number) {
    const bars = this.api.score?.masterBars ?? [];
    const target = bars[Math.max(0, Math.min(bars.length - 1, bar - 1))];
    if (target) this.api.tickPosition = target.start;
  }
}

/** The label, the number, and a word saying what the number means. */
function dial(spec: {
  label: string;
  big: string;
  sub: string;
  tone: Tone;
  title: string;
}): HTMLElement {
  const box = document.createElement('div');
  box.className = `dial ${spec.tone}`;
  box.title = spec.title;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = spec.label;
  const big = document.createElement('b');
  big.className = 'big';
  big.textContent = spec.big;
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = spec.sub;
  box.append(label, big, sub);
  return box;
}

/** The numbers the dials summarise, for the days you want them. Shut by default. */
function drawDetails(g: Grade): HTMLElement {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'the numbers';
  details.appendChild(summary);

  const table = document.createElement('table');
  table.appendChild(row('th', ['Limb', 'Notes', 'Mean', 'Spread', 'Median', 'Worst']));
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
  details.appendChild(table);

  const notes: string[] = [];
  // Not a mistake, but not nothing either: a groove full of these usually means
  // the module's hi-hat threshold is not where your foot thinks it is.
  if (g.sameDrum > 0) {
    notes.push(
      `${g.sameDrum} hit${g.sameDrum > 1 ? 's' : ''} landed on the same drum in its other ` +
        'state (an open hat where a closed one is written). Counted as hits.'
    );
  }
  if (g.unmappedNotes.length) {
    notes.push(
      `Unmapped module notes: ${g.unmappedNotes.join(', ')} (add them to kit.toml [input.note]).`
    );
  }
  for (const text of notes) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = text;
    details.appendChild(p);
  }
  return details;
}

type Tone = 'good' | 'ok' | 'bad';

/**
 * Milliseconds to a verdict.
 *
 * Two thresholds, used for both spread and offset, because the ear does not
 * have separate opinions about them: inside `TIGHT_MS` nobody hears it, beyond
 * `LOOSE_MS` everybody does.
 */
const toneOf = (ms: number): Tone =>
  Math.abs(ms) <= TIGHT_MS ? 'good' : Math.abs(ms) <= LOOSE_MS ? 'ok' : 'bad';

/** A word for a spread, so the dial reads without knowing what 14 ms means. */
function steadiness(sdMs: number): string {
  if (sdMs <= 8) return 'rock solid';
  if (sdMs <= TIGHT_MS) return 'tight';
  if (sdMs <= LOOSE_MS) return 'a bit loose';
  return 'all over';
}

/** A word for an offset. Sign matters, so it is never dropped or abs()ed away. */
function placement(meanMs: number): string {
  if (Math.abs(meanMs) <= TIGHT_MS) return 'right on it';
  const late = meanMs > 0;
  if (Math.abs(meanMs) <= LOOSE_MS) return late ? 'a touch behind' : 'a touch ahead';
  return late ? 'dragging' : 'rushing';
}

/** `18`, `18 and 20`, `18, 20 and 22`. */
const list = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

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
  sticking: StickingLock | undefined,
  reference: ReferenceLock | undefined
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
    reference,
    // Same rule, same reason: a floor measured against notation you have since
    // edited is not this song's floor any more (reference.ts).
    referenceMs: floorOf(reference, hash),
  };
}

export type { ExpectedNote };
