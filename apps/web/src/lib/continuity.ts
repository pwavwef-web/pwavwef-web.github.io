import { collection, orderBy, query, where, type QueryConstraint, type WhereFilterOp } from 'firebase/firestore';
import type {
  CharacterBible,
  ContinuityCollection,
  ContinuityConstraint,
  ContinuityPromptResult,
  ContinuitySnapshotDoc,
  ContinuityState,
  ContinuityWarning,
  CoverageSuggestion,
  CreditMetadata,
  MusicAnalysis,
  PlannedShot,
  SetView,
} from '@az-studio/shared';
import { api } from './api';
import { db } from './firebase';
import { useDoc, useQuery, type WithId } from './data';

/** Project sub-collections added by the Continuity Director, finishing tools and Music Studio. */
export type ProjectCollection =
  | ContinuityCollection
  | 'continuitySnapshots'
  | 'characterStates'
  | 'propStates'
  | 'qualityReviews'
  | 'repairAttempts'
  | 'finalInspections'
  | 'musicVersions'
  | 'stems'
  | 'subjectTracks'
  | 'scoreBibles'
  | 'cueSheets';

export interface CollectionOptions {
  order?: string;
  dir?: 'asc' | 'desc';
  where?: [string, WhereFilterOp, unknown][];
}

/** Live query of a project sub-collection (null project disables it). */
export function useProjectCollection<T>(projectId: string | null | undefined, name: ProjectCollection, opts: CollectionOptions = {}) {
  const key = JSON.stringify(opts);
  return useQuery<T>(() => {
    if (!projectId) return null;
    const cs: QueryConstraint[] = [];
    for (const [f, op, v] of opts.where ?? []) cs.push(where(f, op, v));
    if (opts.order) cs.push(orderBy(opts.order, opts.dir ?? 'asc'));
    return query(collection(db, 'projects', projectId, name), ...cs);
  }, [projectId, name, key]);
}

/** Live project sub-collection document. */
export function useProjectDoc<T>(projectId: string | null | undefined, name: ProjectCollection, id: string | null | undefined) {
  return useDoc<T>(projectId && id ? `projects/${projectId}/${name}/${id}` : null);
}

export type Snapshot = WithId<ContinuitySnapshotDoc>;

// ---------------------------------------------------------------------------
// Typed writes (validated server-side)
// ---------------------------------------------------------------------------

export const saveContinuity = (projectId: string, collectionName: ContinuityCollection, data: Record<string, unknown>, id?: string | null) =>
  api<{ id: string; needsApproval?: boolean }, 'continuitySave'>('continuitySave', { projectId, collection: collectionName, data, id: id ?? null });

export const deleteContinuity = (projectId: string, collectionName: ContinuityCollection, id: string) => api<{ deleted: boolean }, 'continuityDelete'>('continuityDelete', { projectId, collection: collectionName, id });

export const saveCharacterBible = (projectId: string, characterId: string, bible: Omit<CharacterBible, 'approvedAt'> & { approvedAt?: number | null }, approve: boolean) =>
  api<{ approvedAt: number | null }, 'characterBibleSave'>('characterBibleSave', { projectId, characterId, bible: bible as never, approve });

export const approveBible = (projectId: string, kind: 'visual' | 'character' | 'set', id: string, approve: boolean, views: SetView[] = []) =>
  api<{ approved: boolean; approvedAt?: number }, 'bibleApprove'>('bibleApprove', { projectId, kind, id, approve, views });

export interface ContinuityCheck {
  warnings: ContinuityWarning[];
  text: string;
  added: ContinuityPromptResult['added'];
  dropped: ContinuityPromptResult['dropped'];
  setView: SetView | null;
  protectedConstraints: ContinuityConstraint[];
  optionalPreferences: ContinuityConstraint[];
  planned: PlannedShot['planned'];
  before: ContinuityState | null;
  previousShotId: string | null;
  blocking: { screenOrder: string[]; cameraSide: 'left' | 'right' | null; entities: unknown[] } | null;
  names: { characters: Record<string, string>; props: Record<string, string> };
}

export const checkContinuity = (projectId: string, shotId: string, save = true) => api<ContinuityCheck, 'continuityCheck'>('continuityCheck', { projectId, shotId, save });

