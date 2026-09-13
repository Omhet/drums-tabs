// One media element kept on the mix clock.
//
// The master clock is an <audio> element on the song's mix (media.ts), so the
// clock's time *is* mix time: the timeline the beat map, the stems and the
// notation all refer to. Everything else that plays on the page follows it --
// the two stems, and the picture when the song has a video bound to this
// timeline -- and each of them is one of these.
//
// A media element cannot be told to hold a position. It drifts by a few ms
// per second, and its `currentTime` is only readable in steps of an audio
// render quantum, so comparing the two naively chases noise rather than
// drift. The correction therefore has hysteresis: a hard seek when the
// follower is far away, a small rate nudge when it is close, and exactly the
// master's rate once it has arrived. Nothing calls it on a timer by itself --
// the mixer already runs one, and it drives every follower from there.
//
// `offsetMs` is what lets a video follow the same clock as the stems: the
// beat map and the stems are on mix.wav's timeline, and a separately
// downloaded video is cut a few tens of milliseconds differently (`drums
// align` measures it). Mix time plus that offset is where the picture goes.

/** A follower this far from where it belongs is seeked there. */
const HARD_SEEK_MS = 250;
/** Default: between here and HARD_SEEK_MS its rate is nudged towards the clock. */
const NUDGE_ABOVE_MS = 20;
/** Default: under this it runs at exactly the master rate again. */
const LOCK_BELOW_MS = 10;
const MAX_NUDGE = 0.03;
const MIN_NUDGE = 0.01;

export interface FollowerOptions {
  /** It could not load what it was pointed at (probably missing from songs/). */
  onError?: () => void;
  /**
   * How far out it has to be before its rate is nudged, and how close before
   * it is left alone again, in ms.
   *
   * The defaults suit an audio element, which reports its time in render
   * quanta of a couple of milliseconds and lands on a seek exactly. A video
   * element reports the time of the frame on screen instead, roughly a frame
   * behind where it actually is, so holding a picture closer than a couple of
   * frames is chasing the frame rate rather than drift.
   */
  nudgeAboveMs?: number;
  lockBelowMs?: number;
  /**
   * The largest rate nudge, as a fraction. 3% is the most you can do to audio
   * without anyone hearing a time-stretch; a silent picture has no such limit,
   * and needs the room: starting a video element takes it about a tenth of a
   * second to present its first frame, and the clock does not wait, so it
   * begins every playback that far behind and has to be driven back.
   */
  maxNudge?: number;
}

export class Follower<Name extends string = string> {
  /** element time - mix time, in ms. 0 for anything cut from the mix itself. */
  offsetMs = 0;
  /** The source failed to load; it is skipped until pointed somewhere else. */
  failed = false;
  /** False while it has nothing to play, so clearing a src is not a failure. */
  private active = false;

  constructor(
    readonly name: Name,
    readonly el: HTMLMediaElement,
    private readonly options: FollowerOptions = {}
  ) {
    el.preload = 'auto';
    // Slowing down must not drop the pitch: the drummer is practising the
    // song, not a slowed-down recording of it.
    el.preservesPitch = true;
    el.addEventListener('error', () => {
      if (!this.active) return;
      this.failed = true;
      this.options.onError?.();
    });
  }

  /** Point it at `url` (or at nothing), `offsetMs` away from mix time. */
  load(url: string | null, offsetMs = 0) {
    this.offsetMs = offsetMs;
    this.failed = false;
    this.active = url !== null;
    if (url === null) {
      this.el.pause();
      // Clearing the attribute is not enough on its own: the element keeps
      // playing and holding its buffer until the load algorithm is re-run.
      this.el.removeAttribute('src');
      this.el.load();
    } else {
      this.el.src = url;
    }
  }

  /** True when it has something to play and it loaded. */
  get following(): boolean {
    return this.active && !this.failed;
  }

  /** Its own time, in seconds, for mix time `mixNow` (also in seconds). */
  target(mixNow: number): number {
    return Math.max(0, mixNow + this.offsetMs / 1000);
  }

  /** How far ahead of where it belongs it is, in ms. */
  errorMs(mixNow: number): number {
    return (this.el.currentTime - this.target(mixNow)) * 1000;
  }

  /** Put it exactly where it belongs. */
  align(mixNow: number) {
    if (this.following) this.el.currentTime = this.target(mixNow);
  }

  /** Place it at `mixNow` and start it at `rate`. */
  start(mixNow: number, rate: number) {
    if (!this.following) return;
    this.align(mixNow);
    this.el.playbackRate = rate;
    this.el.play().catch(() => {
      /* reported through the element's error event, or a missing gesture */
    });
  }

  /** The clock has stopped (paused, or buffering): wait where you are. */
  stop() {
    this.el.pause();
  }

  setRate(rate: number) {
    if (this.following) this.el.playbackRate = rate;
  }

  /**
   * Drift correction with hysteresis. A positive error means the follower is
   * ahead of the clock, so it is slowed; the nudge grows with the error but
   * never exceeds `maxNudge` -- 3% by default, which is a time-stretch nobody
   * hears for the second it lasts.
   */
  correct(mixNow: number, rate: number) {
    const el = this.el;
    if (!this.following || el.seeking || el.readyState < 2 || el.paused) return;
    const nudgeAbove = this.options.nudgeAboveMs ?? NUDGE_ABOVE_MS;
    const lockBelow = this.options.lockBelowMs ?? LOCK_BELOW_MS;
    const maxNudge = this.options.maxNudge ?? MAX_NUDGE;
    const err = this.errorMs(mixNow);
    const abs = Math.abs(err);
    if (abs > HARD_SEEK_MS) {
      el.currentTime = this.target(mixNow);
      el.playbackRate = rate;
    } else if (abs > nudgeAbove) {
      const nudge = Math.min(maxNudge, Math.max(MIN_NUDGE, (abs / HARD_SEEK_MS) * maxNudge));
      el.playbackRate = rate * (1 - Math.sign(err) * nudge);
    } else if (abs < lockBelow && el.playbackRate !== rate) {
      el.playbackRate = rate;
    }
  }
}
