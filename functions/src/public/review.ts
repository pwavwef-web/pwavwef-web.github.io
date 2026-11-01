import { parseReviewComment, parseReviewDecision, REVIEW_LIMITS, REVIEW_TOKEN_RE, reviewLinkState, reviewPublicView, reviewRateStamps, type ReviewComment, type ReviewLinkDoc } from '@az-studio/shared';
import { db, FieldValue } from '../lib/firebase';
import { signedReadUrl } from '../lib/storage';
import { ALLOWED_ORIGINS } from '../config/runtime';
import type { PublicReq, PublicRes } from './audio';

/**
 * Client review links (unauthenticated, through the Hosting rewrite `/api/public/**`). The token in the path is the
 * credential; an expired or revoked link answers 410. Nothing but the shared render and its review thread is read.
 *
 *   GET  /api/public/review/{token}           → the review (title, length, status, decisions, comments)
 *   GET  /api/public/review/{token}/media     → 302 to a 1-hour signed URL of the render
 *   POST /api/public/review/{token}/comments  → { atSec, text, name } — a comment pinned to a moment in the cut
 *   POST /api/public/review/{token}/decision  → { decision: approved | changes_requested, note, name }
 */
export interface ReviewReq extends PublicReq {
  body?: unknown;
}


const links = () => db.collection('reviewLinks');

function reply(res: PublicRes, status: number, body: unknown) {
  res.set('Cache-Control', 'no-store');
  res.status(status).json(body);
}

export async function handlePublicReview(req: ReviewReq, res: PublicRes, now = Date.now()): Promise<void> {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  const m = /^\/api\/public\/review\/([^/]+)(?:\/(media|comments|decision))?\/?$/.exec(req.path);
  if (!m || !REVIEW_TOKEN_RE.test(m[1]!)) return reply(res, 404, { error: 'not_found' });
  const [, token, sub] = m as unknown as [string, string, 'media' | 'comments' | 'decision' | undefined];
  const ref = links().doc(token);
  const doc = (await ref.get()).data() as ReviewLinkDoc | undefined;
  if (!doc) return reply(res, 404, { error: 'not_found' });
  const state = reviewLinkState(doc, now);
  if (state !== 'open') return reply(res, 410, { error: state, message: state === 'expired' ? 'This review link has expired. Ask for a new one.' : 'This review link was withdrawn.' });

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (sub === 'media') {
      const { url } = await signedReadUrl(doc.storagePath, { ttlSeconds: REVIEW_LIMITS.mediaTtlSec });
      res.set('Cache-Control', 'no-store');
      res.redirect(302, url);
      return;
    }
    if (sub) return reply(res, 405, { error: 'method_not_allowed' });
    const comments = (await ref.collection('comments').get()).docs.map((c) => ({ id: c.id, ...c.data() }) as ReviewComment);
    return reply(res, 200, reviewPublicView(doc, comments));
  }
  if (req.method !== 'POST' || !sub || sub === 'media') {
    res.set('Allow', sub && sub !== 'media' ? 'POST' : 'GET, HEAD');
    return reply(res, 405, { error: 'method_not_allowed' });
  }
  const origin = req.headers.origin;
  // The browser sends Origin on POST: only the studio's own sites may write (other sites are refused).
  if (typeof origin === 'string' && !ALLOWED_ORIGINS.some((o) => (typeof o === 'string' ? o === origin : o.test(origin)))) return reply(res, 403, { error: 'forbidden' });

  const parsed = sub === 'comments' ? parseReviewComment(req.body, doc.durationSec) : parseReviewDecision(req.body);
  if (!parsed.ok) return reply(res, 400, { error: 'invalid', message: parsed.error });
  const outcome = await db.runTransaction(async (tx) => {
    const fresh = (await tx.get(ref)).data() as ReviewLinkDoc | undefined;
    if (!fresh || reviewLinkState(fresh, now) !== 'open') return 'gone' as const;
    const stamps = reviewRateStamps(fresh.stamps ?? [], now);
    if (!stamps) return 'slow' as const;
    if (sub === 'comments') {
      if (fresh.commentCount >= REVIEW_LIMITS.maxComments) return 'full' as const;
      const v = parsed.value as { atSec: number; text: string; name: string };
      tx.set(ref.collection('comments').doc(), { ...v, createdAt: now, resolved: false });
      tx.set(ref, { stamps, commentCount: FieldValue.increment(1) }, { merge: true });
    } else {
      const v = parsed.value as { decision: 'approved' | 'changes_requested'; note: string; name: string };
      tx.set(ref, { stamps, status: v.decision, decisions: [...(fresh.decisions ?? []), { ...v, at: now }].slice(-20) }, { merge: true });
    }
    return 'ok' as const;
  });
  if (outcome === 'gone') return reply(res, 410, { error: 'expired' });
  if (outcome === 'slow') return reply(res, 429, { error: 'rate_limited', message: 'Too many messages in a minute. Wait a moment and try again.' });
  if (outcome === 'full') return reply(res, 409, { error: 'full', message: 'This review has reached its comment limit.' });
  const comments = (await ref.collection('comments').get()).docs.map((c) => ({ id: c.id, ...c.data() }) as ReviewComment);
  return reply(res, 200, reviewPublicView((await ref.get()).data() as ReviewLinkDoc, comments));
}
