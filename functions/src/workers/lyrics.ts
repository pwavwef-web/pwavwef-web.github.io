import {
  alignLyrics,
  isWellSupportedLanguage,
  lyricId,
  needsLanguageVerification,
  languageName,
  sheetToLyricLines,
  tokenize,
  wordsOf,
  type AsrWord,
  type JobDoc,
  type LineAnchor,
  type LyricSheetLine,
  type LyricsSheet,
  type SongDoc,
} from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { transcribe, type TranscriptResult } from '../lib/audio-models';
import { col, FieldValue, gsUri } from '../lib/firebase';
import { fail } from '../lib/errors';
import { logInteraction } from '../lib/interactions';
import { progress, transition } from '../lib/jobs';
import { recordUsage } from '../lib/usage';
import { callReasoning, saveRun, usageFor } from './text';
import { LYRIC_ANCHORS_SCHEMA, VOCALS_SCHEMA } from './text-tasks';

export interface SongAudioParams {
  songId: string;
  audioAssetId: string;
  storagePath: string;
  mimeType: string;
  durationSec: number;
  languageCode: string | null;
}

/** Word-timed transcription of a song's vocals (usage recorded on the job). */
export async function transcribeSong(job: JobDoc, p: SongAudioParams, vocabulary: string[], countJob: boolean): Promise<TranscriptResult> {
  const r = await transcribe({ fileUri: gsUri(p.storagePath), mimeType: p.mimeType, languageCode: p.languageCode, vocabulary });
  await recordUsage({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: r.modelId, kind: 'transcription', inputTokens: r.usage.input, outputTokens: r.usage.output, thoughtTokens: r.usage.thoughts, countJob });
  await logInteraction({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: r.modelId, api: 'generateContent', request: { task: 'transcribe_song', durationSec: p.durationSec, languageHint: p.languageCode, vocabulary: vocabulary.length }, response: { words: r.words.length, languageCode: r.languageCode, usage: r.usage }, latencyMs: r.latencyMs });
  return r;
}

interface VocalsJson {
  vocalsPresent?: boolean;
  confidence?: number;
  languageCode?: string;
  note?: string;
  lines?: { start?: number; end?: number; text?: string; uncertainWords?: string[] }[];
}

/** Independent listening pass: are there vocals, and what is sung (line by line, with doubts marked)? */
async function reviewVocals(job: JobDoc, p: SongAudioParams): Promise<VocalsJson> {
  const r = await callReasoning(
    [
      { fileData: { fileUri: gsUri(p.storagePath), mimeType: p.mimeType } },
      {
        text:
          `Listen to this song (${Math.round(p.durationSec)} s). Decide whether it contains sung or rapped vocals. If it does, write down what is sung, line by line, with start and end times in seconds, ` +
          `in the language actually sung (${p.languageCode ? `expected: ${languageName(p.languageCode)}` : 'detect it'}). Keep the original language and its spelling; never translate. ` +
          'List in uncertainWords every word you are not sure about. If there are no vocals, return vocalsPresent false and no lines.',
      },
    ],
    { systemInstruction: 'You are a meticulous lyric transcriber. Return only JSON matching the schema.', responseJsonSchema: VOCALS_SCHEMA, audioTimestamp: true },
    'MEDIUM',
  );
  await usageFor(job, r, 'audio', false);
  return r.json as VocalsJson;
}

/**
 * Line anchors for exact lyrics: the model hears where each numbered line is sung and returns only
 * indices and times — it never returns lyric text, so the creator's wording cannot be altered.
 */
