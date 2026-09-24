/**
 * AZ Studio Cloud Functions (codebase `az-studio`, region us-central1).
 *
 *  azsApi         — owner-only callable API (Auth + App Check enforced)
 *  azsJobWorker   — Cloud Tasks queue that runs durable generation / render jobs
 *  azsOnUpload    — validates uploads in the private media bucket
 *  azsMaintenance — reconciles jobs every 10 minutes
 */
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { ZodError } from 'zod';
import { apiRequestSchema, type ApiRequest } from '@az-studio/shared';
import { ALLOWED_ORIGINS, IS_EMULATOR, MEDIA_BUCKET, OWNER_EMAIL, OWNER_UID, REGION, RUNTIME_SERVICE_ACCOUNT, RUNTIME_SERVICE_ACCOUNT_EMAIL } from './config/runtime';
import { assertOwner } from './lib/owner';
import * as actions from './api/actions';
import * as production from './api/production';
import { handleTask } from './workers/worker';
import type { WorkerPayload } from './lib/jobs';
import { handleUpload } from './triggers/upload';
import { runMaintenance } from './scheduled/maintenance';

setGlobalOptions({ region: REGION, serviceAccount: RUNTIME_SERVICE_ACCOUNT, maxInstances: 10 });

async function dispatch(req: ApiRequest, owner: ReturnType<typeof assertOwner>): Promise<unknown> {
  switch (req.action) {
    case 'bootstrap':
      return actions.bootstrap(owner);
    case 'createUpload':
      return actions.createUpload(owner, req.payload);
    case 'mediaUrls':
      return actions.mediaUrls(owner, req.payload);
    case 'estimate':
      return actions.estimate(owner, req.payload);
    case 'submitJobs':
      return actions.submitJobs(owner, req.payload);
    case 'cancelJob':
      return actions.cancelJob(owner, req.payload);
    case 'retryJob':
      return actions.retryJob(owner, req.payload);
    case 'updateSettings':
      return actions.updateSettings(owner, req.payload);
    case 'deleteAsset':
      return actions.deleteAsset(owner, req.payload);
    case 'deleteProject':
      return actions.deleteProject(owner, req.payload);
    case 'usageSummary':
      return actions.usageSummary(owner, req.payload);
    case 'deriveClip':
      return actions.deriveClip(owner, req.payload);
    case 'extractFrame':
      return actions.extractFrame(owner, req.payload);
    case 'estimateProduction':
      return production.estimateProduction(owner, req.payload);
    case 'startProduction':
      return production.startProduction(owner, req.payload);
    case 'productionAction':
      return production.productionAction(owner, req.payload);
    case 'modelStatus':
      return production.modelStatus(owner, req.payload);
  }
}

export const azsApi = onCall(
  {
    secrets: [OWNER_UID, OWNER_EMAIL],
    enforceAppCheck: !IS_EMULATOR,
    cors: ALLOWED_ORIGINS,
    memory: '1GiB',
    timeoutSeconds: 300,
    concurrency: 40,
  },
  async (request: CallableRequest<unknown>) => {
    const owner = assertOwner(request.auth);
    let parsed: ApiRequest;
    try {
      parsed = apiRequestSchema.parse(request.data);
    } catch (e) {
      const msg = e instanceof ZodError ? e.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ') : 'Invalid request.';
      throw new HttpsError('invalid-argument', msg);
    }
    try {
      return await dispatch(parsed, owner);
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error('azsApi failure', { action: parsed.action, error: String((e as Error)?.stack ?? e) });
      throw new HttpsError('internal', 'AZ Studio hit an unexpected error. It has been logged.');
    }
  },
);

export const azsJobWorker = onTaskDispatched<WorkerPayload>(
  {
    // Tasks are enqueued by the API with an OIDC token for the runtime service account, so that
    // account (only) may invoke the worker and enqueue to its queue.
    invoker: RUNTIME_SERVICE_ACCOUNT_EMAIL,
    secrets: [OWNER_UID, OWNER_EMAIL],
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 20, maxBackoffSeconds: 600 },
    rateLimits: { maxConcurrentDispatches: 20, maxDispatchesPerSecond: 10 },
    memory: '2GiB',
    cpu: 2,
    timeoutSeconds: 1800,
    concurrency: 8,
  },
  async (req) => {
    await handleTask(req.data);
  },
);

export const azsOnUpload = onObjectFinalized(
  { bucket: MEDIA_BUCKET, memory: '2GiB', cpu: 2, timeoutSeconds: 540, concurrency: 4 },
  async (event) => {
    await handleUpload({ name: event.data.name, size: Number(event.data.size ?? 0) });
  },
);

export const azsMaintenance = onSchedule({ schedule: 'every 10 minutes', timeoutSeconds: 300, memory: '512MiB' }, async () => {
  await runMaintenance();
});
