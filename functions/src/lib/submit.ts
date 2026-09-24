import { HttpsError } from 'firebase-functions/v2/https';
import { sumEstimates, type CostEstimate, type JobDoc, type JobRequest, type JobTarget, type JobType, type StudioSettings } from '@az-studio/shared';
import { PRICING } from '../config/pricing';
import { col, db, FieldValue } from './firebase';
import { enqueueJob } from './jobs';
import { prepareJob, type PreparedJob } from './prepare';
import { assertWithinLimits, getSettings, spendSnapshot } from './usage';

export async function prepareAll(uid: string, jobs: JobRequest[]): Promise<PreparedJob[]> {
  const out: PreparedJob[] = [];
  for (const j of jobs) out.push(await prepareJob(uid, j));
  return out;
}

export function confirmationPolicy(settings: StudioSettings, prepared: Pick<PreparedJob, 'type'>[], totalUsd: number) {
  const videos = prepared.filter((p) => p.type === 'video.generate').length;
  const reasons: string[] = [];
  if (totalUsd >= settings.confirmAboveUsd) reasons.push(`Estimated cost ≥ $${settings.confirmAboveUsd.toFixed(2)} confirmation threshold`);
  if (videos >= 2) reasons.push(`${videos} video generations in one batch`);
  return { required: reasons.length > 0, reasons };
}

export interface CreateJobsOptions {
  batchLabel?: string;
  confirmedUsd?: number | null;
  /** Production run that owns these jobs (their completion advances it). */
  productionId?: string | null;
  /** Skip the confirmation step (the owner already approved the production's budget). */
  preconfirmed?: boolean;
}

/**
 * Validates, prices and writes jobs (plus the takes, chain turns and render documents they create),
 * then enqueues them. Spending limits are always enforced.
 */