async function anchorLines(job: JobDoc, p: SongAudioParams, lines: LyricSheetLine[], language: string | null): Promise<LineAnchor[]> {
  const numbered = lines.map((l, i) => `${i}: ${l.text}`).join('\n');
  const r = await callReasoning(
    [
      { fileData: { fileUri: gsUri(p.storagePath), mimeType: p.mimeType } },
      {
        text:
          `These are the exact lyrics of this song${language ? ` (${languageName(language)})` : ''}, one numbered line each. For every line index, give when that line starts and ends being sung, in seconds. ` +
          'Lines may repeat (choruses): each numbered line is one occurrence, in order. If a line is not sung, set sung to false. Return indices and times only.\n\n' +
          numbered,
      },
    ],
    { systemInstruction: 'You align lyrics to audio precisely. Return only JSON matching the schema.', responseJsonSchema: LYRIC_ANCHORS_SCHEMA, audioTimestamp: true },
    'MEDIUM',
  );
  await usageFor(job, r, 'audio', false);
  const out = ((r.json as { lines?: { lineIndex?: number; start?: number; end?: number; confidence?: number; sung?: boolean }[] }).lines ?? [])
    .filter((a) => a.sung !== false && Number.isInteger(a.lineIndex) && a.lineIndex! >= 0 && a.lineIndex! < lines.length && Number(a.end) > Number(a.start))
    .map((a) => ({ lineIndex: a.lineIndex!, start: Math.max(0, Number(a.start)), end: Math.min(p.durationSec || Number(a.end), Number(a.end)), confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0.5)) }));
  return out;
}

/** Guards the core invariant before any lyric sheet is saved. */
function assertTextUnchanged(before: LyricsSheet, after: LyricsSheet): void {
  if (before.lines.length !== after.lines.length || before.lines.some((l, i) => l.text !== after.lines[i]!.text)) {
    fail('internal', 'Lyric alignment tried to change the lyric text; nothing was saved.');
  }
}

