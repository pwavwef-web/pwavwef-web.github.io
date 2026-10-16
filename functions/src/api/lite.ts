import { HttpsError } from 'firebase-functions/v2/https';
import {
  ACTIVE_STATUSES,
  AMBIENCE_KINDS,
  LITE_SCORE_ID,
  buildLiteScore,
  compileLiteImageRequest,
  compileNarrationRequest,
  computeLiteTiming,
  liteVocabulary,
  narrationHash,
  normalizeLiteSpec,
  pickTake,
  shotsNeedingImages,
  stableHash,
  sumEstimates,
  takesFromJobs,
  type AmbienceKind,
  type ApiRequest,
  type JobDoc,
  type JobRequest,
  type LiteNarrationTake,
  type LiteSpec,
  type ScoreDoc,
} from '@az-studio/shared';
import { PRICING } from '../config/pricing';
import { col, db, FieldValue } from '../lib/firebase';
import type { Owner } from '../lib/owner';
import { confirmationPolicy, createJobs, prepareAll } from '../lib/submit';
import { assertRateLimit, assertWithinLimits, getSettings, projectBudget, spendSnapshot } from '../lib/usage';
import { cancelJob } from './actions';

type Payload<A extends ApiRequest['action']> = Extract<ApiRequest, { action: A }>['payload'];
type Job = JobDoc & { id: string };

/** Length of a synthesised ambience bed (looped with crossfades on the timeline). */
export const AMBIENCE_BED_SEC = 90;

async function loadLite(uid: string, projectId: string): Promise<{ title: string; spec: LiteSpec; jobs: Job[] }> {
  const snap = await col.projects().doc(projectId).get();
  if (!snap.exists || snap.get('ownerUid') !== uid) throw new HttpsError('not-found', 'Film not found.');
  if (snap.get('type') !== 'film_lite') throw new HttpsError('failed-precondition', 'This is not a Film Studio Lite project.');
  const spec = normalizeLiteSpec(snap.get('lite'));
  const jobsOf = async (pid: string) => (await col.jobs().where('ownerUid', '==', uid).where('projectId', '==', pid).get()).docs.map((d) => ({ ...(d.data() as JobDoc), id: d.id }));
  const jobs = await jobsOf(projectId);
  // A copy of another Lite film reuses the original's results (nothing is generated twice).
  const source = spec.importedFrom?.projectId;
  if (source && source !== projectId) {
    const src = await col.projects().doc(source).get();
    if (src.exists && src.get('ownerUid') === uid && src.get('type') === 'film_lite') jobs.push(...(await jobsOf(source)).filter((j) => j.type !== 'render.timeline' && j.type !== 'final.inspect'));
  }
  return { title: String(snap.get('title') ?? 'Film'), spec, jobs };
}

const isActive = (j: Job) => (ACTIVE_STATUSES as readonly string[]).includes(j.status);
const targetOf = (j: Job) => `${j.target?.kind ?? ''}:${j.target?.id ?? ''}${j.target?.kind === 'lite_film' ? `:${j.target.sub ?? ''}` : ''}`;
const hashOf = (j: Job) => (j.params as { inputHash?: string }).inputHash ?? null;

/** Narration takes the film currently uses (newest take for each scene's current text, or the chosen one). */
export function currentTakes(spec: LiteSpec, jobs: Job[]): Record<string, LiteNarrationTake | null> {
  const takes = takesFromJobs(jobs);
  return Object.fromEntries(spec.scenes.map((s) => [s.id, pickTake(s, narrationHash(s, spec.voice, spec.pronunciation), takes).take]));
}

interface Planned {
  request: JobRequest;
  key: string;
  title: string;
}

