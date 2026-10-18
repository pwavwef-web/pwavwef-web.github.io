import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, buildScript, makeDirection, decodePcm16Wav, encodePcm16Wav, flattenScript, type JobDoc, type NarratorClipDoc, type NarratorEditionDoc, type NarratorExportDoc } from '@az-studio/shared';
import { doc, docs, resetFakes, store, tasks } from './fakes';

/**
 * Pwavwe Narrator backend with MOCKED provider calls (no request reaches Google): authorisation, idempotent
 * jobs, chunk order, retries, ambiguous requests, cancellation and per-passage invalidation. The export test
 * runs the real FFmpeg pipeline on synthetic audio. Live provider checks are separate (see docs/OPERATIONS.md).
 */

vi.mock('../src/lib/firebase', async () => import('./fakes'));
vi.mock('firebase-admin/functions', async () => {
  const f = await import('./fakes');
  return { getFunctions: () => ({ taskQueue: () => ({ enqueue: async (payload: never, opts?: { scheduleDelaySeconds?: number }) => void f.tasks.push({ payload, delaySec: opts?.scheduleDelaySeconds ?? 0 }) }) }) };
});
vi.mock('firebase-functions', async (orig) => ({ ...(await orig<typeof import('firebase-functions')>()), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/lib/storage', () => ({ signedReadUrl: async (path: string, o: { ttlSeconds?: number; downloadName?: string }) => ({ url: `https://signed.example/${path}?ttl=${o.ttlSeconds}${o.downloadName ? `&name=${o.downloadName}` : ''}`, expiresAt: Date.now() + (o.ttlSeconds ?? 0) * 1000 }) }));

const files = new Map<string, Buffer>();
vi.mock('../src/lib/narrator-store', async (orig) => {
  const real = await orig<typeof import('../src/lib/narrator-store')>();
  return {
    ...real,
    media: {
      save: async (p: string, data: Uint8Array) => void files.set(p, Buffer.from(data)),
      read: async (p: string) => {
        const b = files.get(p);
        if (!b) throw new Error(`missing ${p}`);
        return b;
      },
      remove: async (p: string) => void files.delete(p),
      removePrefix: async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)).forEach((k) => files.delete(k)),
      size: async (p: string) => (files.has(p) ? files.get(p)!.length : null),
      staleUnder: async () => [] as string[],
    },
  };
});

const synthesize = vi.fn();
const transcribeMock = vi.fn();
vi.mock('../src/lib/audio-models', async (orig) => ({ ...(await orig<typeof import('../src/lib/audio-models')>()), transcribe: (...a: unknown[]) => transcribeMock(...a) }));
const createVoice = vi.fn();
const listReplicatedVoices = vi.fn();
const callReasoning = vi.fn();
vi.mock('../src/workers/text', async (orig) => ({ ...(await orig<typeof import('../src/workers/text')>()), callReasoning: (...a: unknown[]) => callReasoning(...a), usageFor: async () => 0 }));
vi.mock('../src/lib/interactions', () => ({ logInteraction: async () => undefined }));

vi.mock('../src/lib/narrator-provider', async (orig) => {
  const real = await orig<typeof import('../src/lib/narrator-provider')>();
  return { ...real, providerConfigured: async () => true, synthesize: (...a: unknown[]) => synthesize(...a), createVoice: (...a: unknown[]) => createVoice(...a), listReplicatedVoices: (...a: unknown[]) => listReplicatedVoices(...a) };
});

import { narrator } from '../src/api/narrator';
import { claimJob } from '../src/lib/jobs';
import { NarratorProviderError } from '../src/lib/narrator-provider';
import { continueNarratorSpeakJob, narratorRetryTiming, runNarratorExportJob, runNarratorSpeakJob, runNarratorVoiceJob } from '../src/workers/narrator';
import { runNarratorDirectJob } from '../src/workers/narrator-direct';
import { clearLimit, gateOverrides, resetDailyCount } from '../src/lib/narrator-limits';

const owner = { uid: 'u', email: 'o@x' };
type Said = { segments: { text: string; style: string }[] };
/** The words sent in one synthesis request (all its text blocks). */
const said = (input: unknown) => (input as Said).segments.map((x) => x.text).join(' ');
const RATE = 24000;
narratorRetryTiming.baseMs = 1;
narratorRetryTiming.gateWaitMs = 50;
gateOverrides.developer = { minIntervalMs: 0 };
gateOverrides.vertex = { minIntervalMs: 0 };

function speechWav(sec: number, freq = 180): Buffer {
  const s = new Float32Array(Math.round(sec * RATE));
  for (let i = 0; i < s.length; i++) {
    const t = i / RATE;
    const env = t < 0.2 || t > sec - 0.2 ? 0 : Math.sin(Math.PI * ((t * 4) % 1)) ** 2;
    s[i] = 0.3 * env * Math.sin(2 * Math.PI * freq * t);
  }
  return Buffer.from(encodePcm16Wav(s, RATE));
}

const BODY = 'First paragraph about Kasem.\n\nSecond paragraph.\n\n## A heading\n\nThird paragraph.';

function seed(): { editionId: string; passageIds: string[] } {
  let n = 0;
  const { script } = buildScript({ title: 'A Paper', body: BODY }, () => `p${n++}`);
  const edition: NarratorEditionDoc = {
    ownerUid: 'u',
    title: 'A Paper',
    author: 'Francis Pwavwe',
    publishedDate: '2026-10-07',
    sourceUrl: 'https://blogs.pwavwe.com/2026/10/a-paper.html',
    voiceId: 'v1',
    article: { body: BODY, origin: 'paste', importedAt: null, notes: [] },
    script,
    settings: { preset: 'conversational', customStyle: '', includeClosing: true, pauses: { afterOpeningSec: 1.2, betweenParagraphsSec: 0.7, betweenSectionsSec: 1.4, afterHeadingSec: 0.6, beforeClosingSec: 1.4 } },
    takes: {},
    soundcloud: { title: '', description: '', link: null },
    rev: 1,
    lastExportId: null,
    deleted: false,
  };
  store.set('narratorEditions/e1', edition as never);
  return { editionId: 'e1', passageIds: flattenScript(script).map((f) => f.passage.id) };
}

beforeEach(() => {
  resetFakes();
  files.clear();
  synthesize.mockReset();
  transcribeMock.mockReset();
  transcribeMock.mockRejectedValue(new Error('no transcription in this test'));
  createVoice.mockReset();
  listReplicatedVoices.mockReset();
  store.set('users/u', { settings: { ...DEFAULT_SETTINGS, dailyLimitUsd: 1000, monthlyLimitUsd: 1000 } });
  store.set('narratorVoices/v1', { ownerUid: 'u', displayName: 'Francis — Pwavwe Papers', modelId: 'gemini-3.8-flash-tts', status: 'active', approval: { state: 'approved' }, consent: { state: 'verified' } });
  store.set('narratorVoices/v1/private/provider', { providerVoiceId: 'voice_abc' });
  synthesize.mockImplementation(async (input: Said) => ({ wav: speechWav(Math.max(1, said(input).length / 15)), sampleRate: RATE, inputTokens: 10, outputTokens: 50 }));
});

const jobs = () => docs<JobDoc>('jobs');
const clips = (e = 'e1') => docs<NarratorClipDoc>(`narratorEditions/${e}/clips`);
async function run(jobId: string) {
  const claimed = await claimJob(jobId);
  expect(claimed).not.toBeNull();
  if (claimed!.type === 'narrator.speak') await runNarratorSpeakJob(claimed!);
  else if (claimed!.type === 'narrator.export') await runNarratorExportJob(claimed!);
  else if (claimed!.type === 'narrator.direct') await runNarratorDirectJob(claimed!);
  else await runNarratorVoiceJob(claimed!);
  return doc(`jobs/${jobId}`) as JobDoc;
}

describe('ownership isolation', () => {
  it('refuses another account’s editions, voices and media', async () => {
    seed();
    store.set('narratorEditions/e2', { ...(doc('narratorEditions/e1') as object), ownerUid: 'someone-else' });
    store.set('narratorEditions/e2/clips/c9', { ownerUid: 'someone-else', storagePath: 'users/someone-else/x.wav', passageId: 'p1', status: 'ready' });
    await expect(narrator(owner, { op: 'editionSave', editionId: 'e2', baseRev: 1, patch: { title: 'Mine now' } })).rejects.toThrow(/not found/i);
    await expect(narrator(owner, { op: 'mediaUrl', kind: 'clip', id: 'c9', editionId: 'e2', download: false })).rejects.toThrow(/not found/i);
    await expect(narrator(owner, { op: 'generate', editionId: 'e2', scope: 'edition', passageIds: [], force: false, requestId: 'req-aaaaaaaa', confirmedUsd: 1 })).rejects.toThrow(/not found/i);
    store.set('narratorVoices/v9', { ownerUid: 'someone-else', displayName: 'X', status: 'active' });
    await expect(narrator(owner, { op: 'voiceTest', voiceId: 'v9', text: 'Hi', preset: 'conversational', customStyle: '', requestId: 'req-bbbbbbbb' })).rejects.toThrow(/not found/i);
    expect(jobs()).toHaveLength(0);
  });

  it('issues short-lived media links only for the owner’s files', async () => {
    seed();
    store.set('narratorEditions/e1/clips/c1', { ownerUid: 'u', storagePath: 'users/u/narrator/editions/e1/clips/c1.wav', passageId: 'p1', status: 'ready' });
    const r = (await narrator(owner, { op: 'mediaUrl', kind: 'clip', id: 'c1', editionId: 'e1', download: false })) as { url: string };
    expect(r.url).toContain('ttl=900');
  });
});

describe('generation', () => {
  it('requires a confirmed estimate for a full edition and never creates duplicate jobs', async () => {
    const { passageIds } = seed();
    const est = (await narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'edition', passageIds: [], force: false })) as { items: unknown[]; estimate: { usd: number } };
    expect(est.items).toHaveLength(passageIds.length);
    await expect(narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-11111111', confirmedUsd: null })).rejects.toThrow(/Confirm/);
    const a = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-11111111', confirmedUsd: est.estimate.usd })) as { jobId: string };
    const b = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-11111111', confirmedUsd: est.estimate.usd })) as { jobId: string; duplicate: boolean };
    expect(b).toMatchObject({ jobId: a.jobId, duplicate: true });
    // A second click with a new request id while the first runs: every passage is already in flight.
    const c = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-22222222', confirmedUsd: est.estimate.usd })) as { jobId: string | null };
    expect(c.jobId).toBeNull();
    expect(jobs()).toHaveLength(1);
    expect(tasks).toHaveLength(1);
  });

  it('speaks every passage in order, chunk by chunk, records usage and selects the takes', async () => {
    const { passageIds } = seed();
    const est = (await narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'edition', passageIds: [], force: false })) as { estimate: { usd: number } };
    const { jobId } = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-33333333', confirmedUsd: est.estimate.usd })) as { jobId: string };
    const job = await run(jobId);
    expect(job.status).toBe('completed');
    const spoken = synthesize.mock.calls.map((c) => said(c[0]));
    const ed = doc('narratorEditions/e1') as NarratorEditionDoc;
    expect(spoken).toEqual(flattenScript(ed.script).map((f) => f.passage.text));
    expect(synthesize.mock.calls[0]![0]).toMatchObject({ voiceId: 'voice_abc', modelId: 'gemini-3.8-flash-tts', segments: [{ style: 'natural and conversational' }] });
    expect(Object.keys(ed.takes).sort()).toEqual([...passageIds].sort());
    expect(clips().every((c) => c.status === 'ready' && c.version === 1)).toBe(true);
    expect(docs('usage')).toHaveLength(passageIds.length);
    expect([...files.keys()].some((k) => k.includes('/chunks/'))).toBe(false); // intermediate chunks cleaned up
  });

  it('regenerates only the edited passage and keeps the earlier take', async () => {
    const { passageIds } = seed();
    const est = (await narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'edition', passageIds: [], force: false })) as { estimate: { usd: number } };
    const first = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-44444444', confirmedUsd: est.estimate.usd })) as { jobId: string };
    await run(first.jobId);
    synthesize.mockClear();
    const ed = doc('narratorEditions/e1') as NarratorEditionDoc;
    const target = ed.script.sections[0]!.passages[1]!;
    const script = { ...ed.script, sections: ed.script.sections.map((s, i) => (i === 0 ? { ...s, passages: s.passages.map((p) => (p.id === target.id ? { ...p, text: 'Second paragraph, revised.' } : p)) } : s)) };
    await narrator(owner, { op: 'editionSave', editionId: 'e1', baseRev: 1, patch: { script } });
    // A stale take can never be exported.
    await expect(narrator(owner, { op: 'exportStart', editionId: 'e1', requestId: 'req-x0000000' })).rejects.toThrow(/out-of-date/);
    const plan = (await narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'edition', passageIds: [], force: false })) as { items: { passageId: string }[]; skipped: unknown[] };
    expect(plan.items.map((i) => i.passageId)).toEqual([target.id]);
    expect(plan.skipped).toHaveLength(passageIds.length - 1);
    const second = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'passages', passageIds: [target.id], force: false, requestId: 'req-55555555', confirmedUsd: 1 })) as { jobId: string };
    await run(second.jobId);
    expect(synthesize).toHaveBeenCalledTimes(1);
    const takes = clips().filter((c) => c.passageId === target.id);
    expect(takes.map((c) => c.version).sort()).toEqual([1, 2]);
    const selected = (doc('narratorEditions/e1') as NarratorEditionDoc).takes[target.id];
    expect(takes.find((c) => c.id === selected)!.version).toBe(2);
  });

  it('a stale edit conflict from another tab is refused', async () => {
    seed();
    await narrator(owner, { op: 'editionSave', editionId: 'e1', baseRev: 1, patch: { title: 'One' } });
    await expect(narrator(owner, { op: 'editionSave', editionId: 'e1', baseRev: 1, patch: { title: 'Two' } })).rejects.toThrow(/another tab/);
    expect((doc('narratorEditions/e1') as NarratorEditionDoc).title).toBe('One');
  });

  it('retries refused requests, but never resends an ambiguous one', async () => {
    const { passageIds } = seed();
    let calls = 0;
    synthesize.mockImplementation(async (input: Said) => {
      calls++;
      if (calls === 1) throw new NarratorProviderError('rate_limited', 'Too many requests', 429);
      if (said(input) === 'Second paragraph.') throw new NarratorProviderError('ambiguous', 'No answer within 240 s.');
      return { wav: speechWav(1), sampleRate: RATE, inputTokens: 1, outputTokens: 25 };
    });
    const { jobId } = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-66666666', confirmedUsd: 1 })) as { jobId: string };
    const job = await run(jobId);
    const texts = synthesize.mock.calls.map((c) => said(c[0]));
    expect(texts.filter((t) => t === 'Second paragraph.')).toHaveLength(1);
    expect(texts[0]).toBe(texts[1]); // the 429 was retried
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'needs_recovery', ambiguous: true });
    const problem = clips().find((c) => c.status === 'needs_recovery')!;
    expect(problem.text).toBe('Second paragraph.');
    expect(clips().filter((c) => c.status === 'ready')).toHaveLength(passageIds.length - 1);
  });

  it('after a worker restart, the request that was in flight is marked for recovery instead of being resent', async () => {
    seed();
    const { jobId } = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'passages', passageIds: ['p1', 'p2'], force: false, requestId: 'req-77777777', confirmedUsd: 1 })) as { jobId: string };
    await claimJob(jobId);
    store.set(`jobs/${jobId}`, { ...doc(`jobs/${jobId}`)!, status: 'generating', external: { narrator: { chunks: {}, done: {}, failed: {}, inflight: { key: 'p1', chunk: 0, at: 1 }, spentUsd: 0.001, slice: 3 } } });
    await continueNarratorSpeakJob({ ...(doc(`jobs/${jobId}`) as JobDoc), id: jobId }, 3);
    expect(synthesize.mock.calls.map((c) => said(c[0]))).toEqual(['Second paragraph.']);
    expect(clips().find((c) => c.passageId === 'p1')!.status).toBe('needs_recovery');
  });

  it('cancelling stops the remaining passages and keeps finished ones', async () => {
    seed();
    synthesize.mockImplementation(async () => {
      store.set('jobs/nars-req-88888888', { ...doc('jobs/nars-req-88888888')!, cancelRequested: true });
      return { wav: speechWav(1), sampleRate: RATE, inputTokens: 1, outputTokens: 25 };
    });
    await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-88888888', confirmedUsd: 1 });
    const job = await run('nars-req-88888888');
    expect(job.status).toBe('cancelled');
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(clips().filter((c) => c.status === 'ready')).toHaveLength(1);
  });

  it('a used-up daily allowance is sent once, stops the job and blocks new requests until Google\'s retry time', async () => {
    seed();
    synthesize.mockRejectedValue(new NarratorProviderError('quota', "Rate limit exceeded for model gemini-3.8-flash-tts (limit: 100 requests per day on Tier 1). Please retry in 21h2m35s or upgrade your tier at https://ai.dev/rate-limit.", 429, 'RESOURCE_EXHAUSTED', 75755));
    const r = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-quota001', confirmedUsd: 1 })) as { jobId: string };
    const job = await run(r.jobId);
    expect(job.status).toBe('failed');
    expect(synthesize).toHaveBeenCalledTimes(1); // not retried, and the other passages were not attempted
    expect(clips().every((c) => c.status === 'failed')).toBe(true);
    expect(clips().find((c) => c.error?.message.includes('100 requests per day'))).toBeDefined();
    const est = (await narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'edition', passageIds: [], force: false })) as { limitProblem: string | null };
    expect(est.limitProblem).toMatch(/request limit for gemini-3\.8-flash-tts \(Gemini Developer API\) is used up for now \(Rate limit exceeded for model gemini-3\.8-flash-tts \(limit: 100 requests per day on Tier 1\)\.\) Nothing/);
    await expect(narrator(owner, { op: 'generate', editionId: 'e1', scope: 'passages', passageIds: ['p1'], force: false, requestId: 'req-quota002', confirmedUsd: 1 })).rejects.toThrow(/used up/);
    await expect(narrator(owner, { op: 'voiceTest', voiceId: 'v1', text: 'Hi', preset: 'conversational', customStyle: '', requestId: 'req-quota003' })).rejects.toThrow(/used up/);
    expect(synthesize).toHaveBeenCalledTimes(1);
    // Settings → Check now clears the block (e.g. after raising the API tier).
    store.set('runtime/narrator-status', { configured: true, checkedAt: Date.now(), models: [], voicesApi: { available: true, message: null, replicatedVoices: 1 }, message: null });
    const st = (await narrator(owner, { op: 'status', refresh: false })) as { limits: unknown[] };
    expect(st.limits).toHaveLength(1);
    await clearLimit('gemini-3.8-flash-tts');
    await resetDailyCount('developer', 'gemini-3.8-flash-tts');
    const est2 = (await narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'edition', passageIds: [], force: false })) as { limitProblem: string | null };
    expect(est2.limitProblem).toBeNull();
  });

  it('a voice Google no longer has stops the job and marks the voice for renewal', async () => {
    seed();
    synthesize.mockRejectedValue(new NarratorProviderError('not_found', 'Voice not found', 404));
    await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'passages', passageIds: ['p1'], force: false, requestId: 'req-99999999', confirmedUsd: 1 });
    const job = await run('nars-req-99999999');
    expect(job.status).toBe('failed');
    expect(doc('narratorVoices/v1')!.status).toBe('missing_at_provider');
    await expect(narrator(owner, { op: 'generate', editionId: 'e1', scope: 'passages', passageIds: ['p1'], force: false, requestId: 'req-a9999999', confirmedUsd: 1 })).rejects.toThrow(/not available/);
  });

  it('approving through the API stores the approved state the rest of the studio checks', async () => {
    seed();
    store.set('narratorVoices/v1', { ...doc('narratorVoices/v1')!, approval: { state: 'pending', at: null, assessment: null, preset: null } });
    store.set('narratorVoices/v1/tests/t1', { ownerUid: 'u', voiceId: 'v1', status: 'ready' });
    await expect(narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'edition', passageIds: [], force: false })).rejects.toThrow(/Approve your voice/);
    const assessment = { naturalness: 5, resemblance: 5, accent: 5, pronunciation: 4, pacing: 5, notes: '' };
    await narrator(owner, { op: 'voiceAssess', voiceId: 'v1', decision: 'approve', assessment, preset: 'conversational' });
    expect(doc('narratorVoices/v1')!.approval).toMatchObject({ state: 'approved', assessment, preset: 'conversational' });
    const est = (await narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'edition', passageIds: [], force: false })) as { items: unknown[] };
    expect(est.items.length).toBeGreaterThan(0);
    await narrator(owner, { op: 'voiceAssess', voiceId: 'v1', decision: 'reject', assessment, preset: 'conversational' });
    expect(doc('narratorVoices/v1')!.approval.state).toBe('rejected');
    await expect(narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'edition', passageIds: [], force: false })).rejects.toThrow(/Approve your voice/);
  });

  it('refuses edition narration with an unapproved voice (selection previews still work)', async () => {
    seed();
    store.set('narratorVoices/v1', { ...doc('narratorVoices/v1')!, approval: { state: 'pending' } });
    await expect(narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'edition', passageIds: [], force: false })).rejects.toThrow(/Approve your voice/);
    const r = (await narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'selection', passageIds: [], selection: 'Kasem matters.', force: false })) as { items: unknown[] };
    expect(r.items).toHaveLength(1);
  });
});

