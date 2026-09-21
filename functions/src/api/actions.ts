import path from 'node:path';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  ACTIVE_STATUSES,
  DEFAULT_SETTINGS,
  dayKey,
  isTerminal,
  jobRequestSchema,
  monthKey,
  storagePaths,
  sumEstimates,
  validateDeclaredUpload,
  type ApiRequest,
  type AssetDoc,
  type JobDoc,
  type JobRequest,
  type StudioSettings,
} from '@az-studio/shared';
import { studioCapabilities } from '../config/models';
import { PRICING } from '../config/pricing';
import { createAsset, withTmpDir } from '../lib/assets';
import { activeSlots } from '../lib/concurrency';
import { bucket, col, db, FieldValue } from '../lib/firebase';
import { cancelJobDoc, enqueueJob, getJob, transition } from '../lib/jobs';
import { trimVideo, videoFrame } from '../lib/media';
import type { Owner } from '../lib/owner';
import { prepareJob, type PreparedJob } from '../lib/prepare';
import { deletePrefix, signedReadUrl } from '../lib/storage';
import { assertRateLimit, assertWithinLimits, getSettings, spendSnapshot } from '../lib/usage';
import { genai } from '../lib/vertex';
import { cancelExecution } from '../workers/render';

type Payload<A extends ApiRequest['action']> = Extract<ApiRequest, { action: A }>['payload'];

async function ownedAsset(uid: string, assetId: string): Promise<AssetDoc> {
  const snap = await col.assets().doc(assetId).get();
  if (!snap.exists || snap.get('ownerUid') !== uid) throw new HttpsError('not-found', 'Media not found.');
  return { id: snap.id, ...snap.data() } as AssetDoc;
}

async function ownedJob(uid: string, jobId: string): Promise<JobDoc> {
  const job = await getJob(jobId);
  if (!job || job.ownerUid !== uid) throw new HttpsError('not-found', 'Job not found.');
  return job;
}

// ---------------------------------------------------------------------------

export async function bootstrap(owner: Owner) {
  const userRef = col.users().doc(owner.uid);
  const [user, settings, spend, slots] = await Promise.all([userRef.get(), getSettings(owner.uid), spendSnapshot(owner.uid), activeSlots(owner.uid)]);
  if (!user.exists) await userRef.set({ email: owner.email, settings: DEFAULT_SETTINGS, createdAt: FieldValue.serverTimestamp() }, { merge: true });
  return {
    owner,
    capabilities: studioCapabilities(),
    pricing: PRICING,
    settings,
    spend,
    stats: (user.get('stats') as { storageBytes?: number; assetCount?: number } | undefined) ?? { storageBytes: 0, assetCount: 0 },
    activeSlots: slots.length,
    serverTime: Date.now(),
  };
}

