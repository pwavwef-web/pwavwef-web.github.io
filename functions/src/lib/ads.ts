import { logger } from 'firebase-functions';
import {
  AD_ASPECT_SIZES,
  AD_GENERATION_ASPECT,
  compileAdImagePrompt,
  compileAdVideoPrompt,
  isGeneratedScene,
  isTerminal,
  normalizeAdSpec,
  sceneGenerationSeconds,
  sumEstimates,
  type AdSceneSpec,
  type AdSpec,
  type CostEstimate,
  type JobDoc,
  type JobRequest,
  type ProjectDoc,
  type ShotDoc,
} from '@az-studio/shared';
import { MODEL_REGISTRY, VIDEO_CAPABILITIES } from '../config/models';
import { PRICING } from '../config/pricing';
import { col, db, FieldValue } from './firebase';
import { createInternalJob } from './submit';

/**
 * Short Ads on the server: which scenes need a generation, the requests that generate them (one at a time
 * per scene, behind a lock), and the validation that runs on every generated take before composition.
 */

export type Scene = ShotDoc & { id: string; ad: AdSceneSpec };

export async function loadAd(uid: string, projectId: string): Promise<{ project: ProjectDoc & { id: string }; ad: AdSpec; scenes: Scene[] }> {
  const snap = await col.projects().doc(projectId).get();
  if (!snap.exists || snap.get('ownerUid') !== uid) throw new Error('Project not found.');
  const project = { id: snap.id, ...snap.data() } as ProjectDoc & { id: string };
  if (project.type !== 'short_ad') throw new Error('This project is not a short ad.');
  const shots = await col.projects().doc(projectId).collection('shots').orderBy('order', 'asc').get();
  const scenes = shots.docs.map((d) => ({ id: d.id, ...d.data() }) as Scene).filter((s) => s.ad);
  return { project, ad: normalizeAdSpec(project.ad), scenes };
}

/** A scene's media is usable when its selected take finished and did not fail validation. */
export async function sceneState(projectId: string, scene: Scene): Promise<{ active: boolean; usable: boolean; failed: boolean }> {
  let active = false;
  let failed = false;
  if (scene.ad.jobId) {
    const job = await col.jobs().doc(scene.ad.jobId).get();
    const status = job.get('status') as JobDoc['status'] | undefined;
    active = Boolean(status && !isTerminal(status));
    failed = status === 'failed' || status === 'cancelled';
  }
  let usable = false;
  if (scene.selectedTakeId) {
    const take = await col.projects().doc(projectId).collection('shots').doc(scene.id).collection('takes').doc(scene.selectedTakeId).get();
    usable = Boolean(take.get('assetId')) && take.get('status') === 'completed' && (take.get('validation.verdict') as string | undefined) !== 'fail';
  }
  return { active, usable, failed };
}

/** The generation request for one scene (prompt compiled from the scene and the ad's direction). */
export function sceneJobRequest(projectId: string, ad: AdSpec, scene: Scene, opts: { repairNotes?: string[] } = {}): JobRequest {
  const window = Math.max(0.5, (scene.timing?.end ?? 0) - (scene.timing?.start ?? 0));
  const aspect = AD_GENERATION_ASPECT[ad.aspect];
  const visual = scene.description || scene.title;
  const label = `Ad scene ${scene.number || ''} · ${scene.title}`.replace(/\s+/g, ' ').trim();
  if (scene.ad.kind === 'generated_image') {
    const prompt = scene.promptOverride?.trim() || compileAdImagePrompt({ kind: 'generated_image', visual, narration: scene.ad.narration, durationSec: window, aspect, repairNotes: opts.repairNotes }, ad.brief);
    return { type: 'image.generate', projectId, prompt, purpose: 'free', aspectRatio: aspect, imageSize: '2K', referenceAssetIds: scene.refs?.assetIds?.slice(0, 6) ?? [], grounding: false, applyStyleBible: false, characterIds: [], collections: ['ad:scene'], title: scene.title.slice(0, 160), label: label.slice(0, 160), target: { kind: 'shot', id: scene.id }, adScene: true };
  }
  const durationSec = sceneGenerationSeconds(window + (scene.ad.inPoint ?? 0), VIDEO_CAPABILITIES.durationSec);
  const prompt = scene.promptOverride?.trim() || compileAdVideoPrompt({ kind: 'generated_video', visual, directions: scene.directions, narration: scene.ad.narration, durationSec, aspect, repairNotes: opts.repairNotes }, ad.brief);
  const media = (scene.refs?.assetIds ?? []).slice(0, 3).map((assetId) => ({ role: 'image_ref' as const, assetId }));
  return { type: 'video.generate', projectId, mode: 'generate', prompt, aspectRatio: aspect, resolution: ad.generation.resolution, durationSec, media, characterIds: [], title: scene.title.slice(0, 160), label: label.slice(0, 160), target: { kind: 'shot', id: scene.id }, adScene: true };
}

