import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_PRODUCTION_STATUSES,
  apiRequestSchema,
  compileShotPrompt,
  isTerminal,
  jobRequestSchema,
  sumEstimates,
  toMillis,
  type ApiRequest,
  type AssetDoc,
  type JobDoc,
  type ProductionDoc,
  type ProductionVersionDoc,
  type QualityReportDoc,
  type ShotDirections,
  type VideoJobRequest,
} from '@az-studio/shared';
import { PRICING } from '../../functions/src/config/pricing';
import { bucket, col, FieldValue } from '../../functions/src/lib/firebase';
import { createJobs, prepareAll } from '../../functions/src/lib/submit';
import { productionSpend } from '../../functions/src/lib/production';
import * as actions from '../../functions/src/api/actions';
import * as productionApi from '../../functions/src/api/production';
import type { Owner } from '../../functions/src/lib/owner';

export const RESULTS_DIR = path.join(import.meta.dirname, '.results');
mkdirSync(RESULTS_DIR, { recursive: true });
/** One id per run keeps reruns apart in the studio (e.g. 20260924T1805). */
export const RUN = process.env.AZS_ACCEPTANCE_RUN ?? new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
export const FIXTURES = path.join(import.meta.dirname, 'fixtures');

export function reporter(name: string) {
  const logFile = path.join(RESULTS_DIR, `${name}.log`);
  const log = (msg: string) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    appendFileSync(logFile, `${line}\n`);
    console.log(`${name} ${line}`);
  };
  const save = (data: unknown) => writeFileSync(path.join(RESULTS_DIR, `${name}.json`), JSON.stringify(data, null, 2));
  return { log, save };
}
export type Log = ReturnType<typeof reporter>['log'];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The single studio owner (AZ Studio is a private, single-owner portal). */
export async function studioOwner(): Promise<Owner> {
  const snap = await col.users().limit(2).get();
  if (snap.size !== 1) throw new Error(`Expected exactly one studio owner, found ${snap.size}.`);
  const d = snap.docs[0]!;
  return { uid: d.id, email: String(d.get('email') ?? '').toLowerCase() };
}

type Payload<A extends ApiRequest['action']> = Extract<ApiRequest, { action: A }>['payload'];
/** Validates a payload exactly like the callable API does (zod defaults applied). */
export function payload<A extends ApiRequest['action']>(action: A, p: unknown): Payload<A> {
  return (apiRequestSchema.parse({ action, payload: p }) as Extract<ApiRequest, { action: A }>).payload as unknown as Payload<A>;
}

// ---------------------------------------------------------------------------
// Studio fixtures
// ---------------------------------------------------------------------------

