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
//   `virtual:kit`            kit.toml, three ways. The default export is
//                            `[input]` -- which note the module sends for which
//                            drum. `sampler` is `[sampler]` plus which
//                            articulations ring, which is how the kit is
//                            played. `bank` is kit/kit.lock.json: what
//                            `drums kit-bake` actually rendered, or null when
//                            nothing has been. The geometry in the same file is
//                            the Python pipeline's business.
//   POST /practice/take      songs/<slug>/takes/<id>.json, tracked in git: the
//                            progress history, and what the coaching agent
//                            reads (Q8).
//   GET /practice/routines   the sealed runs, oldest first: the history the
//                            per-section trend lines are drawn from.
//   GET/POST/DELETE /practice/routine
//                            songs/<slug>/routines/<id>.json, also tracked: the
//                            run you are part-way through, rewritten after every
//                            cell so that Live's reload cannot lose it (Q10).
//                            GET returns the open one -- the rule that there is
//                            at most one is enforced here, not in the page,
//                            because the page is what keeps being reloaded.
//   GET/POST /practice/calibration
//                            calibration.local.json at the repo root. Untracked
//                            and per machine: it measures this audio path, not
//                            this song and not this drummer (Q9).
//   GET /practice/exercises  the whole pool: exercises/<id>/exercise.json, each
//                            with its drills, `reps` stripped. The pool is at
//                            the repo root and not under a song, because one
//                            exercise can be played from several songs and a
//                            file cannot live in two directories.
//   POST/DELETE /practice/exercise
//                            exercises/<id>/exercise.json. POST is an upsert,
//                            which is also how a second source is added to one.
//   POST /practice/drill     exercises/<id>/drills/<id>.json: one sitting, with
//                            every rep in it. Tracked, like takes.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

export interface KitSampler {
  /** Groups of articulations that cut each other off. */
  choke: string[][];
  /** Per-instrument trim in dB. */
  trim: Record<string, number>;
  /** Articulations that ring long enough to need cutting off. */
  ring: string[];
}

/** One velocity layer: the velocity it was rendered at, and its takes. */
export interface BankLayer {
  velocity: number;
  peak: number;
  /** Paths under kit/samples/, served at /kit/samples/<file>. */
  files: string[];
}

export interface BankArticulation {
  instrument: string;
  /** The one picked when nothing asks for a particular strike. */
  default: boolean;
  stereo: boolean;
  /** Quietest first. */
  layers: BankLayer[];
}

export interface Bank {
  name: string;
  sampleRate: number;
  gain: number;
  renderedAt: string;
  articulations: Record<string, BankArticulation>;
}

/**
 * How the bank is played: taste, read live rather than baked into the manifest.
 *
 * A choke group or a trim is something you argue with while listening, and
 * `drums kit-bake` takes nine minutes. Keeping these in kit.toml means
 * changing one is a page reload.
 */
export function readKitSampler(kitPath: string): KitSampler {
  if (!existsSync(kitPath)) return { choke: [], trim: {}, ring: [] };
  const toml = parseToml(readFileSync(kitPath, 'utf-8')) as Record<string, unknown>;
  const sampler = (toml.sampler ?? {}) as { choke?: unknown; trim?: Record<string, unknown> };
  const render = (toml.render ?? {}) as { articulation?: Record<string, { ring?: unknown }> };

  const choke = Array.isArray(sampler.choke) ? sampler.choke : [];
  const trim: Record<string, number> = {};
  for (const [name, db] of Object.entries(sampler.trim ?? {})) {
    const n = Number(db);
    if (Number.isFinite(n)) trim[name] = n;
  }
  const ring = Object.entries(render.articulation ?? {})
    .filter(([, spec]) => Boolean(spec?.ring))
    .map(([name]) => name);

  return {
    choke: choke
      .filter((group): group is unknown[] => Array.isArray(group))
      .map((group) => group.map(String)),
    trim,
    ring,
  };
}

/**
 * What `drums kit-bake` rendered, or null if it never has.
 *
 * Null rather than an empty bank on purpose: "no kit has been baked" and "a
 * kit was baked and has no snare in it" are different problems, and the page
 * says so differently.
 */
