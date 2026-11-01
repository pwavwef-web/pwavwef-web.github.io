import { createHash } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { normalizeBetaLimits, type BetaLimits } from '@az-studio/shared';
import { BETA_BUCKET, BETA_DATABASE, BETA_ENV_OFF, BETA_IS_SEPARATE, BETA_PROJECT } from '../config/beta';
import { bucket, db } from './firebase';

/**
 * Public-beta persistence. Everything a member owns is under `members/{uid}` (editions, credit ledger); invitations are
 * `invites/{sha256(code)}`; feedback `betaFeedback/{id}`; the global daily spend `runtime/beta-spend-{day}`. The rules
 * match none of these for any client (deny-by-default) — the member callable and the owner-only API are the only way
 * in, and each checks who is calling.
 */

function separate() {
  const name = 'az-studio-beta';
  const app = getApps().find((a) => a.name === name) ?? initializeApp({ projectId: BETA_PROJECT, storageBucket: BETA_BUCKET }, name);
  const d = getFirestore(app, BETA_DATABASE);
  d.settings({ ignoreUndefinedProperties: true });
  return { db: d, bucket: getStorage(app).bucket(BETA_BUCKET) };
}

const store = BETA_IS_SEPARATE ? separate() : { db, bucket };
export const bdb = store.db;
export const bbucket = store.bucket;

export const bcol = {
  members: () => bdb.collection('members'),
  editions: (uid: string) => bdb.collection('members').doc(uid).collection('editions'),
  ledger: (uid: string) => bdb.collection('members').doc(uid).collection('ledger'),
  invites: () => bdb.collection('invites'),
  feedback: () => bdb.collection('betaFeedback'),
  features: () => bdb.collection('runtime').doc('features'),
  /** Recorded and reserved spend of all members together for one UTC day (the circuit breaker). */
  spend: (day: string) => bdb.collection('runtime').doc(`beta-spend-${day}`),
};

export const bpath = {
  editionDir: (uid: string, editionId: string) => `members/${uid}/editions/${editionId}/`,
  chunk: (uid: string, editionId: string, jobId: string, i: number) => `members/${uid}/editions/${editionId}/chunks/${jobId}-${i}.wav`,
  audio: (uid: string, editionId: string, jobId: string) => `members/${uid}/editions/${editionId}/${jobId}.mp3`,
};

export const inviteId = (code: string) => createHash('sha256').update(`az-studio-invite:${code}`).digest('hex');

export interface BetaState {
  enabled: boolean;
  reason: string | null;
  limits: BetaLimits;
}

/**
 * `runtime/features` → `{ beta: { enabled: true, limits?: {…} } }`. Missing, false or unreadable = off; the deployment's
 * `AZS_FEATURE_BETA=off` overrides the flag. Off means every member operation is refused before anything is read.
 */
export async function betaState(): Promise<BetaState> {
  if (BETA_ENV_OFF()) return { enabled: false, reason: 'The beta is switched off for this deployment (AZS_FEATURE_BETA=off).', limits: normalizeBetaLimits(null) };
  let flag: { enabled?: unknown; limits?: unknown } | undefined;
  try {
    flag = (await bcol.features().get()).get('beta') as typeof flag;
  } catch {
    flag = undefined;
  }
  if (!flag || flag.enabled !== true) return { enabled: false, reason: 'The beta is switched off (runtime/features.beta.enabled is not true).', limits: normalizeBetaLimits(flag?.limits) };
  return { enabled: true, reason: null, limits: normalizeBetaLimits(flag.limits) };
}
