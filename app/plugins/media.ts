// Serves the untracked files that live outside Vite's root.
//
// Two mounts, for the same reason: songs/ holds the video and stems, kit/
// holds the sampler's bank, and both are large, regenerable and ignored by
// git. Vite's own /@fs/ route would work in dev, but it bakes an absolute
// machine path into the page and does not exist in `vite preview`, so the app
// gets one stable URL scheme instead.
//
// Range requests are mandatory: without 206 responses the browser cannot seek
// an 80 MB mp4, and the player is nothing but seeking. The kit's samples are a
// few tens of kilobytes each and never seek, but they come down the same path
// because there is no reason to write a second one.
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  // The sampler's bank. Lossless, and about half the size of the wav it came
  // from; Chrome decodes it through decodeAudioData like anything else.
  '.flac': 'audio/flac',
};

/**
 * @param mounts URL prefix (with both slashes) -> directory it serves.
 */
export function untrackedFiles(mounts: Record<string, string>): Plugin {
  const roots = Object.entries(mounts).map(([prefix, dir]) => [prefix, resolve(dir)] as const);

  const handle = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const mount = roots.find(([prefix]) => pathname.startsWith(prefix));
    if (!mount) return next();
    const [prefix, root] = mount;

    const file = resolve(root, decodeURIComponent(pathname.slice(prefix.length)));
    // Path containment: a decoded '..' must not climb out of the mount.
    if (!file.startsWith(root + sep)) return end(res, 403);
    const type = TYPES[extname(file).toLowerCase()];
    if (!type) return end(res, 404);
    let size: number;
    try {
      const stat = statSync(file);
      if (!stat.isFile()) return end(res, 404);
      size = stat.size;
    } catch {
      return end(res, 404);
    }

    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    let start = 0;
    let stop = size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const [, from, to] = range;
      if (from === '') {
        // "bytes=-500": the last 500 bytes.
        start = Math.max(0, size - Number(to));
      } else {
        start = Number(from);
        if (to !== '') stop = Math.min(Number(to), size - 1);
      }
      if (start >= size || start > stop) {
        res.setHeader('Content-Range', `bytes */${size}`);
        return end(res, 416);
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${stop}/${size}`);
    }
    res.setHeader('Content-Length', stop - start + 1);
    if (req.method === 'HEAD') return res.end();

    const stream = createReadStream(file, { start, end: stop });
    // The browser drops connections constantly while seeking; stop reading
    // when it does rather than pumping the rest of the file into nothing.
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };

  return {
    name: 'drums-untracked-files',
    configureServer(server) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
    },
  };
}

function end(res: ServerResponse, status: number) {
  res.statusCode = status;
  res.end();
}
