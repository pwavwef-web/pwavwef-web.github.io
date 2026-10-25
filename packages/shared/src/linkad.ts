import { z } from 'zod';
import { stableHash, wordCount } from './lite';

/**
 * Link to Ad: paste a website address, get an editable first ad.
 *
 * The document below (`project.linkad`) is the whole editorial state of one ad. It keeps three kinds of
 * content apart on purpose:
 *   - `source.facts`  — what a page said, each with its address, supporting excerpt and retrieval time;
 *   - `userFacts`     — what the director typed (never presented as sourced);
 *   - everything the model proposed (`brief.*` with `origin: 'ai'`, `directions`) — recommendations.
 * Approved facts and confirmations are stored separately from those suggestions, and every piece of
 * generated media records the hash of the inputs it was made from, so a change invalidates exactly the
 * work that depended on it (see `linkAdStatus`).
 */

export const LINKAD_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Limits and options
// ---------------------------------------------------------------------------

export const LINKAD_LIMITS = {
  /** Hard cap of pages read for one ad (the submitted page + related pages). Operators may lower it, never raise it. */
  maxPagesCap: 5,
  defaultMaxPages: 5,
  maxFacts: 160,
  maxImages: 12,
  maxScenes: 8,
  minScenes: 3,
  narrationChars: 420,
  overlayChars: 70,
  durationMin: 15,
  durationMax: 30,
  durationDefault: 20,
  /** Words the voice can comfortably say per second inside the chosen length (≈ 150 wpm incl. pauses). */
  wordsPerSecond: 2.6,
  userTextChars: 6000,
  ledgerEntries: 200,
  exports: 30,
} as const;

export const LINKAD_STAGES = ['draft', 'analysing', 'reviewing', 'planning', 'awaiting_selection', 'generating', 'composing', 'ready', 'failed', 'cancelled'] as const;
export type LinkAdStage = (typeof LINKAD_STAGES)[number];

export const LINKAD_STAGE_LABELS: Record<LinkAdStage, string> = {
  draft: 'Waiting for a website',
  analysing: 'Reading the website',
  reviewing: 'Review the proposed ad',
  planning: 'Planning three directions',
  awaiting_selection: 'Choose a direction',
  generating: 'Editing the ad',
  composing: 'Exporting the video',
  ready: 'Ready',
  failed: 'Stopped',
  cancelled: 'Cancelled',
};

/** Which stage may follow which. A terminal stage can be left only through an explicit user action (retry / restart). */
export const LINKAD_TRANSITIONS: Record<LinkAdStage, readonly LinkAdStage[]> = {
  draft: ['analysing', 'reviewing', 'cancelled'],
  analysing: ['reviewing', 'failed', 'cancelled'],
  reviewing: ['analysing', 'planning', 'cancelled'],
  planning: ['awaiting_selection', 'failed', 'cancelled', 'reviewing'],
  awaiting_selection: ['planning', 'generating', 'reviewing', 'cancelled'],
  generating: ['awaiting_selection', 'planning', 'composing', 'reviewing', 'failed', 'cancelled'],
  composing: ['generating', 'ready', 'failed', 'cancelled'],
  ready: ['generating', 'composing', 'planning', 'awaiting_selection', 'reviewing'],
  failed: ['draft', 'analysing', 'reviewing', 'planning', 'awaiting_selection', 'generating', 'composing'],
  cancelled: ['draft', 'analysing', 'reviewing', 'planning', 'awaiting_selection', 'generating', 'composing'],
};

export function canMoveStage(from: LinkAdStage, to: LinkAdStage): boolean {
  return from === to || LINKAD_TRANSITIONS[from].includes(to);
}

export const LINKAD_VOICES = ['Kore', 'Aoede', 'Leda', 'Zephyr', 'Sulafat', 'Charon', 'Puck', 'Fenrir', 'Orus', 'Algieba'] as const;
export const LINKAD_TONES = ['warm', 'confident', 'friendly', 'premium', 'energetic', 'calm'] as const;
export const LINKAD_LANGUAGES = [{ code: 'en', label: 'English' }] as const;
export const LINKAD_FORMATS = [{ aspect: '9:16', label: 'Vertical 9:16', preset: 'vertical_9x16', ready: true }] as const;
export const LINKAD_MOTIONS = ['still', 'push_in', 'pull_out', 'pan_left', 'pan_right'] as const;
export type LinkAdMotion = (typeof LINKAD_MOTIONS)[number];

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(80).regex(/^[\w.-]+$/, 'Invalid id');
const text = (max: number) => z.string().max(max);
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const ts = z.number().int().nonnegative();

