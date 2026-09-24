import type { AsrWord, LyricCaptionMode, LyricsSheet } from './lyrics';
import type { ProductionSummary } from './production';
import type { QualitySettings } from './quality';
import type { ScoreMode } from './score';

/**
 * AZ Studio domain model. These shapes are shared by the web app, Cloud Functions and the renderer.
 * Firestore database: `az-studio`. Every top-level document carries `ownerUid`.
 */

/** Firestore Timestamp (client or admin SDK) — only `toMillis` is relied upon. */
export interface TimestampLike {
  toMillis(): number;
}
export type Time = TimestampLike | null | undefined;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const PROJECT_TYPES = ['quick_video', 'music_video', 'film', 'image', 'remix'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  quick_video: 'Quick Video',
  music_video: 'Music Video',
  film: 'Film',
  image: 'Image Studio',
  remix: 'Video Remix',
};

export type FrameAspect = '16:9' | '9:16' | '1:1';

export interface Treatment {
  title?: string;
  logline?: string;
  synopsis?: string;
  body?: string;
  themes?: string[];
  tone?: string;
  visualStyle?: string;
  palette?: string[];
  motifs?: string[];
  wardrobe?: string;
  performanceVsNarrative?: string;
  sectionIdeas?: { sectionLabel: string; idea: string }[];
  /** Set when the creator approves the treatment for production (ms); editing is locked until cleared. */
  approvedAt?: number | null;
  updatedAt?: Time;
}

/** Visual continuity rules that are injected into every shot prompt of a project. */
export interface StyleBible {
  visualStyle?: string;
  palette?: string;
  lighting?: string;
  cameraLanguage?: string;
  texture?: string;
  continuityNotes?: string;
}

export interface ProjectDoc {
  id: string;
  ownerUid: string;
  title: string;
  type: ProjectType;
  logline?: string;
  idea?: string;
  genre?: string;
  status: 'active' | 'archived';
  /** `videoResolution` is the default Omni resolution for new shots in this project. */
  format: { aspectRatio: FrameAspect; fps: 24 | 25 | 30; videoResolution?: string };
  coverAssetId?: string | null;
  treatment?: Treatment;
  styleBible?: StyleBible;
  /** Autonomous quality control for generated scenes (defaults: DEFAULT_QUALITY_SETTINGS). */
  quality?: Partial<QualitySettings>;
  /** Film soundtrack policy. Music videos keep their song as the master audio. */
  score?: { mode: ScoreMode; scoreId: string | null } | null;
  /** Main spoken language of the project (BCP-47), used as a transcription hint. */
  language?: string | null;
  /** Server-maintained aggregates (usage is an estimate derived from recorded token usage). */
  usage?: { costUsd: number; jobs: number };
  createdAt?: Time;
  updatedAt?: Time;
}

// ---------------------------------------------------------------------------
// Assets & media
// ---------------------------------------------------------------------------

