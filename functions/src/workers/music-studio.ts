import { execFile } from 'node:child_process';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  alignVersions,
  analyzeMusic,
  arrangementFilter,
  arrangementPlan,
  mixFilterGraph,
  remapSheet,
  shiftSheet,
  sheetToLyricLines,
  type JobDoc,
  type LyricsSheet,
  type MixSettings,
  type MixTrack,
  type MusicAnalysis,
  type MusicVersionDoc,
  type Region,
  type SectionEdit,
  type SongDoc,
  type VersionSource,
} from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { PRICING } from '../config/pricing';
import { createAsset, withTmpDir } from '../lib/assets';
import { bucket, col, db, FieldValue, gsUri } from '../lib/firebase';
import { fail, JobFailure } from '../lib/errors';
import { logInteraction } from '../lib/interactions';
import { FFMPEG, probe } from '../lib/media';
import { progress, transition } from '../lib/jobs';
import { generateMusic } from '../lib/music-model';
import { decodeMono, loudnessStats } from '../lib/signal';
import { recordUsage } from '../lib/usage';
import { callReasoning, usageFor } from './text';
import { VOCALS_SCHEMA } from './text-tasks';

const execFileAsync = promisify(execFile);
const ffmpeg = (args: string[]) => execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 1_200_000, maxBuffer: 32 * 1024 * 1024 });
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const RATE = 22050;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface NewVersion {
  musicProjectId: string;
  source: VersionSource;
  label: string;
  assetId: string;
  parentVersionId: string | null;
  jobId: string | null;
  prompt: string | null;
  lyricsText: string | null;
  modelId: string | null;
  method: string;
  durationSec: number | null;
  loudness: MusicVersionDoc['loudness'];
  analysis: MusicAnalysis | null;
  timeMap: MusicVersionDoc['timeMap'];
}

