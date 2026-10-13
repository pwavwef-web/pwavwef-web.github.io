import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AMBIENCE_KINDS, DEFAULT_SETTINGS, defaultLiteSpec, jobRequestSchema, newScene, newShot, type JobDoc, type LiteSpec } from '@az-studio/shared';
import { doc, docs, resetFakes, store } from './fakes';

vi.mock('../src/lib/firebase', async () => import('./fakes'));
vi.mock('firebase-admin/functions', async () => {
  const f = await import('./fakes');
  return { getFunctions: () => ({ taskQueue: () => ({ enqueue: async (payload: never, opts?: { scheduleDelaySeconds?: number }) => void f.tasks.push({ payload, delaySec: opts?.scheduleDelaySeconds ?? 0 }) }) }) };
});
vi.mock('firebase-functions', async (orig) => ({ ...(await orig<typeof import('firebase-functions')>()), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/lib/interactions', () => ({ logInteraction: async () => undefined }));
vi.mock('../src/lib/music-model', () => ({ musicSurface: async () => 'developer-api', generateMusic: vi.fn() }));
const speakLine = vi.fn();
const transcribe = vi.fn();
vi.mock('../src/lib/audio-models', async (orig) => ({ ...(await orig<typeof import('../src/lib/audio-models')>()), speakLine: (...a: unknown[]) => speakLine(...a), transcribe: (...a: unknown[]) => transcribe(...a) }));
vi.mock('../src/lib/assets', async (orig) => ({ ...(await orig<typeof import('../src/lib/assets')>()), createAsset: async (input: { assetId: string }) => input.assetId }));

import { liteCancel, liteGenerate } from '../src/api/lite';
import { prepareJob } from '../src/lib/prepare';
import { createInternalJob } from '../src/lib/submit';
import { runLiteNarrationJob } from '../src/workers/lite-narration';
import { ambienceGraph } from '../src/workers/ambience';
import { claimJob } from '../src/lib/jobs';

const owner = { uid: 'u', email: 'o@x' };

function liteSpec(): LiteSpec {
  const spec = defaultLiteSpec({ direction: 'folklore', aspect: '16:9', targetSec: 120 });
  spec.bible.characters = [{ id: 'ama', name: 'Ama', description: 'A girl of ten with short natural hair', clothing: 'Indigo wrapper', refAssetIds: ['ref-ama'] }];
  spec.scenes = [
    newScene({ id: 's1', title: 'Fire', narration: 'Long ago, the village gathered by the fire.', ambience: { kind: 'night', assetId: null, levelDb: 0 }, shots: [newShot({ id: 'h1', brief: 'Villagers around a fire at night', characterIds: ['ama'] }), newShot({ id: 'h2', brief: 'Ama listening, firelight on her face', characterIds: ['ama'] })] }),
    newScene({ id: 's2', title: 'Dawn', narration: 'At dawn, Ama walked to the river.', ambience: { kind: 'wind', assetId: null, levelDb: 0 }, shots: [newShot({ id: 'h3', brief: 'A path to the river at dawn' })] }),
  ];
  return spec;
}

beforeEach(() => {
  resetFakes();
  speakLine.mockReset();
  transcribe.mockReset();
  store.set('users/u', { settings: { ...DEFAULT_SETTINGS, dailyLimitUsd: 1000, monthlyLimitUsd: 1000, confirmAboveUsd: 0.01 } });
  store.set('projects/p', { ownerUid: 'u', title: 'The River', type: 'film_lite', status: 'active', format: { aspectRatio: '16:9', fps: 24 }, lite: liteSpec() });
  store.set('assets/ref-ama', { ownerUid: 'u', kind: 'image', status: 'ready', mimeType: 'image/png', storagePath: 'users/u/ref-ama.png', sizeBytes: 1000, title: 'portrait.png' });
});

const jobs = () => docs<JobDoc>('jobs');
const complete = (id: string, result: Record<string, unknown> = {}) => store.set(`jobs/${id}`, { ...doc(`jobs/${id}`)!, status: 'completed', result });

describe('liteGenerate', () => {
  it('estimates first, then requests each missing image once with labelled references', async () => {
    const est = (await liteGenerate(owner, { projectId: 'p', kind: 'images', force: false, estimateOnly: true })) as { perTarget: unknown[]; estimate: { usd: number }; confirmation: { required: boolean } };
    expect(est.perTarget).toHaveLength(3);
    expect(est.estimate.usd).toBeGreaterThan(0);
    expect(jobs()).toHaveLength(0);
    // A confirmation is required above the threshold; without it nothing is created.
    await expect(liteGenerate(owner, { projectId: 'p', kind: 'images', force: false, estimateOnly: false })).rejects.toThrow(/Confirm/);
    const res = (await liteGenerate(owner, { projectId: 'p', kind: 'images', force: false, estimateOnly: false, confirmedUsd: est.estimate.usd })) as { jobIds: string[] };
    expect(res.jobIds).toHaveLength(3);
    const j = jobs().find((x) => x.target?.id === 'h2')!;
    expect(j).toMatchObject({ type: 'image.generate', target: { kind: 'lite_shot', id: 'h2' } });
    expect((j.params as { references: { title: string }[] }).references[0]!.title).toBe('Ama — likeness reference');
    expect((j.params as { prompt: string }).prompt).toContain('Match reference image 1 exactly');
    expect((j.params as { prompt: string }).prompt).toMatch(/Not a cartoon/);
  });

  it('never requests the same image twice: running and completed work with the same input are reused', async () => {
    const first = (await liteGenerate(owner, { projectId: 'p', kind: 'images', force: false, estimateOnly: false, confirmedUsd: 5 })) as { jobIds: string[] };
    const again = (await liteGenerate(owner, { projectId: 'p', kind: 'images', force: false, estimateOnly: false, confirmedUsd: 5 })) as { jobIds: string[]; skipped: { reason: string }[] };
    expect(again.jobIds).toEqual([]);
    expect(again.skipped.every((s) => /in progress/.test(s.reason))).toBe(true);
    for (const id of first.jobIds) complete(id, { assetIds: [`img-${id}`] });
    const after = (await liteGenerate(owner, { projectId: 'p', kind: 'images', force: false, estimateOnly: false, confirmedUsd: 5 })) as { jobIds: string[]; skipped: { reason: string }[] };
    expect(after.jobIds).toEqual([]);
    expect(after.skipped.every((s) => /reused/.test(s.reason))).toBe(true);
    // An explicit regeneration of one shot makes exactly one new request.
    const redo = (await liteGenerate(owner, { projectId: 'p', kind: 'images', targetIds: ['h3'], force: true, estimateOnly: false, confirmedUsd: 5 })) as { jobIds: string[] };
    expect(redo.jobIds).toHaveLength(1);
    expect(jobs()).toHaveLength(4);
  });

  it('voices each scene once and re-voices only a scene whose text changed', async () => {
    const r1 = (await liteGenerate(owner, { projectId: 'p', kind: 'narration', force: false, estimateOnly: false, confirmedUsd: 5 })) as { jobIds: string[] };
    expect(r1.jobIds).toHaveLength(2);
    for (const id of r1.jobIds) complete(id, { data: { takes: [] } });
    const spec = doc('projects/p')!.lite as LiteSpec;
    spec.scenes[1]!.narration = 'At dawn, Ama ran to the river.';
    const r2 = (await liteGenerate(owner, { projectId: 'p', kind: 'narration', force: false, estimateOnly: false, confirmedUsd: 5 })) as { jobIds: string[] };
    expect(r2.jobIds).toHaveLength(1);
    expect(jobs().find((j) => j.id === r2.jobIds[0])!.target).toEqual({ kind: 'lite_scene', id: 's2' });
  });

  it('plans the score from the scenes and requests strictly instrumental movements for a Lite film', async () => {
    const res = (await liteGenerate(owner, { projectId: 'p', kind: 'music', force: false, estimateOnly: false, confirmedUsd: 5 })) as { jobIds: string[] };
    expect(res.jobIds.length).toBeGreaterThan(0);
    const score = doc('projects/p/scores/lite-score')!;
    expect(score.cueSheet.map((c: { sceneId: string }) => c.sceneId)).toEqual(['s1', 's2']);
    const j = jobs()[0]!;
    expect(j.type).toBe('music.generate');
    expect((j.params as { prompt: string }).prompt).toMatch(/Strictly instrumental/);
  });

  it('prices the first score before it is saved (no “Score not found”)', async () => {
    expect(doc('projects/p/scores/lite-score')).toBeFalsy();
    const est = (await liteGenerate(owner, { projectId: 'p', kind: 'music', force: false, estimateOnly: true })) as { perTarget: unknown[]; estimate: { usd: number }; movements: unknown[] };
    expect(est.perTarget.length).toBeGreaterThan(0);
    expect(est.movements.length).toBe(est.perTarget.length);
    expect(doc('projects/p/scores/lite-score')).toBeFalsy();
    expect(jobs()).toHaveLength(0);
  });

  it('makes free ambience beds once per kind', async () => {
    const r = (await liteGenerate(owner, { projectId: 'p', kind: 'ambience', force: false, estimateOnly: false })) as { jobIds: string[]; estimate: { usd: number } };
    expect(r.jobIds).toHaveLength(2);
    expect(r.estimate.usd).toBe(0);
    for (const id of r.jobIds) complete(id, { assetIds: ['a'] });
    expect(((await liteGenerate(owner, { projectId: 'p', kind: 'ambience', force: false, estimateOnly: false })) as { jobIds: string[] }).jobIds).toEqual([]);
  });

  it('cancels queued generation but leaves renders alone', async () => {
    await liteGenerate(owner, { projectId: 'p', kind: 'images', force: false, estimateOnly: false, confirmedUsd: 5 });
    store.set('jobs/render1', { ownerUid: 'u', projectId: 'p', type: 'render.timeline', status: 'rendering', cancelRequested: false });
    const r = await liteCancel(owner, { projectId: 'p' });
    expect(r.cancelled).toBe(3);
    expect(doc('jobs/render1')!.status).toBe('rendering');
  });
});

describe('Film Studio Lite never uses video generation or lip sync', () => {
  it('rejects video generation for a Lite project', async () => {
    const req = jobRequestSchema.parse({ type: 'video.generate', projectId: 'p', prompt: 'A slow push-in', durationSec: 4 });
    await expect(prepareJob('u', req)).rejects.toThrow(/does not use video generation/);
  });
  it('rejects lip sync for a Lite project', async () => {
    await expect(createInternalJob('u', { type: 'video.lipsync', projectId: 'p', modelId: null, label: 'x', params: {}, estimate: { usd: 0, basis: 'none', confidence: 'high', breakdown: [], notes: [], pricingVersion: 'x' }, target: null, productionId: null })).rejects.toThrow(/lip sync/);
  });
});

describe('narration worker', () => {
  const words = (text: string, from = 0.3) => text.split(' ').map((w, i) => ({ text: w.replace(/[.,]/g, ''), start: from + i * 0.4, end: from + i * 0.4 + 0.32, speaker: null }));
  async function narrationJob(): Promise<JobDoc> {
    const res = (await liteGenerate(owner, { projectId: 'p', kind: 'narration', targetIds: ['s1'], force: false, estimateOnly: false, confirmedUsd: 5 })) as { jobIds: string[] };
    return (await claimJob(res.jobIds[0]!))!;
  }

  it('speaks once and times every word from the real audio', async () => {
    speakLine.mockResolvedValue({ wav: Buffer.alloc(100), fileSeconds: 4.2, speech: { start: 0.3, end: 3.9, durationSec: 3.6 }, usage: { input: 10, output: 100 } });
    transcribe.mockResolvedValue({ text: '', words: words('Long ago, the village gathered by the fire.'), languageCode: 'en', modelId: 'm', usage: { input: 1, output: 1, thoughts: 0 }, latencyMs: 1 });
    const job = await narrationJob();
    await runLiteNarrationJob(job);
    const done = doc(`jobs/${job.id}`)!;
    expect(done.status).toBe('completed');
    const take = done.result.data.takes[0];
    expect(take).toMatchObject({ sceneId: 's1', alignment: 'aligned', source: 'generated', speechStart: 0.3 });
    expect(take.words.map((w: { text: string }) => w.text).join(' ')).toBe('Long ago, the village gathered by the fire.');
    expect(take.words[0].start).toBeCloseTo(0.3, 3);
    expect(speakLine).toHaveBeenCalledTimes(1);
  });

  it('keeps the speech when timing fails and never pays for the speech again on a retry', async () => {
    speakLine.mockResolvedValue({ wav: Buffer.alloc(100), fileSeconds: 4.2, speech: { start: 0.3, end: 3.9, durationSec: 3.6 }, usage: { input: 10, output: 100 } });
    transcribe.mockRejectedValueOnce(new Error('503 unavailable'));
    const job = await narrationJob();
    await runLiteNarrationJob(job);
    const done = doc(`jobs/${job.id}`)!;
    expect(done.status).toBe('completed');
    expect(done.result.data.takes[0].alignment).toBe('estimated');
    expect(done.result.data.takes[0].flags[0]).toMatch(/alignment_unavailable/);
    // A redelivered task (e.g. after a crash) reuses the saved audio.
    store.set(`jobs/${job.id}`, { ...done, status: 'queued', result: null });
    transcribe.mockResolvedValue({ text: '', words: words('Long ago, the village gathered by the fire.'), languageCode: 'en', modelId: 'm', usage: { input: 1, output: 1, thoughts: 0 }, latencyMs: 1 });
    await runLiteNarrationJob((await claimJob(job.id))!);
    expect(speakLine).toHaveBeenCalledTimes(1);
    expect(doc(`jobs/${job.id}`)!.result.data.takes[0].alignment).toBe('aligned');
  });

  it('flags a voice that repeated part of the script', async () => {
    speakLine.mockResolvedValue({ wav: Buffer.alloc(100), fileSeconds: 8, speech: { start: 0.3, end: 7.5, durationSec: 7.2 }, usage: { input: 10, output: 100 } });
    transcribe.mockResolvedValue({ text: '', words: words('Long ago, the village gathered by the fire. the village gathered by the fire by the fire.'), languageCode: 'en', modelId: 'm', usage: { input: 1, output: 1, thoughts: 0 }, latencyMs: 1 });
    const job = await narrationJob();
    await runLiteNarrationJob(job);
    expect(doc(`jobs/${job.id}`)!.result.data.takes[0].flags.join(' ')).toMatch(/extra_words/);
  });
});

const require = createRequire(import.meta.url);
const FF = (() => {
  try {
    return require('ffmpeg-static') as string;
  } catch {
    return null;
  }
})();

describe.skipIf(!FF)('ambience synthesis', () => {
  it('renders every bed, and the same seed always gives the same audio', () => {
    for (const kind of AMBIENCE_KINDS) {
      const run = () => execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-filter_complex', `${ambienceGraph(kind, 4, 11)},aformat=sample_fmts=s16:channel_layouts=stereo[out]`, '-map', '[out]', '-t', '4', '-f', 'md5', '-'], { stdio: 'pipe' }).toString().trim();
      const a = run();
      expect(a).toMatch(/^MD5=/);
      expect(run()).toBe(a);
    }
  }, 60_000);
});
