import { logger } from 'firebase-functions';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  ACTIVE_PRODUCTION_STATUSES,
  CATEGORY_KEYS,
  CATEGORY_LABELS,
  chooseRepair,
  decideAfterInspection,
  editorialWindows,
  estimateImage,
  estimateInspection,
  estimateLocalCompute,
  estimateSpeech,
  estimateSpeechSeconds,
  estimateText,
  estimateVideo,
  estimateVision,
  evaluateQuality,
  isTerminal,
  manualOptions,
  planSceneDuration,
  rankTakes,
  REPAIR_LABELS,
  segmentTimingDirections,
  strongestVersion,
  sumEstimates,
  toMillis,
  type CategoryScores,
  type CostEstimate,
  type DurationPlan,
  type EditorialWindow,
  type JobDoc,
  type OmniMediaRef,
  type PlanLine,
  type PlanSegment,
  type ProductionContinuity,
  type ProductionDoc,
  type ProductionStage,
  type ProductionStatus,
  type ProductionSummary,
  type ProductionVersionDoc,
  type QualityReportDoc,
  type RepairAttemptDoc,
  type RepairContext,
  type RepairDecision,
  type RepairRecord,
  type RepairType,
  type TakeComparison,
  type TakeDoc,
  type VersionKind,
  type VideoJobRequest,
} from '@az-studio/shared';
import { MODEL_REGISTRY, VIDEO_CAPABILITIES } from '../config/models';
import { PRICING } from '../config/pricing';
import { applyContinuityToRequest, loadShotContinuity, planContinuity, savePlan } from './continuity';
import { toJobError } from './errors';
import { col, db, FieldValue } from './firebase';
import { enqueueProduction } from './jobs';
import { prepareColorMatch, prepareScreenReplace } from './prepare-studio';
import { createInternalJob, createJobs } from './submit';
import { mediaInputUrl } from './media-proxy';
import { decodeMono, speechBounds } from './signal';
import type { CompositeParams } from '../workers/composite';
import type { InspectParams, InspectReference } from '../workers/inspect';
import type { SpokenLineResult } from '../workers/speech';

export const CAPS = { minSec: VIDEO_CAPABILITIES.durationSec.min, maxSec: VIDEO_CAPABILITIES.durationSec.max, maxChainSec: VIDEO_CAPABILITIES.maxExtendedLengthSec };
const CONTINUITY = 'Keep exactly the same characters, faces, wardrobe, hairstyles, props, location, lighting, time of day, camera style and emotional state.';

/** Where the production is in a multi-step generation or repair. */
export interface ProductionRun {
  kind: 'generation' | 'repair';
  type: RepairType | null;
  step: 'speech' | 'chain' | 'video' | 'insert' | 'composite' | 'trim' | 'extend_upload' | 'blocking_frame' | 'compare';
  baseVersionId: string | null;
  decision: RepairDecision | null;
  data: Record<string, unknown>;
}

type Prod = ProductionDoc & { run?: ProductionRun | null; lock?: { until: number } | null };

const ref = (id: string) => col.productions().doc(id);

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

export async function loadProduction(id: string): Promise<Prod | null> {
  const snap = await ref(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Prod) : null;
}

async function event(p: Pick<Prod, 'id' | 'stage' | 'status'>, message: string, detail: Record<string, unknown> = {}): Promise<void> {
  await ref(p.id).collection('events').add({ at: Date.now(), stage: p.stage, status: p.status, message: message.slice(0, 600), detail, createdAt: FieldValue.serverTimestamp() });
}

/** Mirrors a compact summary onto the shot for lists and badges. */
export async function mirrorShot(p: Prod, extra: { overall?: number | null; passed?: boolean | null } = {}): Promise<void> {
  const summary: ProductionSummary = {
    id: p.id,
    status: p.status,
    stage: p.stage,
    message: p.stageMessage,
    overall: extra.overall ?? null,
    passed: extra.passed ?? null,
    versionCount: p.versionCount,
    updatedAt: Date.now(),
  };
  try {
    await col.projects().doc(p.projectId).collection('shots').doc(p.shotId).set({ production: summary, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  } catch (e) {
    logger.warn('mirrorShot failed', { productionId: p.id, error: String(e) });
  }
}

/** Updates status/stage/message (and anything else), logs the event and refreshes the shot badge. */
async function setState(p: Prod, patch: Partial<Prod> & { status?: ProductionStatus; stage?: ProductionStage; stageMessage?: string }, summary: { overall?: number | null; passed?: boolean | null } = {}, detail: Record<string, unknown> = {}): Promise<Prod> {
  const next = { ...p, ...patch } as Prod;
  await ref(p.id).set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  if (patch.stageMessage || patch.status || patch.stage) await event(next, next.stageMessage, detail);
  await mirrorShot(next, summary);
  return next;
}

async function claim(id: string): Promise<Prod | 'locked' | null> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref(id));
    if (!snap.exists) return null;
    const p = { id: snap.id, ...snap.data() } as Prod;
    if ((p.lock?.until ?? 0) > Date.now()) return 'locked' as const;
    tx.update(ref(id), { lock: { until: Date.now() + 4 * 60_000 } });
    return p;
  });
}

async function release(id: string): Promise<void> {
  await ref(id).set({ lock: null }, { merge: true });
}

async function loadJobs(ids: string[]): Promise<JobDoc[]> {
  if (!ids.length) return [];
  const snaps = await db.getAll(...ids.map((id) => col.jobs().doc(id)));
  return snaps.filter((s) => s.exists).map((s) => ({ id: s.id, ...s.data() }) as JobDoc);
}

/** Recorded spend of every job this production submitted. */
export async function productionSpend(productionId: string): Promise<number> {
  const snap = await col.jobs().where('productionId', '==', productionId).get();
  return Math.round(snap.docs.reduce((s, d) => s + Number(d.get('usageUsd') ?? 0), 0) * 1e6) / 1e6;
}

async function loadVersion(p: Pick<Prod, 'id'>, versionId: string | null): Promise<ProductionVersionDoc | null> {
  if (!versionId) return null;
  const snap = await ref(p.id).collection('versions').doc(versionId).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as ProductionVersionDoc) : null;
}

async function loadVersions(p: Pick<Prod, 'id'>): Promise<ProductionVersionDoc[]> {
  const snap = await ref(p.id).collection('versions').orderBy('index', 'asc').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as ProductionVersionDoc);
}

export async function loadReport(p: Pick<Prod, 'id'>, reportId: string | null): Promise<QualityReportDoc | null> {
  if (!reportId) return null;
  const snap = await ref(p.id).collection('reports').doc(reportId).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as QualityReportDoc) : null;
}

export function continuable(v: ProductionVersionDoc): boolean {
  const created = v.interactionAt ?? toMillis(v.createdAt as never) ?? Date.now();
  const fresh = (Date.now() - created) / 86_400_000 < VIDEO_CAPABILITIES.interactionRetentionDays - 0.25;
  return Boolean(v.interactionId && v.takeId && fresh && v.chainSec + CAPS.minSec <= CAPS.maxChainSec);
}

// Repair attempts (projects/{projectId}/repairAttempts) --------------------------------------------

async function recordAttempt(p: Prod, v: ProductionVersionDoc, d: RepairDecision, estimateUsd: number, categories: string[], directorRequested: boolean): Promise<string> {
  const attempt = col.sub(p.projectId, 'repairAttempts').doc();
  const doc: Omit<RepairAttemptDoc, 'id'> = {
    shotId: p.shotId,
    productionId: p.id,
    fromVersionId: v.id,
    // The version being repaired is never modified or deleted; the repair produces a new version.
    fromAssetId: v.assetId,
    resultVersionId: null,
    resultAssetId: null,
    type: d.type,
    label: REPAIR_LABELS[d.type],
    reason: d.reason,
    instruction: d.instruction,
    categories,
    jobIds: [],
    estimateUsd,
    costUsd: null,
    outcome: 'pending',
    resultOverall: null,
    directorRequested,
    at: Date.now(),
  };
  await attempt.set({ ...doc, updatedAt: FieldValue.serverTimestamp() });
  return attempt.id;
}

async function updateAttempt(projectId: string, attemptId: string | null | undefined, patch: Partial<RepairAttemptDoc> & Record<string, unknown>): Promise<void> {
  if (!attemptId) return;
  try {
    await col.sub(projectId, 'repairAttempts').doc(attemptId).set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  } catch (e) {
    logger.warn('repair attempt update failed', { attemptId, error: String(e) });
  }
}

/** Adds a follow-up job (blocking frame → video, insert → edit…) to the running repair's record. */
function withRepairJob(repairs: RepairRecord[], jobId: string): RepairRecord[] {
  return repairs.map((r, i) => (i === repairs.length - 1 && r.outcome === 'pending' ? { ...r, jobIds: [...new Set([...r.jobIds, jobId])] } : r));
}

