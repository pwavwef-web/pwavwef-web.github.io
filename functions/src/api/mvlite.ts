import { HttpsError } from 'firebase-functions/v2/https';
import {
  ACTIVE_STATUSES,
  compileMvImageRequest,
  computeMvTiming,
  mvShotsNeedingImages,
  normalizeMvLiteSpec,
  shotLyrics,
  sumEstimates,
  type ApiRequest,
  type JobDoc,
  type JobRequest,
  type MvLiteSpec,
  type MvSong,
  type SongDoc,
} from '@az-studio/shared';
import { PRICING } from '../config/pricing';
import { col } from '../lib/firebase';
import type { Owner } from '../lib/owner';
import { confirmationPolicy, createJobs, prepareAll } from '../lib/submit';
import { assertRateLimit, assertWithinLimits, getSettings, projectBudget, spendSnapshot } from '../lib/usage';
import { cancelJob } from './actions';
import { withLock } from './lite';

type Payload<A extends ApiRequest['action']> = Extract<ApiRequest, { action: A }>['payload'];
type Job = JobDoc & { id: string };

/** The song document as Music Video Lite reads it. */
export function mvSongOf(id: string, d: Partial<SongDoc> | undefined): MvSong | null {
  if (!d?.audioAssetId) return null;
  return { id, title: d.title ?? 'Song', audioAssetId: d.audioAssetId, durationSec: Number(d.durationSec ?? 0), analysis: d.analysis ?? null, sheet: d.lyricsSheet ?? null, instrumental: Boolean(d.instrumental) };
}

async function loadMv(uid: string, projectId: string): Promise<{ title: string; spec: MvLiteSpec; song: MvSong | null; jobs: Job[] }> {
  const snap = await col.projects().doc(projectId).get();
  if (!snap.exists || snap.get('ownerUid') !== uid) throw new HttpsError('not-found', 'Video not found.');
  if (snap.get('type') !== 'mv_lite') throw new HttpsError('failed-precondition', 'This is not a Music Video Lite project.');
  const spec = normalizeMvLiteSpec(snap.get('mvlite'));
  const song = spec.song.songId ? mvSongOf(spec.song.songId, (await col.songs(projectId).doc(spec.song.songId).get()).data() as SongDoc | undefined) : null;
  const jobsOf = async (pid: string) => (await col.jobs().where('ownerUid', '==', uid).where('projectId', '==', pid).get()).docs.map((d) => ({ ...(d.data() as JobDoc), id: d.id }));
  const jobs = await jobsOf(projectId);
  // A copy of another video reuses the original's images (nothing is generated twice).
  const source = spec.importedFrom?.projectId;
  if (source && source !== projectId) {
    const src = await col.projects().doc(source).get();
    if (src.exists && src.get('ownerUid') === uid && src.get('type') === 'mv_lite') jobs.push(...(await jobsOf(source)).filter((j) => j.type === 'image.generate'));
  }
  return { title: String(snap.get('title') ?? 'Music video'), spec, song, jobs };
}

const isActive = (j: Job) => (ACTIVE_STATUSES as readonly string[]).includes(j.status);
const targetOf = (j: Job) => `${j.target?.kind ?? ''}:${j.target?.id ?? ''}`;
const hashOf = (j: Job) => (j.params as { inputHash?: string }).inputHash ?? null;

interface Planned {
  request: JobRequest;
  key: string;
  title: string;
}

/** Images still needed; completed results with the same input are reused, running ones are not doubled. */
export function planMvWork(spec: MvLiteSpec, song: MvSong | null, title: string, projectId: string, jobs: Job[], opts: { targetIds?: string[]; force?: boolean }): { planned: Planned[]; skipped: { key: string; reason: string }[] } {
  if (!song) throw new HttpsError('failed-precondition', 'Choose the song first — shots are planned against it.');
  const only = opts.targetIds?.length ? new Set(opts.targetIds) : null;
  const planned: Planned[] = [];
  const skipped: { key: string; reason: string }[] = [];
  const activeKeys = new Set(jobs.filter(isActive).map(targetOf));
  const doneHashes = new Set(jobs.filter((j) => j.status === 'completed').map((j) => `${targetOf(j)}#${hashOf(j)}`));
  const lyrics = shotLyrics(computeMvTiming(spec, song), song.sheet);
  for (const { section, shot } of mvShotsNeedingImages(spec, only ?? undefined)) {
    const key = `lite_shot:${shot.id}`;
    const label = `${section.name || section.label} · shot ${section.shots.indexOf(shot) + 1}`;
    if (only && !opts.force && shot.image.approvedAssetId) {
      skipped.push({ key, reason: `${label}: already has an approved image (regenerate explicitly to replace it)` });
      continue;
    }
    const req = compileMvImageRequest(spec, section, shot, spec.lyrics.enabled ? lyrics[shot.id] ?? [] : []);
    if (activeKeys.has(key)) {
      skipped.push({ key, reason: `${label}: already in progress` });
      continue;
    }
    if (doneHashes.has(`${key}#${req.hash}`) && !opts.force) {
      skipped.push({ key, reason: `${label}: already made for this exact input (reused)` });
      continue;
    }
    planned.push({
      key,
      title: label,
      request: {
        type: 'image.generate',
        projectId,
        prompt: req.prompt,
        purpose: 'free',
        aspectRatio: req.aspectRatio,
        imageSize: req.imageSize,
        referenceAssetIds: req.referenceAssetIds,
        referenceLabels: req.referenceLabels,
        grounding: false,
        applyStyleBible: false,
        characterIds: [],
        collections: ['mvlite:image', `mvlite:shot:${shot.id}`],
        title: `${title} · ${label}`,
        label: `Image · ${label}`,
        target: { kind: 'lite_shot', id: shot.id },
        inputHash: req.hash,
      },
    });
  }
  return { planned, skipped };
}

