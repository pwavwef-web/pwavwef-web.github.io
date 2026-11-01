import { BUDGET_ROLES, JOB_ROLES, monthKey, roleBudgetProblem, roleSpend, type BudgetRole, type JobDoc, type RoleBudgetProblem } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { col } from './firebase';
import { getSettings } from './usage';

/** Model ids recorded in the ledger for each budget role. */
export function roleModels(): Record<BudgetRole, readonly string[]> {
  return Object.fromEntries(
    BUDGET_ROLES.map((role) => {
      const m = MODEL_REGISTRY[role] as { id: string; allowedIds?: readonly string[] };
      return [role, [...new Set([m.id, ...(m.allowedIds ?? [])])]];
    }),
  ) as unknown as Record<BudgetRole, readonly string[]>;
}

/** This month's spend per role (recorded usage). */
export async function monthRoleSpend(uid: string): Promise<Record<BudgetRole, number>> {
  const m = await col.usageMonthly().doc(`${uid}_${monthKey()}`).get();
  return roleSpend((m.get('byModel') as Record<string, number> | undefined) ?? {}, roleModels());
}

/** Whether a job may start under the owner's role budgets (checked by the worker before any request is sent). */
export async function jobRoleBudgetProblem(job: Pick<JobDoc, 'ownerUid' | 'type'>): Promise<RoleBudgetProblem | null> {
  const roles = JOB_ROLES[job.type] ?? [];
  if (!roles.length) return null;
  const settings = await getSettings(job.ownerUid);
  if (!Object.values(settings.roleBudgetsUsd ?? {}).some((v) => Number(v) > 0)) return null;
  return roleBudgetProblem(settings.roleBudgetsUsd, await monthRoleSpend(job.ownerUid), roles);
}
