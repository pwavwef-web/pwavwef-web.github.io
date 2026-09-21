import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { bucket } from './firebase';

/**
 * The bundled static ffmpeg/ffprobe builds crash (SIGSEGV) as soon as they resolve a hostname in the
 * Cloud Functions runtime (statically linked glibc meets the host's NSS modules), so they must never
 * fetch https://storage.googleapis.com themselves. They read media from this loopback server instead:
 * an IP literal needs no DNS, and byte-range requests keep seeking cheap, so large uploads are never
 * downloaded whole.
 */
export interface RangeSource {
  size: number;
  contentType: string;
  /** Opens an inclusive byte range. */
  open(start: number, end: number): Readable;
}

export interface RangeServer {
  /** Returns a loopback URL valid for `ttlMs`; the file name is appended so probing can use the extension. */
  register(source: RangeSource, fileName: string, ttlMs?: number): Promise<string>;
  close(): Promise<void>;
}

/** Parses a single `bytes=` range: null means "whole file", 'invalid' means unsatisfiable. */
export function parseRange(header: string | undefined, size: number): [number, number] | null | 'invalid' {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  const [start, end] = m[1] ? [Number(m[1]), m[2] ? Math.min(Number(m[2]), size - 1) : size - 1] : [Math.max(0, size - Number(m[2])), size - 1];
  return start >= size || start > end ? 'invalid' : [start, end];
}

export function createRangeServer(): RangeServer {
  const routes = new Map<string, { source: RangeSource; expires: number }>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const now = Date.now();
    for (const [token, r] of routes) if (r.expires < now) routes.delete(token);
    const route = routes.get((req.url ?? '').split('/')[1] ?? '');
    if (!route || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return;
    }
    const { size, contentType } = route.source;
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    const [start, end] = range ?? [0, size - 1];
    res.writeHead(range ? 206 : 200, {
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'Content-Length': String(Math.max(0, end - start + 1)),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD' || size === 0) {
      res.end();
      return;
    }
    try {
      await pipeline(route.source.open(start, end), res);
    } catch {
      res.destroy(); // ffmpeg drops the connection whenever it seeks; that is expected.
    }
  };

  const server = createServer((req, res) => void handle(req, res));
  let base: Promise<string> | null = null;

  return {
    async register(source, fileName, ttlMs = 30 * 60_000) {
      base ??= new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
        server.unref();
      });
      const token = randomBytes(16).toString('hex');
      routes.set(token, { source, expires: Date.now() + ttlMs });
      return `${await base}/${token}/${encodeURIComponent(fileName)}`;
    },
    close() {
      routes.clear();
      return new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
    },
  };
}

let shared: RangeServer | null = null;

/** Loopback URL through which ffmpeg/ffprobe read a Storage object (range requests, no download). */
export async function mediaInputUrl(storagePath: string): Promise<string> {
  const file = bucket.file(storagePath);
  const [meta] = await file.getMetadata();
  shared ??= createRangeServer();
  return shared.register(
    {
      size: Number(meta.size ?? 0),
      contentType: meta.contentType ?? 'application/octet-stream',
      open: (start, end) => file.createReadStream({ start, end, validation: false }),
    },
    path.posix.basename(storagePath),
  );
}
