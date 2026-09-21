import { addDoc, collection, deleteDoc, doc, orderBy, query, serverTimestamp, setDoc, updateDoc, where, writeBatch, type DocumentData, type Query } from 'firebase/firestore';
import {
  emptyTimeline,
  timelineDuration,
  type FrameAspect,
  type NoteDoc,
  type ProjectDoc,
  type ProjectType,
  type ScriptDoc,
  type ShotDoc,
  type SongDoc,
  type TimelineDoc,
  type TimelineState,
} from '@az-studio/shared';
import { db } from './firebase';
export { newCharacter, newElement, newLocation, newScene, newShot } from './shot-defaults';
import { useQuery, useDoc } from './data';
import { useUid } from './session';

export type SubCollection = 'scripts' | 'sequences' | 'scenes' | 'shots' | 'characters' | 'locations' | 'elements' | 'notes' | 'songs' | 'timelines' | 'aiRuns';

export const projectRef = (id: string) => doc(db, 'projects', id);
export const subCol = (projectId: string, sub: SubCollection) => collection(db, 'projects', projectId, sub);
export const subDoc = (projectId: string, sub: SubCollection, id: string) => doc(db, 'projects', projectId, sub, id);

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useProjects(filter?: { type?: ProjectType; status?: 'active' | 'archived' }) {
  const uid = useUid();
  return useQuery<ProjectDoc>(() => {
    if (!uid) return null;
    const parts = [where('ownerUid', '==', uid)];
    if (filter?.type) parts.push(where('type', '==', filter.type));
    if (filter?.status) parts.push(where('status', '==', filter.status));
    return query(collection(db, 'projects'), ...parts, orderBy('updatedAt', 'desc'));
  }, [uid, filter?.type, filter?.status]);
}

export const useProject = (id: string | undefined) => useDoc<ProjectDoc>(id ? `projects/${id}` : null);

