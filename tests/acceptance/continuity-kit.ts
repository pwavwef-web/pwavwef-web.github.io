import { expect } from 'vitest';
import {
  compileShotPrompt,
  defaultCamera,
  emptyShotContinuity,
  jobRequestSchema,
  type BlockingCamera,
  type BlockingEntity,
  type ContinuitySnapshotDoc,
  type QualitySettings,
  type ShotContinuityInput,
  type ShotDirections,
  type VideoJobRequest,
} from '@az-studio/shared';
import * as continuityApi from '../../functions/src/api/continuity';
import * as production from '../../functions/src/api/production';
import { col, FieldValue } from '../../functions/src/lib/firebase';
import type { Owner } from '../../functions/src/lib/owner';
import { payload, productionRecord, runProduction, submitJobs, waitForJob, type Log, type ProductionRecord } from './harness';

/**
 * Helpers for the Continuity Director acceptance tests: they build projects exactly as the studio
 * does (through the same typed API calls the web app makes) and run real productions at 360p.
 */

export const EMPTY_DIRECTIONS: ShotDirections = { framing: '', cameraMovement: '', lens: '', lighting: '', mood: '', style: '', performance: '', action: '', dialogue: [], ambientSound: '', avoid: '' };

/** Cheap productions: one automatic repair at most, a low ceiling, expensive retries need approval. */
export const CHEAP: Partial<QualitySettings> = { maxRepairAttempts: 1, repairCostCeilingUsd: 1.2, requireApprovalForExpensiveRetries: true, expensiveRetryUsd: 0.5, dialogueAudio: 'estimate' };

export async function generateImage(owner: Owner, projectId: string, log: Log, input: { prompt: string; title: string; aspectRatio?: string; refs?: string[]; purpose?: string; characterIds?: string[] }): Promise<string> {
  const [jobId] = await submitJobs(
    owner,
    [{ type: 'image.generate', projectId, prompt: input.prompt, purpose: input.purpose ?? 'character', aspectRatio: input.aspectRatio ?? '4:5', imageSize: '1K', referenceAssetIds: input.refs ?? [], grounding: false, applyStyleBible: false, characterIds: input.characterIds ?? [], collections: ['qa'], title: input.title, label: `QA · ${input.title}` }],
    `QA · ${input.title}`,
  );
  const job = await waitForJob(jobId!, log, 15 * 60_000);
  expect(job.status, job.error?.message).toBe('completed');
  const id = job.result?.assetIds?.[0];
  expect(id).toBeTruthy();
  log(`image “${input.title}” → ${id}`);
  return id!;
}

export function character(id: string, refId: string, label: string, x: number, y: number, facingDeg: number, extra: Partial<BlockingEntity> = {}): BlockingEntity {
  return { id, kind: 'character', refId, label, position: { x, y }, facingDeg, gaze: { kind: 'none', targetId: null, deg: null }, path: [], layer: null, occlusionAllowed: false, protectedVisibility: 'face', speaking: false, posture: 'standing', ...extra };
}

export function camera(x: number, y: number, directionDeg: number, extra: Partial<BlockingCamera> = {}): BlockingCamera {
  return { ...defaultCamera(), position: { x, y }, directionDeg, ...extra };
}

export interface ShotSpec {
  order: number;
  number: string;
  title: string;
  description: string;
  durationSec: number;
  directions: Partial<ShotDirections>;
  characterIds: string[];
  locationIds?: string[];
  elementIds?: string[];
  sceneId?: string | null;
  continuity?: Partial<ShotContinuityInput>;
}

