/**
 * Structured failures of Google model calls and the bounded retry policy every generation job follows.
 *
 * Categories (what went wrong, never guessed from a bare message when Google says it precisely):
 *  - transient       — timeouts, dropped connections, per-minute rate limits, 500/503/504. Retried with
 *                      truncated exponential backoff and jitter, never longer than Google asks (Retry-After,
 *                      google.rpc.RetryInfo) and never more often than the policy allows.
 *  - invalid_request — malformed payloads, unsupported parameters, model/region mismatches. Resubmitted once
 *                      only when a documented repair changes the request; an unchanged request is never resent.
 *  - policy          — content-policy / safety blocks. One automatic benign rewrite (clarifying accidental
 *                      ambiguity, keeping the creative intent) when the director allows it; then the scene
 *                      waits for the director ("Fix prompt & retry").
 *  - auth_quota      — authentication, permission, billing, disabled APIs and exhausted (daily) quota. Stops at
 *                      once with the specific action to take; automatic retries pause until it changes.
 *  - unknown         — anything Google did not explain. Diagnostics are kept and the director may retry.
 *
 * Sources: Google's Gemini API error reference (https://ai.google.dev/gemini-api/docs/api-errors — e.g.
 * `rate_limit_exceeded` "per-minute or per-second" vs `quota_exceeded` "daily quota", the generation-blocked
 * codes incl. `content_blocked`), AIP-194 (only UNAVAILABLE is always safe to retry automatically;
 * DEADLINE_EXCEEDED must not be retried blindly; RESOURCE_EXHAUSTED retries "may have billing implications";
 * non-idempotent work needs application-level retry logic) and Vertex AI's retry strategy guidance
 * (truncated exponential backoff with jitter for 429 / 5xx). Retrieved 2026-10-03.
 */

export const ERROR_CATEGORIES = ['transient', 'invalid_request', 'policy', 'auth_quota', 'unknown'] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const ERROR_CATEGORY_LABELS: Record<ErrorCategory, string> = {
  transient: 'Temporary service problem',
  invalid_request: 'Request not accepted',
  policy: 'Blocked by content policy',
  auth_quota: 'Access, billing or quota',
  unknown: 'Unclear failure',
};

/** What the director can do next about a job that stopped. */
export const USER_REMEDIES = ['retry', 'fix_prompt', 'resume', 'fix_settings', 'none'] as const;
export type UserRemedy = (typeof USER_REMEDIES)[number];

export const USER_REMEDY_LABELS: Record<UserRemedy, string> = {
  retry: 'Retry',
  fix_prompt: 'Fix prompt & retry',
  resume: 'Resume checking',
  fix_settings: 'Fix the setting, then retry',
  none: 'No retry available',
};

export interface RetryPolicy {
  /** Submission attempts for temporary failures, the first attempt included (Google requests may fail transiently). */
  transientAttempts: number;
  /** Automatic benign prompt rewrites after a content-policy block (0 turns the rewrite off). */
  promptRewrites: number;
  /** Resubmissions with a documented configuration repair after an invalid request. */
  configRepairs: number;
  /** First backoff delay (seconds); doubles per retry, with jitter. */
  baseDelaySec: number;
  /** Longest wait between two automatic attempts (seconds). */
  maxDelaySec: number;
  /** When Google asks to wait longer than this, AZ Studio stops and the director retries later. */
  maxRetryAfterSec: number;
  /** Consecutive failed status checks of an accepted job before AZ Studio stops checking (resumable, never resubmitted). */
  pollFailures: number;
  /** Minutes to keep checking an accepted job before pausing (resumable, never resubmitted). */
  pollMaxWaitMinutes: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  transientAttempts: 3,
  promptRewrites: 1,
  configRepairs: 1,
  baseDelaySec: 8,
  maxDelaySec: 300,
  maxRetryAfterSec: 900,
  pollFailures: 8,
  pollMaxWaitMinutes: 45,
};

/** Bounds enforced on owner-configured policies (Settings → Generation retries). */
export const RETRY_POLICY_LIMITS: Record<keyof RetryPolicy, { min: number; max: number }> = {
  transientAttempts: { min: 1, max: 5 },
  promptRewrites: { min: 0, max: 1 },
  configRepairs: { min: 0, max: 1 },
  baseDelaySec: { min: 2, max: 120 },
  maxDelaySec: { min: 10, max: 900 },
  maxRetryAfterSec: { min: 30, max: 3600 },
  pollFailures: { min: 2, max: 20 },
  pollMaxWaitMinutes: { min: 10, max: 120 },
};

/** Clamps a stored policy into the supported bounds (older settings documents have none). */
export function resolveRetryPolicy(p: Partial<RetryPolicy> | null | undefined): RetryPolicy {
  const out = { ...DEFAULT_RETRY_POLICY };
  for (const k of Object.keys(DEFAULT_RETRY_POLICY) as (keyof RetryPolicy)[]) {
    const v = p?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(RETRY_POLICY_LIMITS[k].max, Math.max(RETRY_POLICY_LIMITS[k].min, Math.round(v)));
  }
  if (out.maxDelaySec < out.baseDelaySec) out.maxDelaySec = out.baseDelaySec;
  return out;
}

