import { alignWords, normalizeWord, round1, round3, tokenize, wordSimilarity } from './text-align';
import type { DurationPlan, EditorialWindow } from './duration';
import { CATEGORY_KEYS, computeCategoryScores, directorProblems, emptyExpectations, meanCategoryScore, measuredContinuityProblems, type CategoryScores, type ColourMeasurements, type DirectorReview, type InspectionExpectations, type TemporalMeasurements, type VisionMeasurements } from './inspection';

/**
 * Autonomous production quality control:
 *   plan → audio_prepare → duration_calculate → generate → inspect → repair → reinspect → approve → render
 * A scene is never marked complete because a generation request succeeded — the generated media is
 * transcribed and reviewed, scored against the screenplay, repaired with the least destructive fix,
 * re-inspected, and only then offered for approval.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface QualitySettings {
  autoQualityReview: boolean;
  autoFixIncomplete: boolean;
  ensureCompleteDialogue: boolean;
  ensureCompleteAction: boolean;
  checkContinuity: boolean;
  maxRepairAttempts: number;
  /** Overall usability score (0–100) a version needs before it may be approved. */
  minApprovalScore: number;
  /** Most AZ Studio may spend automatically on one scene (generation + inspections + repairs). */
  repairCostCeilingUsd: number;
  requireApprovalForExpensiveRetries: boolean;
  /** A single repair estimated at or above this amount waits for the director. */
  expensiveRetryUsd: number;
  /** How line lengths are measured before generating: spoken guide audio, or text estimates. */
  dialogueAudio: 'generate' | 'estimate';
  openingAllowanceSec: number;
  closingAllowanceSec: number;
  /** Most independent takes a production may generate for one shot (each is billed). */
  maxTakesPerShot: number;
}

export const DEFAULT_QUALITY_SETTINGS: QualitySettings = {
  autoQualityReview: true,
  autoFixIncomplete: true,
  ensureCompleteDialogue: true,
  ensureCompleteAction: true,
  checkContinuity: true,
  maxRepairAttempts: 3,
  minApprovalScore: 75,
  repairCostCeilingUsd: 6,
  requireApprovalForExpensiveRetries: true,
  expensiveRetryUsd: 1.5,
  dialogueAudio: 'generate',
  openingAllowanceSec: 0.6,
  closingAllowanceSec: 1,
  maxTakesPerShot: 2,
};

export function qualitySettings(partial: Partial<QualitySettings> | null | undefined): QualitySettings {
  return { ...DEFAULT_QUALITY_SETTINGS, ...(partial ?? {}) };
}

// ---------------------------------------------------------------------------
// Production state machine
// ---------------------------------------------------------------------------

export const PRODUCTION_STATUSES = ['planning', 'generating', 'inspecting', 'repairing', 'awaiting_review', 'approved', 'failed_review', 'cancelled'] as const;
export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number];

export const PRODUCTION_STAGES = ['plan', 'continuity', 'audio_prepare', 'duration_calculate', 'generate', 'inspect', 'compare', 'repair', 'reinspect', 'approve', 'update_continuity', 'render'] as const;
export type ProductionStage = (typeof PRODUCTION_STAGES)[number];

export const PRODUCTION_STATUS_LABELS: Record<ProductionStatus, string> = {
  planning: 'Planning',
  generating: 'Generating',
  inspecting: 'Inspecting',
  repairing: 'Repairing',
  awaiting_review: 'Awaiting review',
  approved: 'Approved',
  failed_review: 'Failed quality review',
  cancelled: 'Cancelled',
};

export const PRODUCTION_STAGE_LABELS: Record<ProductionStage, string> = {
  plan: 'Plan',
  continuity: 'Establish continuity',
  audio_prepare: 'Prepare dialogue audio',
  duration_calculate: 'Calculate duration',
  generate: 'Generate',
  inspect: 'Inspect',
  compare: 'Compare takes',
  repair: 'Repair',
  reinspect: 'Re-inspect',
  approve: 'Approve',
  update_continuity: 'Update continuity state',
  render: 'Render',
};

export const PRODUCTION_TRANSITIONS: Record<ProductionStatus, readonly ProductionStatus[]> = {
  planning: ['planning', 'generating', 'awaiting_review', 'failed_review', 'cancelled'],
  generating: ['generating', 'inspecting', 'awaiting_review', 'failed_review', 'cancelled'],
  inspecting: ['inspecting', 'repairing', 'awaiting_review', 'failed_review', 'cancelled'],
  repairing: ['repairing', 'inspecting', 'awaiting_review', 'failed_review', 'cancelled'],
  // The director can approve, ask for a repair / regeneration, or split the scene.
  awaiting_review: ['awaiting_review', 'approved', 'planning', 'generating', 'repairing', 'failed_review', 'cancelled'],
  failed_review: ['failed_review', 'approved', 'awaiting_review', 'planning', 'generating', 'repairing', 'cancelled'],
  approved: ['approved', 'awaiting_review'],
  cancelled: ['cancelled'],
};

export function canProductionTransition(from: ProductionStatus, to: ProductionStatus): boolean {
  return PRODUCTION_TRANSITIONS[from].includes(to);
}

export const ACTIVE_PRODUCTION_STATUSES: readonly ProductionStatus[] = ['planning', 'generating', 'inspecting', 'repairing'];

// ---------------------------------------------------------------------------
// Scores & problems
// ---------------------------------------------------------------------------

export const SCORE_KEYS = ['dialogueCompleteness', 'actionCompleteness', 'visualAccuracy', 'characterContinuity', 'audioQuality', 'storyContinuity', 'overallUsability'] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];
export type QualityScores = Record<ScoreKey, number | null>;

export const SCORE_LABELS: Record<ScoreKey, string> = {
  dialogueCompleteness: 'Dialogue completeness',
  actionCompleteness: 'Action completeness',
  visualAccuracy: 'Visual accuracy',
  characterContinuity: 'Character continuity',
  audioQuality: 'Audio quality',
  storyContinuity: 'Story continuity',
  overallUsability: 'Overall usability',
};

export const PROBLEM_CATEGORIES = [
  'dialogue_missing',
  'dialogue_altered',
  'dialogue_repeated',
  'dialogue_truncated',
  'dialogue_early',
  'dialogue_late',
  'trailing_room',
  'wrong_speaker',
  'lip_sync',
  'performance_unfinished',
  'abrupt_cut',
  'music_over_dialogue',
  'audio_quality',
  'action_incomplete',
  'unfinished_movement',
  'character_identity',
  'costume',
  'hairstyle',
  'location',
  'time_of_day',
  'props',
  'camera_direction',
  'screen_direction',
  'emotional_performance',
  'rendered_text',
  'visual_artefact',
  'sudden_disappearance',
  'accidental_scene_change',
  'first_frame',
  'last_frame',
  'storyboard_mismatch',
  'previous_shot_mismatch',
  'story_continuity',
  // Character continuity (against the Character Bible)
  'face_change',
  'missing_accessory',
  'wrong_age',
  'character_count',
  'character_merge',
  'character_disappears',
  'scale_change',
  'impossible_position',
  // Background / set continuity (against the Set Bible and previous shots)
  'background_drift',
  'door_window_moved',
  'furniture_moved',
  'wall_colour',
  'landscape',
  'layout_reversed',
  'weather',
  'lighting_change',
  'background_people',
  'architecture_mutation',
  'duplicate_object',
  'location_replaced',
  // Blocking and occlusion
  'occlusion',
  'face_hidden',
  'bodies_merge',
  'same_space',
  'attached_character',
  'action_hidden',
  'depth_order',
  'wrong_eyeline',
  'speaker_blocked',
  'walk_through',
  // Screen direction and the camera axis
  'direction_reversal',
  'entry_exit_side',
  'broken_eyeline',
  'side_swap',
  'axis_crossing',
  'vehicle_direction',
  'spatial_confusion',
  // Protected screens, text, signs and logos
  'mirrored_text',
  'misspelled_text',
  'reversed_logo',
  'flipped_interface',
  'distorted_ui',
  'text_flicker',
  'wrong_screen_content',
  // Prop ledger
  'prop_appearance',
  'prop_hand',
  'prop_teleport',
  'prop_state',
  'prop_missing',
  'prop_scale',
  'duplicate_prop',
  // Temporal / frame-level
  'face_instability',
  'body_instability',
  'hand_quality',
  'texture_flicker',
  'lighting_flicker',
  'camera_jump',
  'physics',
  'broken_motion',
  'morphing',
  'repeated_frames',
  'frozen_frames',
  'corrupted_frames',
  // First and last second
  'early_dialogue_start',
  'first_frame_mismatch',
  'final_line_incomplete',
  'final_action_incomplete',
  'exit_incomplete',
  'camera_unresolved',
  'no_edit_room',
  // Colour and lighting continuity
  'colour_drift',
  'exposure_mismatch',
  'white_balance',
  'skin_tone',
] as const;
export type ProblemCategory = (typeof PROBLEM_CATEGORIES)[number];
export type ProblemSeverity = 'minor' | 'major' | 'critical';

