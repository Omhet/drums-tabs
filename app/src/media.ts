// The mix is the master clock; alphaTab follows it.
//
// In PlayerMode.EnabledExternalMedia alphaTab stops producing sound and time.
// It still owns the transport (play/pause/seek/speed) and delegates each of
// those to this handler, and it expects the media's current time to be pushed
// back in through `updatePosition`, which is what moves the cursor.
//
// The media that does that is an <audio> element on songs/<slug>/audio/mix.wav
// -- the timeline the beat map, the stems and the notation all refer to. So
// the clock's time is mix time with nothing to convert, and everything else
// that plays follows it: the stems, the click, and the picture when the song
// has a video bound to this timeline (see follow.ts). It used to be the other
// way round, the cover video leading and the mix trailing it by the offset
// `drums align` measured; practice is against the original track now, and a
// video is a picture the timeline may or may not have.
import type * as alphaTab from '@coderline/alphatab';
import type { PlayClock, TransportEvent } from './clock';

type Output = alphaTab.synth.IExternalMediaSynthOutput;

export interface MixClockOptions {
  /** Called when the browser refuses to start the audio (autoplay policy). */
  onPlayError?: (error: unknown) => void;
}

export class MixClock implements PlayClock {
  private output: Output | undefined;
  private frame = 0;
  /** Where the smoothed clock was last pinned to the media, in ms. */
  private anchorMedia = 0;
  /** ...and when, in performance.now() ms. */
  private anchorWall = 0;
  /**
   * Positions before this many ms are reported as this value: the count-in
   * has no place in the notation, so the cursor waits on bar 1.
   */
  floorMs = 0;
  /** Used until the media's metadata has loaded and the true duration is known. */
  fallbackDurationMs = 0;

  private readonly listeners = new Set<(event: TransportEvent) => void>();

  constructor(
    readonly el: HTMLMediaElement,
    private readonly options: MixClockOptions = {}
  ) {
    el.addEventListener('play', () => {
      this.startPump();
      this.say('play');
    });
    el.addEventListener('pause', () => {
      this.stopPump();
      this.say('pause');
    });
    el.addEventListener('ratechange', () => {
      this.anchor();
      this.say('rate');
    });
    // A seek moves the cursor even while paused.
    el.addEventListener('seeked', () => {
      this.anchor();
      this.push(this.el.currentTime * 1000);
      this.say('seek');
    });
    // requestAnimationFrame stops in a background tab; the media keeps
    // playing and timeupdate keeps firing (about 4 Hz), enough to keep
    // alphaTab's idea of the position from going stale.
    el.addEventListener('timeupdate', () => {
      if (document.hidden && !el.paused) this.push(el.currentTime * 1000);
    });
  }

  get running(): boolean {
    return !this.el.paused;
  }

  onTransport(fn: (event: TransportEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private say(event: TransportEvent) {
    for (const fn of this.listeners) fn(event);
  }

  /** Attach to alphaTab's external-media output. Safe to call again. */
  attach(output: Output) {
    if (this.output === output) return;
    this.output = output;
    output.handler = this;
  }

  /** Let go: stop pushing positions at an output that is somebody else's now. */
  detach() {
    this.stopPump();
    this.el.pause();
    this.output = undefined;
  }

  // --- IExternalMediaHandler ------------------------------------------------

  /** Mix time in ms: the media's own position, there being nothing between. */
  get mixTimeMs(): number {
    return this.el.currentTime * 1000;
  }

  /**
   * Mix time in ms at a given moment on the `performance.now()` clock.
   *
   * A hit is stamped when it arrives, a few milliseconds before anything gets
   * to look at it, so "mix time now" is the wrong answer by that much. Two
   * things have to be undone to get the right one: the delay since it arrived,
   * and the playback rate -- at 80% a millisecond of wall clock is 0.8 ms of
   * mix, and a take recorded slow would otherwise read as played early.
   *
   * Playing, this reads off the same smoothed line the cursor runs on, so a
   * hit and the cursor agree about where they are. Paused, mix time is not
   * moving and the media's own position is the whole answer.
   */
  mixTimeAt(wallMs: number): number {
    if (this.el.paused || this.frame === 0) return this.el.currentTime * 1000;
    return this.anchorMedia + (wallMs - this.anchorWall) * this.el.playbackRate;
  }

  get backingTrackDuration(): number {
    const d = this.el.duration;
    return Number.isFinite(d) && d > 0 ? d * 1000 : this.fallbackDurationMs;
  }

  get playbackRate(): number {
    return this.el.playbackRate;
  }
  set playbackRate(value: number) {
    this.el.playbackRate = value;
  }

  get masterVolume(): number {
    return this.el.volume;
  }
  set masterVolume(value: number) {
    this.el.volume = value;
  }

  seekTo(time: number): void {
    this.el.currentTime = time / 1000;
  }

  play(): void {
    this.el.play().catch((err: unknown) => this.options.onPlayError?.(err));
  }

  pause(): void {
    this.el.pause();
  }

  // --- the clock --------------------------------------------------------------

  private push(mixMs: number) {
    this.output?.updatePosition(Math.max(mixMs, this.floorMs));
  }

  private anchor() {
    this.anchorMedia = this.el.currentTime * 1000;
    this.anchorWall = performance.now();
  }

  private startPump() {
    this.anchor();
    cancelAnimationFrame(this.frame);
    const tick = () => {
      if (this.el.paused) return;
      // `currentTime` advances in steps (an audio render quantum, a video
      // frame) and pushing it raw makes alphaTab's tick jitter across beat
      // boundaries and restart the cursor animation. Run a straight line at
      // the playback rate instead, pinned to the media whenever it strays.
      const now = performance.now();
      const raw = this.el.currentTime * 1000;
      let estimate = this.anchorMedia + (now - this.anchorWall) * this.el.playbackRate;
      const drift = raw - estimate;
      if (Math.abs(drift) > 40) {
        this.anchorMedia = raw;
        this.anchorWall = now;
        estimate = raw;
      } else {
        this.anchorMedia += drift * 0.05;
      }
      this.push(estimate);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private stopPump() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.push(this.el.currentTime * 1000);
  }
}
