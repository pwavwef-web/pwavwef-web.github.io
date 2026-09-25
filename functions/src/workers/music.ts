import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { analyzeMusic, needsLanguageVerification, languageName, parseLyricsText, sheetFromParsed, sheetToLyricLines, type JobDoc, type LyricsSheet, type MusicAnalysis, type ScoreDoc } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { PRICING } from '../config/pricing';
import { createAsset, withTmpDir } from '../lib/assets';
import { bucket, col, db, FieldValue } from '../lib/firebase';
import { JobFailure } from '../lib/errors';
import { logInteraction } from '../lib/interactions';
import { progress, transition } from '../lib/jobs';
import { generateMusic } from '../lib/music-model';
import { decodeMono, loudnessStats } from '../lib/signal';
import { recordUsage } from '../lib/usage';
import { alignAndSave } from './lyrics';
import { createMusicVersion } from './music-studio';

interface MusicParams {
  purpose: 'song' | 'score_movement';
  prompt: string;
  lyricsProvided: boolean;
  lyrics: string | null;
  instrumental: boolean;
  languageCode: string | null;
  images: { assetId: string; storagePath: string; mimeType: string }[];
  songId: string | null;
  scoreId: string | null;
  movementId: string | null;
  title: string | null;
  /** Music Studio: the generation becomes a new version of this music project. */
  musicProjectId?: string | null;
  mode?: string | null;
  alternate?: boolean;
}

const EXT: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac' };

async function setMovement(projectId: string, scoreId: string, movementId: string, patch: Record<string, unknown>): Promise<void> {
  const ref = col.scores(projectId).doc(scoreId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const score = snap.data() as ScoreDoc;
    tx.update(ref, { movements: score.movements.map((m) => (m.id === movementId ? { ...m, ...patch } : m)), updatedAt: FieldValue.serverTimestamp() });
  });
}

/**
 * Lyria 3.5: a song (audio + structure + lyrics, aligned to the real vocals) or one movement of a
 * film score. Fails fast with the exact limitation when the model is not served for the project.
 */
