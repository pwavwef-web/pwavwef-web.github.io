import { httpsCallable, type FunctionsError } from 'firebase/functions';
import type { ApiRequest, CostEstimate, JobRequest, PricingTable, StudioCapabilities, StudioSettings, UsageAggregate } from '@az-studio/shared';
import { functions } from './firebase';

const callable = httpsCallable<ApiRequest, unknown>(functions, 'azsApi', { timeout: 300_000 });

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

type Payload<A extends ApiRequest['action']> = Extract<ApiRequest, { action: A }>['payload'];

/** Calls the owner-only `azsApi` callable. Errors are normalised into readable ApiErrors. */
export async function api<T, A extends ApiRequest['action'] = ApiRequest['action']>(action: A, payload: Payload<A>): Promise<T> {
  try {
    const res = await callable({ action, payload } as ApiRequest);
    return res.data as T;
  } catch (e) {
    const fe = e as FunctionsError & { details?: unknown };
    const code = (fe.code ?? 'unknown').replace(/^functions\//, '');
    let message = fe.message || 'Something went wrong.';
    if (code === 'unavailable' || code === 'deadline-exceeded') message = 'AZ Studio could not reach its backend. Check your connection and try again.';
    if (code === 'unauthenticated') message = 'Your session expired. Sign in again.';
    throw new ApiError(message, code, (fe.details as Record<string, unknown> | undefined) ?? null);
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface SpendSnapshot {
  today: UsageAggregate;
  month: UsageAggregate;
  pendingUsd: number;
  activeJobs: number;
}

export interface BootstrapData {
  owner: { uid: string; email: string };
  capabilities: StudioCapabilities;
  pricing: PricingTable;
  settings: StudioSettings;
  spend: SpendSnapshot;
  stats: { storageBytes?: number; assetCount?: number };
  activeSlots: number;
  serverTime: number;
}

export interface EstimateResponse {
  estimate: CostEstimate;
  perJob: { type: string; label: string; modelId: string | null; estimate: CostEstimate }[];
  confirmation: { required: boolean; reasons: string[] };
  limitProblem: string | null;
  spend: SpendSnapshot;
  settings: StudioSettings;
  batchTooLarge: boolean;
}

export interface SubmitResponse {
  jobIds: string[];
  batchId: string | null;
  estimate: CostEstimate;
}

export const estimateJobs = (jobs: JobRequest[]) => api<EstimateResponse, 'estimate'>('estimate', { jobs });
export const submitJobsRaw = (jobs: JobRequest[], confirmedUsd: number | null, batchLabel?: string) =>
  api<SubmitResponse, 'submitJobs'>('submitJobs', { jobs, confirmedUsd, ...(batchLabel ? { batchLabel } : {}) });
