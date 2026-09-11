// tab.mid -> alphaTex. The notation is derived, never edited: the MIDI is the
// source, this file decides how it looks on the staff.
import { parseMidi } from 'midi-file';

// alphaTab addresses percussion by articulation *name*; the number is where
// the notehead lands, and alphaTab's numbering is not General MIDI (its kick
// is 35, where the bass drum is written, not GM's 36).
export const ARTICULATION: Record<string, string> = {
  kick: 'kick (hit)',
  snare: 'snare (hit)',
  hihat_closed: 'hi-hat (closed)',
  hihat_open: 'hi-hat (open)',
  hihat_pedal: 'pedal hi-hat (hit)',
  tom_high: 'high tom (hit)',
  tom_mid: 'mid tom (hit)',
  tom_floor: 'low tom (hit)',
  crash: 'crash high (hit)',
  crash2: 'crash medium (hit)',
  ride: 'ride (middle)',
};

// Voice 0 is hands (stems up), voice 1 is feet (stems down): the Guitar Pro
// convention, and the one every drum book uses.
export const FEET = new Set(['kick', 'hihat_pedal']);

export interface TabOptions {
  title: string;
  subtitle?: string;
  bpm: number;
  /** MIDI key -> instrument name (keys of ARTICULATION). */
  map: Record<number, string>;
  beatsPerBar: number;
  /** Render at least this many bars, so an unfinished tab still shows the whole song. */
  barCount: number;
}

export interface TabResult {
  tex: string;
  bars: number;
  notes: number;
  /** MIDI keys that had no mapping and were dropped. */
  unmapped: number[];
  /** Mapped instruments alphaTab has no articulation for. */
  unknown: string[];
}

interface Hit {
  slot: number; // position in 16ths from bar 1
  instrument: string;
}

const SLOTS_PER_BEAT = 4; // sixteenth grid

/** Largest power of two <= n that also divides pos, so pieces sit on the grid. */
function piece(pos: number, n: number): number {
  let size = 1;
  while (size * 2 <= n && pos % (size * 2) === 0) size *= 2;
  return size;
}

const DURATION: Record<number, string> = { 16: '1', 8: '2', 4: '4', 2: '8', 1: '16' };

function durationToken(size: number, slotsPerBar: number): string {
  // 4/4 is the only meter where a whole bar is one token; elsewhere a bar-long
  // rest is spelled as beats.
  if (size === slotsPerBar && slotsPerBar !== 16) return '4';
  return DURATION[size] ?? '16';
}

function renderVoice(hits: Map<number, Set<string>>, slotsPerBar: number): string {
  const tokens: string[] = [];
  const emitRests = (from: number, to: number) => {
    let pos = from;
    while (pos < to) {
      const size = piece(pos, to - pos);
      tokens.push(`r.${durationToken(size, slotsPerBar)}`);
      pos += size;
    }
  };
  const positions = [...hits.keys()].sort((a, b) => a - b);
  if (positions.length === 0) {
    emitRests(0, slotsPerBar);
    return tokens.join(' ');
  }
  let cursor = 0;
  positions.forEach((pos, i) => {
    emitRests(cursor, pos);
    const next = positions[i + 1] ?? slotsPerBar;
    // A drum hit has no length; the written value only says where the next
    // thing is. Cap it at a quarter so a kick on 1 and 3 reads as quarters
    // and rests, not hollow half notes.
    const size = Math.min(piece(pos, next - pos), SLOTS_PER_BEAT);
    const names = [...hits.get(pos)!].map((n) => `"${ARTICULATION[n]}"`);
    const head = names.length === 1 ? names[0] : `(${names.join(' ')})`;
    tokens.push(`${head}.${durationToken(size, slotsPerBar)}`);
    emitRests(pos + size, next);
    cursor = next;
  });
  return tokens.join(' ');
}

export function midiToAlphaTex(bytes: Uint8Array, opts: TabOptions): TabResult {
  const midi = parseMidi(bytes);
  const ppq = midi.header.ticksPerBeat;
  if (!ppq) throw new Error('tab.mid uses SMPTE timing; expected ticks per beat');
  const step = ppq / SLOTS_PER_BEAT;
  const slotsPerBar = opts.beatsPerBar * SLOTS_PER_BEAT;

  const hits: Hit[] = [];
  const unmapped = new Set<number>();
  const unknown = new Set<string>();
  for (const track of midi.tracks) {
    let tick = 0;
    for (const event of track) {
      tick += event.deltaTime;
      if (event.type !== 'noteOn' || event.velocity === 0) continue;
      const instrument = opts.map[event.noteNumber];
      if (!instrument) {
        unmapped.add(event.noteNumber);
        continue;
      }
      if (!ARTICULATION[instrument]) {
        unknown.add(instrument);
        continue;
      }
      hits.push({ slot: Math.round(tick / step), instrument });
    }
  }

  // bar -> voice -> slot-in-bar -> instruments
  const bars = new Map<number, [Map<number, Set<string>>, Map<number, Set<string>>]>();
  let lastBar = -1;
  for (const hit of hits) {
    const bar = Math.floor(hit.slot / slotsPerBar);
    const pos = hit.slot % slotsPerBar;
    let voices = bars.get(bar);
    if (!voices) {
      voices = [new Map(), new Map()];
      bars.set(bar, voices);
    }
    const voice = voices[FEET.has(hit.instrument) ? 1 : 0];
    let set = voice.get(pos);
    if (!set) {
      set = new Set();
      voice.set(pos, set);
    }
    set.add(hit.instrument);
    lastBar = Math.max(lastBar, bar);
  }

  const barCount = Math.max(opts.barCount, lastBar + 1);
  const lines: string[] = [
    `\\title ${JSON.stringify(opts.title)}`,
    opts.subtitle ? `\\subtitle ${JSON.stringify(opts.subtitle)}` : '',
    `\\tempo ${Math.round(opts.bpm)}`,
    '\\hidedynamics',
    '\\track "Drums"',
    '\\instrument percussion',
    '\\articulation defaults',
    '\\clef neutral',
    '\\voicemode barwise',
    `\\ts(${opts.beatsPerBar} 4)`,
    '',
  ];
  for (let bar = 0; bar < barCount; bar++) {
    const [hands, feet] = bars.get(bar) ?? [new Map(), new Map()];
    lines.push(
      `/* ${bar + 1} */ ${renderVoice(hands, slotsPerBar)} \\voice ${renderVoice(feet, slotsPerBar)} |`
    );
  }

  return {
    tex: lines.filter((l) => l !== '').join('\n') + '\n',
    bars: barCount,
    notes: hits.length,
    unmapped: [...unmapped].sort((a, b) => a - b),
    unknown: [...unknown].sort(),
  };
}
