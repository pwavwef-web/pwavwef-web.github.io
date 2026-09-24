import { getFunctions } from 'firebase-admin/functions';
import { logger } from 'firebase-functions';
import { canTransition, isTerminal, type JobDoc, type JobError, type JobStatus } from '@az-studio/shared';
import { col, db, FieldValue } from './firebase';
import { releaseSlot } from './concurrency';
import { REGION, WORKER_FUNCTION } from '../config/runtime';

export type WorkerStep = 'start' | 'poll' | 'advance';

/** A job step, or an `advance` of a production run (the quality-control loop). */
export interface WorkerPayload {
  jobId?: string;
  productionId?: string;
  step: WorkerStep;
  seq: number;
}

async function enqueue(payload: WorkerPayload, key: string, delaySec?: number): Promise<void> {
  const queue = getFunctions().taskQueue<WorkerPayload>(`locations/${REGION}/functions/${WORKER_FUNCTION}`);
  try {
    await queue.enqueue(payload, {
      scheduleDelaySeconds: Math.max(0, Math.round(delaySec ?? 0)),
      dispatchDeadlineSeconds: 1800,
      id: `${key}-${payload.step}-${payload.seq}-${Date.now().toString(36)}`,
    });
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code.includes('task-already-exists')) return;
    throw e;
  }
}

/** Enqueues a worker task. Duplicate task ids are treated as already enqueued. */
export async function enqueueJob(jobId: string, step: WorkerStep = 'start', opts: { delaySec?: number; seq?: number } = {}): Promise<void> {
  await enqueue({ jobId, step, seq: opts.seq ?? 0 }, jobId, opts.delaySec);
}

/** Asks the worker to advance a production run (after a child job finished, or to resume one). */
export async function enqueueProduction(productionId: string, opts: { delaySec?: number; seq?: number } = {}): Promise<void> {
  await enqueue({ productionId, step: 'advance', seq: opts.seq ?? Math.floor(Date.now() / 1000) % 1_000_000 }, `prod-${productionId}`, opts.delaySec);
}

export async function getJob(jobId: string): Promise<JobDoc | null> {
  const snap = await col.jobs().doc(jobId).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as JobDoc) : null;
}

type JobPatch = Partial<Omit<JobDoc, 'id' | 'status' | 'createdAt' | 'updatedAt'>> & Record<string, unknown>;

/**
 * Atomically moves a job to `to` if the transition is legal. Returns the updated job, or null when
 * the job is missing or already in an incompatible state (e.g. cancelled meanwhile).
 */
export async function transition(
  jobId: string,
  to: JobStatus,
  patch: JobPatch = {},
  mirrorExtra: { assetId?: string | null; interactionId?: string | null } = {},
): Promise<JobDoc | null> {
  const ref = col.jobs().doc(jobId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const job = { id: snap.id, ...snap.data() } as JobDoc;
    if (!canTransition(job.status, to)) return null;
    const data: Record<string, unknown> = { ...patch, status: to, updatedAt: FieldValue.serverTimestamp() };
    if (to === 'validating' && !job.startedAt) data.startedAt = FieldValue.serverTimestamp();
    if (isTerminal(to)) {
      data.completedAt = FieldValue.serverTimestamp();
      data.lease = FieldValue.delete();
      if (to === 'completed') data.progress = 1;
    }
    tx.update(ref, data);
    return { ...job, ...patch, status: to } as JobDoc;
  });
  if (result) {
    await mirrorTarget(result, to, mirrorExtra);
    // A finished child job moves its production run to the next stage.
    if (isTerminal(to) && result.productionId) {
      try {
        await enqueueProduction(result.productionId, { delaySec: 2 });
      } catch (e) {
        logger.error('could not advance production', { jobId, productionId: result.productionId, error: String(e) });
      }
    }
  }
  return result;
}

export interface Lease {
  until: number;
}

/**
 * Claims a job for processing: `queued → validating`, or takes over a `validating` job whose lease
 * expired (a crashed worker made no paid calls yet). Returns null when another worker owns it.
 */