/** Adds a version to a music project (numbered in order; the first one becomes the master). */
export async function createMusicVersion(projectId: string, v: NewVersion): Promise<string> {
  const mpRef = col.sub(projectId, 'musicProjects').doc(v.musicProjectId);
  const ref = col.sub(projectId, 'musicVersions').doc();
  await db.runTransaction(async (tx) => {
    const mp = await tx.get(mpRef);
    if (!mp.exists) throw new JobFailure({ code: 'not_found', message: 'The music project no longer exists.', retryable: false });
    const index = Number(mp.get('versionCount') ?? 0) + 1;
    tx.set(ref, { ...v, index, createdAt: FieldValue.serverTimestamp() });
    tx.set(mpRef, { versionCount: index, ...(mp.get('masterVersionId') ? {} : { masterVersionId: ref.id }), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  return ref.id;
}

async function saveAudio(job: JobDoc, dir: string, local: string, title: string, collections: string[], derivedFrom: string | null, generation?: Record<string, unknown>): Promise<{ assetId: string; durationSec: number }> {
  const assetId = col.assets().doc().id;
  const ext = path.extname(local).slice(1) || 'mp3';
  const mimeType = ext === 'wav' ? 'audio/wav' : ext === 'flac' ? 'audio/flac' : 'audio/mpeg';
  const storagePath = `users/${job.ownerUid}/generated/${job.id}/${assetId}.${ext}`;
  await bucket.upload(local, { destination: storagePath, resumable: false, metadata: { contentType: mimeType, cacheControl: 'private, max-age=31536000', metadata: { jobId: job.id } } });
  await createAsset({ uid: job.ownerUid, assetId, projectId: job.projectId, kind: 'audio', source: generation ? 'generated' : 'derived', title, fileName: `${assetId}.${ext}`, mimeType, storagePath, localFile: local, dir, collections, ...(derivedFrom ? { derivedFrom: { assetId: derivedFrom } } : {}), ...(generation ? { generation: generation as never } : {}) });
  const durationSec = Number((await col.assets().doc(assetId).get()).get('durationSec') ?? 0);
  return { assetId, durationSec };
}

// ---------------------------------------------------------------------------
// Analysis (beats, bars, key, energy, sections, vocals)
// ---------------------------------------------------------------------------

interface AnalyzeParams {
  assetId: string;
  storagePath: string;
  mimeType: string;
  durationSec: number;
  musicProjectId: string | null;
  versionId: string | null;
  detectVocals: boolean;
}

/** Vocal presence from the reasoning model listening to the audio (regions with singing). */
async function vocalRegions(job: JobDoc, p: AnalyzeParams): Promise<Region[] | null> {
  const r = await callReasoning(
    [{ fileData: { fileUri: gsUri(p.storagePath), mimeType: p.mimeType } }, { text: 'Listen to this recording. Say whether it contains sung or spoken vocals, and list every sung line with its start and end time in seconds (the words as heard; mark words you are unsure about).' }],
    { systemInstruction: 'You are a careful music transcriber. Return only JSON matching the schema.', responseJsonSchema: VOCALS_SCHEMA },
    'LOW',
  );
  await usageFor(job, r, 'audio', false);
  await logInteraction({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: r.modelId, api: 'generateContent', request: { task: 'vocal_detection', durationSec: p.durationSec }, response: { usage: r.res.usageMetadata ?? null }, latencyMs: r.latencyMs });
  const j = (r.json ?? {}) as { vocalsPresent?: boolean; lines?: { start?: number; end?: number }[] };
  if (!j.vocalsPresent) return [];
  const regions = (j.lines ?? []).filter((l) => typeof l.start === 'number' && typeof l.end === 'number' && l.end! > l.start!).map((l) => ({ start: Math.max(0, l.start!), end: Math.min(p.durationSec, l.end!) }));
  // Merge lines closer than a second into phrases.
  const merged: Region[] = [];
  for (const g of regions.sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && g.start - last.end < 1) last.end = Math.max(last.end, g.end);
    else merged.push({ ...g });
  }
  return merged;
}

export async function runMusicAnalyzeJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as AnalyzeParams;
  if (!job.projectId) fail('invalid_request', 'Analysis needs a project.');
  if (!(await transition(job.id, 'generating', { stage: 'Decoding the audio', progress: 0.1, lease: { until: Date.now() + 15 * 60_000 } }))) return;
  const { samples, loudness } = await withTmpDir(async (dir) => {
    const local = path.join(dir, `audio${path.extname(p.storagePath) || '.mp3'}`);
    await bucket.file(p.storagePath).download({ destination: local });
    return { samples: await decodeMono(local, RATE), loudness: await loudnessStats(local) };
  });
  let vocals: Region[] | null = null;
  if (p.detectVocals) {
    await progress(job.id, 'Listening for vocals', 0.35);
    vocals = await vocalRegions(job, p);
  }
  await progress(job.id, 'Finding beats, bars, key, energy and sections', 0.6);
  const analysis = analyzeMusic(samples, RATE, { vocalPresence: vocals });
  if (vocals) analysis.method = 'dsp+ai';
  if (p.versionId) {
    const ref = col.sub(job.projectId!, 'musicVersions').doc(p.versionId);
    const cur = (await ref.get()).data() as MusicVersionDoc | undefined;
    // Director corrections survive re-analysis.
    const corrected = cur?.analysis?.corrected ?? [];
    const merged = cur?.analysis ? { ...analysis, ...Object.fromEntries(corrected.map((k) => [k, (cur.analysis as unknown as Record<string, unknown>)[k]])), corrected } : analysis;
    await ref.set({ analysis: merged, loudness: { integratedLufs: loudness.integratedLufs, truePeakDb: loudness.truePeakDb } }, { merge: true });
  }
  await transition(job.id, 'completed', {
    stage: `${Math.round(analysis.bpm)} BPM · ${analysis.key} · ${analysis.sections.length} sections${vocals ? ` · vocals in ${vocals.length} phrase${vocals.length === 1 ? '' : 's'}` : ''}${loudness.integratedLufs !== null ? ` · ${loudness.integratedLufs.toFixed(1)} LUFS` : ''}`,
    result: { data: { analysis, loudness, versionId: p.versionId } },
  });
}

// ---------------------------------------------------------------------------
// Arrangement: the real audio re-ordered (loops, trims, mutes, fades) — never regenerated
// ---------------------------------------------------------------------------

interface ArrangeParams {
  musicProjectId: string;
  versionId: string;
  source: { assetId: string; storagePath: string; durationSec: number | null };
  sections: SectionEdit[];
}

export async function runMusicArrangeJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as ArrangeParams;
  if (!job.projectId) fail('invalid_request', 'Arrangement needs a project.');
  if (!(await transition(job.id, 'rendering', { stage: 'Arranging the sections', progress: 0.1, lease: { until: Date.now() + 15 * 60_000 } }))) return;
  const plan = arrangementPlan(p.sections);
  if (!plan.segments.length) fail('invalid_request', 'Keep at least one section.');
  const saved = await withTmpDir(async (dir) => {
    const local = path.join(dir, `source${path.extname(p.source.storagePath) || '.mp3'}`);
    await bucket.file(p.source.storagePath).download({ destination: local });
    const out = path.join(dir, 'arrangement.wav');
    await ffmpeg(['-i', local, '-filter_complex', arrangementFilter(plan), '-map', '[out]', '-ar', '48000', '-c:a', 'pcm_s16le', out]);
    const mp3 = path.join(dir, 'arrangement.mp3');
    await ffmpeg(['-i', out, '-c:a', 'libmp3lame', '-b:a', '320k', mp3]);
    const loud = await loudnessStats(mp3);
    const asset = await saveAudio(job, dir, mp3, 'Arrangement', ['music'], p.source.assetId);
    return { ...asset, loud };
  });
  const order = plan.segments.map((s) => p.sections.find((x) => x.id === s.sectionId)?.name || p.sections.find((x) => x.id === s.sectionId)?.label || '?');
  const versionId = await createMusicVersion(job.projectId!, {
    musicProjectId: p.musicProjectId,
    source: 'arrangement',
    label: `Arrangement (${order.length} parts)`,
    assetId: saved.assetId,
    parentVersionId: p.versionId,
    jobId: job.id,
    prompt: null,
    lyricsText: null,
    modelId: null,
    method: `The original audio re-ordered with ${Math.round(plan.crossfadeSec * 1000)} ms crossfades: ${order.join(' → ')}. Nothing was regenerated.`,
    durationSec: saved.durationSec,
    loudness: { integratedLufs: saved.loud.integratedLufs, truePeakDb: saved.loud.truePeakDb },
    analysis: null,
    timeMap: plan.timeMap,
  });
  await transition(job.id, 'completed', { stage: `Arrangement ready · ${mmss(saved.durationSec)}`, result: { assetIds: [saved.assetId], data: { versionId, timeMap: plan.timeMap } } });
}

// ---------------------------------------------------------------------------
// Mixdown
// ---------------------------------------------------------------------------

interface MixParams {
  musicProjectId: string;
  mix: MixSettings;
  durationSec: number;
  tracks: (MixTrack & { storagePath: string })[];
}

export async function runMusicMixJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as MixParams;
  if (!job.projectId) fail('invalid_request', 'Mixing needs a project.');
  if (!(await transition(job.id, 'rendering', { stage: `Mixing ${p.tracks.length} track${p.tracks.length === 1 ? '' : 's'}`, progress: 0.1, lease: { until: Date.now() + 20 * 60_000 } }))) return;
  const soloed = p.tracks.some((t) => t.solo);
  const live = p.tracks.filter((t) => !t.mute && (!soloed || t.solo));
  if (!live.length) fail('invalid_request', 'Every track is muted.');
  const graph = mixFilterGraph(p.tracks, p.mix, p.durationSec);
  const saved = await withTmpDir(async (dir) => {
    const inputs: string[] = [];
    for (const [i, t] of live.entries()) {
      const local = path.join(dir, `t${i}${path.extname(t.storagePath) || '.wav'}`);
      await bucket.file(t.storagePath).download({ destination: local });
      inputs.push('-i', local);
    }
    const wav = path.join(dir, 'mix.wav');
    await ffmpeg([...inputs, '-filter_complex', graph.filter, '-map', '[out]', '-c:a', 'pcm_s16le', wav]);
    const mp3 = path.join(dir, 'mix.mp3');
    await ffmpeg(['-i', wav, '-c:a', 'libmp3lame', '-b:a', '320k', mp3]);
    const loud = await loudnessStats(mp3);
    const asset = await saveAudio(job, dir, mp3, 'Mixdown', ['music'], null);
    return { ...asset, loud };
  });
  const versionId = await createMusicVersion(job.projectId!, {
    musicProjectId: p.musicProjectId,
    source: 'mixdown',
    label: `Mixdown (${live.length} track${live.length === 1 ? '' : 's'})`,
    assetId: saved.assetId,
    parentVersionId: null,
    jobId: job.id,
    prompt: null,
    lyricsText: null,
    modelId: null,
    method: `Mixed ${live.map((t) => t.name).join(', ')}${p.mix.targetLufs !== null ? `, normalised to ${p.mix.targetLufs} LUFS` : ''}${p.mix.limiter ? ' with a limiter' : ''}.`,
    durationSec: saved.durationSec,
    loudness: { integratedLufs: saved.loud.integratedLufs, truePeakDb: saved.loud.truePeakDb },
    analysis: null,
    timeMap: null,
  });
  await transition(job.id, 'completed', { stage: `Mixdown ready · ${saved.loud.integratedLufs?.toFixed(1) ?? '—'} LUFS · true peak ${saved.loud.truePeakDb?.toFixed(1) ?? '—'} dB`, result: { assetIds: [saved.assetId], data: { versionId, loudness: saved.loud } } });
}

