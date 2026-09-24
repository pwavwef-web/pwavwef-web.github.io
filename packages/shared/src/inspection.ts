import type { ContinuityWarning, ScreenDirection } from './continuity';
import type { DetectedState } from './continuity-state';
import { problemId, type ProblemCategory, type ProblemSeverity, type QualityProblem } from './quality';
import { round3 } from './text-align';

/**
 * Continuity-aware inspection: what the reviewing model reports beyond the scene review (character,
 * background, blocking, direction, text, prop, temporal and first/last-second checks), deterministic
 * measurements of the real file (frame sampling with face/object/text detection, freeze/flicker/decode
 * analysis, colour statistics) and the take-evaluation category scores.
 */

// ---------------------------------------------------------------------------
// Category scores (take evaluation)
// ---------------------------------------------------------------------------

export const CATEGORY_KEYS = [
  'promptCompliance',
  'characterConsistency',
  'backgroundConsistency',
  'blocking',
  'dialogueCompleteness',
  'actionCompleteness',
  'screenDirection',
  'faceVisibility',
  'propContinuity',
  'textOrientation',
  'visualArtefacts',
  'audioQuality',
  'lipSync',
  'emotionalPerformance',
  'editCompatibility',
] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];
export type CategoryScores = Record<CategoryKey, number | null>;

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  promptCompliance: 'Prompt compliance',
  characterConsistency: 'Character consistency',
  backgroundConsistency: 'Background consistency',
  blocking: 'Blocking',
  dialogueCompleteness: 'Dialogue completeness',
  actionCompleteness: 'Action completeness',
  screenDirection: 'Screen direction',
  faceVisibility: 'Face visibility',
  propContinuity: 'Prop continuity',
  textOrientation: 'Text orientation',
  visualArtefacts: 'Visual artefacts',
  audioQuality: 'Audio quality',
  lipSync: 'Lip synchronisation',
  emotionalPerformance: 'Emotional performance',
  editCompatibility: 'Edit compatibility',
};

// ---------------------------------------------------------------------------
// The reviewer's continuity report
// ---------------------------------------------------------------------------

export interface CharacterCheck {
  name: string;
  present: boolean;
  faceMatchesReference: boolean;
  hairMatches: boolean;
  costumeMatches: boolean;
  accessoriesPresent: boolean;
  ageMatches: boolean;
  scaleConsistent: boolean;
  merged: boolean;
  disappears: boolean;
  positionPlausible: boolean;
  speaksWhenExpected: boolean;
  severity: ProblemSeverity;
  note: string;
}

export const BACKGROUND_ASPECTS = ['door_window_moved', 'furniture_moved', 'wall_colour', 'landscape', 'layout_reversed', 'weather', 'lighting_change', 'background_people', 'architecture_mutation', 'duplicate_object', 'location_replaced'] as const;
export type BackgroundAspect = (typeof BACKGROUND_ASPECTS)[number];

export interface BackgroundCheck {
  aspect: BackgroundAspect;
  ok: boolean;
  severity: ProblemSeverity;
  startSec: number | null;
  note: string;
}

export interface OcclusionFinding {
  occluder: string;
  occluded: string;
  faceBlocked: boolean;
  intentional: boolean;
  startSec: number | null;
  endSec: number | null;
  severity: ProblemSeverity;
}

export interface BlockingCheck {
  characterCount: number;
  expectedCount: number;
  faceVisibleDuringDialogue: boolean;
  occlusions: OcclusionFinding[];
  mergedBodies: boolean;
  sameSpace: boolean;
  attachedCharacter: boolean;
  actionHidden: boolean;
  depthOrderCorrect: boolean;
  eyelinesCorrect: boolean;
  speakerBehindOther: boolean;
  walksThrough: boolean;
  screenOrder: string[];
  note: string;
}

export interface DirectionCheck {
  travel: { name: string; direction: ScreenDirection | 'mixed' }[];
  reversal: boolean;
  entryExitCorrect: boolean;
  eyelinesConsistent: boolean;
  sidesSwapped: boolean;
  axisCrossed: boolean;
  vehicleReversal: boolean;
  spatiallyConfusing: boolean;
  note: string;
}

export interface TextCheck {
  surface: string;
  text: string;
  expected: string;
  mirrored: boolean;
  misspelled: boolean;
  readable: boolean;
  logoReversed: boolean;
  interfaceFlipped: boolean;
  distorted: boolean;
  changesBetweenFrames: boolean;
  wrongContent: boolean;
  startSec: number | null;
  note: string;
}

export interface PropCheck {
  name: string;
  present: boolean;
  holder: string;
  hand: 'left' | 'right' | 'both' | 'none';
  status: string;
  appearanceConsistent: boolean;
  teleports: boolean;
  changesHandsWithoutAction: boolean;
  scaleConsistent: boolean;
  duplicated: boolean;
  severity: ProblemSeverity;
  note: string;
}

export const TEMPORAL_KINDS = ['face_instability', 'body_instability', 'hand_quality', 'costume_change', 'background_mutation', 'duplicate_object', 'lighting_flicker', 'texture_flicker', 'camera_jump', 'disappearance', 'physics', 'broken_motion', 'unfinished_action', 'morphing'] as const;
export type TemporalKind = (typeof TEMPORAL_KINDS)[number];

export interface TemporalCheck {
  problems: { kind: TemporalKind; startSec: number | null; endSec: number | null; severity: ProblemSeverity; description: string }[];
  note: string;
}

