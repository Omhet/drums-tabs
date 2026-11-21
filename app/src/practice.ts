// Practice mode: play the song on the kit, get marked on it.
//
// MIDI in, a calibration ritual, a take on disk, a grade, and the grade drawn
// on the staff. A take is the whole song at whatever tempo the page is set to:
// a bar of count-in, then the record from bar 1 to the end, every stroke
// stamped in mix time and marked against the chart when it stops.
//
// There used to be two more layers on top of this -- a routine (a grid of
// whole-song tempos you opened, filled and sealed) and exercises (bars cut into
// a pool and drilled on a loop with a ladder of their own). Both were removed
// on 2026-11-21: they were barely used and got in the way of playing along.
// The loop they had is in git history (`git show 5c21a14:app/src/practice.ts`)
// for when looping a section on the song page is built.
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
import { Click } from './click';
import { grade, type Grade, type GradeResult, type TakeEvent, type Timing } from './grade';
import { Heatmap } from './heatmap';
import { say } from './icons';
import type { PlayClock } from './clock';
import { MidiIn, type MidiHit } from './midi-in';
import type { Mixer } from './mixer';
import { referenceMs as floorOf, referenceNote, type ReferenceLock } from './reference';
import type { StickingLock } from './sticking';
import { writeTake, type Take } from './take';
import { barStartMs, type Grid } from './syncpoints';

/** Bars of click before the take starts. Not recorded, not graded. */
const COUNT_IN_BARS = 1;
/** Hits this far outside the take's range still belong to it: a late last note counts. */
const EDGE_MS = 250;
/** A take whose mean is further than this from the stored calibration nags. */
const DRIFT_MS = 10;
/**
 * At or above this share of the written notes, a take -- or a bar of one --
 * reads as good. Below it the dial and the bar go red, and nothing else
 * happens: it is a signal, not a gate.
 */
const PASS = 0.9;
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
  enable: HTMLButtonElement;
  port: HTMLSelectElement;
  calibrate: HTMLButtonElement;
  calibration: HTMLOutputElement;
  record: HTMLButtonElement;
  /** What Record will play, in words. */
  target: HTMLOutputElement;
  monitorOn: HTMLInputElement;
  monitor: HTMLElement;
  report: HTMLElement;
  /**
   * The click fader, which the count-in and the ritual need audible. Driven by
   * dispatching the `input` event the page already listens for, so the slider,
   * the mixer and the remembered levels all stay in step with one setter
   * rather than three.
   */
  clickFader: HTMLInputElement;
}

export class Practice {
  readonly midi: MidiIn;
  private readonly heatmap: Heatmap;
  private loaded: PracticeSong | undefined;
  private calibration: Calibration | undefined;
  private running: CalibrationRun | undefined;
  /** Recording: the hits landing in the take. Unset through the count-in. */
  private capture: TakeEvent[] | undefined;
  private run: Run | undefined;
  private timer = 0;
  private countInTimer = 0;
  private recent: MidiHit[] = [];
  /** The last graded take, for the headless check and the console. */
  result: GradeResult | undefined;
  /**
   * The bars the last graded take covered, for the strip. Kept rather than
   * recomputed, because a theme switch redraws the report and the song may
   * have been re-saved in Live since.
   */
  private reportRange: { startBar: number; endBar: number } | undefined;

  constructor(
    private readonly api: alphaTab.AlphaTabApi,
    private readonly clock: PlayClock,
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
    // Only the notation needs telling: alphaTab paints noteheads itself, while
    // the report is drawn from CSS variables and re-themes with the interface.
    this.heatmap.setTheme(dark);
    // The heatmap bakes its colours into a render, so a take already on the
    // staff would keep the old palette's noteheads until the next take.
    const grid = this.loaded?.grid;
    if (this.result && grid) this.heatmap.show(this.result, grid);
  }

  /** Point practice mode at the song the player just loaded. */
  load(loaded: PracticeSong) {
    this.stopRun(false);
    this.heatmap.clear();
    this.result = undefined;
    this.el.report.hidden = true;
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
    this.el.enable.disabled = state.kind === 'ready';
    // The word, and the glyph that stands in for it when the rail is collapsed
    // to one icon wide (icons.ts).
    if (state.kind === 'ready') say(this.el.enable, 'MIDI on', '✓');
    else say(this.el.enable, 'Enable MIDI', '♪');
    this.showTarget();
  }

