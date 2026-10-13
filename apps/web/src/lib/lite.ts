import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, getDoc, getDocs, onSnapshot, orderBy, query, serverTimestamp, setDoc, where } from 'firebase/firestore';
import {
  AMBIENCE_KINDS,
  EXPORT_PRESETS,
  LITE_SCORE_ID,
  assembleLiteTimeline,
  computeLiteTiming,
  defaultLiteSpec,
  liteExportChecks,
  narrationHash,
  normalizeLiteSpec,
  pickTake,
  reconcileTiming,
  takesFromJobs,
  timelineDuration,
  type AmbienceKind,
  type AssetDoc,
  type CharacterDoc,
  type CostEstimate,
  type JobDoc,
  type LiteAspect,
  type LiteAssetInfo,
  type LiteDirectionId,
  type LiteNarrationTake,
  type LiteSpec,
  type LocationDoc,
  type ProjectDoc,
  type ScoreDoc,
  type ScriptDoc,
  type TimelineState,
} from '@az-studio/shared';
import { api } from './api';
import { db } from './firebase';
import { useDoc, useQuery, type WithId } from './data';
import { useUid } from './session';
import { createProject, createTimeline, saveTimeline, updateProject } from './studio';

export type Job = WithId<JobDoc>;

export const ASPECT_PRESET: Record<LiteAspect, 'youtube_16x9' | 'vertical_9x16' | 'square_1x1'> = { '16:9': 'youtube_16x9', '9:16': 'vertical_9x16', '1:1': 'square_1x1' };

export async function createLiteProject(uid: string, input: { title: string; logline?: string; direction: LiteDirectionId; targetSec: number; aspect: LiteAspect; idea?: string }): Promise<string> {
  const id = await createProject(uid, { title: input.title, type: 'film_lite', logline: input.logline ?? '', aspectRatio: input.aspect, fps: 24, idea: input.idea ?? '' });
  await updateProject(id, { lite: { ...defaultLiteSpec({ direction: input.direction, targetSec: input.targetSec, aspect: input.aspect, idea: input.idea }), updatedAt: Date.now() } });
  return id;
}