export async function runMusicJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as MusicParams;
  if (!job.projectId) throw new JobFailure({ code: 'invalid_request', message: 'Music generation needs a project.', retryable: false });
  if (!(await transition(job.id, 'generating', { stage: `${MODEL_REGISTRY.music.displayName} is composing`, progress: 0.1, lease: { until: Date.now() + 28 * 60_000 } }))) return;
  if (p.purpose === 'score_movement') await setMovement(job.projectId, p.scoreId!, p.movementId!, { status: 'generating', jobId: job.id, error: null });
  const started = Date.now();
  let result: Awaited<ReturnType<typeof generateMusic>>;
  try {
    result = await generateMusic({ prompt: p.prompt, imagePaths: p.images });
  } catch (e) {
    if (p.purpose === 'score_movement') await setMovement(job.projectId, p.scoreId!, p.movementId!, { status: 'failed', error: e instanceof JobFailure ? e.jobError.message : String((e as Error)?.message ?? e).slice(0, 300) });
    await logInteraction({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: MODEL_REGISTRY.music.id, api: 'interactions', request: { purpose: p.purpose, promptChars: p.prompt.length, images: p.images.length }, response: { error: String((e as Error)?.message ?? e).slice(0, 500) }, latencyMs: Date.now() - started });
    throw e;
  }
  await recordUsage({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: MODEL_REGISTRY.music.id, kind: 'music', inputTokens: result.usage?.input ?? 0, outputTokens: result.usage?.output ?? 0, thoughtTokens: 0, costUsdOverride: PRICING.music.perSongUsd });
  await transition(job.id, 'downloading', { stage: 'Saving the music', progress: 0.6 });
  const parsed = parseLyricsText(result.text, 'auto');
  const ext = EXT[result.mimeType] ?? 'mp3';
  const assetId = col.assets().doc().id;
  const storagePath = `users/${job.ownerUid}/generated/${job.id}/${assetId}.${ext}`;
  let durationSec = 0;
  let lufs: number | null = null;
  let truePeakDb: number | null = null;
  let analysis: MusicAnalysis | null = null;
  await withTmpDir(async (dir) => {
    const local = path.join(dir, `music.${ext}`);
    await writeFile(local, result.audio);
    await bucket.file(storagePath).save(result.audio, { contentType: result.mimeType, resumable: false, metadata: { cacheControl: 'private, max-age=31536000', metadata: { jobId: job.id, modelId: MODEL_REGISTRY.music.id } } });
    await createAsset({
      uid: job.ownerUid,
      assetId,
      projectId: job.projectId,
      kind: 'audio',
      source: 'generated',
      title: p.title ?? (p.purpose === 'song' ? 'Generated song' : 'Score movement'),
      fileName: `${assetId}.${ext}`,
      mimeType: result.mimeType,
      storagePath,
      localFile: local,
      dir,
      collections: [p.purpose === 'song' ? 'music' : 'score'],
      generation: { jobId: job.id, modelId: MODEL_REGISTRY.music.id, prompt: p.prompt, params: { purpose: p.purpose, instrumental: p.instrumental, languageCode: p.languageCode }, interactionId: result.interactionId },
    });
    durationSec = Number((await col.assets().doc(assetId).get()).get('durationSec') ?? 0);
    const loud = await loudnessStats(local);
    lufs = loud.integratedLufs;
    truePeakDb = loud.truePeakDb;
    // Music Studio versions are analysed straight away (beats, bars, key, energy, sections: DSP, no model call).
    if (p.musicProjectId) analysis = analyzeMusic(await decodeMono(local, 22050), 22050);
  });
  await logInteraction({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: MODEL_REGISTRY.music.id, api: 'interactions', interactionId: result.interactionId, request: { purpose: p.purpose, promptChars: p.prompt.length, images: p.images.length }, response: { assetId, durationSec, textChars: result.text.length, lines: parsed.lines.length, bpm: parsed.meta.bpm ?? null }, latencyMs: Date.now() - started });

  if (p.purpose === 'score_movement') {
    await setMovement(job.projectId, p.scoreId!, p.movementId!, { status: 'ready', assetId, durationSec, loudnessLufs: lufs, error: null });
    await transition(job.id, 'completed', { stage: `Movement ready · ${durationSec.toFixed(1)} s`, result: { assetIds: [assetId], interactionId: result.interactionId, text: result.text.slice(0, 2000) } });
    return;
  }

  // Song: store audio, structure and lyrics; the text becomes a draft (or the creator's lyrics stay authoritative).
  let sheet: LyricsSheet | null = null;
  if (!p.instrumental) {
    if (p.lyricsProvided && p.lyrics) {
      sheet = sheetFromParsed(parseLyricsText(p.lyrics, 'plain'), { source: 'manual', language: p.languageCode, status: 'approved' });
    } else if (parsed.lines.length) {
      sheet = sheetFromParsed(parsed, { source: 'lyria', language: p.languageCode, status: 'draft' });
      sheet.requiresLanguageVerification = needsLanguageVerification(p.languageCode, 'generated');
    }
  }
  const songPatch: Record<string, unknown> = {
    audioAssetId: assetId,
    durationSec,
    analysis: null,
    ai: parsed.meta.caption ? { summary: parsed.meta.caption.slice(0, 600) } : null,
    instrumental: p.instrumental,
    vocals: { present: !p.instrumental, confidence: 0.6, checkedAt: Date.now(), note: 'Generated song' },
    generation: { jobId: job.id, modelId: MODEL_REGISTRY.music.id, prompt: p.prompt.slice(0, 4000), caption: parsed.meta.caption ?? '', bpm: parsed.meta.bpm ?? null },
    lyricsSheet: sheet,
    lyrics: sheet ? { source: 'ai', lines: sheetToLyricLines(sheet) } : null,
    asr: null,
    range: null,
  };
  let songId = p.songId;
  if (!songId && p.musicProjectId) songId = ((await col.sub(job.projectId, 'musicProjects').doc(p.musicProjectId).get()).get('songId') as string | null) ?? null;
  const songRef = songId ? col.songs(job.projectId).doc(songId) : col.songs(job.projectId).doc();
  await songRef.set({ ...songPatch, ...(songId ? {} : { title: p.title ?? 'Generated song', artist: '', createdAt: FieldValue.serverTimestamp() }), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  let versionId: string | null = null;
  if (p.musicProjectId) {
    versionId = await createMusicVersion(job.projectId, {
      musicProjectId: p.musicProjectId,
      source: 'lyria',
      label: p.title ?? (p.instrumental ? 'Instrumental' : 'Song'),
      assetId,
      parentVersionId: null,
      jobId: job.id,
      prompt: p.prompt.slice(0, 12000),
      lyricsText: p.lyrics ?? null,
      modelId: MODEL_REGISTRY.music.id,
      method: `${MODEL_REGISTRY.music.displayName} generated the full piece (${result.surface === 'developer-api' ? 'Gemini Developer API' : 'Vertex AI'}), ${p.instrumental ? 'instrumental' : p.lyricsProvided ? 'singing the provided lyrics' : 'with lyrics it wrote'}.`,
      durationSec,
      loudness: { integratedLufs: lufs, truePeakDb },
      analysis,
      timeMap: null,
    });
    await col.sub(job.projectId, 'musicProjects').doc(p.musicProjectId).set({ songId: songRef.id, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  let syncNote = '';
  if (sheet?.lines.length) {
    // Retrieve real timing: align the lyrics to the generated vocals.
    await progress(job.id, 'Aligning the lyrics to the generated vocals', 0.75);
    const params = { songId: songRef.id, audioAssetId: assetId, storagePath, mimeType: result.mimeType, durationSec, languageCode: p.languageCode };
    const out = await alignAndSave(job, params, sheet, { cachedWords: null, countFirstUsage: false });
    await songRef.set({ lyricsSheet: out.sheet, lyrics: { source: 'ai', lines: sheetToLyricLines(out.sheet) }, asr: { words: out.words, modelId: out.modelId, languageCode: out.languageCode, audioAssetId: assetId, createdAt: Date.now() }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    syncNote = ` · lyrics synced (${Math.round(out.stats.coverage * 100)}% of words matched)`;
  }
  const lang = languageName(p.languageCode);
  await transition(job.id, 'completed', {
    stage: `Song ready · ${durationSec.toFixed(0)} s${parsed.meta.bpm ? ` · ${parsed.meta.bpm} BPM` : ''}${lang && !p.instrumental ? ` · ${lang}` : ''}${syncNote}`,
    result: { assetIds: [assetId], interactionId: result.interactionId, text: result.text.slice(0, 2000), data: { songId: songRef.id, versionId, lyricLines: sheet?.lines.length ?? 0, sectionCount: parsed.sections.length } },
  });
}
