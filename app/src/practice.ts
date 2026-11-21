// Practice mode: play the song on the kit, get marked on it.
//
// MIDI in, a calibration ritual, a take on disk, a grade, and the grade drawn
// on the staff. What Record plays is whatever the page is aimed at:
//
//   - with the loop off, the whole song at the tempo set -- a bar of count-in,
//     then the record from bar 1 to the end, marked when it stops;
//   - with the loop on, the loop (loop.ts), marked one pass at a time. Every
//     pass is a take of its own, written as it ends, and the reading card in
//     the header shows the one just played.
//
// The kit layer is only on the page while a kit is connected (Lamp-12): the
// chip in the corner, the Record pill in the controls row, and after a pass or
// a song, the reading card. With no kit none of it is there at all.
//
// Either way every stroke is stamped in mix time and the take format is the
// same one (take.ts). There used to be two more layers on top of this -- a
// routine and exercises -- removed on 2026-11-21; see README.
import type * as alphaTab from '@coderline/alphatab';
import type { SongMeta } from 'virtual:songs';
import kitInput from 'virtual:kit';
import { chartHash, expectedNotes, readChart, type ChartHit, type ExpectedNote, type Limb } from './chart';
import {
  calibrate,
  loadCalibration,
  saveCalibration,
  type Calibration,
  type CalibrationRun,
} from './calibrate';
import { countIn, type CountIn } from './click';
import { grade, type Grade, type GradeResult, type TakeEvent, type Timing } from './grade';
import { Heatmap } from './heatmap';
import type { PlayClock } from './clock';
import { EDGE_MS, type Grader, type Loop, type LoopRange } from './loop';
import { MidiIn, type MidiHit } from './midi-in';
import type { Mixer } from './mixer';
import { referenceMs as floorOf, referenceNote, type ReferenceLock } from './reference';
import type { StickingLock } from './sticking';
import { writeTake, type Take } from './take';
import { barStartMs, type Grid } from './syncpoints';

/** Bars of click before the take starts. Not recorded, not graded. */
const COUNT_IN_BARS = 1;
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
/** How many hits the monitor keeps on screen. */
const MONITOR = 14;

const LIMB_NAMES: Record<Limb, string> = {
  right_hand: 'Right hand',
  left_hand: 'Left hand',
  right_foot: 'Right foot (kick)',
  left_foot: 'Left foot (hats)',
  hands: 'Hands',
};

/** What a take covers: the bars, and the words for them. */
interface Target {
  startBar: number;
  endBar: number;
  label: string;
}

/** A take in progress. */
interface Run {
  startMs: number;
  endMs: number;
  startBar: number;
  endBar: number;
  /** Playback rate it is played at: 1 is the record's tempo. */
  tempo: number;
  started: string;
}

/** One pass of a loop, marked. */
interface Pass {
  n: number;
  /** Whether it reached the end of the range. */
  complete: boolean;
  startedAt: string;
  /** Playback rate it was played at. A ramp changes it between passes. */
  tempo: number;
  result: GradeResult;
}

/**
 * A loop being marked: everything the passes share, fixed when Record was
 * pressed so that a re-save in Live or a song change cannot pull it from under
 * a pass that is still being written.
 */
interface LoopTake {
  song: PracticeSong;
  range: LoopRange;
  /** What `cell.section` says: the section's name, or `bars 12-14`. */
  section: string;
  /** The notes the range asks for. The same every pass: every pass is the same ms of the record. */
  written: ExpectedNote[];
  passes: Pass[];
  /** When the pass under way started, and how fast. */
  startedAt: string;
  tempo: number;
}

export interface PracticeSong {
  song: SongMeta;
  grid: Grid | undefined;
  hits: ChartHit[];
  chartHash: string;
  /** Which limb plays what, when it was solved against this chart. */
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
  /** Settings' Kit: asks the browser for MIDI. Hidden once it has it. */
  enable: HTMLButtonElement;
  /** The connection line: a dot (`data-state` on, off or err) and a sentence. */
  kitState: HTMLElement;
  port: HTMLSelectElement;
  calibrate: HTMLButtonElement;
  calibration: HTMLOutputElement;
  /** The Record pill in the controls row: there only while the kit is connected. */
  record: HTMLButtonElement;
  /** Its word: Record, or Recording. */
  recordWord: HTMLElement;
  /** The kit chip in the header's corner (Lamp-12): a dot and a few words. */
  chip: HTMLElement;
  chipSays: HTMLElement;
  /** The reading card in the header (Lamp-12), built here. */
  card: HTMLElement;
  /**
   * Where the page is told: `data-kit` while a kit is connected,
   * `data-recording` while Record has the transport, `data-reading` while the
   * card is up. The stylesheet lays the header out from them.
   */
  app: HTMLElement;
  /** Settings' Kit: "Show the last few hits", and the hits. */
  monitorOn: HTMLInputElement;
  monitor: HTMLElement;
  /** The kit, a recording or the card came or went: the header is painted and fitted again. */
  relaid: () => void;
  /**
   * Make the Click channel heard -- unmuted, and up if it was at 0 -- through
   * the page's one mix setter, so the panel, the mixer and the remembered
   * levels stay in step. True if it had to do anything. The ritual needs it.
   */
  clickAudible: () => boolean;
}