/** A copy of the film's plan and choices. Media is shared (nothing is regenerated); renders and timelines start fresh. */
export async function duplicateLiteProject(uid: string, project: WithId<ProjectDoc>): Promise<string> {
  const spec = normalizeLiteSpec(project.lite);
  const id = await createProject(uid, { title: `${project.title} (copy)`.slice(0, 160), type: 'film_lite', logline: project.logline ?? '', aspectRatio: spec.setup.aspect, fps: spec.setup.fps });
  // Narration takes belong to the original's jobs: the copy keeps the chosen audio by pointing at the same takes.
  await updateProject(id, { lite: { ...spec, timelines: {}, renders: [], timing: { baseline: null, totalSec: null, acknowledgedAt: null }, importedFrom: { projectId: project.id, title: project.title, at: Date.now() }, updatedAt: Date.now() }, coverAssetId: project.coverAssetId ?? null });
  const score = await getDoc(doc(db, 'projects', project.id, 'scores', LITE_SCORE_ID));
  if (score.exists()) await setDoc(doc(db, 'projects', id, 'scores', LITE_SCORE_ID), { ...score.data(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  return id;
}

export type DraftStatus = 'saved' | 'saving' | 'unsaved' | 'error';

/**
 * The film's draft with undo/redo: edited locally, saved shortly after every change (and when leaving),
 * adopted from the server when another tab changes it while nothing is pending here.
 */
export function useLiteDraft(project: WithId<ProjectDoc>, delayMs = 700) {
  const remote = useMemo(() => normalizeLiteSpec(project.lite), [project.lite]);
  const [spec, setLocal] = useState<LiteSpec>(remote);
  const [status, setStatus] = useState<DraftStatus>('saved');
  const pending = useRef<LiteSpec | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef<string>(JSON.stringify(remote));
  const history = useRef<{ past: LiteSpec[]; future: LiteSpec[]; lastPush: number; lastLabel: string }>({ past: [], future: [], lastPush: 0, lastLabel: '' });
  const [, force] = useState(0);

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
      lastSaved.current = JSON.stringify(normalizeLiteSpec(stamped));
      await updateProject(project.id, { lite: stamped });
      setStatus(pending.current ? 'unsaved' : 'saved');
    } catch {
      pending.current = pending.current ?? next;
      setStatus('error');
    }
  }, [project.id]);

  const schedule = useCallback(
    (next: LiteSpec) => {
      pending.current = next;
      setStatus('unsaved');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delayMs);
    },
    [delayMs, flush],
  );

  /** Applies an edit. `label` groups rapid edits of the same kind (typing) into one undo step. */
  const update = useCallback(
    (patch: Partial<LiteSpec> | ((s: LiteSpec) => LiteSpec), label = 'edit') => {
      setLocal((cur) => {
        const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
        if (next === cur) return cur;
        const h = history.current;
        const now = Date.now();
        if (label !== h.lastLabel || now - h.lastPush > 1200) {
          h.past = [...h.past.slice(-99), cur];
          h.lastPush = now;
          h.lastLabel = label;
        }
        h.future = [];
        schedule(next);
        return next;
      });
      force((n) => n + 1);
    },
    [schedule],
  );

  const undo = useCallback(() => {
    const h = history.current;
    const prev = h.past[h.past.length - 1];
    if (!prev) return;
    setLocal((cur) => {
      h.past = h.past.slice(0, -1);
      h.future = [cur, ...h.future];
      h.lastLabel = '';
      schedule(prev);
      return prev;
    });
    force((n) => n + 1);
  }, [schedule]);

  const redo = useCallback(() => {
    const h = history.current;
    const next = h.future[0];
    if (!next) return;
    setLocal((cur) => {
      h.future = h.future.slice(1);
      h.past = [...h.past, cur];
      h.lastLabel = '';
      schedule(next);
      return next;
    });
    force((n) => n + 1);
  }, [schedule]);

  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener('beforeunload', onHide);
    return () => {
      window.removeEventListener('beforeunload', onHide);
      void flush();
    };
  }, [flush]);

  return { spec, update, status, flush, undo, redo, canUndo: history.current.past.length > 0, canRedo: history.current.future.length > 0 };
}

/**
 * Every job of the film (the ledger of paid results: images, narration, score, ambience, renders). A copy
 * of another Lite film also sees the original's results, so duplicating never regenerates anything.
 */
export function useLiteJobs(projectId: string, sourceProjectId?: string | null) {
  const uid = useUid();
  const own = useQuery<JobDoc>(() => (uid ? query(collection(db, 'jobs'), where('ownerUid', '==', uid), where('projectId', '==', projectId)) : null), [uid, projectId]);
  const src = useQuery<JobDoc>(() => (uid && sourceProjectId ? query(collection(db, 'jobs'), where('ownerUid', '==', uid), where('projectId', '==', sourceProjectId)) : null), [uid, sourceProjectId]);
  const data = useMemo(() => [...own.data, ...src.data.filter((j) => j.type !== 'render.timeline' && j.type !== 'final.inspect')], [own.data, src.data]);
  return { ...own, data };
}

export const useLiteScore = (projectId: string) => useDoc<ScoreDoc>(`projects/${projectId}/scores/${LITE_SCORE_ID}`);

/** Live asset documents for a set of ids (dimensions, durations, readiness). */
export function useAssetMap(ids: string[]): Record<string, WithId<AssetDoc>> {
  const key = [...new Set(ids.filter(Boolean))].sort().join(',');
  const [map, setMap] = useState<Record<string, WithId<AssetDoc>>>({});
  useEffect(() => {
    if (!key) return;
    const unsubs = key.split(',').map((id) =>
      onSnapshot(
        doc(db, 'assets', id),
        (snap) => {
          const a = snap.data() as AssetDoc | undefined;
          setMap((m) => {
            if (!a) {
              if (!(id in m)) return m;
              const { [id]: _drop, ...rest } = m;
              void _drop;
              return rest;
            }
            return { ...m, [id]: { ...a, id } };
          });
        },
        () => undefined,
      ),
    );
    return () => unsubs.forEach((u) => u());
  }, [key]);
  return map;
}

