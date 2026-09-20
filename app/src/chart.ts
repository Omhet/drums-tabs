// The chart: what is written, where it falls in the mix, and which limb plays it.
//
// This is the browser's twin of `pipeline/chart.py`, and it lays every hit on
// the same grid for the same reason: a tool that disagreed with the page about
// where a note is would be analysing a chart nobody can see. `midi-tab.ts`
// turns these hits into notation; the scorer measures what you played against
// them.
//
// **Two timelines, never mixed up.** `slot` is *straight* time -- sixteenths
// counted from the start of bar 1, at the constant tempo the notation is
// written at. `tMs` is *mix* time -- the real millisecond in mix.wav the note
// falls on, which is what a hit can be compared to. `grid.lock.json` is the
// only bridge between them, and it is the same bridge the cursor crosses
// (`syncpoints.ts`), so a reference note and the cursor are always in the same
// place.
import { parseMidi } from 'midi-file';
import type { StickingLock } from './sticking';
import type { Grid } from './syncpoints';

/** The notation's grid: four slots to the beat. */
export const SLOTS_PER_BEAT = 4;

/** The four limbs, plus the one the sticking cannot name. */
export type Limb = 'right_hand' | 'left_hand' | 'right_foot' | 'left_foot' | 'hands';

/**
 * Which foot plays a pedal. Fixed by practice-plan Q11: hi-hat pedal is the
 * left foot and the kick is the right, which assumes one kick pedal and a
 * conventional setup.
 */
const FOOT: Record<string, Limb> = { kick: 'right_foot', hihat_pedal: 'left_foot' };

/** One note in the chart, on the notation's own grid. */
export interface ChartHit {
  /** Sixteenths from the start of bar 1. */
  slot: number;
  /**
   * The MIDI key as laid out on the drum rack -- a song's `[midi_map]`.
   *
   * Absent on hits that did not come out of a song's tab.mid: an exercise
   * carries its own notes (exercise.ts) and the key one song happened to put
   * them on says nothing about them. `instrument` is the identity.
   */
  note?: number;
  instrument: string;
  /** 1-127 as written in Ableton. Carried, never graded. */
  velocity: number;
}

/** One note to be played, placed in the mix and given a limb. */
export interface ExpectedNote {
  /** 1-based, the way bar numbers are printed. */
  bar: number;
  /** Sixteenths from the start of *this bar*. */
  inBar: number;
  /** Sixteenths from the start of bar 1: the chart-wide address. */
  slot: number;
  instrument: string;
  velocity: number;
  /** When it falls in the mix, in ms. */
  tMs: number;
  limb: Limb;
}

/**
 * What a chart is, to anything that has to notice it changing.
 *
 * Every Ctrl+S in Ableton rewrites tab.mid, so a lock file, a take or an
 * exercise can quietly come to describe a chart that no longer exists. Each of
 * them records the hash it was made against; this is the other half of that
 * check.
 *
 * It lives here rather than beside the sticking it was first written for
 * because it is a fact about the chart, and because `exercise.ts` has to reach
 * it from the pure half that `node --test` runs directly -- which cannot load
 * a module with a class in it.
 */
export async function chartHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex.slice(0, 16)}`;
}

/**
 * Every note-on in a tab.mid, read as instruments.
 *
 * Document order, which is the order `midiToAlphaTex` has always seen them in;
 * anything wanting them in time order sorts its own copy.
 */
export function readChart(
  bytes: Uint8Array,
  map: Record<number, string>
): { hits: ChartHit[]; unmapped: number[] } {
  const midi = parseMidi(bytes);
  const ppq = midi.header.ticksPerBeat;
  if (!ppq) throw new Error('tab.mid uses SMPTE timing; expected ticks per beat');
  const step = ppq / SLOTS_PER_BEAT;

  const hits: ChartHit[] = [];
  const unmapped = new Set<number>();
  for (const track of midi.tracks) {
    let tick = 0;
    for (const event of track) {
      tick += event.deltaTime;
      if (event.type !== 'noteOn' || !event.velocity) continue;
      const instrument = map[event.noteNumber!];
      if (!instrument) {
        unmapped.add(event.noteNumber!);
        continue;
      }
      hits.push({
        slot: Math.round(tick / step),
        note: event.noteNumber!,
        instrument,
        velocity: event.velocity,
      });
    }
  }
  return { hits, unmapped: [...unmapped].sort((a, b) => a - b) };
}

/**
 * Where a slot falls in the mix, in ms.
 *
 * The beat map says when every beat happened; a slot between two beats is
 * placed proportionally between them, which is exactly what alphaTab does with
 * the same numbers when it stretches the cursor between sync points. Past the
 * end of the beat map the last interval is extended rather than the note being
 * dropped -- a chart bar with no measured beat under it is a problem to report,
 * not to silently lose a note over.
 */
export function slotToMixMs(grid: Grid, slot: number): number | undefined {
  const beats = grid.beats;
  if (beats.length < 2) return undefined;
  const fromBarOne = slot / SLOTS_PER_BEAT;
  const whole = Math.floor(fromBarOne);
  const frac = fromBarOne - whole;
  const i = grid.bar_one_beat + whole;
  const last = beats.length - 1;
  if (i < 0) return undefined;
  if (i < last) {
    const a = beats[i]!;
    return (a + frac * (beats[i + 1]! - a)) * 1000;
  }
  // Past the beat map: carry on at the length of its last beat.
  const step = beats[last]! - beats[last - 1]!;
  return (beats[last]! + (i - last + frac) * step) * 1000;
}

/**
 * The notes a stretch of bars asks for, in time order.
 *
 * `bars` are 1-based and inclusive, the way `[[section]]` writes them.
 *
 * **Limbs come from the sticking lock, and matching never uses them.** Which
 * hand hit the snare is not in the MIDI and never can be -- the module sends a
 * note, not a hand -- so a played hit is matched by instrument and inherits the
 * limb of whatever it matched. The limb is for the report, where "your right
 * hand rushes" is the sentence worth reading.
 */
export function expectedNotes(
  hits: readonly ChartHit[],
  grid: Grid,
  bars: { start: number; end: number },
  // Only the strokes are read, so an exercise can hand over its own re-based
  // ones without a whole `sticking.lock.json` around them.
  sticking?: Pick<StickingLock, 'strokes'>
): ExpectedNote[] {
  const perBar = grid.meter.beats_per_bar * SLOTS_PER_BEAT;
  const limbs = new Map<string, Limb>();
  for (const stroke of sticking?.strokes ?? []) {
    limbs.set(`${stroke.bar}:${stroke.slot}:${stroke.instrument}`, stroke.limb);
  }

  const notes: ExpectedNote[] = [];
  for (const hit of hits) {
    const bar = Math.floor(hit.slot / perBar) + 1;
    if (bar < bars.start || bar > bars.end) continue;
    const tMs = slotToMixMs(grid, hit.slot);
    if (tMs === undefined) continue;
    const inBar = hit.slot % perBar;
    notes.push({
      bar,
      inBar,
      slot: hit.slot,
      instrument: hit.instrument,
      velocity: hit.velocity,
      tMs,
      // The sticking lock addresses a stroke by (bar, slot-in-bar, instrument).
      limb: FOOT[hit.instrument] ?? limbs.get(`${bar}:${inBar}:${hit.instrument}`) ?? 'hands',
    });
  }
  notes.sort((a, b) => a.tMs - b.tMs || a.instrument.localeCompare(b.instrument));
  return notes;
}
