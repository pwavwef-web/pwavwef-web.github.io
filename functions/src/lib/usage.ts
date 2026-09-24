import { HttpsError } from 'firebase-functions/v2/https';
import { ACTIVE_STATUSES, DEFAULT_SETTINGS, costFromUsage, dayKey, monthKey, type StudioSettings, type UsageAggregate, type UsageRecord } from '@az-studio/shared';
import { col, db, FieldValue } from './firebase';
import { PRICING } from '../config/pricing';

export async function getSettings(uid: string): Promise<StudioSettings> {
  const snap = await col.users().doc(uid).get();
  return { ...DEFAULT_SETTINGS, ...((snap.get('settings') as Partial<StudioSettings> | undefined) ?? {}) };
}

export interface SpendSnapshot {
  today: UsageAggregate;
  month: UsageAggregate;
  /** Sum of estimates for jobs that have not finished yet. */
  pendingUsd: number;
  activeJobs: number;
}

const emptyAgg = (): UsageAggregate => ({ costUsd: 0, jobs: 0, byModel: {} });

export async function spendSnapshot(uid: string): Promise<SpendSnapshot> {
  const [d, m, active] = await Promise.all([
    col.usageDaily().doc(`${uid}_${dayKey()}`).get(),
    col.usageMonthly().doc(`${uid}_${monthKey()}`).get(),
    col.jobs().where('ownerUid', '==', uid).where('status', 'in', [...ACTIVE_STATUSES]).get(),
  ]);
  let pendingUsd = 0;
  for (const j of active.docs) pendingUsd += Number(j.get('estimate.usd') ?? 0);
  return {
    today: { ...emptyAgg(), ...(d.data() as Partial<UsageAggregate> | undefined) },
    month: { ...emptyAgg(), ...(m.data() as Partial<UsageAggregate> | undefined) },
    pendingUsd: Math.round(pendingUsd * 1e6) / 1e6,
    activeJobs: active.size,
  };
}

/** Rejects a submission that would push projected spend past the owner's daily or monthly limit. */
export function assertWithinLimits(settings: StudioSettings, spend: SpendSnapshot, addUsd: number): void {
  const projectedDay = spend.today.costUsd + spend.pendingUsd + addUsd;
  const projectedMonth = spend.month.costUsd + spend.pendingUsd + addUsd;
  if (settings.dailyLimitUsd <= 0 || settings.monthlyLimitUsd <= 0) {
    throw new HttpsError('resource-exhausted', 'Generation is paused: a spending limit is set to $0 in Settings.');
  }
  if (projectedDay > settings.dailyLimitUsd + 1e-9) {
    throw new HttpsError(
      'resource-exhausted',
      `This would exceed your daily limit of $${settings.dailyLimitUsd.toFixed(2)} (today ≈ $${spend.today.costUsd.toFixed(2)} + in progress ≈ $${spend.pendingUsd.toFixed(2)} + this ≈ $${addUsd.toFixed(2)}). Raise the limit in Settings or try tomorrow.`,
    );
  }
  if (projectedMonth > settings.monthlyLimitUsd + 1e-9) {
    throw new HttpsError(
      'resource-exhausted',
      `This would exceed your monthly limit of $${settings.monthlyLimitUsd.toFixed(2)} (month ≈ $${spend.month.costUsd.toFixed(2)}). Raise the limit in Settings.`,
    );
  }
}

export interface UsageInput {
  uid: string;
  projectId: string | null;
  jobId: string;
  modelId: string;
  kind: Exclude<UsageRecord['kind'], 'render'>;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  outputByModality?: Record<string, number>;
  /** Models priced per request (e.g. music per song) record their published price directly. */
  costUsdOverride?: number;
  /** False for secondary calls inside one job (keeps per-day job counts honest). */
  countJob?: boolean;
}

/**
 * Records token usage reported by Vertex AI and its cost at published list prices, and updates
 * daily, monthly, per-project and per-job aggregates.
 */
