import { logger } from 'firebase-functions';
import { toMillis, type JobDoc } from '@az-studio/shared';
import { col } from '../lib/firebase';
import { enqueueJob, failJob } from '../lib/jobs';
import { ensurePolling } from '../workers/video';

const MINUTE = 60_000;

/**
 * Reconciles jobs that lost their worker chain (crash, deploy mid-flight):
 *  - generating Omni jobs whose poll task was lost are re-polled;
 *  - generating jobs with an expired lease and no external operation are failed (never re-sent,
 *    to avoid a second charge);
 *  - queued jobs untouched for 15 minutes are re-enqueued.
 */
export async function runMaintenance(): Promise<{ repolled: number; failed: number; requeued: number }> {
  const now = Date.now();
  let repolled = 0;
  let failed = 0;
  let requeued = 0;
  const generating = await col.jobs().where('status', '==', 'generating').limit(200).get();
  for (const d of generating.docs) {
    const job = { id: d.id, ...d.data() } as JobDoc & { lease?: { until?: number } };
    const updated = toMillis(job.updatedAt as never) ?? now;
    if (job.type === 'video.generate' && job.external?.interactionId) {
      if (now - updated > 5 * MINUTE) {
        await ensurePolling(job.id);
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
  const rendering = await col.jobs().where('status', 'in', ['rendering', 'downloading']).where('type', '==', 'render.timeline').limit(100).get();
  for (const d of rendering.docs) {
    const updated = toMillis(d.get('updatedAt')) ?? now;
    if (now - updated > 10 * MINUTE) {
      await enqueueJob(d.id, 'poll', { seq: 9000 + Math.floor(now / MINUTE) % 1000 });
      repolled++;
    }
  }
  if (repolled || failed || requeued) logger.info('maintenance', { repolled, failed, requeued });
  return { repolled, failed, requeued };
}
