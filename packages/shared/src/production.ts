import type { ContinuityState, ContinuityWarning } from './continuity';
import type { DurationPlan, EditorialWindow } from './duration';
import type { CategoryScores, InspectionExpectations } from './inspection';
import type { OmniMediaRef } from './prompt';
import type { DetectedWord, DialogueAnalysis, ExpectedLine, Measurements, ModelReview, ProblemSeverity, ProductionStage, ProductionStatus, QualityProblem, QualityScores, QualitySettings, RepairDecision, RepairType } from './quality';
import { TEXT_CATEGORIES } from './quality';
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
  /** `repairAttempts/{id}` record of this attempt (instruction, cost, result). */
  attemptId?: string | null;
}

/**
 * Continuity compiled once when the production starts (the shot's `continuitySnapshots` document holds
 * the full plan). Generation, inspection and continuity repairs all use this.
 */
export interface ProductionContinuity {
  plannedAt: number;
  /** The shot's own prompt body and media before continuity was added (repairs re-plan from these). */
  basePrompt: string;
  baseMedia: OmniMediaRef[];
  expectations: InspectionExpectations;
  /** Canonical set views and approved identity, prop and screen references the reviewer compares with. */
  refs: { assetId: string; label: string; kind: 'set' | 'character' | 'prop' | 'screen' }[];
  /** Final frame of the previous approved shot in the same scene (colour and first-frame continuity). */
  colourRefAssetId: string | null;
  previousFinalFrameAssetId: string | null;
  constraints: number;
  preferences: number;
  openWarnings: number;
  /** References that did not fit in the request (the model accepts a limited number of images). */
  dropped: { assetId: string; reason: string }[];
  /** Protected screens whose approved content can be composited after generation. */
  compositeScreenIds: string[];
  /** The shot has a blocking plan (a blocking frame can be generated from it). */
  hasBlocking: boolean;
  /** Character and prop names by id (maps what the reviewer saw back to the ledger). */
  names: { characters: Record<string, string>; props: Record<string, string> };
}

/** Result of comparing independently generated takes of the same shot. */
export interface TakeComparison {
  at: number;
  ranked: { versionId: string; index: number; take: number; passed: boolean; overall: number | null; weakest: string | null; weakestScore: number | null }[];
  recommendedVersionId: string | null;
  reason: string;
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
  /** Continuity established for this shot (null for productions started before the Continuity Director). */
  continuity?: ProductionContinuity | null;
  /** Independent takes generated side by side for the first generation (1 = a single take). */
  takes?: number;
  comparison?: TakeComparison | null;
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
  /** The fifteen take-evaluation categories from its inspection. */
  categoryScores?: CategoryScores | null;
  /** Take number when several takes were generated side by side. */
  take?: number | null;
  label: string;
  createdAt?: Time;
}

export interface QualityReportDoc {
  id: string;
  productionId: string;
  versionId: string;
  jobId: string;
  assetId: string;
  modelIds: { review: string; transcription: string; vision?: string | null };
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
  categoryScores?: CategoryScores | null;
  /** What the reviewer saw at the end of the take and how it differs from the continuity plan. */
  continuity?: { detected: ContinuityState | null; warnings: ContinuityWarning[] } | null;
  createdAt?: Time;
}

/**
 * `projects/{projectId}/qualityReviews/{reportId}` — one line per inspected take for project-wide
 * lists and dashboards (the full report stays under the production). Server-written.
 */
export interface QualityReviewDoc {
  id: string;
  shotId: string;
  takeId: string | null;
  productionId: string;
  versionId: string;
  versionIndex: number | null;
  reportId: string;
  assetId: string;
  passed: boolean;
  overall: number;
  threshold: number;
  scores: QualityScores;
  categoryScores: CategoryScores | null;
  blocking: { category: string; severity: ProblemSeverity; description: string }[];
  problemCount: number;
  continuityWarnings: number;
  summary: string;
  modelIds: { review: string; transcription: string; vision: string | null };
  costUsd: number;
  createdAt?: Time;
}

/**
 * `projects/{projectId}/repairAttempts/{id}` — every automatic or director-requested repair: what was
 * wrong, the exact instruction, what it cost and whether it fixed the problem. The version it repaired
 * is always kept. Server-written.
 */
export interface RepairAttemptDoc {
  id: string;
  shotId: string;
  productionId: string;
  fromVersionId: string;
  fromAssetId: string | null;
  resultVersionId: string | null;
  resultAssetId: string | null;
  type: RepairType;
  label: string;
  reason: string;
  instruction: string;
  categories: string[];
  jobIds: string[];
  estimateUsd: number;
  costUsd: number | null;
  outcome: RepairRecord['outcome'];
  resultOverall: number | null;
  directorRequested: boolean;
  at: number;
  updatedAt?: Time;
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

/**
 * A take can pass review while its protected screen is blank or wrong (the video model is told to leave a
 * composited screen clean): the approved content still has to go onto it. Returns that composite once per
 * production — never after a composite was made or tried.
 */
export function screenCompositeForPassedTake(input: { problems: Pick<QualityProblem, 'category'>[]; compositeScreenIds: string[]; triedTypes: RepairType[] }): RepairDecision | null {
  if (!input.compositeScreenIds.length || input.triedTypes.includes('screen_composite')) return null;
  if (!input.problems.some((x) => (TEXT_CATEGORIES as readonly string[]).includes(x.category))) return null;
  return {
    type: 'screen_composite',
    reason: 'The take passes review, but its protected screen does not show the approved content yet: the content is tracked onto the surface and composited, then re-inspected.',
    instruction: 'Composite the approved content onto the protected surface.',
    durationSec: null,
    sectionStartSec: null,
    sectionEndSec: null,
    keepAudio: true,
    data: { screenIds: input.compositeScreenIds },
  };
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
