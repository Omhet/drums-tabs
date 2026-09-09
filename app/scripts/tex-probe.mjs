import * as at from '@coderline/alphatab';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'fixtures';
for (const file of readdirSync(dir).filter(f => f.endsWith('.alphatex')).sort()) {
  const tex = readFileSync(join(dir, file), 'utf8');
  console.log(`--- ${file}`);
  try {
    const imp = new at.importer.AlphaTexImporter();
    imp.initFromString(tex, new at.Settings());
    const score = imp.readScore();
    const staff = score.tracks[0].staves[0];
    const desc = staff.bars.map(bar =>
      bar.voices.map(v => v.beats.map(b =>
        b.isRest ? 'r' : b.notes.map(n => n.percussionArticulation).join('+')
      ).join(' ')).filter(s => s.length).join('   //v//   ')
    ).join('  |  ');
    console.log(`    OK  perc=${staff.isPercussion} bars=${staff.bars.length} voices=${staff.bars[0].voices.length}`);
    console.log(`        ${desc}`);
  } catch (e) {
    for (const key of ['lexerDiagnostics','parserDiagnostics','semanticDiagnostics']) {
      for (const d of (e[key] && e[key].items) || []) {
        if (d.severity === 0) continue;
        console.log(`    FAIL [${d.start.line}:${d.start.col}] ${String(d.message).slice(0,150)}`);
      }
    }
  }
}