export interface ShotCandidate {
  assetId: string;
  source: 'generated' | 'upload' | 'import';
  jobId: string | null;
  prompt: string | null;
  at: number;
}

const ms = (t: unknown) => (t && typeof (t as { toMillis?: () => number }).toMillis === 'function' ? (t as { toMillis: () => number }).toMillis() : 0);
const ACTIVE = new Set(['queued', 'validating', 'generating', 'downloading', 'rendering']);

/** What the jobs say about each target: results, work in progress and the latest failure. */
export function jobIndex(jobs: Job[]) {
  const byTarget = new Map<string, Job[]>();
  for (const j of jobs) {
    const k = `${j.target?.kind ?? ''}:${j.target?.id ?? ''}`;
    byTarget.set(k, [...(byTarget.get(k) ?? []), j]);
  }
  for (const list of byTarget.values()) list.sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  const forTarget = (kind: string, id: string) => byTarget.get(`${kind}:${id}`) ?? [];
  return {
    forTarget,
    active: (kind: string, id: string) => forTarget(kind, id).find((j) => ACTIVE.has(j.status)) ?? null,
    failed: (kind: string, id: string) => {
      const latest = forTarget(kind, id)[0];
      return latest && latest.status === 'failed' ? latest : null;
    },
    imageCandidates: (shotId: string): ShotCandidate[] =>
      forTarget('lite_shot', shotId)
        .filter((j) => j.type === 'image.generate' && j.status === 'completed' && j.result?.assetIds?.[0])
        .map((j) => ({ assetId: j.result!.assetIds![0]!, source: 'generated' as const, jobId: j.id, prompt: (j.params as { prompt?: string }).prompt ?? null, at: ms(j.completedAt) || ms(j.createdAt) })),
  };
}

/** Synthesised ambience beds already made (newest per kind). */
export function ambienceBeds(jobs: Job[]): Partial<Record<AmbienceKind, { assetId: string; durationSec: number }>> {
  const out: Partial<Record<AmbienceKind, { assetId: string; durationSec: number; at: number }>> = {};
  for (const j of jobs) {
    if (j.type !== 'audio.ambience' || j.status !== 'completed' || !j.result?.assetIds?.[0]) continue;
    const kind = (j.params as { kind?: AmbienceKind }).kind;
    if (!kind || !(AMBIENCE_KINDS as readonly string[]).includes(kind)) continue;
    const at = ms(j.completedAt);
    if (!out[kind] || out[kind]!.at < at) out[kind] = { assetId: j.result.assetIds[0], durationSec: Number((j.params as { durationSec?: number }).durationSec ?? 90), at };
  }
  return out;
}

export interface SceneVoice {
  take: LiteNarrationTake | null;
  stale: boolean;
  takes: LiteNarrationTake[];
}

/** The narration each scene uses now, whether it is out of date, and the takes to choose from. */
export function sceneVoices(spec: LiteSpec, jobs: Job[]): Record<string, SceneVoice> {
  const all = takesFromJobs(jobs);
  return Object.fromEntries(
    spec.scenes.map((s) => {
      const mine = all.filter((t) => t.sceneId === s.id);
      const { take, stale } = pickTake(s, narrationHash(s, spec.voice, spec.pronunciation), mine);
      return [s.id, { take, stale, takes: mine.sort((a, b) => b.createdAt - a.createdAt) }];
    }),
  );
}

/** Every asset the composition refers to. */
export function compositionAssetIds(spec: LiteSpec, voices: Record<string, SceneVoice>, score: ScoreDoc | null, beds: ReturnType<typeof ambienceBeds>): string[] {
  const ids: string[] = [];
  for (const s of spec.scenes) {
    for (const sh of s.shots) {
      if (sh.image.approvedAssetId) ids.push(sh.image.approvedAssetId);
      if (sh.parallax) ids.push(sh.parallax.backgroundAssetId, sh.parallax.foregroundAssetId);
    }
    const t = voices[s.id]?.take;
    if (t) ids.push(t.assetId);
    if (s.ambience.kind === 'upload' && s.ambience.assetId) ids.push(s.ambience.assetId);
    if (s.soundCue?.assetId) ids.push(s.soundCue.assetId);
  }
  for (const m of score?.movements ?? []) if (m.assetId) ids.push(m.assetId);
  for (const t of spec.sound.music.tracks) ids.push(t.assetId);
  for (const b of Object.values(beds)) if (b) ids.push(b.assetId);
  return ids;
}

