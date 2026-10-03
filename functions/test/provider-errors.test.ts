import { describe, expect, it } from 'vitest';
import { classifyBlockedResponse, classifyInteractionFailure, classifyProviderError } from '../src/lib/provider-errors';
import { checkRewrite, configRepairFor, splitDeclaration } from '../src/lib/prompt-repair';
import { blockKey, blockUntil, nextPacificMidnight } from '../src/lib/provider-health';
import { apiError } from './fakes';

/** generateContent errors carry Google's JSON body in the message (as the Gen AI SDK builds them). */
const sdkError = (status: number, body: Record<string, unknown>) => Object.assign(new Error(JSON.stringify({ error: body })), { name: 'ApiError', status });

describe('classifying Google failures (mocked provider errors)', () => {
  it('separates a temporary rate limit from an exhausted daily quota', () => {
    const rate = classifyProviderError(sdkError(429, { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource exhausted. Please try again later.', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }] }), { modelId: 'video-model' });
    expect(rate).toMatchObject({ category: 'transient', code: 'rate_limited', retryAfterSec: 7, quotaScope: 'minute', ambiguous: false });
    const perMinute = classifyProviderError(sdkError(429, { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model.' }));
    expect(perMinute.category).toBe('transient');
    const daily = classifyProviderError(sdkError(429, { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota.', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel', quotaMetric: 'generativelanguage.googleapis.com/generate_requests_per_model_per_day' }] }] }));
    expect(daily).toMatchObject({ category: 'auth_quota', code: 'quota_exhausted', quotaScope: 'day' });
    expect(daily.action).toMatch(/midnight Pacific|quota/i);
    expect(classifyProviderError(apiError(429, { code: 'quota_exceeded', message: 'You have exceeded your daily quota' }))).toMatchObject({ category: 'auth_quota', code: 'quota_exhausted' });
  });

  it('reads Retry-After from the Interactions client headers', () => {
    const f = classifyProviderError(apiError(429, { code: 'rate_limit_exceeded', message: 'Too many requests' }, { 'retry-after': '12' }));
    expect(f).toMatchObject({ category: 'transient', code: 'rate_limited', retryAfterSec: 12 });
  });

  it('names the specific access, billing or API problem', () => {
    expect(classifyProviderError(sdkError(403, { code: 403, status: 'PERMISSION_DENIED', message: 'Vertex AI API has not been used in project 123 before or it is disabled.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com' }] }))).toMatchObject({ category: 'auth_quota', code: 'api_disabled' });
    expect(classifyProviderError(sdkError(403, { code: 403, status: 'PERMISSION_DENIED', message: 'Billing account is disabled', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'BILLING_DISABLED' }] }))).toMatchObject({ category: 'auth_quota', code: 'billing_disabled' });
    const denied = classifyProviderError(sdkError(403, { code: 403, status: 'PERMISSION_DENIED', message: "Permission 'aiplatform.endpoints.predict' denied" }));
    expect(denied).toMatchObject({ category: 'auth_quota', code: 'permission_denied' });
    expect(denied.action).toMatch(/roles\/aiplatform\.user/);
    expect(classifyProviderError(apiError(401, { code: 'authentication', message: 'API key not valid' }), { surface: 'developer-api' })).toMatchObject({ category: 'auth_quota', code: 'api_key_invalid' });
  });

  it('recognises invalid requests and model/region mismatches without calling them safety blocks', () => {
    expect(classifyProviderError(sdkError(400, { code: 400, status: 'INVALID_ARGUMENT', message: 'previous_interaction_id is not allowed when video task is set' }))).toMatchObject({ category: 'invalid_request', code: 'unsupported_parameter', promptRelated: false });
    expect(classifyProviderError(sdkError(404, { code: 404, status: 'NOT_FOUND', message: 'Publisher Model `projects/x/locations/global/publishers/google/models/y` not found.' }))).toMatchObject({ category: 'invalid_request', code: 'model_not_found' });
    expect(classifyProviderError(sdkError(400, { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' }))).toMatchObject({ category: 'invalid_request', code: 'invalid_argument' });
  });

  it('classifies content-policy blocks from codes and Google’s wording', () => {
    expect(classifyProviderError(apiError(400, { code: 'content_blocked', message: 'An unspecified policy reason blocked the request' }))).toMatchObject({ category: 'policy', promptRelated: true });
    expect(classifyProviderError(new Error('Request blocked for an unspecified policy reason.'))).toMatchObject({ category: 'policy' });
    expect(classifyProviderError(sdkError(400, { code: 400, status: 'INVALID_ARGUMENT', message: "The prompt could not be submitted. This prompt contains sensitive words that violate Google's Responsible AI practices." }))).toMatchObject({ category: 'policy' });
  });

  it('treats timeouts and dropped connections as temporary, marking whether the request may have arrived', () => {
    expect(classifyProviderError(sdkError(503, { code: 503, status: 'UNAVAILABLE', message: 'The service is currently unavailable.' }))).toMatchObject({ category: 'transient', code: 'service_unavailable', ambiguous: false });
    expect(classifyProviderError(sdkError(504, { code: 504, status: 'DEADLINE_EXCEEDED', message: 'Deadline expired' }))).toMatchObject({ category: 'transient', ambiguous: true });
    expect(classifyProviderError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toMatchObject({ category: 'transient', code: 'connection', ambiguous: false });
    expect(classifyProviderError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toMatchObject({ category: 'transient', ambiguous: true });
    expect(classifyProviderError(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }))).toMatchObject({ category: 'transient', code: 'timeout', ambiguous: true });
  });

  it('keeps unexplained failures as unknown (never labelled a safety block) with sanitised diagnostics', () => {
    const f = classifyProviderError(new Error('Something odd happened at https://x.googleapis.com/v1?key=AIzaSyA-1234567890abcdefghijklmnop'));
    expect(f).toMatchObject({ category: 'unknown', promptRelated: false });
    expect(f.details).not.toMatch(/AIzaSy/);
  });

  it('reads blocked and empty responses from their block and finish reasons', () => {
    expect(classifyBlockedResponse({ blockReason: 'SAFETY' }, { what: 'image' })).toMatchObject({ category: 'policy', code: 'safety' });
    expect(classifyBlockedResponse({ finishReason: 'IMAGE_SAFETY' })).toMatchObject({ category: 'policy' });
    expect(classifyBlockedResponse({ finishReason: 'NO_IMAGE' })).toMatchObject({ category: 'unknown', code: 'no_image' });
    expect(classifyBlockedResponse({ finishReason: 'LANGUAGE' })).toMatchObject({ category: 'invalid_request', promptRelated: true });
    expect(classifyBlockedResponse({ finishReason: 'STOP' })).toMatchObject({ category: 'unknown' });
  });

  it('reads failed Omni interactions', () => {
    expect(classifyInteractionFailure({ status: 'failed', errors: [{ code: 'content_blocked', message: 'An unspecified policy reason blocked the request' }] })).toMatchObject({ category: 'policy', code: 'content_blocked' });
    expect(classifyInteractionFailure({ status: 'failed', errors: [{ code: 'service_unavailable', message: 'The service is temporarily overloaded' }] })).toMatchObject({ category: 'transient' });
    expect(classifyInteractionFailure({ status: 'failed' })).toMatchObject({ category: 'unknown' });
    expect(classifyInteractionFailure({ status: 'failed', modelText: 'The model is currently unable to process speech edits.' })).toMatchObject({ category: 'invalid_request', code: 'speech_edit_unsupported' });
  });
});

describe('documented configuration repairs and rewrite checks', () => {
  const base = { mode: 'edit', task: 'edit', previousInteractionId: 'int-0', aspectRatio: '9:16', durationSec: 6, resolution: '720p', prompt: 'x' };
  it('repairs only values established by the registry or a verified rule, never resending an unchanged request', () => {
    const f = classifyProviderError(sdkError(400, { code: 400, status: 'INVALID_ARGUMENT', message: 'previous_interaction_id is not allowed when video task is set' }));
    expect(configRepairFor('video.generate', base, f)?.params).toMatchObject({ task: null });
    expect(configRepairFor('video.generate', { ...base, task: null }, f)).toBeNull();
    const dur = classifyProviderError(sdkError(400, { code: 400, status: 'INVALID_ARGUMENT', message: 'duration must be between 3s and 10s' }));
    expect(configRepairFor('video.generate', { ...base, durationSec: 14 }, dur)?.params).toMatchObject({ durationSec: 10 });
    expect(configRepairFor('video.generate', base, dur)).toBeNull();
    const generic = classifyProviderError(sdkError(400, { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' }));
    expect(configRepairFor('video.generate', base, generic)).toBeNull();
  });

  it('rejects rewrites that are unchanged, drop tags, remove restrictions or are not benign', () => {
    const original = '<IMAGE_REF_0> An elder laughs with a child.\nDo not show any text.';
    expect(checkRewrite(original, original, true).ok).toBe(false);
    expect(checkRewrite(original, 'An elder laughs with a child. Do not show any text.', true).ok).toBe(false);
    expect(checkRewrite(original, '<IMAGE_REF_0> An elder and a child share a laugh.', true).ok).toBe(false);
    expect(checkRewrite(original, '<IMAGE_REF_0> An elder and a child share a laugh.\nDo not show any text.', false).ok).toBe(false);
    expect(checkRewrite(original, '<IMAGE_REF_0> An elder and a child share a laugh.\nDo not show any text.', true).ok).toBe(true);
    expect(splitDeclaration('[# Sources <FIRST_FRAME>@Image1]\nA shot.')).toEqual({ declaration: '[# Sources <FIRST_FRAME>@Image1]', body: 'A shot.' });
  });

  it('pauses per model for exhausted quota and project-wide for access problems, until the daily reset', () => {
    expect(blockKey('vertex', 'm1', 'quota_exhausted')).toBe('vertex:m1');
    expect(blockKey('vertex', 'm1', 'permission_denied')).toBe('vertex:*');
    // 2026-10-03 10:00 UTC = 03:00 in Los Angeles (PDT) → resets at 07:00 UTC the next day.
    const t = Date.UTC(2026, 9, 3, 10, 0, 0);
    expect(new Date(nextPacificMidnight(t)).toISOString()).toBe('2026-10-04T07:00:00.000Z');
    expect(blockUntil({ code: 'permission_denied', quotaScope: null }, t)).toBe(t + 15 * 60_000);
  });
});
