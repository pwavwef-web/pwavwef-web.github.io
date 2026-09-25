import path from 'node:path';
import type { Box, JobDoc } from '@az-studio/shared';
import { withTmpDir } from '../lib/assets';
import { bucket, col, FieldValue } from '../lib/firebase';
import { fail } from '../lib/errors';
import { jpegAt, sampleFrames } from '../lib/frames';
import { probe } from '../lib/media';
import { progress, transition } from '../lib/jobs';
import { annotateFrames } from '../lib/vision';

interface SubjectsParams {
  assets: { assetId: string; storagePath: string; kind: 'video' | 'image'; durationSec: number | null; width: number | null; height: number | null }[];
  fps: number;
}

/** `projects/{projectId}/subjectTracks/{assetId}` — faces and people per sampled frame (0–1 boxes). */
export interface SubjectTrackDoc {
  assetId: string;
  fps: number;
  width: number | null;
  height: number | null;
  durationSec: number;
  samples: { t: number; faces: { box: Box; confidence: number; pan: number | null }[]; people: { box: Box; score: number }[] }[];
  analyzedAt: number;
  jobId: string;
}

/**
 * Face and body tracking on real frames (Cloud Vision): used by face-safe reframing (vertical and
 * square exports), lyric and title placement (never over a face) and blocking checks.
 */
export async function runAnalyzeSubjectsJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as SubjectsParams;
  if (!job.projectId) fail('invalid_request', 'Tracking needs a project.');
  if (!(await transition(job.id, 'generating', { stage: `Tracking faces and people in ${p.assets.length} clip${p.assets.length === 1 ? '' : 's'}`, progress: 0.05, lease: { until: Date.now() + 25 * 60_000 } }))) return;
  const usage = { uid: job.ownerUid, projectId: job.projectId, jobId: job.id };
  let done = 0;
  let frames = 0;
  for (const a of p.assets) {
    await progress(job.id, `Tracking ${done + 1} of ${p.assets.length}`, 0.05 + (0.9 * done) / p.assets.length);
    const doc = await withTmpDir(async (dir) => {
      const local = path.join(dir, `media${path.extname(a.storagePath) || (a.kind === 'video' ? '.mp4' : '.png')}`);
      await bucket.file(a.storagePath).download({ destination: local });
      const info = await probe(local);
      const D = a.kind === 'image' ? 0 : info.durationSec ?? a.durationSec ?? 0;
      const W = info.width ?? a.width ?? 1280;
      const H = info.height ?? a.height ?? 720;
      const sampled =
        a.kind === 'image'
          ? [{ t: 0, jpeg: (await jpegAt(local, 0, 1024))!, width: 1024, height: Math.round((1024 * H) / W) }].filter((f) => f.jpeg)
          : await sampleFrames(local, { durationSec: D, fps: p.fps, width: 1024, srcWidth: W, srcHeight: H, max: 120 });
      const annotated = await annotateFrames({ frames: sampled, features: ['FACE_DETECTION', 'OBJECT_LOCALIZATION'], usage });
      frames += annotated.length;
      const out: SubjectTrackDoc = {
        assetId: a.assetId,
        fps: p.fps,
        width: W,
        height: H,
        durationSec: D,
        samples: annotated.map((f) => ({ t: f.t, faces: f.faces.map((x) => ({ box: x.box, confidence: Math.round(x.confidence * 1000) / 1000, pan: x.pan })), people: f.people.map((x) => ({ box: x.box, score: Math.round(x.score * 1000) / 1000 })) })),
        analyzedAt: Date.now(),
        jobId: job.id,
      };
      return out;
    });
    await col.sub(job.projectId!, 'subjectTracks').doc(a.assetId).set({ ...doc, updatedAt: FieldValue.serverTimestamp() });
    done++;
  }
  await transition(job.id, 'completed', { stage: `Tracked ${done} clip${done === 1 ? '' : 's'} (${frames} frames analysed)`, result: { data: { assetIds: p.assets.map((a) => a.assetId), frames } } });
}