export async function shot(projectId: string, shotId: string, s: ShotSpec): Promise<ShotDirections> {
  const directions = { ...EMPTY_DIRECTIONS, ...s.directions };
  await col.projects().doc(projectId).collection('shots').doc(shotId).set({
    sceneId: s.sceneId ?? null,
    sectionId: null,
    order: s.order,
    number: s.number,
    title: s.title,
    description: s.description,
    directions,
    promptOverride: null,
    durationSec: s.durationSec,
    aspectRatio: '16:9',
    resolution: '360p',
    refs: { characterIds: s.characterIds, locationIds: s.locationIds ?? [], elementIds: s.elementIds ?? [], assetIds: [], firstFrameAssetId: null, lastFrameAssetId: null, storyboardAssetId: null },
    lockRefs: true,
    status: 'planned',
    selectedTakeId: null,
    approvedTakeId: null,
    timing: null,
    takeCount: 0,
    notes: '',
    production: null,
    continuity: { ...emptyShotContinuity(), ...(s.continuity ?? {}) },
    continuityStatus: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return directions;
}

/** The request the Shots tab builds (prompt compiled from the directions; the production adds continuity). */
export function videoJob(projectId: string, shotId: string, s: ShotSpec, directions: ShotDirections, people: { id: string; name: string; description: string }[], place: { name: string; description: string } | null, durationSec = s.durationSec): VideoJobRequest {
  const prompt = compileShotPrompt(directions, {
    description: s.description,
    characters: people.map((c) => ({ tag: '', name: c.name, description: c.description })),
    locations: place ? [{ tag: '', name: place.name, description: place.description }] : [],
    durationSec,
    noBackgroundMusic: true,
    noOverlayText: true,
  });
  return jobRequestSchema.parse({ type: 'video.generate', projectId, mode: 'generate', prompt, aspectRatio: '16:9', resolution: '360p', durationSec, media: [], characterIds: s.characterIds, target: { kind: 'shot', id: shotId }, title: s.title, label: `QA · ${s.title}` }) as VideoJobRequest;
}

export async function saveBlocking(owner: Owner, projectId: string, shotId: string, sceneId: string | null, locationId: string | null, cam: BlockingCamera, entities: BlockingEntity[]) {
  await continuityApi.continuitySave(owner, payload('continuitySave', { projectId, collection: 'blockingPlans', data: { shotId, sceneId, locationId, camera: cam, entities, protectedZones: [], notes: '' } }));
}

export async function check(owner: Owner, projectId: string, shotId: string) {
  return continuityApi.continuityCheck(owner, payload('continuityCheck', { projectId, shotId, save: true }));
}

export interface Produced {
  productionId: string;
  estimateUsd: number;
  record: ProductionRecord;
  /** Category scores (15 categories) per version, as the AI Director Review shows them. */
  categoryScores: Record<string, Record<string, number | null>>;
}

/** Runs a production the way “Produce” does (inspection, least-destructive repair, re-inspection). */
export async function produce(owner: Owner, projectId: string, shotId: string, job: VideoJobRequest, log: Log, opts: { reviewTakeId?: string; requestedSec?: number; settings?: Partial<QualitySettings> } = {}): Promise<Produced> {
  const options = { requestedSec: opts.requestedSec ?? job.durationSec ?? 4, ...(opts.reviewTakeId ? { reviewTakeId: opts.reviewTakeId } : {}), settings: { ...CHEAP, ...(opts.settings ?? {}) } };
  const est = await production.estimateProduction(owner, payload('estimateProduction', { projectId, shotId, job, options }));
  log(`${shotId}: estimate ≈ $${est.estimate.usd.toFixed(3)} · continuity ${JSON.stringify(est.continuity)}`);
  const started = await production.startProduction(owner, payload('startProduction', { projectId, shotId, job, options, confirmedUsd: est.estimate.usd }));
  await runProduction(owner, started.productionId, log, { approveUpToUsd: 0 });
  const record = await productionRecord(started.productionId);
  const versions = await col.productions().doc(started.productionId).collection('versions').get();
  const categoryScores = Object.fromEntries(versions.docs.map((v) => [String(v.get('index')), (v.get('categoryScores') as Record<string, number | null> | undefined) ?? {}]));
  return { productionId: started.productionId, estimateUsd: est.estimate.usd, record, categoryScores };
}

/** Approves the current version (waiving nothing) or, when it failed, keeps the original with its issues recorded. */
export async function approve(owner: Owner, productionId: string, record: ProductionRecord, log: Log) {
  const current = record.versions.find((v) => v.version.id === record.currentVersionId) ?? record.versions.at(-1)!;
  if (current.report?.passed) {
    await production.productionAction(owner, payload('productionAction', { productionId, action: 'approve', versionId: current.version.id }));
    log(`approved version ${current.version.index} (${current.report.overall}/100)`);
  } else {
    await production.productionAction(owner, payload('productionAction', { productionId, action: 'keep_original', note: 'QA: approved with its issues recorded to continue the sequence' }));
    log(`kept the original version with its issues recorded`);
  }
}

export async function snapshot(projectId: string, shotId: string): Promise<ContinuitySnapshotDoc | null> {
  const s = await col.projects().doc(projectId).collection('continuitySnapshots').doc(shotId).get();
  return s.exists ? (s.data() as ContinuitySnapshotDoc) : null;
}

/**
 * A deliberately wrong version of a shot, made outside its continuity plan (like a clip imported or
 * generated before the bibles were locked): generated without a shot target, then filed as a take of the
 * shot so the production can review it.
 */
export async function outsideTake(owner: Owner, projectId: string, shotId: string, job: VideoJobRequest, log: Log): Promise<{ takeId: string; assetId: string }> {
  const { target: _t, ...free } = job;
  void _t;
  const [jobId] = await submitJobs(owner, [{ ...free, projectId }], `QA · ${job.title}`);
  const done = await waitForJob(jobId!, log, 30 * 60_000);
  expect(done.status, done.error?.message).toBe('completed');
  const assetId = done.result!.assetIds![0]!;
  const takes = col.projects().doc(projectId).collection('shots').doc(shotId).collection('takes');
  const ref = takes.doc();
  const count = (await takes.get()).size;
  await ref.set({ index: count + 1, jobId: jobId!, assetId, status: 'completed', prompt: job.prompt, params: {}, interactionId: null, parentTakeId: null, label: `${job.title} (outside the plan)`, rating: 0, notes: 'QA: generated without the continuity plan', approved: false, productionId: null, createdAt: FieldValue.serverTimestamp() });
  log(`outside-the-plan take ${ref.id} (asset ${assetId}) filed under ${shotId}`);
  return { takeId: ref.id, assetId };
}

export function allProblems(p: Produced): { version: number; category: string; severity: string; blocking: boolean; description: string }[] {
  return p.record.versions.flatMap((v) => (v.report?.problems ?? []).map((x) => ({ version: v.version.index, category: x.category, severity: x.severity, blocking: x.blocking, description: x.description })));
}
