import { z } from 'zod';
import { ASSET_KINDS, SECTION_LABELS } from './types';
import { SET_VIEWS } from './continuity';
import { characterBibleSchema, CONTINUITY_COLLECTIONS } from './continuity-schemas';
import { COVERAGE_TYPES } from './coverage';
import { MUSIC_MODES } from './music-studio';

/**
 * Request schemas for the `azsApi` callable. Structural validation lives here; values that depend
 * on the active model (resolutions, aspect ratios, durations…) are re-validated server-side against
 * the model registry so unsupported parameters are never sent to Vertex AI.
 */

const id = z.string().min(1).max(128).regex(/^[\w-]+$/, 'Invalid id');
const text = (max: number) => z.string().max(max);

export const jobTargetSchema = z.object({
  kind: z.enum(['shot', 'chain', 'character', 'location', 'element', 'lookbook', 'storyboard', 'song', 'script', 'project', 'timeline', 'asset', 'production', 'score', 'set', 'music_project', 'render', 'screen', 'final_inspection']),
  id,
  sub: id.optional(),
});

export const omniMediaRefSchema = z.object({
  role: z.enum(['first_frame', 'last_frame', 'image_ref', 'video_ref', 'source_video']),
  assetId: id,
  label: text(120).optional(),
});

export const imageJobSchema = z.object({
  type: z.literal('image.generate'),
  projectId: id.nullable().optional(),
  prompt: z.string().trim().min(1, 'Describe the image.').max(8000),
  purpose: z.enum(['free', 'character', 'turnaround', 'costume', 'location', 'poster', 'thumbnail', 'storyboard', 'product', 'style_match', 'lookbook']).default('free'),
  aspectRatio: z.string().min(3).max(6),
  imageSize: z.string().min(2).max(3),
  referenceAssetIds: z.array(id).max(14).default([]),
  /** Image being edited (image-to-image / conversational edit). */
  sourceAssetId: id.nullable().optional(),
  chainId: id.nullable().optional(),
  parentTurnId: id.nullable().optional(),
  grounding: z.boolean().default(false),
  applyStyleBible: z.boolean().default(true),
  characterIds: z.array(id).max(10).default([]),
  collections: z.array(text(80)).max(10).default([]),
  title: text(160).optional(),
  label: text(160).optional(),
  target: jobTargetSchema.nullable().optional(),
});

export const videoJobSchema = z.object({
  type: z.literal('video.generate'),
  projectId: id.nullable().optional(),
  mode: z.enum(['generate', 'edit', 'extend']).default('generate'),
  prompt: z.string().trim().min(1, 'Describe the shot or the change.').max(12000),
  aspectRatio: z.string().max(6).nullable().optional(),
  resolution: z.string().max(8).nullable().optional(),
  durationSec: z.number().int().min(1).max(60).nullable().optional(),
  media: z.array(omniMediaRefSchema).max(16).default([]),
  /** Continue an Omni interaction chain from this turn (server resolves the interaction id). */
  chainId: id.nullable().optional(),
  parentTurnId: id.nullable().optional(),
  /** For shot targets: edit this earlier take (server resolves its interaction). */
  parentTakeId: id.nullable().optional(),
  characterIds: z.array(id).max(10).default([]),
  title: text(160).optional(),
  label: text(160).optional(),
  target: jobTargetSchema.nullable().optional(),
});

export const TEXT_TASKS = [
  'film.treatment',
  'film.screenplay_draft',
  'film.screenplay_rewrite',
  'film.screenplay_continue',
  'film.structure',
  'film.breakdown',
  'film.characters',
  'film.locations',
  'film.shotlist',
  'music.treatment',
  'music.shotlist',
  'prompt.polish',
  'storyboard.prompts',
  'music.lyrics',
  'film.score_bible',
  'film.cue_sheet',
  'film.coverage',
  'music.brief_from_media',
] as const;
export type TextTask = (typeof TEXT_TASKS)[number];

