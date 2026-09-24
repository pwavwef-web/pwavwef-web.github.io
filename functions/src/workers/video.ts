import { logger } from 'firebase-functions';
import { toMillis, type JobDoc } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { OMNI_POLL } from '../config/runtime';
import { applyTarget, createAsset, withTmpDir } from '../lib/assets';
import { bucket, col, gsUri, pathFromGsUri } from '../lib/firebase';
import { isSafetyMessage, JobFailure } from '../lib/errors';
import { logInteraction } from '../lib/interactions';
import { cancelJobDoc, enqueueJob, failJob, getJob, progress, transition } from '../lib/jobs';
import { releaseSlot } from '../lib/concurrency';
import { recordUsage } from '../lib/usage';
import { genai } from '../lib/vertex';
import type { PreparedMedia } from '../lib/prepare';

export interface VideoParams {
  mode: 'generate' | 'edit' | 'extend';
  task: string | null;
  aspectRatio: string | null;
  resolution: string;
  resolutionExplicit: boolean;
  durationSec: number | null;
  prompt: string;
  promptBody: string;
  media: PreparedMedia[];
  previousInteractionId: string | null;
  chainFallback: string | null;
  title: string | null;
}

type InteractionLike = {
  id: string;
  status: string;
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_thought_tokens?: number;
    output_tokens_by_modality?: { modality?: string; tokens?: number }[];
  };
  steps?: { type?: string; content?: { type?: string; uri?: string; data?: string; mime_type?: string; text?: string }[]; summary?: { text?: string }[] }[];
  errors?: { code?: number | string; message?: string }[];
  output_text?: string;
};

/** Builds the Interactions API request. Only documented fields are sent; unset options are omitted. */
export function buildInteractionRequest(p: VideoParams, outputPrefix: string) {
  const content: Record<string, unknown>[] = [{ type: 'text', text: p.prompt }];
  for (const m of p.media) content.push({ type: m.kind, uri: gsUri(m.storagePath), mime_type: m.mimeType });
  const responseFormat: Record<string, unknown> = { type: 'video', delivery: 'uri', gcs_uri: gsUri(outputPrefix) };
  if (p.aspectRatio) responseFormat.aspect_ratio = p.aspectRatio;
  if (p.resolution) responseFormat.resolution = p.resolution;
  if (p.durationSec) responseFormat.duration = `${p.durationSec}s`;
  return {
    model: MODEL_REGISTRY.video.id,
    background: true,
    store: true,
    input: [{ type: 'user_input', content }],
    response_format: [responseFormat],
    ...(p.task ? { generation_config: { video_config: { task: p.task } } } : {}),
    ...(p.previousInteractionId ? { previous_interaction_id: p.previousInteractionId } : {}),
  };
}

function expectedSeconds(p: VideoParams): number {
  const base = 70 + (p.durationSec ?? 6) * 6;
  const resFactor: Record<string, number> = { '360p': 0.8, '720p': 1, '1080p': 1.5, '4k': 2.4 };
  return base * (resFactor[p.resolution] ?? 1) * (p.mode === 'generate' ? 1 : 1.3);
}

export async function startVideoJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as VideoParams;
  const outputPrefix = `users/${job.ownerUid}/generated/${job.id}/`;
  const body = buildInteractionRequest(p, outputPrefix);
  if (!(await transition(job.id, 'generating', { stage: 'Submitting to Gemini Omni', progress: 0.05, lease: { until: Date.now() + 5 * 60_000 } }))) return;
  const started = Date.now();
  // Interactions API types are broad; the body above follows the Vertex AI REST reference exactly.
  const created = (await genai().interactions.create(body as never)) as unknown as InteractionLike;
  await transition(
    job.id,
    'generating',
    { stage: 'Gemini Omni is generating', progress: 0.1, external: { interactionId: created.id, pollCount: 0 }, lease: null },
    { interactionId: created.id },
  );
  await logInteraction({
    uid: job.ownerUid,
    projectId: job.projectId,
    jobId: job.id,
    modelId: MODEL_REGISTRY.video.id,
    api: 'interactions',
    interactionId: created.id,
    request: { ...body, input: [{ type: 'user_input', content: [{ type: 'text', text: p.prompt }, ...p.media.map((m) => ({ type: m.kind, role: m.role, assetId: m.assetId }))] }] },
    response: { status: created.status },
    latencyMs: Date.now() - started,
  });
  await enqueueJob(job.id, 'poll', { delaySec: OMNI_POLL.firstDelaySec, seq: 1 });
}

