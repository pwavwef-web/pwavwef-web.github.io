import type { Time } from './types';
import type { Direction } from './narrator-direction';

/**
 * Pwavwe Narrator — audio editions of The Pwavwe Papers read in Francis Pwavwe's own replicated voice.
 *
 * The provider facts below were checked against Google's documentation on 2026-10-17
 * (https://ai.google.dev/gemini-api/docs/voice-replication, /speech-generation, /pricing) and with live,
 * free calls from project az-learner (models.get, voices.list) plus one schema probe of the Interactions
 * API with a prebuilt voice. Model IDs live only in functions/src/config/models.ts.
 */
export const NARRATOR = {
  name: 'Pwavwe Narrator',
  subtitle: 'The Pwavwe Papers, in your voice.',
  voiceDisplayName: 'Francis — Pwavwe Papers',
  defaultAuthor: 'Francis Pwavwe',
  publication: 'The Pwavwe Papers',
  site: 'https://blogs.pwavwe.com',
  siteHost: 'blogs.pwavwe.com',
} as const;

/** Editable reference script (a suggestion — any 10–30 s of natural speech works). */
export const REFERENCE_SCRIPT =
  "Hello, I'm Francis Pwavwe, and this is The Pwavwe Papers. I write about technology, culture, and the questions that refuse to leave me alone. Sometimes I have an answer. Sometimes I have a better question. Either way, let's take a closer look.";

/** Default audition text. A test script — not an excerpt from a published article. */
export const AUDITION_SCRIPT =
  "Welcome to The Pwavwe Papers. I'm Francis Pwavwe. Today, we're talking about a mistake that's becoming very easy to make: confusing a convincing answer with a correct one. AI can help you move faster. But if you don't know what good work looks like, you might simply arrive at the wrong answer sooner.";

export const OPENING_TEMPLATE = "[Article title]. Written by Francis Pwavwe. You're listening to The Pwavwe Papers.";
export const DEFAULT_CLOSING = 'Thank you for listening to The Pwavwe Papers. You can read this article and explore more at blogs dot pwavwe dot com.';

/**
 * Google's mandatory consent statement, verbatim (voice-replication page, "Supported consent phrases by
 * language", checked 2026-10-17). The four English locales share the same sentence. Never paraphrase it.
 */
export const CONSENT_STATEMENTS = [
  { locale: 'en-US', language: 'English (US)', text: 'I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.' },
  { locale: 'en-GB', language: 'English (UK)', text: 'I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.' },
  { locale: 'en-IN', language: 'English (India)', text: 'I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.' },
  { locale: 'en-AU', language: 'English (Australia)', text: 'I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.' },
] as const;
export type ConsentLocale = (typeof CONSENT_STATEMENTS)[number]['locale'];
export const CONSENT_LOCALES = CONSENT_STATEMENTS.map((c) => c.locale) as [ConsentLocale, ...ConsentLocale[]];
export const CONSENT_SOURCE = { url: 'https://ai.google.dev/gemini-api/docs/voice-replication', checkedOn: '2026-10-17' } as const;

/** Documented enrollment requirements, plus the bounds AZ Studio applies where Google gives none. */
export const ENROLLMENT = {
  reference: { minSec: 10, maxSec: 30, documented: true },
  /** Google gives no length for the consent clip; these bounds only catch empty or runaway recordings. */
  consent: { minSec: 3, maxSec: 20, documented: false },
  pronunciation: { minSec: 0.5, maxSec: 15, documented: false },
  /** Recommended format (voice-replication page): 24 kHz, mono, 16-bit PCM WAV. */
  sampleRate: 24_000,
  /** Largest recording accepted (larger files go through the private Storage inbox, not the callable). */
  maxUploadBytes: 50 * 1024 * 1024,
  /** Files up to this size travel inside the API request (base64); larger ones use the Storage inbox. */
  maxInlineBytes: 900 * 1024,
  acceptedMimeTypes: ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/flac', 'audio/x-flac'],
  /** What the stateful Voices API keeps (speech-generation page, "Custom voice limits and TTL"). */
  storedVoiceTtlDays: 365,
  projectVoiceLimit: 200,
} as const;

