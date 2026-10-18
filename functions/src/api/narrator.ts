import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  ACTIVE_STATUSES,
  CLOUD_CONSENT_SOURCE,
  CLOUD_CONSENT_STATEMENTS,
  CONSENT_SOURCE,
  CONSENT_STATEMENTS,
  NARRATOR_ROUTES,
  ROUTE_LABELS,
  consentStatementFor,
  decodePcm16Wav,
  googleVoiceLabel,
  googleVoiceOf,
  providerOfRoute,
  routeOfVoice,
  type NarrationPin,
  type NarratorRoute,
  DEFAULT_EDITION_SETTINGS,
  DEFAULT_WORDS_PER_MINUTE,
  ENROLLMENT,
  NARRATOR,
  RETENTION,
  SEED_PRONUNCIATIONS,
  analyzeRecording,
  bloggerEmbedHtml,
  buildScript,
  defaultSoundCloudDescription,
  defaultSoundCloudTitle,
  estimateNarration,
  flattenScript,
  exportFileNames,
  hasBlockingIssue,
  loudnessTarget,
  measuredPace,
  normalizeNarratorSettings,
  parseSoundCloudInput,
  providerTextFor,
  styleFor,
  toMillis,
  type CostEstimate,
  type JobDoc,
  type NarratorClipDoc,
  type NarratorEditionDoc,
  type NarratorExportDoc,
  type NarratorProfileDoc,
  type NarratorRecordingDoc,
  type NarratorRequest,
  type NarratorSettings,
  type NarratorTestDoc,
  type NarratorVoiceDoc,
  type NoiseReduction,
  type PronunciationEntry,
} from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { narrationRates, PRICING } from '../config/pricing';
import { col, db, FieldValue } from '../lib/firebase';
import { cancelJobDoc, enqueueJob } from '../lib/jobs';
import { decodeToFloat, sniffAudio, toEnrollmentWav } from '../lib/narrator-audio';
import { ImportError, importArticle } from '../lib/narrator-import';
import { planExport, planNarration, type NarrationPlan } from '../lib/narrator-plan';
import { checkCapabilities, deleteVoice, getVoice, listReplicatedVoices, NarratorProviderError, providerConfigured, synthesize, type ProviderStatus, type ProviderVoice } from '../lib/narrator-provider';
import { media, ncol, npath, voiceFingerprint } from '../lib/narrator-store';
import type { Owner } from '../lib/owner';
import { activeLimit, clearLimit, dailyAllowance, limitMessage, resetDailyCount, type Allowance } from '../lib/narrator-limits';
import { publish, unpublish, withdraw } from './narrator-publish';
import { signedReadUrl } from '../lib/storage';
import { assertRateLimit, assertWithinLimits, getSettings, recordUsage, spendSnapshot } from '../lib/usage';

type Req<O extends NarratorRequest['op']> = Extract<NarratorRequest, { op: O }>;
type WithId<T> = T & { id: string };

const DAY = 86_400_000;
/** Narrator media links expire quickly; the player asks for a fresh one when needed. */
export const NARRATOR_URL_TTL_SEC = 15 * 60;

// ---------------------------------------------------------------------------
// Loading with ownership checks
// ---------------------------------------------------------------------------

async function owned<T>(ref: FirebaseFirestore.DocumentReference, uid: string, what: string): Promise<WithId<T>> {
  const snap = await ref.get();
  if (!snap.exists || snap.get('ownerUid') !== uid) throw new HttpsError('not-found', `${what} not found.`);
  return { ...(snap.data() as T), id: snap.id };
}

const loadVoice = (uid: string, voiceId: string) => owned<NarratorVoiceDoc>(ncol.voices().doc(voiceId) as never, uid, 'Voice');

/**
 * The voice an edition is narrated with: a replicated voice profile, or one of Google's prebuilt voices
 * (`google-<Name>`). A prebuilt voice needs no enrollment or approval and is spoken on the route and model chosen
 * in Settings, so it is described here as an always-active, approved profile on that route.
 */
async function loadNarrator(uid: string, voiceId: string): Promise<WithId<NarratorVoiceDoc>> {
  const g = googleVoiceOf(voiceId);
  if (!g) return loadVoice(uid, voiceId);
  const { settings } = await loadProfile(uid);
  const modelId = narrationModel(settings);
  return {
    id: voiceId,
    ownerUid: uid,
    displayName: googleVoiceLabel(g),
    provider: providerOfRoute(settings.route),
    modelId,
    compatibleModels: [...MODEL_REGISTRY.narration.allowedIds],
    storage: 'stateful',
    status: 'active',
    consent: { state: 'verified', locale: 'en-US', submittedAt: null, verifiedAt: null, message: null },
    approval: { state: 'approved', at: null, assessment: null, preset: null },
    referenceRecordingId: null,
    consentRecordingId: null,
    createdAtProvider: null,
    lastUsedAt: null,
    expiresAt: null,
    error: null,
    jobId: null,
    requestId: voiceId,
  };
}

/** Noise reduction for a job's audio: the owner's setting for replicated voices; prebuilt voices are clean. */
const noiseFor = (voiceId: string, settings: NarratorSettings): NoiseReduction => (googleVoiceOf(voiceId) ? 'off' : settings.noiseReduction);
const loadEdition = async (uid: string, editionId: string) => {
  const e = await owned<NarratorEditionDoc>(ncol.editions().doc(editionId) as never, uid, 'Edition');
  if (e.deleted) throw new HttpsError('not-found', 'Edition not found.');
  return e;
};

export async function loadProfile(uid: string): Promise<NarratorProfileDoc> {
  const snap = await ncol.profiles().doc(uid).get();
  const d = (snap.exists ? snap.data() : {}) as Partial<NarratorProfileDoc>;
  return { ownerUid: uid, pronunciations: Array.isArray(d.pronunciations) ? d.pronunciations : SEED_PRONUNCIATIONS, settings: normalizeNarratorSettings(d.settings) };
}

/** The synthesis model: the owner's choice when it is one of the registry's narration models. */
export function narrationModel(settings: NarratorSettings): string {
  const allowed = MODEL_REGISTRY.narration.allowedIds as readonly string[];
  return settings.modelId && allowed.includes(settings.modelId) ? settings.modelId : MODEL_REGISTRY.narration.id;
}

async function clipsOf(editionId: string): Promise<WithId<NarratorClipDoc>[]> {
  return (await ncol.clips(editionId).get()).docs.map((d) => ({ ...(d.data() as NarratorClipDoc), id: d.id }));
}

async function activeNarratorJobs(uid: string): Promise<WithId<JobDoc>[]> {
  const snap = await col.jobs().where('ownerUid', '==', uid).where('status', 'in', [...ACTIVE_STATUSES]).get();
  return snap.docs.map((d) => ({ ...(d.data() as JobDoc), id: d.id })).filter((j) => j.type.startsWith('narrator.'));
}

function costEstimate(usd: number, notes: string[], label: string): CostEstimate {
  return { usd, basis: usd > 0 ? 'published_rate' : 'none', confidence: 'medium', breakdown: [{ label, usd }], notes, pricingVersion: 'narration-2026-10-17' };
}

interface NewJob {
  id: string;
  type: 'narrator.voice' | 'narrator.speak' | 'narrator.export' | 'narrator.direct';
  label: string;
  modelId: string | null;
  params: Record<string, unknown>;
  estimate: CostEstimate;
  target: JobDoc['target'];
}

