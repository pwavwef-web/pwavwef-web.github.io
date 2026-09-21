import { HttpsError } from 'firebase-functions/v2/https';
import { ACTIVE_STATUSES, DEFAULT_SETTINGS, costFromUsage, dayKey, monthKey, type StudioSettings, type UsageAggregate } from '@az-studio/shared';
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
  kind: 'image' | 'video' | 'text' | 'audio';
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  outputByModality?: Record<string, number>;
}

/**
 * Records token usage reported by Vertex AI and its cost at published list prices, and updates
 * daily, monthly, per-project and per-job aggregates.
 */
export async function recordUsage(u: UsageInput): Promise<number> {
  const pricingKind = u.kind === 'audio' ? 'text' : u.kind;
  const costUsd = costFromUsage(pricingKind, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, thoughtTokens: u.thoughtTokens, outputByModality: u.outputByModality }, PRICING, u.modelId);
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
  const agg = { ownerUid: u.uid, costUsd: FieldValue.increment(costUsd), jobs: FieldValue.increment(1), byModel: { [u.modelId]: FieldValue.increment(costUsd) }, updatedAt: FieldValue.serverTimestamp() };
  batch.set(col.usageDaily().doc(`${u.uid}_${day}`), { ...agg, day }, { merge: true });
  batch.set(col.usageMonthly().doc(`${u.uid}_${month}`), { ...agg, month }, { merge: true });
  if (u.projectId) batch.set(col.projects().doc(u.projectId), { usage: { costUsd: FieldValue.increment(costUsd), jobs: FieldValue.increment(1) } }, { merge: true });
  batch.set(col.jobs().doc(u.jobId), { usageUsd: FieldValue.increment(costUsd) }, { merge: true });
  await batch.commit();
  return costUsd;
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
