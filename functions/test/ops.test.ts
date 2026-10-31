import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, monthKey } from '@az-studio/shared';
import { resetFakes, store } from './fakes';

/** Model-role budgets and the provider ledger against the in-memory Firestore (no provider is called). */

const fal = vi.hoisted(() => ({ balance: 12.5 as number | null }));

vi.mock('../src/lib/firebase', async () => {
  const f = await import('./fakes');
  return { db: f.db, col: f.col, bucket: f.bucket, FieldValue: f.FieldValue, Timestamp: f.Timestamp, gsUri: f.gsUri, pathFromGsUri: f.pathFromGsUri };
});
vi.mock('../src/lib/fal', () => ({ falBalance: async () => fal.balance }));

const { jobRoleBudgetProblem } = await import('../src/lib/role-budget');
const { balanceProblem, providerLedger, providerOf, readBalances, refreshFalBalance } = await import('../src/lib/provider-ledger');
const { MODEL_REGISTRY } = await import('../src/config/models');

beforeEach(() => {
  resetFakes();
  fal.balance = 12.5;
});

describe('model-role budgets', () => {
  it('refuses a job only when one of its roles is over budget', async () => {
    store.set('users/u1', { settings: { ...DEFAULT_SETTINGS, roleBudgetsUsd: { reasoning: 5 } } });
    store.set(`usageMonthly/u1_${monthKey()}`, { byModel: { [MODEL_REGISTRY.reasoning.id]: 5.2, [MODEL_REGISTRY.image.id]: 30 } });
    expect((await jobRoleBudgetProblem({ ownerUid: 'u1', type: 'linkad.run' }))?.role).toBe('reasoning');
    expect(await jobRoleBudgetProblem({ ownerUid: 'u1', type: 'image.generate' })).toBeNull();
    expect(await jobRoleBudgetProblem({ ownerUid: 'u1', type: 'render.timeline' })).toBeNull();
  });

  it('does nothing without budgets', async () => {
    store.set('users/u1', { settings: DEFAULT_SETTINGS });
    store.set(`usageMonthly/u1_${monthKey()}`, { byModel: { [MODEL_REGISTRY.reasoning.id]: 500 } });
    expect(await jobRoleBudgetProblem({ ownerUid: 'u1', type: 'text.assist' })).toBeNull();
  });
});

describe('provider ledger', () => {
  it('tells fal apart from Google', () => {
    expect(providerOf('fal-ai/sync-lipsync/v2#lipsync-2')).toBe('fal');
    expect(providerOf(MODEL_REGISTRY.reasoning.id)).toBe('google');
  });

  it('stores the live fal balance and refuses a job it would not cover', async () => {
    expect(await refreshFalBalance()).toBe(12.5);
    const b = (await readBalances()).fal;
    expect(b).toMatchObject({ balanceUsd: 12.5, source: 'api', lowUsd: 5 });
    expect(balanceProblem('fal', b, 12)).toBeNull();
    expect(balanceProblem('fal', b, 13)).toMatch(/below this job's estimate of \$13\.00/);
    expect(balanceProblem('fal', { ...b, balanceUsd: null }, 13)).toBeNull();
  });

  it('keeps the last balance when a read fails', async () => {
    await refreshFalBalance();
    fal.balance = null;
    expect(await refreshFalBalance()).toBeNull();
    expect((await readBalances()).fal.balanceUsd).toBe(12.5);
  });

  it('sums the month per provider and flags a low balance', async () => {
    fal.balance = 3;
    await refreshFalBalance();
    store.set(`usageMonthly/u1_${monthKey()}`, { byModel: { 'fal-ai/sync-lipsync/v2#lipsync-2': 1.5, [MODEL_REGISTRY.reasoning.id]: 2 } });
    const rows = await providerLedger('u1');
    expect(rows.find((r) => r.provider === 'fal')).toMatchObject({ monthSpendUsd: 1.5, balanceUsd: 3, low: true });
    expect(rows.find((r) => r.provider === 'google')).toMatchObject({ monthSpendUsd: 2, low: false });
  });
});