/** The whole derived composition of the film for one format: timing, timeline, subtitles and checks. */
export function useComposition(spec: LiteSpec, jobs: Job[], score: ScoreDoc | null, aspect: LiteAspect, captionBandLuma?: Record<string, number>) {
  const voices = useMemo(() => sceneVoices(spec, jobs), [spec, jobs]);
  const beds = useMemo(() => ambienceBeds(jobs), [jobs]);
  const assetIds = useMemo(() => compositionAssetIds(spec, voices, score, beds), [spec, voices, score, beds]);
  const assetDocs = useAssetMap(assetIds);
  return useMemo(() => {
    const takes = Object.fromEntries(Object.entries(voices).map(([k, v]) => [k, v.take]));
    const timing = computeLiteTiming(spec, takes);
    const assets: Record<string, LiteAssetInfo> = {};
    for (const [id, a] of Object.entries(assetDocs)) if (a.status === 'ready') assets[id] = { width: a.width ?? null, height: a.height ?? null, durationSec: a.durationSec ?? null };
    const outWidth = EXPORT_PRESETS[ASPECT_PRESET[aspect]].final.width;
    const assembly = assembleLiteTimeline({ spec, timing, takes, assets, aspect, outWidth, score: spec.sound.music.mode === 'score' ? score : null, ambience: beds });
    const stale = Object.entries(voices).filter(([, v]) => v.stale).map(([k]) => k);
    const findings = liteExportChecks({ spec, timing, assembly, staleNarration: stale, captionBandLuma });
    const reconciliation = reconcileTiming(spec, timing);
    return { voices, beds, timing, assembly, findings, reconciliation, assetDocs, takes };
  }, [spec, voices, beds, assetDocs, score, aspect, captionBandLuma]);
}

/**
 * Saves the composition for a format as the project's timeline document (created on first use). The same
 * document is what preview reads and what the renderer snapshots, so the export matches the approved edit.
 */
export async function saveComposition(uid: string, project: WithId<ProjectDoc>, spec: LiteSpec, aspect: LiteAspect, state: TimelineState): Promise<{ timelineId: string; created: boolean }> {
  const existing = spec.timelines[aspect];
  if (existing) {
    const snap = await getDoc(doc(db, 'projects', project.id, 'timelines', existing));
    if (snap.exists()) {
      const cur = snap.data() as { version?: number; tracks?: unknown; clips?: unknown };
      if (JSON.stringify({ t: cur.tracks, c: cur.clips }) !== JSON.stringify({ t: state.tracks, c: state.clips })) await saveTimeline(project.id, existing, state, (cur.version ?? 1) + 1);
      return { timelineId: existing, created: false };
    }
  }
  const id = await createTimeline(uid, project.id, `${project.title} — ${aspect}`, state, aspect, spec.setup.fps);
  return { timelineId: id, created: true };
}

export interface LiteGenerateResponse {
  jobIds: string[];
  skipped: { key: string; reason: string }[];
  estimate: CostEstimate | null;
  perTarget: { key: string; title: string; estimate?: CostEstimate; jobId?: string }[];
  message?: string;
  confirmation?: { required: boolean; reasons: string[] };
  limitProblem?: string | null;
  movements?: { id: string; index: number; start: number; end: number; ready: boolean }[] | null;
}

export type LiteWorkKind = 'images' | 'narration' | 'music' | 'ambience';