/** What still needs doing for a kind of work; completed results with the same input are reused. */
export function planLiteWork(spec: LiteSpec, title: string, projectId: string, jobs: Job[], kind: Payload<'liteGenerate'>['kind'], opts: { targetIds?: string[]; force?: boolean; score?: ScoreDoc | null }): { planned: Planned[]; skipped: { key: string; reason: string }[]; score: Omit<ScoreDoc, 'id'> | null } {
  const only = opts.targetIds?.length ? new Set(opts.targetIds) : null;
  const planned: Planned[] = [];
  const skipped: { key: string; reason: string }[] = [];
  const activeKeys = new Set(jobs.filter(isActive).map(targetOf));
  const doneHashes = new Set(jobs.filter((j) => j.status === 'completed').map((j) => `${targetOf(j)}#${hashOf(j)}`));
  const consider = (key: string, hash: string, label: string, make: () => JobRequest) => {
    if (activeKeys.has(key)) return skipped.push({ key, reason: `${label}: already in progress` });
    if (doneHashes.has(`${key}#${hash}`) && !opts.force) return skipped.push({ key, reason: `${label}: already made for this exact input (reused)` });
    planned.push({ request: make(), key, title: label });
  };
  let score: Omit<ScoreDoc, 'id'> | null = null;

  if (kind === 'images') {
    for (const { scene, shot } of shotsNeedingImages(spec, only ?? undefined)) {
      if (only && !opts.force && shot.image.approvedAssetId) {
        skipped.push({ key: `lite_shot:${shot.id}`, reason: 'already has an approved image (regenerate explicitly to replace it)' });
        continue;
      }
      const req = compileLiteImageRequest(spec, scene, shot);
      const label = `${scene.title || 'Scene'} · shot ${scene.shots.indexOf(shot) + 1}`;
      consider(`lite_shot:${shot.id}`, req.hash, label, () => ({
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
        collections: ['lite:image', `lite:shot:${shot.id}`],
        title: `${title} · ${label}`,
        label: `Image · ${label}`,
        target: { kind: 'lite_shot', id: shot.id },
        inputHash: req.hash,
      }));
    }
  } else if (kind === 'narration') {
    const vocabulary = liteVocabulary(spec);
    if (spec.voice.mode === 'generate') {
      for (const scene of spec.scenes) {
        if (!scene.narration.trim() || (only && !only.has(scene.id))) continue;
        if (scene.voiceUploadAssetId) {
          // A recording uploaded for just this scene replaces the studio voice there: it is timed, not spoken.
          const hash = stableHash({ a: scene.voiceUploadAssetId, t: scene.narration });
          consider(`lite_scene:${scene.id}`, hash, `Narration timing · ${scene.title || 'scene'}`, () => ({ type: 'lite.narration', projectId, mode: 'align_scene', sceneId: scene.id, text: scene.narration, spokenText: '', direction: '', audioAssetId: scene.voiceUploadAssetId, scenes: [], languageCode: spec.setup.language, vocabulary, inputHash: hash, label: `Narration timing · ${scene.title || 'scene'}` }));
          continue;
        }
        const r = compileNarrationRequest(spec, scene);
        consider(`lite_scene:${scene.id}`, r.hash, `Narration · ${scene.title || 'scene'}`, () => ({ type: 'lite.narration', projectId, mode: 'tts', sceneId: scene.id, text: r.text, spokenText: r.spokenText, voice: r.voice, direction: r.direction, languageCode: r.languageCode, vocabulary: r.vocabulary, scenes: [], inputHash: r.hash, label: `Narration · ${scene.title || 'scene'}` }));
      }
    } else if (spec.voice.mode === 'upload_whole') {
      if (!spec.voice.wholeAssetId) throw new HttpsError('failed-precondition', 'Upload the narration recording first.');
      const scenes = spec.scenes.filter((s) => s.narration.trim()).map((s) => ({ sceneId: s.id, text: s.narration }));
      const hash = stableHash({ a: spec.voice.wholeAssetId, s: scenes });
      consider(`lite_film:${projectId}:`, hash, 'Narration timing (whole recording)', () => ({ type: 'lite.narration', projectId, mode: 'align_whole', sceneId: null, text: '', spokenText: '', direction: '', audioAssetId: spec.voice.wholeAssetId, scenes, languageCode: spec.setup.language, vocabulary, inputHash: hash, label: 'Narration timing (whole recording)' }));
    } else {
      for (const scene of spec.scenes) {
        if (!scene.voiceUploadAssetId || (only && !only.has(scene.id))) continue;
        const hash = stableHash({ a: scene.voiceUploadAssetId, t: scene.narration });
        consider(`lite_scene:${scene.id}`, hash, `Narration timing · ${scene.title || 'scene'}`, () => ({ type: 'lite.narration', projectId, mode: 'align_scene', sceneId: scene.id, text: scene.narration, spokenText: '', direction: '', audioAssetId: scene.voiceUploadAssetId, scenes: [], languageCode: spec.setup.language, vocabulary, inputHash: hash, label: `Narration timing · ${scene.title || 'scene'}` }));
      }
    }
  } else if (kind === 'music') {
    if (spec.sound.music.mode !== 'score') throw new HttpsError('failed-precondition', 'Choose “Generated score” as the music source first.');
    const timing = computeLiteTiming(spec, currentTakes(spec, jobs));
    score = buildLiteScore(spec, timing, opts.score ?? null, title);
    for (const m of score.movements) {
      if (only && !only.has(m.id)) continue;
      const key = `score:${LITE_SCORE_ID}`;
      const running = jobs.some((j) => isActive(j) && j.type === 'music.generate' && (j.params as { movementId?: string }).movementId === m.id);
      if (running) skipped.push({ key: `${key}:${m.id}`, reason: `Movement ${m.index + 1}: already composing` });
      else if (m.assetId && !opts.force) skipped.push({ key: `${key}:${m.id}`, reason: `Movement ${m.index + 1}: already composed for these scenes (reused)` });
      else if (m.locked) skipped.push({ key: `${key}:${m.id}`, reason: `Movement ${m.index + 1}: locked` });
      else planned.push({ key: `${key}:${m.id}`, title: `Score movement ${m.index + 1}`, request: { type: 'music.generate', projectId, purpose: 'score_movement', scoreId: LITE_SCORE_ID, movementId: m.id, instrumental: true, prompt: 'score', alternate: false, imageAssetIds: [], label: `Score · movement ${m.index + 1} of ${score.movements.length}` } });
    }
  } else {
    const kinds = new Set<AmbienceKind>(spec.scenes.map((s) => s.ambience.kind).filter((k): k is AmbienceKind => (AMBIENCE_KINDS as readonly string[]).includes(k)));
    for (const k of kinds) {
      if (only && !only.has(k)) continue;
      const seed = spec.setup.look.seed * 31 + AMBIENCE_KINDS.indexOf(k);
      consider(`lite_film:${projectId}:${k}`, stableHash({ k, seed, d: AMBIENCE_BED_SEC }), `${k} ambience`, () => ({ type: 'audio.ambience', projectId, kind: k, durationSec: AMBIENCE_BED_SEC, seed, label: `Ambience · ${k}` }));
    }
    // Ambience jobs carry no input hash: a completed bed of the same kind is reused.
    for (let i = planned.length - 1; i >= 0; i--) {
      const k = (planned[i]!.request as { kind?: string }).kind;
      if (!opts.force && jobs.some((j) => j.type === 'audio.ambience' && j.status === 'completed' && (j.params as { kind?: string }).kind === k)) {
        skipped.push({ key: planned[i]!.key, reason: `${k} ambience already made (reused)` });
        planned.splice(i, 1);
      }
    }
  }
  return { planned, skipped, score };
}

