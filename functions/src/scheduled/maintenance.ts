import { logger } from 'firebase-functions';
import { ACTIVE_PRODUCTION_STATUSES, isTerminal, toMillis, type JobDoc } from '@az-studio/shared';
import { col } from '../lib/firebase';
import { enqueueJob, enqueueProduction, failJob } from '../lib/jobs';
import { startFinalInspection } from '../workers/after-render';
import { ensurePolling } from '../workers/video';

const MINUTE = 60_000;

/**
 * Reconciles jobs that lost their worker chain (crash, deploy mid-flight):
 *  - generating Omni jobs whose poll task was lost are re-polled;
 *  - generating jobs with an expired lease and no external operation are failed (never re-sent,
 *    to avoid a second charge);
 *  - queued jobs untouched for 15 minutes are re-enqueued;
 *  - stem separations whose poll was lost are re-polled; FFmpeg jobs whose worker died are failed;
 *  - finished final renders whose inspection never started get it started (export stays blocked until then).
 */
export async function runMaintenance(): Promise<{ repolled: number; failed: number; requeued: number; resumed: number }> {
  const now = Date.now();
  let repolled = 0;
  let failed = 0;
  let requeued = 0;
  let resumed = 0;
  const generating = await col.jobs().where('status', '==', 'generating').limit(200).get();
  for (const d of generating.docs) {
    const job = { id: d.id, ...d.data() } as JobDoc & { lease?: { until?: number } };
    const updated = toMillis(job.updatedAt as never) ?? now;
    if (job.type === 'video.generate' && job.external?.interactionId) {
      if (now - updated > 5 * MINUTE) {
        await ensurePolling(job.id);
        repolled++;
      }
    } else if (job.type === 'audio.stems' && job.external?.executionName) {
      // Demucs runs on Cloud Run: the execution keeps going, only the watcher needs to resume.
      if (now - updated > 5 * MINUTE) {
        await enqueueJob(job.id, 'poll', { seq: 8000 + (Math.floor(now / MINUTE) % 1000) });
        repolled++;
      }
    } else if ((job.lease?.until ?? 0) < now && now - updated > 12 * MINUTE) {
      await failJob(job, { code: 'interrupted', message: 'The worker stopped unexpectedly. Retry to run it again — this may incur a new charge.', retryable: false });
      failed++;
    }
  }
  const stale = await col.jobs().where('status', '==', 'queued').limit(200).get();
  for (const d of stale.docs) {
    const updated = toMillis(d.get('updatedAt')) ?? now;
    if (now - updated > 15 * MINUTE) {
      await enqueueJob(d.id, 'start', { seq: 5000 + Math.floor(now / MINUTE) % 1000 });
      requeued++;
    }
  }
  // FFmpeg work inside the worker (repair edits, colour match, arrangements, mixdowns) whose worker died.
  const inWorker = await col.jobs().where('status', '==', 'rendering').limit(100).get();
  for (const d of inWorker.docs) {
    const job = { id: d.id, ...d.data() } as JobDoc & { lease?: { until?: number } };
    if (job.type === 'render.timeline') continue;
    if ((job.lease?.until ?? 0) < now && now - (toMillis(job.updatedAt as never) ?? now) > 12 * MINUTE) {
      await failJob(job, { code: 'interrupted', message: 'The edit stopped unexpectedly. Retry to run it again.', retryable: false });
      failed++;
    }
  }
  // Final renders whose inspection never started (its trigger was lost).
  const uninspected = await col.renders().where('inspect', '==', true).where('finalInspection', '==', null).where('status', '==', 'completed').limit(20).get();
  for (const d of uninspected.docs) {
    const done = toMillis(d.get('completedAt')) ?? now;
    if (now - done > 3 * MINUTE && (await startFinalInspection(d.id, String(d.get('ownerUid')), String(d.get('projectId'))))) resumed++;
  }
  // Production runs whose next step was lost (deploy, crash): resume once their jobs are finished.
  const productions = await col.productions().where('status', 'in', [...ACTIVE_PRODUCTION_STATUSES]).limit(100).get();
  for (const d of productions.docs) {
    const updated = toMillis(d.get('updatedAt')) ?? now;
    const lock = Number(d.get('lock.until') ?? 0);
    if (now - updated < 10 * MINUTE || lock > now) continue;
    const waiting = (d.get('waitingOn') as string[] | undefined) ?? [];
    const jobs = waiting.length ? await Promise.all(waiting.map((id) => col.jobs().doc(id).get())) : [];
    if (jobs.every((j) => !j.exists || isTerminal(j.get('status')))) {
      await enqueueProduction(d.id, { seq: 7000 + (Math.floor(now / MINUTE) % 1000) });
      resumed++;
    }
  }
  const rendering = await col.jobs().where('status', 'in', ['rendering', 'downloading']).where('type', '==', 'render.timeline').limit(100).get();
  for (const d of rendering.docs) {
    const updated = toMillis(d.get('updatedAt')) ?? now;
    if (now - updated > 10 * MINUTE) {
      await enqueueJob(d.id, 'poll', { seq: 9000 + Math.floor(now / MINUTE) % 1000 });
      repolled++;
    }
  }
  if (repolled || failed || requeued || resumed) logger.info('maintenance', { repolled, failed, requeued, resumed });
  return { repolled, failed, requeued, resumed };
}
