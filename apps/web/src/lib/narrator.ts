import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import type {
  ConsentLocale,
  JobDoc,
  NarrationEstimate,
  NarrationRates,
  NarratorClipDoc,
  NarratorEditionDoc,
  NarratorExportDoc,
  NarratorRecordingDoc,
  NarratorRequest,
  NarratorSettings,
  NarratorTestDoc,
  NarratorVoiceDoc,
  PronunciationEntry,
  RecordingAnalysis,
  SoundCloudLink,
} from '@az-studio/shared';
import { ACTIVE_STATUSES, ENROLLMENT, RETENTION, toMillis } from '@az-studio/shared';
import { api } from './api';
import { db } from './firebase';
import { useDoc, useQuery, type Live, type WithId } from './data';
import { useUid } from './session';

/** Calls one Pwavwe Narrator operation on the owner-only API. */
export function nar<T, O extends NarratorRequest['op'] = NarratorRequest['op']>(op: O, payload: Omit<Extract<NarratorRequest, { op: O }>, 'op'> | Record<string, unknown> = {}): Promise<T> {
  return api<T, 'narrator'>('narrator', { op, ...payload } as NarratorRequest);
}

/** Idempotency key for one user action (a double click or a retried request cannot create a second job). */
export function newRequestId(prefix = 'r'): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}${rnd}`.slice(0, 40);
}

export interface ProviderStatus {
  configured: boolean;
  checkedAt: number;
  models: { id: string; displayName: string; available: boolean; message: string | null; inputTokenLimit: number | null; outputTokenLimit: number | null }[];
  voicesApi: { available: boolean; message: string | null; replicatedVoices: number | null };
  message: string | null;
}

export interface NarratorStatus {
  provider: ProviderStatus;
  model: { id: string; displayName: string; allowed: { id: string; displayName: string }[] };
  rates: NarrationRates;
  voiceCreationCost: string;
  consent: { statements: { locale: ConsentLocale; language: string; text: string }[]; source: { url: string; checkedOn: string } };
  enrollment: typeof ENROLLMENT;
  retention: typeof RETENTION;
  settings: NarratorSettings;
  pronunciations: PronunciationEntry[];
}

export function useNarratorStatus() {
  const [data, setData] = useState<NarratorStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      setData(await nar<NarratorStatus>('status', { refresh }));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(false);
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

/** Newest first (sorted here, so no composite index is needed for these small lists). */
function useSorted<T>(q: Live<WithId<T>[]>, key: (x: WithId<T>) => number): Live<WithId<T>[]> {
  const data = useMemo(() => [...q.data].sort((a, b) => key(b) - key(a)), [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...q, data };
}

export const useVoices = () => {
  const uid = useUid();
  const q = useQuery<NarratorVoiceDoc>(() => (uid ? query(collection(db, 'narratorVoices'), where('ownerUid', '==', uid)) : null), [uid]);
  return useSorted(q, (v) => toMillis(v.createdAt) ?? Date.now());
};

export const useRecordings = () => {
  const uid = useUid();
  return useQuery<NarratorRecordingDoc>(() => (uid ? query(collection(db, 'narratorRecordings'), where('ownerUid', '==', uid), where('status', '==', 'ready')) : null), [uid]);
};

export const useTests = (voiceId: string | null) => {
  const uid = useUid();
  const q = useQuery<NarratorTestDoc>(() => (uid && voiceId ? query(collection(db, 'narratorVoices', voiceId, 'tests'), where('ownerUid', '==', uid)) : null), [uid, voiceId]);
  return useSorted(q, (t) => toMillis(t.createdAt) ?? Date.now());
};

export const useEditions = () => {
  const uid = useUid();
  const q = useQuery<NarratorEditionDoc>(() => (uid ? query(collection(db, 'narratorEditions'), where('ownerUid', '==', uid)) : null), [uid]);
  return useSorted(q, (e) => toMillis(e.updatedAt) ?? Date.now());
};

export const useEdition = (editionId: string | undefined) => useDoc<NarratorEditionDoc>(editionId ? `narratorEditions/${editionId}` : null);

export const useClips = (editionId: string | undefined) => {
  const uid = useUid();
  return useQuery<NarratorClipDoc>(() => (uid && editionId ? query(collection(db, 'narratorEditions', editionId, 'clips'), where('ownerUid', '==', uid)) : null), [uid, editionId]);
};

export const useExports = (editionId: string | undefined) => {
  const uid = useUid();
  const q = useQuery<NarratorExportDoc>(() => (uid && editionId ? query(collection(db, 'narratorEditions', editionId, 'exports'), where('ownerUid', '==', uid)) : null), [uid, editionId]);
  return useSorted(q, (e) => e.version);
};

/** Active narrator jobs (generation, voice creation, export) — the source of truth for "generating". */
export const useNarratorJobs = () => {
  const uid = useUid();
  const q = useQuery<JobDoc>(() => (uid ? query(collection(db, 'jobs'), where('ownerUid', '==', uid), where('status', 'in', [...ACTIVE_STATUSES])) : null), [uid]);
  return { ...q, data: q.data.filter((j) => j.type.startsWith('narrator.')) };
};

export const useJob = (jobId: string | null | undefined) => useDoc<JobDoc>(jobId ? `jobs/${jobId}` : null);

/** Auto-direct jobs of one edition (finished ones carry suggestions to merge into the draft). */
export const useDirectJobs = (editionId: string | undefined) => {
  const uid = useUid();
  const q = useQuery<JobDoc>(() => (uid && editionId ? query(collection(db, 'jobs'), where('ownerUid', '==', uid), where('type', '==', 'narrator.direct')) : null), [uid, editionId]);
  return { ...q, data: q.data.filter((j) => (j.params as { editionId?: string }).editionId === editionId) };
};

type MediaRef = { kind: 'recording' | 'clip' | 'test' | 'export'; id: string; editionId?: string; voiceId?: string; file?: 'wav' | 'mp3' | 'transcript' | 'chapters' };
const urlCache = new Map<string, { url: string; expiresAt: number }>();
const keyOf = (r: MediaRef) => `${r.kind}:${r.editionId ?? ''}:${r.voiceId ?? ''}:${r.id}:${r.file ?? ''}`;

/** A short-lived signed URL (15 min), refreshed shortly before it expires. */
export async function narratorMediaUrl(ref: MediaRef, download = false): Promise<string> {
  const k = keyOf(ref);
  const hit = urlCache.get(k);
  if (!download && hit && hit.expiresAt - Date.now() > 90_000) return hit.url;
  const res = await nar<{ url: string; expiresAt: number }>('mediaUrl', { ...ref, download });
  if (!download) urlCache.set(k, res);
  return res.url;
}

export function useNarratorMedia(ref: MediaRef | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const k = ref ? keyOf(ref) : null;
  const latest = useRef(ref);
  latest.current = ref;
  useEffect(() => {
    if (!k || !latest.current) {
      setUrl(null);
      return;
    }
    let live = true;
    const refresh = () =>
      void narratorMediaUrl(latest.current!)
        .then((u) => live && setUrl(u))
        .catch(() => live && setUrl(null));
    refresh();
    const t = setInterval(refresh, 12 * 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [k]);
  return url;
}

export async function downloadNarratorFile(ref: MediaRef): Promise<void> {
  const url = await narratorMediaUrl(ref, true);
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'));
    r.readAsDataURL(file);
  });
}

export interface UploadResult {
  recordingId: string;
  analysis: RecordingAnalysis;
}

export interface EstimateResult {
  items: { key: string; passageId: string | null; chars: number; requests: number }[];
  reuse: { passageId: string; clipId: string }[];
  skipped: { passageId: string; reason: string }[];
  estimate: NarrationEstimate;
  budgetUsd: number;
  limitProblem: string | null;
  confirmationRequired: boolean;
}

export type { SoundCloudLink, WithId };
