import type { CharacterDoc, JobDoc, ProjectDoc } from '@az-studio/shared';
import { col, db, FieldValue } from './firebase';
import { bibleCoverSignature, loadBibleCover } from './bible-cover';
import { prepareJob } from './prepare';
import { enqueueJob } from './jobs';
import { assertProjectBudget, assertWithinLimits, getSettings, spendSnapshot } from './usage';

/** Firestore retries and simultaneous reference completions create only one cover for this Bible. */
export async function queueBibleCover(projectId: string): Promise<string | null> {
  const ref = col.projects().doc(projectId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const uid = String(snap.get('ownerUid'));
  const bible = await loadBibleCover(uid, projectId);
  const previous = snap.get('coverBible') as {signature?: string; jobId?: string} | undefined;
  if (previous?.signature === bible.signature && previous.jobId) {
    const job = await col.jobs().doc(previous.jobId).get();
    if (job.get('status') === 'queued') await enqueueJob(previous.jobId, 'start');
    return previous.jobId;
  }
  const prepared = await prepareJob(uid, bible.request);
  assertWithinLimits(await getSettings(uid), await spendSnapshot(uid), prepared.estimate.usd);
  await assertProjectBudget(uid, projectId, prepared.estimate.usd);
  const id = `bible-cover-${bible.signature.slice(0, 40)}`;
  const childRef = col.jobs().doc(id);
  const jobId = await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    const characters = await tx.get(col.sub(projectId, 'characters'));
    const existing = await tx.get(childRef);
    if (!current.exists || current.get('ownerUid') !== uid) return null;
    const signature = bibleCoverSignature({...current.data(), id: projectId} as ProjectDoc, characters.docs.map(d => ({...d.data(), id: d.id} as CharacterDoc)));
    if (signature !== bible.signature) return null;
    const currentCover = current.get('coverBible') as {signature?: string; jobId?: string} | undefined;
    if (currentCover?.signature === signature && currentCover.jobId) return currentCover.jobId;
    if (existing.exists) return id;
    const now = FieldValue.serverTimestamp();
    const job: Omit<JobDoc, 'id'> = {
      ownerUid: uid, projectId, type: 'image.generate', status: 'queued', stage: 'Queued', progress: 0,
      modelId: prepared.modelId, params: prepared.params, estimate: prepared.estimate, batchId: null,
      target: {kind: 'project', id: projectId, sub: id}, label: prepared.label, attempt: 0,
      retryOf: null, external: null, result: null, error: null, cancelRequested: false, usageUsd: null, productionId: null,
    };
    tx.set(childRef, {...job, request: bible.request, createdAt: now, updatedAt: now});
    tx.update(ref, {coverJobId: id, coverBible: {signature, jobId: id}});
    return id;
  });
  if (jobId) await enqueueJob(jobId, 'start');
  return jobId;
}
