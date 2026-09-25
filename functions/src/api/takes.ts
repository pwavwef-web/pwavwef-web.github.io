import { HttpsError } from 'firebase-functions/v2/https';
import type { ApiRequest, ShotDoc, TakeDoc } from '@az-studio/shared';
import { approveContinuity, withdrawContinuity } from '../lib/continuity';
import { col, db, FieldValue } from '../lib/firebase';
import type { Owner } from '../lib/owner';
import { loadProduction, mirrorShot } from '../lib/production';
import { productionAction } from './production';

type Payload<A extends ApiRequest['action']> = Extract<ApiRequest, { action: A }>['payload'];

/**
 * Approving a take makes it the shot's take of record and updates canonical continuity (character,
 * prop and camera-axis records and the final frame the next shot continues from). A take produced
 * under quality control is approved through its production, which records any accepted issues; a
 * take that was never inspected is approved with continuity marked “needs review”.
 */
export async function takeAction(owner: Owner, p: Payload<'takeAction'>) {
  const proj = await col.projects().doc(p.projectId).get();
  if (!proj.exists || proj.get('ownerUid') !== owner.uid) throw new HttpsError('not-found', 'Project not found.');
  const shotRef = proj.ref.collection('shots').doc(p.shotId);
  const [shotSnap, takeSnap] = await Promise.all([shotRef.get(), shotRef.collection('takes').doc(p.takeId).get()]);
  if (!shotSnap.exists || !takeSnap.exists) throw new HttpsError('not-found', 'Take not found.');
  const shot = shotSnap.data() as ShotDoc;
  const take = { ...(takeSnap.data() as TakeDoc), id: takeSnap.id };

  if (p.action === 'approve') {
    if (take.status !== 'completed' || !take.assetId) throw new HttpsError('failed-precondition', 'Only a finished take can be approved.');
    if (take.productionId) {
      const prod = await loadProduction(take.productionId);
      if (prod && prod.ownerUid === owner.uid && take.versionId) {
        if (take.quality?.verdict !== 'passed') throw new HttpsError('failed-precondition', 'This take has not passed quality review. Open it in the AI Director Review to repair it or to mark its issues as acceptable.', { reason: 'quality_review_failed' });
        return productionAction(owner, { productionId: prod.id, action: 'approve', versionId: take.versionId, categories: [], note: p.note ?? '' });
      }
    }
    const batch = db.batch();
    if (shot.approvedTakeId && shot.approvedTakeId !== take.id) batch.set(shotRef.collection('takes').doc(shot.approvedTakeId), { approved: false }, { merge: true });
    batch.set(takeSnap.ref, { approved: true }, { merge: true });
    batch.set(shotRef, { approvedTakeId: take.id, selectedTakeId: take.id, status: 'approved', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await batch.commit();
    const inspected = take.quality?.verdict === 'passed';
    await approveContinuity(p.projectId, p.shotId, { versionId: take.versionId ?? null, productionId: take.productionId ?? null, waivedKinds: [], takeAssetId: take.assetId, repaired: false, inspected, ownerUid: owner.uid });
    return { status: 'approved', takeId: take.id, continuity: inspected ? 'locked' : 'needs_review' };
  }

  // Withdraw: the canonical records of this shot are removed; later shots re-plan from the previous approved shot.
  if (shot.approvedTakeId !== take.id) return { status: shot.approvedTakeId ? 'other_take_approved' : 'not_approved' };
  const batch = db.batch();
  batch.set(takeSnap.ref, { approved: false }, { merge: true });
  batch.set(shotRef, { approvedTakeId: null, status: 'ready', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await batch.commit();
  await withdrawContinuity(p.projectId, p.shotId);
  if (take.productionId) {
    const prod = await loadProduction(take.productionId);
    if (prod && prod.ownerUid === owner.uid && prod.status === 'approved') {
      const patch = { status: 'awaiting_review' as const, stage: 'approve' as const, approval: null, approvedVersionId: null, stageMessage: `Director withdrew the approval${p.note ? ` — ${p.note}` : ''}` };
      await col.productions().doc(prod.id).set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await col.productions().doc(prod.id).collection('events').add({ at: Date.now(), stage: 'approve', status: 'awaiting_review', message: patch.stageMessage, detail: { takeId: take.id, uid: owner.uid }, createdAt: FieldValue.serverTimestamp() });
      await mirrorShot({ ...prod, ...patch });
    }
  }
  return { status: 'withdrawn', takeId: take.id };
}
