import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CharacterDoc, ProjectDoc } from '@az-studio/shared';
const state = vi.hoisted(() => ({ characters: [] as CharacterDoc[], submit: vi.fn(), job: null as Record<string, unknown> | null }));
vi.mock('../lib/studio', () => ({useSub: () => ({data: state.characters, loading: false})}));
vi.mock('../lib/data', () => ({useDoc: () => ({data: state.job})}));
vi.mock('../lib/media', () => ({useMediaUrls: () => null}));
vi.mock('./jobs', () => ({useJobSubmitter: () => ({submit: state.submit, busy: false, dialog: null})}));
vi.mock('sonner', () => ({toast: {success: vi.fn()}}));
import { ProjectCoverBible } from './project-cover-bible';
const project = {id: 'p', ownerUid: 'u', title: 'Homecoming', type: 'film', status: 'active', format: {aspectRatio: '16:9', fps: 24}, coverAssetId: 'cover'} as ProjectDoc;
beforeEach(() => { state.characters = []; state.job = null; state.submit.mockReset().mockResolvedValue(['cover-job']); });
afterEach(cleanup);
describe('Project cover in the Bible', () => {
  it('requires likeness references before regeneration', () => {
    state.characters = [{id: 'a', name: 'AMA', primaryRefAssetId: null} as CharacterDoc];
    render(<ProjectCoverBible project={project} />);
    expect((screen.getByRole('button', {name: 'Regenerate cover'}) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Finish the likeness references for AMA/)).toBeTruthy();
  });
  it('submits a Bible cover request when references are ready', async () => {
    state.characters = [{id: 'a', name: 'AMA', primaryRefAssetId: 'portrait-a'} as CharacterDoc];
    render(<ProjectCoverBible project={project} />);
    fireEvent.click(screen.getByRole('button', {name: 'Regenerate cover'}));
    await waitFor(() => expect(state.submit).toHaveBeenCalledWith([expect.objectContaining({type: 'image.generate', projectId: 'p', bibleCover: true})], expect.anything()));
  });
  it('shows job progress and prevents a second generation while the cover is running', () => {
    state.characters = [{id: 'a', name: 'AMA', primaryRefAssetId: 'portrait-a'} as CharacterDoc];
    state.job = {status: 'generating', stage: 'Composing cover'};
    render(<ProjectCoverBible project={project} />);
    expect(screen.getByRole('status').textContent).toBe('Composing cover');
    expect((screen.getByRole('button', {name: 'Regenerate cover'}) as HTMLButtonElement).disabled).toBe(true);
  });
});