export const DIALOGUE_CATEGORIES: readonly ProblemCategory[] = ['dialogue_missing', 'dialogue_altered', 'dialogue_repeated', 'dialogue_truncated', 'dialogue_early', 'dialogue_late', 'trailing_room', 'wrong_speaker', 'lip_sync', 'performance_unfinished', 'abrupt_cut', 'music_over_dialogue', 'early_dialogue_start', 'final_line_incomplete'];
export const ACTION_CATEGORIES: readonly ProblemCategory[] = ['action_incomplete', 'unfinished_movement', 'final_action_incomplete', 'exit_incomplete'];
export const CHARACTER_CATEGORIES: readonly ProblemCategory[] = ['character_identity', 'face_change', 'costume', 'hairstyle', 'missing_accessory', 'wrong_age', 'character_count', 'character_merge', 'character_disappears', 'scale_change', 'impossible_position'];
export const BACKGROUND_CATEGORIES: readonly ProblemCategory[] = ['location', 'time_of_day', 'background_drift', 'door_window_moved', 'furniture_moved', 'wall_colour', 'landscape', 'layout_reversed', 'weather', 'lighting_change', 'background_people', 'architecture_mutation', 'duplicate_object', 'location_replaced'];
export const BLOCKING_CATEGORIES: readonly ProblemCategory[] = ['occlusion', 'face_hidden', 'bodies_merge', 'same_space', 'attached_character', 'action_hidden', 'depth_order', 'wrong_eyeline', 'speaker_blocked', 'walk_through'];
export const DIRECTION_CATEGORIES: readonly ProblemCategory[] = ['screen_direction', 'direction_reversal', 'entry_exit_side', 'broken_eyeline', 'side_swap', 'axis_crossing', 'vehicle_direction', 'spatial_confusion'];
export const TEXT_CATEGORIES: readonly ProblemCategory[] = ['rendered_text', 'mirrored_text', 'misspelled_text', 'reversed_logo', 'flipped_interface', 'distorted_ui', 'text_flicker', 'wrong_screen_content'];
export const PROP_CATEGORIES: readonly ProblemCategory[] = ['props', 'prop_appearance', 'prop_hand', 'prop_teleport', 'prop_state', 'prop_missing', 'prop_scale', 'duplicate_prop'];
export const TEMPORAL_CATEGORIES: readonly ProblemCategory[] = ['visual_artefact', 'face_instability', 'body_instability', 'hand_quality', 'texture_flicker', 'lighting_flicker', 'camera_jump', 'physics', 'broken_motion', 'morphing', 'repeated_frames', 'frozen_frames', 'corrupted_frames', 'sudden_disappearance'];
export const COLOUR_CATEGORIES: readonly ProblemCategory[] = ['colour_drift', 'exposure_mismatch', 'white_balance', 'skin_tone'];
export const CONTINUITY_CATEGORIES: readonly ProblemCategory[] = [
  'storyboard_mismatch',
  'previous_shot_mismatch',
  'story_continuity',
  'first_frame_mismatch',
  ...CHARACTER_CATEGORIES,
  ...BACKGROUND_CATEGORIES,
  ...BLOCKING_CATEGORIES,
  ...DIRECTION_CATEGORIES,
  ...PROP_CATEGORIES,
  ...COLOUR_CATEGORIES,
  'mirrored_text',
  'misspelled_text',
  'reversed_logo',
  'flipped_interface',
  'wrong_screen_content',
];
/** Problems that are about the picture only (the dialogue audio can be kept while they are fixed). */
export const VISUAL_CATEGORIES: readonly ProblemCategory[] = [
  'camera_direction',
  'first_frame',
  'last_frame',
  'storyboard_mismatch',
  'previous_shot_mismatch',
  ...CHARACTER_CATEGORIES.filter((c) => c !== 'character_count' && c !== 'character_disappears'),
  ...BACKGROUND_CATEGORIES,
  ...TEXT_CATEGORIES,
  ...PROP_CATEGORIES,
  ...COLOUR_CATEGORIES,
  ...TEMPORAL_CATEGORIES.filter((c) => c !== 'sudden_disappearance' && c !== 'corrupted_frames'),
  'screen_direction',
];

/** Problem groups shown together in the AI Director Review and the Continuity workspace. */
export const PROBLEM_GROUPS: { key: string; title: string; categories: readonly ProblemCategory[] }[] = [
  { key: 'dialogue', title: 'Dialogue', categories: DIALOGUE_CATEGORIES },
  { key: 'action', title: 'Action', categories: ACTION_CATEGORIES },
  { key: 'character', title: 'Characters', categories: CHARACTER_CATEGORIES },
  { key: 'background', title: 'Background & set', categories: BACKGROUND_CATEGORIES },
  { key: 'blocking', title: 'Blocking & occlusion', categories: BLOCKING_CATEGORIES },
  { key: 'direction', title: 'Screen direction', categories: DIRECTION_CATEGORIES },
  { key: 'text', title: 'Screens, text & logos', categories: TEXT_CATEGORIES },
  { key: 'props', title: 'Props', categories: PROP_CATEGORIES },
  { key: 'temporal', title: 'Frame-level quality', categories: TEMPORAL_CATEGORIES },
  { key: 'colour', title: 'Colour & lighting', categories: COLOUR_CATEGORIES },
];

export function problemGroup(c: ProblemCategory): string {
  return PROBLEM_GROUPS.find((g) => g.categories.includes(c))?.key ?? 'other';
}

export interface QualityProblem {
  id: string;
  category: ProblemCategory;
  severity: ProblemSeverity;
  startSec: number | null;
  endSec: number | null;
  description: string;
  /** `measured` = deterministic analysis of the media; `model` = judged by the reviewing model. */
  source: 'measured' | 'model';
  /** Whether this problem prevents approval under the project's settings. */
  blocking: boolean;
  /** Set when the director marks the issue as acceptable. */
  waived?: { at: number; note: string } | null;
  /** Where in the frame the problem is (0–1), when known — lets a reframe remove it. */
  region?: { x: number; y: number; w: number; h: number } | null;
}

// ---------------------------------------------------------------------------
// Dialogue completion analysis (deterministic: screenplay vs. word-timed transcript)
// ---------------------------------------------------------------------------

export interface ExpectedLine {
  index: number;
  character: string;
  text: string;
}

export interface DetectedWord {
  text: string;
  start: number;
  end: number;
  speaker?: string | null;
}

export interface DialogueLineResult {
  index: number;
  character: string;
  expected: string;
  detected: string;
  matchedWords: number;
  totalWords: number;
  missing: string[];
  start: number | null;
  end: number | null;
  complete: boolean;
}

export interface DialogueAnalysis {
  applicable: boolean;
  dialogueComplete: boolean;
  expectedText: string;
  detectedText: string;
  missingWords: string[];
  alteredWords: { expected: string; detected: string; atSec: number | null; severity: ProblemSeverity }[];
  repeatedWords: string[];
  extraWords: string[];
  truncatedFinalWord: boolean;
  /** When speech is cut off (s), or null. */
  cutoffTime: number | null;
  firstWordStart: number | null;
  lastWordEnd: number | null;
  leadingRoomSec: number | null;
  trailingRoomSec: number | null;
  wordCoverage: number;
  lines: DialogueLineResult[];
  recommendedRepair: RepairType | null;
  problems: QualityProblem[];
  score: number | null;
}

export interface DialogueAnalysisInput {
  expected: ExpectedLine[];
  words: DetectedWord[];
  durationSec: number;
  /** Speech energy was still high in the final frames (from audio measurement). */
  speechAtEnd?: boolean;
  /** Planned internal edit points (s) — speech may legitimately continue across them. */
  plannedCuts?: number[];
  minTrailingSec?: number;
  minLeadingSec?: number;
}

/** A word without surrounding punctuation, for reports ("begun." → "begun"). */
export function bareWord(w: string): string {
  return w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') || w;
}

let problemCounter = 0;
export function problemId(category: string): string {
  problemCounter = (problemCounter + 1) % 100000;
  return `${category}_${Date.now().toString(36)}${problemCounter.toString(36)}`;
}

