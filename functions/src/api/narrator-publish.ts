import { randomBytes } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  NARRATOR,
  PUBLICATION_CACHE,
  azStudioEmbedHtml,
  playerUrl,
  publicPeaks,
  type NarratorEditionDoc,
  type NarratorExportDoc,
  type NarratorPublicationDoc,
  type NarratorRequest,
  type PublicationRevision,
} from '@az-studio/shared';
import { db } from '../lib/firebase';
import { media, ncol, npath } from '../lib/narrator-store';
import type { Owner } from '../lib/owner';

type Req<O extends NarratorRequest['op']> = Extract<NarratorRequest, { op: O }>;

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function newPublicId(): string {
  const bytes = randomBytes(12);
  return [...bytes].map((b) => BASE62[b % 62]).join('');
}

async function ownedEdition(uid: string, editionId: string): Promise<NarratorEditionDoc & { id: string }> {
  const snap = await ncol.editions().doc(editionId).get();
  if (!snap.exists || snap.get('ownerUid') !== uid || snap.get('deleted')) throw new HttpsError('not-found', 'Edition not found.');
  return { ...(snap.data() as NarratorEditionDoc), id: snap.id };
}

/**
 * Publishes one reviewed export: its MP3 is copied to a per-revision public-serving path and becomes the
 * revision the stable player URL serves. Later edits and exports stay drafts until this is called again;
 * the public id (and so the embed URL) never changes. The WAV master and everything else stay private.
 */
export async function publish(owner: Owner, p: Req<'publish'>) {
  if ((p as { reviewed?: unknown }).reviewed !== true) throw new HttpsError('failed-precondition', 'Confirm that you have listened to this export before publishing it.');
  const edition = await ownedEdition(owner.uid, p.editionId);
  const exSnap = await ncol.exports(edition.id).doc(p.exportId).get();
  const ex = exSnap.exists ? (exSnap.data() as NarratorExportDoc) : null;
  if (!ex || ex.ownerUid !== owner.uid) throw new HttpsError('not-found', 'Export not found.');
  if (ex.status !== 'ready' || !ex.files.mp3 || !ex.durationSec) throw new HttpsError('failed-precondition', 'Only a finished export can be published.');
  const publicId = edition.publication?.publicId ?? newPublicId();
  const pubRef = ncol.publications().doc(publicId);
  const prev = (await pubRef.get()).data() as NarratorPublicationDoc | undefined;
  if (prev && prev.ownerUid !== owner.uid) throw new HttpsError('permission-denied', 'Not allowed.');
  if (prev?.status === 'published' && prev.current?.exportId === p.exportId) return { publicId, revision: prev.revision, unchanged: true, listenUrl: playerUrl(publicId), embedHtml: azStudioEmbedHtml(publicId, prev.current.title) };
  const revision = (prev?.revision ?? 0) + 1;
  const audioPath = npath.publicAudio(publicId, revision);
  // Revision paths never change content, so the object can be cached by browsers for its signed lifetime.
  const bytes = await media.copy(ex.files.mp3, audioPath, { contentType: 'audio/mpeg', cacheControl: `private, max-age=${PUBLICATION_CACHE.signedUrlTtlSec}` });
  const now = Date.now();
  const current: PublicationRevision = {
    revision,
    exportId: p.exportId,
    exportVersion: ex.version,
    audioPath,
    bytes,
    durationSec: ex.durationSec,
    title: edition.title,
    author: edition.author || NARRATOR.defaultAuthor,
    publishedDate: edition.publishedDate,
    articleUrl: edition.sourceUrl,
    sections: ex.sections.map((s) => ({ title: s.title, startSec: s.startSec })),
    peaks: publicPeaks(ex.peaks),
    publishedAt: now,
  };
  const retired = [...(prev?.retired ?? []), ...(prev?.current && prev.status === 'published' ? [{ revision: prev.current.revision, audioPath: prev.current.audioPath, until: now + PUBLICATION_CACHE.replacedGraceSec * 1000 }] : [])];
  const doc: NarratorPublicationDoc = { ownerUid: owner.uid, editionId: edition.id, status: 'published', revision, current, retired, history: [...(prev?.history ?? []), { revision, exportVersion: ex.version, at: now, action: 'published' as const }].slice(-50), unpublishedAt: null, updatedAt: now };
  await db.runTransaction(async (tx) => {
    tx.set(pubRef, doc);
    tx.update(ncol.editions().doc(edition.id), { publication: { publicId, status: 'published', exportId: p.exportId, exportVersion: ex.version, revision, publishedAt: now, unpublishedAt: null } });
  });
  return { publicId, revision, unchanged: false, listenUrl: playerUrl(publicId), embedHtml: azStudioEmbedHtml(publicId, edition.title) };
}

/**
 * Withdraws the publication: the public metadata answers "unavailable" at once (CDN copies expire within
 * PUBLICATION_CACHE.metadataSharedMaxAgeSec) and every public audio object is deleted, so new requests for
 * the audio fail immediately. Copies listeners already downloaded cannot be recalled.
 */
export async function unpublish(owner: Owner, p: Req<'unpublish'>) {
  const edition = await ownedEdition(owner.uid, p.editionId);
  const publicId = edition.publication?.publicId;
  if (!publicId) return { status: 'not_published' };
  await withdraw(owner.uid, publicId, edition.id);
  return { status: 'unpublished', publicId };
}

export async function withdraw(uid: string, publicId: string, editionId: string): Promise<void> {
  const pubRef = ncol.publications().doc(publicId);
  const prev = (await pubRef.get()).data() as NarratorPublicationDoc | undefined;
  if (!prev || prev.ownerUid !== uid) return;
  const now = Date.now();
  await pubRef.set({ ...prev, status: 'unpublished', current: null, retired: [], unpublishedAt: now, updatedAt: now, history: [...prev.history, { revision: prev.revision, exportVersion: prev.current?.exportVersion ?? 0, at: now, action: 'unpublished' }].slice(-50) });
  const edRef = ncol.editions().doc(editionId);
  if ((await edRef.get()).exists) await edRef.update({ 'publication.status': 'unpublished', 'publication.unpublishedAt': now });
  for (const path of [prev.current?.audioPath, ...prev.retired.map((r) => r.audioPath)]) if (path) await media.remove(path);
}

/** Deletes replaced revisions whose grace window has passed (maintenance). */
export async function sweepRetiredRevisions(now = Date.now()): Promise<number> {
  let removed = 0;
  const snap = await ncol.publications().where('status', '==', 'published').get();
  for (const d of snap.docs) {
    const pub = d.data() as NarratorPublicationDoc;
    const due = pub.retired.filter((r) => r.until <= now);
    if (!due.length) continue;
    for (const r of due) await media.remove(r.audioPath);
    await d.ref.update({ retired: pub.retired.filter((r) => r.until > now) });
    removed += due.length;
  }
  return removed;
}