export const ASSET_KINDS = ['image', 'video', 'audio', 'document'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export type AssetSource = 'upload' | 'generated' | 'render' | 'derived';
export type AssetStatus = 'uploading' | 'processing' | 'ready' | 'rejected';

export interface Provenance {
  /** Google states all Omni and Nano Banana Pro outputs carry an invisible SynthID watermark. */
  synthId: boolean;
  /** Whether a C2PA manifest was detected in the stored original file. */
  c2pa: 'present' | 'absent' | 'unknown';
  generator?: string;
}

export interface AssetGeneration {
  jobId: string;
  modelId: string;
  prompt: string;
  params: Record<string, unknown>;
  interactionId?: string;
  chainId?: string;
  turnId?: string;
  parentAssetId?: string;
  provenance: Provenance;
}

export interface AssetDoc {
  id: string;
  ownerUid: string;
  projectId: string | null;
  kind: AssetKind;
  source: AssetSource;
  status: AssetStatus;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  thumbPath?: string | null;
  posterPath?: string | null;
  /** JSON file with min/max waveform peaks (audio and video with audio). */
  waveformPath?: string | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
  fps?: number | null;
  hasAudio?: boolean | null;
  favorite: boolean;
  tags: string[];
  /** Free-form collection keys, e.g. `lookbook`, `storyboard`, `character:<id>`, `location:<id>`. */
  collections: string[];
  generation?: AssetGeneration | null;
  /** Set for clips trimmed from, or frames extracted from, another asset. */
  derivedFrom?: { assetId: string; startSec?: number; durationSec?: number; atSec?: number } | null;
  /** C2PA manifest detected in an uploaded file. */
  c2pa?: 'present' | 'absent' | 'unknown';
  rejection?: { reason: string } | null;
  createdAt?: Time;
  updatedAt?: Time;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const JOB_STATUSES = [
  'queued',
  'validating',
  'generating',
  'downloading',
  'rendering',
  'completed',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TYPES = [
  'image.generate',
  'video.generate',
  'text.assist',
  'audio.analyze',
  'render.timeline',
  'quality.inspect',
  'speech.generate',
  'music.generate',
  'lyrics.transcribe',
  'lyrics.align',
  'media.composite',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
  /** True when a model safety filter rejected the prompt or output. */
  safety?: boolean;
  details?: string;
}

export interface CostEstimate {
  usd: number;
  /** `published_rate` = Google's published per-token price × expected tokens. `compute` = Cloud Run compute. */
  basis: 'published_rate' | 'compute' | 'none';
  confidence: 'high' | 'medium' | 'low';
  breakdown: { label: string; usd: number }[];
  notes: string[];
  pricingVersion: string;
}

export interface JobTarget {
  kind: 'shot' | 'chain' | 'character' | 'location' | 'element' | 'lookbook' | 'storyboard' | 'song' | 'script' | 'project' | 'timeline' | 'asset' | 'production' | 'score';
  id: string;
  /** Extra identifier, e.g. the take id created for a shot. */
  sub?: string;
}

export interface JobDoc {
  id: string;
  ownerUid: string;
  projectId: string | null;
  type: JobType;
  status: JobStatus;
  /** Human-readable stage message shown in the UI. */
  stage: string;
  progress: number;
  modelId: string | null;
  params: Record<string, unknown>;
  estimate: CostEstimate;
  batchId: string | null;
  target: JobTarget | null;
  label: string;
  attempt: number;
  retryOf: string | null;
  external: { interactionId?: string; executionName?: string; pollCount?: number; renderId?: string } | null;
  result: { assetIds?: string[]; aiRunId?: string; interactionId?: string; text?: string; reportId?: string; data?: Record<string, unknown> } | null;
  error: JobError | null;
  cancelRequested: boolean;
  usageUsd: number | null;
  /** Set on jobs a production run submitted; their completion advances the run. */
  productionId?: string | null;
  createdAt?: Time;
  updatedAt?: Time;
  startedAt?: Time;
  completedAt?: Time;
}

// ---------------------------------------------------------------------------
// Conversational chains (Omni interaction chains / Nano Banana edit histories)
// ---------------------------------------------------------------------------

export interface ChainDoc {
  id: string;
  ownerUid: string;
  projectId: string | null;
  kind: 'video' | 'image';
  title: string;
  headTurnId: string | null;
  turnCount: number;
  createdAt?: Time;
  updatedAt?: Time;
}

export interface ChainTurn {
  id: string;
  index: number;
  parentTurnId: string | null;
  prompt: string;
  mode: string;
  jobId: string;
  status: JobStatus;
  assetId: string | null;
  interactionId: string | null;
  createdAt?: Time;
}

// ---------------------------------------------------------------------------
// Film development
// ---------------------------------------------------------------------------

export interface ScriptDoc {
  id: string;
  title: string;
  /** Screenplay in Fountain markup. */
  content: string;
  version: number;
  pageCount: number;
  createdAt?: Time;
  updatedAt?: Time;
}

export interface ScriptVersion {
  id: string;
  version: number;
  content: string;
  note: string;
  createdAt?: Time;
}

export interface SequenceDoc {
  id: string;
  title: string;
  order: number;
  summary: string;
  color?: string;
}

export interface SceneDoc {
  id: string;
  sequenceId: string | null;
  order: number;
  number: string;
  heading: string;
  intExt: 'INT' | 'EXT' | 'INT/EXT' | '';
  locationName: string;
  locationId: string | null;
  timeOfDay: string;
  summary: string;
  characterIds: string[];
  props: string[];
  costumes: string[];
  mood: string;
  dialoguePlan: string;
  audioPlan: string;
  estimatedDurationSec: number;
  status: 'draft' | 'boarded' | 'generating' | 'assembled';
  notes: string;
}

export interface CharacterDoc {
  id: string;
  name: string;
  role: string;
  description: string;
  appearance: string;
  wardrobe: string;
  personality: string;
  voice: string;
  referenceAssetIds: string[];
  primaryRefAssetId: string | null;
  turnaroundAssetId: string | null;
  locked: boolean;
  /** Likeness safeguard: real people may only be depicted with their documented consent. */
  realPerson: boolean;
  consentConfirmed: boolean;
}

export interface LocationDoc {
  id: string;
  name: string;
  description: string;
  timeOfDay: string;
  palette: string;
  atmosphere: string;
  referenceAssetIds: string[];
  primaryRefAssetId: string | null;
  locked: boolean;
}

export type ElementKind = 'prop' | 'costume' | 'vehicle' | 'set_dressing';
export interface ElementDoc {
  id: string;
  kind: ElementKind;
  name: string;
  description: string;
  characterId: string | null;
  referenceAssetIds: string[];
  locked: boolean;
}

export interface DialogueLine {
  character: string;
  line: string;
}

export interface ShotDirections {
  framing: string;
  cameraMovement: string;
  lens: string;
  lighting: string;
  mood: string;
  style: string;
  performance: string;
  action: string;
  dialogue: DialogueLine[];
  ambientSound: string;
  avoid: string;
}

export type ShotStatus = 'planned' | 'queued' | 'generating' | 'ready' | 'approved' | 'failed';

export interface ShotRefs {
  characterIds: string[];
  locationIds: string[];
  elementIds: string[];
  /** Extra image/video assets used as references. */
  assetIds: string[];
  firstFrameAssetId: string | null;
  lastFrameAssetId: string | null;
  storyboardAssetId: string | null;
}

export interface ShotDoc {
  id: string;
  sceneId: string | null;
  sectionId: string | null;
  order: number;
  number: string;
  title: string;
  description: string;
  directions: ShotDirections;
  /** When set, this exact prompt is sent instead of the compiled directions. */
  promptOverride: string | null;
  durationSec: number;
  aspectRatio: '16:9' | '9:16';
  resolution: string;
  refs: ShotRefs;
  lockRefs: boolean;
  status: ShotStatus;
  selectedTakeId: string | null;
  approvedTakeId: string | null;
  /** For music videos: where this shot sits in the song (seconds). */
  timing: { start: number; end: number } | null;
  takeCount: number;
  notes: string;
  /** Latest quality-controlled production run for this shot (mirrored by the backend). */
  production?: ProductionSummary | null;
  createdAt?: Time;
  updatedAt?: Time;
}

export interface TakeDoc {
  id: string;
  index: number;
  jobId: string;
  assetId: string | null;
  status: JobStatus;
  prompt: string;
  params: Record<string, unknown>;
  interactionId: string | null;
  parentTakeId: string | null;
  label: string;
  rating: number;
  notes: string;
  approved: boolean;
  /** Quality control result for this take when it was produced by a production run. */
  productionId?: string | null;
  versionId?: string | null;
  quality?: { verdict: 'pending' | 'passed' | 'failed' | 'error'; overall: number | null; reportId: string | null } | null;
  createdAt?: Time;
}

export interface NoteDoc {
  id: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  context: { kind: 'scene' | 'shot' | 'character' | 'location' | 'general'; id: string | null };
  createdAt?: Time;
  updatedAt?: Time;
}

export interface AiRunDoc {
  id: string;
  task: string;
  jobId: string;
  status: JobStatus;
  modelId: string;
  output: unknown;
  outputText: string | null;
  createdAt?: Time;
}

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------

export const SECTION_LABELS = [
  'intro',
  'verse',
  'pre-chorus',
  'chorus',
  'post-chorus',
  'bridge',
  'breakdown',
  'drop',
  'instrumental',
  'hook',
  'outro',
  'other',
] as const;
export type SectionLabel = (typeof SECTION_LABELS)[number];

export interface SongSection {
  id: string;
  label: SectionLabel;
  name: string;
  start: number;
  end: number;
  energy: number;
}

export interface LyricLine {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface SongAnalysis {
  bpm: number;
  beats: number[];
  downbeats: number[];
  /** Normalised RMS energy sampled every `energyHop` seconds. */
  energy: number[];
  energyHop: number;
  sections: SongSection[];
  method: 'dsp' | 'dsp+ai';
  analyzedAt: number;
}

export interface SongDoc {
  id: string;
  audioAssetId: string;
  title: string;
  artist: string;
  durationSec: number;
  analysis: SongAnalysis | null;
  lyrics: { source: 'upload' | 'ai' | 'manual'; lines: LyricLine[] } | null;
  ai: { genre?: string; mood?: string; instrumentation?: string; tempoFeel?: string; summary?: string } | null;
  /** Part of the song being produced (seconds); null or missing means the whole song. */
  range?: { start: number; end: number } | null;
  /** Editable lyric sheet with word timing (source of truth for captions and exports). */
  lyricsSheet?: LyricsSheet | null;
  /** Explicitly instrumental: AZ Studio never invents lyrics for it. */
  instrumental?: boolean;
  /** Vocal detection result for the audio. */
  vocals?: { present: boolean; confidence: number; checkedAt: number; note: string } | null;
  /** Cached word-timed transcription of the vocals (lets corrections re-sync without a new model call). */
  asr?: { words: AsrWord[]; modelId: string; languageCode: string | null; audioAssetId: string; createdAt: number } | null;
  /** A transcribed draft kept aside because approved lyrics already exist. */
  lyricsCandidate?: LyricsSheet | null;
  /** Present when the song itself was generated. */
  generation?: { jobId: string; modelId: string; prompt: string; caption: string; bpm: number | null } | null;
  createdAt?: Time;
  updatedAt?: Time;
}

// ---------------------------------------------------------------------------
// Timeline & rendering
// ---------------------------------------------------------------------------

export const TRACK_KINDS = ['video', 'overlay', 'caption', 'audio'] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
  /** Linear gain for audio tracks (0–2). */
  volume: number;
}

export const CLIP_KINDS = ['video', 'image', 'audio', 'caption', 'title'] as const;
export type ClipKind = (typeof CLIP_KINDS)[number];

export const TRANSITION_TYPES = ['cut', 'dissolve', 'dip_black', 'dip_white', 'slide_left', 'slide_right'] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

export const TEXT_FONTS = ['Inter', 'EB Garamond', 'DejaVu Sans', 'Noto Sans'] as const;
export type TextFont = (typeof TEXT_FONTS)[number];

export interface TextStyle {
  font: TextFont;
  /** Font size as a percentage of the frame height. */
  sizePct: number;
  color: string;
  background: string | null;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  outline: number;
  shadow: boolean;
  /** Karaoke / phrase highlight colour (sung text). */
  highlight?: string | null;
}

export interface TextPosition {
  anchor: 'top' | 'middle' | 'bottom';
  /** Vertical offset as a fraction of frame height (positive moves toward the centre). */
  offset: number;
  align: 'left' | 'center' | 'right';
}

export type FitMode = 'fill' | 'fit' | 'blur';

export interface Clip {
  id: string;
  trackId: string;
  kind: ClipKind;
  /** Timeline position (seconds). */
  start: number;
  /** Timeline duration (seconds). */
  duration: number;
  assetId: string | null;
  /** Source in-point (seconds) for video/audio clips. */
  inPoint: number;
  /** Duration of the source media, used to bound trims. `null` for stills and text. */
  sourceDuration: number | null;
  volume: number;
  useSourceAudio: boolean;
  fadeIn: number;
  fadeOut: number;
  transitionIn: { type: TransitionType; duration: number };
  fit: FitMode;
  kenBurns: boolean;
  text: string;
  style: TextStyle | null;
  position: TextPosition | null;
  label: string;
  shotId: string | null;
  takeId: string | null;
  /** Audio role in the mix: music is ducked under dialogue and follows score automation. */
  role?: 'music' | 'dialogue' | 'effects' | null;
  /** Lower this clip automatically while dialogue plays. */
  duck?: boolean;
  /** How far a ducked clip drops under dialogue (dB). */
  duckDb?: number;
  /** Linear gain keyframes relative to the clip start (score volume automation). */
  volumeAutomation?: { t: number; gain: number }[] | null;
  /** Audio clip of a song in the project (lyric captions follow it). */
  songId?: string | null;
  /** Caption generated from a song's lyric sheet; re-timed from the sheet whenever the song moves. */
  lyric?: { songId: string; lineId: string; mode: LyricCaptionMode } | null;
  /** Highlight units (words or phrases) relative to the caption start. */
  karaoke?: { text: string; start: number; end: number }[] | null;
}

export interface TimelineMarker {
  id: string;
  time: number;
  label: string;
  color: string;
}

export interface TimelineDoc {
  id: string;
  ownerUid: string;
  projectId: string;
  name: string;
  fps: 24 | 25 | 30;
  aspectRatio: FrameAspect;
  tracks: Track[];
  clips: Clip[];
  markers: TimelineMarker[];
  /** Optional beat grid for snapping (music videos). */
  beatGrid: { bpm: number; beats: number[] } | null;
  version: number;
  durationSec: number;
  createdAt?: Time;
  updatedAt?: Time;
}

export type RenderQuality = 'draft' | 'final';

export interface RenderDoc {
  id: string;
  ownerUid: string;
  projectId: string;
  timelineId: string;
  timelineVersion: number;
  preset: string;
  quality: RenderQuality;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  status: JobStatus;
  stage: string;
  progress: number;
  jobId: string;
  executionName: string | null;
  outputAssetId: string | null;
  error: JobError | null;
  createdAt?: Time;
  updatedAt?: Time;
  completedAt?: Time;
}

// ---------------------------------------------------------------------------
// Settings & usage
// ---------------------------------------------------------------------------

export interface StudioSettings {
  maxConcurrentGenerations: number;
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
  /** Batches estimated above this amount require an explicit confirmation step. */
  confirmAboveUsd: number;
  maxBatchSize: number;
  defaultVideoResolution: string;
  defaultImageSize: string;
}

export const DEFAULT_SETTINGS: StudioSettings = {
  maxConcurrentGenerations: 2,
  dailyLimitUsd: 25,
  monthlyLimitUsd: 250,
  confirmAboveUsd: 1,
  maxBatchSize: 24,
  defaultVideoResolution: '720p',
  defaultImageSize: '2K',
};

export interface UsageRecord {
  id: string;
  ownerUid: string;
  projectId: string | null;
  jobId: string;
  modelId: string;
  kind: 'image' | 'video' | 'text' | 'audio' | 'render' | 'speech' | 'transcription' | 'music';
  tokens: { input: number; output: number; thoughts: number; byModality: Record<string, number> };
  costUsd: number;
  pricingVersion: string;
  day: string;
  month: string;
  createdAt?: Time;
}

export interface UsageAggregate {
  costUsd: number;
  jobs: number;
  byModel: Record<string, number>;
}
