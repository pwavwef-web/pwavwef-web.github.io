import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AssetDoc, JobDoc } from '@az-studio/shared';
import { createAsset, withTmpDir } from '../lib/assets';
import { bucket, col, db, FieldValue } from '../lib/firebase';
import { fail } from '../lib/errors';
import { FFMPEG, probe } from '../lib/media';
import { progress, transition } from '../lib/jobs';

const execFileAsync = promisify(execFile);

export interface CompositeParams {
  op: 'trim' | 'cutaway';
  sourceAssetId: string;
  /** trim: keep [0, keepUntilSec). */
  keepUntilSec?: number;
  /** cutaway: replace the picture of [sectionStartSec, sectionEndSec) with the insert; audio stays. */
  insertAssetId?: string;
  sectionStartSec?: number;
  sectionEndSec?: number;
  shotId: string | null;
  parentTakeId: string | null;
  takeLabel: string;
  title: string;
}

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];

/**
 * Least-destructive repair edits on real media: trim an unwanted ending, or cut away to an insert /
 * reaction shot for a faulty section while the original dialogue audio keeps playing underneath.
 */
export async function runCompositeJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as CompositeParams;
  if (!job.projectId) fail('invalid_request', 'Repair edits need a project.');
  if (!(await transition(job.id, 'rendering', { stage: p.op === 'trim' ? 'Trimming the ending' : 'Cutting away over the dialogue', progress: 0.1, lease: { until: Date.now() + 9 * 60_000 } }))) return;
  const src = { id: p.sourceAssetId, ...(await col.assets().doc(p.sourceAssetId).get()).data() } as AssetDoc;
  if (!src.storagePath) fail('not_found', 'The version being repaired no longer exists.');
  const newId = col.assets().doc().id;
  const storagePath = `users/${job.ownerUid}/generated/${job.id}/${newId}.mp4`;
  const takeId = await withTmpDir(async (dir) => {
    const srcLocal = path.join(dir, 'source.mp4');
    await bucket.file(src.storagePath).download({ destination: srcLocal });
    const info = await probe(srcLocal);
    const D = info.durationSec ?? src.durationSec ?? 0;
    const out = path.join(dir, 'repaired.mp4');
    if (p.op === 'trim') {
      const keep = Math.min(D, Math.max(0.5, p.keepUntilSec ?? D));
      await ffmpeg(['-i', srcLocal, '-t', String(r3(keep)), ...ENCODE, out]);
    } else {
      const ins = { id: p.insertAssetId!, ...(await col.assets().doc(p.insertAssetId!).get()).data() } as AssetDoc;
      if (!ins.storagePath) fail('not_found', 'The cutaway shot no longer exists.');
      const insLocal = path.join(dir, 'insert.mp4');
      await bucket.file(ins.storagePath).download({ destination: insLocal });
      const S = Math.max(0, Math.min(D, p.sectionStartSec ?? 0));
      const E = Math.max(S + 0.2, Math.min(D, p.sectionEndSec ?? D));
      const L = E - S;
      const W = info.width ?? 1280;
      const H = info.height ?? 720;
      const F = info.fps ?? 24;
      const norm = (label: string) => `fps=${F},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p[${label}]`;
      const parts: string[] = [];
      const labels: string[] = [];
      if (S > 0.04) {
        parts.push(`[0:v]trim=0:${r3(S)},setpts=PTS-STARTPTS,${norm('a')}`);
        labels.push('[a]');
      }
      parts.push(`[1:v]tpad=stop_mode=clone:stop_duration=${r3(L)},trim=0:${r3(L)},setpts=PTS-STARTPTS,${norm('b')}`);
      labels.push('[b]');
      if (D - E > 0.04) {
        parts.push(`[0:v]trim=${r3(E)}:${r3(D)},setpts=PTS-STARTPTS,${norm('c')}`);
        labels.push('[c]');
      }
      parts.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[v]`);
      // The original dialogue/ambience track plays uninterrupted under the new picture.
      await ffmpeg(['-i', srcLocal, '-i', insLocal, '-filter_complex', parts.join(';'), '-map', '[v]', '-map', '0:a?', '-t', String(r3(D)), ...ENCODE, out]);
    }
    await progress(job.id, 'Saving the repaired version', 0.7);
    await bucket.upload(out, { destination: storagePath, resumable: false, metadata: { contentType: 'video/mp4', cacheControl: 'private, max-age=31536000', metadata: { jobId: job.id, repair: p.op } } });
    await createAsset({
      uid: job.ownerUid,
      assetId: newId,
      projectId: job.projectId,
      kind: 'video',
      source: 'derived',
      title: p.title,
      fileName: `${newId}.mp4`,
      mimeType: 'video/mp4',
      storagePath,
      localFile: out,
      dir,
      collections: src.collections ?? [],
      derivedFrom: { assetId: src.id, ...(p.op === 'trim' ? { startSec: 0, durationSec: p.keepUntilSec ?? D } : {}) },
      ...(src.generation ? { generation: { ...src.generation, jobId: job.id, parentAssetId: src.id, params: { ...src.generation.params, repair: p.op, insertAssetId: p.insertAssetId ?? null }, provenance: { ...src.generation.provenance, c2pa: 'absent' } } } : {}),
    });
    if (!p.shotId) return null;
    // The repaired version becomes a take of the shot so it can be compared, selected and approved.
    const shotRef = col.projects().doc(job.projectId!).collection('shots').doc(p.shotId);
    const takeRef = shotRef.collection('takes').doc();
    await db.runTransaction(async (tx) => {
      const shot = await tx.get(shotRef);
      const index = Number(shot.get('takeCount') ?? 0) + 1;
      tx.set(takeRef, {
        index,
        jobId: job.id,
        assetId: newId,
        status: 'completed',
        prompt: p.op === 'trim' ? 'Trimmed ending' : 'Cutaway over continuous dialogue',
        params: { repair: p.op },
        interactionId: null,
        parentTakeId: p.parentTakeId,
        label: `Take ${index} · ${p.takeLabel}`,
        rating: 0,
        notes: '',
        approved: false,
        productionId: job.productionId ?? null,
        versionId: null,
        quality: { verdict: 'pending', overall: null, reportId: null },
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(shotRef, { takeCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
    return takeRef.id;
  });
  await transition(job.id, 'completed', { stage: 'Repaired version saved', result: { assetIds: [newId], data: { takeId } } }, { assetId: newId });
}
