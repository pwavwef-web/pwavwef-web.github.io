import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from 'firebase-functions';
import { evaluateAdScene, isGeneratedScene, normalizeAdSpec, type AdSceneKind, type AdSceneValidation, type AdSceneValidationSummary, type AdSpec, type JobDoc } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { lockScene, sceneJobRequest, unlockScene, type Scene } from '../lib/ads';
import { fail } from '../lib/errors';
import { col, db, FieldValue, gsUri } from '../lib/firebase';
import { logInteraction } from '../lib/interactions';
import { progress, transition } from '../lib/jobs';
import { FFMPEG, probe } from '../lib/media';
import { mediaInputUrl } from '../lib/media-proxy';
import { blackSegments } from '../lib/signal';
import { createJobs } from '../lib/submit';
import { callReasoning, usageFor } from './text';

const execFileAsync = promisify(execFile);

export interface AdValidateParams {
  sceneId: string;
  takeId: string | null;
  assetId: string;
  storagePath: string;
  mimeType: string;
  mediaKind: 'video' | 'image' | string;
  sceneKind: AdSceneKind;
  windowSec: number;
  neededSec: number;
  expectedAspect: '9:16' | '16:9' | '1:1' | null;
  outputHeight: number;
  visual: string;
  narration: string;
  direction: string;
  review: boolean;
}

const ISSUE_TYPES = ['text_in_frame', 'logo', 'watermark', 'distorted_hands', 'face_morph', 'inconsistent_character', 'artefact', 'off_brief', 'stock_look', 'real_person', 'continuity', 'other'] as const;

export const AD_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    matchesBrief: { type: 'integer', minimum: 0, maximum: 100, description: 'How well the picture shows the scene brief (100 = exactly).' },
    summary: { type: 'string', description: 'One or two sentences on what the picture actually shows.' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...ISSUE_TYPES] },
          severity: { type: 'string', enum: ['minor', 'major', 'critical'] },
          note: { type: 'string' },
        },
        required: ['type', 'severity', 'note'],
      },
    },
  },
  required: ['matchesBrief', 'summary', 'issues'],
};

const REVIEW_SYSTEM =
  'You review generated footage for a short video advert before it is edited. Report only what you can actually see in the picture. ' +
  'Text, captions and logos are added later in the edit, so any readable text, letters, logo or watermark inside the picture is an issue. ' +
  'Be strict about hands (extra or merged fingers), faces that morph, people who change appearance during the shot, and staging that looks like generic corporate stock footage. Return only JSON.';

export function normalizeAdReview(raw: unknown): NonNullable<AdSceneValidation['review']> {
  const r = (raw ?? {}) as { matchesBrief?: unknown; summary?: unknown; issues?: unknown };
  const issues = Array.isArray(r.issues) ? (r.issues as { type?: unknown; severity?: unknown; note?: unknown }[]) : [];
  const score = Number(r.matchesBrief);
  return {
    matchesBrief: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null,
    summary: String(r.summary ?? '').slice(0, 600),
    issues: issues
      .map((i) => ({
        type: (ISSUE_TYPES as readonly string[]).includes(String(i.type)) ? String(i.type) : 'other',
        severity: (['minor', 'major', 'critical'].includes(String(i.severity)) ? String(i.severity) : 'minor') as 'minor' | 'major' | 'critical',
        note: String(i.note ?? '').slice(0, 300),
      }))
      .slice(0, 12),
  };
}