export const liteGenerate = (projectId: string, kind: LiteWorkKind, opts: { targetIds?: string[]; force?: boolean; estimateOnly?: boolean; confirmedUsd?: number | null } = {}) =>
  // Unset options are left out (the callable would send `undefined` as null, which the API rightly rejects).
  api<LiteGenerateResponse, 'liteGenerate'>('liteGenerate', { projectId, kind, ...(opts.targetIds ? { targetIds: opts.targetIds } : {}), force: opts.force ?? false, estimateOnly: opts.estimateOnly ?? false, confirmedUsd: opts.confirmedUsd ?? null });

/** Resolves with a job's result assets once it finishes (rejects when it fails or is cancelled). */
export function waitForJobAssets(jobId: string, timeoutMs = 10 * 60_000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error('Still working — the result will appear in your library when it is ready.'));
    }, timeoutMs);
    const unsub = onSnapshot(doc(db, 'jobs', jobId), (snap) => {
      const j = snap.data() as JobDoc | undefined;
      if (!j) return;
      if (j.status === 'completed') {
        clearTimeout(timer);
        unsub();
        resolve(j.result?.assetIds ?? []);
      } else if (j.status === 'failed' || j.status === 'cancelled') {
        clearTimeout(timer);
        unsub();
        reject(new Error(j.error?.message ?? `The job was ${j.status}.`));
      }
    });
  });
}

export const liteCancel =(projectId: string) => api<{ cancelled: number }, 'liteCancel'>('liteCancel', { projectId });

export function timelineLength(state: TimelineState): number {
  return timelineDuration(state.clips);
}

// ---------------------------------------------------------------------------
// Import from a Film Studio project (read-only: the source is never changed)
// ---------------------------------------------------------------------------

export interface FilmImport {
  title: string;
  script: string;
  idea: string;
  characters: { name: string; description: string; clothing: string; refAssetIds: string[] }[];
  locations: { name: string; description: string; refAssetIds: string[] }[];
  lookbookAssetIds: string[];
}

/** Reads a film's treatment, latest script, characters and locations (with their reference images). */
export async function readFilmForImport(projectId: string): Promise<FilmImport> {
  const p = (await getDoc(doc(db, 'projects', projectId))).data() as ProjectDoc | undefined;
  if (!p) throw new Error('That project is no longer available.');
  const scripts = await getDocs(query(collection(db, 'projects', projectId, 'scripts'), orderBy('updatedAt', 'desc')));
  const script = (scripts.docs[0]?.data() as ScriptDoc | undefined)?.content ?? '';
  const chars = (await getDocs(collection(db, 'projects', projectId, 'characters'))).docs.map((d) => d.data() as CharacterDoc);
  const locs = (await getDocs(collection(db, 'projects', projectId, 'locations'))).docs.map((d) => d.data() as LocationDoc);
  const refs = (primary: string | null | undefined, list: string[] | undefined, approved?: string[]) => [...new Set([...(approved ?? []), ...(primary ? [primary] : []), ...(list ?? [])])].slice(0, 3);
  return {
    title: p.title,
    script,
    idea: [p.logline, p.treatment?.synopsis, p.treatment?.body].filter(Boolean).join('\n\n'),
    characters: chars.map((c) => ({ name: c.name, description: [c.description, c.appearance].filter(Boolean).join(' '), clothing: c.wardrobe ?? '', refAssetIds: refs(c.primaryRefAssetId, c.referenceAssetIds, c.bible?.approvedRefIds) })),
    locations: locs.map((l) => ({ name: l.name, description: [l.description, l.atmosphere, l.timeOfDay].filter(Boolean).join(' '), refAssetIds: refs(l.primaryRefAssetId, l.referenceAssetIds) })),
    lookbookAssetIds: [],
  };
}

/** Plain readable script from Fountain markup (scene headings and cues removed; dialogue and action kept). */
export function fountainToNarration(fountain: string): string {
  return fountain
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split('\n')
        .filter((l) => !/^(INT|EXT|INT\/EXT|I\/E)[ .]/i.test(l.trim()) && !/^[A-Z0-9 .'-]{2,}(\s*\(.*\))?$/.test(l.trim()) && !/^\(.*\)$/.test(l.trim()) && !/^[A-Z ]+TO:$/.test(l.trim()))
        .join(' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n\n');
}