export interface EdgeCheck {
  dialogueStartsBeforeReady: boolean;
  firstFrameContinues: 'yes' | 'no' | 'not_applicable';
  finalLineComplete: boolean;
  finalActionFinishes: boolean;
  exitComplete: 'yes' | 'no' | 'not_applicable';
  cameraResolves: boolean;
  editRoomSec: number | null;
  note: string;
}

export interface DirectorReview {
  characters: CharacterCheck[];
  background: BackgroundCheck[];
  blocking: BlockingCheck;
  direction: DirectionCheck;
  text: TextCheck[];
  props: PropCheck[];
  temporal: TemporalCheck;
  edges: EdgeCheck;
  detected: DetectedState;
  categoryScores: Partial<CategoryScores>;
}

// Defensive normalisation of model output ----------------------------------------------------------

type R = Record<string, unknown>;
const SEV: ProblemSeverity[] = ['minor', 'major', 'critical'];
const s = (v: unknown) => (typeof v === 'string' ? v.slice(0, 600) : '');
const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const sev = (v: unknown): ProblemSeverity => (SEV.includes(v as ProblemSeverity) ? (v as ProblemSeverity) : 'minor');
const arr = (v: unknown): R[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as R[]) : []);
const obj = (v: unknown): R => (v && typeof v === 'object' && !Array.isArray(v) ? (v as R) : {});
const dir = (v: unknown): ScreenDirection | 'mixed' => (['left_to_right', 'right_to_left', 'toward_camera', 'away_from_camera', 'static', 'mixed'].includes(String(v)) ? (v as ScreenDirection) : 'static');
const score = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.max(0, Math.min(100, Math.round(v))) : null);

export function normalizeDirectorReview(raw: unknown): DirectorReview {
  const r = obj(raw);
  const bl = obj(r.blocking);
  const dr = obj(r.direction);
  const tp = obj(r.temporal);
  const ed = obj(r.edges);
  const det = obj(r.detectedState ?? r.detected);
  const cs = obj(r.categoryScores);
  const categoryScores: Partial<CategoryScores> = {};
  for (const k of CATEGORY_KEYS) {
    const v = score(cs[k]);
    if (v !== null) categoryScores[k] = v;
  }
  return {
    characters: arr(r.characters).map((c) => ({
      name: s(c.name),
      present: b(c.present, true),
      faceMatchesReference: b(c.faceMatchesReference, true),
      hairMatches: b(c.hairMatches, true),
      costumeMatches: b(c.costumeMatches, true),
      accessoriesPresent: b(c.accessoriesPresent, true),
      ageMatches: b(c.ageMatches, true),
      scaleConsistent: b(c.scaleConsistent, true),
      merged: b(c.merged, false),
      disappears: b(c.disappears, false),
      positionPlausible: b(c.positionPlausible, true),
      speaksWhenExpected: b(c.speaksWhenExpected, true),
      severity: sev(c.severity),
      note: s(c.note),
    })),
    background: arr(r.background)
      .filter((x) => (BACKGROUND_ASPECTS as readonly string[]).includes(String(x.aspect)))
      .map((x) => ({ aspect: x.aspect as BackgroundAspect, ok: b(x.ok, true), severity: sev(x.severity), startSec: n(x.startSec), note: s(x.note) })),
    blocking: {
      characterCount: Math.max(0, Math.round(Number(bl.characterCount) || 0)),
      expectedCount: Math.max(0, Math.round(Number(bl.expectedCount) || 0)),
      faceVisibleDuringDialogue: b(bl.faceVisibleDuringDialogue, true),
      occlusions: arr(bl.occlusions).map((o) => ({ occluder: s(o.occluder), occluded: s(o.occluded), faceBlocked: b(o.faceBlocked, false), intentional: b(o.intentional, false), startSec: n(o.startSec), endSec: n(o.endSec), severity: sev(o.severity) })),
      mergedBodies: b(bl.mergedBodies, false),
      sameSpace: b(bl.sameSpace, false),
      attachedCharacter: b(bl.attachedCharacter, false),
      actionHidden: b(bl.actionHidden, false),
      depthOrderCorrect: b(bl.depthOrderCorrect, true),
      eyelinesCorrect: b(bl.eyelinesCorrect, true),
      speakerBehindOther: b(bl.speakerBehindOther, false),
      walksThrough: b(bl.walksThrough, false),
      screenOrder: Array.isArray(bl.screenOrder) ? bl.screenOrder.map((x) => s(x)).filter(Boolean) : [],
      note: s(bl.note),
    },
    direction: {
      travel: arr(dr.travel).map((t) => ({ name: s(t.name), direction: dir(t.direction) })),
      reversal: b(dr.reversal, false),
      entryExitCorrect: b(dr.entryExitCorrect, true),
      eyelinesConsistent: b(dr.eyelinesConsistent, true),
      sidesSwapped: b(dr.sidesSwapped, false),
      axisCrossed: b(dr.axisCrossed, false),
      vehicleReversal: b(dr.vehicleReversal, false),
      spatiallyConfusing: b(dr.spatiallyConfusing, false),
      note: s(dr.note),
    },
    text: arr(r.text).map((t) => ({
      surface: s(t.surface),
      text: s(t.text),
      expected: s(t.expected),
      mirrored: b(t.mirrored, false),
      misspelled: b(t.misspelled, false),
      readable: b(t.readable, true),
      logoReversed: b(t.logoReversed, false),
      interfaceFlipped: b(t.interfaceFlipped, false),
      distorted: b(t.distorted, false),
      changesBetweenFrames: b(t.changesBetweenFrames, false),
      wrongContent: b(t.wrongContent, false),
      startSec: n(t.startSec),
      note: s(t.note),
    })),
    props: arr(r.props).map((p) => ({
      name: s(p.name),
      present: b(p.present, true),
      holder: s(p.holder),
      hand: (['left', 'right', 'both', 'none'].includes(String(p.hand)) ? p.hand : 'none') as PropCheck['hand'],
      status: s(p.status),
      appearanceConsistent: b(p.appearanceConsistent, true),
      teleports: b(p.teleports, false),
      changesHandsWithoutAction: b(p.changesHandsWithoutAction, false),
      scaleConsistent: b(p.scaleConsistent, true),
      duplicated: b(p.duplicated, false),
      severity: sev(p.severity),
      note: s(p.note),
    })),
    temporal: {
      problems: arr(tp.problems)
        .filter((x) => (TEMPORAL_KINDS as readonly string[]).includes(String(x.kind)))
        .map((x) => ({ kind: x.kind as TemporalKind, startSec: n(x.startSec), endSec: n(x.endSec), severity: sev(x.severity), description: s(x.description) })),
      note: s(tp.note),
    },
    edges: {
      dialogueStartsBeforeReady: b(ed.dialogueStartsBeforeReady, false),
      firstFrameContinues: (['yes', 'no', 'not_applicable'].includes(String(ed.firstFrameContinues)) ? ed.firstFrameContinues : 'not_applicable') as EdgeCheck['firstFrameContinues'],
      finalLineComplete: b(ed.finalLineComplete, true),
      finalActionFinishes: b(ed.finalActionFinishes, true),
      exitComplete: (['yes', 'no', 'not_applicable'].includes(String(ed.exitComplete)) ? ed.exitComplete : 'not_applicable') as EdgeCheck['exitComplete'],
      cameraResolves: b(ed.cameraResolves, true),
      editRoomSec: n(ed.editRoomSec),
      note: s(ed.note),
    },
    detected: {
      characters: arr(det.characters).map((c) => ({
        characterId: null,
        name: s(c.name),
        present: b(c.present, true),
        costume: s(c.costume),
        hair: s(c.hair),
        leftHand: s(c.leftHand),
        rightHand: s(c.rightHand),
        posture: s(c.posture),
        screenSide: (['left', 'centre', 'right', 'absent'].includes(String(c.screenSide)) ? c.screenSide : 'centre') as DetectedState['characters'][number]['screenSide'],
        facing: s(c.facing),
        emotion: s(c.emotion),
        matchesReference: b(c.matchesReference, true),
      })),
      props: arr(det.props).map((p) => ({ propId: null, name: s(p.name), present: b(p.present, true), holder: s(p.holder), hand: (['left', 'right', 'both', 'none'].includes(String(p.hand)) ? p.hand : 'none') as DetectedState['props'][number]['hand'], status: s(p.status), condition: s(p.condition) })),
      environment: { timeOfDay: s(obj(det.environment).timeOfDay), weather: s(obj(det.environment).weather), lightDirection: s(obj(det.environment).lightDirection), background: s(obj(det.environment).background) },
      travel: arr(det.travel).map((t) => ({ name: s(t.name), direction: dir(t.direction) })),
    },
    categoryScores,
  };
}

