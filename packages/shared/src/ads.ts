import type { Clip, ShotDirections, TextStyle, Track } from './types';
import type { AsrWord, LyricSheetLine, LyricSheetSection, LyricsSheet, LyricWord, WordFlag } from './lyrics';
import { emptyTiming, lyricCaptionSpecs, lyricId } from './lyrics';
import type { LyricStyle, LyricStyleDoc } from './lyric-style';
import { LYRIC_PRESET_STYLES } from './lyric-style';
import { alignWords, normalizeWord, round3, tokenize, wordSimilarity } from './text-align';
import { splitSentences, estimateSpeechSeconds } from './duration';
import { compileShotPrompt, EMPTY_DIRECTIONS } from './prompt';
import { applyLyricCaptions, DEFAULT_TEXT_STYLE, makeClip, makeTrack, MIN_CLIP_SECONDS, type TimelineState } from './timeline';

/**
 * Short Ads: 40–60 second promotional videos, built either around an approved soundtrack (audio-first) or
 * from a brief (brief-first). The narration is the timeline authority: its measured duration fixes the
 * length of the advert, its word-timed transcript fixes captions and scene cuts. Text, captions and branding
 * are composed in the edit — never generated inside video.
 */

// ---------------------------------------------------------------------------
// Advert specification (stored on the project document as `ad`)
// ---------------------------------------------------------------------------

export const AD_MODES = ['audio_first', 'brief_first'] as const;
export type AdMode = (typeof AD_MODES)[number];
export const AD_MODE_LABELS: Record<AdMode, string> = { audio_first: 'Audio-first', brief_first: 'Brief-first' };

export const AD_STEPS = ['brief', 'assets', 'storyboard', 'generate', 'review', 'export'] as const;
export type AdStep = (typeof AD_STEPS)[number];
export const AD_STEP_LABELS: Record<AdStep, string> = {
  brief: 'Brief',
  assets: 'Audio & assets',
  storyboard: 'Storyboard',
  generate: 'Generate',
  review: 'Review',
  export: 'Export',
};

export const AD_ASPECTS = ['9:16', '16:9', '1:1'] as const;
export type AdAspect = (typeof AD_ASPECTS)[number];
export const AD_ASPECT_PRESETS: Record<AdAspect, 'vertical_9x16' | 'youtube_16x9' | 'square_1x1'> = { '9:16': 'vertical_9x16', '16:9': 'youtube_16x9', '1:1': 'square_1x1' };
export const AD_ASPECT_SIZES: Record<AdAspect, { width: number; height: number }> = { '9:16': { width: 1080, height: 1920 }, '16:9': { width: 1920, height: 1080 }, '1:1': { width: 1080, height: 1080 } };
/** Gemini Omni generates 16:9 or 9:16; square adverts are generated vertically and reframed in the renderer. */
export const AD_GENERATION_ASPECT: Record<AdAspect, '9:16' | '16:9'> = { '9:16': '9:16', '16:9': '16:9', '1:1': '9:16' };

export const AD_DURATION = { min: 40, max: 60, default: 45 } as const;

export const AD_FONTS = ['Noto Sans', 'Inter', 'EB Garamond', 'DejaVu Sans'] as const;

export const AD_ASSET_ROLES = ['logo', 'screenshot', 'recording', 'photo', 'footage'] as const;
export type AdAssetRole = (typeof AD_ASSET_ROLES)[number];
export const AD_ASSET_ROLE_LABELS: Record<AdAssetRole, string> = { logo: 'Logos', screenshot: 'Product screenshots', recording: 'Screen recordings', photo: 'Photos', footage: 'Footage' };

export interface AdBrief {
  brand: string;
  product: string;
  audience: string;
  objective: string;
  keyMessage: string;
  tone: string;
  callToAction: string;
  destinationUrl: string;
  /** Desired length (brief-first). Audio-first adverts take their length from the measured audio. */
  durationSec: number;
  /** A short on-screen line shown early (e.g. "Starting with Kasem"). */
  tagline: string;
  visualDirection: string;
  mustAvoid: string;
}

export interface AdBrand {
  /** Brand colour (cards, highlights). */
  primary: string;
  /** Deep ground behind typography, screens and the end card. */
  background: string;
  /** Accent (active caption word, tagline). */
  accent: string;
  /** Text colour on the ground. */
  text: string;
  font: string;
  /** Uploaded licensed font (.ttf/.otf); used through the caption style. */
  fontAssetId: string | null;
  logoAssetId: string | null;
  /** Where the logo comes from (shown in the review so it is never mistaken for an invented mark). */
  logoSource: string;
}

export interface AdAssetRef {
  assetId: string;
  role: AdAssetRole;
  label: string;
  note: string;
}

export interface AdAudio {
  assetId: string | null;
  /** Narration transcript holder (`songs/{songId}`, lyric sheet = captions). */
  songId: string | null;
  /** Measured by the server's media probe — the timeline authority. */
  durationSec: number | null;
  fileName: string;
  /** The approved audio is never rewritten, regenerated, re-timed or cut. */
  preserve: boolean;
  /** The approved script, used as a reference only (never as proof of what was said). */
  referenceScript: string;
  /** Terms whose spelling must be exact in captions (e.g. Kasem, Indigen World). */
  protectedTerms: string[];
  languageCode: string;
  transcriptApprovedAt: number | null;
}

export interface AdSpec {
  version: 1;
  mode: AdMode;
  step: AdStep;
  aspect: AdAspect;
  brief: AdBrief;
  brand: AdBrand;
  audio: AdAudio;
  assets: AdAssetRef[];
  captions: { enabled: boolean; styleId: string | null };
  generation: { resolution: '720p' | '1080p'; qualityRepairs: number };
  timelineId: string | null;
  previewRenderId: string | null;
  finalRenderIds: Partial<Record<AdAspect, string>>;
  updatedAt: number;
}

export function defaultAdSpec(mode: AdMode = 'audio_first', aspect: AdAspect = '9:16'): AdSpec {
  return {
    version: 1,
    mode,
    step: 'brief',
    aspect,
    brief: { brand: '', product: '', audience: '', objective: '', keyMessage: '', tone: '', callToAction: '', destinationUrl: '', durationSec: AD_DURATION.default, tagline: '', visualDirection: '', mustAvoid: '' },
    brand: { primary: '#19327F', background: '#0F1830', accent: '#22D3EE', text: '#FFFFFF', font: 'Noto Sans', fontAssetId: null, logoAssetId: null, logoSource: '' },
    audio: { assetId: null, songId: null, durationSec: null, fileName: '', preserve: true, referenceScript: '', protectedTerms: [], languageCode: 'en', transcriptApprovedAt: null },
    assets: [],
    captions: { enabled: true, styleId: null },
    generation: { resolution: '1080p', qualityRepairs: 1 },
    timelineId: null,
    previewRenderId: null,
    finalRenderIds: {},
    updatedAt: Date.now(),
  };
}

/** Fills fields missing from older or partial drafts without touching what is there. */
export function normalizeAdSpec(ad: Partial<AdSpec> | null | undefined): AdSpec {
  const base = defaultAdSpec(ad?.mode ?? 'audio_first', ad?.aspect ?? '9:16');
  return {
    ...base,
    ...ad,
    brief: { ...base.brief, ...(ad?.brief ?? {}) },
    brand: { ...base.brand, ...(ad?.brand ?? {}) },
    audio: { ...base.audio, ...(ad?.audio ?? {}) },
    captions: { ...base.captions, ...(ad?.captions ?? {}) },
    generation: { ...base.generation, ...(ad?.generation ?? {}) },
    assets: ad?.assets ?? [],
    finalRenderIds: ad?.finalRenderIds ?? {},
  } as AdSpec;
}

// ---------------------------------------------------------------------------
// Scenes (stored as shots with an `ad` field)
// ---------------------------------------------------------------------------

export const AD_SCENE_KINDS = ['generated_video', 'generated_image', 'product_screen', 'footage', 'photo', 'typography', 'end_card'] as const;
export type AdSceneKind = (typeof AD_SCENE_KINDS)[number];
export const AD_SCENE_KIND_LABELS: Record<AdSceneKind, string> = {
  generated_video: 'Generated video',
  generated_image: 'Generated still',
  product_screen: 'Product screen',
  footage: 'Supplied footage',
  photo: 'Supplied photo',
  typography: 'Typography',
  end_card: 'End card',
};
export const GENERATED_SCENE_KINDS: readonly AdSceneKind[] = ['generated_video', 'generated_image'];
export const isGeneratedScene = (kind: AdSceneKind) => GENERATED_SCENE_KINDS.includes(kind);

export type AdCheckId = 'playable' | 'duration' | 'aspect' | 'resolution' | 'black' | 'brief' | 'text_in_frame' | 'artefacts' | 'continuity' | 'asset';

