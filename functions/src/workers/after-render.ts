import { logger } from 'firebase-functions';
import type { JobDoc } from '@az-studio/shared';
import { col, db } from '../lib/firebase';
import { prepareFinalInspect } from '../lib/prepare-studio';
import { createInternalJob } from '../lib/submit';

/**
 * A render that asked for inspection (every final render does) gets its final-film inspection as soon
 * as the renderer has finished. Claimed in a transaction so duplicate deliveries start it once.
 */
export async function afterRenderCompleted(job: JobDoc): Promise<void> {
  const renderId = (job.external?.renderId as string | undefined) ?? (job.params as { renderId?: string }).renderId;
  if (!renderId || !job.projectId) return;
  const ref = col.renders().doc(renderId);
  const claimed = await db.runTransaction(async (tx) => {
    const r = await tx.get(ref);
    if (!r.exists || r.get('status') !== 'completed' || !r.get('inspect') || r.get('finalInspection') || !r.get('outputAssetId')) return false;
    tx.set(ref, { finalInspection: { id: renderId, status: 'queued', readiness: null, score: null, errors: 0, warnings: 0 } }, { merge: true });
    return true;
  });
  if (!claimed) return;
  try {
    const prepared = await prepareFinalInspect(job.ownerUid, { type: 'final.inspect', projectId: job.projectId, renderId });
    await createInternalJob(job.ownerUid, { type: 'final.inspect', projectId: job.projectId, modelId: prepared.modelId, label: prepared.label, params: prepared.params, estimate: prepared.estimate, target: prepared.target, productionId: null });
  } catch (e) {
    // The export stays blocked; the director can start the inspection again from the render.
    logger.warn('final inspection could not start', { renderId, error: String(e) });
    await ref.set({ finalInspection: { id: renderId, status: 'failed', readiness: 'blocked', score: null, errors: 0, warnings: 0, error: String((e as Error)?.message ?? e).slice(0, 300) } }, { merge: true });
  }
}
