import { sanitizeDiagnostics, type ErrorCategory, type JobError } from '@az-studio/shared';
import { PROJECT_ID, RUNTIME_SERVICE_ACCOUNT_EMAIL } from '../config/runtime';

/**
 * Turns whatever a Google model call threw (or a blocked / failed response) into a structured failure:
 * category (transient, invalid request, content policy, access/billing/quota, unknown), Google's own status
 * and reason, how long Google asked to wait, whether the request may have been accepted anyway, and a
 * specific, user-facing explanation. Structured fields (HTTP status, google.rpc details, error codes, block
 * and finish reasons) are read first; message text is only a fallback — an unexplained error is never
 * labelled a safety block.
 *
 * Error vocabularies: Vertex AI / google.rpc canonical codes (INVALID_ARGUMENT, RESOURCE_EXHAUSTED, …) and the
 * Gemini API error codes (`rate_limit_exceeded`, `quota_exceeded`, `content_blocked`, …) documented at
 * https://ai.google.dev/gemini-api/docs/api-errors (retrieved 2026-10-03).
 */

export type Surface = 'vertex' | 'developer-api';

export interface ProviderFailure {
  category: ErrorCategory;
  /** Stable AZ Studio code, e.g. rate_limited, quota_exhausted, content_blocked, model_not_found. */
  code: string;
  /** What happened, in plain words. */
  message: string;
  /** The specific thing to do about it (for access, billing, quota and configuration problems). */
  action?: string;
  httpStatus: number | null;
  providerStatus: string | null;
  reason: string | null;
  retryAfterSec: number | null;
  quotaScope: 'minute' | 'day' | null;
  /** The request may have reached Google although no answer came back. */
  ambiguous: boolean;
  /** The failure concerns the prompt text. */
  promptRelated: boolean;
  /** Sanitised diagnostics (status, reason, quota metric, Google's message excerpt). */
  details: string;
}

export interface ClassifyContext {
  surface?: Surface;
  modelId?: string;
  /** What was being generated, for messages ("video", "image", "transcript"…). */
  what?: string;
}

const GRPC_NAMES: Record<number, string> = {
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
};

/** Gemini API "generation blocked" codes and Vertex block / finish reasons that mean a policy decision. */
export const POLICY_CODES = new Set([
  'safety',
  'prohibited_content',
  'blocklist',
  'spii',
  'image_safety',
  'image_prohibited_content',
  'image_recitation',
  'image_other',
  'recitation',
  'content_blocked',
  'model_armor',
  'jailbreak',
  'other_block',
]);

