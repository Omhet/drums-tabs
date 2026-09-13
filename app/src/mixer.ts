// The mixer: what you hear, and the picture, on the mix clock.
//
// The clock is an <audio> element on audio/mix.wav (media.ts), so its time is
// mix time. What you hear instead of that mix is nodrums.wav + drums.wav,
// each on its own fader, plus a click synthesised on the beat map. All of it
// runs through one Web Audio graph:
//
//   mix     -> source -> gain (0)      -+
//   nodrums -> source -> gain (fader)  -+-> master -> analyser -> speakers
//   drums   -> source -> gain (fader)  -+
//   click   ->           gain (fader)  -+
//
// The mix's own gain is 0 while the stems play -- it is the same music twice
// -- and 1 when neither stem loads, so a song that has not been separated
// still plays. The graph is built on the first user gesture (an AudioContext
// made before one stays suspended), and until then the mix plays through its
// own output as before.
//
// Transport stays alphaTab's: it drives the clock element through MixClock,
// and everything else follows that element's own play/pause/seek/rate events
// as a Follower (follow.ts) -- the two stems, and the picture when the song
// has a video bound to this timeline. The picture is muted whatever happens:
// its soundtrack is this same mix (and after the practice pivot it is a
// recording of a room with an e-kit in it, which is not music).
//
// The followers are corrected on a 25 ms timer rather than rAF: it must go on
// in a background tab, and the click's lookahead scheduler needs it anyway.
import { Click } from './click';
import { Follower } from './follow';
import type { MixClock } from './media';

export type StemName = 'nodrums' | 'drums';
export type Fader = StemName | 'click';
export const FADERS: readonly Fader[] = ['nodrums', 'drums', 'click'];

const STEMS: readonly StemName[] = ['nodrums', 'drums'];
const TICK_MS = 25;

export interface MixerOptions {
  /** A stem did not load (probably missing from songs/<slug>/stems/). */
  onStemError?: (name: StemName, el: HTMLMediaElement) => void;
  /** The video did not load. Everything else plays on, without a picture. */
  onPictureError?: () => void;
}

/** What the mixer needs to know about the song being loaded. */
export interface MixerSong {
  slug: string;
  /** Whether songs/<slug>/audio/video.mp4 is there to be the picture. */
  video: boolean;
  /** video time - mix time, in ms, from `drums align`. */
  videoOffsetMs: number;
  /** Mix time of every beat the drummer played, in seconds. */
  beats: number[];
  /** Whether beat `i` is the first of a bar, so the click accents it. */
  accent: (beat: number) => boolean;
}

export class Mixer {
  ctx: AudioContext | undefined;
  /** Taps the sum of everything, for the headless checks. */
  analyser: AnalyserNode | undefined;
  /** The two stems: what you actually hear. */
  readonly stems: Follower<StemName>[];
  /** The video, when the song has one. Silent, and only as wide as the stage. */
  readonly picture: Follower;
  /** Everything that follows the clock, in the order it is corrected. */
  readonly followers: Follower[];
  private click: Click | undefined;
  private mixGain: GainNode | undefined;
  private clickGain: GainNode | undefined;
  private stemGain = new Map<StemName, GainNode>();
  private levels: Record<Fader, number> = { nodrums: 1, drums: 1, click: 0 };
  private timer = 0;
  private beats: number[] = [];
  private accent = (_beat: number): boolean => false;