/** Claims a scene for one submission (stops double clicks and concurrent requests from generating twice). */
export async function lockScene(projectId: string, sceneId: string, by: string, ms = 90_000): Promise<boolean> {
  const ref = col.projects().doc(projectId).collection('shots').doc(sceneId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const lock = snap.get('ad.lock') as { until?: number } | null | undefined;
    if ((lock?.until ?? 0) > Date.now()) return false;
    tx.update(ref, { 'ad.lock': { until: Date.now() + ms, by } });
    return true;
  });
}

export async function unlockScene(projectId: string, sceneId: string, jobId: string | null): Promise<void> {
  await col.projects().doc(projectId).collection('shots').doc(sceneId).update({ 'ad.lock': null, ...(jobId ? { 'ad.jobId': jobId } : {}), updatedAt: FieldValue.serverTimestamp() });
}

/** Seconds of video the reviewer watches and what that costs (video frames + a short structured answer). */
export function estimateAdValidation(durationSec: number, review: boolean): CostEstimate {
  const t = PRICING.text[MODEL_REGISTRY.reasoning.id]!;
  const q = PRICING.inspection;
  const inTokens = Math.ceil(durationSec * q.framesPerSecond * q.videoTokensPerFrame) + 1200;
  const parts = review
    ? [
        { label: `Scene review (≈${inTokens.toLocaleString('en-US')} input tokens)`, usd: (inTokens * t.inputPerM) / 1e6 },
        { label: 'Review answer (≈1,800 tokens, estimated)', usd: (1800 * t.outputPerM) / 1e6 },
      ]
    : [{ label: 'Media checks (FFmpeg)', usd: 0 }];
  return sumEstimates([{ usd: parts.reduce((s, p) => s + p.usd, 0), basis: review ? 'published_rate' : 'compute', confidence: 'medium', breakdown: parts, notes: ['Every generated scene is checked before composition: playback, length, shape, black frames, and a review against its brief.'], pricingVersion: PRICING.version }], PRICING);
}

/** After a scene's generation completes, its take is validated before it can be composed. */
export async function afterSceneGenerated(job: JobDoc, assetId: string): Promise<void> {
  const p = job.params as { adScene?: boolean };
  if (!p.adScene || !job.projectId || job.target?.kind !== 'shot' || !job.target.sub) return;
  try {
    await scheduleValidation(job.ownerUid, job.projectId, job.target.id, job.target.sub, assetId);
  } catch (e) {
    logger.error('scene validation could not start', { jobId: job.id, error: String(e) });
  }
}

export async function scheduleValidation(uid: string, projectId: string, sceneId: string, takeId: string | null, assetId: string): Promise<string | null> {
  const [shotSnap, projectSnap, assetSnap] = await Promise.all([col.projects().doc(projectId).collection('shots').doc(sceneId).get(), col.projects().doc(projectId).get(), col.assets().doc(assetId).get()]);
  if (!shotSnap.exists || !assetSnap.exists) return null;
  const scene = { id: shotSnap.id, ...shotSnap.data() } as Scene;
  const ad = normalizeAdSpec(projectSnap.get('ad') as AdSpec | undefined);
  const window = Math.max(0.1, (scene.timing?.end ?? 0) - (scene.timing?.start ?? 0));
  const generated = isGeneratedScene(scene.ad.kind);
  const kind = assetSnap.get('kind') as string;
  const durationSec = Number(assetSnap.get('durationSec') ?? 0) || window;
  const expectedAspect = generated ? AD_GENERATION_ASPECT[ad.aspect] : null;
  const jobId = await createInternalJob(uid, {
    type: 'ad.validate',
    projectId,
    modelId: generated ? MODEL_REGISTRY.reasoning.id : null,
    label: `Validate · ${scene.title}`.slice(0, 160),
    params: {
      sceneId,
      takeId,
      assetId,
      storagePath: assetSnap.get('storagePath'),
      mimeType: assetSnap.get('mimeType'),
      mediaKind: kind,
      sceneKind: scene.ad.kind,
      windowSec: window,
      neededSec: (scene.ad.inPoint ?? 0) + window,
      expectedAspect,
      outputHeight: AD_ASPECT_SIZES[ad.aspect].height,
      visual: scene.description || scene.title,
      narration: scene.ad.narration,
      direction: ad.brief.visualDirection,
      review: generated,
    },
    estimate: estimateAdValidation(kind === 'video' ? durationSec : 1, generated),
    target: { kind: 'shot', id: sceneId },
    productionId: null,
  });
  await col.projects().doc(projectId).collection('shots').doc(sceneId).update({ 'ad.validationJobId': jobId, updatedAt: FieldValue.serverTimestamp() });
  return jobId;
}
