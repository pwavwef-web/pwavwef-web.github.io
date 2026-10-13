import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { estimateNarrationSec, reconcileTranscript, sheetWords, splitWholeNarration, type JobDoc, type LiteWord, type StoredTake } from '@az-studio/shared';
import { MODEL_REGISTRY, TRANSCRIPTION_LANGUAGE_HINTS } from '../config/models';
import { speakLine, timedAudioSegments, transcribe } from '../lib/audio-models';
import { createAsset, withTmpDir } from '../lib/assets';
import { fail, JobFailure } from '../lib/errors';
import { bucket, col, gsUri } from '../lib/firebase';
import { logInteraction } from '../lib/interactions';
import { extractSpeechAudio } from '../lib/signal';
import { progress, transition } from '../lib/jobs';
import { mediaInputUrl } from '../lib/media-proxy';
import { recordUsage } from '../lib/usage';
import { readFile } from 'node:fs/promises';

interface LiteNarrationParams {
  mode: 'tts' | 'align_scene' | 'align_whole';
  sceneId: string | null;
  text: string;
  spokenText?: string;
  voice?: string | null;
  direction?: string;
  scenes?: { sceneId: string; text: string }[];
  audioAssetId?: string;
  storagePath?: string;
  mimeType?: string;
  durationSec?: number;
  languageCode: string | null;
  vocabulary: string[];
  inputHash: string;
}

interface SpokenAudio {
  assetId: string;
  storagePath: string;
  fileSeconds: number;
  speechStart: number | null;
  speechEnd: number | null;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const flat = (t: string) => t.replace(/\s+/g, ' ').trim();

/** Alignment quality notes the director sees next to a take (speech models can repeat or skip words). */
export function takeFlags(report: { coverage: number; heardWords: number; referenceWords: number; extra: { text: string }[] }, opts: { generated: boolean; speechSec: number; text: string; languageCode: string | null }): string[] {
  const flags: string[] = [];
  if (report.referenceWords && report.coverage < 0.9) flags.push(`missing_words: ${Math.round((1 - report.coverage) * 100)}% of the script was not heard`);
  if (report.referenceWords && report.heardWords > report.referenceWords * 1.15 + 2) flags.push(`extra_words: ${report.heardWords - report.referenceWords} more words heard than written${opts.generated ? ' — the voice may have repeated a phrase' : ''}`);
  const expected = estimateNarrationSec(opts.text, 140);
  if (opts.generated && expected > 3 && opts.speechSec > expected * 1.7) flags.push('unusually_long: the speech is much longer than the text suggests — listen for repeats or long hesitations');
  const base = opts.languageCode?.toLowerCase().split('-')[0];
  if (base && base !== 'en' && !TRANSCRIPTION_LANGUAGE_HINTS.has(base)) flags.push('approximate_timing: the transcription model has little support for this language — check subtitle timing by ear');
  return flags;
}

/**
 * Film Studio Lite narration. `tts`: one scene spoken by the speech model (saved immediately, so a retry
 * of the timing step never pays for the speech again), then its words timed from the real audio.
 * `align_scene` / `align_whole`: an uploaded recording timed against the script; a whole recording is
 * split into scenes at the silences between them. Subtitle spelling always comes from the script.
 */
export async function runLiteNarrationJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as LiteNarrationParams;
  if (!job.projectId) fail('invalid_request', 'Narration needs a project.');
  if (!(await transition(job.id, 'generating', { stage: p.mode === 'tts' ? 'Speaking the narration' : 'Listening to the recording', progress: 0.1, lease: { until: Date.now() + 25 * 60_000 } }))) return;
  const started = Date.now();
  const usage = { uid: job.ownerUid, projectId: job.projectId, jobId: job.id };
  const languageCode = p.languageCode ?? 'en';
  const takes: StoredTake[] = [];

