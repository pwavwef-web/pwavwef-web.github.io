import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, jobRequestSchema, type CharacterDoc, type ProjectDoc } from '@az-studio/shared';
import { doc, docs, resetFakes, store, tasks } from './fakes';
vi.mock('../src/lib/firebase', async () => import('./fakes'));
vi.mock('firebase-admin/functions', async () => {
  const f = await import('./fakes');
  return { getFunctions: () => ({ taskQueue: () => ({ enqueue: async (payload: never, opts?: { scheduleDelaySeconds?: number }) => { f.tasks.push({ payload, delaySec: opts?.scheduleDelaySeconds ?? 0 }); } }) }) };
});
vi.mock('firebase-functions', async orig => ({ ...(await orig<typeof import('firebase-functions')>()), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { applyTarget } from '../src/lib/assets';
import { loadBibleCover } from '../src/lib/bible-cover';
import { queueBibleCover } from '../src/lib/bible-cover-jobs';
import { prepareJob } from '../src/lib/prepare';
import { createJobs } from '../src/lib/submit';
import { handleBibleCoverChange } from '../src/triggers/bible-cover';
const project: ProjectDoc = { id: 'p', ownerUid: 'u', title: 'Homecoming', type: 'film', status: 'active', format: { aspectRatio: '16:9', fps: 24 }, coverAssetId: 'old-cover', treatment: {body: 'A young learner and an elder talk in a Kasena compound.'} };
const a = {id: 'a', name: 'AMA', role: 'lead', appearance: 'Short natural hair', wardrobe: 'Mustard blouse', primaryRefAssetId: 'portrait-a', realPerson: false} as CharacterDoc;
const b = {id: 'b', name: 'KOFI', role: 'elder', appearance: 'Grey hair', wardrobe: 'Blue shirt', primaryRefAssetId: 'portrait-b', realPerson: false} as CharacterDoc;
beforeEach(() => {
  resetFakes();
  store.set('users/u', {settings: {...DEFAULT_SETTINGS, dailyLimitUsd: 1000, monthlyLimitUsd: 1000}});
  store.set('projects/p', {...project});
  store.set('projects/p/characters/a', {...a});
  store.set('projects/p/characters/b', {...b});
  for (const id of ['portrait-a', 'portrait-b', 'approved-a']) store.set(`assets/${id}`, {ownerUid: 'u', kind: 'image', status: 'ready', mimeType: 'image/png', storagePath: `users/u/${id}.png`, sizeBytes: 1000, title: id});
});
describe('Bible project covers', () => {
  it('waits for all character likenesses, then automatically queues the cover using their exact images', async () => {
    const incomplete = {...b, primaryRefAssetId: null};
    store.set('projects/p/characters/b', incomplete);
    await handleBibleCoverChange('p', undefined, a);
    expect(docs('jobs')).toHaveLength(0);
    store.set('projects/p/characters/b', {...b});
    await handleBibleCoverChange('p', incomplete, b);
    const image = docs('jobs')[0]!;
    expect(image).toMatchObject({type: 'image.generate', status: 'queued', params: {purpose: 'thumbnail', aspectRatio: '16:9'}, target: {kind: 'project', id: 'p', sub: image.id}});
    expect(image.params.references.map((r: any) => r.assetId)).toEqual(['portrait-a', 'portrait-b']);
    expect(image.params.prompt).toContain('exact facial identity');
    expect(image.params.prompt).toContain('Kasena compound');
    expect(tasks.some(t => t.payload.jobId === image.id)).toBe(true);
  });
  it('deduplicates simultaneous reference completions and repeated Firestore events', async () => {
    const ids = await Promise.all([queueBibleCover('p'), queueBibleCover('p')]);
    expect(ids[0]).toBe(ids[1]);
    await handleBibleCoverChange('p', undefined, b);
    expect(docs('jobs')).toHaveLength(1);
    expect(doc('projects/p')!.coverBible.jobId).toBe(ids[0]);
  });
  it('uses approved likenesses and ignores unrelated client-supplied images and prompts', async () => {
    store.set('projects/p/characters/a', {...a, bible: {approvedAt: 1, approvedRefIds: ['approved-a'], refs: {}}});
    const req = jobRequestSchema.parse({type: 'image.generate', projectId: 'p', bibleCover: true, prompt: 'Invent a different face', aspectRatio: '16:9', imageSize: '1K', referenceAssetIds: ['unowned-image']});
    const p = await prepareJob('u', req);
    expect(p.params.references).toEqual(expect.arrayContaining([expect.objectContaining({assetId: 'approved-a'})]));
    expect(p.params.prompt).not.toContain('Invent a different face');
    expect(p.params.bibleCoverSignature).toBeTruthy();
  });
  it('blocks unfinished, foreign, missing references and unconfirmed real people', async () => {
    store.set('assets/portrait-b', {...doc('assets/portrait-b'), status: 'processing'});
    await expect(loadBibleCover('u', 'p')).rejects.toThrow('every character likeness');
    store.set('assets/portrait-b', {...doc('assets/portrait-b'), status: 'ready', ownerUid: 'other'});
    await expect(loadBibleCover('u', 'p')).rejects.toThrow('every character likeness');
    store.set('assets/portrait-b', {...doc('assets/portrait-b'), ownerUid: 'u'});
    store.set('projects/p/characters/b', {...b, realPerson: true, consentConfirmed: false});
    await expect(loadBibleCover('u', 'p')).rejects.toThrow('consent');
    store.set('projects/p/characters/b', {...b, primaryRefAssetId: null});
    await expect(loadBibleCover('u', 'p')).rejects.toThrow('KOFI');
  });
  it('enforces spending limits for automatic covers', async () => {
    store.set('users/u', {settings: {...DEFAULT_SETTINGS, dailyLimitUsd: 0}});
    await expect(queueBibleCover('p')).rejects.toThrow('Generation is paused');
    expect(docs('jobs')).toHaveLength(0);
  });
  it('regenerates from the Bible and prevents late covers from replacing the newest request', async () => {
    const automatic = await queueBibleCover('p');
    const result = await createJobs('u', [(await loadBibleCover('u', 'p')).request], {preconfirmed: true});
    const newest = result.jobIds[0]!;
    await applyTarget('p', {kind: 'project', id: 'p', sub: automatic!}, 'late-cover', 'thumbnail');
    expect(doc('projects/p')!.coverAssetId).toBe('old-cover');
    await applyTarget('p', {kind: 'project', id: 'p', sub: newest}, 'bible-cover', 'thumbnail');
    expect(doc('projects/p')!.coverAssetId).toBe('bible-cover');
    await applyTarget('p', {kind: 'project', id: 'p'}, 'ordinary-image', 'free');
    expect(doc('projects/p')!.coverAssetId).toBe('bible-cover');
  });
  it('does not generate covers during treatment writing or unrelated Bible edits', async () => {
    for (const task of ['film.treatment', 'music.treatment']) {
      const p = await prepareJob('u', jobRequestSchema.parse({type: 'text.assist', projectId: 'p', task, input: {idea: 'Home', brief: 'Home'}}));
      expect(p.params).not.toHaveProperty('projectCover');
    }
    await handleBibleCoverChange('p', a, {...a, personality: 'Curious'});
    expect(docs('jobs')).toHaveLength(0);
  });
});
