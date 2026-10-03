import { HttpsError } from 'firebase-functions/v2/https';
import { ACTIVE_STATUSES, isGeneratedScene, sceneWindowProblems, sumEstimates, type ApiRequest, type JobDoc } from '@az-studio/shared';
import { PRICING } from '../config/pricing';
import { estimateAdValidation, loadAd, lockScene, sceneJobRequest, sceneState, scheduleValidation, unlockScene, type Scene } from '../lib/ads';
import { col } from '../lib/firebase';
import type { Owner } from '../lib/owner';
import { confirmationPolicy, createJobs, prepareAll } from '../lib/submit';
import { assertRateLimit, assertWithinLimits, getSettings, projectBudget, spendSnapshot } from '../lib/usage';
import { cancelJob } from './actions';

type Payload<A extends ApiRequest['action']> = Extract<ApiRequest, { action: A }>['payload'];

async function ad(owner: Owner, projectId: string) {
  try {
    return await loadAd(owner.uid, projectId);
  } catch (e) {
    throw new HttpsError('not-found', (e as Error).message);
  }
}

/**
 * Generates the scenes that need it — generated scenes without a usable result (or the ones named, when
 * forced) — and never touches completed scenes. Each scene is locked while its request is created, so a
 * double click or a second tab cannot start a second paid generation.
 */
export async function adGenerate(owner: Owner, p: Payload<'adGenerate'>) {
  const { project, ad: spec, scenes } = await ad(owner, p.projectId);
  const duration = spec.audio.durationSec ?? spec.brief.durationSec;
  const problems = sceneWindowProblems(scenes.map((s) => ({ start: s.timing?.start ?? 0, end: s.timing?.end ?? 0, kind: s.ad.kind })), duration);
  if (problems.length) throw new HttpsError('failed-precondition', `Fix the storyboard first: ${problems.slice(0, 3).join(' ')}`);
  const named = p.sceneIds ? new Set(p.sceneIds) : null;
  const chosen: Scene[] = [];
  const skipped: { sceneId: string; reason: string }[] = [];
  for (const s of scenes) {
    if (!isGeneratedScene(s.ad.kind)) continue;
    if (named && !named.has(s.id)) continue;
    const st = await sceneState(project.id, s);
    if (st.active) skipped.push({ sceneId: s.id, reason: 'already generating' });
    else if (st.usable && !(p.force && named?.has(s.id))) skipped.push({ sceneId: s.id, reason: 'already has a usable result' });
    else chosen.push(s);
  }
  if (!chosen.length) return { jobIds: [], skipped, estimate: null, perScene: [], message: skipped.length ? 'Every scene already has a result or is generating.' : 'There are no generated scenes in the storyboard.' };

  const requests = chosen.map((s) => sceneJobRequest(project.id, spec, s));
  const prepared = await prepareAll(owner.uid, requests, { skipContinuity: true });
  const generation = sumEstimates(prepared.map((x) => x.estimate), PRICING);
  const checks = sumEstimates(chosen.map((s) => estimateAdValidation(Math.max(1, (s.timing?.end ?? 0) - (s.timing?.start ?? 0)), true)), PRICING);
  const settings = await getSettings(owner.uid);
  if (p.estimateOnly) {
    const spend = await spendSnapshot(owner.uid);
    let limitProblem: string | null = null;
    try {
      assertWithinLimits(settings, spend, generation.usd + checks.usd);
    } catch (e) {
      limitProblem = (e as Error).message;
    }
    const budget = await projectBudget(owner.uid, project.id);
    if (!limitProblem && budget && budget.spentUsd + budget.pendingUsd + generation.usd > budget.limitUsd + 1e-9) limitProblem = `This would exceed the project budget of $${budget.limitUsd.toFixed(2)}.`;
    const repairsUpTo = chosen.length * spec.generation.qualityRepairs;
    return {
      jobIds: [],
      skipped,
      estimate: generation,
      validationEstimate: checks,
      perScene: chosen.map((s, i) => ({ sceneId: s.id, title: s.title, kind: s.ad.kind, estimate: prepared[i]!.estimate })),
      confirmation: confirmationPolicy(settings, prepared, generation.usd),
      limitProblem,
      spend,
      settings,
      notes: [
        `Each generated scene is validated before composition (≈ $${checks.usd.toFixed(3)} in total).`,
        repairsUpTo ? `If a scene fails validation, up to ${spec.generation.qualityRepairs} automatic regeneration${spec.generation.qualityRepairs === 1 ? '' : 's'} per scene may follow (at most ${repairsUpTo} in all), within your spending limits.` : 'Automatic quality regenerations are off for this advert.',
        'Temporary Google failures are retried with backoff; a blocked prompt is rewritten at most once; nothing is resubmitted after Google accepted it.',
      ],
    };
  }

  await assertRateLimit(owner.uid, chosen.length);
  const lockedIdx: number[] = [];
  for (const [i, s] of chosen.entries()) {
    if (await lockScene(project.id, s.id, owner.uid)) lockedIdx.push(i);
    else skipped.push({ sceneId: s.id, reason: 'another request is starting it' });
  }
  if (!lockedIdx.length) return { jobIds: [], skipped, estimate: null, perScene: [], message: 'These scenes are already being started.' };
  const lockedScenes = lockedIdx.map((i) => chosen[i]!);
  try {
    const res = await createJobs(owner.uid, lockedIdx.map((i) => requests[i]!), { confirmedUsd: p.confirmedUsd ?? null, batchLabel: `${project.title} · ${lockedIdx.length} scene${lockedIdx.length === 1 ? '' : 's'}`, skipContinuity: true }, lockedIdx.map((i) => prepared[i]!));
    await Promise.all(lockedScenes.map((s, k) => unlockScene(project.id, s.id, res.jobIds[k] ?? null)));
    return { jobIds: res.jobIds, skipped, estimate: res.estimate, perScene: lockedScenes.map((s, k) => ({ sceneId: s.id, jobId: res.jobIds[k] })) };
  } catch (e) {
    await Promise.all(lockedScenes.map((s) => unlockScene(project.id, s.id, null)));
    throw e;
  }
}

