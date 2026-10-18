import type { NarratorRoute } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { db } from './firebase';
import { ncol } from './narrator-store';
import type { NarratorProviderError } from './narrator-provider';

const safe = (s: string) => s.replace(/[^\w.-]/g, '_');

// ---------------------------------------------------------------------------
// Recorded allowance blocks (Google said a limit is used up)
// ---------------------------------------------------------------------------

/**
 * Google's per-model request allowances (e.g. "100 requests per day on Tier 1" for gemini-3.8-flash-tts on the
 * Developer API). When Google reports one as used up, new narration requests for that route and model are
 * refused here — with Google's own message and retry time — instead of being sent again and refused again.
 * Settings → Check now clears it.
 */
export interface ProviderLimit {
  modelId: string;
  route?: NarratorRoute;
  until: number;
  message: string;
  at: number;
}

// The developer key keeps its original document name (blocks recorded before routes existed stay valid).
const limitRef = (modelId: string, route: NarratorRoute) => ncol.runtime(route === 'vertex' ? `limit-vertex-${safe(modelId)}` : `limit-${safe(modelId)}`);

export async function recordLimit(modelId: string, e: NarratorProviderError, now = Date.now(), route: NarratorRoute = 'developer'): Promise<ProviderLimit> {
  // Google's own "retry in" is preferred; without it a daily allowance is assumed to reset at the next quota day.
  const until = e.retryAfterSec ? now + e.retryAfterSec * 1000 : route === 'developer' ? nextQuotaReset(now) : now + 3600_000;
  const limit: ProviderLimit = { modelId, route, until, message: e.message, at: now };
  await limitRef(modelId, route).set(limit);
  return limit;
}

export async function activeLimit(modelId: string, route: NarratorRoute = 'developer', now = Date.now()): Promise<ProviderLimit | null> {
  const snap = await limitRef(modelId, route).get();
  const l = snap.exists ? (snap.data() as ProviderLimit) : null;
  return l && l.until > now ? { ...l, route } : null;
}

export async function clearLimit(modelId: string, route: NarratorRoute = 'developer'): Promise<void> {
  await limitRef(modelId, route).delete();
}

/** What the studio says while a limit is active. */
export function limitMessage(l: ProviderLimit): string {
  const hours = Math.max(0, (l.until - Date.now()) / 3_600_000);
  const wait = hours >= 1 ? `about ${Math.ceil(hours)} hour${Math.ceil(hours) === 1 ? '' : 's'}` : `about ${Math.max(1, Math.ceil(hours * 60))} minutes`;
  const where = l.route === 'vertex' ? 'Google Cloud' : 'Gemini Developer API';
  const remedy = l.route === 'vertex' ? 'or check the project’s Vertex AI quotas in the Cloud console.' : 'raise the API tier at ai.dev/rate-limit, or narrate with a Google Cloud voice (Settings → Speech service). Switching an edition’s voice re-narrates the whole edition.';
  return `Google’s request limit for ${l.modelId} (${where}) is used up for now (${l.message.replace(/\s*Please retry in\b.*$/is, '').trim()}) Nothing was charged for the refused requests. Try again in ${wait} (after ${new Date(l.until).toUTCString()}), ${remedy}`;
}

// ---------------------------------------------------------------------------
// Shared request gate: one queue per route and model for every job and worker
// ---------------------------------------------------------------------------

export interface GatePolicy {
  maxConcurrent: number;
  minIntervalMs: number;
  /** Requests per quota day this app may send (null = no fixed daily allowance). */
  dailyRequests: number | null;
}

/** Tests only: per-route policy overrides. */
export const gateOverrides: Partial<Record<NarratorRoute, Partial<GatePolicy>>> = {};

export function gatePolicy(route: NarratorRoute): GatePolicy {
  const base = { ...MODEL_REGISTRY.narration.gate[route], ...gateOverrides[route] };
  const env = (name: string) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  };
  return route === 'vertex' ? { ...base, maxConcurrent: env('AZS_NARRATOR_VERTEX_CONCURRENCY') ?? base.maxConcurrent } : { ...base, dailyRequests: env('AZS_NARRATOR_DEV_RPD') ?? base.dailyRequests };
}

/**
 * The quota day. Observed 2026-10-18 on the Developer API: a 429 at 03:13:13 UTC said "Please retry in
 * 20h46m46s" — i.e. the per-day allowance resets at 00:00 UTC (not midnight Pacific as some pages state).
 */
