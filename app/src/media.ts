// The video element is the master clock; alphaTab follows it.
//
// In PlayerMode.EnabledExternalMedia alphaTab stops producing sound and time.
// It still owns the transport (play/pause/seek/speed) and delegates each of
// those to this handler, and it expects the media's current time to be pushed
// back in through `updatePosition`, which is what moves the cursor.
import type * as alphaTab from '@coderline/alphatab';

type Output = alphaTab.synth.IExternalMediaSynthOutput;

export interface VideoClockOptions {
  /** Called when the browser refuses to start the video (autoplay policy). */
  onPlayError?: (error: unknown) => void;
}

export class VideoClock implements alphaTab.synth.IExternalMediaHandler {
  private output: Output | undefined;
  private frame = 0;
  /** Where the smoothed clock was last pinned to the video, in ms. */
  private anchorMedia = 0;
  /** ...and when, in performance.now() ms. */
  private anchorWall = 0;
  /**
   * Positions before this many ms are reported as this value: the media's
   * count-in has no place in the notation, so the cursor waits on bar 1.
   */
  floorMs = 0;
  /** Used until the video's metadata has loaded and the true duration is known. */
  fallbackDurationMs = 0;
  /**
   * video time - mix time. Positions alphaTab sees are mix time (the beat
   * map's timeline); the video runs this much ahead or behind it.
   */
  offsetMs = 0;

  constructor(
    readonly video: HTMLVideoElement,
    private readonly options: VideoClockOptions = {}
  ) {
    video.addEventListener('play', () => this.startPump());
    video.addEventListener('pause', () => this.stopPump());
    video.addEventListener('ratechange', () => this.anchor());
    // A seek moves the cursor even while paused.
    video.addEventListener('seeked', () => {
      this.anchor();
      this.push(this.video.currentTime * 1000);
    });
    // requestAnimationFrame stops in a background tab; the media keeps
    // playing and timeupdate keeps firing (about 4 Hz), enough to keep
    // alphaTab's idea of the position from going stale.
    video.addEventListener('timeupdate', () => {
      if (document.hidden && !video.paused) this.push(video.currentTime * 1000);
    });
  }

  /** Attach to alphaTab's external-media output. Safe to call again. */
  attach(output: Output) {
    if (this.output === output) return;
    this.output = output;
    output.handler = this;
  }

  // --- IExternalMediaHandler ------------------------------------------------

  /** Mix time in ms for the video's current position. */
  get mixTimeMs(): number {
    return this.video.currentTime * 1000 - this.offsetMs;
  }

  get backingTrackDuration(): number {
    const d = this.video.duration;
    return Number.isFinite(d) && d > 0 ? d * 1000 - this.offsetMs : this.fallbackDurationMs;
  }

  get playbackRate(): number {
    return this.video.playbackRate;
  }
  set playbackRate(value: number) {
    this.video.playbackRate = value;
  }

  get masterVolume(): number {
    return this.video.volume;
  }
  set masterVolume(value: number) {
    this.video.volume = value;
  }

  seekTo(time: number): void {
    this.video.currentTime = (time + this.offsetMs) / 1000;
  }

  play(): void {
    this.video.play().catch((err: unknown) => this.options.onPlayError?.(err));
  }

  pause(): void {
    this.video.pause();
  }

  // --- the clock --------------------------------------------------------------

  /** `videoMs` is the video's own time; alphaTab gets mix time. */
  private push(videoMs: number) {
    this.output?.updatePosition(Math.max(videoMs - this.offsetMs, this.floorMs));
  }

  private anchor() {
    this.anchorMedia = this.video.currentTime * 1000;
    this.anchorWall = performance.now();
  }

  private startPump() {
    this.anchor();
    cancelAnimationFrame(this.frame);
    const tick = () => {
      if (this.video.paused) return;
      // `currentTime` advances in steps (a video frame, an audio render
      // quantum) and pushing it raw makes alphaTab's tick jitter across beat
      // boundaries and restart the cursor animation. Run a straight line at
      // the playback rate instead, pinned to the video whenever it strays.
      const now = performance.now();
      const raw = this.video.currentTime * 1000;
      let estimate = this.anchorMedia + (now - this.anchorWall) * this.video.playbackRate;
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
    this.push(this.video.currentTime * 1000);
  }
}
