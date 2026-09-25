import type { Time } from './types';

/**
 * Continuity Director — the structured memory of a film or music-video project.
 *
 *   Visual Bible ─┐
 *   Character Bibles ─┤   per shot: continuityBefore → plannedState → (generate, inspect) →
 *   Set Bibles ───────┤             continuityAfter (detected) → approvedState (only on approval)
 *   Prop Ledger ──────┘
 *
 * Everything here is data, never a long prompt: prompts are compiled from it (continuity-prompt.ts),
 * inspections compare generated media with it (quality.ts) and only an approved shot may update the
 * canonical state (functions/src/lib/continuity.ts).
 */

// ---------------------------------------------------------------------------
// Constraint levels
// ---------------------------------------------------------------------------

export const CONSTRAINT_LEVELS = ['locked', 'preferred', 'flexible', 'scene_specific'] as const;
export type ConstraintLevel = (typeof CONSTRAINT_LEVELS)[number];

export const CONSTRAINT_LEVEL_LABELS: Record<ConstraintLevel, string> = {
  locked: 'Locked',
  preferred: 'Preferred',
  flexible: 'Flexible',
  scene_specific: 'Scene-specific',
};

export const CONSTRAINT_LEVEL_HELP: Record<ConstraintLevel, string> = {
  locked: 'Must hold in every shot. Sent as a protected constraint and checked by the reviewer.',
  preferred: 'Sent as direction in every shot; small deviations are reported but do not fail a take.',
  flexible: 'Kept in the bible for reference only; not sent to the video model.',
  scene_specific: 'Applies only to the scenes you choose.',
};

// ---------------------------------------------------------------------------
// Visual Bible
// ---------------------------------------------------------------------------

export const VISUAL_BIBLE_KEYS = [
  'overallStyle',
  'colourPalette',
  'contrast',
  'filmGrain',
  'cameraLanguage',
  'lensPreferences',
  'lightingStyle',
  'aspectRatio',
  'frameRate',
  'compositionRules',
  'culturalContext',
  'historicalPeriod',
  'architecture',
  'materials',
  'prohibited',
] as const;
export type VisualBibleKey = (typeof VISUAL_BIBLE_KEYS)[number];

export const VISUAL_BIBLE_LABELS: Record<VisualBibleKey, string> = {
  overallStyle: 'Overall visual style',
  colourPalette: 'Colour palette',
  contrast: 'Contrast',
  filmGrain: 'Film grain',
  cameraLanguage: 'Camera language',
  lensPreferences: 'Lens preferences',
  lightingStyle: 'Lighting style',
  aspectRatio: 'Aspect ratio',
  frameRate: 'Frame rate',
  compositionRules: 'Composition rules',
  culturalContext: 'Cultural context',
  historicalPeriod: 'Historical period',
  architecture: 'Architecture',
  materials: 'Materials and textures',
  prohibited: 'Prohibited visual elements',
};

/** Prompt phrasing per key (how a constraint reads when compiled into direction). */
export const VISUAL_BIBLE_PROMPT: Record<VisualBibleKey, string> = {
  overallStyle: 'Visual style',
  colourPalette: 'Colour palette',
  contrast: 'Contrast',
  filmGrain: 'Film grain and texture',
  cameraLanguage: 'Camera language',
  lensPreferences: 'Lenses',
  lightingStyle: 'Lighting',
  aspectRatio: 'Framing for aspect ratio',
  frameRate: 'Motion cadence',
  compositionRules: 'Composition',
  culturalContext: 'Cultural context (portray authentically)',
  historicalPeriod: 'Period',
  architecture: 'Architecture',
  materials: 'Materials and textures',
  prohibited: 'Never show',
};

export interface BibleEntry {
  value: string;
  level: ConstraintLevel;
  /** Scenes this entry applies to when `level` is scene_specific. */
  sceneIds: string[];
}

