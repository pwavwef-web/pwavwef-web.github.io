import type { GenerateContentResponse, Part } from '@google/genai';
import { Modality } from '@google/genai';
import { applySpeechRespellings, checkTakeLength, guardSpeech, parseOffset, transcriptionVocabulary, type DetectedWord, type SpeechGuardRecord } from '@az-studio/shared';
import { MODEL_REGISTRY, SPEECH_VOICES, TRANSCRIPTION_CAPABILITIES, TRANSCRIPTION_LANGUAGE_HINTS } from '../config/models';
import { fail, GenerationFailure, providerFailure } from './errors';
import { classifyBlockedResponse } from './provider-errors';
import { pcm16ToFloat, pcm16ToWav, speechBounds } from './signal';
import { genai } from './vertex';

// ---------------------------------------------------------------------------
// Transcription with word timestamps (dialogue validation, lyric sync)
// ---------------------------------------------------------------------------

export interface TranscriptResult {
  text: string;
  words: DetectedWord[];
  languageCode: string | null;
  modelId: string;
  usage: { input: number; output: number; thoughts: number };
  latencyMs: number;
}

export interface TranscribeInput {
  /** Inline audio (short clips) … */
  data?: Buffer;
  /** … or a gs:// URI inside the studio bucket (songs). */
  fileUri?: string;
  mimeType: string;
  languageCode?: string | null;
  /** Terms to bias recognition toward (character names, lyric words). */
  vocabulary?: string[];
}

/** Leave a minute of room under Google's 15-minute word-timestamp limit for duration rounding. */
export function timedAudioSegments(durationSec: number): { startSec: number; durationSec: number }[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const step = TRANSCRIPTION_CAPABILITIES.maxTimedAudioSeconds - 60;
  const segments: { startSec: number; durationSec: number }[] = [];
  for (let startSec = 0; startSec < durationSec; startSec += step) {
    segments.push({ startSec, durationSec: Math.min(step, durationSec - startSec) });
  }
  return segments;
}

/** Only hint languages the model handles reliably; everything else is auto-detected. */
export function transcriptionLanguageHint(code: string | null | undefined): string[] | undefined {
  const base = code?.toLowerCase().split('-')[0];
  return base && TRANSCRIPTION_LANGUAGE_HINTS.has(base) ? [base] : undefined;
}

export function parseTranscription(res: GenerateContentResponse): Omit<TranscriptResult, 'modelId' | 'latencyMs'> {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  const words: DetectedWord[] = [];
  const texts: string[] = [];
  let languageCode: string | null = null;
  for (const p of parts) {
    const t = p.audioTranscription;
    if (!t) continue;
    if (t.text) texts.push(t.text);
    languageCode = languageCode ?? t.languageCode ?? null;
    for (const w of t.words ?? []) {
      const text = (w.word ?? '').trim();
      if (!text) continue;
      words.push({ text, start: parseOffset(w.startOffset), end: parseOffset(w.endOffset), speaker: t.speakerLabel ?? null });
    }
  }
  if (!texts.length) texts.push(...parts.filter((p) => p.text && !p.thought).map((p) => p.text!.trim()));
  const u = res.usageMetadata;
  return { text: texts.join(' ').trim(), words: words.sort((a, b) => a.start - b.start), languageCode, usage: { input: u?.promptTokenCount ?? 0, output: u?.candidatesTokenCount ?? 0, thoughts: u?.thoughtsTokenCount ?? 0 } };
}

