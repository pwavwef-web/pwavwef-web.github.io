import { Modality, type GenerateContentResponse, type Part } from '@google/genai';
import type { JobDoc } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { applyTarget, createAsset, saveBufferToFile, withTmpDir } from '../lib/assets';
import { bucket, col, gsUri } from '../lib/firebase';
import { GenerationFailure, JobFailure, providerFailure } from '../lib/errors';
import { classifyBlockedResponse } from '../lib/provider-errors';
import { afterSceneGenerated } from '../lib/ads';
import { noteSubmission } from './recovery';
import { logInteraction } from '../lib/interactions';
import { progress, transition } from '../lib/jobs';
import { recordUsage } from '../lib/usage';
import { genai } from '../lib/vertex';

interface ImageRef {
  assetId: string;
  storagePath: string;
  mimeType: string;
  title?: string;
}

export interface ImageParams {
  mode: 'generate' | 'edit';
  purpose: string;
  prompt: string;
  promptBody: string;
  aspectRatio: string;
  imageSize: string;
  source: ImageRef | null;
  references: ImageRef[];
  grounding: boolean;
  collections: string[];
  characterIds: string[];
  title: string | null;
}

export const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export function buildImageParts(p: ImageParams): Part[] {
  const parts: Part[] = [];
  if (p.source) parts.push({ fileData: { fileUri: gsUri(p.source.storagePath), mimeType: p.source.mimeType } });
  for (const r of p.references) parts.push({ fileData: { fileUri: gsUri(r.storagePath), mimeType: r.mimeType } });
  const refNote = p.references.length
    ? `Reference images (in order after ${p.source ? 'the image to edit' : 'this note'}): ${p.references.map((r, i) => `${i + 1}. ${r.title ?? 'reference'}`).join('; ')}.\n`
    : '';
  const text = p.mode === 'edit' ? `Edit the first image. ${p.prompt}\nKeep everything that is not mentioned unchanged.` : p.prompt;
  parts.push({ text: `${refNote}${text}` });
  return parts;
}

export function extractImage(res: GenerateContentResponse): { data: string; mimeType: string; text: string } {
  const ctx = { modelId: MODEL_REGISTRY.image.id, what: 'image', surface: 'vertex' as const };
  const block = res.promptFeedback?.blockReason;
  if (block) throw new GenerationFailure(classifyBlockedResponse({ blockReason: String(block), blockMessage: res.promptFeedback?.blockReasonMessage ?? null }, ctx));
  const cand = res.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const text = parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('\n')
    .trim();
  const image = parts.find((p) => !p.thought && p.inlineData?.data && (p.inlineData.mimeType ?? '').startsWith('image/'));
  if (!image?.inlineData?.data) {
    // Read Google's finish reason: a policy stop, an unsupported language, or an unexplained empty answer.
    throw new GenerationFailure(classifyBlockedResponse({ finishReason: cand?.finishReason ? String(cand.finishReason) : null, finishMessage: cand?.finishMessage ?? null, text }, ctx));
  }
  return { data: image!.inlineData!.data!, mimeType: image!.inlineData!.mimeType ?? 'image/png', text };
}

