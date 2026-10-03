import { isTerminal } from '@az-studio/shared';
import { acquireSlot, releaseSlot } from '../lib/concurrency';
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
import { runColorMatchJob } from './color-match';
import { runContinuityCompareJob } from './continuity-compare';
import { runFinalInspectJob } from './final-inspect';
import { runLyricsResyncAudioJob, runMusicAnalyzeJob, runMusicArrangeJob, runMusicMixJob, runMusicReplaceSectionJob } from './music-studio';
import { runReferencePackJob } from './reference-pack';
import { runScreenReplaceJob } from './screen-replace';
import { startStemsJob, watchStemsJob } from './stems';
import { runAnalyzeSubjectsJob } from './subjects';
import { afterRenderCompleted } from './after-render';
import { advanceProduction } from '../lib/production';
import { runNarrationTranscribeJob } from './narration';
import { runAdValidateJob } from './ad-validate';
import { assertProviderAvailable, recoverFromFailure, usesSlot } from './recovery';

async function startJob(jobId: string, seq: number): Promise<void> {
  const claimed = await claimJob(jobId);
  if (!claimed) return;
  if (claimed.cancelRequested) {
    await cancelJobDoc(claimed);
    return;
  }
  // Access, billing or quota problems pause automatic work: nothing is sent to Google until they change.
  await assertProviderAvailable(claimed);
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
    case 'reference.pack':
      try {
        await runReferencePackJob(claimed);
      } finally {
        await releaseSlot(claimed.ownerUid, claimed.id);
      }
      return;
    case 'continuity.compare':
      await runContinuityCompareJob(claimed);
      return;
    case 'media.screen_replace':
      await runScreenReplaceJob(claimed);
      return;
    case 'media.color_match':
      await runColorMatchJob(claimed);
      return;
    case 'media.analyze_subjects':
      await runAnalyzeSubjectsJob(claimed);
      return;
    case 'lyrics.resync_audio':
      await runLyricsResyncAudioJob(claimed);
      return;
    case 'final.inspect':
      await runFinalInspectJob(claimed);
      return;
    case 'music.analyze':
      await runMusicAnalyzeJob(claimed);
      return;
    case 'music.arrange':
      await runMusicArrangeJob(claimed);
      return;
    case 'music.mix':
      await runMusicMixJob(claimed);
      return;
    case 'music.replace_section':
      await runMusicReplaceSectionJob(claimed);
      return;
    case 'audio.stems':
      // Demucs runs as a Cloud Run job execution; polling follows its progress.
      await startStemsJob(claimed);
      return;
    case 'narration.transcribe':
      await runNarrationTranscribeJob(claimed);
      return;
    case 'ad.validate':
      await runAdValidateJob(claimed);
      return;
    default: {
      const unknown: never = claimed.type;
      await failJob(claimed, { code: 'unsupported', message: `No worker handles ${String(unknown)} jobs.`, retryable: false });
    }
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
  // A finished render (the renderer completes the job itself) gets its final-film inspection.
  if (job && job.type === 'render.timeline' && job.status === 'completed' && payload.step === 'poll') {
    await afterRenderCompleted(job);
    return;
  }
  if (!job || isTerminal(job.status)) return;
  try {
    if (payload.step === 'start') await startJob(job.id, payload.seq);
    else if (job.type === 'video.generate') await pollVideoJob(job, payload.seq);
    else if (job.type === 'render.timeline') await watchRenderJob(job, payload.seq);
    else if (job.type === 'audio.stems') await watchStemsJob(job, payload.seq);
  } catch (e) {
    // Classified, bounded recovery: retry with backoff, check the same accepted job again, repair a documented
    // configuration once, rewrite a blocked prompt once, or stop with what the director can do next.
    await recoverFromFailure(job.id, payload, e);
  }
}
