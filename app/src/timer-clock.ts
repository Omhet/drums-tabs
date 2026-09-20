// A clock with nothing behind it: the timeline an exercise plays on.
//
// `MixClock` (media.ts) is the same job done by an <audio> element -- it reads
// the mix's position and pushes it into alphaTab, and everything that plays
// follows. An exercise that carries its own notes has no mix, no stems and no
// picture, so there is nothing to read a position off. This counts one out
// instead: a straight line at the playback rate, started and stopped by the
// transport, pushed into alphaTab exactly the same way.
//
// It is deliberately the duller of the two. `MixClock` has to keep a smoothed
// estimate pinned to a media element that advances in jerks of a render
// quantum; there is nothing here to be pinned to, so the straight line *is*
// the answer and the drift-correction is simply absent rather than disabled.
//
// The sound is somebody else's problem, which is the point of keeping the
// fork here: the click books blips against this position (click.ts) and the
// kit books notes against it the same way, so replacing either of them
// changes nothing about the clock they agree on.
import type * as alphaTab from '@coderline/alphatab';
import type { PlayClock, TransportEvent } from './clock';

type Output = alphaTab.synth.IExternalMediaSynthOutput;

export class TimerClock implements PlayClock {
  private output: Output | undefined;
  private frame = 0;
  private pump = 0;
  private playing = false;
  /** Where the line was last pinned, in ms of this timeline. */
  private anchorTime = 0;
  /** ...and when, in `performance.now()` ms. */
  private anchorWall = 0;
  private rate = 1;
  private volume = 1;
  /** How long the thing being played is. Zero would read as an empty track. */
  private durationMs = 0;

  floorMs = 0;

  private readonly listeners = new Set<(event: TransportEvent) => void>();

  get running(): boolean {
    return this.playing;
  }

  onTransport(fn: (event: TransportEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private say(event: TransportEvent) {
    for (const fn of this.listeners) fn(event);
  }

  /** The length of what is loaded, which alphaTab asks for before it will play. */
  setDuration(ms: number) {
    this.durationMs = Math.max(1, ms);
  }

  attach(output: Output) {
    if (this.output === output) return;
    this.output = output;
    output.handler = this;
    this.push(this.anchorTime);
  }

  detach() {
    this.pause();
    this.output = undefined;
  }

  // --- IExternalMediaHandler ------------------------------------------------

  get mixTimeMs(): number {
    return this.playing ? this.anchorTime + (performance.now() - this.anchorWall) * this.rate : this.anchorTime;
  }

  /**
   * Where the line was at a given moment on the wall clock.
   *
   * Paused, the position is not moving and the anchor is the whole answer --
   * the same rule `MixClock` follows, and for the same reason: a stroke that
   * arrives while the transport is parked has nowhere else to be placed.
   */
  mixTimeAt(wallMs: number): number {
    if (!this.playing) return this.anchorTime;
    return this.anchorTime + (wallMs - this.anchorWall) * this.rate;
  }

  get backingTrackDuration(): number {
    return this.durationMs;
  }

  get playbackRate(): number {
    return this.rate;
  }
  set playbackRate(value: number) {
    // Pin first: the seconds already played were played at the old rate, and
    // re-deriving them from the new one would move the cursor sideways.
    this.anchorTime = this.mixTimeMs;
    this.anchorWall = performance.now();
    this.rate = value || 1;
    this.say('rate');
  }

  /** Nothing here makes a sound, so this is only ever read back. */
  get masterVolume(): number {
    return this.volume;
  }
  set masterVolume(value: number) {
    this.volume = value;
  }

  seekTo(time: number): void {
    this.anchorTime = Math.max(0, time);
    this.anchorWall = performance.now();
    // Paused or playing: a seek moves the cursor either way, which is what a
    // loop turning round during its rest depends on.
    this.push(this.anchorTime);
    this.say('seek');
  }

  play(): void {
    if (this.playing) return;
    this.anchorWall = performance.now();
    this.playing = true;
    this.startPump();
    this.say('play');
  }

  pause(): void {
    if (!this.playing) return;
    this.anchorTime = this.mixTimeMs;
    this.playing = false;
    this.stopPump();
    this.push(this.anchorTime);
    this.say('pause');
  }

  // --- the clock --------------------------------------------------------------

  private push(ms: number) {
    this.output?.updatePosition(Math.max(ms, this.floorMs));
  }

  private startPump() {
    cancelAnimationFrame(this.frame);
    const tick = () => {
      if (!this.playing) return;
      this.push(this.mixTimeMs);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
    // requestAnimationFrame stops in a background tab. The mix has a media
    // element still firing timeupdate to cover that; this has nothing, so it
    // keeps its own slow pump for the same reason.
    clearInterval(this.pump);
    this.pump = window.setInterval(() => {
      if (this.playing && document.hidden) this.push(this.mixTimeMs);
    }, 250);
  }

  private stopPump() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    clearInterval(this.pump);
    this.pump = 0;
  }
}
