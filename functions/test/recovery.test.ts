import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, defaultAdScene, defaultAdSpec, type JobDoc } from '@az-studio/shared';
import { apiError, doc, docs, resetFakes, store, tasks } from './fakes';

/**
 * Worker-level recovery with MOCKED provider failures: the real task handler, retry policy, Omni and
 * image workers and Short Ads API run against an in-memory Firestore, a recorded task queue and a
 * scripted fake Google client. No request reaches Google.
 */

const g = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), cancel: vi.fn(), generate: vi.fn(), settings: {} as Record<string, unknown> }));

vi.mock('../src/lib/firebase', async () => {
  const f = await import('./fakes');
  return { db: f.db, col: f.col, bucket: f.bucket, FieldValue: f.FieldValue, Timestamp: f.Timestamp, gsUri: f.gsUri, pathFromGsUri: f.pathFromGsUri };
});
vi.mock('firebase-admin/functions', async () => {
  const f = await import('./fakes');
  return { getFunctions: () => ({ taskQueue: () => ({ enqueue: async (payload: never, opts?: { scheduleDelaySeconds?: number }) => void f.tasks.push({ payload, delaySec: opts?.scheduleDelaySeconds ?? 0 }) }) }) };
});
vi.mock('firebase-functions', async (orig) => ({ ...(await orig<typeof import('firebase-functions')>()), logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, log: () => undefined } }));
vi.mock('../src/lib/vertex', () => ({
  genai: () => ({ interactions: { create: g.create, get: g.get, cancel: g.cancel }, models: { generateContent: g.generate, get: vi.fn() } }),
  geminiDeveloperApi: async () => null,
}));
vi.mock('../src/lib/assets', async () => {
  const f = await import('./fakes');
  return {
  withTmpDir: async (fn: (dir: string) => unknown) => fn('/tmp/azs-test'),
  createAsset: async (input: { assetId?: string; uid: string; kind: string; storagePath: string; mimeType: string }) => {
    const id = input.assetId ?? 'asset-new';
    f.store.set(`assets/${id}`, { ownerUid: input.uid, kind: input.kind, storagePath: input.storagePath, mimeType: input.mimeType, status: 'ready', durationSec: input.kind === 'video' ? 5 : null, width: 1080, height: 1920 });
    return id;
  },
  applyTarget: async () => undefined,
  saveBufferToFile: async (dir: string, name: string) => `${dir}/${name}`,
  deriveFiles: async () => ({}),
  };
});
vi.mock('../src/lib/concurrency', () => ({ acquireSlot: async () => true, releaseSlot: async () => undefined, activeSlots: async () => [] }));
vi.mock('../src/lib/interactions', () => ({ logInteraction: async () => undefined }));
vi.mock('../src/workers/ad-validate', () => ({ runAdValidateJob: vi.fn(async () => undefined) }));
vi.mock('../src/lib/usage', async () => {
  const shared = await import('@az-studio/shared');
  const empty = { costUsd: 0, jobs: 0, byModel: {} };
  return {
    getSettings: async () => ({ ...shared.DEFAULT_SETTINGS, ...g.settings }),
    recordUsage: async () => 0,
    assertWithinLimits: () => undefined,
    spendSnapshot: async () => ({ today: empty, month: empty, pendingUsd: 0, activeJobs: 0 }),
    assertProjectBudget: async () => undefined,
    projectBudget: async () => null,
    assertRateLimit: async () => undefined,
  };
});

const { MODEL_REGISTRY } = await import('../src/config/models');
const { handleTask } = await import('../src/workers/worker');
const actions = await import('../src/api/actions');
const adsApi = await import('../src/api/ads');
const { invalidateProviderHealth } = await import('../src/lib/provider-health');

const OWNER = { uid: 'u1', email: 'owner@example.com' };
const VIDEO = MODEL_REGISTRY.video.id;
const IMAGE = MODEL_REGISTRY.image.id;
const REASONING = MODEL_REGISTRY.reasoning.id;
const processed: { jobId?: string; step: string; delaySec: number }[] = [];

