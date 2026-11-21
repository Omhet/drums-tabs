// Ableton Live set -> tab.mid, and the song catalogue as a virtual module.
//
// A Live set (.als) is gzipped XML with every MIDI note in it, so "export" is
// just Ctrl+S in Ableton: this plugin watches the set named in song.toml,
// pulls the arrangement clips off the drum track, and rewrites
// songs/<slug>/tab.mid. A tab.mid exported by hand from Ableton is the same
// file, so the browser side never knows which way it was made.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import { parseMidi, writeMidi, type MidiData, type MidiEvent } from 'midi-file';
import { parse as parseToml } from 'smol-toml';
import type { Plugin, ViteDevServer } from 'vite';

/** One `[[section]]` block: a stretch of bars you can practise on its own. */
export interface Section {
  name: string;
  /** 1-based and inclusive, as written in song.toml. */
  start_bar: number;
  end_bar: number;
}

export interface SongMeta {
  slug: string;
  /** `[song]`: the band, and the song's own short title ("Blur", "Song 2"). */
  artist: string;
  title: string;
  /** Bars in the notation: the beat map's, or further if tab.mid has notes past it. */
  bars: number;
  /** The record's tempo from the beat map, in BPM; 0 without one. */
  bpm: number;
  /** How long the record is, in seconds (`[source] duration`). */
  seconds: number;
  /** MIDI key -> instrument name (kick, snare, hihat_closed, ...). */
  map: Record<number, string>;
  /** The `[[section]]` blocks, in the order they are written. */
  sections: Section[];
  /**
   * What those blocks are, as one string a take can be pinned to.
   *
   * `chartHash` covers tab.mid, which knows nothing about sections: move a
   * boundary and the cell grid changes shape while the chart hash stays
   * identical, so a take needs both (practice-plan Q8). The recipe is the
   * compact JSON of `[name, start_bar, end_bar]` triples in file order, sha256,
   * first 16 hex, prefixed -- matching `chart_hash` in pipeline/chart.py so the
   * Python side can compute the same string when it needs to.
   */
  sectionsHash: string;
  /**
   * Present when the notation is authored in a Live set.
   *
   * `barOffset` is which bar of that set holds bar 1 of the song, minus one:
   * 0 when the set starts on the first written bar, 3 when it carries three
   * bars of intro in front of it. See `shiftBars`.
   */
  author?: { als: string; track?: string; barOffset: number };
  /**
   * Which media is on disk. Both are untracked and built by the pipeline, so
   * either can be absent: without `mix` the song cannot play at all (it is the
   * clock), without `video` there is no picture and the notation has the stage
   * to itself.
   */
  media: { mix: boolean; video: boolean };
}

const VIRTUAL_ID = 'virtual:songs';
const RESOLVED_ID = '\0' + VIRTUAL_ID;
const TICKS_PER_BEAT = 480;

// --- song.toml ---------------------------------------------------------------

export function readSongs(songsDir: string): SongMeta[] {
  if (!existsSync(songsDir)) return [];
  const songs: SongMeta[] = [];
  for (const slug of readdirSync(songsDir).sort()) {
    const tomlPath = join(songsDir, slug, 'song.toml');
    if (!existsSync(tomlPath)) continue;
    const toml = parseToml(readFileSync(tomlPath, 'utf-8')) as Record<string, unknown>;
    const named = (toml.song ?? {}) as Record<string, unknown>;
    const artist = typeof named.artist === 'string' ? named.artist.trim() : '';
    const title = typeof named.title === 'string' ? named.title.trim() : '';
    // Required: the header and the library say "Song 2 — Blur", and a slug in
    // their place would be a song nobody named.
    if (!artist || !title) {
      throw new Error(`${tomlPath}: [song] needs an artist and a title ("Blur", "Song 2")`);
    }
    const source = (toml.source ?? {}) as Record<string, unknown>;
    const author = toml.author as
      | { als?: string; track?: string; bar_offset?: number }
      | undefined;
    const map: Record<number, string> = {};
    for (const [key, name] of Object.entries((toml.midi_map ?? {}) as Record<string, string>)) {
      map[Number(key)] = String(name);
    }
    const sections: Section[] = ((toml.section ?? []) as Record<string, unknown>[]).map((s) => ({
      name: String(s.name ?? ''),
      start_bar: Number(s.start_bar ?? 0),
      end_bar: Number(s.end_bar ?? 0),
    }));
    const grid = readGrid(join(songsDir, slug));
    songs.push({
      slug,
      artist,
      title,
      bars: notationBars(join(songsDir, slug, 'tab.mid'), grid),
      bpm: grid?.bpm ?? 0,
      seconds: Number(source.duration ?? 0),
      map,
      sections,
      sectionsHash: sectionsHash(sections),
      author: author?.als
        ? { als: author.als, track: author.track, barOffset: Number(author.bar_offset ?? 0) }
        : undefined,
      media: {
        mix: existsSync(join(songsDir, slug, 'audio', 'mix.wav')),
        video: existsSync(join(songsDir, slug, 'audio', 'video.mp4')),
      },
    });
  }
  return songs;
}