// ---------------------------------------------------------------------------
// Replace one section (Lyria generates a new passage; AZ Studio blends it in)
// ---------------------------------------------------------------------------

interface ReplaceParams {
  musicProjectId: string;
  versionId: string;
  section: SectionEdit;
  source: { assetId: string; storagePath: string; durationSec: number | null };
  prompt: string;
  beats: number[];
  downbeats: number[];
}

/** Nearest beat (or downbeat) to a time, within a tolerance. */
function snap(t: number, grid: number[], tol = 0.35): number {
  let best = t;
  let d = tol;
  for (const g of grid) {
    if (Math.abs(g - t) < d) {
      d = Math.abs(g - t);
      best = g;
    }
  }
  return best;
}

export async function runMusicReplaceSectionJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as ReplaceParams;
  if (!job.projectId) fail('invalid_request', 'Section replacement needs a project.');
  if (!(await transition(job.id, 'generating', { stage: `${MODEL_REGISTRY.music.displayName} is composing the new ${p.section.name || p.section.label}`, progress: 0.1, lease: { until: Date.now() + 28 * 60_000 } }))) return;
  const started = Date.now();
  const result = await generateMusic({ prompt: p.prompt, imagePaths: [] });
  await recordUsage({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: MODEL_REGISTRY.music.id, kind: 'music', inputTokens: result.usage?.input ?? 0, outputTokens: result.usage?.output ?? 0, thoughtTokens: 0, costUsdOverride: PRICING.music.perSongUsd });
  await logInteraction({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: MODEL_REGISTRY.music.id, api: 'interactions', interactionId: result.interactionId, request: { task: 'replace_section', section: p.section.label, promptChars: p.prompt.length }, response: { mimeType: result.mimeType, bytes: result.audio.length, surface: result.surface }, latencyMs: Date.now() - started });
  await progress(job.id, 'Blending the new passage into the song on the beat', 0.6);
  // Section boundaries snapped to downbeats (else beats) so the crossfades land in time.
  const grid = p.downbeats.length ? p.downbeats : p.beats;
  const S = snap(p.section.start, grid);
  const E = snap(p.section.end, grid);
  const len = Math.max(1, E - S);
  const xf = 0.12;
  const saved = await withTmpDir(async (dir) => {
    const orig = path.join(dir, `source${path.extname(p.source.storagePath) || '.mp3'}`);
    await bucket.file(p.source.storagePath).download({ destination: orig });
    const gen = path.join(dir, `passage.${result.mimeType.includes('wav') ? 'wav' : 'mp3'}`);
    await writeFile(gen, result.audio);
    // Keep the generated passage from its first strong onset (it may begin with silence).
    const g = await decodeMono(gen, RATE);
    let startAt = 0;
    const hop = Math.round(RATE * 0.02);
    for (let i = 0; i + hop < g.length; i += hop) {
      let s = 0;
      for (let k = 0; k < hop; k++) s += g[i + k]! * g[i + k]!;
      if (Math.sqrt(s / hop) > 0.02) {
        startAt = i / RATE;
        break;
      }
    }
    const genLen = g.length / RATE - startAt;
    if (genLen < len * 0.8) fail('model_output', `The generated passage is ${genLen.toFixed(1)} s long; the ${p.section.name || p.section.label} needs ${len.toFixed(1)} s. Nothing was changed.`);
    const D = (await probe(orig)).durationSec ?? p.source.durationSec ?? E;
    const filter = [
      `[0:a]atrim=0:${(S + xf).toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a]`,
      `[1:a]atrim=${startAt.toFixed(3)}:${(startAt + len + xf).toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[b]`,
      `[0:a]atrim=${Math.max(0, E - xf).toFixed(3)}:${D.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[c]`,
      `[a][b]acrossfade=d=${xf}:c1=qsin:c2=qsin[ab]`,
      `[ab][c]acrossfade=d=${xf}:c1=qsin:c2=qsin[out]`,
    ].join(';');
    const wav = path.join(dir, 'replaced.wav');
    await ffmpeg(['-i', orig, '-i', gen, '-filter_complex', filter, '-map', '[out]', '-c:a', 'pcm_s16le', wav]);
    const mp3 = path.join(dir, 'replaced.mp3');
    await ffmpeg(['-i', wav, '-c:a', 'libmp3lame', '-b:a', '320k', mp3]);
    const loud = await loudnessStats(mp3);
    const asset = await saveAudio(job, dir, mp3, `New ${p.section.name || p.section.label}`, ['music'], p.source.assetId, { jobId: job.id, modelId: MODEL_REGISTRY.music.id, prompt: p.prompt, params: { purpose: 'replace_section', section: p.section.label }, interactionId: result.interactionId });
    // The generated passage on its own is kept too (so it can be auditioned or re-blended).
    const passage = await saveAudio(job, dir, gen, `Generated passage · ${p.section.name || p.section.label}`, ['music'], null, { jobId: job.id, modelId: MODEL_REGISTRY.music.id, prompt: p.prompt, params: { purpose: 'replace_section_passage' }, interactionId: result.interactionId });
    return { ...asset, loud, passageAssetId: passage.assetId };
  });
  const versionId = await createMusicVersion(job.projectId!, {
    musicProjectId: p.musicProjectId,
    source: 'replacement',
    label: `New ${p.section.name || p.section.label}`,
    assetId: saved.assetId,
    parentVersionId: p.versionId,
    jobId: job.id,
    prompt: p.prompt,
    lyricsText: null,
    modelId: MODEL_REGISTRY.music.id,
    method: `${MODEL_REGISTRY.music.displayName} generated a new ${len.toFixed(1)}-second passage (it cannot edit the existing song); AZ Studio blended it in at ${mmss(S)}–${mmss(E)} with ${Math.round(xf * 1000)} ms crossfades on the ${p.downbeats.length ? 'downbeats' : 'beats'}.`,
    durationSec: saved.durationSec,
    loudness: { integratedLufs: saved.loud.integratedLufs, truePeakDb: saved.loud.truePeakDb },
    analysis: null,
    // Time before the section is unchanged; after it, the song continues at the same times.
    timeMap: [
      { src: 0, dst: 0, len: S },
      { src: E, dst: E, len: Math.max(0, (p.source.durationSec ?? E) - E) },
    ],
  });
  await transition(job.id, 'completed', { stage: `Replacement blended at ${mmss(S)}–${mmss(E)}`, result: { assetIds: [saved.assetId, saved.passageAssetId], data: { versionId, start: S, end: E } } });
}