export async function runImageJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as ImageParams;
  const model = MODEL_REGISTRY.image.id;
  const parts = buildImageParts(p);
  if (!(await transition(job.id, 'generating', { stage: 'Nano Banana Pro is composing the image', progress: 0.15, lease: { until: Date.now() + 9 * 60_000 } }))) return;

  const started = Date.now();
  await noteSubmission(job);
  let res: GenerateContentResponse;
  try {
    res = await genai().models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
        imageConfig: { aspectRatio: p.aspectRatio, imageSize: p.imageSize },
        ...(p.grounding ? { tools: [{ googleSearch: {} }] } : {}),
      },
    });
  } catch (e) {
    throw providerFailure(e, { modelId: model, what: 'image', surface: 'vertex' });
  }
  const latencyMs = Date.now() - started;
  const usage = res.usageMetadata;
  const imageTokens = usage?.candidatesTokensDetails?.find((d) => String(d.modality) === 'IMAGE')?.tokenCount ?? 0;

  let image: ReturnType<typeof extractImage>;
  try {
    image = extractImage(res);
  } catch (e) {
    if (e instanceof JobFailure && usage) {
      // Blocked outputs still report usage; record it so estimates stay honest.
      await recordUsage({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: model, kind: 'image', inputTokens: usage.promptTokenCount ?? 0, outputTokens: usage.candidatesTokenCount ?? 0, thoughtTokens: usage.thoughtsTokenCount ?? 0, outputByModality: { image: imageTokens } });
    }
    await logInteraction({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: model, api: 'generateContent', request: { prompt: p.prompt, aspectRatio: p.aspectRatio, imageSize: p.imageSize, references: parts.length - 1 }, response: { finishReason: res.candidates?.[0]?.finishReason ?? null, blockReason: res.promptFeedback?.blockReason ?? null, usage: usage ?? null }, latencyMs });
    throw e;
  }

  await transition(job.id, 'downloading', { stage: 'Saving image', progress: 0.85 });
  const assetId = await withTmpDir(async (dir) => {
    const ext = IMAGE_EXT[image.mimeType] ?? 'png';
    const buf = Buffer.from(image.data, 'base64');
    const local = await saveBufferToFile(dir, `image.${ext}`, buf);
    const newId = col.assets().doc().id;
    const storagePath = `users/${job.ownerUid}/generated/${job.id}/${newId}.${ext}`;
    // Original bytes are stored unmodified so the embedded C2PA manifest is preserved.
    await bucket.file(storagePath).save(buf, { contentType: image.mimeType, resumable: false, metadata: { cacheControl: 'private, max-age=31536000', metadata: { jobId: job.id, modelId: model } } });
    return createAsset({
      uid: job.ownerUid,
      assetId: newId,
      projectId: job.projectId,
      kind: 'image',
      source: 'generated',
      title: p.title ?? p.promptBody.slice(0, 80),
      fileName: `${newId}.${ext}`,
      mimeType: image.mimeType,
      storagePath,
      localFile: local,
      dir,
      collections: p.collections,
      generation: {
        jobId: job.id,
        modelId: model,
        prompt: p.prompt,
        params: { aspectRatio: p.aspectRatio, imageSize: p.imageSize, purpose: p.purpose, mode: p.mode, grounding: p.grounding },
        ...(job.target?.kind === 'chain' ? { chainId: job.target.id, turnId: job.target.sub } : {}),
        ...(p.source ? { parentAssetId: p.source.assetId } : {}),
      },
    });
  });

  const cost = await recordUsage({
    uid: job.ownerUid,
    projectId: job.projectId,
    jobId: job.id,
    modelId: model,
    kind: 'image',
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    thoughtTokens: usage?.thoughtsTokenCount ?? 0,
    outputByModality: { image: imageTokens },
  });
  await applyTarget(job.projectId, job.target, assetId, p.purpose);
  await logInteraction({
    uid: job.ownerUid,
    projectId: job.projectId,
    jobId: job.id,
    modelId: model,
    api: 'generateContent',
    request: { prompt: p.prompt, aspectRatio: p.aspectRatio, imageSize: p.imageSize, references: parts.length - 1, grounding: p.grounding },
    response: { finishReason: res.candidates?.[0]?.finishReason ?? null, text: image.text.slice(0, 2000), usage: usage ?? null, modelVersion: res.modelVersion ?? null, assetId, costUsd: cost },
    latencyMs,
  });
  await progress(job.id, 'Finishing', 0.95);
  await transition(job.id, 'completed', { stage: 'Done', result: { assetIds: [assetId], ...(image.text ? { text: image.text.slice(0, 2000) } : {}) } }, { assetId });
  await afterSceneGenerated(job, assetId);
}
