import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from 'firebase-functions';
import {
  CHUNK_JOIN_PAUSE_SEC,
  ENROLLMENT,
  NARRATOR,
  RETENTION,
  decodePcm16Wav,
  encodePcm16Wav,
  googleVoiceOf,
  joinWithPauses,
  pauseBetween,
  peaksFor,
  sectionTitleOf,
  sectionsText,
  speechBounds,
  transcriptText,
  trimClip,
  type JobDoc,
  type JobError,
  type NarratorClipDoc,
  type NarratorEditionDoc,
  type NarratorExportDoc,
  type NarratorPauses,
  type NarratorRoute,
  type NarratorVoiceDoc,
  type NoiseReduction,
  routeOfVoice,
  alignTakeSpans,
  alignSpansFromWords,
  applyFades,
} from '@az-studio/shared';
import { PRICING } from '../config/pricing';
import { transcribe as transcribeAudio } from '../lib/audio-models';
import { narrationRates } from '../config/pricing';
import { col, db, FieldValue } from '../lib/firebase';
import { enqueueJob, failJob, progress, transition } from '../lib/jobs';
import { reduceNoise, renderMasters, writeRawFloat } from '../lib/narrator-audio';
import { previewClipKey, type ExportPart, type PlannedItem } from '../lib/narrator-plan';
import { createVoice, listReplicatedVoices, NarratorProviderError, synthesize } from '../lib/narrator-provider';
import { chunkCacheKey, media, ncol, npath, voiceFingerprint } from '../lib/narrator-store';
import { recordUsage } from '../lib/usage';
import { acquireRequest, recordLimit, releaseRequest } from '../lib/narrator-limits';
import { linkVoice, loadProfile } from '../api/narrator';
import { sweepRetiredRevisions } from '../api/narrator-publish';

const DAY = 86_400_000;
const SLICE_MS = 20 * 60_000;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The voice behind a running job is no longer the one it was started with: stop rather than switch narrators. */
class PinChangedError extends Error {}

function providerJobError(e: unknown): JobError {
  if (e instanceof PinChangedError) return { code: 'pin_changed', message: e.message, retryable: false };
  if (e instanceof NarratorProviderError) {
    const category = e.kind === 'auth' || e.kind === 'quota' || e.kind === 'not_configured' ? 'auth_quota' : e.kind === 'policy' ? 'policy' : e.kind === 'invalid_request' ? 'invalid_request' : e.kind === 'rate_limited' || e.kind === 'server' ? 'transient' : 'unknown';
    return { code: `provider_${e.kind}`, message: e.message, retryable: false, category, httpStatus: e.httpStatus, providerStatus: e.providerStatus, ambiguous: e.kind === 'ambiguous', remedy: e.kind === 'ambiguous' ? 'retry' : undefined } as JobError;
  }
  return { code: 'internal', message: String((e as Error)?.message ?? e).slice(0, 300), retryable: false };
}

/**
 * Backoff for refused requests and waits for the shared request gate (tests shorten them). In-process waits stay
 * short; anything longer parks the job (state saved, a delayed continuation task) instead of holding a worker.
 */
export const narratorRetryTiming = { baseMs: 2000, maxMs: 30_000, gateWaitMs: 25_000, parkBaseMs: 30_000, parkMaxMs: 15 * 60_000 };
const MAX_BACKOFF_PARKS = 6;
const MAX_GATE_PARKS = 120;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Equal jitter: half the delay fixed, half random (spreads workers that were refused together). */
export const jitter = (ms: number) => Math.round(ms / 2 + Math.random() * (ms / 2));

/**
 * Requests Google refused outright (rate limit, 5xx) are sent again a bounded number of times, honouring the
 * retry time Google gives; ambiguous ones never. A requested wait longer than `maxMs` is not slept here — the
 * error goes back to the caller, which parks the job.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof NarratorProviderError) || !e.retryable || i >= attempts - 1) throw e;
      const asked = (e.retryAfterSec ?? 0) * 1000;
      if (asked > narratorRetryTiming.maxMs) throw e;
      await sleep(jitter(Math.min(narratorRetryTiming.maxMs, Math.max(asked, narratorRetryTiming.baseMs * 2 ** i))));
    }
  }
}

type GateWait = { ok: true } | { ok: false; reason: 'busy' | 'daily'; waitMs: number; resetAt: number | null; used: number; limit: number | null };

/** Waits briefly for a place in the shared request queue; returns the refusal when the wait would be long. */
async function waitForGate(route: NarratorRoute, modelId: string, holder: string): Promise<GateWait> {
  const until = Date.now() + narratorRetryTiming.gateWaitMs;
  for (;;) {
    const g = await acquireRequest(route, modelId, holder);
    if (g.ok || g.reason === 'daily' || Date.now() + g.waitMs > until) return g.ok ? { ok: true } : g;
    await sleep(jitter(Math.min(3000, Math.max(50, g.waitMs))));
  }
}

// ---------------------------------------------------------------------------
// Voice creation
// ---------------------------------------------------------------------------

/** Standard noise reduction of an enrollment WAV (24 kHz mono 16-bit in and out). Unreadable audio is sent as is. */
async function cleanEnrollment(wav: Buffer): Promise<Buffer> {
  const d = decodePcm16Wav(wav);
  if (!d || !d.samples.length) return wav;
  return Buffer.from(encodePcm16Wav(await reduceNoise(d.samples, d.sampleRate, 'standard'), d.sampleRate));
}