/** How many times each kind of automatic recovery has run for one job. */
export interface RetryCounters {
  /** Requests sent to Google (submissions, not status checks). */
  submissions: number;
  /** Temporary submission failures so far. */
  transient: number;
  /** Automatic prompt rewrites so far. */
  rewrites: number;
  /** Configuration repairs so far. */
  repairs: number;
  /** Consecutive failed status checks of the accepted operation. */
  pollFailures: number;
}

export const EMPTY_RETRY_COUNTERS: RetryCounters = { submissions: 0, transient: 0, rewrites: 0, repairs: 0, pollFailures: 0 };

/** One entry of a job's attempt history (persisted on the job; never contains keys or raw responses). */
export interface GenerationAttempt {
  /** 1-based attempt number within the job. */
  n: number;
  at: number;
  kind: 'submit' | 'poll' | 'rewrite' | 'repair' | 'resume';
  outcome: 'accepted' | 'failed' | 'retrying' | 'stopped' | 'rewritten' | 'repaired' | 'completed';
  category?: ErrorCategory | null;
  code?: string | null;
  httpStatus?: number | null;
  /** Seconds waited before the next attempt. */
  delaySec?: number | null;
  /** Which prompt version was sent (0 = original). */
  promptVersion?: number;
  /** Provider operation id (e.g. the Omni interaction), when one was accepted. */
  operationId?: string | null;
  note?: string;
}

/** Prompt history of a job: the original, any automatic or director revision, and why. */
export interface PromptRevision {
  version: number;
  prompt: string;
  source: 'original' | 'auto_rewrite' | 'director' | 'proposal';
  at: number;
  explanation?: string;
  changes?: string[];
}

export type RetryPhase = 'submit' | 'poll' | 'finish';

export interface RetryInput {
  category: ErrorCategory;
  phase: RetryPhase;
  counters: RetryCounters;
  policy: RetryPolicy;
  /** Seconds Google asked to wait (Retry-After header or RetryInfo). */
  retryAfterSec?: number | null;
  /** The request may have reached Google even though no answer came back (timeout or dropped connection after sending). */
  ambiguous?: boolean;
  /** The request starts billable asynchronous work (an Omni generation): an ambiguous failure is never resent automatically. */
  createsOperation?: boolean;
  /** A documented configuration repair exists for this invalid request. */
  repairAvailable?: boolean;
  /** The job type supports an automatic prompt rewrite and the director allows it. */
  rewriteAllowed?: boolean;
  /** The failure concerns the prompt text (content policy, unsupported language…). */
  promptRelated?: boolean;
  /** An operation was accepted and can be checked again without a new charge. */
  resumable?: boolean;
  cancelled?: boolean;
}

export type RetryDecision =
  | { action: 'retry'; delaySec: number; counters: RetryCounters; note: string }
  | { action: 'poll'; delaySec: number; counters: RetryCounters; note: string }
  | { action: 'repair'; counters: RetryCounters; note: string }
  | { action: 'rewrite'; counters: RetryCounters; note: string }
  | { action: 'stop'; remedy: UserRemedy; counters: RetryCounters; note: string };

/**
 * Truncated exponential backoff with "equal jitter": half the exponential delay is fixed, half random, so
 * retries from many jobs spread out. Never shorter than what Google asked for.
 */
export function backoffDelaySec(retryIndex: number, policy: Pick<RetryPolicy, 'baseDelaySec' | 'maxDelaySec'>, retryAfterSec?: number | null, random: () => number = Math.random): number {
  const exp = Math.min(policy.maxDelaySec, policy.baseDelaySec * 2 ** Math.max(0, retryIndex));
  const jittered = exp / 2 + (exp / 2) * Math.min(1, Math.max(0, random()));
  const floor = typeof retryAfterSec === 'number' && retryAfterSec > 0 ? retryAfterSec : 0;
  return Math.max(1, Math.round(Math.max(jittered, floor)));
}

/** Upper bound on requests sent for one job, whatever mix of failures occurs (no nested retry loops). */
export function maxSubmissions(policy: RetryPolicy): number {
  return policy.transientAttempts + policy.promptRewrites + policy.configRepairs;
}

/**
 * Decides what happens after a failed model call. Pure: the worker applies the decision and persists the
 * counters it returns, so a redelivered task can never retry twice for the same failure.
 */