/** What the library needs from grid.lock.json: the bars it maps, the tempo, the meter. */
function readGrid(songDir: string): { bars: number; bpm: number; beatsPerBar: number } | undefined {
  const path = join(songDir, 'grid.lock.json');
  if (!existsSync(path)) return undefined;
  const g = JSON.parse(readFileSync(path, 'utf-8')) as {
    bar_count?: number;
    score?: { bpm?: number };
    meter?: { beats_per_bar?: number };
  };
  return { bars: g.bar_count ?? 0, bpm: g.score?.bpm ?? 0, beatsPerBar: g.meter?.beats_per_bar ?? 4 };
}

/**
 * How many bars the player will engrave: the beat map's, or as far as tab.mid
 * has notes if that is further (midi-tab.ts `barCount`) -- One For The Road's
 * chart runs a bar past its beat map, and the library says 73 as the player does.
 */
export function notationBars(tabPath: string, grid: { bars: number; beatsPerBar: number } | undefined): number {
  const mapped = grid?.bars ?? 0;
  if (!existsSync(tabPath)) return mapped;
  const midi = parseMidi(readFileSync(tabPath));
  const perBar = midi.header.ticksPerBeat! * (grid?.beatsPerBar ?? 4);
  let last = -1;
  for (const track of midi.tracks) {
    let tick = 0;
    for (const event of track) {
      tick += event.deltaTime;
      if (event.type === 'noteOn' && event.velocity > 0) last = Math.max(last, Math.floor(tick / perBar));
    }
  }
  return Math.max(mapped, last + 1);
}

/** See `SongMeta.sectionsHash` for the recipe and why it is not the chart hash. */
export function sectionsHash(sections: Section[]): string {
  const shape = JSON.stringify(sections.map((s) => [s.name, s.start_bar, s.end_bar]));
  return 'sha256:' + createHash('sha256').update(shape, 'utf-8').digest('hex').slice(0, 16);
}

// --- .als -> notes -----------------------------------------------------------

interface Note {
  /** Position in beats (quarter notes) from bar 1. */
  beat: number;
  duration: number;
  key: number;
  velocity: number;
}

type Xml = Record<string, any>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: true,
  isArray: (name) =>
    ['MidiTrack', 'AudioTrack', 'ReturnTrack', 'MidiClip', 'KeyTrack', 'MidiNoteEvent'].includes(name),
});

const num = (node: Xml | undefined, fallback = 0): number => {
  const v = node?.Value;
  return typeof v === 'number' ? v : v == null ? fallback : Number(v);
};

