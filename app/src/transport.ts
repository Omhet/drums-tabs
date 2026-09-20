// Which clock alphaTab is following, and the one place it changes.
//
// The player mode never changes: alphaTab is in EnabledExternalMedia from the
// first line of main.ts to the last, drawing the cursor and owning the
// transport while something else says what time it is. What changes is *who*
// that something is.
//
//   a song      -> MixClock, on mix.wav: the timeline the beat map, the stems
//                  and the picture are all measured against
//   an exercise -> TimerClock, on nothing: a line counted out at the tempo the
//                  exercise is written at
//
// Forking here rather than at the player is what keeps the rest of the app
// from noticing. The sync-point layer that corrects alphaTab's tick-to-ms
// truncation (syncpoints.ts) stays live, `MidiIn` keeps stamping strokes
// through one interface, and the scorer never learns that some of the beats it
// places notes on were nobody's.
import type * as alphaTab from '@coderline/alphatab';
import type { PlayClock } from './clock';
import type { MixClock } from './media';
import type { TimerClock } from './timer-clock';

/** Anything that holds on to a clock and has to be told when it changes. */
export interface ClockFollower {
  setClock(clock: PlayClock): void;
}

export class Transport {
  private current: PlayClock;

  constructor(
    private readonly api: alphaTab.AlphaTabApi,
    readonly mix: MixClock,
    readonly timer: TimerClock,
    private readonly followers: readonly ClockFollower[]
  ) {
    this.current = mix;
  }

  /** Whichever clock is driving the page right now. */
  get clock(): PlayClock {
    return this.current;
  }

  /** True while an exercise is playing on its own timeline. */
  get standalone(): boolean {
    return this.current === this.timer;
  }

  /** The record is the clock: a song page, exactly as it always was. */
  useMix() {
    this.use(this.mix);
  }

  /**
   * A counted line is the clock, `ms` long.
   *
   * The length matters: alphaTab asks the handler how long the track is and
   * treats a zero-length one as empty, so an exercise that never said would
   * refuse to play at all.
   */
  useTimer(ms: number) {
    this.timer.setDuration(ms);
    this.use(this.timer);
  }

  /** Point alphaTab at whichever clock is current. Safe to call again. */
  attach() {
    const output = this.api.player?.output as alphaTab.synth.IExternalMediaSynthOutput | undefined;
    if (output && 'handler' in output) this.current.attach(output);
  }

  private use(next: PlayClock) {
    if (this.current === next) return;
    // Stop the outgoing one first, and stop alphaTab with it: two clocks
    // pushing positions into one cursor is the one failure this class exists
    // to make impossible.
    this.api.pause();
    this.current.detach();
    this.current = next;
    this.attach();
    for (const follower of this.followers) follower.setClock(next);
  }
}
