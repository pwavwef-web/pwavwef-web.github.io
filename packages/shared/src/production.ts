import type { DurationPlan, EditorialWindow } from './duration';
import type { DetectedWord, DialogueAnalysis, ExpectedLine, Measurements, ModelReview, ProductionStage, ProductionStatus, QualityProblem, QualityScores, QualitySettings, RepairDecision, RepairType } from './quality';
import type { Time } from './types';

/**
 * Durable production runs (`productions/{id}`) — one per scene/shot being produced — with their
 * versions (`versions/{id}`), quality reports (`reports/{id}`) and event log (`events/{id}`).
 * Written only by the backend; the director acts on them through the API.
 */

export interface ExpectedScene {
  lines: ExpectedLine[];
  action: string;
  description: string;
  characters: { id: string; name: string; description: string; referenceAssetId: string | null }[];
  location: { name: string; description: string; timeOfDay: string } | null;
  props: string[];
  camera: string;
  screenDirection: string;
  performance: string;
  mood: string;
  style: string;
  /** Scene or project music policy for this shot (films are scored centrally, so no background music). */
  music: 'no_background_music' | 'song_laid_later' | 'as_prompted';
  storyboardAssetId: string | null;
  firstFrameAssetId: string | null;
  previousShot: { shotId: string; title: string; assetId: string } | null;
  language: string | null;
  projectType: string;
}

export type DialogueAudioMode = 'generated' | 'uploaded' | 'identified' | 'estimated' | 'none';

export interface DialogueAudioLine {
  index: number;
  character: string;
  text: string;
  assetId: string | null;
  /** Measured spoken length (speech only) or null when estimated. */
  seconds: number | null;
  estimatedSec: number;
  voice: string | null;
}

export interface DialogueAudioState {
  mode: DialogueAudioMode;
  lines: DialogueAudioLine[];
  jobId: string | null;
  note: string;
}

export interface RepairRecord {
  versionId: string;
  type: RepairType;
  reason: string;
  categories: string[];
  jobIds: string[];
  estimateUsd: number;
  at: number;
  outcome: 'pending' | 'fixed' | 'not_fixed' | 'failed';
}

export interface PendingRepair extends RepairDecision {
  estimateUsd: number;
  /** Why it waits for the director. */
  waitingFor: 'expensive_retry' | 'cost_ceiling' | 'spending_limit' | 'director';
  forVersionId: string;
  categories: string[];
}

export interface ProductionFailure {
  summary: string;
  failed: string[];
  attempted: string[];
  strongestVersionId: string | null;
  nextAttemptUsd: number | null;
  options: string[];
}

export interface ProductionDoc {
  id: string;
  ownerUid: string;
  projectId: string;
  shotId: string;
  sceneId: string | null;
  title: string;
  status: ProductionStatus;
  stage: ProductionStage;
  stageMessage: string;
  settings: QualitySettings;
  expected: ExpectedScene;
  /** The compiled video request (prompt body, media, aspect, resolution) every generation starts from. */
  request: Record<string, unknown>;
  dialogueAudio: DialogueAudioState;
  plan: DurationPlan | null;
  /** Generation progress through the planned connected shots. */
  chain: { segmentIndex: number; takeIds: string[]; assetIds: string[] };
  waitingOn: string[];
  versionCount: number;
  currentVersionId: string | null;
  bestVersionId: string | null;
  approvedVersionId: string | null;
  repairCount: number;
  repairs: RepairRecord[];
  pendingRepair: PendingRepair | null;
  /** Recorded spend of this production's jobs (USD). */
  spentUsd: number;
  estimateUsd: number;
  failure: ProductionFailure | null;
  /** Problem categories the director accepted (not blocking) — recorded, never silent. */
  waivedCategories: string[];
  approval: { at: number; versionId: string; override: boolean; note: string } | null;
  /** Set when the production reviews an existing take instead of generating one. */
  reviewTakeId?: string | null;
  createdAt?: Time;
  updatedAt?: Time;
}

/** `existing`: a take made outside quality control, adopted for review and repair. */
export type VersionKind = 'generation' | 'extension' | 'repair' | 'existing';
export type VersionVerdict = 'pending' | 'passed' | 'failed' | 'error';