/** Colour Director targets (approved look). */
export interface ColourDirection {
  referenceAssetId: string | null;
  palette: string[];
  /** Skin-tone target in plain words, e.g. "warm, natural deep brown skin; never grey or orange". */
  skinTone: string;
  /** Target white balance in kelvin (null = match the reference still). */
  whiteBalanceK: number | null;
  contrast: 'low' | 'medium' | 'high' | null;
  saturation: 'muted' | 'natural' | 'rich' | null;
  grain: 'none' | 'fine' | 'medium' | 'heavy' | null;
  highlightRollOff: 'soft' | 'medium' | 'hard' | null;
  shadowTreatment: 'lifted' | 'neutral' | 'crushed' | null;
  look: 'day' | 'night' | 'dusk' | 'interior' | null;
  /** Optional creative LUT (.cube document asset) applied at a set strength. */
  lutAssetId: string | null;
  lutStrength: number;
  approvedAt: number | null;
}

export const EMPTY_COLOUR: ColourDirection = {
  referenceAssetId: null,
  palette: [],
  skinTone: '',
  whiteBalanceK: null,
  contrast: null,
  saturation: null,
  grain: null,
  highlightRollOff: null,
  shadowTreatment: null,
  look: null,
  lutAssetId: null,
  lutStrength: 0.6,
  approvedAt: null,
};

export interface VisualBibleDoc {
  id: string;
  entries: Partial<Record<VisualBibleKey, BibleEntry>>;
  referenceAssetIds: string[];
  /** Lookbook images the director approved as the reference of record. */
  lookbookAssetIds: string[];
  colour: ColourDirection;
  approvedAt: number | null;
  version: number;
  /** The version every generation inherits, frozen at approval (draft edits reach no shot until approved). */
  approved?: { entries: Partial<Record<VisualBibleKey, BibleEntry>>; lookbookAssetIds: string[]; colour: ColourDirection; approvedAt: number; version: number } | null;
  updatedAt?: Time;
}

export const VISUAL_BIBLE_ID = 'main';

export function emptyVisualBible(): VisualBibleDoc {
  return { id: VISUAL_BIBLE_ID, entries: {}, referenceAssetIds: [], lookbookAssetIds: [], colour: { ...EMPTY_COLOUR }, approvedAt: null, version: 0 };
}