function lyricVocabulary(sheet: LyricsSheet): string[] {
  const words = sheet.lines.flatMap((l) => tokenize(l.text).map((t) => t.raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')));
  return [...new Set(words.filter((w) => w.length > 2))].slice(0, 500);
}

/** Aligns a sheet to the song (transcription + a second listening pass when needed) and saves it. */
export async function alignAndSave(job: JobDoc, p: SongAudioParams, sheet: LyricsSheet, opts: { cachedWords: AsrWord[] | null; countFirstUsage: boolean }): Promise<{ sheet: LyricsSheet; words: AsrWord[]; stats: ReturnType<typeof alignLyrics>['stats']; anchored: boolean; modelId: string; languageCode: string | null }> {
  let words = opts.cachedWords;
  let languageCode = sheet.language ?? p.languageCode;
  let modelId: string = MODEL_REGISTRY.transcription.id;
  if (!words) {
    await progress(job.id, 'Transcribing the vocals with word timing', 0.25);
    const t = await transcribeSong(job, { ...p, languageCode }, lyricVocabulary(sheet), opts.countFirstUsage);
    words = t.words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
    languageCode = languageCode ?? t.languageCode;
    modelId = t.modelId;
  }
  await progress(job.id, 'Aligning your lyrics to the vocals', 0.55);
  const improveGiven = sheet.lines.some((l) => l.flags.includes('given_timing'));
  let result = alignLyrics(sheet, words, { durationSec: p.durationSec, improveGiven, audioAssetId: p.audioAssetId, method: 'word_timed_transcript' });
  let anchored = false;
  const weak = result.stats.coverage < 0.6 || result.stats.unaligned > 0 || result.stats.lowConfidence > 0 || !isWellSupportedLanguage(languageCode);
  if (weak && sheet.lines.length) {
    await progress(job.id, 'Listening again for lines the transcript could not place', 0.7);
    const anchors = await anchorLines(job, p, sheet.lines, languageCode);
    result = alignLyrics(sheet, words, { durationSec: p.durationSec, improveGiven, audioAssetId: p.audioAssetId, anchors, method: 'word_timed_transcript+line_anchors' });
    anchored = true;
  }
  assertTextUnchanged(sheet, result.sheet);
  return { sheet: result.sheet, words, stats: result.stats, anchored, modelId, languageCode };
}

async function saveSong(projectId: string, songId: string, patch: Record<string, unknown>): Promise<void> {
  await col.songs(projectId).doc(songId).set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

/** Extract lyrics from an uploaded song: vocal detection, word-timed draft, uncertain words flagged. */
export async function runLyricsTranscribeJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as SongAudioParams;
  if (!job.projectId) fail('invalid_request', 'Lyrics extraction needs a project.');
  if (!(await transition(job.id, 'generating', { stage: 'Transcribing the vocals', progress: 0.1, lease: { until: Date.now() + 25 * 60_000 } }))) return;
  const songRef = col.songs(job.projectId!).doc(p.songId);
  const song = { id: p.songId, ...(await songRef.get()).data() } as SongDoc;
  const t = await transcribeSong(job, p, [], true);
  await progress(job.id, 'Checking for vocals and uncertain words', 0.45);
  const review = await reviewVocals(job, p);
  const words: AsrWord[] = t.words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
  const vocalsPresent = Boolean(review.vocalsPresent) || words.length >= 8;
  const languageCode = p.languageCode ?? (t.languageCode && t.languageCode !== 'und' ? t.languageCode : review.languageCode && review.languageCode !== 'und' ? review.languageCode : null);
  const asr = { words, modelId: t.modelId, languageCode, audioAssetId: p.audioAssetId, createdAt: Date.now() };
  const vocals = { present: vocalsPresent, confidence: Math.max(0, Math.min(1, Number(review.confidence) || (vocalsPresent ? 0.7 : 0.6))), checkedAt: Date.now(), note: String(review.note ?? '').slice(0, 300) };
  if (!vocalsPresent) {
    await saveSong(job.projectId!, p.songId, { asr, vocals });
    const runId = await saveRun(job, 'lyrics.transcribe', MODEL_REGISTRY.reasoning.id, { vocalsPresent: false }, '');
    await transition(job.id, 'completed', { stage: 'No vocals detected — this sounds instrumental, so no lyrics were created', result: { aiRunId: runId, data: { vocalsPresent: false } } });
    return;
  }

  // Draft text: the listening pass's line breaks (words as heard), else the transcript grouped at pauses.
  const reviewLines = (review.lines ?? []).map((l) => ({ text: String(l.text ?? '').trim(), start: Number(l.start), end: Number(l.end), uncertain: (l.uncertainWords ?? []).map((w) => String(w).toLowerCase()) })).filter((l) => l.text);
  let draftLines: { text: string; uncertain: string[] }[] = reviewLines.map((l) => ({ text: l.text, uncertain: l.uncertain }));
  if (!draftLines.length) {
    const groups: AsrWord[][] = [];
    for (const w of words) {
      const cur = groups[groups.length - 1];
      if (!cur || w.start - cur[cur.length - 1]!.end > 0.6 || cur.length >= 10) groups.push([w]);
      else cur.push(w);
    }
    draftLines = groups.map((g) => ({ text: g.map((w) => w.text).join(' '), uncertain: [] }));
  }
  const draft: LyricsSheet = {
    version: 1,
    source: 'transcribed',
    status: 'draft',
    approvedAt: null,
    language: languageCode,
    languageName: languageName(languageCode),
    requiresLanguageVerification: needsLanguageVerification(languageCode, 'transcribed'),
    languageVerifiedAt: null,
    instrumental: false,
    sections: [],
    lines: draftLines.map((l) => ({ id: lyricId(), text: l.text, sectionId: null, start: null, end: null, words: wordsOf(l.text), confidence: 0, flags: [] })),
    timing: { status: 'none', method: null, audioAssetId: p.audioAssetId, alignedAt: null, lowConfidenceLineIds: [], unalignedLineIds: [], adjustments: 0, notes: [] },
    updatedAt: Date.now(),
  };
  const aligned = alignLyrics(draft, words, { durationSec: p.durationSec, audioAssetId: p.audioAssetId, method: 'word_timed_transcript' });
  // Mark words the listening pass was unsure of, and every word where the two passes disagree.
  aligned.sheet.lines.forEach((l, i) => {
    const doubts = draftLines[i]?.uncertain ?? [];
    for (const w of l.words) if (doubts.includes(w.text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ''))) w.flag = 'uncertain';
    if (l.words.some((w) => w.flag === 'uncertain') && !l.flags.includes('uncertain_words')) l.flags.push('uncertain_words');
  });
  const sheet = aligned.sheet;
  const existing = song.lyricsSheet;
  const keepExisting = existing && (existing.status === 'approved' || existing.source === 'uploaded' || existing.source === 'manual') && existing.lines.length > 0;
  await saveSong(job.projectId!, p.songId, {
    asr,
    vocals,
    ...(keepExisting ? { lyricsCandidate: sheet } : { lyricsSheet: sheet, lyrics: { source: 'ai', lines: sheetToLyricLines(sheet) }, instrumental: false }),
  });
  const uncertain = sheet.lines.reduce((s, l) => s + l.words.filter((w) => w.flag === 'uncertain').length, 0);
  const runId = await saveRun(job, 'lyrics.transcribe', t.modelId, { lines: sheet.lines.length, uncertainWords: uncertain, languageCode }, '');
  await transition(job.id, 'completed', {
    stage: keepExisting
      ? `Transcribed ${sheet.lines.length} lines — kept your approved lyrics; the draft is available for comparison`
      : `Draft lyrics: ${sheet.lines.length} lines, ${uncertain} uncertain word${uncertain === 1 ? '' : 's'} flagged${sheet.requiresLanguageVerification ? ' · needs language verification' : ''}`,
    modelId: t.modelId,
    result: { aiRunId: runId, data: { lines: sheet.lines.length, uncertainWords: uncertain, keptExisting: Boolean(keepExisting) } },
  });
}

/** Synchronise authoritative lyrics (uploaded, approved or corrected) with the vocals. */
export async function runLyricsAlignJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as SongAudioParams & { useCache: boolean };
  if (!job.projectId) fail('invalid_request', 'Lyric sync needs a project.');
  if (!(await transition(job.id, 'generating', { stage: 'Synchronising lyrics', progress: 0.1, lease: { until: Date.now() + 25 * 60_000 } }))) return;
  const songRef = col.songs(job.projectId!).doc(p.songId);
  const song = { id: p.songId, ...(await songRef.get()).data() } as SongDoc;
  const sheet = song.lyricsSheet;
  if (!sheet?.lines.length) fail('invalid_request', 'There are no lyrics to synchronise.');
  const cached = p.useCache && song.asr?.audioAssetId === p.audioAssetId ? song.asr.words : null;
  const out = await alignAndSave(job, p, sheet!, { cachedWords: cached, countFirstUsage: true });
  // Re-read so edits made while the job ran are not overwritten with a stale text.
  const latest = ((await songRef.get()).get('lyricsSheet') as LyricsSheet | undefined) ?? sheet!;
  if (latest.lines.map((l) => l.text).join('\n') !== sheet!.lines.map((l) => l.text).join('\n')) {
    await saveSong(job.projectId!, p.songId, { asr: { words: out.words, modelId: out.modelId, languageCode: out.languageCode, audioAssetId: p.audioAssetId, createdAt: Date.now() } });
    await transition(job.id, 'completed', { stage: 'The lyrics were edited while syncing — resync again to use the new wording', result: { data: { stale: true } } });
    return;
  }
  await saveSong(job.projectId!, p.songId, {
    lyricsSheet: out.sheet,
    lyrics: { source: sheet!.source === 'uploaded' ? 'upload' : sheet!.source === 'manual' ? 'manual' : 'ai', lines: sheetToLyricLines(out.sheet) },
    ...(cached ? {} : { asr: { words: out.words, modelId: out.modelId, languageCode: out.languageCode, audioAssetId: p.audioAssetId, createdAt: Date.now() } }),
  });
  const s = out.stats;
  await transition(job.id, 'completed', {
    stage: `Synced ${sheet!.lines.length} lines · ${Math.round(s.coverage * 100)}% of words matched the vocals${s.lowConfidence + s.unaligned ? ` · ${s.lowConfidence + s.unaligned} line(s) to check` : ''}${s.adjusted ? ` · ${s.adjusted} time(s) corrected` : ''}`,
    result: { data: { ...s, anchored: out.anchored } },
  });
}