async function drain(max = 60) {
  let n = 0;
  while (tasks.length && n < max) {
    const t = tasks.shift()!;
    processed.push({ jobId: t.payload.jobId, step: t.payload.step, delaySec: t.delaySec });
    await handleTask(t.payload as never);
    n++;
  }
  return n;
}

const job = (id: string) => doc(`jobs/${id}`) as unknown as JobDoc;
const estimate = { usd: 0.4, basis: 'published_rate', confidence: 'medium', breakdown: [], notes: [], pricingVersion: 't' };

function seedVideoJob(id: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  store.set(`jobs/${id}`, {
    ownerUid: 'u1', projectId: null, type: 'video.generate', status: 'queued', stage: 'Queued', progress: 0, modelId: VIDEO,
    params: { mode: 'generate', task: 'text_to_video', aspectRatio: '9:16', resolution: '720p', resolutionExplicit: true, durationSec: 4, prompt: 'Two friends laugh together at a market stall.', promptBody: 'Two friends laugh together at a market stall.', media: [], previousInteractionId: null, chainFallback: null, title: 'Scene', ...params },
    estimate, batchId: null, target: null, label: 'Scene', attempt: 0, retryOf: null, external: null, result: null, error: null, cancelRequested: false, usageUsd: null,
    request: { type: 'video.generate', projectId: null, mode: 'generate', prompt: 'Two friends laugh together at a market stall.', aspectRatio: '9:16', resolution: '720p', durationSec: 4, media: [], characterIds: [] },
    ...extra,
  });
  tasks.push({ payload: { jobId: id, step: 'start', seq: 0 }, delaySec: 0 });
}

function seedImageJob(id: string, prompt: string) {
  store.set(`jobs/${id}`, {
    ownerUid: 'u1', projectId: null, type: 'image.generate', status: 'queued', stage: 'Queued', progress: 0, modelId: IMAGE,
    params: { mode: 'generate', purpose: 'free', prompt, promptBody: prompt, aspectRatio: '9:16', imageSize: '2K', source: null, references: [], grounding: false, collections: [], characterIds: [], title: 'Still' },
    estimate, batchId: null, target: null, label: 'Still', attempt: 0, retryOf: null, external: null, result: null, error: null, cancelRequested: false, usageUsd: null,
    request: { type: 'image.generate', projectId: null, prompt, purpose: 'free', aspectRatio: '9:16', imageSize: '2K', referenceAssetIds: [], grounding: false, applyStyleBible: false, characterIds: [], collections: [] },
  });
  tasks.push({ payload: { jobId: id, step: 'start', seq: 0 }, delaySec: 0 });
}

const accepted = (id = 'int-1') => ({ id, status: 'in_progress' });
const done = (id = 'int-1') => ({ id, status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', uri: `gs://test-bucket/users/u1/generated/${id}/v.mp4`, mime_type: 'video/mp4' }] }], usage: { total_input_tokens: 10, total_output_tokens: 100 } });
const imageOk = () => ({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('png').toString('base64'), mimeType: 'image/png' } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1120 } });
const imageBlocked = () => ({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] });
const reasoningJson = (json: unknown) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 60 } });

beforeEach(() => {
  resetFakes();
  invalidateProviderHealth();
  processed.length = 0;
  g.settings = {};
  for (const fn of [g.create, g.get, g.cancel, g.generate]) fn.mockReset();
  store.set('users/u1', { email: 'owner@example.com', settings: DEFAULT_SETTINGS });
});