function failureFrom(it: InteractionLike): JobFailure {
  // Only what the model said: the echoed prompt (a user_input step) must not be read as a safety message.
  const modelSteps = (it.steps ?? []).filter((s) => s.type === 'model_output');
  const messages = [...(it.errors ?? []).map((e) => e.message ?? ''), it.output_text ?? '', ...modelSteps.flatMap((s) => (s.content ?? []).map((c) => c.text ?? ''))].filter(Boolean).join(' ');
  if (/unable to process speech edits/i.test(messages)) {
    return new JobFailure({ code: 'speech_edit_unsupported', message: 'Gemini Omni cannot edit or extend speech in a re-sent video. Only a take generated in AZ Studio within the last 7 days can be continued with dialogue — regenerate the scene instead.', retryable: false, details: messages.slice(0, 600) });
  }
  if (isSafetyMessage(messages)) {
    return new JobFailure({ code: 'safety_blocked', message: 'Google’s safety filters rejected this video request. Adjust the prompt or references and try again.', retryable: false, safety: true, details: messages.slice(0, 600) });
  }
  const status = it.status;
  return new JobFailure({
    code: status === 'budget_exceeded' ? 'budget_exceeded' : status === 'incomplete' ? 'incomplete' : 'omni_failed',
    message: `Gemini Omni ${status === 'cancelled' ? 'cancelled' : 'did not finish'} the video (${status}).${messages ? ` ${messages.slice(0, 300)}` : ''}`,
    retryable: false,
    details: messages.slice(0, 600),
  });
}