  if (p.mode === 'tts') {
    let audio = (job.external as { liteAudio?: SpokenAudio } | null)?.liteAudio ?? null;
    if (!audio) {
      const spoken = await speakLine(p.spokenText || p.text, p.voice!, p.direction ?? '');
      await recordUsage({ ...usage, modelId: MODEL_REGISTRY.speech.id, kind: 'speech', inputTokens: spoken.usage.input, outputTokens: spoken.usage.output, thoughtTokens: 0 });
      const assetId = col.assets().doc().id;
      const storagePath = `users/${job.ownerUid}/generated/${job.id}/${assetId}.wav`;
      await withTmpDir(async (dir) => {
        const local = path.join(dir, 'narration.wav');
        await writeFile(local, spoken.wav);
        await bucket.upload(local, { destination: storagePath, resumable: false, metadata: { contentType: 'audio/wav', cacheControl: 'private, max-age=31536000' } });
        await createAsset({ uid: job.ownerUid, assetId, projectId: job.projectId, kind: 'audio', source: 'generated', title: `Narration — “${flat(p.text).slice(0, 60)}${p.text.length > 60 ? '…' : ''}”`, fileName: 'narration.wav', mimeType: 'audio/wav', storagePath, localFile: local, dir, collections: ['lite:narration'], generation: { jobId: job.id, modelId: MODEL_REGISTRY.speech.id, prompt: p.spokenText || p.text, params: { voice: p.voice, direction: p.direction, purpose: 'lite_narration', sceneId: p.sceneId } } });
      });
      audio = { assetId, storagePath, fileSeconds: spoken.fileSeconds, speechStart: spoken.speech?.start ?? null, speechEnd: spoken.speech?.end ?? null };
      await col.jobs().doc(job.id).set({ external: { ...(job.external ?? {}), liteAudio: audio } }, { merge: true });
    }
    await progress(job.id, 'Timing every word from the spoken audio', 0.6);
    let words: LiteWord[] = [];
    let coverage: number | null = null;
    let flags: string[];
    let alignment: 'aligned' | 'estimated' = 'aligned';
    try {
      const t = await transcribe({ fileUri: gsUri(audio.storagePath), mimeType: 'audio/wav', languageCode, vocabulary: p.vocabulary });
      await recordUsage({ ...usage, modelId: t.modelId, kind: 'transcription', inputTokens: t.usage.input, outputTokens: t.usage.output, thoughtTokens: t.usage.thoughts, countJob: false });
      const { sheet, report } = reconcileTranscript(t.words.map((w) => ({ text: w.text, start: w.start, end: w.end })), p.text, { durationSec: audio.fileSeconds, protectedTerms: p.vocabulary, languageCode, audioAssetId: audio.assetId, maxPhraseWords: 14, maxPhraseChars: 90 });
      words = sheetWords(sheet);
      coverage = r3(report.coverage);
      flags = takeFlags(report, { generated: true, speechSec: (audio.speechEnd ?? audio.fileSeconds) - (audio.speechStart ?? 0), text: p.text, languageCode });
      if (!words.length) alignment = 'estimated';
    } catch (e) {
      // The speech is already saved: keep it and say the timing is estimated (re-align later costs only a transcription).
      alignment = 'estimated';
      flags = [`alignment_unavailable: ${e instanceof JobFailure ? e.jobError.message : String((e as Error)?.message ?? e).slice(0, 200)}`];
    }
    const speechStart = audio.speechStart ?? words[0]?.start ?? 0;
    const speechEnd = audio.speechEnd ?? words[words.length - 1]?.end ?? audio.fileSeconds;
    takes.push({ sceneId: p.sceneId!, hash: p.inputHash, assetId: audio.assetId, inPoint: 0, outPoint: r3(audio.fileSeconds), speechStart: r3(Math.min(speechStart, words[0]?.start ?? speechStart)), speechEnd: r3(Math.max(speechEnd, words[words.length - 1]?.end ?? speechEnd)), words, alignment, coverage, flags, source: 'generated', voice: p.voice ?? null });
  } else {
    const D = p.durationSec ?? 0;
    const segments = timedAudioSegments(D);
    const heard: { text: string; start: number; end: number }[] = [];
    await withTmpDir(async (dir) => {
      for (const [i, seg] of segments.entries()) {
        await progress(job.id, segments.length > 1 ? `Transcribing part ${i + 1} of ${segments.length}` : 'Transcribing the recording with word timing', 0.15 + (0.6 * i) / segments.length);
        let t;
        if (segments.length === 1) t = await transcribe({ fileUri: gsUri(p.storagePath!), mimeType: p.mimeType!, languageCode, vocabulary: p.vocabulary });
        else {
          const flac = path.join(dir, `part-${i}.flac`);
          await extractSpeechAudio(await mediaInputUrl(p.storagePath!), flac, seg);
          t = await transcribe({ data: await readFile(flac), mimeType: 'audio/flac', languageCode, vocabulary: p.vocabulary });
        }
        await recordUsage({ ...usage, modelId: t.modelId, kind: 'transcription', inputTokens: t.usage.input, outputTokens: t.usage.output, thoughtTokens: t.usage.thoughts, countJob: i === 0 });
        heard.push(...t.words.map((w) => ({ text: w.text, start: w.start + seg.startSec, end: w.end + seg.startSec })));
      }
    });
    if (!heard.length) fail('no_speech', 'No words were heard in this recording. Check that it contains the narration.');
    await progress(job.id, 'Matching the recording to the script', 0.85);
    if (p.mode === 'align_scene') {
      const { sheet, report } = reconcileTranscript(heard, p.text, { durationSec: D, protectedTerms: p.vocabulary, languageCode, audioAssetId: p.audioAssetId, maxPhraseWords: 14, maxPhraseChars: 90 });
      const words = sheetWords(sheet);
      takes.push({ sceneId: p.sceneId!, hash: p.inputHash, assetId: p.audioAssetId!, inPoint: 0, outPoint: r3(D), speechStart: r3(words[0]?.start ?? report.speechStart ?? 0), speechEnd: r3(words[words.length - 1]?.end ?? report.speechEnd ?? D), words, alignment: words.length ? 'aligned' : 'estimated', coverage: r3(report.coverage), flags: takeFlags(report, { generated: false, speechSec: D, text: p.text, languageCode }), source: 'upload_scene', voice: null });
    } else {
      const scenes = (p.scenes ?? []).filter((s) => flat(s.text));
      const reference = scenes.map((s) => flat(s.text)).join('\n');
      const { sheet, report } = reconcileTranscript(heard, reference, { durationSec: D, protectedTerms: p.vocabulary, languageCode, audioAssetId: p.audioAssetId, maxPhraseWords: 14, maxPhraseChars: 90 });
      const parts = splitWholeNarration(sheet, scenes.map((s, i) => ({ sceneId: s.sceneId, paragraph: i })), D);
      const shared = takeFlags(report, { generated: false, speechSec: D, text: reference, languageCode });
      const missing = scenes.filter((s) => !parts.some((x) => x.sceneId === s.sceneId));
      for (const part of parts) takes.push({ ...part, hash: p.inputHash, assetId: p.audioAssetId!, alignment: 'aligned', coverage: r3(report.coverage), flags: shared, source: 'upload_whole', voice: null });
      if (missing.length) shared.push(`scenes_not_found: ${missing.length} scene(s) were not found in the recording`);
    }
  }

  await logInteraction({ ...usage, modelId: p.mode === 'tts' ? MODEL_REGISTRY.speech.id : MODEL_REGISTRY.transcription.id, api: 'generateContent', request: { task: `lite_narration_${p.mode}`, chars: p.text.length, scenes: p.scenes?.length ?? 1 }, response: { takes: takes.length, words: takes.reduce((s, t) => s + t.words.length, 0), flags: takes.flatMap((t) => t.flags).slice(0, 10) }, latencyMs: Date.now() - started });
  const speech = takes.reduce((s, t) => s + (t.speechEnd - t.speechStart), 0);
  const aligned = takes.every((t) => t.alignment === 'aligned');
  await transition(job.id, 'completed', {
    stage: `${takes.length === 1 ? 'Narration' : `${takes.length} scenes`} · ${speech.toFixed(1)} s of speech · ${aligned ? 'words timed from the audio' : 'timing estimated'}${takes.some((t) => t.flags.length) ? ' · check the notes' : ''}`,
    result: { assetIds: [...new Set(takes.map((t) => t.assetId))], data: { takes } },
  });
}