export function readBank(repoRoot: string): Bank | null {
  const manifest = join(repoRoot, 'kit', 'kit.lock.json');
  if (!existsSync(manifest)) return null;
  try {
    return JSON.parse(readFileSync(manifest, 'utf-8')) as Bank;
  } catch (err) {
    // Said out loud: "no kit baked" and "the manifest is unreadable" look
    // identical on the page, and only one of them is worth panicking about.
    console.log(`[practice] kit.lock.json could not be read: ${String(err)}`);
    return null;
  }
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

/**
 * Why an exercise id cannot be a directory name here, or nothing if it can.
 *
 * Refused rather than scrubbed the way `safe()` scrubs a slug. A slug comes
 * from a directory that already exists, so rewriting it is harmless; an id
 * *names* a directory this route is about to make, and a silent rename means
 * the page and the disk disagree about where an exercise lives from then on.
 * `uniqueId` in exercise.ts already produces exactly this alphabet.
 */
function idProblem(id: string | undefined): string | undefined {
  if (!id) return 'no id';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
    return 'an id is lowercase letters, digits and single hyphens';
  }
  return undefined;
}

/**
 * Every routine of a song that parses, by filename.
 *
 * A directory scan rather than an index file: the routines directory is tracked
 * in git, so it gets merged, reverted and copied between machines, and an index
 * would be one more thing that can disagree with the files it describes.
 */
function allRoutines(songs: string, slug: string) {
  const dir = join(songs, safe(slug), 'routines');
  if (!slug || !existsSync(dir)) return [];
  const found: { name: string; routine: { sealedAt?: string | null } }[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      found.push({ name, routine: JSON.parse(readFileSync(join(dir, name), 'utf-8')) });
    } catch {
      // A routine that will not parse is a file to fix by hand, not a reason to
      // refuse to practise: skip it and let the readable ones through.
      console.warn(`[practice] routines/${name} is not readable JSON`);
    }
  }
  return found;
}

/** The runs still in progress. At most one, and the POST route keeps it that way. */
function openRoutines(songs: string, slug: string) {
  return allRoutines(songs, slug).filter((r) => r.routine.sealedAt == null);
}

/** The finished runs: the history. Oldest first, because that is the order a line is drawn in. */
function sealedRoutines(songs: string, slug: string) {
  return allRoutines(songs, slug)
    .filter((r) => r.routine.sealedAt != null)
    .sort((a, b) => String(a.routine.sealedAt).localeCompare(String(b.routine.sealedAt)));
}

/**
 * Every exercise in the pool, each with its drills, oldest first.
 *
 * The same directory scan the routines get, for the same reason, and the
 * drills come back **without their reps**: a twenty-rep sitting is hundreds of
 * strokes, the pool only ever needs the grades, and nothing reads a rep back
 * yet. The day something does, it gets a route of its own rather than making
 * this one fat.
 */
function allExercises(root: string) {
  if (!existsSync(root)) return [];
  const found: { exercise: unknown; drills: unknown[] }[] = [];
  for (const id of readdirSync(root).sort()) {
    const file = join(root, id, 'exercise.json');
    if (!existsSync(file)) continue;
    try {
      const exercise = JSON.parse(readFileSync(file, 'utf-8'));
      const drillDir = join(root, id, 'drills');
      const drills: unknown[] = [];
      if (existsSync(drillDir)) {
        for (const name of readdirSync(drillDir).sort()) {
          if (!name.endsWith('.json')) continue;
          try {
            const { reps: _reps, ...summary } = JSON.parse(readFileSync(join(drillDir, name), 'utf-8'));
            drills.push(summary);
          } catch {
            console.warn(`[practice] exercises/${id}/drills/${name} is not readable JSON`);
          }
        }
      }
      found.push({ exercise, drills });
    } catch {
      // One broken file is a thing to fix by hand, not a reason to refuse to
      // practise: skip it and let the readable ones through.
      console.warn(`[practice] exercises/${id}/exercise.json is not readable JSON`);
    }
  }
  return found;
}

