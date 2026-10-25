import { HttpsError } from 'firebase-functions/v2/https';
import { canMoveStage, dayKey, LINKAD_LIMITS, normalizeLinkAd, stableHash, type CostEstimate, type JobDoc, type LedgerEntry, type LinkAdDoc, type LinkAdStage } from '@az-studio/shared';
import { col, db, FieldValue } from './firebase';
import { enqueueJob } from './jobs';
import type { Owner } from './owner';

/**
 * Link to Ad persistence and access.
 *
 * Access has two layers. Every call has already passed the studio's owner check; `linkAdEntitlement` then decides
 * whether the *feature* is available to that account, with the quotas that apply. Today the only plan is the owner's.
 * A future public plan changes this function (and the quotas it returns) and nothing else: every read and write
 * below is already scoped to `ownerUid`, quotas are counted server-side, and the browser never decides either.
 */

export const FEATURE_ENV_OFF = () => (process.env.AZS_FEATURE_LINK_AD ?? '').toLowerCase() === 'off';
export const FIXTURES_ALLOWED = () => process.env.AZS_LINKAD_FIXTURES === '1' || process.env.FUNCTIONS_EMULATOR === 'true';

export interface LinkAdQuotas {
  analysesPerDay: number;
  voiceRunsPerDay: number;
  exportsPerDay: number;
  maxSpendCapUsd: number;
}

export interface LinkAdEntitlement {
  enabled: boolean;
  plan: 'owner';
  audience: 'owner';
  reason: string | null;
  quotas: LinkAdQuotas;
}

const OWNER_QUOTAS: LinkAdQuotas = { analysesPerDay: 60, voiceRunsPerDay: 120, exportsPerDay: 60, maxSpendCapUsd: 25 };

/** `runtime/features` (server-only): `{ linkAd: { enabled: boolean } }`. Missing = enabled for the owner. */
export async function linkAdEntitlement(_owner: Pick<Owner, 'uid'>): Promise<LinkAdEntitlement> {
  if (FEATURE_ENV_OFF()) return { enabled: false, plan: 'owner', audience: 'owner', reason: 'Link to Ad is switched off for this deployment (AZS_FEATURE_LINK_AD=off).', quotas: OWNER_QUOTAS };
  let flag: { enabled?: boolean; quotas?: Partial<LinkAdQuotas> } | undefined;
  try {
    flag = (await col.runtime().doc('features').get()).get('linkAd') as typeof flag;
  } catch {
    flag = undefined;
  }
  if (flag && flag.enabled === false) return { enabled: false, plan: 'owner', audience: 'owner', reason: 'Link to Ad is switched off in the studio feature flags.', quotas: OWNER_QUOTAS };
  return { enabled: true, plan: 'owner', audience: 'owner', reason: null, quotas: { ...OWNER_QUOTAS, ...(flag?.quotas ?? {}) } };
}

export async function assertLinkAdAccess(owner: Owner): Promise<LinkAdEntitlement> {
  const e = await linkAdEntitlement(owner);
  if (!e.enabled) throw new HttpsError('failed-precondition', e.reason ?? 'Link to Ad is not available.');
  return e;
}