/** Finish reasons that mean a policy stop (Vertex AI FinishReason). */
export const POLICY_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'RECITATION', 'IMAGE_RECITATION', 'IMAGE_OTHER']);
/** Prompt block reasons (Vertex AI BlockedReason) — every one of them is a policy decision. */
export const POLICY_BLOCK = new Set(['SAFETY', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY', 'MODEL_ARMOR', 'JAILBREAK']);

const POLICY_TEXT = /(responsible ai|request blocked for an? unspecified policy reason|blocked (?:for|by|due to) (?:an? )?(?:unspecified )?(?:safety|policy|content|google)|violat\w* (?:google'?s? )?(?:usage|content|safety|use)[ -]?polic|prohibited[_ ]content|content (?:was )?blocked|sensitive words|safety filters?\b|safety polic|image_safety|unsafe (?:prompt|content)|could not be submitted.{0,80}(?:polic|safety|responsible))/i;

/** Narrow text test used only when Google gave no structured signal. */
export function isPolicyText(text: string): boolean {
  return POLICY_TEXT.test(text);
}

interface Extracted {
  httpStatus: number | null;
  providerStatus: string | null;
  code: string | null;
  message: string;
  reasons: string[];
  domains: string[];
  quota: { id: string; metric: string; description: string }[];
  retryAfterSec: number | null;
  networkCode: string | null;
  timeout: boolean;
  raw: string;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function parseJson(text: string): unknown {
  const t = text.trim();
  const at = t.indexOf('{');
  if (at < 0) return null;
  try {
    return JSON.parse(t.slice(at));
  } catch {
    return null;
  }
}

function durationSeconds(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(v.trim());
    if (m) return Number(m[1]);
  }
  const o = asObject(v);
  if (o && (o.seconds !== undefined || o.nanos !== undefined)) return Number(o.seconds ?? 0) + Number(o.nanos ?? 0) / 1e9;
  return null;
}

function headerRetryAfter(headers: unknown): number | null {
  const get = (name: string): string | null => {
    const h = headers as { get?: (n: string) => string | null } | Record<string, string> | null | undefined;
    if (!h) return null;
    if (typeof (h as { get?: unknown }).get === 'function') return (h as { get: (n: string) => string | null }).get(name);
    const rec = h as Record<string, string>;
    const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
    return key ? String(rec[key]) : null;
  };
  const ms = get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Number(ms) / 1000;
  const ra = get('retry-after');
  if (!ra) return null;
  if (/^\d+(\.\d+)?$/.test(ra.trim())) return Number(ra);
  const at = Date.parse(ra);
  return Number.isFinite(at) ? Math.max(0, (at - Date.now()) / 1000) : null;
}

/** Collects status, codes, google.rpc details and network signals from any error shape the SDKs throw. */
export function extractError(e: unknown): Extracted {
  const out: Extracted = { httpStatus: null, providerStatus: null, code: null, message: '', reasons: [], domains: [], quota: [], retryAfterSec: null, networkCode: null, timeout: false, raw: '' };
  const err = asObject(e) ?? {};
  const message = String((err.message as string | undefined) ?? (typeof e === 'string' ? e : '') ?? '');
  out.raw = message;
  const httpLike = (n: unknown) => (typeof n === 'number' && n >= 100 && n < 600 ? n : null);
  out.httpStatus = httpLike(err.status) ?? httpLike(err.statusCode) ?? (typeof err.code === 'number' && err.code >= 100 ? (err.code as number) : null);
  if (typeof err.code === 'number' && err.code > 0 && err.code < 20) out.providerStatus = GRPC_NAMES[err.code as number] ?? null;
  if (typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code as string) && !/^E[A-Z]+$/.test(err.code as string) && !/^UND_ERR/.test(err.code as string)) out.providerStatus = err.code as string;
  out.retryAfterSec = headerRetryAfter(err.headers);

  // Error payloads: the Interactions client keeps it on `.error` / `.body`; generateContent puts JSON in the message.
  const payloads: unknown[] = [err.error, typeof err.body === 'string' ? parseJson(err.body as string) : err.body, parseJson(message)];
  for (const p of payloads) {
    let o = asObject(p);
    if (!o) continue;
    if (asObject(o.error)) o = asObject(o.error)!;
    if (typeof o.code === 'number') out.httpStatus = out.httpStatus ?? httpLike(o.code);
    if (typeof o.code === 'string') out.code = out.code ?? (o.code as string).toLowerCase();
    if (typeof o.status === 'string') out.providerStatus = out.providerStatus ?? (o.status as string);
    if (typeof o.message === 'string' && !out.message) out.message = o.message as string;
    for (const d of (Array.isArray(o.details) ? o.details : []) as Record<string, unknown>[]) {
      const type = String(d['@type'] ?? '');
      if (type.endsWith('ErrorInfo')) {
        if (d.reason) out.reasons.push(String(d.reason));
        if (d.domain) out.domains.push(String(d.domain));
        const md = asObject(d.metadata);
        if (md?.quota_limit || md?.quota_metric) out.quota.push({ id: String(md.quota_limit ?? ''), metric: String(md.quota_metric ?? ''), description: String(md.quota_limit_value ?? '') });
      } else if (type.endsWith('RetryInfo')) {
        const s = durationSeconds(d.retryDelay ?? d.retry_delay);
        if (s !== null) out.retryAfterSec = Math.max(out.retryAfterSec ?? 0, s);
      } else if (type.endsWith('QuotaFailure')) {
        for (const v of (Array.isArray(d.violations) ? d.violations : []) as Record<string, unknown>[]) out.quota.push({ id: String(v.quotaId ?? v.subject ?? ''), metric: String(v.quotaMetric ?? ''), description: String(v.description ?? '') });
      }
    }
  }
  if (!out.message) out.message = message;

  // Network and timeout signals (fetch / undici / the interactions HTTP client).
  const cause = asObject(err.cause);
  const net = String((cause?.code as string | undefined) ?? (typeof err.code === 'string' ? err.code : '') ?? '');
  if (/^(E[A-Z]+|UND_ERR_[A-Z_]+)$/.test(net)) out.networkCode = net;
  const name = String(err.name ?? '');
  if (/Timeout/i.test(name) || name === 'AbortError' || /timed out|timeout/i.test(message) || /TIMEOUT/.test(net)) out.timeout = true;
  if (!out.networkCode && /fetch failed|socket hang up|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network error|Connection error/i.test(message)) {
    out.networkCode = /ECONNREFUSED/.test(message) ? 'ECONNREFUSED' : /ENOTFOUND/.test(message) ? 'ENOTFOUND' : /EAI_AGAIN/.test(message) ? 'EAI_AGAIN' : /socket hang up|ECONNRESET/.test(message) ? 'ECONNRESET' : 'NETWORK';
  }
  return out;
}

/** Network failures that happen before a request can have been sent (nothing reached Google). */
const PRE_SEND = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

function diag(x: Extracted, extra: string[] = []): string {
  const parts = [x.httpStatus ? `HTTP ${x.httpStatus}` : '', x.providerStatus ?? '', x.code ?? '', x.reasons.length ? `reason ${x.reasons.join(',')}` : '', x.quota.length ? `quota ${x.quota.map((q) => q.metric || q.id).filter(Boolean).join(',')}` : '', x.retryAfterSec !== null ? `retry after ${Math.round(x.retryAfterSec)}s` : '', x.networkCode ?? '', ...extra, x.message || x.raw];
  return sanitizeDiagnostics(parts.filter(Boolean).join(' · '));
}

const modelName = (ctx: ClassifyContext) => (ctx.modelId ? `${ctx.modelId}` : 'the model');
const surfaceName = (ctx: ClassifyContext) => (ctx.surface === 'developer-api' ? 'the Gemini Developer API' : 'Vertex AI');

function failure(category: ErrorCategory, code: string, message: string, x: Extracted, more: Partial<ProviderFailure> = {}): ProviderFailure {
  return {
    category,
    code,
    message,
    httpStatus: x.httpStatus,
    providerStatus: x.providerStatus ?? x.code,
    reason: x.reasons[0] ?? null,
    retryAfterSec: x.retryAfterSec !== null ? Math.round(x.retryAfterSec * 10) / 10 : null,
    quotaScope: null,
    ambiguous: false,
    promptRelated: false,
    details: diag(x),
    ...more,
  };
}

/** Classifies an exception thrown by a Google SDK call (or by AZ Studio's own storage/database calls). */
export function classifyProviderError(e: unknown, ctx: ClassifyContext = {}): ProviderFailure {
  const x = extractError(e);
  const text = `${x.message} ${x.raw}`;
  const status = x.providerStatus?.toUpperCase() ?? '';
  const code = x.code ?? '';
  const http = x.httpStatus;
  const what = ctx.what ?? 'request';

  // Content policy (structured codes first, then Google's own wording).
  if (POLICY_CODES.has(code) || isPolicyText(text)) {
    return failure('policy', code && POLICY_CODES.has(code) ? code : 'safety_blocked', `Google’s content policy blocked this ${what}${code && POLICY_CODES.has(code) ? ` (${code.replace(/_/g, ' ')})` : ''}. The blocked prompt is never resent unchanged.`, x, { promptRelated: true });
  }

  // Access, billing, disabled APIs.
  const reasons = x.reasons.join(' ');
  if (http === 401 || status === 'UNAUTHENTICATED' || code === 'authentication' || /API key not valid|API_KEY_INVALID|invalid authentication credentials/i.test(text)) {
    const keyed = ctx.surface === 'developer-api' || /API key/i.test(text);
    return failure('auth_quota', keyed ? 'api_key_invalid' : 'unauthenticated', keyed ? 'Google rejected the Gemini API key used for this model.' : 'Google rejected the studio’s credentials.', x, {
      action: keyed ? 'Create a new key for the Generative Language API and add it as a new version of the AZ_STUDIO_GEMINI_API_KEY secret (docs/OPERATIONS.md).' : `Check that the functions run as ${RUNTIME_SERVICE_ACCOUNT_EMAIL} and that its credentials are valid.`,
    });
  }
  if (http === 402 || code === 'payment_required') {
    return failure('auth_quota', 'payment_required', `${surfaceName(ctx)} reports the prepaid balance is used up.`, x, { action: 'Top up or update the billing account linked to the key, then retry.' });
  }
  if (/BILLING_DISABLED|billing (?:is )?(?:disabled|not enabled|account)|requires billing/i.test(`${reasons} ${text}`)) {
    return failure('auth_quota', 'billing_disabled', `Billing is disabled for project ${PROJECT_ID}, so Google refused the request.`, x, { action: `Re-enable billing for ${PROJECT_ID} in Google Cloud Console → Billing, then retry.` });
  }
  if (/SERVICE_DISABLED|ACCESS_NOT_CONFIGURED/.test(reasons) || /has not been used in project|(?:API|service) \S* ?(?:has been|is) disabled/i.test(text)) {
    return failure('auth_quota', 'api_disabled', `The Google API needed for ${modelName(ctx)} is disabled for project ${PROJECT_ID}.`, x, { action: `Enable ${/generativelanguage/i.test(text) ? 'generativelanguage.googleapis.com' : 'aiplatform.googleapis.com'} for ${PROJECT_ID} (APIs & Services), wait a few minutes, then retry.` });
  }
  if (http === 403 || status === 'PERMISSION_DENIED' || code === 'permission_denied') {
    return failure('auth_quota', 'permission_denied', `Google denied the studio access to ${modelName(ctx)} or to the media it needs.`, x, {
      action: `Grant ${RUNTIME_SERVICE_ACCOUNT_EMAIL} the Vertex AI User role (roles/aiplatform.user) on ${PROJECT_ID}, and make sure the Vertex AI service agent can read the media bucket.`,
    });
  }

  // Rate limits vs. exhausted quota.
  if (http === 429 || status === 'RESOURCE_EXHAUSTED' || code === 'rate_limit_exceeded' || code === 'quota_exceeded' || code === 'too_many_requests') {
    const quotaText = `${x.quota.map((q) => `${q.id} ${q.metric} ${q.description}`).join(' ')} ${text}`;
    const daily = code === 'quota_exceeded' || /per[_ ]?day|PerDay|daily|requests_per_day/i.test(quotaText);
    if (daily) {
      return failure('auth_quota', 'quota_exhausted', `The daily quota for ${modelName(ctx)} on ${surfaceName(ctx)} is used up.`, x, { quotaScope: 'day', action: `Wait for the daily reset (midnight Pacific time) or request a higher quota in Google Cloud Console → IAM & Admin → Quotas for ${PROJECT_ID}.` });
    }
    return failure('transient', 'rate_limited', `Google is rate-limiting ${modelName(ctx)} right now (requests per minute or shared capacity).`, x, { quotaScope: 'minute' });
  }

  // Requests Google rejected as invalid.
  if (/previous interaction .* invalid state|current state: IN_PROGRESS/i.test(text)) {
    return failure('transient', 'previous_in_progress', 'Gemini Omni is still finalising the previous part; it is ready moments later.', x);
  }
  if (/unable to process speech edits/i.test(text)) {
    return failure('invalid_request', 'speech_edit_unsupported', 'Gemini Omni cannot edit or extend speech in a re-sent video. Regenerate the scene instead.', x);
  }
  if (http === 404 || status === 'NOT_FOUND' || code === 'not_found' || code === 'model_not_found') {
    if (/interaction/i.test(text) && !/model/i.test(text)) return failure('invalid_request', 'interaction_not_found', 'Google no longer has the earlier result this request continues from (results are kept for 7 days).', x);
    return failure('invalid_request', 'model_not_found', `${modelName(ctx)} is not available to project ${PROJECT_ID} on ${surfaceName(ctx)} in this location.`, x, { action: 'AZ Studio never switches models silently. Check Settings → Models; the model registry (functions/src/config/models.ts) holds the verified IDs.' });
  }
  if (code === 'language' || /unsupported language|language is not supported/i.test(text)) {
    return failure('invalid_request', 'unsupported_language', `${modelName(ctx)} does not accept the language of this prompt.`, x, { promptRelated: true, action: 'Write the prompt in English; keep other-language words only as quoted names.' });
  }
  if (http === 400 || http === 416 || http === 422 || http === 501 || ['INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'OUT_OF_RANGE', 'UNIMPLEMENTED'].includes(status) || ['invalid_request', 'parameter_unknown', 'out_of_range', 'failed_precondition', 'unimplemented'].includes(code)) {
    const unknownParam = code === 'parameter_unknown' || /unknown (?:name|field|parameter)|not allowed when|not supported|Unsupported/i.test(text);
    const tooLong = /too long|exceeds the maximum|token count/i.test(text);
    return failure('invalid_request', unknownParam ? 'unsupported_parameter' : tooLong ? 'prompt_too_long' : 'invalid_argument', `Google rejected the ${what} as invalid: ${sanitizeDiagnostics(x.message || x.raw, 220)}`, x, { promptRelated: tooLong });
  }

  // Temporary service problems.
  if (http === 503 || status === 'UNAVAILABLE' || code === 'service_unavailable') return failure('transient', 'service_unavailable', 'Google’s service is temporarily unavailable or overloaded.', x);
  if (http === 500 || http === 502 || status === 'INTERNAL' || code === 'api_error') return failure('transient', 'provider_internal', 'Google reported a temporary internal error.', x);
  if (http === 504 || status === 'DEADLINE_EXCEEDED' || code === 'deadline_exceeded') return failure('transient', 'deadline_exceeded', 'Google could not finish the request in time.', x, { ambiguous: true });
  if (http === 408) return failure('transient', 'request_timeout', 'The request to Google timed out.', x);
  if (http === 409 || status === 'ABORTED' || code === 'aborted') return failure('transient', 'aborted', 'Google aborted the request because of a concurrent change; it can be retried.', x);
  if (x.timeout) return failure('transient', 'timeout', 'No answer came back from Google in time.', x, { ambiguous: true });
  if (x.networkCode) {
    const pre = PRE_SEND.has(x.networkCode);
    return failure('transient', 'connection', pre ? 'AZ Studio could not reach Google (the request was not sent).' : 'The connection to Google dropped while waiting for an answer.', x, { ambiguous: !pre });
  }
  if (status === 'UNKNOWN' || !status) {
    return failure('unknown', 'unexplained', `Google returned an error AZ Studio could not classify${x.message ? `: ${sanitizeDiagnostics(x.message, 200)}` : '.'}`, x);
  }
  return failure('unknown', status.toLowerCase(), `Google returned ${status}${x.message ? `: ${sanitizeDiagnostics(x.message, 200)}` : '.'}`, x);
}

/** A response Google returned without the expected output, read from its block / finish reasons. */
export function classifyBlockedResponse(input: { blockReason?: string | null; blockMessage?: string | null; finishReason?: string | null; finishMessage?: string | null; text?: string | null }, ctx: ClassifyContext = {}): ProviderFailure {
  const x: Extracted = { httpStatus: null, providerStatus: null, code: null, message: [input.blockMessage, input.finishMessage, input.text].filter(Boolean).join(' '), reasons: [], domains: [], quota: [], retryAfterSec: null, networkCode: null, timeout: false, raw: '' };
  const what = ctx.what ?? 'request';
  const block = (input.blockReason ?? '').toUpperCase();
  const finish = (input.finishReason ?? '').toUpperCase();
  if (block && block !== 'BLOCKED_REASON_UNSPECIFIED' && POLICY_BLOCK.has(block)) {
    x.reasons.push(block);
    return failure('policy', block.toLowerCase(), `Google’s content policy blocked this ${what} before generating (${block.toLowerCase().replace(/_/g, ' ')}). The blocked prompt is never resent unchanged.`, x, { promptRelated: true });
  }
  if (finish && POLICY_FINISH.has(finish)) {
    x.reasons.push(finish);
    return failure('policy', finish.toLowerCase(), `Google’s content policy stopped this ${what} (${finish.toLowerCase().replace(/_/g, ' ')}). The blocked prompt is never resent unchanged.`, x, { promptRelated: true });
  }
  if (finish === 'LANGUAGE') {
    x.reasons.push(finish);
    return failure('invalid_request', 'unsupported_language', `${modelName(ctx)} does not support the language of this prompt.`, x, { promptRelated: true, action: 'Write the prompt in English; keep other-language words only as quoted names.' });
  }
  if (finish === 'MAX_TOKENS') {
    x.reasons.push(finish);
    return failure('invalid_request', 'too_long', 'The answer hit the model’s output limit.', x, { promptRelated: true });
  }
  if (finish === 'NO_IMAGE') {
    x.reasons.push(finish);
    return failure('unknown', 'no_image', `${modelName(ctx)} finished without an image and gave no policy reason.`, x);
  }
  if (input.text && isPolicyText(input.text)) return failure('policy', 'safety_blocked', `Google’s content policy blocked this ${what}.`, x, { promptRelated: true });
  if (finish) x.reasons.push(finish);
  return failure('unknown', finish ? `finish_${finish.toLowerCase()}` : 'empty_output', `${modelName(ctx)} returned no ${what}${finish ? ` (finish reason ${finish})` : ''}.`, x);
}

/** A background Omni interaction that ended without a video. */
export function classifyInteractionFailure(it: { status?: string; errors?: { code?: number | string; message?: string }[]; output_text?: string; modelText?: string }, ctx: ClassifyContext = {}): ProviderFailure {
  const errs = it.errors ?? [];
  const codes = errs.map((e) => String(e.code ?? '').toLowerCase()).filter(Boolean);
  const message = [...errs.map((e) => e.message ?? ''), it.modelText ?? '', it.output_text ?? ''].filter(Boolean).join(' ');
  const x: Extracted = { httpStatus: null, providerStatus: it.status ?? null, code: codes[0] ?? null, message, reasons: codes, domains: [], quota: [], retryAfterSec: null, networkCode: null, timeout: false, raw: '' };
  const what = ctx.what ?? 'video';
  const policy = codes.find((c) => POLICY_CODES.has(c));
  if (policy || isPolicyText(message)) {
    return failure('policy', policy ?? 'content_blocked', `Google’s content policy blocked this ${what}${policy ? ` (${policy.replace(/_/g, ' ')})` : ''}. The blocked prompt is never resent unchanged.`, x, { promptRelated: true });
  }
  if (/unable to process speech edits/i.test(message)) return failure('invalid_request', 'speech_edit_unsupported', 'Gemini Omni cannot edit or extend speech in a re-sent video. Regenerate the scene instead.', x);
  // Errors recorded on the interaction use the same vocabulary as request errors.
  if (codes.length || message) {
    const fromCodes = classifyProviderError({ message, error: { code: codes[0], message } }, ctx);
    if (fromCodes.category !== 'unknown') return { ...fromCodes, providerStatus: it.status ?? fromCodes.providerStatus };
  }
  if (it.status === 'budget_exceeded') return failure('invalid_request', 'budget_exceeded', `Gemini Omni stopped: the interaction’s budget was exceeded.`, x);
  if (it.status === 'cancelled') return failure('unknown', 'cancelled_by_provider', 'Gemini Omni cancelled the interaction without a reason.', x);
  return failure('unknown', it.status === 'incomplete' ? 'incomplete' : 'omni_failed', `Gemini Omni did not finish the ${what} (${it.status ?? 'unknown status'})${message ? `: ${sanitizeDiagnostics(message, 200)}` : '.'}`, x);
}

/** The stored form of a failure (sanitised; no raw responses, keys or tokens). */
export function failureToJobError(f: ProviderFailure): JobError {
  return {
    code: f.code,
    message: f.message,
    retryable: f.category === 'transient',
    safety: f.category === 'policy',
    details: f.details,
    category: f.category,
    ...(f.action ? { action: f.action } : {}),
    httpStatus: f.httpStatus,
    providerStatus: f.providerStatus,
    reason: f.reason,
    retryAfterSec: f.retryAfterSec,
    promptRelated: f.promptRelated,
    ambiguous: f.ambiguous,
  };
}
