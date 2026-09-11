// grid.lock.json -> alphaTab sync points.
//
// The notation is written at a constant tempo; the drummer was not. The beat
// map records when every beat actually happened in the video, and alphaTab
// takes that as a list of "this point in the score is at this millisecond in
// the media", stretching the cursor between neighbouring points.
import type * as alphaTab from '@coderline/alphatab';

/** The beat map the Python pipeline writes to songs/<slug>/grid.lock.json. */
export interface Grid {
  version: number;
  source: { audio_duration: number };
  meter: { beats_per_bar: number; beat_unit: number };
  /** Index into `beats` of the first beat of song bar 1 (= notation bar 1). */
  bar_one_beat: number;
  count_in_bars: number;
  /** Bars from bar 1 to the end of the beat map. */
  bar_count: number;
  score: { bpm: number };
  /** Seconds into the media of every beat the drummer played. */
  beats: number[];
}

/**
 * One sync point per played beat, for the first `barCount` notation bars.
 *
 * Notation bar index 0 is song bar 1, so the count-in beats before
 * `bar_one_beat` get no sync point: alphaTab cannot place them, and the player
 * holds the cursor on bar 1 until the song starts.
 */
export function gridSyncPoints(grid: Grid, barCount: number): alphaTab.model.FlatSyncPoint[] {
  const perBar = grid.meter.beats_per_bar;
  const points: alphaTab.model.FlatSyncPoint[] = [];
  for (let i = grid.bar_one_beat; i < grid.beats.length; i++) {
    const n = i - grid.bar_one_beat;
    const barIndex = Math.floor(n / perBar);
    if (barIndex >= barCount) break;
    points.push({
      barIndex,
      barOccurence: 0,
      barPosition: (n % perBar) / perBar,
      millisecondOffset: grid.beats[i]! * 1000,
    });
  }
  return points;
}

/**
 * A tempo to write the notation at so that it stays locked to the sync points.
 *
 * alphaTab builds its sync table by adding up beat durations truncated to
 * whole milliseconds (MidiUtils.ticksToMillis does `| 0`), but converts ticks
 * to time exactly everywhere else. At 91 BPM a beat is 659.34 ms, so every
 * sync point loses a third of a millisecond and the cursor is 80 ms behind the
 * drummer by bar 60. With a beat that is a whole number of milliseconds
 * (a tempo that divides 60000) nothing is lost. The written tempo is only a
 * number on the page: the media sets the real one.
 */
export function syncSafeTempo(bpm: number): number {
  let best = 120;
  for (let t = 40; t <= 240; t++) {
    if (60000 % t === 0 && Math.abs(t - bpm) < Math.abs(best - bpm)) best = t;
  }
  return best;
}

/** Milliseconds into the media where notation bar `barIndex` (0-based) starts. */
export function barStartMs(grid: Grid, barIndex: number): number | undefined {
  const s = grid.beats[grid.bar_one_beat + barIndex * grid.meter.beats_per_bar];
  return s === undefined ? undefined : s * 1000;
}