export async function createJobs(uid: string, requests: JobRequest[], opts: CreateJobsOptions = {}, preparedIn?: PreparedJob[]): Promise<{ jobIds: string[]; batchId: string | null; estimate: CostEstimate; prepared: PreparedJob[] }> {
  const settings = await getSettings(uid);
  const prepared = preparedIn ?? (await prepareAll(uid, requests));
  const total = sumEstimates(prepared.map((x) => x.estimate), PRICING);
  if (!opts.preconfirmed) {
    const confirm = confirmationPolicy(settings, prepared, total.usd);
    if (confirm.required && (opts.confirmedUsd === null || opts.confirmedUsd === undefined || opts.confirmedUsd + 0.005 < total.usd)) {
      throw new HttpsError('failed-precondition', 'Confirm the estimated cost before submitting this batch.', { reason: 'confirmation_required', estimate: total, reasons: confirm.reasons });
    }
  }
  assertWithinLimits(settings, await spendSnapshot(uid), total.usd);

  const now = FieldValue.serverTimestamp();
  const batchId = prepared.length > 1 ? col.batches().doc().id : null;
  const writes = db.batch();
  const jobIds: string[] = [];
  const takeCounters = new Map<string, number>();
  const turnCounters = new Map<string, number>();
  for (const [i, x] of prepared.entries()) {
    const jobRef = col.jobs().doc();
    jobIds.push(jobRef.id);
    const job: Omit<JobDoc, 'id'> & { request: JobRequest } = {
      ownerUid: uid,
      projectId: x.projectId,
      type: x.type,
      status: 'queued',
      stage: 'Queued',
      progress: 0,
      modelId: x.modelId,
      params: x.params,
      estimate: x.estimate,
      batchId,
      target: x.target,
      label: x.label,
      attempt: 0,
      retryOf: null,
      external: null,
      result: null,
      error: null,
      cancelRequested: false,
      usageUsd: null,
      productionId: opts.productionId ?? null,
      request: requests[i]!,
    };
    writes.set(jobRef, { ...job, createdAt: now, updatedAt: now });
    if (x.take && x.projectId) {
      const shotRef = col.projects().doc(x.projectId).collection('shots').doc(x.take.shotId);
      if (!takeCounters.has(x.take.shotId)) takeCounters.set(x.take.shotId, Number((await shotRef.get()).get('takeCount') ?? 0));
      const index = takeCounters.get(x.take.shotId)! + 1;
      takeCounters.set(x.take.shotId, index);
      writes.set(shotRef.collection('takes').doc(x.take.takeId), {
        index,
        jobId: jobRef.id,
        assetId: null,
        status: 'queued',
        prompt: x.take.prompt,
        params: x.take.params,
        interactionId: null,
        parentTakeId: x.take.parentTakeId,
        label: x.take.label ?? `Take ${index}`,
        rating: 0,
        notes: '',
        approved: false,
        productionId: opts.productionId ?? null,
        versionId: null,
        quality: opts.productionId ? { verdict: 'pending', overall: null, reportId: null } : null,
        createdAt: now,
      });
      writes.set(shotRef, { takeCount: FieldValue.increment(1), status: 'queued', updatedAt: now }, { merge: true });
    }
    if (x.chain) {
      const chainRef = col.chains().doc(x.chain.chainId);
      if (x.chain.isNew) {
        turnCounters.set(x.chain.chainId, 0);
        writes.set(chainRef, { ownerUid: uid, projectId: x.projectId, kind: x.chain.kind, title: x.chain.title, headTurnId: null, turnCount: 1, createdAt: now, updatedAt: now });
      } else {
        if (!turnCounters.has(x.chain.chainId)) turnCounters.set(x.chain.chainId, Number((await chainRef.get()).get('turnCount') ?? 0));
        writes.set(chainRef, { turnCount: FieldValue.increment(1), updatedAt: now }, { merge: true });
      }
      const index = turnCounters.get(x.chain.chainId)!;
      turnCounters.set(x.chain.chainId, index + 1);
      writes.set(chainRef.collection('turns').doc(x.chain.turnId), { index, parentTurnId: x.chain.parentTurnId, prompt: x.chain.prompt, mode: x.chain.mode, jobId: jobRef.id, status: 'queued', assetId: null, interactionId: null, createdAt: now });
    }
    if (x.render) {
      writes.set(col.renders().doc(x.render.renderId), { ...x.render.doc, status: 'queued', stage: 'Queued', progress: 0, jobId: jobRef.id, executionName: null, outputAssetId: null, error: null, createdAt: now, updatedAt: now });
    }
  }
  if (batchId) writes.set(col.batches().doc(batchId), { ownerUid: uid, label: opts.batchLabel ?? `${prepared.length} jobs`, jobIds, estimate: total, confirmedUsd: opts.confirmedUsd ?? null, createdAt: now });
  await writes.commit();
  await Promise.all(jobIds.map((id) => enqueueJob(id, 'start')));
  return { jobIds, batchId, estimate: total, prepared };
}

export interface InternalJobInput {
  type: Extract<JobType, 'quality.inspect' | 'media.composite'>;
  projectId: string;
  modelId: string | null;
  label: string;
  params: Record<string, unknown>;
  estimate: CostEstimate;
  target: JobTarget | null;
  productionId: string;
}

/** Jobs the production loop runs on its own (inspection, repair edits); they are not user-submittable. */
export async function createInternalJob(uid: string, input: InternalJobInput): Promise<string> {
  const settings = await getSettings(uid);
  if (input.estimate.usd > 0) assertWithinLimits(settings, await spendSnapshot(uid), input.estimate.usd);
  const ref = col.jobs().doc();
  const now = FieldValue.serverTimestamp();
  const job: Omit<JobDoc, 'id'> = {
    ownerUid: uid,
    projectId: input.projectId,
    type: input.type,
    status: 'queued',
    stage: 'Queued',
    progress: 0,
    modelId: input.modelId,
    params: input.params,
    estimate: input.estimate,
    batchId: null,
    target: input.target,
    label: input.label,
    attempt: 0,
    retryOf: null,
    external: null,
    result: null,
    error: null,
    cancelRequested: false,
    usageUsd: null,
    productionId: input.productionId,
  };
  await ref.set({ ...job, createdAt: now, updatedAt: now });
  await enqueueJob(ref.id, 'start');
  return ref.id;
}