export function useSub<T>(projectId: string | undefined, sub: SubCollection, order: string = 'order', dir: 'asc' | 'desc' = 'asc') {
  return useQuery<T>(() => (projectId ? (query(subCol(projectId, sub), orderBy(order, dir)) as Query<DocumentData>) : null), [projectId, sub, order, dir]);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function createProject(uid: string, input: { title: string; type: ProjectType; logline?: string; aspectRatio?: FrameAspect; idea?: string; genre?: string }): Promise<string> {
  const data: Omit<ProjectDoc, 'id'> = {
    ownerUid: uid,
    title: input.title.trim().slice(0, 160),
    type: input.type,
    logline: input.logline?.trim() ?? '',
    idea: input.idea?.trim() ?? '',
    genre: input.genre?.trim() ?? '',
    status: 'active',
    format: { aspectRatio: input.aspectRatio ?? '16:9', fps: 24 },
    coverAssetId: null,
    styleBible: {},
  };
  const ref = await addDoc(collection(db, 'projects'), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  return ref.id;
}

export async function updateProject(id: string, patch: Partial<Omit<ProjectDoc, 'id' | 'ownerUid' | 'usage' | 'type'>>) {
  await updateDoc(projectRef(id), { ...patch, updatedAt: serverTimestamp() });
}

export const touchProject = (id: string) => updateDoc(projectRef(id), { updatedAt: serverTimestamp() });

// ---------------------------------------------------------------------------
// Creative documents
// ---------------------------------------------------------------------------

export async function addShots(projectId: string, shots: Omit<ShotDoc, 'id'>[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < shots.length; i += 400) {
    const batch = writeBatch(db);
    for (const s of shots.slice(i, i + 400)) {
      const ref = doc(subCol(projectId, 'shots'));
      ids.push(ref.id);
      batch.set(ref, { ...s, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    }
    await batch.commit();
  }
  await touchProject(projectId);
  return ids;
}

export async function updateShot(projectId: string, id: string, patch: Partial<Omit<ShotDoc, 'id'>>) {
  await updateDoc(subDoc(projectId, 'shots', id), { ...patch, updatedAt: serverTimestamp() });
}

export async function addDocs<T extends object>(projectId: string, sub: SubCollection, items: T[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < items.length; i += 400) {
    const batch = writeBatch(db);
    for (const it of items.slice(i, i + 400)) {
      const ref = doc(subCol(projectId, sub));
      ids.push(ref.id);
      batch.set(ref, it);
    }
    await batch.commit();
  }
  await touchProject(projectId);
  return ids;
}

export async function updateSubDoc(projectId: string, sub: SubCollection, id: string, patch: Record<string, unknown>) {
  await updateDoc(subDoc(projectId, sub, id), patch);
}

export async function deleteSubDoc(projectId: string, sub: SubCollection, id: string) {
  await deleteDoc(subDoc(projectId, sub, id));
}

// Scripts ----------------------------------------------------------------------------------------

export async function createScript(projectId: string, title: string, content = ''): Promise<string> {
  const ref = await addDoc(subCol(projectId, 'scripts'), { title, content, version: 1, pageCount: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp() } satisfies Omit<ScriptDoc, 'id' | 'createdAt' | 'updatedAt'> & Record<string, unknown>);
  return ref.id;
}

export async function saveScript(projectId: string, scriptId: string, content: string, pageCount: number) {
  await updateDoc(subDoc(projectId, 'scripts', scriptId), { content, pageCount, updatedAt: serverTimestamp() });
}

/** Snapshots the current screenplay into its version history. */
export async function snapshotScript(projectId: string, scriptId: string, version: number, content: string, note: string) {
  await addDoc(collection(db, 'projects', projectId, 'scripts', scriptId, 'versions'), { version, content, note: note.slice(0, 200), createdAt: serverTimestamp() });
  await updateDoc(subDoc(projectId, 'scripts', scriptId), { version: version + 1, updatedAt: serverTimestamp() });
}

// Songs ------------------------------------------------------------------------------------------

export async function createSong(projectId: string, audioAssetId: string, title: string, durationSec: number): Promise<string> {
  const ref = await addDoc(subCol(projectId, 'songs'), {
    audioAssetId,
    title,
    artist: '',
    durationSec,
    analysis: null,
    lyrics: null,
    ai: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  } satisfies Omit<SongDoc, 'id' | 'createdAt' | 'updatedAt'> & Record<string, unknown>);
  await touchProject(projectId);
  return ref.id;
}

// Timelines --------------------------------------------------------------------------------------

export async function createTimeline(uid: string, projectId: string, name: string, state?: TimelineState, aspect: FrameAspect = '16:9'): Promise<string> {
  const s = state ?? emptyTimeline(aspect);
  const data: Omit<TimelineDoc, 'id'> = {
    ownerUid: uid,
    projectId,
    name,
    fps: s.fps,
    aspectRatio: s.aspectRatio,
    tracks: s.tracks,
    clips: s.clips,
    markers: s.markers,
    beatGrid: s.beatGrid,
    version: 1,
    durationSec: timelineDuration(s.clips),
  };
  const ref = await addDoc(subCol(projectId, 'timelines'), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  await touchProject(projectId);
  return ref.id;
}

export async function saveTimeline(projectId: string, timelineId: string, state: TimelineState, version: number) {
  await setDoc(
    subDoc(projectId, 'timelines', timelineId),
    { tracks: state.tracks, clips: state.clips, markers: state.markers, beatGrid: state.beatGrid, fps: state.fps, aspectRatio: state.aspectRatio, version, durationSec: timelineDuration(state.clips), updatedAt: serverTimestamp() },
    { merge: true },
  );
}

export async function snapshotTimeline(projectId: string, timelineId: string, state: TimelineState, version: number, note: string) {
  await addDoc(collection(db, 'projects', projectId, 'timelines', timelineId, 'versions'), { version, note: note.slice(0, 200), tracks: state.tracks, clips: state.clips, markers: state.markers, createdAt: serverTimestamp() });
}

// Notes ------------------------------------------------------------------------------------------

export async function addNote(projectId: string, note: Partial<NoteDoc>) {
  await addDoc(subCol(projectId, 'notes'), { title: '', body: '', tags: [], pinned: false, context: { kind: 'general', id: null }, ...note, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
}
