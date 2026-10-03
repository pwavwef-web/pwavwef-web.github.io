import { logger } from 'firebase-functions';
import {
  decideRetry,
  EMPTY_RETRY_COUNTERS,
  formatDuration,
  isTerminal,
  resolveRetryPolicy,
  type GenerationAttempt,
  type JobDoc,
  type JobError,
  type PromptRevision,
  type RetryCounters,
  type RetryPhase,
  type UserRemedy,
} from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { releaseSlot } from '../lib/concurrency';
import { GenerationFailure, providerFailure } from '../lib/errors';
import { col, FieldValue } from '../lib/firebase';
import { enqueueJob, failJob, getJob, progress, transition, type WorkerPayload } from '../lib/jobs';
import { checkRewrite, configRepairFor, REWRITE_SCHEMA, REWRITE_SYSTEM, rewriteRequest, splitDeclaration } from '../lib/prompt-repair';
import { failureToJobError, type ProviderFailure, type Surface } from '../lib/provider-errors';
import { activeBlock, recordBlock } from '../lib/provider-health';
import { getSettings } from '../lib/usage';
import { callReasoning, usageFor } from './text';

/** Jobs whose request is a creative prompt the director can revise ("Fix prompt & retry"). */
export const PROMPT_JOBS = new Set(['image.generate', 'video.generate']);
/** Only image/video generations (including set reference packs) occupy concurrent-generation slots. */
export const usesSlot = (job: Pick<JobDoc, 'type'>) => job.type === 'image.generate' || job.type === 'video.generate' || job.type === 'reference.pack';

const VERTEX_MODELS = new Set<string>([MODEL_REGISTRY.video.id, MODEL_REGISTRY.image.id, MODEL_REGISTRY.reasoning.id, MODEL_REGISTRY.transcription.id, MODEL_REGISTRY.speech.id]);

export function surfaceOf(job: Pick<JobDoc, 'modelId' | 'type'>): Surface | null {
  if (job.modelId && VERTEX_MODELS.has(job.modelId)) return 'vertex';
  return null;
}

export function whatOf(type: JobDoc['type']): string {
  switch (type) {
    case 'video.generate':
      return 'video';
    case 'image.generate':
    case 'reference.pack':
      return 'image';
    case 'music.generate':
    case 'music.replace_section':
      return 'music';
    case 'speech.generate':
      return 'dialogue audio';
    case 'lyrics.transcribe':
    case 'lyrics.align':
    case 'narration.transcribe':
      return 'transcript';
    default:
      return 'request';
  }
}

async function appendAttempt(job: JobDoc, a: Omit<GenerationAttempt, 'n' | 'at'>): Promise<void> {
  const record: GenerationAttempt = { n: (job.attempts?.length ?? 0) + 1, at: Date.now(), ...a };
  try {
    await col.jobs().doc(job.id).update({ attempts: FieldValue.arrayUnion(record), updatedAt: FieldValue.serverTimestamp() });
  } catch (e) {
    logger.warn('attempt record failed', { jobId: job.id, error: String(e) });
  }
}