describe('voice creation', () => {
  beforeEach(() => {
    store.delete('narratorVoices/v1');
    const analysis = { durationSec: 15, speechSec: 12, peakDbfs: -6, rmsDbfs: -22, clippedPct: 0, noiseFloorDbfs: -60, longestPauseSec: 0.6, leadingSilenceSec: 0.3, trailingSilenceSec: 0.4, issues: [] };
    store.set('narratorRecordings/ref', { ownerUid: 'u', kind: 'reference', status: 'ready', storagePath: 'users/u/narrator/recordings/ref.wav', analysis });
    store.set('narratorRecordings/con', { ownerUid: 'u', kind: 'consent', status: 'ready', storagePath: 'users/u/narrator/recordings/con.wav', analysis: { ...analysis, durationSec: 6 } });
    files.set('users/u/narrator/recordings/ref.wav', speechWav(15));
    files.set('users/u/narrator/recordings/con.wav', speechWav(6));
  });

  it('creates one voice per request, deletes the consent clip and keeps provider ids server-side', async () => {
    createVoice.mockResolvedValue({ voiceId: 'voice_new' });
    const req = { op: 'voiceCreate' as const, referenceId: 'ref', consentId: 'con', consentLocale: 'en-GB' as const, requestId: 'req-voice001', attestSameAdultSpeaker: true as const };
    const a = (await narrator(owner, req)) as { voiceId: string; jobId: string };
    const b = (await narrator(owner, req)) as { voiceId: string; duplicate: boolean };
    expect(b).toMatchObject({ voiceId: a.voiceId, duplicate: true });
    const job = await run(a.jobId);
    expect(job.status).toBe('completed');
    expect(createVoice).toHaveBeenCalledTimes(1);
    expect(createVoice.mock.calls[0]![0]).toMatchObject({ modelId: 'gemini-3.8-flash-tts', displayName: 'Francis — Pwavwe Papers' });
    const v = doc(`narratorVoices/${a.voiceId}`)!;
    expect(v).toMatchObject({ status: 'active', consent: { state: 'verified' }, approval: { state: 'pending' } });
    expect(JSON.stringify(v)).not.toContain('voice_new');
    expect(doc(`narratorVoices/${a.voiceId}/private/provider`)!.providerVoiceId).toBe('voice_new');
    expect(doc('narratorRecordings/con')).toMatchObject({ status: 'deleted', storagePath: null });
    expect(files.has('users/u/narrator/recordings/con.wav')).toBe(false);
    expect(doc('narratorRecordings/ref')!.usedByVoiceId).toBe(a.voiceId);
  });

  it('records a refused consent without retrying', async () => {
    createVoice.mockRejectedValue(new NarratorProviderError('policy', 'Consent audio did not match the reference speaker.', 400));
    const a = (await narrator(owner, { op: 'voiceCreate', referenceId: 'ref', consentId: 'con', consentLocale: 'en-US', requestId: 'req-voice002', attestSameAdultSpeaker: true })) as { voiceId: string; jobId: string };
    const job = await run(a.jobId);
    expect(job.status).toBe('failed');
    expect(createVoice).toHaveBeenCalledTimes(1);
    expect(doc(`narratorVoices/${a.voiceId}`)).toMatchObject({ status: 'failed', consent: { state: 'rejected' } });
  });

  it('after an ambiguous answer, links the voice Google created instead of creating another', async () => {
    createVoice.mockRejectedValue(new NarratorProviderError('ambiguous', 'Connection dropped.'));
    listReplicatedVoices.mockResolvedValue([{ id: 'voice_found', displayName: 'Francis — Pwavwe Papers', type: 'replicated', createTime: new Date(Date.now() + 1000).toISOString() }]);
    const a = (await narrator(owner, { op: 'voiceCreate', referenceId: 'ref', consentId: 'con', consentLocale: 'en-US', requestId: 'req-voice003', attestSameAdultSpeaker: true })) as { voiceId: string; jobId: string };
    const job = await run(a.jobId);
    expect(job.status).toBe('completed');
    expect(createVoice).toHaveBeenCalledTimes(1);
    expect(doc(`narratorVoices/${a.voiceId}/private/provider`)!.providerVoiceId).toBe('voice_found');
  });

  it('refuses recordings with blocking problems', async () => {
    store.set('narratorRecordings/ref', { ...doc('narratorRecordings/ref')!, analysis: { ...doc('narratorRecordings/ref')!.analysis, issues: [{ code: 'too_short', severity: 'error', message: 'Too short.' }] } });
    await expect(narrator(owner, { op: 'voiceCreate', referenceId: 'ref', consentId: 'con', consentLocale: 'en-US', requestId: 'req-voice004', attestSameAdultSpeaker: true })).rejects.toThrow(/Too short/);
    expect(jobs()).toHaveLength(0);
  });
});

