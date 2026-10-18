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
  type PassageKind,
} from '@az-studio/shared';
import { narrationRates } from '../config/pricing';
import { col, db, FieldValue } from '../lib/firebase';
import { enqueueJob, failJob, progress, transition } from '../lib/jobs';
import { renderMasters, writeRawFloat } from '../lib/narrator-audio';
import { previewClipKey, type ExportPart, type PlannedItem } from '../lib/narrator-plan';
import { createVoice, listReplicatedVoices, NarratorProviderError, synthesize } from '../lib/narrator-provider';
import { media, ncol, npath } from '../lib/narrator-store';
import { recordUsage } from '../lib/usage';
import { linkVoice } from '../api/narrator';
import { sweepRetiredRevisions } from '../api/narrator-publish';

const DAY = 86_400_000;
const SLICE_MS = 20 * 60_000;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function providerJobError(e: unknown): JobError {
  if (e instanceof NarratorProviderError) {
    const category = e.kind === 'auth' || e.kind === 'quota' || e.kind === 'not_configured' ? 'auth_quota' : e.kind === 'policy' ? 'policy' : e.kind === 'invalid_request' ? 'invalid_request' : e.kind === 'rate_limited' || e.kind === 'server' ? 'transient' : 'unknown';
    return { code: `provider_${e.kind}`, message: e.message, retryable: false, category, httpStatus: e.httpStatus, providerStatus: e.providerStatus, ambiguous: e.kind === 'ambiguous', remedy: e.kind === 'ambiguous' ? 'retry' : undefined } as JobError;
  }
  return { code: 'internal', message: String((e as Error)?.message ?? e).slice(0, 300), retryable: false };
}

/** Backoff for refused requests (tests shorten it). */
export const narratorRetryTiming = { baseMs: 2000, maxMs: 30_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Requests Google refused outright (rate limit, 5xx) are sent again a bounded number of times; ambiguous ones never. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof NarratorProviderError) || !e.retryable || i >= attempts - 1) throw e;
      await sleep(Math.min(narratorRetryTiming.maxMs, narratorRetryTiming.baseMs * 2 ** i + Math.floor(Math.random() * narratorRetryTiming.baseMs * 0.5)));
    }
  }
}

// ---------------------------------------------------------------------------
// Voice creation
// ---------------------------------------------------------------------------