export async function recordUsage(u: UsageInput): Promise<number> {
  const pricingKind = u.kind === 'audio' ? 'text' : u.kind === 'music' || u.kind === 'vision' || u.kind === 'compute' ? null : u.kind;
  const costUsd =
    u.costUsdOverride !== undefined
      ? Math.round(u.costUsdOverride * 1e6) / 1e6
      : pricingKind
        ? costFromUsage(pricingKind, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, thoughtTokens: u.thoughtTokens, outputByModality: u.outputByModality }, PRICING, u.modelId)
        : 0;
  const jobs = u.countJob === false ? 0 : 1;
  const now = new Date();
  const day = dayKey(now);
  const month = monthKey(now);
  const batch = db.batch();
  batch.set(col.usage().doc(), {
    ownerUid: u.uid,
    projectId: u.projectId,
    jobId: u.jobId,
    modelId: u.modelId,
    kind: u.kind,
    tokens: { input: u.inputTokens, output: u.outputTokens, thoughts: u.thoughtTokens, byModality: u.outputByModality ?? {} },
    costUsd,
    pricingVersion: PRICING.version,
    day,
    month,
    createdAt: FieldValue.serverTimestamp(),
  });
  const agg = { ownerUid: u.uid, costUsd: FieldValue.increment(costUsd), jobs: FieldValue.increment(jobs), byModel: { [u.modelId]: FieldValue.increment(costUsd) }, updatedAt: FieldValue.serverTimestamp() };
  batch.set(col.usageDaily().doc(`${u.uid}_${day}`), { ...agg, day }, { merge: true });
  batch.set(col.usageMonthly().doc(`${u.uid}_${month}`), { ...agg, month }, { merge: true });
  if (u.projectId) batch.set(col.projects().doc(u.projectId), { usage: { costUsd: FieldValue.increment(costUsd), jobs: FieldValue.increment(jobs) } }, { merge: true });
  batch.set(col.jobs().doc(u.jobId), { usageUsd: FieldValue.increment(costUsd) }, { merge: true });
  await batch.commit();
  return costUsd;
}

/**
 * Rejects work that would take a project past its own budget (recorded usage + running jobs + this).
 * Projects without a budget are only bound by the owner's daily and monthly limits.
 */
export async function assertProjectBudget(uid: string, projectId: string | null | undefined, addUsd: number): Promise<void> {
  if (!projectId || addUsd <= 0) return;
  const p = await col.projects().doc(projectId).get();
  const limit = p.get('budget.limitUsd') as number | null | undefined;
  if (typeof limit !== 'number' || limit <= 0) return;
  const spent = Number(p.get('usage.costUsd') ?? 0);
  const active = await col.jobs().where('ownerUid', '==', uid).where('projectId', '==', projectId).where('status', 'in', [...ACTIVE_STATUSES]).get();
  const pending = active.docs.reduce((s, d) => s + Number(d.get('estimate.usd') ?? 0), 0);
  if (spent + pending + addUsd > limit + 1e-9) {
    throw new HttpsError(
      'resource-exhausted',
      `This would exceed the project budget of $${limit.toFixed(2)} (spent ≈ $${spent.toFixed(2)} + in progress ≈ $${pending.toFixed(2)} + this ≈ $${addUsd.toFixed(2)}). Raise the project budget, reuse approved takes, or cancel queued work.`,
    );
  }
}

/** Sliding one-minute submission limit to stop runaway clients. */
export async function assertRateLimit(uid: string, count: number, perMinute = 60): Promise<void> {
  const ref = col.runtime().doc(`${uid}_rate`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const recent = ((snap.get('stamps') as number[] | undefined) ?? []).filter((t) => now - t < 60_000);
    if (recent.length + count > perMinute) {
      throw new HttpsError('resource-exhausted', 'Too many submissions in the last minute. Wait a moment and try again.');
    }
    tx.set(ref, { stamps: [...recent, ...Array(count).fill(now)].slice(-perMinute) }, { merge: true });
  });
}
