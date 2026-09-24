import { GoogleAuth } from 'google-auth-library';
import { logger } from 'firebase-functions';
import { PROJECT_ID } from '../config/runtime';

/**
 * Optional secrets read at runtime from Secret Manager (e.g. the Gemini Developer API key for Lyria 3.5).
 * They are not declared as function secrets, so the functions deploy and run without them; a missing
 * secret simply leaves the feature reporting its limitation. Values are cached in memory only and never
 * logged, returned to the client or written anywhere.
 */

const cache = new Map<string, { value: string | null; at: number }>();
let auth: GoogleAuth | null = null;

export async function readOptionalSecret(name: string, ttlMs = 10 * 60_000): Promise<string | null> {
  const env = process.env[name];
  if (env && env.trim()) return env.trim();
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < (hit.value ? ttlMs : 2 * 60_000)) return hit.value;
  try {
    auth ??= new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const res = await client.request<{ payload?: { data?: string } }>({ url: `https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/${name}/versions/latest:access`, method: 'GET', retry: false });
    const value = Buffer.from(res.data.payload?.data ?? '', 'base64').toString('utf8').trim() || null;
    cache.set(name, { value, at: Date.now() });
    return value;
  } catch (e) {
    const status = (e as { response?: { status?: number } }).response?.status ?? null;
    if (status !== 404) logger.warn('optional secret unavailable', { name, status });
    cache.set(name, { value: null, at: Date.now() });
    return null;
  }
}

export function forgetSecret(name: string): void {
  cache.delete(name);
}
