import { defaultCamera, type BlockingEntity, type BlockingPlanDoc, type StagePoint } from './continuity';
import { coverageCamera } from './spatial';
import type { CostEstimate } from './types';
import { estimateVideo, sumEstimates, type PricingTable } from './cost';

/**
 * Coverage Generator: editorial coverage for a dialogue or action scene (establishing, master,
 * two-shot, singles, over-the-shoulders, reactions, inserts…) suggested by the reasoning model from
 * the screenplay, costed before anything is generated, and turned into shots with blocking on the
 * established side of the 180-degree line when the director accepts them.
 */

export const COVERAGE_TYPES = ['establishing', 'master', 'two_shot', 'medium', 'clean_single', 'close_up', 'over_the_shoulder', 'reaction', 'insert', 'cutaway', 'detail', 'transition', 'environment'] as const;
export type CoverageType = (typeof COVERAGE_TYPES)[number];

export const COVERAGE_LABELS: Record<CoverageType, string> = {
  establishing: 'Establishing shot',
  master: 'Master shot',
  two_shot: 'Two-shot',
  medium: 'Medium shot',
  clean_single: 'Clean single',
  close_up: 'Close-up',
  over_the_shoulder: 'Over-the-shoulder',
  reaction: 'Reaction shot',
  insert: 'Insert',
  cutaway: 'Cutaway',
  detail: 'Detail shot',
  transition: 'Transition shot',
  environment: 'Environment shot',
};

const FRAMING: Record<CoverageType, string> = {
  establishing: 'Extreme wide shot',
  master: 'Wide establishing shot',
  two_shot: 'Two-shot',
  medium: 'Medium shot',
  clean_single: 'Medium close-up',
  close_up: 'Close-up',
  over_the_shoulder: 'Over-the-shoulder shot',
  reaction: 'Close-up',
  insert: 'Insert shot',
  cutaway: 'Medium wide shot',
  detail: 'Extreme close-up',
  transition: 'Wide establishing shot',
  environment: 'Extreme wide shot',
};

export interface CoverageSuggestion {
  id: string;
  type: CoverageType;
  /** Character ids the shot is about (first = subject). */
  subjectIds: string[];
  description: string;
  action: string;
  framing: string;
  lens: string;
  cameraMovement: string;
  durationSec: number;
  /** Indexes of the scene's dialogue lines this shot covers. */
  dialogueLines: number[];
  priority: 'essential' | 'recommended' | 'optional';
  rationale: string;
  accepted: boolean;
}

/** Estimated cost of each suggestion and of the accepted set (published rates; estimate). */
export function coverageCost(items: CoverageSuggestion[], pricing: PricingTable, resolution: string, referenceImages = 3): { per: Record<string, CostEstimate>; accepted: CostEstimate } {
  const per: Record<string, CostEstimate> = {};
  for (const it of items) per[it.id] = estimateVideo({ resolution, outputSeconds: Math.max(3, Math.min(10, Math.round(it.durationSec))), promptChars: 2500, imageInputs: referenceImages, videoInputSeconds: 0, task: 'generate' }, pricing);
  const accepted = sumEstimates(items.filter((i) => i.accepted).map((i) => per[i.id]!), pricing);
  return { per, accepted };
}

/** Normalises the model's coverage list (valid types, durations inside the video model's limits). */
export function normalizeCoverage(raw: unknown, characterIdsByName: Record<string, string>, caps: { min: number; max: number }): CoverageSuggestion[] {
  const list = Array.isArray((raw as { shots?: unknown })?.shots) ? ((raw as { shots: unknown[] }).shots as Record<string, unknown>[]) : [];
  return list.slice(0, 16).map((s, i) => {
    const type = (COVERAGE_TYPES as readonly string[]).includes(String(s.type)) ? (s.type as CoverageType) : 'medium';
    const names = Array.isArray(s.subjects) ? (s.subjects as unknown[]).map(String) : [];
    const ids = names.map((n) => characterIdsByName[n.trim().toUpperCase()] ?? characterIdsByName[n.trim()] ?? '').filter(Boolean);
    const priority = s.priority === 'essential' || s.priority === 'optional' ? s.priority : 'recommended';
    return {
      id: `cov${i + 1}`,
      type,
      subjectIds: ids,
      description: String(s.description ?? '').slice(0, 400),
      action: String(s.action ?? '').slice(0, 400),
      framing: String(s.framing ?? FRAMING[type]).slice(0, 80) || FRAMING[type],
      lens: String(s.lens ?? '').slice(0, 60),
      cameraMovement: String(s.cameraMovement ?? '').slice(0, 80),
      durationSec: Math.max(caps.min, Math.min(caps.max, Math.round(Number(s.durationSec) || 5))),
      dialogueLines: Array.isArray(s.dialogueLines) ? (s.dialogueLines as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 0) : [],
      priority: priority as CoverageSuggestion['priority'],
      rationale: String(s.rationale ?? '').slice(0, 300),
      accepted: priority !== 'optional',
    };
  });
}

/**
 * Blocking for an accepted coverage shot: the characters keep their master positions and the camera is
 * placed for the coverage type on the established side of the line.
 */
export function coverageBlocking(s: CoverageSuggestion, master: Pick<BlockingPlanDoc, 'entities' | 'sceneId' | 'locationId'> | null, side: 'left' | 'right' | null, shotId: string): Omit<BlockingPlanDoc, 'id' | 'updatedAt'> {
  const entities: BlockingEntity[] = master ? master.entities.map((e) => ({ ...e, path: [...e.path], speaking: e.kind === 'character' && e.refId !== null && s.subjectIds[0] === e.refId && s.dialogueLines.length > 0 })) : [];
  const pos = (id: string | undefined): StagePoint | null => (id ? entities.find((e) => e.refId === id)?.position ?? null : null);
  const a = pos(s.subjectIds[0]) ?? entities.find((e) => e.kind === 'character')?.position ?? { x: 0.45, y: 0.5 };
  const b = pos(s.subjectIds[1]) ?? entities.filter((e) => e.kind === 'character').map((e) => e.position).find((p) => p !== a) ?? null;
  const cam = coverageCamera(s.type, a, b, side);
  // Over-the-shoulder: the foreground shoulder is a deliberate partial occlusion.
  if (s.type === 'over_the_shoulder' && s.subjectIds[0]) {
    const fg = entities.find((e) => e.refId === s.subjectIds[0]);
    if (fg) fg.occlusionAllowed = true;
  }
  return { shotId, sceneId: master?.sceneId ?? null, locationId: master?.locationId ?? null, camera: { ...defaultCamera(), position: cam.position, directionDeg: cam.directionDeg, lensMm: cam.lensMm }, entities, protectedZones: [], notes: `${COVERAGE_LABELS[s.type]} — generated by the Coverage Generator.` };
}