export async function runNarratorVoiceJob(job: JobDoc): Promise<void> {
  const p = job.params as { voiceId: string; referenceId: string; consentId: string; modelId: string; route?: NarratorRoute };
  const route: NarratorRoute = p.route ?? 'developer';
  const voiceRef = ncol.voices().doc(p.voiceId);
  const clearLock = () => ncol.runtime(`voice-create-${job.ownerUid}`).delete().catch(() => undefined);
  if (!(await transition(job.id, 'generating', { stage: 'Sending your recordings to Google', progress: 0.2, lease: { until: Date.now() + 10 * 60_000 } }))) return;
  try {
    const [ref, con] = await Promise.all([ncol.recordings().doc(p.referenceId).get(), ncol.recordings().doc(p.consentId).get()]);
    const refPath = ref.get('storagePath') as string | null;
    const conPath = con.get('storagePath') as string | null;
    if (!refPath || !conPath || ref.get('ownerUid') !== job.ownerUid || con.get('ownerUid') !== job.ownerUid) throw Object.assign(new Error('A recording was deleted before the voice could be created.'), { code: 'recording_missing' });
    const [rawReference, rawConsent] = await Promise.all([media.read(refPath), media.read(conPath)]);
    // A replicated voice reproduces the room it was recorded in. Both clips are cleaned the same way (never with
    // the gate: enrollment keeps every breath and word ending) so Google compares like with like.
    const clean = (await loadProfile(job.ownerUid)).settings.noiseReduction !== 'off';
    const [referenceWav, consentWav] = clean ? await Promise.all([cleanEnrollment(rawReference), cleanEnrollment(rawConsent)]) : [rawReference, rawConsent];
    const submittedAt = Date.now();
    await voiceRef.update({ 'consent.submittedAt': submittedAt, updatedAt: FieldValue.serverTimestamp() });
    await col.jobs().doc(job.id).set({ external: { submission: { at: submittedAt, n: 1 } } }, { merge: true });
    let voiceId: string;
    try {
      ({ voiceId } = await createVoice({ route, modelId: p.modelId, displayName: NARRATOR.voiceDisplayName, referenceWav, consentWav }));
    } catch (e) {
      if (e instanceof NarratorProviderError && e.kind === 'ambiguous') {
        // Google may have created the voice. Look for it instead of sending the recordings again.
        const match = await findCreatedVoice(submittedAt, route).catch(() => null);
        if (!match) {
          await voiceRef.set({ status: 'needs_recovery', error: { code: 'ambiguous', message: `${e.message} Use “Check Google for voices” in Narrator → Settings before trying again.` }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
          throw e;
        }
        voiceId = match;
      } else throw e;
    }
    await col.jobs().doc(job.id).set({ external: { submission: null } }, { merge: true });
    await linkVoice(p.voiceId, voiceId, Date.now());
    // Retention: the consent clip has served its purpose; the reference stays a while for comparison.
    if (conPath) await media.remove(conPath);
    await ncol.recordings().doc(p.consentId).set({ status: 'deleted', storagePath: null, usedByVoiceId: p.voiceId, deletedAt: FieldValue.serverTimestamp() }, { merge: true });
    await ncol.recordings().doc(p.referenceId).set({ usedByVoiceId: p.voiceId, deleteAfter: Date.now() + RETENTION.referenceAfterCreateDays * DAY }, { merge: true });
    await transition(job.id, 'completed', { stage: 'Voice created — Google verified the consent recording', result: { data: { voiceId: p.voiceId } } });
  } catch (e) {
    const err = (e as { code?: string }).code === 'recording_missing' ? { code: 'recording_missing', message: (e as Error).message, retryable: false } : providerJobError(e);
    const snap = await voiceRef.get();
    if (snap.get('status') === 'creating') {
      const rejected = e instanceof NarratorProviderError && (e.kind === 'policy' || e.kind === 'invalid_request');
      await voiceRef.update({ status: 'failed', 'consent.state': rejected ? 'rejected' : 'pending', 'consent.message': rejected ? err.message : null, error: { code: err.code, message: err.message }, updatedAt: FieldValue.serverTimestamp() });
    }
    await failJob(job, err);
  } finally {
    await clearLock();
  }
}

async function findCreatedVoice(submittedAt: number, route: NarratorRoute): Promise<string | null> {
  const linked = new Set<string>();
  for (const d of (await ncol.voices().get()).docs) {
    const s = await ncol.voicePrivate(d.id).get();
    if (s.exists) linked.add(String(s.get('providerVoiceId')));
  }
  const candidates = (await listReplicatedVoices(route)).filter((v) => !linked.has(v.id) && v.displayName === NARRATOR.voiceDisplayName && (!v.createTime || Date.parse(v.createTime) >= submittedAt - 120_000));
  return candidates.length === 1 ? candidates[0]!.id : null;
}

// ---------------------------------------------------------------------------
// Speech (tests, previews, passages, sections, editions)
// ---------------------------------------------------------------------------

interface SpeakParams {
  kind: 'audition' | 'selection' | 'passages' | 'section' | 'edition';
  /** A voice profile (`v-…`) or a prebuilt Google voice (`google-<Name>`). */
  voiceId: string;
  /** Background-noise reduction for the finished audio (absent on older jobs: none). */
  noiseReduction?: NoiseReduction;
  testId: string | null;
  editionId: string | null;
  modelId: string;
  /** The voice store the job was planned for (absent on jobs created before routes = developer). */
  route?: NarratorRoute;
  /**
   * Fingerprint of the provider voice the job was planned with (not the id itself: job documents are
   * owner-readable, provider ids are server-only). A different voice behind the profile stops the job.
   */
  voiceFingerprint?: string | null;
  budgetUsd: number;
  items: PlannedItem[];
}

interface SpeakState {
  /** item key → chunk storage paths saved so far (cached chunk audio, see `npath.cachedChunk`). */
  chunks: Record<string, string[]>;
  done: Record<string, string>;
  failed: Record<string, { code: string; message: string; ambiguous: boolean }>;
  inflight: { key: string; chunk: number; at: number } | null;
  spentUsd: number;
  slice: number;
  /** Times the job was parked after refused requests (bounded) and while waiting for the request gate. */
  backoffs?: number;
  gateParks?: number;
  /** Chunks taken from audio paid for by an earlier attempt instead of a new request. */
  reusedChunks?: number;
}

const emptyState = (): SpeakState => ({ chunks: {}, done: {}, failed: {}, inflight: null, spentUsd: 0, slice: 0, backoffs: 0, gateParks: 0, reusedChunks: 0 });

export async function runNarratorSpeakJob(job: JobDoc): Promise<void> {
  if (!(await transition(job.id, 'generating', { stage: 'Generating speech', progress: 0.02, lease: { until: Date.now() + 30 * 60_000 } }))) return;
  await speak(job.id, 0);
}

/** Continuation of a long or parked job (or after a restart): picks up where the saved state ends. */
export async function continueNarratorSpeakJob(job: JobDoc, seq: number): Promise<void> {
  const state = ((job.external ?? {}) as { narrator?: SpeakState }).narrator;
  if (job.status !== 'generating' || !state || state.slice !== seq) return;
  await speak(job.id, seq);
}

async function speak(jobId: string, slice: number): Promise<void> {
  const started = Date.now();
  const jobRef = col.jobs().doc(jobId);
  const job = { ...((await jobRef.get()).data() as JobDoc), id: jobId };
  const p = job.params as unknown as SpeakParams;
  const route: NarratorRoute = p.route ?? 'developer';
  const state: SpeakState = { ...emptyState(), ...(((job.external ?? {}) as { narrator?: SpeakState }).narrator ?? {}), slice };
  const save = () => jobRef.set({ external: { narrator: state, submission: state.inflight ? { at: state.inflight.at, n: 1 } : null }, lease: { until: Date.now() + 30 * 60_000 }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  /** Saves progress and continues later in a fresh task (finished chunks and passages are kept). */
  const park = async (delayMs: number, stage: string) => {
    state.slice = slice + 1;
    await save();
    await progress(job.id, stage);
    await enqueueJob(job.id, 'poll', { seq: state.slice, delaySec: Math.max(1, Math.ceil(delayMs / 1000)) });
  };
  const rates = narrationRates(p.modelId);

  // A request that was in flight when a previous worker stopped is ambiguous: never sent again automatically.
  if (state.inflight) {
    state.failed[state.inflight.key] = { code: 'interrupted', message: 'The worker stopped while this passage was being generated. Google may have produced (and billed) it. Retry it yourself when ready — this may charge again.', ambiguous: true };
    state.inflight = null;
    await save();
  }

  let voiceMissing = false;
  try {
    // A prebuilt Google voice is addressed by its name on either route; a replicated voice by its provider id.
    const prebuilt = googleVoiceOf(p.voiceId);
    const providerVoiceId = prebuilt ? prebuilt.name : ((await ncol.voicePrivate(p.voiceId).get()).get('providerVoiceId') as string | undefined);
    const voiceSnap = prebuilt ? null : await ncol.voices().doc(p.voiceId).get();
    if (!providerVoiceId || (voiceSnap && voiceSnap.get('status') !== 'active')) throw new NarratorProviderError('not_found', 'The voice is no longer available (deleted or expired). Create or renew it in My Voice.');
    // The narrator is pinned for the whole job: same voice store, same provider voice, same model.
    const fingerprint = voiceFingerprint(providerVoiceId);
    if ((voiceSnap && routeOfVoice(voiceSnap.data() as NarratorVoiceDoc) !== route) || (p.voiceFingerprint && p.voiceFingerprint !== fingerprint)) {
      throw new PinChangedError('The voice behind this profile changed after the job started (it was re-linked or re-created). Stopped so the narrator does not change partway through; finished passages are kept. Generate the rest again to use the current voice.');
    }
    const pending = p.items.filter((i) => !state.done[i.key] && !state.failed[i.key]);
    for (const [n, item] of pending.entries()) {
      for (let c = (state.chunks[item.key] ?? []).length; c < item.chunks.length; c++) {
        if ((await jobRef.get()).get('cancelRequested')) return await finishSpeak(job, p, state, 'cancelled');
        if (Date.now() - started > SLICE_MS) {
          state.slice = slice + 1;
          await save();
          await enqueueJob(job.id, 'poll', { seq: state.slice });
          return;
        }
        if (state.spentUsd > p.budgetUsd * 1.5 + 0.01) {
          for (const rest of p.items.filter((i) => !state.done[i.key] && !state.failed[i.key])) state.failed[rest.key] = { code: 'budget', message: `Stopped: spending reached $${state.spentUsd.toFixed(3)}, well above the $${p.budgetUsd.toFixed(2)} budget for this request.`, ambiguous: false };
          return await finishSpeak(job, p, state, 'done');
        }
        const segments = item.chunks[c]!.segments;
        // Audio already paid for (an earlier attempt that stopped later on) is reused, never requested again.
        const cachePath = npath.cachedChunk(job.ownerUid, chunkCacheKey({ route, modelId: p.modelId, voiceFingerprint: fingerprint, segments }));
        if ((await media.size(cachePath)) !== null) {
          state.chunks[item.key] = [...(state.chunks[item.key] ?? []), cachePath];
          state.reusedChunks = (state.reusedChunks ?? 0) + 1;
          await save();
          continue;
        }
        const where = item.take ? (p.items.length > 1 ? `take ${p.items.indexOf(item) + 1} of ${p.items.length} in one go (${item.take.passageIds.length} passages, about ${Math.max(1, Math.round(item.take.plannedSec / 60))} min)` : `the whole edition in one take (${item.take.passageIds.length} passages)`) : `${p.items.length > 1 ? `passage ${p.items.indexOf(item) + 1} of ${p.items.length}` : p.kind === 'audition' ? 'your test' : 'the passage'}${item.chunks.length > 1 ? ` (part ${c + 1} of ${item.chunks.length})` : ''}`;
        await progress(job.id, `Speaking ${where}`, 0.05 + 0.9 * ((n + c / Math.max(1, item.chunks.length)) / Math.max(1, pending.length)));
        // One shared queue per route and model across every job: bounded concurrency, pacing, daily allowance.
        const holder = `${job.id}:${item.key}:${c}`;
        const gate = await waitForGate(route, p.modelId, holder);
        if (!gate.ok && gate.reason === 'daily') {
          throw new NarratorProviderError('quota', `AZ Studio stopped before sending: today’s allowance of ${gate.limit} requests for ${p.modelId} on the Gemini Developer API is used (${gate.used} sent since 00:00 UTC).`, null, null, Math.ceil(gate.waitMs / 1000));
        }
        if (!gate.ok) {
          if ((state.gateParks ?? 0) >= MAX_GATE_PARKS) throw new NarratorProviderError('rate_limited', 'Other narration kept the request queue busy for too long. Finished passages are kept; generate the rest again.');
          state.gateParks = (state.gateParks ?? 0) + 1;
          return await park(jitter(narratorRetryTiming.parkBaseMs), `Waiting for the request queue · ${where}`);
        }
        state.inflight = { key: item.key, chunk: c, at: Date.now() };
        await save();
        let result;
        try {
          // A whole-article take can take minutes to generate; passages keep the shorter limit.
          result = await withRetry(() => synthesize({ route, modelId: p.modelId, voiceId: providerVoiceId, segments, ...(item.take ? { timeoutMs: 600_000 } : {}) }));
        } catch (e) {
          // A definite refusal (an HTTP error answer) generated nothing and does not count against the allowance.
          const pe = e instanceof NarratorProviderError ? e : null;
          await releaseRequest(route, p.modelId, holder, { refund: Boolean(pe && pe.httpStatus !== null && pe.kind !== 'ambiguous'), exhausted: pe?.kind === 'quota' }).catch(() => undefined);
          state.inflight = null;
          if (pe?.kind === 'not_found') {
            voiceMissing = !prebuilt;
            throw e;
          }
          if (pe && (pe.kind === 'auth' || pe.kind === 'quota' || pe.kind === 'not_configured')) throw e;
          // Still refused after the in-process retries: wait longer in a later task (bounded), never resend ambiguous ones.
          if (pe?.retryable && (state.backoffs ?? 0) < MAX_BACKOFF_PARKS) {
            const delay = Math.min(narratorRetryTiming.parkMaxMs, Math.max((pe.retryAfterSec ?? 0) * 1000, narratorRetryTiming.parkBaseMs * 2 ** (state.backoffs ?? 0)));
            state.backoffs = (state.backoffs ?? 0) + 1;
            return await park(jitter(delay), `Google asked to slow down — continuing in about ${Math.max(1, Math.round(delay / 60_000))} min · ${where}`);
          }
          state.failed[item.key] = { code: pe ? `provider_${pe.kind}` : 'internal', message: pe ? pe.message : String((e as Error)?.message ?? e).slice(0, 300), ambiguous: Boolean(pe && (pe.kind === 'ambiguous' || pe.kind === 'unexpected')) };
          await save();
          break;
        }
        await releaseRequest(route, p.modelId, holder).catch(() => undefined);
        const usd = Math.round(((result.inputTokens / 1e6) * rates.inputPerM + (result.outputTokens / 1e6) * rates.outputPerM) * 1e6) / 1e6;
        state.spentUsd += usd;
        await recordUsage({ uid: job.ownerUid, projectId: null, jobId: job.id, modelId: p.modelId, kind: 'speech', inputTokens: result.inputTokens, outputTokens: result.outputTokens, thoughtTokens: 0, costUsdOverride: usd, countJob: state.spentUsd === usd });
        if (result.finish === 'MAX_TOKENS') {
          // Google stopped at its output limit: the take is cut off. It was billed, but is never kept as a take.
          state.inflight = null;
          state.failed[item.key] = { code: 'take_cut_off', message: `Google stopped this ${item.take ? 'take' : 'passage'} at its length limit (${result.outputTokens.toLocaleString()} audio tokens), so the end is missing. It was billed. Split the article into more sections, or read this edition passage by passage.`, ambiguous: false };
          await save();
          break;
        }
        await media.save(cachePath, result.wav, 'audio/wav');
        state.chunks[item.key] = [...(state.chunks[item.key] ?? []), cachePath];
        state.inflight = null;
        await save();
      }
      if (!state.failed[item.key] && (state.chunks[item.key] ?? []).length === item.chunks.length) {
        // A take is checked against its text (and finished if Google stopped speaking early) before it is kept.
        const prepared = item.take ? await finishTake(job, p, item, state.chunks[item.key]![0]!, { route, voiceId: providerVoiceId, rates }) : undefined;
        if (prepared) state.spentUsd += prepared.extraUsd;
        state.done[item.key] = await storeResult(job, p, item, state.chunks[item.key]!, prepared);
        // The take now holds the audio; its cached chunks are no longer needed.
        for (const cp of state.chunks[item.key]!) await media.remove(cp).catch(() => undefined);
        await save();
      }
    }
    if (!prebuilt) await ncol.voices().doc(p.voiceId).set({ lastUsedAt: Date.now(), expiresAt: Date.now() + ENROLLMENT.storedVoiceTtlDays * DAY }, { merge: true });
    await finishSpeak(job, p, state, 'done');
  } catch (e) {
    if (voiceMissing) await ncol.voices().doc(p.voiceId).set({ status: 'missing_at_provider', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    // A used-up allowance (e.g. requests per day) blocks new requests for this route and model until it resets.
    if (e instanceof NarratorProviderError && e.kind === 'quota') await recordLimit(p.modelId, e, Date.now(), route).catch(() => undefined);
    const why = e instanceof NarratorProviderError || e instanceof PinChangedError ? e.message : 'Stopped.';
    for (const rest of p.items.filter((i) => !state.done[i.key] && !state.failed[i.key])) state.failed[rest.key] = { code: 'stopped', message: why, ambiguous: false };
    await recordFailures(job, p, state);
    const err = providerJobError(e);
    await markTest(p, 'failed', null, { code: err.code, message: err.message });
    await col.jobs().doc(job.id).set({ external: { narrator: state, submission: null } }, { merge: true });
    await failJob(job, err);
    // Cached chunk audio of unfinished passages is kept (a later attempt reuses it instead of paying again).
    await cleanupChunks(job);
  }
}

/** Below this share of the text heard, a take is flagged for listening (names and numbers differ slightly). */
const TAKE_COVERAGE_WARN = 0.85;
/** Silence between the end of a take and the passages read again to finish it (≈ a paragraph break). */
const TAIL_JOIN_GAP_SEC = 0.55;

type TakeCheck = { spans: { startSec: number; endSec: number }[]; heard: boolean[] | null; check: NonNullable<NarratorClipDoc['textCheck']> };

/**
 * Transcribes audio of a take with word timestamps and aligns it with the passages' text: accurate passage
 * spans, and which passages were actually read. Falls back to a pause-based estimate when transcription fails.
 */
async function checkTake(job: JobDoc, texts: string[], weights: number[], wav: Buffer, samples: Float32Array, rate: number): Promise<TakeCheck> {
  try {
    const tr = await transcribeAudio({ data: wav, mimeType: 'audio/wav', languageCode: 'en' });
    const t = PRICING.transcription;
    const usd = Math.round(((tr.usage.input / 1e6) * t.inputPerM + (tr.usage.output / 1e6) * t.outputPerM) * 1e6) / 1e6;
    await recordUsage({ uid: job.ownerUid, projectId: null, jobId: job.id, modelId: tr.modelId, kind: 'transcription', inputTokens: tr.usage.input, outputTokens: tr.usage.output, thoughtTokens: 0, costUsdOverride: usd, countJob: false });
    const a = alignSpansFromWords(texts, tr.words);
    return { spans: a.spans, heard: a.heard, check: { method: 'transcript', coverage: a.coverage, passagesHeard: a.passagesHeard, message: null } };
  } catch (e) {
    logger.warn('narrator take transcription failed', { jobId: job.id, error: String((e as Error)?.message ?? e).slice(0, 200) });
    return { spans: alignTakeSpans(samples, rate, weights), heard: null, check: { method: 'pauses', coverage: null, passagesHeard: null, message: 'Chapter times are estimated: the take could not be transcribed to check it.' } };
  }
}

const listPassages = (idx: number[]) => (idx.length === 1 ? `passage ${idx[0]! + 1}` : `passages ${idx.slice(0, -1).map((i) => i + 1).join(', ')} and ${idx[idx.length - 1]! + 1}`);

/**
 * Checks a finished take and completes it when Google stopped speaking early. Observed live 2026-10-18 (47
 * passages, Reflective delivery): speech ended at 516 s, then 3 minutes of room tone, and the closing was never
 * read. Passages missing at the END are read in one extra request and joined at that passage break (the only
 * join); passages missing in the middle are named so the take can be listened to and re-read.
 */
async function finishTake(job: JobDoc, p: SpeakParams, item: PlannedItem, chunkPath: string, ctx: { route: NarratorRoute; voiceId: string; rates: ReturnType<typeof narrationRates> }): Promise<{ wav: Buffer; spans: { startSec: number; endSec: number }[]; check: NonNullable<NarratorClipDoc['textCheck']>; extraUsd: number }> {
  const take = item.take!;
  const wav = await media.read(chunkPath);
  const d = decodePcm16Wav(wav);
  if (!d) throw new Error('The take could not be read back.');
  const rate = d.sampleRate;
  const first = await checkTake(job, take.texts, take.weights, wav, d.samples, rate);
  if (!first.heard) return { wav, spans: first.spans, check: first.check, extraUsd: 0 };
  const heard = [...first.heard];
  let k = heard.length;
  while (k > 0 && !heard[k - 1]) k--;
  const notes: string[] = [];
  let out = { wav, spans: first.spans, extraUsd: 0 };
  if (k === 0) notes.push('No passage of this take was recognised. Listen to it and read it again.');
  else if (k < heard.length && take.segmentPassage?.length === item.chunks[0]!.segments.length) {
    const missing = heard.length - k;
    const segments = item.chunks[0]!.segments.filter((_, si) => take.segmentPassage![si]! >= k);
    try {
      await progress(job.id, `Google stopped before the end — reading the last ${missing === 1 ? 'passage' : `${missing} passages`} to finish the take`);
      const r = await withRetry(() => synthesize({ route: ctx.route, modelId: p.modelId, voiceId: ctx.voiceId, segments, timeoutMs: 240_000 }));
      const usd = Math.round(((r.inputTokens / 1e6) * ctx.rates.inputPerM + (r.outputTokens / 1e6) * ctx.rates.outputPerM) * 1e6) / 1e6;
      await recordUsage({ uid: job.ownerUid, projectId: null, jobId: job.id, modelId: p.modelId, kind: 'speech', inputTokens: r.inputTokens, outputTokens: r.outputTokens, thoughtTokens: 0, costUsdOverride: usd, countJob: false });
      const tail = decodePcm16Wav(r.wav);
      if (!tail || tail.sampleRate !== rate) throw new Error('the extra passage audio could not be read');
      const tailCheck = await checkTake(job, take.texts.slice(k), take.weights.slice(k), r.wav, tail.samples, rate);
      // The take up to just after its last read passage (the silent ending is dropped), a paragraph-length
      // pause, then the passages read again.
      const cut = Math.min(d.samples.length, Math.round((first.spans[k - 1]!.endSec + 0.25) * rate));
      const head = d.samples.slice(0, cut);
      applyFades(head, rate, 0.01);
      const b = speechBounds(tail.samples, rate);
      const lead = b ? Math.max(0, Math.floor((b.startSec - 0.06) * rate)) : 0;
      const rest = trimClip(tail.samples, rate);
      const gap = Math.round(TAIL_JOIN_GAP_SEC * rate);
      const joined = new Float32Array(head.length + gap + rest.length);
      joined.set(head, 0);
      joined.set(rest, head.length + gap);
      const offset = (head.length + gap - lead) / rate;
      out = { wav: Buffer.from(encodePcm16Wav(joined, rate)), spans: [...first.spans.slice(0, k), ...tailCheck.spans.map((s) => ({ startSec: r3(Math.max(0, s.startSec + offset)), endSec: r3(Math.max(0, s.endSec + offset)) }))], extraUsd: usd };
      for (let i = k; i < heard.length; i++) heard[i] = tailCheck.heard ? Boolean(tailCheck.heard[i - k]) : true;
      notes.push(`Google stopped speaking before the end of this take, so the last ${missing === 1 ? 'passage was' : `${missing} passages were`} read in a second request and joined at that passage break.`);
    } catch (e) {
      notes.push(`Google stopped speaking before the end of this take (${listPassages(Array.from({ length: missing }, (_, i) => k + i))} missing), and reading ${missing === 1 ? 'it' : 'them'} again failed (${String((e as Error)?.message ?? e).slice(0, 120)}). Read this take again.`);
    }
  }
  const unheard = heard.map((h, i) => (h ? -1 : i)).filter((i) => i >= 0);
  if (k > 0 && unheard.length) notes.push(`${listPassages(unheard).replace(/^p/, 'P')} of this take ${unheard.length === 1 ? 'was' : 'were'} not recognised — Google may have skipped ${unheard.length === 1 ? 'it' : 'them'}. Listen, and read the take again if needed.`);
  else if ((first.check.coverage ?? 1) < TAKE_COVERAGE_WARN) notes.push(`Only ${Math.round((first.check.coverage ?? 0) * 100)}% of the words were recognised. Listen before publishing.`);
  return { ...out, check: { ...first.check, passagesHeard: heard.filter(Boolean).length, message: notes.length ? notes.join(' ') : null } };
}

/** Joins a passage's chunks (decoded, trimmed at the joins, short natural pause) into one WAV and records it. */
async function storeResult(job: JobDoc, p: SpeakParams, item: PlannedItem, chunkPaths: string[], prepared?: { wav: Buffer; spans: { startSec: number; endSec: number }[]; check: NonNullable<NarratorClipDoc['textCheck']> }): Promise<string> {
  const decoded = prepared ? [decodePcm16Wav(prepared.wav)] : await Promise.all(chunkPaths.map(async (cp) => decodePcm16Wav(await media.read(cp))));
  if (decoded.some((d) => !d)) throw new Error('A generated chunk could not be read back.');
  const rate = decoded[0]!.sampleRate;
  const joinedSamples = decoded.length === 1 ? decoded[0]!.samples : joinWithPauses(decoded.map((d) => ({ samples: trimClip(d!.samples, rate), pauseAfterSec: CHUNK_JOIN_PAUSE_SEC })), rate).samples;
  // Background noise is removed from the finished audio (the cached chunks stay as Google returned them).
  const noise = p.noiseReduction ?? 'off';
  const samples = await reduceNoise(joinedSamples, rate, noise);
  const wav = noise !== 'off' ? Buffer.from(encodePcm16Wav(samples, rate)) : prepared ? prepared.wav : decoded.length === 1 ? await media.read(chunkPaths[0]!) : Buffer.from(encodePcm16Wav(samples, rate));
  const bounds = speechBounds(samples, rate);
  const durationSec = r3(samples.length / rate);
  const peaks = peaksFor(samples, rate);
  if (p.kind === 'audition' && p.testId) {
    const storagePath = npath.test(job.ownerUid, p.voiceId, p.testId);
    await media.save(storagePath, wav, 'audio/wav');
    await ncol.tests(p.voiceId).doc(p.testId).set({ status: 'ready', storagePath, durationSec, speechSec: bounds ? r3(bounds.endSec - bounds.startSec) : null, peaks }, { merge: true });
    return p.testId;
  }
  const editionId = p.editionId!;
  const clipRef = ncol.clips(editionId).doc();
  const storagePath = npath.clip(job.ownerUid, editionId, clipRef.id);
  await media.save(storagePath, wav, 'audio/wav');
  const passageId = item.previewOf && item.variant ? previewClipKey(item.variant, item.previewOf) : (item.passageId ?? 'preview');
  const versions = await ncol.clips(editionId).where('passageId', '==', passageId).get();
  const clip: NarratorClipDoc = { ownerUid: job.ownerUid, editionId, passageId, version: versions.size + 1, status: 'ready', inputHash: item.inputHash, text: item.text, providerText: item.providerText, style: item.style, voiceId: p.voiceId, modelId: p.modelId, storagePath, durationSec, speechStartSec: bounds?.startSec ?? null, speechEndSec: bounds?.endSec ?? null, peaks, chunks: chunkPaths.length, usageUsd: 0, jobId: job.id, error: null, ...(noise !== 'off' ? { noiseReduction: noise } : {}) };
  if (item.take && prepared) {
    // One continuous take: where each passage sits (chapters, seeking) and whether every passage was read.
    clip.passageIds = item.take.passageIds;
    clip.spans = item.take.passageIds.map((id, i) => ({ passageId: id, ...prepared.spans[i]! }));
    clip.textCheck = prepared.check;
  }
  await clipRef.set({ ...clip, createdAt: FieldValue.serverTimestamp() });
  // The newest take becomes the selected one; earlier takes stay available (never overwritten).
  if (item.passageId) await ncol.editions().doc(editionId).update({ [`takes.${item.passageId}`]: clipRef.id });
  return clipRef.id;
}

async function recordFailures(job: JobDoc, p: SpeakParams, state: SpeakState): Promise<void> {
  if (!p.editionId) return;
  for (const item of p.items) {
    const f = state.failed[item.key];
    if (!f || !item.passageId) continue;
    const versions = await ncol.clips(p.editionId).where('passageId', '==', item.passageId).get();
    const clip: NarratorClipDoc = { ownerUid: job.ownerUid, editionId: p.editionId, passageId: item.passageId, version: versions.size + 1, status: f.ambiguous ? 'needs_recovery' : 'failed', inputHash: item.inputHash, text: item.text, providerText: item.providerText, style: item.style, voiceId: p.voiceId, modelId: p.modelId, storagePath: null, durationSec: null, speechStartSec: null, speechEndSec: null, peaks: null, chunks: item.chunks.length, usageUsd: 0, jobId: job.id, error: { code: f.code, message: f.message } };
    await ncol.clips(p.editionId).doc().set({ ...clip, createdAt: FieldValue.serverTimestamp() });
  }
}

async function markTest(p: SpeakParams, status: 'failed' | 'cancelled', _: null, error: { code: string; message: string } | null): Promise<void> {
  if (p.kind !== 'audition' || !p.testId) return;
  const ref = ncol.tests(p.voiceId).doc(p.testId);
  if ((await ref.get()).get('status') === 'generating') await ref.set({ status, error }, { merge: true });
}

async function cleanupChunks(job: JobDoc): Promise<void> {
  try {
    await media.removePrefix(npath.chunkDir(job.ownerUid, job.id));
  } catch (e) {
    logger.warn('narrator chunk cleanup failed', { jobId: job.id, error: String(e) });
  }
}

async function finishSpeak(job: JobDoc, p: SpeakParams, state: SpeakState, how: 'done' | 'cancelled'): Promise<void> {
  if (how === 'cancelled') for (const rest of p.items.filter((i) => !state.done[i.key] && !state.failed[i.key])) state.failed[rest.key] = { code: 'cancelled', message: 'Cancelled before this passage was sent.', ambiguous: false };
  await recordFailures(job, p, { ...state, failed: Object.fromEntries(Object.entries(state.failed).filter(([, f]) => f.code !== 'cancelled')) });
  await col.jobs().doc(job.id).set({ external: { narrator: state, submission: null } }, { merge: true });
  const done = Object.keys(state.done).length;
  const failed = Object.values(state.failed).filter((f) => f.code !== 'cancelled');
  const summary = `${done} of ${p.items.length} ${p.kind === 'audition' ? 'test' : p.items.length === 1 ? 'passage' : 'passages'} ready${failed.length ? ` · ${failed.length} failed${failed.some((f) => f.ambiguous) ? ' (some need recovery)' : ''}` : ''}`;
  const result = { data: { done: state.done, failed: state.failed, spentUsd: state.spentUsd } };
  if (how === 'cancelled') {
    await markTest(p, 'cancelled', null, null);
    await transition(job.id, 'cancelled', { stage: `Cancelled · ${summary}`, result });
  } else if (failed.length) {
    await markTest(p, 'failed', null, { code: failed[0]!.code, message: failed[0]!.message });
    await transition(job.id, 'failed', { stage: summary, result, error: { code: failed.some((f) => f.ambiguous) ? 'needs_recovery' : failed[0]!.code, message: failed.length === 1 ? failed[0]!.message : `${failed.length} passages failed; finished passages are kept. ${failed[0]!.message}`, retryable: false, ambiguous: failed.some((f) => f.ambiguous) } });
  } else await transition(job.id, 'completed', { stage: summary, result });
  await cleanupChunks(job);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

interface ExportParams {
  editionId: string;
  exportId: string;
  parts: ExportPart[];
  pauses: NarratorPauses;
  channels: 1 | 2;
  target: { integratedLufs: number; truePeakDbtp: number };
  /** Cleans takes made before noise reduction (absent on older jobs: none). Takes already cleaned are kept. */
  noiseReduction?: NoiseReduction;
}

export async function runNarratorExportJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as ExportParams;
  const exportRef = ncol.exports(p.editionId).doc(p.exportId);
  if (!(await transition(job.id, 'rendering', { stage: 'Assembling the narration', progress: 0.05, lease: { until: Date.now() + 25 * 60_000 } }))) return;
  const dir = await mkdtemp(path.join(tmpdir(), 'narx-'));
  try {
    const edition = (await ncol.editions().doc(p.editionId).get()).data() as NarratorEditionDoc | undefined;
    if (!edition || edition.ownerUid !== job.ownerUid) throw new Error('The edition no longer exists.');
    const rate = 24_000;
    // Units of audio in order: one passage take (passage mode), or one continuous take holding several passages
    // (one-take mode, decoded once and never cut — pauses are added only between units).
    type Unit = { samples: Float32Array; parts: ExportPart[]; leadSec: number };
    const units: Unit[] = [];
    const noise = p.noiseReduction ?? 'off';
    let cleanedAtExport = 0;
    let cleanedAtTake = 0;
    for (const [i, part] of p.parts.entries()) {
      const prev = units[units.length - 1];
      if (part.take && prev?.parts[0]!.take?.key === part.take.key && prev.parts[0]!.clipId === part.clipId) {
        prev.parts.push(part);
        continue;
      }
      if ((await col.jobs().doc(job.id).get()).get('cancelRequested')) {
        await exportRef.set({ status: 'failed', error: { code: 'cancelled', message: 'Cancelled.' } }, { merge: true });
        await transition(job.id, 'cancelled', { stage: 'Cancelled' });
        return;
      }
      await progress(job.id, part.take ? `Decoding take ${units.length + 1}` : `Decoding passage ${i + 1} of ${p.parts.length}`, 0.05 + 0.4 * (i / p.parts.length));
      const clip = (await ncol.clips(p.editionId).doc(part.clipId).get()).data() as NarratorClipDoc | undefined;
      if (!clip?.storagePath || clip.inputHash !== part.inputHash) throw new Error('A take changed after the export was requested. Export again.');
      const d = decodePcm16Wav(await media.read(clip.storagePath));
      if (!d) throw new Error('A take could not be decoded.');
      if (d.sampleRate !== rate) throw new Error(`Unexpected sample rate ${d.sampleRate} Hz in a take.`);
      // Takes made before noise reduction are cleaned here (no new request); cleaned takes are never processed twice.
      const already = clip.noiseReduction && clip.noiseReduction !== 'off';
      if (already) cleanedAtTake++;
      const clean = !already && noise !== 'off' ? await reduceNoise(d.samples, rate, noise) : d.samples;
      if (clean !== d.samples) cleanedAtExport++;
      // trimClip keeps 0.06 s before the first speech: passage times inside a take shift by what was cut.
      const b = speechBounds(clean, rate);
      const leadSec = b ? Math.max(0, Math.floor((b.startSec - 0.06) * rate)) / rate : 0;
      units.push({ samples: trimClip(clean, rate), parts: [part], leadSec });
    }
    const joined = joinWithPauses(
      units.map((u, i) => {
        const next = units[i + 1];
        const last = u.parts[u.parts.length - 1]!;
        return { samples: u.samples, pauseAfterSec: next ? pauseBetween(last.kind, next.parts[0]!.kind, next.parts[0]!.sectionId !== last.sectionId, p.pauses) : 0 };
      }),
      rate,
    );
    // Short lead-in and tail of silence so players do not clip the first or last word.
    const padded = new Float32Array(joined.samples.length + Math.round(rate * 0.5) + Math.round(rate * 1.0));
    padded.set(joined.samples, Math.round(rate * 0.5));
    const offset = 0.5;
    await progress(job.id, 'Measuring and normalising loudness', 0.55);
    const raw = path.join(dir, 'joined.f32');
    await writeRawFloat(raw, padded);
    const masters = await renderMasters({ rawPath: raw, rate, dir, channels: p.channels, target: p.target, meta: { title: edition.title, artist: edition.author || NARRATOR.defaultAuthor, album: NARRATOR.publication, date: edition.publishedDate, comment: edition.sourceUrl ?? NARRATOR.site } });
    if (cleanedAtExport || cleanedAtTake) {
      const how = [cleanedAtTake ? `${cleanedAtTake} take${cleanedAtTake === 1 ? '' : 's'} cleaned when generated` : '', cleanedAtExport ? `${cleanedAtExport} older take${cleanedAtExport === 1 ? '' : 's'} cleaned now (${noise})` : ''].filter(Boolean).join(', ');
      masters.processing.unshift(`Background noise reduction before loudness: high-pass and adaptive FFT denoise (FFmpeg afftdn) — ${how}.`);
    }
    const ex = (await exportRef.get()).data() as NarratorExportDoc;
    const parts = units.flatMap((u, i) =>
      u.parts.map((part) => {
        const base = joined.spans[i]!.startSec + offset;
        const len = joined.spans[i]!.endSec - joined.spans[i]!.startSec;
        const start = part.take ? Math.min(len, Math.max(0, part.take.startSec - u.leadSec)) : 0;
        const end = part.take ? Math.min(len, Math.max(start, part.take.endSec - u.leadSec)) : len;
        return { passageId: part.passageId, clipId: part.clipId, inputHash: part.inputHash, startSec: r3(base + start), endSec: r3(base + end), sectionId: part.sectionId, kind: part.kind };
      }),
    );
    const sections: NarratorExportDoc['sections'] = [];
    for (const part of parts) {
      const title = sectionTitleOf(edition.script, part.sectionId, part.kind);
      if (!sections.length || sections[sections.length - 1]!.title !== title || (part.kind !== 'opening' && part.kind !== 'closing' && sections[sections.length - 1]!.sectionId !== part.sectionId)) sections.push({ sectionId: part.sectionId, title, startSec: part.startSec });
    }
    await progress(job.id, 'Saving the WAV master, MP3 and transcript', 0.85);
    const files = {
      wav: npath.exportFile(job.ownerUid, p.editionId, p.exportId, ex.fileNames.wav),
      mp3: npath.exportFile(job.ownerUid, p.editionId, p.exportId, ex.fileNames.mp3),
      transcript: npath.exportFile(job.ownerUid, p.editionId, p.exportId, ex.fileNames.transcript),
      chapters: npath.exportFile(job.ownerUid, p.editionId, p.exportId, ex.fileNames.chapters),
    };
    await media.save(files.wav, await readFile(masters.wavPath), 'audio/wav');
    await media.save(files.mp3, await readFile(masters.mp3Path), 'audio/mpeg');
    await media.save(files.transcript, Buffer.from(transcriptText(edition), 'utf8'), 'text/plain; charset=utf-8');
    await media.save(files.chapters, Buffer.from(sectionsText(sections), 'utf8'), 'text/plain; charset=utf-8');
    const finalWav = decodePcm16Wav(await readFile(masters.wavPath));
    const durationSec = finalWav ? r3(finalWav.samples.length / finalWav.sampleRate) : r3(padded.length / rate);
    await exportRef.set({ status: 'ready', parts, sections, durationSec, before: masters.before, after: masters.after, files, peaks: finalWav ? peaksFor(finalWav.samples, finalWav.sampleRate) : null, processing: masters.processing, error: null }, { merge: true });
    await ncol.editions().doc(p.editionId).update({ lastExportId: p.exportId });
    await transition(job.id, 'completed', { stage: `Export ready · ${Math.round(durationSec / 60)} min · ${masters.after.integratedLufs} LUFS, ${masters.after.truePeakDbtp} dBTP (measured)`, result: { data: { exportId: p.exportId } } });
  } catch (e) {
    const message = String((e as Error)?.message ?? e).slice(0, 300);
    await exportRef.set({ status: 'failed', error: { code: 'export_failed', message } }, { merge: true });
    await failJob(job, { code: 'export_failed', message, retryable: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Retention and cleanup (called from the 10-minute maintenance run). */
export async function narratorMaintenance(now = Date.now()): Promise<{ recordingsDeleted: number }> {
  let recordingsDeleted = 0;
  const due = await ncol.recordings().where('status', '==', 'ready').get();
  for (const d of due.docs) {
    if (Number(d.get('deleteAfter') ?? Infinity) > now) continue;
    const sp = d.get('storagePath') as string | null;
    if (sp) await media.remove(sp);
    await d.ref.set({ status: 'deleted', storagePath: null, deletedAt: FieldValue.serverTimestamp() }, { merge: true });
    recordingsDeleted++;
  }
  // Inbox uploads the API never processed, and replaced published revisions past their grace window.
  for (const p of await media.staleInbox(60 * 60_000).catch(() => [] as string[])) await media.remove(p);
  // Paid-for chunks of passages that never finished are kept for reuse for a while (a daily allowance resets
  // within a day), then removed.
  for (const p of await media.staleUnder('users/*/narrator/chunk-cache/*', RETENTION.chunkDays * DAY).catch(() => [] as string[])) await media.remove(p);
  await sweepRetiredRevisions(now);
  void db;
  return { recordingsDeleted };
}
