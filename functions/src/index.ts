/**
 * AZ Studio Cloud Functions (codebase `az-studio`, region us-central1).
 *
 *  azsApi         — owner-only callable API (Auth + App Check enforced)
 *  azsJobWorker   — Cloud Tasks queue that runs durable generation / render jobs
 *  azsOnUpload    — validates uploads in the private media bucket
 *  azsMaintenance — reconciles jobs every 10 minutes
 *  azsCanary      — probes every model role once a day and records what changed
 *  azsMember      — the public beta's member callable (off unless runtime/features.beta.enabled; never the owner API)
 *  azsMemberWorker — Cloud Tasks queue that voices members' audio editions (prebuilt voices only)
 *  azsPublic      — unauthenticated: published audio editions, client review links and the website's early-access form
 */
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall, onRequest, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';
import { ZodError } from 'zod';
import { apiRequestSchema, type ApiRequest } from '@az-studio/shared';
import { ALLOWED_ORIGINS, FIRESTORE_DATABASE, IS_EMULATOR, MEDIA_BUCKET, OWNER_EMAIL, OWNER_UID, REGION, RUNTIME_SERVICE_ACCOUNT, RUNTIME_SERVICE_ACCOUNT_EMAIL } from './config/runtime';
import type { CharacterDoc } from '@az-studio/shared';
import { handleBibleCoverChange } from './triggers/bible-cover';
import { assertOwner } from './lib/owner';
import * as actions from './api/actions';
import * as ops from './api/ops';
import { reviewLinks } from './api/review-links';
import { advanceOpenPacks, deliverables } from './api/deliverables';
import { handlePublicReview } from './public/review';
import * as continuity from './api/continuity';
import * as production from './api/production';
import * as studio from './api/studio';
import * as takes from './api/takes';
import * as ads from './api/ads';
import * as lite from './api/lite';
import * as mvlite from './api/mvlite';
import { linkAd } from './api/linkad';
import { brandKits } from './api/brand-kits';
import { liteBooth } from './api/lite-booth';
import { beta } from './api/beta';
import { member } from './api/member';
import { runMemberSpeak, type MemberTask } from './workers/member-speak';
import { isOwner } from './lib/owner';
import { memberRequestSchema } from '@az-studio/shared';
import { narrator } from './api/narrator';
import { handleTask } from './workers/worker';
import type { WorkerPayload } from './lib/jobs';
import { handleUpload } from './triggers/upload';
import { runMaintenance } from './scheduled/maintenance';
import { runCanary } from './scheduled/canary';
import { ownerConfig } from './lib/owner';
import { handlePublicAudio } from './public/audio';
import { handleEarlyAccess } from './public/early-access';
import { earlyAccess } from './api/early-access';
import { pruneEarlyAccessRate } from './lib/early-access';

setGlobalOptions({ region: REGION, serviceAccount: RUNTIME_SERVICE_ACCOUNT, maxInstances: 10 });

export const azsOnBibleCharacter = onDocumentWritten({document: 'projects/{projectId}/characters/{characterId}', database: FIRESTORE_DATABASE, retry: true}, async event => {
  await handleBibleCoverChange(event.params.projectId, event.data?.before.data() as CharacterDoc | undefined, event.data?.after.data() as CharacterDoc | undefined);
});

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
    case 'canary':
      return ops.canary(owner, req.payload);
    case 'spendByTask':
      return ops.spendByTask(owner, req.payload);
    case 'providerLedger':
      return ops.providerLedger(owner, req.payload);
    case 'reviewLinks':
      return reviewLinks(owner, req.payload);
    case 'deliverables':
      return deliverables(owner, req.payload);
    case 'continuitySave':
      return continuity.continuitySave(owner, req.payload);
    case 'continuityDelete':
      return continuity.continuityDelete(owner, req.payload);
    case 'characterBibleSave':
      return continuity.characterBibleSave(owner, req.payload);
    case 'bibleApprove':
      return continuity.bibleApprove(owner, req.payload);
    case 'continuityCheck':
      return continuity.continuityCheck(owner, req.payload);
    case 'continuityWarning':
      return continuity.continuityWarning(owner, req.payload);
    case 'insertNeutralShot':
      return continuity.insertNeutralShot(owner, req.payload);
    case 'coverageApply':
      return continuity.coverageApply(owner, req.payload);
    case 'continuityOverview':
      return continuity.continuityOverview(owner, req.payload);
    case 'creditsMetadata':
      return continuity.creditsMetadata(owner, req.payload);
    case 'cancelQueued':
      return continuity.cancelQueued(owner, req.payload);
    case 'finalInspectionAction':
      return studio.finalInspectionAction(owner, req.payload);
    case 'musicSetMaster':
      return studio.musicSetMaster(owner, req.payload);
    case 'musicToVideo':
      return studio.musicToVideo(owner, req.payload);
    case 'musicAddVersion':
      return studio.musicAddVersion(owner, req.payload);
    case 'musicCorrectAnalysis':
      return studio.musicCorrectAnalysis(owner, req.payload);
    case 'takeAction':
      return takes.takeAction(owner, req.payload);
    case 'proposePromptFix':
      return actions.proposePromptFix(owner, req.payload);
    case 'providerHealth':
      return actions.providerHealth(owner, req.payload);
    case 'adGenerate':
      return ads.adGenerate(owner, req.payload);
    case 'adValidateScene':
      return ads.adValidateScene(owner, req.payload);
    case 'adCancel':
      return ads.adCancel(owner, req.payload);
    case 'liteGenerate':
      return lite.liteGenerate(owner, req.payload);
    case 'liteCancel':
      return lite.liteCancel(owner, req.payload);
    case 'mvliteGenerate':
      return mvlite.mvliteGenerate(owner, req.payload);
    case 'mvliteCancel':
      return mvlite.mvliteCancel(owner, req.payload);
    case 'narrator':
      return narrator(owner, req.payload);
    case 'earlyAccess':
      return earlyAccess(owner, req.payload);
    case 'liteBooth':
      return liteBooth(owner, req.payload);
    case 'beta':
      return beta(owner, req.payload);
    case 'linkAd':
      return linkAd(owner, req.payload);
    case 'brandKits':
      return brandKits(owner, req.payload);
    default: {
      // Every action in the request schema must be handled here (compile-time check).
      const unhandled: never = req;
      throw new HttpsError('invalid-argument', `Unknown action ${(unhandled as { action?: string }).action ?? ''}.`);
    }
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