/** Retention of private enrollment audio (implemented by the maintenance job). */
export const RETENTION = {
  /** Recordings never used to create a voice. */
  unusedRecordingDays: 7,
  /** The reference stays available for side-by-side listening after the voice is created. */
  referenceAfterCreateDays: 30,
  /** The consent recording is deleted as soon as Google has accepted it. */
  consentAfterCreateDays: 0,
  /** Intermediate chunk audio of generation jobs. */
  chunkDays: 2,
} as const;

export const DELIVERY_PRESETS = {
  conversational: { label: 'Conversational', style: 'natural and conversational', blurb: 'Relaxed and natural — the default.' },
  reflective: { label: 'Reflective', style: 'reflective and unhurried', blurb: 'Slower and more thoughtful.' },
  firm: { label: 'Firm and clear', style: 'firm and clear', blurb: 'Direct and well articulated.' },
} as const;
export type DeliveryPreset = keyof typeof DELIVERY_PRESETS;
export const DELIVERY_PRESET_IDS = Object.keys(DELIVERY_PRESETS) as [DeliveryPreset, ...DeliveryPreset[]];

/** Google documents a turn-level `speech_metadata.style` string; long style text causes drift, so keep it short. */
export const MAX_STYLE_CHARS = 80;

export function styleFor(preset: DeliveryPreset, custom?: string | null): string {
  const c = (custom ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_STYLE_CHARS);
  return c || DELIVERY_PRESETS[preset].style;
}

// ---------------------------------------------------------------------------
// Voice profiles, recordings and tests (Firestore documents written by the backend)
// ---------------------------------------------------------------------------

export type RecordingKind = 'reference' | 'consent' | 'pronunciation';

export interface RecordingIssue {
  code: 'too_short' | 'too_long' | 'silent' | 'clipping' | 'too_quiet' | 'noisy' | 'long_pause' | 'trailing_silence';
  severity: 'error' | 'warning';
  message: string;
}

export interface RecordingAnalysis {
  durationSec: number;
  speechSec: number;
  peakDbfs: number;
  rmsDbfs: number;
  /** Share of samples at full scale (|x| ≥ 0.999). */
  clippedPct: number;
  /** Quietest 10 % of 20 ms frames — a rough noise floor. */
  noiseFloorDbfs: number;
  longestPauseSec: number;
  leadingSilenceSec: number;
  trailingSilenceSec: number;
  issues: RecordingIssue[];
}

export interface NarratorRecordingDoc {
  ownerUid: string;
  kind: RecordingKind;
  source: 'microphone' | 'upload';
  /** Converted 24 kHz mono 16-bit WAV in the private bucket (the browser original is not kept). */
  storagePath: string | null;
  originalMimeType: string;
  originalBytes: number;
  analysis: RecordingAnalysis;
  /** For pronunciation clips: the notebook entry they belong to. */
  termId?: string | null;
  scriptText?: string | null;
  consentLocale?: ConsentLocale | null;
  usedByVoiceId?: string | null;
  status: 'ready' | 'deleted';
  deleteAfter: number;
  createdAt?: Time;
  deletedAt?: Time | null;
}

export type VoiceProfileStatus = 'creating' | 'active' | 'failed' | 'needs_recovery' | 'expired' | 'missing_at_provider' | 'deleted';

export interface VoiceAssessment {
  naturalness: number | null;
  resemblance: number | null;
  accent: number | null;
  pronunciation: number | null;
  pacing: number | null;
  notes: string;
}

