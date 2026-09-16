// The floor a take is measured from.
//
// The chart is written on a sixteenth grid. The record it was written from was
// played by a person, who sits wherever the music wants them to -- and if that
// is behind the grid, then copying the feel that is actually in your ears is
// marked late by the difference, every time, forever. `drums reference`
// measures that difference per song and writes it to `reference.lock.json`;
// this takes it off, so that **zero means "sitting where the record sits"**
// rather than "sitting on a grid nobody played to".
//
// Two things about it are worth stating plainly, because a correction you
// cannot see is a correction you cannot argue with:
//
//  1. **It is one number for the whole kit**, and on some records the kick and
//     the snare do not sit together -- Song 2's kick is +10.7 ms behind the
//     grid and its snare is -1.3 ms, so the pooled +6.2 ms is right for
//     neither exactly. The split is in the lock for a later version to use; one
//     number is the honest default because it is the one that fits in a
//     sentence.
//  2. **It is pinned to the chart.** Move a note in Live and the record sits
//     somewhere else relative to it, so a lock measured from another chart is
//     ignored rather than applied -- the same rule the sticking letters follow.

export interface ReferenceInstrument {
  instrument: string;
  /** How many written notes of this instrument found an onset in the record. */
  matched: number;
  written: number;
  mean_ms: number;
  median_ms: number;
  sd_ms: number;
}

export interface ReferenceLock {
  version: number;
  /** The chart it was measured against: sha256 of tab.mid, first 16 hex digits. */
  chart: string;
  /** Pooled over every matched note. Positive means the record is behind the chart. */
  mean_ms: number;
  median_ms: number;
  matched: number;
  written: number;
  instruments: ReferenceInstrument[];
}

/**
 * The milliseconds to take off a take's timing, or zero.
 *
 * Zero for a song that has never been measured, and zero for a lock belonging
 * to a chart you have since edited -- in both cases the honest answer is "no
 * floor is known", and applying a stale one would be worse than applying none.
 */
export function referenceMs(lock: ReferenceLock | undefined, chart: string): number {
  if (!lock || lock.version !== 1 || lock.chart !== chart) return 0;
  return Number.isFinite(lock.mean_ms) ? lock.mean_ms : 0;
}

/** What the correction is, in a sentence, for the tooltip on the timing dial. */
export function referenceNote(lock: ReferenceLock | undefined, chart: string): string {
  const ms = referenceMs(lock, chart);
  if (ms === 0) {
    return lock && lock.chart !== chart
      ? 'The record was measured against an older chart, so no floor is being taken off. ' +
          'Run `drums reference <slug>` again.'
      : 'This song has no reference measurement, so timing is against the written grid. ' +
          'Run `drums reference <slug>`.';
  }
  const split = lock!.instruments
    .map((i) => `${i.instrument} ${signed(Math.round(i.mean_ms))}`)
    .join(', ');
  return (
    `Zero is where the record's own drummer sits, not where the grid is: ` +
    `${signed(round1(ms))} ms is taken off every stroke (${split}). ` +
    `Measured over ${lock!.matched} notes.`
  );
}

const round1 = (ms: number) => Math.round(ms * 10) / 10;
const signed = (ms: number) => (ms > 0 ? `+${ms}` : String(ms));

