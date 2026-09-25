import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { colourDrift, computeColourMatch, lutrgbFilter, type AssetDoc, type JobDoc, type Rgb, type RgbStats } from '@az-studio/shared';
import { createAsset, withTmpDir } from '../lib/assets';
import { bucket, col } from '../lib/firebase';
import { fail } from '../lib/errors';
import { jpegAt, regionMean, rgbStats, toColourStats } from '../lib/frames';
import { FFMPEG, probe } from '../lib/media';
import { progress, transition } from '../lib/jobs';
import { recordDerivedTake } from '../lib/takes';
import { annotateFrames } from '../lib/vision';

const execFileAsync = promisify(execFile);

export interface ColorMatchParams {
  source: { assetId: string; storagePath: string; kind: 'video' | 'image'; durationSec: number | null; title: string };
  reference: { assetId: string; storagePath: string; kind: string };
  strength: number;
  lut: { storagePath: string; strength: number } | null;
  skinTone: string;
  shotId: string | null;
  parentTakeId?: string | null;
  takeLabel?: string;
}

const ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

/** Skin tone of the largest confident face in one frame (null when no face is visible). */
async function skin(jpeg: Buffer | null, usage: { uid: string; projectId: string | null; jobId: string }): Promise<Rgb | null> {
  if (!jpeg) return null;
  const [frame] = await annotateFrames({ frames: [{ t: 0, jpeg, width: 768, height: 432 }], features: ['FACE_DETECTION'], usage });
  const face = frame?.faces.filter((f) => f.confidence >= 0.6).sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];
  if (!face || face.box.w < 0.04) return null;
  return regionMean(jpeg, { x: face.box.x + face.box.w * 0.25, y: face.box.y + face.box.h * 0.3, w: face.box.w * 0.5, h: face.box.h * 0.45 });
}

/**
 * Colour Director: measures the source and the approved reference, computes a capped per-channel
 * transfer (exposure, white balance, contrast) that protects skin tones, applies it (and an optional
 * creative LUT at a set strength) with FFmpeg, then measures the result against the reference again.
 */
