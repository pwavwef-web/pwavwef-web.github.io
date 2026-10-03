import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { doc, getDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import {
  adCaptionStyle,
  assembleAdTimeline,
  retimeEditedLine,
  defaultAdScene,
  defaultAdSpec,
  editLineText,
  isGeneratedScene,
  labelNarrationSections,
  normalizeAdSpec,
  sceneGenerationSeconds,
  type AdAspect,
  type AdAssemblyScene,
  type AdMode,
  type AdSceneSpec,
  type AdSceneWindow,
  type AdSpec,
  type AssetDoc,
  type LyricsSheet,
  type ProjectDoc,
  type ShotDoc,
  type SongDoc,
  type TakeDoc,
} from '@az-studio/shared';
import { api } from './api';
import { db } from './firebase';
import { useDoc, type WithId } from './data';
import { createProject, createSong, createTimeline, newShot, saveTimeline, snapshotTimeline, subCol, updateProject, updateSubDoc, useSub } from './studio';

/** A scene of an advert: a shot carrying an `ad` spec. */
export type AdScene = WithId<ShotDoc> & { ad: AdSceneSpec };

export async function createAdProject(uid: string, input: { title: string; mode: AdMode; aspect: AdAspect; logline?: string }): Promise<string> {
  const id = await createProject(uid, { title: input.title, type: 'short_ad', logline: input.logline ?? '', aspectRatio: input.aspect, fps: 24, videoResolution: '1080p' });
  await updateProject(id, { ad: { ...defaultAdSpec(input.mode, input.aspect), updatedAt: Date.now() } });
  return id;
}

export type DraftStatus = 'saved' | 'saving' | 'unsaved' | 'error';

/**
 * The advert's draft: edited locally, saved to the project shortly after every change (and on leaving the
 * page), and adopted from the server when another tab changes it while nothing is pending here.
 */
export function useAdDraft(project: WithId<ProjectDoc>, delayMs = 700) {
  const remote = useMemo(() => normalizeAdSpec(project.ad), [project.ad]);
  const [ad, setLocal] = useState<AdSpec>(remote);
  const [status, setStatus] = useState<DraftStatus>('saved');
  const pending = useRef<AdSpec | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef<string>(JSON.stringify(remote));

  useEffect(() => {
    const key = JSON.stringify(remote);
    if (!pending.current && key !== lastSaved.current) {
      lastSaved.current = key;
      setLocal(remote);
    }
  }, [remote]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    setStatus('saving');
    try {
      const stamped = { ...next, updatedAt: Date.now() };
      lastSaved.current = JSON.stringify(normalizeAdSpec(stamped));
      await updateProject(project.id, { ad: stamped });
      setStatus(pending.current ? 'unsaved' : 'saved');
    } catch {
      pending.current = pending.current ?? next;
      setStatus('error');
    }
  }, [project.id]);

  const update = useCallback(
    (patch: Partial<AdSpec> | ((a: AdSpec) => AdSpec)) => {
      setLocal((cur) => {
        const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
        pending.current = next;
        return next;
      });
      setStatus('unsaved');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delayMs);
    },
    [delayMs, flush],
  );

  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener('beforeunload', onHide);
    return () => {
      window.removeEventListener('beforeunload', onHide);
      void flush();
    };
  }, [flush]);

  return { ad, update, status, flush };
}

export function useAdScenes(projectId: string | undefined) {
  const shots = useSub<ShotDoc>(projectId, 'shots', 'order');
  const scenes = useMemo(() => shots.data.filter((s): s is AdScene => Boolean(s.ad)).sort((a, b) => (a.timing?.start ?? a.order) - (b.timing?.start ?? b.order)), [shots.data]);
  return { ...shots, data: scenes };
}

export const useNarration = (projectId: string, songId: string | null) => useDoc<SongDoc>(songId ? `projects/${projectId}/songs/${songId}` : null);