// ---------------------------------------------------------------------------
// Lyric re-sync after the audio changed
// ---------------------------------------------------------------------------

interface ResyncParams {
  songId: string;
  from: { assetId: string; storagePath: string };
  to: { assetId: string; storagePath: string; durationSec: number | null };
}

/**
 * The lyric sheet follows a new audio version: through the arrangement's time map when the new version
 * is an arrangement of the old one, otherwise by the measured offset between the two recordings. The
 * words are never changed; when the recordings do not line up the sheet is left as it was.
 */
export async function runLyricsResyncAudioJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as ResyncParams;
  if (!job.projectId) fail('invalid_request', 'Re-sync needs a project.');
  if (!(await transition(job.id, 'generating', { stage: 'Comparing the two audio versions', progress: 0.1, lease: { until: Date.now() + 15 * 60_000 } }))) return;
  const songRef = col.songs(job.projectId!).doc(p.songId);
  const song = (await songRef.get()).data() as SongDoc | undefined;
  if (!song?.lyricsSheet) fail('invalid_request', 'This song has no lyric sheet.');
  const sheet = song!.lyricsSheet!;
  // An arrangement (or replacement) made in Music Studio carries its exact time map.
  const versions = await col.sub(job.projectId!, 'musicVersions').where('assetId', '==', p.to.assetId).limit(1).get();
  const toVersion = versions.docs[0]?.data() as MusicVersionDoc | undefined;
  let parentAsset: string | null = null;
  if (toVersion?.parentVersionId) parentAsset = ((await col.sub(job.projectId!, 'musicVersions').doc(toVersion.parentVersionId).get()).get('assetId') as string | undefined) ?? null;
  let next: LyricsSheet;
  let method: string;
  if (toVersion?.timeMap && parentAsset === p.from.assetId) {
    next = remapSheet(sheet, toVersion.timeMap);
    method = `followed the ${toVersion.source} edit’s time map`;
  } else {
    const { a, b } = await withTmpDir(async (dir) => {
      const fa = path.join(dir, 'a');
      const fb = path.join(dir, 'b');
      await Promise.all([bucket.file(p.from.storagePath).download({ destination: fa }), bucket.file(p.to.storagePath).download({ destination: fb })]);
      return { a: await decodeMono(fa, 8000), b: await decodeMono(fb, 8000) };
    });
    const al = alignVersions(a, b, 8000);
    if (al.confidence < 0.3) fail('alignment_failed', `The two recordings do not line up (match confidence ${Math.round(al.confidence * 100)}%), so the lyric timing was left unchanged. Re-sync the lyrics to the new vocals instead (Lyrics → Sync to vocals).`);
    next = shiftSheet(sheet, al.offsetSec);
    method = `shifted by ${al.offsetSec >= 0 ? '+' : ''}${al.offsetSec.toFixed(3)} s (match confidence ${Math.round(al.confidence * 100)}%)`;
  }
  const dur = p.to.durationSec ?? Infinity;
  next = { ...next, lines: next.lines.filter((l) => l.start === null || l.start < dur - 0.05) };
  // The previous sheet is kept on the song so the change can be undone.
  await songRef.collection('lyricsHistory').add({ at: Date.now(), audioAssetId: p.from.assetId, sheet, reason: 'resync_audio', jobId: job.id, createdAt: FieldValue.serverTimestamp() });
  await songRef.set({ lyricsSheet: next, lyrics: { source: 'manual', lines: sheetToLyricLines(next) }, audioAssetId: p.to.assetId, durationSec: p.to.durationSec ?? song!.durationSec, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await transition(job.id, 'completed', { stage: `Lyrics re-synced: ${method}`, result: { data: { method, lines: next.lines.length } } });
}

export { snap as snapToGrid };