export const FACT_KINDS = ['business_name', 'product_name', 'description', 'benefit', 'price', 'date', 'offer', 'contact', 'destination', 'location', 'rating', 'other'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** Kinds that must be confirmed (or left out) before they are rendered into an ad. */
export const CONFIRM_KINDS: readonly FactKind[] = ['price', 'date', 'offer', 'rating'];

export const sourceFactSchema = z.object({
  id,
  kind: z.enum(FACT_KINDS),
  /** The fact in plain words, as it may be used in the ad. */
  text: text(400),
  value: text(120).nullable().default(null),
  currency: text(8).nullable().default(null),
  qualifier: text(120).nullable().default(null),
  sourceUrl: text(2000),
  excerpt: text(600),
  retrievedAt: ts,
  /** True when the page itself did not make this reliable (a price without a date, an unqualified offer…). */
  needsConfirmation: z.boolean().default(false),
  /** The director edited the extracted wording. */
  edited: z.boolean().default(false),
});
export type SourceFact = z.infer<typeof sourceFactSchema>;

export const userFactSchema = z.object({ id, kind: z.enum(FACT_KINDS), text: text(400), at: ts });
export type UserFact = z.infer<typeof userFactSchema>;

export const assetRefSchema = z.object({
  /** Local id of this entry in the ad. */
  id,
  /** The stored studio asset (null while a candidate has only been found). */
  assetId: z.string().max(80).nullable().default(null),
  role: z.enum(['logo', 'image']),
  origin: z.enum(['site', 'upload', 'generated']),
  url: text(2000).nullable().default(null),
  pageUrl: text(2000).nullable().default(null),
  alt: text(240).default(''),
  width: z.number().int().nullable().default(null),
  height: z.number().int().nullable().default(null),
  bytes: z.number().int().nullable().default(null),
  mime: text(60).nullable().default(null),
  status: z.enum(['candidate', 'stored', 'rejected']).default('candidate'),
  rejectReason: text(240).nullable().default(null),
  /** Public accessibility is not a reuse licence: nothing is rendered until the director confirms the right to use it. */
  rights: z.enum(['unconfirmed', 'confirmed']).default('unconfirmed'),
  /** Generated or enhanced pictures that could misrepresent the offering wait for a look. */
  needsReview: z.boolean().default(false),
  reviewed: z.boolean().default(false),
  selected: z.boolean().default(false),
  /** Where the tidied-up copy of the logo/image came from, for the editor. */
  note: text(240).default(''),
});
export type LinkAdAsset = z.infer<typeof assetRefSchema>;

// ---------------------------------------------------------------------------
// Source bundle
// ---------------------------------------------------------------------------

export const pageRecordSchema = z.object({
  url: text(2000),
  finalUrl: text(2000).nullable().default(null),
  title: text(300).default(''),
  status: z.enum(['ok', 'empty', 'blocked', 'failed', 'skipped']),
  httpStatus: z.number().int().nullable().default(null),
  fetchedAt: ts,
  bytes: z.number().int().default(0),
  note: text(400).default(''),
  /** How the page was read: the studio's own safe reader, or Firecrawl when it is configured. */
  via: z.enum(['direct', 'firecrawl', 'manual', 'fixture']).default('direct'),
});
export type PageRecord = z.infer<typeof pageRecordSchema>;

export const conflictSchema = z.object({ id, kind: z.enum(FACT_KINDS), message: text(400), factIds: z.array(id).max(10) });
export type FactConflict = z.infer<typeof conflictSchema>;

export const sourceBundleSchema = z.object({
  status: z.enum(['none', 'ok', 'partial', 'failed', 'manual']).default('none'),
  extractor: z.enum(['direct', 'firecrawl', 'manual', 'fixture']).default('direct'),
  startedAt: ts.nullable().default(null),
  fetchedAt: ts.nullable().default(null),
  siteName: text(160).default(''),
  pages: z.array(pageRecordSchema).max(8).default([]),
  facts: z.array(sourceFactSchema).max(LINKAD_LIMITS.maxFacts).default([]),
  assets: z.array(assetRefSchema).max(40).default([]),
  colours: z.array(colour).max(8).default([]),
  warnings: z.array(text(400)).max(30).default([]),
  conflicts: z.array(conflictSchema).max(20).default([]),
  missing: z.array(text(200)).max(20).default([]),
  /** Instruction-like lines the page contained; they were ignored, and are shown so the director knows. */
  ignoredInstructions: z.array(text(300)).max(10).default([]),
});
export type SourceBundle = z.infer<typeof sourceBundleSchema>;

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

export const briefSchema = z.object({
  /** What is being promoted, in a sentence. */
  focus: text(240).default(''),
  /** Offerings found on the site, so the director can switch the focus. */
  offerings: z.array(z.object({ id, name: text(160), factIds: z.array(id).max(10) })).max(8).default([]),
  audience: z.object({ text: text(240).default(''), origin: z.enum(['ai', 'user']).default('ai') }).default({ text: '', origin: 'ai' }),
  message: text(240).default(''),
  benefit: z.object({ text: text(240).default(''), factId: id.nullable().default(null) }).default({ text: '', factId: null }),
  action: text(120).default(''),
  destination: z.object({ kind: z.enum(['url', 'phone', 'email', 'text']).default('url'), value: text(300).default(''), factId: id.nullable().default(null) }).default({ kind: 'url', value: '', factId: null }),
  tone: z.enum(LINKAD_TONES).default('warm'),
  language: z.literal('en').default('en'),
  durationSec: z.number().min(LINKAD_LIMITS.durationMin).max(LINKAD_LIMITS.durationMax).default(LINKAD_LIMITS.durationDefault),
  format: z.literal('9:16').default('9:16'),
  voice: z.enum(LINKAD_VOICES).default('Kore'),
  voiceDirection: text(160).default('Warm, clear and natural, like a friendly local presenter'),
  logoId: id.nullable().default(null),
  imageIds: z.array(id).max(LINKAD_LIMITS.maxImages).default([]),
  /** Facts the ad will rely on. Prices, dates and offers among them must be confirmed before export. */
  usedFactIds: z.array(id).max(40).default([]),
  /** The model's plain-language list of what to double-check. */
  confirmNotes: z.array(text(240)).max(10).default([]),
  origin: z.enum(['ai', 'manual', 'fixture']).default('ai'),
});
export type LinkAdBrief = z.infer<typeof briefSchema>;

// ---------------------------------------------------------------------------
// Scenes, directions, ad
// ---------------------------------------------------------------------------

export const SCENE_ROLES = ['hook', 'offer', 'detail', 'cta'] as const;
export type SceneRole = (typeof SCENE_ROLES)[number];

export const sceneSchema = z.object({
  id,
  role: z.enum(SCENE_ROLES),
  narration: text(LINKAD_LIMITS.narrationChars).default(''),
  overlay: text(LINKAD_LIMITS.overlayChars).default(''),
  overlayPos: z.enum(['upper', 'middle', 'lower']).default('upper'),
  /** Id of an entry in `assets`; null = a text-led scene on the brand colour. */
  assetId: id.nullable().default(null),
  focal: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).default({ x: 0.5, y: 0.5 }),
  motion: z.enum(LINKAD_MOTIONS).default('push_in'),
  /** Facts this scene relies on, with a stamp of their wording when the scene was written. */
  factIds: z.array(id).max(8).default([]),
  factStamp: z.record(z.string(), z.string()).default({}),
  /** Why the scene needs a look (a fact it relies on changed, a figure is unsupported…). */
  review: text(300).nullable().default(null),
});
export type AdScene = z.infer<typeof sceneSchema>;