/** Attaches an uploaded or chosen audio file as the advert's soundtrack (its measured length becomes the advert's). */
export async function attachAudio(projectId: string, asset: WithId<AssetDoc>, ad: AdSpec): Promise<Partial<AdSpec>> {
  const songId = await createSong(projectId, asset.id, asset.title, asset.durationSec ?? 0);
  return { audio: { ...ad.audio, assetId: asset.id, songId, durationSec: asset.durationSec ?? null, fileName: asset.fileName, transcriptApprovedAt: null } };
}

/** Saves an edited caption line, re-timed against the words heard around it (no model call; other lines keep their timing). */
export async function saveTranscriptEdit(projectId: string, song: WithId<SongDoc>, sheet: LyricsSheet, lineId: string, text: string): Promise<LyricsSheet> {
  const next = song.asr?.words?.length ? retimeEditedLine(sheet, lineId, text, song.asr.words, song.durationSec) : { ...editLineText(sheet, lineId, text), source: 'manual' as const, status: 'draft' as const, approvedAt: null };
  await updateSubDoc(projectId, 'songs', song.id, { lyricsSheet: next, updatedAt: serverTimestamp() });
  return next;
}

export async function approveTranscript(projectId: string, songId: string, sheet: LyricsSheet): Promise<void> {
  await updateSubDoc(projectId, 'songs', songId, { lyricsSheet: { ...sheet, status: 'approved', approvedAt: Date.now() }, updatedAt: serverTimestamp() });
}