export const textJobSchema = z.object({
  type: z.literal('text.assist'),
  projectId: id.nullable().optional(),
  task: z.enum(TEXT_TASKS),
  input: z.record(z.string(), z.unknown()),
  label: text(160).optional(),
  target: jobTargetSchema.nullable().optional(),
});

export const audioJobSchema = z.object({
  type: z.literal('audio.analyze'),
  projectId: id,
  songId: id,
  audioAssetId: id,
  transcribeLyrics: z.boolean().default(true),
  label: text(160).optional(),
});

export const renderJobSchema = z.object({
  type: z.literal('render.timeline'),
  projectId: id,
  timelineId: id,
  preset: z.enum(['youtube_16x9', 'vertical_9x16', 'square_1x1', 'portrait_4x5']),
  quality: z.enum(['draft', 'final']),
  /** Run the final-film inspection on the finished render. */
  inspect: z.boolean().default(false),
  /** Render even though lyric captions are out of sync with the vocals (the issues are recorded). */
  acceptLyricSync: z.boolean().default(false),
  label: text(160).optional(),
});

const languageCode = z.string().trim().min(2).max(24).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'Use a language code such as en, tw or xsm');

export const speechJobSchema = z.object({
  type: z.literal('speech.generate'),
  projectId: id,
  lines: z
    .array(z.object({ index: z.number().int().min(0).max(500), character: text(80), text: z.string().trim().min(1).max(2000), voice: text(40).nullable().optional(), direction: text(300).optional() }))
    .min(1)
    .max(40),
  languageCode: languageCode.nullable().optional(),
  label: text(160).optional(),
  target: jobTargetSchema.nullable().optional(),
});

export const musicJobSchema = z.object({
  type: z.literal('music.generate'),
  projectId: id,
  purpose: z.enum(['song', 'score_movement']),
  /** Music Studio project the generated version belongs to (a new musicVersions entry). */
  musicProjectId: id.nullable().optional(),
  mode: z.enum(MUSIC_MODES).optional(),
  /** Alternate movement of a score (kept beside the current one). */
  alternate: z.boolean().default(false),
  prompt: z.string().trim().min(1, 'Describe the music.').max(12000),
  /** Exact lyrics to sing (section tags allowed). Omitted for instrumental music. */
  lyrics: z.string().max(12000).nullable().optional(),
  instrumental: z.boolean().default(false),
  languageCode: languageCode.nullable().optional(),
  imageAssetIds: z.array(id).max(10).default([]),
  songId: id.nullable().optional(),
  scoreId: id.nullable().optional(),
  movementId: text(40).nullable().optional(),
  title: text(160).optional(),
  label: text(160).optional(),
});

export const lyricsTranscribeJobSchema = z.object({
  type: z.literal('lyrics.transcribe'),
  projectId: id,
  songId: id,
  audioAssetId: id,
  languageCode: languageCode.nullable().optional(),
  label: text(160).optional(),
});

export const lyricsAlignJobSchema = z.object({
  type: z.literal('lyrics.align'),
  projectId: id,
  songId: id,
  audioAssetId: id,
  languageCode: languageCode.nullable().optional(),
  /** Transcribe the vocals again even if a cached transcription exists. */
  retranscribe: z.boolean().default(false),
  label: text(160).optional(),
});

export const referencePackJobSchema = z.object({
  type: z.literal('reference.pack'),
  projectId: id,
  locationId: id,
  views: z.array(z.enum(SET_VIEWS)).min(1).max(5),
  imageSize: z.string().min(2).max(3).default('2K'),
  aspectRatio: z.string().min(3).max(6).default('16:9'),
  direction: text(2000).optional(),
  label: text(160).optional(),
});

export const continuityCompareJobSchema = z.object({ type: z.literal('continuity.compare'), projectId: id, shotIds: z.array(id).min(2).max(12), label: text(160).optional() });