export interface NarratorVoiceDoc {
  ownerUid: string;
  displayName: string;
  provider: 'google_gemini_api';
  /** The model the voice was created with; synthesis uses it. */
  modelId: string;
  /** Models the voice is known to work with (the creation model; others unverified). */
  compatibleModels: string[];
  storage: 'stateful';
  status: VoiceProfileStatus;
  /** Google verified the consent recording against the reference (set only when creation succeeded). */
  consent: { state: 'pending' | 'verified' | 'rejected'; locale: ConsentLocale; submittedAt: number | null; verifiedAt: number | null; message: string | null };
  /** Francis's own listening approval — separate from consent verification and never automated. */
  approval: { state: 'pending' | 'approved' | 'rejected'; at: number | null; assessment: VoiceAssessment | null; preset: DeliveryPreset | null };
  referenceRecordingId: string | null;
  consentRecordingId: string | null;
  createdAtProvider: number | null;
  lastUsedAt: number | null;
  /** Stateful voices are deleted by Google after one year without use (TTL resets on use). */
  expiresAt: number | null;
  error: { code: string; message: string } | null;
  jobId: string | null;
  requestId: string;
  createdAt?: Time;
  updatedAt?: Time;
}

export interface NarratorTestDoc {
  ownerUid: string;
  voiceId: string;
  text: string;
  preset: DeliveryPreset;
  style: string;
  status: 'generating' | 'ready' | 'failed' | 'cancelled';
  storagePath: string | null;
  durationSec: number | null;
  peaks: number[] | null;
  jobId: string;
  error: { code: string; message: string } | null;
  pronunciations: { term: string; spokenAs: string }[];
  createdAt?: Time;
}

// ---------------------------------------------------------------------------
// Pronunciation notebook
// ---------------------------------------------------------------------------

export interface PronunciationEntry {
  id: string;
  /** As written in the article (never changed in the visible text). */
  term: string;
  /** Speech-only spelling sent to the voice model ('' = say it as written). */
  spokenAs: string;
  /** Francis's own note on how it should sound. */
  hint: string;
  caseSensitive: boolean;
  /** A private reference recording of Francis saying it (for his own listening, not sent to Google). */
  recordingId: string | null;
}

/** Names that need care. Nothing is guessed: spoken forms start empty until Francis fills them in. */
export const SEED_PRONUNCIATIONS: PronunciationEntry[] = ['Francis Pwavwe', 'The Pwavwe Papers', 'Indigen World', 'Kasem', 'University of Cape Coast'].map((term, i) => ({
  id: `seed-${i + 1}`,
  term,
  spokenAs: '',
  hint: '',
  caseSensitive: false,
  recordingId: null,
}));

// ---------------------------------------------------------------------------
// Editions
// ---------------------------------------------------------------------------

export type PassageKind = 'opening' | 'heading' | 'paragraph' | 'closing';

export interface NarratorPassage {
  id: string;
  kind: PassageKind;
  /** What is spoken (editable). Pronunciation spellings are applied on top, at synthesis only. */
  text: string;
  /** The article text this passage came from ('' for the opening/closing). Never edited. */
  source: string;
  /** Left out of the narration (image credits, interface text…) — the text stays visible. */
  skip?: boolean;
  /** Optional per-passage delivery override. */
  style?: string | null;
}

export interface NarratorSection {
  id: string;
  title: string | null;
  passages: NarratorPassage[];
}

export interface NarratorScript {
  opening: NarratorPassage | null;
  sections: NarratorSection[];
  closing: NarratorPassage | null;
}

export interface NarratorPauses {
  afterOpeningSec: number;
  betweenParagraphsSec: number;
  betweenSectionsSec: number;
  afterHeadingSec: number;
  beforeClosingSec: number;
}

export const DEFAULT_PAUSES: NarratorPauses = { afterOpeningSec: 1.2, betweenParagraphsSec: 0.7, betweenSectionsSec: 1.4, afterHeadingSec: 0.6, beforeClosingSec: 1.4 };
export const PAUSE_LIMITS = { min: 0.15, max: 4 } as const;

export interface EditionSettings {
  preset: DeliveryPreset;
  customStyle: string;
  includeClosing: boolean;
  pauses: NarratorPauses;
}

