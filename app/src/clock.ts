// What the page needs from a clock, and nothing about where the time comes from.
//
// alphaTab runs in PlayerMode.EnabledExternalMedia throughout: it draws the
// cursor and owns the transport, and something else is expected to say what
// time it is. That something is `mix.wav` (media.ts), and this is the narrow
// view of it the rest of the page is given -- the mixer, the MIDI input and
// practice mode ask these questions and never touch the media element:
//
//   `mixTimeMs`   the mixer, per frame, to keep the stems and the click with it
//   `mixTimeAt`   MidiIn, to stamp a stroke at the moment it actually arrived
//   `seekTo`      Practice, to put a take on its first bar
//   `playbackRate` both, because a millisecond at 80% is not a millisecond
import type * as alphaTab from '@coderline/alphatab';

/**
 * A clock alphaTab can follow, and the page can read back.
 *
 * `IExternalMediaHandler` is alphaTab's half -- play, pause, seek, rate,
 * duration, volume. The rest is ours: where the time is now, where it was a
 * moment ago, and the floor the count-in hides behind.
 */
export interface PlayClock extends alphaTab.synth.IExternalMediaHandler {
  /** Where the transport is now, in ms of mix time. */
  readonly mixTimeMs: number;
  /**
   * Where it was at a given `performance.now()` moment.
   *
   * A hit is stamped when it arrives, a few milliseconds before anything gets
   * to look at it, so "now" is the wrong answer by that much.
   */
  mixTimeAt(wallMs: number): number;
  /** Positions before this are reported as this: the count-in has no bar. */
  floorMs: number;
  /** Whether time is currently moving. */
  readonly running: boolean;
  /**
   * Told when the transport moves, until the returned function is called.
   *
   * The four things a media element fires that the page actually acts on.
   * Buffering is deliberately not in here: stalling is a fact about a media
   * file arriving, not about a transport, and the mixer reads it off the
   * element itself.
   */
  onTransport(fn: (event: TransportEvent) => void): () => void;
  /** Attach to alphaTab's external-media output. Safe to call again. */
  attach(output: alphaTab.synth.IExternalMediaSynthOutput): void;
}

export type TransportEvent = 'play' | 'pause' | 'seek' | 'rate';
