import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { lipSyncEstimateUsd, LIPSYNC_MODELS, type AssetDoc, type CostEstimate, type JobDoc } from '@az-studio/shared';
import { PRICING } from '../config/pricing';
import { createAsset, withTmpDir } from '../lib/assets';
import { fail } from '../lib/errors';
import { FalError, falRun, falUpload } from '../lib/fal';
import { bucket, col } from '../lib/firebase';
import { progress, transition } from '../lib/jobs';
import { FFMPEG, probe } from '../lib/media';
import { readFile } from 'node:fs/promises';
import { recordDerivedTake } from '../lib/takes';
import { recordUsage } from '../lib/usage';

const execFileAsync = promisify(execFile);

export interface LipSyncParams {
  source: { assetId: string; storagePath: string; title: string; durationSec: number | null };
  /** The recording whose words the mouth must follow, and the stretch of it that plays under this clip. */
  audio: { assetId: string; storagePath: string; startSec: number };
  tier: keyof typeof LIPSYNC_MODELS;
  shotId: string | null;
  parentTakeId?: string | null;
  takeLabel?: string;
}

export function lipSyncEstimate(durationSec: number, tier: keyof typeof LIPSYNC_MODELS = 'standard'): CostEstimate {
  const usd = lipSyncEstimateUsd(durationSec, tier);
  return { usd, basis: 'none', confidence: 'low', breakdown: [{ label: `fal.ai ${LIPSYNC_MODELS[tier].param} · ${durationSec.toFixed(1)} s`, usd }], notes: ['Estimated from fal.ai list price per second of video; the real charge appears in your fal.ai account.'], pricingVersion: PRICING.version };
}

/** Runs the lip-sync model on one clip and stores the result as a new derived asset. Returns the asset id and the model request id. */
export async function lipSyncClip(job: Pick<JobDoc, 'id' | 'ownerUid' | 'projectId'>, p: LipSyncParams, onStage: (stage: string, value: number) => Promise<void> = async () => undefined): Promise<{ assetId: string; requestId: string; durationSec: number; costUsd: number }> {
  const src = { id: p.source.assetId, ...(await col.assets().doc(p.source.assetId).get()).data() } as AssetDoc;
  if (!src.storagePath) fail('not_found', 'The clip to lip-sync no longer exists.');
  const newId = col.assets().doc().id;
  const storagePath = `users/${job.ownerUid}/generated/${job.id}/${newId}.mp4`;
  return withTmpDir(async (dir) => {
    const srcLocal = path.join(dir, 'source.mp4');
    const audioLocal = path.join(dir, 'song.audio');
    await Promise.all([bucket.file(src.storagePath).download({ destination: srcLocal }), bucket.file(p.audio.storagePath).download({ destination: audioLocal })]);
    const info = await probe(srcLocal);
    const D = info.durationSec ?? p.source.durationSec ?? 0;
    if (D <= 0) fail('invalid_media', 'The clip has no readable duration.');
    await onStage('Cutting the voice for this clip', 0.1);
    // The exact stretch of the recording that plays under this clip, same length as the picture.
    const voiceLocal = path.join(dir, 'voice.mp3');
    await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, p.audio.startSec)), '-t', D.toFixed(3), '-i', audioLocal, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k', voiceLocal], { timeout: 120_000 });
    {
      const [videoUrl, audioUrl] = await Promise.all([readFile(srcLocal).then((b) => falUpload(b, 'video/mp4', 'clip.mp4')), readFile(voiceLocal).then((b) => falUpload(b, 'audio/mpeg', 'voice.mp3'))]);
      await onStage('Lip-syncing with fal.ai', 0.25);
      const model = LIPSYNC_MODELS[p.tier];
      const { requestId, output } = await falRun<{ video?: { url?: string } }>(model.id, { model: model.param, video_url: videoUrl, audio_url: audioUrl, sync_mode: 'cut_off' }, { onStatus: (s) => void onStage(`Lip-syncing with fal.ai · ${s.toLowerCase().replace('_', ' ')}`, 0.4) });
      const url = output.video?.url;
      if (!url) fail('provider_error', 'fal.ai finished without returning a video.');
      await onStage('Saving the lip-synced clip', 0.8);
      const res = await fetch(url);
      if (!res.ok) throw new FalError(`Could not download the lip-synced clip (${res.status}).`, res.status, true);
      const raw = path.join(dir, 'synced-raw.mp4');
      await writeFile(raw, Buffer.from(await res.arrayBuffer()));
      // Normalise to the source's frame size and rate so the take drops straight into the edit.
      const outLocal = path.join(dir, 'synced.mp4');
      const w = src.width ?? info.width ?? 720;
      const h = src.height ?? info.height ?? 1280;
      await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-t', D.toFixed(3), '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`, '-r', String(info.fps ?? src.fps ?? 24), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outLocal], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
      const outInfo = await probe(outLocal);
      await bucket.upload(outLocal, { destination: storagePath, resumable: false, metadata: { contentType: 'video/mp4', cacheControl: 'private, max-age=31536000', metadata: { jobId: job.id, op: 'lipsync' } } });
      await createAsset({
        uid: job.ownerUid,
        assetId: newId,
        projectId: job.projectId,
        kind: 'video',
        source: 'derived',
        title: `${p.source.title || src.title} — lip-synced`,
        fileName: `${newId}.mp4`,
        mimeType: 'video/mp4',
        storagePath,
        localFile: outLocal,
        dir,
        collections: src.collections ?? [],
        derivedFrom: { assetId: src.id },
        ...(src.generation ? { generation: { ...src.generation, jobId: job.id, parentAssetId: src.id, params: { ...src.generation.params, lipSync: { model: model.param, requestId, audioAssetId: p.audio.assetId, audioStartSec: p.audio.startSec } }, provenance: { ...src.generation.provenance, c2pa: 'absent' } } } : {}),
      });
      const costUsd = lipSyncEstimateUsd(D, p.tier);
      await recordUsage({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: `${model.id}#${model.param}`, kind: 'compute', inputTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsdOverride: costUsd });
      return { assetId: newId, requestId, durationSec: outInfo.durationSec ?? D, costUsd };
    }
  });
}

/** Job runner: lip-sync one take of a shot to the real recording, and add the result as a new take. */
export async function runLipSyncJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as LipSyncParams;
  if (!job.projectId) fail('invalid_request', 'Lip sync needs a project.');
  if (!(await transition(job.id, 'rendering', { stage: 'Preparing lip sync', progress: 0.05, lease: { until: Date.now() + 20 * 60_000 } }))) return;
  let out;
  try {
    out = await lipSyncClip(job, p, (stage, value) => progress(job.id, stage, value));
  } catch (e) {
    if (e instanceof FalError) fail(e.status === 401 || e.status === 403 ? 'permission' : 'provider_error', e.message, { retryable: e.retryable });
    throw e;
  }
  let takeId: string | null = null;
  if (p.shotId) {
    takeId = await recordDerivedTake({ projectId: job.projectId, shotId: p.shotId, jobId: job.id, assetId: out.assetId, prompt: 'Lip-synced to the recording', params: { repair: 'lipsync', audioAssetId: p.audio.assetId, tier: p.tier }, parentTakeId: p.parentTakeId ?? null, takeLabel: p.takeLabel ?? 'lip-synced', productionId: job.productionId ?? null });
  }
  await transition(job.id, 'completed', { stage: 'Lip-synced', result: { assetIds: [out.assetId], data: { takeId, requestId: out.requestId, costUsd: out.costUsd } } }, { assetId: out.assetId });
}
