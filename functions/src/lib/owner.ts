import { HttpsError } from 'firebase-functions/v2/https';
import { OWNER_EMAIL, OWNER_UID } from '../config/runtime';

export interface AuthContext {
  uid: string;
  token: { email?: string; email_verified?: boolean; [k: string]: unknown };
}

export interface Owner {
  uid: string;
  email: string;
}

/** Owner identity from Secret Manager. Both values are required. */
export function ownerConfig(): { uid: string; email: string } {
  const uid = OWNER_UID.value().trim();
  const email = OWNER_EMAIL.value().trim().toLowerCase();
  if (!uid || !email) throw new HttpsError('failed-precondition', 'The studio owner is not configured (AZ_STUDIO_OWNER_UID / AZ_STUDIO_OWNER_EMAIL).');
  return { uid, email };
}

/**
 * Pure check used by the guard and by tests: the caller must be the configured owner UID *and*
 * present the owner's verified email.
 */
export function isOwner(auth: AuthContext | null | undefined, config: { uid: string; email: string }): boolean {
  if (!auth) return false;
  const email = typeof auth.token.email === 'string' ? auth.token.email.toLowerCase() : '';
  return auth.uid === config.uid && email === config.email && auth.token.email_verified === true;
}

export function assertOwner(auth: AuthContext | null | undefined): Owner {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in to use AZ Studio.');
  const config = ownerConfig();
  if (!isOwner(auth, config)) {
    throw new HttpsError('permission-denied', 'AZ Studio is a private studio. This account does not have access.');
  }
  return { uid: auth.uid, email: config.email };
}
