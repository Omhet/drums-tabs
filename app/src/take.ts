// A take: one attempt at a song, on disk, forever.
//
// This is the format practice-plan Q4 calls the most important thing designed
// in the project, because three different readers depend on it and only one of
// them exists yet: you, the display, and a coaching agent that will one day
// read `songs/<slug>/takes/` off disk and write exercises from it. Get it right
// and everything above it is replaceable.
//
// Five decisions are frozen into the shape below and should not be quietly
// revisited:
//
//  1. **`tMs` is mix time** -- the same timeline `grid.beats` and the chart use,
//     so a take is directly comparable to both with nothing to convert.
//  2. **Timestamps are raw.** Both corrections in force are recorded beside
//     them, never baked in -- `calibrationMs` for this machine's audio path and
//     `referenceMs` for how far behind the chart the record itself plays -- so
//     either one later found to be wrong is a re-grade and not a lost take.
//  3. **Stored at the tempo it was played**, never normalised to 100%. The
//     whole point of Q7's second stage is that 30 ms late at 70% is not the
//     same achievement as 30 ms late at full speed.
//  4. **Velocity on every stroke, graded by nothing.** It costs nothing to
//     record and cannot be recovered afterwards.
//  5. **Both hashes are mandatory.** `chartHash` covers tab.mid; `sectionsHash`
//     covers the `[[section]]` blocks, which tab.mid knows nothing about -- move
//     a boundary and a section's bars change while the chart hash sits still.
//
// MIDI only: no audio. The sound is always regenerable from the notes, so
// storing it would be tens of megabytes to say nothing new.
import type { Grade, TakeEvent } from './grade';

/**
 * What was played: which bars, at what tempo.
 *
 * Called a cell because takes were once the cells of a routine grid (section x
 * tempo). The grid was removed on 2026-11-21 and a take is now the whole song,
 * but takes are never rewritten, so the name and its older shapes stay.
 */
export interface Cell {
  /**
   * The cell's place in the routine grid, `<section>@<percent>`. Written only
   * by takes played while the grid existed (2026-09-13 to 2026-11-21); never
   * written now.
   */
  id?: string;
  /** The `[[section]]` name, or `whole song`. */
  section: string;
  /** Playback rate it was played at: 1 is the record's tempo. */
  tempo: number;
  /** 1-based and inclusive, as the section is written. */
  startBar: number;
  endBar: number;
}

export interface Take {
  version: 1;
  cell: Cell;
  startedAt: string;
  /** What was subtracted at grading time. Raw stamps stay raw in `events`. */
  calibrationMs: number;
  /** The pad the calibration was measured on: latency is per input path. */
  calibrationNote?: number;
  /**
   * The song's reference floor, also subtracted at grading time (reference.ts).
   *
   * Optional because the takes played before the floor was measured do not have
   * one, and a take is never rewritten. Zero and absent mean the same thing:
   * this take's timing is against the written grid, not against the record.
   */
  referenceMs?: number;
  /** sha256 of tab.mid, first 16 hex. */
  chartHash: string;
  /** The `[[section]]` blocks as one string. See plugins/ableton.ts. */
  sectionsHash: string;
  /**
   * Whether the transport reached the end of the bars. A take stopped early is
   * still written -- it is a measurement that happened.
   */
  complete: boolean;
  /** Raw mix time, raw module note numbers, raw velocity. */
  events: TakeEvent[];
  grade: Grade;
}

/**
 * Write it to `songs/<slug>/takes/`.
 *
 * Through the dev server, which is the only thing here that can touch the
 * filesystem -- so recording is a dev-mode feature (Q15), stated rather than
 * discovered.
 */
export async function writeTake(slug: string, take: Take): Promise<string> {
  const res = await fetch('/practice/take', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `events` is the bulk of it and is written as sent: one object per stroke.
    body: JSON.stringify({ slug, ...take }),
  });
  const body = (await res.json()) as { path?: string; name?: string; error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `take not written (${res.status})`);
  return body.name ?? body.path ?? 'written';
}