export const quotaDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** The next 00:00 UTC after `now`. */
export function nextQuotaReset(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

interface GateDoc {
  active: Record<string, number>;
  lastAt: number;
  day: string;
  count: number;
}

/** A request holder older than this is a leak (a request never takes more than 240 s). */
const HOLD_TTL_MS = 5 * 60_000;
const gateRef = (route: NarratorRoute, modelId: string) => ncol.runtime(`gate-${route}-${safe(modelId)}`);

export type GateResult = { ok: true; used: number; limit: number | null } | { ok: false; reason: 'busy' | 'daily'; waitMs: number; resetAt: number | null; used: number; limit: number | null };

/**
 * Takes a place for one provider request (idempotent per holder). Refuses when the route is at its concurrency
 * bound, inside its pacing interval, or out of today's allowance — before anything is sent to Google.
 */
export async function acquireRequest(route: NarratorRoute, modelId: string, holder: string, now = Date.now()): Promise<GateResult> {
  const policy = gatePolicy(route);
  const ref = gateRef(route, modelId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const day = quotaDay(now);
    const cur = (snap.exists ? snap.data() : null) as Partial<GateDoc> | null;
    const g: GateDoc = { active: { ...(cur?.active ?? {}) }, lastAt: Number(cur?.lastAt ?? 0), day: cur?.day ?? day, count: Number(cur?.count ?? 0) };
    if (g.day !== day) Object.assign(g, { day, count: 0 });
    for (const [h, t] of Object.entries(g.active)) if (now - t > HOLD_TTL_MS) delete g.active[h];
    if (g.active[holder]) return { ok: true, used: g.count, limit: policy.dailyRequests };
    if (policy.dailyRequests !== null && g.count >= policy.dailyRequests) {
      const resetAt = nextQuotaReset(now);
      return { ok: false, reason: 'daily', waitMs: resetAt - now, resetAt, used: g.count, limit: policy.dailyRequests };
    }
    if (Object.keys(g.active).length >= policy.maxConcurrent) return { ok: false, reason: 'busy', waitMs: 1000, resetAt: null, used: g.count, limit: policy.dailyRequests };
    if (now - g.lastAt < policy.minIntervalMs) return { ok: false, reason: 'busy', waitMs: policy.minIntervalMs - (now - g.lastAt), resetAt: null, used: g.count, limit: policy.dailyRequests };
    g.active[holder] = now;
    g.lastAt = now;
    g.count += 1;
    tx.set(ref, g);
    return { ok: true, used: g.count, limit: policy.dailyRequests };
  });
}

/**
 * Gives the place back. `refund` when Google definitely refused the request (an HTTP error answer: nothing was
 * generated and it does not count against the allowance); a sent or ambiguous request stays counted.
 * `exhausted` when Google said the daily allowance is used up: the counter is set to the limit so other jobs
 * stop before sending.
 */
export async function releaseRequest(route: NarratorRoute, modelId: string, holder: string, opts: { refund?: boolean; exhausted?: boolean } = {}, now = Date.now()): Promise<void> {
  const ref = gateRef(route, modelId);
  const policy = gatePolicy(route);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const g = snap.data() as GateDoc;
    const active = { ...(g.active ?? {}) };
    const held = holder in active;
    delete active[holder];
    let count = Number(g.count ?? 0);
    const sameDay = g.day === quotaDay(now);
    if (sameDay && opts.exhausted && policy.dailyRequests !== null) count = Math.max(count, policy.dailyRequests);
    else if (sameDay && held && opts.refund) count = Math.max(0, count - 1);
    tx.set(ref, { ...g, active, count });
  });
}

/**
 * Forgets today's count (Settings → Check now, e.g. after raising the API tier). If Google still refuses, the
 * first refusal is free and sets the count back to the limit.
 */
export async function resetDailyCount(route: NarratorRoute, modelId: string): Promise<void> {
  const ref = gateRef(route, modelId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) tx.set(ref, { ...(snap.data() as GateDoc), count: 0 });
  });
}

export interface Allowance {
  route: NarratorRoute;
  modelId: string;
  used: number;
  limit: number;
  remaining: number;
  resetAt: number;
}

/** Today's request count against the route's daily allowance (null when the route has none). */
export async function dailyAllowance(route: NarratorRoute, modelId: string, now = Date.now()): Promise<Allowance | null> {
  const limit = gatePolicy(route).dailyRequests;
  if (limit === null) return null;
  const snap = await gateRef(route, modelId).get();
  const g = (snap.exists ? snap.data() : null) as Partial<GateDoc> | null;
  const used = g && g.day === quotaDay(now) ? Number(g.count ?? 0) : 0;
  return { route, modelId, used, limit, remaining: Math.max(0, limit - used), resetAt: nextQuotaReset(now) };
}