export class Practice {
  readonly midi: MidiIn;
  private readonly heatmap: Heatmap;
  private loaded: PracticeSong | undefined;
  private calibration: Calibration | undefined;
  private running: CalibrationRun | undefined;
  /**
   * Recording: the hits landing in the take, or in the pass of a loop under
   * way. Unset through a count-in and between passes.
   */
  private capture: TakeEvent[] | undefined;
  private run: Run | undefined;
  /** The loop being marked, while Record has it going round. */
  private loopTake: LoopTake | undefined;
  private timer = 0;
  private counting: CountIn | undefined;
  private recent: MidiHit[] = [];
  /** The last graded take, for the headless check and the console. */
  result: GradeResult | undefined;
  /** The reading on the card, while it is up. */
  private reading: Reading | undefined;
  private readonly cardEl: CardParts;

  constructor(
    private readonly api: alphaTab.AlphaTabApi,
    private readonly clock: PlayClock,
    private readonly mixer: Mixer,
    /** The loop on the song page: what Record marks pass by pass when it is on. */
    private readonly loop: Loop,
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
    el.record.addEventListener('click', (e) => {
      this.toggleRecord();
      if (e.detail > 0) el.record.blur();
    });
    el.monitorOn.addEventListener('change', () => {
      el.monitor.hidden = !el.monitorOn.checked;
      this.drawMonitor();
    });
    this.cardEl = buildCard(el.card, () => this.dismiss());

    void this.reloadCalibration();
    void this.reconnect();
  }

  /**
   * Connect without a click when the browser has already been told yes.
   * Chrome asks once per site and remembers, so after the first Connect the
   * kit is there whenever the page is. A refusal here is said nowhere: it is
   * only the page trying, and Settings' Connect is the way to ask out loud.
   */
  private async reconnect() {
    try {
      const status = await navigator.permissions?.query({ name: 'midi' as PermissionName });
      if (status?.state !== 'granted') return;
      await this.midi.start();
    } catch {
      /* no Permissions API, or no Web MIDI: Settings' Connect says why */
    }
    this.showPorts();
  }

  /**
   * The paper changed theme. The report is drawn from CSS variables and
   * re-themes by itself, but the heatmap bakes the --verdict-* colours into a
   * render, so a take already on the staff is drawn again in the new ones.
   */
  retheme() {
    const grid = this.loaded?.grid;
    if (this.result && grid) this.heatmap.show(this.result, grid);
  }

  /** Point practice mode at the song the player just loaded. */
  load(loaded: PracticeSong) {
    this.stopRun(false);
    // The score these marks were drawn on is about to be replaced, so there is
    // nothing to repaint -- and a repaint of the old score here would finish
    // after the new one had started, and read as the new song being drawn.
    this.heatmap.forget();
    this.result = undefined;
    this.hideCard();
    this.loaded = loaded;
    this.showTarget();
    // The kit gets the whole part up front: this is what the Kit fader plays.
    this.mixer.loadKit(this.wholeSong());
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
    this.el.enable.hidden = state.kind === 'ready';
    const open = ports.find((p) => p.open);
    const [dot, says] =
      state.kind === 'unsupported'
        ? ['err', 'This browser cannot read a kit: it has no Web MIDI (Chrome or Edge can).']
        : state.kind === 'denied'
          ? ['err', `The browser refused MIDI: ${state.message}`]
          : state.kind === 'idle'
            ? ['off', 'No kit connected']
            : open
              ? ['on', `${open.name} connected`]
              : ['off', 'No kit connected: is it on, and plugged in?'];
    this.el.kitState.dataset.state = dot;
    this.el.kitState.lastChild!.textContent = says;
    this.showTarget();
  }

  /** Whether a kit is connected: a port open, or (for the checks) strokes injected. */
  get connected(): boolean {
    return this.midi.hasSource;
  }

  /**
   * The kit layer on the page, or not: the chip, the Record pill, the card.
   * With no kit nothing of it is there at all -- not a disabled pill, not an
   * empty chip -- because most sessions are free playing and it would only be
   * one more thing to read past.
   */
  private paintKit() {
    const on = this.connected;
    const recording = !!this.run || !!this.loopTake;
    const was = this.el.app.hasAttribute('data-kit');
    const wasRecording = this.el.app.hasAttribute('data-recording');
    this.el.app.toggleAttribute('data-kit', on);
    this.el.app.toggleAttribute('data-recording', recording);
    this.el.chip.hidden = !on;
    this.el.chipSays.textContent = `Kit connected · ${this.calibration ? 'calibrated' : 'not calibrated'}`;
    // A take under way keeps its way out, whatever the cable does.
    this.el.record.hidden = !on && !recording;
    if (!on && !recording && this.reading) this.hideCard();
    if (was !== on || wasRecording !== recording) this.el.relaid();
  }