/** Creates a narrator job with a deterministic id; returns false when a job with that id already exists. */
async function createJob(uid: string, j: NewJob, tx: FirebaseFirestore.Transaction): Promise<void> {
  const now = FieldValue.serverTimestamp();
  const job: Omit<JobDoc, 'id'> = { ownerUid: uid, projectId: null, type: j.type, status: 'queued', stage: 'Queued', progress: 0, modelId: j.modelId, params: j.params, estimate: j.estimate, batchId: null, target: j.target, label: j.label, attempt: 0, retryOf: null, external: null, result: null, error: null, cancelRequested: false, usageUsd: null, productionId: null };
  tx.set(col.jobs().doc(j.id) as never, { ...job, createdAt: now, updatedAt: now });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function status(owner: Owner, p: Req<'status'>) {
  const cacheRef = ncol.runtime('status');
  let provider: ProviderStatus | null = null;
  const cached = await cacheRef.get();
  if (!p.refresh && cached.exists && Date.now() - Number(cached.get('checkedAt') ?? 0) < 10 * 60_000) provider = cached.data() as ProviderStatus;
  if (!provider) {
    provider = await checkCapabilities();
    await cacheRef.set(provider);
  }
  const profile = await loadProfile(owner.uid);
  const modelId = narrationModel(profile.settings);
  const ids = MODEL_REGISTRY.narration.allowedIds as readonly string[];
  // “Check now” clears a recorded allowance block (e.g. after raising the API tier); otherwise report it.
  if (p.refresh) {
    for (const route of NARRATOR_ROUTES) for (const id of ids) await clearLimit(id, route);
    for (const id of ids) await resetDailyCount('developer', id);
  }
  const limits = (await Promise.all(NARRATOR_ROUTES.flatMap((route) => ids.map((id) => activeLimit(id, route))))).filter((l) => l !== null).map((l) => ({ modelId: l!.modelId, route: l!.route ?? 'developer', until: l!.until, message: limitMessage(l!) }));
  // While Google's own block is recorded, the allowance is used up whatever this app counted itself.
  const allowance = (await Promise.all(ids.map((id) => dailyAllowance('developer', id))))
    .filter((a): a is Allowance => a !== null)
    .map((a) => (limits.some((l) => l.route === 'developer' && l.modelId === a.modelId) ? { ...a, used: Math.max(a.used, a.limit), remaining: 0 } : a));
  const names = MODEL_REGISTRY.narration.displayNames as Record<string, string>;
  return {
    provider,
    model: { id: modelId, displayName: names[modelId] ?? modelId, allowed: ids.map((id) => ({ id, displayName: names[id] ?? id })) },
    rates: narrationRates(modelId),
    voiceCreationCost: 'Google’s pricing pages (checked 17–18 October 2026) list no price for creating a replicated voice, so AZ Studio cannot estimate it.',
    consent: { statements: CONSENT_STATEMENTS, source: CONSENT_SOURCE, cloud: { statements: CLOUD_CONSENT_STATEMENTS, source: CLOUD_CONSENT_SOURCE } },
    enrollment: ENROLLMENT,
    retention: RETENTION,
    settings: profile.settings,
    pronunciations: profile.pronunciations,
    limits,
    routes: { cloudTest: publicCloudTest(await cloudTestRecord()), allowance },
  };
}

// ---------------------------------------------------------------------------
// Google Cloud route: a short narration test unlocks it
// ---------------------------------------------------------------------------

interface CloudTestRecord {
  ok: boolean;
  at: number;
  modelId: string;
  requestId: string;
  durationSec: number | null;
  latencyMs: number | null;
  usd: number | null;
  message: string | null;
  storagePath: string | null;
}

const cloudTestRef = () => ncol.runtime('cloud-test');
async function cloudTestRecord(): Promise<CloudTestRecord | null> {
  const s = await cloudTestRef().get();
  return s.exists ? (s.data() as CloudTestRecord) : null;
}
const publicCloudTest = (r: CloudTestRecord | null) => (r ? { ok: r.ok, at: r.at, modelId: r.modelId, durationSec: r.durationSec, latencyMs: r.latencyMs, usd: r.usd, message: r.message } : null);

/** The Cloud route stays locked (Developer API remains the default) until a Cloud narration test succeeded. */
async function cloudRouteReady(): Promise<boolean> {
  return Boolean((await cloudTestRecord())?.ok);
}

/**
 * Speaks two short styled sentences with a prebuilt voice on Vertex AI, using the functions' own service
 * account — proving project access, IAM, billing, location, the model and per-block delivery styles.
 */
async function cloudCheck(owner: Owner, p: Req<'cloudCheck'>) {
  await assertRateLimit(owner.uid, 1, 5);
  const prev = await cloudTestRecord();
  if (prev?.requestId === p.requestId) return { ...publicCloudTest(prev), url: prev.storagePath ? (await signedReadUrl(prev.storagePath, { ttlSeconds: NARRATOR_URL_TTL_SEC })).url : null };
  const profile = await loadProfile(owner.uid);
  const modelId = narrationModel(profile.settings);
  const segments = [
    { text: 'This is a short test of Pwavwe Narrator on Google Cloud.', style: 'natural and conversational' },
    { text: 'If you can hear this sentence, the Cloud route works.', style: 'warm and unhurried' },
  ];
  const rates = narrationRates(modelId);
  assertWithinLimits(await getSettings(owner.uid), await spendSnapshot(owner.uid), 0.01);
  const t0 = Date.now();
  let rec: CloudTestRecord;
  try {
    const r = await synthesize({ route: 'vertex', modelId, voiceId: MODEL_REGISTRY.narration.vertex.testVoice, segments });
    const latencyMs = Date.now() - t0;
    const usd = Math.round(((r.inputTokens / 1e6) * rates.inputPerM + (r.outputTokens / 1e6) * rates.outputPerM) * 1e6) / 1e6;
    await recordUsage({ uid: owner.uid, projectId: null, jobId: `narc-${p.requestId}`, modelId, kind: 'speech', inputTokens: r.inputTokens, outputTokens: r.outputTokens, thoughtTokens: 0, costUsdOverride: usd });
    const storagePath = `${npath.root(owner.uid)}cloud-test/${p.requestId}.wav`;
    await media.save(storagePath, r.wav, 'audio/wav');
    const d = decodePcm16Wav(r.wav);
    const durationSec = d ? Math.round((d.samples.length / d.sampleRate) * 100) / 100 : null;
    const ok = Boolean(durationSec && durationSec > 1);
    rec = { ok, at: Date.now(), modelId, requestId: p.requestId, durationSec, latencyMs, usd, message: ok ? null : 'Google answered with too little audio to count as a narration.', storagePath };
  } catch (e) {
    rec = { ok: false, at: Date.now(), modelId, requestId: p.requestId, durationSec: null, latencyMs: Date.now() - t0, usd: null, message: e instanceof NarratorProviderError ? `${e.kind === 'auth' ? 'Permission: ' : ''}${e.message}` : String((e as Error)?.message ?? e).slice(0, 300), storagePath: null };
  }
  if (prev?.storagePath) await media.remove(prev.storagePath).catch(() => undefined);
  await cloudTestRef().set(rec);
  await ncol.runtime('status').delete();
  return { ...publicCloudTest(rec), url: rec.storagePath ? (await signedReadUrl(rec.storagePath, { ttlSeconds: NARRATOR_URL_TTL_SEC })).url : null };
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

async function recordingUpload(owner: Owner, p: Req<'recordingUpload'>) {
  await assertRateLimit(owner.uid, 1, 20);
  if (Boolean(p.dataBase64) === Boolean(p.inboxPath)) throw new HttpsError('invalid-argument', 'Send the recording either inline or through the upload inbox.');
  if (p.inboxPath && !p.inboxPath.startsWith(`users/${owner.uid}/narrator-inbox/`)) throw new HttpsError('permission-denied', 'Not your upload.');
  let buf: Buffer;
  try {
    buf = p.inboxPath ? await media.read(p.inboxPath) : Buffer.from(p.dataBase64!, 'base64');
  } catch {
    throw new HttpsError('not-found', 'The uploaded file was not found. Upload it again.');
  } finally {
    if (p.inboxPath) await media.remove(p.inboxPath).catch(() => undefined);
  }
  if (!buf.length) throw new HttpsError('invalid-argument', 'The recording is empty.');
  if (buf.length > ENROLLMENT.maxUploadBytes) throw new HttpsError('invalid-argument', `The file is ${(buf.length / 1048576).toFixed(1)} MB; the limit is ${ENROLLMENT.maxUploadBytes / 1048576} MB. A 10–30 s clip is far smaller — trim it or export it as MP3/M4A.`);
  const sniffed = await sniffAudio(buf);
  if (!sniffed) throw new HttpsError('invalid-argument', 'This file is not a supported audio recording (WAV, MP3, M4A/AAC, FLAC, Ogg or WebM). Its contents, not its name, were checked.');
  const dir = await mkdtemp(path.join(tmpdir(), 'nar-'));
  try {
    const src = path.join(dir, `in.${sniffed.ext}`);
    const wav = path.join(dir, 'out.wav');
    await writeFile(src, buf);
    try {
      await toEnrollmentWav(src, wav);
    } catch {
      throw new HttpsError('invalid-argument', 'The audio could not be decoded. Try recording again or export the file as WAV or MP3.');
    }
    const samples = await decodeToFloat(wav, ENROLLMENT.sampleRate);
    const analysis = analyzeRecording(samples, ENROLLMENT.sampleRate, p.kind);
    const ref = ncol.recordings().doc();
    const storagePath = npath.recording(owner.uid, ref.id);
    await media.save(storagePath, await readFile(wav), 'audio/wav');
    const doc: NarratorRecordingDoc = {
      ownerUid: owner.uid,
      kind: p.kind,
      source: p.source,
      storagePath,
      originalMimeType: sniffed.mime,
      originalBytes: buf.length,
      analysis,
      termId: p.termId ?? null,
      scriptText: p.scriptText ?? null,
      consentLocale: p.kind === 'consent' ? (p.consentLocale ?? 'en-US') : null,
      consentRoute: p.kind === 'consent' ? (p.consentRoute ?? 'developer') : null,
      usedByVoiceId: null,
      status: 'ready',
      deleteAfter: Date.now() + (p.kind === 'pronunciation' ? 365 : RETENTION.unusedRecordingDays) * DAY,
    };
    await ref.set({ ...doc, createdAt: FieldValue.serverTimestamp() });
    return { recordingId: ref.id, analysis, converted: { sampleRate: ENROLLMENT.sampleRate, channels: 1, bitsPerSample: 16, format: 'wav' } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function deleteRecording(uid: string, recordingId: string): Promise<void> {
  const ref = ncol.recordings().doc(recordingId);
  const r = await owned<NarratorRecordingDoc>(ref as never, uid, 'Recording');
  if (r.storagePath) await media.remove(r.storagePath);
  await ref.set({ status: 'deleted', storagePath: null, deletedAt: FieldValue.serverTimestamp() }, { merge: true });
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

async function voiceCreate(owner: Owner, p: Req<'voiceCreate'>) {
  const profile = await loadProfile(owner.uid);
  // New voices go to the route chosen in Settings; each route keeps its own voice store and consent sentence.
  const route: NarratorRoute = profile.settings.route;
  if (route === 'vertex' && !(await cloudRouteReady())) throw new HttpsError('failed-precondition', 'Run the Google Cloud narration test in Settings → Speech service before creating a Cloud voice.');
  if (!(await providerConfigured(route))) throw new HttpsError('failed-precondition', 'Voice replication is not configured on the server yet (see Settings → Provider).');
  const [ref, con] = await Promise.all([owned<NarratorRecordingDoc>(ncol.recordings().doc(p.referenceId) as never, owner.uid, 'Reference recording'), owned<NarratorRecordingDoc>(ncol.recordings().doc(p.consentId) as never, owner.uid, 'Consent recording')]);
  if (ref.kind !== 'reference' || con.kind !== 'consent') throw new HttpsError('invalid-argument', 'Use one reference recording and one consent recording.');
  if (ref.status !== 'ready' || con.status !== 'ready' || !ref.storagePath || !con.storagePath) throw new HttpsError('failed-precondition', 'A recording was deleted. Record it again.');
  if ((con.consentRoute ?? 'developer') !== route) throw new HttpsError('failed-precondition', `This consent recording reads the ${ROUTE_LABELS[con.consentRoute ?? 'developer']} sentence, but ${ROUTE_LABELS[route]} verifies its own wording. Record the consent statement again, word for word: “${consentStatementFor(route, p.consentLocale)}”`);
  if (con.usedByVoiceId) throw new HttpsError('failed-precondition', 'This consent recording was already used for a voice. Record the consent statement again.');
  if (hasBlockingIssue(ref.analysis)) throw new HttpsError('failed-precondition', `The reference recording cannot be used: ${ref.analysis.issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' ')}`);
  if (hasBlockingIssue(con.analysis)) throw new HttpsError('failed-precondition', `The consent recording cannot be used: ${con.analysis.issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' ')}`);
  const modelId = narrationModel(profile.settings);
  const voiceRef = ncol.voices().doc(`v-${p.requestId}`);
  const jobId = `narv-${p.requestId}`;
  const result = await db.runTransaction(async (tx) => {
    const existing = await tx.get(voiceRef);
    if (existing.exists) {
      if (existing.get('ownerUid') !== owner.uid) throw new HttpsError('permission-denied', 'Not allowed.');
      return { voiceId: voiceRef.id, jobId: String(existing.get('jobId')), duplicate: true };
    }
    const lock = await tx.get(ncol.runtime(`voice-create-${owner.uid}`));
    if (lock.exists && Number(lock.get('until') ?? 0) > Date.now() && lock.get('voiceId') !== voiceRef.id) throw new HttpsError('already-exists', 'A voice is already being created. Wait for it to finish.');
    const voice: NarratorVoiceDoc = {
      ownerUid: owner.uid,
      displayName: NARRATOR.voiceDisplayName,
      provider: providerOfRoute(route),
      modelId,
      compatibleModels: [modelId],
      storage: 'stateful',
      status: 'creating',
      consent: { state: 'pending', locale: p.consentLocale, submittedAt: null, verifiedAt: null, message: null },
      approval: { state: 'pending', at: null, assessment: null, preset: null },
      referenceRecordingId: ref.id,
      consentRecordingId: con.id,
      createdAtProvider: null,
      lastUsedAt: null,
      expiresAt: null,
      error: null,
      jobId,
      requestId: p.requestId,
    };
    tx.set(voiceRef, { ...voice, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.set(ncol.runtime(`voice-create-${owner.uid}`), { voiceId: voiceRef.id, until: Date.now() + 10 * 60_000 });
    await createJob(owner.uid, { id: jobId, type: 'narrator.voice', label: `Voice replication · ${NARRATOR.voiceDisplayName}${route === 'vertex' ? ' (Google Cloud)' : ''}`, modelId, params: { voiceId: voiceRef.id, referenceId: ref.id, consentId: con.id, modelId, route }, estimate: costEstimate(0, ['Google lists no price for creating a replicated voice; the cost is unavailable.'], 'Voice creation (price not published)'), target: { kind: 'narrator_voice', id: voiceRef.id } }, tx);
    return { voiceId: voiceRef.id, jobId, duplicate: false };
  });
  if (!result.duplicate) await enqueueJob(jobId, 'start');
  return result;
}

async function voiceTest(owner: Owner, p: Req<'voiceTest'>) {
  const voice = await loadVoice(owner.uid, p.voiceId);
  if (voice.status !== 'active') throw new HttpsError('failed-precondition', voice.status === 'creating' ? 'The voice is still being created.' : 'This voice is not available. Renew it from My Voice.');
  const limit = await activeLimit(voice.modelId, routeOfVoice(voice));
  if (limit) throw new HttpsError('resource-exhausted', limitMessage(limit));
  const pin = await jobPin(voice);
  const profile = await loadProfile(owner.uid);
  const testRef = ncol.tests(voice.id).doc(`t-${p.requestId}`);
  const jobId = `nart-${p.requestId}`;
  const { text: providerText, applied } = providerTextFor(p.text, profile.pronunciations);
  const style = styleFor(p.preset, p.customStyle);
  const est = await estimateFor(owner.uid, voice, [providerText]);
  const settings = await getSettings(owner.uid);
  assertWithinLimits(settings, await spendSnapshot(owner.uid), est.usd);
  if (est.usd > profile.settings.generationBudgetUsd) throw new HttpsError('failed-precondition', `This test is estimated at $${est.usd.toFixed(4)}, above your generation budget of $${profile.settings.generationBudgetUsd.toFixed(2)} (Settings).`);
  const created = await db.runTransaction(async (tx) => {
    if ((await tx.get(testRef)).exists) return false;
    const test: NarratorTestDoc = { ownerUid: owner.uid, voiceId: voice.id, text: p.text, preset: p.preset, style, status: 'generating', storagePath: null, durationSec: null, peaks: null, jobId, error: null, pronunciations: applied.map((a) => ({ term: a.term, spokenAs: a.spokenAs })) };
    tx.set(testRef, { ...test, createdAt: FieldValue.serverTimestamp() });
    await createJob(owner.uid, { id: jobId, type: 'narrator.speak', label: 'Voice test · Pwavwe Narrator', modelId: voice.modelId, params: { kind: 'audition', voiceId: voice.id, testId: testRef.id, editionId: null, modelId: voice.modelId, ...pin, noiseReduction: noiseFor(voice.id, profile.settings), budgetUsd: profile.settings.generationBudgetUsd, items: [{ key: 'audition', passageId: null, text: p.text, providerText, style, inputHash: '', chunks: [{ segments: [{ text: providerText, style }] }], pronunciations: applied }] }, estimate: costEstimate(est.usd, est.notes, 'Speech'), target: { kind: 'narrator_voice', id: voice.id, sub: testRef.id } }, tx);
    return true;
  });
  if (created) await enqueueJob(jobId, 'start');
  return { testId: testRef.id, jobId, estimate: est };
}

async function voiceAssess(owner: Owner, p: Req<'voiceAssess'>) {
  const voice = await loadVoice(owner.uid, p.voiceId);
  if (p.decision === 'approve') {
    if (voice.status !== 'active') throw new HttpsError('failed-precondition', 'Only an active voice can be approved.');
    const tests = await ncol.tests(voice.id).where('status', '==', 'ready').limit(1).get();
    if (tests.empty) throw new HttpsError('failed-precondition', 'Generate and listen to a test before approving the voice.');
  }
  // The request names an action (approve / reject / pending); the profile stores the resulting state.
  const STATE: Record<typeof p.decision, NarratorVoiceDoc['approval']['state']> = { approve: 'approved', reject: 'rejected', pending: 'pending' };
  const approval: NarratorVoiceDoc['approval'] = { state: STATE[p.decision], at: p.decision === 'pending' ? null : Date.now(), assessment: p.assessment, preset: p.preset };
  await ncol.voices().doc(voice.id).set({ approval, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
}

async function providerIdOf(voiceId: string): Promise<string | null> {
  const snap = await ncol.voicePrivate(voiceId).get();
  return snap.exists ? (snap.get('providerVoiceId') as string) : null;
}

/** What a speech job is pinned to: the voice's route and a fingerprint of its provider voice (never the id). */
async function jobPin(voice: WithId<NarratorVoiceDoc>): Promise<{ route: NarratorRoute; voiceFingerprint: string | null }> {
  const g = googleVoiceOf(voice.id);
  const pid = g ? g.name : await providerIdOf(voice.id);
  return { route: routeOfVoice(voice), voiceFingerprint: pid ? voiceFingerprint(pid) : null };
}

async function voiceRefresh(owner: Owner, p: Req<'voiceRefresh'>) {
  const voice = await loadVoice(owner.uid, p.voiceId);
  const pid = await providerIdOf(voice.id);
  if (!pid) return { status: voice.status, exists: false };
  const found = await getVoice(pid, routeOfVoice(voice));
  const next = found ? 'active' : voice.expiresAt && voice.expiresAt < Date.now() ? 'expired' : 'missing_at_provider';
  if (voice.status !== 'deleted' && voice.status !== 'creating') await ncol.voices().doc(voice.id).set({ status: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { status: next, exists: Boolean(found) };
}

async function voiceDelete(owner: Owner, p: Req<'voiceDelete'>) {
  const voice = await loadVoice(owner.uid, p.voiceId);
  if (p.confirmName.trim() !== voice.displayName) throw new HttpsError('invalid-argument', `Type “${voice.displayName}” to confirm.`);
  if (voice.status === 'creating') throw new HttpsError('failed-precondition', 'Wait until creation finishes, then delete.');
  const pid = await providerIdOf(voice.id);
  let atProvider: 'deleted' | 'already_gone' | 'none' = 'none';
  if (pid) {
    try {
      atProvider = await deleteVoice(pid, routeOfVoice(voice));
    } catch (e) {
      throw new HttpsError('unavailable', `Google did not confirm the deletion (${e instanceof NarratorProviderError ? e.message : String(e)}). Nothing was removed here; try again.`);
    }
  }
  let recordings = 0;
  for (const rid of [voice.referenceRecordingId, voice.consentRecordingId]) {
    if (!rid) continue;
    const r = await ncol.recordings().doc(rid).get();
    if (r.exists && r.get('ownerUid') === owner.uid && r.get('status') !== 'deleted') {
      await deleteRecording(owner.uid, rid);
      recordings++;
    }
  }
  const tests = await ncol.tests(voice.id).get();
  for (const t of tests.docs) {
    const sp = t.get('storagePath') as string | null;
    if (sp) await media.remove(sp);
    await t.ref.set({ storagePath: null, status: t.get('status') === 'ready' ? 'cancelled' : t.get('status') }, { merge: true });
  }
  await ncol.voicePrivate(voice.id).delete();
  await ncol.voices().doc(voice.id).set({ status: 'deleted', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  const editions = await ncol.editions().where('ownerUid', '==', owner.uid).where('voiceId', '==', voice.id).get();
  return { atProvider, recordingsDeleted: recordings, testsDeleted: tests.size, editionsKept: editions.docs.filter((d) => !d.get('deleted')).length };
}

async function voiceReconcile(owner: Owner) {
  // Both voice stores (each route keeps its own); a route that cannot be listed is reported, not fatal.
  const remote: (ProviderVoice & { route: NarratorRoute })[] = [];
  const problems: { route: NarratorRoute; message: string }[] = [];
  for (const route of NARRATOR_ROUTES) {
    if (route === 'vertex' && !(await cloudRouteReady())) continue;
    try {
      for (const v of await listReplicatedVoices(route)) remote.push({ ...v, route });
    } catch (e) {
      problems.push({ route, message: e instanceof NarratorProviderError ? e.message : String(e).slice(0, 300) });
    }
  }
  const local = (await ncol.voices().where('ownerUid', '==', owner.uid).get()).docs.map((d) => ({ ...(d.data() as NarratorVoiceDoc), id: d.id }));
  const linked = new Map<string, string>();
  for (const v of local) {
    const pid = await providerIdOf(v.id);
    if (pid) linked.set(pid, v.id);
  }
  const unlinked = remote.filter((r) => !linked.has(r.id));
  // An interrupted creation: link the one matching voice Google created after the request was sent.
  const recovered: string[] = [];
  for (const v of local.filter((x) => x.status === 'needs_recovery' && x.consent.submittedAt)) {
    const candidates = unlinked.filter((r) => r.route === routeOfVoice(v) && r.displayName === v.displayName && (!r.createTime || Date.parse(r.createTime) >= v.consent.submittedAt! - 120_000));
    if (candidates.length === 1) {
      await linkVoice(v.id, candidates[0]!.id, Date.parse(candidates[0]!.createTime ?? '') || Date.now());
      recovered.push(v.id);
      unlinked.splice(unlinked.indexOf(candidates[0]!), 1);
    }
  }
  return { remote: remote.length, linked: [...linked.values()], recovered, unlinked: unlinked.map((u) => ({ providerVoiceId: u.id, route: u.route, displayName: u.displayName, createTime: u.createTime })), problems };
}

export async function linkVoice(voiceId: string, providerVoiceId: string, createdAt: number): Promise<void> {
  await ncol.voicePrivate(voiceId).set({ providerVoiceId, linkedAt: Date.now() });
  await ncol.voices().doc(voiceId).update({ status: 'active', 'consent.state': 'verified', 'consent.verifiedAt': createdAt, createdAtProvider: createdAt, lastUsedAt: createdAt, expiresAt: createdAt + ENROLLMENT.storedVoiceTtlDays * DAY, error: null, updatedAt: FieldValue.serverTimestamp() });
}

async function providerVoiceDelete(owner: Owner, p: Req<'providerVoiceDelete'>) {
  const local = (await ncol.voices().where('ownerUid', '==', owner.uid).get()).docs;
  for (const d of local) if ((await providerIdOf(d.id)) === p.providerVoiceId && d.get('status') !== 'deleted') throw new HttpsError('failed-precondition', 'This voice belongs to a profile here. Delete it from My Voice instead.');
  return { atProvider: await deleteVoice(p.providerVoiceId, p.route) };
}

// ---------------------------------------------------------------------------
// Profile (pronunciations, settings)
// ---------------------------------------------------------------------------

async function profileSave(owner: Owner, p: Req<'profileSave'>) {
  const cur = await loadProfile(owner.uid);
  const settings = p.settings ? normalizeNarratorSettings({ ...cur.settings, ...p.settings }) : cur.settings;
  if (p.settings?.modelId && !(MODEL_REGISTRY.narration.allowedIds as readonly string[]).includes(p.settings.modelId)) throw new HttpsError('invalid-argument', 'That model is not available for narration.');
  if (p.settings?.route === 'vertex' && cur.settings.route !== 'vertex' && !(await cloudRouteReady())) throw new HttpsError('failed-precondition', 'Run the Google Cloud narration test first (Settings → Speech service). The Developer API stays in use until it succeeds.');
  const pronunciations: PronunciationEntry[] = p.pronunciations ?? cur.pronunciations;
  if (new Set(pronunciations.map((x) => x.term.toLowerCase())).size !== pronunciations.length) throw new HttpsError('invalid-argument', 'Each term can appear only once in the notebook.');
  await ncol.profiles().doc(owner.uid).set({ ownerUid: owner.uid, pronunciations, settings, updatedAt: FieldValue.serverTimestamp() });
  return { settings, pronunciations };
}

// ---------------------------------------------------------------------------
// Editions
// ---------------------------------------------------------------------------

async function defaultVoiceId(uid: string): Promise<string | null> {
  const voices = (await ncol.voices().where('ownerUid', '==', uid).where('status', '==', 'active').get()).docs.map((d) => ({ ...(d.data() as NarratorVoiceDoc), id: d.id }));
  voices.sort((a, b) => (b.approval.state === 'approved' ? 1 : 0) - (a.approval.state === 'approved' ? 1 : 0) || (toMillis(b.createdAt) ?? 0) - (toMillis(a.createdAt) ?? 0));
  return voices[0]?.id ?? null;
}

async function editionCreate(owner: Owner, p: Req<'editionCreate'>) {
  await assertRateLimit(owner.uid, 1, 30);
  const profile = await loadProfile(owner.uid);
  const title = p.title.trim() || 'Untitled paper';
  const built = buildScript({ title, body: p.body, openingTemplate: profile.settings.openingTemplate, closingText: profile.settings.closingText, existingOpening: p.existingOpening });
  const ref = ncol.editions().doc();
  const edition: NarratorEditionDoc = {
    ownerUid: owner.uid,
    title,
    author: NARRATOR.defaultAuthor,
    publishedDate: p.publishedDate,
    sourceUrl: p.sourceUrl,
    voiceId: await defaultVoiceId(owner.uid),
    article: { body: p.body, origin: p.origin, importedAt: p.origin === 'url' ? Date.now() : null, notes: [...p.notes, ...built.notes].slice(0, 20) },
    script: built.script,
    // New editions are read as one continuous take (older editions keep passage-by-passage takes until switched).
    settings: { ...DEFAULT_EDITION_SETTINGS, preset: profile.settings.defaultPreset, includeClosing: profile.settings.includeClosing, pauses: profile.settings.pauses, readMode: 'oneTake' },
    takes: {},
    soundcloud: { title: defaultSoundCloudTitle(title), description: defaultSoundCloudDescription({ title, author: NARRATOR.defaultAuthor, publishedDate: p.publishedDate, sourceUrl: p.sourceUrl }), link: null },
    rev: 1,
    lastExportId: null,
    deleted: false,
  };
  await ref.set({ ...edition, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return { editionId: ref.id, notes: built.notes };
}

async function editionSave(owner: Owner, p: Req<'editionSave'>) {
  const ref = ncol.editions().doc(p.editionId);
  if (p.patch.voiceId) await loadNarrator(owner.uid, p.patch.voiceId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('ownerUid') !== owner.uid || snap.get('deleted')) throw new HttpsError('not-found', 'Edition not found.');
    const rev = Number(snap.get('rev') ?? 0);
    if (rev !== p.baseRev) throw new HttpsError('aborted', 'This edition was changed in another tab or window. Reload to continue from the latest version.', { rev });
    const patch: Record<string, unknown> = { rev: rev + 1, updatedAt: FieldValue.serverTimestamp() };
    for (const [k, v] of Object.entries(p.patch)) {
      if (v === undefined) continue;
      if (k === 'soundcloud') {
        patch['soundcloud.title'] = (v as { title: string }).title;
        patch['soundcloud.description'] = (v as { description: string }).description;
      } else patch[k] = v;
    }
    tx.update(ref, patch);
    return { rev: rev + 1 };
  });
}

async function editionDelete(owner: Owner, p: Req<'editionDelete'>) {
  const e = await loadEdition(owner.uid, p.editionId);
  const active = (await activeNarratorJobs(owner.uid)).filter((j) => (j.params as { editionId?: string }).editionId === e.id);
  if (active.length) throw new HttpsError('failed-precondition', 'Cancel the running generation or export first.');
  // A deleted edition is withdrawn from the public player first.
  if (e.publication?.publicId) await withdraw(owner.uid, e.publication.publicId, e.id);
  await media.removePrefix(npath.editionDir(owner.uid, e.id));
  for (const sub of [ncol.clips(e.id), ncol.exports(e.id)]) for (const d of (await sub.get()).docs) await d.ref.delete();
  await ncol.editions().doc(e.id).delete();
  return { ok: true };
}

async function importUrl(owner: Owner, p: Req<'importUrl'>) {
  await assertRateLimit(owner.uid, 1, 10);
  try {
    return await importArticle(p.url);
  } catch (e) {
    if (e instanceof ImportError) throw new HttpsError('invalid-argument', e.message);
    throw new HttpsError('unavailable', 'The page could not be imported. Paste the article text instead.');
  }
}

// ---------------------------------------------------------------------------
// Estimates and generation
// ---------------------------------------------------------------------------

async function paceFor(voiceId: string): Promise<{ wordsPerMinute: number; source: 'measured' | 'default' }> {
  const samples: { text: string; speechSec: number | null }[] = [];
  const tests = await ncol.tests(voiceId).where('status', '==', 'ready').limit(10).get();
  for (const t of tests.docs) samples.push({ text: String(t.get('text') ?? ''), speechSec: Number(t.get('speechSec') ?? t.get('durationSec') ?? 0) || null });
  const measured = measuredPace(samples);
  return measured ? { wordsPerMinute: Math.max(90, Math.min(230, measured)), source: 'measured' } : { wordsPerMinute: DEFAULT_WORDS_PER_MINUTE, source: 'default' };
}

async function estimateFor(uid: string, voice: WithId<NarratorVoiceDoc>, texts: string[]) {
  void uid;
  return estimateNarration(texts, narrationRates(voice.modelId), await paceFor(voice.id));
}

interface Prepared {
  edition: WithId<NarratorEditionDoc>;
  voice: WithId<NarratorVoiceDoc>;
  plan: NarrationPlan;
  estimate: Awaited<ReturnType<typeof estimateFor>>;
  budgetUsd: number;
  noiseReduction: NoiseReduction;
  limitProblem: string | null;
  /** Today's Developer-API allowance for this model, and a note when this request needs more than remains. */
  allowance: Allowance | null;
  allowanceNote: string | null;
  /** The narrator the edition's audio is pinned to, and what this generation will use. */
  pin: NarrationPin | null;
  next: NarrationPin;
}

/** Scopes whose audio becomes part of the edition (previews and selections never do). */
const PINNING_SCOPES = new Set(['passages', 'section', 'edition']);
const samePin = (a: Pick<NarrationPin, 'voiceId' | 'modelId'>, b: Pick<NarrationPin, 'voiceId' | 'modelId'>) => a.voiceId === b.voiceId && a.modelId === b.modelId;

/** The edition's pin; editions narrated before pins existed take it from their selected takes. */
async function editionPin(edition: WithId<NarratorEditionDoc>, clips: WithId<NarratorClipDoc>[]): Promise<NarrationPin | null> {
  if (edition.narration) return edition.narration;
  const selected = new Set(Object.values(edition.takes ?? {}));
  const take = clips.find((c) => selected.has(c.id) && c.status === 'ready');
  if (!take) return null;
  const v = await ncol.voices().doc(take.voiceId).get();
  return { voiceId: take.voiceId, provider: (v.get('provider') as NarrationPin['provider'] | undefined) ?? 'google_gemini_api', modelId: take.modelId, pinnedAt: toMillis(take.createdAt) ?? Date.now() };
}

async function pinLabel(pin: NarrationPin): Promise<string> {
  const names = MODEL_REGISTRY.narration.displayNames as Record<string, string>;
  const g = googleVoiceOf(pin.voiceId);
  const v = g ? null : await ncol.voices().doc(pin.voiceId).get();
  const created = v ? toMillis(v.get('createdAt')) : null;
  return `“${g ? googleVoiceLabel(g) : String(v!.get('displayName') ?? 'a deleted voice')}”${created ? ` (created ${new Date(created).toISOString().slice(0, 10)})` : ''} on ${ROUTE_LABELS[pin.provider === 'vertex_ai' ? 'vertex' : 'developer']}, ${names[pin.modelId] ?? pin.modelId}`;
}

async function prepareGeneration(owner: Owner, p: Req<'estimate'> | Req<'generate'>): Promise<Prepared> {
  const edition = await loadEdition(owner.uid, p.editionId);
  if (!edition.voiceId) throw new HttpsError('failed-precondition', 'Choose a voice for this edition first (create one in My Voice, or pick a Google voice).');
  const voice = await loadNarrator(owner.uid, edition.voiceId);
  if (voice.status !== 'active') throw new HttpsError('failed-precondition', 'The selected voice is not available (it may have expired or been deleted). Renew it in My Voice.');
  if (p.scope !== 'selection' && p.scope !== 'preview' && voice.approval.state !== 'approved') throw new HttpsError('failed-precondition', 'Approve your voice in My Voice before narrating editions. (Previews work before approval.)');
  if (p.scope === 'preview' && p.passageIds.length !== 1) throw new HttpsError('invalid-argument', 'Preview one passage at a time.');
  const route = routeOfVoice(voice);
  const clips = await clipsOf(edition.id);
  // One narrator per edition: a voice/route/model change re-narrates the whole edition, never a part of it.
  const pin = await editionPin(edition, clips);
  const next: NarrationPin = { voiceId: voice.id, provider: voice.provider ?? 'google_gemini_api', modelId: voice.modelId, pinnedAt: Date.now() };
  if (pin && !samePin(pin, next) && (p.scope === 'passages' || p.scope === 'section')) {
    throw new HttpsError('failed-precondition', `This edition is narrated with ${await pinLabel(pin)}. It is now set to ${await pinLabel(next)}. Generating only part of it would mix two narrators in one article, so nothing was sent. Generate the full edition to re-narrate it with the new voice, or switch the edition back to the earlier voice.`, { pin, next });
  }
  const profile = await loadProfile(owner.uid);
  const inFlight = new Set<string>();
  for (const j of await activeNarratorJobs(owner.uid)) {
    const params = j.params as { editionId?: string; items?: { passageId: string | null }[] };
    if (params.editionId === edition.id) for (const it of params.items ?? []) if (it.passageId) inFlight.add(it.passageId);
  }
  const plan = planNarration({ edition, clips, notebook: profile.pronunciations, voice: { id: voice.id, modelId: voice.modelId }, scope: p.scope, variant: p.variant, passageIds: p.passageIds, sectionId: p.sectionId ?? null, selection: p.selection, force: p.force, inFlight });
  const estimate = { ...(await estimateFor(owner.uid, voice, plan.items.map((i) => i.providerText))) };
  const settings = await getSettings(owner.uid);
  const requests = plan.items.reduce((n, i) => n + i.chunks.length, 0);
  const takes = plan.items.filter((i) => i.take);
  if (takes.length) {
    // A take is ONE request (not split into chunks), then transcribed once with word timings to place chapters
    // and confirm every passage was read.
    const t = PRICING.transcription;
    const sec = estimate.speechSec * (takes.reduce((n, i) => n + i.providerText.length, 0) / Math.max(1, plan.items.reduce((n, i) => n + i.providerText.length, 0)));
    const words = takes.reduce((n, i) => n + i.providerText.split(/\s+/).length, 0);
    const checkUsd = Math.round((((sec * t.audioTokensPerSecond) / 1e6) * t.inputPerM + ((words * 1.2) / 1e6) * t.outputPerM) * 1e5) / 1e5;
    estimate.requests = requests;
    estimate.usd = Math.round((estimate.usd + checkUsd) * 1e5) / 1e5;
    estimate.notes = [...estimate.notes, `Read as one take: ${takes.length === 1 ? 'the whole edition is one request' : `${takes.length} requests, split at section breaks`}. Each take is then transcribed with word timings (${t.modelId}, about $${checkUsd.toFixed(3)} in total) to place chapters and check that every passage was read.`];
  }
  const allowance = await dailyAllowance(route, voice.modelId);
  let allowanceNote: string | null = null;
  let limitProblem: string | null = null;
  const limit = await activeLimit(voice.modelId, route);
  if (limit) limitProblem = limitMessage(limit);
  else if (allowance && allowance.remaining === 0 && requests > 0) limitProblem = `Today’s allowance of ${allowance.limit} requests for ${voice.modelId} on the Gemini Developer API is used (resets ${new Date(allowance.resetAt).toUTCString()}). Nothing was sent.`;
  else if (estimate.usd > profile.settings.generationBudgetUsd) limitProblem = `Estimated $${estimate.usd.toFixed(3)} is above your generation budget of $${profile.settings.generationBudgetUsd.toFixed(2)}. Raise it in Narrator → Settings or generate a section at a time.`;
  if (!limitProblem && allowance && requests > allowance.remaining) {
    allowanceNote = `This needs ${requests} requests, but only ${allowance.remaining} of today’s ${allowance.limit} remain on the Gemini Developer API. The first ${allowance.remaining} passages will be kept; the rest can be generated after the allowance resets (${new Date(allowance.resetAt).toUTCString()}) without paying again for finished work.`;
  }
  try {
    assertWithinLimits(settings, await spendSnapshot(owner.uid), estimate.usd);
  } catch (e) {
    limitProblem = (e as Error).message;
  }
  return { edition, voice, plan, estimate, budgetUsd: profile.settings.generationBudgetUsd, noiseReduction: noiseFor(voice.id, profile.settings), limitProblem, allowance, allowanceNote, pin, next };
}

async function estimate(owner: Owner, p: Req<'estimate'>) {
  const g = await prepareGeneration(owner, p);
  const switching = Boolean(g.pin && !samePin(g.pin, g.next) && PINNING_SCOPES.has(p.scope));
  return {
    items: g.plan.items.map((i) => ({ key: i.key, passageId: i.passageId, chars: i.providerText.length, requests: i.chunks.length })),
    reuse: g.plan.reuse,
    skipped: g.plan.skipped,
    estimate: g.estimate,
    budgetUsd: g.budgetUsd,
    limitProblem: g.limitProblem,
    confirmationRequired: p.scope === 'edition' || g.estimate.usd >= 0.05,
    route: routeOfVoice(g.voice),
    allowance: g.allowance,
    allowanceNote: g.allowanceNote,
    narrator: { pinned: g.pin ? await pinLabel(g.pin) : null, next: await pinLabel(g.next), switching },
  };
}

async function generate(owner: Owner, p: Req<'generate'>) {
  await assertRateLimit(owner.uid, 1, 30);
  const jobId = `nars-${p.requestId}`;
  const existing = await col.jobs().doc(jobId).get();
  if (existing.exists) {
    if (existing.get('ownerUid') !== owner.uid) throw new HttpsError('permission-denied', 'Not allowed.');
    return { jobId, duplicate: true, reused: [] };
  }
  const g = await prepareGeneration(owner, p);
  if (g.limitProblem) throw new HttpsError('failed-precondition', g.limitProblem);
  const needsConfirm = p.scope === 'edition' || g.estimate.usd >= 0.05;
  if (needsConfirm && (p.confirmedUsd === null || p.confirmedUsd + 1e-9 < g.estimate.usd)) throw new HttpsError('failed-precondition', `Confirm the estimated cost ($${g.estimate.usd.toFixed(3)}) to start.`, { estimate: g.estimate });
  // Ready takes with identical inputs become current without a new request.
  for (const r of g.plan.reuse) await ncol.editions().doc(g.edition.id).update({ [`takes.${r.passageId}`]: r.clipId });
  // Pin (or, for a full edition, re-pin) the narrator before any take is made with it.
  if (PINNING_SCOPES.has(p.scope) && (!g.pin || !samePin(g.pin, g.next) || !g.edition.narration)) await ncol.editions().doc(g.edition.id).update({ narration: g.pin && samePin(g.pin, g.next) ? g.pin : g.next });
  if (!g.plan.items.length) return { jobId: null, duplicate: false, reused: g.plan.reuse.map((r) => r.passageId), skipped: g.plan.skipped };
  const label = p.scope === 'selection' ? 'Selection preview' : p.scope === 'preview' ? `Passage preview (${p.variant === 'undirected' ? 'without' : 'with'} directions)` : p.scope === 'edition' ? 'Full edition' : p.scope === 'section' ? 'Section' : g.plan.items.length === 1 ? 'Passage' : `${g.plan.items.length} passages`;
  const pin = await jobPin(g.voice);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(col.jobs().doc(jobId))).exists) return;
    await createJob(owner.uid, { id: jobId, type: 'narrator.speak', label: `${label} · ${g.edition.title}`.slice(0, 160), modelId: g.voice.modelId, params: { kind: p.scope, editionId: g.edition.id, voiceId: g.voice.id, testId: null, modelId: g.voice.modelId, ...pin, noiseReduction: g.noiseReduction, budgetUsd: g.budgetUsd, items: g.plan.items }, estimate: costEstimate(g.estimate.usd, g.estimate.notes, `Speech · ${g.estimate.requests} request(s)`), target: { kind: 'narrator_edition', id: g.edition.id } }, tx);
  });
  await enqueueJob(jobId, 'start');
  return { jobId, duplicate: false, reused: g.plan.reuse.map((r) => r.passageId), skipped: g.plan.skipped, estimate: g.estimate, allowanceNote: g.allowanceNote };
}

async function jobCancel(owner: Owner, p: Req<'jobCancel'>) {
  const ref = col.jobs().doc(p.jobId);
  const job = await owned<JobDoc>(ref as never, owner.uid, 'Job');
  if (!job.type.startsWith('narrator.')) throw new HttpsError('invalid-argument', 'Not a narrator job.');
  if (!(ACTIVE_STATUSES as readonly string[]).includes(job.status)) return { status: job.status, message: 'The job had already finished.' };
  if (job.status === 'queued') {
    await cancelJobDoc(job);
    return { status: 'cancelled', message: 'Cancelled before anything was sent to Google.' };
  }
  await ref.set({ cancelRequested: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { status: job.status, message: job.type === 'narrator.speak' ? 'Stopping. A passage already sent to Google cannot be withdrawn and may still be billed; nothing after it will be sent. Finished passages are kept.' : 'Stopping after the current step.' };
}

async function takeSelect(owner: Owner, p: Req<'takeSelect'>) {
  await loadEdition(owner.uid, p.editionId);
  const clip = await owned<NarratorClipDoc>(ncol.clips(p.editionId).doc(p.clipId) as never, owner.uid, 'Take');
  if (clip.passageId !== p.passageId || clip.status !== 'ready') throw new HttpsError('failed-precondition', 'That take cannot be used for this passage.');
  await ncol.editions().doc(p.editionId).update({ [`takes.${p.passageId}`]: clip.id });
  return { ok: true };
}

async function clipDismiss(owner: Owner, p: Req<'clipDismiss'>) {
  await loadEdition(owner.uid, p.editionId);
  const clip = await owned<NarratorClipDoc>(ncol.clips(p.editionId).doc(p.clipId) as never, owner.uid, 'Take');
  if (clip.status !== 'needs_recovery') return { ok: true };
  await ncol.clips(p.editionId).doc(p.clipId).set({ status: 'failed', error: { code: 'dismissed', message: 'Marked as not usable by you. Check Google usage if you need to know whether it was billed.' } }, { merge: true });
  return { ok: true };
}

async function exportStart(owner: Owner, p: Req<'exportStart'>) {
  const edition = await loadEdition(owner.uid, p.editionId);
  if (!edition.voiceId) throw new HttpsError('failed-precondition', 'This edition has no voice.');
  const voice = await loadNarrator(owner.uid, edition.voiceId);
  const jobId = `nare-${p.requestId}`;
  if ((await col.jobs().doc(jobId).get()).exists) return { jobId, duplicate: true };
  const running = (await activeNarratorJobs(owner.uid)).find((j) => j.type === 'narrator.export' && (j.params as { editionId?: string }).editionId === edition.id);
  if (running) return { jobId: running.id, duplicate: true };
  const profile = await loadProfile(owner.uid);
  const plan = planExport({ edition, clips: await clipsOf(edition.id), notebook: profile.pronunciations, voice: { id: voice.id, modelId: voice.modelId } });
  if (plan.missing.length || plan.stale.length) throw new HttpsError('failed-precondition', `${plan.missing.length ? `${plan.missing.length} passage(s) have no audio` : ''}${plan.missing.length && plan.stale.length ? ' and ' : ''}${plan.stale.length ? `${plan.stale.length} passage(s) have out-of-date audio` : ''}. Generate them before exporting.`, { missing: plan.missing, stale: plan.stale });
  if (!plan.parts.length) throw new HttpsError('failed-precondition', 'Nothing to export yet.');
  const exportsSnap = await ncol.exports(edition.id).get();
  const version = exportsSnap.size + 1;
  const exportRef = ncol.exports(edition.id).doc();
  const fileNames = exportFileNames(edition.title, edition.publishedDate, version);
  const target = loudnessTarget(profile.settings);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(col.jobs().doc(jobId))).exists) return;
    const doc: NarratorExportDoc = { ownerUid: owner.uid, editionId: edition.id, version, status: 'rendering', jobId, parts: [], sections: [], durationSec: null, channels: profile.settings.channels, target, before: null, after: null, files: { wav: null, mp3: null, transcript: null, chapters: null }, fileNames, peaks: null, processing: [], error: null };
    tx.set(exportRef, { ...doc, createdAt: FieldValue.serverTimestamp() });
    await createJob(owner.uid, { id: jobId, type: 'narrator.export', label: `Export v${version} · ${edition.title}`.slice(0, 160), modelId: null, params: { editionId: edition.id, exportId: exportRef.id, parts: plan.parts, pauses: edition.settings.pauses, channels: profile.settings.channels, target, noiseReduction: noiseFor(voice.id, profile.settings) }, estimate: costEstimate(0, ['Assembled and normalised inside AZ Studio’s worker; no model is called.'], 'Assembly (no model cost)'), target: { kind: 'narrator_edition', id: edition.id, sub: exportRef.id } }, tx);
  });
  await enqueueJob(jobId, 'start');
  return { jobId, exportId: exportRef.id, duplicate: false };
}

async function mediaUrl(owner: Owner, p: Req<'mediaUrl'>) {
  let storagePath: string | null;
  let downloadName: string | undefined;
  if (p.kind === 'recording') storagePath = (await owned<NarratorRecordingDoc>(ncol.recordings().doc(p.id) as never, owner.uid, 'Recording')).storagePath;
  else if (p.kind === 'test') {
    if (!p.voiceId) throw new HttpsError('invalid-argument', 'voiceId is required.');
    await loadVoice(owner.uid, p.voiceId);
    storagePath = (await owned<NarratorTestDoc>(ncol.tests(p.voiceId).doc(p.id) as never, owner.uid, 'Test')).storagePath;
  } else if (p.kind === 'clip') {
    if (!p.editionId) throw new HttpsError('invalid-argument', 'editionId is required.');
    storagePath = (await owned<NarratorClipDoc>(ncol.clips(p.editionId).doc(p.id) as never, owner.uid, 'Take')).storagePath;
  } else {
    if (!p.editionId) throw new HttpsError('invalid-argument', 'editionId is required.');
    const ex = await owned<NarratorExportDoc>(ncol.exports(p.editionId).doc(p.id) as never, owner.uid, 'Export');
    const file = p.file ?? 'mp3';
    storagePath = ex.files[file];
    downloadName = p.download ? ex.fileNames[file] : undefined;
  }
  if (!storagePath) throw new HttpsError('not-found', 'This audio is no longer available.');
  return signedReadUrl(storagePath, { ttlSeconds: NARRATOR_URL_TTL_SEC, ...(downloadName ? { downloadName } : {}) });
}

async function soundcloudSave(owner: Owner, p: Req<'soundcloudSave'>) {
  const e = await loadEdition(owner.uid, p.editionId);
  if (p.input === null) {
    await ncol.editions().doc(e.id).update({ 'soundcloud.link': null });
    return { link: null };
  }
  const parsed = parseSoundCloudInput(p.input);
  if (!parsed.ok) throw new HttpsError('invalid-argument', parsed.error);
  const link = { trackUrl: parsed.trackUrl, playerSrc: parsed.playerSrc, pageUrl: parsed.pageUrl, savedAt: Date.now() };
  await ncol.editions().doc(e.id).update({ 'soundcloud.link': link });
  return { link, embeds: { theme: bloggerEmbedHtml(link, e.title, 'theme'), standalone: bloggerEmbedHtml(link, e.title, 'standalone') } };
}

/**
 * Auto-direct: a reasoning-model job that only suggests delivery directions. It never synthesises speech,
 * never changes the script and never publishes; the editor merges its suggestions for review.
 */
async function autodirect(owner: Owner, p: Req<'autodirect'>) {
  await assertRateLimit(owner.uid, 1, 10);
  const edition = await loadEdition(owner.uid, p.editionId);
  const jobId = `nard-${p.requestId}`;
  if ((await col.jobs().doc(jobId).get()).exists) return { jobId, duplicate: true };
  const running = (await activeNarratorJobs(owner.uid)).find((j) => j.type === 'narrator.direct' && (j.params as { editionId?: string }).editionId === edition.id);
  if (running) return { jobId: running.id, duplicate: true };
  const want = new Set(p.passageIds);
  const passages = flattenScript(edition.script, edition.settings.includeClosing)
    .map((f) => f.passage)
    .filter((x) => !x.skip && x.text.trim() && (!want.size || want.has(x.id)))
    .map((x) => ({ id: x.id, kind: x.kind, text: x.text }));
  if (!passages.length) throw new HttpsError('failed-precondition', 'There is no spoken text to direct.');
  const rates = PRICING.text[MODEL_REGISTRY.reasoning.id];
  const chars = passages.reduce((s, x) => s + x.text.length, 0);
  const batches = Math.ceil(passages.length / 18);
  const inTok = Math.ceil(chars / 4) + batches * 900;
  const outTok = passages.length * 70 + batches * 1500;
  const usd = rates ? Math.round(((inTok / 1e6) * rates.inputPerM + (outTok / 1e6) * rates.outputPerM) * 1e5) / 1e5 : 0;
  assertWithinLimits(await getSettings(owner.uid), await spendSnapshot(owner.uid), usd);
  const vocalAlready = (edition.directions ?? []).filter((d) => d.kind === 'vocal' && d.status !== 'rejected').length;
  await db.runTransaction(async (tx) => {
    if ((await tx.get(col.jobs().doc(jobId))).exists) return;
    await createJob(owner.uid, { id: jobId, type: 'narrator.direct', label: `Auto-direct (${p.intensity}) · ${edition.title}`.slice(0, 160), modelId: MODEL_REGISTRY.reasoning.id, params: { editionId: edition.id, intensity: p.intensity, passages, vocalAlready }, estimate: costEstimate(usd, ['Estimate for the reasoning model reading the script; no speech is generated.'], 'Auto-direct analysis'), target: { kind: 'narrator_edition', id: edition.id } }, tx);
  });
  await enqueueJob(jobId, 'start');
  return { jobId, duplicate: false, estimateUsd: usd, passages: passages.length };
}

// ---------------------------------------------------------------------------

export async function narrator(owner: Owner, p: NarratorRequest): Promise<unknown> {
  switch (p.op) {
    case 'status':
      return status(owner, p);
    case 'recordingUpload':
      return recordingUpload(owner, p);
    case 'recordingDelete':
      await deleteRecording(owner.uid, p.recordingId);
      return { ok: true };
    case 'voiceCreate':
      return voiceCreate(owner, p);
    case 'voiceTest':
      return voiceTest(owner, p);
    case 'voiceAssess':
      return voiceAssess(owner, p);
    case 'voiceRefresh':
      return voiceRefresh(owner, p);
    case 'voiceDelete':
      return voiceDelete(owner, p);
    case 'voiceReconcile':
      return voiceReconcile(owner);
    case 'cloudCheck':
      return cloudCheck(owner, p);
    case 'providerVoiceDelete':
      return providerVoiceDelete(owner, p);
    case 'profileSave':
      return profileSave(owner, p);
    case 'editionCreate':
      return editionCreate(owner, p);
    case 'editionSave':
      return editionSave(owner, p);
    case 'editionDelete':
      return editionDelete(owner, p);
    case 'importUrl':
      return importUrl(owner, p);
    case 'estimate':
      return estimate(owner, p);
    case 'generate':
      return generate(owner, p);
    case 'jobCancel':
      return jobCancel(owner, p);
    case 'takeSelect':
      return takeSelect(owner, p);
    case 'clipDismiss':
      return clipDismiss(owner, p);
    case 'exportStart':
      return exportStart(owner, p);
    case 'mediaUrl':
      return mediaUrl(owner, p);
    case 'soundcloudSave':
      return soundcloudSave(owner, p);
    case 'publish':
      return publish(owner, p);
    case 'unpublish':
      return unpublish(owner, p);
    case 'autodirect':
      return autodirect(owner, p);
    default: {
      const unhandled: never = p;
      throw new HttpsError('invalid-argument', `Unknown narrator operation ${(unhandled as { op?: string }).op ?? ''}.`);
    }
  }
}