export function practice(songsDir: string, repoRoot: string): Plugin {
  const kitPath = join(repoRoot, 'kit.toml');
  const calibrationPath = join(repoRoot, 'calibration.local.json');
  const songs = resolve(songsDir);
  // The pool's own root. Every path built from a request is contained against
  // *this*, not against `songs` -- the guard is the same idea as the take and
  // routine routes use, but it must not be copy-pasted with the old root.
  const exercises = resolve(join(repoRoot, 'exercises'));

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
      if (url.pathname === '/practice/routines' && req.method === 'GET') {
        const slug = url.searchParams.get('slug') ?? '';
        // Whole routines rather than a summary: they are a few kilobytes each,
        // and a summary would be one more thing that can disagree with the
        // files it describes. The page decides what to plot from them.
        const runs = sealedRoutines(songs, slug).map((r) => r.routine);
        return json(res, 200, JSON.stringify({ routines: runs }));
      }
      if (url.pathname === '/practice/routine') {
        const slug = url.searchParams.get('slug') ?? '';
        if (req.method === 'GET') {
          const open = openRoutines(songs, slug);
          // Two open routines is not a state the app can produce, so it means a
          // file was edited or restored by hand. Saying so beats picking one.
          if (open.length > 1) {
            const names = open.map((r) => r.name).join(', ');
            return json(res, 409, JSON.stringify({ error: `more than one open routine: ${names}` }));
          }
          return json(res, 200, JSON.stringify({ routine: open[0]?.routine ?? null }));
        }
        if (req.method === 'POST') {
          const routine = JSON.parse(await read(req)) as {
            slug?: string;
            openedAt?: string;
            sealedAt?: string | null;
          };
          if (!routine.slug) return json(res, 400, JSON.stringify({ error: 'no slug' }));
          const name = `${stamp(routine.openedAt ?? '')}.json`;
          const file = join(songs, safe(routine.slug), 'routines', name);
          if (!file.startsWith(songs)) return json(res, 403, JSON.stringify({ error: 'bad slug' }));
          // At most one routine in progress per song (Q10). Checked on the way
          // in rather than trusted: the page holding the other one may have been
          // reloaded, or be a second tab.
          if (routine.sealedAt == null) {
            const other = openRoutines(songs, routine.slug).find((r) => r.name !== name);
            if (other) {
              return json(
                res,
                409,
                JSON.stringify({ error: `another routine is already open: ${other.name}` })
              );
            }
          }
          mkdirSync(dirname(file), { recursive: true });
          const { slug: _slug, ...rest } = routine as Record<string, unknown>;
          writeFileSync(file, JSON.stringify(rest, null, 1) + '\n');
          console.log(`[practice] routine -> ${file}`);
          return json(res, 200, JSON.stringify({ path: file, name }));
        }
        if (req.method === 'DELETE') {
          const name = `${stamp(url.searchParams.get('openedAt') ?? '')}.json`;
          const file = join(songs, safe(slug), 'routines', name);
          if (!file.startsWith(songs)) return json(res, 403, JSON.stringify({ error: 'bad slug' }));
          if (!existsSync(file)) return json(res, 404, JSON.stringify({ error: 'no such routine' }));
          // A sealed routine is history, and history is not edited from the app.
          const sealed = (JSON.parse(readFileSync(file, 'utf-8')) as { sealedAt?: string | null })
            .sealedAt;
          if (sealed != null) {
            return json(res, 409, JSON.stringify({ error: 'that routine is sealed' }));
          }
          rmSync(file);
          console.log(`[practice] routine discarded: ${file}`);
          return json(res, 200, JSON.stringify({ discarded: name }));
        }
      }
      if (url.pathname === '/practice/exercises' && req.method === 'GET') {
        return json(res, 200, JSON.stringify({ exercises: allExercises(exercises) }));
      }
      if (url.pathname === '/practice/exercise') {
        if (req.method === 'POST') {
          const exercise = JSON.parse(await read(req)) as {
            id?: string;
            sources?: unknown;
            chart?: { hits?: unknown };
          };
          const bad = idProblem(exercise.id);
          if (bad) return json(res, 400, JSON.stringify({ error: bad }));
          // An exercise with no notes is not an exercise. It would sit in the
          // pool for ever looking like a thing you could pick. `sources` is
          // where else it can be played, which is a separate question.
          const hasChart = Array.isArray(exercise.chart?.hits) && exercise.chart.hits.length > 0;
          if (!hasChart) {
            return json(
              res,
              400,
              JSON.stringify({ error: 'an exercise needs notes of its own' })
            );
          }
          const dir = join(exercises, exercise.id!);
          if (!dir.startsWith(exercises)) return json(res, 403, JSON.stringify({ error: 'bad id' }));
          mkdirSync(dir, { recursive: true });
          // An upsert, and safe to be one: the page derives a fresh id from the
          // pool it is already holding, so writing over an exercise is only
          // ever the deliberate act of adding a source to it.
          writeFileSync(join(dir, 'exercise.json'), JSON.stringify(exercise, null, 1) + '\n');
          console.log(`[practice] exercise -> ${dir}`);
          return json(res, 200, JSON.stringify({ id: exercise.id, path: dir }));
        }
        if (req.method === 'DELETE') {
          const id = url.searchParams.get('id') ?? '';
          const bad = idProblem(id);
          if (bad) return json(res, 400, JSON.stringify({ error: bad }));
          const dir = join(exercises, id);
          if (!dir.startsWith(exercises)) return json(res, 403, JSON.stringify({ error: 'bad id' }));
          if (!existsSync(dir)) return json(res, 404, JSON.stringify({ error: 'no such exercise' }));
          // The drills go with it. Unlike a sealed routine this is allowed,
          // because an exercise is a thing you made and can unmake -- but the
          // page says out loud that the history goes too.
          rmSync(dir, { recursive: true });
          console.log(`[practice] exercise deleted: ${dir}`);
          return json(res, 200, JSON.stringify({ deleted: true }));
        }
      }
      if (url.pathname === '/practice/drill' && req.method === 'POST') {
        const drill = JSON.parse(await read(req)) as {
          exercise?: string;
          startedAt?: string;
          tempo?: number;
        };
        const badId = idProblem(drill.exercise);
        if (badId) return json(res, 400, JSON.stringify({ error: badId }));
        const dir = join(exercises, drill.exercise!, 'drills');
        if (!dir.startsWith(exercises)) return json(res, 403, JSON.stringify({ error: 'bad id' }));
        // The same recipe a take's name uses: when, and how fast, without the
        // file having to be opened.
        const name = `${stamp(drill.startedAt ?? '')}-${Math.round((drill.tempo ?? 1) * 100)}.json`;
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), JSON.stringify(drill, null, 1) + '\n');
        console.log(`[practice] drill -> ${join(dir, name)}`);
        return json(res, 200, JSON.stringify({ name, path: join(dir, name) }));
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
      if (id !== RESOLVED_ID) return undefined;
      return [
        `export default ${JSON.stringify(readKitInput(kitPath))};`,
        `export const sampler = ${JSON.stringify(readKitSampler(kitPath))};`,
        `export const bank = ${JSON.stringify(readBank(repoRoot))};`,
      ].join('\n');
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use(handle);
      // An edit to the input map should take effect by hitting the pad again,
      // not by restarting the dev server.
      const manifestPath = join(repoRoot, 'kit', 'kit.lock.json');
      const watched = [kitPath, manifestPath].map((p) => p.replace(/\\/g, '/').toLowerCase());
      server.watcher.add(kitPath);
      server.watcher.add(manifestPath);
      // All three events, not just 'change': a first bake *adds* kit.lock.json
      // where there was none, and deleting a bank *unlinks* it. Both change
      // what `virtual:kit` should say, and a page still holding the old module
      // would insist there are 255 recordings that are no longer on disk.
      const reread = (path: string, what: string) => {
        const hit = watched.indexOf(path.replace(/\\/g, '/').toLowerCase());
        if (hit < 0) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        console.log(`[practice] ${hit === 0 ? 'kit.toml' : 'the kit'} ${what}, reloading`);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('change', (path: string) => reread(path, 'changed'));
      server.watcher.on('add', (path: string) => reread(path, 'was baked'));
      server.watcher.on('unlink', (path: string) => reread(path, 'went away'));
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
