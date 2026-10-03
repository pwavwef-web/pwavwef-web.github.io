import { logger } from 'firebase-functions';
import { col, db } from './firebase';
import type { ProviderFailure, Surface } from './provider-errors';

/**
 * Pauses automatic work after an access, billing or exhausted-quota failure, so queued jobs do not keep
 * calling Google with a request that cannot succeed. A pause lifts when its time passes (the daily quota
 * resets at midnight Pacific time; access and billing are re-tested after 15 minutes), when the director
 * retries (they say the cause is fixed), or when Settings → Models probes the model successfully.
 */

export interface ProviderBlock {
  key: string;
  surface: Surface;
  modelId: string | null;
  code: string;
  message: string;
  action: string | null;
  at: number;
  until: number;
}

const ref = () => col.runtime().doc('providerHealth');
let cache: { at: number; blocks: ProviderBlock[] } | null = null;
const CACHE_MS = 20_000;

/** Forgets the cached pauses (the next check reads the stored state). */
export function invalidateProviderHealth(): void {
  cache = null;
}

/** Quota exhaustion is per model; access, billing and disabled APIs affect every model on the surface. */
export function blockKey(surface: Surface, modelId: string | null, code: string): string {
  return code === 'quota_exhausted' && modelId ? `${surface}:${modelId}` : `${surface}:*`;
}

/** Next midnight in America/Los_Angeles (when Google's daily quotas reset). */
export function nextPacificMidnight(now = Date.now()): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(now))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  ) as { hour: number; minute: number; second: number };
  const hour = parts.hour % 24;
  const elapsed = (hour * 3600 + parts.minute * 60 + parts.second) * 1000;
  return now - elapsed + 24 * 3600 * 1000;
}

export function blockUntil(f: Pick<ProviderFailure, 'code' | 'quotaScope'>, now = Date.now()): number {
  if (f.code === 'quota_exhausted' || f.quotaScope === 'day') return nextPacificMidnight(now);
  return now + 15 * 60_000;
}

export async function listBlocks(now = Date.now(), fresh = false): Promise<ProviderBlock[]> {
  if (!fresh && cache && now - cache.at < CACHE_MS) return cache.blocks.filter((b) => b.until > now);
  const snap = await ref().get();
  const blocks = Object.values((snap.get('blocks') as Record<string, ProviderBlock> | undefined) ?? {});
  cache = { at: now, blocks };
  return blocks.filter((b) => b.until > now);
}

/** The pause that applies to a call, if any. */
export async function activeBlock(surface: Surface, modelId: string | null, now = Date.now()): Promise<ProviderBlock | null> {
  try {
    const blocks = await listBlocks(now);
    return blocks.find((b) => b.key === `${surface}:*` || (modelId && b.key === `${surface}:${modelId}`)) ?? null;
  } catch (e) {
    logger.warn('provider health unavailable', { error: String(e) });
    return null;
  }
}

export async function recordBlock(f: ProviderFailure, ctx: { surface: Surface; modelId: string | null }, now = Date.now()): Promise<ProviderBlock | null> {
  if (f.category !== 'auth_quota') return null;
  const block: ProviderBlock = { key: blockKey(ctx.surface, ctx.modelId, f.code), surface: ctx.surface, modelId: ctx.modelId, code: f.code, message: f.message, action: f.action ?? null, at: now, until: blockUntil(f, now) };
  await ref().set({ blocks: { [block.key]: block } }, { merge: true });
  cache = null;
  logger.warn('automatic generation paused', { key: block.key, code: block.code, until: new Date(block.until).toISOString() });
  return block;
}

/** Lifts pauses (all of them when no keys are given). */
export async function clearBlocks(keys?: string[]): Promise<number> {
  const snap = await ref().get();
  const blocks = (snap.get('blocks') as Record<string, ProviderBlock> | undefined) ?? {};
  const remove = keys?.length ? keys.filter((k) => blocks[k]) : Object.keys(blocks);
  if (!remove.length) return 0;
  await db.runTransaction(async (tx) => {
    const cur = ((await tx.get(ref())).get('blocks') as Record<string, ProviderBlock> | undefined) ?? {};
    for (const k of remove) delete cur[k];
    tx.set(ref(), { blocks: cur });
  });
  cache = null;
  return remove.length;
}