describe('temporary failures', () => {
  it('retries a rejected submission with backoff (respecting Retry-After) and succeeds without a duplicate', async () => {
    g.create.mockRejectedValueOnce(apiError(503, { code: 'service_unavailable', message: 'The service is temporarily overloaded' }, { 'retry-after': '20' })).mockResolvedValueOnce(accepted());
    g.get.mockResolvedValue(done());
    seedVideoJob('j1');
    await drain();
    const j = job('j1');
    expect(j.status).toBe('completed');
    expect(g.create).toHaveBeenCalledTimes(2);
    expect(j.retry).toMatchObject({ transient: 1, submissions: 2 });
    const retryTask = processed.find((p) => p.step === 'start' && p.delaySec > 0)!;
    expect(retryTask.delaySec).toBeGreaterThanOrEqual(20);
    expect(j.attempts?.some((a) => a.outcome === 'retrying' && a.category === 'transient' && a.code === 'service_unavailable')).toBe(true);
  });

  it('stops after the configured number of attempts and offers a retry', async () => {
    g.create.mockRejectedValue(apiError(503, { code: 'service_unavailable', message: 'Overloaded' }));
    seedVideoJob('j1');
    await drain();
    const j = job('j1');
    expect(j.status).toBe('failed');
    expect(g.create).toHaveBeenCalledTimes(3);
    expect(j.error).toMatchObject({ category: 'transient', remedy: 'retry', retryable: false });
  });

  it('never resends a paid generation when Google did not confirm whether it was accepted', async () => {
    g.create.mockRejectedValue(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }));
    seedVideoJob('j1');
    await drain();
    expect(g.create).toHaveBeenCalledTimes(1);
    expect(job('j1').error).toMatchObject({ category: 'transient', ambiguous: true, remedy: 'retry' });
  });
});

describe('accepted generations are resumed, never resubmitted', () => {
  it('checks the same interaction again after failed status checks', async () => {
    g.create.mockResolvedValue(accepted());
    g.get
      .mockRejectedValueOnce(apiError(503, { code: 'service_unavailable', message: 'busy' }))
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(done());
    seedVideoJob('j1');
    await drain();
    const j = job('j1');
    expect(j.status).toBe('completed');
    expect(g.create).toHaveBeenCalledTimes(1);
    expect(g.get).toHaveBeenCalledTimes(4);
    expect(j.attempts?.filter((a) => a.kind === 'poll' && a.outcome === 'retrying')).toHaveLength(2);
    expect(j.result?.interactionId).toBe('int-1');
  });

  it('pauses as resumable at the status-check limit, and resuming completes with no new submission', async () => {
    g.settings = { retryPolicy: { ...DEFAULT_SETTINGS.retryPolicy, pollFailures: 2 } };
    g.create.mockResolvedValue(accepted());
    g.get.mockRejectedValue(apiError(503, { code: 'service_unavailable', message: 'busy' }));
    seedVideoJob('j1');
    await drain();
    const stopped = job('j1');
    expect(stopped.status).toBe('failed');
    expect(stopped.error).toMatchObject({ remedy: 'resume', resumable: true });
    expect(stopped.external?.interactionId).toBe('int-1');
    g.get.mockReset().mockResolvedValue(done());
    const res = await actions.retryJob(OWNER, { jobId: 'j1', acknowledgeCharge: true, resume: true });
    await drain();
    const resumed = job(res.jobIds[0]!);
    expect(resumed.status).toBe('completed');
    expect(resumed.resumedFrom).toBe('j1');
    expect(g.create).toHaveBeenCalledTimes(1);
  });

  it('stops checking (without cancelling or resubmitting) after the waiting time', async () => {
    g.settings = { retryPolicy: { ...DEFAULT_SETTINGS.retryPolicy, pollMaxWaitMinutes: 10 } };
    g.create.mockResolvedValue(accepted());
    g.get.mockResolvedValue(accepted());
    seedVideoJob('j1');
    await drain(3);
    // The accepted interaction is now old: the next check stops.
    store.set('jobs/j1', { ...doc('jobs/j1')!, external: { ...(doc('jobs/j1')!.external as object), acceptedAt: Date.now() - 11 * 60_000 } });
    await drain();
    const j = job('j1');
    expect(j.status).toBe('failed');
    expect(j.error).toMatchObject({ code: 'poll_timeout', remedy: 'resume' });
    expect(g.cancel).not.toHaveBeenCalled();
    expect(g.create).toHaveBeenCalledTimes(1);
  });
});

