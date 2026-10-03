import { reconcileTranscript, sheetToLyricLines, tokenize, type JobDoc, type LyricsSheet, type SongDoc } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { transcribe } from '../lib/audio-models';
import { fail } from '../lib/errors';
import { col, FieldValue, gsUri } from '../lib/firebase';
import { logInteraction } from '../lib/interactions';
import { progress, transition } from '../lib/jobs';
import { recordUsage } from '../lib/usage';
import { saveRun } from './text';

export interface NarrationParams {
  songId: string;
  audioAssetId: string;
  storagePath: string;
  mimeType: string;
  durationSec: number;
  reference: string | null;
  protectedTerms: string[];
  languageCode: string | null;
}

/** Terms that bias recognition: the protected terms and the script's capitalised words (names, places). */
export function narrationVocabulary(reference: string | null, terms: string[]): string[] {
  const names = reference ? tokenize(reference).map((t) => t.raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')).filter((w) => /^\p{Lu}/u.test(w) && w.length > 2) : [];
  return [...new Set([...terms, ...terms.flatMap((t) => t.split(/\s+/)), ...names])].filter(Boolean).slice(0, 100);
}

/**
 * The narration's word-timed transcript. What the recording says is the authority; the approved script only
 * supplies spelling, punctuation and sentence structure where they agree. Never overwrites an approved
 * transcript (the new one is kept aside for comparison).
 */
export async function runNarrationTranscribeJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as NarrationParams;
  if (!job.projectId) fail('invalid_request', 'The narration transcript needs a project.');
  if (!(await transition(job.id, 'generating', { stage: 'Transcribing the narration with word timing', progress: 0.15, lease: { until: Date.now() + 15 * 60_000 } }))) return;
  const vocabulary = narrationVocabulary(p.reference, p.protectedTerms);
  const t = await transcribe({ fileUri: gsUri(p.storagePath), mimeType: p.mimeType, languageCode: p.languageCode ?? 'en', vocabulary });
  await recordUsage({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: t.modelId, kind: 'transcription', inputTokens: t.usage.input, outputTokens: t.usage.output, thoughtTokens: t.usage.thoughts });
  await logInteraction({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: t.modelId, api: 'generateContent', request: { task: 'transcribe_narration', durationSec: p.durationSec, vocabulary: vocabulary.length }, response: { words: t.words.length, languageCode: t.languageCode, usage: t.usage }, latencyMs: t.latencyMs });
  if (!t.words.length) fail('no_speech', 'No words were heard in this audio. Check that the file contains the narration.');

  await progress(job.id, p.reference ? 'Reconciling the transcript with the approved script' : 'Building captions from the transcript', 0.7);
  const words = t.words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
  const { sheet, report } = reconcileTranscript(words, p.reference, { durationSec: p.durationSec, protectedTerms: p.protectedTerms, languageCode: p.languageCode ?? t.languageCode ?? 'en', audioAssetId: p.audioAssetId });
  const songRef = col.songs(job.projectId!).doc(p.songId);
  const song = (await songRef.get()).data() as SongDoc | undefined;
  const keep = song?.lyricsSheet?.status === 'approved' && (song.lyricsSheet.lines.length ?? 0) > 0;
  const narration = { report, reference: p.reference ?? '', protectedTerms: p.protectedTerms, heardText: t.text.slice(0, 6000), transcribedAt: Date.now(), modelId: t.modelId, jobId: job.id };
  await songRef.set(
    {
      asr: { words, modelId: t.modelId, languageCode: t.languageCode ?? p.languageCode ?? null, audioAssetId: p.audioAssetId, createdAt: Date.now() },
      narration,
      instrumental: false,
      ...(keep ? { lyricsCandidate: sheet } : { lyricsSheet: sheet, lyrics: { source: 'ai', lines: sheetToLyricLines(sheet as LyricsSheet) } }),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  const runId = await saveRun(job, 'narration.transcribe', MODEL_REGISTRY.transcription.id, { report }, '');
  const terms = report.protectedTerms.map((pt) => `${pt.term} ${pt.found}/${pt.expected}`).join(', ');
  await transition(job.id, 'completed', {
    stage: `${sheet.lines.length} caption lines · ${Math.round(report.coverage * 100)}% of the script heard${report.corrected.length ? ` · ${report.corrected.length} spelling${report.corrected.length === 1 ? '' : 's'} corrected` : ''}${report.notDetected.filter((n) => !n.kept).length ? ` · ${report.notDetected.filter((n) => !n.kept).length} script word(s) not in the recording` : ''}${terms ? ` · ${terms}` : ''}${keep ? ' · kept your approved transcript' : ''}`,
    modelId: t.modelId,
    result: { aiRunId: runId, data: { lines: sheet.lines.length, coverage: report.coverage, corrected: report.corrected.length, keptExisting: keep } },
  });
}
