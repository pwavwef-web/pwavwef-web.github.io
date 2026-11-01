import { HttpsError } from 'firebase-functions/v2/https';
import type { MemberDoc } from '@az-studio/shared';
import { bcol, betaState, type BetaState } from './beta-store';
import type { AuthContext } from './owner';

/**
 * The member role, separate from the owner. `assertOwner` (owner.ts) is untouched and stays the only gate of `azsApi`;
 * members reach only the `azsMember` callable, and every member operation passes one of these two checks first:
 *
 * - `assertBetaCaller`: the beta is switched on and the caller is signed in (for `me` and `redeem`, which work
 *   before membership exists).
 * - `assertMember`: additionally a verified email and an active `members/{uid}` record for that same email
 *   (created only by redeeming an invitation).
 *
 * With the beta off both refuse before reading anything else, so nothing changes for anyone.
 */

export interface BetaCaller {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  state: BetaState;
}

export interface Member extends BetaCaller {
  email: string;
  member: MemberDoc;
}

export const BETA_CLOSED = 'The AZ Studio beta is not open.';

export async function assertBetaCaller(auth: AuthContext | null | undefined): Promise<BetaCaller> {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in to use the AZ Studio beta.');
  const state = await betaState();
  if (!state.enabled) throw new HttpsError('permission-denied', BETA_CLOSED);
  const email = typeof auth.token.email === 'string' ? auth.token.email.trim().toLowerCase() : null;
  return { uid: auth.uid, email, emailVerified: auth.token.email_verified === true, state };
}

export async function assertMember(auth: AuthContext | null | undefined): Promise<Member> {
  const caller = await assertBetaCaller(auth);
  if (!caller.email || !caller.emailVerified) throw new HttpsError('permission-denied', 'Verify your email address to use the beta.');
  const snap = await bcol.members().doc(caller.uid).get();
  const member = snap.exists ? (snap.data() as MemberDoc) : null;
  if (!member) throw new HttpsError('permission-denied', 'This account has not joined the beta. Redeem your invitation first.');
  if (member.status !== 'active') throw new HttpsError('permission-denied', 'Your beta access has ended.');
  if (member.email.toLowerCase() !== caller.email) throw new HttpsError('permission-denied', 'This account’s email no longer matches the invitation.');
  return { ...caller, email: caller.email, member };
}
