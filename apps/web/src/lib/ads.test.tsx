import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { defaultAdSpec, type AdSpec, type ProjectDoc } from '@az-studio/shared';

const updateProject = vi.fn<(id: string, patch: { ad: AdSpec }) => Promise<void>>();
vi.mock('firebase/firestore', () => ({ doc: vi.fn(), getDoc: vi.fn(), serverTimestamp: vi.fn(), writeBatch: vi.fn() }));
vi.mock('./firebase', () => ({ db: {} }));
vi.mock('./api', () => ({ api: vi.fn() }));
vi.mock('./data', () => ({ useDoc: vi.fn(() => ({ data: null, loading: false })) }));
vi.mock('./studio', () => ({
  updateProject: (id: string, patch: { ad: AdSpec }) => updateProject(id, patch),
  createProject: vi.fn(),
  createSong: vi.fn(),
  createTimeline: vi.fn(),
  newShot: vi.fn(),
  saveTimeline: vi.fn(),
  snapshotTimeline: vi.fn(),
  subCol: vi.fn(),
  updateSubDoc: vi.fn(),
  useSub: vi.fn(() => ({ data: [], loading: false })),
}));

const { useAdDraft } = await import('./ads');

type Project = ProjectDoc & { id: string };
const project = (ad: AdSpec): Project => ({ id: 'p1', ownerUid: 'owner', title: 'Advert', type: 'short_ad', logline: '', idea: '', genre: '', status: 'active', format: { aspectRatio: '9:16', fps: 24 }, coverAssetId: null, styleBible: {}, ad }) as unknown as Project;

beforeEach(() => {
  vi.useFakeTimers();
  updateProject.mockReset();
  updateProject.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flushTimers = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('advert draft persistence', () => {
  it('saves edits shortly after the last change, once, with the latest state', async () => {
    const start = defaultAdSpec('audio_first', '9:16');
    const { result } = renderHook(() => useAdDraft(project(start), 500));
    expect(result.current.status).toBe('saved');
    act(() => result.current.update((a) => ({ ...a, brief: { ...a.brief, brand: 'Indigen' } })));
    act(() => result.current.update((a) => ({ ...a, brief: { ...a.brief, brand: 'Indigen World' } })));
    act(() => result.current.update({ aspect: '1:1' }));
    expect(result.current.status).toBe('unsaved');
    expect(result.current.ad.brief.brand).toBe('Indigen World');
    await flushTimers(499);
    expect(updateProject).not.toHaveBeenCalled();
    await flushTimers(1);
    expect(updateProject).toHaveBeenCalledTimes(1);
    const [id, patch] = updateProject.mock.calls[0]!;
    expect(id).toBe('p1');
    expect(patch.ad).toMatchObject({ aspect: '1:1', brief: { brand: 'Indigen World' } });
    expect(patch.ad.updatedAt).toBeGreaterThan(0);
    expect(result.current.status).toBe('saved');
  });

  it('keeps a draft that failed to save and saves it with the next change', async () => {
    updateProject.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useAdDraft(project(defaultAdSpec()), 200));
    act(() => result.current.update((a) => ({ ...a, brief: { ...a.brief, tagline: 'Starting with Kasem' } })));
    await flushTimers(200);
    expect(result.current.status).toBe('error');
    expect(result.current.ad.brief.tagline).toBe('Starting with Kasem');
    act(() => result.current.update((a) => ({ ...a, brief: { ...a.brief, callToAction: 'Discover Indigen World' } })));
    await flushTimers(200);
    expect(updateProject).toHaveBeenCalledTimes(2);
    expect(updateProject.mock.calls[1]![1].ad.brief).toMatchObject({ tagline: 'Starting with Kasem', callToAction: 'Discover Indigen World' });
    expect(result.current.status).toBe('saved');
  });

  it('saves pending edits when the workspace is left before the delay', async () => {
    const { result, unmount } = renderHook(() => useAdDraft(project(defaultAdSpec()), 5000));
    act(() => result.current.update((a) => ({ ...a, brand: { ...a.brand, accent: '#22D3EE' } })));
    expect(updateProject).not.toHaveBeenCalled();
    unmount();
    await flushTimers(0);
    expect(updateProject).toHaveBeenCalledTimes(1);
    expect(updateProject.mock.calls[0]![1].ad.brand.accent).toBe('#22D3EE');
  });

  it('adopts changes saved elsewhere only when nothing is pending here', async () => {
    const base = defaultAdSpec();
    const { result, rerender } = renderHook(({ p }) => useAdDraft(p, 300), { initialProps: { p: project(base) } });
    rerender({ p: project({ ...base, brief: { ...base.brief, brand: 'From another tab' } }) });
    expect(result.current.ad.brief.brand).toBe('From another tab');
    act(() => result.current.update((a) => ({ ...a, brief: { ...a.brief, objective: 'Local edit' } })));
    rerender({ p: project({ ...base, brief: { ...base.brief, brand: 'Second remote change' } }) });
    expect(result.current.ad.brief).toMatchObject({ brand: 'From another tab', objective: 'Local edit' });
    await flushTimers(300);
    expect(updateProject.mock.calls.at(-1)![1].ad.brief).toMatchObject({ brand: 'From another tab', objective: 'Local edit' });
  });
});