  private onHit(hit: MidiHit) {
    this.recent.push(hit);
    if (this.recent.length > MONITOR) this.recent.shift();
    this.drawMonitor();
    // A stroke arriving is itself news: it means there is something to record
    // from, which `showPorts` cannot know before the first one lands.
    if (this.el.record.disabled) this.showTarget();
    const take = this.capture;
    const rec = this.run;
    if (!take || !rec) return;
    if (hit.tMs < rec.startMs - EDGE_MS || hit.tMs > rec.endMs + EDGE_MS) return;
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
      this.showTarget();
    }
  }

  // --- the take -------------------------------------------------------------------

  /**
   * What Record plays: the whole song, as far as the beat map can place it.
   *
   * Bar 1 to the last bar of the sections when there are any -- they are the
   * song as you named it -- else to the end of the beat map. Either way it is
   * cut back to the last bar the beat map has an end for: a take ends where
   * the bar after its last bar begins, and a chart that runs a bar past the
   * beat map (Song 2's last crash, One For The Road's 73 bars against 72) would
   * otherwise refuse to record at all.
   */
  private target(): Target | undefined {
    const loaded = this.loaded;
    const grid = loaded?.grid;
    if (!loaded || !grid) return undefined;
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
    this.el.target.textContent = at?.label ?? 'no beat map';
    const ready = !!at && !this.running && this.midi.hasSource && import.meta.env.DEV;
    // Record is the way out of a take it started.
    this.el.record.disabled = !this.run && !ready;
    // Calibrating needs something sending strokes and nothing else running --
    // not a song, which is the point: the click it measures against is its own.
    if (!this.running) this.el.calibrate.disabled = !this.midi.hasSource || !!this.run;
    // A disabled button should say what would enable it.
    this.el.record.title = this.run
      ? 'Stop the take'
      : !import.meta.env.DEV
        ? 'Recording needs the dev server (npm run dev)'
        : !at
          ? 'No grid.lock.json: nothing can be placed in the mix'
          : !this.midi.hasSource
            ? 'Enable MIDI first: there is nothing to record'
            : 'Play the whole song at the tempo set, and be marked on it';
  }

  private toggleRecord() {
    if (this.run) this.stopRun(false);
    else this.startRun();
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

    this.heatmap.clear();
    this.result = undefined;
    this.el.report.hidden = true;
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
    say(this.el.record, 'Stop', '⏹');
    this.el.record.dataset.armed = '1';
    this.showTarget();
    const label = `${at.label} at ${Math.round(tempo * 100)}%`;
    this.onStatus(
      `Counting in ${label}` +
        (!this.calibration ? ' -- uncalibrated, so the mean offset will include the audio path' : '')
    );

    // One bar of clicks, then the music, starting exactly on bar 1. A count-in
    // rather than a bar of the record itself, because bar 1 has no bar before
    // it to play -- and because the clicks give you the tempo, which the
    // run-up only implies. In the take's tempo, not the record's: four clicks
    // at 100% would hand you the wrong speed to start a 70% take in.
    const perBar = grid.meter.beats_per_bar;
    const barMs = (barStartMs(grid, at.startBar) ?? startMs + 2000) - startMs;
    const beatS = barMs / perBar / 1000 / tempo;
    void this.countIn(beatS, perBar * COUNT_IN_BARS).then((go) => {
      if (!go || this.run !== rec) return; // stopped during the count-in
      this.capture = [];
      this.api.play();
      clearInterval(this.timer);
      this.timer = window.setInterval(() => this.tick(), 25);
      this.onStatus(`Recording ${label}.`);
    });
  }

  /** The only place the transport is watched: the end of the take. */
  private tick() {
    const rec = this.run;
    if (rec && this.clock.mixTimeMs >= rec.endMs) this.stopRun(true);
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
        if (!this.run) {
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
          resolve(this.run !== undefined);
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

  private stopRun(complete: boolean) {
    clearInterval(this.timer);
    clearTimeout(this.countInTimer);
    this.timer = 0;
    const rec = this.run;
    const events = this.capture;
    this.run = undefined;
    this.capture = undefined;
    say(this.el.record, 'Record', '⏺');
    delete this.el.record.dataset.armed;
    if (rec) this.api.pause();
    // Nothing captured means it was stopped during the count-in: nothing was
    // played, so there is nothing to write.
    if (rec && events) void this.finish(rec, events, complete);
    this.showTarget();
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
    this.reportRange = { startBar: rec.startBar, endBar: rec.endBar };
    this.drawReport(result);
    this.el.report.hidden = false;

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
    }

    const g = result.grade;
    const drift = this.calibration ? Math.abs(g.timing.overall.meanMs) : 0;
    this.onStatus(
      [
        complete ? 'Take complete.' : 'Take stopped early.',
        `${g.hit}/${g.expected} notes, ${g.missed} missed, ${g.extra} extra.`,
        `Mean ${signed(g.timing.overall.meanMs)} ms, spread ±${g.timing.overall.sdMs} ms.`,
        name ? `Written to takes/${name}.` : '',
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
  private drawReport(result: GradeResult) {
    const g = result.grade;
    const el = this.el.report;
    el.replaceChildren();

    const dials = document.createElement('div');
    dials.className = 'dials';
    dials.append(
      dial({
        label: 'Notes',
        big: `${Math.round(g.accuracy * 100)}%`,
        sub: `${g.hit} of ${g.expected}`,
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
   * One block per bar of the take: a map of where it went wrong.
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
      // A bar with nothing written in it is neither good nor bad.
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
