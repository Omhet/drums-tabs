// Ableton Live set -> tab.mid, and the song catalogue as a virtual module.
//
// A Live set (.als) is gzipped XML with every MIDI note in it, so "export" is
// just Ctrl+S in Ableton: this plugin watches the set named in song.toml,
// pulls the arrangement clips off the drum track, and rewrites
// songs/<slug>/tab.mid. A tab.mid exported by hand from Ableton is the same
// file, so the browser side never knows which way it was made.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import { writeMidi, type MidiData, type MidiEvent } from 'midi-file';
import { parse as parseToml } from 'smol-toml';
import type { Plugin, ViteDevServer } from 'vite';

export interface SongMeta {
  slug: string;
  title: string;
  /** MIDI key -> instrument name (kick, snare, hihat_closed, ...). */
  map: Record<number, string>;
  /** Present when the notation is authored in a Live set. */
  author?: { als: string; track?: string };
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
    const source = (toml.source ?? {}) as Record<string, unknown>;
    const author = toml.author as { als?: string; track?: string } | undefined;
    const map: Record<number, string> = {};
    for (const [key, name] of Object.entries((toml.midi_map ?? {}) as Record<string, string>)) {
      map[Number(key)] = String(name);
    }
    songs.push({
      slug,
      title: String(source.title ?? slug),
      map,
      author: author?.als ? { als: author.als, track: author.track } : undefined,
    });
  }
  return songs;
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
  const { notes, track } = extractNotes(song.author.als, song.author.track);
  const bytes = notesToMidi(notes, { bpm: readBpm(songDir), name: track });
  const dest = join(songDir, 'tab.mid');
  if (existsSync(dest) && Buffer.from(readFileSync(dest)).equals(Buffer.from(bytes))) {
    return `${song.slug}: ${notes.length} notes, tab.mid unchanged`;
  }
  writeFileSync(dest, bytes);
  return `${song.slug}: ${notes.length} notes from "${track}" -> tab.mid`;
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
      const reload = () => server.ws.send({ type: 'full-reload' });

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
          songs = readSongs(songsDir);
          watchSets();
          syncAll();
          const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
          if (mod) server.moduleGraph.invalidateModule(mod);
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