export const DEFAULT_EDITION_SETTINGS: EditionSettings = { preset: 'conversational', customStyle: '', includeClosing: true, pauses: DEFAULT_PAUSES };

export interface ArticleSource {
  body: string;
  origin: 'paste' | 'url' | 'package';
  importedAt: number | null;
  notes: string[];
}

export interface SoundCloudLink {
  trackUrl: string;
  playerSrc: string;
  /** Validated public track page (fallback link). */
  pageUrl: string;
  savedAt: number;
}

export interface NarratorEditionDoc {
  ownerUid: string;
  title: string;
  author: string;
  publishedDate: string | null;
  sourceUrl: string | null;
  voiceId: string | null;
  article: ArticleSource;
  script: NarratorScript;
  settings: EditionSettings;
  /** Selected clip per passage — written by the backend only (generation, take selection). */
  takes: Record<string, string>;
  soundcloud: { title: string; description: string; link: SoundCloudLink | null };
  rev: number;
  lastExportId: string | null;
  /** Auto-direct and manual delivery directions (annotations beside the script; never part of it). */
  directions?: Direction[];
  /** Auto-direct jobs whose suggestions were already merged (so a job is never merged twice). */
  directionsMergedJobs?: string[];
  /** The hosted-player publication (written by the backend only). */
  publication?: { publicId: string; status: 'published' | 'unpublished'; exportId: string | null; exportVersion: number | null; revision: number; publishedAt: number | null; unpublishedAt: number | null } | null;
  deleted: boolean;
  createdAt?: Time;
  updatedAt?: Time;
}

export type ClipStatus = 'ready' | 'needs_recovery' | 'failed';

export interface NarratorClipDoc {
  ownerUid: string;
  editionId: string;
  passageId: string;
  /** Version number of this passage's takes (1, 2, …). */
  version: number;
  status: ClipStatus;
  inputHash: string;
  text: string;
  providerText: string;
  style: string;
  voiceId: string;
  modelId: string;
  storagePath: string | null;
  durationSec: number | null;
  speechStartSec: number | null;
  speechEndSec: number | null;
  peaks: number[] | null;
  chunks: number;
  usageUsd: number;
  jobId: string;
  error: { code: string; message: string } | null;
  createdAt?: Time;
}

export interface LoudnessMeasurement {
  integratedLufs: number;
  truePeakDbtp: number;
  lra: number;
}

export interface NarratorExportDoc {
  ownerUid: string;
  editionId: string;
  version: number;
  status: 'rendering' | 'ready' | 'failed';
  jobId: string;
  /** Exactly what went into this render: passage → clip and the clip's input hash. */
  parts: { passageId: string; clipId: string; inputHash: string; startSec: number; endSec: number; sectionId: string | null; kind: PassageKind }[];
  sections: { sectionId: string | null; title: string; startSec: number }[];
  durationSec: number | null;
  channels: 1 | 2;
  target: { integratedLufs: number; truePeakDbtp: number };
  before: LoudnessMeasurement | null;
  after: LoudnessMeasurement | null;
  files: { wav: string | null; mp3: string | null; transcript: string | null; chapters: string | null };
  fileNames: { wav: string; mp3: string; transcript: string; chapters: string };
  peaks: number[] | null;
  processing: string[];
  error: { code: string; message: string } | null;
  createdAt?: Time;
}

export interface NarratorProfileDoc {
  ownerUid: string;
  pronunciations: PronunciationEntry[];
  settings: NarratorSettings;
  updatedAt?: Time;
}

export interface NarratorSettings {
  /** Server-validated choice among the registry's narration models. */
  modelId: string | null;
  /** Largest estimated cost of one generation request (full edition, section or test). */
  generationBudgetUsd: number;
  channels: 1 | 2;
  /** −19 LUFS mono / −16 LUFS stereo (AES TD1004 streaming targets); true peak ceiling. */
  loudness: 'podcast' | 'streaming';
  defaultPreset: DeliveryPreset;
  openingTemplate: string;
  closingText: string;
  includeClosing: boolean;
  pauses: NarratorPauses;
}