/** Compares the approved screenplay with what was actually said (word timestamps from transcription). */
export function analyzeDialogue(input: DialogueAnalysisInput): DialogueAnalysis {
  const minTrailing = input.minTrailingSec ?? 0.5;
  const minLeading = input.minLeadingSec ?? 0.2;
  const D = input.durationSec;
  const expectedTokens = input.expected.flatMap((l) => tokenize(l.text).map((t) => ({ ...t, line: l.index })));
  const detected = input.words.filter((w) => normalizeWord(w.text)).map((w) => ({ ...w, norm: normalizeWord(w.text) }));
  const expectedText = input.expected.map((l) => l.text.trim()).join(' ');
  const detectedText = input.words.map((w) => w.text).join(' ');
  const firstWordStart = detected.length ? detected[0]!.start : null;
  const lastWordEnd = detected.length ? Math.max(...detected.map((w) => w.end)) : null;
  const trailing = lastWordEnd === null ? null : round3(D - lastWordEnd);
  const leading = firstWordStart === null ? null : round3(firstWordStart);

  if (!expectedTokens.length) {
    return {
      applicable: false,
      dialogueComplete: true,
      expectedText: '',
      detectedText,
      missingWords: [],
      alteredWords: [],
      repeatedWords: [],
      extraWords: detected.map((w) => w.text),
      truncatedFinalWord: false,
      cutoffTime: null,
      firstWordStart,
      lastWordEnd,
      leadingRoomSec: leading,
      trailingRoomSec: trailing,
      wordCoverage: 1,
      lines: [],
      recommendedRepair: null,
      problems: [],
      score: null,
    };
  }

  const ops = alignWords(
    expectedTokens.map((t) => t.norm),
    detected.map((w) => w.norm),
  );
  const matchedE = new Map<number, number>();
  const substituted = new Map<number, { d: number; sim: number }>();
  const missingIdx: number[] = [];
  const inserted: number[] = [];
  for (const op of ops) {
    if (op.op === 'match') matchedE.set(op.e, op.d);
    else if (op.op === 'substitute') substituted.set(op.e, { d: op.d, sim: op.sim });
    else if (op.op === 'delete') missingIdx.push(op.e);
    else inserted.push(op.d);
  }

  // Repeated words: an inserted word identical to the word just before or after it.
  const repeatedWords: string[] = [];
  const extraWords: string[] = [];
  for (const d of inserted) {
    const w = detected[d]!;
    const neighbours = [detected[d - 1]?.norm, detected[d - 2]?.norm, detected[d + 1]?.norm].filter(Boolean);
    if (neighbours.includes(w.norm)) repeatedWords.push(w.text);
    else extraWords.push(w.text);
  }

  // Final word truncation / cut-off. A detected prefix of the last word ("beg" for "begun") means the
  // word was chopped mid-way: it counts as missing, not as a changed word.
  const lastIdx = expectedTokens.length - 1;
  const lastSub = substituted.get(lastIdx);
  const lastExpected = expectedTokens[lastIdx]!;
  const prefixCut = lastSub ? lastExpected.norm.startsWith(detected[lastSub.d]!.norm) && detected[lastSub.d]!.norm.length < lastExpected.norm.length : false;
  if (prefixCut) {
    substituted.delete(lastIdx);
    missingIdx.push(lastIdx);
  }

  const alteredWords: DialogueAnalysis['alteredWords'] = [];
  for (const [e, s] of substituted) {
    const exp = expectedTokens[e]!;
    const det = detected[s.d]!;
    alteredWords.push({ expected: bareWord(exp.raw), detected: bareWord(det.text), atSec: det.start, severity: s.sim >= 0.5 ? 'minor' : 'major' });
  }
  const endsAtEdge = lastWordEnd !== null && D - lastWordEnd < 0.15;
  const finalMissing = missingIdx.includes(lastIdx);
  // Missing words at the very end of the script while speech runs into the last frame = cut off.
  const tailMissing = missingIdx.length > 0 && missingIdx.every((i, k) => i === lastIdx - (missingIdx.length - 1 - k)) && missingIdx[missingIdx.length - 1] === lastIdx;
  const truncatedFinalWord = prefixCut || ((finalMissing || tailMissing) && (endsAtEdge || Boolean(input.speechAtEnd)));
  const cutoffTime = truncatedFinalWord || (endsAtEdge && input.speechAtEnd) ? round3(lastWordEnd ?? D) : null;

  const matchedCount = matchedE.size;
  const minorAltered = alteredWords.filter((a) => a.severity === 'minor').length;
  const coverage = (matchedCount + 0.5 * minorAltered) / expectedTokens.length;

  const lines: DialogueLineResult[] = input.expected.map((l) => {
    const idxs = expectedTokens.map((t, i) => (t.line === l.index ? i : -1)).filter((i) => i >= 0);
    const times = idxs.map((i) => (matchedE.has(i) ? detected[matchedE.get(i)!] : substituted.has(i) ? detected[substituted.get(i)!.d] : undefined)).filter((w): w is (typeof detected)[number] => Boolean(w));
    const missing = idxs.filter((i) => missingIdx.includes(i)).map((i) => bareWord(expectedTokens[i]!.raw));
    const matched = idxs.filter((i) => matchedE.has(i)).length;
    return {
      index: l.index,
      character: l.character,
      expected: l.text,
      detected: times.map((w) => w.text).join(' '),
      matchedWords: matched,
      totalWords: idxs.length,
      missing,
      start: times.length ? times[0]!.start : null,
      end: times.length ? times[times.length - 1]!.end : null,
      complete: missing.length === 0 && idxs.every((i) => matchedE.has(i) || (substituted.get(i)?.sim ?? 0) >= 0.5),
    };
  });

  const problems: QualityProblem[] = [];
  const add = (category: ProblemCategory, severity: ProblemSeverity, description: string, startSec: number | null = null, endSec: number | null = null) =>
    problems.push({ id: problemId(category), category, severity, startSec, endSec, description, source: 'measured', blocking: false });

  const missingWords = missingIdx.map((i) => bareWord(expectedTokens[i]!.raw));
  if (truncatedFinalWord) add('dialogue_truncated', 'critical', `Speech is cut off at ${round1(cutoffTime ?? D)} s — the final words (“${missingWords.slice(-4).join(' ') || lastExpected.raw}”) are not delivered in full.`, cutoffTime, D);
  const midMissing = missingWords.length - (truncatedFinalWord && tailMissing ? missingIdx.length : 0);
  if (missingWords.length && (!truncatedFinalWord || midMissing > 0)) {
    add('dialogue_missing', missingWords.length >= 3 || missingWords.length / expectedTokens.length > 0.15 ? 'critical' : 'major', `${missingWords.length} scripted word${missingWords.length > 1 ? 's are' : ' is'} missing: ${missingWords.slice(0, 12).join(', ')}${missingWords.length > 12 ? '…' : ''}.`);
  }
  const majorAltered = alteredWords.filter((a) => a.severity === 'major');
  if (majorAltered.length) add('dialogue_altered', majorAltered.length >= 3 ? 'critical' : 'major', `Changed words: ${majorAltered.slice(0, 8).map((a) => `“${a.expected}” → “${a.detected}”`).join(', ')}.`, majorAltered[0]!.atSec, null);
  else if (minorAltered) add('dialogue_altered', 'minor', `${minorAltered} word${minorAltered > 1 ? 's' : ''} may be mispronounced or mis-transcribed: ${alteredWords.filter((a) => a.severity === 'minor').slice(0, 6).map((a) => `“${a.expected}” → “${a.detected}”`).join(', ')}.`);
  if (repeatedWords.length) add('dialogue_repeated', repeatedWords.length >= 2 ? 'major' : 'minor', `Repeated word${repeatedWords.length > 1 ? 's' : ''}: ${repeatedWords.join(', ')}.`);
  if (leading !== null && leading < minLeading) add('dialogue_early', leading < 0.08 ? 'major' : 'minor', `Dialogue starts ${round1(leading)} s into the shot — there is no breath before the first word.`, 0, leading);
  if (trailing !== null && !truncatedFinalWord && trailing < minTrailing) {
    add('trailing_room', trailing < 0.25 ? 'major' : 'minor', `Only ${round1(Math.max(0, trailing))} s after the final word — the moment is cut short (aim for 0.8–1.5 s).`, lastWordEnd, D);
  }
  if (!detected.length) add('dialogue_missing', 'critical', 'No speech was detected, but the screenplay has dialogue for this shot.');

  const dialogueComplete = missingWords.length === 0 && !truncatedFinalWord && majorAltered.length === 0 && (trailing === null || trailing >= 0.25) && detected.length > 0;

  let score = 100 * Math.min(1, coverage);
  if (truncatedFinalWord) score -= 25;
  if (trailing !== null && trailing < minTrailing) score -= trailing < 0.25 ? 15 : 6;
  if (leading !== null && leading < minLeading) score -= leading < 0.08 ? 10 : 4;
  score -= Math.min(15, repeatedWords.length * 5);
  score -= Math.min(20, majorAltered.length * 6);
  score = Math.max(0, Math.min(100, Math.round(score)));

  let recommendedRepair: RepairType | null = null;
  if (truncatedFinalWord || (trailing !== null && trailing < minTrailing)) recommendedRepair = 'extend_scene';
  else if (missingWords.length || majorAltered.length || repeatedWords.length >= 2) recommendedRepair = 'regenerate_longer';
  else if (leading !== null && leading < 0.08) recommendedRepair = 'regenerate_longer';

  return {
    applicable: true,
    dialogueComplete,
    expectedText,
    detectedText,
    missingWords,
    alteredWords,
    repeatedWords,
    extraWords,
    truncatedFinalWord,
    cutoffTime,
    firstWordStart,
    lastWordEnd,
    leadingRoomSec: leading,
    trailingRoomSec: trailing,
    wordCoverage: round3(Math.min(1, coverage)),
    lines,
    recommendedRepair,
    problems,
    score,
  };
}