/** One request at a time per film and kind: a second click or tab cannot start the same paid work twice. */
export async function withLock<T>(projectId: string, kind: string, fn: () => Promise<T>): Promise<T> {
  const ref = col.projects().doc(projectId).collection('liteLocks').doc(kind);
  const got = await db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    if (cur.exists && Number(cur.get('until') ?? 0) > Date.now()) return false;
    tx.set(ref, { until: Date.now() + 90_000, at: FieldValue.serverTimestamp() });
    return true;
  });
  if (!got) throw new HttpsError('aborted', 'This work is already being started — wait a moment.');
  try {
    return await fn();
  } finally {
    await ref.delete().catch(() => undefined);
  }
}

export async function liteGenerate(owner: Owner, p: Payload<'liteGenerate'>) {
  const { title, spec } = await loadLite(owner.uid, p.projectId);
  const scoreRef = col.scores(p.projectId).doc(LITE_SCORE_ID);
  const existingScore = p.kind === 'music' ? (((await scoreRef.get()).data() as ScoreDoc | undefined) ?? null) : null;

  if (p.estimateOnly) {
    const { jobs } = await loadLite(owner.uid, p.projectId);
    const plan = planLiteWork(spec, title, p.projectId, jobs, p.kind, { targetIds: p.targetIds, force: p.force, score: existingScore });
    if (!plan.planned.length) return { jobIds: [], skipped: plan.skipped, estimate: null, perTarget: [], message: plan.skipped.length ? 'Nothing new to request: everything is done, reused or in progress.' : 'Nothing to request yet.' };
    // The estimate runs before the planned score is saved, so price against the plan, not the stored copy.
    const prepared = await prepareAll(owner.uid, plan.planned.map((x) => x.request), plan.score ? { scores: { [LITE_SCORE_ID]: { id: LITE_SCORE_ID, ...plan.score } } } : {});
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
    return {
      jobIds: [],
      skipped: plan.skipped,
      estimate,
      perTarget: plan.planned.map((x, i) => ({ key: x.key, title: x.title, estimate: prepared[i]!.estimate })),
      movements: plan.score?.movements.map((m) => ({ id: m.id, index: m.index, start: m.start, end: m.end, ready: Boolean(m.assetId) })) ?? null,
      confirmation: confirmationPolicy(settings, prepared, estimate.usd),
      limitProblem,
      spend,
      settings,
    };
  }

  await assertRateLimit(owner.uid, 1);
  return withLock(p.projectId, p.kind, async () => {
    // Re-read inside the lock so work started a moment ago by another request is seen.
    const { jobs } = await loadLite(owner.uid, p.projectId);
    const plan = planLiteWork(spec, title, p.projectId, jobs, p.kind, { targetIds: p.targetIds, force: p.force, score: existingScore });
    if (plan.score) await scoreRef.set({ ...plan.score, updatedAt: FieldValue.serverTimestamp(), ...(existingScore ? {} : { createdAt: FieldValue.serverTimestamp() }) }, { merge: false });
    if (!plan.planned.length) return { jobIds: [], skipped: plan.skipped, estimate: null, perTarget: [], message: 'Nothing new to request: everything is done, reused or in progress.' };
    const res = await createJobs(owner.uid, plan.planned.map((x) => x.request), { confirmedUsd: p.confirmedUsd ?? null, batchLabel: `${title} · ${p.kind}` });
    return { jobIds: res.jobIds, skipped: plan.skipped, estimate: res.estimate, perTarget: plan.planned.map((x, i) => ({ key: x.key, title: x.title, jobId: res.jobIds[i] })) };
  });
}

/** Stops queued and running generation for the film; renders and their inspections keep running. */
export async function liteCancel(owner: Owner, p: Payload<'liteCancel'>) {
  await loadLite(owner.uid, p.projectId);
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