export const warningAction = (projectId: string, shotId: string, warningId: string, action: 'override' | 'reopen' | 'resolve', note = '') =>
  api<{ status: string }, 'continuityWarning'>('continuityWarning', { projectId, shotId, warningId, action, note });

export const insertNeutralShot = (projectId: string, afterShotId: string, kind: 'head_on' | 'tail_away' | 'cutaway') => api<{ shotId: string }, 'insertNeutralShot'>('insertNeutralShot', { projectId, afterShotId, kind });

export const applyCoverage = (projectId: string, sceneId: string | null, masterShotId: string | null, suggestions: (CoverageSuggestion & { accepted: boolean })[]) =>
  api<{ shotIds: string[] }, 'coverageApply'>('coverageApply', {
    projectId,
    sceneId,
    masterShotId,
    suggestions: suggestions.map((s) => ({ id: s.id, type: s.type, subjectIds: s.subjectIds, description: s.description, action: s.action, framing: s.framing, lens: s.lens, cameraMovement: s.cameraMovement, durationSec: s.durationSec, dialogueLines: s.dialogueLines, priority: s.priority, rationale: s.rationale, accepted: s.accepted })),
  });

export interface ContinuityOverview {
  snapshots: Snapshot[];
  propTimeline: Record<string, { shotId: string; order: number; approved: boolean; state: { present: boolean; holderId: string | null; hand: string | null; location: string; condition: string; status: string } }[]>;
  propRecords: number;
  characterRecords: number;
}

export const continuityOverview = (projectId: string) => api<ContinuityOverview, 'continuityOverview'>('continuityOverview', { projectId });
export const creditsMetadata = (projectId: string) => api<CreditMetadata, 'creditsMetadata'>('creditsMetadata', { projectId });
export const cancelQueued = (projectId?: string | null) => api<{ cancelled: number; productions: number; stillRunning: number }, 'cancelQueued'>('cancelQueued', { projectId: projectId ?? null });

/** Approving a take updates canonical continuity; withdrawing removes the shot's canonical records. */
export const takeAction = (projectId: string, shotId: string, takeId: string, action: 'approve' | 'withdraw', note?: string) =>
  api<{ status: string; continuity?: string }, 'takeAction'>('takeAction', { projectId, shotId, takeId, action, ...(note ? { note } : {}) });

export const finalInspectionAction = (projectId: string, inspectionId: string, action: 'apply_fix' | 'apply_all_fixes' | 'override' | 'clear_override' | 'resolve' | 'reopen', extra: { findingId?: string | null; note?: string } = {}) =>
  api<{ readiness: string; score: number; errors: number; warnings: number; timelineVersion: number | null; applied: string[]; needsRerender: boolean }, 'finalInspectionAction'>('finalInspectionAction', { projectId, inspectionId, action, findingId: extra.findingId ?? null, ...(extra.note ? { note: extra.note } : {}) });

export const musicSetMaster = (projectId: string, musicProjectId: string, versionId: string) => api<{ masterVersionId: string }, 'musicSetMaster'>('musicSetMaster', { projectId, musicProjectId, versionId });
export const musicToVideo = (projectId: string, musicProjectId: string, versionId: string, targetProjectId: string) =>
  api<{ songId: string; projectId: string; lyricsCopied: boolean; note: string }, 'musicToVideo'>('musicToVideo', { projectId, musicProjectId, versionId, targetProjectId });
export const musicCorrectAnalysis = (projectId: string, versionId: string, corrections: Partial<Pick<MusicAnalysis, 'bpm' | 'key' | 'timeSignature' | 'sections' | 'downbeats'>>) =>
  api<{ analysis: MusicAnalysis }, 'musicCorrectAnalysis'>('musicCorrectAnalysis', { projectId, versionId, corrections: corrections as never });
export const musicAddVersion = (projectId: string, musicProjectId: string, assetId: string, source: 'upload' | 'recording', label?: string) =>
  api<{ versionId: string; songId: string }, 'musicAddVersion'>('musicAddVersion', { projectId, musicProjectId, assetId, source, ...(label ? { label } : {}) });