export async function createUpload(owner: Owner, p: Payload<'createUpload'>) {
  const problem = validateDeclaredUpload({ fileName: p.fileName, mimeType: p.mimeType, sizeBytes: p.sizeBytes, kind: p.kind });
  if (problem) throw new HttpsError('invalid-argument', problem);
  if (p.projectId) {
    const proj = await col.projects().doc(p.projectId).get();
    if (!proj.exists || proj.get('ownerUid') !== owner.uid) throw new HttpsError('not-found', 'Project not found.');
  }
  await assertRateLimit(owner.uid, 1, 120);
  const ref = col.assets().doc();
  const storagePath = storagePaths.upload(owner.uid, ref.id, p.fileName);
  const doc: Omit<AssetDoc, 'id'> = {
    ownerUid: owner.uid,
    projectId: p.projectId ?? null,
    kind: p.kind,
    source: 'upload',
    status: 'uploading',
    title: (p.title ?? p.fileName).slice(0, 160),
    fileName: p.fileName.slice(0, 255),
    mimeType: p.mimeType,
    sizeBytes: p.sizeBytes,
    storagePath,
    favorite: false,
    tags: [],
    collections: p.collections,
    generation: null,
    rejection: null,
  };
  await ref.set({ ...doc, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return { assetId: ref.id, storagePath };
}

export async function mediaUrls(owner: Owner, p: Payload<'mediaUrls'>) {
  const snaps = await db.getAll(...[...new Set(p.assetIds)].map((id) => col.assets().doc(id)));
  const urls: Record<string, { file?: string; thumb?: string; poster?: string; waveform?: string; expiresAt: number }> = {};
  await Promise.all(
    snaps.map(async (s) => {
      if (!s.exists || s.get('ownerUid') !== owner.uid) return;
      const a = s.data() as AssetDoc;
      const entry: (typeof urls)[string] = { expiresAt: 0 };
      const want = new Set(p.variants);
      const sign = async (key: 'file' | 'thumb' | 'poster' | 'waveform', objectPath: string | null | undefined, downloadName?: string) => {
        if (!want.has(key) || !objectPath) return;
        const r = await signedReadUrl(objectPath, downloadName ? { downloadName } : {});
        entry[key] = r.url;
        entry.expiresAt = entry.expiresAt ? Math.min(entry.expiresAt, r.expiresAt) : r.expiresAt;
      };
      if (a.status === 'ready') await sign('file', a.storagePath, p.download ? a.fileName : undefined);
      await Promise.all([sign('thumb', a.thumbPath), sign('poster', a.posterPath), sign('waveform', a.waveformPath)]);
      urls[s.id] = entry;
    }),
  );
  return { urls };
}

async function prepareAll(uid: string, jobs: JobRequest[]): Promise<PreparedJob[]> {
  const out: PreparedJob[] = [];
  for (const j of jobs) out.push(await prepareJob(uid, j));
  return out;
}

function confirmationPolicy(settings: StudioSettings, prepared: PreparedJob[], totalUsd: number) {
  const videos = prepared.filter((p) => p.type === 'video.generate').length;
  const reasons: string[] = [];
  if (totalUsd >= settings.confirmAboveUsd) reasons.push(`Estimated cost ≥ $${settings.confirmAboveUsd.toFixed(2)} confirmation threshold`);
  if (videos >= 2) reasons.push(`${videos} video generations in one batch`);
  return { required: reasons.length > 0, reasons };
}

export async function estimate(owner: Owner, p: Payload<'estimate'>) {
  const settings = await getSettings(owner.uid);
  const prepared = await prepareAll(owner.uid, p.jobs);
  const total = sumEstimates(prepared.map((x) => x.estimate), PRICING);
  const spend = await spendSnapshot(owner.uid);
  const confirm = confirmationPolicy(settings, prepared, total.usd);
  let limitProblem: string | null = null;
  try {
    assertWithinLimits(settings, spend, total.usd);
  } catch (e) {
    limitProblem = (e as Error).message;
  }
  return {
    estimate: total,
    perJob: prepared.map((x) => ({ type: x.type, label: x.label, modelId: x.modelId, estimate: x.estimate })),
    confirmation: confirm,
    limitProblem,
    spend,
    settings,
    batchTooLarge: p.jobs.length > settings.maxBatchSize,
  };
}

export async function submitJobs(owner: Owner, p: Payload<'submitJobs'>) {
  const uid = owner.uid;
  const settings = await getSettings(uid);
  if (p.jobs.length > settings.maxBatchSize) throw new HttpsError('invalid-argument', `Batches are limited to ${settings.maxBatchSize} jobs (see Settings).`);
  await assertRateLimit(uid, p.jobs.length);
  const prepared = await prepareAll(uid, p.jobs);
  const total = sumEstimates(prepared.map((x) => x.estimate), PRICING);
  const confirm = confirmationPolicy(settings, prepared, total.usd);
  if (confirm.required && (p.confirmedUsd === null || p.confirmedUsd === undefined || p.confirmedUsd + 0.005 < total.usd)) {
    throw new HttpsError('failed-precondition', 'Confirm the estimated cost before submitting this batch.', { reason: 'confirmation_required', estimate: total, reasons: confirm.reasons });
  }
  assertWithinLimits(settings, await spendSnapshot(uid), total.usd);

  const now = FieldValue.serverTimestamp();
  const batchId = prepared.length > 1 ? col.batches().doc().id : null;
  const writes = db.batch();
  const jobIds: string[] = [];
  // Sequential take / turn numbering per shot and chain.
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
      request: p.jobs[i]!,
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
        label: `Take ${index}`,
        rating: 0,
        notes: '',
        approved: false,
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
  if (batchId) writes.set(col.batches().doc(batchId), { ownerUid: uid, label: p.batchLabel ?? `${prepared.length} jobs`, jobIds, estimate: total, confirmedUsd: p.confirmedUsd ?? null, createdAt: now });
  await writes.commit();
  await Promise.all(jobIds.map((id) => enqueueJob(id, 'start')));
  return { jobIds, batchId, estimate: total };
}

export async function cancelJob(owner: Owner, p: Payload<'cancelJob'>) {
  const job = await ownedJob(owner.uid, p.jobId);
  if (isTerminal(job.status)) return { status: job.status, message: 'The job has already finished.' };
  await col.jobs().doc(job.id).update({ cancelRequested: true, updatedAt: FieldValue.serverTimestamp() });
  if (job.status === 'queued') {
    await cancelJobDoc(job);
    return { status: 'cancelled', message: 'Cancelled before generation started — no charge.' };
  }
  if (job.type === 'video.generate' && job.external?.interactionId) {
    try {
      await genai().interactions.cancel(job.external.interactionId);
    } catch {
      // The poller retries the cancellation.
    }
    await cancelJobDoc(job, 'Cancelled — Omni may still bill for work already done');
    return { status: 'cancelled', message: 'Cancellation sent to Gemini Omni. Work already done may still be billed.' };
  }
  if (job.type === 'render.timeline' && job.external?.executionName) {
    try {
      await cancelExecution(job.external.executionName);
    } catch {
      // Watchdog retries.
    }
    await transition(job.id, 'cancelled', { stage: 'Render cancelled' });
    if (job.external.renderId) await col.renders().doc(job.external.renderId).set({ status: 'cancelled', stage: 'Render cancelled', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { status: 'cancelled', message: 'Render cancelled.' };
  }
  if (job.status === 'validating') return { status: job.status, message: 'Cancelling — the job will stop before any paid request is sent.' };
  return { status: job.status, message: 'This generation is already running and finishes within seconds; it cannot be stopped mid-request.' };
}

export async function retryJob(owner: Owner, p: Payload<'retryJob'>) {
  const job = (await ownedJob(owner.uid, p.jobId)) as JobDoc & { request?: JobRequest };
  if (job.status !== 'failed' && job.status !== 'cancelled') throw new HttpsError('failed-precondition', 'Only failed or cancelled jobs can be retried.');
  if (!job.request) throw new HttpsError('failed-precondition', 'This job cannot be retried automatically.');
  const request = jobRequestSchema.parse(job.request);
  // The owner acknowledged the possible charge; that acknowledgement counts as confirmation.
  const res = await submitJobs(owner, { jobs: [request], confirmedUsd: Number.MAX_SAFE_INTEGER, batchLabel: `Retry of ${job.label}` });
  await col.jobs().doc(res.jobIds[0]!).update({ retryOf: job.id, attempt: 0 });
  return res;
}

export async function updateSettings(owner: Owner, p: Payload<'updateSettings'>) {
  const current = await getSettings(owner.uid);
  const next = { ...current, ...p };
  if (next.monthlyLimitUsd < next.dailyLimitUsd) throw new HttpsError('invalid-argument', 'The monthly limit must be at least the daily limit.');
  await col.users().doc(owner.uid).set({ settings: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { settings: next };
}

export async function deleteAsset(owner: Owner, p: Payload<'deleteAsset'>) {
  const a = await ownedAsset(owner.uid, p.assetId);
  const active = await col.jobs().where('ownerUid', '==', owner.uid).where('status', 'in', [...ACTIVE_STATUSES]).get();
  if (active.docs.some((d) => JSON.stringify(d.get('params') ?? {}).includes(a.id))) throw new HttpsError('failed-precondition', 'This media is being used by a running job.');
  await bucket.file(a.storagePath).delete({ ignoreNotFound: true });
  await deletePrefix(`users/${owner.uid}/derived/${a.id}/`);
  const batch = db.batch();
  batch.delete(col.assets().doc(a.id));
  if (a.status === 'ready') batch.set(col.users().doc(owner.uid), { stats: { storageBytes: FieldValue.increment(-a.sizeBytes), assetCount: FieldValue.increment(-1) } }, { merge: true });
  await batch.commit();
  return { deleted: true };
}

export async function deleteProject(owner: Owner, p: Payload<'deleteProject'>) {
  const ref = col.projects().doc(p.projectId);
  const snap = await ref.get();
  if (!snap.exists || snap.get('ownerUid') !== owner.uid) throw new HttpsError('not-found', 'Project not found.');
  if (String(snap.get('title')).trim() !== p.confirmTitle.trim()) throw new HttpsError('invalid-argument', 'Type the project title exactly to confirm.');
  const active = await col.jobs().where('ownerUid', '==', owner.uid).where('projectId', '==', p.projectId).where('status', 'in', [...ACTIVE_STATUSES]).get();
  if (!active.empty) throw new HttpsError('failed-precondition', 'Cancel or wait for this project’s running jobs first.');
  // Media is kept in the library (detached from the project); creative documents are removed.
  const assets = await col.assets().where('ownerUid', '==', owner.uid).where('projectId', '==', p.projectId).get();
  for (let i = 0; i < assets.docs.length; i += 400) {
    const b = db.batch();
    for (const d of assets.docs.slice(i, i + 400)) b.update(d.ref, { projectId: null, updatedAt: FieldValue.serverTimestamp() });
    await b.commit();
  }
  await db.recursiveDelete(ref);
  return { deleted: true, detachedAssets: assets.size };
}

export async function usageSummary(owner: Owner, p: Payload<'usageSummary'>) {
  const days: string[] = [];
  for (let i = p.days - 1; i >= 0; i--) days.push(dayKey(new Date(Date.now() - i * 86_400_000)));
  const dailySnaps = await db.getAll(...days.map((d) => col.usageDaily().doc(`${owner.uid}_${d}`)));
  const month = await col.usageMonthly().doc(`${owner.uid}_${monthKey()}`).get();
  const projects = await col.projects().where('ownerUid', '==', owner.uid).get();
  const recent = await col.usage().where('ownerUid', '==', owner.uid).orderBy('createdAt', 'desc').limit(50).get();
  return {
    daily: dailySnaps.map((s, i) => ({ day: days[i]!, costUsd: Number(s.get('costUsd') ?? 0), jobs: Number(s.get('jobs') ?? 0), byModel: (s.get('byModel') as Record<string, number>) ?? {} })),
    month: { month: monthKey(), costUsd: Number(month.get('costUsd') ?? 0), jobs: Number(month.get('jobs') ?? 0), byModel: (month.get('byModel') as Record<string, number>) ?? {} },
    byProject: projects.docs
      .map((d) => ({ projectId: d.id, title: String(d.get('title') ?? ''), costUsd: Number(d.get('usage.costUsd') ?? 0), jobs: Number(d.get('usage.jobs') ?? 0) }))
      .filter((x) => x.jobs > 0)
      .sort((a, b) => b.costUsd - a.costUsd),
    recent: recent.docs.map((d) => ({ id: d.id, jobId: d.get('jobId'), projectId: d.get('projectId'), modelId: d.get('modelId'), kind: d.get('kind'), costUsd: d.get('costUsd'), tokens: d.get('tokens'), createdAt: d.get('createdAt')?.toMillis?.() ?? null })),
    pricing: { version: PRICING.version, source: PRICING.source, retrievedAt: PRICING.retrievedAt },
  };
}

export async function deriveClip(owner: Owner, p: Payload<'deriveClip'>) {
  const a = await ownedAsset(owner.uid, p.assetId);
  if (a.kind !== 'video' || a.status !== 'ready') throw new HttpsError('invalid-argument', 'Choose a ready video to trim.');
  const dur = a.durationSec ?? 0;
  if (p.startSec + p.durationSec > dur + 0.05) throw new HttpsError('invalid-argument', 'The selected window runs past the end of the video.');
  const input = (await signedReadUrl(a.storagePath, { ttlSeconds: 1800 })).url;
  const newId = col.assets().doc().id;
  const storagePath = storagePaths.derived(owner.uid, newId, 'clip.mp4');
  await withTmpDir(async (dir) => {
    const local = path.join(dir, 'clip.mp4');
    await trimVideo(input, local, p.startSec, p.durationSec);
    await bucket.upload(local, { destination: storagePath, resumable: false, metadata: { contentType: 'video/mp4' } });
    await createAsset({
      uid: owner.uid,
      assetId: newId,
      projectId: a.projectId,
      kind: 'video',
      source: 'derived',
      title: p.title ?? `${a.title} (${p.startSec.toFixed(1)}s–${(p.startSec + p.durationSec).toFixed(1)}s)`,
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      storagePath,
      localFile: local,
      dir,
      collections: a.collections,
      derivedFrom: { assetId: a.id, startSec: p.startSec, durationSec: p.durationSec },
      ...(a.generation ? { generation: { ...a.generation, provenance: { ...a.generation.provenance, c2pa: 'absent' } } } : {}),
    });
  });
  return { assetId: newId };
}

export async function extractFrame(owner: Owner, p: Payload<'extractFrame'>) {
  const a = await ownedAsset(owner.uid, p.assetId);
  if (a.kind !== 'video' || a.status !== 'ready') throw new HttpsError('invalid-argument', 'Choose a ready video.');
  const at = Math.min(Math.max(0, p.atSec), Math.max(0, (a.durationSec ?? 0) - 0.05));
  const input = (await signedReadUrl(a.storagePath, { ttlSeconds: 1800 })).url;
  const newId = col.assets().doc().id;
  const storagePath = storagePaths.derived(owner.uid, newId, 'frame.png');
  await withTmpDir(async (dir) => {
    const local = path.join(dir, 'frame.png');
    await videoFrame(input, local, at, a.width ?? 1920);
    await bucket.upload(local, { destination: storagePath, resumable: false, metadata: { contentType: 'image/png' } });
    await createAsset({
      uid: owner.uid,
      assetId: newId,
      projectId: a.projectId,
      kind: 'image',
      source: 'derived',
      title: p.title ?? `${a.title} — frame at ${at.toFixed(2)}s`,
      fileName: 'frame.png',
      mimeType: 'image/png',
      storagePath,
      localFile: local,
      dir,
      collections: p.collections,
      derivedFrom: { assetId: a.id, atSec: at },
      ...(a.generation ? { generation: { ...a.generation, provenance: { ...a.generation.provenance, c2pa: 'absent' } } } : {}),
    });
  });
  return { assetId: newId };
}