export async function runColorMatchJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as ColorMatchParams;
  if (!job.projectId) fail('invalid_request', 'Colour matching needs a project.');
  if (!(await transition(job.id, 'rendering', { stage: 'Measuring colour', progress: 0.1, lease: { until: Date.now() + 15 * 60_000 } }))) return;
  const usage = { uid: job.ownerUid, projectId: job.projectId, jobId: job.id };
  const src = { id: p.source.assetId, ...(await col.assets().doc(p.source.assetId).get()).data() } as AssetDoc;
  if (!src.storagePath) fail('not_found', 'The clip to colour-match no longer exists.');
  const isVideo = p.source.kind === 'video';
  const newId = col.assets().doc().id;
  const ext = isVideo ? 'mp4' : 'jpg';
  const storagePath = `users/${job.ownerUid}/generated/${job.id}/${newId}.${ext}`;
  const out = await withTmpDir(async (dir) => {
    const srcLocal = path.join(dir, `source${path.extname(src.storagePath) || (isVideo ? '.mp4' : '.png')}`);
    const refLocal = path.join(dir, `reference${path.extname(p.reference.storagePath) || '.png'}`);
    await Promise.all([bucket.file(src.storagePath).download({ destination: srcLocal }), bucket.file(p.reference.storagePath).download({ destination: refLocal })]);
    const info = await probe(srcLocal);
    const D = info.durationSec ?? p.source.durationSec ?? 0;
    const refIsImage = p.reference.kind === 'image';
    const [srcStats, refStats] = await Promise.all([rgbStats(srcLocal, isVideo ? { fps: 2 } : { isImage: true }), rgbStats(refLocal, refIsImage ? { isImage: true } : { fps: 2 })]);
    if (!srcStats || !refStats) fail('invalid_media', 'The source or the reference could not be read for colour measurement.');
    const [srcSkin, refSkin] = await Promise.all([skin(await jpegAt(srcLocal, isVideo ? D / 2 : 0), usage), skin(await jpegAt(refLocal, 0), usage)]);
    const s: RgbStats = { ...srcStats!, skin: srcSkin };
    const r: RgbStats = { ...refStats!, skin: refSkin };
    const correction = computeColourMatch(s, r, { strength: p.strength });
    await progress(job.id, `Applying the correction${p.lut ? ' and the creative LUT' : ''}`, 0.4);
    let filter = `[0:v]${lutrgbFilter(correction)}`;
    if (p.lut) {
      const lutLocal = path.join(dir, 'look.cube');
      await bucket.file(p.lut.storagePath).download({ destination: lutLocal });
      const k = Math.max(0, Math.min(1, p.lut.strength));
      filter += `,split[a][b];[b]lut3d=file='${lutLocal.replace(/\\/g, '/').replace(/'/g, "\\'")}':interp=tetrahedral[l];[a][l]blend=all_expr='A*${(1 - k).toFixed(3)}+B*${k.toFixed(3)}',format=yuv420p`;
    }
    filter += '[v]';
    const outLocal = path.join(dir, `matched.${ext}`);
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', srcLocal, '-filter_complex', filter, '-map', '[v]'];
    if (isVideo) args.push('-map', '0:a?', '-c:a', 'copy', ...ENCODE, outLocal);
    else args.push('-frames:v', '1', '-q:v', '2', outLocal);
    await execFileAsync(FFMPEG, args, { timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
    // Verify on the real output: distance to the reference before and after.
    const after = await rgbStats(outLocal, isVideo ? { fps: 2 } : { isImage: true });
    const afterSkin = await skin(await jpegAt(outLocal, isVideo ? D / 2 : 0), usage);
    const before = colourDrift(toColourStats(s)!, toColourStats(r)!);
    const result = after ? colourDrift(toColourStats({ ...after, skin: afterSkin })!, toColourStats(r)!) : null;
    await progress(job.id, 'Saving the colour-matched version', 0.75);
    await bucket.upload(outLocal, { destination: storagePath, resumable: false, metadata: { contentType: isVideo ? 'video/mp4' : 'image/jpeg', cacheControl: 'private, max-age=31536000', metadata: { jobId: job.id, op: 'color_match' } } });
    await createAsset({
      uid: job.ownerUid,
      assetId: newId,
      projectId: job.projectId,
      kind: isVideo ? 'video' : 'image',
      source: 'derived',
      title: `${p.source.title || src.title} — colour matched`,
      fileName: `${newId}.${ext}`,
      mimeType: isVideo ? 'video/mp4' : 'image/jpeg',
      storagePath,
      localFile: outLocal,
      dir,
      collections: src.collections ?? [],
      derivedFrom: { assetId: src.id },
      ...(src.generation ? { generation: { ...src.generation, jobId: job.id, parentAssetId: src.id, params: { ...src.generation.params, colorMatch: { referenceAssetId: p.reference.assetId, gain: correction.gain, offset: correction.offset, strength: correction.strength } }, provenance: { ...src.generation.provenance, c2pa: 'absent' } } } : {}),
    });
    return { correction, before, result };
  });
  let takeId: string | null = null;
  if (p.shotId && isVideo) {
    takeId = await recordDerivedTake({ projectId: job.projectId!, shotId: p.shotId, jobId: job.id, assetId: newId, prompt: `Colour-matched to the reference (ΔE ${out.before.deltaE.toFixed(1)} → ${out.result?.deltaE.toFixed(1) ?? '—'})`, params: { repair: 'color_match', referenceAssetId: p.reference.assetId }, parentTakeId: p.parentTakeId ?? null, takeLabel: p.takeLabel ?? 'colour-matched', productionId: job.productionId ?? null });
  }
  const improved = out.result ? out.result.deltaE < out.before.deltaE : false;
  await transition(
    job.id,
    'completed',
    {
      stage: `Colour matched · ΔE ${out.before.deltaE.toFixed(1)} → ${out.result?.deltaE.toFixed(1) ?? '—'}${out.correction.skinProtected ? ' · skin tones protected' : ''}${improved ? '' : ' · no closer to the reference'}`,
      result: { assetIds: [newId], data: { takeId, correction: out.correction, before: out.before, after: out.result, improved } },
    },
    { assetId: newId },
  );
}
