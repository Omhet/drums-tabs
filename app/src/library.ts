// The library (design/lamp/Lamp-09): the songs, as the home page.
//
// One row a song, 200 tall: its picture (a frame grabbed from its video) or
// the "no video" staff, "Artist — Title", how long, how fast, how many bars,
// and where you left off -- read from what each song remembers of itself
// (main.ts `SongMemory`, B5). The one played last is outlined in brass and its
// Resume pill is the lit one. ↑ ↓ choose, Enter opens; a click opens too. A
// song opens on the route it always had, `#<slug>`; this page is the route
// with no song in it (`#` or `#/songs`).
import type { Section } from 'virtual:songs';
import { rangeName, type LoopMemory } from './loop';

/** What a song remembers of itself (main.ts keeps one per song). */
export interface SongMemory {
  /** Percent of the record's tempo. */
  tempo?: number;
  loop?: LoopMemory;
  /** When it last started playing, `Date.now()`; never played without it. */
  played?: number;
}

/** A row's song: what the catalogue says about it, and what it remembers. */
export interface LibrarySong {
  slug: string;
  artist: string;
  title: string;
  seconds: number;
  bpm: number;
  bars: number;
  video: boolean;
  sections: readonly Section[];
  memory: SongMemory;
}

// --- the words, pure and tested (scripts/test-library.mjs) -----------------------

