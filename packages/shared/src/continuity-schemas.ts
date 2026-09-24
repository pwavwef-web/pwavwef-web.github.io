import { z } from 'zod';
import { AXIS_CROSSING_REASONS, BLOCKING_ENTITY_KINDS, CAMERA_HEIGHTS, CONSTRAINT_LEVELS, ENTRY_SIDES, FLOOR_ITEM_KINDS, HANDS, LAYERS, POSTURES, PROP_EVENT_TYPES, PROP_STATUSES, SCREEN_SURFACES, SET_VIEWS, VISUAL_BIBLE_KEYS } from './continuity';
import { LYRIC_ASPECTS, LYRIC_PRESETS } from './lyric-style';
import { CREDIT_KINDS, CREDIT_LAYOUTS, CREDIT_SECTION_TYPES } from './credits';
import { MUSIC_MODES, VOCAL_OPTIONS } from './music-studio';
import { SECTION_LABELS } from './types';

/**
 * Typed schemas for every document the Continuity Director, Lyric Style Studio, Credits Studio and
 * Music Studio write. The API validates each write against these before it reaches Firestore; the
 * security rules deny direct client writes to these collections.
 */

const id = z.string().min(1).max(128).regex(/^[\w-]+$/, 'Invalid id');
const text = (max: number) => z.string().max(max);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a #RRGGBB colour');
const unit = z.number().min(-0.5).max(1.5);
const point = z.object({ x: unit, y: unit });
const list = (max: number, item = text(300)) => z.array(item).max(max);

export const bibleEntrySchema = z.object({ value: text(3000), level: z.enum(CONSTRAINT_LEVELS), sceneIds: z.array(id).max(300).default([]) });

export const colourDirectionSchema = z.object({
  referenceAssetId: id.nullable(),
  palette: list(12, text(40)),
  skinTone: text(400),
  whiteBalanceK: z.number().min(1500).max(15000).nullable(),
  contrast: z.enum(['low', 'medium', 'high']).nullable(),
  saturation: z.enum(['muted', 'natural', 'rich']).nullable(),
  grain: z.enum(['none', 'fine', 'medium', 'heavy']).nullable(),
  highlightRollOff: z.enum(['soft', 'medium', 'hard']).nullable(),
  shadowTreatment: z.enum(['lifted', 'neutral', 'crushed']).nullable(),
  look: z.enum(['day', 'night', 'dusk', 'interior']).nullable(),
  lutAssetId: id.nullable(),
  lutStrength: z.number().min(0).max(1),
  approvedAt: z.number().nullable(),
});

export const visualBibleSchema = z.object({
  entries: z.partialRecord(z.enum(VISUAL_BIBLE_KEYS), bibleEntrySchema),
  referenceAssetIds: z.array(id).max(30),
  lookbookAssetIds: z.array(id).max(12),
  colour: colourDirectionSchema,
});

export const characterBibleSchema = z.object({
  refs: z.object({ front: id.nullable(), profile: id.nullable(), threeQuarter: id.nullable(), fullBody: id.nullable() }),
  approvedRefIds: z.array(id).max(6),
  height: text(80),
  build: text(200),
  skinTone: text(200),
  hair: text(300),
  facialHair: text(200),
  features: text(600),
  ageRange: text(60),
  defaultCostumeId: id.nullable(),
  costumes: z.array(z.object({ id, name: text(80), description: text(600), assetId: id.nullable() })).max(20),
  accessories: list(20, text(120)),
  voiceProfile: text(400),
  speakingStyle: text(400),
  emotionalBaseline: text(300),
  movementStyle: text(300),
  palette: list(10, text(40)),
  itemsCarried: list(12, text(120)),
  protectedIdentity: list(12, text(300)),
  performer: text(120),
});

const floorItemSchema = z.object({ id, kind: z.enum(FLOOR_ITEM_KINDS), label: text(80), x: unit, y: unit, w: z.number().min(0).max(1.5), h: z.number().min(0).max(1.5), rotation: z.number().min(-360).max(360), locked: z.boolean() });
const variantSchema = z.object({ id, label: text(80), assetId: id.nullable(), description: text(400) });

