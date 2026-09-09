// Regenerates pipeline/data/alphatab_articulations.json from the installed
// alphaTab build. Re-run after upgrading alphaTab so the emitter's articulation
// names stay in sync with what the renderer will actually accept.
//
// The alphaTex source is read from a fixture file rather than embedded here:
// alphaTex is backslash-heavy and round-tripping it through string literals is
// a reliable way to introduce invisible escaping bugs.
import * as at from '@coderline/alphatab';
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = '../pipeline/data/alphatab_articulations.json';

const imp = new at.importer.AlphaTexImporter();
imp.initFromString(readFileSync('fixtures/articulation-probe.alphatex', 'utf8'), new at.Settings());
imp.readScore();

const byMidi = new Map();
for (const [alias, key] of imp.state.percussionArticulationNames) {
  const midi = Number(key.split('.').pop());
  if (!Number.isFinite(midi)) continue;
  if (!byMidi.has(midi)) byMidi.set(midi, new Set());
  byMidi.get(midi).add(alias);
}

const out = {};
for (const [midi, aliases] of [...byMidi].sort((a, b) => a[0] - b[0])) {
  const all = [...aliases].sort();
  // Prefer the spaced, human-readable alias ("hi-hat (closed)") over the
  // compact one ("hihatclosed") -- it is what we write into .alphatex files.
  const spaced = all.filter((a) => a.includes(' ') || a.includes('-'));
  const preferred = spaced.sort((a, b) => a.length - b.length)[0] ?? all[0];
  out[midi] = { name: preferred, aliases: all };
}

writeFileSync(
  OUT,
  `${JSON.stringify({ alphaTabVersion: at.Environment.version ?? 'unknown', byMidi: out }, null, 2)}\n`
);
console.log(`wrote ${Object.keys(out).length} articulations to ${OUT}`);