export function decideRetry(input: RetryInput): RetryDecision {
  const c = { ...input.counters };
  const p = input.policy;
  const stop = (remedy: UserRemedy, note: string): RetryDecision => ({ action: 'stop', remedy, counters: c, note });
  if (input.cancelled) return stop('none', 'Cancelled by the director.');

  if (input.phase === 'poll') {
    // The operation was accepted: never resubmit it; check the same operation again.
    if (input.category === 'transient' || input.category === 'unknown') {
      c.pollFailures += 1;
      if (c.pollFailures >= p.pollFailures) return stop('resume', `Status checks failed ${c.pollFailures} times in a row; the accepted job can be resumed without a new charge.`);
      return { action: 'poll', delaySec: backoffDelaySec(c.pollFailures - 1, p, input.retryAfterSec), counters: c, note: 'Checking the same accepted job again.' };
    }
    if (input.category === 'auth_quota') return stop(input.resumable ? 'resume' : 'fix_settings', 'Status checks were refused; fix access, then resume checking the same job.');
    return stop(input.resumable ? 'resume' : 'retry', 'The accepted job could not be checked.');
  }

  if (input.phase === 'finish') {
    // Google already produced (and may have billed) the result: AZ Studio never pays for it twice automatically.
    return stop(input.resumable ? 'resume' : 'retry', 'The result arrived but could not be saved.');
  }

  const totalCap = maxSubmissions(p);
  switch (input.category) {
    case 'transient': {
      c.transient += 1;
      if (input.ambiguous && input.createsOperation) return stop('retry', 'Google did not confirm whether it accepted the request; it was not resent automatically to avoid a duplicate charge.');
      if (typeof input.retryAfterSec === 'number' && input.retryAfterSec > p.maxRetryAfterSec) return stop('retry', `Google asked to wait ${Math.ceil(input.retryAfterSec / 60)} minutes before trying again.`);
      if (c.transient >= p.transientAttempts) return stop('retry', `Stopped after ${c.transient} temporary failures (limit ${p.transientAttempts}).`);
      if (c.submissions >= totalCap) return stop('retry', `Stopped after ${c.submissions} requests (limit ${totalCap}).`);
      return { action: 'retry', delaySec: backoffDelaySec(c.transient - 1, p, input.retryAfterSec), counters: c, note: `Temporary failure ${c.transient} of ${p.transientAttempts}.` };
    }
    case 'invalid_request': {
      if (input.repairAvailable && c.repairs < p.configRepairs && c.submissions < totalCap) {
        c.repairs += 1;
        return { action: 'repair', counters: c, note: 'Resubmitting once with a documented configuration repair.' };
      }
      return stop(input.promptRelated ? 'fix_prompt' : 'fix_settings', input.repairAvailable ? 'The configuration repair was already used.' : 'No documented repair applies; the unchanged request is not resent.');
    }
    case 'policy': {
      if (input.rewriteAllowed && c.rewrites < p.promptRewrites && c.submissions < totalCap) {
        c.rewrites += 1;
        return { action: 'rewrite', counters: c, note: 'One automatic rewrite to remove accidental ambiguity.' };
      }
      return stop('fix_prompt', c.rewrites > 0 ? 'The rewritten prompt was blocked too; the scene waits for the director.' : 'The blocked prompt is never resent unchanged.');
    }
    case 'auth_quota':
      return stop('fix_settings', 'Automatic retries are paused until access, billing or quota is fixed.');
    default:
      return stop('retry', 'Google gave no clear reason; diagnostics were kept.');
  }
}

/** Short human summary of the attempts made (e.g. "3 attempts · 1 rewrite"). */
export function attemptSummary(c: Partial<RetryCounters> | null | undefined): string {
  if (!c) return '';
  const parts: string[] = [];
  if (c.submissions) parts.push(`${c.submissions} request${c.submissions === 1 ? '' : 's'}`);
  if (c.transient) parts.push(`${c.transient} temporary failure${c.transient === 1 ? '' : 's'}`);
  if (c.rewrites) parts.push(`${c.rewrites} prompt rewrite${c.rewrites === 1 ? '' : 's'}`);
  if (c.repairs) parts.push(`${c.repairs} configuration repair${c.repairs === 1 ? '' : 's'}`);
  if (c.pollFailures) parts.push(`${c.pollFailures} failed status check${c.pollFailures === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** Redacts credentials and signed-URL secrets from any diagnostic text before it is stored or shown. */
export function sanitizeDiagnostics(text: string, max = 700): string {
  let s = String(text ?? '');
  s = s.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-key]');
  s = s.replace(/ya29\.[0-9A-Za-z._-]+/g, '[redacted-token]');
  s = s.replace(/(Bearer\s+)[0-9A-Za-z._~+/=-]+/gi, '$1[redacted]');
  s = s.replace(/((?:^|[?&\s])(?:key|api_key|access_token|token|X-Goog-Signature|X-Goog-Credential|Signature|sig)=)[^&\s"']+/gi, '$1[redacted]');
  s = s.replace(/("(?:api_?key|apiKey|access_token|authorization|x-goog-api-key)"\s*:\s*")[^"]*"/gi, '$1[redacted]"');
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