export interface AdSceneValidation {
  verdict: 'pass' | 'warn' | 'fail';
  checkedAt: number;
  checks: { id: AdCheckId; label: string; ok: boolean; severity: 'info' | 'warning' | 'error'; detail: string }[];
  review: { matchesBrief: number | null; summary: string; issues: { type: string; severity: 'minor' | 'major' | 'critical'; note: string }[] } | null;
  measurements: { durationSec: number | null; width: number | null; height: number | null; fps: number | null; decodeErrors: number; blackSec: number };
  modelId: string | null;
}

export interface AdSceneValidationSummary {
  takeId: string;
  verdict: AdSceneValidation['verdict'];
  checkedAt: number;
  failed: string[];
}

export interface AdSceneSpec {
  kind: AdSceneKind;
  /** Narration heard during the scene (exact transcript text). */
  narration: string;
  /** Transcript lines (captions) inside the scene. */
  lineIds: string[];
  /** Typography / end-card text, composed in the edit. */
  onScreenText: string;
  /** Secondary line (e.g. the URL on the end card). */
  subText: string;
  /** Supplied assets used by the scene (screens, footage, photos). */
  assetIds: string[];
  /** Show the narration captions during this scene. */
  captions: boolean;
  /** Still-image motion. */
  motion: 'none' | 'push_in' | 'drift';
  /** Source in-point for video scenes (seconds). */
  inPoint: number;
  /** Automatic quality repairs already used (bounded by the ad's setting). */
  qualityRepairs: number;
  /** Latest generation job (written by the backend). */
  jobId: string | null;
  /** Latest validation job (written by the backend). */
  validationJobId: string | null;
  /** Validation of the selected take (written by the backend). */
  validation: AdSceneValidationSummary | null;
  /** Placeholder note: what real material should replace this scene later. */
  replaceNote: string;
  /** Submission lock (written by the backend) — stops double submissions. */
  lock?: { until: number; by: string } | null;
}

export function defaultAdScene(partial: Partial<AdSceneSpec> = {}): AdSceneSpec {
  return { kind: 'generated_video', narration: '', lineIds: [], onScreenText: '', subText: '', assetIds: [], captions: true, motion: 'push_in', inPoint: 0, qualityRepairs: 0, jobId: null, validationJobId: null, validation: null, replaceNote: '', ...partial };
}

// ---------------------------------------------------------------------------
// Transcript reconciliation (reference script vs. word-timed transcription)
// ---------------------------------------------------------------------------

const FILLERS = new Set(['uh', 'um', 'erm', 'er', 'hmm', 'mm', 'ah', 'eh']);
/** Short function words transcription often drops even when they are spoken. */
const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'and', 'to', 'of', 'you', 'we', 'in', 'on', 'it', 'is', 'with', 'so', 'but', 'for', 'at', 'that', 'what', 'one']);

export interface TranscriptCorrection {
  written: string;
  heard: string;
  start: number | null;
  kind: 'protected_term' | 'spelling' | 'heard_differently';
  /** Which text the captions use. */
  used: 'script' | 'heard';
}

export interface TranscriptReport {
  method: 'reference_aligned' | 'transcript_only';
  referenceWords: number;
  heardWords: number;
  matched: number;
  corrected: TranscriptCorrection[];
  /** Script words the transcription did not hear: kept (timed between neighbours) or left out of the captions. */
  notDetected: { text: string; near: number | null; kept: boolean }[];
  /** Words heard that are not in the script. */
  extra: { text: string; start: number; kept: boolean }[];
  protectedTerms: { term: string; expected: number; found: number; heardAs: string[] }[];
  /** Matched + corrected script words / script words. */
  coverage: number;
  speechStart: number | null;
  speechEnd: number | null;
}

export interface ReconcileOptions {
  durationSec: number;
  protectedTerms?: string[];
  maxPhraseWords?: number;
  maxPhraseChars?: number;
  languageCode?: string | null;
  audioAssetId?: string | null;
}

interface RefToken {
  raw: string;
  norm: string;
  sentence: number;
  /** Protected term this token stands for (multi-word terms are one token). */
  term: string | null;
}

interface HeardToken {
  text: string;
  norm: string;
  start: number;
  end: number;
  term: string | null;
}

interface PlacedWord {
  text: string;
  start: number;
  end: number;
  sentence: number;
  flag: WordFlag;
  confidence: number;
}

const termKey = (t: string) => normalizeWord(t.replace(/\s+/g, ''));

/** Splits the reference into sentences (line breaks and sentence punctuation), then into tokens; protected multi-word terms become one token. */
function referenceTokens(reference: string, terms: string[]): { tokens: RefToken[]; sentences: string[]; paragraphs: number[] } {
  const sentences: string[] = [];
  const paragraphs: number[] = [];
  reference
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line, p) => {
      for (const sentence of splitSentences(line).map((x) => x.trim()).filter(Boolean)) {
        sentences.push(sentence);
        paragraphs.push(p);
      }
    });
  const tokens: RefToken[] = [];
  sentences.forEach((s, si) => {
    const toks = tokenize(s);
    for (let i = 0; i < toks.length; i++) {
      let merged = false;
      for (const term of terms) {
        const parts = tokenize(term);
        if (parts.length < 2 || i + parts.length > toks.length) continue;
        if (parts.every((p, k) => toks[i + k]!.norm === p.norm)) {
          tokens.push({ raw: toks.slice(i, i + parts.length).map((t) => t.raw).join(' '), norm: termKey(term), sentence: si, term });
          i += parts.length - 1;
          merged = true;
          break;
        }
      }
      if (merged) continue;
      const t = toks[i]!;
      const single = terms.find((term) => tokenize(term).length === 1 && normalizeWord(term) === t.norm) ?? null;
      tokens.push({ raw: t.raw, norm: t.norm, sentence: si, term: single });
    }
  });
  return { tokens, sentences, paragraphs };
}

/** Heard words as tokens; windows of 1–3 heard words that sound like a protected multi-word term are merged. */
function heardTokens(asr: AsrWord[], terms: string[]): HeardToken[] {
  const words = asr
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.text.trim())
    .sort((a, b) => a.start - b.start)
    .flatMap((w) => {
      const toks = tokenize(w.text);
      if (toks.length <= 1) return toks.length ? [{ text: w.text.trim(), norm: toks[0]!.norm, start: w.start, end: Math.max(w.end, w.start) }] : [];
      // A "word" holding several tokens (e.g. "Indigen-World") shares its time span evenly.
      const span = Math.max(0.01, w.end - w.start) / toks.length;
      return toks.map((t, i) => ({ text: t.raw, norm: t.norm, start: w.start + span * i, end: w.start + span * (i + 1) }));
    });
  const multi = terms.filter((t) => tokenize(t).length >= 2).map((t) => ({ term: t, key: termKey(t) }));
  const out: HeardToken[] = [];
  for (let i = 0; i < words.length; i++) {
    let best: { len: number; sim: number; term: string } | null = null;
    for (const m of multi) {
      for (let len = 1; len <= 3 && i + len <= words.length; len++) {
        const joined = words.slice(i, i + len).map((w) => w.norm).join('');
        const sim = wordSimilarity(joined, m.key);
        if (sim >= 0.72 && (!best || sim > best.sim)) best = { len, sim, term: m.term };
      }
    }
    if (best) {
      const span = words.slice(i, i + best.len);
      out.push({ text: span.map((w) => w.text).join(' '), norm: termKey(best.term), start: span[0]!.start, end: span[span.length - 1]!.end, term: best.term });
      i += best.len - 1;
    } else {
      const w = words[i]!;
      out.push({ ...w, term: null });
    }
  }
  return out;
}

/** Words a caption should rather start with than end on (break before them). */
const BREAK_BEFORE = new Set(['and', 'but', 'or', 'so', 'when', 'that', 'who', 'which', 'with', 'to', 'for', 'in', 'on', 'of', 'because', 'if', 'while', 'as']);
const phraseLen = (ws: { text: string }[]) => ws.reduce((s, w) => s + [...w.text].length + 1, -1);

