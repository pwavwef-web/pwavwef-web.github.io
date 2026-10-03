import type { ErrorCategory, JobError, RetryPhase } from '@az-studio/shared';
import { classifyProviderError, failureToJobError, isPolicyText, type ClassifyContext, type ProviderFailure } from './provider-errors';

/** Thrown by workers for expected, user-facing failures. */
export class JobFailure extends Error {
  constructor(public readonly jobError: JobError) {
    super(jobError.message);
  }
}

/**
 * A classified failure of a Google call, with the phase it happened in: `submit` (nothing accepted yet),
 * `poll` (an accepted operation could not be checked) or `finish` (the result arrived but could not be saved).
 * The worker's retry policy decides from these whether, when and how the work is tried again.
 */
export class GenerationFailure extends JobFailure {
  constructor(
    public readonly failure: ProviderFailure,
    public readonly phase: RetryPhase = 'submit',
  ) {
    super(failureToJobError(failure));
  }
}

export function fail(code: string, message: string, extra: Partial<JobError> = {}): never {
  throw new JobFailure({ code, message, retryable: false, ...extra });
}

/** Google's wording for a content-policy block (used only when no structured reason is available). */
export function isSafetyMessage(msg: string): boolean {
  return isPolicyText(msg);
}

/** Wraps whatever a Google call threw into a classified failure for the worker's retry policy. */
export function providerFailure(e: unknown, ctx: ClassifyContext & { phase?: RetryPhase } = {}): GenerationFailure {
  if (e instanceof GenerationFailure) return ctx.phase && ctx.phase !== e.phase ? new GenerationFailure(e.failure, ctx.phase) : e;
  if (e instanceof JobFailure) return new GenerationFailure(failureFromJobError(e.jobError), ctx.phase ?? 'submit');
  return new GenerationFailure(classifyProviderError(e, ctx), ctx.phase ?? 'submit');
}

/** Rebuilds the structured failure stored on a job error (older errors are mapped by code). */
export function failureFromJobError(err: JobError): ProviderFailure {
  const legacy: Record<string, ErrorCategory> = {
    safety_blocked: 'policy',
    quota: 'transient',
    permission: 'auth_quota',
    not_found: 'invalid_request',
    invalid_request: 'invalid_request',
    unavailable: 'transient',
    previous_in_progress: 'transient',
    model_unavailable: 'auth_quota',
    speech_edit_unsupported: 'invalid_request',
    interrupted: 'unknown',
    timeout: 'transient',
  };
  const category = err.category ?? legacy[err.code] ?? (err.safety ? 'policy' : err.retryable ? 'transient' : 'unknown');
  return {
    category,
    code: err.code,
    message: err.message,
    ...(err.action ? { action: err.action } : {}),
    httpStatus: err.httpStatus ?? null,
    providerStatus: err.providerStatus ?? null,
    reason: err.reason ?? null,
    retryAfterSec: err.retryAfterSec ?? null,
    quotaScope: null,
    ambiguous: Boolean(err.ambiguous),
    promptRelated: Boolean(err.promptRelated ?? category === 'policy'),
    details: err.details ?? '',
  };
}

/** Maps any error into a stable, user-facing job error. */
export function toJobError(e: unknown, ctx: ClassifyContext = {}): JobError {
  if (e instanceof JobFailure) return e.jobError;
  return failureToJobError(classifyProviderError(e, ctx));
}
