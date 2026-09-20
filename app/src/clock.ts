// What the page needs from a clock, and nothing about where the time comes from.
//
// alphaTab runs in PlayerMode.EnabledExternalMedia throughout: it draws the
// cursor and owns the transport, and something else is expected to say what
// time it is. On a song that something is `mix.wav` (media.ts). On an exercise
// with no song behind it there is no media at all, and the time is counted out
// on the audio clock instead (timer-clock.ts) -- but every consumer downstream
// asks the same four questions, so neither of them is a special case.
//
// The four questions, and who asks them:
//
//   `mixTimeMs`   the mixer, per frame, to keep the stems and the click with it
//   `mixTimeAt`   MidiIn, to stamp a stroke at the moment it actually arrived
//   `seekTo`      Practice, which is how a loop turns round
//   `playbackRate` both, because a millisecond at 80% is not a millisecond
//
// The name says "mix time" on both, which is honest rather than sloppy: it is
// the timeline the notes, the beat map and the cursor are all placed on. On a
// song that is the mix's own timeline; without one it is a timeline the page
// makes up, and the only thing that changes is who counts it.
import type * as alphaTab from '@coderline/alphatab';

/**
 * A clock alphaTab can follow, and the page can read back.
 *
 * `IExternalMediaHandler` is alphaTab's half -- play, pause, seek, rate,
 * duration, volume. The rest is ours: where the time is now, where it was a
 * moment ago, and the floor the count-in hides behind.
 */
export interface PlayClock extends alphaTab.synth.IExternalMediaHandler {
  /** Where the transport is now, in ms of this timeline. */
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
   * The four things a media element fires that the page actually acts on, as
   * an event anything can raise. The mixer used to read them straight off the
   * <audio> element, which meant the click and the stems only followed a clock
   * that happened to *be* an element -- and an exercise's clock is not one.
   *
   * Buffering is deliberately not in here: stalling is a fact about a media
   * element, not about a transport, and it stays where it belongs.
   */
  onTransport(fn: (event: TransportEvent) => void): () => void;
  /** Attach to alphaTab's external-media output. Safe to call again. */
  attach(output: alphaTab.synth.IExternalMediaSynthOutput): void;
  /** Stop pumping positions and let go of the transport. */
  detach(): void;
}

export type TransportEvent = 'play' | 'pause' | 'seek' | 'rate';
