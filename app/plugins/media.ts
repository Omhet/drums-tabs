// Serves the untracked media under songs/ (video, stems) at /media/<slug>/...
//
// The song directories sit outside Vite's root. Vite's own /@fs/ route would
// work in dev, but it bakes an absolute machine path into the page and does
// not exist in `vite preview`, so the app gets one stable URL scheme instead.
// Range requests are mandatory: without 206 responses the browser cannot seek
// an 80 MB mp4, and the player is nothing but seeking.
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

const PREFIX = '/media/';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
};

export function songMedia(songsDir: string): Plugin {
  const root = resolve(songsDir);

  const handle = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!pathname.startsWith(PREFIX)) return next();

    const file = resolve(root, decodeURIComponent(pathname.slice(PREFIX.length)));
    // Path containment: a decoded '..' must not climb out of songs/.
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
    name: 'drums-song-media',
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
