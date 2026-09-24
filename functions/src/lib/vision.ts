import { GoogleAuth } from 'google-auth-library';
import type { Box, VisionFrame } from '@az-studio/shared';
import { MODEL_REGISTRY, VISION_CAPABILITIES } from '../config/models';
import { PRICING } from '../config/pricing';
import { PROJECT_ID } from '../config/runtime';
import { JobFailure } from './errors';
import { recordUsage } from './usage';

/**
 * Cloud Vision on sampled frames: faces (with head pan), people/objects and text. Runs with the
 * functions' service account; images are sent inline (frames extracted by FFmpeg), never made public.
 */

export type VisionFeature = 'FACE_DETECTION' | 'OBJECT_LOCALIZATION' | 'TEXT_DETECTION' | 'LOGO_DETECTION';

let auth: GoogleAuth | null = null;

interface RawVertex {
  x?: number;
  y?: number;
}
interface RawResponse {
  faceAnnotations?: { boundingPoly?: { vertices?: RawVertex[] }; fdBoundingPoly?: { vertices?: RawVertex[] }; panAngle?: number; detectionConfidence?: number }[];
  localizedObjectAnnotations?: { name?: string; score?: number; boundingPoly?: { normalizedVertices?: RawVertex[] } }[];
  textAnnotations?: { description?: string; boundingPoly?: { vertices?: RawVertex[] } }[];
  fullTextAnnotation?: { text?: string };
  logoAnnotations?: { description?: string; score?: number; boundingPoly?: { vertices?: RawVertex[] } }[];
  error?: { message?: string };
}

function boxOf(vs: RawVertex[] | undefined, w: number, h: number, normalized: boolean): Box | null {
  if (!vs?.length) return null;
  const xs = vs.map((v) => (v.x ?? 0) / (normalized ? 1 : w));
  const ys = vs.map((v) => (v.y ?? 0) / (normalized ? 1 : h));
  const x0 = Math.max(0, Math.min(...xs));
  const y0 = Math.max(0, Math.min(...ys));
  const x1 = Math.min(1, Math.max(...xs));
  const y1 = Math.min(1, Math.max(...ys));
  return { x: Math.round(x0 * 1000) / 1000, y: Math.round(y0 * 1000) / 1000, w: Math.round((x1 - x0) * 1000) / 1000, h: Math.round((y1 - y0) * 1000) / 1000 };
}

export interface AnnotatedFrame extends VisionFrame {
  fullText: string;
  logos: { name: string; score: number; box: Box | null }[];
}

export interface AnnotateInput {
  frames: { t: number; jpeg: Buffer; width: number; height: number }[];
  features: VisionFeature[];
  /** For usage records. */
  usage?: { uid: string; projectId: string | null; jobId: string };
}

/** Annotates frames in batches (16 per request). */
export async function annotateFrames(input: AnnotateInput): Promise<AnnotatedFrame[]> {
  if (!input.frames.length) return [];
  auth ??= new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'], projectId: PROJECT_ID });
  const client = await auth.getClient();
  const out: AnnotatedFrame[] = [];
  const per = VISION_CAPABILITIES.maxImagesPerRequest;
  for (let i = 0; i < input.frames.length; i += per) {
    const batch = input.frames.slice(i, i + per);
    const res = await client.request<{ responses?: RawResponse[] }>({
      url: 'https://vision.googleapis.com/v1/images:annotate',
      method: 'POST',
      headers: { 'x-goog-user-project': PROJECT_ID },
      data: { requests: batch.map((f) => ({ image: { content: f.jpeg.toString('base64') }, features: input.features.map((type) => ({ type, maxResults: type === 'TEXT_DETECTION' ? 50 : 20 })) })) },
    });
    const responses = res.data.responses ?? [];
    batch.forEach((f, k) => {
      const r = responses[k] ?? {};
      if (r.error?.message && !responses.some((x) => !x.error)) throw new JobFailure({ code: 'vision_failed', message: `Cloud Vision could not analyse the frames: ${r.error.message}`, retryable: true });
      out.push({
        t: f.t,
        faces: (r.faceAnnotations ?? []).map((a) => ({ box: boxOf(a.fdBoundingPoly?.vertices ?? a.boundingPoly?.vertices, f.width, f.height, false)!, pan: typeof a.panAngle === 'number' ? a.panAngle : null, confidence: a.detectionConfidence ?? 0 })).filter((a) => a.box),
        people: (r.localizedObjectAnnotations ?? []).filter((o) => /^person$/i.test(o.name ?? '')).map((o) => ({ box: boxOf(o.boundingPoly?.normalizedVertices, 1, 1, true)!, score: o.score ?? 0 })).filter((o) => o.box),
        objects: (r.localizedObjectAnnotations ?? []).filter((o) => !/^person$/i.test(o.name ?? '')).map((o) => ({ name: o.name ?? '', box: boxOf(o.boundingPoly?.normalizedVertices, 1, 1, true)!, score: o.score ?? 0 })).filter((o) => o.box),
        text: (r.textAnnotations ?? []).slice(1).map((tx) => ({ text: tx.description ?? '', box: boxOf(tx.boundingPoly?.vertices, f.width, f.height, false) })),
        fullText: (r.fullTextAnnotation?.text ?? r.textAnnotations?.[0]?.description ?? '').trim(),
        logos: (r.logoAnnotations ?? []).map((l) => ({ name: l.description ?? '', score: l.score ?? 0, box: boxOf(l.boundingPoly?.vertices, f.width, f.height, false) })),
      });
    });
  }
  if (input.usage) {
    const units = input.frames.length * input.features.length;
    await recordUsage({ uid: input.usage.uid, projectId: input.usage.projectId, jobId: input.usage.jobId, modelId: MODEL_REGISTRY.vision.id, kind: 'vision', inputTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsdOverride: Math.round(((units * (PRICING.vision?.perThousandUnits ?? 1.5)) / 1000) * 1e6) / 1e6, countJob: false });
  }
  return out;
}