describe('content-policy blocks', () => {
  it('rewrites a blocked prompt once and keeps both versions in the history', async () => {
    g.generate.mockImplementation(async (req: { model: string }) => {
      if (req.model === REASONING) return reasoningJson({ benign: true, revisedPrompt: 'A grandmother stands calmly and smiles at her grandson in a sunlit courtyard.', explanation: 'Replaced wording about touching clothing with a neutral description.', changes: ['smooths her blouse → stands calmly'] });
      return g.generate.mock.calls.filter((c) => (c[0] as { model: string }).model === IMAGE).length === 1 ? imageBlocked() : imageOk();
    });
    seedImageJob('i1', 'A grandmother smooths her blouse and smiles at her grandson in a sunlit courtyard.');
    await drain();
    const j = job('i1');
    expect(j.status).toBe('completed');
    const imageCalls = g.generate.mock.calls.filter((c) => (c[0] as { model: string }).model === IMAGE);
    expect(imageCalls).toHaveLength(2);
    expect(JSON.stringify(imageCalls[1]![0])).toContain('stands calmly');
    expect(j.prompts?.map((p) => p.source)).toEqual(['original', 'auto_rewrite']);
    expect(j.prompts?.[0]?.prompt).toContain('smooths her blouse');
    expect(j.retry?.rewrites).toBe(1);
  });

  it('stops after the rewritten prompt is blocked too — no third request, the director revises it', async () => {
    g.generate.mockImplementation(async (req: { model: string }) => (req.model === REASONING ? reasoningJson({ benign: true, revisedPrompt: 'A calm portrait of a grandmother in a courtyard.', explanation: 'Neutral wording.', changes: [] }) : imageBlocked()));
    seedImageJob('i1', 'A grandmother smooths her blouse.');
    await drain();
    const j = job('i1');
    expect(j.status).toBe('failed');
    expect(j.error).toMatchObject({ category: 'policy', remedy: 'fix_prompt' });
    expect(g.generate.mock.calls.filter((c) => (c[0] as { model: string }).model === IMAGE)).toHaveLength(2);
    expect(g.generate.mock.calls.filter((c) => (c[0] as { model: string }).model === REASONING)).toHaveLength(1);
  });

  it('does not resubmit when the intended content itself is not allowed', async () => {
    g.generate.mockImplementation(async (req: { model: string }) => (req.model === REASONING ? reasoningJson({ benign: false, revisedPrompt: '', explanation: 'The request itself is not allowed.', changes: [] }) : imageBlocked()));
    seedImageJob('i1', 'Some prompt.');
    await drain();
    expect(job('i1').error).toMatchObject({ category: 'policy', remedy: 'fix_prompt' });
    expect(g.generate.mock.calls.filter((c) => (c[0] as { model: string }).model === IMAGE)).toHaveLength(1);
  });

  it('lets the director retry with a revised prompt; the history keeps every version', async () => {
    g.generate.mockImplementation(async (req: { model: string }) => (req.model === REASONING ? reasoningJson({ benign: false, revisedPrompt: '', explanation: '', changes: [] }) : imageBlocked()));
    seedImageJob('i1', 'First prompt.');
    await drain();
    g.generate.mockReset().mockResolvedValue(imageOk());
    const res = await actions.retryJob(OWNER, { jobId: 'i1', acknowledgeCharge: true, prompt: 'A revised, literal prompt.', resume: false });
    await drain();
    const next = job(res.jobIds[0]!);
    expect(next.status).toBe('completed');
    expect(next.retryOf).toBe('i1');
    expect(next.prompts?.map((p) => [p.source, p.prompt])).toEqual([
      ['original', 'First prompt.'],
      ['director', 'A revised, literal prompt.'],
    ]);
  });
});