export async function claimJob(jobId: string, leaseMs = 10 * 60 * 1000): Promise<JobDoc | null> {
  const ref = col.jobs().doc(jobId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const job = { id: snap.id, ...snap.data() } as JobDoc & { lease?: Lease };
    const leaseValid = (job.lease?.until ?? 0) > Date.now();
    if (job.status === 'queued' || (job.status === 'validating' && !leaseValid)) {
      const lease = { until: Date.now() + leaseMs };
      tx.update(ref, {
        status: 'validating',
        stage: 'Validating inputs',
        lease,
        updatedAt: FieldValue.serverTimestamp(),
        ...(job.startedAt ? {} : { startedAt: FieldValue.serverTimestamp() }),
      });
      return { ...job, status: 'validating', lease } as JobDoc;
    }
    return null;
  });
}

/** Updates progress/stage without changing status (ignored once the job is terminal). */
export async function progress(jobId: string, stage: string, value?: number, extra: JobPatch = {}): Promise<void> {
  const ref = col.jobs().doc(jobId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || isTerminal(snap.get('status') as JobStatus)) return;
    tx.update(ref, { stage, ...(value !== undefined ? { progress: Math.max(0, Math.min(1, value)) } : {}), ...extra, updatedAt: FieldValue.serverTimestamp() });
  });
}

export async function failJob(job: Pick<JobDoc, 'id' | 'ownerUid'>, error: JobError): Promise<void> {
  logger.warn('job failed', { jobId: job.id, code: error.code, message: error.message, details: error.details });
  await transition(job.id, 'failed', { error, stage: error.safety ? 'Blocked by safety filters' : 'Failed' });
  await releaseSlot(job.ownerUid, job.id);
}

export async function cancelJobDoc(job: Pick<JobDoc, 'id' | 'ownerUid'>, stage = 'Cancelled'): Promise<void> {
  await transition(job.id, 'cancelled', { stage });
  await releaseSlot(job.ownerUid, job.id);
}

/** Keeps shot takes, chain turns and render documents in sync with their job. */
export async function mirrorTarget(job: JobDoc, status: JobStatus, extra: { assetId?: string | null; interactionId?: string | null } = {}): Promise<void> {
  const t = job.target;
  if (!t) return;
  const now = FieldValue.serverTimestamp();
  try {
    if (t.kind === 'shot' && job.projectId && t.sub) {
      const shotRef = col.projects().doc(job.projectId).collection('shots').doc(t.id);
      const takeRef = shotRef.collection('takes').doc(t.sub);
      await takeRef.set({ status, ...(extra.assetId !== undefined ? { assetId: extra.assetId } : {}), ...(extra.interactionId !== undefined ? { interactionId: extra.interactionId } : {}) }, { merge: true });
      await db.runTransaction(async (tx) => {
        const shot = await tx.get(shotRef);
        if (!shot.exists) return;
        const current = shot.get('status') as string;
        const hasTake = Boolean(shot.get('selectedTakeId'));
        let next: string;
        if (current === 'approved') next = 'approved';
        else if (status === 'completed') next = 'ready';
        else if (status === 'failed') next = hasTake ? 'ready' : 'failed';
        else if (status === 'cancelled') next = hasTake ? 'ready' : 'planned';
        else next = 'generating';
        const patch: Record<string, unknown> = { status: next, updatedAt: now };
        if (status === 'completed' && extra.assetId && !shot.get('selectedTakeId')) patch.selectedTakeId = t.sub;
        tx.update(shotRef, patch);
      });
    } else if (t.kind === 'chain' && t.sub) {
      const chainRef = col.chains().doc(t.id);
      await chainRef.collection('turns').doc(t.sub).set(
        { status, ...(extra.assetId !== undefined ? { assetId: extra.assetId } : {}), ...(extra.interactionId !== undefined ? { interactionId: extra.interactionId } : {}) },
        { merge: true },
      );
      await chainRef.set({ updatedAt: now, ...(status === 'completed' ? { headTurnId: t.sub } : {}) }, { merge: true });
    } else if (t.kind === 'timeline' && t.sub) {
      await col.renders().doc(t.sub).set({ status, updatedAt: now }, { merge: true });
    }
  } catch (e) {
    logger.error('mirrorTarget failed', { jobId: job.id, error: String(e) });
  }
}