  private onHit(hit: MidiHit) {
    this.recent.push(hit);
    if (this.recent.length > MONITOR) this.recent.shift();
    this.drawMonitor();
    // A stroke arriving is itself news: it means there is something to record
    // from, which `showPorts` cannot know before the first one lands.
    if (!this.el.app.hasAttribute('data-kit') || this.el.record.disabled) this.showTarget();
    const take = this.capture;
    if (!take) return;
    // Raw, uncorrected, and the module's own note number: the take stores the
    // measurement, and the grade is a reading of it (practice-plan Q8).
    const stroke = { note: hit.note, velocity: hit.velocity, instrument: hit.instrument };
    if (this.loopTake) {
      // The loop knows where its pass is -- including the moment after the end,
      // when the transport is parked and cannot stamp anything.
      const tMs = this.loop.placeStroke(hit.wallMs, hit.tMs);
      if (tMs !== undefined) take.push({ tMs, ...stroke });
      return;
    }
    const rec = this.run;
    if (!rec) return;
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
    this.el.calibration.textContent = note ?? calibrationSaid(c);
    if (note === undefined) this.el.calibrate.textContent = c ? 'Calibrate again' : 'Calibrate';
    this.paintKit();
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
    const raised = this.el.clickAudible() ? 'Turned the click on. ' : '';
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
      this.showCalibration();
      this.showTarget();
    }
  }

  // --- the take -------------------------------------------------------------------

  /**
   * What Record plays: the loop when it is on, else the whole song, as far as
   * the beat map can place it.
   *
   * Bar 1 to the last bar of the sections when there are any -- they are the
   * song as you named it -- else to the end of the beat map. Either way it is
   * cut back to the last bar the beat map has an end for: a take ends where
   * the bar after its last bar begins, and a chart that runs a bar past the
   * beat map (Song 2's last crash, One For The Road's 73 bars against 72) would
   * otherwise refuse to record at all. The loop holds itself to the same rule
   * (loop.ts `checkRange`).
   */
  private target(): Target | undefined {
    const loaded = this.loaded;
    const grid = loaded?.grid;
    if (!loaded || !grid) return undefined;
    const looped = this.loop.armed ? this.loop.range : undefined;
    if (looped) return { ...looped, label: this.loop.describe() };
    const sections = loaded.song.sections;
    let endBar = sections.length ? Math.max(...sections.map((s) => s.end_bar)) : grid.bar_count;
    endBar = Math.min(endBar, grid.bar_count);
    while (endBar > 1 && barStartMs(grid, endBar) === undefined) endBar--;
    if (endBar < 1 || barStartMs(grid, endBar) === undefined) return undefined;
    return { startBar: 1, endBar, label: `whole song · bars 1-${endBar}` };
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

  /** The calibration ritual while it is running, or nothing. */
  get calibrating(): CalibrationRun | undefined {
    return this.running;
  }

  /**
   * Whether practice mode has the transport to itself: a whole-song take, or
   * the calibration. A marked loop is the loop's, and the loop knows it is
   * going round.
   */
  get busy(): boolean {
    return !!this.run || !!this.running;
  }

  /** The loop was turned on or off, or went round or stopped: what Record offers changes. */
  refresh() {
    this.showTarget();
  }

  /** The notes a take is marked against, placed in the mix. */
  expected(): ExpectedNote[] {
    const loaded = this.loaded;
    const at = this.target();
    if (!loaded?.grid || !at) return [];
    return expectedNotes(
      loaded.hits,
      loaded.grid,
      { start: at.startBar, end: at.endBar },
      loaded.sticking
    );
  }

  /** Every note in the song, for the kit to sound under whatever is playing. */
  wholeSong(): ExpectedNote[] {
    const loaded = this.loaded;
    if (!loaded?.grid) return [];
    return expectedNotes(
      loaded.hits,
      loaded.grid,
      { start: 1, end: Number.POSITIVE_INFINITY },
      loaded.sticking
    );
  }

  private showTarget() {
    const at = this.target();
    const looped = this.loop.armed;
    const recording = !!this.run || !!this.loopTake;
    const ready = !!at && !this.running && this.midi.hasSource && import.meta.env.DEV;
    this.el.record.disabled = !recording && !ready;
    this.el.record.setAttribute('aria-pressed', String(recording));
    this.el.recordWord.textContent = recording ? 'Recording' : 'Record';
    // Calibrating needs something sending strokes and nothing else running --
    // not a song, which is the point: the click it measures against is its own.
    if (!this.running) {
      this.el.calibrate.disabled = !this.midi.hasSource || recording || this.loop.running;
    }
    // What it will play, or why it cannot: the tooltip, and the screen reader.
    this.el.record.title = recording
      ? 'Recording: press to stop'
      : !import.meta.env.DEV
        ? 'Recording needs the dev server (npm run dev)'
        : !at
          ? 'No grid.lock.json: nothing can be placed in the mix'
          : looped
            ? `Record every pass of the loop (${at.label}), and be marked on each`
            : `Record the whole song (${at.label}) at the tempo set, and be marked on it`;
    this.paintKit();
  }

  /** What Record will play, in words: `whole song · bars 1-62`, or the loop's. */
  get plan(): string {
    const at = this.target();
    return at ? (this.loop.armed ? `${at.label}, every pass` : at.label) : 'no beat map';
  }

  /**
   * Record, and pressed again, stop. A loop already going round is started
   * again from its count-in with every pass marked: pressing Record means "from
   * now on, mark me", and the pass under way had no start to mark from.
   */
  private toggleRecord() {
    if (this.loopTake) this.loop.stop();
    else if (this.run) this.stopRun(false);
    else if (this.loop.armed) {
      if (this.loop.running) this.loop.stop(true);
      this.startLoop();
    } else this.startRun();
  }

  private startRun() {
    const loaded = this.loaded;
    const at = this.target();
    if (!loaded?.grid || !at) return;
    const grid = loaded.grid;
    const startMs = barStartMs(grid, at.startBar - 1);
    // The range ends where the bar after its last bar begins.
    const endMs = barStartMs(grid, at.endBar);
    if (startMs === undefined || endMs === undefined) {
      this.onStatus('The beat map does not cover those bars.', true);
      return;
    }

    this.clearReading();
    // `capture` stays unset until the music actually starts: the transport is
    // parked on the first beat through the count-in, so a stroke played over
    // the count-in would otherwise be stamped exactly on that beat and
    // recorded as a very good hit.
    this.capture = undefined;
    // The tempo is whatever the page is set to. alphaTab's own setting rather
    // than the media element's rate: it is the one the slider writes.
    const tempo = this.api.playbackSpeed || 1;
    const rec: Run = {
      startMs,
      endMs,
      startBar: at.startBar,
      endBar: at.endBar,
      tempo,
      started: new Date().toISOString(),
    };
    this.run = rec;

    this.mixer.ensureGraph();
    this.api.pause();
    this.clock.seekTo(startMs);
    this.showTarget();
    // Nothing on the status line: the header shows the count-in ("count-in ·
    // then verse, bar 1, recording") and the pill says Recording.
    this.onStatus('');

    // One bar of clicks, then the music, starting exactly on bar 1. A count-in
    // rather than a bar of the record itself, because bar 1 has no bar before
    // it to play -- and because the clicks give you the tempo, which the
    // run-up only implies. In the take's tempo, not the record's: four clicks
    // at 100% would hand you the wrong speed to start a 70% take in.
    const perBar = grid.meter.beats_per_bar;
    const barMs = (barStartMs(grid, at.startBar) ?? startMs + 2000) - startMs;
    const beatS = barMs / perBar / 1000 / tempo;
    const ctx = this.mixer.ctx;
    const out = this.mixer.countInOut();
    const counting = ctx && out ? countIn(ctx, out, beatS, perBar * COUNT_IN_BARS) : undefined;
    this.counting = counting;
    void (counting?.done ?? Promise.resolve(true)).then((go) => {
      if (!go || this.run !== rec) return; // stopped during the count-in
      this.counting = undefined;
      this.capture = [];
      this.api.play();
      clearInterval(this.timer);
      this.timer = window.setInterval(() => this.tick(), 25);
    });
  }

  /** The only place the transport is watched: the end of the take. */
  private tick() {
    const rec = this.run;
    if (rec && this.clock.mixTimeMs >= rec.endMs) this.stopRun(true);
  }

  private stopRun(complete: boolean) {
    clearInterval(this.timer);
    this.counting?.cancel();
    this.counting = undefined;
    this.timer = 0;
    const rec = this.run;
    const events = this.capture;
    this.run = undefined;
    this.capture = undefined;
    if (rec) this.api.pause();
    // Nothing captured means it was stopped during the count-in: nothing was
    // played, so there is nothing to write.
    if (rec && events) void this.finish(rec, events, complete);
    this.showTarget();
    this.paintCardRec();
  }

  /** Nothing on the staff, no reading: a new take is about to start. */
  private clearReading() {
    this.heatmap.clear();
    this.result = undefined;
    this.hideCard();
  }

  // --- a loop, marked pass by pass ----------------------------------------------

  /**
   * Record with the loop on: the loop goes round as it would on Play, and each
   * pass is marked and written as a take of its own when it ends.
   *
   * One take per pass rather than one file for the sitting, because the take
   * format already says everything a pass is -- which bars, how fast, the raw
   * strokes, the grade -- and a pass is the thing that happened. A loop going
   * round for an hour is that many files, each one a measurement.
   */
  private startLoop() {
    const loaded = this.loaded;
    const range = this.loop.range;
    if (!loaded?.grid || !range) return;
    this.clearReading();
    this.capture = undefined;
    const take: LoopTake = {
      song: loaded,
      range,
      section: this.loop.name(),
      written: expectedNotes(
        loaded.hits,
        loaded.grid,
        { start: range.startBar, end: range.endBar },
        loaded.sticking
      ),
      passes: [],
      startedAt: '',
      tempo: 1,
    };
    const grader: Grader = {
      open: () => {
        take.startedAt = new Date().toISOString();
        take.tempo = this.api.playbackSpeed || 1;
        this.capture = [];
      },
      close: (n, complete) => this.closePass(take, n, complete),
      done: () => this.finishLoop(take),
    };
    this.loopTake = take;
    if (!this.loop.start(grader)) {
      this.loopTake = undefined;
      return;
    }
    this.showTarget();
  }

  /**
   * A pass is over: mark it, show it, write it. Returns its accuracy when it
   * reached its end, which is what a ramp waiting for a good pass steps on.
   */
  private closePass(take: LoopTake, n: number, complete: boolean): number | undefined {
    const events = this.capture;
    this.capture = undefined;
    if (!events) return undefined;
    const song = take.song;
    const calibrationMs = this.calibration?.offsetMs ?? 0;
    const result = grade(take.written, events, {
      calibrationMs,
      referenceMs: song.referenceMs,
      sameDrum: kitInput.same_drum,
    });
    const pass: Pass = { n, complete, startedAt: take.startedAt, tempo: take.tempo, result };
    take.passes.push(pass);

    // The card follows the passes as they go: it is the page, not the
    // notation. The noteheads wait until the loop stops, because colouring
    // them re-engraves the score -- a stall in the cursor, and a late start to
    // the next pass when the turn-round is only a grace window long.
    this.result = result;
    this.showCard({
      result,
      range: take.range,
      title: complete ? `Pass ${n}, just played` : `Pass ${n}, stopped part way`,
    });

    const record: Take = {
      version: 1,
      cell: {
        section: take.section,
        tempo: pass.tempo,
        startBar: take.range.startBar,
        endBar: take.range.endBar,
      },
      startedAt: pass.startedAt,
      calibrationMs,
      calibrationNote: this.calibration?.note,
      referenceMs: song.referenceMs,
      chartHash: song.chartHash,
      sectionsHash: song.song.sectionsHash,
      complete,
      events,
      grade: result.grade,
    };
    writeTake(song.song.slug, record).catch((err: Error) =>
      this.onStatus(`Pass ${n} not written: ${err.message}`, true)
    );
    return complete ? result.grade.accuracy : undefined;
  }

  /**
   * The loop stopped: Record is Record again, and the noteheads can be
   * coloured -- by the last pass that reached its end, which is the one the
   * card shows from now on. A pass stopped part way is written to takes/ but
   * not shown: its unplayed half would read as a page of misses.
   */
  private finishLoop(take: LoopTake) {
    if (this.loopTake !== take) return;
    this.loopTake = undefined;
    this.capture = undefined;
    const shown = [...take.passes].reverse().find((p) => p.complete) ?? take.passes.at(-1);
    const grid = take.song.grid;
    if (shown && grid && this.loaded === take.song) {
      const last = shown === take.passes.at(-1);
      this.result = shown.result;
      this.heatmap.show(shown.result, grid);
      this.showCard({
        result: shown.result,
        range: take.range,
        title: !shown.complete
          ? `Pass ${shown.n}, stopped part way`
          : last
            ? `Pass ${shown.n}, just played`
            : `Pass ${shown.n}, the last one played through`,
      });
    }
    const partial = take.passes.length > 0 && !take.passes.some((p) => p.complete);
    this.onStatus(partial ? 'No pass reached its end: the one you stopped is written to takes/ as unfinished.' : '');
    this.showTarget();
    this.paintCardRec();
  }

  private async finish(rec: Run, events: TakeEvent[], complete: boolean) {
    const loaded = this.loaded!;
    const song = loaded.song;
    const grid = loaded.grid!;
    const written = expectedNotes(
      loaded.hits,
      grid,
      { start: rec.startBar, end: rec.endBar },
      loaded.sticking
    );
    const calibrationMs = this.calibration?.offsetMs ?? 0;
    const referenceMs = loaded.referenceMs;
    const result = grade(written, events, {
      calibrationMs,
      referenceMs,
      sameDrum: kitInput.same_drum,
    });
    this.result = result;

    this.heatmap.show(result, grid);
    this.showCard({
      result,
      range: { startBar: rec.startBar, endBar: rec.endBar },
      title: complete ? 'Whole song, just played' : 'Whole song, stopped part way',
    });

    const take: Take = {
      version: 1,
      cell: {
        section: 'whole song',
        tempo: rec.tempo,
        startBar: rec.startBar,
        endBar: rec.endBar,
      },
      startedAt: rec.started,
      calibrationMs,
      calibrationNote: this.calibration?.note,
      referenceMs,
      chartHash: loaded.chartHash,
      sectionsHash: song.sectionsHash,
      complete,
      events,
      grade: result.grade,
    };

    let name = '';
    try {
      name = await writeTake(song.slug, take);
    } catch (err) {
      this.onStatus(`Take not written: ${(err as Error).message}`, true);
      return;
    }

    const g = result.grade;
    console.info(
      `[drums] take ${name}: ${g.hit}/${g.expected} notes, ${g.missed} missed, ${g.extra} extra; ` +
        `mean ${signed(g.timing.overall.meanMs)} ms, spread ±${g.timing.overall.sdMs} ms`
    );
    // The status line only for what the card cannot say: something to do
    // outside the page.
    const drift = this.calibration ? Math.abs(g.timing.overall.meanMs) : 0;
    this.onStatus(
      [
        // Q9: a mean that has walked away from the stored calibration usually
        // means the audio path changed, not that you started rushing.
        drift > DRIFT_MS
          ? `The timing has drifted ${Math.round(drift)} ms from the calibration: worth calibrating again (Settings › Kit).`
          : '',
        g.unmappedNotes.length
          ? `The kit sent notes ${g.unmappedNotes.join(', ')}, which kit.toml [input.note] does not name.`
          : '',
      ]
        .filter(Boolean)
        .join(' ')
    );
  }

  // --- the reading card ----------------------------------------------------------------

  /** Whether the card is up and can be put away (Esc, or its close): not while recording. */
  get dismissible(): boolean {
    return !!this.reading && !this.run && !this.loopTake;
  }

  /** Put the reading away: the card, and the colours on the noteheads with it. */
  dismiss() {
    if (!this.dismissible) return;
    this.heatmap.clear();
    this.result = undefined;
    this.hideCard();
  }

  private hideCard() {
    const was = !!this.reading;
    this.reading = undefined;
    this.el.card.hidden = true;
    this.el.app.removeAttribute('data-reading');
    if (was) this.el.relaid();
  }

  /**
   * What the take says, in the order you want to know it (Lamp-12).
   *
   * Three readings, then a map of the bars, then one sentence. What this
   * replaced put twenty-four numbers on the screen and never said whether the
   * take was good or what to go and play again -- all true, and unreadable.
   * The numbers behind it are in the card's tooltip and the console.
   *
   * The rule: **each reading answers exactly one question, and they are never
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
  private showCard(reading: Reading) {
    const was = !!this.reading;
    this.reading = reading;
    const { result, range, title } = reading;
    const g = result.grade;
    const c = this.cardEl;
    this.el.card.setAttribute('aria-label', `The reading: ${title}`);
    c.title.textContent = title;

    // Down, never up: 99.6% with a note missed is not 100%.
    c.notes.textContent = `${Math.floor(g.accuracy * 100)}%`;
    c.notesBox.title =
      `${g.hit} of ${g.expected} written notes landed on the right drum. ` +
      `${g.missed} missed, ${g.wrongVoice} on the wrong drum, ${g.extra} nobody wrote` +
      (g.flam ? `, ${g.flam} bounce${g.flam > 1 ? 's' : ''}` : '') +
      '. Extras are counted but never taken off this number.';

    const sd = g.timing.overall.sdMs;
    c.steady.textContent = steadiness(sd);
    c.steadySub.textContent = `±${sd} ms`;
    c.steadyBox.title =
      'How much your timing wandered over the take. This is the reading that is the playing: ' +
      'it is what practice actually moves, and no calibration can flatter it.';

    const mean = g.timing.overall.meanMs;
    c.feel.textContent = placement(mean);
    // Clamped, because a wild take should peg the needle rather than quietly
    // rescale the dial. Ahead on the left, behind on the right.
    const at = Math.max(-1, Math.min(1, mean / NEEDLE_MS));
    c.needle.style.left = `${50 + at * 50}%`;
    const floor = this.loaded?.referenceMs ?? 0;
    c.feelBox.setAttribute(
      'aria-label',
      `Feel: ${placement(mean)}, ${Math.abs(mean)} ms ${mean > 0 ? 'behind' : mean < 0 ? 'ahead of' : 'on'} the record`
    );
    c.feelBox.title =
      `${signed(mean)} ms against ${floor === 0 ? 'the written grid' : "the record's own feel"}. ` +
      referenceNote(this.loaded?.reference, this.loaded?.chartHash ?? '') +
      ' A steady offset is the audio path or your feel, not your accuracy -- Steady is the one to practise against.';

    this.drawStrip(g, range);

    // The one thing to do next, in words rather than as a ranked table.
    const worst = g.worstBars
      .filter((b) => b.wrong > 0 || b.rmsMs > LOOSE_MS)
      .slice(0, 3)
      .map((b) => b.bar)
      .sort((a, b) => a - b);
    c.again.textContent = worst.length
      ? `Go again at bar${worst.length > 1 ? 's' : ''} ${list(worst.map(String))}.`
      : 'Every bar as written.';

    this.el.card.title = numbersSaid(g);
    this.el.card.hidden = false;
    this.el.app.setAttribute('data-reading', 'on');
    this.paintCardRec();
    // The words were fitted to their room at the size they were drawn in.
    for (const big of [c.steady, c.feel]) fitWord(big);
    if (!was) this.el.relaid();
  }

  /** "recording" on the card while the loop is still going round; the close once it is not. */
  private paintCardRec() {
    const recording = !!this.run || !!this.loopTake;
    this.cardEl.rec.hidden = !recording;
    this.cardEl.close.hidden = recording;
  }

  /**
   * One block per bar of the take: a map of where it went wrong.
   *
   * In the noteheads' own two colours, played and missed, because a strip
   * speaking a second colour vocabulary would be a second thing to learn. A
   * bar is played when every note in it landed on the right drum and nothing
   * else was struck; how tight it was is in its tooltip. Clicking a block puts
   * the cursor on that bar so you can play it again straight away. A whole
   * song is too many bars for numbers, so its blocks close up into a strip
   * without them (`data-dense`) and the sentence names the bars.
   */
  private drawStrip(g: Grade, range: { startBar: number; endBar: number }) {
    const wrap = this.cardEl.strip;
    wrap.replaceChildren();
    const byBar = new Map(g.bars.map((b) => [b.bar, b]));
    const n = range.endBar - range.startBar + 1;
    wrap.style.setProperty('--bars', String(n));
    wrap.toggleAttribute('data-dense', n > 16);
    for (let bar = range.startBar; bar <= range.endBar; bar++) {
      const b = byBar.get(bar);
      // A bar with nothing written in it and nothing struck is neither.
      const empty = !b || (b.expected === 0 && b.wrong === 0);
      const block = document.createElement('button');
      block.className = 'rd-bar';
      block.dataset.verdict = empty ? 'none' : b.hit === b.expected && b.wrong === 0 ? 'played' : 'missed';
      block.textContent = String(bar);
      block.title = empty
        ? `Bar ${bar}: nothing written here`
        : `Bar ${bar}: ${b.hit} of ${b.expected} notes` +
          (b.wrong ? `, ${b.wrong} wrong` : '') +
          (b.rmsMs ? ` · ±${b.rmsMs} ms` : '');
      block.addEventListener('click', (e) => {
        this.seekToBar(bar);
        if (e.detail > 0) block.blur();
      });
      wrap.appendChild(block);
    }
  }

  /** Put the cursor on a bar, the way the player's own arrow keys do. */
  private seekToBar(bar: number) {
    const bars = this.api.score?.masterBars ?? [];
    const target = bars[Math.max(0, Math.min(bars.length - 1, bar - 1))];
    if (target) this.api.tickPosition = target.start;
  }
}