describe('export (real FFmpeg)', () => {
  it('joins decoded takes with the configured pauses, normalises loudness and writes WAV, MP3, transcript and sections', async () => {
    const { passageIds } = seed();
    const { jobId } = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-e0000001', confirmedUsd: 1 })) as { jobId: string };
    await run(jobId);
    const ex = (await narrator(owner, { op: 'exportStart', editionId: 'e1', requestId: 'req-e0000002' })) as { jobId: string; exportId: string };
    const dup = (await narrator(owner, { op: 'exportStart', editionId: 'e1', requestId: 'req-e0000002' })) as { duplicate: boolean };
    expect(dup.duplicate).toBe(true);
    const job = await run(ex.jobId);
    expect(job.status, JSON.stringify(job.error)).toBe('completed');
    const out = doc(`narratorEditions/e1/exports/${ex.exportId}`) as NarratorExportDoc;
    expect(out.status).toBe('ready');
    expect(out.parts.map((p) => p.passageId)).toEqual(passageIds);
    for (let i = 1; i < out.parts.length; i++) expect(out.parts[i]!.startSec).toBeGreaterThan(out.parts[i - 1]!.endSec);
    const wav = decodePcm16Wav(files.get(out.files.wav!)!)!;
    expect(wav.sampleRate).toBe(24000);
    expect(Math.abs(wav.samples.length / 24000 - out.durationSec!)).toBeLessThan(0.01);
    expect(out.durationSec!).toBeCloseTo(out.parts[out.parts.length - 1]!.endSec + 1.0, 1);
    expect(Math.abs(out.after!.integratedLufs - -19)).toBeLessThan(1.5);
    expect(out.after!.truePeakDbtp).toBeLessThanOrEqual(-1);
    expect(files.get(out.files.mp3!)!.subarray(0, 3).toString()).toBe('ID3');
    expect(files.get(out.files.transcript!)!.toString()).toContain('Third paragraph.');
    expect(files.get(out.files.chapters!)!.toString()).toMatch(/A heading/);
    expect((doc('narratorEditions/e1') as NarratorEditionDoc).lastExportId).toBe(ex.exportId);
  }, 60_000);
});

