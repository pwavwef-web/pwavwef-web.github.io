import { httpsCallable, type FunctionsError } from 'firebase/functions';
import type { MemberAllowance, MemberEditionStatus, MemberRequest } from '@az-studio/shared';
import { memberFunctions } from './firebase';

const callable = httpsCallable<MemberRequest, unknown>(memberFunctions, 'azsMember', { timeout: 120_000 });

export class MemberApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

/** Calls one member operation. Every check (beta switched on, membership, allowance, credits) happens on the server. */
export async function call<T, O extends MemberRequest['op']>(op: O, payload: Omit<Extract<MemberRequest, { op: O }>, 'op'> | Record<string, never> = {}): Promise<T> {
  try {
    return (await callable({ op, ...payload } as MemberRequest)).data as T;
  } catch (e) {
    const fe = e as FunctionsError;
    const code = (fe.code ?? 'unknown').replace(/^functions\//, '');
    const message = code === 'unavailable' || code === 'deadline-exceeded' ? 'AZ Studio could not be reached. Check your connection and try again.' : fe.message || 'Something went wrong.';
    throw new MemberApiError(message, code);
  }
}

export interface EditionSummary {
  id: string;
  title: string;
  voice: string;
  status: MemberEditionStatus;
  rev: number;
  chars: number;
  sourceUrl: string | null;
  audio: { durationSec: number; bytes: number; at: number } | null;
  error: string | null;
  updatedAt: number;
}

export interface MeResult {
  enabled: true;
  email: string | null;
  emailVerified: boolean;
  member: { wave: string; joinedAt: number } | null;
  revoked?: boolean;
  allowance?: MemberAllowance;
  voices?: { name: string; character: string }[];
  editions?: EditionSummary[];
}

export interface EstimateResult {
  chars: number;
  speechSec: number;
  usd: number;
  credits: number;
  problems: string[];
  allowance: MemberAllowance;
}
