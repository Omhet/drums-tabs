// What you play, arriving in the browser.
//
// The module sends a note-on per stroke; this opens its port, reads the raw
// note numbers, and stamps each one with the moment in the mix it happened at.
// Everything downstream -- the calibration ritual, a take, the grade -- works
// from the hits this emits, so the two things it has to get right are the
// timestamp and the instrument.
//
// **The timestamp.** A MIDI event carries `timeStamp`, put on it when it
// arrived rather than when the handler got round to running, on the same clock
// as `performance.now()`. That is the honest moment, and it is what gets
// converted to mix time (`MixClock.mixTimeAt`) -- not "mix time now", which is
// a handler's worth of jitter later. Nothing here corrects for latency: the
// calibration offset is measured separately and subtracted at grading time, so
// a take keeps the raw measurement (practice-plan Q8).
//
// **The instrument.** The note numbers are the module's, not the chart's, and
// the two layouts disagree about nearly every number -- see the comment over
// `[input]` in kit.toml, which is the table this reads. Unmapped notes are
// still emitted, with no instrument, because the fastest way to fix the table
// is to hit the pad and read the number off the screen.
import type { MixClock } from './media';

/** One stroke, as it reached the browser. */
export interface MidiHit {
  /** When it arrived, on the `performance.now()` clock. */
  wallMs: number;
  /** ...and where that is in the mix, in ms. Raw: no calibration subtracted. */
  tMs: number;
  /** The raw note number the module sent. */
  note: number;
  /** 1-127, always captured and never graded (practice-plan Q7). */
  velocity: number;
  /** What kit.toml `[input]` calls that note, if it calls it anything. */
  instrument?: string;
}

export interface MidiPort {
  id: string;
  name: string;
  /** Whether hits are currently being read from it. */
  open: boolean;
}

/** Where the permission/support story stopped, for the status line. */
export type MidiState =
  | { kind: 'idle' }
  | { kind: 'unsupported' }
  | { kind: 'denied'; message: string }
  | { kind: 'ready'; ports: MidiPort[] };

export interface MidiInOptions {
  /** kit.toml `[input].note`: module note number -> instrument name. */
  notes: Record<number, string>;
  /** kit.toml `[input].port`: matched as a case-insensitive substring. */
  preferPort?: string;
}

const STORAGE_KEY = 'midi-port';

export class MidiIn {
  private access: MIDIAccess | undefined;
  private openId: string | undefined;
  private listeners = new Set<(hit: MidiHit) => void>();
  private stateListeners = new Set<(state: MidiState) => void>();
  private _state: MidiState = { kind: 'idle' };
  private injected = false;

  constructor(
    private readonly clock: MixClock,
    private readonly options: MidiInOptions
  ) {}

  get state(): MidiState {
    return this._state;
  }

  /** Every hit, until the returned function is called. */
  onHit(fn: (hit: MidiHit) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onState(fn: (state: MidiState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  /**
   * Ask for MIDI and open a port.
   *
   * Chrome puts Web MIDI behind a permission prompt, so this has to be called
   * from a click -- and a refusal is a normal outcome, not an error: the rest
   * of the player works without it.
   */
  async start(): Promise<MidiState> {
    if (!navigator.requestMIDIAccess) return this.setState({ kind: 'unsupported' });
    try {
      // No sysex: nothing here needs it, and asking for it makes the prompt
      // scarier and the permission harder to grant.
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      return this.setState({ kind: 'denied', message: String((err as Error)?.message ?? err) });
    }
    this.access.onstatechange = () => this.rescan();
    this.rescan();
    return this._state;
  }

  /** Read hits from this port, and remember it for next time. */
  open(id: string) {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) input.onmidimessage = null;
    const port = this.access.inputs.get(id);
    if (port) {
      void port.open();
      port.onmidimessage = (event) => this.onMessage(event);
      this.openId = id;
      try {
        localStorage.setItem(STORAGE_KEY, id);
      } catch {
        /* private mode: the choice lasts for this page */
      }
    } else {
      this.openId = undefined;
    }
    this.publishPorts();
  }

  /**
   * Whether anything is feeding strokes in: a port, or an injector.
   *
   * This, rather than "was Web MIDI granted", is what practice mode gates
   * recording on -- **Chrome refuses `requestMIDIAccess` under automation**
   * whatever the permission says, so the headless checks drive the whole
   * pipeline through `inject` and would otherwise be locked out of the one
   * feature they exist to check.
   */
  get hasSource(): boolean {
    return this.openId !== undefined || this.injected;
  }

  /** Feed a hit in as if it had arrived from the module. For the checks. */
  inject(note: number, velocity = 100, wallMs = performance.now()) {
    this.injected = true;
    this.emit(note, velocity, wallMs);
  }

  // --- ports ------------------------------------------------------------------

  private rescan() {
    if (!this.access) return;
    const ids = [...this.access.inputs.keys()];
    // Keep the open port if it is still there; otherwise take the remembered
    // one, then the one kit.toml names, then the only one there is.
    if (!this.openId || !ids.includes(this.openId)) {
      const choice = this.remembered(ids) ?? this.preferred() ?? (ids.length === 1 ? ids[0] : undefined);
      if (choice) this.open(choice);
      else this.openId = undefined;
    }
    this.publishPorts();
  }

  private remembered(ids: string[]): string | undefined {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved && ids.includes(saved) ? saved : undefined;
    } catch {
      return undefined;
    }
  }

  private preferred(): string | undefined {
    const want = this.options.preferPort?.trim().toLowerCase();
    if (!want || !this.access) return undefined;
    for (const [id, input] of this.access.inputs) {
      if ((input.name ?? '').toLowerCase().includes(want)) return id;
    }
    return undefined;
  }

  private publishPorts() {
    if (!this.access) return;
    const ports: MidiPort[] = [...this.access.inputs.values()].map((input) => ({
      id: input.id,
      name: [input.manufacturer, input.name].filter(Boolean).join(' ') || input.id,
      open: input.id === this.openId,
    }));
    this.setState({ kind: 'ready', ports });
  }

  private setState(state: MidiState): MidiState {
    this._state = state;
    for (const fn of this.stateListeners) fn(state);
    return state;
  }

  // --- messages ---------------------------------------------------------------

  private onMessage(event: MIDIMessageEvent) {
    const data = event.data;
    if (!data || data.length < 3) return;
    // 0x90 is note-on; a note-on at velocity 0 is how a lot of hardware spells
    // note-off, and a drum has no note-off worth hearing about either way.
    // The module also sends continuous controllers (the hi-hat pedal's
    // position on CC4), which nothing here reads yet.
    if ((data[0]! & 0xf0) !== 0x90) return;
    const velocity = data[2]!;
    if (velocity === 0) return;
    // Some implementations leave timeStamp at 0; `performance.now()` in the
    // handler is a worse answer than the real one but a much better answer
    // than 1970.
    const wallMs = event.timeStamp > 0 ? event.timeStamp : performance.now();
    this.emit(data[1]!, velocity, wallMs);
  }

  private emit(note: number, velocity: number, wallMs: number) {
    const hit: MidiHit = {
      wallMs,
      tMs: this.clock.mixTimeAt(wallMs),
      note,
      velocity,
      instrument: this.options.notes[note],
    };
    for (const fn of this.listeners) fn(hit);
  }
}