/** Parses "1.300s" / "2s" offsets from the transcription API. */
export function parseOffset(v: unknown): number {
  if (typeof v === 'number') return v;
  const m = /^(-?[\d.]+)s?$/.exec(String(v ?? '').trim());
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------------------
// Model review (structured output from the reviewing model) and the final verdict
// ---------------------------------------------------------------------------

export interface ModelReview {
  summary: string;
  speakerAttribution: { lineIndex: number; expectedCharacter: string; deliveredBy: string; correct: boolean; note: string }[];
  lipSync: { applicable: boolean; drift: 'none' | 'minor' | 'severe'; note: string };
  performanceFinished: boolean;
  dialogueOverMusic: 'clear' | 'music_loud' | 'music_overpowering' | 'not_applicable';
  abruptCutDuringSpeech: boolean;
  actions: { beat: string; completed: boolean; startSec: number | null; endSec: number | null; note: string }[];
  actionComplete: boolean;
  unfinishedMovementAtEnd: boolean;
  continuity: { aspect: string; ok: boolean; severity: 'none' | ProblemSeverity; note: string }[];
  cameraMatchesDirection: boolean;
  screenDirectionConsistent: boolean;
  emotionalPerformanceMatches: boolean;
  renderedText: { present: boolean; acceptable: boolean; note: string };
  artefacts: { description: string; severity: ProblemSeverity; startSec: number | null; endSec: number | null; region?: { x: number; y: number; w: number; h: number } | null }[];
  suddenDisappearance: boolean;
  accidentalSceneChange: boolean;
  firstFrame: { quality: 'good' | 'acceptable' | 'poor'; note: string };
  lastFrame: { quality: 'good' | 'acceptable' | 'poor'; note: string };
  scores: { actionCompleteness: number; visualAccuracy: number; characterContinuity: number | null; audioQuality: number; storyContinuity: number; overallUsability: number };
  problems: { category: string; severity: ProblemSeverity; startSec: number | null; endSec: number | null; description: string }[];
  recommendedRepair: { type: string; instruction: string; sectionStartSec: number | null; sectionEndSec: number | null; rationale: string } | null;
  /** Continuity Director checks (character, background, blocking, direction, text, props, temporal, edges). */
  director?: DirectorReview | null;
}

export interface AudioMeasurements {
  peakDbfs: number | null;
  clippedRatio: number;
  /** RMS level of the final 150 ms relative to the loudest speech (dB). */
  endLevelDb: number | null;
  speechAtEnd: boolean;
  integratedLufs: number | null;
}

export interface VisualMeasurements {
  /** Detected hard cuts (s). */
  sceneCuts: number[];
  blackSegments: { start: number; end: number }[];
  /** Mean inter-frame change over the final half second vs. the whole clip (1 ≈ same motion). */
  endMotionRatio: number | null;
  frozenAtEnd: boolean;
}

export interface Measurements {
  durationSec: number;
  fps: number | null;
  hasAudio: boolean;
  audio: AudioMeasurements | null;
  visual: VisualMeasurements;
  /** Frame-level analysis: freezes, stutter, flicker, jumps, decode errors. */
  temporal?: TemporalMeasurements | null;
  /** Sampled frames with detected faces, people, objects and text (Cloud Vision). */
  vision?: VisionMeasurements | null;
  /** Colour statistics of the shot, the approved reference still and the previous shot. */
  colour?: ColourMeasurements | null;
}

export interface VerdictInput {
  /** What the Continuity Director expects in this shot (characters, direction, protected screens…). */
  expect?: InspectionExpectations | null;
  dialogue: DialogueAnalysis;
  review: ModelReview;
  measurements: Measurements;
  settings: QualitySettings;
  /** Planned internal cuts (connected shots) that must not count as accidental scene changes. */
  plannedCuts?: number[];
  /** Spans where the plan asked for a cut to another angle (reaction shot, reverse angle). */
  editorialCuts?: EditorialWindow[];
  hasCharacters: boolean;
  /** Problem categories the director marked as acceptable for this version. */
  waivedCategories?: string[];
}

export interface Verdict {
  scores: QualityScores;
  overall: number;
  problems: QualityProblem[];
  passed: boolean;
  reasons: string[];
  dialogueComplete: boolean;
  actionComplete: boolean;
  /** The fifteen take-evaluation categories (null when not applicable). */
  categoryScores: CategoryScores;
}

const clampScore = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);

function modelCategory(c: string): ProblemCategory {
  const k = c.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (PROBLEM_CATEGORIES as readonly string[]).includes(k) ? (k as ProblemCategory) : k.includes('text') ? 'rendered_text' : k.includes('continu') ? 'story_continuity' : 'visual_artefact';
}

/** Marks which problems block approval under the project settings. */
export function isBlocking(p: Pick<QualityProblem, 'category' | 'severity' | 'waived'>, s: QualitySettings): boolean {
  if (p.waived) return false;
  if (p.severity === 'minor') return false;
  if (p.severity === 'critical') return true;
  if (DIALOGUE_CATEGORIES.includes(p.category)) return s.ensureCompleteDialogue;
  if (ACTION_CATEGORIES.includes(p.category)) return s.ensureCompleteAction;
  if (CONTINUITY_CATEGORIES.includes(p.category)) return s.checkContinuity;
  // Editorial niceties (camera settles late, little room at the end) never block on their own.
  if (p.category === 'camera_unresolved' || p.category === 'no_edit_room' || p.category === 'emotional_performance' || p.category === 'camera_direction') return false;
  return true;
}

