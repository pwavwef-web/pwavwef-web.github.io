import { randomBytes } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import { REVIEW_LIMITS, reviewLinkState, type ApiRequest, type AssetDoc, type RenderDoc, type ReviewComment, type ReviewLinkDoc } from '@az-studio/shared';
import { col, db } from '../lib/firebase';
import type { Owner } from '../lib/owner';

type Payload<A extends ApiRequest['action']> = Extract<ApiRequest, { action: A }>['payload'];

export const reviewLinksCol = () => db.collection('reviewLinks');

/** 24 random bytes → 32 URL-safe characters: the link itself is the credential. */
export function newReviewToken(): string {
  return randomBytes(24).toString('base64url');
}

async function ownedLink(uid: string, token: string): Promise<ReviewLinkDoc> {
  const snap = await reviewLinksCol().doc(token).get();
  const doc = snap.data() as ReviewLinkDoc | undefined;
  if (!doc || doc.ownerUid !== uid) throw new HttpsError('not-found', 'Review link not found.');
  return doc;
}

const summary = (d: ReviewLinkDoc, now = Date.now()) => {
  const { stamps: _stamps, ownerUid: _owner, storagePath: _path, ...rest } = d;
  return { ...rest, state: reviewLinkState(d, now), url: `/review/${d.token}` };
};

/** Owner side of client review links: create for a finished render, list with comments, revoke, resolve comments. */
export async function reviewLinks(owner: Owner, p: Payload<'reviewLinks'>) {
  if (p.op === 'create') {
    const r = (await col.renders().doc(p.renderId).get()).data() as RenderDoc | undefined;
    if (!r || r.ownerUid !== owner.uid) throw new HttpsError('not-found', 'Render not found.');
    if (r.status !== 'completed' || !r.outputAssetId) throw new HttpsError('failed-precondition', 'Only a finished render can be shared for review.');
    const a = (await col.assets().doc(r.outputAssetId).get()).data() as AssetDoc | undefined;
    if (!a?.storagePath || a.status !== 'ready') throw new HttpsError('failed-precondition', 'The render’s file is not available.');
    const project = await col.projects().doc(r.projectId).get();
    const now = Date.now();
    const days = Math.min(REVIEW_LIMITS.maxDays, Math.max(REVIEW_LIMITS.minDays, Math.round(p.expiresInDays ?? REVIEW_LIMITS.defaultDays)));
    const token = newReviewToken();
    const doc: ReviewLinkDoc = {
      token,
      ownerUid: owner.uid,
      projectId: r.projectId,
      projectTitle: String(project.get('title') ?? ''),
      renderId: r.id ?? p.renderId,
      assetId: r.outputAssetId,
      storagePath: a.storagePath,
      mimeType: a.mimeType || 'video/mp4',
      title: (p.title?.trim() || String(project.get('title') ?? 'Review')).slice(0, 160),
      versionLabel: (p.versionLabel?.trim() || '').slice(0, 60),
      durationSec: Number(a.durationSec ?? r.durationSec ?? 0),
      width: Number(a.width ?? r.width ?? 0),
      height: Number(a.height ?? r.height ?? 0),
      createdAt: now,
      expiresAt: now + days * 86_400_000,
      revokedAt: null,
      status: 'open',
      decisions: [],
      commentCount: 0,
      stamps: [],
    };
    await reviewLinksCol().doc(token).set(doc);
    return { link: summary(doc, now) };
  }
  if (p.op === 'revoke') {
    await ownedLink(owner.uid, p.token);
    await reviewLinksCol().doc(p.token).set({ revokedAt: Date.now() }, { merge: true });
    return { link: summary(await ownedLink(owner.uid, p.token)) };
  }
  if (p.op === 'resolve') {
    await ownedLink(owner.uid, p.token);
    await reviewLinksCol().doc(p.token).collection('comments').doc(p.commentId).set({ resolved: p.resolved }, { merge: true });
    return { ok: true };
  }
  // list: newest first, with comments.
  let q = reviewLinksCol().where('ownerUid', '==', owner.uid);
  if (p.projectId) q = q.where('projectId', '==', p.projectId);
  const links = (await q.get()).docs.map((d) => d.data() as ReviewLinkDoc).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  const comments = await Promise.all(links.map(async (l) => (await reviewLinksCol().doc(l.token).collection('comments').get()).docs.map((c) => ({ id: c.id, ...c.data() }) as ReviewComment).sort((a, b) => a.atSec - b.atSec)));
  return { links: links.map((l, i) => ({ ...summary(l), comments: comments[i]! })) };
}
