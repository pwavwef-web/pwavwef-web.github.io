import type { JobError } from '@az-studio/shared';

/** Thrown by workers for expected, user-facing failures. */
export class JobFailure extends Error {
  constructor(public readonly jobError: JobError) {
    super(jobError.message);
  }
}

export function fail(code: string, message: string, extra: Partial<JobError> = {}): never {
  throw new JobFailure({ code, message, retryable: false, ...extra });
}

const SAFETY_RE = /(safety|blocked by|was blocked|prohibited[_ ]content|responsible ai|usage polic|content polic|violat|IMAGE_SAFETY|SPII|recitation)/i;

function truncate(s: string, n = 600): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function isSafetyMessage(msg: string): boolean {
  return SAFETY_RE.test(msg);
}

/** Maps SDK / HTTP errors from Vertex AI into stable, user-facing job errors. */
export function toJobError(e: unknown): JobError {
  if (e instanceof JobFailure) return e.jobError;
  const err = e as { status?: number; code?: number | string; message?: string };
  const status = typeof err?.status === 'number' ? err.status : typeof err?.code === 'number' ? err.code : undefined;
  const msg = String(err?.message ?? e ?? 'Unknown error');
  const details = truncate(msg);
  if (isSafetyMessage(msg)) {
    return {
      code: 'safety_blocked',
      message: 'Google’s safety filters rejected this request. Rephrase the prompt or change the reference media, then try again.',
      retryable: false,
      safety: true,
      details,
    };
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(msg)) {
    return { code: 'quota', message: 'Vertex AI quota or rate limit reached for this project. The job will retry automatically with backoff.', retryable: true, details };
  }
  if (status === 401 || status === 403 || /PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg)) {
    return { code: 'permission', message: 'Vertex AI denied the studio service account. Check its roles/aiplatform.user grant.', retryable: false, details };
  }
  if (status === 404 || /NOT_FOUND|was not found/i.test(msg)) {
    return { code: 'not_found', message: 'Vertex AI could not find the requested model or interaction.', retryable: false, details };
  }
  if (status === 400 || /INVALID_ARGUMENT|Unsupported/i.test(msg)) {
    return { code: 'invalid_request', message: `Vertex AI rejected the request: ${truncate(msg, 240)}`, retryable: false, details };
  }
  if ((status !== undefined && status >= 500) || /UNAVAILABLE|DEADLINE_EXCEEDED|INTERNAL|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(msg)) {
    return { code: 'unavailable', message: 'Vertex AI is temporarily unavailable. The job will retry automatically.', retryable: true, details };
  }
  return { code: 'internal', message: `Unexpected error: ${truncate(msg, 240)}`, retryable: false, details };
}
