import type { GenerateContentResponse, Part } from '@google/genai';
import { Modality } from '@google/genai';
import { parseOffset, type DetectedWord } from '@az-studio/shared';
import { MODEL_REGISTRY, SPEECH_VOICES, TRANSCRIPTION_LANGUAGE_HINTS } from '../config/models';
import { fail, isSafetyMessage } from './errors';
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
  const vocabulary = [...new Set((input.vocabulary ?? []).map((v) => v.trim()).filter((v) => v.length > 1))].slice(0, 500);
  const started = Date.now();
  const res = await genai().models.generateContent({
    model: MODEL_REGISTRY.transcription.id,
    contents: [{ role: 'user', parts: [part] }],
    config: { audioTranscriptionConfig: { wordTimestamp: true, ...(languageCodes ? { languageCodes } : {}), ...(vocabulary.length ? { customVocabulary: vocabulary } : {}) } },
  });
  const block = res.promptFeedback?.blockReason;
  if (block) fail('safety_blocked', `Google’s safety filters blocked the transcription (${block}).`, { safety: true });
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
  usage: { input: number; output: number };
}

export async function speakLine(text: string, voice: string, direction: string): Promise<SpokenLine> {
  const res = await genai().models.generateContent({
    model: MODEL_REGISTRY.speech.id,
    contents: [{ role: 'user', parts: [{ text: direction ? `${direction}: ${text}` : text }] }],
    config: { responseModalities: [Modality.AUDIO], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  });
  const block = res.promptFeedback?.blockReason;
  if (block) fail('safety_blocked', `Google’s safety filters blocked this line (${block}).`, { safety: true });
  const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) {
    const reason = String(res.candidates?.[0]?.finishReason ?? 'unknown');
    if (isSafetyMessage(reason)) fail('safety_blocked', 'Google’s safety filters stopped the dialogue audio.', { safety: true });
    fail('no_audio', `The speech model returned no audio (${reason}).`);
  }
  const mime = part!.inlineData!.mimeType ?? 'audio/L16;rate=24000';
  const rate = Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000);
  const pcm = Buffer.from(part!.inlineData!.data!, 'base64');
  const samples = pcm16ToFloat(pcm);
  const u = res.usageMetadata;
  return { wav: pcm16ToWav(pcm, rate), fileSeconds: +(samples.length / rate).toFixed(3), speech: speechBounds(samples, rate), usage: { input: u?.promptTokenCount ?? 0, output: u?.candidatesTokenCount ?? 0 } };
}
