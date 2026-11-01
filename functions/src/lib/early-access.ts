import { createHash, createHmac, randomBytes } from 'node:crypto';
import { EARLY_ACCESS_LIMITS, toMillis, type EarlyAccessRecord, type EarlyAccessSubmission } from '@az-studio/shared';
import { col, db, FieldValue } from './firebase';

/**
 * Early-access list for the public website. Registrations live in `earlyAccess/{sha256(email)}`; per-address
 * counters in `earlyAccessRate/{hmac(ip)}` (deleted after 48 h); the pause switch, the global daily counter and the
 * address-hashing key in `runtime/`. The rules deny every client read and write — only this backend and the
 * owner-only API touch them.
 */

const HOUR = 3_600_000;

export const earlyAccessCol = () => db.collection('earlyAccess');
export const earlyAccessRateCol = () => db.collection('earlyAccessRate');
const metaRef = () => col.runtime().doc('earlyAccess');
const keyRef = () => col.runtime().doc('earlyAccessKey');

/** Registration id: the SHA-256 of the normalised address, so a repeat submission lands on the same document. */
export const registrationId = (email: string) => createHash('sha256').update(email).digest('hex');

let cachedKey: string | null = null;
/** Secret used to hash network addresses (created once, never leaves Firestore's `runtime/`). */
async function addressKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  cachedKey = await db.runTransaction(async (tx) => {
    const snap = await tx.get(keyRef());
    const existing = snap.get('key');
    if (typeof existing === 'string' && existing.length >= 32) return existing;
    const key = randomBytes(32).toString('base64');
    tx.set(keyRef(), { key, createdAt: FieldValue.serverTimestamp() });
    return key;
  });
  return cachedKey;
}

export const _resetEarlyAccessKeyCache = () => void (cachedKey = null);

export type RegisterOutcome = 'stored' | 'repeat' | 'paused' | 'busy' | 'rate_limited';

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utcHour = (ms: number) => new Date(ms).toISOString().slice(0, 13);

/**
 * Stores a validated registration, applying the pause switch, the per-address limits and the global daily cap
 * in one transaction. A repeat of an address already on the list changes nothing anyone can see (only the
 * last-submitted time and a counter), so the caller can answer it exactly like a new registration.
 */
export async function registerEarlyAccess(sub: EarlyAccessSubmission, address: string, now = Date.now()): Promise<RegisterOutcome> {
  const key = await addressKey();
  const addressHash = createHmac('sha256', key).update(address || 'unknown').digest('hex').slice(0, 40);
  const rateRef = earlyAccessRateCol().doc(addressHash);
  const regRef = earlyAccessCol().doc(registrationId(sub.email));
  const day = utcDay(now);
  const hour = utcHour(now);
  return db.runTransaction(async (tx) => {
    const [meta, rate, reg] = await Promise.all([tx.get(metaRef()), tx.get(rateRef), tx.get(regRef)]);
    if (meta.get('paused') === true) return 'paused' as const;
    const globalCount = meta.get('day') === day ? Number(meta.get('dayCount') ?? 0) : 0;
    if (globalCount >= EARLY_ACCESS_LIMITS.globalDay) return 'busy' as const;
    const hourCount = rate.get('hour') === hour ? Number(rate.get('hourCount') ?? 0) : 0;
    const dayCount = rate.get('day') === day ? Number(rate.get('dayCount') ?? 0) : 0;
    if (hourCount >= EARLY_ACCESS_LIMITS.perIpHour || dayCount >= EARLY_ACCESS_LIMITS.perIpDay) return 'rate_limited' as const;

    tx.set(metaRef(), { day, dayCount: globalCount + 1 }, { merge: true });
    tx.set(rateRef, { hour, hourCount: hourCount + 1, day, dayCount: dayCount + 1, expireAt: now + EARLY_ACCESS_LIMITS.rateRetentionHours * HOUR });
    if (reg.exists) {
      tx.update(regRef, { lastSubmittedAt: FieldValue.serverTimestamp(), submissions: FieldValue.increment(1) });
      return 'repeat' as const;
    }
    tx.set(regRef, {
      email: sub.email,
      name: sub.name,
      interest: sub.interest,
      consent: { updates: true, noticeVersion: sub.noticeVersion, at: FieldValue.serverTimestamp() },
      source: 'website',
      createdAt: FieldValue.serverTimestamp(),
      lastSubmittedAt: FieldValue.serverTimestamp(),
      submissions: 1,
    });
    return 'stored' as const;
  });
}

/** Deletes hashed-address counters past their retention (run by azsMaintenance). */
export async function pruneEarlyAccessRate(now = Date.now()): Promise<number> {
  const stale = await earlyAccessRateCol().where('expireAt', '<', now).limit(400).get();
  if (stale.empty) return 0;
  const batch = db.batch();
  for (const d of stale.docs) batch.delete(d.ref);
  await batch.commit();
  return stale.size;
}

export async function listEarlyAccess(): Promise<{ records: EarlyAccessRecord[]; paused: boolean }> {
  const [snap, meta] = await Promise.all([earlyAccessCol().orderBy('createdAt', 'desc').limit(10_000).get(), metaRef().get()]);
  const records = snap.docs.map((d): EarlyAccessRecord => {
    const r = d.data() as Record<string, unknown> & { consent?: { noticeVersion?: string; at?: unknown } };
    return {
      id: d.id,
      email: String(r.email ?? ''),
      name: (r.name as string | null) ?? null,
      interest: (r.interest as EarlyAccessRecord['interest']) ?? null,
      consent: { updates: true, noticeVersion: String(r.consent?.noticeVersion ?? ''), at: toMillis(r.consent?.at as never) },
      createdAt: toMillis(r.createdAt as never),
      lastSubmittedAt: toMillis(r.lastSubmittedAt as never),
      submissions: Number(r.submissions ?? 1),
      source: String(r.source ?? 'website'),
    };
  });
  return { records, paused: meta.get('paused') === true };
}

export async function deleteEarlyAccess(id: string): Promise<boolean> {
  const ref = earlyAccessCol().doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.delete();
  return true;
}

export async function setEarlyAccessPaused(paused: boolean): Promise<boolean> {
  await metaRef().set({ paused, pausedAt: FieldValue.serverTimestamp() }, { merge: true });
  return paused;
}