/**
 * Public, unauthenticated endpoints reached through Hosting at /api/public/**: audio editions (published
 * revisions only) and the website's early-access form (stores an interest registration, nothing else).
 * No Auth, App Check, studio data or generation code is involved.
 */
export const azsPublic = onRequest({ invoker: 'public', memory: '512MiB', timeoutSeconds: 120, concurrency: 80, maxInstances: 10 }, async (req, res) => {
  try {
    if (req.path.startsWith('/api/public/review/')) {
      await handlePublicReview({ method: req.method, path: req.path, headers: req.headers, body: req.body }, res);
      return;
    }
    if (req.path === '/api/public/early-access') {
      await handleEarlyAccess({ method: req.method, headers: req.headers, body: req.body, rawBody: req.rawBody, ip: req.ip }, res);
      return;
    }
    await handlePublicAudio({ method: req.method, path: req.path, headers: req.headers }, Object.assign(res, { pipeFrom: (s: NodeJS.ReadableStream) => void s.pipe(res) }));
  } catch (e) {
    logger.error('azsPublic failure', { path: req.path, error: String((e as Error)?.message ?? e) });
    if (!res.headersSent) res.status(500).set('Cache-Control', 'no-store').json({ error: 'unavailable' });
  }
});

export const azsMaintenance = onSchedule({ schedule: 'every 10 minutes', timeoutSeconds: 300, memory: '512MiB' }, async () => {
  await runMaintenance();
  // Hashed visitor addresses kept for the early-access rate limits expire after 48 hours.
  await pruneEarlyAccessRate();
  // Deliverables packs waiting for their renders' export checks.
  await advanceOpenPacks();
});

/** Daily model canary (scheduled/canary.ts): changes show as a studio banner until acknowledged in Settings. */
export const azsCanary = onSchedule({ schedule: 'every day 06:30', timeZone: 'Africa/Accra', timeoutSeconds: 300, memory: '512MiB', secrets: [OWNER_UID, OWNER_EMAIL] }, async () => {
  const state = await runCanary(ownerConfig().uid);
  if (state.changes.some((c) => c.worse)) logger.warn('model canary changes', { changes: state.changes });
});

/**
 * The public beta's member API. A separate callable with its own gate (`assertMember`, lib/member.ts): it never runs
 * `assertOwner`'s code path and owner actions are not reachable from it. With `runtime/features.beta.enabled` unset (the
 * default) or `AZS_FEATURE_BETA=off`, every call is refused before anything is read.
 */
export const azsMember = onCall(
  { secrets: [OWNER_UID, OWNER_EMAIL], enforceAppCheck: !IS_EMULATOR, cors: ALLOWED_ORIGINS, memory: '512MiB', timeoutSeconds: 120, concurrency: 40, maxInstances: 5 },
  async (request: CallableRequest<unknown>) => {
    let parsed;
    try {
      parsed = memberRequestSchema.parse(request.data);
    } catch (e) {
      const msg = e instanceof ZodError ? e.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ') : 'Invalid request.';
      throw new HttpsError('invalid-argument', msg);
    }
    try {
      const owner = Boolean(request.auth && isOwner(request.auth, ownerConfig()));
      return await member(request.auth, parsed, owner);
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error('azsMember failure', { op: parsed.op, error: String((e as Error)?.stack ?? e) });
      throw new HttpsError('internal', 'Something went wrong. It has been logged.');
    }
  },
);

export const azsMemberWorker = onTaskDispatched<MemberTask>(
  {
    invoker: RUNTIME_SERVICE_ACCOUNT_EMAIL,
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 30, maxBackoffSeconds: 600 },
    rateLimits: { maxConcurrentDispatches: 4, maxDispatchesPerSecond: 2 },
    memory: '1GiB',
    timeoutSeconds: 1800,
    concurrency: 4,
  },
  async (req) => {
    await runMemberSpeak(req.data);
  },
);