export const screenReplaceJobSchema = z.object({ type: z.literal('media.screen_replace'), projectId: id, sourceAssetId: id, screenId: id, shotId: id.nullable().optional(), label: text(160).optional() });

export const colorMatchJobSchema = z.object({
  type: z.literal('media.color_match'),
  projectId: id,
  sourceAssetId: id,
  /** Still or clip to match; defaults to the Colour Director's approved reference still. */
  referenceAssetId: id.nullable().optional(),
  strength: z.number().min(0.1).max(1).default(0.8),
  applyLut: z.boolean().default(false),
  shotId: id.nullable().optional(),
  label: text(160).optional(),
});

export const analyzeSubjectsJobSchema = z.object({ type: z.literal('media.analyze_subjects'), projectId: id, assetIds: z.array(id).min(1).max(60), fps: z.number().min(0.5).max(4).default(1), label: text(160).optional() });

export const lyricsResyncAudioJobSchema = z.object({ type: z.literal('lyrics.resync_audio'), projectId: id, songId: id, fromAssetId: id, toAssetId: id, label: text(160).optional() });

export const finalInspectJobSchema = z.object({ type: z.literal('final.inspect'), projectId: id, renderId: id, label: text(160).optional() });

export const musicAnalyzeJobSchema = z.object({
  type: z.literal('music.analyze'),
  projectId: id,
  audioAssetId: id,
  musicProjectId: id.nullable().optional(),
  versionId: id.nullable().optional(),
  detectVocals: z.boolean().default(true),
  label: text(160).optional(),
});

export const musicArrangeJobSchema = z.object({ type: z.literal('music.arrange'), projectId: id, musicProjectId: id, versionId: id, label: text(160).optional() });

export const musicMixJobSchema = z.object({ type: z.literal('music.mix'), projectId: id, musicProjectId: id, label: text(160).optional() });

export const musicReplaceSectionJobSchema = z.object({
  type: z.literal('music.replace_section'),
  projectId: id,
  musicProjectId: id,
  versionId: id,
  sectionId: id,
  direction: text(2000).default(''),
  lyrics: z.string().max(4000).nullable().optional(),
  label: text(160).optional(),
});

export const stemsJobSchema = z.object({ type: z.literal('audio.stems'), projectId: id, audioAssetId: id, musicProjectId: id.nullable().optional(), versionId: id.nullable().optional(), label: text(160).optional() });

export const jobRequestSchema = z.discriminatedUnion('type', [
  imageJobSchema,
  videoJobSchema,
  textJobSchema,
  audioJobSchema,
  renderJobSchema,
  speechJobSchema,
  musicJobSchema,
  lyricsTranscribeJobSchema,
  lyricsAlignJobSchema,
  referencePackJobSchema,
  continuityCompareJobSchema,
  screenReplaceJobSchema,
  colorMatchJobSchema,
  analyzeSubjectsJobSchema,
  lyricsResyncAudioJobSchema,
  finalInspectJobSchema,
  musicAnalyzeJobSchema,
  musicArrangeJobSchema,
  musicMixJobSchema,
  musicReplaceSectionJobSchema,
  stemsJobSchema,
]);
export type JobRequest = z.infer<typeof jobRequestSchema>;
export type ImageJobRequest = z.infer<typeof imageJobSchema>;
export type VideoJobRequest = z.infer<typeof videoJobSchema>;
export type TextJobRequest = z.infer<typeof textJobSchema>;
export type AudioJobRequest = z.infer<typeof audioJobSchema>;
export type RenderJobRequest = z.infer<typeof renderJobSchema>;
export type SpeechJobRequest = z.infer<typeof speechJobSchema>;
export type MusicJobRequest = z.infer<typeof musicJobSchema>;
export type LyricsTranscribeJobRequest = z.infer<typeof lyricsTranscribeJobSchema>;
export type LyricsAlignJobRequest = z.infer<typeof lyricsAlignJobSchema>;
export type ReferencePackJobRequest = z.infer<typeof referencePackJobSchema>;
export type ContinuityCompareJobRequest = z.infer<typeof continuityCompareJobSchema>;
export type ScreenReplaceJobRequest = z.infer<typeof screenReplaceJobSchema>;
export type ColorMatchJobRequest = z.infer<typeof colorMatchJobSchema>;
export type AnalyzeSubjectsJobRequest = z.infer<typeof analyzeSubjectsJobSchema>;
export type LyricsResyncAudioJobRequest = z.infer<typeof lyricsResyncAudioJobSchema>;
export type FinalInspectJobRequest = z.infer<typeof finalInspectJobSchema>;
export type MusicAnalyzeJobRequest = z.infer<typeof musicAnalyzeJobSchema>;
export type MusicArrangeJobRequest = z.infer<typeof musicArrangeJobSchema>;
export type MusicMixJobRequest = z.infer<typeof musicMixJobSchema>;
export type MusicReplaceSectionJobRequest = z.infer<typeof musicReplaceSectionJobSchema>;
export type StemsJobRequest = z.infer<typeof stemsJobSchema>;