export function extractNotes(alsPath: string, trackName?: string): { notes: Note[]; track: string } {
  const xml = gunzipSync(readFileSync(alsPath)).toString('utf-8');
  const doc = parser.parse(xml) as Xml;
  const tracks: Xml[] = doc.Ableton?.LiveSet?.Tracks?.MidiTrack ?? [];
  if (tracks.length === 0) throw new Error(`${alsPath}: no MIDI tracks in the set`);

  const nameOf = (t: Xml) => String(t.Name?.EffectiveName?.Value ?? '');
  const track = trackName ? tracks.find((t) => nameOf(t) === trackName) : tracks[0];
  if (!track) {
    throw new Error(
      `${alsPath}: no MIDI track named ${JSON.stringify(trackName)} (have: ${tracks.map(nameOf).join(', ')})`
    );
  }

  const clips: Xml[] =
    track.DeviceChain?.MainSequencer?.ClipTimeable?.ArrangerAutomation?.Events?.MidiClip ?? [];
  const notes: Note[] = [];
  for (const clip of clips) {
    const start = num(clip.CurrentStart);
    const end = num(clip.CurrentEnd);
    const loopStart = num(clip.Loop?.LoopStart);
    const loopEnd = num(clip.Loop?.LoopEnd, loopStart + (end - start));
    const loopOn = clip.Loop?.LoopOn?.Value === true;
    const loopLength = loopEnd - loopStart;
    if (loopLength <= 0) continue;
    // An arrangement clip plays [loopStart, loopEnd) of its own timeline from
    // `start`; if looping is on and the clip is longer than the loop, the
    // region repeats until `end`.
    const repeats = loopOn ? Math.ceil((end - start) / loopLength) : 1;

    const keyTracks: Xml[] = clip.Notes?.KeyTracks?.KeyTrack ?? [];
    for (const keyTrack of keyTracks) {
      const key = num(keyTrack.MidiKey);
      const events: Xml[] = keyTrack.Notes?.MidiNoteEvent ?? [];
      for (const event of events) {
        if (event.IsEnabled === false) continue;
        const time = Number(event.Time);
        if (time < loopStart || time >= loopEnd) continue;
        for (let k = 0; k < repeats; k++) {
          const beat = start + k * loopLength + (time - loopStart);
          if (beat >= end) break;
          notes.push({
            beat,
            duration: Math.max(Number(event.Duration) || 0, 1 / 32),
            key,
            velocity: Math.max(1, Math.min(127, Math.round(Number(event.Velocity) || 100))),
          });
        }
      }
    }
  }
  notes.sort((a, b) => a.beat - b.beat || a.key - b.key);
  return { notes, track: nameOf(track) };
}

// --- notes -> tab.mid --------------------------------------------------------

/**
 * Move the set back so that its bar `1 + bars` becomes bar 1 of the notation.
 *
 * Notation bar 1 is the beat at `grid.bar_one_beat` -- the first kick or snare
 * -- and the count-in in front of it has no place in the score. A set written
 * against the record from the top of the track instead starts where the
 * *music* starts, so its first bars are the intro and every note in it is that
 * many bars late. `bar_offset` in `[author]` is how many, and this takes them
 * off.
 *
 * Notes landing before bar 1 are dropped rather than clamped onto it: they are
 * intro the score does not have, and stacking them on the downbeat would
 * invent a hit nobody played there. The count comes back so the log can say so
 * -- a set whose offset is one bar too big loses real notes, and silently is
 * the wrong way to find that out.
 */
export function shiftBars(
  notes: Note[],
  bars: number,
  beatsPerBar = 4
): { notes: Note[]; dropped: number } {
  if (!bars) return { notes, dropped: 0 };
  const moved = notes.map((note) => ({ ...note, beat: note.beat - bars * beatsPerBar }));
  const kept = moved.filter((note) => note.beat >= 0);
  return { notes: kept, dropped: moved.length - kept.length };
}

export function notesToMidi(notes: Note[], opts: { bpm: number; name: string }): Uint8Array {
  type Timed = { tick: number; event: MidiEvent };
  const timed: Timed[] = [];
  for (const note of notes) {
    const on = Math.round(note.beat * TICKS_PER_BEAT);
    const off = Math.max(on + 1, Math.round((note.beat + note.duration) * TICKS_PER_BEAT));
    timed.push({ tick: on, event: { deltaTime: 0, type: 'noteOn', channel: 9, noteNumber: note.key, velocity: note.velocity } });
    timed.push({ tick: off, event: { deltaTime: 0, type: 'noteOff', channel: 9, noteNumber: note.key, velocity: 0 } });
  }
  // Stable: offs before ons at the same tick so a re-hit is not swallowed.
  timed.sort((a, b) => a.tick - b.tick || (a.event.type === 'noteOff' ? -1 : 1) - (b.event.type === 'noteOff' ? -1 : 1));

  const track: MidiEvent[] = [
    { deltaTime: 0, type: 'trackName', text: opts.name },
    { deltaTime: 0, type: 'setTempo', microsecondsPerBeat: Math.round(60_000_000 / opts.bpm) },
    { deltaTime: 0, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 },
  ];
  let last = 0;
  for (const { tick, event } of timed) {
    track.push({ ...event, deltaTime: tick - last } as MidiEvent);
    last = tick;
  }
  track.push({ deltaTime: 0, type: 'endOfTrack' });

  const data: MidiData = { header: { format: 0, numTracks: 1, ticksPerBeat: TICKS_PER_BEAT }, tracks: [track] };
  return Uint8Array.from(writeMidi(data));
}

// --- the plugin --------------------------------------------------------------

