// tab.mid -> alphaTex. The notation is derived, never edited: the MIDI is the
// source, this file decides how it looks on the staff.
//
// Reading the MIDI is `chart.ts`'s job and shared with the scorer, so that the
// notes you are marked against are the notes on the page.
import { readChart, SLOTS_PER_BEAT } from './chart';

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
  /**
   * Rests that should not be drawn, as (bar index, voice index, beat index in
   * that voice). alphaTex has no way to say it, so the player flags them on the
   * parsed score. Drum charts never write the feet's rests, and a hands rest on
   * a beat where the foot plays is noise: the kick already marks the time.
   */
  hiddenRests: { bar: number; voice: number; beat: number }[];
  /** MIDI keys that had no mapping and were dropped. */
  unmapped: number[];
  /** Mapped instruments alphaTab has no articulation for. */
  unknown: string[];
}

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

interface VoiceRender {
  text: string;
  /** Indices (into this voice's beats) of rests that should not be drawn. */
  hidden: number[];
}

interface RestPolicy {
  /** Positions the other voice plays at: rests are split there so that... */
  splitAt: Set<number>;
  /** ...each rest can be judged on its own start: hide it or not. */
  hideAt: (pos: number) => boolean;
}

function renderVoice(
  hits: Map<number, Set<string>>,
  slotsPerBar: number,
  policy: RestPolicy
): VoiceRender {
  const tokens: string[] = [];
  const hidden: number[] = [];
  const emitRests = (from: number, to: number) => {
    let pos = from;
    while (pos < to) {
      let limit = to;
      for (const split of policy.splitAt) if (split > pos && split < limit) limit = split;
      const size = piece(pos, limit - pos);
      tokens.push(`r.${durationToken(size, slotsPerBar)}`);
      if (policy.hideAt(pos)) hidden.push(tokens.length - 1);
      pos += size;
    }
  };
  const positions = [...hits.keys()].sort((a, b) => a - b);
  if (positions.length === 0) {
    emitRests(0, slotsPerBar);
    return { text: tokens.join(' '), hidden };
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
  return { text: tokens.join(' '), hidden };
}

export function midiToAlphaTex(bytes: Uint8Array, opts: TabOptions): TabResult {
  const slotsPerBar = opts.beatsPerBar * SLOTS_PER_BEAT;
  const { hits: read, unmapped } = readChart(bytes, opts.map);

  // An instrument the kit knows but the staff cannot draw is dropped here
  // rather than in chart.ts: the scorer can still mark you on a cowbell that
  // alphaTab has no notehead for.
  const unknown = new Set<string>();
  const hits = read.filter((hit) => {
    if (ARTICULATION[hit.instrument]) return true;
    unknown.add(hit.instrument);
    return false;
  });

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
  const hiddenRests: TabResult['hiddenRests'] = [];
  for (let bar = 0; bar < barCount; bar++) {
    const [hands, feet] = bars.get(bar) ?? [new Map(), new Map()];
    const feetAt = new Set(feet.keys());
    // Hands: a rest is drawn unless the foot plays right where it starts.
    const top = renderVoice(hands, slotsPerBar, { splitAt: feetAt, hideAt: (p) => feetAt.has(p) });
    // Feet: never draw rests; the hands carry the time.
    const bottom = renderVoice(feet, slotsPerBar, { splitAt: new Set(), hideAt: () => true });
    lines.push(`/* ${bar + 1} */ ${top.text} \\voice ${bottom.text} |`);
    for (const beat of top.hidden) hiddenRests.push({ bar, voice: 0, beat });
    for (const beat of bottom.hidden) hiddenRests.push({ bar, voice: 1, beat });
  }

  return {
    tex: lines.filter((l) => l !== '').join('\n') + '\n',
    bars: barCount,
    notes: hits.length,
    hiddenRests,
    unmapped,
    unknown: [...unknown].sort(),
  };
}