export const qualitySettingsSchema = z.object({
  autoQualityReview: z.boolean(),
  autoFixIncomplete: z.boolean(),
  ensureCompleteDialogue: z.boolean(),
  ensureCompleteAction: z.boolean(),
  checkContinuity: z.boolean(),
  maxRepairAttempts: z.number().int().min(0).max(6),
  minApprovalScore: z.number().int().min(0).max(100),
  repairCostCeilingUsd: z.number().min(0).max(200),
  requireApprovalForExpensiveRetries: z.boolean(),
  expensiveRetryUsd: z.number().min(0).max(100),
  dialogueAudio: z.enum(['generate', 'estimate']),
  openingAllowanceSec: z.number().min(0.4).max(1),
  closingAllowanceSec: z.number().min(0.8).max(1.5),
  maxTakesPerShot: z.number().int().min(1).max(4),
});

export const productionOptionsSchema = z.object({
  /** The creator's preferred duration (a preference, not a limit). */
  requestedSec: z.number().min(1).max(60),
  /** Uploaded recordings per dialogue line, measured instead of generated guide audio. */
  uploadedAudio: z.array(z.object({ lineIndex: z.number().int().min(0).max(500), assetId: id })).max(40).default([]),
  /** Measure line lengths from this earlier take (identify the final dialogue audio). */
  identifyFromTakeId: id.nullable().optional(),
  /** Review an existing take instead of generating: it becomes version 1 and goes straight to inspection and repair. */
  reviewTakeId: id.nullable().optional(),
  settings: qualitySettingsSchema.partial().optional(),
  /** Independent takes generated side by side; the strongest is recommended (the director approves). */
  takes: z.number().int().min(1).max(4).default(1),
});

export const PRODUCTION_ACTIONS = ['approve', 'repair', 'extend', 'split', 'regenerate', 'keep_original', 'waive', 'unwaive', 'cancel', 'reinspect', 'approve_pending_repair', 'dismiss_pending_repair', 'choose_version', 'color_match', 'screen_composite', 'correct_blocking', 'regenerate_with_references'] as const;
export type ProductionAction = (typeof PRODUCTION_ACTIONS)[number];

export const settingsSchema = z.object({
  maxConcurrentGenerations: z.number().int().min(1).max(8),
  dailyLimitUsd: z.number().min(0).max(5000),
  monthlyLimitUsd: z.number().min(0).max(50000),
  confirmAboveUsd: z.number().min(0).max(1000),
  maxBatchSize: z.number().int().min(1).max(100),
  defaultVideoResolution: z.string().max(8),
  defaultImageSize: z.string().max(3),
});