export const closingSchema = z.object({
  headline: text(LINKAD_LIMITS.overlayChars).default(''),
  line: text(120).default(''),
  showLogo: z.boolean().default(true),
});
export type AdClosing = z.infer<typeof closingSchema>;

export const DIRECTION_KINDS = ['experience', 'showcase', 'problem_solution', 'other'] as const;
export type LinkAdDirectionKind = (typeof DIRECTION_KINDS)[number];

export const linkAdDirectionSchema = z.object({
  id,
  kind: z.enum(DIRECTION_KINDS),
  title: text(80),
  summary: text(300).default(''),
  hook: text(160).default(''),
  scenes: z.array(sceneSchema).min(LINKAD_LIMITS.minScenes).max(LINKAD_LIMITS.maxScenes),
  closing: closingSchema,
  rationale: text(300).default(''),
  /** Lower number = the framing fits this site's material better. */
  origin: z.enum(['ai', 'fixture']).default('ai'),
  createdAt: ts,
});
export type AdDirection = z.infer<typeof linkAdDirectionSchema>;

export const takeSchema = z.object({
  /** Hash of the narration, voice and direction this audio was made from. */
  hash: text(40),
  assetId: id,
  jobId: text(120).nullable().default(null),
  fileSec: z.number().nonnegative(),
  speechStart: z.number().nonnegative(),
  speechEnd: z.number().nonnegative(),
  words: z.array(z.object({ text: text(60), start: z.number(), end: z.number(), confidence: z.number().min(0).max(1), sentenceEnd: z.boolean().optional() })).max(200).default([]),
  alignment: z.enum(['aligned', 'estimated']),
  coverage: z.number().min(0).max(1).nullable().default(null),
  flags: z.array(text(240)).max(8).default([]),
  source: z.enum(['generated', 'fixture', 'upload']).default('generated'),
  voice: text(40).nullable().default(null),
  createdAt: ts,
});
export type AdTake = z.infer<typeof takeSchema>;