export interface ProductionVersionDoc {
  id: string;
  index: number;
  parentVersionId: string | null;
  kind: VersionKind;
  repair: RepairDecision | null;
  jobIds: string[];
  takeId: string | null;
  assetId: string | null;
  interactionId: string | null;
  /** When that Omni interaction was created (ms), if earlier than this version (an adopted take). */
  interactionAt?: number | null;
  /** Spans where the plan directed a cut to another angle (not accidental scene changes). */
  editorialCuts?: EditorialWindow[];
  durationSec: number | null;
  /** Length of the continuous Omni take this version belongs to (for extension limits). */
  chainSec: number;
  /** Planned internal edit points (connected shots) — not accidental scene changes. */
  plannedCuts: number[];
  reportId: string | null;
  verdict: VersionVerdict;
  overall: number | null;
  scores: QualityScores | null;
  label: string;
  createdAt?: Time;
}

export interface QualityReportDoc {
  id: string;
  productionId: string;
  versionId: string;
  jobId: string;
  assetId: string;
  modelIds: { review: string; transcription: string };
  measurements: Measurements;
  transcript: { text: string; words: DetectedWord[]; languageCode: string | null };
  dialogue: DialogueAnalysis;
  review: ModelReview;
  scores: QualityScores;
  overall: number;
  problems: QualityProblem[];
  passed: boolean;
  threshold: number;
  reasons: string[];
  plannedDurationSec: number | null;
  recommendedRepair: RepairDecision | null;
  summary: string;
  costUsd: number;
  createdAt?: Time;
}

export interface ProductionEvent {
  at: number;
  stage: ProductionStage;
  status: ProductionStatus;
  message: string;
  detail?: Record<string, unknown>;
}

/** Summary mirrored onto the shot document for lists and badges. */
export interface ProductionSummary {
  id: string;
  status: ProductionStatus;
  stage: ProductionStage;
  message: string;
  overall: number | null;
  passed: boolean | null;
  versionCount: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type AfterInspection =
  | { action: 'await_review'; message: string }
  | { action: 'repair'; message: string }
  | { action: 'await_repair_approval'; waitingFor: PendingRepair['waitingFor']; message: string }
  | { action: 'fail'; message: string };

export interface AfterInspectionInput {
  passed: boolean;
  settings: QualitySettings;
  repairCount: number;
  spentUsd: number;
  repair: RepairDecision | null;
  repairEstimateUsd: number | null;
  /** The director explicitly asked for this repair (bypasses the expensive-retry prompt, not the ceiling). */
  directorRequested?: boolean;
}

/** What the loop does after an inspection. Never approves a failing scene and never hides a failure. */
export function decideAfterInspection(i: AfterInspectionInput): AfterInspection {
  if (i.passed) return { action: 'await_review', message: 'Passed quality review — awaiting the director’s approval.' };
  if (!i.settings.autoFixIncomplete && !i.directorRequested) return { action: 'fail', message: 'Failed quality review. Automatic repair is switched off for this project.' };
  if (i.repairCount >= i.settings.maxRepairAttempts && !i.directorRequested) return { action: 'fail', message: `Failed quality review after ${i.repairCount} automatic repair attempt${i.repairCount === 1 ? '' : 's'} (the limit is ${i.settings.maxRepairAttempts}).` };
  if (!i.repair) return { action: 'fail', message: 'Failed quality review. No automatic repair applies to these problems.' };
  const est = i.repairEstimateUsd ?? 0;
  if (i.spentUsd + est > i.settings.repairCostCeilingUsd + 1e-9) {
    return { action: 'await_repair_approval', waitingFor: 'cost_ceiling', message: `Another repair (≈ $${est.toFixed(2)}) would pass this scene’s $${i.settings.repairCostCeilingUsd.toFixed(2)} cost ceiling (spent ≈ $${i.spentUsd.toFixed(2)}).` };
  }
  if (!i.directorRequested && i.settings.requireApprovalForExpensiveRetries && est >= i.settings.expensiveRetryUsd) {
    return { action: 'await_repair_approval', waitingFor: 'expensive_retry', message: `The next repair is estimated at $${est.toFixed(2)} — waiting for approval before spending it.` };
  }
  return { action: 'repair', message: `Repairing: ${i.repair.reason}` };
}

/** Human list of the manual options offered when a scene fails review. */
export function manualOptions(canContinue: boolean): string[] {
  return [
    'Approve the strongest version anyway by marking its issues as acceptable',
    canContinue ? 'Extend the scene' : '',
    'Regenerate with new direction',
    'Split into connected shots',
    'Edit the screenplay lines or action and start again',
    'Keep the original version',
  ].filter(Boolean);
}