describe('invalid requests, access and quota', () => {
  it('repairs a documented configuration once', async () => {
    g.create.mockRejectedValueOnce(apiError(400, { code: 400, status: 'INVALID_ARGUMENT', message: 'previous_interaction_id is not allowed when video task is set' })).mockResolvedValueOnce(accepted());
    g.get.mockResolvedValue(done());
    seedVideoJob('j1', { mode: 'edit', task: 'edit', previousInteractionId: 'int-0' });
    await drain();
    expect(job('j1').status).toBe('completed');
    expect(g.create).toHaveBeenCalledTimes(2);
    expect((g.create.mock.calls[0]![0] as { generation_config?: unknown }).generation_config).toBeTruthy();
    expect((g.create.mock.calls[1]![0] as { generation_config?: unknown }).generation_config).toBeUndefined();
    expect(job('j1').repairs).toHaveLength(1);
  });

  it('never resends an unchanged invalid request', async () => {
    g.create.mockRejectedValue(apiError(400, { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' }));
    seedVideoJob('j1');
    await drain();
    expect(g.create).toHaveBeenCalledTimes(1);
    expect(job('j1').error).toMatchObject({ category: 'invalid_request', remedy: 'fix_settings' });
  });

  it('stops at a permission failure, explains it, and pauses other work for that provider', async () => {
    g.create.mockRejectedValue(apiError(403, { code: 403, status: 'PERMISSION_DENIED', message: "Permission 'aiplatform.endpoints.predict' denied" }));
    seedVideoJob('j1');
    await drain();
    expect(g.create).toHaveBeenCalledTimes(1);
    expect(job('j1').error).toMatchObject({ category: 'auth_quota', code: 'permission_denied', remedy: 'fix_settings' });
    expect(job('j1').error?.action).toMatch(/roles\/aiplatform\.user/);
    seedVideoJob('j2');
    await drain();
    expect(g.create).toHaveBeenCalledTimes(1);
    expect(job('j2').error).toMatchObject({ category: 'auth_quota', providerStatus: 'paused' });
  });

  it('stops at an exhausted daily quota without retrying', async () => {
    g.create.mockRejectedValue(apiError(429, { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for aiplatform.googleapis.com/online_prediction_requests_per_day.' }));
    seedVideoJob('j1');
    await drain();
    expect(g.create).toHaveBeenCalledTimes(1);
    expect(job('j1').error).toMatchObject({ category: 'auth_quota', code: 'quota_exhausted' });
  });

  it('keeps an unexplained failure as unknown with an explicit retry (not a safety block)', async () => {
    g.create.mockRejectedValue(new Error('An odd internal condition'));
    seedVideoJob('j1');
    await drain();
    expect(job('j1').error).toMatchObject({ category: 'unknown', remedy: 'retry', safety: false });
  });
});

describe('cancellation', () => {
  it('cancels a running generation at Google and sends nothing more', async () => {
    g.create.mockResolvedValue(accepted());
    g.get.mockResolvedValue(accepted());
    seedVideoJob('j1');
    await drain(2);
    const r = await actions.cancelJob(OWNER, { jobId: 'j1' });
    expect(r.status).toBe('cancelled');
    await drain();
    expect(g.cancel).toHaveBeenCalledWith('int-1');
    expect(job('j1').status).toBe('cancelled');
    expect(g.create).toHaveBeenCalledTimes(1);
  });

  it('cancels a job waiting for its retry, so the retry never runs', async () => {
    g.create.mockRejectedValueOnce(apiError(503, { code: 'service_unavailable', message: 'busy' })).mockResolvedValue(accepted());
    seedVideoJob('j1');
    await drain(1);
    expect(job('j1').status).toBe('queued');
    await actions.cancelJob(OWNER, { jobId: 'j1' });
    await drain();
    expect(job('j1').status).toBe('cancelled');
    expect(g.create).toHaveBeenCalledTimes(1);
  });
});

describe('Short Ads scene generation', () => {
  function seedAd() {
    const ad = { ...defaultAdSpec('audio_first', '9:16'), audio: { ...defaultAdSpec().audio, assetId: 'aud', songId: 'song', durationSec: 12 } };
    store.set('projects/p1', { ownerUid: 'u1', title: 'Ad', type: 'short_ad', status: 'active', format: { aspectRatio: '9:16', fps: 24 }, ad });
    const shot = (id: string, start: number, end: number, extra: Record<string, unknown>) =>
      store.set(`projects/p1/shots/${id}`, {
        sceneId: null, sectionId: null, order: start, number: id, title: `Scene ${id}`, description: 'Two friends laugh at a market stall', directions: { framing: '', cameraMovement: '', lens: '', lighting: '', mood: '', style: '', performance: '', action: '', dialogue: [], ambientSound: '', avoid: '' },
        promptOverride: null, durationSec: 5, aspectRatio: '9:16', resolution: '1080p', refs: { characterIds: [], locationIds: [], elementIds: [], assetIds: [], firstFrameAssetId: null, lastFrameAssetId: null, storyboardAssetId: null },
        lockRefs: false, status: 'planned', selectedTakeId: null, approvedTakeId: null, timing: { start, end }, takeCount: 0, notes: '', ...extra,
      });
    // A: generated and validated; B: failed earlier; C: typography (never generated).
    shot('a', 0, 4, { status: 'ready', selectedTakeId: 'ta', ad: defaultAdScene({ kind: 'generated_video', jobId: 'old-a', validation: { takeId: 'ta', verdict: 'pass', checkedAt: 1, failed: [] } }) });
    store.set('projects/p1/shots/a/takes/ta', { index: 1, jobId: 'old-a', assetId: 'va', status: 'completed', validation: { verdict: 'pass' } });
    store.set('jobs/old-a', { ownerUid: 'u1', status: 'completed', type: 'video.generate' });
    shot('b', 4, 8, { status: 'failed', ad: defaultAdScene({ kind: 'generated_video', jobId: 'old-b' }) });
    store.set('jobs/old-b', { ownerUid: 'u1', status: 'failed', type: 'video.generate' });
    shot('c', 8, 12, { ad: defaultAdScene({ kind: 'typography' }) });
  }

  it('regenerates only the failed scene, keeps completed scenes, and never starts the same scene twice', async () => {
    seedAd();
    const first = await adsApi.adGenerate(OWNER, { projectId: 'p1', force: false, estimateOnly: false, confirmedUsd: 100 });
    expect(first.jobIds).toHaveLength(1);
    expect(first.skipped).toEqual([{ sceneId: 'a', reason: 'already has a usable result' }]);
    expect(doc('projects/p1/shots/b')!.ad).toMatchObject({ jobId: first.jobIds[0] });
    expect(doc('projects/p1/shots/a')!).toMatchObject({ selectedTakeId: 'ta', ad: { jobId: 'old-a' } });
    const again = await adsApi.adGenerate(OWNER, { projectId: 'p1', force: false, estimateOnly: false, confirmedUsd: 100 });
    expect(again.jobIds).toHaveLength(0);
    expect(again.skipped).toEqual(expect.arrayContaining([{ sceneId: 'b', reason: 'already generating' }]));
    expect(docs('jobs').filter((j) => j.type === 'video.generate' && j.id !== 'old-a' && j.id !== 'old-b')).toHaveLength(1);
  });

  it('starts one generation even when two requests arrive at once', async () => {
    seedAd();
    const [x, y] = await Promise.all([adsApi.adGenerate(OWNER, { projectId: 'p1', force: false, estimateOnly: false, confirmedUsd: 100 }), adsApi.adGenerate(OWNER, { projectId: 'p1', force: false, estimateOnly: false, confirmedUsd: 100 })]);
    expect(x.jobIds.length + y.jobIds.length).toBe(1);
  });

  it('validates a generated scene before it can be composed', async () => {
    seedAd();
    g.create.mockResolvedValue(accepted());
    g.get.mockResolvedValue(done());
    const r = await adsApi.adGenerate(OWNER, { projectId: 'p1', force: false, estimateOnly: false, confirmedUsd: 100 });
    await drain();
    expect(job(r.jobIds[0]!).status).toBe('completed');
    const validate = docs('jobs').find((j) => j.type === 'ad.validate');
    expect(validate).toMatchObject({ target: { kind: 'shot', id: 'b' } });
    expect(doc('projects/p1/shots/b')!.ad).toMatchObject({ validationJobId: validate!.id });
  });
});
