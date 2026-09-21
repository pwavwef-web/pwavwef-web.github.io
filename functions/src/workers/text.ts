import type { GenerateContentConfig, GenerateContentResponse, Part } from '@google/genai';
import { ThinkingLevel } from '@google/genai';
import { SECTION_LABELS, type JobDoc, type LyricLine, type SectionLabel, type SongSection, type TextTask } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { col, FieldValue, gsUri } from '../lib/firebase';
import { fail, isSafetyMessage, toJobError } from '../lib/errors';
import { logInteraction } from '../lib/interactions';
import { transition } from '../lib/jobs';
import { recordUsage } from '../lib/usage';
import { genai } from '../lib/vertex';
import { SONG_ANALYSIS_SCHEMA, TEXT_TASK_SPECS } from './text-tasks';

interface ReasoningResult {
  json: unknown;
  text: string;
  modelId: string;
  usedFallback: boolean;
  res: GenerateContentResponse;
  latencyMs: number;
}

/**
 * Calls the reasoning model with structured output. Falls back to the registry's fallback model
 * only when the primary model is not found (retired preview); the fallback is recorded on the job.
 */
async function callReasoning(parts: Part[], config: GenerateContentConfig, thinking: 'LOW' | 'MEDIUM' | 'HIGH'): Promise<ReasoningResult> {
  const primary = MODEL_REGISTRY.reasoning.id;
  const fallback = MODEL_REGISTRY.reasoning.fallbackId;
  const started = Date.now();
  const attempt = async (model: string, useLevel: boolean) =>
    genai().models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: { ...config, responseMimeType: 'application/json', maxOutputTokens: 65536, ...(useLevel ? { thinkingConfig: { thinkingLevel: ThinkingLevel[thinking] } } : {}) },
    });
  let res: GenerateContentResponse;
  let modelId: string = primary;
  let usedFallback = false;
  try {
    res = await attempt(primary, true);
  } catch (e) {
    const err = toJobError(e);
    if (err.code !== 'not_found' || !fallback) throw e;
    modelId = fallback;
    usedFallback = true;
    res = await attempt(fallback, false);
  }
  const latencyMs = Date.now() - started;
  const block = res.promptFeedback?.blockReason;
  if (block) fail('safety_blocked', `Google’s safety filters blocked this request (${block}).`, { safety: true });
  const cand = res.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
  const reason = String(cand?.finishReason ?? '');
  if (!text) {
    if (isSafetyMessage(reason)) fail('safety_blocked', 'Google’s safety filters stopped this response. Rephrase the request.', { safety: true, details: reason });
    fail('empty_output', `The model returned no answer (${reason || 'no reason given'}).`);
  }
  if (reason === 'MAX_TOKENS') fail('too_long', 'The answer hit the model’s output limit. Ask for a smaller portion (for example one sequence at a time).');
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    fail('invalid_output', 'The model returned malformed structured output. Try again.', { details: text.slice(0, 400) });
  }
  return { json, text, modelId, usedFallback, res, latencyMs };
}

/** AI results are persisted so they survive refreshes: per project, or in the owner's top-level `aiRuns`. */
async function saveRun(job: JobDoc, task: string, modelId: string, output: unknown, text: string): Promise<string> {
  const ref = job.projectId ? col.projects().doc(job.projectId).collection('aiRuns').doc() : col.aiRuns().doc();
  await ref.set({ ownerUid: job.ownerUid, task, jobId: job.id, status: 'completed', modelId, output, outputText: text.length < 200_000 ? text : null, createdAt: FieldValue.serverTimestamp() });
  return ref.id;
}

async function usageFor(job: JobDoc, r: ReasoningResult, kind: 'text' | 'audio') {
  const u = r.res.usageMetadata;
  return recordUsage({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: r.modelId, kind, inputTokens: u?.promptTokenCount ?? 0, outputTokens: u?.candidatesTokenCount ?? 0, thoughtTokens: u?.thoughtsTokenCount ?? 0 });
}

export async function runTextJob(job: JobDoc): Promise<void> {
  const { task, input } = job.params as { task: TextTask; input: Record<string, unknown> };
  const spec = TEXT_TASK_SPECS[task];
  if (!(await transition(job.id, 'generating', { stage: `${MODEL_REGISTRY.reasoning.displayName} is writing`, progress: 0.2, lease: { until: Date.now() + 9 * 60_000 } }))) return;
  const r = await callReasoning([{ text: spec.prompt(input) }], { systemInstruction: spec.system, responseJsonSchema: spec.schema }, spec.thinking);
  const runId = await saveRun(job, task, r.modelId, r.json, r.text);
  const cost = await usageFor(job, r, 'text');
  await logInteraction({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: r.modelId, api: 'generateContent', request: { task, inputChars: JSON.stringify(input).length }, response: { finishReason: r.res.candidates?.[0]?.finishReason ?? null, usage: r.res.usageMetadata ?? null, usedFallback: r.usedFallback, costUsd: cost }, latencyMs: r.latencyMs });
  await transition(job.id, 'completed', {
    stage: r.usedFallback ? `Done (answered by fallback ${r.modelId})` : 'Done',
    modelId: r.modelId,
    result: { aiRunId: runId },
  });
}