export const apiRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('bootstrap'), payload: z.object({}).default({}) }),
  z.object({
    action: z.literal('createUpload'),
    payload: z.object({
      kind: z.enum(ASSET_KINDS),
      fileName: z.string().min(1).max(255),
      mimeType: z.string().min(1).max(120),
      sizeBytes: z.number().int().positive(),
      projectId: id.nullable().optional(),
      title: text(160).optional(),
      collections: z.array(text(80)).max(10).default([]),
    }),
  }),
  z.object({
    action: z.literal('mediaUrls'),
    payload: z.object({
      assetIds: z.array(id).min(1).max(200),
      variants: z.array(z.enum(['file', 'thumb', 'poster', 'waveform'])).default(['file', 'thumb', 'poster']),
      download: z.boolean().default(false),
    }),
  }),
  z.object({ action: z.literal('estimate'), payload: z.object({ jobs: z.array(jobRequestSchema).min(1).max(100) }) }),
  z.object({
    action: z.literal('submitJobs'),
    payload: z.object({
      jobs: z.array(jobRequestSchema).min(1).max(100),
      /** The estimate (USD) the owner confirmed; required for large or multi-video batches. */
      confirmedUsd: z.number().min(0).nullable().optional(),
      batchLabel: text(160).optional(),
    }),
  }),
  z.object({ action: z.literal('cancelJob'), payload: z.object({ jobId: id }) }),
  z.object({ action: z.literal('retryJob'), payload: z.object({ jobId: id, acknowledgeCharge: z.literal(true) }) }),
  z.object({ action: z.literal('updateSettings'), payload: settingsSchema.partial() }),
  z.object({ action: z.literal('deleteAsset'), payload: z.object({ assetId: id }) }),
  z.object({
    action: z.literal('deriveClip'),
    payload: z.object({ assetId: id, startSec: z.number().min(0), durationSec: z.number().min(0.5).max(60), title: text(160).optional() }),
  }),
  z.object({
    action: z.literal('extractFrame'),
    payload: z.object({ assetId: id, atSec: z.number().min(0), title: text(160).optional(), collections: z.array(text(80)).max(10).default([]) }),
  }),
  z.object({ action: z.literal('deleteProject'), payload: z.object({ projectId: id, confirmTitle: z.string().min(1).max(200) }) }),
  z.object({ action: z.literal('usageSummary'), payload: z.object({ days: z.number().int().min(1).max(90).default(30) }) }),
  z.object({
    action: z.literal('estimateProduction'),
    payload: z.object({ projectId: id, shotId: id, job: videoJobSchema, options: productionOptionsSchema }),
  }),
  z.object({
    action: z.literal('startProduction'),
    payload: z.object({ projectId: id, shotId: id, job: videoJobSchema, options: productionOptionsSchema, confirmedUsd: z.number().min(0).nullable().optional() }),
  }),
  z.object({
    action: z.literal('productionAction'),
    payload: z.object({
      productionId: id,
      action: z.enum(PRODUCTION_ACTIONS),
      versionId: id.nullable().optional(),
      categories: z.array(text(40)).max(40).default([]),
      note: text(500).optional(),
      instruction: text(2000).optional(),
      extendSec: z.number().int().min(1).max(10).nullable().optional(),
      confirmedUsd: z.number().min(0).nullable().optional(),
    }),
  }),
  z.object({ action: z.literal('modelStatus'), payload: z.object({ refresh: z.boolean().default(false) }).default({ refresh: false }) }),
  z.object({
    action: z.literal('continuitySave'),
    payload: z.object({ projectId: id, collection: z.enum(CONTINUITY_COLLECTIONS), id: id.nullable().optional(), data: z.record(z.string(), z.unknown()) }),
  }),
  z.object({ action: z.literal('continuityDelete'), payload: z.object({ projectId: id, collection: z.enum(CONTINUITY_COLLECTIONS), id }) }),
  z.object({ action: z.literal('characterBibleSave'), payload: z.object({ projectId: id, characterId: id, bible: characterBibleSchema, approve: z.boolean().default(false) }) }),
  z.object({ action: z.literal('bibleApprove'), payload: z.object({ projectId: id, kind: z.enum(['visual', 'character', 'set']), id, approve: z.boolean(), views: z.array(z.enum(SET_VIEWS)).max(5).default([]) }) }),
  z.object({ action: z.literal('continuityCheck'), payload: z.object({ projectId: id, shotId: id, save: z.boolean().default(true) }) }),
  z.object({ action: z.literal('continuityWarning'), payload: z.object({ projectId: id, shotId: id, warningId: text(80), action: z.enum(['override', 'reopen', 'resolve']), note: text(500).default('') }) }),
  z.object({ action: z.literal('insertNeutralShot'), payload: z.object({ projectId: id, afterShotId: id, kind: z.enum(['head_on', 'tail_away', 'cutaway']) }) }),
  z.object({
    action: z.literal('coverageApply'),
    payload: z.object({
      projectId: id,
      sceneId: id.nullable(),
      masterShotId: id.nullable(),
      suggestions: z
        .array(
          z.object({
            id: text(40),
            type: z.enum(COVERAGE_TYPES),
            subjectIds: z.array(id).max(6),
            description: text(400),
            action: text(400),
            framing: text(80),
            lens: text(60),
            cameraMovement: text(80),
            durationSec: z.number().min(1).max(60),
            dialogueLines: z.array(z.number().int().min(0).max(500)).max(40),
            priority: z.enum(['essential', 'recommended', 'optional']),
            rationale: text(300),
            accepted: z.boolean(),
          }),
        )
        .min(1)
        .max(16),
    }),
  }),
  z.object({ action: z.literal('finalInspectionAction'), payload: z.object({ projectId: id, inspectionId: id, action: z.enum(['apply_fix', 'apply_all_fixes', 'override', 'clear_override', 'resolve', 'reopen']), findingId: text(80).nullable().optional(), note: text(500).optional() }) }),
  z.object({ action: z.literal('musicSetMaster'), payload: z.object({ projectId: id, musicProjectId: id, versionId: id }) }),
  z.object({ action: z.literal('musicToVideo'), payload: z.object({ projectId: id, musicProjectId: id, versionId: id, targetProjectId: id }) }),
  z.object({ action: z.literal('cancelQueued'), payload: z.object({ projectId: id.nullable().optional() }) }),
  z.object({ action: z.literal('creditsMetadata'), payload: z.object({ projectId: id }) }),
  z.object({ action: z.literal('continuityOverview'), payload: z.object({ projectId: id }) }),
  /** Director corrections of an automatic music analysis (kept through re-analysis). */
  z.object({
    action: z.literal('musicCorrectAnalysis'),
    payload: z.object({
      projectId: id,
      versionId: id,
      corrections: z.object({
        bpm: z.number().min(30).max(300).optional(),
        key: text(40).optional(),
        timeSignature: z.string().regex(/^\d{1,2}\/\d{1,2}$/, 'Use a time signature such as 4/4').optional(),
        sections: z.array(z.object({ id, label: z.enum(SECTION_LABELS), name: text(80), start: z.number().min(0), end: z.number().min(0), energy: z.number().min(0).max(1) })).max(80).optional(),
        downbeats: z.array(z.number().min(0)).max(5000).optional(),
      }),
    }),
  }),
  /** Approve or withdraw a shot's take (approval updates canonical continuity; the rules deny direct writes). */
  z.object({ action: z.literal('takeAction'), payload: z.object({ projectId: id, shotId: id, takeId: id, action: z.enum(['approve', 'withdraw']), note: text(500).optional() }) }),
]);
export type ApiRequest = z.infer<typeof apiRequestSchema>;
export type ApiAction = ApiRequest['action'];