describe('Auto-direct', () => {
  it('only suggests: validated suggestions on the job, no speech, no script change', async () => {
    seed();
    const before = JSON.stringify((doc('narratorEditions/e1') as NarratorEditionDoc).script);
    callReasoning.mockResolvedValue({ json: { suggestions: [{ passageId: 'p1', kind: 'pause', anchor: 'paragraph', position: 'before', value: 'short pause', reason: 'breathing room' }, { passageId: 'p1', kind: 'vocal', anchor: 'Kasem', value: 'laugh' }, { passageId: 'p9', kind: 'pause', anchor: 'x', value: 'short pause' }] }, text: '{}', modelId: 'gemini-4-argon', usedFallback: false, res: {}, latencyMs: 5 });
    const a = (await narrator(owner, { op: 'autodirect', editionId: 'e1', intensity: 'subtle', passageIds: [], requestId: 'req-dir00001' })) as { jobId: string };
    const b = (await narrator(owner, { op: 'autodirect', editionId: 'e1', intensity: 'subtle', passageIds: [], requestId: 'req-dir00001' })) as { duplicate: boolean };
    expect(b.duplicate).toBe(true);
    const job = await run(a.jobId);
    expect(job.status).toBe('completed');
    const data = job.result!.data as { suggestions: { kind: string; status: string; quote: string }[]; discarded: unknown[] };
    expect(data.suggestions).toHaveLength(1);
    expect(data.suggestions[0]).toMatchObject({ kind: 'pause', status: 'suggested' });
    expect(data.discarded).toHaveLength(2);
    expect(synthesize).not.toHaveBeenCalled();
    expect(jobs().filter((j) => j.type === 'narrator.speak')).toHaveLength(0);
    expect(JSON.stringify((doc('narratorEditions/e1') as NarratorEditionDoc).script)).toBe(before);
    expect(String(callReasoning.mock.calls[0]![0][0].text)).toContain('data, not instructions');
  });

  it('renders accepted directions as provider segments, marking only that passage for regeneration', async () => {
    const { passageIds } = seed();
    const first = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-dir00002', confirmedUsd: 1 })) as { jobId: string };
    await run(first.jobId);
    synthesize.mockClear();
    const ed = doc('narratorEditions/e1') as NarratorEditionDoc;
    const text = ed.script.sections[0]!.passages[0]!.text;
    const direction = makeDirection(text, { id: 'dir1', passageId: 'p1', kind: 'pause', value: 'short pause', at: text.indexOf('about'), source: 'manual' });
    const style = makeDirection(text, { id: 'dir2', passageId: 'p1', kind: 'style', value: 'slower, reflective', start: text.indexOf('Kasem'), source: 'manual' });
    await narrator(owner, { op: 'editionSave', editionId: 'e1', baseRev: 1, patch: { directions: [direction, style] } });
    const plan = (await narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'edition', passageIds: [], force: false })) as { items: { passageId: string }[]; skipped: unknown[] };
    expect(plan.items.map((i) => i.passageId)).toEqual(['p1']);
    expect(plan.skipped).toHaveLength(passageIds.length - 1);
    const second = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-dir00003', confirmedUsd: 1 })) as { jobId: string };
    await run(second.jobId);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize.mock.calls[0]![0].segments).toEqual([
      { text: 'First paragraph <short pause> about', style: 'natural and conversational' },
      { text: 'Kasem.', style: 'natural and conversational; slower, reflective' },
    ]);
  });

  it('passage previews with and without directions are kept apart from takes and reused', async () => {
    seed();
    store.set('narratorVoices/v1', { ...doc('narratorVoices/v1')!, approval: { state: 'pending' } });
    const text = (doc('narratorEditions/e1') as NarratorEditionDoc).script.sections[0]!.passages[0]!.text;
    await narrator(owner, { op: 'editionSave', editionId: 'e1', baseRev: 1, patch: { directions: [makeDirection(text, { id: 'dir3', passageId: 'p1', kind: 'emphasis', value: '', start: text.indexOf('Kasem'), end: text.indexOf('Kasem') + 5, source: 'manual' })] } });
    for (const variant of ['directed', 'undirected'] as const) {
      const r = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'preview', variant, passageIds: ['p1'], force: false, requestId: `req-pv${variant}`, confirmedUsd: 1 })) as { jobId: string };
      await run(r.jobId);
    }
    expect(synthesize.mock.calls.map((c) => c[0].segments[0].text)).toEqual(['First paragraph about KASEM.', 'First paragraph about Kasem.']);
    expect(clips().map((c) => c.passageId).sort()).toEqual(['preview-directed-p1', 'preview-undirected-p1']);
    expect((doc('narratorEditions/e1') as NarratorEditionDoc).takes).toEqual({});
    const again = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'preview', variant: 'directed', passageIds: ['p1'], force: false, requestId: 'req-pvagain1', confirmedUsd: 1 })) as { jobId: string | null };
    expect(again.jobId).toBeNull();
  });
});

