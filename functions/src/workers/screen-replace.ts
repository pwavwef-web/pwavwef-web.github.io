import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Part } from '@google/genai';
import { textOrientation, type AssetDoc, type JobDoc, type ProtectedScreenDoc } from '@az-studio/shared';
import { createAsset, withTmpDir } from '../lib/assets';
import { bucket, col } from '../lib/firebase';
import { fail } from '../lib/errors';
import { flipJpeg, regionMean, rgbStats, sampleFrames, type SampledFrame } from '../lib/frames';
import { logInteraction } from '../lib/interactions';
import { FFMPEG, probe } from '../lib/media';
import { progress, transition } from '../lib/jobs';
import { recordDerivedTake } from '../lib/takes';
import { annotateFrames } from '../lib/vision';
import { callReasoning, usageFor } from './text';
import { SCREEN_CORNERS_SCHEMA } from './text-tasks';

const execFileAsync = promisify(execFile);

export interface ScreenReplaceParams {
  sourceAssetId: string;
  storagePath: string;
  width: number | null;
  height: number | null;
  durationSec: number;
  fps: number | null;
  screen: ProtectedScreenDoc;
  content: { assetId: string; storagePath: string; kind: string; mimeType: string };
  shotId: string | null;
  parentTakeId?: string | null;
  takeLabel?: string;
}

type Pt = { x: number; y: number };
interface Corners {
  t: number;
  tl: Pt;
  tr: Pt;
  br: Pt;
  bl: Pt;
}

const ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
const clamp01 = (n: number) => Math.max(-0.2, Math.min(1.2, n));

/** Piecewise-linear expression of a value over the frame number `in` (held before the first and after the last key). */
export function frameExpr(keys: { f: number; v: number }[]): string {
  if (!keys.length) return '0';
  const fmt = (n: number) => (Math.round(n * 100) / 100).toString();
  let expr = fmt(keys[keys.length - 1]!.v);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    const slope = b.f > a.f ? (b.v - a.v) / (b.f - a.f) : 0;
    expr = `if(lt(in,${b.f}),${fmt(a.v)}+(in-${a.f})*${Math.round(slope * 100000) / 100000},${expr})`;
  }
  return `if(lt(in,${keys[0]!.f}),${fmt(keys[0]!.v)},${expr})`;
}

/** Median of each coordinate over a window of three detections (removes single-frame jitter). */
export function smoothCorners(track: Corners[]): Corners[] {
  const keys = ['tl', 'tr', 'br', 'bl'] as const;
  return track.map((c, i) => {
    const win = track.slice(Math.max(0, i - 1), Math.min(track.length, i + 2));
    const med = (vals: number[]) => [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)]!;
    const out = { ...c };
    for (const k of keys) out[k] = { x: med(win.map((w) => w[k].x)), y: med(win.map((w) => w[k].y)) };
    return out;
  });
}

/** Spans (s) where the surface is tracked; gaps longer than a second hide the composite. */
export function visibleSpans(track: Corners[], durationSec: number, step: number): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const c of track) {
    const last = spans[spans.length - 1];
    if (last && c.t - last.end <= Math.max(1, step * 1.6)) last.end = c.t;
    else spans.push({ start: c.t, end: c.t });
  }
  return spans.map((s) => ({ start: Math.max(0, s.start - step / 2), end: Math.min(durationSec, s.end + step / 2) }));
}