export const setBibleSchema = z.object({
  locationId: id,
  planSizeM: z.number().min(2).max(500),
  views: z.object(Object.fromEntries(SET_VIEWS.map((v) => [v, id.nullable()])) as Record<(typeof SET_VIEWS)[number], z.ZodNullable<typeof id>>),
  detailAssetIds: z.array(id).max(20),
  floorPlanAssetId: id.nullable(),
  floorPlan: z.array(floorItemSchema).max(200),
  wallColours: text(300),
  materials: text(400),
  backgroundObjects: list(40, text(160)),
  lighting: z.object({ keyDirection: text(160), colour: text(120), notes: text(400) }),
  timeOfDayVariants: z.array(variantSchema).max(8),
  weatherVariants: z.array(variantSchema).max(8),
  protectedFeatures: list(30, text(200)),
  readableSigns: z.array(z.object({ text: text(200), where: text(120) })).max(20),
  mayChange: list(30, text(200)),
  neverChange: list(30, text(200)),
  population: text(300),
});

export const propStateSchema = z.object({ present: z.boolean(), holderId: id.nullable(), hand: z.enum(HANDS).nullable(), location: text(200), condition: text(200), status: z.enum(PROP_STATUSES), orientation: text(120) });

export const propBibleSchema = z.object({
  elementId: id,
  ownerId: id.nullable(),
  approvedRefAssetId: id.nullable(),
  description: text(600),
  scale: text(160),
  entersShotId: id.nullable(),
  leavesShotId: id.nullable(),
  initial: propStateSchema,
  notes: text(600),
});

const gazeSchema = z.object({ kind: z.enum(['none', 'camera', 'entity', 'direction']), targetId: id.nullable(), deg: z.number().min(-720).max(720).nullable() });
const entitySchema = z.object({
  id,
  kind: z.enum(BLOCKING_ENTITY_KINDS),
  refId: id.nullable(),
  label: text(80),
  position: point,
  facingDeg: z.number().min(-720).max(720),
  gaze: gazeSchema,
  path: z.array(point).max(20),
  layer: z.enum(LAYERS).nullable(),
  occlusionAllowed: z.boolean(),
  protectedVisibility: z.enum(['face', 'body', 'none']),
  speaking: z.boolean(),
  posture: z.enum(POSTURES),
});

export const blockingPlanSchema = z.object({
  shotId: id,
  sceneId: id.nullable(),
  locationId: id.nullable(),
  camera: z.object({ position: point, directionDeg: z.number().min(-720).max(720), lensMm: z.number().min(8).max(600), height: z.enum(CAMERA_HEIGHTS), endPosition: point.nullable() }),
  entities: z.array(entitySchema).max(24),
  protectedZones: z.array(z.object({ id, label: text(80), x: unit, y: unit, w: z.number().min(0).max(1.5), h: z.number().min(0).max(1.5) })).max(12),
  notes: text(1000),
});

const screenDirection = z.enum(['left_to_right', 'right_to_left', 'toward_camera', 'away_from_camera', 'static']);

export const cameraAxisSchema = z.object({
  sceneId: id,
  axis: z.object({ aId: id.nullable(), bId: id.nullable(), a: point, b: point }).nullable(),
  establishedSide: z.enum(['left', 'right']).nullable(),
  travel: z.array(z.object({ refId: id, direction: screenDirection })).max(20),
  crossings: z.array(z.object({ shotId: id, reason: z.enum(AXIS_CROSSING_REASONS), note: text(300), at: z.number() })).max(100),
});

export const protectedScreenSchema = z.object({
  name: text(120).min(1),
  surface: z.enum(SCREEN_SURFACES),
  expectedText: text(600),
  contentAssetId: id.nullable(),
  referenceAssetId: id.nullable(),
  logoAssetId: id.nullable(),
  corners: z.tuple([point, point, point, point]).nullable(),
  mayMirror: z.boolean(),
  composite: z.boolean(),
  minTextHeight: z.number().min(0).max(0.5),
  notes: text(600),
});

export const characterStatePartialSchema = z
  .object({
    present: z.boolean(),
    costumeId: id.nullable(),
    costume: text(400),
    hair: text(200),
    accessories: list(12, text(120)),
    physical: text(300),
    emotion: text(200),
    position: point.nullable(),
    facingDeg: z.number().min(-720).max(720).nullable(),
    gaze: text(120),
    action: text(400),
    leftHand: text(128).nullable(),
    rightHand: text(128).nullable(),
    entry: z.enum(ENTRY_SIDES),
    exit: z.enum(ENTRY_SIDES),
    posture: z.enum(POSTURES),
    costumeChangeReason: text(300),
  })
  .partial();