/** Combines deterministic measurements with the model's review into scores, problems and a verdict. */
export function evaluateQuality(input: VerdictInput): Verdict {
  const { dialogue, review, measurements: m, settings } = input;
  const problems: QualityProblem[] = [...dialogue.problems];
  const add = (category: ProblemCategory, severity: ProblemSeverity, description: string, source: QualityProblem['source'], startSec: number | null = null, endSec: number | null = null) => {
    if (problems.some((p) => p.category === category && p.description === description)) return;
    problems.push({ id: problemId(category), category, severity, startSec, endSec, description, source, blocking: false });
  };
  const planned = input.plannedCuts ?? [];
  const nearPlanned = (t: number) => planned.some((c) => Math.abs(c - t) < 1);

  if (dialogue.applicable) {
    for (const a of review.speakerAttribution) {
      if (a.correct) continue;
      // The right character delivering altered words is not a speaker problem (the wording is measured from the transcript).
      if (a.deliveredBy.trim() && a.deliveredBy.trim().toLowerCase() === a.expectedCharacter.trim().toLowerCase()) continue;
      add('wrong_speaker', 'major', `Line ${a.lineIndex + 1} should be spoken by ${a.expectedCharacter} but is delivered by ${a.deliveredBy || 'someone else'}. ${a.note}`.trim(), 'model');
    }
    if (review.lipSync.applicable && review.lipSync.drift !== 'none') add('lip_sync', review.lipSync.drift === 'severe' ? 'major' : 'minor', `Lip-sync drift: ${review.lipSync.note || review.lipSync.drift}.`, 'model');
    if (!review.performanceFinished) add('performance_unfinished', 'major', 'A speaker does not finish their physical performance before the shot ends.', 'model');
    if (review.abruptCutDuringSpeech) add('abrupt_cut', 'critical', 'The shot cuts abruptly while someone is speaking.', 'model');
    if (review.dialogueOverMusic === 'music_overpowering') add('music_over_dialogue', 'major', 'Music is loud enough to cover the dialogue.', 'model');
    else if (review.dialogueOverMusic === 'music_loud') add('music_over_dialogue', 'minor', 'Music competes with the dialogue.', 'model');
  }
  const incompleteBeats = review.actions.filter((a) => !a.completed);
  if (!review.actionComplete || incompleteBeats.length) add('action_incomplete', 'major', `Unfinished action: ${incompleteBeats.map((a) => a.beat).join('; ') || 'the described action does not complete'}.`, 'model', incompleteBeats[0]?.startSec ?? null, null);
  if (review.unfinishedMovementAtEnd) add('unfinished_movement', 'major', 'Movement is still in progress in the final frames.', 'model', Math.max(0, m.durationSec - 1), m.durationSec);
  for (const c of review.continuity) {
    if (c.ok || c.severity === 'none') continue;
    const cat = modelCategory(c.aspect);
    add(CONTINUITY_CATEGORIES.includes(cat) ? cat : 'story_continuity', c.severity, `${c.aspect.replace(/_/g, ' ')}: ${c.note}`, 'model');
  }
  if (!review.cameraMatchesDirection) add('camera_direction', 'minor', 'The camera does not follow the requested framing or movement.', 'model');
  if (!review.screenDirectionConsistent) add('screen_direction', 'major', 'Screen direction is inconsistent (characters or movement flip sides).', 'model');
  if (!review.emotionalPerformanceMatches) add('emotional_performance', 'minor', 'The emotional performance does not match the direction.', 'model');
  if (review.renderedText.present && !review.renderedText.acceptable) add('rendered_text', 'major', `Unwanted or garbled text in the frame: ${review.renderedText.note}`, 'model');
  for (const a of review.artefacts) {
    add('visual_artefact', a.severity, a.description, 'model', a.startSec, a.endSec);
    const last = problems[problems.length - 1];
    if (a.region && last && last.description === a.description) last.region = a.region;
  }
  if (review.suddenDisappearance) add('sudden_disappearance', 'critical', 'A character or object disappears suddenly.', 'model');
  // Cuts the plan asked for inside a continuation part are intended — up to its limit (away and back).
  const windows = input.editorialCuts ?? [];
  const used = windows.map(() => 0);
  const directed = (t: number) => {
    const i = windows.findIndex((w, k) => t > w.startSec + 0.3 && t < w.endSec - 0.3 && used[k]! < w.maxCuts);
    if (i < 0) return false;
    used[i]! += 1;
    return true;
  };
  const unplannedCuts = m.visual.sceneCuts.filter((t) => t > 0.3 && t < m.durationSec - 0.2 && !nearPlanned(t) && !directed(t));
  const cutList = unplannedCuts.map((t) => `${round1(t)} s`).join(', ');
  const cutWord = `cut${unplannedCuts.length > 1 ? 's' : ''}`;
  if (review.accidentalSceneChange) add('accidental_scene_change', 'major', unplannedCuts.length ? `Unplanned ${cutWord} at ${cutList}.` : 'The scene changes unexpectedly.', unplannedCuts.length ? 'measured' : 'model', unplannedCuts[0] ?? null, null);
  // A picture jump the reviewer did not see as a scene change (a whip pan, a flash, a lighting change)
  // is reported for the director to check but does not fail the scene on its own.
  else if (unplannedCuts.length) add('accidental_scene_change', 'minor', `Possible ${cutWord} at ${cutList} (sharp picture change; the reviewer saw no scene change — check it).`, 'measured', unplannedCuts[0] ?? null, null);
  if (review.firstFrame.quality === 'poor') add('first_frame', 'minor', `First frame: ${review.firstFrame.note}`, 'model', 0, 0.5);
  if (review.lastFrame.quality === 'poor') add('last_frame', 'minor', `Last frame: ${review.lastFrame.note}`, 'model', Math.max(0, m.durationSec - 0.5), m.durationSec);
  for (const b of m.visual.blackSegments) if (b.end - b.start > 0.25) add('visual_artefact', 'major', `Black frames from ${round1(b.start)} s to ${round1(b.end)} s.`, 'measured', b.start, b.end);
  if (m.audio && m.audio.clippedRatio > 0.002) add('audio_quality', m.audio.clippedRatio > 0.02 ? 'major' : 'minor', `Audio clips (${(m.audio.clippedRatio * 100).toFixed(1)}% of samples at full scale).`, 'measured');
  if (!m.hasAudio && dialogue.applicable) add('audio_quality', 'critical', 'The video has no audio track.', 'measured');
  for (const p of review.problems) {
    const cat = modelCategory(p.category);
    if (DIALOGUE_CATEGORIES.includes(cat) && dialogue.applicable && ['dialogue_missing', 'dialogue_altered', 'dialogue_truncated'].includes(cat)) continue; // measured instead
    add(cat, p.severity, p.description, 'model', p.startSec, p.endSec);
  }
  // Continuity Director: the reviewer's continuity sections and the measured frame, text and colour checks.
  const expect = input.expect ?? emptyExpectations();
  const extra = [...(review.director ? directorProblems(review.director, expect) : []), ...measuredContinuityProblems({ temporal: m.temporal ?? null, vision: m.vision ?? null, colour: m.colour ?? null, expect, durationSec: m.durationSec })];
  for (const p of extra) {
    // The measured dialogue analysis already decides whether the final line is complete.
    if (p.category === 'final_line_incomplete' && dialogue.applicable && dialogue.dialogueComplete && !dialogue.truncatedFinalWord) continue;
    if (p.category === 'final_line_incomplete' && !dialogue.applicable) continue;
    if (!problems.some((x) => x.category === p.category && x.description === p.description)) problems.push(p);
  }

  const waived = new Set(input.waivedCategories ?? []);
  for (const p of problems) {
    if (waived.has(p.category) && !p.waived) p.waived = { at: Date.now(), note: 'Marked acceptable by the director' };
    p.blocking = isBlocking(p, settings);
  }

  const dialogueComplete = !dialogue.applicable || (dialogue.dialogueComplete && !problems.some((p) => ['wrong_speaker', 'abrupt_cut'].includes(p.category) && p.severity !== 'minor' && !p.waived));
  const actionComplete = review.actionComplete && incompleteBeats.length === 0 && !review.unfinishedMovementAtEnd;
  const rs = review.scores;
  let audio = clampScore(rs.audioQuality) ?? 70;
  if (review.dialogueOverMusic === 'music_overpowering') audio = Math.min(audio, 50);
  if (m.audio && m.audio.clippedRatio > 0.02) audio = Math.min(audio, 60);
  let action = clampScore(rs.actionCompleteness) ?? 70;
  if (!actionComplete) action = Math.min(action, 60);
  const scores: QualityScores = {
    dialogueCompleteness: dialogue.applicable ? dialogue.score : null,
    actionCompleteness: action,
    visualAccuracy: clampScore(rs.visualAccuracy),
    characterContinuity: input.hasCharacters ? clampScore(rs.characterContinuity) : null,
    audioQuality: audio,
    storyContinuity: clampScore(rs.storyContinuity),
    overallUsability: null,
  };
  const parts = SCORE_KEYS.filter((k) => k !== 'overallUsability')
    .map((k) => scores[k])
    .filter((v): v is number => v !== null);
  const mean = parts.length ? parts.reduce((s, v) => s + v, 0) / parts.length : 70;
  const minPart = parts.length ? Math.min(...parts) : 70;
  let overall = Math.min(clampScore(rs.overallUsability) ?? mean, Math.round(mean + 10), Math.round(minPart + 35));
  const categoryScores = computeCategoryScores({
    model: review.director?.categoryScores ?? {},
    dialogueScore: scores.dialogueCompleteness,
    actionScore: scores.actionCompleteness,
    audioScore: scores.audioQuality,
    lipSync: review.lipSync.applicable ? review.lipSync.drift : null,
    problems,
    hasText: expect.screens.length > 0 || review.renderedText.present,
    hasDialogue: dialogue.applicable,
  });
  if (categoryScores.promptCompliance === null) categoryScores.promptCompliance = scores.visualAccuracy;
  if (categoryScores.characterConsistency === null && input.hasCharacters) categoryScores.characterConsistency = scores.characterContinuity;
  if (categoryScores.visualArtefacts === null) categoryScores.visualArtefacts = scores.visualAccuracy;
  if (categoryScores.emotionalPerformance === null) categoryScores.emotionalPerformance = review.emotionalPerformanceMatches ? 85 : 60;
  if (categoryScores.backgroundConsistency === null) categoryScores.backgroundConsistency = scores.storyContinuity;
  const catMean = meanCategoryScore(categoryScores);
  const catValues = CATEGORY_KEYS.map((k) => categoryScores[k]).filter((v): v is number => v !== null);
  if (catMean !== null) overall = Math.min(overall, Math.round(catMean + 12), Math.round(Math.min(...catValues) + 40));
  const reasons: string[] = [];
  const activeBlocking = problems.filter((p) => p.blocking);
  if (settings.ensureCompleteDialogue && !dialogueComplete) {
    overall = Math.min(overall, 55);
    reasons.push('Dialogue is incomplete.');
  }
  if (settings.ensureCompleteAction && !actionComplete && !waived.has('action_incomplete')) {
    overall = Math.min(overall, 60);
    reasons.push('The action does not complete.');
  }
  if (activeBlocking.some((p) => p.severity === 'critical')) overall = Math.min(overall, 40);
  scores.overallUsability = Math.max(0, overall);
  if (overall < settings.minApprovalScore) reasons.push(`Overall usability ${overall} is below the approval threshold of ${settings.minApprovalScore}.`);
  for (const p of activeBlocking) reasons.push(p.description);
  const passed = overall >= settings.minApprovalScore && activeBlocking.length === 0 && (!settings.ensureCompleteDialogue || dialogueComplete) && (!settings.ensureCompleteAction || actionComplete || waived.has('action_incomplete'));
  return { scores, overall, problems, passed, reasons: [...new Set(reasons)], dialogueComplete, actionComplete, categoryScores };
}