// ---------------------------------------------------------------------------
// Song analysis
// ---------------------------------------------------------------------------

interface SongAnalysisJson {
  summary?: string;
  genre?: string;
  mood?: string;
  instrumentation?: string;
  tempoFeel?: string;
  sections?: { label?: string; name?: string; start?: number; end?: number }[];
  lyrics?: { start?: number; end?: number; text?: string }[];
}

export function normaliseSongAnalysis(json: SongAnalysisJson, durationSec: number): { sections: SongSection[]; lyrics: LyricLine[] } {
  const clampT = (t: unknown) => Math.max(0, Math.min(durationSec || Number.MAX_SAFE_INTEGER, Number(t) || 0));
  const sections = (json.sections ?? [])
    .map((s, i) => ({
      id: `ai_${i}`,
      label: (SECTION_LABELS as readonly string[]).includes(String(s.label)) ? (s.label as SectionLabel) : ('other' as SectionLabel),
      name: String(s.name ?? s.label ?? `Section ${i + 1}`).slice(0, 60),
      start: Math.round(clampT(s.start) * 1000) / 1000,
      end: Math.round(clampT(s.end) * 1000) / 1000,
      energy: 0,
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const lyrics = (json.lyrics ?? [])
    .map((l, i) => ({ id: `ly_${i}`, start: Math.round(clampT(l.start) * 1000) / 1000, end: Math.round(clampT(l.end) * 1000) / 1000, text: String(l.text ?? '').trim().slice(0, 300) }))
    .filter((l) => l.text && l.end > l.start)
    .sort((a, b) => a.start - b.start);
  return { sections, lyrics };
}

export async function runAudioJob(job: JobDoc): Promise<void> {
  const p = job.params as { songId: string; audioAssetId: string; storagePath: string; mimeType: string; durationSec: number; transcribeLyrics: boolean };
  if (!job.projectId) fail('invalid_request', 'Song analysis needs a project.');
  if (!(await transition(job.id, 'generating', { stage: `${MODEL_REGISTRY.reasoning.displayName} is listening to the song`, progress: 0.2, lease: { until: Date.now() + 9 * 60_000 } }))) return;
  const prompt =
    `Analyse this song for a music video director. Duration: ${Math.round(p.durationSec)} seconds. ` +
    'Identify the song structure with precise start/end times in seconds (intro, verses, pre-choruses, choruses, bridge, breakdowns, outro), the genre, mood, instrumentation and tempo feel. ' +
    (p.transcribeLyrics ? 'Transcribe the sung lyrics line by line with start/end times in seconds; keep the original language; mark unclear words with [?]. ' : 'Do not transcribe lyrics; return an empty lyrics array. ') +
    'Times must be within the song duration and sections must not overlap.';
  const r = await callReasoning(
    [{ fileData: { fileUri: gsUri(p.storagePath), mimeType: p.mimeType } }, { text: prompt }],
    { systemInstruction: 'You are a professional music analyst and transcriber. Return only JSON matching the schema.', responseJsonSchema: SONG_ANALYSIS_SCHEMA, audioTimestamp: true },
    'MEDIUM',
  );
  const json = r.json as SongAnalysisJson;
  const { sections, lyrics } = normaliseSongAnalysis(json, p.durationSec);
  const songRef = col.projects().doc(job.projectId!).collection('songs').doc(p.songId);
  const song = await songRef.get();
  const patch: Record<string, unknown> = {
    ai: { summary: json.summary ?? '', genre: json.genre ?? '', mood: json.mood ?? '', instrumentation: json.instrumentation ?? '', tempoFeel: json.tempoFeel ?? '' },
    aiSections: sections,
    updatedAt: FieldValue.serverTimestamp(),
  };
  // Never overwrite lyrics the owner uploaded or edited.
  const existing = song.get('lyrics') as { source?: string; lines?: unknown[] } | null | undefined;
  if (p.transcribeLyrics && lyrics.length && (!existing || !existing.lines?.length || existing.source === 'ai')) patch.lyrics = { source: 'ai', lines: lyrics };
  await songRef.set(patch, { merge: true });
  const runId = await saveRun(job, 'audio.analyze', r.modelId, json, r.text);
  const cost = await usageFor(job, r, 'audio');
  await logInteraction({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: r.modelId, api: 'generateContent', request: { task: 'song_analysis', durationSec: p.durationSec, transcribe: p.transcribeLyrics }, response: { sections: sections.length, lyrics: lyrics.length, usage: r.res.usageMetadata ?? null, costUsd: cost }, latencyMs: r.latencyMs });
  await transition(job.id, 'completed', { stage: `Found ${sections.length} sections${p.transcribeLyrics ? ` and ${lyrics.length} lyric lines` : ''}`, modelId: r.modelId, result: { aiRunId: runId } });
}