function readBpm(songDir: string): number {
  const straight = join(songDir, 'stems', 'straight.json');
  if (existsSync(straight)) {
    const bpm = Number((JSON.parse(readFileSync(straight, 'utf-8')) as { bpm?: number }).bpm);
    if (bpm > 0) return bpm;
  }
  return 120;
}

/** Regenerate tab.mid for one song. Returns a one-line summary for the log. */
export function syncSong(songsDir: string, song: SongMeta): string {
  if (!song.author) return `${song.slug}: no [author] section, tab.mid left alone`;
  if (!existsSync(song.author.als)) return `${song.slug}: Live set not found at ${song.author.als}`;
  const songDir = join(songsDir, song.slug);
  const read = extractNotes(song.author.als, song.author.track);
  const { notes, dropped } = shiftBars(read.notes, song.author.barOffset);
  const track = read.track;
  const bytes = notesToMidi(notes, { bpm: readBpm(songDir), name: track });
  const dest = join(songDir, 'tab.mid');
  if (existsSync(dest) && Buffer.from(readFileSync(dest)).equals(Buffer.from(bytes))) {
    return `${song.slug}: ${notes.length} notes, tab.mid unchanged`;
  }
  writeFileSync(dest, bytes);
  const moved = song.author.barOffset
    ? `, ${song.author.barOffset} bar(s) off the front` +
      (dropped ? ` (${dropped} note(s) before bar 1 dropped)` : '')
    : '';
  return `${song.slug}: ${notes.length} notes from "${track}" -> tab.mid${moved}`;
}

export function abletonTabs(songsDir: string): Plugin {
  let songs = readSongs(songsDir);
  const log = (msg: string) => console.log(`[ableton] ${msg}`);

  const syncAll = () => {
    for (const song of songs) {
      try {
        log(syncSong(songsDir, song));
      } catch (err) {
        log(`${song.slug}: ${(err as Error).message}`);
      }
    }
  };

  return {
    name: 'drums-ableton-tabs',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      return `export default ${JSON.stringify(songs)};`;
    },
    buildStart() {
      songs = readSongs(songsDir);
      syncAll();
      // Again: the bars are counted off tab.mid, which the sync just rewrote.
      songs = readSongs(songsDir);
    },
    configureServer(server: ViteDevServer) {
      // Vite only watches its root (app/); the songs and the Live sets live
      // elsewhere.
      server.watcher.add(songsDir);
      const watchSets = () => {
        for (const song of songs) if (song.author) server.watcher.add(song.author.als);
      };
      watchSets();

      // Ableton writes the set in one go but the watcher can fire more than
      // once per save; coalesce, and retry once if we caught it mid-write.
      const pending = new Map<string, NodeJS.Timeout>();
      const later = (key: string, fn: () => void) => {
        clearTimeout(pending.get(key));
        pending.set(key, setTimeout(fn, 300));
      };
      /**
       * The catalogue again, then the page: a save in Live changes tab.mid
       * and so perhaps the bars, a save of song.toml anything. A song.toml
       * the catalogue cannot read (no [song] names) keeps the last good one
       * and says why, rather than taking the dev server down.
       */
      const reload = () => {
        try {
          songs = readSongs(songsDir);
        } catch (err) {
          log((err as Error).message);
        }
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };

      const onSetChanged = (path: string) => {
        const changed = songs.filter((s) => s.author && samePath(s.author.als, path));
        if (changed.length === 0) return;
        later(path, () => {
          for (const song of changed) {
            try {
              log(syncSong(songsDir, song));
            } catch (err) {
              log(`${song.slug}: ${(err as Error).message} (retrying)`);
              setTimeout(() => {
                try {
                  log(syncSong(songsDir, song));
                  reload();
                } catch (again) {
                  log(`${song.slug}: ${(again as Error).message}`);
                }
              }, 700);
              return;
            }
          }
          reload();
        });
      };

      const onSongsChanged = (path: string) => {
        if (!path.endsWith('song.toml')) return;
        later('toml', () => {
          try {
            songs = readSongs(songsDir);
          } catch (err) {
            log((err as Error).message);
            return;
          }
          watchSets();
          syncAll();
          reload();
        });
      };

      for (const event of ['change', 'add'] as const) {
        server.watcher.on(event, (path: string) => {
          if (path.toLowerCase().endsWith('.als')) onSetChanged(path);
          else onSongsChanged(path);
        });
      }
    },
  };
}

const samePath = (a: string, b: string) =>
  a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