export async function runNarratorVoiceJob(job: JobDoc): Promise<void> {
  const p = job.params as { voiceId: string; referenceId: string; consentId: string; modelId: string };
  const voiceRef = ncol.voices().doc(p.voiceId);
  const clearLock = () => ncol.runtime(`voice-create-${job.ownerUid}`).delete().catch(() => undefined);
  if (!(await transition(job.id, 'generating', { stage: 'Sending your recordings to Google', progress: 0.2, lease: { until: Date.now() + 10 * 60_000 } }))) return;
  try {
    const [ref, con] = await Promise.all([ncol.recordings().doc(p.referenceId).get(), ncol.recordings().doc(p.consentId).get()]);
    const refPath = ref.get('storagePath') as string | null;
    const conPath = con.get('storagePath') as string | null;
    if (!refPath || !conPath || ref.get('ownerUid') !== job.ownerUid || con.get('ownerUid') !== job.ownerUid) throw Object.assign(new Error('A recording was deleted before the voice could be created.'), { code: 'recording_missing' });
    const [referenceWav, consentWav] = await Promise.all([media.read(refPath), media.read(conPath)]);
    const submittedAt = Date.now();
    await voiceRef.update({ 'consent.submittedAt': submittedAt, updatedAt: FieldValue.serverTimestamp() });
    await col.jobs().doc(job.id).set({ external: { submission: { at: submittedAt, n: 1 } } }, { merge: true });
    let voiceId: string;
    try {
      ({ voiceId } = await createVoice({ modelId: p.modelId, displayName: NARRATOR.voiceDisplayName, referenceWav, consentWav }));
    } catch (e) {
      if (e instanceof NarratorProviderError && e.kind === 'ambiguous') {
        // Google may have created the voice. Look for it instead of sending the recordings again.
        const match = await findCreatedVoice(submittedAt).catch(() => null);
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

async function findCreatedVoice(submittedAt: number): Promise<string | null> {
  const linked = new Set<string>();
  for (const d of (await ncol.voices().get()).docs) {
    const s = await ncol.voicePrivate(d.id).get();
    if (s.exists) linked.add(String(s.get('providerVoiceId')));
  }
  const candidates = (await listReplicatedVoices()).filter((v) => !linked.has(v.id) && v.displayName === NARRATOR.voiceDisplayName && (!v.createTime || Date.parse(v.createTime) >= submittedAt - 120_000));
  return candidates.length === 1 ? candidates[0]!.id : null;
}

// ---------------------------------------------------------------------------
// Speech (tests, previews, passages, sections, editions)
// ---------------------------------------------------------------------------

interface SpeakParams {
  kind: 'audition' | 'selection' | 'passages' | 'section' | 'edition';
  voiceId: string;
  testId: string | null;
  editionId: string | null;
  modelId: string;
  budgetUsd: number;
  items: PlannedItem[];
}

interface SpeakState {
  /** item key → chunk storage paths saved so far. */
  chunks: Record<string, string[]>;
  done: Record<string, string>;
  failed: Record<string, { code: string; message: string; ambiguous: boolean }>;
  inflight: { key: string; chunk: number; at: number } | null;
  spentUsd: number;
  slice: number;
}

const emptyState = (): SpeakState => ({ chunks: {}, done: {}, failed: {}, inflight: null, spentUsd: 0, slice: 0 });

export async function runNarratorSpeakJob(job: JobDoc): Promise<void> {
  if (!(await transition(job.id, 'generating', { stage: 'Generating speech', progress: 0.02, lease: { until: Date.now() + 30 * 60_000 } }))) return;
  await speak(job.id, 0);
}

/** Continuation of a long job (or after a restart): picks up where the saved state ends. */
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
  const state: SpeakState = { ...emptyState(), ...(((job.external ?? {}) as { narrator?: SpeakState }).narrator ?? {}), slice };
  const save = () => jobRef.set({ external: { narrator: state, submission: state.inflight ? { at: state.inflight.at, n: 1 } : null }, lease: { until: Date.now() + 30 * 60_000 }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  const rates = narrationRates(p.modelId);

  // A request that was in flight when a previous worker stopped is ambiguous: never sent again automatically.
  if (state.inflight) {
    state.failed[state.inflight.key] = { code: 'interrupted', message: 'The worker stopped while this passage was being generated. Google may have produced (and billed) it. Retry it yourself when ready — this may charge again.', ambiguous: true };
    state.inflight = null;
    await save();
  }

  let voiceMissing = false;
  try {
    const providerVoiceId = (await ncol.voicePrivate(p.voiceId).get()).get('providerVoiceId') as string | undefined;
    const voiceSnap = await ncol.voices().doc(p.voiceId).get();
    if (!providerVoiceId || voiceSnap.get('status') !== 'active') throw new NarratorProviderError('not_found', 'The voice is no longer available (deleted or expired). Create or renew it in My Voice.');
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
        await progress(job.id, `Speaking ${p.items.length > 1 ? `passage ${p.items.indexOf(item) + 1} of ${p.items.length}` : p.kind === 'audition' ? 'your test' : 'the passage'}${item.chunks.length > 1 ? ` (part ${c + 1} of ${item.chunks.length})` : ''}`, 0.05 + 0.9 * ((n + c / item.chunks.length) / Math.max(1, pending.length)));
        state.inflight = { key: item.key, chunk: c, at: Date.now() };
        await save();
        let result;
        try {
          result = await withRetry(() => synthesize({ modelId: p.modelId, voiceId: providerVoiceId, segments: item.chunks[c]! }));
        } catch (e) {
          state.inflight = null;
          if (e instanceof NarratorProviderError && e.kind === 'not_found') {
            voiceMissing = true;
            throw e;
          }
          if (e instanceof NarratorProviderError && (e.kind === 'auth' || e.kind === 'quota' || e.kind === 'not_configured')) throw e;
          state.failed[item.key] = { code: e instanceof NarratorProviderError ? `provider_${e.kind}` : 'internal', message: e instanceof NarratorProviderError ? e.message : String((e as Error)?.message ?? e).slice(0, 300), ambiguous: e instanceof NarratorProviderError && (e.kind === 'ambiguous' || e.kind === 'unexpected') };
          await save();
          break;
        }
        const usd = Math.round(((result.inputTokens / 1e6) * rates.inputPerM + (result.outputTokens / 1e6) * rates.outputPerM) * 1e6) / 1e6;
        state.spentUsd += usd;
        await recordUsage({ uid: job.ownerUid, projectId: null, jobId: job.id, modelId: p.modelId, kind: 'speech', inputTokens: result.inputTokens, outputTokens: result.outputTokens, thoughtTokens: 0, costUsdOverride: usd, countJob: state.spentUsd === usd });
        const chunkPath = npath.chunk(job.ownerUid, job.id, item.key, c);
        await media.save(chunkPath, result.wav, 'audio/wav');
        state.chunks[item.key] = [...(state.chunks[item.key] ?? []), chunkPath];
        state.inflight = null;
        await save();
      }
      if (!state.failed[item.key] && (state.chunks[item.key] ?? []).length === item.chunks.length) {
        state.done[item.key] = await storeResult(job, p, item, state.chunks[item.key]!);
        await save();
      }
    }
    await ncol.voices().doc(p.voiceId).set({ lastUsedAt: Date.now(), expiresAt: Date.now() + ENROLLMENT.storedVoiceTtlDays * DAY }, { merge: true });
    await finishSpeak(job, p, state, 'done');
  } catch (e) {
    if (voiceMissing) await ncol.voices().doc(p.voiceId).set({ status: 'missing_at_provider', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    for (const rest of p.items.filter((i) => !state.done[i.key] && !state.failed[i.key])) state.failed[rest.key] = { code: 'stopped', message: e instanceof NarratorProviderError ? e.message : 'Stopped.', ambiguous: false };
    await recordFailures(job, p, state);
    await markTest(p, 'failed', null, { code: e instanceof NarratorProviderError ? `provider_${e.kind}` : 'internal', message: e instanceof NarratorProviderError ? e.message : String((e as Error)?.message ?? e).slice(0, 300) });
    await failJob(job, providerJobError(e));
    await cleanupChunks(job);
  }
}

/** Joins a passage's chunks (decoded, trimmed at the joins, short natural pause) into one WAV and records it. */
async function storeResult(job: JobDoc, p: SpeakParams, item: PlannedItem, chunkPaths: string[]): Promise<string> {
  const decoded = await Promise.all(chunkPaths.map(async (cp) => decodePcm16Wav(await media.read(cp))));
  if (decoded.some((d) => !d)) throw new Error('A generated chunk could not be read back.');
  const rate = decoded[0]!.sampleRate;
  const samples = decoded.length === 1 ? decoded[0]!.samples : joinWithPauses(decoded.map((d) => ({ samples: trimClip(d!.samples, rate), pauseAfterSec: CHUNK_JOIN_PAUSE_SEC })), rate).samples;
  const wav = decoded.length === 1 ? await media.read(chunkPaths[0]!) : Buffer.from(encodePcm16Wav(samples, rate));
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
  const clip: NarratorClipDoc = { ownerUid: job.ownerUid, editionId, passageId, version: versions.size + 1, status: 'ready', inputHash: item.inputHash, text: item.text, providerText: item.providerText, style: item.style, voiceId: p.voiceId, modelId: p.modelId, storagePath, durationSec, speechStartSec: bounds?.startSec ?? null, speechEndSec: bounds?.endSec ?? null, peaks, chunks: chunkPaths.length, usageUsd: 0, jobId: job.id, error: null };
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
    const decoded: { samples: Float32Array; part: ExportPart }[] = [];
    for (const [i, part] of p.parts.entries()) {
      if ((await col.jobs().doc(job.id).get()).get('cancelRequested')) {
        await exportRef.set({ status: 'failed', error: { code: 'cancelled', message: 'Cancelled.' } }, { merge: true });
        await transition(job.id, 'cancelled', { stage: 'Cancelled' });
        return;
      }
      await progress(job.id, `Decoding passage ${i + 1} of ${p.parts.length}`, 0.05 + 0.4 * (i / p.parts.length));
      const clip = (await ncol.clips(p.editionId).doc(part.clipId).get()).data() as NarratorClipDoc | undefined;
      if (!clip?.storagePath || clip.inputHash !== part.inputHash) throw new Error('A take changed after the export was requested. Export again.');
      const d = decodePcm16Wav(await media.read(clip.storagePath));
      if (!d) throw new Error('A take could not be decoded.');
      if (d.sampleRate !== rate) throw new Error(`Unexpected sample rate ${d.sampleRate} Hz in a take.`);
      decoded.push({ samples: trimClip(d.samples, rate), part });
    }
    const kinds: PassageKind[] = decoded.map((d) => d.part.kind);
    const joined = joinWithPauses(
      decoded.map((d, i) => {
        const next = decoded[i + 1];
        return { samples: d.samples, pauseAfterSec: next ? pauseBetween(kinds[i]!, kinds[i + 1]!, next.part.sectionId !== d.part.sectionId, p.pauses) : 0 };
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
    const ex = (await exportRef.get()).data() as NarratorExportDoc;
    const parts = decoded.map((d, i) => ({ passageId: d.part.passageId, clipId: d.part.clipId, inputHash: d.part.inputHash, startSec: r3(joined.spans[i]!.startSec + offset), endSec: r3(joined.spans[i]!.endSec + offset), sectionId: d.part.sectionId, kind: d.part.kind }));
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
  await sweepRetiredRevisions(now);
  void db;
  return { recordingsDeleted };
}