/** `2:03`. */
export function lengthSaid(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** `2:03 · 130 BPM · 65 bars · video`: what is known, in that order. */
export function factsSaid(song: Pick<LibrarySong, 'seconds' | 'bpm' | 'bars' | 'video'>): string {
  return [
    song.seconds > 0 ? lengthSaid(song.seconds) : '',
    song.bpm > 0 ? `${Math.round(song.bpm)} BPM` : '',
    song.bars > 0 ? `${song.bars} bars` : '',
    song.video ? 'video' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Where you left off: "chorus looped at 80%", "bars 9–12 looped at 70%",
 * "whole song at 85%" -- or undefined for a song never played, which the row
 * says as "not played yet". Opening a song is not playing it.
 */
export function leftOffSaid(memory: SongMemory, sections: readonly Section[]): string | undefined {
  if (!memory.played) return undefined;
  const tempo = typeof memory.tempo === 'number' ? memory.tempo : 100;
  const r = memory.loop?.on ? memory.loop.range : undefined;
  if (!r) return `whole song at ${tempo}%`;
  const name = rangeName(sections, r);
  const what = name.startsWith('bar')
    ? r.startBar === r.endBar
      ? `bar ${r.startBar}`
      : `bars ${r.startBar}–${r.endBar}`
    : name;
  return `${what} looped at ${tempo}%`;
}

/** The slug of the song played last, if any was. */
export function lastPlayed(songs: readonly Pick<LibrarySong, 'slug' | 'memory'>[]): string | undefined {
  let best: { slug: string; at: number } | undefined;
  for (const s of songs) {
    const at = s.memory.played ?? 0;
    if (at > 0 && (!best || at > best.at)) best = { slug: s.slug, at };
  }
  return best?.slug;
}

// --- the page -------------------------------------------------------------------------

/** What the library asks of the page (main.ts). */
export interface LibraryHost {
  /** The songs, as they are now: the memory changes every time one is played. */
  songs(): LibrarySong[];
  /** Open a song: its route. */
  href(slug: string): string;
}

const SVG = 'http://www.w3.org/2000/svg';
/** Where in a video its picture is taken from: past the titles, into the band. */
const FRAME_AT = 0.3;

export class Library {
  private readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly host: LibraryHost;
  /** A frame of each song's video, grabbed once a page load. */
  private readonly frames = new Map<string, Promise<HTMLCanvasElement | undefined>>();

  constructor(el: HTMLElement, list: HTMLElement, host: LibraryHost) {
    this.el = el;
    this.list = list;
    this.host = host;
  }

  get shown(): boolean {
    return !this.el.hidden;
  }

  /** Draw the rows from what the songs remember now, and show the page. */
  show(focus?: string) {
    const songs = this.host.songs();
    const last = lastPlayed(songs);
    this.list.replaceChildren(...songs.map((s) => this.row(s, s.slug === last)));
    this.el.hidden = false;
    // The row to start from: the song just left, else the one played last.
    const start = focus ?? last ?? songs[0]?.slug;
    this.rows().find((r) => r.dataset.slug === start)?.focus({ preventScroll: true });
  }

  hide() {
    this.el.hidden = true;
  }

  /** ↑ ↓ choose (wrapping at neither end), Home and End the ends. Enter is the link's own. */
  key(code: string): boolean {
    const rows = this.rows();
    if (rows.length === 0) return false;
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const to =
      code === 'ArrowUp'
        ? Math.max(0, at - 1)
        : code === 'ArrowDown'
          ? at < 0
            ? 0
            : Math.min(rows.length - 1, at + 1)
          : code === 'Home'
            ? 0
            : code === 'End'
              ? rows.length - 1
              : undefined;
    if (to === undefined) return false;
    rows[to]!.focus();
    return true;
  }

  private rows(): HTMLElement[] {
    return [...this.list.querySelectorAll<HTMLElement>('.lib-row')];
  }

  private row(song: LibrarySong, last: boolean): HTMLElement {
    const a = document.createElement('a');
    a.className = 'lib-row';
    a.href = this.host.href(song.slug);
    a.dataset.slug = song.slug;
    a.toggleAttribute('data-last', last);

    const pic = document.createElement('div');
    pic.className = 'lib-pic';
    if (song.video) {
      void this.frame(song.slug).then((c) => {
        if (c) pic.replaceChildren(c);
      });
    } else {
      pic.classList.add('none');
      pic.append(staffGlyph(), Object.assign(document.createElement('span'), { textContent: 'no video' }));
    }

    const words = document.createElement('div');
    words.className = 'lib-words';
    const name = document.createElement('div');
    name.className = 'lib-name';
    const artist = document.createElement('span');
    artist.className = 'lib-artist';
    artist.textContent = `${song.artist} —`;
    const title = document.createElement('b');
    title.textContent = song.title;
    name.append(artist, ' ', title);
    const facts = document.createElement('div');
    facts.className = 'lib-facts';
    facts.textContent = factsSaid(song);
    words.append(name, facts);

    const end = document.createElement('div');
    end.className = 'lib-end';
    const left = leftOffSaid(song.memory, song.sections);
    const where = document.createElement('div');
    where.className = 'lib-left';
    if (left) {
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.textContent = 'where you left off';
      const said = document.createElement('div');
      said.className = 'said';
      said.textContent = left;
      where.append(cap, said);
    } else {
      where.classList.add('never');
      where.textContent = 'not played yet';
    }
    // A pill to look at, not a second target: the whole row is the link.
    const pill = document.createElement('span');
    pill.className = 'lib-go';
    pill.textContent = left ? 'Resume' : 'Play';
    end.append(where, pill);

    a.append(pic, words, end);
    a.setAttribute('aria-label', `${song.title}, ${song.artist}. ${facts.textContent}. ${left ?? 'Not played yet'}.`);
    return a;
  }

  /**
   * A frame from the song's video, 30% in, drawn on a canvas and the video let
   * go: a <video> preloading its metadata and one seek, not a poster file to
   * keep up to date. Undefined if the video will not give one.
   */
  private frame(slug: string): Promise<HTMLCanvasElement | undefined> {
    let got = this.frames.get(slug);
    if (!got) {
      got = grabFrame(`/media/${encodeURIComponent(slug)}/audio/video.mp4`);
      this.frames.set(slug, got);
    }
    // The same canvas cannot be in two rows; a redraw of the page takes a copy.
    return got.then((c) => (c ? copy(c) : undefined));
  }
}

function grabFrame(src: string): Promise<HTMLCanvasElement | undefined> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    const done = (c: HTMLCanvasElement | undefined) => {
      v.removeAttribute('src');
      v.load();
      resolve(c);
    };
    v.addEventListener('loadedmetadata', () => {
      v.currentTime = (Number.isFinite(v.duration) ? v.duration : 60) * FRAME_AT;
    });
    v.addEventListener('seeked', () => {
      const c = document.createElement('canvas');
      // Twice the row's 320x180: the screen is at 175%.
      c.width = 640;
      c.height = 360;
      const g = c.getContext('2d');
      if (!g || !v.videoWidth) return done(undefined);
      // Cover, as the frame draws it: the middle of a wider picture.
      const scale = Math.max(c.width / v.videoWidth, c.height / v.videoHeight);
      const w = v.videoWidth * scale;
      const h = v.videoHeight * scale;
      g.drawImage(v, (c.width - w) / 2, (c.height - h) / 2, w, h);
      done(c);
    });
    v.addEventListener('error', () => done(undefined));
    v.src = src;
  });
}

function copy(c: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = c.width;
  out.height = c.height;
  out.getContext('2d')?.drawImage(c, 0, 0);
  return out;
}

/** Lamp-09's "no video": five staff lines and two notes. */
function staffGlyph(): SVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 120 60');
  svg.setAttribute('width', '120');
  svg.setAttribute('height', '60');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.innerHTML =
    '<path d="M0 10h120M0 20h120M0 30h120M0 40h120M0 50h120"/>' +
    '<ellipse cx="34" cy="35" rx="7" ry="5" fill="currentColor" stroke="none"/><path d="M41 35V4"/>' +
    '<ellipse cx="78" cy="25" rx="7" ry="5" fill="currentColor" stroke="none"/><path d="M85 25V2"/>';
  return svg;
}