export const shotContinuitySchema = z.object({
  characters: z.record(id, characterStatePartialSchema),
  propIds: z.array(id).max(30),
  propEvents: z.array(z.object({ propId: id, type: z.enum(PROP_EVENT_TYPES), characterId: id.nullable(), toCharacterId: id.nullable(), hand: z.enum(HANDS).nullable(), location: text(200), note: text(300) })).max(30),
  environment: z.object({ locationId: id.nullable(), timeOfDay: text(80), weather: text(80), lightDirection: text(120), lightColour: text(80), background: text(300) }).partial(),
  screenIds: z.array(id).max(10),
  axisCrossing: z.object({ reason: z.enum(AXIS_CROSSING_REASONS), note: text(300) }).nullable(),
  directionChange: z.object({ refId: id, reason: text(300) }).nullable(),
  startFromPreviousFrame: z.boolean(),
  intentionalLook: text(300),
  notes: text(1000),
});

const entrance = z.enum(['none', 'fade', 'rise', 'drop', 'scale', 'slide_left', 'slide_right', 'blur']);
const wordEffect = z.enum(['none', 'sweep', 'instant', 'highlight', 'pop', 'typewriter', 'reveal']);
const aspectPlacement = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), fontSizePct: z.number().min(1).max(20), align: z.enum(['left', 'center', 'right']), maxCharsPerLine: z.number().int().min(4).max(120), locked: z.boolean() }).partial();

export const lyricStyleValueSchema = z.object({
  preset: z.enum(LYRIC_PRESETS),
  fontFamily: text(80).min(1),
  fontWeight: z.number().int().min(100).max(900),
  fontSizePct: z.number().min(1).max(20),
  capitalisation: z.enum(['none', 'upper', 'lower', 'title']),
  italic: z.boolean(),
  letterSpacing: z.number().min(-10).max(40),
  lineSpacing: z.number().min(0.8).max(3),
  maxCharsPerLine: z.number().int().min(4).max(120),
  maxLines: z.number().int().min(1).max(6),
  align: z.enum(['left', 'center', 'right']),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  activeColor: hex,
  inactiveColor: hex,
  outline: z.object({ width: z.number().min(0).max(20), color: hex }).nullable(),
  shadow: z.object({ x: z.number().min(-40).max(40), y: z.number().min(-40).max(40), blur: z.number().min(0).max(60), color: hex, opacity: z.number().min(0).max(1) }).nullable(),
  glow: z.object({ radius: z.number().min(0).max(80), color: hex, strength: z.number().min(0).max(1) }).nullable(),
  gradient: z.object({ from: hex, to: hex }).nullable(),
  box: z.object({ color: hex, opacity: z.number().min(0).max(1), padding: z.number().min(0).max(120), radius: z.number().min(0).max(120) }).nullable(),
  backgroundBlur: z.number().min(0).max(60),
  opacity: z.number().min(0.05).max(1),
  entrance,
  exit: entrance,
  wordAnimation: wordEffect,
  transitionMs: z.number().int().min(0).max(3000),
  direction: z.enum(['ltr', 'rtl']),
  safeMargin: z.number().min(0).max(0.3),
  translation: z.object({ color: hex, sizeRatio: z.number().min(0.3).max(1.2) }),
  aspects: z.partialRecord(z.enum(LYRIC_ASPECTS), aspectPlacement),
});

export const lyricStyleSchema = z.object({
  name: text(120).min(1),
  global: lyricStyleValueSchema,
  sections: z.partialRecord(z.enum(SECTION_LABELS), lyricStyleValueSchema.partial()),
  fonts: z.array(z.object({ family: text(80).min(1), assetId: id, licenceConfirmed: z.literal(true) })).max(10),
});

export const lyricsTrackSchema = z.object({
  songId: id,
  styleId: id.nullable(),
  /** Placement per aspect ratio and line (the director can lock a position). */
  placements: z.partialRecord(z.enum(LYRIC_ASPECTS), z.record(id, z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), locked: z.boolean() }))),
});

const creditSection = z.object({ id, type: z.enum(CREDIT_SECTION_TYPES), title: text(200), entries: z.array(z.object({ role: text(160), names: list(20, text(160)) })).max(200), body: text(3000) });

export const creditSequenceSchema = z.object({
  name: text(120).min(1),
  kind: z.enum(CREDIT_KINDS),
  layout: z.enum(CREDIT_LAYOUTS),
  sections: z.array(creditSection).max(40),
  logoAssetIds: z.array(id).max(8),
  background: z.object({ type: z.enum(['transparent', 'black', 'colour']), colour: hex }),
  musicAssetId: id.nullable(),
  musicVolume: z.number().min(0).max(2),
  fontFamily: text(80).min(1),
  titleSizePct: z.number().min(1).max(15),
  bodySizePct: z.number().min(1).max(10),
  sectionSpacing: z.number().min(0).max(0.4),
  lineSpacing: z.number().min(0.9).max(3),
  align: z.enum(['center', 'left']),
  fadeSec: z.number().min(0).max(5),
  durationSec: z.number().min(2).max(900),
  cardSec: z.number().min(1).max(20),
  safeMargin: z.number().min(0).max(0.25),
  textColor: hex,
  accentColor: hex,
  startSec: z.number().min(0).max(36000).nullable(),
});