export async function qaProject(owner: Owner, key: string, title: string, type: 'film' | 'music_video', extra: Record<string, unknown> = {}): Promise<string> {
  const id = `qa-${key}-${RUN}`;
  await col.projects().doc(id).set({ ownerUid: owner.uid, title: `QA · ${title} (${RUN})`, type, status: 'active', format: { aspectRatio: '16:9', fps: 24 }, ...extra, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return id;
}

export interface QaCharacter {
  id: string;
  name: string;
  appearance: string;
  wardrobe: string;
}

export async function qaCharacter(projectId: string, c: QaCharacter): Promise<void> {
  await col.projects().doc(projectId).collection('characters').doc(c.id).set({ name: c.name, role: '', description: '', appearance: c.appearance, wardrobe: c.wardrobe, personality: '', voice: '', referenceAssetIds: [], primaryRefAssetId: null, turnaroundAssetId: null, locked: false, realPerson: false, consentConfirmed: false, createdAt: FieldValue.serverTimestamp() });
}

export interface QaShot {
  title: string;
  description: string;
  durationSec: number;
  directions: Partial<ShotDirections>;
  characterIds?: string[];
}

const EMPTY_DIRECTIONS: ShotDirections = { framing: '', cameraMovement: '', lens: '', lighting: '', mood: '', style: '', performance: '', action: '', dialogue: [], ambientSound: '', avoid: '' };

export async function qaShot(projectId: string, shotId: string, s: QaShot): Promise<ShotDirections> {
  const directions = { ...EMPTY_DIRECTIONS, ...s.directions };
  await col.projects().doc(projectId).collection('shots').doc(shotId).set({
    sceneId: null,
    sectionId: null,
    order: 1,
    number: '1',
    title: s.title,
    description: s.description,
    directions,
    promptOverride: null,
    durationSec: s.durationSec,
    aspectRatio: '16:9',
    resolution: '360p',
    refs: { characterIds: s.characterIds ?? [], locationIds: [], elementIds: [], assetIds: [], firstFrameAssetId: null, lastFrameAssetId: null, storyboardAssetId: null },
    lockRefs: false,
    status: 'planned',
    selectedTakeId: null,
    approvedTakeId: null,
    timing: null,
    takeCount: 0,
    notes: '',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return directions;
}

/** The request the Shots tab builds for this shot (same prompt compiler, 360p to keep tests cheap). */
export function shotVideoJob(projectId: string, shotId: string, s: QaShot, directions: ShotDirections, characters: QaCharacter[], film: boolean, durationSec = s.durationSec): VideoJobRequest {
  const prompt = compileShotPrompt(directions, {
    description: s.description,
    characters: characters.map((c) => ({ tag: '', name: c.name, description: [c.appearance, c.wardrobe].filter(Boolean).join('; ') })),
    durationSec,
    noBackgroundMusic: film && !/\b(music|song|singing|band|radio|choir|melody|score)\b/i.test(directions.ambientSound),
    noOverlayText: true,
  });
  return jobRequestSchema.parse({ type: 'video.generate', projectId, mode: 'generate', prompt, aspectRatio: '16:9', resolution: '360p', durationSec, media: [], characterIds: characters.map((c) => c.id), target: { kind: 'shot', id: shotId }, title: s.title, label: `QA · ${s.title}` }) as VideoJobRequest;
}

// ---------------------------------------------------------------------------
// Jobs, uploads and productions
// ---------------------------------------------------------------------------

/** Submits jobs through the same path as the API, confirming exactly the estimated cost. */
export async function submitJobs(owner: Owner, requests: unknown[], label: string): Promise<string[]> {
  const parsed = requests.map((r) => jobRequestSchema.parse(r));
  const prepared = await prepareAll(owner.uid, parsed);
  const total = sumEstimates(prepared.map((p) => p.estimate), PRICING).usd;
  const res = await createJobs(owner.uid, parsed, { confirmedUsd: total, batchLabel: label }, prepared);
  return res.jobIds;
}

export async function getJob(jobId: string): Promise<JobDoc> {
  const snap = await col.jobs().doc(jobId).get();
  return { id: snap.id, ...snap.data() } as JobDoc;
}

export async function waitForJob(jobId: string, log: Log, timeoutMs = 30 * 60_000): Promise<JobDoc> {
  const until = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const job = await getJob(jobId);
    const line = `${job.type} ${job.status}${job.stage ? ` — ${job.stage}` : ''}`;
    if (line !== last) log(`job ${jobId.slice(0, 6)}: ${line}`);
    last = line;
    if (isTerminal(job.status)) return job;
    if (Date.now() > until) throw new Error(`Timed out waiting for job ${jobId} (${line})`);
    await sleep(8000);
  }
}

export async function uploadFile(owner: Owner, projectId: string, file: string, kind: 'audio' | 'video' | 'image', mimeType: string, log: Log): Promise<AssetDoc & { id: string }> {
  const data = readFileSync(file);
  const up = await actions.createUpload(owner, payload('createUpload', { kind, fileName: path.basename(file), mimeType, sizeBytes: data.length, projectId, title: `QA · ${path.basename(file)}` }));
  await bucket.file(up.storagePath).save(data, { contentType: mimeType, resumable: false });
  log(`uploaded ${path.basename(file)} → asset ${up.assetId}; waiting for server-side validation`);
  const until = Date.now() + 10 * 60_000;
  for (;;) {
    const a = await col.assets().doc(up.assetId).get();
    const status = a.get('status') as string;
    if (status === 'ready') return { id: a.id, ...a.data() } as AssetDoc & { id: string };
    if (status === 'rejected') throw new Error(`Upload rejected: ${JSON.stringify(a.get('rejection'))}`);
    if (Date.now() > until) throw new Error(`Upload ${up.assetId} never became ready (${status})`);
    await sleep(4000);
  }
}

export async function loadProductionDoc(id: string): Promise<ProductionDoc> {
  const snap = await col.productions().doc(id).get();
  return { id: snap.id, ...snap.data() } as ProductionDoc;
}

/** Follows a production until automation stops (awaiting review, approved, failed or cancelled). */
export async function waitForProduction(id: string, log: Log, timeoutMs = 80 * 60_000): Promise<ProductionDoc> {
  const until = Date.now() + timeoutMs;
  let lastAt = 0;
  for (;;) {
    const events = await col.productions().doc(id).collection('events').where('at', '>', lastAt).orderBy('at', 'asc').get();
    for (const e of events.docs) {
      log(`[${e.get('status')}/${e.get('stage')}] ${e.get('message')}`);
      lastAt = Math.max(lastAt, Number(e.get('at')));
    }
    const p = await loadProductionDoc(id);
    if (!(ACTIVE_PRODUCTION_STATUSES as readonly string[]).includes(p.status)) return p;
    if (Date.now() > until) throw new Error(`Timed out waiting for production ${id} (${p.status}/${p.stage}: ${p.stageMessage})`);
    await sleep(15_000);
  }
}

export interface VersionReport {
  version: Pick<ProductionVersionDoc, 'id' | 'index' | 'kind' | 'label' | 'durationSec' | 'plannedCuts' | 'verdict' | 'overall' | 'takeId' | 'assetId' | 'repair'>;
  report: {
    overall: number;
    passed: boolean;
    threshold: number;
    reasons: string[];
    scores: QualityReportDoc['scores'];
    dialogue: Pick<QualityReportDoc['dialogue'], 'applicable' | 'dialogueComplete' | 'expectedText' | 'detectedText' | 'missingWords' | 'alteredWords' | 'repeatedWords' | 'truncatedFinalWord' | 'cutoffTime' | 'firstWordStart' | 'lastWordEnd' | 'leadingRoomSec' | 'trailingRoomSec' | 'recommendedRepair'>;
    actions: QualityReportDoc['review']['actions'];
    actionComplete: boolean;
    problems: { category: string; severity: string; blocking: boolean; source: string; startSec: number | null; description: string }[];
    summary: string;
    durationSec: number;
    sceneCuts: number[];
    costUsd: number;
  } | null;
}

/** Everything a reviewer needs: plan, versions with their reports, repairs, events and spend. */
export async function productionRecord(id: string) {
  const p = await loadProductionDoc(id);
  const ref = col.productions().doc(id);
  const [versions, reports, events] = await Promise.all([ref.collection('versions').orderBy('index', 'asc').get(), ref.collection('reports').get(), ref.collection('events').orderBy('at', 'asc').get()]);
  const byVersion = new Map<string, QualityReportDoc>();
  for (const r of reports.docs) {
    const d = { id: r.id, ...r.data() } as QualityReportDoc;
    const prev = byVersion.get(d.versionId);
    if (!prev || (toMillis(prev.createdAt as never) ?? 0) <= (toMillis(d.createdAt as never) ?? 0)) byVersion.set(d.versionId, d);
  }
  const out: VersionReport[] = versions.docs.map((v) => {
    const d = { id: v.id, ...v.data() } as ProductionVersionDoc;
    const r = byVersion.get(d.id) ?? null;
    return {
      version: { id: d.id, index: d.index, kind: d.kind, label: d.label, durationSec: d.durationSec, plannedCuts: d.plannedCuts, verdict: d.verdict, overall: d.overall, takeId: d.takeId, assetId: d.assetId, repair: d.repair },
      report: r && {
        overall: r.overall,
        passed: r.passed,
        threshold: r.threshold,
        reasons: r.reasons,
        scores: r.scores,
        dialogue: { applicable: r.dialogue.applicable, dialogueComplete: r.dialogue.dialogueComplete, expectedText: r.dialogue.expectedText, detectedText: r.dialogue.detectedText, missingWords: r.dialogue.missingWords, alteredWords: r.dialogue.alteredWords, repeatedWords: r.dialogue.repeatedWords, truncatedFinalWord: r.dialogue.truncatedFinalWord, cutoffTime: r.dialogue.cutoffTime, firstWordStart: r.dialogue.firstWordStart, lastWordEnd: r.dialogue.lastWordEnd, leadingRoomSec: r.dialogue.leadingRoomSec, trailingRoomSec: r.dialogue.trailingRoomSec, recommendedRepair: r.dialogue.recommendedRepair },
        actions: r.review.actions,
        actionComplete: r.review.actionComplete,
        problems: r.problems.map((x) => ({ category: x.category, severity: x.severity, blocking: x.blocking, source: x.source, startSec: x.startSec, description: x.description })),
        summary: r.summary,
        durationSec: r.measurements.durationSec,
        sceneCuts: r.measurements.visual.sceneCuts,
        costUsd: r.costUsd,
      },
    };
  });
  return {
    id,
    status: p.status,
    stage: p.stage,
    stageMessage: p.stageMessage,
    plan: p.plan && { requestedSec: p.plan.requestedSec, requiredSec: p.plan.requiredSec, plannedSec: p.plan.plannedSec, strategy: p.plan.strategy, message: p.plan.message, breakdown: p.plan.breakdown, segments: p.plan.segments.map((s) => ({ durationSec: s.durationSec, text: s.units.map((u) => u.text).join(' ') })), measured: p.plan.measured },
    dialogueAudio: { mode: p.dialogueAudio.mode, note: p.dialogueAudio.note, lines: p.dialogueAudio.lines.map((l) => ({ index: l.index, character: l.character, seconds: l.seconds, estimatedSec: l.estimatedSec, voice: l.voice })) },
    repairs: p.repairs,
    pendingRepair: p.pendingRepair,
    failure: p.failure,
    approval: p.approval,
    bestVersionId: p.bestVersionId,
    currentVersionId: p.currentVersionId,
    versions: out,
    events: events.docs.map((e) => `[${e.get('status')}/${e.get('stage')}] ${e.get('message')}`),
    spentUsd: await productionSpend(id),
  };
}
export type ProductionRecord = Awaited<ReturnType<typeof productionRecord>>;

export function currentVersion(rec: ProductionRecord): VersionReport | undefined {
  return rec.versions.find((v) => v.version.id === rec.currentVersionId) ?? rec.versions.at(-1);
}

/**
 * Runs a production to the end of automation. Acting as the director, it approves a proposed repair
 * that is only waiting because it is "expensive" (never one that would pass the scene's cost ceiling
 * or the spending limits), up to `approveUpToUsd` each and at most twice.
 */
export async function runProduction(owner: Owner, productionId: string, log: Log, opts: { approveUpToUsd?: number } = {}): Promise<ProductionDoc> {
  let approvals = 0;
  for (;;) {
    const p = await waitForProduction(productionId, log);
    const pending = p.pendingRepair;
    if (p.status === 'awaiting_review' && pending?.waitingFor === 'expensive_retry' && pending.estimateUsd <= (opts.approveUpToUsd ?? 2.5) && approvals < 2) {
      approvals += 1;
      log(`director approves the proposed repair (${pending.type}, ≈ $${pending.estimateUsd})`);
      await productionApi.productionAction(owner, payload('productionAction', { productionId, action: 'approve_pending_repair', confirmedUsd: pending.estimateUsd }));
      continue;
    }
    return p;
  }
}