  constructor(
    /** The clock element: alphaTab drives it, everything else follows it. */
    private readonly mixEl: HTMLMediaElement,
    videoEl: HTMLVideoElement,
    private readonly clock: MixClock,
    private readonly options: MixerOptions = {}
  ) {
    mixEl.preservesPitch = true;
    this.stems = STEMS.map(
      (name) => new Follower(name, new Audio(), { onError: () => this.stemFailed(name) })
    );
    videoEl.muted = true;
    this.picture = new Follower('picture', videoEl, {
      onError: () => this.options.onPictureError?.(),
      // A picture is held to a couple of frames, not to a couple of ms (see
      // follow.ts), and it is driven back hard: it starts about a tenth of a
      // second behind the clock, and a silent video can be run 15% fast for a
      // second without anyone seeing it.
      nudgeAboveMs: 60,
      lockBelowMs: 30,
      maxNudge: 0.15,
    });
    this.followers = [...this.stems, this.picture];

    mixEl.addEventListener('play', () => this.onPlay());
    // `playing` also fires after a stall, when the mix has caught up.
    mixEl.addEventListener('playing', () => this.follow());
    mixEl.addEventListener('waiting', () => this.hold());
    mixEl.addEventListener('pause', () => this.onPause());
    mixEl.addEventListener('seeked', () => this.onSeek());
    mixEl.addEventListener('ratechange', () => this.onRate());

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

  /** Point every follower at a song and give the click its beat map. */
  load(song: MixerSong) {
    this.beats = song.beats;
    this.accent = song.accent;
    this.click?.load(song.beats, song.accent);
    const media = (path: string) => `/media/${encodeURIComponent(song.slug)}/${path}`;
    for (const stem of this.stems) stem.load(media(`stems/${stem.name}.wav`));
    this.picture.load(song.video ? media('audio/video.mp4') : null, song.videoOffsetMs);
    this.routeMix();
  }

  /**
   * Where the click goes, so the calibration ritual can put its own click on
   * the same bus -- same fader, same output path, and therefore the same
   * latency as the click you practise to.
   */
  get clickOut(): GainNode | undefined {
    return this.clickGain;
  }

  level(fader: Fader): number {
    return this.levels[fader];
  }

  /** 0..1, applied at once if the graph exists, remembered for when it does. */
  setLevel(fader: Fader, value: number) {
    const v = Math.min(1, Math.max(0, value));
    this.levels[fader] = v;
    const gain = fader === 'click' ? this.clickGain : this.stemGain.get(fader);
    if (gain && this.ctx) gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  /** Mix time in seconds, never negative: the followers start at 0. */
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

    this.mixGain = ctx.createGain();
    ctx.createMediaElementSource(this.mixEl).connect(this.mixGain).connect(master);
    for (const stem of this.stems) {
      const gain = ctx.createGain();
      gain.gain.value = this.levels[stem.name];
      this.stemGain.set(stem.name, gain);
      ctx.createMediaElementSource(stem.el).connect(gain).connect(master);
    }
    this.clickGain = ctx.createGain();
    this.clickGain.gain.value = this.levels.click;
    this.clickGain.connect(master);
    this.click = new Click(ctx, this.clickGain);
    this.click.load(this.beats, this.accent);
    this.routeMix();
    if (ctx.state !== 'running') void ctx.resume();
  }

  // --- following the clock ------------------------------------------------------

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
    const mixNow = this.mixNow;
    for (const f of this.followers) f.align(mixNow);
    this.click?.rewind(mixNow);
  }

  private onRate() {
    for (const f of this.followers) f.setRate(this.mixEl.playbackRate);
  }

  /** The clock is running: put every follower where it is and start it. */
  private follow() {
    if (this.mixEl.paused) return;
    const mixNow = this.mixNow;
    for (const f of this.followers) f.start(mixNow, this.mixEl.playbackRate);
    this.click?.rewind(mixNow);
  }

  /** The clock has stopped (paused, or buffering): the followers wait. */
  private hold() {
    for (const f of this.followers) f.stop();
    this.click?.forget();
  }

  private tick() {
    if (this.mixEl.paused || !this.ctx) return;
    const mixNow = this.mixNow;
    const rate = this.mixEl.playbackRate;
    for (const f of this.followers) f.correct(mixNow, rate);
    this.click?.book(mixNow, rate);
  }

  // --- the mix's own sound ------------------------------------------------------

  private stemFailed(name: StemName) {
    this.routeMix();
    const stem = this.stems.find((s) => s.name === name)!;
    this.options.onStemError?.(name, stem.el);
  }

  /**
   * The clock element plays the full mix; with the stems playing it would
   * double everything, so it is muted. Without any stem it is all there is.
   */
  private routeMix() {
    if (!this.mixGain || !this.ctx) return;
    const noStems = this.stems.every((s) => s.failed);
    this.mixGain.gain.setTargetAtTime(noStems ? 1 : 0, this.ctx.currentTime, 0.01);
  }
}