// ---------------------------------------------------------------------------
// Repairs
// ---------------------------------------------------------------------------

export const REPAIR_TYPES = [
  'conversational_edit',
  'extend_scene',
  'regenerate_longer',
  'split_into_shots',
  'replace_visuals_keep_audio',
  'cutaway',
  'regenerate_section',
  'trim_ending',
  'regenerate',
  'regenerate_with_references',
  'replace_background',
  'correct_blocking',
  'correct_direction',
  'screen_composite',
  'color_match',
  'reframe',
  'use_other_take',
] as const;
export type RepairType = (typeof REPAIR_TYPES)[number];

export const REPAIR_LABELS: Record<RepairType, string> = {
  conversational_edit: 'Conversational edit (Omni)',
  extend_scene: 'Extend the scene',
  regenerate_longer: 'Regenerate with a longer duration',
  split_into_shots: 'Split into connected shots',
  replace_visuals_keep_audio: 'Replace visuals, keep dialogue audio',
  cutaway: 'Cutaway over continuous dialogue',
  regenerate_section: 'Regenerate the failed section only',
  trim_ending: 'Trim the unwanted ending',
  regenerate: 'Regenerate',
  regenerate_with_references: 'Regenerate with stronger references',
  replace_background: 'Replace only the background',
  correct_blocking: 'Correct character positions (blocking frame)',
  correct_direction: 'Correct the screen direction',
  screen_composite: 'Composite the approved screen content',
  color_match: 'Colour-match the shot',
  reframe: 'Reframe to remove the artefact',
  use_other_take: 'Use a different approved take',
};

/** Repairs that need no new video generation (FFmpeg, compositing or choosing another take). */
export const NON_GENERATIVE_REPAIRS: readonly RepairType[] = ['trim_ending', 'color_match', 'reframe', 'use_other_take', 'screen_composite'];

export interface RepairDecision {
  type: RepairType;
  reason: string;
  /** Instruction for the video model (edit / extension / regeneration direction). */
  instruction: string;
  /** Output seconds for generate/extend repairs. */
  durationSec: number | null;
  /** Section of the current version the repair replaces (cutaway, section, trim). */
  sectionStartSec: number | null;
  sectionEndSec: number | null;
  /** The repaired version keeps the current dialogue audio. */
  keepAudio: boolean;
  /** Extra data for continuity repairs (crop box, take to switch to, screen to composite…). */
  data?: Record<string, unknown> | null;
}

export interface RepairContext {
  /** Other inspected versions/takes of this shot (for "use a different approved take"). */
  alternatives?: { versionId: string; index: number; overall: number | null; passed: boolean; label: string }[];
  /** Protected screens in the shot whose approved content can be composited. */
  compositableScreens?: string[];
  /** Region (0–1 of the frame) of localized artefacts or unwanted text, when known. */
  regions?: { problemId: string; box: { x: number; y: number; w: number; h: number } }[];
  problems: QualityProblem[];
  dialogue: DialogueAnalysis;
  review: Pick<ModelReview, 'recommendedRepair' | 'actions'> | null;
  version: {
    durationSec: number;
    /** An Omni interaction for this version can still be continued (edit/extend). */
    continuable: boolean;
    /** Length of the continuous take this version belongs to (s). */
    chainSec: number;
  };
  expected: { lines: ExpectedLine[]; action: string };
  plan: Pick<DurationPlan, 'requiredSec' | 'breakdown'> | null;
  caps: { minSec: number; maxSec: number; maxChainSec: number };
  previous: { type: RepairType; categories: ProblemCategory[] }[];
}

const ESCALATION: Partial<Record<RepairType, RepairType>> = {
  trim_ending: 'regenerate_section',
  conversational_edit: 'regenerate_with_references',
  cutaway: 'conversational_edit',
  replace_visuals_keep_audio: 'regenerate',
  extend_scene: 'regenerate_longer',
  regenerate_section: 'regenerate_longer',
  regenerate_longer: 'split_into_shots',
  color_match: 'conversational_edit',
  reframe: 'conversational_edit',
  screen_composite: 'regenerate_with_references',
  replace_background: 'regenerate_with_references',
  correct_blocking: 'regenerate_with_references',
  correct_direction: 'correct_blocking',
  regenerate_with_references: 'regenerate',
};

/** Words still to be spoken after a cut-off, quoted for an extension instruction. */
function remainingDialogue(ctx: RepairContext): { speaker: string; text: string } | null {
  const lines = ctx.dialogue.lines;
  const firstIncomplete = lines.find((l) => !l.complete || l.missing.length);
  if (!firstIncomplete) return null;
  const idx = lines.indexOf(firstIncomplete);
  const words = tokenize(firstIncomplete.expected);
  const heard = firstIncomplete.matchedWords;
  const rest = words.slice(Math.min(words.length, heard)).map((w) => w.raw);
  const following = lines.slice(idx + 1).map((l) => `${l.character}: "${l.expected}"`);
  const text = [rest.length ? `"${rest.join(' ')}"` : '', ...following].filter(Boolean).join(' Then ');
  return { speaker: firstIncomplete.character, text };
}

const CONTINUITY_SUFFIX = 'Keep exactly the same characters, faces, wardrobe, hairstyles, props, location, lighting, time of day, camera style and emotional state.';

/**
 * True when the speaker skipped scripted words and then carried on (words missing before the last word
 * that was heard). Continuing the take cannot put those back; a take that simply stopped early can be
 * continued. A word or two may be lost to transcription noise, so small gaps are tolerated.
 */
function skippedMidLine(d: DialogueAnalysis): boolean {
  if (!d.missingWords.length) return false;
  const expected = d.lines.flatMap((l) => tokenize(l.expected).map((w) => w.norm));
  const heard = tokenize(d.detectedText).map((w) => w.norm);
  if (!expected.length || !heard.length) return false;
  const ops = alignWords(expected, heard);
  let lastHeard = -1;
  for (const o of ops) if (o.op === 'match' || o.op === 'substitute') lastHeard = Math.max(lastHeard, o.e);
  const skipped = ops.filter((o) => o.op === 'delete' && o.e < lastHeard).length;
  return skipped > 2;
}

/**
 * Chooses the least destructive repair for the current problems. Returns null when nothing in the
 * repair ladder applies (the scene then fails quality review with the strongest version kept).
 */
