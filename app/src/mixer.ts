// The mixer: the two stems and the click over the video, on the video's clock.
//
// The video's own soundtrack is the full mix, so what you hear instead is
// nodrums.wav + drums.wav, each on its own fader, plus a click synthesised on
// the beat map. All of it runs through one Web Audio graph:
//
//   video   -> source -> gain (0)      -+
//   nodrums -> source -> gain (fader)  -+-> master -> analyser -> speakers
//   drums   -> source -> gain (fader)  -+
//   click   ->           gain (fader)  -+
//
// The graph is built on the first user gesture (an AudioContext made before
// one stays suspended), and until then the video plays through its own
// output as before.
//
// Transport stays alphaTab's: it drives the video through `VideoClock`, and
// the stems follow the video element's own play/pause/seek/rate events. The
// stems are on mix time and the video is `VideoClock.offsetMs` away from it,
// so a stem is in the right place when `currentTime == clock.mixTimeMs / 1000`.
// A media element cannot be told to keep that; it drifts by a few ms per
// second, so a 25 ms timer (not rAF: it must go on in a background tab, and
// the click needs it anyway) corrects each stem with hysteresis, because
// `currentTime` is read in steps of an audio render quantum and a naive
// comparison would chase the noise.
import { Click } from './click';
import type { VideoClock } from './media';

export type StemName = 'nodrums' | 'drums';
export type Fader = StemName | 'click';
export const FADERS: readonly Fader[] = ['nodrums', 'drums', 'click'];

/** A stem this far from the video is seeked to it. */
const HARD_SEEK_MS = 250;
/** Between here and HARD_SEEK_MS the stem's rate is nudged towards the video. */
const NUDGE_ABOVE_MS = 20;
/** Under this the stem runs at exactly the master rate again. */
const LOCK_BELOW_MS = 10;
const MAX_NUDGE = 0.03;
const MIN_NUDGE = 0.01;
const TICK_MS = 25;

interface Stem {
  name: StemName;
  el: HTMLAudioElement;
  gain?: GainNode;
  failed: boolean;
}

export interface MixerOptions {
  /** A stem did not load (probably missing from songs/<slug>/stems/). */
  onStemError?: (name: StemName, el: HTMLAudioElement) => void;
}