/** Counts a request sent to Google (called right before the call). */
export async function noteSubmission(job: Pick<JobDoc, 'id'>): Promise<void> {
  await col.jobs().doc(job.id).update({ 'retry.submissions': FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
}

/** A paused provider (access, billing, exhausted quota) fails new work at once, without calling Google. */
export async function assertProviderAvailable(job: JobDoc): Promise<void> {
  const surface = surfaceOf(job);
  if (!surface) return;
  const block = await activeBlock(surface, job.modelId);
  if (!block) return;
  const until = new Date(block.until).toISOString().slice(0, 16).replace('T', ' ');
  throw new GenerationFailure({
    category: 'auth_quota',
    code: block.code,
    message: `${block.message} Automatic generation is paused until ${until} UTC or until you retry after fixing it.`,
    ...(block.action ? { action: block.action } : {}),
    httpStatus: null,
    providerStatus: 'paused',
    reason: null,
    retryAfterSec: null,
    quotaScope: block.code === 'quota_exhausted' ? 'day' : null,
    ambiguous: false,
    promptRelated: false,
    details: `Paused by an earlier ${block.code} failure at ${new Date(block.at).toISOString()} (no request was sent).`,
  });
}

function phaseFor(job: JobDoc, payload: WorkerPayload, e: unknown): RetryPhase {
  if (e instanceof GenerationFailure) return e.phase;
  if (payload.step === 'poll' && job.type === 'video.generate' && job.external?.interactionId) return job.status === 'downloading' ? 'finish' : 'poll';
  if (job.status === 'downloading') return 'finish';
  return 'submit';
}

/** The remedy actually offered for this job (resume needs an accepted operation; prompt fixes need a prompt). */
function offeredRemedy(remedy: UserRemedy, job: JobDoc): UserRemedy {
  if (remedy === 'resume' && !(job.type === 'video.generate' && job.external?.interactionId)) return 'retry';
  if (remedy === 'fix_prompt' && !PROMPT_JOBS.has(job.type)) return 'none';
  return remedy;
}

function promptVersion(job: JobDoc): number {
  return Math.max(0, ...(job.prompts ?? []).map((p) => p.version));
}

/** The prompt text the director wrote (without Omni's media declaration). */
export function currentPromptBody(job: JobDoc): string {
  const p = job.params as { prompt?: string; promptBody?: string };
  if (job.type === 'video.generate') return splitDeclaration(String(p.prompt ?? '')).body || String(p.promptBody ?? '');
  return String(p.prompt ?? p.promptBody ?? '');
}

/** Params with a revised prompt body (Omni's media declaration is kept verbatim). */
export function withPromptBody(job: JobDoc, body: string): Record<string, unknown> {
  const p = job.params as { prompt?: string };
  if (job.type === 'video.generate') {
    const { declaration } = splitDeclaration(String(p.prompt ?? ''));
    return { ...job.params, prompt: declaration ? `${declaration}\n${body}` : body, promptBody: body };
  }
  return { ...job.params, prompt: body, promptBody: body };
}

export interface RewriteOutcome {
  ok: boolean;
  revised: string;
  explanation: string;
  changes: string[];
  reason: string;
  modelId: string;
}

/** Asks the reasoning model for one benign rewrite of a blocked prompt and checks it deterministically. */
export async function rewriteBlockedPrompt(job: JobDoc, f: Pick<ProviderFailure, 'code' | 'reason' | 'message'>, countUsage = false): Promise<RewriteOutcome> {
  const body = currentPromptBody(job);
  const kind = job.type === 'image.generate' ? 'image' : 'video';
  const r = await callReasoning([{ text: rewriteRequest(kind, body, f) }], { systemInstruction: REWRITE_SYSTEM, responseJsonSchema: REWRITE_SCHEMA }, 'LOW');
  await usageFor(job, r, 'text', countUsage);
  const out = (r.json ?? {}) as { benign?: boolean; revisedPrompt?: string; explanation?: string; changes?: string[] };
  const revised = String(out.revisedPrompt ?? '').trim();
  const check = checkRewrite(body, revised, Boolean(out.benign));
  return { ok: check.ok, revised, explanation: String(out.explanation ?? '').slice(0, 600), changes: (out.changes ?? []).map((c) => String(c).slice(0, 200)).slice(0, 12), reason: check.reason, modelId: r.modelId };
}

function promptHistory(job: JobDoc, add: Omit<PromptRevision, 'version' | 'at'>): PromptRevision[] {
  const history = [...(job.prompts ?? [])];
  if (!history.length) history.push({ version: 0, prompt: currentPromptBody(job), source: 'original', at: Date.now() });
  history.push({ ...add, version: promptVersion({ ...job, prompts: history }) + 1, at: Date.now() });
  return history;
}

/** Stops the job with a remedy the director can act on (and pauses the provider for access/quota problems). */
export async function stopJob(job: JobDoc, f: ProviderFailure, remedy: UserRemedy, note: string, extra: Record<string, unknown> = {}): Promise<void> {
  const offered = offeredRemedy(remedy, job);
  const error: JobError = { ...failureToJobError(f), retryable: false, remedy: offered, resumable: offered === 'resume' };
  if (f.category === 'auth_quota') {
    const surface = surfaceOf(job);
    if (surface && f.providerStatus !== 'paused') await recordBlock(f, { surface, modelId: job.modelId }).catch((e) => logger.warn('could not record provider pause', { error: String(e) }));
  }
  await appendAttempt(job, { kind: 'submit', outcome: 'stopped', category: f.category, code: f.code, httpStatus: f.httpStatus, note, operationId: job.external?.interactionId ?? null, promptVersion: promptVersion(job) });
  if (Object.keys(extra).length) await col.jobs().doc(job.id).set(extra, { merge: true });
  await failJob(job, error);
}

const fmt = (sec: number) => (sec < 90 ? `${Math.round(sec)} s` : formatDuration(sec));

/**
 * Applies the retry policy to a failed job step. Called by the task handler for every failure; each branch
 * persists its counters before acting, so a redelivered task can never retry twice for one failure.
 */
export async function recoverFromFailure(jobId: string, payload: WorkerPayload, e: unknown): Promise<void> {
  const fresh = await getJob(jobId);
  if (!fresh || isTerminal(fresh.status)) return;
  const settings = await getSettings(fresh.ownerUid);
  const policy = resolveRetryPolicy(settings.retryPolicy);
  const gf = providerFailure(e, { modelId: fresh.modelId ?? undefined, what: whatOf(fresh.type), surface: surfaceOf(fresh) ?? undefined, phase: phaseFor(fresh, payload, e) });
  const f = gf.failure;
  const counters: RetryCounters = { ...EMPTY_RETRY_COUNTERS, ...(fresh.retry ?? {}) };
  const inFlight = Boolean(fresh.external?.submission) && !fresh.external?.interactionId;
  const repair = f.category === 'invalid_request' ? configRepairFor(fresh.type, fresh.params, f) : null;
  const decision = decideRetry({
    category: f.category,
    phase: gf.phase,
    counters,
    policy,
    retryAfterSec: f.retryAfterSec,
    ambiguous: f.ambiguous || (inFlight && fresh.type === 'video.generate'),
    createsOperation: fresh.type === 'video.generate',
    repairAvailable: Boolean(repair),
    rewriteAllowed: PROMPT_JOBS.has(fresh.type) && settings.autoPromptRewrite && (fresh.params as { noAutoRewrite?: boolean }).noAutoRewrite !== true,
    promptRelated: f.promptRelated,
    resumable: fresh.type === 'video.generate' && Boolean(fresh.external?.interactionId),
    cancelled: fresh.cancelRequested,
  });
  logger.info('job failure', { jobId, type: fresh.type, category: f.category, code: f.code, http: f.httpStatus, phase: gf.phase, action: decision.action, note: decision.note });
  const base = { category: f.category, code: f.code, httpStatus: f.httpStatus, operationId: fresh.external?.interactionId ?? null, promptVersion: promptVersion(fresh) };
  const lastError = failureToJobError(f);

  switch (decision.action) {
    case 'retry': {
      await appendAttempt(fresh, { ...base, kind: 'submit', outcome: 'retrying', delaySec: decision.delaySec, note: decision.note });
      const ok = await transition(fresh.id, 'queued', {
        attempt: fresh.attempt + 1,
        retry: decision.counters,
        stage: `Retrying in ${fmt(decision.delaySec)} — ${f.message} (${decision.note})`,
        lease: null,
        lastError,
        external: null,
      });
      if (!ok) return;
      if (usesSlot(fresh)) await releaseSlot(fresh.ownerUid, fresh.id);
      await enqueueJob(fresh.id, 'start', { delaySec: decision.delaySec, seq: payload.seq + 1 });
      return;
    }
    case 'poll': {
      await appendAttempt(fresh, { ...base, kind: 'poll', outcome: 'retrying', delaySec: decision.delaySec, note: decision.note });
      await progress(fresh.id, `Checking the accepted job again in ${fmt(decision.delaySec)} — ${f.message}`, undefined, { retry: decision.counters, lastError });
      await enqueueJob(fresh.id, 'poll', { delaySec: decision.delaySec, seq: payload.seq + 1 });
      return;
    }
    case 'repair': {
      if (!repair) return stopJob(fresh, f, 'fix_settings', 'No repair available.');
      await appendAttempt(fresh, { ...base, kind: 'repair', outcome: 'repaired', note: `${repair.change} (${repair.source})` });
      const ok = await transition(fresh.id, 'queued', {
        params: repair.params,
        retry: decision.counters,
        stage: `Resubmitting once with a repaired configuration — ${repair.change}`,
        lease: null,
        lastError,
        external: null,
        repairs: FieldValue.arrayUnion({ at: Date.now(), change: repair.change, source: repair.source, after: f.code }) as unknown as JobDoc['repairs'],
      });
      if (!ok) return;
      if (usesSlot(fresh)) await releaseSlot(fresh.ownerUid, fresh.id);
      await enqueueJob(fresh.id, 'start', { delaySec: 2, seq: payload.seq + 1 });
      return;
    }
    case 'rewrite': {
      // Counters first: a crash during the rewrite can never lead to a second automatic rewrite.
      await col.jobs().doc(fresh.id).set({ retry: decision.counters }, { merge: true });
      await progress(fresh.id, 'Blocked by content policy — rewriting the prompt once to remove accidental ambiguity', undefined);
      let out: RewriteOutcome;
      try {
        out = await rewriteBlockedPrompt(fresh, f);
      } catch (err) {
        logger.warn('automatic rewrite failed', { jobId, error: String(err) });
        return stopJob({ ...fresh, retry: decision.counters }, f, 'fix_prompt', 'The automatic rewrite could not run; revise the prompt.');
      }
      if (!out.ok) {
        const history = out.revised ? promptHistory(fresh, { prompt: out.revised, source: 'proposal', explanation: `${out.explanation} (not sent: ${out.reason})`, changes: out.changes }) : fresh.prompts ?? [];
        return stopJob({ ...fresh, retry: decision.counters }, f, 'fix_prompt', `Automatic rewrite not used: ${out.reason}`, history.length ? { prompts: history } : {});
      }
      const prompts = promptHistory(fresh, { prompt: out.revised, source: 'auto_rewrite', explanation: out.explanation, changes: out.changes });
      await appendAttempt(fresh, { ...base, kind: 'rewrite', outcome: 'rewritten', note: out.explanation.slice(0, 300) });
      const params = withPromptBody(fresh, out.revised);
      const ok = await transition(fresh.id, 'queued', { params, prompts, retry: decision.counters, stage: 'Resubmitting once with the clarified prompt (both versions are kept in the history)', lease: null, lastError, external: null });
      if (!ok) return;
      if (fresh.target?.kind === 'shot' && fresh.projectId && fresh.target.sub) {
        await col.projects().doc(fresh.projectId).collection('shots').doc(fresh.target.id).collection('takes').doc(fresh.target.sub).set({ prompt: params.prompt, promptRevised: true }, { merge: true }).catch(() => undefined);
      }
      if (usesSlot(fresh)) await releaseSlot(fresh.ownerUid, fresh.id);
      await enqueueJob(fresh.id, 'start', { delaySec: 3, seq: payload.seq + 1 });
      return;
    }
    case 'stop':
      return stopJob({ ...fresh, retry: decision.counters }, f, decision.remedy, decision.note, { retry: decision.counters });
  }
}
