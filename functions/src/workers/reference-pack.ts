import { Modality, type Part } from '@google/genai';
import { emptySetBible, SET_VIEW_LABELS, type JobDoc, type SetBibleDoc, type SetView } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { createAsset, saveBufferToFile, withTmpDir } from '../lib/assets';
import { bucket, col, db, FieldValue, gsUri } from '../lib/firebase';
import { JobFailure } from '../lib/errors';
import { logInteraction } from '../lib/interactions';
import { progress, transition } from '../lib/jobs';
import { recordUsage } from '../lib/usage';
import { genai } from '../lib/vertex';
import { extractImage, IMAGE_EXT } from './image';

interface ReferencePackParams {
  locationId: string;
  anchorAssetId: string | null;
  views: { view: SetView; prompt: string }[];
  imageSize: string;
  aspectRatio: string;
  locationName: string;
}

/**
 * Set Bible reference pack (Nano Banana Pro): the wide view first (or the existing anchor), then every
 * other view generated with it as the reference so the set stays one coherent room. The views are
 * proposed to the director (status “pending approval”); nothing is locked until they approve them.
 */
export async function runReferencePackJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as ReferencePackParams;
  if (!job.projectId) throw new JobFailure({ code: 'invalid_request', message: 'A reference pack needs a project.', retryable: false });
  if (!(await transition(job.id, 'generating', { stage: `Designing ${p.views.length} view${p.views.length === 1 ? '' : 's'} of ${p.locationName}`, progress: 0.05, lease: { until: Date.now() + 25 * 60_000 } }))) return;
  const model = MODEL_REGISTRY.image.id;
  let anchor: { storagePath: string; mimeType: string } | null = null;
  if (p.anchorAssetId) {
    const a = await col.assets().doc(p.anchorAssetId).get();
    if (a.exists && a.get('status') === 'ready') anchor = { storagePath: String(a.get('storagePath')), mimeType: String(a.get('mimeType')) };
  }
  const created: Partial<Record<SetView, string>> = {};
  const failures: string[] = [];
  let totalCost = 0;
  // The wide view anchors the rest, so it is generated first.
  const ordered = [...p.views].sort((a, b) => Number(b.view === 'wide') - Number(a.view === 'wide'));
  for (const [i, v] of ordered.entries()) {
    await progress(job.id, `Generating the ${SET_VIEW_LABELS[v.view].toLowerCase()} (${i + 1} of ${ordered.length})`, 0.08 + (0.8 * i) / ordered.length);
    const parts: Part[] = [];
    if (anchor) parts.push({ fileData: { fileUri: gsUri(anchor.storagePath), mimeType: anchor.mimeType } });
    parts.push({ text: `${anchor ? 'Reference image 1: the approved view of this set — the same room.\n' : ''}${v.prompt}` });
    const started = Date.now();
    try {
      const res = await genai().models.generateContent({ model, contents: [{ role: 'user', parts }], config: { responseModalities: [Modality.TEXT, Modality.IMAGE], imageConfig: { aspectRatio: p.aspectRatio, imageSize: p.imageSize } } });
      const usage = res.usageMetadata;
      const imageTokens = usage?.candidatesTokensDetails?.find((d) => String(d.modality) === 'IMAGE')?.tokenCount ?? 0;
      totalCost += await recordUsage({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: model, kind: 'image', inputTokens: usage?.promptTokenCount ?? 0, outputTokens: usage?.candidatesTokenCount ?? 0, thoughtTokens: usage?.thoughtsTokenCount ?? 0, outputByModality: { image: imageTokens } });
      const image = extractImage(res);
      const assetId = await withTmpDir(async (dir) => {
        const ext = IMAGE_EXT[image.mimeType] ?? 'png';
        const buf = Buffer.from(image.data, 'base64');
        const local = await saveBufferToFile(dir, `view.${ext}`, buf);
        const newId = col.assets().doc().id;
        const storagePath = `users/${job.ownerUid}/generated/${job.id}/${newId}.${ext}`;
        await bucket.file(storagePath).save(buf, { contentType: image.mimeType, resumable: false, metadata: { cacheControl: 'private, max-age=31536000', metadata: { jobId: job.id, modelId: model } } });
        return createAsset({ uid: job.ownerUid, assetId: newId, projectId: job.projectId, kind: 'image', source: 'generated', title: `${p.locationName} — ${SET_VIEW_LABELS[v.view]}`, fileName: `${newId}.${ext}`, mimeType: image.mimeType, storagePath, localFile: local, dir, collections: ['set-reference'], generation: { jobId: job.id, modelId: model, prompt: v.prompt, params: { purpose: 'location', view: v.view, aspectRatio: p.aspectRatio, imageSize: p.imageSize, anchorAssetId: p.anchorAssetId } } });
      });
      created[v.view] = assetId;
      if (v.view === 'wide' && !anchor) {
        const a = await col.assets().doc(assetId).get();
        anchor = { storagePath: String(a.get('storagePath')), mimeType: String(a.get('mimeType')) };
      }
      await logInteraction({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: model, api: 'generateContent', request: { task: 'set_reference_view', view: v.view, anchored: parts.length > 1, promptChars: v.prompt.length }, response: { assetId, usage: usage ?? null, text: image.text.slice(0, 500) }, latencyMs: Date.now() - started });
    } catch (e) {
      const msg = e instanceof JobFailure ? e.jobError.message : String((e as Error)?.message ?? e);
      failures.push(`${SET_VIEW_LABELS[v.view]}: ${msg.slice(0, 200)}`);
      // Without the wide view the other views have nothing to stay consistent with.
      if (v.view === 'wide' && !anchor) throw e;
    }
  }
  if (!Object.keys(created).length) throw new JobFailure({ code: 'no_image', message: `No view was generated. ${failures.join(' ')}`, retryable: false });

  // Proposed views go into the Set Bible for approval (the canonical set is never locked automatically).
  const ref = col.sub(job.projectId, 'setBibles').doc(p.locationId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? (snap.data() as SetBibleDoc) : emptySetBible(p.locationId);
    if (cur.canonical?.status === 'locked') throw new JobFailure({ code: 'conflict', message: 'The set was locked while the pack was generating; the new views are kept in the asset library only.', retryable: false });
    tx.set(ref, { ...(snap.exists ? {} : cur), views: { ...cur.views, ...created }, canonical: { ...cur.canonical, status: 'pending_approval', packJobId: job.id }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  const ids = Object.values(created).filter((x): x is string => Boolean(x));
  await transition(job.id, 'completed', {
    stage: `${ids.length} view${ids.length === 1 ? '' : 's'} ready for approval${failures.length ? ` · ${failures.length} failed` : ''} · ≈ $${totalCost.toFixed(2)}`,
    result: { assetIds: ids, data: { views: created, failures } },
  });
}