/** Counts one use against a daily quota (server-side). Throws when the day's allowance is spent. */
export async function consumeQuota(uid: string, kind: 'analyses' | 'voiceRuns' | 'exports', limit: number): Promise<void> {
  const ref = col.runtime().doc(`linkad-quota-${uid}-${dayKey()}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = Number(snap.get(kind) ?? 0);
    if (used >= limit) throw new HttpsError('resource-exhausted', `Today's allowance for this step (${limit}) is used up. It resets tomorrow.`);
    tx.set(ref, { ownerUid: uid, [kind]: used + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}

// ---------------------------------------------------------------------------
// Document access
// ---------------------------------------------------------------------------

export interface LoadedAd {
  ref: FirebaseFirestore.DocumentReference;
  title: string;
  doc: LinkAdDoc;
}

/** Loads one ad the caller owns. Anything else — missing, someone else's, another project type — looks the same. */
export async function loadAd(uid: string, projectId: string): Promise<LoadedAd> {
  const ref = col.projects().doc(projectId);
  const snap = await ref.get();
  if (!snap.exists || snap.get('ownerUid') !== uid || snap.get('type') !== 'link_ad') throw new HttpsError('not-found', 'Ad not found.');
  return { ref, title: String(snap.get('title') ?? 'Link to Ad'), doc: normalizeLinkAd(snap.get('linkad')) };
}

const MAX_DOC_BYTES = 900_000;

export function sizeGuard(doc: LinkAdDoc): LinkAdDoc {
  let d = doc;
  let size = Buffer.byteLength(JSON.stringify(d));
  // Over the limit: the least useful extracted material goes first (long excerpts, then low-value facts).
  if (size > MAX_DOC_BYTES) {
    d = { ...d, source: { ...d.source, facts: d.source.facts.map((f) => ({ ...f, excerpt: f.excerpt.slice(0, 160) })) } };
    size = Buffer.byteLength(JSON.stringify(d));
  }
  while (size > MAX_DOC_BYTES && d.source.facts.length > 20) {
    const keep = d.source.facts.filter((f) => f.needsConfirmation || ['business_name', 'product_name', 'contact', 'destination', 'price'].includes(f.kind) || d.brief.usedFactIds.includes(f.id));
    const drop = d.source.facts.filter((f) => !keep.includes(f)).slice(-10);
    d = { ...d, source: { ...d.source, facts: d.source.facts.filter((f) => !drop.includes(f)) } };
    size = Buffer.byteLength(JSON.stringify(d));
    if (!drop.length) break;
  }
  if (size > MAX_DOC_BYTES) throw new HttpsError('resource-exhausted', 'This ad holds too much material. Remove some facts or pictures.');
  return d;
}

export interface MutateOptions {
  /** The revision the editor last saw; a different stored revision means another tab changed it. */
  expectedRevision?: number;
  title?: string;
}

/** Applies `fn` to the stored document in a transaction (revision + 1). `fn` may throw an HttpsError to abort. */
export async function mutateAd(uid: string, projectId: string, fn: (doc: LinkAdDoc, title: string) => LinkAdDoc | Promise<LinkAdDoc>, opts: MutateOptions = {}): Promise<LinkAdDoc> {
  const ref = col.projects().doc(projectId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('ownerUid') !== uid || snap.get('type') !== 'link_ad') throw new HttpsError('not-found', 'Ad not found.');
    const cur = normalizeLinkAd(snap.get('linkad'));
    if (opts.expectedRevision !== undefined && cur.revision !== opts.expectedRevision) throw new HttpsError('aborted', 'This ad was changed somewhere else (another tab?). Reload to see the latest version.', { reason: 'revision_conflict', revision: cur.revision });
    const next = sizeGuard({ ...(await fn(cur, String(snap.get('title') ?? ''))), revision: cur.revision + 1, updatedAt: Date.now() });
    tx.update(ref, { linkad: next, updatedAt: FieldValue.serverTimestamp(), ...(opts.title ? { title: opts.title.slice(0, 160) } : {}) });
    return next;
  });
}

/** Moves the document to another stage. An impossible move is a programming error, not a user error. */
export function moveStage(doc: LinkAdDoc, to: LinkAdStage, note = '', opts: { force?: boolean } = {}): LinkAdDoc {
  // `force` is for moves the owner starts themselves on an ad that already has work in it (choosing a direction, exporting).
  if (!opts.force && !canMoveStage(doc.stage, to)) throw new HttpsError('failed-precondition', `That step is not available right now (${doc.stage} → ${to}).`);
  return { ...doc, stage: to, stageNote: note.slice(0, 400), ...(to === 'failed' || to === 'cancelled' || to === 'reviewing' || to === 'awaiting_selection' || to === 'ready' ? { activeJobId: null } : {}) };
}

// ---------------------------------------------------------------------------
// Spend ledger
// ---------------------------------------------------------------------------

export function spentUsd(doc: Pick<LinkAdDoc, 'spend'>): { estimated: number; actual: number } {
  let estimated = 0;
  let actual = 0;
  for (const e of doc.spend.ledger) {
    estimated += e.estimateUsd;
    actual += e.actualUsd ?? 0;
  }
  return { estimated: Math.round(estimated * 1e6) / 1e6, actual: Math.round(actual * 1e6) / 1e6 };
}

/** What is already spent (actual where known, else the estimate) against the director's cap for this ad. */
export function committedUsd(doc: Pick<LinkAdDoc, 'spend'>): number {
  return Math.round(doc.spend.ledger.reduce((s, e) => s + (e.actualUsd ?? e.estimateUsd), 0) * 1e6) / 1e6;
}

/** Refuses work that would take this ad past its cap. Estimates and actual usage stay separate entries. */
export function assertWithinAdCap(doc: Pick<LinkAdDoc, 'spend'>, addUsd: number): void {
  const cap = doc.spend.capUsd;
  const after = committedUsd(doc) + addUsd;
  if (after > cap + 1e-9) throw new HttpsError('resource-exhausted', `This would take the ad to about $${after.toFixed(2)}, over its spending cap of $${cap.toFixed(2)}. Raise the cap on the ad, or do less.`, { reason: 'ad_cap', capUsd: cap, committedUsd: committedUsd(doc), addUsd });
}

export function addLedger(doc: LinkAdDoc, e: Omit<LedgerEntry, 'at'>): LinkAdDoc {
  const ledger = [...doc.spend.ledger, { ...e, at: Date.now() }].slice(-LINKAD_LIMITS.ledgerEntries);
  return { ...doc, spend: { ...doc.spend, ledger } };
}

/**
 * Adds an actual cost, as the provider reported it, to the estimate made for the same job and kind. Estimates and
 * actual usage stay separate numbers on the entry; usage seen with no estimate becomes its own entry.
 */
export function settleLedger(doc: LinkAdDoc, jobId: string, kind: LedgerEntry['kind'], addUsd: number): LinkAdDoc {
  let done = false;
  const ledger = doc.spend.ledger.map((e) => {
    if (!done && e.jobId === jobId && e.kind === kind) {
      done = true;
      return { ...e, actualUsd: Math.round(((e.actualUsd ?? 0) + addUsd) * 1e6) / 1e6 };
    }
    return e;
  });
  const next = { ...doc, spend: { ...doc.spend, ledger } };
  return done ? next : addLedger(next, { step: 'unplanned', kind, units: '', estimateUsd: 0, actualUsd: addUsd, jobId, basis: 'published_rate' });
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type LinkAdStep = 'analyse' | 'directions' | 'revise' | 'voice';

export interface NewLinkAdJob {
  uid: string;
  projectId: string;
  step: LinkAdStep;
  requestId: string;
  label: string;
  params: Record<string, unknown>;
  estimate: CostEstimate;
}

/** Deterministic job id: the same request id for the same ad never creates a second job (or a second paid call). */
export const linkAdJobId = (projectId: string, step: LinkAdStep, requestId: string) => `lad-${step}-${stableHash([projectId, step, requestId])}-${requestId.slice(0, 24)}`;

/** Creates and enqueues the job unless it already exists. Returns the id and whether it was newly created. */
export async function createLinkAdJob(j: NewLinkAdJob): Promise<{ jobId: string; created: boolean }> {
  const jobId = linkAdJobId(j.projectId, j.step, j.requestId);
  const ref = col.jobs().doc(jobId);
  const now = FieldValue.serverTimestamp();
  const job: Omit<JobDoc, 'id'> = { ownerUid: j.uid, projectId: j.projectId, type: 'linkad.run', status: 'queued', stage: 'Queued', progress: 0, modelId: null, params: { step: j.step, ...j.params }, estimate: j.estimate, batchId: null, target: { kind: 'linkad', id: j.projectId }, label: j.label, attempt: 0, retryOf: null, external: null, result: null, error: null, cancelRequested: false, usageUsd: null, productionId: null };
  const created = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      if (snap.get('ownerUid') !== j.uid) throw new HttpsError('not-found', 'Ad not found.');
      return false;
    }
    tx.set(ref, { ...job, createdAt: now, updatedAt: now });
    return true;
  });
  if (created) await enqueueJob(jobId, 'start');
  return { jobId, created };
}

/** A running job for this ad, if any (one pipeline step at a time). */
export async function activeJobFor(uid: string, projectId: string): Promise<{ id: string; step: string; status: string } | null> {
  const snap = await col.jobs().where('ownerUid', '==', uid).where('projectId', '==', projectId).where('status', 'in', ['queued', 'validating', 'generating', 'downloading']).get();
  for (const d of snap.docs) if (d.get('type') === 'linkad.run') return { id: d.id, step: String(d.get('params.step') ?? ''), status: String(d.get('status')) };
  return null;
}