export const DEFAULT_NARRATOR_SETTINGS: NarratorSettings = {
  modelId: null,
  generationBudgetUsd: 1,
  channels: 1,
  loudness: 'podcast',
  defaultPreset: 'conversational',
  openingTemplate: OPENING_TEMPLATE,
  closingText: DEFAULT_CLOSING,
  includeClosing: true,
  pauses: DEFAULT_PAUSES,
};

/** Loudness targets: AES TD1004 (−16 LUFS stereo / −19 LUFS mono) or the louder streaming norm (−14 / −17). */
export function loudnessTarget(settings: Pick<NarratorSettings, 'loudness' | 'channels'>): { integratedLufs: number; truePeakDbtp: number } {
  const stereo = settings.channels === 2;
  if (settings.loudness === 'streaming') return { integratedLufs: stereo ? -14 : -17, truePeakDbtp: -1 };
  return { integratedLufs: stereo ? -16 : -19, truePeakDbtp: -1.5 };
}

export function normalizeNarratorSettings(raw: Partial<NarratorSettings> | null | undefined): NarratorSettings {
  const r = raw ?? {};
  const clampPause = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(PAUSE_LIMITS.max, Math.max(PAUSE_LIMITS.min, v)) : d);
  const p = (r.pauses ?? {}) as Partial<NarratorPauses>;
  return {
    modelId: typeof r.modelId === 'string' ? r.modelId : null,
    generationBudgetUsd: typeof r.generationBudgetUsd === 'number' && r.generationBudgetUsd > 0 ? Math.min(50, r.generationBudgetUsd) : DEFAULT_NARRATOR_SETTINGS.generationBudgetUsd,
    channels: r.channels === 2 ? 2 : 1,
    loudness: r.loudness === 'streaming' ? 'streaming' : 'podcast',
    defaultPreset: r.defaultPreset && r.defaultPreset in DELIVERY_PRESETS ? r.defaultPreset : 'conversational',
    openingTemplate: typeof r.openingTemplate === 'string' && r.openingTemplate.trim() ? r.openingTemplate : OPENING_TEMPLATE,
    closingText: typeof r.closingText === 'string' && r.closingText.trim() ? r.closingText : DEFAULT_CLOSING,
    includeClosing: r.includeClosing !== false,
    pauses: {
      afterOpeningSec: clampPause(p.afterOpeningSec, DEFAULT_PAUSES.afterOpeningSec),
      betweenParagraphsSec: clampPause(p.betweenParagraphsSec, DEFAULT_PAUSES.betweenParagraphsSec),
      betweenSectionsSec: clampPause(p.betweenSectionsSec, DEFAULT_PAUSES.betweenSectionsSec),
      afterHeadingSec: clampPause(p.afterHeadingSec, DEFAULT_PAUSES.afterHeadingSec),
      beforeClosingSec: clampPause(p.beforeClosingSec, DEFAULT_PAUSES.beforeClosingSec),
    },
  };
}

// ---------------------------------------------------------------------------
// Hashing — what makes audio current
// ---------------------------------------------------------------------------

function fnv(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 64-bit content hash (two FNV-1a passes with different seeds plus the length). */
export function narratorHash(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return `${fnv(s, 0x811c9dc5)}${fnv(s, 0x01000193 ^ 0x5bd1e995)}${s.length.toString(36)}`;
}

/**
 * The input that determines a passage's audio: the exact text sent (pronunciations applied), the
 * delivery style, the voice profile and the model. Any change makes earlier audio stale.
 */
export function passageInputHash(input: { providerText: string; style: string; voiceId: string; modelId: string }): string {
  return narratorHash({ t: input.providerText, s: input.style, v: input.voiceId, m: input.modelId });
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export type IdFactory = () => string;

export function makeIdFactory(prefix = 'p'): IdFactory {
  let n = 0;
  const stamp = Date.now().toString(36);
  return () => `${prefix}${stamp}${(n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