/** Splits one clause into the fewest roughly equal phrases that fit, breaking before conjunctions where it can. */
function balancedSplit(words: PlacedWord[], maxWords: number, maxChars: number): PlacedWord[][] {
  if (words.length <= maxWords && phraseLen(words) <= maxChars) return [words];
  const parts = Math.max(Math.ceil(phraseLen(words) / maxChars), Math.ceil(words.length / maxWords));
  const total = phraseLen(words);
  const out: PlacedWord[][] = [];
  let start = 0;
  for (let k = 1; k < parts && start < words.length - 1; k++) {
    const target = (total * k) / parts;
    let best = -1;
    let bestScore = Infinity;
    for (let i = start + 1; i < words.length; i++) {
      const cum = phraseLen(words.slice(0, i));
      const chunk = words.slice(start, i);
      if (chunk.length > maxWords + 1 || phraseLen(chunk) > maxChars + 8) break;
      const nextWord = words[i]!.text.toLowerCase().replace(/[^\p{L}']/gu, '');
      const score = Math.abs(cum - target) - (BREAK_BEFORE.has(nextWord) ? 5 : 0) + (chunk.length === 1 ? 8 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) best = Math.min(words.length - 1, start + maxWords);
    out.push(words.slice(start, best));
    start = best;
  }
  out.push(words.slice(start));
  return out.filter((p) => p.length);
}

/** Caption phrases of a sentence: clauses at punctuation and long pauses, each balanced to fit two short rows. */
function phraseLines(words: PlacedWord[], maxWords: number, maxChars: number): PlacedWord[][] {
  const clauses: PlacedWord[][] = [];
  let cur: PlacedWord[] = [];
  words.forEach((w, i) => {
    const next = words[i + 1];
    cur.push(w);
    const pause = next ? next.start - w.end : 0;
    if (!next || /[,;:—–]$/.test(w.text) || pause >= 0.45) {
      clauses.push(cur);
      cur = [];
    }
  });
  // Very short clauses join a neighbour when the result still fits ("you know what you want to say,").
  const merged: PlacedWord[][] = [];
  for (const c of clauses) {
    const prev = merged[merged.length - 1];
    if (prev && (c.length <= 2 || prev.length <= 2) && phraseLen([...prev, ...c]) <= maxChars && prev.length + c.length <= maxWords + 1) merged[merged.length - 1] = [...prev, ...c];
    else merged.push(c);
  }
  return merged.flatMap((c) => balancedSplit(c, maxWords, maxChars));
}

function makeSheet(placed: PlacedWord[], sentences: string[], opts: ReconcileOptions, method: string, paragraphs?: number[]): LyricsSheet {
  const maxWords = opts.maxPhraseWords ?? 8;
  const maxChars = opts.maxPhraseChars ?? 34;
  const sections: LyricSheetSection[] = [];
  const lines: LyricSheetLine[] = [];
  const bySentence = new Map<number, PlacedWord[]>();
  for (const w of placed) bySentence.set(w.sentence, [...(bySentence.get(w.sentence) ?? []), w]);
  [...bySentence.keys()]
    .sort((a, b) => a - b)
    .forEach((si) => {
      const ws = bySentence.get(si)!.sort((a, b) => a.start - b.start);
      const sec: LyricSheetSection = { id: lyricId('sec'), label: 'verse', name: (sentences[si] ?? ws.map((w) => w.text).join(' ')).slice(0, 80), paragraph: paragraphs?.[si] ?? si };
      sections.push(sec);
      for (const group of phraseLines(ws, maxWords, maxChars)) {
        const words: LyricWord[] = group.map((w) => ({ text: w.text, start: round3(w.start), end: round3(w.end), confidence: w.confidence, flag: w.flag }));
        const conf = words.reduce((s, w) => s + w.confidence, 0) / Math.max(1, words.length);
        const flags: LyricSheetLine['flags'] = [];
        if (words.some((w) => w.flag === 'uncertain')) flags.push('uncertain_words');
        if (conf < 0.55) flags.push('low_confidence');
        lines.push({ id: lyricId(), text: words.map((w) => w.text).join(' '), sectionId: sec.id, start: words[0]!.start, end: words[words.length - 1]!.end, words, confidence: round3(conf), flags });
      }
    });
  const low = lines.filter((l) => l.flags.includes('low_confidence') || l.flags.includes('uncertain_words')).map((l) => l.id);
  return {
    version: 1,
    source: 'transcribed',
    status: 'draft',
    approvedAt: null,
    language: opts.languageCode ?? 'en',
    languageName: null,
    requiresLanguageVerification: false,
    languageVerifiedAt: null,
    instrumental: false,
    sections,
    lines,
    timing: { ...emptyTiming(), status: low.length ? 'needs_review' : 'aligned', method, audioAssetId: opts.audioAssetId ?? null, alignedAt: Date.now(), lowConfidenceLineIds: low },
    updatedAt: Date.now(),
  };
}

/** Removes overlaps and keeps every word inside the audio. */
function tidy(words: PlacedWord[], durationSec: number): PlacedWord[] {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  let prevEnd = 0;
  for (const w of sorted) {
    w.start = Math.max(prevEnd, Math.min(durationSec, w.start));
    w.end = Math.min(durationSec, Math.max(w.start + 0.04, w.end));
    prevEnd = w.end;
  }
  return sorted;
}

/**
 * Builds the narration transcript from what was actually heard. The reference script supplies spelling,
 * punctuation and sentence structure where the recording agrees with it; it is never taken as proof that a
 * word was spoken. Protected terms (e.g. Kasem, Indigen World) keep their exact spelling when the narrator
 * plainly said them, even if the transcription misheard them.
 */
export function reconcileTranscript(asr: AsrWord[], reference: string | null | undefined, opts: ReconcileOptions): { sheet: LyricsSheet; report: TranscriptReport } {
  const terms = [...new Set((opts.protectedTerms ?? []).map((t) => t.trim()).filter(Boolean))];
  const heard = heardTokens(asr, terms);
  const speechStart = heard.length ? round3(heard[0]!.start) : null;
  const speechEnd = heard.length ? round3(heard[heard.length - 1]!.end) : null;
  const report: TranscriptReport = { method: 'transcript_only', referenceWords: 0, heardWords: heard.length, matched: 0, corrected: [], notDetected: [], extra: [], protectedTerms: [], coverage: 0, speechStart, speechEnd };

  if (!reference?.trim()) {
    // No script: sentences come from the transcription's own punctuation and long pauses.
    const placed: PlacedWord[] = [];
    let sentence = 0;
    heard.forEach((h, i) => {
      if (FILLERS.has(h.norm)) return;
      const text = h.term ?? h.text;
      placed.push({ text, start: h.start, end: h.end, sentence, flag: 'aligned', confidence: 0.8 });
      const next = heard[i + 1];
      if (/[.!?]$/.test(h.text) || (next && next.start - h.end >= 0.8)) sentence += 1;
    });
    const sentences: string[] = [];
    for (const w of placed) sentences[w.sentence] = sentences[w.sentence] ? `${sentences[w.sentence]} ${w.text}` : w.text;
    for (const term of terms) report.protectedTerms.push({ term, expected: 0, found: heard.filter((h) => h.term === term).length, heardAs: [...new Set(heard.filter((h) => h.term === term).map((h) => h.text))] });
    report.coverage = 1;
    return { sheet: makeSheet(tidy(placed, opts.durationSec), sentences, opts, 'word_timed_transcript'), report };
  }

  const { tokens: ref, sentences, paragraphs } = referenceTokens(reference, terms);
  report.method = 'reference_aligned';
  report.referenceWords = ref.length;
  const ops = alignWords(
    ref.map((t) => t.norm),
    heard.map((h) => h.norm),
    { matchThreshold: 0.75 },
  );

  // Group the edit script into anchors (match/substitute) and gaps, so unmatched script words and unmatched
  // heard words between the same anchors can be paired (a misheard word shows up as delete + insert).
  type Slot = { ref?: number; heard?: number; sim?: number };
  const slots: Slot[] = [];
  let gapRefs: number[] = [];
  let gapHeard: number[] = [];
  const mergeHeard = (from: number, to: number): number => {
    // A protected multi-word term heard as several fragments ("in the gen world") becomes one heard token.
    if (to <= from) return from;
    const span = heard.slice(from, to + 1);
    heard[from] = { text: span.map((h) => h.text).join(' '), norm: span.map((h) => h.norm).join(''), start: span[0]!.start, end: span[span.length - 1]!.end, term: null };
    return from;
  };
  const flushGap = () => {
    let surplus = gapHeard.length - gapRefs.length;
    let hi = 0;
    const paired: Slot[] = [];
    for (const r of gapRefs) {
      if (hi >= gapHeard.length) {
        paired.push({ ref: r });
        continue;
      }
      const words = ref[r]!.term ? tokenize(ref[r]!.term!).length : 1;
      const take = 1 + Math.max(0, Math.min(surplus, words - 1));
      surplus -= take - 1;
      const h = mergeHeard(gapHeard[hi]!, gapHeard[hi + take - 1]!);
      paired.push({ ref: r, heard: h, sim: wordSimilarity(ref[r]!.norm, heard[h]!.norm) });
      hi += take;
    }
    slots.push(...paired);
    for (const h of gapHeard.slice(hi)) slots.push({ heard: h });
    gapRefs = [];
    gapHeard = [];
  };
  for (const op of ops) {
    if (op.op === 'delete') gapRefs.push(op.e);
    else if (op.op === 'insert') gapHeard.push(op.d);
    else {
      flushGap();
      slots.push({ ref: op.e, heard: op.d, sim: op.sim });
    }
  }
  flushGap();

  const placed: PlacedWord[] = [];
  const pendingRefs: { ref: number; at: number }[] = [];
  const termHits = new Map<string, number>();
  for (const [i, s] of slots.entries()) {
    if (s.ref !== undefined && s.heard !== undefined) {
      const r = ref[s.ref]!;
      const h = heard[s.heard]!;
      const sim = s.sim ?? 0;
      if (r.term && (sim >= 0.5 || h.term === r.term)) termHits.set(r.term, (termHits.get(r.term) ?? 0) + 1);
      if (sim >= 0.75) {
        report.matched += 1;
        placed.push({ text: r.raw, start: h.start, end: h.end, sentence: r.sentence, flag: 'aligned', confidence: 0.95 });
        if (r.term && h.text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase() !== r.raw.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()) {
          report.corrected.push({ written: r.raw.replace(/[,.;:!?]+$/, ''), heard: h.text, start: round3(h.start), kind: 'protected_term', used: 'script' });
        }
      } else if (r.term || sim >= 0.5) {
        // A protected term, or a near miss: the narrator said the script word; transcription misspelled it.
        report.matched += 1;
        placed.push({ text: r.raw, start: h.start, end: h.end, sentence: r.sentence, flag: r.term ? 'aligned' : 'uncertain', confidence: r.term ? 0.85 : 0.6 });
        report.corrected.push({ written: r.raw.replace(/[,.;:!?]+$/, ''), heard: h.text, start: round3(h.start), kind: r.term ? 'protected_term' : 'spelling', used: 'script' });
      } else {
        // Clearly different: the recording is the authority; flagged for the director to confirm.
        const punct = /[,.;:!?]+$/.exec(r.raw)?.[0] ?? '';
        placed.push({ text: `${h.text.replace(/[,.;:!?]+$/, '')}${punct}`, start: h.start, end: h.end, sentence: r.sentence, flag: 'uncertain', confidence: 0.45 });
        report.corrected.push({ written: r.raw.replace(/[,.;:!?]+$/, ''), heard: h.text, start: round3(h.start), kind: 'heard_differently', used: 'heard' });
      }
    } else if (s.ref !== undefined) {
      pendingRefs.push({ ref: s.ref, at: i });
    } else if (s.heard !== undefined) {
      const h = heard[s.heard]!;
      if (FILLERS.has(h.norm)) {
        report.extra.push({ text: h.text, start: round3(h.start), kept: false });
        continue;
      }
      // Inside the narration (between words the script and the recording share) → spoken; else ambient.
      const before = slots.slice(0, i).reverse().find((x) => x.ref !== undefined && x.heard !== undefined);
      const after = slots.slice(i + 1).find((x) => x.ref !== undefined && x.heard !== undefined);
      const inside = Boolean(before && after);
      const sentence = before ? ref[before.ref!]!.sentence : after ? ref[after.ref!]!.sentence : 0;
      report.extra.push({ text: h.text, start: round3(h.start), kept: inside });
      if (inside) placed.push({ text: h.term ?? h.text, start: h.start, end: h.end, sentence, flag: 'uncertain', confidence: 0.5 });
    }
  }

  // Script words not heard: keep short function words (often swallowed) and any word with room for it
  // between its neighbours; leave out content words the recording has no time for.
  for (const p of pendingRefs) {
    const r = ref[p.ref]!;
    const prevAnchor = slots.slice(0, p.at).reverse().find((x) => x.heard !== undefined && x.ref !== undefined);
    const nextAnchor = slots.slice(p.at + 1).find((x) => x.heard !== undefined && x.ref !== undefined);
    const prevEnd = prevAnchor ? heard[prevAnchor.heard!]!.end : speechStart ?? 0;
    const nextStart = nextAnchor ? heard[nextAnchor.heard!]!.start : speechEnd ?? opts.durationSec;
    const missingHere = pendingRefs.filter((q) => {
      const pa = slots.slice(0, q.at).reverse().find((x) => x.heard !== undefined && x.ref !== undefined);
      return pa === prevAnchor;
    });
    const k = missingHere.findIndex((q) => q.ref === p.ref);
    const gap = Math.max(0, nextStart - prevEnd);
    const room = gap >= 0.12 * missingHere.length;
    const keep = FUNCTION_WORDS.has(r.norm) || room || Boolean(r.term);
    report.notDetected.push({ text: r.raw.replace(/[,.;:!?]+$/, ''), near: round3(prevEnd), kept: keep });
    if (!keep) continue;
    const span = Math.max(0.08, gap) / missingHere.length;
    const start = prevEnd + span * k;
    placed.push({ text: r.raw, start, end: start + Math.max(0.06, span * 0.9), sentence: r.sentence, flag: 'interpolated', confidence: 0.3 });
  }

  for (const term of terms) {
    const key = termKey(term);
    report.protectedTerms.push({
      term,
      expected: ref.filter((r) => r.norm === key).length,
      found: termHits.get(term) ?? 0,
      heardAs: [...new Set([...heard.filter((h) => h.term === term).map((h) => h.text), ...report.corrected.filter((c) => termKey(c.written) === key).map((c) => c.heard)])],
    });
  }
  report.coverage = ref.length ? round3(Math.min(1, report.matched / ref.length)) : 1;
  return { sheet: makeSheet(tidy(placed, opts.durationSec), sentences, opts, 'word_timed_transcript+reference', paragraphs), report };
}

/** Script lines with estimated timing (brief-first adverts before a voice-over exists). */
export function sheetFromScript(lines: string[], durationSec: number, opts: { languageCode?: string | null; startSec?: number; gapSec?: number } = {}): LyricsSheet {
  const text = lines.map((l) => l.trim()).filter(Boolean);
  const est = text.map((l) => Math.max(0.8, estimateSpeechSeconds(l)));
  const gap = opts.gapSec ?? 0.45;
  const start0 = opts.startSec ?? 0.6;
  const natural = est.reduce((s, e) => s + e, 0) + gap * Math.max(0, text.length - 1);
  const room = Math.max(1, durationSec - start0 - 2.5);
  const k = natural > room ? room / natural : 1;
  let t = start0;
  const placed: PlacedWord[] = [];
  text.forEach((line, si) => {
    const words = tokenize(line);
    const dur = est[si]! * k;
    const per = dur / Math.max(1, words.length);
    words.forEach((w, wi) => placed.push({ text: w.raw, start: t + per * wi, end: t + per * (wi + 0.9), sentence: si, flag: 'interpolated', confidence: 0.3 }));
    t += dur + gap * k;
  });
  const sheet = makeSheet(tidy(placed, durationSec), text, { durationSec, languageCode: opts.languageCode ?? 'en' }, 'estimated_from_script');
  return { ...sheet, source: 'manual', timing: { ...sheet.timing, status: 'approximate' } };
}

// ---------------------------------------------------------------------------
// Scene windows aligned to the narration
// ---------------------------------------------------------------------------

export interface AdSceneWindow {
  index: number;
  start: number;
  end: number;
  sectionIds: string[];
  lineIds: string[];
  narration: string;
}

interface Sentence {
  sectionId: string;
  paragraph: number;
  start: number;
  end: number;
  lines: LyricSheetLine[];
}

function sentencesOf(sheet: LyricsSheet): Sentence[] {
  const timed = sheet.lines.filter((l) => l.start !== null && l.end !== null && l.end > l.start);
  const paragraphOf = new Map(sheet.sections.map((s, i) => [s.id, s.paragraph ?? i]));
  const out: Sentence[] = [];
  for (const l of timed) {
    const key = l.sectionId ?? l.id;
    const last = out[out.length - 1];
    if (last && last.sectionId === key) {
      last.lines.push(l);
      last.end = Math.max(last.end, l.end!);
    } else out.push({ sectionId: key, paragraph: paragraphOf.get(key) ?? out.length, start: l.start!, end: l.end!, lines: [l] });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Cuts the advert into scenes on the real narration. Windows tile [0, duration] exactly (no gaps, no
 * overlaps); a cut lands just before the first word of its beat. Sentences of one script paragraph stay
 * together when they fit one shot; a window shorter than `minSec` joins the neighbour that gives the shorter
 * scene; a window longer than `maxSec` splits at the widest pause between two caption lines.
 */
export function planSceneWindows(sheet: LyricsSheet, durationSec: number, opts: { minSec?: number; maxSec?: number; leadSec?: number } = {}): AdSceneWindow[] {
  const minSec = opts.minSec ?? 1.6;
  const maxSec = opts.maxSec ?? 8.5;
  const lead = opts.leadSec ?? 0.12;
  const D = round3(durationSec);
  const sentences = sentencesOf(sheet);
  if (!sentences.length || D <= 0) return D > 0 ? [{ index: 0, start: 0, end: D, sectionIds: [], lineIds: [], narration: '' }] : [];

  // Beats: a script paragraph when it fits one shot, otherwise its sentences.
  let groups: Sentence[][] = [];
  for (const s of sentences) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.paragraph === s.paragraph && s.end - last[0]!.start <= maxSec) last.push(s);
    else groups.push([s]);
  }
  const startOf = (g: Sentence[]) => g[0]!.start;
  const endOf = (g: Sentence[]) => g[g.length - 1]!.end;
  const cutsFor = (gs: Sentence[][]) => {
    const cuts = [0];
    for (let i = 1; i < gs.length; i++) cuts.push(round3(Math.max(endOf(gs[i - 1]!), startOf(gs[i]!) - lead)));
    cuts.push(D);
    return cuts;
  };
  // Short windows join the neighbour that gives the shorter scene (the closing window keeps the audio's tail).
  for (let guard = 0; guard < 100 && groups.length > 1; guard++) {
    const cuts = cutsFor(groups);
    const lens = groups.map((_, i) => cuts[i + 1]! - cuts[i]!);
    const i = lens.findIndex((l) => l < minSec);
    if (i < 0) break;
    const withPrev = i > 0 ? cuts[i + 1]! - cuts[i - 1]! : Infinity;
    const withNext = i < groups.length - 1 ? cuts[i + 2]! - cuts[i]! : Infinity;
    const j = withPrev <= withNext ? i - 1 : i;
    groups = [...groups.slice(0, j), [...groups[j]!, ...groups[j + 1]!], ...groups.slice(j + 2)];
  }
  const cuts = cutsFor(groups);
  type Win = { start: number; end: number; lines: LyricSheetLine[]; sectionIds: string[] };
  const windows: Win[] = groups.map((g, i) => ({ start: cuts[i]!, end: cuts[i + 1]!, lines: g.flatMap((s) => s.lines), sectionIds: g.map((s) => s.sectionId) }));

  // Long windows split at the widest pause between caption lines near the middle (never the closing card's tail).
  const split = (w: Win): Win[] => {
    if (w.end - w.start <= maxSec || w.lines.length < 2) return [w];
    const speechEnd = w.lines[w.lines.length - 1]!.end!;
    if (speechEnd - w.start <= maxSec && w.end === D) return [w];
    const mid = (w.start + Math.min(w.end, speechEnd)) / 2;
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 1; i < w.lines.length; i++) {
      const gapStart = w.lines[i - 1]!.end!;
      const gapEnd = w.lines[i]!.start!;
      const at = (gapStart + gapEnd) / 2;
      if (at - w.start < minSec || w.end - at < minSec) continue;
      const score = (gapEnd - gapStart) * 2 - Math.abs(at - mid) / (w.end - w.start);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return [w];
    const cut = round3(Math.max(w.lines[best - 1]!.end!, w.lines[best]!.start! - lead));
    const left = w.lines.slice(0, best);
    const right = w.lines.slice(best);
    return [...split({ start: w.start, end: cut, lines: left, sectionIds: [...new Set(left.map((l) => l.sectionId ?? l.id))] }), ...split({ start: cut, end: w.end, lines: right, sectionIds: [...new Set(right.map((l) => l.sectionId ?? l.id))] })];
  };
  return windows.flatMap(split).map((w, index) => ({ index, start: round3(w.start), end: round3(w.end), sectionIds: w.sectionIds, lineIds: w.lines.map((l) => l.id), narration: w.lines.map((l) => l.text).join(' ') }));
}


/** Generation length for a scene window: whole seconds within the model's range, never shorter than the window. */
export function sceneGenerationSeconds(windowSec: number, range: { min: number; max: number } = { min: 3, max: 10 }): number {
  return Math.min(range.max, Math.max(range.min, Math.ceil(windowSec + 0.25)));
}

/** Problems with a scene plan before anything is generated. */
export function sceneWindowProblems(windows: { start: number; end: number; kind?: AdSceneKind }[], durationSec: number, maxGenerated = 10): string[] {
  const out: string[] = [];
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  if (!sorted.length) return ['The storyboard has no scenes.'];
  if (Math.abs(sorted[0]!.start) > 0.01) out.push(`The first scene starts at ${sorted[0]!.start.toFixed(2)} s — the advert must start at 0.`);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]!.start - sorted[i - 1]!.end;
    if (gap > 0.01) out.push(`Gap of ${gap.toFixed(2)} s before scene ${i + 1}.`);
    if (gap < -0.01) out.push(`Scenes ${i} and ${i + 1} overlap by ${(-gap).toFixed(2)} s.`);
  }
  const end = sorted[sorted.length - 1]!.end;
  if (Math.abs(end - durationSec) > 0.01) out.push(`The last scene ends at ${end.toFixed(2)} s but the audio lasts ${durationSec.toFixed(2)} s.`);
  sorted.forEach((w, i) => {
    if (w.kind && isGeneratedScene(w.kind) && w.end - w.start > maxGenerated + 0.01) out.push(`Scene ${i + 1} lasts ${(w.end - w.start).toFixed(1)} s — longer than one generation (${maxGenerated} s). Split it.`);
    if (w.end - w.start < MIN_CLIP_SECONDS) out.push(`Scene ${i + 1} is too short.`);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Prompts for generated scenes
// ---------------------------------------------------------------------------

export interface AdScenePromptInput {
  kind: AdSceneKind;
  visual: string;
  directions?: Partial<ShotDirections>;
  narration: string;
  durationSec: number;
  aspect: '9:16' | '16:9';
  /** Notes from a failed validation, folded into a regeneration. */
  repairNotes?: string[];
}

/** Ad-wide direction that every generated scene carries. */
export function adStyleLines(brief: Pick<AdBrief, 'visualDirection' | 'mustAvoid' | 'tone'>): string[] {
  const lines: string[] = [];
  if (brief.visualDirection.trim()) lines.push(`Look and feel: ${brief.visualDirection.trim().replace(/\s+/g, ' ')}`);
  if (brief.tone.trim()) lines.push(`Tone: ${brief.tone.trim()}`);
  return lines;
}

const AD_AVOID =
  'Do not show any readable text, captions, subtitles, signs with words, logos, brand marks, app interfaces or watermarks — text and branding are added in the edit. ' +
  'Avoid distorted or extra fingers, morphing faces, characters who change appearance mid-shot, and generic corporate stock-footage staging.';

/** The prompt for a generated video scene (Gemini Omni). The narration is laid over the edit, so the clip carries no dialogue track of its own. */
export function compileAdVideoPrompt(input: AdScenePromptInput, brief: Pick<AdBrief, 'visualDirection' | 'mustAvoid' | 'tone'>): string {
  const d = { ...EMPTY_DIRECTIONS, ...(input.directions ?? {}) };
  if (!d.action.trim()) d.action = input.visual;
  const body = compileShotPrompt(d, {
    description: input.visual,
    durationSec: input.durationSec,
    singleContinuousShot: true,
    noOverlayText: true,
  }).replace(/^Dialogue: No dialogue\.$/m, `Dialogue: No dialogue — people may smile, gesture or talk quietly without clear words; the advert's voice-over is added in the edit.`);
  const extra = [
    `Format: ${input.aspect === '9:16' ? 'vertical 9:16, subjects framed for a phone screen with room above and below' : 'horizontal 16:9'}; one continuous ${input.durationSec}-second shot with gentle, motivated camera movement.`,
    ...adStyleLines(brief),
    'Sound: natural room or street ambience only, no music.',
    AD_AVOID,
    brief.mustAvoid.trim() ? `Also avoid: ${brief.mustAvoid.trim()}` : '',
    ...(input.repairNotes?.length ? [`Fix from the previous attempt: ${input.repairNotes.join(' ')}`] : []),
  ].filter(Boolean);
  return [body, ...extra].join('\n');
}

/** The prompt for a generated still (Nano Banana Pro); still-image motion is added in the edit. */
export function compileAdImagePrompt(input: AdScenePromptInput, brief: Pick<AdBrief, 'visualDirection' | 'mustAvoid' | 'tone'>): string {
  return [
    `Photographic still for a ${input.aspect === '9:16' ? 'vertical 9:16' : 'horizontal 16:9'} video advert: ${input.visual.trim()}`,
    ...adStyleLines(brief),
    'Natural, candid moment; realistic hands and faces; shallow depth of field; no text, letters, logos or watermarks anywhere in the image.',
    brief.mustAvoid.trim() ? `Avoid: ${brief.mustAvoid.trim()}` : '',
    ...(input.repairNotes?.length ? [`Fix from the previous attempt: ${input.repairNotes.join(' ')}`] : []),
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Validation verdict (deterministic, from measurements and the reviewer's findings)
// ---------------------------------------------------------------------------

export interface AdValidationInput {
  kind: AdSceneKind;
  /** Length of the scene's window on the timeline. */
  windowSec: number;
  /** Seconds of media needed after the in-point. */
  neededSec: number;
  /** Expected shape of the media (generation aspect or the ad's aspect). */
  expectedAspect: '9:16' | '16:9' | '1:1' | null;
  outputHeight: number;
  measurements: AdSceneValidation['measurements'];
  probeOk: boolean;
  review: AdSceneValidation['review'];
  modelId: string | null;
}

const ASPECT_VALUE: Record<string, number> = { '9:16': 9 / 16, '16:9': 16 / 9, '1:1': 1 };

export function evaluateAdScene(input: AdValidationInput): AdSceneValidation {
  const m = input.measurements;
  const checks: AdSceneValidation['checks'] = [];
  const add = (id: AdCheckId, label: string, ok: boolean, severity: 'info' | 'warning' | 'error', detail: string) => checks.push({ id, label, ok, severity: ok ? 'info' : severity, detail });
  add('playable', 'Plays back', input.probeOk && m.decodeErrors === 0, 'error', input.probeOk ? (m.decodeErrors ? `${m.decodeErrors} decode error(s)` : 'Decodes cleanly') : 'The file could not be read');
  const isVideo = input.kind === 'generated_video' || input.kind === 'footage';
  if (isVideo) {
    const ok = (m.durationSec ?? 0) + 0.05 >= input.neededSec;
    add('duration', 'Long enough', ok, 'error', `${(m.durationSec ?? 0).toFixed(2)} s available, ${input.neededSec.toFixed(2)} s needed — never stretched to fit`);
  }
  if (input.expectedAspect && m.width && m.height) {
    const want = ASPECT_VALUE[input.expectedAspect]!;
    const got = m.width / m.height;
    const ok = Math.abs(got - want) / want < 0.03;
    add('aspect', 'Aspect ratio', ok, input.kind === 'generated_video' || input.kind === 'generated_image' ? 'error' : 'warning', `${m.width}×${m.height} (${got.toFixed(3)}), expected ${input.expectedAspect}`);
  }
  if (m.height && m.width) {
    const short = Math.min(m.width, m.height);
    const ok = short >= Math.min(1080, input.outputHeight) * 0.66;
    add('resolution', 'Resolution', ok, 'warning', `${m.width}×${m.height}${ok ? '' : ' — will look soft at the export size'}`);
  }
  if (isVideo) add('black', 'No black frames', m.blackSec < 0.25, 'warning', m.blackSec ? `${m.blackSec.toFixed(2)} s of black` : 'None');
  const r = input.review;
  if (r) {
    const issue = (types: string[]) => r.issues.filter((i) => types.includes(i.type));
    const worst = (list: { severity: string }[]) => (list.some((i) => i.severity === 'critical') ? 'critical' : list.some((i) => i.severity === 'major') ? 'major' : list.length ? 'minor' : null);
    const text = issue(['text_in_frame', 'logo', 'watermark']);
    const art = issue(['distorted_hands', 'face_morph', 'artefact', 'inconsistent_character']);
    const cont = issue(['continuity']);
    add('brief', 'Matches the scene brief', r.matchesBrief === null || r.matchesBrief >= 55, r.matchesBrief !== null && r.matchesBrief < 35 ? 'error' : 'warning', r.matchesBrief === null ? 'Not scored' : `${r.matchesBrief}/100 — ${r.summary.slice(0, 160)}`);
    add('text_in_frame', 'No generated text or logos', !text.length || worst(text) === 'minor', worst(text) === 'critical' || worst(text) === 'major' ? 'error' : 'warning', text.map((i) => i.note).join(' ') || 'None seen');
    add('artefacts', 'Hands, faces and people look right', !art.length || worst(art) === 'minor', worst(art) === 'critical' ? 'error' : 'warning', art.map((i) => i.note).join(' ') || 'None seen');
    if (cont.length) add('continuity', 'Visual continuity', worst(cont) === 'minor', worst(cont) === 'critical' ? 'error' : 'warning', cont.map((i) => i.note).join(' '));
  }
  const errors = checks.filter((c) => !c.ok && c.severity === 'error').length;
  const warnings = checks.filter((c) => !c.ok && c.severity === 'warning').length;
  return { verdict: errors ? 'fail' : warnings ? 'warn' : 'pass', checkedAt: Date.now(), checks, review: input.review, measurements: m, modelId: input.modelId };
}

// ---------------------------------------------------------------------------
// Captions (a lyric style tuned for adverts) and the timeline
// ---------------------------------------------------------------------------

/** Caption placement per aspect: clear of the platform UI (top bar, bottom caption area, right-hand buttons). */
export const AD_CAPTION_Y: Record<AdAspect, { body: number; hook: number; outro: number }> = {
  '9:16': { body: 0.69, hook: 0.45, outro: 0.33 },
  '16:9': { body: 0.85, hook: 0.5, outro: 0.36 },
  '1:1': { body: 0.8, hook: 0.48, outro: 0.32 },
};

/**
 * Advert captions: readable sentence-case words with the active word lit in the accent colour; the closing
 * lines (sections `hook` and `outro`) switch to large, restrained typography on the brand ground.
 */
export function adCaptionStyle(brand: Pick<AdBrand, 'font' | 'accent' | 'text' | 'background'>): Omit<LyricStyleDoc, 'id'> {
  const base = LYRIC_PRESET_STYLES.active_word;
  const global: LyricStyle = {
    ...base,
    fontFamily: brand.font,
    fontWeight: 800,
    fontSizePct: 4.3,
    capitalisation: 'none',
    maxCharsPerLine: 24,
    maxLines: 2,
    y: AD_CAPTION_Y['16:9'].body,
    activeColor: brand.accent,
    inactiveColor: brand.text,
    outline: { width: 3, color: '#0B1020' },
    shadow: { x: 0, y: 3, blur: 6, color: '#000000', opacity: 0.5 },
    wordAnimation: 'highlight',
    entrance: 'fade',
    exit: 'fade',
    transitionMs: 140,
    safeMargin: 0.01,
    aspects: { '9:16': { y: AD_CAPTION_Y['9:16'].body, fontSizePct: 3.5 }, '1:1': { y: AD_CAPTION_Y['1:1'].body, fontSizePct: 4.6 }, '16:9': { y: AD_CAPTION_Y['16:9'].body } },
  };
  const typography = (key: 'hook' | 'outro'): Partial<LyricStyle> => ({
    preset: 'large_centred',
    fontFamily: brand.font,
    fontWeight: 700,
    fontSizePct: key === 'hook' ? 7.2 : 6.2,
    capitalisation: 'none',
    activeColor: brand.text,
    inactiveColor: brand.text,
    outline: null,
    shadow: null,
    glow: null,
    gradient: null,
    box: null,
    wordAnimation: 'none',
    entrance: 'fade',
    exit: 'fade',
    transitionMs: 260,
    maxCharsPerLine: 18,
    maxLines: 3,
    lineSpacing: 1.12,
    y: AD_CAPTION_Y['16:9'][key],
    aspects: { '9:16': { y: AD_CAPTION_Y['9:16'][key], fontSizePct: key === 'hook' ? 4.4 : 3.6, maxCharsPerLine: 16 }, '1:1': { y: AD_CAPTION_Y['1:1'][key], fontSizePct: key === 'hook' ? 6.4 : 5.4 }, '16:9': { y: AD_CAPTION_Y['16:9'][key] } },
  });
  return { name: 'Short ad captions', global, sections: { hook: typography('hook'), outro: typography('outro') }, fonts: [] };
}

/** Section labels for the narration: sentences inside typography scenes become `hook`, inside the end card `outro`. */
export function labelNarrationSections(sheet: LyricsSheet, scenes: { kind: AdSceneKind; start: number; end: number }[]): LyricsSheet {
  const labelOf = (sectionId: string): LyricSheetSection['label'] => {
    const lines = sheet.lines.filter((l) => l.sectionId === sectionId && l.start !== null && l.end !== null);
    if (!lines.length) return 'verse';
    const mid = (lines[0]!.start! + lines[lines.length - 1]!.end!) / 2;
    const scene = scenes.find((s) => mid >= s.start && mid < s.end);
    return scene?.kind === 'end_card' ? 'outro' : scene?.kind === 'typography' ? 'hook' : 'verse';
  };
  return { ...sheet, sections: sheet.sections.map((s) => ({ ...s, label: labelOf(s.id) })), updatedAt: Date.now() };
}

export interface AdAssemblyScene {
  id: string;
  kind: AdSceneKind;
  title: string;
  start: number;
  end: number;
  /** The picture: the selected take for generated scenes, the supplied asset otherwise. */
  media: { assetId: string; kind: 'video' | 'image'; durationSec: number | null; width: number | null; height: number | null } | null;
  inPoint: number;
  motion: AdSceneSpec['motion'];
  onScreenText: string;
  subText: string;
  captions: boolean;
}

export interface AdAssemblyInput {
  aspect: AdAspect;
  fps: 24 | 25 | 30;
  /** Measured audio duration — the length of the advert. */
  durationSec: number;
  audio: { assetId: string; songId: string; label: string };
  sheet: LyricsSheet | null;
  captions: boolean;
  brand: AdBrand;
  tagline: { text: string; start: number; end: number } | null;
  scenes: AdAssemblyScene[];
}

export interface AdAssemblyIssue {
  sceneId: string | null;
  severity: 'warning' | 'error';
  message: string;
}

/** Box (fractions of the frame) for a product screen in each aspect ratio: the whole screen visible, captions below it. */
export const AD_SCREEN_BOX: Record<AdAspect, { x: number; y: number; w: number; h: number }> = {
  '9:16': { x: 0.14, y: 0.11, w: 0.72, h: 0.52 },
  '16:9': { x: 0.36, y: 0.06, w: 0.28, h: 0.7 },
  '1:1': { x: 0.32, y: 0.06, w: 0.36, h: 0.66 },
};

export const AD_LOGO_BOX: Record<AdAspect, { x: number; y: number; w: number; h: number }> = {
  '9:16': { x: 0.36, y: 0.43, w: 0.28, h: 0.13 },
  '16:9': { x: 0.43, y: 0.44, w: 0.14, h: 0.18 },
  '1:1': { x: 0.4, y: 0.42, w: 0.2, h: 0.16 },
};

/** Bottom offsets (fraction of the frame height) of the end card's title and URL. */
const END_CARD_TEXT: Record<AdAspect, { title: number; sub: number; titleSize: number; subSize: number }> = {
  '9:16': { title: 0.355, sub: 0.315, titleSize: 3.3, subSize: 2.3 },
  '16:9': { title: 0.24, sub: 0.17, titleSize: 5.6, subSize: 3.8 },
  '1:1': { title: 0.29, sub: 0.23, titleSize: 4.6, subSize: 3.2 },
};

function colourCard(trackId: string, start: number, duration: number, colour: string, label: string): Clip {
  return makeClip({ trackId, kind: 'title', start, duration, text: '', style: { ...DEFAULT_TEXT_STYLE, background: colour }, label });
}

function textClip(trackId: string, kind: 'title' | 'caption', start: number, duration: number, text: string, style: Partial<TextStyle>, bottomOffset: number, label: string): Clip {
  return makeClip({
    trackId,
    kind,
    start,
    duration,
    text,
    style: { ...DEFAULT_TEXT_STYLE, outline: 0, shadow: false, ...style },
    position: { anchor: 'bottom', offset: bottomOffset, align: 'center' },
    fadeIn: Math.min(0.35, duration / 4),
    fadeOut: Math.min(0.3, duration / 4),
    label,
  });
}

/**
 * Builds the advert's timeline: scenes cut exactly on their windows (never stretched), screens placed on the
 * brand ground, typography and the end card composed as text, narration captions from the transcript, and
 * the approved soundtrack once, untouched, for the whole length.
 */
export function assembleAdTimeline(input: AdAssemblyInput): { state: TimelineState; issues: AdAssemblyIssue[] } {
  const issues: AdAssemblyIssue[] = [];
  const D = round3(input.durationSec);
  const t = (kind: Track['kind'], name: string) => makeTrack(kind, name);
  const tracks = [t('video', 'V1 Scenes'), t('video', 'V2 Screens'), t('overlay', 'Logo'), t('overlay', 'End card title'), t('overlay', 'End card line'), t('caption', 'Narration captions'), t('caption', 'Tagline'), t('audio', 'A1 Approved soundtrack')];
  const [v1, v2, logo, endTitle, endLine, , tagTrack, a1] = tracks as [Track, Track, Track, Track, Track, Track, Track, Track];
  const clips: Clip[] = [];
  const brand = input.brand;
  const scenes = [...input.scenes].sort((a, b) => a.start - b.start);

  // Scenes must tile the whole narration.
  for (const p of sceneWindowProblems(scenes, D)) issues.push({ sceneId: null, severity: 'error', message: p });

  for (const s of scenes) {
    const start = round3(Math.max(0, s.start));
    const end = round3(Math.min(D, s.end));
    const dur = round3(end - start);
    if (dur < MIN_CLIP_SECONDS) continue;
    const label = s.title || `Scene ${scenes.indexOf(s) + 1}`;
    const needsGround = s.kind === 'typography' || s.kind === 'end_card' || s.kind === 'product_screen' || !s.media;
    if (needsGround) clips.push(colourCard(v1.id, start, dur, brand.background, `${label} · ground`));
    if (s.kind === 'typography' || s.kind === 'end_card') {
      if (s.kind === 'end_card') {
        const e = END_CARD_TEXT[input.aspect];
        if (brand.logoAssetId) clips.push(makeClip({ trackId: logo.id, kind: 'image', start, duration: dur, assetId: brand.logoAssetId, label: 'Logo', fit: 'fit', layout: { box: AD_LOGO_BOX[input.aspect], radius: 0, shadow: false, push: 0 }, fadeIn: Math.min(0.4, dur / 4) }));
        else issues.push({ sceneId: s.id, severity: 'warning', message: 'No logo file is assigned: the end card shows the name in type only. Add the official logo under Audio & assets → Logos.' });
        if (s.onScreenText.trim()) clips.push(textClip(endTitle.id, 'title', start, dur, s.onScreenText.trim(), { font: brand.font as TextStyle['font'], sizePct: e.titleSize, color: brand.text, bold: true }, e.title, 'End card title'));
        if (s.subText.trim()) clips.push(textClip(endLine.id, 'title', start, dur, s.subText.trim(), { font: brand.font as TextStyle['font'], sizePct: e.subSize, color: brand.accent, bold: false }, e.sub, 'End card line'));
      } else if (s.onScreenText.trim() && !s.captions) {
        clips.push(textClip(endTitle.id, 'title', start, dur, s.onScreenText.trim(), { font: brand.font as TextStyle['font'], sizePct: input.aspect === '9:16' ? 4.4 : 6.4, color: brand.text, bold: true }, 0.45, `${label} · text`));
      }
      continue;
    }
    if (!s.media) {
      issues.push({ sceneId: s.id, severity: 'error', message: `“${label}” has no picture yet.` });
      continue;
    }
    const m = s.media;
    if (s.kind === 'product_screen') {
      clips.push(makeClip({ trackId: v2.id, kind: 'image', start, duration: dur, assetId: m.assetId, label, fit: 'fit', layout: { box: AD_SCREEN_BOX[input.aspect], radius: 0.055, shadow: true, push: s.motion === 'none' ? 0 : 0.035 }, fadeIn: Math.min(0.25, dur / 6) }));
      continue;
    }
    if (m.kind === 'video') {
      const available = (m.durationSec ?? 0) - s.inPoint;
      if (available + 0.04 < dur) {
        // Never slow a clip down to fill its slot: show what exists and flag the shortfall.
        issues.push({ sceneId: s.id, severity: 'error', message: `“${label}” is ${available.toFixed(2)} s long but its slot is ${dur.toFixed(2)} s. Regenerate it longer or choose another shot — clips are never stretched.` });
      }
      const len = round3(Math.max(MIN_CLIP_SECONDS, Math.min(dur, available)));
      clips.push(makeClip({ trackId: v1.id, kind: 'video', start, duration: len, assetId: m.assetId, inPoint: s.inPoint, sourceDuration: m.durationSec, label, useSourceAudio: false, volume: 0, fit: 'fill' }));
      if (len + 0.04 < dur) clips.push(colourCard(v1.id, round3(start + len), round3(dur - len), brand.background, `${label} · shortfall`));
    } else {
      clips.push(makeClip({ trackId: v1.id, kind: 'image', start, duration: dur, assetId: m.assetId, label, fit: 'fill', kenBurns: s.motion !== 'none' }));
    }
  }

  // Tagline (e.g. "Starting with Kasem"): a small label near the top, inside the safe area.
  if (input.tagline?.text.trim()) {
    const tg = input.tagline;
    const start = round3(Math.max(0, tg.start));
    const end = round3(Math.min(D, tg.end));
    if (end - start >= 0.8) {
      clips.push(
        makeClip({
          trackId: tagTrack.id,
          kind: 'caption',
          start,
          duration: round3(end - start),
          text: tg.text.trim(),
          style: { ...DEFAULT_TEXT_STYLE, font: brand.font as TextStyle['font'], sizePct: input.aspect === '9:16' ? 2.1 : 3.2, color: brand.text, background: brand.primary, bold: true, uppercase: true, outline: 0, shadow: false },
          position: { anchor: 'top', offset: input.aspect === '9:16' ? 0.14 : 0.08, align: 'center' },
          fadeIn: 0.3,
          fadeOut: 0.3,
          label: 'Tagline',
        }),
      );
    }
  }

  // The approved soundtrack, once, for the whole advert (no fades beyond the renderer's click guard).
  clips.push(makeClip({ trackId: a1.id, kind: 'audio', start: 0, duration: D, assetId: input.audio.assetId, inPoint: 0, sourceDuration: D, label: input.audio.label, useSourceAudio: false, songId: input.audio.songId, role: 'music', volume: 1, fadeIn: 0, fadeOut: 0 }));

  let state: TimelineState = { tracks, clips, markers: [], fps: input.fps, aspectRatio: input.aspect, beatGrid: null };
  if (input.captions && input.sheet?.lines.some((l) => l.start !== null)) {
    state = applyLyricCaptions(state, input.audio.songId, input.sheet, 'karaoke');
    // Scenes that hide captions (e.g. a typography card that already shows the words) drop theirs.
    const hidden = scenes.filter((s) => !s.captions && s.kind !== 'typography' && s.kind !== 'end_card');
    if (hidden.length) state = { ...state, clips: state.clips.filter((c) => !(c.lyric && hidden.some((s) => c.start >= s.start - 0.01 && c.start < s.end - 0.01))) };
    const specs = lyricCaptionSpecs(input.sheet, 'karaoke');
    const late = specs.filter((sp) => sp.end > D + 0.01);
    if (late.length) issues.push({ sceneId: null, severity: 'error', message: `${late.length} caption line(s) run past the end of the audio.` });
  } else if (input.captions) {
    issues.push({ sceneId: null, severity: 'warning', message: 'No timed transcript yet: the advert has no captions.' });
  }
  return { state, issues };
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export interface AdReadinessInput {
  ad: AdSpec;
  sheet: LyricsSheet | null;
  scenes: { id: string; title: string; kind: AdSceneKind; start: number; end: number; hasMedia: boolean; validation: AdSceneValidationSummary | null; generating: boolean }[];
}

export interface AdReadinessItem {
  step: AdStep;
  severity: 'error' | 'warning';
  message: string;
}

/** What still blocks (errors) or deserves a look (warnings) before the advert can be rendered and exported. */
export function adReadiness({ ad, sheet, scenes }: AdReadinessInput): AdReadinessItem[] {
  const out: AdReadinessItem[] = [];
  const D = ad.audio.durationSec ?? (ad.mode === 'brief_first' ? ad.brief.durationSec : null);
  if (ad.mode === 'audio_first' && !ad.audio.assetId) out.push({ step: 'assets', severity: 'error', message: 'Upload the approved narration or soundtrack.' });
  if (ad.mode === 'audio_first' && ad.audio.assetId && !ad.audio.durationSec) out.push({ step: 'assets', severity: 'error', message: 'The audio duration has not been measured yet.' });
  if (D !== null && (D < AD_DURATION.min - 0.5 || D > AD_DURATION.max + 0.5)) out.push({ step: 'assets', severity: 'warning', message: `The advert lasts ${D.toFixed(1)} s — outside the ${AD_DURATION.min}–${AD_DURATION.max} s range.` });
  if (!sheet?.lines.length) out.push({ step: 'assets', severity: ad.captions.enabled ? 'error' : 'warning', message: 'There is no transcript, so no captions and no narration-aligned scenes.' });
  else if (sheet.timing.status === 'needs_review' && !ad.audio.transcriptApprovedAt) out.push({ step: 'assets', severity: 'warning', message: 'Some transcript lines need a listen before approval.' });
  if (sheet?.lines.length && !ad.audio.transcriptApprovedAt) out.push({ step: 'assets', severity: 'warning', message: 'Approve the transcript (captions use it exactly).' });
  if (!scenes.length) out.push({ step: 'storyboard', severity: 'error', message: 'Plan the storyboard.' });
  if (D !== null && scenes.length) for (const p of sceneWindowProblems(scenes, D)) out.push({ step: 'storyboard', severity: 'error', message: p });
  for (const s of scenes) {
    if (s.kind === 'typography' || s.kind === 'end_card') continue;
    if (s.generating) out.push({ step: 'generate', severity: 'warning', message: `“${s.title}” is still being generated.` });
    else if (!s.hasMedia) out.push({ step: isGeneratedScene(s.kind) ? 'generate' : 'storyboard', severity: 'error', message: `“${s.title}” has no picture yet.` });
    else if (isGeneratedScene(s.kind) && s.validation?.verdict === 'fail') out.push({ step: 'review', severity: 'error', message: `“${s.title}” failed validation (${s.validation.failed.join(', ') || 'see Review'}).` });
    else if (isGeneratedScene(s.kind) && !s.validation) out.push({ step: 'review', severity: 'warning', message: `“${s.title}” has not been validated yet.` });
  }
  if (scenes.some((s) => s.kind === 'end_card') && !ad.brand.logoAssetId) out.push({ step: 'assets', severity: 'warning', message: 'No logo file: the end card uses typography only.' });
  return out;
}

/**
 * Re-times one corrected caption line against the words heard between its neighbours (no model call); every
 * other line keeps its timing. When the new words cannot be matched, they are spread over the line's span.
 */
export function retimeEditedLine(sheet: LyricsSheet, lineId: string, text: string, asr: AsrWord[], durationSec: number): LyricsSheet {
  const idx = sheet.lines.findIndex((l) => l.id === lineId);
  if (idx < 0) return sheet;
  const line = sheet.lines[idx]!;
  const from = sheet.lines[idx - 1]?.end ?? 0;
  const to = sheet.lines[idx + 1]?.start ?? durationSec;
  const nearby = asr.filter((w) => w.start >= from - 0.05 && w.end <= to + 0.05);
  const tokens = tokenize(text);
  const heard = nearby.map((w) => ({ ...w, norm: tokenize(w.text)[0]?.norm ?? '' })).filter((w) => w.norm);
  const ops = alignWords(
    tokens.map((t) => t.norm),
    heard.map((h) => h.norm),
    { matchThreshold: 0.6, freeDetectedEnds: true },
  );
  const words: LyricWord[] = tokens.map((t) => ({ text: t.raw, start: null, end: null, confidence: 0, flag: 'unaligned' as WordFlag }));
  for (const op of ops) {
    if (op.op === 'match' || op.op === 'substitute') {
      const h = heard[op.d]!;
      words[op.e] = { text: tokens[op.e]!.raw, start: round3(h.start), end: round3(h.end), confidence: op.op === 'match' ? 0.9 : 0.5, flag: op.op === 'match' ? 'aligned' : 'uncertain' };
    }
  }
  const s0 = line.start ?? from;
  const e0 = line.end ?? Math.min(to, s0 + 2);
  // Unmatched words are interpolated between their timed neighbours (or across the old span).
  for (let i = 0; i < words.length; i++) {
    if (words[i]!.start !== null) continue;
    let j = i;
    while (j < words.length && words[j]!.start === null) j++;
    const left = i > 0 ? words[i - 1]!.end! : s0;
    const right = j < words.length ? words[j]!.start! : Math.max(left + 0.1, e0);
    const span = Math.max(0.05, right - left) / (j - i);
    for (let k = i; k < j; k++) words[k] = { ...words[k]!, start: round3(left + span * (k - i)), end: round3(left + span * (k - i + 0.9)), confidence: 0.3, flag: 'interpolated' };
    i = j - 1;
  }
  const start = words[0]?.start ?? s0;
  const end = words[words.length - 1]?.end ?? e0;
  const conf = words.reduce((s, w) => s + w.confidence, 0) / Math.max(1, words.length);
  const edited: LyricSheetLine = { ...line, text, words, start, end, confidence: round3(conf), flags: [...line.flags.filter((f) => f === 'manual_timing'), ...(conf < 0.55 ? (['low_confidence'] as const) : [])] };
  return { ...sheet, source: 'manual', status: 'draft', approvedAt: null, lines: sheet.lines.map((l, i) => (i === idx ? edited : l)), updatedAt: Date.now() };
}

/** Where a word-timed sheet is read for the scene editor: the transcript lines inside a window. */
export function linesInWindow(sheet: LyricsSheet | null, start: number, end: number): LyricSheetLine[] {
  if (!sheet) return [];
  return sheet.lines.filter((l) => l.start !== null && l.end !== null && (l.start + l.end) / 2 >= start && (l.start + l.end) / 2 < end);
}
