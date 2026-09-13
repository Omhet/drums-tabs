// The practice mode's disk access: the kit you play, and the takes you record.
//
// There is no application server in this project -- the app is a static page
// and a handful of Vite plugins -- so anything that has to touch the filesystem
// gets a route here, the same trick `plugins/ableton.ts` uses to write tab.mid.
// The consequence is stated rather than discovered (practice-plan Q15):
// **recording is a dev-mode feature.** `npm run build` produces a page that can
// read a chart and play a song but cannot write a take.
//
// Two things live here:
//
//   `virtual:kit`            kit.toml, for `[input]` -- which note the module
//                            sends for which drum. The geometry in the same
//                            file is the Python pipeline's business.
//   POST /practice/take      songs/<slug>/takes/<id>.json, tracked in git: the
//                            progress history, and what the coaching agent
//                            reads (Q8).
//   GET/POST /practice/calibration
//                            calibration.local.json at the repo root. Untracked
//                            and per machine: it measures this audio path, not
//                            this song and not this drummer (Q9).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { Plugin, ViteDevServer } from 'vite';

const VIRTUAL_ID = 'virtual:kit';
const RESOLVED_ID = '\0' + VIRTUAL_ID;
/** A take is tens of kilobytes; this is only here so a bug cannot fill RAM. */
const MAX_BODY = 8 * 1024 * 1024;

export interface KitInput {
  /** Substring of the MIDI port name to open by default. */
  port: string;
  /** Module note number -> instrument name. */
  note: Record<number, string>;
  /** Groups of instruments that are one drum in different states. */
  same_drum: string[][];
}

export function readKitInput(kitPath: string): KitInput {
  if (!existsSync(kitPath)) return { port: '', note: {}, same_drum: [] };
  const toml = parseToml(readFileSync(kitPath, 'utf-8')) as Record<string, unknown>;
  const input = (toml.input ?? {}) as {
    port?: unknown;
    note?: Record<string, unknown>;
    same_drum?: unknown;
  };
  const note: Record<number, string> = {};
  for (const [key, name] of Object.entries(input.note ?? {})) {
    const n = Number(key);
    if (Number.isInteger(n) && n >= 0 && n <= 127) note[n] = String(name);
  }
  const sameDrum = Array.isArray(input.same_drum) ? input.same_drum : [];
  return {
    port: String(input.port ?? ''),
    note,
    same_drum: sameDrum
      .filter((group): group is unknown[] => Array.isArray(group))
      .map((group) => group.map(String)),
  };
}

/** `2026-09-13T18:04:11.123Z` -> `2026-09-13T18-04-11`, which sorts and is a filename. */
function stamp(iso: string): string {
  const d = new Date(iso);
  const when = Number.isNaN(d.valueOf()) ? new Date() : d;
  return when.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
}

/** Anything that is not plainly a name is not going into a path. */
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

export function practice(songsDir: string, repoRoot: string): Plugin {
  const kitPath = join(repoRoot, 'kit.toml');
  const calibrationPath = join(repoRoot, 'calibration.local.json');
  const songs = resolve(songsDir);

  const handle = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/practice/')) return next();

    try {
      if (url.pathname === '/practice/calibration' && req.method === 'GET') {
        const body = existsSync(calibrationPath) ? readFileSync(calibrationPath, 'utf-8') : 'null';
        return json(res, 200, body);
      }
      if (url.pathname === '/practice/calibration' && req.method === 'POST') {
        const body = await read(req);
        // Parse before writing: a malformed body should fail here rather than
        // leave a file the app cannot read back.
        JSON.parse(body);
        writeFileSync(calibrationPath, body.endsWith('\n') ? body : body + '\n');
        return json(res, 200, JSON.stringify({ path: calibrationPath }));
      }
      if (url.pathname === '/practice/take' && req.method === 'POST') {
        const take = JSON.parse(await read(req)) as {
          slug?: string;
          startedAt?: string;
          cell?: { section?: string; tempo?: number };
        };
        if (!take.slug) return json(res, 400, JSON.stringify({ error: 'no slug' }));
        const dir = join(songs, safe(take.slug), 'takes');
        // The name is the take's identity in the history, so it says when,
        // what and how fast without opening the file.
        const name =
          `${stamp(take.startedAt ?? '')}` +
          `-${safe(String(take.cell?.section ?? 'x'))}` +
          `-${Math.round((take.cell?.tempo ?? 1) * 100)}.json`;
        const file = join(dir, name);
        if (!file.startsWith(songs)) return json(res, 403, JSON.stringify({ error: 'bad slug' }));
        mkdirSync(dirname(file), { recursive: true });
        // `slug` is in the path; keeping it in the file too would let the two
        // disagree. Everything else is written as sent.
        const { slug: _slug, ...rest } = take as Record<string, unknown>;
        writeFileSync(file, JSON.stringify(rest, null, 1) + '\n');
        console.log(`[practice] take -> ${file}`);
        return json(res, 200, JSON.stringify({ path: file, name }));
      }
    } catch (err) {
      return json(res, 500, JSON.stringify({ error: String((err as Error)?.message ?? err) }));
    }
    return json(res, 404, JSON.stringify({ error: 'no such practice route' }));
  };

  return {
    name: 'drums-practice',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      return id === RESOLVED_ID ? `export default ${JSON.stringify(readKitInput(kitPath))};` : undefined;
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use(handle);
      // An edit to the input map should take effect by hitting the pad again,
      // not by restarting the dev server.
      server.watcher.add(kitPath);
      server.watcher.on('change', (path: string) => {
        if (path.replace(/\\/g, '/').toLowerCase() !== kitPath.replace(/\\/g, '/').toLowerCase()) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        console.log('[practice] kit.toml changed, reloading');
        server.ws.send({ type: 'full-reload' });
      });
    },
  };
}

function json(res: ServerResponse, status: number, body: string) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(body);
}

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
