import { col, db } from './firebase';

/** A generation slot is considered leaked after this long without release. */
const SLOT_TTL_MS = 60 * 60 * 1000;

/**
 * Acquires one of `max` concurrent generation slots for the owner. Idempotent per job.
 * Returns false when all slots are busy (the caller re-queues the job).
 */
export async function acquireSlot(uid: string, jobId: string, max: number): Promise<boolean> {
  const ref = col.runtime().doc(`${uid}_slots`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const active = { ...((snap.get('active') as Record<string, number> | undefined) ?? {}) };
    for (const [id, t] of Object.entries(active)) if (now - t > SLOT_TTL_MS) delete active[id];
    if (active[jobId]) return true;
    if (Object.keys(active).length >= Math.max(1, max)) return false;
    active[jobId] = now;
    tx.set(ref, { active, updatedAt: now });
    return true;
  });
}

export async function releaseSlot(uid: string, jobId: string): Promise<void> {
  const ref = col.runtime().doc(`${uid}_slots`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const active = { ...((snap.get('active') as Record<string, number> | undefined) ?? {}) };
    if (!(jobId in active)) return;
    delete active[jobId];
    tx.set(ref, { active, updatedAt: Date.now() });
  });
}

export async function activeSlots(uid: string): Promise<string[]> {
  const snap = await col.runtime().doc(`${uid}_slots`).get();
  return Object.keys((snap.get('active') as Record<string, number> | undefined) ?? {});
}
