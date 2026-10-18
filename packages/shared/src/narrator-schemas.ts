import { z } from 'zod';
import { CONSENT_LOCALES, DELIVERY_PRESET_IDS, ENROLLMENT, MAX_STYLE_CHARS, NARRATOR_ROUTES, NOISE_REDUCTION_LEVELS, PAUSE_LIMITS } from './narrator';

/** Request schemas for Pwavwe Narrator (`azsApi` action `narrator`, one `op` per operation). */

const id = z.string().min(1).max(128).regex(/^[\w-]+$/, 'Invalid id');
const requestId = z.string().min(8).max(64).regex(/^[\w-]+$/, 'Invalid request id');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const httpsUrl = z
  .string()
  .max(500)
  .refine((s) => {
    try {
      return new URL(s).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Use a full https:// address');

/** The article body (≈ 20,000 words) and spoken text limits keep an edition inside one Firestore document. */
export const NARRATOR_LIMITS = { bodyChars: 120_000, passageChars: 12_000, passages: 1200, sections: 300, titleChars: 200, selectionChars: 1500, testChars: 800 } as const;

export const passageSchema = z.object({
  id,
  kind: z.enum(['opening', 'heading', 'paragraph', 'closing']),
  text: z.string().max(NARRATOR_LIMITS.passageChars),
  source: z.string().max(NARRATOR_LIMITS.passageChars),
  skip: z.boolean().optional(),
  style: z.string().max(MAX_STYLE_CHARS).nullable().optional(),
});

export const scriptSchema = z
  .object({
    opening: passageSchema.nullable(),
    sections: z.array(z.object({ id, title: z.string().max(400).nullable(), passages: z.array(passageSchema).max(NARRATOR_LIMITS.passages) })).max(NARRATOR_LIMITS.sections),
    closing: passageSchema.nullable(),
  })
  .refine((s) => s.sections.reduce((n, x) => n + x.passages.length, 0) <= NARRATOR_LIMITS.passages, 'Too many paragraphs for one edition.')
  .refine((s) => {
    const ids = [s.opening?.id, s.closing?.id, ...s.sections.map((x) => x.id), ...s.sections.flatMap((x) => x.passages.map((p) => p.id))].filter(Boolean);
    return new Set(ids).size === ids.length;
  }, 'Duplicate passage ids.');

const pause = z.number().min(PAUSE_LIMITS.min).max(PAUSE_LIMITS.max);
export const pausesSchema = z.object({ afterOpeningSec: pause, betweenParagraphsSec: pause, betweenSectionsSec: pause, afterHeadingSec: pause, beforeClosingSec: pause });

export const editionSettingsSchema = z.object({
  preset: z.enum(DELIVERY_PRESET_IDS),
  customStyle: z.string().max(MAX_STYLE_CHARS),
  includeClosing: z.boolean(),
  pauses: pausesSchema,
  readMode: z.enum(['passages', 'oneTake']).optional(),
});

export const directionSchema = z.object({
  id,
  passageId: id,
  kind: z.enum(['pause', 'emphasis', 'style', 'vocal']),
  at: z.number().int().min(0).max(NARRATOR_LIMITS.passageChars).optional(),
  start: z.number().int().min(0).max(NARRATOR_LIMITS.passageChars).optional(),
  end: z.number().int().min(0).max(NARRATOR_LIMITS.passageChars).optional(),
  value: z.string().max(80),
  quote: z.string().max(200),
  before: z.string().max(60),
  after: z.string().max(60),
  textHash: z.string().max(40),
  source: z.enum(['auto', 'manual']),
  status: z.enum(['suggested', 'accepted', 'rejected', 'needs_review']),
  intensity: z.enum(['subtle', 'expressive', 'dramatic']).nullable(),
  rationale: z.string().max(300).nullable(),
  jobId: z.string().max(128).nullable(),
  createdAt: z.number(),
});

export const editionPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(NARRATOR_LIMITS.titleChars),
    author: z.string().trim().max(120),
    publishedDate: isoDate.nullable(),
    sourceUrl: httpsUrl.nullable(),
    voiceId: id.nullable(),
    article: z.object({ body: z.string().max(NARRATOR_LIMITS.bodyChars), origin: z.enum(['paste', 'url', 'package']), importedAt: z.number().nullable(), notes: z.array(z.string().max(400)).max(20) }),
    script: scriptSchema,
    settings: editionSettingsSchema,
    soundcloud: z.object({ title: z.string().max(100), description: z.string().max(4000) }),
    directions: z.array(directionSchema).max(3000),
    directionsMergedJobs: z.array(id).max(200),
  })
  .partial();

export const pronunciationSchema = z.object({
  id,
  term: z.string().trim().min(1).max(80),
  spokenAs: z.string().max(120),
  hint: z.string().max(300),
  caseSensitive: z.boolean(),
  recordingId: id.nullable(),
});

export const narratorSettingsSchema = z
  .object({
    modelId: z.string().max(80).nullable(),
    route: z.enum(NARRATOR_ROUTES),
    generationBudgetUsd: z.number().min(0.05).max(50),
    channels: z.union([z.literal(1), z.literal(2)]),
    loudness: z.enum(['podcast', 'streaming']),
    defaultPreset: z.enum(DELIVERY_PRESET_IDS),
    openingTemplate: z.string().trim().min(1).max(400),
    closingText: z.string().trim().min(1).max(600),
    includeClosing: z.boolean(),
    pauses: pausesSchema,
    noiseReduction: z.enum(NOISE_REDUCTION_LEVELS),
  })
  .partial();

const assessmentScore = z.number().int().min(1).max(5).nullable();
export const assessmentSchema = z.object({ naturalness: assessmentScore, resemblance: assessmentScore, accent: assessmentScore, pronunciation: assessmentScore, pacing: assessmentScore, notes: z.string().max(1000) });

const scope = z.enum(['selection', 'passages', 'section', 'edition', 'preview']);
const generationTarget = {
  editionId: id,
  scope,
  passageIds: z.array(id).max(NARRATOR_LIMITS.passages).default([]),
  sectionId: id.nullable().optional(),
  selection: z.string().max(NARRATOR_LIMITS.selectionChars).optional(),
  /** Make another take even when the passage already has current audio. */
  force: z.boolean().default(false),
  /** scope 'preview': a listening preview of one passage, with or without its accepted directions (never a take). */
  variant: z.enum(['directed', 'undirected']).optional(),
};

// Base64 of the largest accepted upload.
const maxB64 = Math.ceil((ENROLLMENT.maxInlineBytes * 4) / 3) + 8;

export const narratorRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status'), refresh: z.boolean().default(false) }),
  z.object({
    op: z.literal('recordingUpload'),
    kind: z.enum(['reference', 'consent', 'pronunciation']),
    source: z.enum(['microphone', 'upload']),
    mimeType: z.string().max(100),
    dataBase64: z.string().min(16).max(maxB64).optional(),
    /** A file the owner uploaded to users/{uid}/narrator-inbox/ (checked server-side). */
    inboxPath: z.string().max(300).regex(/^users\/[\w-]+\/narrator-inbox\/[\w.-]+$/).optional(),
    scriptText: z.string().max(2000).optional(),
    consentLocale: z.enum(CONSENT_LOCALES).optional(),
    /** Which route's consent sentence a consent clip reads. */
    consentRoute: z.enum(NARRATOR_ROUTES).optional(),
    termId: id.optional(),
  }),
  z.object({ op: z.literal('recordingDelete'), recordingId: id }),
  z.object({ op: z.literal('voiceCreate'), referenceId: id, consentId: id, consentLocale: z.enum(CONSENT_LOCALES), requestId, attestSameAdultSpeaker: z.literal(true) }),
  z.object({ op: z.literal('voiceTest'), voiceId: id, text: z.string().trim().min(1).max(NARRATOR_LIMITS.testChars), preset: z.enum(DELIVERY_PRESET_IDS), customStyle: z.string().max(MAX_STYLE_CHARS).default(''), requestId }),
  z.object({ op: z.literal('voiceAssess'), voiceId: id, decision: z.enum(['approve', 'reject', 'pending']), assessment: assessmentSchema, preset: z.enum(DELIVERY_PRESET_IDS) }),
  z.object({ op: z.literal('voiceRefresh'), voiceId: id }),
  z.object({ op: z.literal('voiceDelete'), voiceId: id, confirmName: z.string().max(200) }),
  z.object({ op: z.literal('voiceReconcile') }),
  /** Deletes a replicated voice found at Google that no active profile here uses (e.g. after an interrupted creation). */
  z.object({ op: z.literal('providerVoiceDelete'), providerVoiceId: z.string().regex(/^voice_[\w-]{1,120}$/), route: z.enum(NARRATOR_ROUTES).default('developer'), confirm: z.literal(true) }),
  /** A short Google Cloud narration test with a prebuilt voice (unlocks the Cloud route). */
  z.object({ op: z.literal('cloudCheck'), requestId }),
  z.object({ op: z.literal('profileSave'), pronunciations: z.array(pronunciationSchema).max(300).optional(), settings: narratorSettingsSchema.optional() }),
  z.object({ op: z.literal('editionCreate'), title: z.string().trim().max(NARRATOR_LIMITS.titleChars).default(''), body: z.string().max(NARRATOR_LIMITS.bodyChars).default(''), origin: z.enum(['paste', 'url', 'package']).default('paste'), sourceUrl: httpsUrl.nullable().default(null), publishedDate: isoDate.nullable().default(null), existingOpening: z.string().max(2000).nullable().default(null), notes: z.array(z.string().max(400)).max(20).default([]) }),
  z.object({ op: z.literal('editionSave'), editionId: id, baseRev: z.number().int().min(0), patch: editionPatchSchema }),
  z.object({ op: z.literal('editionDelete'), editionId: id }),
  z.object({ op: z.literal('importUrl'), url: z.string().max(500) }),
  z.object({ op: z.literal('estimate'), ...generationTarget }),
  z.object({ op: z.literal('generate'), ...generationTarget, requestId, confirmedUsd: z.number().min(0).nullable().default(null) }),
  z.object({ op: z.literal('jobCancel'), jobId: id }),
  z.object({ op: z.literal('takeSelect'), editionId: id, passageId: id, clipId: id }),
  z.object({ op: z.literal('clipDismiss'), editionId: id, clipId: id }),
  z.object({ op: z.literal('exportStart'), editionId: id, requestId }),
  z.object({ op: z.literal('mediaUrl'), kind: z.enum(['recording', 'clip', 'test', 'export']), id, editionId: id.optional(), voiceId: id.optional(), file: z.enum(['wav', 'mp3', 'transcript', 'chapters']).optional(), download: z.boolean().default(false) }),
  z.object({ op: z.literal('soundcloudSave'), editionId: id, input: z.string().max(5000).nullable() }),
  /** Publishes one reviewed export through AZ Studio's hosted player (explicit action; never automatic). */
  z.object({ op: z.literal('publish'), editionId: id, exportId: id, reviewed: z.literal(true) }),
  z.object({ op: z.literal('unpublish'), editionId: id }),
  /** Auto-direct: suggests delivery directions for passages (reasoning model only — never synthesises audio). */
  z.object({ op: z.literal('autodirect'), editionId: id, intensity: z.enum(['subtle', 'expressive', 'dramatic']), passageIds: z.array(id).max(NARRATOR_LIMITS.passages).default([]), requestId }),
]);

export type NarratorRequest = z.infer<typeof narratorRequestSchema>;
export type NarratorOp = NarratorRequest['op'];