export class Mixer {
  ctx: AudioContext | undefined;
  /** Taps the sum of everything, for the headless checks. */
  analyser: AnalyserNode | undefined;
  readonly stems: Stem[];
  private click: Click | undefined;
  private videoGain: GainNode | undefined;
  private clickGain: GainNode | undefined;
  private levels: Record<Fader, number> = { nodrums: 1, drums: 1, click: 0 };
  private timer = 0;
  private beats: number[] = [];
  private accent = (_beat: number): boolean => false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly clock: VideoClock,
    private readonly options: MixerOptions = {}
  ) {
    // Slowing down must not drop the pitch: the drummer is practising the
    // song, not a slowed-down recording of it.
    video.preservesPitch = true;
    this.stems = (['nodrums', 'drums'] as const).map((name) => {
      const el = new Audio();
      el.preload = 'auto';
      el.preservesPitch = true;
      el.addEventListener('error', () => this.stemFailed(name, el));
      return { name, el, failed: false };
    });

    video.addEventListener('play', () => this.onPlay());
    // `playing` also fires after a stall, when the video has caught up.
    video.addEventListener('playing', () => this.follow());
    video.addEventListener('waiting', () => this.hold());
    video.addEventListener('pause', () => this.onPause());
    video.addEventListener('seeked', () => this.onSeek());
    video.addEventListener('ratechange', () => this.onRate());

    // Build the graph inside a gesture so the context is allowed to run.
    const unlock = () => {
      this.ensureGraph();
      if (this.ctx?.state === 'running') {
        document.removeEventListener('pointerdown', unlock);
        document.removeEventListener('keydown', unlock);
      }
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
  }

  /** Point the stems at a song and give the click its beat map (mix seconds). */
  load(slug: string, beats: number[], accent: (beat: number) => boolean) {
    this.beats = beats;
    this.accent = accent;
    this.click?.load(beats, accent);
    for (const stem of this.stems) {
      stem.failed = false;
      stem.el.src = `/media/${encodeURIComponent(slug)}/stems/${stem.name}.wav`;
    }
    this.routeVideo();
  }

  level(fader: Fader): number {
    return this.levels[fader];
  }

  /** 0..1, applied at once if the graph exists, remembered for when it does. */
  setLevel(fader: Fader, value: number) {
    const v = Math.min(1, Math.max(0, value));
    this.levels[fader] = v;
    const gain = fader === 'click' ? this.clickGain : this.stems.find((s) => s.name === fader)?.gain;
    if (gain && this.ctx) gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  /** Mix time in seconds, never negative: the stems start at 0. */
  get mixNow(): number {
    return Math.max(0, this.clock.mixTimeMs / 1000);
  }

  ensureGraph() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    const master = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    master.connect(this.analyser).connect(ctx.destination);

    this.videoGain = ctx.createGain();
    ctx.createMediaElementSource(this.video).connect(this.videoGain).connect(master);
    for (const stem of this.stems) {
      stem.gain = ctx.createGain();
      stem.gain.gain.value = this.levels[stem.name];
      ctx.createMediaElementSource(stem.el).connect(stem.gain).connect(master);
    }
    this.clickGain = ctx.createGain();
    this.clickGain.gain.value = this.levels.click;
    this.clickGain.connect(master);
    this.click = new Click(ctx, this.clickGain);
    this.click.load(this.beats, this.accent);
    this.routeVideo();
    if (ctx.state !== 'running') void ctx.resume();
  }

  // --- following the video ------------------------------------------------------

  private onPlay() {
    this.ensureGraph();
    this.follow();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  private onPause() {
    clearInterval(this.timer);
    this.timer = 0;
    this.hold();
  }

  private onSeek() {
    for (const stem of this.stems) this.align(stem);
    this.click?.rewind(this.mixNow);
  }

  private onRate() {
    for (const stem of this.stems) stem.el.playbackRate = this.video.playbackRate;
  }

  /** The video is running: put every stem where it is and start it. */
  private follow() {
    if (this.video.paused) return;
    const mixNow = this.mixNow;
    for (const stem of this.stems) {
      if (stem.failed) continue;
      this.align(stem, mixNow);
      stem.el.playbackRate = this.video.playbackRate;
      stem.el.play().catch(() => {
        /* reported through the element's error event, or a missing gesture */
      });
    }
    this.click?.rewind(mixNow);
  }

  /** The video has stopped (paused, or buffering): the stems wait. */
  private hold() {
    for (const stem of this.stems) stem.el.pause();
    this.click?.forget();
  }

  private align(stem: Stem, mixNow = this.mixNow) {
    if (stem.failed) return;
    stem.el.currentTime = mixNow;
  }

  private tick() {
    if (this.video.paused || !this.ctx) return;
    const mixNow = this.mixNow;
    const rate = this.video.playbackRate;
    for (const stem of this.stems) this.correct(stem, mixNow, rate);
    this.click?.book(mixNow, rate);
  }

  /**
   * Drift correction with hysteresis. `err` > 0 means the stem is ahead of
   * the video, so it is slowed; the nudge grows with the error but never
   * exceeds 3%, which is a time-stretch nobody hears for the second it lasts.
   */
  private correct(stem: Stem, mixNow: number, rate: number) {
    const el = stem.el;
    if (stem.failed || el.seeking || el.readyState < 2 || el.paused) return;
    const err = (el.currentTime - mixNow) * 1000;
    const abs = Math.abs(err);
    if (abs > HARD_SEEK_MS) {
      el.currentTime = mixNow;
      el.playbackRate = rate;
    } else if (abs > NUDGE_ABOVE_MS) {
      const nudge = Math.min(MAX_NUDGE, Math.max(MIN_NUDGE, (abs / HARD_SEEK_MS) * MAX_NUDGE));
      el.playbackRate = rate * (1 - Math.sign(err) * nudge);
    } else if (abs < LOCK_BELOW_MS && el.playbackRate !== rate) {
      el.playbackRate = rate;
    }
  }

  // --- the video's own sound ---------------------------------------------------

  private stemFailed(name: StemName, el: HTMLAudioElement) {
    const stem = this.stems.find((s) => s.name === name)!;
    stem.failed = true;
    this.routeVideo();
    this.options.onStemError?.(name, el);
  }

  /**
   * The video's soundtrack is the full mix; with the stems playing it would
   * double everything, so it is muted. Without any stem it is all there is.
   */
  private routeVideo() {
    if (!this.videoGain || !this.ctx) return;
    const noStems = this.stems.every((s) => s.failed);
    this.videoGain.gain.setTargetAtTime(noStems ? 1 : 0, this.ctx.currentTime, 0.01);
  }
}