/** Entries that apply to a scene, split by how strictly they are enforced. */
export function applicableBibleEntries(bible: Pick<VisualBibleDoc, 'entries'> | null | undefined, sceneId: string | null): { key: VisualBibleKey; entry: BibleEntry; enforced: boolean }[] {
  if (!bible) return [];
  const out: { key: VisualBibleKey; entry: BibleEntry; enforced: boolean }[] = [];
  for (const key of VISUAL_BIBLE_KEYS) {
    const entry = bible.entries[key];
    if (!entry || !entry.value.trim()) continue;
    if (entry.level === 'flexible') continue;
    if (entry.level === 'scene_specific' && (!sceneId || !entry.sceneIds.includes(sceneId))) continue;
    out.push({ key, entry, enforced: entry.level === 'locked' || entry.level === 'scene_specific' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Character Bible & Character State
// ---------------------------------------------------------------------------

export interface CharacterCostume {
  id: string;
  name: string;
  description: string;
  assetId: string | null;
}

export interface CharacterBible {
  refs: { front: string | null; profile: string | null; threeQuarter: string | null; fullBody: string | null };
  /** Face / body references approved for generation (sent to the video model, in order). */
  approvedRefIds: string[];
  height: string;
  build: string;
  skinTone: string;
  hair: string;
  facialHair: string;
  features: string;
  ageRange: string;
  defaultCostumeId: string | null;
  costumes: CharacterCostume[];
  accessories: string[];
  voiceProfile: string;
  speakingStyle: string;
  emotionalBaseline: string;
  movementStyle: string;
  palette: string[];
  itemsCarried: string[];
  /** Identity requirements the reviewer must hold every take to, e.g. "scar over the left eyebrow". */
  protectedIdentity: string[];
  /** Performer / voice credit for the Credits Studio. */
  performer: string;
  approvedAt: number | null;
}

export function emptyCharacterBible(): CharacterBible {
  return {
    refs: { front: null, profile: null, threeQuarter: null, fullBody: null },
    approvedRefIds: [],
    height: '',
    build: '',
    skinTone: '',
    hair: '',
    facialHair: '',
    features: '',
    ageRange: '',
    defaultCostumeId: null,
    costumes: [],
    accessories: [],
    voiceProfile: '',
    speakingStyle: '',
    emotionalBaseline: '',
    movementStyle: '',
    palette: [],
    itemsCarried: [],
    protectedIdentity: [],
    performer: '',
    approvedAt: null,
  };
}

export const POSTURES = ['standing', 'seated', 'walking', 'running', 'lying', 'kneeling', 'crouching'] as const;
export type Posture = (typeof POSTURES)[number];
export const HANDS = ['left', 'right', 'both'] as const;
export type Hand = (typeof HANDS)[number];
export const ENTRY_SIDES = ['none', 'left', 'right', 'foreground', 'background', 'door'] as const;
export type EntrySide = (typeof ENTRY_SIDES)[number];

export interface CharacterState {
  present: boolean;
  costumeId: string | null;
  costume: string;
  hair: string;
  accessories: string[];
  /** Injuries, dirt, wet clothes, make-up changes… */
  physical: string;
  emotion: string;
  /** Stage-plan position (0–1, north = top) when blocked. */
  position: { x: number; y: number } | null;
  /** Body orientation on the plan in degrees (0 = north, clockwise). */
  facingDeg: number | null;
  /** 'camera', another character's id, 'prop:<id>' or free text. */
  gaze: string;
  action: string;
  /** Prop id (or short description) held in each hand. */
  leftHand: string | null;
  rightHand: string | null;
  entry: EntrySide;
  exit: EntrySide;
  posture: Posture;
}

export function defaultCharacterState(bible: Partial<CharacterBible> | null | undefined, fallbackWardrobe = ''): CharacterState {
  const costume = bible?.costumes?.find((c) => c.id === bible.defaultCostumeId) ?? null;
  return {
    present: true,
    costumeId: costume?.id ?? null,
    costume: costume ? `${costume.name}${costume.description ? ` — ${costume.description}` : ''}` : fallbackWardrobe,
    hair: bible?.hair ?? '',
    accessories: [...(bible?.accessories ?? [])],
    physical: '',
    emotion: bible?.emotionalBaseline ?? '',
    position: null,
    facingDeg: null,
    gaze: '',
    action: '',
    leftHand: null,
    rightHand: null,
    entry: 'none',
    exit: 'none',
    posture: 'standing',
  };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export const PROP_STATUSES = ['intact', 'open', 'closed', 'full', 'empty', 'damaged', 'missing', 'on', 'off', 'lit', 'unlit'] as const;
export type PropStatus = (typeof PROP_STATUSES)[number];

export interface PropState {
  present: boolean;
  holderId: string | null;
  hand: Hand | null;
  /** Where it is when nobody holds it ("on the kitchen table"). */
  location: string;
  condition: string;
  status: PropStatus;
  orientation: string;
}

export function defaultPropState(): PropState {
  return { present: true, holderId: null, hand: null, location: '', condition: '', status: 'intact', orientation: '' };
}

/** Prop ledger entry (`props/{elementId}`) — extends the Props & costumes catalogue item. */
export interface PropBibleDoc {
  id: string;
  elementId: string;
  ownerId: string | null;
  approvedRefAssetId: string | null;
  description: string;
  scale: string;
  /** Shot where the prop enters / leaves the story (story order). */
  entersShotId: string | null;
  leavesShotId: string | null;
  initial: PropState;
  notes: string;
  updatedAt?: Time;
}

export const PROP_EVENT_TYPES = ['pick_up', 'put_down', 'hand_over', 'switch_hands', 'open', 'close', 'fill', 'empty', 'damage', 'repair', 'switch_on', 'switch_off', 'lose', 'reveal'] as const;
export type PropEventType = (typeof PROP_EVENT_TYPES)[number];

export const PROP_EVENT_LABELS: Record<PropEventType, string> = {
  pick_up: 'Picks up',
  put_down: 'Puts down',
  hand_over: 'Hands over',
  switch_hands: 'Switches hands',
  open: 'Opens',
  close: 'Closes',
  fill: 'Fills',
  empty: 'Empties',
  damage: 'Damages',
  repair: 'Repairs',
  switch_on: 'Switches on',
  switch_off: 'Switches off',
  lose: 'Loses / leaves behind',
  reveal: 'Reveals / brings in',
};

/** An on-screen action that legitimately changes a prop's state during a shot. */
export interface PropEvent {
  propId: string;
  type: PropEventType;
  characterId: string | null;
  toCharacterId: string | null;
  hand: Hand | null;
  /** Where it ends up after put_down / lose. */
  location: string;
  note: string;
}

// ---------------------------------------------------------------------------
// Set Bible (locations)
// ---------------------------------------------------------------------------

export const SET_VIEWS = ['wide', 'front', 'rear', 'left', 'right'] as const;
export type SetView = (typeof SET_VIEWS)[number];
export const SET_VIEW_LABELS: Record<SetView, string> = {
  wide: 'Wide establishing',
  front: 'Front (facing the north wall)',
  rear: 'Rear (facing the south wall)',
  left: 'Left (facing the west wall)',
  right: 'Right (facing the east wall)',
};

export const FLOOR_ITEM_KINDS = ['wall', 'door', 'window', 'furniture', 'light', 'object', 'sign', 'zone', 'camera'] as const;
export type FloorItemKind = (typeof FLOOR_ITEM_KINDS)[number];

/** One element of the top-down floor plan. Coordinates are 0–1 of the plan (north = top). */
export interface FloorItem {
  id: string;
  kind: FloorItemKind;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  /** Protected: must never move or change between shots. */
  locked: boolean;
}

export interface SetVariant {
  id: string;
  label: string;
  assetId: string | null;
  description: string;
}

export type CanonicalStatus = 'draft' | 'pending_approval' | 'locked';

export interface SetBibleDoc {
  id: string;
  locationId: string;
  /** Plan size in metres (the plan is square). */
  planSizeM: number;
  views: Record<SetView, string | null>;
  detailAssetIds: string[];
  floorPlanAssetId: string | null;
  floorPlan: FloorItem[];
  wallColours: string;
  materials: string;
  backgroundObjects: string[];
  lighting: { keyDirection: string; colour: string; notes: string };
  timeOfDayVariants: SetVariant[];
  weatherVariants: SetVariant[];
  protectedFeatures: string[];
  readableSigns: { text: string; where: string }[];
  mayChange: string[];
  neverChange: string[];
  population: string;
  canonical: { status: CanonicalStatus; approvedAt: number | null; approvedViews: SetView[]; packJobId: string | null };
  updatedAt?: Time;
}

export const DEFAULT_PLAN_SIZE_M = 10;

export function emptySetBible(locationId: string): SetBibleDoc {
  return {
    id: locationId,
    locationId,
    planSizeM: DEFAULT_PLAN_SIZE_M,
    views: { wide: null, front: null, rear: null, left: null, right: null },
    detailAssetIds: [],
    floorPlanAssetId: null,
    floorPlan: [],
    wallColours: '',
    materials: '',
    backgroundObjects: [],
    lighting: { keyDirection: '', colour: '', notes: '' },
    timeOfDayVariants: [],
    weatherVariants: [],
    protectedFeatures: [],
    readableSigns: [],
    mayChange: [],
    neverChange: [],
    population: '',
    canonical: { status: 'draft', approvedAt: null, approvedViews: [], packJobId: null },
  };
}

/** Canonical view whose camera faces the given plan direction (0 = north wall = "front"). */
export function viewForDirection(deg: number | null | undefined): SetView {
  if (deg === null || deg === undefined || !Number.isFinite(deg)) return 'wide';
  const d = ((deg % 360) + 360) % 360;
  if (d >= 315 || d < 45) return 'front';
  if (d < 135) return 'right';
  if (d < 225) return 'rear';
  return 'left';
}

/** Plan direction (degrees) a canonical view faces. */
export const VIEW_DIRECTION: Record<Exclude<SetView, 'wide'>, number> = { front: 0, right: 90, rear: 180, left: 270 };

// ---------------------------------------------------------------------------
// Blocking plan & camera axis
// ---------------------------------------------------------------------------

export interface StagePoint {
  x: number;
  y: number;
}

export const BLOCKING_ENTITY_KINDS = ['character', 'prop', 'door', 'exit', 'furniture', 'vehicle'] as const;
export type BlockingEntityKind = (typeof BLOCKING_ENTITY_KINDS)[number];
export const LAYERS = ['foreground', 'midground', 'background'] as const;
export type Layer = (typeof LAYERS)[number];

export interface BlockingGaze {
  kind: 'none' | 'camera' | 'entity' | 'direction';
  targetId: string | null;
  deg: number | null;
}

export interface BlockingEntity {
  id: string;
  kind: BlockingEntityKind;
  /** Character id / element id this marker stands for. */
  refId: string | null;
  label: string;
  position: StagePoint;
  facingDeg: number;
  gaze: BlockingGaze;
  /** Movement waypoints after `position` (start = position, end = last point). */
  path: StagePoint[];
  layer: Layer | null;
  /** Deliberate partial concealment (over-the-shoulder, foreground silhouette, crossing frame). */
  occlusionAllowed: boolean;
  protectedVisibility: 'face' | 'body' | 'none';
  speaking: boolean;
  posture: Posture;
}

export const CAMERA_HEIGHTS = ['ground', 'low', 'eye', 'high', 'overhead'] as const;
export type CameraHeight = (typeof CAMERA_HEIGHTS)[number];

export interface BlockingCamera {
  position: StagePoint;
  directionDeg: number;
  lensMm: number;
  height: CameraHeight;
  /** End of a moving camera (tracking, crane, dolly) — used for axis crossing checks. */
  endPosition: StagePoint | null;
}

export interface ProtectedZone {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BlockingPlanDoc {
  id: string;
  shotId: string;
  sceneId: string | null;
  locationId: string | null;
  camera: BlockingCamera;
  entities: BlockingEntity[];
  protectedZones: ProtectedZone[];
  notes: string;
  updatedAt?: Time;
}

export function defaultCamera(): BlockingCamera {
  return { position: { x: 0.5, y: 0.9 }, directionDeg: 0, lensMm: 35, height: 'eye', endPosition: null };
}

export type ScreenDirection = 'left_to_right' | 'right_to_left' | 'toward_camera' | 'away_from_camera' | 'static';
export const SCREEN_DIRECTION_LABELS: Record<ScreenDirection, string> = {
  left_to_right: 'Left → right',
  right_to_left: 'Right → left',
  toward_camera: 'Toward camera',
  away_from_camera: 'Away from camera',
  static: 'Static',
};

export const AXIS_CROSSING_REASONS = ['planned', 'neutral_shot', 'moving_camera', 'override'] as const;
export type AxisCrossingReason = (typeof AXIS_CROSSING_REASONS)[number];
export const AXIS_CROSSING_LABELS: Record<AxisCrossingReason, string> = {
  planned: 'Planned crossing',
  neutral_shot: 'A neutral shot establishes it',
  moving_camera: 'The camera visibly crosses the line',
  override: 'Director override',
};

export interface CameraAxisDoc {
  id: string;
  sceneId: string;
  /** The 180-degree line, usually between the two main characters (plan coordinates). */
  axis: { aId: string | null; bId: string | null; a: StagePoint; b: StagePoint } | null;
  /** Side of the line (looking from a to b) the camera stays on. */
  establishedSide: 'left' | 'right' | null;
  /** Established travel direction per character / vehicle. */
  travel: { refId: string; direction: ScreenDirection }[];
  crossings: { shotId: string; reason: AxisCrossingReason; note: string; at: number }[];
  updatedAt?: Time;
}

// ---------------------------------------------------------------------------
// Protected screens, text, signs and logos
// ---------------------------------------------------------------------------

export const SCREEN_SURFACES = ['phone', 'tablet', 'computer', 'tv', 'sign', 'book', 'poster', 'clothing', 'vehicle', 'logo', 'packaging'] as const;
export type ScreenSurface = (typeof SCREEN_SURFACES)[number];

export interface ProtectedScreenDoc {
  id: string;
  name: string;
  surface: ScreenSurface;
  /** Text that must be readable exactly (the OCR check compares against it). */
  expectedText: string;
  /** Approved graphic / interface capture composited onto the surface. */
  contentAssetId: string | null;
  referenceAssetId: string | null;
  logoAssetId: string | null;
  /** Default four corners (0–1 of the frame, clockwise from top-left) for static shots. */
  corners: [StagePoint, StagePoint, StagePoint, StagePoint] | null;
  mayMirror: boolean;
  /** Composite the approved content instead of letting the video model draw it. */
  composite: boolean;
  /** Smallest acceptable character height as a fraction of frame height. */
  minTextHeight: number;
  notes: string;
  updatedAt?: Time;
}

// ---------------------------------------------------------------------------
// Per-shot continuity input (written by the director on the shot)
// ---------------------------------------------------------------------------

export interface EnvironmentState {
  locationId: string | null;
  timeOfDay: string;
  weather: string;
  lightDirection: string;
  lightColour: string;
  background: string;
}

export interface ShotContinuityInput {
  /** Per-character changes planned for this shot (everything else continues from the previous shot). */
  characters: Record<string, Partial<CharacterState> & { costumeChangeReason?: string }>;
  propIds: string[];
  propEvents: PropEvent[];
  environment: Partial<EnvironmentState>;
  screenIds: string[];
  /** Why this shot may cross the 180-degree line (null = it must not). */
  axisCrossing: { reason: AxisCrossingReason; note: string } | null;
  /** Deliberate change of screen direction (e.g. the character turns back). */
  directionChange: { refId: string; reason: string } | null;
  /** Begin exactly where the previous approved shot ended (its last frame becomes the first frame). */
  startFromPreviousFrame: boolean;
  /** Lighting that is intentionally different from the rest of the scene (colour matching leaves it alone). */
  intentionalLook: string;
  notes: string;
}

export function emptyShotContinuity(): ShotContinuityInput {
  return { characters: {}, propIds: [], propEvents: [], environment: {}, screenIds: [], axisCrossing: null, directionChange: null, startFromPreviousFrame: false, intentionalLook: '', notes: '' };
}

// ---------------------------------------------------------------------------
// Continuity state lifecycle
// ---------------------------------------------------------------------------

export interface ContinuityState {
  characters: Record<string, CharacterState>;
  props: Record<string, PropState>;
  environment: EnvironmentState;
  camera: { side: 'left' | 'right' | null; directionDeg: number | null; travel: Record<string, ScreenDirection> };
  screens: Record<string, { content: string; orientation: 'normal' | 'mirrored' | 'unknown' }>;
  dialogue: { lastLine: string | null; complete: boolean };
  action: { description: string; complete: boolean };
}

export function emptyContinuityState(): ContinuityState {
  return {
    characters: {},
    props: {},
    environment: { locationId: null, timeOfDay: '', weather: '', lightDirection: '', lightColour: '', background: '' },
    camera: { side: null, directionDeg: null, travel: {} },
    screens: {},
    dialogue: { lastLine: null, complete: true },
    action: { description: '', complete: true },
  };
}

export const CONSTRAINT_SOURCES = ['visual_bible', 'character', 'set', 'prop', 'blocking', 'axis', 'screen', 'previous_shot', 'colour'] as const;
export type ConstraintSource = (typeof CONSTRAINT_SOURCES)[number];

export interface ContinuityConstraint {
  id: string;
  source: ConstraintSource;
  subjectId: string | null;
  text: string;
  level: ConstraintLevel;
}

export const WARNING_KINDS = [
  'costume',
  'hair',
  'accessory',
  'character_presence',
  'prop_hand',
  'prop_teleport',
  'prop_state',
  'prop_missing',
  'time_of_day',
  'weather',
  'lighting',
  'location',
  'axis_crossing',
  'screen_direction',
  'entry_exit',
  'eyeline',
  'occlusion',
  'face_hidden',
  'same_space',
  'tangent',
  'walk_through',
  'out_of_frame',
  'screen_content',
  'mirrored_text',
  'background',
  'character_identity',
  'colour',
  'blocking',
] as const;
export type ContinuityWarningKind = (typeof WARNING_KINDS)[number];

export const WARNING_LABELS: Record<ContinuityWarningKind, string> = {
  costume: 'Costume',
  hair: 'Hair',
  accessory: 'Accessory',
  character_presence: 'Character presence',
  prop_hand: 'Prop hand',
  prop_teleport: 'Prop moved',
  prop_state: 'Prop state',
  prop_missing: 'Prop missing',
  time_of_day: 'Time of day',
  weather: 'Weather',
  lighting: 'Lighting',
  location: 'Location',
  axis_crossing: '180° line crossed',
  screen_direction: 'Screen direction',
  entry_exit: 'Entry / exit side',
  eyeline: 'Eyeline',
  occlusion: 'Occlusion',
  face_hidden: 'Face hidden',
  same_space: 'Characters overlap',
  tangent: 'Silhouettes touch',
  walk_through: 'Walks through something',
  out_of_frame: 'Out of frame',
  screen_content: 'Screen content',
  mirrored_text: 'Mirrored text',
  background: 'Background',
  character_identity: 'Character identity',
  colour: 'Colour',
  blocking: 'Blocking',
};

export type WarningSeverity = 'info' | 'warning' | 'critical';

export interface ContinuityWarning {
  id: string;
  kind: ContinuityWarningKind;
  severity: WarningSeverity;
  subjectId: string | null;
  message: string;
  expected: string;
  detected: string | null;
  difference: string | null;
  proposedRepair: { type: string; label: string; estimateUsd: number | null } | null;
  affects: { previousShotId: string | null; nextShotId: string | null };
  source: 'plan' | 'inspection' | 'final' | 'compare';
  status: 'open' | 'resolved' | 'overridden';
  note?: string;
}

export const CONTINUITY_STATUSES = ['planned', 'locked', 'consistent', 'warning', 'failed', 'repaired', 'needs_review', 'overridden'] as const;
export type ContinuityStatus = (typeof CONTINUITY_STATUSES)[number];

export const CONTINUITY_STATUS_LABELS: Record<ContinuityStatus, string> = {
  planned: 'Planned',
  locked: 'Locked',
  consistent: 'Consistent',
  warning: 'Warning',
  failed: 'Failed',
  repaired: 'Repaired',
  needs_review: 'Needs review',
  overridden: 'Manually overridden',
};

export interface ContinuitySnapshotDoc {
  id: string;
  shotId: string;
  sceneId: string | null;
  order: number;
  previousShotId: string | null;
  nextShotId: string | null;
  continuityBefore: ContinuityState | null;
  plannedState: ContinuityState;
  continuityAfter: ContinuityState | null;
  approvedState: ContinuityState | null;
  continuityWarnings: ContinuityWarning[];
  protectedConstraints: ContinuityConstraint[];
  optionalPreferences: ContinuityConstraint[];
  status: ContinuityStatus;
  productionId: string | null;
  versionId: string | null;
  /** Last frame of the approved take (an image asset) — reference for the next shot. */
  finalFrameAssetId: string | null;
  approvedAt: number | null;
  plannedAt: number | null;
  updatedAt?: Time;
}

/** Canonical per-shot record of one character (`characterStates/{shotId}__{characterId}`). */
export interface CharacterStateDoc {
  id: string;
  characterId: string;
  shotId: string;
  sceneId: string | null;
  order: number;
  planned: CharacterState;
  approved: CharacterState | null;
  approvedAt: number | null;
  versionId: string | null;
}

/** Canonical per-shot record of one prop (`propStates/{shotId}__{propId}`). */
export interface PropStateDoc {
  id: string;
  propId: string;
  shotId: string;
  sceneId: string | null;
  order: number;
  planned: PropState;
  approved: PropState | null;
  events: PropEvent[];
  approvedAt: number | null;
  versionId: string | null;
}

export const stateDocId = (shotId: string, subjectId: string) => `${shotId}__${subjectId}`;

let warningCounter = 0;
export function warningId(kind: string): string {
  warningCounter = (warningCounter + 1) % 100000;
  return `w_${kind}_${Date.now().toString(36)}${warningCounter.toString(36)}`;
}

/** The status badge a snapshot shows (worst open warning wins; approvals lock). */
export function snapshotStatus(s: Pick<ContinuitySnapshotDoc, 'approvedState' | 'continuityWarnings' | 'status'>): ContinuityStatus {
  if (s.status === 'overridden' || s.status === 'repaired' || s.status === 'failed' || s.status === 'needs_review') return s.status;
  if (s.approvedState) return 'locked';
  const open = s.continuityWarnings.filter((w) => w.status === 'open');
  if (open.some((w) => w.severity === 'critical')) return 'failed';
  if (open.some((w) => w.severity === 'warning')) return 'warning';
  return s.status === 'planned' ? 'planned' : 'consistent';
}