async function locateCorners(job: JobDoc, screen: ProtectedScreenDoc, frames: SampledFrame[]): Promise<Corners[]> {
  const parts: Part[] = [];
  frames.forEach((f, i) => {
    parts.push({ text: `Frame ${i} (t = ${f.t.toFixed(2)} s):` });
    parts.push({ inlineData: { data: f.jpeg.toString('base64'), mimeType: 'image/jpeg' } });
  });
  const hint = screen.corners ? ` In a static shot it sits near: top-left (${screen.corners[0].x.toFixed(2)}, ${screen.corners[0].y.toFixed(2)}), top-right (${screen.corners[1].x.toFixed(2)}, ${screen.corners[1].y.toFixed(2)}), bottom-right (${screen.corners[2].x.toFixed(2)}, ${screen.corners[2].y.toFixed(2)}), bottom-left (${screen.corners[3].x.toFixed(2)}, ${screen.corners[3].y.toFixed(2)}).` : '';
  parts.push({
    text: `Locate the flat surface “${screen.name}” (${screen.surface}${screen.notes ? `; ${screen.notes}` : ''}) in every labelled frame.${hint} Return the four corners of its display or printed area as fractions of the frame (x from the left edge, y from the top edge): tl = the corner nearest the top-left of the frame, then tr, br, bl clockwise. Mark visible = false when the surface is not in the frame, and occluded = true when something covers part of it. Be precise to about 1% of the frame.`,
  });
  const r = await callReasoning(parts, { systemInstruction: 'You are a precise match-move tracker. Return only JSON matching the schema.', responseJsonSchema: SCREEN_CORNERS_SCHEMA }, 'MEDIUM');
  await usageFor(job, r, 'text', false);
  await logInteraction({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: r.modelId, api: 'generateContent', request: { task: 'screen_corner_tracking', screenId: screen.id, frames: frames.length }, response: { usage: r.res.usageMetadata ?? null }, latencyMs: r.latencyMs });
  const json = (r.json ?? {}) as { frames?: { index?: number; visible?: boolean; tl?: Pt; tr?: Pt; br?: Pt; bl?: Pt; confidence?: number }[] };
  const ok = (p?: Pt) => Boolean(p && Number.isFinite(p.x) && Number.isFinite(p.y));
  return (json.frames ?? [])
    .filter((f) => f.visible && (f.confidence ?? 0.6) >= 0.45 && ok(f.tl) && ok(f.tr) && ok(f.br) && ok(f.bl) && typeof f.index === 'number' && frames[f.index])
    .map((f) => ({ t: frames[f.index!]!.t, tl: { x: clamp01(f.tl!.x), y: clamp01(f.tl!.y) }, tr: { x: clamp01(f.tr!.x), y: clamp01(f.tr!.y) }, br: { x: clamp01(f.br!.x), y: clamp01(f.br!.y) }, bl: { x: clamp01(f.bl!.x), y: clamp01(f.bl!.y) } }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Protected screens: generated video models draw text and interfaces unreliably (often mirrored). The
 * approved content is tracked onto the surface instead — corners located on sampled frames, smoothed,
 * warped with a per-frame perspective, brightness-matched, softened and composited — and the result is
 * read back with OCR as filmed and mirrored.
 */
export async function runScreenReplaceJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as ScreenReplaceParams;
  if (!job.projectId) fail('invalid_request', 'Screen replacement needs a project.');
  if (!(await transition(job.id, 'generating', { stage: `Tracking “${p.screen.name}”`, progress: 0.08, lease: { until: Date.now() + 20 * 60_000 } }))) return;
  const usage = { uid: job.ownerUid, projectId: job.projectId, jobId: job.id };
  const src = { id: p.sourceAssetId, ...(await col.assets().doc(p.sourceAssetId).get()).data() } as AssetDoc;
  if (!src.storagePath) fail('not_found', 'The clip no longer exists.');
  const newId = col.assets().doc().id;
  const storagePath = `users/${job.ownerUid}/generated/${job.id}/${newId}.mp4`;
  const out = await withTmpDir(async (dir) => {
    const local = path.join(dir, 'source.mp4');
    const contentLocal = path.join(dir, `content${path.extname(p.content.storagePath) || '.png'}`);
    await Promise.all([bucket.file(src.storagePath).download({ destination: local }), bucket.file(p.content.storagePath).download({ destination: contentLocal })]);
    const info = await probe(local);
    const D = info.durationSec ?? p.durationSec;
    const W = info.width ?? p.width ?? 1280;
    const H = info.height ?? p.height ?? 720;
    const F = Math.round(info.fps ?? p.fps ?? 24);
    const step = 0.5;
    const frames = await sampleFrames(local, { durationSec: D, fps: 1 / step, width: 768, srcWidth: W, srcHeight: H, max: 30 });
    await progress(job.id, `Locating the corners of “${p.screen.name}” in ${frames.length} frames`, 0.2);
    let track = smoothCorners(await locateCorners(job, p.screen, frames));
    let source = 'tracked';
    if (track.length < 2 && p.screen.corners) {
      // A static shot with the director's corner placement.
      const [tl, tr, br, bl] = p.screen.corners;
      track = [{ t: 0, tl, tr, br, bl }, { t: D, tl, tr, br, bl }];
      source = 'director_corners';
    }
    if (track.length < 2) fail('not_found', `“${p.screen.name}” could not be located in the shot, so nothing was composited. Set its corners in the Continuity panel (static shots) or regenerate the shot with the surface clearly visible.`);
    const spans = source === 'tracked' ? visibleSpans(track, D, step) : [{ start: 0, end: D }];

    // Brightness of the surface as filmed vs the approved content (screens are emissive; keep the scene's level).
    const lumas: number[] = [];
    for (const c of track.slice(0, 8)) {
      const f = frames.reduce((best, x) => (Math.abs(x.t - c.t) < Math.abs(best.t - c.t) ? x : best), frames[0]!);
      const xs = [c.tl.x, c.tr.x, c.br.x, c.bl.x];
      const ys = [c.tl.y, c.tr.y, c.br.y, c.bl.y];
      const box = { x: Math.max(0, Math.min(...xs)), y: Math.max(0, Math.min(...ys)), w: Math.min(1, Math.max(...xs)) - Math.max(0, Math.min(...xs)), h: Math.min(1, Math.max(...ys)) - Math.max(0, Math.min(...ys)) };
      if (box.w > 0.01 && box.h > 0.01) {
        const m = await regionMean(f.jpeg, box).catch(() => null);
        if (m) lumas.push(0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]);
      }
    }
    const contentStats = await rgbStats(contentLocal, p.content.kind === 'image' ? { isImage: true } : { fps: 1 });
    const contentLuma = contentStats ? 0.2126 * contentStats.mean[0] + 0.7152 * contentStats.mean[1] + 0.0722 * contentStats.mean[2] : 128;
    const surfaceLuma = lumas.length ? lumas.reduce((a, b) => a + b, 0) / lumas.length : contentLuma;
    const gain = Math.max(0.55, Math.min(1.25, surfaceLuma / Math.max(1, contentLuma)));

    // Per-frame corners in output pixels (perspective: x0/y0 top-left, x1/y1 top-right, x2/y2 bottom-left, x3/y3 bottom-right).
    const key = (pick: (c: Corners) => number, scale: number) => frameExpr(track.map((c) => ({ f: Math.round(c.t * F), v: pick(c) * scale })));
    const persp = [
      `x0='${key((c) => c.tl.x, W)}'`,
      `y0='${key((c) => c.tl.y, H)}'`,
      `x1='${key((c) => c.tr.x, W)}'`,
      `y1='${key((c) => c.tr.y, H)}'`,
      `x2='${key((c) => c.bl.x, W)}'`,
      `y2='${key((c) => c.bl.y, H)}'`,
      `x3='${key((c) => c.br.x, W)}'`,
      `y3='${key((c) => c.br.y, H)}'`,
    ].join(':');
    const enable = spans.map((s) => `between(t,${s.start.toFixed(2)},${s.end.toFixed(2)})`).join('+');
    const g = gain.toFixed(3);
    const filter = [
      `[1:v]fps=${F},scale=${W - 4}:${H - 4},format=rgba,lutrgb=r='clip(val*${g},0,255)':g='clip(val*${g},0,255)':b='clip(val*${g},0,255)',colorchannelmixer=aa=0.94,format=yuva444p,pad=${W}:${H}:2:2:color=black@0,perspective=${persp}:sense=destination:eval=frame,gblur=sigma=0.6[w]`,
      `[0:v][w]overlay=0:0:format=auto:enable='${enable}',format=yuv420p[v]`,
    ].join(';');
    const contentArgs = p.content.kind === 'image' ? ['-loop', '1', '-framerate', String(F), '-t', String(D), '-i', contentLocal] : ['-stream_loop', '-1', '-t', String(D), '-i', contentLocal];
    const outLocal = path.join(dir, 'composited.mp4');
    await progress(job.id, 'Compositing the approved content onto the surface', 0.5);
    await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', local, ...contentArgs, '-filter_complex', filter, '-map', '[v]', '-map', '0:a?', '-c:a', 'copy', '-t', String(D), ...ENCODE, outLocal], { timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });

    // Read the result back: the expected text must read correctly as filmed (and not only when mirrored).
    await progress(job.id, 'Reading the composited surface back with OCR', 0.75);
    const checks: { t: number; verdict: string; normal: number; flipped: number }[] = [];
    if (p.screen.expectedText.trim()) {
      const times = spans.flatMap((s) => [s.start + (s.end - s.start) * 0.25, s.start + (s.end - s.start) * 0.75]).slice(0, 4);
      const outFrames = (await sampleFrames(outLocal, { durationSec: D, fps: 2, width: 1024, srcWidth: W, srcHeight: H, max: 24 })).filter((f) => times.some((t) => Math.abs(f.t - t) < 0.3)).slice(0, 4);
      const normal = await annotateFrames({ frames: outFrames, features: ['TEXT_DETECTION'], usage });
      const flipped = await annotateFrames({ frames: await Promise.all(outFrames.map(async (f) => ({ ...f, jpeg: await flipJpeg(f.jpeg) }))), features: ['TEXT_DETECTION'], usage });
      normal.forEach((n, i) => {
        const o = textOrientation(p.screen.expectedText, n.fullText, flipped[i]?.fullText ?? '');
        checks.push({ t: n.t, verdict: o.verdict, normal: o.normal, flipped: o.flipped });
      });
    }
    await bucket.upload(outLocal, { destination: storagePath, resumable: false, metadata: { contentType: 'video/mp4', cacheControl: 'private, max-age=31536000', metadata: { jobId: job.id, op: 'screen_replace' } } });
    await createAsset({
      uid: job.ownerUid,
      assetId: newId,
      projectId: job.projectId,
      kind: 'video',
      source: 'derived',
      title: `${src.title} — ${p.screen.name} composited`,
      fileName: `${newId}.mp4`,
      mimeType: 'video/mp4',
      storagePath,
      localFile: outLocal,
      dir,
      collections: src.collections ?? [],
      derivedFrom: { assetId: src.id },
      ...(src.generation ? { generation: { ...src.generation, jobId: job.id, parentAssetId: src.id, params: { ...src.generation.params, screenComposite: { screenId: p.screen.id, contentAssetId: p.content.assetId } }, provenance: { ...src.generation.provenance, c2pa: 'absent' } } } : {}),
    });
    return { tracked: track.length, source, spans, gain, checks };
  });
  let takeId: string | null = null;
  if (p.shotId) takeId = await recordDerivedTake({ projectId: job.projectId!, shotId: p.shotId, jobId: job.id, assetId: newId, prompt: `Approved content composited onto “${p.screen.name}”`, params: { repair: 'screen_composite', screenId: p.screen.id }, parentTakeId: p.parentTakeId ?? null, takeLabel: p.takeLabel ?? 'screen composited', productionId: job.productionId ?? null });
  const readable = out.checks.length ? out.checks.filter((c) => c.verdict === 'correct').length : null;
  await transition(
    job.id,
    'completed',
    {
      stage: `“${p.screen.name}” composited (${out.source === 'tracked' ? `tracked on ${out.tracked} frames` : 'director’s corners'})${readable === null ? '' : ` · OCR reads it correctly in ${readable} of ${out.checks.length} checks`}`,
      result: { assetIds: [newId], data: { takeId, tracked: out.tracked, source: out.source, spans: out.spans, gain: out.gain, ocr: out.checks } },
    },
    { assetId: newId },
  );
}