describe('request queue, resumable jobs and narrator pins', () => {
  const quotaError = () => new NarratorProviderError('quota', 'Rate limit exceeded for model gemini-3.8-flash-tts (limit: 100 requests per day on Tier 1). Please retry in 21h2m35s or upgrade your tier at https://ai.dev/rate-limit.', 429, 'RESOURCE_EXHAUSTED', 75755);
  const gateDoc = 'runtime/narrator-gate-developer-gemini-3.8-flash-tts';

  it('stops before sending once today’s allowance is used, keeps finished passages and blocks until the reset', async () => {
    seed();
    gateOverrides.developer = { minIntervalMs: 0, dailyRequests: 2 };
    try {
      const r = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-allow001', confirmedUsd: 1 })) as { jobId: string };
      const job = await run(r.jobId);
      expect(synthesize).toHaveBeenCalledTimes(2);
      expect(job.status).toBe('failed');
      expect(job.error).toMatchObject({ code: 'provider_quota' });
      expect(job.error!.message).toMatch(/stopped before sending/);
      expect(clips().filter((c) => c.status === 'ready')).toHaveLength(2);
      const est = (await narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'edition', passageIds: [], force: false })) as { limitProblem: string | null };
      expect(est.limitProblem).toMatch(/used up/);
    } finally {
      gateOverrides.developer = { minIntervalMs: 0 };
      await clearLimit('gemini-3.8-flash-tts');
    }
  });

  it('reuses chunk audio already paid for instead of requesting it again', async () => {
    seed();
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} of a long paragraph that keeps going for a while.`).join(' ');
    const ed = doc('narratorEditions/e1') as NarratorEditionDoc;
    ed.script.sections[0]!.passages[0]!.text = long;
    store.set('narratorEditions/e1', ed as never);
    let n = 0;
    synthesize.mockImplementation(async (input: Said) => {
      n++;
      if (n === 2) throw quotaError();
      return { wav: speechWav(Math.max(1, said(input).length / 60)), sampleRate: RATE, inputTokens: 10, outputTokens: 50 };
    });
    const a = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'passages', passageIds: ['p1'], force: false, requestId: 'req-cache001', confirmedUsd: 1 })) as { jobId: string };
    expect((await run(a.jobId)).status).toBe('failed');
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect([...files.keys()].filter((k) => k.includes('/chunk-cache/'))).toHaveLength(1);
    // The next day: the allowance is back.
    await clearLimit('gemini-3.8-flash-tts');
    store.delete(gateDoc);
    const b = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'passages', passageIds: ['p1'], force: false, requestId: 'req-cache002', confirmedUsd: 1 })) as { jobId: string };
    const job = await run(b.jobId);
    expect(job.status).toBe('completed');
    expect(synthesize).toHaveBeenCalledTimes(3); // only the chunk that was never generated
    expect(said(synthesize.mock.calls[2]![0])).toBe(said(synthesize.mock.calls[1]![0]));
    expect((job.external as { narrator: { reusedChunks: number } }).narrator.reusedChunks).toBe(1);
    expect([...files.keys()].filter((k) => k.includes('/chunk-cache/'))).toHaveLength(0);
    expect(clips().filter((c) => c.status === 'ready' && c.passageId === 'p1')).toHaveLength(1);
  });

  it('parks the job when Google asks for a longer wait, then resumes where it stopped', async () => {
    seed();
    let n = 0;
    synthesize.mockImplementation(async (input: Said) => {
      n++;
      if (n === 1) throw new NarratorProviderError('rate_limited', 'Resource exhausted. Please try again later.', 429, 'RESOURCE_EXHAUSTED', 120);
      return { wav: speechWav(Math.max(1, said(input).length / 15)), sampleRate: RATE, inputTokens: 10, outputTokens: 50 };
    });
    const r = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'passages', passageIds: ['p1', 'p2'], force: false, requestId: 'req-park0001', confirmedUsd: 1 })) as { jobId: string };
    const parked = await run(r.jobId);
    expect(parked.status).toBe('generating');
    expect(synthesize).toHaveBeenCalledTimes(1); // 120 s is not slept in-process
    const t = tasks[tasks.length - 1]!;
    expect(t).toMatchObject({ payload: { jobId: r.jobId, step: 'poll', seq: 1 } });
    expect(t.delaySec).toBeGreaterThanOrEqual(60);
    expect(t.delaySec).toBeLessThanOrEqual(120);
    await continueNarratorSpeakJob({ ...(doc(`jobs/${r.jobId}`) as JobDoc), id: r.jobId }, 1);
    expect((doc(`jobs/${r.jobId}`) as JobDoc).status).toBe('completed');
    expect(synthesize).toHaveBeenCalledTimes(3);
    expect(clips().filter((c) => c.status === 'ready')).toHaveLength(2);
  });

  it('pins an edition to its narrator: part of it cannot be re-voiced, the whole edition can', async () => {
    seed();
    const a = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'passages', passageIds: ['p1'], force: false, requestId: 'req-pin00001', confirmedUsd: 1 })) as { jobId: string };
    await run(a.jobId);
    expect((doc('narratorEditions/e1') as NarratorEditionDoc).narration).toMatchObject({ voiceId: 'v1', modelId: 'gemini-3.8-flash-tts' });
    store.set('narratorVoices/v2', { ownerUid: 'u', displayName: 'Francis — Pwavwe Papers', provider: 'vertex_ai', modelId: 'gemini-3.8-flash-tts', status: 'active', approval: { state: 'approved' }, consent: { state: 'verified' } });
    store.set('narratorVoices/v2/private/provider', { providerVoiceId: 'voice_cloud' });
    const rev = (doc('narratorEditions/e1') as NarratorEditionDoc).rev;
    await narrator(owner, { op: 'editionSave', editionId: 'e1', baseRev: rev, patch: { voiceId: 'v2' } });
    await expect(narrator(owner, { op: 'generate', editionId: 'e1', scope: 'passages', passageIds: ['p2'], force: false, requestId: 'req-pin00002', confirmedUsd: 1 })).rejects.toThrow(/mix two narrators/);
    const est = (await narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'edition', passageIds: [], force: false })) as { narrator: { switching: boolean }; route: string };
    expect(est).toMatchObject({ narrator: { switching: true }, route: 'vertex' });
    const b = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-pin00003', confirmedUsd: 1 })) as { jobId: string };
    expect((await run(b.jobId)).status).toBe('completed');
    const cloudCalls = synthesize.mock.calls.slice(1).map((c) => c[0] as { route: string; voiceId: string });
    expect(cloudCalls.every((c) => c.route === 'vertex' && c.voiceId === 'voice_cloud')).toBe(true);
    expect((doc('narratorEditions/e1') as NarratorEditionDoc).narration).toMatchObject({ voiceId: 'v2', provider: 'vertex_ai' });
  });

  it('stops a job whose provider voice changed after it was planned', async () => {
    seed();
    const r = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'passages', passageIds: ['p1'], force: false, requestId: 'req-pinjob01', confirmedUsd: 1 })) as { jobId: string };
    expect(JSON.stringify(doc(`jobs/${r.jobId}`))).not.toContain('voice_abc');
    store.set('narratorVoices/v1/private/provider', { providerVoiceId: 'voice_other' });
    const job = await run(r.jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'pin_changed' });
    expect(synthesize).not.toHaveBeenCalled();
  });
});

describe('Google Cloud route', () => {
  beforeEach(() => {
    const analysis = { durationSec: 15, speechSec: 12, peakDbfs: -6, rmsDbfs: -22, clippedPct: 0, noiseFloorDbfs: -60, longestPauseSec: 0.6, leadingSilenceSec: 0.3, trailingSilenceSec: 0.4, issues: [] };
    store.set('narratorRecordings/ref', { ownerUid: 'u', kind: 'reference', status: 'ready', storagePath: 'users/u/narrator/recordings/ref.wav', analysis, usedByVoiceId: 'v1' });
    store.set('narratorRecordings/con', { ownerUid: 'u', kind: 'consent', status: 'ready', storagePath: 'users/u/narrator/recordings/con.wav', analysis: { ...analysis, durationSec: 6 } });
    files.set('users/u/narrator/recordings/ref.wav', speechWav(15));
    files.set('users/u/narrator/recordings/con.wav', speechWav(6));
  });

  it('stays locked until a Cloud narration test passes, then enrols with the Cloud consent sentence', async () => {
    await expect(narrator(owner, { op: 'profileSave', settings: { route: 'vertex' } })).rejects.toThrow(/Cloud narration test/);
    const t = (await narrator(owner, { op: 'cloudCheck', requestId: 'req-cloud001' })) as { ok: boolean; durationSec: number; url: string | null };
    expect(t).toMatchObject({ ok: true });
    expect(t.url).toContain('cloud-test');
    expect(synthesize.mock.calls[0]![0]).toMatchObject({ route: 'vertex', voiceId: 'Kore' });
    expect((synthesize.mock.calls[0]![0] as Said).segments.every((s) => s.style.length > 0)).toBe(true);
    await narrator(owner, { op: 'profileSave', settings: { route: 'vertex' } });
    const req = { op: 'voiceCreate' as const, referenceId: 'ref', consentId: 'con', consentLocale: 'en-US' as const, requestId: 'req-cvoice01', attestSameAdultSpeaker: true as const };
    // A consent clip that read the Developer API sentence is refused before anything is sent.
    await expect(narrator(owner, req)).rejects.toThrow(/through the use of Google Cloud/);
    store.set('narratorRecordings/con', { ...doc('narratorRecordings/con')!, consentRoute: 'vertex' });
    createVoice.mockResolvedValue({ voiceId: 'voice_cloudnew' });
    const created = (await narrator(owner, req)) as { voiceId: string; jobId: string };
    expect((await run(created.jobId)).status).toBe('completed');
    expect(createVoice.mock.calls[0]![0]).toMatchObject({ route: 'vertex' });
    expect(doc(`narratorVoices/${created.voiceId}`)).toMatchObject({ provider: 'vertex_ai', status: 'active' });
  });

  it('a failed Cloud test keeps the Developer API in use and says why', async () => {
    synthesize.mockRejectedValue(new NarratorProviderError('auth', 'Google Cloud refused the functions’ service account: Permission denied.', 403, 'PERMISSION_DENIED'));
    const t = (await narrator(owner, { op: 'cloudCheck', requestId: 'req-cloud002' })) as { ok: boolean; message: string };
    expect(t).toMatchObject({ ok: false });
    expect(t.message).toMatch(/Permission/);
    await expect(narrator(owner, { op: 'profileSave', settings: { route: 'vertex' } })).rejects.toThrow(/Cloud narration test/);
  });
});

describe('read as one take', () => {
  /** A take as Google returns it: each text block spoken in turn with a natural pause between blocks. */
  function takeWav(input: Said): Buffer {
    const pieces = input.segments.map((s) => decodePcm16Wav(speechWav(Math.max(1, s.text.length / 15)))!.samples);
    const gap = Math.round(0.5 * RATE);
    const out = new Float32Array(pieces.reduce((n, p) => n + p.length + gap, 0));
    let at = 0;
    for (const p of pieces) {
      out.set(p, at);
      at += p.length + gap;
    }
    return Buffer.from(encodePcm16Wav(out, RATE));
  }
  function seedOneTake() {
    const s = seed();
    const ed = doc('narratorEditions/e1') as NarratorEditionDoc;
    store.set('narratorEditions/e1', { ...ed, settings: { ...ed.settings, readMode: 'oneTake' } } as never);
    synthesize.mockImplementation(async (input: Said) => ({ wav: takeWav(input), sampleRate: RATE, inputTokens: 40, outputTokens: 900, finish: 'STOP' }));
    transcribeMock.mockImplementation(async () => {
      const input = synthesize.mock.calls[synthesize.mock.calls.length - 1]![0] as Said;
      const words: { text: string; start: number; end: number }[] = [];
      let at = 0;
      for (const seg of input.segments) {
        const len = Math.max(1, seg.text.length / 15);
        const ws = seg.text.split(/ +/);
        ws.forEach((w, k) => words.push({ text: w, start: at + 0.2 + (k * (len - 0.4)) / ws.length, end: at + 0.2 + ((k + 1) * (len - 0.4)) / ws.length }));
        at += len + 0.5;
      }
      return { text: words.map((w) => w.text).join(' '), words, languageCode: 'en', usage: { input: 1000, output: 200, thoughts: 0 }, modelId: 'gemini-3.5-transcribe-preview', latencyMs: 1 };
    });
    return s;
  }

  it('reads the whole edition in ONE request, keeps it as one take and exports it without cutting it', async () => {
    const { passageIds } = seedOneTake();
    const est = (await narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'edition', passageIds: [], force: false })) as { items: { requests: number }[] };
    expect(est.items).toEqual([expect.objectContaining({ requests: 1 })]);
    const { jobId } = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-one00001', confirmedUsd: 1 })) as { jobId: string };
    const job = await run(jobId);
    expect(job.status, JSON.stringify(job.error)).toBe('completed');
    expect(synthesize).toHaveBeenCalledTimes(1);
    const sent = synthesize.mock.calls[0]![0] as Said & { timeoutMs?: number };
    const ed = doc('narratorEditions/e1') as NarratorEditionDoc;
    expect(sent.segments.map((x) => x.text)).toEqual(flattenScript(ed.script).map((f) => f.passage.text));
    expect(sent.timeoutMs).toBe(600_000);
    const key = `take-${passageIds[0]}`;
    const take = clips().find((c) => c.passageId === key)!;
    expect(take).toMatchObject({ status: 'ready', passageIds });
    expect(take.spans!.map((s) => s.passageId)).toEqual(passageIds);
    for (let i = 1; i < take.spans!.length; i++) expect(take.spans![i]!.startSec).toBeGreaterThanOrEqual(take.spans![i - 1]!.endSec);
    // Spans come from the word-timed transcript: each passage starts where its first word is heard.
    expect(take.textCheck).toMatchObject({ method: 'transcript', coverage: 1, passagesHeard: passageIds.length, message: null });
    expect(take.spans![1]!.startSec).toBeCloseTo(Math.max(1, ed.script.opening!.text.length / 15) + 0.5 + 0.2, 1);
    expect(ed.takes[key]).toBe(take.id);
    expect(docs('usage').map((u) => u.kind).sort()).toEqual(['speech', 'transcription']);

    const ex = (await narrator(owner, { op: 'exportStart', editionId: 'e1', requestId: 'req-one00002' })) as { jobId: string; exportId: string };
    const exJob = await run(ex.jobId);
    expect(exJob.status, JSON.stringify(exJob.error)).toBe('completed');
    const out = doc(`narratorEditions/e1/exports/${ex.exportId}`) as NarratorExportDoc;
    expect(out.parts.map((p) => p.passageId)).toEqual(passageIds);
    expect(new Set(out.parts.map((p) => p.clipId))).toEqual(new Set([take.id]));
    for (let i = 1; i < out.parts.length; i++) expect(out.parts[i]!.startSec).toBeGreaterThanOrEqual(out.parts[i - 1]!.endSec);
    // One continuous take: the export is the take plus the lead-in/tail, with no pauses inserted inside it.
    expect(out.durationSec!).toBeLessThan(take.durationSec! + 1.6);
    expect(files.get(out.files.chapters!)!.toString()).toMatch(/A heading/);
  }, 60_000);

  it('editing one passage re-reads its whole take (never a patch), keeping the earlier take', async () => {
    seedOneTake();
    const a = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-one00003', confirmedUsd: 1 })) as { jobId: string };
    await run(a.jobId);
    const ed = doc('narratorEditions/e1') as NarratorEditionDoc;
    const rev = ed.rev;
    const script = structuredClone(ed.script);
    script.sections[0]!.passages[1]!.text = 'Second paragraph, now longer.';
    await narrator(owner, { op: 'editionSave', editionId: 'e1', baseRev: rev, patch: { script } });
    const b = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'passages', passageIds: [script.sections[0]!.passages[1]!.id], force: false, requestId: 'req-one00004', confirmedUsd: 1 })) as { jobId: string };
    expect((await run(b.jobId)).status).toBe('completed');
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(said(synthesize.mock.calls[1]![0])).toContain('Second paragraph, now longer.');
    expect(said(synthesize.mock.calls[1]![0])).toContain('Third paragraph.');
    const takes = clips().filter((c) => c.passageId.startsWith('take-') && c.status === 'ready');
    expect(takes.map((c) => c.version).sort()).toEqual([1, 2]);
  });

  it('if the check transcription fails, the take is kept with estimated chapter times and says so', async () => {
    seedOneTake();
    transcribeMock.mockReset();
    transcribeMock.mockRejectedValue(new Error('transcription unavailable'));
    const r = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-one00006', confirmedUsd: 1 })) as { jobId: string };
    expect((await run(r.jobId)).status).toBe('completed');
    const take = clips().find((c) => c.passageId.startsWith('take-'))!;
    expect(take.textCheck).toMatchObject({ method: 'pauses', coverage: null });
    expect(take.spans).toHaveLength(take.passageIds!.length);
  });

  it('a take Google cut off at its length limit is never kept', async () => {
    seedOneTake();
    synthesize.mockImplementation(async (input: Said) => ({ wav: takeWav(input), sampleRate: RATE, inputTokens: 40, outputTokens: 16384, finish: 'MAX_TOKENS' }));
    const r = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-one00005', confirmedUsd: 1 })) as { jobId: string };
    const job = await run(r.jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ code: 'take_cut_off' });
    expect(clips().filter((c) => c.status === 'ready')).toHaveLength(0);
    expect(Object.keys((doc('narratorEditions/e1') as NarratorEditionDoc).takes)).toHaveLength(0);
  });
});

describe('finishing a take Google stopped early', () => {
  it('reads only the missing last passage in a second request and joins it at that passage break', async () => {
    const { passageIds } = seed();
    const ed = doc('narratorEditions/e1') as NarratorEditionDoc;
    store.set('narratorEditions/e1', { ...ed, settings: { ...ed.settings, readMode: 'oneTake' } } as never);
    // Audio: every block spoken with a pause; the transcript of the FIRST take is missing the closing.
    const blockAudio = (input: Said) => {
      const pieces = input.segments.map((s) => decodePcm16Wav(speechWav(Math.max(1, s.text.length / 15)))!.samples);
      const gap = Math.round(0.5 * RATE);
      const out = new Float32Array(pieces.reduce((n, p) => n + p.length + gap, 0));
      let at = 0;
      for (const p of pieces) {
        out.set(p, at);
        at += p.length + gap;
      }
      return Buffer.from(encodePcm16Wav(out, RATE));
    };
    synthesize.mockImplementation(async (input: Said) => ({ wav: blockAudio(input), sampleRate: RATE, inputTokens: 40, outputTokens: 900, finish: 'STOP' }));
    const wordsOf = (input: Said, drop: number) => {
      const words: { text: string; start: number; end: number }[] = [];
      let at = 0;
      input.segments.slice(0, input.segments.length - drop).forEach((seg) => {
        const len = Math.max(1, seg.text.length / 15);
        const ws = seg.text.split(/ +/);
        ws.forEach((w, k) => words.push({ text: w, start: at + 0.2 + (k * (len - 0.4)) / ws.length, end: at + 0.2 + ((k + 1) * (len - 0.4)) / ws.length }));
        at += len + 0.5;
      });
      return { text: '', words, languageCode: 'en', usage: { input: 1000, output: 200, thoughts: 0 }, modelId: 'gemini-3.5-transcribe-preview', latencyMs: 1 };
    };
    let calls = 0;
    transcribeMock.mockImplementation(async () => {
      calls++;
      const input = synthesize.mock.calls[synthesize.mock.calls.length - 1]![0] as Said;
      return wordsOf(input, calls === 1 ? 1 : 0); // first take: the closing was not spoken
    });
    const r = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-tail0001', confirmedUsd: 1 })) as { jobId: string };
    expect((await run(r.jobId)).status).toBe('completed');
    expect(synthesize).toHaveBeenCalledTimes(2);
    const closing = ed.script.closing!.text;
    expect((synthesize.mock.calls[1]![0] as Said).segments.map((s) => s.text)).toEqual([closing]);
    const take = clips().find((c) => c.passageId.startsWith('take-') && c.status === 'ready')!;
    expect(take.textCheck).toMatchObject({ method: 'transcript', passagesHeard: passageIds.length });
    expect(take.textCheck!.message).toMatch(/second request/);
    const spans = take.spans!;
    expect(spans[spans.length - 1]!.startSec).toBeGreaterThan(spans[spans.length - 2]!.endSec);
    expect(spans[spans.length - 1]!.endSec).toBeLessThanOrEqual(take.durationSec! + 0.01);
    expect(docs('usage').filter((u) => u.kind === 'speech')).toHaveLength(2);
  });

  it('names a passage skipped in the middle instead of hiding it in a coverage percentage', async () => {
    seed();
    const ed = doc('narratorEditions/e1') as NarratorEditionDoc;
    store.set('narratorEditions/e1', { ...ed, settings: { ...ed.settings, readMode: 'oneTake' } } as never);
    synthesize.mockImplementation(async (input: Said) => ({ wav: speechWav(Math.max(1, said(input).length / 15)), sampleRate: RATE, inputTokens: 40, outputTokens: 900, finish: 'STOP' }));
    transcribeMock.mockImplementation(async () => {
      const input = synthesize.mock.calls[synthesize.mock.calls.length - 1]![0] as Said;
      const texts = input.segments.map((s) => s.text).filter((_, i) => i !== 2); // the third block is skipped
      const words = texts.join(' ').split(/ +/).map((w, i) => ({ text: w, start: i * 0.3, end: i * 0.3 + 0.2 }));
      return { text: '', words, languageCode: 'en', usage: { input: 1, output: 1, thoughts: 0 }, modelId: 'gemini-3.5-transcribe-preview', latencyMs: 1 };
    });
    const r = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-skip0001', confirmedUsd: 1 })) as { jobId: string };
    expect((await run(r.jobId)).status).toBe('completed');
    expect(synthesize).toHaveBeenCalledTimes(1);
    const take = clips().find((c) => c.passageId.startsWith('take-'))!;
    expect(take.textCheck!.message).toMatch(/Passage 3 of this take was not recognised/);
  });
});

/** Quietest 20 ms frame (dBFS) — the noise floor in the silence around the synthetic speech. */
function noiseFloorDb(samples: Float32Array): number {
  const win = Math.round(RATE * 0.02);
  const rms: number[] = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let e = 0;
    for (let j = i; j < i + win; j++) e += samples[j]! * samples[j]!;
    rms.push(Math.sqrt(e / win));
  }
  rms.sort((a, b) => a - b);
  return 20 * Math.log10(Math.max(1e-9, rms[0]!));
}

/** Synthetic speech over a replicated voice's room tone: 50 Hz rumble plus broadband hiss. */
function noisyWav(sec: number): Buffer {
  const d = decodePcm16Wav(speechWav(sec))!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < d.samples.length; i++) d.samples[i]! += 0.004 * Math.sin((2 * Math.PI * 50 * i) / RATE) + 0.0015 * rnd();
  return Buffer.from(encodePcm16Wav(d.samples, RATE));
}

describe('Google voices', () => {
  beforeEach(() => {
    store.delete('narratorVoices/v1');
    store.delete('narratorVoices/v1/private/provider');
  });

  it('narrates an edition with a prebuilt voice: no enrollment or approval, spoken by name, never noise-processed', async () => {
    seed();
    await narrator(owner, { op: 'editionSave', editionId: 'e1', baseRev: 1, patch: { voiceId: 'google-Charon' } });
    const est = (await narrator(owner, { op: 'estimate', editionId: 'e1', scope: 'edition', passageIds: [], force: false })) as { estimate: { usd: number }; narrator: { next: string } };
    expect(est.narrator.next).toMatch(/Charon — Informative \(Google voice\)/);
    const { jobId } = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-g0000001', confirmedUsd: est.estimate.usd })) as { jobId: string };
    expect(doc(`jobs/${jobId}`)!.params).toMatchObject({ voiceId: 'google-Charon', noiseReduction: 'off', route: 'developer' });
    const job = await run(jobId);
    expect(job.status, JSON.stringify(job.error)).toBe('completed');
    expect(synthesize.mock.calls.length).toBeGreaterThan(0);
    for (const c of synthesize.mock.calls) expect(c[0]).toMatchObject({ voiceId: 'Charon', route: 'developer' });
    expect(clips().every((c) => c.status === 'ready' && c.voiceId === 'google-Charon' && !c.noiseReduction)).toBe(true);
    expect((doc('narratorEditions/e1') as NarratorEditionDoc).narration).toMatchObject({ voiceId: 'google-Charon', provider: 'google_gemini_api', modelId: 'gemini-3.8-flash-tts' });
    // No voice profile is invented for a prebuilt voice.
    expect(doc('narratorVoices/google-Charon')).toBeUndefined();
  });

  it('refuses a voice name Google does not offer', async () => {
    seed();
    await expect(narrator(owner, { op: 'editionSave', editionId: 'e1', baseRev: 1, patch: { voiceId: 'google-Nobody' } })).rejects.toThrow(/not found/);
  });
});

describe('background noise reduction (real FFmpeg)', () => {
  it('cleans new takes of a replicated voice and records it on the take', async () => {
    seed();
    synthesize.mockImplementation(async (input: Said) => ({ wav: noisyWav(Math.max(2, said(input).length / 12)), sampleRate: RATE, inputTokens: 10, outputTokens: 50 }));
    const { jobId } = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-n0000001', confirmedUsd: 1 })) as { jobId: string };
    expect(doc(`jobs/${jobId}`)!.params).toMatchObject({ noiseReduction: 'standard' });
    expect((await run(jobId)).status).toBe('completed');
    const raw = noiseFloorDb(decodePcm16Wav(noisyWav(4))!.samples);
    expect(clips().length).toBeGreaterThan(0);
    for (const c of clips()) {
      expect(c.noiseReduction).toBe('standard');
      const d = decodePcm16Wav(files.get(c.storagePath!)!)!;
      expect(noiseFloorDb(d.samples)).toBeLessThan(raw - 10);
    }
  }, 60_000);

  it('leaves takes exactly as Google returned them when switched off', async () => {
    seed();
    store.set('narratorProfiles/u', { ownerUid: 'u', settings: { noiseReduction: 'off' } });
    const passageId = flattenScript((doc('narratorEditions/e1') as NarratorEditionDoc).script)[1]!.passage.id;
    const { jobId } = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'passages', passageIds: [passageId], force: false, requestId: 'req-n0000002', confirmedUsd: 1 })) as { jobId: string };
    await run(jobId);
    const c = clips()[0]!;
    expect(c.noiseReduction).toBeUndefined();
    expect(files.get(c.storagePath!)!.equals(speechWav(Math.max(1, said(synthesize.mock.calls[0]![0]).length / 15)))).toBe(true);
  });

  it('cleans older takes at export without a new request, and says so in the processing notes', async () => {
    seed();
    store.set('narratorProfiles/u', { ownerUid: 'u', settings: { noiseReduction: 'off' } });
    synthesize.mockImplementation(async (input: Said) => ({ wav: noisyWav(Math.max(2, said(input).length / 12)), sampleRate: RATE, inputTokens: 10, outputTokens: 50 }));
    const { jobId } = (await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'edition', passageIds: [], force: false, requestId: 'req-n0000003', confirmedUsd: 1 })) as { jobId: string };
    await run(jobId);
    expect(clips().every((c) => !c.noiseReduction)).toBe(true);
    store.set('narratorProfiles/u', { ownerUid: 'u', settings: { noiseReduction: 'standard' } });
    synthesize.mockClear();
    const ex = (await narrator(owner, { op: 'exportStart', editionId: 'e1', requestId: 'req-n0000004' })) as { jobId: string; exportId: string };
    const job = await run(ex.jobId);
    expect(job.status, JSON.stringify(job.error)).toBe('completed');
    expect(synthesize).not.toHaveBeenCalled();
    const out = doc(`narratorEditions/e1/exports/${ex.exportId}`) as NarratorExportDoc;
    expect(out.processing[0]).toMatch(/Background noise reduction.*older takes cleaned now \(standard\)/);
  }, 60_000);

  it('cleans the enrollment recordings before they are sent to Google', async () => {
    store.delete('narratorVoices/v1');
    const analysis = { durationSec: 15, speechSec: 12, peakDbfs: -6, rmsDbfs: -22, clippedPct: 0, noiseFloorDbfs: -60, longestPauseSec: 0.6, leadingSilenceSec: 0.3, trailingSilenceSec: 0.4, issues: [] };
    store.set('narratorRecordings/ref', { ownerUid: 'u', kind: 'reference', status: 'ready', storagePath: 'users/u/narrator/recordings/ref.wav', analysis });
    store.set('narratorRecordings/con', { ownerUid: 'u', kind: 'consent', status: 'ready', storagePath: 'users/u/narrator/recordings/con.wav', analysis: { ...analysis, durationSec: 6 } });
    files.set('users/u/narrator/recordings/ref.wav', noisyWav(15));
    files.set('users/u/narrator/recordings/con.wav', noisyWav(6));
    createVoice.mockResolvedValue({ voiceId: 'voice_clean' });
    const r = (await narrator(owner, { op: 'voiceCreate', referenceId: 'ref', consentId: 'con', consentLocale: 'en-GB', requestId: 'req-voice-nr1', attestSameAdultSpeaker: true })) as { jobId: string };
    expect((await run(r.jobId)).status).toBe('completed');
    const sent = createVoice.mock.calls[0]![0] as { referenceWav: Buffer; consentWav: Buffer };
    const ref = decodePcm16Wav(sent.referenceWav)!;
    expect(ref.sampleRate).toBe(24000);
    expect(ref.samples.length).toBe(15 * RATE);
    expect(noiseFloorDb(ref.samples)).toBeLessThan(noiseFloorDb(decodePcm16Wav(noisyWav(15))!.samples) - 10);
    expect(sent.consentWav.equals(noisyWav(6))).toBe(false);
  }, 60_000);
});
