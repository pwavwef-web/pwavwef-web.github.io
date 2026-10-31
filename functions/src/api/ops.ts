import { BUDGET_ROLES, JOB_ROLES, monthKey, type ApiRequest, type BudgetRole, type JobType } from '@az-studio/shared';
import { reasoningRates } from '../config/pricing';
import { col, db } from '../lib/firebase';
import type { Owner } from '../lib/owner';
import { monthRoleSpend, roleModels } from '../lib/role-budget';
import { acknowledgeCanary, readCanary, runCanary } from '../scheduled/canary';
import { providerLedger as ledger, refreshFalBalance, setBalance } from '../lib/provider-ledger';

type Payload<A extends ApiRequest['action']> = Extract<ApiRequest, { action: A }>['payload'];

/** Settings → Model health: the daily canary's last run and its changes; `run` probes now (≈ $0.002). */
export async function canary(owner: Owner, p: Payload<'canary'>) {
  if (p.op === 'run') return runCanary(owner.uid);
  if (p.op === 'acknowledge') return acknowledgeCanary();
  return readCanary();
}

/** Settings → Providers: spend and balance per provider; `refresh` reads fal's live balance, `set` records one by hand. */
export async function providerLedger(owner: Owner, p: Payload<'providerLedger'>) {
  if (p.op === 'refresh') await refreshFalBalance();
  if (p.op === 'set' && p.provider) await setBalance(p.provider, { ...(p.balanceUsd !== undefined ? { balanceUsd: p.balanceUsd } : {}), ...(p.lowUsd !== undefined ? { lowUsd: p.lowUsd } : {}) });
  return { providers: await ledger(owner.uid) };
}

/**
 * Settings → Spend by task: one month of recorded usage grouped by model role and job type, so it is clear which
 * tasks really need the reasoning model, plus what this month's reasoning calls would cost at Gemini 4 Argon's
 * standard rate (from 1 December 2026 the input and output rates double).
 */
export async function spendByTask(owner: Owner, p: Payload<'spendByTask'>) {
  const month = p.month ?? monthKey();
  const snap = await col.usage().where('ownerUid', '==', owner.uid).where('month', '==', month).get();
  const models = roleModels();
  const roleOf = new Map<string, BudgetRole>();
  for (const r of BUDGET_ROLES) for (const id of models[r]) roleOf.set(id, r);

  const jobIds = [...new Set(snap.docs.map((d) => d.get('jobId') as string | null).filter((x): x is string => Boolean(x)))];
  const jobType = new Map<string, string>();
  for (let i = 0; i < jobIds.length; i += 300) {
    const docs = await db.getAll(...jobIds.slice(i, i + 300).map((id) => col.jobs().doc(id)));
    for (const d of docs) if (d.exists) jobType.set(d.id, String(d.get('type') ?? 'unknown'));
  }

  const standard = reasoningRates(Date.UTC(2026, 11, 1));
  const rows = new Map<string, { role: string; modelId: string; task: string; costUsd: number; calls: number; standardRateUsd: number | null }>();
  for (const d of snap.docs) {
    const modelId = String(d.get('modelId') ?? '');
    const role = roleOf.get(modelId) ?? 'other';
    const jobId = d.get('jobId') as string | null;
    const task = jobId ? (jobType.get(jobId) ?? 'deleted job') : 'studio checks';
    const key = `${modelId}|${task}`;
    const row = rows.get(key) ?? { role, modelId, task, costUsd: 0, calls: 0, standardRateUsd: role === 'reasoning' ? 0 : null };
    row.costUsd += Number(d.get('costUsd') ?? 0);
    row.calls += 1;
    if (row.standardRateUsd !== null) {
      const t = (d.get('tokens') as { input?: number; output?: number; thoughts?: number } | undefined) ?? {};
      row.standardRateUsd += ((t.input ?? 0) * standard.inputPerM + ((t.output ?? 0) + (t.thoughts ?? 0)) * standard.outputPerM) / 1e6;
    }
    rows.set(key, row);
  }
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  const list = [...rows.values()].map((r) => ({ ...r, costUsd: round(r.costUsd), standardRateUsd: r.standardRateUsd === null ? null : round(r.standardRateUsd) })).sort((a, b) => b.costUsd - a.costUsd);
  return {
    month,
    rows: list,
    byRole: await monthRoleSpend(owner.uid),
    /** Roles each job type can spend on (for the budget explanation). */
    jobRoles: JOB_ROLES as Record<JobType, readonly BudgetRole[]>,
    reasoning: {
      costUsd: round(list.filter((r) => r.role === 'reasoning').reduce((s, r) => s + r.costUsd, 0)),
      standardRateUsd: round(list.filter((r) => r.role === 'reasoning').reduce((s, r) => s + (r.standardRateUsd ?? 0), 0)),
      standardFrom: '2026-12-01',
    },
  };
}
