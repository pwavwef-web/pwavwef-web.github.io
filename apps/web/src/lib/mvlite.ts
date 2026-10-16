import { useMemo } from 'react';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import {
  EXPORT_PRESETS,
  LYRIC_PRESET_LABELS,
  LYRIC_PRESET_STYLES,
  assembleMvTimeline,
  computeMvTiming,
  defaultMvLiteSpec,
  mvExportChecks,
  normalizeMvLiteSpec,
  shotLyrics,
  type LiteAspect,
  type LiteAssetInfo,
  type LyricPreset,
  type MvDirectionId,
  type MvLiteSpec,
  type MvSong,
  type ProjectDoc,
  type SongDoc,
  type TimelineState,
} from '@az-studio/shared';
import { api } from './api';
import { saveContinuity } from './continuity';
import { db } from './firebase';
import { useDoc, type WithId } from './data';
import { ASPECT_PRESET, useAssetMap, useProjectDraft } from './lite';
import { createProject, createTimeline, saveTimeline, updateProject } from './studio';

export { ASPECT_PRESET, jobIndex, useLiteJobs as useMvJobs, waitForJobAssets, type Job, type LiteGenerateResponse, type ShotCandidate } from './lite';

export async function createMvLiteProject(uid: string, input: { title: string; logline?: string; direction: MvDirectionId; aspect: LiteAspect; idea?: string }): Promise<string> {
  const id = await createProject(uid, { title: input.title, type: 'mv_lite', logline: input.logline ?? '', aspectRatio: input.aspect, fps: 24, idea: input.idea ?? '' });
  await updateProject(id, { mvlite: { ...defaultMvLiteSpec({ direction: input.direction, aspect: input.aspect, idea: input.idea }), updatedAt: Date.now() } });
  return id;
}

/**
 * A copy of the video's plan and choices. The song document is copied (same audio, same lyric sheet and
 * timing) and images are shared — nothing is regenerated; renders and timelines start fresh.
 */
export async function duplicateMvLiteProject(uid: string, project: WithId<ProjectDoc>): Promise<string> {
  const spec = normalizeMvLiteSpec(project.mvlite);
  const id = await createProject(uid, { title: `${project.title} (copy)`.slice(0, 160), type: 'mv_lite', logline: project.logline ?? '', aspectRatio: spec.setup.aspect, fps: spec.setup.fps });
  let songId = spec.song.songId;
  if (songId) {
    const song = await getDoc(doc(db, 'projects', project.id, 'songs', songId));
    if (song.exists()) await setDoc(doc(db, 'projects', id, 'songs', songId), { ...song.data(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    else songId = null;
  }
  await updateProject(id, { mvlite: { ...spec, song: { ...spec.song, songId }, timelines: {}, renders: [], importedFrom: { projectId: project.id, title: project.title, at: Date.now() }, updatedAt: Date.now() }, coverAssetId: project.coverAssetId ?? null });
  return id;
}

export function useMvDraft(project: WithId<ProjectDoc>, delayMs = 700) {
  return useProjectDraft<MvLiteSpec>(project.id, project.mvlite, 'mvlite', normalizeMvLiteSpec, delayMs);
}

/** The video's song document, live. */
export function useMvSongDoc(projectId: string, songId: string | null) {
  return useDoc<SongDoc>(songId ? `projects/${projectId}/songs/${songId}` : null);
}

export function mvSongFrom(song: WithId<SongDoc> | null | undefined): MvSong | null {
  if (!song?.audioAssetId) return null;
  return { id: song.id, title: song.title || 'Song', audioAssetId: song.audioAssetId, durationSec: Number(song.durationSec ?? 0), analysis: song.analysis ?? null, sheet: song.lyricsSheet ?? null, instrumental: Boolean(song.instrumental) };
}

/** Every asset the composition refers to. */
export function mvAssetIds(spec: MvLiteSpec, song: MvSong | null): string[] {
  const ids: string[] = [];
  for (const s of spec.sections) for (const sh of s.shots) if (sh.image.approvedAssetId) ids.push(sh.image.approvedAssetId);
  if (song) ids.push(song.audioAssetId);
  return ids;
}

/** The whole derived composition for one format: timing, timeline, lyrics per shot and checks. */
export function useMvComposition(spec: MvLiteSpec, song: MvSong | null, aspect: LiteAspect) {
  const assetIds = useMemo(() => mvAssetIds(spec, song), [spec, song]);
  const assetDocs = useAssetMap(assetIds);
  return useMemo(() => {
    const timing = computeMvTiming(spec, song);
    const assets: Record<string, LiteAssetInfo> = {};
    for (const [id, a] of Object.entries(assetDocs)) if (a.status === 'ready') assets[id] = { width: a.width ?? null, height: a.height ?? null, durationSec: a.durationSec ?? null };
    const outWidth = EXPORT_PRESETS[ASPECT_PRESET[aspect]].final.width;
    const assembly = assembleMvTimeline({ spec, timing, song, assets, aspect, outWidth });
    const findings = mvExportChecks({ spec, timing, assembly, song });
    const lyrics = shotLyrics(timing, song?.sheet);
    return { timing, assembly, findings, lyrics, assetDocs };
  }, [spec, song, assetDocs, aspect]);
}

/** Saves the composition for a format as the project's timeline document (what preview and the renderer read). */
export async function saveMvComposition(uid: string, project: WithId<ProjectDoc>, spec: MvLiteSpec, aspect: LiteAspect, state: TimelineState): Promise<{ timelineId: string; created: boolean }> {
  const existing = spec.timelines[aspect];
  if (existing) {
    const snap = await getDoc(doc(db, 'projects', project.id, 'timelines', existing));
    if (snap.exists()) {
      const cur = snap.data() as { version?: number; tracks?: unknown; clips?: unknown; beatGrid?: unknown };
      if (JSON.stringify({ t: cur.tracks, c: cur.clips, b: cur.beatGrid ?? null }) !== JSON.stringify({ t: state.tracks, c: state.clips, b: state.beatGrid })) await saveTimeline(project.id, existing, state, (cur.version ?? 1) + 1);
      return { timelineId: existing, created: false };
    }
  }
  const id = await createTimeline(uid, project.id, `${project.title} — ${aspect}`, state, aspect, spec.setup.fps);
  return { timelineId: id, created: true };
}

/** Gives the song's lyrics a style from the presets (the renderer lays the lyrics out with it). */
export async function applyLyricPreset(projectId: string, songId: string, preset: LyricPreset, existingStyleId: string | null): Promise<string> {
  const r = await saveContinuity(projectId, 'lyricStyles', { name: LYRIC_PRESET_LABELS[preset], global: { ...LYRIC_PRESET_STYLES[preset] }, sections: {}, fonts: [] }, existingStyleId);
  await saveContinuity(projectId, 'lyricsTracks', { songId, styleId: r.id, placements: {} });
  return r.id;
}

export const mvliteGenerate = (projectId: string, opts: { targetIds?: string[]; force?: boolean; estimateOnly?: boolean; confirmedUsd?: number | null } = {}) =>
  api<import('./lite').LiteGenerateResponse, 'mvliteGenerate'>('mvliteGenerate', { projectId, kind: 'images', ...(opts.targetIds ? { targetIds: opts.targetIds } : {}), force: opts.force ?? false, estimateOnly: opts.estimateOnly ?? false, confirmedUsd: opts.confirmedUsd ?? null });

export const mvliteCancel = (projectId: string) => api<{ cancelled: number }, 'mvliteCancel'>('mvliteCancel', { projectId });
