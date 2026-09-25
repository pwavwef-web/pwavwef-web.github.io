import { GoogleAuth } from 'google-auth-library';
import { logger } from 'firebase-functions';
import { isTerminal, type JobDoc } from '@az-studio/shared';
import { PROJECT_ID, REGION, RENDER_JOB_NAME } from '../config/runtime';
import { col, FieldValue } from '../lib/firebase';
import { JobFailure } from '../lib/errors';
import { enqueueJob, failJob, getJob, progress, transition } from '../lib/jobs';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
export const RUN_API = 'https://run.googleapis.com/v2';

export interface Execution {
  name?: string;
  completionTime?: string;
  succeededCount?: number;
  failedCount?: number;
  cancelledCount?: number;
  runningCount?: number;
  conditions?: { type?: string; state?: string; message?: string }[];
}

export async function runApi<T>(url: string, method: 'GET' | 'POST', data?: unknown): Promise<T> {
  const client = await auth.getClient();
  const res = await client.request<T>({ url, method, ...(data !== undefined ? { data } : {}) });
  return res.data;
}

export async function cancelExecution(executionName: string): Promise<void> {
  await runApi(`${RUN_API}/${executionName}:cancel`, 'POST', {});
}

/** Launches the FFmpeg renderer as a Cloud Run job execution for this render. */
export async function startRenderJob(job: JobDoc): Promise<void> {
  const p = job.params as { renderId: string; durationSec: number; quality: string };
  if (!(await transition(job.id, 'rendering', { stage: 'Starting the renderer', progress: 0.02, lease: { until: Date.now() + 5 * 60_000 } }))) return;
  const url = `${RUN_API}/projects/${PROJECT_ID}/locations/${REGION}/jobs/${RENDER_JOB_NAME}:run`;
  const hours = Math.min(12, Math.max(1, Math.ceil((p.durationSec * (p.quality === 'final' ? 3 : 1.5)) / 3600) + 1));
  let op: { name?: string; metadata?: { name?: string } };
  try {
    op = await runApi(url, 'POST', {
      overrides: { containerOverrides: [{ env: [{ name: 'RENDER_ID', value: p.renderId }, { name: 'JOB_ID', value: job.id }] }], taskCount: 1, timeout: `${hours * 3600}s` },
    });
  } catch (e) {
    const status = (e as { response?: { status?: number } }).response?.status;
    throw new JobFailure({
      code: status === 404 ? 'renderer_missing' : 'renderer_launch_failed',
      message: status === 404 ? 'The Cloud Run renderer job is not deployed.' : `Could not start the renderer: ${String((e as Error).message).slice(0, 200)}`,
      retryable: status === undefined || status >= 500,
    });
  }
  const executionName = op.metadata?.name ?? null;
  await transition(job.id, 'rendering', { stage: 'Renderer starting on Cloud Run', progress: 0.04, external: { renderId: p.renderId, ...(executionName ? { executionName } : {}) }, lease: null });
  await col.renders().doc(p.renderId).set({ executionName, status: 'rendering', stage: 'Renderer starting on Cloud Run', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await enqueueJob(job.id, 'poll', { delaySec: 60, seq: 1 });
}

/** Watchdog: detects renderer crashes or cancellations the renderer could not report itself. */
export async function watchRenderJob(job: JobDoc, seq: number): Promise<void> {
  const executionName = job.external?.executionName;
  if (isTerminal(job.status) || !executionName) return;
  if (job.cancelRequested) {
    try {
      await cancelExecution(executionName);
    } catch (e) {
      logger.warn('render cancel failed', { jobId: job.id, error: String(e) });
    }
  }
  let exec: Execution;
  try {
    exec = await runApi<Execution>(`${RUN_API}/${executionName}`, 'GET');
  } catch (e) {
    logger.warn('execution lookup failed', { jobId: job.id, error: String(e) });
    await enqueueJob(job.id, 'poll', { delaySec: 90, seq: seq + 1 });
    return;
  }
  const done = Boolean(exec.completionTime);
  if (!done) {
    await enqueueJob(job.id, 'poll', { delaySec: 60, seq: seq + 1 });
    return;
  }
  // The renderer normally finalises the job itself; give it a moment, then reconcile.
  const fresh = await getJob(job.id);
  if (!fresh || isTerminal(fresh.status)) return;
  if (seq < 1000 && (exec.succeededCount ?? 0) > 0) {
    await progress(job.id, 'Finalising render', undefined);
    await enqueueJob(job.id, 'poll', { delaySec: 30, seq: 1000 });
    return;
  }
  const renderId = job.external?.renderId;
  if ((exec.cancelledCount ?? 0) > 0 || fresh.cancelRequested) {
    await transition(job.id, 'cancelled', { stage: 'Render cancelled' });
    if (renderId) await col.renders().doc(renderId).set({ status: 'cancelled', stage: 'Render cancelled', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return;
  }
  const reason = exec.conditions?.find((c) => c.state === 'CONDITION_FAILED')?.message ?? 'The renderer stopped without reporting a result.';
  await failJob(job, { code: 'render_failed', message: `Render failed: ${reason.slice(0, 300)}`, retryable: false });
  if (renderId) await col.renders().doc(renderId).set({ status: 'failed', stage: 'Failed', error: { code: 'render_failed', message: reason.slice(0, 300), retryable: false }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}