const structurePart = z.object({ id, label: z.enum(SECTION_LABELS), name: text(60), seconds: z.number().min(1).max(600).nullable(), notes: text(300) });

export const musicBriefSchema = z.object({
  title: text(160),
  concept: text(3000),
  language: text(24),
  genre: text(80),
  subgenre: text(80),
  mood: text(160),
  tempoBpm: z.number().min(30).max(260).nullable(),
  key: text(24),
  timeSignature: text(8),
  durationSec: z.number().min(5).max(600),
  vocals: z.enum(VOCAL_OPTIONS),
  vocalCharacter: text(300),
  instrumentation: list(24, text(80)),
  structure: z.array(structurePart).max(30),
  introSec: z.number().min(0).max(120).nullable(),
  verseCount: z.number().int().min(0).max(8),
  chorusCount: z.number().int().min(0).max(8),
  bridge: z.boolean(),
  outro: z.boolean(),
  energy: text(400),
  culturalDirection: text(600),
  avoidInstruments: list(20, text(80)),
  explicit: z.enum(['clean', 'allowed']),
});

const sectionEdit = z.object({ id, label: z.enum(SECTION_LABELS), name: text(60), start: z.number().min(0).max(3600), end: z.number().min(0).max(3600), loop: z.number().int().min(1).max(8), muted: z.boolean(), gainDb: z.number().min(-40).max(12), fadeIn: z.number().min(0).max(30), fadeOut: z.number().min(0).max(30), visualIdea: text(600) });

export const musicProjectSchema = z.object({
  mode: z.enum(MUSIC_MODES),
  brief: musicBriefSchema,
  lyricsText: text(12000),
  lyricsSheetId: id.nullable(),
  songId: id.nullable(),
  masterVersionId: id.nullable(),
  sections: z.array(sectionEdit).max(60),
  markers: z.array(z.object({ id, t: z.number().min(0).max(3600), label: text(80), color: hex })).max(100),
  mix: z.object({ limiter: z.boolean(), targetLufs: z.number().min(-30).max(-6).nullable(), preset: text(40) }),
});

export const audioTrackSchema = z.object({
  musicProjectId: id,
  name: text(80).min(1),
  assetId: id,
  kind: z.enum(['version', 'stem', 'recording', 'upload']),
  role: z.enum(['music', 'vocal', 'dialogue', 'fx']),
  volumeDb: z.number().min(-60).max(12),
  pan: z.number().min(-1).max(1),
  mute: z.boolean(),
  solo: z.boolean(),
  offsetSec: z.number().min(0).max(3600),
  fadeIn: z.number().min(0).max(60),
  fadeOut: z.number().min(0).max(60),
  eq: z.object({ lowDb: z.number().min(-15).max(15), midDb: z.number().min(-15).max(15), highDb: z.number().min(-15).max(15) }),
  compressor: z.object({ enabled: z.boolean(), thresholdDb: z.number().min(-60).max(0), ratio: z.number().min(1).max(20) }),
  noiseReduction: z.boolean(),
  duck: z.object({ enabled: z.boolean(), keyTrackId: id.nullable(), amountDb: z.number().min(0).max(30) }),
  order: z.number().int().min(0).max(1000),
});

/** Collections written through `continuitySave` (validated here; the rules deny direct writes). */
export const CONTINUITY_DOC_SCHEMAS = {
  visualBibles: visualBibleSchema,
  setBibles: setBibleSchema,
  props: propBibleSchema,
  blockingPlans: blockingPlanSchema,
  cameraAxes: cameraAxisSchema,
  protectedScreens: protectedScreenSchema,
  lyricStyles: lyricStyleSchema,
  lyricsTracks: lyricsTrackSchema,
  creditSequences: creditSequenceSchema,
  musicProjects: musicProjectSchema,
  audioTracks: audioTrackSchema,
} as const;
export type ContinuityCollection = keyof typeof CONTINUITY_DOC_SCHEMAS;
export const CONTINUITY_COLLECTIONS = Object.keys(CONTINUITY_DOC_SCHEMAS) as ContinuityCollection[];

/** Server-written collections (read-only to the owner). */
export const SERVER_COLLECTIONS = ['continuitySnapshots', 'characterStates', 'propStates', 'qualityReviews', 'repairAttempts', 'finalInspections', 'musicVersions', 'stems', 'scoreBibles', 'cueSheets', 'subjectTracks'] as const;
