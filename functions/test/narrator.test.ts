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
    },
  };
});

const synthesize = vi.fn();
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

const owner = { uid: 'u', email: 'o@x' };
type Said = { segments: { text: string; style: string }[] };
/** The words sent in one synthesis request (all its text blocks). */
const said = (input: unknown) => (input as Said).segments.map((x) => x.text).join(' ');
const RATE = 24000;
narratorRetryTiming.baseMs = 1;

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

  it('a voice Google no longer has stops the job and marks the voice for renewal', async () => {
    seed();
    synthesize.mockRejectedValue(new NarratorProviderError('not_found', 'Voice not found', 404));
    await narrator(owner, { op: 'generate', editionId: 'e1', scope: 'passages', passageIds: ['p1'], force: false, requestId: 'req-99999999', confirmedUsd: 1 });
    const job = await run('nars-req-99999999');
    expect(job.status).toBe('failed');
    expect(doc('narratorVoices/v1')!.status).toBe('missing_at_provider');
    await expect(narrator(owner, { op: 'generate', editionId: 'e1', scope: 'passages', passageIds: ['p1'], force: false, requestId: 'req-a9999999', confirmedUsd: 1 })).rejects.toThrow(/not available/);
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