/** Validates a scene's picture again: the selected take of a generated scene, or the supplied asset. */
export async function adValidateScene(owner: Owner, p: Payload<'adValidateScene'>) {
  const { project, scenes } = await ad(owner, p.projectId);
  const scene = scenes.find((s) => s.id === p.sceneId);
  if (!scene) throw new HttpsError('not-found', 'Scene not found.');
  let takeId: string | null = null;
  let assetId: string | null;
  if (isGeneratedScene(scene.ad.kind)) {
    takeId = scene.selectedTakeId;
    if (!takeId) throw new HttpsError('failed-precondition', 'This scene has no generated take yet.');
    assetId = ((await col.projects().doc(project.id).collection('shots').doc(scene.id).collection('takes').doc(takeId).get()).get('assetId') as string | null) ?? null;
  } else assetId = scene.ad.assetIds[0] ?? null;
  if (!assetId) throw new HttpsError('failed-precondition', 'This scene has no picture to validate.');
  const jobId = await scheduleValidation(owner.uid, project.id, scene.id, takeId, assetId);
  return { jobId };
}

/** Stops every queued or running generation and validation of the advert. */
export async function adCancel(owner: Owner, p: Payload<'adCancel'>) {
  await ad(owner, p.projectId);
  const active = await col.jobs().where('ownerUid', '==', owner.uid).where('projectId', '==', p.projectId).where('status', 'in', [...ACTIVE_STATUSES]).get();
  const results: { jobId: string; status: string; message: string }[] = [];
  for (const d of active.docs) {
    const job = d.data() as JobDoc;
    if (job.type === 'render.timeline') continue;
    const r = await cancelJob(owner, { jobId: d.id });
    results.push({ jobId: d.id, status: r.status, message: r.message });
  }
  return { cancelled: results.filter((r) => r.status === 'cancelled').length, results };
}