export function chooseRepair(ctx: RepairContext): RepairDecision | null {
  const active = ctx.problems.filter((p) => p.blocking && !p.waived);
  if (!active.length) return null;
  const cats = new Set(active.map((p) => p.category));
  const tried = (t: RepairType) => ctx.previous.filter((p) => p.type === t && p.categories.some((c) => cats.has(c))).length;
  const escalate = (t: RepairType): RepairType => {
    let cur: RepairType = t;
    const seen = new Set<RepairType>();
    while (tried(cur) > 0 && !seen.has(cur)) {
      seen.add(cur);
      cur = ESCALATION[cur] ?? 'regenerate';
    }
    return cur;
  };
  const D = ctx.version.durationSec;
  const d = ctx.dialogue;
  const closing = ctx.plan?.breakdown.closingSec ?? 1;
  const hasDialogue = d.applicable;
  const dialogueCats = active.filter((p) => DIALOGUE_CATEGORIES.includes(p.category));
  const actionCats = active.filter((p) => ACTION_CATEGORIES.includes(p.category));
  const visualCats = active.filter((p) => VISUAL_CATEGORIES.includes(p.category) || p.category === 'accidental_scene_change' || p.category === 'emotional_performance');
  const endIssue = cats.has('dialogue_truncated') || cats.has('trailing_room') || cats.has('unfinished_movement') || (cats.has('action_incomplete') && !dialogueCats.some((p) => p.category !== 'trailing_room')) || cats.has('performance_unfinished');
  const canExtendBy = (sec: number) => ctx.version.continuable && ctx.version.chainSec + sec <= ctx.caps.maxChainSec + 1e-6;
  const make = (type: RepairType, reason: string, instruction: string, extra: Partial<RepairDecision> = {}): RepairDecision => ({ type, reason, instruction, durationSec: null, sectionStartSec: null, sectionEndSec: null, keepAudio: false, ...extra });
  const only = (group: readonly ProblemCategory[]) => active.every((p) => group.includes(p.category));

  // 0. The cheapest fixes first: a take that already passes, colour matching, compositing, reframing.
  const better = (ctx.alternatives ?? []).filter((a) => a.passed).sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0))[0];
  if (better && tried('use_other_take') === 0) {
    return make('use_other_take', `${better.label} already passes review (${better.overall ?? '—'}/100), so it replaces this version with no new generation.`, 'Switch to the stronger approved-quality take.', { data: { versionId: better.versionId } });
  }
  if (only(COLOUR_CATEGORIES) && escalate('color_match') === 'color_match') {
    return make('color_match', 'Only colour, exposure or white balance drift: a measured correction matches the shot to the approved reference, with skin tones protected.', 'Colour-match the shot to the approved reference.', { keepAudio: true });
  }
  if (only(TEXT_CATEGORIES) && (ctx.compositableScreens?.length ?? 0) > 0 && escalate('screen_composite') === 'screen_composite') {
    return make('screen_composite', 'Protected screen or sign content is wrong, unreadable or mirrored: the approved content is tracked onto the surface and composited, then re-inspected.', 'Composite the approved content onto the protected surface.', { keepAudio: true, data: { screenIds: ctx.compositableScreens } });
  }
  const regions = (ctx.regions ?? []).filter((r) => active.some((p) => p.id === r.problemId));
  if (regions.length && active.every((p) => regions.some((r) => r.problemId === p.id)) && escalate('reframe') === 'reframe') {
    const crop = cropAvoiding(regions.map((r) => r.box), 0.84);
    if (crop) return make('reframe', 'The fault sits at the edge of the frame, so the shot is reframed with a gentle push-in that removes it.', 'Reframe to remove the artefact.', { keepAudio: true, data: { crop } });
  }

  // 1. Everything worked, but unwanted material follows the completed moment: trim it away (free).
  //    Only after the last word and the last action beat — a trim never cuts into the performance, and
  //    it is not used when the scene's action timing is unknown.
  const beats = ctx.review?.actions ?? [];
  const beatsEnd = Math.max(0, ...beats.map((a) => a.endSec ?? 0));
  const actionTimingKnown = !ctx.expected.action.trim() || (beats.length > 0 && beats.every((a) => a.completed && a.endSec !== null));
  const after = Math.max(d.lastWordEnd ?? 0, beatsEnd);
  const trimAt = actionTimingKnown && after > 0 && active.every((p) => (p.category === 'accidental_scene_change' || p.category === 'visual_artefact' || p.category === 'last_frame') && p.startSec !== null && p.startSec >= after + 0.8) ? Math.min(...active.map((p) => p.startSec!)) - 0.05 : null;
  if (trimAt !== null && trimAt >= ctx.caps.minSec && !cats.has('action_incomplete') && tried('trim_ending') === 0) {
    return make('trim_ending', 'Dialogue and action complete before the faulty ending, so the ending is trimmed away.', 'Trim the shot before the faulty ending.', { sectionStartSec: round3(trimAt), sectionEndSec: D, durationSec: round3(trimAt) });
  }

  // 2. The scene ends too early (cut-off dialogue, no breathing room, unfinished action): extend it —
  //    unless words were skipped mid-line, which continuing the take cannot put back.
  if (endIssue && !(hasDialogue && skippedMidLine(d))) {
    const rest = remainingDialogue(ctx);
    const remainingSpeech = rest ? Math.max(1, tokenize(rest.text).length / 2.6) : 0;
    const actionTail = cats.has('action_incomplete') || cats.has('unfinished_movement') ? 2.5 : 0;
    const extra = Math.min(ctx.caps.maxSec, Math.max(ctx.caps.minSec, Math.ceil(remainingSpeech + closing + actionTail + 0.3)));
    const type = escalate('extend_scene');
    if (type === 'extend_scene' && canExtendBy(extra)) {
      const parts = [
        'Continue this exact scene from its final frame without restarting anything.',
        rest ? `${rest.speaker || 'The speaker'} finishes speaking, continuing from exactly where the audio stops: ${rest.text}. Do not repeat any words already spoken.` : '',
        actionTail ? `Let the unfinished action complete fully on screen: ${ctx.review?.actions.filter((a) => !a.completed).map((a) => a.beat).join('; ') || ctx.expected.action}.` : '',
        `After the final word, hold on the characters for about ${closing} seconds so the moment lands.`,
        CONTINUITY_SUFFIX,
      ];
      return make('extend_scene', rest ? 'The dialogue is cut off before the final words.' : 'The shot ends before the moment or action completes.', parts.filter(Boolean).join(' '), { durationSec: extra });
    }
    // Cannot extend (chain too long / interaction expired): regenerate longer or split.
    return longerOrSplit(ctx, make, escalate);
  }

  // 3. Dialogue wrong in the middle (missing, changed or repeated words, wrong speaker, starts too early).
  if (hasDialogue && dialogueCats.length) return longerOrSplit(ctx, make, escalate);

  // 4. Picture-only problems while the dialogue is fine.
  if (visualCats.length || actionCats.length) {
    const localized = visualCats.filter((p) => p.startSec !== null && p.endSec !== null && p.endSec - p.startSec <= Math.max(3, D * 0.45));
    const allLocalized = visualCats.length > 0 && localized.length === visualCats.length && !actionCats.length;
    const fixes = [...visualCats, ...actionCats].map((p) => p.description).join(' ');
    const suggested = ctx.review?.recommendedRepair?.type;
    if (allLocalized) {
      const start = Math.max(0, Math.min(...localized.map((p) => p.startSec!)) - 0.2);
      const end = Math.min(D, Math.max(...localized.map((p) => p.endSec!)) + 0.2);
      const noSpeechInside = !hasDialogue || d.lines.every((l) => l.start === null || l.end === null || l.end <= start || l.start >= end);
      // Faulty tail without dialogue: regenerate only that section.
      if (end >= D - 0.3 && noSpeechInside && start >= ctx.caps.minSec - 0.5) {
        const t = escalate('regenerate_section');
        if (t === 'regenerate_section') {
          const secs = Math.min(ctx.caps.maxSec, Math.max(ctx.caps.minSec, Math.ceil(D - start + 0.3)));
          return make('regenerate_section', 'Only the ending is faulty; the rest of the scene is kept.', `Continue the scene naturally from this frame for about ${secs} seconds. ${ctx.expected.action ? `Complete the action: ${ctx.expected.action}.` : ''} Avoid: ${fixes} ${CONTINUITY_SUFFIX}`, { sectionStartSec: round3(start), sectionEndSec: D, durationSec: secs });
        }
      }
      // A local fault under continuous dialogue: cut away while the dialogue keeps playing.
      if (hasDialogue && (suggested === 'cutaway' || suggested === 'replace_visuals_keep_audio' || end - start <= D * 0.35)) {
        const t = escalate('cutaway');
        if (t === 'cutaway') {
          const secs = Math.min(ctx.caps.maxSec, Math.max(ctx.caps.minSec, Math.ceil(end - start + 0.5)));
          return make('cutaway', 'A short visual fault is covered by a cutaway while the original dialogue plays on.', `A ${secs}-second cutaway for this scene: a reaction or insert shot that fits the moment (for example a listener’s reaction, hands, or a relevant detail of the setting). No one speaks on camera in this shot and there is no lip movement toward camera. ${CONTINUITY_SUFFIX}`, { sectionStartSec: round3(start), sectionEndSec: round3(end), durationSec: secs, keepAudio: true });
        }
      }
    }
    if (cats.has('accidental_scene_change') || cats.has('sudden_disappearance')) return longerOrSplit(ctx, make, escalate, 'Single continuous shot with no cuts, no scene changes and no one vanishing.');
    const editable = ctx.version.continuable && D <= ctx.caps.maxSec + 0.05;
    const secs = Math.min(ctx.caps.maxSec, Math.max(ctx.caps.minSec, Math.ceil(Math.max(D, ctx.plan?.requiredSec ?? D))));
    // Only the set drifted: replace the background, keep the performance.
    if (visualCats.length && !actionCats.length && visualCats.every((p) => BACKGROUND_CATEGORIES.includes(p.category))) {
      const t = escalate('replace_background');
      if (t === 'replace_background' && D <= ctx.caps.maxSec + 0.05) {
        return make('replace_background', 'Only the background drifts from the Set Bible: it is replaced to match the canonical set while people, performance and timing stay.', `Keep the people, their faces, costumes, performance, dialogue, timing and camera exactly the same. Replace only the background so it matches the reference set exactly (architecture, doors, windows, furniture, wall colours, light direction). Fix: ${fixes} ${CONTINUITY_SUFFIX}`, { keepAudio: true, durationSec: null });
      }
      if (t === 'regenerate_with_references') return make('regenerate_with_references', 'The background still drifts: regenerating with the canonical set view and the previous shot’s final frame as references.', `The set must match the reference views exactly. Fix: ${fixes} ${CONTINUITY_SUFFIX}`, { durationSec: secs });
    }
    // Wrong blocking (occlusion, merging, eyelines, depth order): regenerate from a blocking frame.
    if (active.some((p) => BLOCKING_CATEGORIES.includes(p.category))) {
      const t = escalate('correct_blocking');
      if (t === 'correct_blocking') return make('correct_blocking', 'Characters are blocked incorrectly: a blocking frame is generated from the stage plan and the shot is regenerated from it.', `Blocking must follow the plan exactly — every speaker visible, no one covering another, correct eyelines and depth order. Fix: ${fixes}`, { durationSec: secs });
    }
    // Screen direction reversed or eyelines broken across the cut.
    if (active.some((p) => DIRECTION_CATEGORIES.includes(p.category))) {
      const t = escalate('correct_direction');
      if (t === 'correct_direction') return make('correct_direction', 'Screen direction breaks continuity: the shot is regenerated with the established direction and camera side (a neutral shot can also bridge it).', `Keep the established screen direction and camera side of the line. Fix: ${fixes}`, { durationSec: secs });
      if (t === 'correct_blocking') return make('correct_blocking', 'Screen direction is still wrong: regenerating from a blocking frame that fixes positions and direction.', `Keep the established screen direction. Fix: ${fixes}`, { durationSec: secs });
    }
    // Identity, costume or prop drift: edit when possible, else regenerate with every approved reference.
    if (active.some((p) => CHARACTER_CATEGORIES.includes(p.category) || PROP_CATEGORIES.includes(p.category))) {
      const t = escalate(editable ? 'conversational_edit' : 'regenerate_with_references');
      if (t === 'conversational_edit' && editable) {
        return make('conversational_edit', 'Character or prop continuity is fixed by editing this take conversationally; timing, dialogue and performance stay the same.', `Keep everything about this video identical — the same timing, dialogue, voices, performance, blocking and camera — and fix only this: ${fixes} ${CONTINUITY_SUFFIX}`, { keepAudio: true });
      }
      if (t === 'regenerate_with_references') return make('regenerate_with_references', 'Identity or prop continuity failed: regenerating with every approved character, prop and set reference plus the previous shot’s final frame.', `Match the approved references exactly — faces, age, hair, costumes, accessories and props. Fix: ${fixes}`, { durationSec: secs });
    }
    const t = escalate('conversational_edit');
    // Omni edits videos of up to 10 seconds (it refuses longer ones even inside a stored chain).
    if (t === 'conversational_edit' && ctx.version.continuable && D <= ctx.caps.maxSec + 0.05) {
      return make('conversational_edit', 'Picture problems are fixed by editing this take conversationally; timing, dialogue and performance stay the same.', `Keep everything about this video identical — the same timing, dialogue, voices, performance, blocking and camera — and fix only this: ${fixes} ${CONTINUITY_SUFFIX}`, { keepAudio: true });
    }
    return longerOrSplit(ctx, make, escalate);
  }
  return longerOrSplit(ctx, make, escalate);
}

