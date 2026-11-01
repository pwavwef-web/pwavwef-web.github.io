import { HttpsError } from 'firebase-functions/v2/https';
import { BRAND_KIT_LIMITS, kitProblems, normalizeBrandKit, prepareKitSave, reconfirmKit, stableHash, todayKey, type BrandKitInput, type BrandKitRequest } from '@az-studio/shared';
import { col, db, FieldValue } from '../lib/firebase';
import type { Owner } from '../lib/owner';
import { assertRateLimit } from '../lib/usage';

/**
 * Brand kits (`brandKits/{id}`): one per client. The owner reads them directly (owner-read rule); every write comes
 * through here so the files a kit points at are checked (the owner's, ready, the right kind), edits re-confirm the
 * prices and contacts they change, and another tab's newer save is a conflict rather than a silent overwrite.
 */

type Req<O extends BrandKitRequest['op']> = Extract<BrandKitRequest, { op: O }>;

export const brandKitsCol = () => db.collection('brandKits');

/** Loads a kit the caller owns; anything else looks like a missing kit. */
export async function loadKit(uid: string, kitId: string): Promise<{ kit: BrandKitInput; revision: number }> {
  const snap = await brandKitsCol().doc(kitId).get();
  if (!snap.exists || snap.get('ownerUid') !== uid) throw new HttpsError('not-found', 'Brand kit not found.');
  return { kit: normalizeBrandKit(snap.data()), revision: Number(snap.get('revision') ?? 0) };
}

/** Every file a kit refers to must be the owner's and ready: logos and photos are pictures, fonts are .ttf/.otf files. */
async function assertKitFiles(uid: string, kit: BrandKitInput): Promise<void> {
  const want = new Map<string, 'image' | 'font'>();
  for (const l of kit.logos) want.set(l.assetId, 'image');
  for (const p of kit.photos) want.set(p.assetId, 'image');
  for (const f of [kit.fonts.heading, kit.fonts.body]) if (f.uploadAssetId) want.set(f.uploadAssetId, 'font');
  if (!want.size) return;
  const snaps = await db.getAll(...[...want.keys()].map((id) => col.assets().doc(id)));
  for (const s of snaps) {
    const kind = want.get(s.id)!;
    if (!s.exists || s.get('ownerUid') !== uid) throw new HttpsError('invalid-argument', 'A logo, photo or font in this kit is not in your library.');
    if (s.get('status') !== 'ready') throw new HttpsError('failed-precondition', `“${String(s.get('title') ?? s.id).slice(0, 60)}” is still being checked. Save again when it is ready.`);
    if (kind === 'image' && s.get('kind') !== 'image') throw new HttpsError('invalid-argument', `“${String(s.get('title') ?? s.id).slice(0, 60)}” is not a picture.`);
    if (kind === 'font' && (s.get('kind') !== 'document' || !/\.(ttf|otf)$/i.test(String(s.get('fileName') ?? '')))) throw new HttpsError('invalid-argument', `“${String(s.get('title') ?? s.id).slice(0, 60)}” is not a .ttf or .otf font file.`);
  }
}

async function save(owner: Owner, p: Req<'save'>) {
  await assertRateLimit(owner.uid, 1, 60);
  const problems = kitProblems(p.kit);
  if (problems.length) throw new HttpsError('invalid-argument', problems.join(' '));
  await assertKitFiles(owner.uid, p.kit);
  const today = todayKey();
  if (!p.kitId) {
    const count = (await brandKitsCol().where('ownerUid', '==', owner.uid).limit(BRAND_KIT_LIMITS.kits).get()).size;
    if (count >= BRAND_KIT_LIMITS.kits) throw new HttpsError('resource-exhausted', `You have ${BRAND_KIT_LIMITS.kits} brand kits, the most allowed. Delete one first.`);
    const ref = brandKitsCol().doc(`bk${stableHash([owner.uid, p.kit.name, Date.now()])}`.slice(0, 40));
    const kit = prepareKitSave(p.kit, null, today);
    await ref.set({ ...kit, ownerUid: owner.uid, revision: 1, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { kitId: ref.id, revision: 1 };
  }
  const ref = brandKitsCol().doc(p.kitId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('ownerUid') !== owner.uid) throw new HttpsError('not-found', 'Brand kit not found.');
    const revision = Number(snap.get('revision') ?? 0);
    if (p.revision !== null && p.revision !== revision) throw new HttpsError('aborted', 'This kit was changed somewhere else (another tab?). Reload to see the latest version.', { reason: 'revision_conflict', revision });
    const kit = prepareKitSave(p.kit, normalizeBrandKit(snap.data()), today);
    tx.set(ref, { ...kit, ownerUid: owner.uid, revision: revision + 1, createdAt: snap.get('createdAt') ?? FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { kitId: ref.id, revision: revision + 1 };
  });
}

async function remove(owner: Owner, p: Req<'delete'>) {
  await loadKit(owner.uid, p.kitId);
  // Ads that used the kit keep the copies they were given; they only lose the link back to it.
  await brandKitsCol().doc(p.kitId).delete();
  return { deleted: true };
}

async function reconfirm(owner: Owner, p: Req<'reconfirm'>) {
  const ref = brandKitsCol().doc(p.kitId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('ownerUid') !== owner.uid) throw new HttpsError('not-found', 'Brand kit not found.');
    const kit = normalizeBrandKit(snap.data());
    const known = new Set([...kit.offers.map((o) => o.id), ...kit.contacts.map((c) => c.id)]);
    const missing = p.entryIds.filter((x) => !known.has(x));
    if (missing.length) throw new HttpsError('invalid-argument', 'A price or contact to re-confirm is no longer in the kit. Reload it.');
    const revision = Number(snap.get('revision') ?? 0) + 1;
    tx.update(ref, { ...reconfirmKit(kit, p.entryIds), revision, updatedAt: FieldValue.serverTimestamp() });
    return { kitId: p.kitId, revision, confirmed: p.entryIds.length };
  });
}

export async function brandKits(owner: Owner, p: BrandKitRequest) {
  switch (p.op) {
    case 'save':
      return save(owner, p);
    case 'delete':
      return remove(owner, p);
    case 'reconfirm':
      return reconfirm(owner, p);
    default: {
      const never: never = p;
      throw new HttpsError('invalid-argument', `Unknown brand kit operation ${(never as { op?: string }).op ?? ''}.`);
    }
  }
}