export async function transcribe(input: TranscribeInput): Promise<TranscriptResult> {
  const part: Part = input.data ? { inlineData: { data: input.data.toString('base64'), mimeType: input.mimeType } } : { fileData: { fileUri: input.fileUri!, mimeType: input.mimeType } };
  const languageCodes = transcriptionLanguageHint(input.languageCode);
  // The shared protected words (names, brands, places) bias every transcription, with the caller's terms after them.
  const vocabulary = transcriptionVocabulary([...new Set((input.vocabulary ?? []).map((v) => v.trim()).filter((v) => v.length > 1))], 500);
  const started = Date.now();
  const ctx = { modelId: MODEL_REGISTRY.transcription.id, what: 'transcript', surface: 'vertex' as const };
  let res: GenerateContentResponse;
  try {
    res = await genai().models.generateContent({
      model: MODEL_REGISTRY.transcription.id,
      contents: [{ role: 'user', parts: [part] }],
      config: { audioTranscriptionConfig: { wordTimestamp: true, ...(languageCodes ? { languageCodes } : {}), ...(vocabulary.length ? { customVocabulary: vocabulary } : {}) } },
    });
  } catch (e) {
    throw providerFailure(e, ctx);
  }
  const block = res.promptFeedback?.blockReason;
  if (block) throw new GenerationFailure(classifyBlockedResponse({ blockReason: String(block), blockMessage: res.promptFeedback?.blockReasonMessage ?? null }, ctx));
  return { ...parseTranscription(res), modelId: MODEL_REGISTRY.transcription.id, latencyMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Dialogue guide audio (TTS)
// ---------------------------------------------------------------------------

const FEMALE = ['Kore', 'Aoede', 'Leda', 'Zephyr', 'Despina', 'Sulafat', 'Gacrux'];
const MALE = ['Charon', 'Puck', 'Fenrir', 'Orus', 'Algieba', 'Schedar', 'Umbriel', 'Rasalgethi', 'Achird'];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
}

/** A stable prebuilt voice for a character, chosen from their voice/appearance description. */
export function voiceFor(character: string, description = ''): string {
  const d = ` ${description.toLowerCase()} `;
  const female = /\b(woman|women|girl|female|she|her|mother|grandmother|queen|lady|sister|aunt|daughter)\b/.test(d);
  const male = /\b(man|men|boy|male|he|his|father|grandfather|king|brother|uncle|son)\b/.test(d);
  const pool = female && !male ? FEMALE : male && !female ? MALE : SPEECH_VOICES;
  return pool[hash(character.trim().toUpperCase()) % pool.length]!;
}

export interface SpokenLine {
  wav: Buffer;
  fileSeconds: number;
  /** Speech only (leading/trailing silence removed). */
  speech: { start: number; end: number; durationSec: number } | null;
  /** Tokens of every take requested (a re-take is billed too). */
  usage: { input: number; output: number };
  /** What the guard changed in the text and direction, the length check of the take kept, and whether it was re-taken. */
  guard: SpeechGuardRecord;
}

export interface SpeakOptions {
  /** One automatic re-take (without the direction) when the measured length is implausible. Default true. */
  retake?: boolean;
  /** Apply the shared speech respellings (letter-by-letter acronyms). Default true. */
  respell?: boolean;
}

interface Take {
  wav: Buffer;
  fileSeconds: number;
  speech: SpokenLine['speech'];
  usage: { input: number; output: number };
}

async function speakOnce(prompt: string, voice: string): Promise<Take> {
  const ctx = { modelId: MODEL_REGISTRY.speech.id, what: 'dialogue audio', surface: 'vertex' as const };
  let res: GenerateContentResponse;
  try {
    res = await genai().models.generateContent({
      model: MODEL_REGISTRY.speech.id,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { responseModalities: [Modality.AUDIO], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    });
  } catch (e) {
    throw providerFailure(e, ctx);
  }
  const block = res.promptFeedback?.blockReason;
  if (block) throw new GenerationFailure(classifyBlockedResponse({ blockReason: String(block), blockMessage: res.promptFeedback?.blockReasonMessage ?? null }, ctx));
  const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) {
    const reason = res.candidates?.[0]?.finishReason;
    if (reason && reason !== 'STOP') throw new GenerationFailure(classifyBlockedResponse({ finishReason: String(reason), finishMessage: res.candidates?.[0]?.finishMessage ?? null }, ctx));
    fail('no_audio', `The speech model returned no audio (${reason ?? 'no reason given'}).`);
  }
  const mime = part!.inlineData!.mimeType ?? 'audio/L16;rate=24000';
  const rate = Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000);
  const pcm = Buffer.from(part!.inlineData!.data!, 'base64');
  const samples = pcm16ToFloat(pcm);
  const u = res.usageMetadata;
  return { wav: pcm16ToWav(pcm, rate), fileSeconds: +(samples.length / rate).toFixed(3), speech: speechBounds(samples, rate), usage: { input: u?.promptTokenCount ?? 0, output: u?.candidatesTokenCount ?? 0 } };
}

/**
 * Speaks one line with the guide voice. Every take goes through the speech guard: the text loses punctuation the
 * model reads as instructions (words unchanged), the direction is reduced to delivery, and the measured speech is
 * checked against the words. An implausible take (the voice read its direction, improvised or dropped half the
 * line) gets one automatic re-take without the direction; the more plausible of the two is kept.
 */
export async function speakLine(text: string, voice: string, direction: string, opts: SpeakOptions = {}): Promise<SpokenLine> {
  const plan = guardSpeech(opts.respell === false ? text : applySpeechRespellings(text), direction);
  const changes = opts.respell === false || applySpeechRespellings(text) === text ? plan.changes : ['applied speech respellings', ...plan.changes];
  const first = await speakOnce(plan.prompt, voice);
  let kept = first;
  let check = checkTakeLength(plan.text, first.speech?.durationSec ?? null);
  let takes = 1;
  const usage = { ...first.usage };
  if (check.verdict !== 'ok' && opts.retake !== false) {
    const second = await speakOnce(plan.text, voice);
    takes = 2;
    usage.input += second.usage.input;
    usage.output += second.usage.output;
    const again = checkTakeLength(plan.text, second.speech?.durationSec ?? null);
    const off = (c: typeof check) => (c.measuredSec === null ? Infinity : Math.abs(c.measuredSec - c.expectedSec));
    if (again.verdict === 'ok' || off(again) < off(check)) {
      kept = second;
      check = again;
    }
  }
  return {
    ...kept,
    usage,
    guard: {
      text: plan.text,
      direction: kept === first ? plan.direction : '',
      changes,
      flags: [...plan.flags, ...(check.verdict === 'ok' ? [] : [`implausible_length: ${check.note}${takes === 2 ? ' (after one automatic re-take)' : ''}`])],
      expectedSec: check.expectedSec,
      measuredSec: check.measuredSec,
      wordsPerSec: check.wordsPerSec,
      verdict: check.verdict,
      takes,
      retaken: takes === 2,
    },
  };
}