// ---------------------------------------------------------------------------
// Deterministic measurements
// ---------------------------------------------------------------------------

export interface TemporalMeasurements {
  frozen: { start: number; end: number }[];
  /** Duplicate consecutive frames (stutter) as a fraction of all frames. */
  repeatedRatio: number;
  /** Luma oscillation energy (0 = steady; > 0.8 visible flicker). */
  flickerIndex: number;
  /** Sharp picture jumps below the hard-cut threshold (camera jumps). */
  jumps: number[];
  decodeErrors: number;
  frames: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VisionFrame {
  t: number;
  faces: { box: Box; pan: number | null; confidence: number }[];
  people: { box: Box; score: number }[];
  objects: { name: string; box: Box; score: number }[];
  text: { text: string; box: Box | null }[];
}

export interface VisionMeasurements {
  frames: VisionFrame[];
  /** OCR of protected surfaces: the frame as filmed and horizontally flipped. */
  screenText: { screenId: string; expected: string; t: number; normal: string; flipped: string }[];
}

export interface ColourStats {
  r: number;
  g: number;
  b: number;
  luma: number;
  /** Mean of a detected face region (skin) when available. */
  skin: { r: number; g: number; b: number } | null;
}

export interface ColourMeasurements {
  shot: ColourStats | null;
  reference: ColourStats | null;
  previous: ColourStats | null;
}

// Text comparison ---------------------------------------------------------------------------------

export function normText(t: string): string {
  return t
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function levenshtein(a: string, b2: string): number {
  if (a === b2) return 0;
  if (!a.length) return b2.length;
  if (!b2.length) return a.length;
  let prev = Array.from({ length: b2.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b2.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b2[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b2.length]!;
}

/** 0–1 similarity of expected text to OCR text (the expected text may appear inside larger OCR output). */
export function textSimilarity(expected: string, ocr: string): number {
  const e = normText(expected);
  const o = normText(ocr);
  if (!e) return 1;
  if (!o) return 0;
  if (o.includes(e)) return 1;
  // Best window of the OCR text with the expected length.
  const words = o.split(' ');
  const ew = e.split(' ').length;
  let best = 1 - levenshtein(e, o) / Math.max(e.length, o.length);
  for (let i = 0; i < words.length; i++) {
    for (const span of [ew - 1, ew, ew + 1]) {
      if (span < 1) continue;
      const w = words.slice(i, i + span).join(' ');
      best = Math.max(best, 1 - levenshtein(e, w) / Math.max(e.length, w.length));
    }
  }
  return Math.max(0, Math.min(1, best));
}

export type OrientationVerdict = 'correct' | 'mirrored' | 'misspelled' | 'unreadable';

/** Reads OCR of a frame and of its mirror image: mirrored writing only becomes readable when flipped. */
export function textOrientation(expected: string, normal: string, flipped: string): { verdict: OrientationVerdict; normal: number; flipped: number } {
  const a = textSimilarity(expected, normal);
  const f = textSimilarity(expected, flipped);
  if (a >= 0.82) return { verdict: 'correct', normal: round3(a), flipped: round3(f) };
  if (f >= 0.7 && f > a + 0.15) return { verdict: 'mirrored', normal: round3(a), flipped: round3(f) };
  if (a >= 0.45) return { verdict: 'misspelled', normal: round3(a), flipped: round3(f) };
  return { verdict: 'unreadable', normal: round3(a), flipped: round3(f) };
}

// Tracking ----------------------------------------------------------------------------------------

/** Screen travel of the main subject from person boxes over time (largest person per frame). */
export function trackDirection(frames: VisionFrame[]): { direction: ScreenDirection | 'mixed'; dx: number; samples: number } {
  const pts = frames
    .map((f) => {
      const p = [...f.people].sort((a, c) => c.box.w * c.box.h - a.box.w * a.box.h)[0];
      return p ? { t: f.t, x: p.box.x + p.box.w / 2, size: p.box.h } : null;
    })
    .filter((x): x is { t: number; x: number; size: number } => Boolean(x));
  if (pts.length < 3) return { direction: 'static', dx: 0, samples: pts.length };
  const first = pts.slice(0, Math.max(1, Math.floor(pts.length / 3)));
  const last = pts.slice(-Math.max(1, Math.floor(pts.length / 3)));
  const mean = (xs: number[]) => xs.reduce((a, c) => a + c, 0) / xs.length;
  const dx = mean(last.map((p) => p.x)) - mean(first.map((p) => p.x));
  const ds = mean(last.map((p) => p.size)) - mean(first.map((p) => p.size));
  // Consistency: most steps move the same way.
  let pos = 0;
  let neg = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i]!.x - pts[i - 1]!.x;
    if (d > 0.01) pos++;
    else if (d < -0.01) neg++;
  }
  if (Math.abs(dx) >= 0.12) {
    if (Math.min(pos, neg) > Math.max(pos, neg) * 0.6) return { direction: 'mixed', dx: round3(dx), samples: pts.length };
    return { direction: dx > 0 ? 'left_to_right' : 'right_to_left', dx: round3(dx), samples: pts.length };
  }
  if (Math.abs(ds) >= 0.12) return { direction: ds > 0 ? 'toward_camera' : 'away_from_camera', dx: round3(dx), samples: pts.length };
  return { direction: 'static', dx: round3(dx), samples: pts.length };
}

/** Flicker: energy of frame-to-frame luma changes that immediately reverse (oscillation, not motion). */
export function flickerIndex(yavg: number[]): number {
  if (yavg.length < 5) return 0;
  let osc = 0;
  let count = 0;
  for (let i = 2; i < yavg.length; i++) {
    const d1 = yavg[i - 1]! - yavg[i - 2]!;
    const d2 = yavg[i]! - yavg[i - 1]!;
    if (Math.sign(d1) !== Math.sign(d2) && Math.abs(d1) > 0.6 && Math.abs(d2) > 0.6) osc += Math.min(Math.abs(d1), Math.abs(d2));
    count++;
  }
  return round3(osc / Math.max(1, count));
}

// Colour ------------------------------------------------------------------------------------------

function srgbToLab(r: number, g: number, b2: number): { L: number; a: number; b: number } {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b2);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return { L: 116 * f(Y) - 16, a: 500 * (f(X) - f(Y)), b: 200 * (f(Y) - f(Z)) };
}

export function colourDrift(a: ColourStats, ref: ColourStats): { deltaE: number; exposure: number; whiteBalance: number; skinHueShift: number | null } {
  const la = srgbToLab(a.r, a.g, a.b);
  const lb = srgbToLab(ref.r, ref.g, ref.b);
  const deltaE = Math.hypot(la.L - lb.L, la.a - lb.a, la.b - lb.b);
  const whiteBalance = Math.hypot(la.a - lb.a, la.b - lb.b);
  let skinHueShift: number | null = null;
  if (a.skin && ref.skin) {
    const sa = srgbToLab(a.skin.r, a.skin.g, a.skin.b);
    const sb = srgbToLab(ref.skin.r, ref.skin.g, ref.skin.b);
    const ha = (Math.atan2(sa.b, sa.a) * 180) / Math.PI;
    const hb = (Math.atan2(sb.b, sb.a) * 180) / Math.PI;
    skinHueShift = round3(Math.abs((((ha - hb) % 360) + 540) % 360 - 180));
  }
  return { deltaE: round3(deltaE), exposure: round3(la.L - lb.L), whiteBalance: round3(whiteBalance), skinHueShift };
}

// ---------------------------------------------------------------------------
// Expectations the inspection checks against
// ---------------------------------------------------------------------------

export interface InspectionExpectations {
  /** Characters expected on screen (names) and who speaks. */
  characters: { id: string; name: string; speaking: boolean; mustShowFace: boolean }[];
  /** Expected travel per character (from the blocking plan / established direction). */
  travel: { id: string; name: string; direction: ScreenDirection }[];
  screens: { id: string; name: string; expectedText: string; mayMirror: boolean; composite: boolean }[];
  /** Time spans with dialogue (s), for face-visibility checks. */
  dialogueWindows: { start: number; end: number; speaker: string }[];
  /** Colour drift is expected here (night scene, flashback…). */
  intentionalLook: boolean;
  /** Plan-time continuity warnings still open for this shot. */
  planWarnings: ContinuityWarning[];
}

export function emptyExpectations(): InspectionExpectations {
  return { characters: [], travel: [], screens: [], dialogueWindows: [], intentionalLook: false, planWarnings: [] };
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

const P = (category: ProblemCategory, severity: ProblemSeverity, description: string, source: QualityProblem['source'], startSec: number | null = null, endSec: number | null = null): QualityProblem => ({ id: problemId(category), category, severity, startSec, endSec, description, source, blocking: false });

/** Problems measured on the file itself (never a model's impression). */
export function measuredContinuityProblems(input: { temporal: TemporalMeasurements | null; vision: VisionMeasurements | null; colour: ColourMeasurements | null; expect: InspectionExpectations; durationSec: number }): QualityProblem[] {
  const out: QualityProblem[] = [];
  const t = input.temporal;
  if (t) {
    for (const f of t.frozen) {
      if (f.end - f.start < 0.35) continue;
      if (f.end >= input.durationSec - 0.1) continue; // a held final frame is judged by the edge checks
      out.push(P('frozen_frames', f.end - f.start > 1 ? 'major' : 'minor', `The picture freezes from ${f.start.toFixed(1)} s to ${f.end.toFixed(1)} s.`, 'measured', f.start, f.end));
    }
    if (t.repeatedRatio > 0.06) out.push(P('repeated_frames', t.repeatedRatio > 0.15 ? 'major' : 'minor', `${Math.round(t.repeatedRatio * 100)}% of frames repeat the previous frame (stutter).`, 'measured'));
    if (t.flickerIndex > 0.8) out.push(P('lighting_flicker', t.flickerIndex > 2 ? 'major' : 'minor', `Brightness flickers (oscillation index ${t.flickerIndex.toFixed(2)}).`, 'measured'));
    for (const j of t.jumps.slice(0, 3)) out.push(P('camera_jump', 'minor', `Sudden picture jump at ${j.toFixed(1)} s.`, 'measured', j, j));
    if (t.decodeErrors > 0) out.push(P('corrupted_frames', t.decodeErrors > 3 ? 'critical' : 'major', `${t.decodeErrors} frame(s) failed to decode (corrupted data).`, 'measured'));
  }
  const v = input.vision;
  if (v) {
    for (const st of v.screenText) {
      const exp = input.expect.screens.find((x) => x.id === st.screenId);
      if (!exp || !st.expected.trim()) continue;
      const o = textOrientation(st.expected, st.normal, st.flipped);
      if (o.verdict === 'mirrored' && !exp.mayMirror) out.push(P('mirrored_text', 'critical', `“${exp.name}” is mirrored at ${st.t.toFixed(1)} s: its text only reads correctly when the frame is flipped (${Math.round(o.flipped * 100)}% vs ${Math.round(o.normal * 100)}%).`, 'measured', st.t, st.t));
      else if (o.verdict === 'misspelled') out.push(P('misspelled_text', 'major', `“${exp.name}” reads “${st.normal.slice(0, 60)}” instead of “${st.expected.slice(0, 60)}” (${Math.round(o.normal * 100)}% match).`, 'measured', st.t, st.t));
      else if (o.verdict === 'unreadable') out.push(P('wrong_screen_content', exp.composite ? 'minor' : 'major', `“${exp.name}” is not readable at ${st.t.toFixed(1)} s${exp.composite ? ' (it will be composited)' : ''}.`, 'measured', st.t, st.t));
    }
    // Faces during dialogue: every speaker who must show their face should be detectable.
    const speakers = input.expect.characters.filter((c) => c.speaking && c.mustShowFace);
    if (speakers.length && input.expect.dialogueWindows.length && v.frames.length) {
      const inDialogue = v.frames.filter((f) => input.expect.dialogueWindows.some((w) => f.t >= w.start - 0.1 && f.t <= w.end + 0.1));
      if (inDialogue.length >= 2) {
        const short = inDialogue.filter((f) => f.faces.filter((x) => x.confidence >= 0.5).length < Math.min(speakers.length, input.expect.characters.filter((c) => c.mustShowFace).length));
        const ratio = short.length / inDialogue.length;
        if (ratio >= 0.5) out.push(P('face_hidden', ratio >= 0.8 ? 'major' : 'minor', `Fewer faces than speakers are visible for ${Math.round(ratio * 100)}% of the dialogue (expected ${speakers.map((x) => x.name).join(', ')}).`, 'measured', short[0]?.t ?? null, short[short.length - 1]?.t ?? null));
      }
    }
    // Direction of travel against the plan.
    if (input.expect.travel.length === 1) {
      const tr = trackDirection(v.frames);
      const want = input.expect.travel[0]!;
      const lateral = (d: string) => d === 'left_to_right' || d === 'right_to_left';
      if (lateral(want.direction) && lateral(tr.direction) && tr.direction !== want.direction) {
        out.push(P('direction_reversal', 'major', `${want.name} travels ${tr.direction.replace(/_/g, ' ')} on screen; the scene established ${want.direction.replace(/_/g, ' ')} (tracked over ${tr.samples} frames).`, 'measured'));
      }
    }
    // More people than planned (a character added, duplicated or split).
    const expectedPeople = input.expect.characters.length;
    if (expectedPeople > 0 && v.frames.length >= 3) {
      const counts = v.frames.map((f) => Math.max(f.people.filter((p) => p.score >= 0.6).length, f.faces.filter((x) => x.confidence >= 0.6).length)).sort((a, c) => a - c);
      const median = counts[Math.floor(counts.length / 2)]!;
      if (median > expectedPeople + 1) out.push(P('character_count', 'major', `About ${median} people are visible; the shot plans ${expectedPeople}.`, 'measured'));
    }
  }
  const c = input.colour;
  if (c?.shot && !input.expect.intentionalLook) {
    const ref = c.reference ?? c.previous;
    if (ref) {
      const d = colourDrift(c.shot, ref);
      const against = c.reference ? 'the approved reference still' : 'the previous shot';
      if (d.whiteBalance > 12) out.push(P('white_balance', d.whiteBalance > 22 ? 'major' : 'minor', `White balance drifts from ${against} (Δab ${d.whiteBalance.toFixed(1)}).`, 'measured'));
      if (Math.abs(d.exposure) > 18) out.push(P('exposure_mismatch', Math.abs(d.exposure) > 30 ? 'major' : 'minor', `Exposure differs from ${against} (ΔL ${d.exposure.toFixed(1)}).`, 'measured'));
      if (d.skinHueShift !== null && d.skinHueShift > 12) out.push(P('skin_tone', d.skinHueShift > 22 ? 'major' : 'minor', `Skin tones shift ${d.skinHueShift.toFixed(0)}° in hue from ${against}.`, 'measured'));
      else if (d.deltaE > 25 && d.whiteBalance <= 12 && Math.abs(d.exposure) <= 18) out.push(P('colour_drift', 'minor', `Overall colour differs from ${against} (ΔE ${d.deltaE.toFixed(1)}).`, 'measured'));
    }
  }
  return out;
}

const BG_CATEGORY: Record<BackgroundAspect, ProblemCategory> = {
  door_window_moved: 'door_window_moved',
  furniture_moved: 'furniture_moved',
  wall_colour: 'wall_colour',
  landscape: 'landscape',
  layout_reversed: 'layout_reversed',
  weather: 'weather',
  lighting_change: 'lighting_change',
  background_people: 'background_people',
  architecture_mutation: 'architecture_mutation',
  duplicate_object: 'duplicate_object',
  location_replaced: 'location_replaced',
};

const TEMPORAL_CATEGORY: Record<TemporalKind, ProblemCategory> = {
  face_instability: 'face_instability',
  body_instability: 'body_instability',
  hand_quality: 'hand_quality',
  costume_change: 'costume',
  background_mutation: 'background_drift',
  duplicate_object: 'duplicate_object',
  lighting_flicker: 'lighting_flicker',
  texture_flicker: 'texture_flicker',
  camera_jump: 'camera_jump',
  disappearance: 'sudden_disappearance',
  physics: 'physics',
  broken_motion: 'broken_motion',
  unfinished_action: 'action_incomplete',
  morphing: 'morphing',
};

/** Problems the reviewing model reports in its continuity sections. */
export function directorProblems(d: DirectorReview, expect: InspectionExpectations): QualityProblem[] {
  const out: QualityProblem[] = [];
  const add = (category: ProblemCategory, severity: ProblemSeverity, description: string, startSec: number | null = null, endSec: number | null = null) => {
    if (!out.some((p) => p.category === category && p.description === description)) out.push(P(category, severity, description, 'model', startSec, endSec));
  };
  for (const c of d.characters) {
    const sv = c.severity === 'minor' ? 'major' : c.severity;
    if (!c.present && expect.characters.some((x) => x.name.toLowerCase() === c.name.toLowerCase())) add('character_disappears', 'critical', `${c.name} is missing from the shot. ${c.note}`.trim());
    if (!c.faceMatchesReference) add('face_change', sv, `${c.name}’s face does not match the approved reference. ${c.note}`.trim());
    if (!c.hairMatches) add('hairstyle', 'major', `${c.name}’s hair differs from the reference. ${c.note}`.trim());
    if (!c.costumeMatches) add('costume', 'major', `${c.name}’s costume differs from the plan. ${c.note}`.trim());
    if (!c.accessoriesPresent) add('missing_accessory', 'major', `${c.name} is missing an accessory. ${c.note}`.trim());
    if (!c.ageMatches) add('wrong_age', 'major', `${c.name} looks a different age than the bible. ${c.note}`.trim());
    if (!c.scaleConsistent) add('scale_change', 'major', `${c.name}’s size changes relative to the scene. ${c.note}`.trim());
    if (c.merged) add('character_merge', 'critical', `${c.name} merges with another person. ${c.note}`.trim());
    if (c.disappears && c.present) add('character_disappears', 'critical', `${c.name} disappears during the shot. ${c.note}`.trim());
    if (!c.positionPlausible) add('impossible_position', 'major', `${c.name} is in an impossible position. ${c.note}`.trim());
  }
  for (const g of d.background) if (!g.ok) add(BG_CATEGORY[g.aspect], g.severity === 'minor' && (g.aspect === 'location_replaced' || g.aspect === 'layout_reversed') ? 'major' : g.severity, `${g.aspect.replace(/_/g, ' ')}: ${g.note}`, g.startSec, null);
  const bl = d.blocking;
  if (bl.expectedCount > 0 && bl.characterCount !== bl.expectedCount) add('character_count', Math.abs(bl.characterCount - bl.expectedCount) > 1 ? 'critical' : 'major', `${bl.characterCount} people on screen; ${bl.expectedCount} expected.`);
  for (const o of bl.occlusions) if (!o.intentional) add(o.faceBlocked ? 'occlusion' : 'action_hidden', o.faceBlocked && expect.characters.some((c) => c.speaking && c.name.toLowerCase() === o.occluded.toLowerCase()) ? 'critical' : o.severity, `${o.occluder} blocks ${o.occluded}${o.faceBlocked ? '’s face' : ''}.`, o.startSec, o.endSec);
  if (!bl.faceVisibleDuringDialogue && expect.dialogueWindows.length) add('face_hidden', 'major', 'A speaker’s face is hidden during their dialogue.');
  if (bl.mergedBodies) add('bodies_merge', 'critical', `Bodies merge. ${bl.note}`.trim());
  if (bl.sameSpace) add('same_space', 'critical', `Two people occupy the same space. ${bl.note}`.trim());
  if (bl.attachedCharacter) add('attached_character', 'major', 'A background person appears attached to a foreground person.');
  if (bl.actionHidden) add('action_hidden', 'major', 'The important action is hidden from the camera.');
  if (!bl.depthOrderCorrect) add('depth_order', 'major', 'Characters are in the wrong depth order.');
  if (!bl.eyelinesCorrect) add('wrong_eyeline', 'major', 'A character looks at the wrong person or place.');
  if (bl.speakerBehindOther) add('speaker_blocked', 'critical', 'A speaker is placed behind an unrelated character.');
  if (bl.walksThrough) add('walk_through', 'critical', 'A character walks through furniture or another person.');
  const dr = d.direction;
  if (dr.reversal) add('direction_reversal', 'major', `Travel direction reverses. ${dr.note}`.trim());
  if (!dr.entryExitCorrect) add('entry_exit_side', 'major', 'Entry or exit is on the wrong side of frame.');
  if (!dr.eyelinesConsistent) add('broken_eyeline', 'major', 'Conversation eyelines do not match.');
  if (dr.sidesSwapped) add('side_swap', 'critical', 'Characters swap sides of the frame during the conversation.');
  if (dr.axisCrossed) add('axis_crossing', 'major', 'The camera crosses the 180-degree line.');
  if (dr.vehicleReversal) add('vehicle_direction', 'major', 'A vehicle changes travel direction.');
  if (dr.spatiallyConfusing) add('spatial_confusion', 'major', `Movement is spatially confusing. ${dr.note}`.trim());
  for (const t of d.text) {
    const exp = expect.screens.find((x) => x.name.toLowerCase() === t.surface.toLowerCase() || (x.expectedText && t.expected && x.expectedText.toLowerCase() === t.expected.toLowerCase()));
    const canMirror = exp?.mayMirror ?? false;
    if (t.mirrored && !canMirror) add('mirrored_text', 'critical', `Mirrored writing on the ${t.surface || 'surface'}: “${t.text}”.`, t.startSec);
    if (t.logoReversed && !canMirror) add('reversed_logo', 'critical', `Reversed logo on the ${t.surface || 'surface'}.`, t.startSec);
    if (t.interfaceFlipped && !canMirror) add('flipped_interface', 'critical', `The ${t.surface || 'screen'} interface is horizontally flipped.`, t.startSec);
    if (t.misspelled) add('misspelled_text', exp ? 'major' : 'minor', `Misspelled text on the ${t.surface || 'surface'}: “${t.text}”${t.expected ? ` (expected “${t.expected}”)` : ''}.`, t.startSec);
    if (t.distorted) add('distorted_ui', 'major', `Distorted interface/text on the ${t.surface || 'surface'}.`, t.startSec);
    if (t.changesBetweenFrames) add('text_flicker', 'major', `Text on the ${t.surface || 'surface'} changes between frames.`, t.startSec);
    if (t.wrongContent) add('wrong_screen_content', exp && !exp.composite ? 'major' : 'minor', `Wrong content on the ${t.surface || 'screen'}.`, t.startSec);
  }
  for (const p of d.props) {
    if (!p.present) add('prop_missing', p.severity === 'minor' ? 'major' : p.severity, `${p.name} is missing. ${p.note}`.trim());
    if (!p.appearanceConsistent) add('prop_appearance', 'major', `${p.name} changes appearance. ${p.note}`.trim());
    if (p.teleports) add('prop_teleport', 'major', `${p.name} jumps to another place. ${p.note}`.trim());
    if (p.changesHandsWithoutAction) add('prop_hand', 'critical', `${p.name} changes hands with no action. ${p.note}`.trim());
    if (!p.scaleConsistent) add('prop_scale', 'major', `${p.name} changes size. ${p.note}`.trim());
    if (p.duplicated) add('duplicate_prop', 'major', `${p.name} appears twice. ${p.note}`.trim());
  }
  for (const x of d.temporal.problems) add(TEMPORAL_CATEGORY[x.kind], x.severity, x.description || x.kind.replace(/_/g, ' '), x.startSec, x.endSec);
  const e = d.edges;
  if (e.dialogueStartsBeforeReady) add('early_dialogue_start', 'major', 'Dialogue starts before the actor is ready (no breath, mid-movement).', 0, 1);
  if (e.firstFrameContinues === 'no') add('first_frame_mismatch', 'major', 'The first frame does not continue from the previous shot.', 0, 0.5);
  if (!e.finalLineComplete) add('final_line_incomplete', 'critical', 'The final line is not delivered completely.');
  if (!e.finalActionFinishes) add('final_action_incomplete', 'major', 'The final action does not finish.');
  if (e.exitComplete === 'no') add('exit_incomplete', 'major', 'The character does not complete their exit.');
  if (!e.cameraResolves) add('camera_unresolved', 'minor', 'The camera move does not resolve before the end.');
  if (e.editRoomSec !== null && e.editRoomSec < 0.4) add('no_edit_room', 'minor', `Only ${e.editRoomSec.toFixed(1)} s of usable room at the end for the edit.`);
  return out;
}

// ---------------------------------------------------------------------------
// Category scores
// ---------------------------------------------------------------------------

export function computeCategoryScores(input: {
  model: Partial<CategoryScores>;
  dialogueScore: number | null;
  actionScore: number | null;
  audioScore: number | null;
  lipSync: 'none' | 'minor' | 'severe' | null;
  problems: QualityProblem[];
  hasText: boolean;
  hasDialogue: boolean;
}): CategoryScores {
  const out = {} as CategoryScores;
  for (const k of CATEGORY_KEYS) out[k] = input.model[k] ?? null;
  out.dialogueCompleteness = input.hasDialogue ? input.dialogueScore : null;
  out.actionCompleteness = input.actionScore;
  out.audioQuality = input.audioScore;
  if (!input.hasDialogue) out.lipSync = null;
  else if (out.lipSync === null && input.lipSync) out.lipSync = input.lipSync === 'none' ? 90 : input.lipSync === 'minor' ? 70 : 35;
  if (!input.hasText && out.textOrientation === null) out.textOrientation = null;
  // Measured and blocking problems cap the category they belong to.
  const cap = (k: CategoryKey, cats: ProblemCategory[], critical: number, major: number) => {
    const hits = input.problems.filter((p) => cats.includes(p.category) && !p.waived);
    if (!hits.length) return;
    const limit = hits.some((p) => p.severity === 'critical') ? critical : hits.some((p) => p.severity === 'major') ? major : 80;
    out[k] = Math.min(out[k] ?? 100, limit);
  };
  cap('characterConsistency', ['face_change', 'character_identity', 'hairstyle', 'costume', 'missing_accessory', 'wrong_age', 'character_count', 'character_merge', 'character_disappears', 'scale_change', 'impossible_position', 'wrong_speaker'], 30, 55);
  cap('backgroundConsistency', ['background_drift', 'door_window_moved', 'furniture_moved', 'wall_colour', 'landscape', 'layout_reversed', 'weather', 'lighting_change', 'background_people', 'architecture_mutation', 'duplicate_object', 'location_replaced', 'location', 'time_of_day'], 30, 55);
  cap('blocking', ['occlusion', 'bodies_merge', 'same_space', 'attached_character', 'action_hidden', 'depth_order', 'wrong_eyeline', 'speaker_blocked', 'walk_through'], 30, 55);
  cap('screenDirection', ['direction_reversal', 'entry_exit_side', 'broken_eyeline', 'side_swap', 'axis_crossing', 'vehicle_direction', 'spatial_confusion', 'screen_direction'], 30, 55);
  cap('faceVisibility', ['face_hidden', 'occlusion', 'speaker_blocked'], 35, 60);
  cap('propContinuity', ['prop_appearance', 'prop_hand', 'prop_teleport', 'prop_state', 'prop_missing', 'prop_scale', 'duplicate_prop', 'props'], 30, 55);
  cap('textOrientation', ['mirrored_text', 'reversed_logo', 'flipped_interface', 'misspelled_text', 'distorted_ui', 'text_flicker', 'wrong_screen_content', 'rendered_text'], 15, 50);
  cap('visualArtefacts', ['visual_artefact', 'face_instability', 'body_instability', 'hand_quality', 'texture_flicker', 'lighting_flicker', 'camera_jump', 'physics', 'broken_motion', 'morphing', 'repeated_frames', 'frozen_frames', 'corrupted_frames'], 30, 60);
  cap('editCompatibility', ['no_edit_room', 'camera_unresolved', 'first_frame_mismatch', 'accidental_scene_change', 'trailing_room', 'early_dialogue_start', 'exit_incomplete'], 40, 65);
  return out;
}

export function meanCategoryScore(scores: CategoryScores): number | null {
  const vals = CATEGORY_KEYS.map((k) => scores[k]).filter((v): v is number => v !== null);
  return vals.length ? Math.round(vals.reduce((a, c) => a + c, 0) / vals.length) : null;
}

/** Ranks takes: passing first, then overall score, then the weakest category (fewest weak spots). */
export function rankTakes<T extends { passed: boolean; overall: number | null; categoryScores?: CategoryScores | null; index: number }>(takes: T[]): T[] {
  const weakest = (t: T) => {
    const v = t.categoryScores ? CATEGORY_KEYS.map((k) => t.categoryScores![k]).filter((x): x is number => x !== null) : [];
    return v.length ? Math.min(...v) : 0;
  };
  return [...takes].sort((a, c) => Number(c.passed) - Number(a.passed) || (c.overall ?? -1) - (a.overall ?? -1) || weakest(c) - weakest(a) || a.index - c.index);
}