export async function pollVideoJob(job: JobDoc, seq: number): Promise<void> {
  const interactionId = job.external?.interactionId;
  if (job.status !== 'generating' || !interactionId) return;
  const p = job.params as unknown as VideoParams;
  const ai = genai();

  if (job.cancelRequested) {
    try {
      await ai.interactions.cancel(interactionId);
    } catch (e) {
      logger.warn('omni cancel failed', { jobId: job.id, error: String(e) });
    }
    await cancelJobDoc(job, 'Cancelled — Omni may still bill for work already done');
    return;
  }

  const it = (await ai.interactions.get(interactionId)) as unknown as InteractionLike;
  const startedMs = toMillis(job.startedAt as never) ?? Date.now();
  const elapsed = (Date.now() - startedMs) / 1000;

  if (it.status === 'in_progress' || it.status === 'queued' || it.status === 'requires_action') {
    if (elapsed > OMNI_POLL.maxWaitMinutes * 60) {
      try {
        await ai.interactions.cancel(interactionId);
      } catch {
        /* best effort */
      }
      await failJob(job, { code: 'timeout', message: `Gemini Omni did not finish within ${OMNI_POLL.maxWaitMinutes} minutes. The request was cancelled.`, retryable: false });
      return;
    }
    const pollCount = (job.external?.pollCount ?? 0) + 1;
    const est = expectedSeconds(p);
    const pct = Math.min(0.9, 0.1 + 0.8 * (1 - Math.exp(-elapsed / est)));
    await progress(job.id, `Gemini Omni is generating · ${Math.floor(elapsed / 60)}m ${Math.round(elapsed % 60)}s`, pct, { external: { interactionId, pollCount } });
    const delay = pollCount > OMNI_POLL.slowAfterPolls ? OMNI_POLL.slowIntervalSec : OMNI_POLL.intervalSec;
    await enqueueJob(job.id, 'poll', { delaySec: delay, seq: seq + 1 });
    return;
  }

  if (it.status !== 'completed') throw failureFrom(it);

  // Completed: locate the output video.
  const output = (it.steps ?? []).filter((s) => s.type === 'model_output').flatMap((s) => s.content ?? []).find((c) => c.type === 'video' && (c.uri || c.data));
  if (!output) throw failureFrom({ ...it, status: 'completed without video' });
  if (!(await transition(job.id, 'downloading', { stage: 'Saving video', progress: 0.92 }))) return;

  const modelText = (it.steps ?? [])
    .filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('\n')
    .trim();

  const assetId = await withTmpDir(async (dir) => {
    const newId = col.assets().doc().id;
    let storagePath: string;
    if (output.uri) {
      const pathInBucket = pathFromGsUri(output.uri);
      if (!pathInBucket) throw new JobFailure({ code: 'unexpected_output', message: `Omni wrote the video outside the studio bucket (${output.uri}).`, retryable: false });
      storagePath = pathInBucket;
    } else {
      storagePath = `users/${job.ownerUid}/generated/${job.id}/${newId}.mp4`;
      await bucket.file(storagePath).save(Buffer.from(output.data!, 'base64'), { contentType: 'video/mp4', resumable: false });
    }
    const local = `${dir}/video.mp4`;
    await bucket.file(storagePath).download({ destination: local });
    return createAsset({
      uid: job.ownerUid,
      assetId: newId,
      projectId: job.projectId,
      kind: 'video',
      source: 'generated',
      title: p.title ?? p.promptBody.slice(0, 80),
      fileName: storagePath.split('/').pop() ?? `${newId}.mp4`,
      mimeType: output.mime_type ?? 'video/mp4',
      storagePath,
      localFile: local,
      dir,
      generation: {
        jobId: job.id,
        modelId: MODEL_REGISTRY.video.id,
        prompt: p.prompt,
        params: { mode: p.mode, task: p.task, aspectRatio: p.aspectRatio, resolution: p.resolution, durationSec: p.durationSec },
        interactionId,
        ...(job.target?.kind === 'chain' ? { chainId: job.target.id, turnId: job.target.sub } : {}),
        ...(p.media.find((m) => m.role === 'source_video') ? { parentAssetId: p.media.find((m) => m.role === 'source_video')!.assetId } : {}),
      },
    });
  });

  const byModality = Object.fromEntries((it.usage?.output_tokens_by_modality ?? []).map((m) => [String(m.modality ?? 'unknown').toLowerCase(), Number(m.tokens ?? 0)]));
  const cost = await recordUsage({
    uid: job.ownerUid,
    projectId: job.projectId,
    jobId: job.id,
    modelId: MODEL_REGISTRY.video.id,
    kind: 'video',
    inputTokens: it.usage?.total_input_tokens ?? 0,
    outputTokens: it.usage?.total_output_tokens ?? 0,
    thoughtTokens: it.usage?.total_thought_tokens ?? 0,
    outputByModality: byModality,
  });
  await applyTarget(job.projectId, job.target, assetId);
  await logInteraction({
    uid: job.ownerUid,
    projectId: job.projectId,
    jobId: job.id,
    modelId: MODEL_REGISTRY.video.id,
    api: 'interactions',
    interactionId,
    request: { poll: true },
    response: { status: it.status, usage: it.usage ?? null, assetId, costUsd: cost, text: modelText.slice(0, 2000) },
    latencyMs: Math.round(elapsed * 1000),
  });
  await transition(job.id, 'completed', { stage: 'Done', result: { assetIds: [assetId], interactionId, ...(modelText ? { text: modelText.slice(0, 2000) } : {}) } }, { assetId, interactionId });
  await releaseSlot(job.ownerUid, job.id);
}

/** Used by maintenance: resumes polling for generating Omni jobs whose poll chain was lost. */
export async function ensurePolling(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (job?.status === 'generating' && job.external?.interactionId) await enqueueJob(jobId, 'poll', { delaySec: 5, seq: (job.external.pollCount ?? 0) + 1000 });
}