export const CAPTION_PRESETS = ['bold', 'clean', 'boxed'] as const;
export const captionsSchema = z.object({
  enabled: z.boolean().default(true),
  preset: z.enum(CAPTION_PRESETS).default('bold'),
  color: colour.default('#FFFFFF'),
  font: z.enum(['Inter', 'EB Garamond', 'DejaVu Sans', 'Noto Sans']).default('Inter'),
  sizePct: z.number().min(2).max(6).default(3.4),
});
export type AdCaptions = z.infer<typeof captionsSchema>;

export const linkAdBrandSchema = z.object({
  primary: colour.default('#1F6F5B'),
  background: colour.default('#0F1B1A'),
  text: colour.default('#FFFFFF'),
  accent: colour.default('#F4B84A'),
  font: z.enum(['Inter', 'EB Garamond', 'DejaVu Sans', 'Noto Sans']).default('Inter'),
});
export type LinkAdBrand = z.infer<typeof linkAdBrandSchema>;

export const musicSchema = z.object({
  /** A studio asset (audio) the director owns or is licensed to use. */
  assetId: z.string().max(80).nullable().default(null),
  title: text(160).default(''),
  /** The director states they may use this track in an advert. */
  rightsConfirmed: z.boolean().default(false),
  gainDb: z.number().min(-40).max(0).default(-17),
});

export const adSchema = z.object({
  directionId: id.nullable().default(null),
  title: text(120).default(''),
  scenes: z.array(sceneSchema).max(LINKAD_LIMITS.maxScenes).default([]),
  closing: closingSchema.default({ headline: '', line: '', showLogo: true }),
  brand: linkAdBrandSchema.default(linkAdBrandSchema.parse({})),
  captions: captionsSchema.default(captionsSchema.parse({})),
  voiceGainDb: z.number().min(-12).max(6).default(0),
  music: musicSchema.default(musicSchema.parse({})),
  /** One recorded take per scene (a change to one scene's words invalidates that scene's audio only). */
  takes: z.record(z.string(), takeSchema).default({}),
});
export type LinkAdAd = z.infer<typeof adSchema>;

// ---------------------------------------------------------------------------
// Spend, jobs, exports
// ---------------------------------------------------------------------------