function longerOrSplit(ctx: RepairContext, make: (t: RepairType, r: string, i: string, e?: Partial<RepairDecision>) => RepairDecision, escalate: (t: RepairType) => RepairType, extraDirection = ''): RepairDecision | null {
  const D = ctx.version.durationSec;
  const required = ctx.plan?.requiredSec ?? D;
  const target = Math.max(Math.ceil(required), Math.ceil(D) + 2);
  const want = escalate('regenerate_longer');
  const direction = [
    ctx.dialogue.applicable ? 'Every scripted word must be spoken exactly as written, in order, at a natural pace, by the correct character; begin after a short breath and hold for about a second after the final word.' : '',
    ctx.expected.action ? `The action must complete fully on screen: ${ctx.expected.action}.` : '',
    extraDirection,
    CONTINUITY_SUFFIX,
  ]
    .filter(Boolean)
    .join(' ');
  if (want === 'regenerate_longer' && target <= ctx.caps.maxSec) {
    return make('regenerate_longer', `Regenerating with a longer planned duration (${target} s) so the scene completes.`, direction, { durationSec: target });
  }
  if (ctx.dialogue.applicable && required > ctx.caps.maxSec) {
    // Only connected shots can hold this scene. A second attempt is allowed (each run is a fresh
    // performance); after that the director decides instead of the loop repeating itself.
    const splitTries = ctx.previous.filter((p) => p.type === 'split_into_shots').length;
    return splitTries < 2 ? make('split_into_shots', 'The scene needs more time than one generation allows, so it is split into connected shots at sentence boundaries.', direction, { durationSec: null }) : null;
  }
  if (want !== 'regenerate' && escalate('regenerate') === 'regenerate') {
    return make('regenerate', 'Regenerating the scene with stronger direction.', direction, { durationSec: Math.min(ctx.caps.maxSec, Math.max(ctx.caps.minSec, Math.ceil(Math.max(D, required)))) });
  }
  if (want === 'regenerate') return make('regenerate', 'Regenerating the scene with stronger direction.', direction, { durationSec: Math.min(ctx.caps.maxSec, Math.max(ctx.caps.minSec, Math.ceil(Math.max(D, required)))) });
  return null;
}

/**
 * Largest centred-as-possible crop (same aspect as the frame, at least `minScale`) that excludes every
 * box. Returns null when no such crop exists (the fault is not near an edge).
 */
export function cropAvoiding(boxes: { x: number; y: number; w: number; h: number }[], minScale = 0.84): { x: number; y: number; w: number; h: number } | null {
  const hits = (c: { x: number; y: number; w: number; h: number }) => boxes.some((b) => b.x < c.x + c.w && b.x + b.w > c.x && b.y < c.y + c.h && b.y + b.h > c.y);
  for (let s = 0.97; s >= minScale - 1e-9; s -= 0.01) {
    const free = 1 - s;
    const options: { x: number; y: number }[] = [];
    for (const fx of [0.5, 0, 1, 0.25, 0.75]) for (const fy of [0.5, 0, 1, 0.25, 0.75]) options.push({ x: free * fx, y: free * fy });
    options.sort((a, b) => Math.hypot(a.x - free / 2, a.y - free / 2) - Math.hypot(b.x - free / 2, b.y - free / 2));
    const ok = options.find((o) => !hits({ x: o.x, y: o.y, w: s, h: s }));
    if (ok) return { x: round3(ok.x), y: round3(ok.y), w: round3(s), h: round3(s) };
  }
  return null;
}

/** Strongest version by overall usability (ties → the more recent). */
export function strongestVersion<T extends { overall: number | null; index: number }>(versions: T[]): T | null {
  const scored = versions.filter((v) => v.overall !== null);
  if (!scored.length) return versions[versions.length - 1] ?? null;
  return scored.reduce((best, v) => (v.overall! > best.overall! || (v.overall === best.overall && v.index > best.index) ? v : best));
}

export function wordsSimilar(a: string, b: string): boolean {
  return wordSimilarity(normalizeWord(a), normalizeWord(b)) >= 0.75;
}
