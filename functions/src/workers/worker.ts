import { logger } from 'firebase-functions';
import { isTerminal, type JobDoc } from '@az-studio/shared';
import { acquireSlot, releaseSlot } from '../lib/concurrency';
import { toJobError } from '../lib/errors';
import { cancelJobDoc, claimJob, enqueueJob, failJob, getJob, transition, type WorkerPayload } from '../lib/jobs';
import { getSettings } from '../lib/usage';
import { runImageJob } from './image';
import { pollVideoJob, startVideoJob } from './video';
import { runAudioJob, runTextJob } from './text';
import { startRenderJob, watchRenderJob } from './render';
import { runInspectJob } from './inspect';
import { runSpeechJob } from './speech';
import { runMusicJob } from './music';
import { runLyricsAlignJob, runLyricsTranscribeJob } from './lyrics';
import { runCompositeJob } from './composite';
import { advanceProduction } from '../lib/production';

const MAX_AUTO_RETRIES = 4;
/** Only image/video generations occupy the owner's concurrent-generation slots. */
const usesSlot = (job: JobDoc) => job.type === 'image.generate' || job.type === 'video.generate';

async function startJob(jobId: string, seq: number): Promise<void> {
  const claimed = await claimJob(jobId);
  if (!claimed) return;
  if (claimed.cancelRequested) {
    await cancelJobDoc(claimed);
    return;
  }
  if (usesSlot(claimed)) {
    const settings = await getSettings(claimed.ownerUid);
    const ok = await acquireSlot(claimed.ownerUid, claimed.id, settings.maxConcurrentGenerations);
    if (!ok) {
      await transition(claimed.id, 'queued', { stage: `Waiting for a free slot (max ${settings.maxConcurrentGenerations} generations at once)`, lease: null });
      await enqueueJob(claimed.id, 'start', { delaySec: 20, seq: seq + 1 });
      return;
    }
  }
  switch (claimed.type) {
    case 'image.generate':
      await runImageJob(claimed);
      await releaseSlot(claimed.ownerUid, claimed.id);
      return;
    case 'video.generate':
      // The slot stays held while Omni works; it is released when polling finishes.
      await startVideoJob(claimed);
      return;
    case 'text.assist':
      await runTextJob(claimed);
      return;
    case 'audio.analyze':
      await runAudioJob(claimed);
      return;
    case 'render.timeline':
      await startRenderJob(claimed);
      return;
    case 'quality.inspect':
      await runInspectJob(claimed);
      return;
    case 'speech.generate':
      await runSpeechJob(claimed);
      return;
    case 'music.generate':
      await runMusicJob(claimed);
      return;
    case 'lyrics.transcribe':
      await runLyricsTranscribeJob(claimed);
      return;
    case 'lyrics.align':
      await runLyricsAlignJob(claimed);
      return;
    case 'media.composite':
      await runCompositeJob(claimed);
      return;
  }
}

/** Entry point for every Cloud Tasks delivery. Idempotent: duplicate deliveries are ignored. */
export async function handleTask(payload: WorkerPayload): Promise<void> {
  if (payload.productionId) {
    await advanceProduction(payload.productionId);
    return;
  }
  if (!payload.jobId) return;
  const job = await getJob(payload.jobId);
  if (!job || isTerminal(job.status)) return;
  try {
    if (payload.step === 'start') await startJob(job.id, payload.seq);
    else if (job.type === 'video.generate') await pollVideoJob(job, payload.seq);
    else if (job.type === 'render.timeline') await watchRenderJob(job, payload.seq);
  } catch (e) {
    const err = toJobError(e);
    const fresh = await getJob(job.id);
    if (!fresh || isTerminal(fresh.status)) return;
    const retryableState = fresh.status === 'queued' || fresh.status === 'validating' || (fresh.status === 'generating' && !fresh.external?.interactionId);
    if (err.retryable && retryableState && fresh.attempt < MAX_AUTO_RETRIES) {
      const delay = Math.min(300, 15 * 2 ** fresh.attempt);
      logger.info('retrying job after transient error', { jobId: job.id, code: err.code, attempt: fresh.attempt + 1, delay });
      await transition(job.id, 'queued', { attempt: fresh.attempt + 1, stage: `Retrying in ${delay}s — ${err.message}`, lease: null });
      if (usesSlot(fresh)) await releaseSlot(fresh.ownerUid, fresh.id);
      await enqueueJob(job.id, 'start', { delaySec: delay, seq: payload.seq + 1 });
      return;
    }
    if (err.retryable && fresh.status === 'generating' && fresh.external?.interactionId) {
      // Transient error while polling: keep polling.
      await enqueueJob(job.id, 'poll', { delaySec: 30, seq: payload.seq + 1 });
      return;
    }
    // Failures after a billed response (e.g. while saving media) are never retried automatically.
    await failJob(fresh, err);
  }
}