async function jobsCost(ids: string[]): Promise<number> {
  const jobs = await loadJobs([...new Set(ids)]);
  return Math.round(jobs.reduce((s, j) => s + Number(j.usageUsd ?? 0), 0) * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function dialogueSentence(units: PlanSegment['units']): string {
  return units.length ? units.map((u) => `${u.character || 'A character'} says: "${u.text.replace(/"/g, "'")}"`).join(' ') : 'No dialogue.';
}

/** Segment prompt: the first part keeps the full shot prompt (with only its own dialogue); later parts continue it. */
export function segmentPrompt(basePrompt: string, plan: DurationPlan, seg: PlanSegment, extra = ''): string {
  const timing = segmentTimingDirections(plan, seg).join(' ');
  if (seg.index === 0) {
    let body = basePrompt;
    if (plan.segments.length > 1) {
      const lines = body.split('\n');
      const i = lines.findIndex((l) => l.startsWith('Dialogue:'));
      const d = `Dialogue (this part only — the scene continues in a connected shot): ${dialogueSentence(seg.units)}`;
      if (i >= 0) lines[i] = d;
      else lines.push(d);
      body = lines.join('\n');
    }
    return [body, timing ? `Timing: ${timing}` : '', extra].filter(Boolean).join('\n');
  }
  return [
    'Continue this exact scene from its final frame. Do not restart the scene and do not repeat anything already said.',
    seg.camera,
    seg.units.length ? `Dialogue in this part, in order: ${dialogueSentence(seg.units)}` : 'No new dialogue in this part.',
    timing,
    CONTINUITY,
    extra,
  ]
    .filter(Boolean)
    .join(' ');
}

/** A one-part plan of `secs` seconds carrying the whole scene (regenerations). */
function singlePlan(p: Prod, secs: number): { plan: DurationPlan; seg: PlanSegment } {
  const reference = p.plan ?? planFor(p, secs);
  const seg: PlanSegment = {
    index: 0,
    durationSec: secs,
    startSec: 0,
    endSec: secs,
    units: p.expected.lines.map((l) => ({ lineIndex: l.index, character: l.character, text: l.text, seconds: 0 })),
    speechStartSec: p.expected.lines.length ? reference.breakdown.openingSec : null,
    speechEndSec: p.expected.lines.length ? Math.max(0, secs - reference.breakdown.closingSec - reference.breakdown.actionTailSec) : null,
    kind: 'opening',
    camera: '',
  };
  return { plan: { ...reference, plannedSec: secs, strategy: 'single', segments: [seg] }, seg };
}

// ---------------------------------------------------------------------------
// Submitting child jobs
// ---------------------------------------------------------------------------

function baseRequest(p: Prod): VideoJobRequest {
  return p.request as unknown as VideoJobRequest;
}

/** Submits `count` identical video requests (independent takes). The request already carries its continuity. */
async function submitVideos(p: Prod, over: Partial<VideoJobRequest> & { mode: VideoJobRequest['mode']; prompt: string }, label: string, toShot = true, count = 1): Promise<string[]> {
  const base = baseRequest(p);
  const make = (i: number): VideoJobRequest => ({
    type: 'video.generate',
    projectId: p.projectId,
    mode: over.mode,
    prompt: over.prompt.slice(0, 12000),
    aspectRatio: over.mode === 'generate' ? base.aspectRatio ?? null : null,
    resolution: base.resolution ?? null,
    durationSec: over.mode === 'edit' ? null : over.durationSec ?? null,
    media: over.media ?? (over.mode === 'generate' ? base.media ?? [] : []),
    chainId: null,
    parentTurnId: null,
    parentTakeId: over.parentTakeId ?? null,
    characterIds: base.characterIds ?? [],
    label: `${p.title} · ${label}${count > 1 ? ` (take ${i + 1} of ${count})` : ''}`.slice(0, 160),
    target: toShot ? { kind: 'shot', id: p.shotId } : { kind: 'production', id: p.id },
    ...(base.title ? { title: base.title } : {}),
  });
  const reqs = Array.from({ length: count }, (_, i) => make(i));
  const res = await createJobs(p.ownerUid, reqs, { productionId: p.id, preconfirmed: true, batchLabel: reqs[0]!.label, skipContinuity: true });
  return res.jobIds;
}

async function submitVideo(p: Prod, over: Partial<VideoJobRequest> & { mode: VideoJobRequest['mode']; prompt: string }, label: string, toShot = true): Promise<string> {
  return (await submitVideos(p, over, label, toShot, 1))[0]!;
}

/** Character/storyboard references plus the Continuity Director's set views and approved bible references. */
async function inspectionReferences(p: Prod): Promise<InspectReference[]> {
  const wanted: { assetId: string; label: string }[] = [];
  const add = (assetId: string | null | undefined, label: string) => {
    if (assetId && !wanted.some((w) => w.assetId === assetId)) wanted.push({ assetId, label });
  };
  const refs = p.continuity?.refs ?? [];
  for (const r of refs.filter((x) => x.kind === 'set')) add(r.assetId, r.label);
  for (const r of refs.filter((x) => x.kind === 'character')) add(r.assetId, r.label);
  for (const c of p.expected.characters.slice(0, 4)) add(c.referenceAssetId, `Character reference: ${c.name}`);
  add(p.expected.storyboardAssetId, 'Storyboard frame for this shot');
  for (const r of refs.filter((x) => x.kind === 'prop' || x.kind === 'screen')) add(r.assetId, r.label);
  const ids = wanted.slice(0, 8);
  if (!ids.length) return [];
  const snaps = await db.getAll(...ids.map((w) => col.assets().doc(w.assetId)));
  return snaps
    .filter((s) => s.exists && s.get('kind') === 'image' && s.get('status') === 'ready')
    .map((s) => ({ assetId: s.id, storagePath: String(s.get('storagePath')), mimeType: String(s.get('mimeType')), label: ids.find((w) => w.assetId === s.id)!.label }));
}

/** Frames Cloud Vision reads during an inspection (≈1 per second, plus mirrored OCR when screens are protected). */
function visionFrames(durationSec: number, screens: number): number {
  return Math.min(16, Math.ceil(durationSec) + 2) + (screens > 0 ? 4 : 0) + 1;
}

export function inspectionEstimate(durationSec: number, referenceImages: number, screens = 0): CostEstimate {
  return sumEstimates([estimateInspection({ modelId: MODEL_REGISTRY.reasoning.id, durationSec, referenceImages, promptChars: 9000 }, PRICING), estimateVision({ images: visionFrames(durationSec, screens), features: 3 }, PRICING)], PRICING);
}

async function createInspectionJob(p: Prod, v: ProductionVersionDoc): Promise<string> {
  const references = await inspectionReferences(p);
  let previousShot: InspectParams['previousShot'] = null;
  let previousFrame: { storagePath: string } | null = null;
  if (p.continuity?.previousFinalFrameAssetId) {
    const a = await col.assets().doc(p.continuity.previousFinalFrameAssetId).get();
    if (a.exists && a.get('status') === 'ready') previousFrame = { storagePath: String(a.get('storagePath')) };
  }
  if (!previousFrame && p.expected.previousShot) {
    const a = await col.assets().doc(p.expected.previousShot.assetId).get();
    if (a.exists && a.get('status') === 'ready') previousShot = { storagePath: String(a.get('storagePath')), title: p.expected.previousShot.title };
  }
  const c = p.continuity ?? null;
  const params: InspectParams = {
    productionId: p.id,
    versionId: v.id,
    versionIndex: v.index,
    assetId: v.assetId!,
    storagePath: String((await col.assets().doc(v.assetId!).get()).get('storagePath')),
    takeRef: v.takeId ? { shotId: p.shotId, takeId: v.takeId } : null,
    expected: p.expected,
    plan: { requiredSec: p.plan?.requiredSec ?? null, plannedSec: p.plan?.plannedSec ?? null, plannedCuts: v.plannedCuts, editorialCuts: v.editorialCuts ?? [] },
    settings: p.settings,
    waivedCategories: p.waivedCategories,
    references,
    previousShot,
    label: `${p.title} · version ${v.index}${v.take ? ` (take ${v.take})` : ''}`,
    continuity: c
      ? {
          shotId: p.shotId,
          expectations: c.expectations,
          names: c.names,
          previousFrame: previousFrame ? { storagePath: previousFrame.storagePath, title: p.expected.previousShot?.title ?? 'the previous shot' } : null,
          sameScenePrevious: Boolean(c.previousFinalFrameAssetId),
        }
      : null,
  };
  const estimate = inspectionEstimate(v.durationSec ?? 8, references.length + (previousShot || previousFrame ? 1 : 0), c?.expectations.screens.length ?? 0);
  return createInternalJob(p.ownerUid, { type: 'quality.inspect', projectId: p.projectId, modelId: MODEL_REGISTRY.reasoning.id, label: `Quality review · ${p.title} v${v.index}`, params: params as unknown as Record<string, unknown>, estimate, target: { kind: 'production', id: p.id, sub: v.id }, productionId: p.id });
}

async function submitInspection(p: Prod, v: ProductionVersionDoc, stage: 'inspect' | 'reinspect'): Promise<Prod> {
  const jobId = await createInspectionJob(p, v);
  const continuity = p.continuity ? ', continuity (characters, set, blocking, direction, props, text)' : ' and continuity';
  return setState(p, { status: 'inspecting', stage, waitingOn: [jobId], stageMessage: `Inspecting version ${v.index}: transcribing the dialogue and reviewing picture, performance${continuity}` });
}

async function submitComposite(p: Prod, params: CompositeParams, label: string): Promise<string> {
  return createInternalJob(p.ownerUid, {
    type: 'media.composite',
    projectId: p.projectId,
    modelId: null,
    label: `${p.title} · ${label}`,
    params: params as unknown as Record<string, unknown>,
    estimate: { usd: 0, basis: 'compute', confidence: 'high', breakdown: [], notes: ['FFmpeg edit inside AZ Studio (no model call).'], pricingVersion: PRICING.version },
    target: { kind: 'production', id: p.id },
    productionId: p.id,
  });
}

async function createVersion(p: Prod, input: { kind: VersionKind; parentVersionId: string | null; repair: RepairDecision | null; jobIds: string[]; takeId: string | null; assetId: string; interactionId: string | null; interactionAt?: number | null; plannedCuts: number[]; editorialCuts?: EditorialWindow[]; label: string; take?: number | null }): Promise<{ p: Prod; v: ProductionVersionDoc }> {
  const asset = await col.assets().doc(input.assetId).get();
  const durationSec = Number(asset.get('durationSec') ?? 0) || null;
  const vref = ref(p.id).collection('versions').doc();
  const index = p.versionCount + 1;
  const v: ProductionVersionDoc = {
    id: vref.id,
    index,
    parentVersionId: input.parentVersionId,
    kind: input.kind,
    repair: input.repair,
    jobIds: input.jobIds,
    takeId: input.takeId,
    assetId: input.assetId,
    interactionId: input.interactionId,
    interactionAt: input.interactionAt ?? null,
    durationSec,
    chainSec: durationSec ?? 0,
    plannedCuts: input.plannedCuts,
    editorialCuts: input.editorialCuts ?? [],
    reportId: null,
    verdict: 'pending',
    overall: null,
    scores: null,
    categoryScores: null,
    take: input.take ?? null,
    label: input.label,
  };
  await vref.set({ ...v, createdAt: FieldValue.serverTimestamp() });
  if (input.takeId) await col.projects().doc(p.projectId).collection('shots').doc(p.shotId).collection('takes').doc(input.takeId).set({ versionId: v.id, productionId: p.id }, { merge: true });
  const next = await setState(p, { versionCount: index, currentVersionId: v.id, run: null, waitingOn: [], stageMessage: `Version ${index} ready (${input.label})` });
  return { p: next, v: { ...v, createdAt: { toMillis: () => Date.now() } } };
}

// ---------------------------------------------------------------------------
// Stage: continuity (Continuity Director)
// ---------------------------------------------------------------------------

/**
 * Compiles the shot's continuity once: the approved Visual Bible, character, set and prop bibles, the
 * blocking plan, the camera axis and the previous approved state become structured direction and
 * reference images baked into the request; the snapshot records the plan; inspection gets the
 * expectations and references. Critical plan warnings stop the production before anything is spent.
 */
async function establishContinuity(p: Prod): Promise<Prod | null> {
  const base = baseRequest(p);
  const basePrompt = p.continuity?.basePrompt ?? String(base.prompt);
  const baseMedia: OmniMediaRef[] = p.continuity?.baseMedia ?? base.media ?? [];
  const ctx = await loadShotContinuity(p.projectId, p.shotId);
  const plan = planContinuity(ctx, baseMedia, { lockRefs: ctx.shot.lockRefs });
  const snapshot = await savePlan(plan, { productionId: p.id });
  // Only the plan's own warnings can stop a production (a re-production is how inspection and comparison findings get fixed).
  const open = snapshot.continuityWarnings.filter((w) => w.status === 'open' && w.severity !== 'info' && w.source === 'plan');
  const critical = open.filter((w) => w.severity === 'critical');
  const sameScene = Boolean(ctx.previous && ctx.previous.shot.sceneId && ctx.previous.shot.sceneId === ctx.shot.sceneId);
  const previousFrame = sameScene ? ctx.previous?.snapshot.finalFrameAssetId ?? null : null;
  const continuity: ProductionContinuity = {
    plannedAt: Date.now(),
    basePrompt,
    baseMedia,
    expectations: plan.expectations,
    refs: plan.inspectionRefs,
    colourRefAssetId: previousFrame,
    previousFinalFrameAssetId: previousFrame,
    constraints: plan.compiled.protectedConstraints.length,
    preferences: plan.compiled.optionalPreferences.length,
    openWarnings: open.length,
    dropped: plan.compiled.dropped.map((d) => ({ assetId: d.assetId, reason: d.why })),
    compositeScreenIds: ctx.screens.filter((s) => s.composite && (s.contentAssetId || s.referenceAssetId)).map((s) => s.id),
    hasBlocking: Boolean(ctx.blocking),
    names: plan.names,
  };
  if (critical.length) {
    const why = `The continuity plan has ${critical.length} critical warning${critical.length === 1 ? '' : 's'}: ${critical.map((w) => w.message).join(' ')}`;
    await setState(p, {
      continuity,
      status: 'failed_review',
      stage: 'continuity',
      waitingOn: [],
      stageMessage: `Stopped before generating — ${why}`.slice(0, 600),
      failure: { summary: why.slice(0, 600), failed: critical.map((w) => w.message), attempted: [], strongestVersionId: null, nextAttemptUsd: null, options: ['Fix the plan in the Continuity panel (blocking, props, camera axis), then produce the shot again', 'Override the warning in the Continuity panel if the change is intended, then produce the shot again'] },
    });
    return null;
  }
  // A review of an existing take keeps its request; a generation receives the compiled continuity.
  const applied = p.reviewTakeId ? null : applyContinuityToRequest({ prompt: basePrompt, media: baseMedia }, plan);
  const parts = [
    `${continuity.constraints} protected constraint${continuity.constraints === 1 ? '' : 's'}`,
    `${plan.compiled.added.length} continuity reference${plan.compiled.added.length === 1 ? '' : 's'} added`,
    open.length ? `${open.length} warning${open.length === 1 ? '' : 's'} to watch` : 'no warnings',
    continuity.dropped.length ? `${continuity.dropped.length} reference${continuity.dropped.length === 1 ? '' : 's'} left out (image limit)` : '',
  ].filter(Boolean);
  return setState(
    p,
    { continuity, stage: 'continuity', ...(applied ? { request: { ...p.request, prompt: applied.prompt, media: applied.media } } : {}), stageMessage: `Continuity established: ${parts.join(', ')}` },
    {},
    { added: plan.compiled.added, dropped: plan.compiled.dropped, warnings: open.map((w) => w.message) },
  );
}

/** Re-plans the shot's continuity from the current approved bibles (stronger-reference regenerations). */
async function replanRequest(p: Prod, extraMedia: OmniMediaRef[] = []): Promise<{ prompt: string; media: OmniMediaRef[]; blockingLines: string[]; imageRefs: string[] }> {
  const base = baseRequest(p);
  const basePrompt = p.continuity?.basePrompt ?? String(base.prompt);
  const baseMedia = [...extraMedia, ...(p.continuity?.baseMedia ?? base.media ?? []).filter((m) => !(extraMedia.some((x) => x.role === 'first_frame') && m.role === 'first_frame'))];
  const ctx = await loadShotContinuity(p.projectId, p.shotId);
  const plan = planContinuity(ctx, baseMedia, { lockRefs: true });
  const applied = applyContinuityToRequest({ prompt: basePrompt, media: baseMedia }, plan);
  return { ...applied, blockingLines: plan.blockingLines, imageRefs: applied.media.filter((m) => m.role === 'image_ref').map((m) => m.assetId) };
}

/** Nano Banana Pro still of the corrected blocking — the first frame of the corrected shot. */
async function submitBlockingFrame(p: Prod, d: RepairDecision): Promise<string> {
  const re = await replanRequest(p);
  const base = baseRequest(p);
  const prompt = [
    `Blocking frame: the exact first frame of the film shot “${p.title}”.`,
    p.expected.description,
    p.expected.action ? `The moment just before this action begins: ${p.expected.action}` : '',
    re.blockingLines.length ? `Positions and eyelines (from the stage plan — follow exactly):\n${re.blockingLines.join('\n')}` : 'Every character is clearly separated with their face visible; nobody stands in front of anyone else; each person’s whole body occupies its own space.',
    p.expected.camera ? `Camera: ${p.expected.camera}.` : '',
    p.expected.location ? `Set: ${p.expected.location.name} — ${p.expected.location.description}; ${p.expected.location.timeOfDay}.` : '',
    `Correct this: ${d.instruction}`,
    'Match the reference images exactly for every face, costume, prop and the set. Photoreal film still with natural light; no text, captions or watermarks.',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 7800);
  const res = await createJobs(
    p.ownerUid,
    [
      {
        type: 'image.generate',
        projectId: p.projectId,
        prompt,
        purpose: 'storyboard',
        aspectRatio: base.aspectRatio ?? '16:9',
        imageSize: '2K',
        referenceAssetIds: re.imageRefs.slice(0, 13),
        sourceAssetId: null,
        chainId: null,
        parentTurnId: null,
        grounding: false,
        applyStyleBible: true,
        characterIds: base.characterIds ?? [],
        collections: ['blocking-frames'],
        title: `${p.title} — blocking frame`,
        label: `${p.title} · repair · blocking frame`,
        target: { kind: 'production', id: p.id },
      },
    ],
    { productionId: p.id, preconfirmed: true },
  );
  return res.jobIds[0]!;
}

// ---------------------------------------------------------------------------
// Stage: plan → continuity → audio_prepare → duration_calculate
// ---------------------------------------------------------------------------

/** Review of an existing take: it becomes version 1 and goes straight to inspection (and repair). */
async function adoptTake(p: Prod, takeId: string): Promise<void> {
  const snap = await col.projects().doc(p.projectId).collection('shots').doc(p.shotId).collection('takes').doc(takeId).get();
  const take = snap.data() as TakeDoc | undefined;
  if (!take?.assetId || take.status !== 'completed') {
    const why = 'The take to review no longer exists or has no video.';
    await setState(p, { status: 'failed_review', waitingOn: [], stageMessage: why, failure: { summary: why, failed: [why], attempted: [], strongestVersionId: null, nextAttemptUsd: null, options: ['Choose another take', 'Produce the shot with quality control'] } });
    return;
  }
  const requested = Number((p.request as { durationSec?: number }).durationSec ?? VIDEO_CAPABILITIES.durationSec.default);
  p = await setState(p, { plan: planFor(p, requested), stage: 'inspect' });
  // Edits and extensions continue the take's own Omni interaction, which expires with the take's age.
  const { p: next, v } = await createVersion(p, { kind: 'existing', parentVersionId: null, repair: null, jobIds: [], takeId, assetId: take.assetId, interactionId: take.interactionId, interactionAt: toMillis(take.createdAt as never) ?? 0, plannedCuts: [], label: `existing ${take.label}` });
  await submitInspection(next, v, 'inspect');
}

async function stepPlan(p: Prod): Promise<void> {
  // Establish continuity first (idempotent): nothing is generated or spent before it holds.
  if (!p.continuity) {
    const next = await establishContinuity(p);
    if (!next) return;
    p = next;
  }
  if (p.reviewTakeId) return adoptTake(p, p.reviewTakeId);
  const lines = p.dialogueAudio.lines;
  if (p.dialogueAudio.mode === 'uploaded') {
    // Measure the creator's own recordings (speech only, silence trimmed).
    const measured = [];
    for (const l of lines) {
      if (!l.assetId) {
        measured.push(l);
        continue;
      }
      const a = await col.assets().doc(l.assetId).get();
      try {
        const samples = await decodeMono(await mediaInputUrl(String(a.get('storagePath'))), 16000);
        const b = speechBounds(samples, 16000);
        measured.push({ ...l, seconds: b ? b.durationSec : null });
      } catch {
        measured.push(l);
      }
    }
    p = await setState(p, { dialogueAudio: { ...p.dialogueAudio, lines: measured }, stageMessage: `Measured ${measured.filter((l) => l.seconds !== null).length} uploaded recording(s)` });
    await stepDuration(await setState(p, { stage: 'duration_calculate', stageMessage: 'Calculating the scene duration from your recordings' }));
    return;
  }
  if (p.dialogueAudio.mode === 'generated' && lines.length) {
    const res = await createJobs(
      p.ownerUid,
      [{ type: 'speech.generate', projectId: p.projectId, lines: lines.map((l) => ({ index: l.index, character: l.character, text: l.text, voice: l.voice ?? null, direction: [p.expected.performance, p.expected.mood].filter(Boolean).join(', ').slice(0, 280) || 'Say naturally' })), languageCode: p.expected.language ?? null, label: `${p.title} · dialogue guide audio`, target: { kind: 'production', id: p.id } }],
      { productionId: p.id, preconfirmed: true },
    );
    await setState(p, { stage: 'audio_prepare', waitingOn: res.jobIds, run: { kind: 'generation', type: null, step: 'speech', baseVersionId: null, decision: null, data: {} }, stageMessage: `Speaking ${lines.length} dialogue line${lines.length === 1 ? '' : 's'} to measure their real length` });
    return;
  }
  await stepDuration(await setState(p, { stage: 'duration_calculate', stageMessage: 'Calculating the scene duration' }));
}

async function stepAudioPrepared(p: Prod, jobs: JobDoc[]): Promise<void> {
  const job = jobs[0];
  let audio = p.dialogueAudio;
  if (job?.status === 'completed') {
    const measured = ((job.result?.data as { lines?: SpokenLineResult[] } | undefined)?.lines ?? []) as SpokenLineResult[];
    audio = {
      ...audio,
      jobId: job.id,
      lines: audio.lines.map((l) => {
        const m = measured.find((x) => x.index === l.index);
        return m ? { ...l, assetId: m.assetId, seconds: m.seconds, voice: m.voice } : l;
      }),
      note: `Measured from generated guide audio (${MODEL_REGISTRY.speech.displayName}).`,
    };
  } else {
    audio = { ...audio, mode: 'estimated', jobId: job?.id ?? null, note: `Guide audio could not be generated (${job?.error?.message ?? job?.status ?? 'unknown'}); line lengths are estimated from the text.` };
  }
  await stepDuration(await setState(p, { dialogueAudio: audio, stage: 'duration_calculate', waitingOn: [], stageMessage: 'Calculating the scene duration from the measured dialogue' }));
}

export function planFor(p: Pick<Prod, 'dialogueAudio' | 'expected' | 'settings' | 'request'>, requestedSec: number): DurationPlan {
  const lines: PlanLine[] = p.dialogueAudio.lines.map((l) => ({ index: l.index, character: l.character, text: l.text, seconds: l.seconds ?? l.estimatedSec, measured: l.seconds !== null && p.dialogueAudio.mode !== 'estimated' }));
  return planSceneDuration({
    lines,
    action: p.expected.action,
    description: p.expected.description,
    requestedSec,
    openingSec: p.settings.openingAllowanceSec,
    closingSec: p.settings.closingAllowanceSec,
    ensureCompleteDialogue: p.settings.ensureCompleteDialogue,
    ensureCompleteAction: p.settings.ensureCompleteAction,
    caps: CAPS,
  });
}

async function stepDuration(p: Prod): Promise<void> {
  const requested = Number((p.request as { durationSec?: number }).durationSec ?? p.plan?.requestedSec ?? VIDEO_CAPABILITIES.durationSec.default);
  const plan = planFor(p, requested);
  if (plan.blocked) {
    await setState(p, { plan, status: 'failed_review', stage: 'duration_calculate', stageMessage: plan.blocked, failure: { summary: plan.blocked, failed: [plan.message], attempted: [], strongestVersionId: null, nextAttemptUsd: null, options: ['Edit the line so it has a natural pause, then start again', 'Split the dialogue across separate shots'] } });
    return;
  }
  if (plan.strategy === 'split_shots') {
    await setState(p, { plan, status: 'failed_review', stage: 'duration_calculate', stageMessage: plan.message, failure: { summary: plan.message, failed: [`Needs ${plan.requiredSec} s — longer than one ${CAPS.maxChainSec}-second continuous take.`], attempted: [], strongestVersionId: null, nextAttemptUsd: null, options: ['Split into shots (creates one shot per part, cut at sentence boundaries)'] } });
    return;
  }
  p = await setState(p, { plan, stageMessage: `Requested ${plan.requestedSec} s · required ${plan.requiredSec} s. ${plan.message}` }, {}, { plan: { requestedSec: plan.requestedSec, requiredSec: plan.requiredSec, plannedSec: plan.plannedSec, strategy: plan.strategy, segments: plan.segments.map((s) => s.durationSec) } });
  await startChain(p, plan, { kind: 'generation', type: null, step: 'chain', baseVersionId: null, decision: null, data: {} }, '');
}

// ---------------------------------------------------------------------------
// Stage: generate (single shot, independent takes, or connected shots joined by Omni extension)
// ---------------------------------------------------------------------------

/** Takes generated side by side: only for a first generation that fits in one part. */
function takeCount(p: Prod, plan: DurationPlan, run: ProductionRun): number {
  if (run.kind !== 'generation' || plan.segments.length !== 1) return 1;
  return Math.max(1, Math.min(p.takes ?? 1, p.settings.maxTakesPerShot));
}

async function startChain(p: Prod, plan: DurationPlan, run: ProductionRun, extra: string): Promise<void> {
  const seg = plan.segments[0]!;
  const prompt = segmentPrompt(String(baseRequest(p).prompt), plan, seg, extra);
  const takes = takeCount(p, plan, run);
  const label = run.kind === 'repair' ? `repair · ${REPAIR_LABELS[run.type!].toLowerCase()}${plan.segments.length > 1 ? ` · part 1 of ${plan.segments.length}` : ''}` : plan.segments.length > 1 ? `part 1 of ${plan.segments.length}` : 'generation';
  const jobIds = await submitVideos(p, { mode: 'generate', prompt, durationSec: seg.durationSec }, label, true, takes);
  await setState(p, {
    status: run.kind === 'repair' ? 'repairing' : 'generating',
    stage: run.kind === 'repair' ? 'repair' : 'generate',
    waitingOn: jobIds,
    chain: { segmentIndex: 0, takeIds: [], assetIds: [] },
    run: { ...run, step: 'chain', data: { ...run.data, extra, chainJobIds: jobIds, takes } },
    ...(run.kind === 'repair' ? { repairs: jobIds.reduce(withRepairJob, p.repairs) } : {}),
    stageMessage:
      takes > 1
        ? `Generating ${takes} independent takes of ${seg.durationSec} s with ${VIDEO_CAPABILITIES.displayName} — each is inspected and the strongest is recommended`
        : plan.segments.length > 1
          ? `Generating part 1 of ${plan.segments.length} (${seg.durationSec} s)`
          : `Generating ${seg.durationSec} s with ${VIDEO_CAPABILITIES.displayName}`,
  });
}

function videoOutcome(job: JobDoc): { takeId: string | null; assetId: string | null; interactionId: string | null } {
  return { takeId: job.target?.kind === 'shot' ? job.target.sub ?? null : null, assetId: job.result?.assetIds?.[0] ?? null, interactionId: job.result?.interactionId ?? null };
}

async function stepChain(p: Prod, jobs: JobDoc[]): Promise<void> {
  const run = p.run ?? { kind: 'generation' as const, type: null, step: 'chain' as const, baseVersionId: null, decision: null, data: {} };
  if (Number(run.data.takes ?? 1) > 1) return stepTakes(p, jobs, run);
  const job = jobs[0];
  if (!job || job.status !== 'completed') return onChildFailure(p, job, run);
  const plan = p.plan!;
  const out = videoOutcome(job);
  const chain = { segmentIndex: p.chain.segmentIndex, takeIds: [...p.chain.takeIds, out.takeId ?? ''], assetIds: [...p.chain.assetIds, out.assetId ?? ''] };
  const nextIndex = p.chain.segmentIndex + 1;
  if (nextIndex < plan.segments.length) {
    const seg = plan.segments[nextIndex]!;
    const prompt = segmentPrompt(String(baseRequest(p).prompt), plan, seg, String(run.data.extra ?? ''));
    const jobId = await submitVideo(p, { mode: 'extend', prompt, durationSec: seg.durationSec, parentTakeId: out.takeId }, `part ${nextIndex + 1} of ${plan.segments.length} (extension)`);
    await setState(p, { waitingOn: [jobId], chain: { ...chain, segmentIndex: nextIndex }, run: { ...run, data: { ...run.data, chainJobIds: [...((run.data.chainJobIds as string[]) ?? []), jobId] } }, ...(run.kind === 'repair' ? { repairs: withRepairJob(p.repairs, jobId) } : {}), stageMessage: `Connected shot ${nextIndex + 1} of ${plan.segments.length}: extending the take by ${seg.durationSec} s with continuous dialogue` });
    return;
  }
  if (!out.assetId) return onChildFailure(p, { ...job, status: 'failed', error: { code: 'no_output', message: 'The generation finished without a video.', retryable: false } }, run);
  let t = 0;
  const cuts: number[] = [];
  for (const s of plan.segments.slice(0, -1)) {
    t += s.durationSec;
    cuts.push(t);
  }
  const { p: next, v } = await createVersion(p, {
    kind: run.kind === 'repair' ? 'repair' : plan.segments.length > 1 ? 'extension' : 'generation',
    parentVersionId: run.baseVersionId,
    repair: run.decision,
    jobIds: (run.data.chainJobIds as string[]) ?? [job.id],
    takeId: out.takeId,
    assetId: out.assetId,
    interactionId: out.interactionId,
    plannedCuts: cuts,
    editorialCuts: editorialWindows(plan),
    label: run.kind === 'repair' ? REPAIR_LABELS[run.type!] : plan.segments.length > 1 ? `${plan.segments.length} connected shots` : 'first generation',
  });
  await submitInspection(next, v, run.kind === 'repair' ? 'reinspect' : 'inspect');
}

/** Independent takes finished: each becomes a version and is inspected; the comparison follows. */
async function stepTakes(p: Prod, jobs: JobDoc[], run: ProductionRun): Promise<void> {
  const order = (run.data.chainJobIds as string[] | undefined) ?? jobs.map((j) => j.id);
  const sorted = [...jobs].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const done = sorted.filter((j) => j.status === 'completed' && videoOutcome(j).assetId);
  if (!done.length) return onChildFailure(p, sorted.find((j) => j.status !== 'completed') ?? sorted[0], run);
  const failed = sorted.filter((j) => !done.includes(j));
  if (failed.length) await event(p, `${failed.length} of ${sorted.length} takes did not finish: ${failed.map((j) => j.error?.message ?? j.status).join('; ')}`.slice(0, 600));
  let cur = p;
  const versions: ProductionVersionDoc[] = [];
  for (const job of done) {
    const out = videoOutcome(job);
    const n = order.indexOf(job.id) + 1;
    const created = await createVersion(cur, { kind: 'generation', parentVersionId: null, repair: null, jobIds: [job.id], takeId: out.takeId, assetId: out.assetId!, interactionId: out.interactionId, plannedCuts: [], editorialCuts: editorialWindows(cur.plan!), label: `take ${n} of ${sorted.length}`, take: n });
    cur = created.p;
    versions.push(created.v);
  }
  if (versions.length === 1) {
    await submitInspection(cur, versions[0]!, 'inspect');
    return;
  }
  const jobIds: string[] = [];
  for (const v of versions) jobIds.push(await createInspectionJob(cur, v));
  await setState(cur, { status: 'inspecting', stage: 'inspect', waitingOn: jobIds, run: { kind: 'generation', type: null, step: 'compare', baseVersionId: null, decision: null, data: { versionIds: versions.map((v) => v.id) } }, stageMessage: `Inspecting ${versions.length} takes side by side (dialogue, picture, performance and continuity)` });
}

// ---------------------------------------------------------------------------
// Stage: inspect / reinspect → compare → decide
// ---------------------------------------------------------------------------

export function estimateRepairUsd(p: Pick<Prod, 'request' | 'plan' | 'continuity'>, v: Pick<ProductionVersionDoc, 'durationSec' | 'chainSec'>, d: RepairDecision): number {
  const base = p.request as unknown as VideoJobRequest;
  const res = base.resolution ?? VIDEO_CAPABILITIES.defaultResolution;
  const D = v.durationSec ?? 8;
  const screens = p.continuity?.expectations.screens.length ?? 0;
  const inspect = (secs: number) => inspectionEstimate(secs, 4, screens).usd;
  const video = (outputSeconds: number, videoInputSeconds: number, task: string, imageInputs = 0) => estimateVideo({ resolution: res, outputSeconds, promptChars: 3500, imageInputs, videoInputSeconds, task }, PRICING).usd;
  const imgs = (base.media ?? []).length;
  const regen = (secs: number) => video(secs, 0, 'generate', imgs) + inspect(secs);
  switch (d.type) {
    case 'use_other_take':
      return 0;
    case 'trim_ending':
      return inspect(d.durationSec ?? D);
    case 'reframe':
      return inspect(D);
    case 'color_match':
      return estimateLocalCompute('Colour match', PRICING).usd + estimateVision({ images: 4, features: 1 }, PRICING).usd + inspect(D);
    case 'screen_composite': {
      const n = Math.max(1, ((d.data?.screenIds as string[] | undefined) ?? []).length);
      return n * (estimateText({ modelId: MODEL_REGISTRY.reasoning.id, inputChars: 3000, expectedOutputTokens: 3000, audioSeconds: 0 }, PRICING).usd + estimateVision({ images: Math.ceil(D * 2) * 2, features: 1 }, PRICING).usd) + inspect(D);
    }
    case 'extend_scene':
      return video(d.durationSec ?? 4, v.chainSec, 'extend') + inspect(v.chainSec + (d.durationSec ?? 4));
    case 'conversational_edit':
    case 'replace_visuals_keep_audio':
      return video(D, D, 'edit') + inspect(D);
    case 'replace_background':
      return video(D, D, 'edit', 2) + inspect(D);
    case 'cutaway':
      return video(d.durationSec ?? 3, 0, 'generate', imgs) + inspect(D);
    case 'regenerate_section':
      return video((d.sectionStartSec ?? 0) + (d.durationSec ?? 4), d.sectionStartSec ?? 0, 'extend') + inspect(D);
    case 'correct_blocking': {
      const secs = d.durationSec ?? D;
      return estimateImage({ imageSize: '2K', referenceImages: Math.min(13, imgs + 4), promptChars: 2500, outputs: 1 }, PRICING).usd + video(secs, 0, 'generate', Math.min(10, imgs + 1)) + inspect(secs);
    }
    case 'split_into_shots': {
      const plan = p.plan;
      let total = 0;
      let acc = 0;
      for (const [i, s] of (plan?.segments ?? []).entries()) {
        total += i === 0 ? video(s.durationSec, 0, 'generate', imgs) : video(s.durationSec, acc, 'extend');
        acc += s.durationSec;
      }
      return total + inspect(acc || D);
    }
    default:
      return regen(d.durationSec ?? D);
  }
}

function blockingCategories(report: QualityReportDoc, waived: string[]): string[] {
  return [...new Set(report.problems.filter((x) => x.blocking && !waived.includes(x.category)).map((x) => x.category))];
}

function weakestCategory(scores: CategoryScores | null | undefined): { key: string | null; score: number | null } {
  if (!scores) return { key: null, score: null };
  let key: string | null = null;
  let score: number | null = null;
  for (const k of CATEGORY_KEYS) {
    const v = scores[k];
    if (v !== null && (score === null || v < score)) {
      score = v;
      key = CATEGORY_LABELS[k];
    }
  }
  return { key, score };
}

async function inspectionFailed(p: Prod, v: ProductionVersionDoc | null, job: JobDoc | undefined): Promise<void> {
  if (v) await ref(p.id).collection('versions').doc(v.id).set({ verdict: 'error' }, { merge: true });
  await setState(p, {
    status: 'failed_review',
    stage: p.stage,
    waitingOn: [],
    run: null,
    stageMessage: `The quality inspection could not finish: ${(job?.error?.message ?? job?.status ?? 'unknown error').replace(/[.\s]+$/, '')}. Nothing was approved.`,
    failure: { summary: 'Inspection failed — the version has not been reviewed.', failed: [job?.error?.message ?? 'Inspection error'], attempted: p.repairs.map((r) => REPAIR_LABELS[r.type]), strongestVersionId: p.bestVersionId, nextAttemptUsd: null, options: ['Re-inspect the version', ...manualOptions(v ? continuable(v) : false)] },
  });
}

async function stepInspected(p: Prod, jobs: JobDoc[]): Promise<void> {
  if (p.run?.step === 'compare' && jobs.length > 1) return stepCompare(p, jobs);
  const job = jobs[0];
  const v = await loadVersion(p, p.currentVersionId);
  if (!job || job.status !== 'completed' || !v) return inspectionFailed(p, v, job);
  const report = await loadReport(p, job.result?.reportId ?? null);
  if (!report) return;
  await decide(p, v, report);
}

/** Several takes were inspected: rank them (passing first, then score, then the weakest category). */
async function stepCompare(p: Prod, jobs: JobDoc[]): Promise<void> {
  const ids = (p.run?.data.versionIds as string[] | undefined) ?? [];
  const versions = (await loadVersions(p)).filter((v) => ids.includes(v.id));
  const reports = new Map<string, QualityReportDoc>();
  for (const v of versions) {
    const r = await loadReport(p, v.reportId);
    if (r) reports.set(v.id, r);
  }
  const inspected = versions.filter((v) => reports.has(v.id));
  if (!inspected.length) return inspectionFailed(p, versions[0] ?? null, jobs.find((j) => j.status !== 'completed') ?? jobs[0]);
  const ranked = rankTakes(inspected.map((v) => ({ ...v, passed: reports.get(v.id)!.passed, overall: reports.get(v.id)!.overall, categoryScores: reports.get(v.id)!.categoryScores ?? null })));
  const best = ranked[0]!;
  const bestReport = reports.get(best.id)!;
  const comparison: TakeComparison = {
    at: Date.now(),
    ranked: ranked.map((v) => {
      const w = weakestCategory(v.categoryScores);
      return { versionId: v.id, index: v.index, take: v.take ?? v.index, passed: v.passed, overall: v.overall, weakest: w.key, weakestScore: w.score };
    }),
    recommendedVersionId: best.id,
    reason: bestReport.passed
      ? `Take ${best.take ?? best.index} passes review with the highest score (${bestReport.overall}/100)${ranked.length > 1 ? `; next best ${ranked[1]!.overall ?? '—'}/100` : ''}.`
      : `No take passes review; take ${best.take ?? best.index} is the strongest (${bestReport.overall}/100) and is repaired first.`,
  };
  const failedInspections = jobs.filter((j) => j.status !== 'completed').length;
  const next = await setState(p, { stage: 'compare', comparison, currentVersionId: best.id, bestVersionId: best.id, run: null, waitingOn: [], stageMessage: `Compared ${inspected.length} takes: ${comparison.reason}${failedInspections ? ` (${failedInspections} inspection${failedInspections === 1 ? '' : 's'} failed)` : ''}` }, {}, { comparison });
  await decide(next, best, bestReport);
}

/** After an inspection: settle the last repair, then pass to the director or choose the next repair. */
async function decide(p: Prod, v: ProductionVersionDoc, report: QualityReportDoc): Promise<void> {
  const versions = await loadVersions(p);
  const best = strongestVersion(versions.map((x) => (x.id === v.id ? { ...x, overall: report.overall } : x)));
  const last = p.repairs[p.repairs.length - 1];
  const repairs = p.repairs.map((r, i) => (i === p.repairs.length - 1 && r.outcome === 'pending' ? { ...r, outcome: (report.passed ? 'fixed' : 'not_fixed') as RepairRecord['outcome'] } : r));
  if (last && last.outcome === 'pending') {
    await updateAttempt(p.projectId, last.attemptId, { outcome: report.passed ? 'fixed' : 'not_fixed', resultVersionId: v.id, resultAssetId: v.assetId, resultOverall: report.overall, jobIds: last.jobIds, costUsd: await jobsCost([...last.jobIds, report.jobId]) });
  }
  if (report.passed) {
    await setState(p, { status: 'awaiting_review', stage: 'approve', waitingOn: [], repairs, bestVersionId: best?.id ?? v.id, pendingRepair: null, failure: null, stageMessage: `Version ${v.index} passed quality review (${report.overall}/100) — awaiting the director’s approval` }, { overall: report.overall, passed: true });
    return;
  }
  const ctx: RepairContext = {
    alternatives: versions.filter((x) => x.id !== v.id && x.verdict === 'passed' && x.takeId).map((x) => ({ versionId: x.id, index: x.index, overall: x.overall, passed: true, label: `Version ${x.index}${x.take ? ` (take ${x.take})` : ''}` })),
    compositableScreens: p.continuity?.compositeScreenIds ?? [],
    regions: report.problems.filter((x) => x.region).map((x) => ({ problemId: x.id, box: x.region! })),
    problems: report.problems,
    dialogue: report.dialogue,
    review: report.review,
    version: { durationSec: v.durationSec ?? report.measurements.durationSec, continuable: continuable(v), chainSec: v.chainSec },
    expected: { lines: p.expected.lines, action: p.expected.action },
    plan: p.plan,
    caps: CAPS,
    previous: repairs.map((r) => ({ type: r.type, categories: r.categories as never })),
  };
  const decision = chooseRepair(ctx);
  const estimate = decision ? Math.round(estimateRepairUsd(p, v, decision) * 100) / 100 : null;
  const spent = await productionSpend(p.id);
  const next = decideAfterInspection({ passed: false, settings: p.settings, repairCount: p.repairCount, spentUsd: spent, repair: decision, repairEstimateUsd: estimate });
  const categories = blockingCategories(report, p.waivedCategories);
  const base = { waitingOn: [], repairs, bestVersionId: best?.id ?? v.id, spentUsd: spent };
  if (next.action === 'repair' && decision) {
    await startRepair({ ...p, ...base }, v, decision, estimate ?? 0, categories, false);
    return;
  }
  if (next.action === 'await_repair_approval' && decision) {
    await setState(p, { ...base, status: 'awaiting_review', stage: 'repair', pendingRepair: { ...decision, estimateUsd: estimate ?? 0, waitingFor: next.waitingFor, forVersionId: v.id, categories }, stageMessage: `${next.message} Proposed: ${REPAIR_LABELS[decision.type]}.` }, { overall: report.overall, passed: false });
    return;
  }
  await setState(
    p,
    {
      ...base,
      status: 'failed_review',
      stage: v.index > 1 ? 'reinspect' : 'inspect',
      pendingRepair: decision ? { ...decision, estimateUsd: estimate ?? 0, waitingFor: 'director', forVersionId: v.id, categories } : null,
      failure: {
        summary: next.message,
        failed: report.reasons,
        attempted: repairs.map((r) => `${REPAIR_LABELS[r.type]} — ${r.outcome === 'fixed' ? 'fixed' : r.outcome === 'failed' ? 'failed to run' : 'did not fix it'}`),
        strongestVersionId: best?.id ?? v.id,
        nextAttemptUsd: estimate,
        options: manualOptions(continuable(v)),
      },
      stageMessage: `Failed quality review (${report.overall}/100): ${next.message}`,
    },
    { overall: report.overall, passed: false },
  );
}

// ---------------------------------------------------------------------------
// Stage: repair
// ---------------------------------------------------------------------------

export async function startRepair(p: Prod, v: ProductionVersionDoc, d: RepairDecision, estimateUsd: number, categories: string[], directorRequested: boolean): Promise<void> {
  const record: RepairRecord = { versionId: v.id, type: d.type, reason: d.reason, categories, jobIds: [] as string[], estimateUsd, at: Date.now(), outcome: 'pending', attemptId: null };
  const run: ProductionRun = { kind: 'repair', type: d.type, step: 'video', baseVersionId: v.id, decision: d, data: {} };
  const common = { status: 'repairing' as const, stage: 'repair' as const, repairCount: p.repairCount + 1, pendingRepair: null, failure: null };
  const msg = `${directorRequested ? 'Director requested' : 'Automatic repair'} ${p.repairCount + 1}: ${REPAIR_LABELS[d.type]} — ${d.reason}`;
  const base = String(baseRequest(p).prompt);
  const secsFor = (x?: number | null) => Math.min(CAPS.maxSec, Math.max(CAPS.minSec, x ?? Math.ceil(v.durationSec ?? 8)));
  let jobId: string;
  switch (d.type) {
    case 'use_other_take': {
      // No generation: switch to a take that already passes review (the current version is kept).
      const alt = await loadVersion(p, String(d.data?.versionId ?? ''));
      const report = alt ? await loadReport(p, alt.reportId) : null;
      if (!alt || !report) throw new HttpsError('failed-precondition', 'That take is no longer available.');
      const attemptId = await recordAttempt(p, v, d, 0, categories, directorRequested);
      const outcome: RepairRecord['outcome'] = report.passed ? 'fixed' : 'not_fixed';
      await updateAttempt(p.projectId, attemptId, { outcome, resultVersionId: alt.id, resultAssetId: alt.assetId, resultOverall: report.overall, costUsd: 0 });
      await setState(p, {
        ...common,
        status: report.passed ? 'awaiting_review' : 'failed_review',
        stage: report.passed ? 'approve' : 'repair',
        waitingOn: [],
        run: null,
        currentVersionId: alt.id,
        bestVersionId: alt.id,
        repairs: [...p.repairs, { ...record, attemptId, outcome }],
        stageMessage: report.passed ? `${msg}. Version ${alt.index} (${report.overall}/100) is ready for the director’s approval.` : `${msg}. Version ${alt.index} does not pass either (${report.overall}/100).`,
        ...(report.passed ? {} : { failure: { summary: 'The alternative take does not pass review.', failed: report.reasons, attempted: [...p.repairs, record].map((r) => REPAIR_LABELS[r.type]), strongestVersionId: alt.id, nextAttemptUsd: null, options: manualOptions(continuable(alt)) } }),
      }, { overall: report.overall, passed: report.passed });
      return;
    }
    case 'extend_scene':
      if (!continuable(v)) throw new HttpsError('failed-precondition', 'This version can no longer be extended (its Omni interaction expired or the take is already at the 40-second limit).');
      jobId = await submitVideo(p, { mode: 'extend', prompt: d.instruction, durationSec: d.durationSec ?? 4, parentTakeId: v.takeId }, `repair · extend ${d.durationSec ?? 4} s`);
      break;
    case 'conversational_edit':
      if (!continuable(v)) throw new HttpsError('failed-precondition', 'This version cannot be edited conversationally (no live Omni interaction).');
      jobId = await submitVideo(p, { mode: 'edit', prompt: d.instruction, parentTakeId: v.takeId }, 'repair · conversational edit');
      break;
    case 'replace_background': {
      // Keep the performance: edit the take with the canonical set views as references.
      const setRefs = (p.continuity?.refs ?? []).filter((r) => r.kind === 'set').slice(0, 2);
      const media: OmniMediaRef[] = setRefs.map((r) => ({ role: 'image_ref', assetId: r.assetId, label: 'the canonical set' }));
      const tags = media.map((_, i) => `<IMAGE_REF_${i}>`).join(' ');
      const prompt = `${d.instruction}${media.length ? ` The background must match the set shown in ${tags} exactly.` : ''}`;
      if (continuable(v)) jobId = await submitVideo(p, { mode: 'edit', prompt, parentTakeId: v.takeId, media }, 'repair · replace background');
      else {
        if ((v.durationSec ?? 0) > VIDEO_CAPABILITIES.maxEditInputSeconds + 0.05) throw new HttpsError('failed-precondition', `The background can only be replaced on takes of up to ${VIDEO_CAPABILITIES.maxEditInputSeconds} seconds once the Omni interaction has expired.`);
        jobId = await submitVideo(p, { mode: 'edit', prompt, media: [{ role: 'source_video', assetId: v.assetId!, label: 'the take' }, ...media] }, 'repair · replace background');
      }
      break;
    }
    case 'trim_ending':
      jobId = await submitComposite(p, { op: 'trim', sourceAssetId: v.assetId!, keepUntilSec: d.durationSec ?? d.sectionStartSec ?? v.durationSec ?? 0, shotId: p.shotId, parentTakeId: v.takeId, takeLabel: 'trimmed ending', title: `${p.title} — trimmed` }, 'repair · trim ending');
      run.step = 'composite';
      break;
    case 'reframe': {
      const crop = d.data?.crop as { x: number; y: number; w: number; h: number } | undefined;
      if (!crop) throw new HttpsError('failed-precondition', 'The reframe has no crop.');
      jobId = await submitComposite(p, { op: 'reframe', sourceAssetId: v.assetId!, crop, shotId: p.shotId, parentTakeId: v.takeId, takeLabel: 'reframed', title: `${p.title} — reframed` }, 'repair · reframe');
      run.step = 'composite';
      break;
    }
    case 'color_match': {
      const refId = p.continuity?.colourRefAssetId;
      if (!refId) throw new HttpsError('failed-precondition', 'No colour reference is available for this shot (approve the previous shot of the scene first).');
      const prepared = await prepareColorMatch(p.ownerUid, { type: 'media.color_match', projectId: p.projectId, sourceAssetId: v.assetId!, referenceAssetId: refId, strength: 0.8, applyLut: false, shotId: p.shotId, label: `${p.title} · repair · colour match` });
      jobId = await createInternalJob(p.ownerUid, { type: 'media.color_match', projectId: p.projectId, modelId: null, label: prepared.label, params: { ...prepared.params, parentTakeId: v.takeId, takeLabel: 'colour-matched' }, estimate: prepared.estimate, target: { kind: 'production', id: p.id }, productionId: p.id });
      run.step = 'composite';
      break;
    }
    case 'screen_composite': {
      const screenIds = ((d.data?.screenIds as string[] | undefined) ?? p.continuity?.compositeScreenIds ?? []).filter(Boolean);
      if (!screenIds.length) throw new HttpsError('failed-precondition', 'No protected screen with approved content is set for this shot.');
      jobId = await submitScreenReplace(p, v.assetId!, screenIds[0]!, v.takeId);
      run.step = 'composite';
      run.data = { screenIds: screenIds.slice(1) };
      break;
    }
    case 'cutaway':
    case 'replace_visuals_keep_audio': {
      const refs = (baseRequest(p).media ?? []).filter((m) => m.role === 'image_ref');
      const prompt = [d.instruction, `Setting: ${p.expected.location ? `${p.expected.location.name} — ${p.expected.location.description}` : p.expected.description}.`, p.expected.style ? `Visual style: ${p.expected.style}.` : '', 'Single continuous shot. No dialogue, no lip movement toward camera, no on-screen text.'].filter(Boolean).join(' ');
      jobId = await submitVideo(p, { mode: 'generate', prompt, durationSec: d.durationSec ?? 3, media: refs }, 'repair · cutaway insert', false);
      run.step = 'insert';
      break;
    }
    case 'regenerate_section': {
      const start = d.sectionStartSec ?? 0;
      if (start > VIDEO_CAPABILITIES.maxEditInputSeconds || start < CAPS.minSec - 0.5) {
        const alt: RepairDecision = { ...d, type: 'regenerate_longer', reason: `${d.reason} (the section starts too late to regenerate on its own, so the scene is regenerated)`, durationSec: secsFor(null) };
        return startRepair(p, v, alt, estimateRepairUsd(p, v, alt), categories, directorRequested);
      }
      jobId = await submitComposite(p, { op: 'trim', sourceAssetId: v.assetId!, keepUntilSec: start, shotId: null, parentTakeId: v.takeId, takeLabel: 'kept section', title: `${p.title} — kept section` }, 'repair · keep good section');
      run.step = 'trim';
      break;
    }
    case 'split_into_shots': {
      // Re-plan from the measured lines: connected shots joined by Omni extension (or one longer shot if it fits).
      const replanned = planSceneDuration({ ...planInputs(p), requestedSec: CAPS.minSec });
      const plan = { ...replanned, requestedSec: p.plan?.requestedSec ?? replanned.requestedSec };
      if (plan.strategy === 'split_shots' || plan.blocked) throw new HttpsError('failed-precondition', plan.blocked ?? 'This scene is too long for one continuous take — use “Split into shots” to create separate shots.');
      const attemptId = await recordAttempt(p, v, d, estimateUsd, categories, directorRequested);
      const repairs = [...p.repairs, { ...record, attemptId }];
      await ref(p.id).set({ plan, repairCount: common.repairCount, repairs }, { merge: true });
      await startChain({ ...p, plan, repairCount: common.repairCount, repairs }, plan, { ...run, step: 'chain' }, d.instruction);
      return;
    }
    case 'correct_blocking':
      // A blocking frame from the stage plan first; the shot is then regenerated from it.
      jobId = await submitBlockingFrame(p, d);
      run.step = 'blocking_frame';
      break;
    case 'correct_direction':
    case 'regenerate_with_references': {
      // Fresh continuity from the current approved bibles (any newly approved references are used).
      const secs = secsFor(d.durationSec);
      const re = await replanRequest(p);
      const { plan, seg } = singlePlan(p, secs);
      const prompt = segmentPrompt(re.prompt, plan, seg, `Director's note for this regeneration: ${d.instruction}`);
      jobId = await submitVideo(p, { mode: 'generate', prompt, durationSec: secs, media: re.media }, `repair · ${REPAIR_LABELS[d.type].toLowerCase()} ${secs} s`);
      break;
    }
    default: {
      // Regenerate as one shot of the chosen length with the full dialogue and firmer direction.
      const secs = secsFor(d.durationSec);
      const { plan, seg } = singlePlan(p, secs);
      const prompt = segmentPrompt(base, plan, seg, `Director's note for this regeneration: ${d.instruction}`);
      jobId = await submitVideo(p, { mode: 'generate', prompt, durationSec: secs }, `repair · regenerate ${secs} s`);
    }
  }
  record.jobIds.push(jobId);
  record.attemptId = await recordAttempt(p, v, d, estimateUsd, categories, directorRequested);
  await updateAttempt(p.projectId, record.attemptId, { jobIds: record.jobIds });
  await setState(p, { ...common, waitingOn: [jobId], repairs: [...p.repairs, record], run, stageMessage: msg }, {}, { repair: d.type, estimateUsd, jobId });
}

async function submitScreenReplace(p: Prod, sourceAssetId: string, screenId: string, parentTakeId: string | null): Promise<string> {
  const prepared = await prepareScreenReplace(p.ownerUid, { type: 'media.screen_replace', projectId: p.projectId, sourceAssetId, screenId, shotId: p.shotId, label: `${p.title} · repair · screen composite` });
  return createInternalJob(p.ownerUid, { type: 'media.screen_replace', projectId: p.projectId, modelId: prepared.modelId, label: prepared.label, params: { ...prepared.params, parentTakeId, takeLabel: 'screen composited' }, estimate: prepared.estimate, target: { kind: 'production', id: p.id }, productionId: p.id });
}

function planInputs(p: Prod) {
  const lines = p.dialogueAudio.lines.map((l) => ({ index: l.index, character: l.character, text: l.text, seconds: l.seconds ?? l.estimatedSec, measured: l.seconds !== null }));
  return { lines, action: p.expected.action, description: p.expected.description, openingSec: p.settings.openingAllowanceSec, closingSec: p.settings.closingAllowanceSec, ensureCompleteDialogue: true, ensureCompleteAction: p.settings.ensureCompleteAction, caps: CAPS };
}

async function stepRepair(p: Prod, jobs: JobDoc[]): Promise<void> {
  const run = p.run;
  if (!run) return;
  if (run.step === 'chain') return stepChain(p, jobs);
  const job = jobs[0];
  if (!job || job.status !== 'completed') return onChildFailure(p, job, run);
  const base = await loadVersion(p, run.baseVersionId);
  if (!base) return;
  const d = run.decision!;
  if (run.step === 'blocking_frame') {
    const frameId = job.result?.assetIds?.[0];
    if (!frameId) return onChildFailure(p, { ...job, status: 'failed', error: { code: 'no_output', message: 'The blocking frame was not generated.', retryable: false } }, run);
    const secs = Math.min(CAPS.maxSec, Math.max(CAPS.minSec, d.durationSec ?? Math.ceil(base.durationSec ?? 8)));
    const re = await replanRequest(p, [{ role: 'first_frame', assetId: frameId, label: 'blocking frame' }]);
    const { plan, seg } = singlePlan(p, secs);
    const prompt = segmentPrompt(re.prompt, plan, seg, `The first frame shows the corrected blocking: keep every position, eyeline and depth order from it. ${d.instruction}`);
    const jobId = await submitVideo(p, { mode: 'generate', prompt, durationSec: secs, media: re.media }, `repair · regenerate from blocking frame ${secs} s`);
    await setState(p, { waitingOn: [jobId], repairs: withRepairJob(p.repairs, jobId), run: { ...run, step: 'video', data: { ...run.data, frameAssetId: frameId, frameJobId: job.id } }, stageMessage: 'Blocking frame ready — regenerating the shot from it' }, {}, { frameAssetId: frameId });
    return;
  }
  if (run.step === 'insert') {
    const insertAssetId = job.result?.assetIds?.[0];
    if (!insertAssetId) return onChildFailure(p, { ...job, status: 'failed', error: { code: 'no_output', message: 'The cutaway generation returned no video.', retryable: false } }, run);
    const jobId = await submitComposite(p, { op: 'cutaway', sourceAssetId: base.assetId!, insertAssetId, sectionStartSec: d.sectionStartSec ?? 0, sectionEndSec: d.sectionEndSec ?? base.durationSec ?? 0, shotId: p.shotId, parentTakeId: base.takeId, takeLabel: 'cutaway repair', title: `${p.title} — cutaway repair` }, 'repair · cutaway edit');
    await setState(p, { waitingOn: [jobId], repairs: withRepairJob(p.repairs, jobId), run: { ...run, step: 'composite', data: { ...run.data, insertAssetId, insertJobId: job.id } }, stageMessage: 'Cutting the insert in over the original dialogue' });
    return;
  }
  if (run.step === 'trim') {
    const trimmedAssetId = job.result?.assetIds?.[0];
    if (!trimmedAssetId) return onChildFailure(p, { ...job, status: 'failed', error: { code: 'no_output', message: 'The trim produced no video.', retryable: false } }, run);
    const jobId = await submitVideo(p, { mode: 'extend', prompt: d.instruction, durationSec: d.durationSec ?? 4, media: [{ role: 'source_video', assetId: trimmedAssetId, label: 'kept section' }] }, `repair · regenerate the last ${d.durationSec ?? 4} s`);
    await setState(p, { waitingOn: [jobId], repairs: withRepairJob(p.repairs, jobId), run: { ...run, step: 'extend_upload', data: { ...run.data, trimmedAssetId } }, stageMessage: 'Regenerating only the failed section from the kept part' });
    return;
  }
  const out = run.step === 'composite' ? { takeId: ((job.result?.data as { takeId?: string } | undefined)?.takeId ?? null) as string | null, assetId: job.result?.assetIds?.[0] ?? null, interactionId: null } : videoOutcome(job);
  if (!out.assetId) return onChildFailure(p, { ...job, status: 'failed', error: { code: 'no_output', message: 'The repair produced no video.', retryable: false } }, run);
  // Several protected screens: composite the next one onto the result.
  const remaining = ((run.data.screenIds as string[] | undefined) ?? []).filter(Boolean);
  if (d.type === 'screen_composite' && remaining.length) {
    const jobId = await submitScreenReplace(p, out.assetId, remaining[0]!, out.takeId);
    await setState(p, { waitingOn: [jobId], repairs: withRepairJob(p.repairs, jobId), run: { ...run, data: { ...run.data, screenIds: remaining.slice(1) } }, stageMessage: `Compositing the next protected screen (${remaining.length} left)` });
    return;
  }
  // Intentional edit points carried into the repaired version (so they are not flagged as accidental cuts).
  const keepsPicture = ['conversational_edit', 'extend_scene', 'color_match', 'reframe', 'screen_composite', 'replace_background'].includes(d.type);
  let cuts: number[] = [];
  if (keepsPicture) cuts = [...base.plannedCuts];
  else if (d.type === 'trim_ending') cuts = base.plannedCuts.filter((c) => c < (d.durationSec ?? d.sectionStartSec ?? Infinity) - 0.1);
  else if (d.type === 'cutaway' || d.type === 'replace_visuals_keep_audio') cuts = [...base.plannedCuts, d.sectionStartSec ?? 0, d.sectionEndSec ?? 0];
  // Directed reaction/reverse-angle cuts survive edits, extensions and cutaways; a trim keeps those before the new end.
  const keepUntil = d.type === 'trim_ending' ? (d.durationSec ?? d.sectionStartSec ?? Infinity) : Infinity;
  const windows = keepsPicture || ['trim_ending', 'cutaway', 'replace_visuals_keep_audio'].includes(d.type) ? (base.editorialCuts ?? []).filter((w) => w.startSec < keepUntil - 0.1).map((w) => ({ ...w, endSec: Math.min(w.endSec, keepUntil) })) : [];
  const jobIds = [...(run.data.insertJobId ? [String(run.data.insertJobId)] : []), ...(run.data.frameJobId ? [String(run.data.frameJobId)] : []), job.id];
  // FFmpeg outputs (colour, reframe, composite) are new files with no Omni interaction: later edits re-upload them.
  const { p: next, v } = await createVersion(p, { kind: 'repair', parentVersionId: base.id, repair: d, jobIds, takeId: out.takeId, assetId: out.assetId, interactionId: out.interactionId, plannedCuts: [...new Set(cuts)].filter((c) => c > 0).sort((a, b) => a - b), editorialCuts: windows, label: REPAIR_LABELS[d.type] });
  await submitInspection(next, v, 'reinspect');
}

/** A child job failed: never approve; try the next repair when one applies, otherwise fail visibly. */
async function onChildFailure(p: Prod, job: JobDoc | undefined, run: ProductionRun): Promise<void> {
  const err = job?.error;
  const why = err?.message ?? (job ? `The job ended as ${job.status}.` : 'The job disappeared.');
  const last = p.repairs[p.repairs.length - 1];
  const repairs = p.repairs.map((r, i) => (i === p.repairs.length - 1 && r.outcome === 'pending' ? { ...r, outcome: 'failed' as const } : r));
  if (last && last.outcome === 'pending') await updateAttempt(p.projectId, last.attemptId, { outcome: 'failed', costUsd: await jobsCost(last.jobIds), error: why.slice(0, 500) });
  if (err?.safety || job?.status === 'cancelled' || run.kind === 'generation') {
    const strongest = p.bestVersionId;
    await setState(p, {
      status: 'failed_review',
      waitingOn: [],
      run: null,
      repairs,
      stageMessage: err?.safety ? `Google’s safety filters rejected the ${run.kind === 'repair' ? 'repair' : 'generation'}. Adjust the direction and try again.` : `${run.kind === 'repair' ? 'The repair' : 'Generation'} failed: ${why}`,
      failure: { summary: why, failed: [why], attempted: repairs.map((r) => `${REPAIR_LABELS[r.type]} — ${r.outcome}`), strongestVersionId: strongest, nextAttemptUsd: null, options: ['Regenerate with new direction', 'Edit the shot and start again'] },
    });
    return;
  }
  // A repair job failed to run: treat it as a failed attempt and let the loop pick the next repair.
  const base = await loadVersion(p, run.baseVersionId);
  const report = base ? await loadReport(p, base.reportId) : null;
  if (!base || !report) {
    await setState(p, { status: 'failed_review', waitingOn: [], run: null, repairs, stageMessage: `The repair failed: ${why}`, failure: { summary: why, failed: [why], attempted: repairs.map((r) => REPAIR_LABELS[r.type]), strongestVersionId: p.bestVersionId, nextAttemptUsd: null, options: manualOptions(false) } });
    return;
  }
  await event(p, `Repair “${REPAIR_LABELS[run.type!]}” could not run: ${why}`);
  await decide({ ...p, repairs, currentVersionId: base.id, run: null }, base, report);
}

// ---------------------------------------------------------------------------
// Entry point (Cloud Tasks)
// ---------------------------------------------------------------------------

export async function advanceProduction(productionId: string): Promise<void> {
  const p = await claim(productionId);
  if (p === 'locked') {
    // Another worker is mid-step; look again shortly so this completion is never lost.
    await enqueueProduction(productionId, { delaySec: 30 });
    return;
  }
  if (!p) return;
  try {
    if (!ACTIVE_PRODUCTION_STATUSES.includes(p.status)) return;
    const jobs = await loadJobs(p.waitingOn ?? []);
    if (jobs.length < (p.waitingOn ?? []).length) logger.warn('production waiting on missing jobs', { productionId, waitingOn: p.waitingOn });
    if (jobs.some((j) => !isTerminal(j.status))) return;
    switch (p.stage) {
      case 'plan':
      case 'continuity':
        await stepPlan(p);
        break;
      case 'audio_prepare':
        await stepAudioPrepared(p, jobs);
        break;
      case 'duration_calculate':
        await stepDuration(p);
        break;
      case 'generate':
        await stepChain(p, jobs);
        break;
      case 'inspect':
      case 'reinspect':
      case 'compare':
        await stepInspected(p, jobs);
        break;
      case 'repair':
        await stepRepair(p, jobs);
        break;
      default:
        break;
    }
  } catch (e) {
    const err = e instanceof HttpsError ? { code: e.code, message: e.message, retryable: false } : toJobError(e);
    logger.error('production step failed', { productionId, stage: p.stage, error: String((e as Error)?.stack ?? e) });
    if (err.retryable) {
      await release(productionId);
      await enqueueProduction(productionId, { delaySec: 60 });
      return;
    }
    const limit = /limit|budget/i.test(err.message) && e instanceof HttpsError && e.code === 'resource-exhausted';
    await setState(p, {
      status: 'failed_review',
      waitingOn: [],
      stageMessage: limit ? `Paused — ${err.message}` : `Production stopped: ${err.message}`,
      failure: { summary: err.message, failed: [err.message], attempted: p.repairs.map((r) => REPAIR_LABELS[r.type]), strongestVersionId: p.bestVersionId, nextAttemptUsd: null, options: limit ? ['Raise the spending limit or the project budget in Settings, then choose Repair or Regenerate'] : manualOptions(false) },
    });
  } finally {
    await release(productionId).catch(() => undefined);
  }
}

/** Director-requested re-inspection of a version (e.g. after changing the approval threshold). */
export async function reinspectVersion(productionId: string, versionId: string): Promise<void> {
  const p = await loadProduction(productionId);
  const v = p ? await loadVersion(p, versionId) : null;
  if (!p || !v || !v.assetId) throw new HttpsError('not-found', 'Version not found.');
  await submitInspection({ ...p, currentVersionId: v.id, run: null }, v, 'reinspect');
  await ref(p.id).set({ currentVersionId: v.id, run: null }, { merge: true });
}

/** The director picks a version (e.g. from the take comparison): it becomes current; approval still needs review. */
export async function chooseVersion(productionId: string, versionId: string): Promise<{ status: ProductionStatus; passed: boolean | null }> {
  const p = await loadProduction(productionId);
  const v = p ? await loadVersion(p, versionId) : null;
  if (!p || !v) throw new HttpsError('not-found', 'Version not found.');
  const report = await loadReport(p, v.reportId);
  const verdict = report ? reevaluate(report, p, p.waivedCategories, v.plannedCuts, v.editorialCuts ?? []) : null;
  const status: ProductionStatus = verdict?.passed ? 'awaiting_review' : 'failed_review';
  await setState(p, { currentVersionId: v.id, status, stage: verdict?.passed ? 'approve' : p.stage, pendingRepair: null, ...(verdict?.passed ? { failure: null } : {}), stageMessage: `Director chose version ${v.index}${v.take ? ` (take ${v.take})` : ''}${verdict ? ` — ${verdict.overall}/100, ${verdict.passed ? 'passes review' : 'does not pass review yet'}` : ' — not inspected yet'}` }, { overall: verdict?.overall ?? null, passed: verdict?.passed ?? null });
  return { status, passed: verdict?.passed ?? null };
}

// ---------------------------------------------------------------------------
// Verdict re-evaluation (director waivers)
// ---------------------------------------------------------------------------

export function reevaluate(report: QualityReportDoc, p: Pick<Prod, 'settings' | 'expected' | 'continuity'>, waived: string[], plannedCuts: number[], editorialCuts: EditorialWindow[] = []) {
  return evaluateQuality({ expect: p.continuity?.expectations ?? null, dialogue: report.dialogue, review: report.review, measurements: report.measurements, settings: p.settings, plannedCuts, editorialCuts, hasCharacters: p.expected.characters.length > 0, waivedCategories: waived });
}

/** Initial estimate for a production: guide audio + planned generation(s) × takes + inspections (a review: the inspection only). */
export function productionEstimate(p: Pick<Prod, 'dialogueAudio' | 'request' | 'plan'>, plan: DurationPlan, opts: { reviewSec?: number; takes?: number; references?: number; screens?: number } = {}) {
  const refs = opts.references ?? 3;
  if (opts.reviewSec !== undefined) return sumEstimates([inspectionEstimate(opts.reviewSec, refs, opts.screens ?? 0)], PRICING);
  const base = p.request as unknown as VideoJobRequest;
  const res = base.resolution ?? VIDEO_CAPABILITIES.defaultResolution;
  const takes = plan.segments.length === 1 ? Math.max(1, opts.takes ?? 1) : 1;
  const parts = [];
  if (p.dialogueAudio.mode === 'generated' && p.dialogueAudio.lines.length) {
    const chars = p.dialogueAudio.lines.reduce((s, l) => s + l.text.length, 0);
    const secs = p.dialogueAudio.lines.reduce((s, l) => s + estimateSpeechSeconds(l.text) + 0.6, 0);
    parts.push(estimateSpeech({ chars, seconds: secs, lines: p.dialogueAudio.lines.length }, PRICING));
  }
  let acc = 0;
  for (const [i, s] of plan.segments.entries()) {
    const one = estimateVideo({ resolution: res, outputSeconds: s.durationSec, promptChars: String(base.prompt).length + 2500, imageInputs: i === 0 ? Math.max((base.media ?? []).length, refs) : 0, videoInputSeconds: acc, task: i === 0 ? 'generate' : 'extend' }, PRICING);
    for (let k = 0; k < (i === 0 ? takes : 1); k++) parts.push(one);
    acc += s.durationSec;
  }
  for (let k = 0; k < takes; k++) parts.push(inspectionEstimate(acc || plan.plannedSec, refs, opts.screens ?? 0));
  const total = sumEstimates(parts, PRICING);
  if (takes > 1) total.notes.push(`${takes} independent takes are generated and inspected; the strongest is recommended for approval.`);
  return total;
}
