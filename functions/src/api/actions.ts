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
} from '@az-studio/shared';
import { studioCapabilities } from '../config/models';
import { PRICING } from '../config/pricing';
import { createAsset, withTmpDir } from '../lib/assets';
import { activeSlots } from '../lib/concurrency';
import { bucket, col, db, FieldValue } from '../lib/firebase';
import { cancelJobDoc, getJob, transition } from '../lib/jobs';
import { confirmationPolicy, createJobs, prepareAll } from '../lib/submit';
import { trimVideo, videoFrame } from '../lib/media';
import type { Owner } from '../lib/owner';
import { deletePrefix, signedReadUrl } from '../lib/storage';
import { mediaInputUrl } from '../lib/media-proxy';
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

/** Why a rendered film may not be exported yet (null when it may). */
export async function exportBlock(storagePath: string): Promise<string | null> {
  const renderId = /\/renders\/([^/]+)\//.exec(storagePath)?.[1];
  if (!renderId) return null;
  const r = await col.renders().doc(renderId).get();
  if (!r.exists) return null;
  const inspected = r.get('inspect') === true || r.get('quality') === 'final';
  if (!inspected) return null;
  const fi = r.get('finalInspection') as { status?: string; readiness?: string | null; errors?: number } | null | undefined;
  if (fi?.status === 'completed' && (fi.readiness === 'ready' || fi.readiness === 'overridden')) return null;
  if (fi?.status === 'failed') return 'The final inspection of this render failed. Run it again (Final inspection) before exporting.';
  if (fi?.status === 'completed') return `Export is blocked: the final inspection found ${fi.errors ?? 0} critical problem${fi.errors === 1 ? '' : 's'}. Fix and re-render, resolve them, or override with a note in Final inspection.`;
  return 'Export waits for the final inspection of this render to finish.';
}

export async function mediaUrls(owner: Owner, p: Payload<'mediaUrls'>) {
  const snaps = await db.getAll(...[...new Set(p.assetIds)].map((id) => col.assets().doc(id)));
  const urls: Record<string, { file?: string; thumb?: string; poster?: string; waveform?: string; expiresAt: number; blocked?: string }> = {};
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
      // Export gate: an inspected render downloads only once its final inspection is ready or overridden.
      if (p.download && a.source === 'render') {
        const blocked = await exportBlock(a.storagePath);
        if (blocked) {
          urls[s.id] = { ...entry, blocked };
          return;
        }
      }
      if (a.status === 'ready') await sign('file', a.storagePath, p.download ? a.fileName : undefined);
      await Promise.all([sign('thumb', a.thumbPath), sign('poster', a.posterPath), sign('waveform', a.waveformPath)]);
      urls[s.id] = entry;
    }),
  );
  return { urls };
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
  const settings = await getSettings(owner.uid);
  if (p.jobs.length > settings.maxBatchSize) throw new HttpsError('invalid-argument', `Batches are limited to ${settings.maxBatchSize} jobs (see Settings).`);
  await assertRateLimit(owner.uid, p.jobs.length);
  const res = await createJobs(owner.uid, p.jobs, { confirmedUsd: p.confirmedUsd ?? null, ...(p.batchLabel ? { batchLabel: p.batchLabel } : {}) });
  return { jobIds: res.jobIds, batchId: res.batchId, estimate: res.estimate };
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
  const input = await mediaInputUrl(a.storagePath);
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
  const input = await mediaInputUrl(a.storagePath);
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
