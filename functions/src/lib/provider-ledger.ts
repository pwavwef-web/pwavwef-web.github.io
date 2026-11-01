import { logger } from 'firebase-functions';
import { monthKey } from '@az-studio/shared';
import { col, FieldValue } from './firebase';
import { falBalance } from './fal';

/**
 * One ledger for every provider. Google calls are priced from tokens at list prices (usage.ts); fal.ai (lip sync) is
 * prepaid credit, so its live balance is read before each request and again after it: the job is refused when the
 * balance would not cover its estimate, and the ledger records the real charge (balance before − after) when both
 * reads succeed, else the estimate. Balances live in runtime/providerBalances (backend only).
 */
export type Provider = 'google' | 'fal';
export const PROVIDERS: readonly Provider[] = ['google', 'fal'];

export function providerOf(modelId: string): Provider {
  return modelId.startsWith('fal-ai/') ? 'fal' : 'google';
}

export interface ProviderBalance {
  /** Remaining prepaid credit (null = postpaid or unknown). */
  balanceUsd: number | null;
  checkedAt: number | null;
  source: 'api' | 'manual' | null;
  /** Warn when the balance falls below this. */
  lowUsd: number;
}

const DEFAULT_LOW: Record<Provider, number> = { google: 0, fal: 5 };
const ref = () => col.runtime().doc('providerBalances');

export async function readBalances(): Promise<Record<Provider, ProviderBalance>> {
  const s = await ref().get();
  return Object.fromEntries(
    PROVIDERS.map((p) => {
      const v = (s.get(p) as Partial<ProviderBalance> | undefined) ?? {};
      return [p, { balanceUsd: typeof v.balanceUsd === 'number' ? v.balanceUsd : null, checkedAt: v.checkedAt ?? null, source: v.source ?? null, lowUsd: typeof v.lowUsd === 'number' ? v.lowUsd : DEFAULT_LOW[p] }];
    }),
  ) as Record<Provider, ProviderBalance>;
}

/** Reads fal's live credit balance and stores it; null when there is no key or the read fails (never throws). */
export async function refreshFalBalance(): Promise<number | null> {
  try {
    const usd = await falBalance();
    if (usd !== null) await ref().set({ fal: { balanceUsd: usd, checkedAt: Date.now(), source: 'api' } }, { merge: true });
    return usd;
  } catch (e) {
    logger.warn('fal balance read failed', { error: String((e as Error)?.message ?? e) });
    return null;
  }
}

export async function setBalance(provider: Provider, patch: { balanceUsd?: number | null; lowUsd?: number }): Promise<void> {
  await ref().set({ [provider]: { ...(patch.balanceUsd !== undefined ? { balanceUsd: patch.balanceUsd, checkedAt: Date.now(), source: 'manual' } : {}), ...(patch.lowUsd !== undefined ? { lowUsd: patch.lowUsd } : {}), updatedAt: FieldValue.serverTimestamp() } }, { merge: true });
}

/** A refusal message when a prepaid provider's known balance does not cover `estimateUsd`, else null. */
export function balanceProblem(provider: Provider, balance: ProviderBalance, estimateUsd: number): string | null {
  if (balance.balanceUsd === null || estimateUsd <= 0) return null;
  if (balance.balanceUsd + 1e-9 >= estimateUsd) return null;
  return `The ${provider} balance is $${balance.balanceUsd.toFixed(2)}, below this job's estimate of $${estimateUsd.toFixed(2)}. Top up the ${provider} account, then retry.`;
}

/** Settings → Providers: this month's recorded spend and the balance of each provider. */
export async function providerLedger(uid: string) {
  const [month, balances] = await Promise.all([col.usageMonthly().doc(`${uid}_${monthKey()}`).get(), readBalances()]);
  const byModel = (month.get('byModel') as Record<string, number> | undefined) ?? {};
  const spent: Record<Provider, number> = { google: 0, fal: 0 };
  for (const [modelId, usd] of Object.entries(byModel)) spent[providerOf(modelId)] += Number(usd ?? 0);
  return PROVIDERS.map((p) => {
    const b = balances[p];
    return { provider: p, monthSpendUsd: Math.round(spent[p] * 1e4) / 1e4, ...b, low: b.balanceUsd !== null && b.balanceUsd < b.lowUsd };
  });
}
