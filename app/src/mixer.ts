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
import type { ExpectedNote } from './chart';
import type { PlayClock, TransportEvent } from './clock';
import { SampleKit, type PlayedNote } from './kit';

export type StemName = 'nodrums' | 'drums';
/**
 * `kit` is the written notes, sounded (kit.ts).
 *
 * A fader rather than a mode, and it earns that on a song page too: turn it up
 * over the record and you hear what is *written* against what was *played*,
 * which is the fastest way there is to find a bar that was transcribed wrong.
 */
export type Fader = StemName | 'click' | 'kit';
export const FADERS: readonly Fader[] = ['nodrums', 'drums', 'click', 'kit'];

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
  private kitGain: GainNode | undefined;
  private kit: SampleKit | undefined;
  private stemGain = new Map<StemName, GainNode>();
  // The kit starts at zero for the same reason the click does: over a record
  // it is a comparison you ask for, not a thing that should start happening.
  // The exercise page turns it up (practice.ts `ensureKitAudible`).
  private levels: Record<Fader, number> = { nodrums: 1, drums: 1, click: 0, kit: 0 };
  private timer = 0;
  /** Drops the current clock's transport subscription when it is swapped out. */
  private unlisten: () => void = () => {};
  /** True while an exercise is playing with no recording behind it. */
  private solo = false;
  /** The part the kit should play, kept for when the graph exists. */
  private pending: readonly ExpectedNote[] | undefined;
  /**
   * Who wants telling about each note.
   *
   * Held here rather than on the kit, because the kit is built on the first
   * user gesture and a page opened straight onto an exercise subscribes before
   * that -- and because replacing the kit must not silently drop the avatar.
   */
  private readonly noteListeners = new Set<(note: PlayedNote) => void>();
  private beats: number[] = [];
  private accent = (_beat: number): boolean => false;

  constructor(
    /** The clock element: alphaTab drives it, everything else follows it. */
    private readonly mixEl: HTMLMediaElement,
    videoEl: HTMLVideoElement,
    private clock: PlayClock,
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

    // Transport comes off the clock, not off the element: an exercise plays on
    // a clock that is not an element at all (timer-clock.ts), and the click has
    // to follow it exactly as the stems follow the mix.
    this.unlisten = clock.onTransport((e) => this.onTransport(e));
    // Stalling is the exception, and stays on the element: it is a fact about
    // a media file arriving, not about a transport.
    mixEl.addEventListener('playing', () => this.follow());
    mixEl.addEventListener('waiting', () => this.hold());

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

  /**
   * Follow a different timeline (transport.ts).
   *
   * The followers are stopped on the way out rather than left running against
   * a clock that is no longer telling them anything -- and the click forgets
   * what it had booked, because those blips were for a beat map that is about
   * to be replaced.
   */
  setClock(clock: PlayClock) {
    if (clock === this.clock) return;
    this.onPause();
    this.unlisten();
    this.clock = clock;
    this.unlisten = clock.onTransport((e) => this.onTransport(e));
  }

  /** Point every follower at a song and give the click its beat map. */
  load(song: MixerSong) {
    this.solo = false;
    this.beats = song.beats;
    this.accent = song.accent;
    this.click?.load(song.beats, song.accent);
    const media = (path: string) => `/media/${encodeURIComponent(song.slug)}/${path}`;
    for (const stem of this.stems) stem.load(media(`stems/${stem.name}.wav`));
    this.picture.load(song.video ? media('audio/video.mp4') : null, song.videoOffsetMs);
    this.routeMix();
  }

  /**
   * An exercise with no song behind it: a beat map for the click and nothing
   * to follow.
   *
   * The stems and the picture are unloaded rather than left holding the last
   * song's buffers -- an element that still has a `src` is an element that can
   * still be started by something, and the whole point here is that there is
   * no recording in the room.
   */
  loadSolo(beats: number[], accent: (beat: number) => boolean) {
    this.solo = true;
    this.beats = beats;
    this.accent = accent;
    this.click?.load(beats, accent);
    for (const stem of this.stems) stem.load(null);
    this.picture.load(null);
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

  /**
   * The written notes, to be sounded under whatever is playing.
   *
   * Remembered when the graph does not exist yet: the part is loaded when an
   * exercise is armed, and the AudioContext is not built until the first
   * gesture -- which, on a page opened straight onto an exercise, comes after.
   */
  loadKit(notes: readonly ExpectedNote[]) {
    this.pending = notes;
    this.kit?.load(notes);
  }

  /** Each note as it is booked: the avatar's input (kit.ts). */
  onNote(fn: (note: PlayedNote) => void): () => void {
    this.noteListeners.add(fn);
    return () => this.noteListeners.delete(fn);
  }

  /** Instruments the chart asks for that the bank cannot play. */
  unplayable(notes: readonly ExpectedNote[]): string[] {
    return this.kit?.unplayable(notes) ?? [];
  }

  level(fader: Fader): number {
    return this.levels[fader];
  }

  /** 0..1, applied at once if the graph exists, remembered for when it does. */
  setLevel(fader: Fader, value: number) {
    const v = Math.min(1, Math.max(0, value));
    this.levels[fader] = v;
    const gain =
      fader === 'click' ? this.clickGain : fader === 'kit' ? this.kitGain : this.stemGain.get(fader);
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

    this.kitGain = ctx.createGain();
    this.kitGain.gain.value = this.levels.kit;
    this.kitGain.connect(master);
    this.kit = new SampleKit(ctx, this.kitGain);
    this.kit.onNote((note) => {
      for (const fn of this.noteListeners) fn(note);
    });
    // Fetched once and kept. Not awaited: a note whose buffer has not arrived
    // is skipped, and the bank is a few hundred kilobytes off localhost.
    void this.kit.ready();
    if (this.pending) this.kit.load(this.pending);
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

  private onTransport(event: TransportEvent) {
    if (event === 'play') return this.onPlay();
    if (event === 'pause') return this.onPause();
    if (event === 'rate') return this.onRate();
    const mixNow = this.mixNow;
    for (const f of this.followers) f.align(mixNow);
    this.click?.rewind(mixNow);
    this.kit?.rewind(mixNow);
  }

  private onRate() {
    for (const f of this.followers) f.setRate(this.clock.playbackRate);
  }

  /** The clock is running: put every follower where it is and start it. */
  private follow() {
    if (!this.clock.running) return;
    const mixNow = this.mixNow;
    for (const f of this.followers) f.start(mixNow, this.clock.playbackRate);
    this.click?.rewind(mixNow);
    this.kit?.rewind(mixNow);
  }

  /** The clock has stopped (paused, or buffering): the followers wait. */
  private hold() {
    for (const f of this.followers) f.stop();
    this.click?.forget();
    this.kit?.forget();
  }

  private tick() {
    if (!this.clock.running || !this.ctx) return;
    const mixNow = this.mixNow;
    const rate = this.clock.playbackRate;
    for (const f of this.followers) f.correct(mixNow, rate);
    this.click?.book(mixNow, rate);
    this.kit?.book(mixNow, rate);
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
    // With nothing loaded there is no mix to fall back to, and the element is
    // still holding whatever song was open last: silence is the only honest
    // setting.
    const noStems = !this.solo && this.stems.every((s) => s.failed);
    this.mixGain.gain.setTargetAtTime(noStems ? 1 : 0, this.ctx.currentTime, 0.01);
  }
}
