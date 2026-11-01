import { logger } from 'firebase-functions';
import { EARLY_ACCESS_LIMITS, validateEarlyAccess, type EarlyAccessInput } from '@az-studio/shared';
import { IS_EMULATOR } from '../config/runtime';
import { registerEarlyAccess } from '../lib/early-access';
import type { PublicRes } from './audio';

/**
 * POST /api/public/early-access — the public website's early-access form (unauthenticated, same origin through
 * the Hosting rewrite). It stores an interest registration and nothing else: no account is created, no email
 * is sent, and no studio data or generation code is reachable from here.
 *
 * Responses never say whether an address was already registered: a new and a repeated address both get
 * `200 {"ok":true}`. Email addresses and network addresses are never logged.
 */

export interface EarlyAccessReq {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: Buffer;
  /** Express's req.ip (fallback when Hosting's client-address header is absent). */
  ip?: string;
}

const SITE_ORIGINS = [/^https:\/\/az-studio\.web\.app$/, /^https:\/\/az-studio\.firebaseapp\.com$/, /^https:\/\/az-studio--[a-z0-9-]+\.web\.app$/];
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

const header = (h: EarlyAccessReq['headers'], k: string) => {
  const v = h[k] ?? h[k.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** The visitor's address as Firebase Hosting (Fastly) reports it; only ever used hashed, for rate limits. */
export function clientAddress(req: EarlyAccessReq): string {
  const fastly = header(req.headers, 'fastly-client-ip');
  if (fastly) return fastly.trim();
  const forwarded = header(req.headers, 'x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return req.ip ?? '';
}

function reply(res: PublicRes, status: number, body: Record<string, unknown>) {
  res.set('Cache-Control', 'no-store');
  res.status(status).json(body);
}

export async function handleEarlyAccess(req: EarlyAccessReq, res: PublicRes, now = Date.now()): Promise<void> {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.method !== 'POST') {
    res.set('Allow', 'POST');
    return reply(res, 405, { error: 'method_not_allowed' });
  }
  const origin = header(req.headers, 'origin') ?? '';
  if (!SITE_ORIGINS.some((r) => r.test(origin)) && !(IS_EMULATOR && DEV_ORIGIN.test(origin))) {
    return reply(res, 403, { error: 'forbidden', message: 'Registrations are accepted from the AZ Studio website only.' });
  }
  if (!/^application\/json\b/i.test(header(req.headers, 'content-type') ?? '')) return reply(res, 415, { error: 'unsupported_media_type' });
  const size = req.rawBody?.length ?? Number(header(req.headers, 'content-length') ?? 0);
  if (size > EARLY_ACCESS_LIMITS.bodyMaxBytes) return reply(res, 413, { error: 'too_large' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return reply(res, 400, { error: 'invalid', fields: { form: 'The form could not be read. Reload the page and try again.' } });

  const check = validateEarlyAccess(req.body as EarlyAccessInput);
  if (!check.ok) {
    logger.info('early-access', { outcome: check.bot ? 'honeypot' : 'invalid', fields: Object.keys(check.errors) });
    return reply(res, 400, { error: 'invalid', fields: check.errors });
  }
  let outcome;
  try {
    outcome = await registerEarlyAccess(check.value, clientAddress(req), now);
  } catch (e) {
    logger.error('early-access', { outcome: 'error', error: String((e as Error)?.message ?? e) });
    return reply(res, 503, { error: 'unavailable', message: 'Registration is temporarily unavailable. Please try again later.' });
  }
  logger.info('early-access', { outcome });
  switch (outcome) {
    case 'stored':
    case 'repeat':
      return reply(res, 200, { ok: true });
    case 'rate_limited':
      res.set('Retry-After', '3600');
      return reply(res, 429, { error: 'rate_limited', message: 'Too many registrations from this network. Please try again in an hour.' });
    case 'paused':
      return reply(res, 503, { error: 'paused', message: 'New registrations are paused for the moment. Please check back soon.' });
    case 'busy':
      return reply(res, 503, { error: 'busy', message: 'The list has had an unusual number of registrations today. Please try again tomorrow.' });
  }
}