export async function mvliteGenerate(owner: Owner, p: Payload<'mvliteGenerate'>) {
  const first = await loadMv(owner.uid, p.projectId);
  if (p.estimateOnly) {
    const plan = planMvWork(first.spec, first.song, first.title, p.projectId, first.jobs, { targetIds: p.targetIds, force: p.force });
    if (!plan.planned.length) return { jobIds: [], skipped: plan.skipped, estimate: null, perTarget: [], message: plan.skipped.length ? 'Nothing new to request: everything is done, reused or in progress.' : 'Nothing to request yet.' };
    const prepared = await prepareAll(owner.uid, plan.planned.map((x) => x.request));
    const estimate = sumEstimates(prepared.map((x) => x.estimate), PRICING);
    const settings = await getSettings(owner.uid);
    const spend = await spendSnapshot(owner.uid);
    let limitProblem: string | null = null;
    try {
      assertWithinLimits(settings, spend, estimate.usd);
    } catch (e) {
      limitProblem = (e as Error).message;
    }
    const budget = await projectBudget(owner.uid, p.projectId);
    if (!limitProblem && budget && budget.spentUsd + budget.pendingUsd + estimate.usd > budget.limitUsd + 1e-9) limitProblem = `This would exceed the project budget of $${budget.limitUsd.toFixed(2)}.`;
    return { jobIds: [], skipped: plan.skipped, estimate, perTarget: plan.planned.map((x, i) => ({ key: x.key, title: x.title, estimate: prepared[i]!.estimate })), confirmation: confirmationPolicy(settings, prepared, estimate.usd), limitProblem, spend, settings };
  }

  await assertRateLimit(owner.uid, 1);
  return withLock(p.projectId, `mv_${p.kind}`, async () => {
    // Re-read inside the lock so work started a moment ago by another request is seen.
    const { spec, song, title, jobs } = await loadMv(owner.uid, p.projectId);
    const plan = planMvWork(spec, song, title, p.projectId, jobs, { targetIds: p.targetIds, force: p.force });
    if (!plan.planned.length) return { jobIds: [], skipped: plan.skipped, estimate: null, perTarget: [], message: 'Nothing new to request: everything is done, reused or in progress.' };
    const res = await createJobs(owner.uid, plan.planned.map((x) => x.request), { confirmedUsd: p.confirmedUsd ?? null, batchLabel: `${title} · ${p.kind}` });
    return { jobIds: res.jobIds, skipped: plan.skipped, estimate: res.estimate, perTarget: plan.planned.map((x, i) => ({ key: x.key, title: x.title, jobId: res.jobIds[i] })) };
  });
}

/** Stops queued and running generation for the video; renders and their inspections keep running. */
export async function mvliteCancel(owner: Owner, p: Payload<'mvliteCancel'>) {
  await loadMv(owner.uid, p.projectId);
  const active = await col.jobs().where('ownerUid', '==', owner.uid).where('projectId', '==', p.projectId).where('status', 'in', [...ACTIVE_STATUSES]).get();
  const results: { jobId: string; status: string; message: string }[] = [];
  for (const d of active.docs) {
    const job = d.data() as JobDoc;
    if (job.type === 'render.timeline' || job.type === 'final.inspect') continue;
    const r = await cancelJob(owner, { jobId: d.id });
    results.push({ jobId: d.id, status: r.status, message: r.message });
  }
  return { cancelled: results.filter((r) => r.status === 'cancelled').length, results };
}