/** A take's reading, as the card shows it. */
interface Reading {
  result: GradeResult;
  range: { startBar: number; endBar: number };
  /** "Pass 2, just played", "Whole song, just played". */
  title: string;
}

/** The card's parts, built once (`buildCard`) and filled on every reading. */
interface CardParts {
  title: HTMLElement;
  rec: HTMLElement;
  close: HTMLButtonElement;
  notesBox: HTMLElement;
  notes: HTMLElement;
  steadyBox: HTMLElement;
  steady: HTMLElement;
  steadySub: HTMLElement;
  feelBox: HTMLElement;
  feel: HTMLElement;
  needle: HTMLElement;
  strip: HTMLElement;
  again: HTMLElement;
}

/**
 * The reading card's insides (Lamp-12): "Pass 2, just played", the three
 * readings, the bar strip, the sentence.
 */
function buildCard(card: HTMLElement, onClose: () => void): CardParts {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = '') => {
    const el = document.createElement(tag);
    el.className = cls;
    if (text) el.textContent = text;
    return el;
  };
  const head = make('div', 'rd-head');
  const title = make('span', 'rd-title');
  const rec = make('span', 'rd-rec');
  rec.append(make('i', 'rd-dot'), 'recording');
  const close = make('button', 'rd-close');
  close.setAttribute('aria-label', 'Put the reading away (Esc)');
  close.title = 'Put the reading away (Esc)';
  close.innerHTML =
    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  close.addEventListener('click', onClose);
  head.append(title, rec, close);

  const reading = (label: string) => {
    const box = make('div', 'rd-dial');
    const big = make('b', 'rd-big');
    box.append(make('span', 'rd-label', label), big);
    return { box, big };
  };
  const notes = reading('Notes');
  notes.box.append(make('span', 'rd-sub', "of what's written"));
  const steady = reading('Steady');
  const steadySub = make('span', 'rd-sub');
  steady.box.append(steadySub);
  const feel = reading('Feel');
  feel.box.setAttribute('role', 'img');
  const track = make('span', 'rd-needle');
  const needle = make('i', '');
  track.appendChild(needle);
  const ends = make('span', 'rd-ends');
  ends.append(make('span', '', 'ahead'), make('span', '', 'behind'));
  feel.box.append(track, ends);
  const dials = make('div', 'rd-dials');
  dials.append(notes.box, steady.box, feel.box);

  const strip = make('div', 'rd-strip');
  const again = make('p', 'rd-again');
  card.replaceChildren(head, dials, strip, again);
  return {
    title,
    rec,
    close,
    notesBox: notes.box,
    notes: notes.big,
    steadyBox: steady.box,
    steady: steady.big,
    steadySub,
    feelBox: feel.box,
    feel: feel.big,
    needle,
    strip,
    again,
  };
}

