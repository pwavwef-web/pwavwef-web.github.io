import { logger } from 'firebase-functions';
import { readOptionalSecret } from './secrets';

/**
 * Minimal client for fal.ai's queue API (used for lip-sync). The key lives in Secret Manager
 * (AZ_STUDIO_FAL_KEY, "id:secret"); it can also be provided through FAL_KEY for local runs.
 * It is read at call time, never logged and never returned to the browser.
 */

export const FAL_SECRET = 'AZ_STUDIO_FAL_KEY';
const QUEUE = 'https://queue.fal.run';

export class FalError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean) {
    super(message);
  }
}

export async function falKey(): Promise<string | null> {
  const env = process.env.FAL_KEY;
  if (env && env.trim()) return env.trim();
  return readOptionalSecret(FAL_SECRET);
}

async function falFetch(key: string, url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === 'object' && body ? JSON.stringify((body as { detail?: unknown }).detail ?? body).slice(0, 400) : String(body ?? '').slice(0, 400);
    throw new FalError(`fal.ai ${res.status}: ${detail}`, res.status, res.status === 429 || res.status >= 500);
  }
  return body;
}

export interface FalRunOptions {
  /** Give up waiting after this long (the request keeps running on fal's side). */
  timeoutMs?: number;
  onStatus?: (status: string) => void;
}

/** Submits a request to a fal model and waits for its result. */
export async function falRun<T>(model: string, input: Record<string, unknown>, opts: FalRunOptions = {}): Promise<{ requestId: string; output: T }> {
  const key = await falKey();
  if (!key) throw new FalError('The fal.ai key is not set (secret AZ_STUDIO_FAL_KEY).', null, false);
  const sub = (await falFetch(key, `${QUEUE}/${model}`, { method: 'POST', body: JSON.stringify(input) })) as { request_id: string; status_url: string; response_url: string };
  logger.info('fal request queued', { model, requestId: sub.request_id });
  const deadline = Date.now() + (opts.timeoutMs ?? 12 * 60_000);
  let last = '';
  for (let delay = 3000; Date.now() < deadline; delay = Math.min(delay + 1000, 8000)) {
    await new Promise((r) => setTimeout(r, delay));
    const st = (await falFetch(key, sub.status_url)) as { status: string };
    if (st.status !== last) {
      last = st.status;
      opts.onStatus?.(st.status);
    }
    if (st.status === 'COMPLETED') {
      const output = (await falFetch(key, sub.response_url)) as T;
      return { requestId: sub.request_id, output };
    }
  }
  throw new FalError(`fal.ai request ${sub.request_id} did not finish in time`, null, true);
}

/** Uploads a file to fal's storage and returns a URL its models can read (no signed URLs of ours leave the project). */
export async function falUpload(data: Buffer, contentType: string, fileName: string): Promise<string> {
  const key = await falKey();
  if (!key) throw new FalError('The fal.ai key is not set (secret AZ_STUDIO_FAL_KEY).', null, false);
  const init = (await falFetch(key, 'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', { method: 'POST', body: JSON.stringify({ content_type: contentType, file_name: fileName }) })) as { upload_url: string; file_url: string };
  const put = await fetch(init.upload_url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: new Uint8Array(data) });
  if (!put.ok) throw new FalError(`fal.ai upload failed (${put.status})`, put.status, put.status >= 500);
  return init.file_url;
}
