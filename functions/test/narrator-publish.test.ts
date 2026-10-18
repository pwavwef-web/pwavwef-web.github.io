import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLICATION_ORIGINS, azStudioEmbedHtml, narratorRequestSchema, parseRange, playerUrl, publicView, type NarratorEditionDoc, type NarratorPublicationDoc } from '@az-studio/shared';
import { doc, resetFakes, store } from './fakes';

vi.mock('../src/lib/firebase', async () => import('./fakes'));
vi.mock('firebase-functions', async (orig) => ({ ...(await orig<typeof import('firebase-functions')>()), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/lib/storage', () => ({ signedReadUrl: async (p: string, o: { ttlSeconds?: number }) => ({ url: `https://storage.googleapis.com/bucket/${p}?X-Goog-Expires=${o.ttlSeconds}&X-Goog-Signature=sig`, expiresAt: 0 }) }));

const files = new Map<string, Buffer>();
vi.mock('../src/lib/narrator-store', async (orig) => {
  const real = await orig<typeof import('../src/lib/narrator-store')>();
  return {
    ...real,
    media: {
      save: async (p: string, d: Uint8Array) => void files.set(p, Buffer.from(d)),
      read: async (p: string) => files.get(p)!,
      remove: async (p: string) => void files.delete(p),
      removePrefix: async () => undefined,
      copy: async (from: string, to: string) => {
        files.set(to, files.get(from)!);
        return files.get(to)!.length;
      },
      size: async (p: string) => (files.has(p) ? files.get(p)!.length : null),
      stream: (p: string, r?: { start: number; end: number }) => Readable.from([r ? files.get(p)!.subarray(r.start, r.end + 1) : files.get(p)!]),
      staleInbox: async () => [],
    },
  };
});

import { publish, sweepRetiredRevisions, unpublish } from '../src/api/narrator-publish';
import { narrator } from '../src/api/narrator';
import { handlePublicAudio, type PublicRes } from '../src/public/audio';

const owner = { uid: 'u', email: 'o@x' };
const MP3 = (n: number) => Buffer.concat([Buffer.from('ID3'), Buffer.alloc(997, n)]);

function seed() {
  store.set('narratorEditions/e1', { ownerUid: 'u', title: 'A Paper', author: 'Francis Pwavwe', publishedDate: '2026-10-07', sourceUrl: 'https://blogs.pwavwe.com/2026/10/a-paper.html', voiceId: 'v1', script: { opening: null, sections: [], closing: null }, settings: {}, takes: {}, rev: 1, deleted: false, article: { body: 'Secret draft text', origin: 'paste', importedAt: null, notes: [] } });
  for (const v of [1, 2]) {
    store.set(`narratorEditions/e1/exports/x${v}`, { ownerUid: 'u', editionId: 'e1', version: v, status: 'ready', durationSec: 60 + v, files: { wav: `users/u/x${v}.wav`, mp3: `users/u/x${v}.mp3`, transcript: 't', chapters: 'c' }, sections: [{ sectionId: null, title: 'Opening', startSec: 0.5 }], peaks: Array.from({ length: 900 }, (_, i) => (i % 10) / 10), parts: [] });
    files.set(`users/u/x${v}.mp3`, MP3(v));
    files.set(`users/u/x${v}.wav`, Buffer.from('RIFF-master'));
  }
}

function fakeRes() {
  const out: { status: number; headers: Record<string, string>; body: unknown; redirect: string | null; piped: Buffer | null; ended: boolean } = { status: 200, headers: {}, body: null, redirect: null, piped: null, ended: false };
  const res: PublicRes = {
    status(c) {
      out.status = c;
      return res;
    },
    set(k, v) {
      out.headers[k.toLowerCase()] = v;
      return res;
    },
    json(b) {
      out.body = b;
      out.ended = true;
    },
    end() {
      out.ended = true;
    },
    redirect(c, u) {
      out.status = c;
      out.redirect = u;
    },
    pipeFrom(s) {
      const chunks: Buffer[] = [];
      s.on('data', (d: Buffer) => chunks.push(d));
      s.on('end', () => (out.piped = Buffer.concat(chunks)));
    },
  };
  return { res, out };
}
const get = async (p: string, headers: Record<string, string> = {}, method = 'GET') => {
  const { res, out } = fakeRes();
  await handlePublicAudio({ method, path: p, headers }, res);
  await new Promise((r) => setTimeout(r, 5));
  return out;
};

beforeEach(() => {
  resetFakes();
  files.clear();
  delete process.env.NARRATOR_PUBLIC_DELIVERY;
  seed();
});

describe('publishing', () => {
  it('requires the explicit reviewed confirmation and a finished export', async () => {
    expect(narratorRequestSchema.safeParse({ op: 'publish', editionId: 'e1', exportId: 'x1' }).success).toBe(false);
    await expect(narrator(owner, { op: 'publish', editionId: 'e1', exportId: 'x1' } as never)).rejects.toThrow(/listened/);
    store.set('narratorEditions/e1/exports/x3', { ownerUid: 'u', editionId: 'e1', version: 3, status: 'rendering', files: { mp3: null } });
    await expect(publish(owner, { op: 'publish', editionId: 'e1', exportId: 'x3', reviewed: true })).rejects.toThrow(/finished export/);
    store.set('narratorEditions/e9', { ...(doc('narratorEditions/e1') as object), ownerUid: 'other' });
    await expect(publish(owner, { op: 'publish', editionId: 'e9', exportId: 'x1', reviewed: true })).rejects.toThrow(/not found/i);
  });

  it('serves only public fields — never drafts, WAV masters, voices or owner data', async () => {
    const r = await publish(owner, { op: 'publish', editionId: 'e1', exportId: 'x1', reviewed: true });
    expect(r.publicId).toMatch(/^[A-Za-z0-9]{12}$/);
    const meta = await get(`/api/public/audio/${r.publicId}`);
    expect(meta.status).toBe(200);
    expect(meta.headers['cache-control']).toBe('public, max-age=30, s-maxage=60');
    const body = meta.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['articleUrl', 'audio', 'author', 'durationSec', 'id', 'peaks', 'publication', 'publishedDate', 'revision', 'sections', 'status', 'title', 'updatedAt']);
    const text = JSON.stringify(body);
    for (const secret of ['ownerUid', 'editionId', '"u"', 'x1.wav', 'users/u', 'Secret draft text', 'voice', 'exportId']) expect(text).not.toContain(secret);
    expect((body.peaks as number[]).length).toBeLessThanOrEqual(400);
    expect(files.get(`narrator-public/${r.publicId}/r1.mp3`)).toBeDefined();
  });

  it('keeps the same URL across an approved update; later exports stay drafts until published', async () => {
    const first = await publish(owner, { op: 'publish', editionId: 'e1', exportId: 'x1', reviewed: true });
    // A newer export exists, but the public player still serves revision 1.
    expect(((await get(`/api/public/audio/${first.publicId}`)).body as { revision: number; durationSec: number }).durationSec).toBe(61);
    const second = await publish(owner, { op: 'publish', editionId: 'e1', exportId: 'x2', reviewed: true });
    expect(second.publicId).toBe(first.publicId);
    expect(second.listenUrl).toBe(playerUrl(first.publicId));
    const meta = (await get(`/api/public/audio/${first.publicId}`)).body as { revision: number; durationSec: number; audio: { url: string } };
    expect(meta).toMatchObject({ revision: 2, durationSec: 62, audio: { url: `/api/public/audio/${first.publicId}/r/2` } });
    // Listeners mid-play on revision 1 keep going during the grace window, then it is deleted.
    expect((await get(`/api/public/audio/${first.publicId}/r/1`)).status).toBe(302);
    expect(await sweepRetiredRevisions(Date.now() + 16 * 60_000)).toBe(1);
    expect(files.has(`narrator-public/${first.publicId}/r1.mp3`)).toBe(false);
    expect((await get(`/api/public/audio/${first.publicId}/r/1`)).status).toBe(409);
    expect((doc('narratorEditions/e1') as NarratorEditionDoc).publication).toMatchObject({ publicId: first.publicId, status: 'published', revision: 2, exportVersion: 2 });
  });

  it('unpublishing withdraws the metadata and deletes the public audio at once', async () => {
    const r = await publish(owner, { op: 'publish', editionId: 'e1', exportId: 'x1', reviewed: true });
    await publish(owner, { op: 'publish', editionId: 'e1', exportId: 'x2', reviewed: true });
    await unpublish(owner, { op: 'unpublish', editionId: 'e1' });
    expect((await get(`/api/public/audio/${r.publicId}`)).status).toBe(410);
    expect((await get(`/api/public/audio/${r.publicId}/r/2`)).status).toBe(410);
    expect([...files.keys()].filter((k) => k.startsWith('narrator-public/'))).toEqual([]);
    expect(files.has('users/u/x2.wav')).toBe(true); // the private master is untouched
    const again = await publish(owner, { op: 'publish', editionId: 'e1', exportId: 'x2', reviewed: true });
    expect(again.publicId).toBe(r.publicId);
    expect((doc(`narratorPublications/${r.publicId}`) as NarratorPublicationDoc).revision).toBe(3);
  });

  it('deleting an edition withdraws its publication first', async () => {
    const r = await publish(owner, { op: 'publish', editionId: 'e1', exportId: 'x1', reviewed: true });
    await narrator(owner, { op: 'editionDelete', editionId: 'e1' });
    expect((await get(`/api/public/audio/${r.publicId}`)).status).toBe(410);
  });
});

describe('public audio route', () => {
  it('redirects to a short-lived signed media URL and is never cached itself', async () => {
    const r = await publish(owner, { op: 'publish', editionId: 'e1', exportId: 'x1', reviewed: true });
    const out = await get(`/api/public/audio/${r.publicId}/r/1`);
    expect(out.status).toBe(302);
    expect(out.redirect).toMatch(/^https:\/\/storage\.googleapis\.com\/.*X-Goog-Expires=3600/);
    expect(out.headers['cache-control']).toBe('no-store');
  });

  it('proxy mode serves byte ranges for seeking with the right type', async () => {
    process.env.NARRATOR_PUBLIC_DELIVERY = 'proxy';
    const r = await publish(owner, { op: 'publish', editionId: 'e1', exportId: 'x1', reviewed: true });
    const part = await get(`/api/public/audio/${r.publicId}/r/1`, { range: 'bytes=100-199' });
    expect(part.status).toBe(206);
    expect(part.headers).toMatchObject({ 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'content-range': 'bytes 100-199/1000', 'content-length': '100' });
    expect(part.piped!.length).toBe(100);
    const whole = await get(`/api/public/audio/${r.publicId}/r/1`);
    expect(whole.status).toBe(200);
    expect(whole.piped!.subarray(0, 3).toString()).toBe('ID3');
    expect((await get(`/api/public/audio/${r.publicId}/r/1`, { range: 'bytes=5000-' })).status).toBe(416);
    const head = await get(`/api/public/audio/${r.publicId}/r/1`, {}, 'HEAD');
    expect(head.piped).toBeNull();
    expect(head.headers['content-length']).toBe('1000');
  });

  it('exposes nothing else', async () => {
    expect((await get('/api/public/audio/short')).status).toBe(404);
    expect((await get('/api/public/audio/AAAAAAAAAAAA')).status).toBe(404);
    expect((await get('/api/public/voices')).status).toBe(404);
    expect((await get('/api/public/audio/AAAAAAAAAAAA', {}, 'POST')).status).toBe(405);
  });

  it('parses ranges and projects only published revisions', () => {
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=9-20', 10)).toEqual({ start: 9, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange('items=0-1', 10)).toBeNull();
    expect(publicView('x', { status: 'unpublished', current: null } as unknown as NarratorPublicationDoc)).toBeNull();
  });
});

describe('embed markup and hosting headers', () => {
  it('builds a stable HTTPS iframe with an accessible title and fallback link — no script, no autoplay, no storage URL', () => {
    const html = azStudioEmbedHtml('AbCdEfGhIjKl', 'Does “Low-Resource” <Mean> "Low"?');
    expect(html).toContain('src="https://az-studio.web.app/embed/audio/AbCdEfGhIjKl"');
    expect(html).toContain('title="Listen to Does “Low-Resource” &lt;Mean&gt; &quot;Low&quot;? — audio edition, The Pwavwe Papers"');
    expect(html).toContain('<a href="https://az-studio.web.app/embed/audio/AbCdEfGhIjKl"');
    expect(html).not.toMatch(/<script|autoplay|storage\.googleapis|X-Goog/i);
  });

  it('lets only the configured publication origins frame the player, and keeps the studio unframeable', () => {
    const cfg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../firebase.json'), 'utf8'));
    const hosting = cfg.hosting[0];
    const block = (src: string) => hosting.headers.find((h: { source: string }) => h.source === src);
    const value = (b: { headers: { key: string; value: string }[] }, k: string) => b.headers.find((h) => h.key === k)?.value;
    const embed = block('/embed/**');
    const ancestors = /frame-ancestors ([^;]+)/.exec(value(embed, 'Content-Security-Policy')!)![1]!.split(' ');
    expect(ancestors).toEqual(["'self'", ...PUBLICATION_ORIGINS]);
    // Production Hosting applies every matching block, later ones overriding duplicate keys (checked on
    // az-studio.web.app): the player block must come after the studio block and replace its framing headers.
    expect(value(embed, 'X-Frame-Options')).toBe('SAMEORIGIN');
    expect(value(embed, 'Content-Security-Policy')).toMatch(/script-src 'self';/);
    const studio = block('**');
    expect(hosting.headers.indexOf(studio)).toBe(0);
    expect(hosting.headers.indexOf(embed)).toBeGreaterThan(0);
    expect(value(studio, 'X-Frame-Options')).toBe('DENY');
    expect(value(studio, 'Content-Security-Policy')).toMatch(/frame-ancestors 'none'/);
    expect(value(block('/api/public/audio/*'), 'Cache-Control')).toBe('public, max-age=30, s-maxage=60');
    expect(value(block('/api/public/audio/*/r/**'), 'Cache-Control')).toBe('no-store');
    expect(hosting.rewrites.slice(0, 2)).toEqual([
      { source: '/api/public/**', function: { functionId: 'azsPublic', region: 'us-central1' } },
      { source: '/embed/audio/**', destination: '/embed.html' },
    ]);
  });
});
