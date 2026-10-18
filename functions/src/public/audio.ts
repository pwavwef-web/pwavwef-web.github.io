import { PUBLICATION_CACHE, PUBLIC_ID_RE, parseRange, publicView, type NarratorPublicationDoc } from '@az-studio/shared';
import { IS_EMULATOR } from '../config/runtime';
import { media, ncol } from '../lib/narrator-store';
import { signedReadUrl } from '../lib/storage';

/**
 * The only public (unauthenticated) surface of Pwavwe Narrator, served same-origin through Firebase Hosting
 * rewrites (`/api/public/**`). It reads published revisions and nothing else: no studio data, no voice or
 * generation code is imported or reachable from here.
 *
 *   GET  /api/public/audio/{id}            → public metadata (JSON) or 404 / 410 (withdrawn)
 *   GET|HEAD /api/public/audio/{id}/r/{n}  → the revision's MP3: a 302 to a short-lived signed media URL
 *        (Cloud Storage serves Range requests for seeking), or, in the emulators, a byte-range proxy.
 */

export interface PublicReq {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface PublicRes {
  status(code: number): PublicRes;
  set(name: string, value: string): PublicRes;
  json(body: unknown): void;
  end(body?: string | Buffer): void;
  redirect(code: number, url: string): void;
  /** For streaming the proxy body. */
  pipeFrom?(stream: NodeJS.ReadableStream): void;
}

const header = (h: PublicReq['headers'], k: string) => {
  const v = h[k] ?? h[k.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

const DELIVERY = () => (process.env.NARRATOR_PUBLIC_DELIVERY === 'proxy' || IS_EMULATOR ? 'proxy' : 'redirect');

function noStore(res: PublicRes) {
  res.set('Cache-Control', 'no-store');
}

async function load(id: string): Promise<NarratorPublicationDoc | null> {
  const snap = await ncol.publications().doc(id).get();
  return snap.exists ? (snap.data() as NarratorPublicationDoc) : null;
}

export async function handlePublicAudio(req: PublicReq, res: PublicRes): Promise<void> {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.set('Allow', 'GET, HEAD');
    noStore(res);
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const m = /^\/api\/public\/audio\/([^/]+)(?:\/r\/(\d{1,6}))?\/?$/.exec(req.path);
  if (!m || !PUBLIC_ID_RE.test(m[1]!)) {
    noStore(res);
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const id = m[1]!;
  const pub = await load(id);
  if (!m[2]) {
    const view = publicView(id, pub);
    res.set('Cache-Control', `public, max-age=${PUBLICATION_CACHE.metadataMaxAgeSec}, s-maxage=${PUBLICATION_CACHE.metadataSharedMaxAgeSec}`);
    if (view) res.status(200).json(view);
    else if (pub?.status === 'unpublished') res.status(410).json({ error: 'unpublished', message: 'This audio edition is no longer available.' });
    else res.status(404).json({ error: 'not_found' });
    return;
  }
  const revision = Number(m[2]);
  noStore(res);
  if (!pub || pub.status !== 'published' || !pub.current) {
    res.status(pub?.status === 'unpublished' ? 410 : 404).json({ error: pub?.status === 'unpublished' ? 'unpublished' : 'not_found' });
    return;
  }
  // The current revision, or a replaced one still inside its grace window (listeners mid-play).
  const target = pub.current.revision === revision ? pub.current.audioPath : pub.retired.find((r) => r.revision === revision && r.until > Date.now())?.audioPath;
  if (!target) {
    res.status(409).json({ error: 'revision_replaced', revision: pub.current.revision });
    return;
  }
  if (DELIVERY() === 'redirect') {
    const { url } = await signedReadUrl(target, { ttlSeconds: PUBLICATION_CACHE.signedUrlTtlSec });
    res.redirect(302, url);
    return;
  }
  const size = (await media.size(target)) ?? 0;
  if (!size) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.set('Accept-Ranges', 'bytes');
  res.set('Content-Type', 'audio/mpeg');
  const range = parseRange(header(req.headers, 'range'), size);
  if (range === 'unsatisfiable') {
    res.set('Content-Range', `bytes */${size}`);
    res.status(416).end();
    return;
  }
  if (range) {
    res.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.set('Content-Length', String(range.end - range.start + 1));
    res.status(206);
  } else {
    res.set('Content-Length', String(size));
    res.status(200);
  }
  if (req.method === 'HEAD' || !res.pipeFrom) {
    res.end();
    return;
  }
  res.pipeFrom(media.stream(target, range ?? undefined));
}