export const ledgerEntrySchema = z.object({
  at: ts,
  step: z.string().max(40),
  kind: z.enum(['reasoning', 'speech', 'transcription', 'image', 'render', 'fetch']),
  units: text(80).default(''),
  estimateUsd: z.number().nonnegative(),
  /** Null until the provider reported what was used. */
  actualUsd: z.number().nonnegative().nullable().default(null),
  jobId: text(120).nullable().default(null),
  basis: z.enum(['published_rate', 'fixture', 'unknown']).default('published_rate'),
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export const exportRecordSchema = z.object({
  renderId: id,
  jobId: text(120).nullable().default(null),
  quality: z.enum(['draft', 'final']),
  /** Hash of the composition this export was made from. */
  timelineHash: text(40),
  at: ts,
  status: z.enum(['queued', 'rendering', 'completed', 'failed', 'cancelled']).default('queued'),
  outputAssetId: z.string().max(80).nullable().default(null),
  durationSec: z.number().nullable().default(null),
  /** Measured on the finished file (not assumed from the plan). */
  checks: z
    .object({
      ok: z.boolean(),
      measuredSec: z.number().nullable(),
      expectedSec: z.number(),
      width: z.number().nullable(),
      height: z.number().nullable(),
      videoCodec: z.string().nullable(),
      audioCodec: z.string().nullable(),
      notes: z.array(text(240)).max(8),
    })
    .nullable()
    .default(null),
  error: text(300).nullable().default(null),
});
export type ExportRecord = z.infer<typeof exportRecordSchema>;

export const inputSchema = z.object({
  url: text(2000).default(''),
  promote: text(300).default(''),
  extraUrls: z.array(text(2000)).max(4).default([]),
  maxPages: z.number().int().min(1).max(LINKAD_LIMITS.maxPagesCap).default(LINKAD_LIMITS.defaultMaxPages),
  manualText: text(LINKAD_LIMITS.userTextChars).default(''),
  /** The director confirms they may use the source pictures and anything they upload. */
  rightsConfirmed: z.boolean().default(false),
});
export type LinkAdInput = z.infer<typeof inputSchema>;

export const linkAdSchema = z.object({
  v: z.literal(LINKAD_VERSION).default(LINKAD_VERSION),
  revision: z.number().int().nonnegative().default(0),
  /** `live` = real providers; `fixture` = canned page and voice for tests and demos (always labelled). */
  mode: z.enum(['live', 'fixture']).default('live'),
  stage: z.enum(LINKAD_STAGES).default('draft'),
  stageNote: text(400).default(''),
  activeJobId: text(120).nullable().default(null),
  lastError: z.object({ message: text(500), step: text(40), at: ts, retryable: z.boolean() }).nullable().default(null),
  input: inputSchema.default(inputSchema.parse({})),
  source: sourceBundleSchema.default(sourceBundleSchema.parse({})),
  userFacts: z.array(userFactSchema).max(40).default([]),
  /** Facts the director confirmed word for word (prices, dates, offers). `{factId: wording hash}` so an edit un-confirms. */
  confirmations: z.record(z.string(), z.string()).default({}),
  brief: briefSchema.default(briefSchema.parse({})),
  briefApprovedAt: ts.nullable().default(null),
  /** Hash of the approved facts at approval; a different hash later means what the ad rests on has changed. */
  briefApprovedHash: text(40).nullable().default(null),
  directions: z.array(linkAdDirectionSchema).max(4).default([]),
  directionsFor: text(40).nullable().default(null),
  ad: adSchema.default(adSchema.parse({})),
  spend: z.object({ capUsd: z.number().min(0).max(100).default(1), ledger: z.array(ledgerEntrySchema).max(LINKAD_LIMITS.ledgerEntries).default([]) }).default({ capUsd: 1, ledger: [] }),
  /** A speech request that was sent and not yet saved, per scene: if the worker died, whether it was billed is unknown. */
  voiceInFlight: z.record(z.string(), z.object({ hash: text(40), jobId: text(120), at: ts })).default({}),
  timelineId: text(80).nullable().default(null),
  exports: z.array(exportRecordSchema).max(LINKAD_LIMITS.exports).default([]),
  importedFrom: z.object({ projectId: id, title: text(160), at: ts }).nullable().default(null),
  updatedAt: ts.default(0),
});
export type LinkAdDoc = z.infer<typeof linkAdSchema>;

export function defaultLinkAd(input: Partial<LinkAdInput> = {}): LinkAdDoc {
  return linkAdSchema.parse({ input: { ...input } });
}

/** Reads a stored document; anything unreadable becomes a fresh draft rather than breaking the page. */
export function normalizeLinkAd(raw: unknown): LinkAdDoc {
  if (!raw || typeof raw !== 'object') return defaultLinkAd();
  const parsed = linkAdSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Keep what can be kept: parse each top-level section on its own.
  const r = raw as Record<string, unknown>;
  const base = defaultLinkAd();
  for (const key of Object.keys(base) as (keyof LinkAdDoc)[]) {
    if (!(key in r)) continue;
    const one = linkAdSchema.shape[key].safeParse(r[key]);
    if (one.success) (base as Record<string, unknown>)[key] = one.data;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Hashes and dependency tracking
// ---------------------------------------------------------------------------

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The wording of a fact as the ad may use it (the unit a confirmation applies to). */
export function factWording(f: Pick<SourceFact, 'text' | 'value' | 'currency' | 'qualifier'>): string {
  return clean([f.text, f.value ?? '', f.currency ?? '', f.qualifier ?? ''].join('|'));
}

export function factHash(f: Pick<SourceFact, 'text' | 'value' | 'currency' | 'qualifier'>): string {
  return stableHash(factWording(f));
}

export interface FactView {
  id: string;
  kind: FactKind;
  text: string;
  value: string | null;
  currency: string | null;
  qualifier: string | null;
  origin: 'source' | 'user';
  needsConfirmation: boolean;
  sourceUrl: string | null;
  excerpt: string | null;
}

/** Sourced and director-written facts as one list (still marked by origin). */
export function allFacts(doc: Pick<LinkAdDoc, 'source' | 'userFacts'>): FactView[] {
  return [
    ...doc.source.facts.map<FactView>((f) => ({ id: f.id, kind: f.kind, text: f.text, value: f.value, currency: f.currency, qualifier: f.qualifier, origin: 'source', needsConfirmation: f.needsConfirmation || CONFIRM_KINDS.includes(f.kind), sourceUrl: f.sourceUrl, excerpt: f.excerpt })),
    ...doc.userFacts.map<FactView>((f) => ({ id: f.id, kind: f.kind, text: f.text, value: null, currency: null, qualifier: null, origin: 'user', needsConfirmation: CONFIRM_KINDS.includes(f.kind), sourceUrl: null, excerpt: null })),
  ];
}

/** True when a price, date, offer or rating fact is confirmed in its current wording. */
export function isConfirmed(doc: Pick<LinkAdDoc, 'confirmations'>, f: FactView): boolean {
  if (!f.needsConfirmation) return true;
  return doc.confirmations[f.id] === factHash(f);
}

/** Hash of the facts the brief relies on (their current wording and confirmation). */
export function usedFactsHash(doc: Pick<LinkAdDoc, 'source' | 'userFacts' | 'brief' | 'confirmations'>): string {
  const byId = new Map(allFacts(doc).map((f) => [f.id, f]));
  return stableHash(doc.brief.usedFactIds.map((fid) => {
    const f = byId.get(fid);
    return f ? [fid, factHash(f), doc.confirmations[fid] === factHash(f)] : [fid, 'missing', false];
  }));
}

/** The spoken text of the ad (what the voice says, in order). */
export function adNarration(ad: Pick<LinkAdAd, 'scenes'>): string {
  return ad.scenes.map((s) => clean(s.narration)).filter(Boolean).join(' ');
}

/** What a scene's voice take depends on: the words, the voice and how it is directed. */
export function sceneVoiceHash(scene: Pick<AdScene, 'narration'>, voice: string, direction: string): string {
  return stableHash(['v1', clean(scene.narration), voice, clean(direction)]);
}

export type VoiceState = 'none' | 'current' | 'stale';

export interface SceneStatus {
  id: string;
  voice: VoiceState;
  words: number;
  /** Seconds of speech once recorded, else an estimate from the word count. */
  speechSec: number;
  spokenEstimate: boolean;
  problems: string[];
}

export interface LinkAdStatus {
  scenes: SceneStatus[];
  /** Every scene that has words has a current take. */
  voiceComplete: boolean;
  scenesNeedingVoice: string[];
  /** Planned and measured length of the finished ad. */
  totalSec: number;
  /** Narration is longer or shorter than the chosen duration allows. */
  lengthProblem: string | null;
  /** The facts the brief rests on changed after approval. */
  factsChangedSinceApproval: boolean;
  /** Hash of everything the picture and sound are composed from. */
  compositionHash: string;
  /** The newest export no longer matches the composition. */
  exportStale: boolean;
}

const CAPTION_LEAD = 0.18;
export const SCENE_PAD = { lead: 0.22, tail: 0.35, ctaTail: 1.1, minSec: 1.8, maxSec: 9 } as const;

/** Spoken length of a scene: the measured speech when a current take exists, else an estimate from its words. */
export function sceneSpeechSec(scene: AdScene, take: AdTake | undefined, current: boolean): { sec: number; estimate: boolean } {
  if (take && current) return { sec: Math.max(0.1, take.speechEnd - take.speechStart), estimate: false };
  return { sec: Math.round((wordCount(scene.narration) / LINKAD_LIMITS.wordsPerSecond) * 10) / 10, estimate: true };
}

/** Scene durations from the real (or estimated) speech: lead-in + speech + tail, never below the minimum. */
export function sceneDurations(ad: LinkAdAd, voice: string, direction: string): { id: string; sec: number; lead: number; speech: number; estimate: boolean }[] {
  return ad.scenes.map((s, i) => {
    const take = ad.takes[s.id];
    const current = Boolean(take && take.hash === sceneVoiceHash(s, voice, direction));
    const sp = sceneSpeechSec(s, take, current);
    const last = i === ad.scenes.length - 1;
    const tail = last ? SCENE_PAD.ctaTail : SCENE_PAD.tail;
    const body = sp.sec > 0.15 ? SCENE_PAD.lead + sp.sec + tail : SCENE_PAD.minSec;
    return { id: s.id, sec: Math.round(Math.max(SCENE_PAD.minSec, body) * 1000) / 1000, lead: SCENE_PAD.lead, speech: sp.sec, estimate: sp.estimate };
  });
}

export function compositionHash(doc: Pick<LinkAdDoc, 'ad' | 'brief' | 'source'>): string {
  const a = doc.ad;
  return stableHash([
    'c1',
    a.scenes.map((s) => [s.id, s.overlay, s.overlayPos, s.assetId, s.focal, s.motion, a.takes[s.id]?.hash ?? null]),
    a.closing,
    a.brand,
    a.captions,
    a.voiceGainDb,
    a.music,
    doc.brief.logoId,
    doc.source.assets.filter((x) => x.status === 'stored').map((x) => [x.id, x.assetId, x.rights]),
  ]);
}

export function linkAdStatus(doc: LinkAdDoc): LinkAdStatus {
  const { ad, brief } = doc;
  const durations = sceneDurations(ad, brief.voice, brief.voiceDirection);
  const scenes: SceneStatus[] = ad.scenes.map((s) => {
    const take = ad.takes[s.id];
    const words = wordCount(s.narration);
    const voice: VoiceState = !words ? 'none' : !take ? 'none' : take.hash === sceneVoiceHash(s, brief.voice, brief.voiceDirection) ? 'current' : 'stale';
    const d = durations.find((x) => x.id === s.id)!;
    return { id: s.id, voice, words, speechSec: d.speech, spokenEstimate: d.estimate, problems: [] };
  });
  const need = scenes.filter((s) => s.words > 0 && s.voice !== 'current').map((s) => s.id);
  const total = Math.round(durations.reduce((a, d) => a + d.sec, 0) * 100) / 100;
  let lengthProblem: string | null = null;
  if (ad.scenes.length) {
    if (total > LINKAD_LIMITS.durationMax + 0.25) lengthProblem = `The ad would run ${total.toFixed(1)} s, over the ${LINKAD_LIMITS.durationMax} s limit. Shorten the narration.`;
    else if (total < LINKAD_LIMITS.durationMin - 0.25) lengthProblem = `The ad would run ${total.toFixed(1)} s, under the ${LINKAD_LIMITS.durationMin} s minimum. Add detail to the narration.`;
    else if (total > brief.durationSec + 3.5) lengthProblem = `The narration runs ${total.toFixed(1)} s, well over the ${brief.durationSec} s you chose.`;
  }
  const hash = compositionHash(doc);
  const finals = doc.exports.filter((e) => e.status === 'completed' || e.status === 'rendering' || e.status === 'queued');
  const newest = finals[0] ?? null;
  return {
    scenes,
    voiceComplete: ad.scenes.length > 0 && need.length === 0 && scenes.some((s) => s.words > 0),
    scenesNeedingVoice: need,
    totalSec: total,
    lengthProblem,
    factsChangedSinceApproval: Boolean(doc.briefApprovedAt && doc.briefApprovedHash && doc.briefApprovedHash !== usedFactsHash(doc)),
    compositionHash: hash,
    exportStale: Boolean(newest && newest.timelineHash !== hash),
  };
}

export const CAPTION_LEAD_SEC = CAPTION_LEAD;

// ---------------------------------------------------------------------------
// Editing with explicit invalidation
// ---------------------------------------------------------------------------

/** The part of the document the browser may change directly. The server applies it and recomputes what is stale. */
export const linkAdEditSchema = z.object({
  input: inputSchema.partial().optional(),
  brief: briefSchema.partial().optional(),
  userFacts: z.array(userFactSchema).max(40).optional(),
  factEdits: z.record(z.string(), text(400)).optional(),
  confirm: z.array(id).max(60).optional(),
  unconfirm: z.array(id).max(60).optional(),
  assets: z.array(z.object({ id, selected: z.boolean().optional(), rights: z.enum(['unconfirmed', 'confirmed']).optional(), reviewed: z.boolean().optional(), role: z.enum(['logo', 'image']).optional(), alt: text(240).optional() })).max(60).optional(),
  ad: z
    .object({
      title: text(120).optional(),
      scenes: z.array(sceneSchema).max(LINKAD_LIMITS.maxScenes).optional(),
      closing: closingSchema.partial().optional(),
      brand: linkAdBrandSchema.partial().optional(),
      captions: captionsSchema.partial().optional(),
      voiceGainDb: z.number().min(-12).max(6).optional(),
      music: musicSchema.partial().optional(),
    })
    .optional(),
  spendCapUsd: z.number().min(0).max(100).optional(),
});
export type LinkAdEdit = z.infer<typeof linkAdEditSchema>;

/** Stamp of the facts a scene relies on (their present wording). */
export function stampFor(doc: Pick<LinkAdDoc, 'source' | 'userFacts'>, factIds: string[]): Record<string, string> {
  const byId = new Map(allFacts(doc).map((f) => [f.id, f]));
  const out: Record<string, string> = {};
  for (const fid of factIds) {
    const f = byId.get(fid);
    out[fid] = f ? factHash(f) : 'missing';
  }
  return out;
}

/** Marks scenes whose facts changed (or vanished) since they were written; clears the mark when they match again. */
export function reviewScenes(doc: Pick<LinkAdDoc, 'source' | 'userFacts' | 'ad'>): AdScene[] {
  const now = new Map(allFacts(doc).map((f) => [f.id, factHash(f)]));
  return doc.ad.scenes.map((s) => {
    const changed = s.factIds.filter((fid) => s.factStamp[fid] !== undefined && s.factStamp[fid] !== (now.get(fid) ?? 'missing'));
    if (!changed.length) return s.review?.startsWith('A fact this scene relies on') ? { ...s, review: null } : s;
    const byId = new Map(allFacts(doc).map((f) => [f.id, f]));
    const names = changed.map((fid) => byId.get(fid)?.text.slice(0, 40) ?? 'a removed fact');
    return { ...s, review: `A fact this scene relies on changed (${names.join('; ')}). Check that the words still say it correctly.` };
  });
}

/** Replaces the voice/words dependency trail after a scene is re-stamped (used when the director accepts the scene as is). */
export function restampScene(doc: Pick<LinkAdDoc, 'source' | 'userFacts'>, scene: AdScene): AdScene {
  return { ...scene, factStamp: stampFor(doc, scene.factIds), review: scene.review?.startsWith('A fact this scene relies on') ? null : scene.review };
}

export function newId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}