/** A word too long for its column at 60 px comes down a size, rather than being cut. */
function fitWord(el: HTMLElement) {
  delete el.dataset.small;
  if (el.scrollWidth > el.clientWidth + 1) el.dataset.small = '1';
}

/** The numbers the card sums up, per limb, for its tooltip: there, not on the screen. */
function numbersSaid(g: Grade): string {
  const lines = [
    `${g.hit} of ${g.expected} notes · ${g.missed} missed · ${g.wrongVoice} on the wrong drum · ${g.extra} extra`,
    `Mean ${signed(g.timing.overall.meanMs)} ms, spread ±${g.timing.overall.sdMs} ms`,
  ];
  const limbs = Object.entries(g.timing.perLimb) as [Limb, Timing][];
  for (const [limb, t] of limbs.sort((a, b) => b[1].n - a[1].n)) {
    lines.push(
      `${LIMB_NAMES[limb] ?? limb}: ${t.n} notes, mean ${signed(t.meanMs)} ms, spread ±${t.sdMs} ms, worst ${t.maxAbsMs} ms`
    );
  }
  // Not a mistake, but not nothing either: a groove full of these usually means
  // the module's hi-hat threshold is not where your foot thinks it is.
  if (g.sameDrum > 0) {
    lines.push(`${g.sameDrum} on the same drum in its other state (an open hat for a closed one), counted as played`);
  }
  if (g.unmappedNotes.length) lines.push(`Unmapped module notes: ${g.unmappedNotes.join(', ')}`);
  return lines.join('\n');
}