/** Replaces the storyboard with one scene per narration window (generated video by default, end card last). */
export async function writeStoryboard(projectId: string, ad: AdSpec, windows: AdSceneWindow[], existing: AdScene[]): Promise<void> {
  const batch = writeBatch(db);
  for (const s of existing) batch.delete(doc(subCol(projectId, 'shots'), s.id));
  windows.forEach((w, i) => {
    const last = i === windows.length - 1;
    const len = w.end - w.start;
    const ref = doc(subCol(projectId, 'shots'));
    batch.set(ref, {
      ...newShot({
        order: w.start,
        number: String(i + 1).padStart(2, '0'),
        title: last ? 'End card' : `Scene ${i + 1}`,
        description: '',
        durationSec: sceneGenerationSeconds(len),
        aspectRatio: ad.aspect === '16:9' ? '16:9' : '9:16',
        resolution: ad.generation.resolution,
        timing: { start: w.start, end: w.end },
        lockRefs: false,
      }),
      ad: defaultAdScene({ kind: last ? 'end_card' : 'generated_video', narration: w.narration, lineIds: w.lineIds, onScreenText: last ? `Discover ${ad.brief.brand || 'us'}` : '', subText: last ? ad.brief.destinationUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : '' }),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
  await batch.commit();
}

export async function updateScene(projectId: string, scene: AdScene, patch: Partial<Omit<ShotDoc, 'ad'>> & { ad?: Partial<AdSceneSpec> }): Promise<void> {
  const { ad, ...rest } = patch;
  const data: Record<string, unknown> = { ...rest, updatedAt: serverTimestamp() };
  if (ad) for (const [k, v] of Object.entries(ad)) data[`ad.${k}`] = v;
  await updateSubDoc(projectId, 'shots', scene.id, data);
}

/** The picture each scene uses: the selected take of a generated scene, the first supplied asset otherwise. */
export async function sceneMedia(projectId: string, scene: AdScene): Promise<AdAssemblyScene['media']> {
  let assetId: string | null = null;
  if (isGeneratedScene(scene.ad.kind)) {
    if (!scene.selectedTakeId) return null;
    const take = (await getDoc(doc(db, 'projects', projectId, 'shots', scene.id, 'takes', scene.selectedTakeId))).data() as TakeDoc | undefined;
    assetId = take?.assetId ?? null;
  } else if (scene.ad.kind !== 'typography' && scene.ad.kind !== 'end_card') assetId = scene.ad.assetIds[0] ?? null;
  if (!assetId) return null;
  const a = (await getDoc(doc(db, 'assets', assetId))).data() as AssetDoc | undefined;
  if (!a || a.status !== 'ready' || (a.kind !== 'video' && a.kind !== 'image')) return null;
  return { assetId, kind: a.kind, durationSec: a.durationSec ?? null, width: a.width ?? null, height: a.height ?? null };
}

/** Caption style for the narration (created once; follows the brand font and colours). */
export async function ensureCaptionStyle(projectId: string, ad: AdSpec): Promise<string> {
  const style = adCaptionStyle(ad.brand);
  const res = await api<{ id: string }, 'continuitySave'>('continuitySave', { projectId, collection: 'lyricStyles', id: ad.captions.styleId ?? null, data: style as unknown as Record<string, unknown> });
  if (ad.audio.songId) await api('continuitySave', { projectId, collection: 'lyricsTracks', id: ad.audio.songId, data: { songId: ad.audio.songId, styleId: res.id, placements: {} } });
  return res.id;
}

/**
 * Builds (or rebuilds) the advert's timeline from the storyboard: real narration timing, scene pictures,
 * typography, end card, captions and the approved soundtrack. Returns the timeline id and any problems.
 */
export async function buildAdTimeline(uid: string, project: WithId<ProjectDoc>, ad: AdSpec, scenes: AdScene[], song: WithId<SongDoc> | null): Promise<{ timelineId: string; issues: { severity: string; message: string }[]; styleId: string | null }> {
  if (!ad.audio.assetId || !ad.audio.songId || !ad.audio.durationSec) throw new Error('Attach and measure the soundtrack first.');
  const media = await Promise.all(scenes.map((s) => sceneMedia(project.id, s)));
  const assembly: AdAssemblyScene[] = scenes.map((s, i) => ({ id: s.id, kind: s.ad.kind, title: s.title, start: s.timing?.start ?? 0, end: s.timing?.end ?? 0, media: media[i] ?? null, inPoint: s.ad.inPoint ?? 0, motion: s.ad.motion, onScreenText: s.ad.onScreenText, subText: s.ad.subText, captions: s.ad.captions }));
  let sheet = song?.lyricsSheet ?? null;
  if (sheet && song) {
    // Sentences inside typography scenes and the end card take the restrained typography style.
    const labelled = labelNarrationSections(sheet, assembly);
    if (JSON.stringify(labelled.sections) !== JSON.stringify(sheet.sections)) {
      await updateSubDoc(project.id, 'songs', song.id, { lyricsSheet: labelled });
      sheet = labelled;
    }
  }
  const firstLine = sheet?.lines.find((l) => l.start !== null);
  const tagline = ad.brief.tagline.trim() ? { text: ad.brief.tagline.trim(), start: 0.5, end: Math.max(3.5, Math.min(6, (firstLine?.start ?? 0) + 4.5)) } : null;
  const { state, issues } = assembleAdTimeline({ aspect: ad.aspect, fps: project.format.fps, durationSec: ad.audio.durationSec, audio: { assetId: ad.audio.assetId, songId: ad.audio.songId, label: ad.audio.fileName || 'Approved soundtrack' }, sheet, captions: ad.captions.enabled, brand: ad.brand, tagline, scenes: assembly });
  let styleId: string | null = ad.captions.styleId;
  if (ad.captions.enabled) styleId = await ensureCaptionStyle(project.id, ad);
  let timelineId = ad.timelineId;
  if (timelineId) {
    const cur = (await getDoc(doc(db, 'projects', project.id, 'timelines', timelineId))).data() as { version?: number; tracks?: unknown } | undefined;
    if (cur) {
      const version = (cur.version ?? 1) + 1;
      await snapshotTimeline(project.id, timelineId, state, version - 1, 'Before rebuilding from the storyboard').catch(() => undefined);
      await saveTimeline(project.id, timelineId, state, version);
    } else timelineId = null;
  }
  if (!timelineId) timelineId = await createTimeline(uid, project.id, `${project.title} — advert`, state, ad.aspect, project.format.fps);
  return { timelineId, issues: issues.map((i) => ({ severity: i.severity, message: i.message })), styleId };
}