/** Decodes the whole file and counts decoder errors (a playable file decodes cleanly). */
async function decodeErrors(input: string): Promise<number> {
  try {
    const { stderr } = await execFileAsync(FFMPEG, ['-hide_banner', '-v', 'error', '-i', input, '-f', 'null', '-'], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
    return stderr.split('\n').filter((l) => l.trim()).length;
  } catch (e) {
    const stderr = String((e as { stderr?: string }).stderr ?? '');
    return Math.max(1, stderr.split('\n').filter((l) => l.trim()).length);
  }
}

/** Notes folded into a regeneration prompt for the checks a take failed. */
export function repairNotesFor(v: AdSceneValidation, visual: string): string[] {
  const notes: string[] = [];
  for (const c of v.checks.filter((x) => !x.ok && x.severity === 'error')) {
    if (c.id === 'text_in_frame') notes.push('Keep every surface free of letters, signs, screens with text, logos and watermarks.');
    if (c.id === 'artefacts') notes.push('Keep hands relaxed and natural with five fingers, or out of frame; faces stay the same person throughout.');
    if (c.id === 'brief') notes.push(`Show exactly this: ${visual}`);
    if (c.id === 'duration') notes.push('Hold the action for the whole shot.');
  }
  return [...new Set(notes)];
}

export async function runAdValidateJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as AdValidateParams;
  if (!job.projectId) fail('invalid_request', 'Scene validation needs a project.');
  if (!(await transition(job.id, 'generating', { stage: 'Checking the scene', progress: 0.1, lease: { until: Date.now() + 9 * 60_000 } }))) return;
  const projectId = job.projectId!;
  const input = await mediaInputUrl(p.storagePath);
  let probeOk = true;
  let info: Awaited<ReturnType<typeof probe>> | null = null;
  try {
    info = await probe(input);
  } catch {
    probeOk = false;
  }
  const isVideo = p.mediaKind === 'video';
  const errors = probeOk && isVideo ? await decodeErrors(input) : 0;
  const black = probeOk && isVideo ? await blackSegments(input).catch(() => []) : [];
  const measurements: AdSceneValidation['measurements'] = {
    durationSec: info?.durationSec ?? null,
    width: info?.width ?? null,
    height: info?.height ?? null,
    fps: info?.fps ?? null,
    decodeErrors: errors,
    blackSec: Math.round(black.reduce((s, b) => s + (b.end - b.start), 0) * 100) / 100,
  };

  let review: AdSceneValidation['review'] = null;
  let modelId: string | null = null;
  if (p.review && probeOk) {
    await progress(job.id, 'Reviewing the picture against the scene brief', 0.45);
    const prompt =
      `Scene brief: ${p.visual}\n` +
      (p.narration ? `Voice-over heard during this scene (not in the picture): “${p.narration}”\n` : '') +
      (p.direction ? `Advert direction: ${p.direction}\n` : '') +
      'Score how well the picture shows the brief, describe what it shows, and list every issue (type, severity, note).';
    const r = await callReasoning([{ fileData: { fileUri: gsUri(p.storagePath), mimeType: p.mimeType } }, { text: prompt }], { systemInstruction: REVIEW_SYSTEM, responseJsonSchema: AD_REVIEW_SCHEMA }, 'LOW');
    await usageFor(job, r, 'text');
    review = normalizeAdReview(r.json);
    modelId = r.modelId;
    await logInteraction({ uid: job.ownerUid, projectId, jobId: job.id, modelId: r.modelId, api: 'generateContent', request: { task: 'ad_scene_review', sceneId: p.sceneId }, response: { matchesBrief: review.matchesBrief, issues: review.issues.length, usage: r.res.usageMetadata ?? null }, latencyMs: r.latencyMs });
  }

  const validation = evaluateAdScene({ kind: p.sceneKind, windowSec: p.windowSec, neededSec: p.neededSec, expectedAspect: p.expectedAspect, outputHeight: p.outputHeight, measurements, probeOk, review, modelId });
  const summary: AdSceneValidationSummary = { takeId: p.takeId ?? '', verdict: validation.verdict, checkedAt: validation.checkedAt, failed: validation.checks.filter((c) => !c.ok && c.severity === 'error').map((c) => c.label) };

  // Save on the take; the scene shows the validation of its selected take, and a passing take replaces a failed one.
  const shotRef = col.projects().doc(projectId).collection('shots').doc(p.sceneId);
  if (p.takeId) await shotRef.collection('takes').doc(p.takeId).set({ validation }, { merge: true });
  await db.runTransaction(async (tx) => {
    const shot = await tx.get(shotRef);
    if (!shot.exists) return;
    const selected = (shot.get('selectedTakeId') as string | null) ?? null;
    const selectedVerdict = selected && selected !== p.takeId ? ((await tx.get(shotRef.collection('takes').doc(selected))).get('validation.verdict') as string | undefined) : undefined;
    const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    let shown = !p.takeId || selected === p.takeId;
    if (p.takeId && validation.verdict !== 'fail' && selected !== p.takeId && (!selected || selectedVerdict === 'fail' || !selectedVerdict)) {
      patch.selectedTakeId = p.takeId;
      shown = true;
    }
    if (shown) patch['ad.validation'] = summary;
    tx.update(shotRef, patch);
  });

  // Bounded automatic quality repair: one regeneration with notes from the failed checks.
  let repairJobId: string | null = null;
  if (validation.verdict === 'fail' && isGeneratedScene(p.sceneKind) && p.takeId) {
    repairJobId = await maybeRepair(job, projectId, p, validation).catch((e) => {
      logger.warn('automatic scene repair not started', { jobId: job.id, error: String(e) });
      return null;
    });
  }
  const verdictText = validation.verdict === 'pass' ? 'Passed every check' : validation.verdict === 'warn' ? `Passed with ${validation.checks.filter((c) => !c.ok).length} warning(s)` : `Failed: ${summary.failed.join(', ')}`;
  await transition(job.id, 'completed', { stage: `${verdictText}${repairJobId ? ' · one automatic regeneration started' : ''}`, modelId: modelId ?? job.modelId, result: { data: { verdict: validation.verdict, failed: summary.failed, repairJobId } } });
}

async function maybeRepair(job: JobDoc, projectId: string, p: AdValidateParams, validation: AdSceneValidation): Promise<string | null> {
  const projectSnap = await col.projects().doc(projectId).get();
  const ad: AdSpec = normalizeAdSpec(projectSnap.get('ad') as AdSpec | undefined);
  const shotRef = col.projects().doc(projectId).collection('shots').doc(p.sceneId);
  // Claim one repair atomically (a redelivered task cannot start a second one).
  const claimed = await db.runTransaction(async (tx) => {
    const s = await tx.get(shotRef);
    const used = Number(s.get('ad.qualityRepairs') ?? 0);
    if (!s.exists || used >= ad.generation.qualityRepairs) return null;
    tx.update(shotRef, { 'ad.qualityRepairs': used + 1 });
    return { id: s.id, ...s.data() } as Scene;
  });
  if (!claimed) return null;
  if (!(await lockScene(projectId, p.sceneId, `repair:${job.id}`))) return null;
  let jobId: string | null = null;
  try {
    const request = sceneJobRequest(projectId, ad, claimed, { repairNotes: repairNotesFor(validation, p.visual) });
    const res = await createJobs(job.ownerUid, [request], { preconfirmed: true, batchLabel: `Automatic quality repair · ${claimed.title}`, skipContinuity: true });
    jobId = res.jobIds[0] ?? null;
  } finally {
    await unlockScene(projectId, p.sceneId, jobId);
  }
  logger.info('automatic scene repair started', { sceneId: p.sceneId, jobId, model: MODEL_REGISTRY.video.id });
  return jobId;
}