/**
 * A word for a spread, so the reading needs no knowing what 14 ms means. Short,
 * because it is read at 60 px from the throne.
 */
function steadiness(sdMs: number): string {
  if (sdMs <= 8) return 'solid';
  if (sdMs <= TIGHT_MS) return 'tight';
  if (sdMs <= LOOSE_MS) return 'loose';
  return 'all over';
}

/** A word for an offset. Sign matters, so it is never dropped or abs()ed away. */
function placement(meanMs: number): string {
  if (Math.abs(meanMs) <= TIGHT_MS) return 'on it';
  const late = meanMs > 0;
  if (Math.abs(meanMs) <= LOOSE_MS) return late ? 'behind' : 'ahead';
  return late ? 'dragging' : 'rushing';
}

/** `18`, `18 and 20`, `18, 20 and 22`. */
const list = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** `+12` / `-12` / `0`: the sign is the whole point, so it is never dropped. */
const signed = (ms: number) => (ms > 0 ? `+${ms}` : String(ms));

/**
 * The calibration in a sentence (Lamp-10): "Calibrated on 14 September:
 * through this setup you sound 23 ms late, and the scoring takes that off."
 */
export function calibrationSaid(c: Calibration | undefined): string {
  if (!c) return 'Not calibrated: takes are scored with no allowance for how late this setup sounds.';
  const when = new Date(c.measuredAt);
  const on = Number.isNaN(when.getTime())
    ? ''
    : ` on ${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
  const ms = Math.round(Math.abs(c.offsetMs));
  const how = ms === 0 ? 'right on the click' : `${ms} ms ${c.offsetMs > 0 ? 'late' : 'early'}`;
  return `Calibrated${on}: through this setup you sound ${how}, and the scoring takes that off.`;
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
