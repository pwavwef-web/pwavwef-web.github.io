import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { Storage } from '@google-cloud/storage';
import { dayKey, monthKey, safeFileName, type Clip, type JobStatus, type Track } from '@az-studio/shared';
import { buildAudioMix, buildSegment, concatList, muxArgs, planSegments, type RenderAssetInfo, type RenderSnapshot } from './graph';

const RENDER_ID = process.env.RENDER_ID ?? '';
const JOB_ID = process.env.JOB_ID ?? '';
const DATABASE = process.env.AZS_FIRESTORE_DATABASE ?? 'az-studio';
const BUCKET = process.env.AZS_MEDIA_BUCKET ?? 'az-studio-media-az-learner';
const MEDIA_ROOT = process.env.MEDIA_ROOT ?? '/media';
const FONTS_DIR = process.env.FONTS_DIR ?? '/app/fonts';
const WORK = process.env.WORK_DIR ?? '/tmp/render';
const FFMPEG = process.env.FFMPEG_BIN ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN ?? 'ffprobe';

const app = getApps()[0] ?? initializeApp();
const db = getFirestore(app, DATABASE);
db.settings({ ignoreUndefinedProperties: true });
const bucket = new Storage().bucket(BUCKET);
const renderRef = db.collection('renders').doc(RENDER_ID);
const jobRef = db.collection('jobs').doc(JOB_ID);

let child: ChildProcess | null = null;
let stopping = false;
const startedAt = Date.now();

function log(message: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ severity: 'INFO', message, renderId: RENDER_ID, jobId: JOB_ID, ...extra }));
}

class Stopped extends Error {}

/** Updates render + job state unless the job was cancelled or finished elsewhere (then aborts). */
async function setState(status: JobStatus, stage: string, progress?: number) {
  const common = { status, stage, ...(progress !== undefined ? { progress: Math.round(progress * 1000) / 1000 } : {}), updatedAt: FieldValue.serverTimestamp() };
  await db.runTransaction(async (tx) => {
    const job = await tx.get(jobRef);
    const current = job.get('status') as JobStatus;
    if (['completed', 'failed', 'cancelled'].includes(current) || job.get('cancelRequested')) throw new Stopped('The job was cancelled.');
    tx.set(jobRef, common, { merge: true });
    tx.set(renderRef, common, { merge: true });
  });
}

let lastProgressWrite = 0;
function reportProgress(stage: string, progress: number) {
  if (Date.now() - lastProgressWrite < 3000) return;
  lastProgressWrite = Date.now();
  setState('rendering', stage, progress).catch((e) => {
    if (e instanceof Stopped) {
      stopping = true;
      child?.kill('SIGKILL');
    }
  });
}

function run(args: string[], onProgress?: (seconds: number) => void, bin = FFMPEG): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child = p;
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => {
      const m = /out_time_us=(\d+)/.exec(d.toString());
      if (m && onProgress) onProgress(Number(m[1]) / 1e6);
    });
    p.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-6000);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      child = null;
      if (code === 0) resolve();
      else reject(new Error(stopping ? 'Render stopped.' : `ffmpeg exited with code ${code}: ${stderr.split('\n').filter(Boolean).slice(-6).join(' | ')}`));
    });
  });
}

async function probeDuration(file: string): Promise<{ durationSec: number; width: number; height: number }> {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    let s = '';
    p.stdout.on('data', (d: Buffer) => (s += d.toString()));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(s) : reject(new Error('ffprobe failed'))));
  });
  const j = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number }[] };
  const v = j.streams?.find((x) => x.codec_type === 'video');
  return { durationSec: Number(j.format?.duration ?? 0), width: v?.width ?? 0, height: v?.height ?? 0 };
}

interface RenderDocData {
  ownerUid: string;
  projectId: string;
  timelineId: string;
  timelineName?: string;
  preset: string;
  quality: 'draft' | 'final';
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  snapshot: { tracks: Track[]; clips: Clip[]; aspectRatio: string; fps: number };
  assets: Record<string, RenderAssetInfo & { title?: string; provenance?: { synthId?: boolean; c2pa?: string } | null; modelId?: string | null }>;
  computeRates?: { vcpu: number; memoryGiB: number; perVcpuSecond: number; perGiBSecond: number };
}

async function resolveMedia(r: RenderDocData): Promise<(assetId: string) => string> {
  const usesMount = existsSync(path.join(MEDIA_ROOT, 'users'));
  if (usesMount) {
    log('using Cloud Storage FUSE mount', { root: MEDIA_ROOT });
    return (id) => path.join(MEDIA_ROOT, r.assets[id]!.storagePath);
  }
  const dir = path.join(WORK, 'in');
  await mkdir(dir, { recursive: true });
  const ids = Object.keys(r.assets);
  const local: Record<string, string> = {};
  for (const [i, id] of ids.entries()) {
    const a = r.assets[id]!;
    const dest = path.join(dir, `${id}${path.extname(a.storagePath) || ''}`);
    await bucket.file(a.storagePath).download({ destination: dest });
    local[id] = dest;
    await setState('downloading', `Fetching media ${i + 1}/${ids.length}`, 0.05 + (0.1 * (i + 1)) / ids.length);
  }
  return (id) => local[id]!;
}

async function recordComputeUsage(r: RenderDocData, seconds: number) {
  const rates = r.computeRates;
  if (!rates) return;
  const billed = Math.max(60, seconds);
  const costUsd = Math.round(billed * (rates.vcpu * rates.perVcpuSecond + rates.memoryGiB * rates.perGiBSecond) * 1e6) / 1e6;
  const day = dayKey();
  const month = monthKey();
  const batch = db.batch();
  batch.set(db.collection('usage').doc(), { ownerUid: r.ownerUid, projectId: r.projectId, jobId: JOB_ID, modelId: 'cloud-run-ffmpeg', kind: 'render', tokens: { input: 0, output: 0, thoughts: 0, byModality: {} }, costUsd, pricingVersion: 'cloud-run-tier1', day, month, computeSeconds: Math.round(billed), createdAt: FieldValue.serverTimestamp() });
  const agg = { ownerUid: r.ownerUid, costUsd: FieldValue.increment(costUsd), jobs: FieldValue.increment(1), byModel: { 'cloud-run-ffmpeg': FieldValue.increment(costUsd) }, updatedAt: FieldValue.serverTimestamp() };
  batch.set(db.collection('usageDaily').doc(`${r.ownerUid}_${day}`), { ...agg, day }, { merge: true });
  batch.set(db.collection('usageMonthly').doc(`${r.ownerUid}_${month}`), { ...agg, month }, { merge: true });
  batch.set(db.collection('projects').doc(r.projectId), { usage: { costUsd: FieldValue.increment(costUsd), jobs: FieldValue.increment(1) } }, { merge: true });
  batch.set(jobRef, { usageUsd: FieldValue.increment(costUsd) }, { merge: true });
  await batch.commit();
}

async function main() {
  if (!RENDER_ID || !JOB_ID) throw new Error('RENDER_ID and JOB_ID are required.');
  const [renderSnap, jobSnap] = await Promise.all([renderRef.get(), jobRef.get()]);
  if (!renderSnap.exists || !jobSnap.exists) throw new Error('Render or job document not found.');
  const jobStatus = jobSnap.get('status') as JobStatus;
  if (['completed', 'failed', 'cancelled'].includes(jobStatus)) {
    log('job already finished; nothing to do', { jobStatus });
    return;
  }
  const r = renderSnap.data() as RenderDocData;
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });

  await setState('downloading', 'Preparing media', 0.05);
  const resolve = await resolveMedia(r);
  const snap: RenderSnapshot = {
    tracks: r.snapshot.tracks,
    clips: r.snapshot.clips,
    fps: r.fps,
    width: r.width,
    height: r.height,
    durationSec: r.durationSec,
    quality: r.quality,
    assets: r.assets,
  };
  const segments = planSegments(snap, 90);
  log('render plan', { segments: segments.length, durationSec: snap.durationSec, width: snap.width, height: snap.height, quality: snap.quality });

  const segFiles: string[] = [];
  let doneSeconds = 0;
  for (const seg of segments) {
    const base = path.join(WORK, `seg${seg.index}`);
    const plan = buildSegment(snap, seg, { resolve, filterScriptPath: `${base}.filter`, assPath: `${base}.ass`, fontsDir: FONTS_DIR, outputPath: `${base}.mp4` });
    await writeFile(`${base}.filter`, plan.filter);
    if (plan.ass) await writeFile(`${base}.ass`, plan.ass);
    const segLen = seg.end - seg.start;
    await run(plan.args, (t) => {
      reportProgress(`Rendering picture · segment ${seg.index + 1}/${segments.length}`, 0.15 + 0.65 * ((doneSeconds + Math.min(t, segLen)) / snap.durationSec));
    });
    doneSeconds += segLen;
    segFiles.push(`${base}.mp4`);
  }

  await setState('rendering', 'Joining segments', 0.81);
  const listFile = path.join(WORK, 'segments.txt');
  await writeFile(listFile, concatList(segFiles));
  const videoFile = path.join(WORK, 'video.mp4');
  await run(['-hide_banner', '-y', '-nostdin', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', videoFile]);
  for (const f of segFiles) await rm(f, { force: true });

  await setState('rendering', 'Mixing audio', 0.84);
  const audioFile = path.join(WORK, 'audio.m4a');
  const mix = buildAudioMix(snap, resolve, audioFile, path.join(WORK, 'audio.filter'));
  await writeFile(path.join(WORK, 'audio.filter'), mix.filter);
  await run(mix.args, (t) => reportProgress('Mixing audio', 0.84 + 0.06 * Math.min(1, t / snap.durationSec)));

  await setState('rendering', 'Finalising file', 0.9);
  const aiSources = Object.entries(r.assets).filter(([, a]) => a.provenance || a.modelId);
  const models = [...new Set(aiSources.map(([, a]) => a.modelId).filter(Boolean))];
  const title = `${r.timelineName ?? 'AZ Studio'} — ${r.preset} ${r.quality}`;
  const finalName = `${safeFileName(r.timelineName ?? 'render')}-${r.preset}-${r.quality}.mp4`;
  const finalFile = path.join(WORK, finalName);
  await run(
    muxArgs(videoFile, audioFile, finalFile, snap.durationSec, {
      title,
      encoder: 'AZ Studio (FFmpeg)',
      comment: aiSources.length
        ? `Contains AI-generated media made with ${models.join(', ')} on Google Vertex AI. Source clips carry Google SynthID watermarks; see provenance.json for C2PA status of each source.`
        : 'Edited in AZ Studio.',
    }),
  );
  await rm(videoFile, { force: true });

  await setState('rendering', 'Uploading', 0.94);
  const outPath = `users/${r.ownerUid}/renders/${RENDER_ID}/${finalName}`;
  await bucket.upload(finalFile, { destination: outPath, resumable: true, metadata: { contentType: 'video/mp4', cacheControl: 'private, max-age=31536000', metadata: { renderId: RENDER_ID, jobId: JOB_ID } } });
  const provenance = {
    renderId: RENDER_ID,
    createdAt: new Date().toISOString(),
    note: 'Re-encoding removes embedded C2PA manifests from source clips; the original generated files remain unmodified in AZ Studio with their Content Credentials.',
    sources: Object.entries(r.assets).map(([id, a]) => ({ assetId: id, title: a.title ?? null, modelId: a.modelId ?? null, synthId: Boolean(a.provenance?.synthId), c2paInSource: a.provenance?.c2pa ?? 'unknown' })),
  };
  await bucket.file(`users/${r.ownerUid}/renders/${RENDER_ID}/provenance.json`).save(JSON.stringify(provenance, null, 2), { contentType: 'application/json', resumable: false });

  // Poster and thumbnail for the library.
  const info = await probeDuration(finalFile);
  const posterLocal = path.join(WORK, 'poster.jpg');
  const thumbLocal = path.join(WORK, 'thumb.jpg');
  const at = String(Math.min(2, info.durationSec * 0.1));
  await run(['-hide_banner', '-y', '-ss', at, '-i', finalFile, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', posterLocal]);
  await run(['-hide_banner', '-y', '-ss', at, '-i', finalFile, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '3', thumbLocal]);
  const assetRef = db.collection('assets').doc();
  const posterPath = `users/${r.ownerUid}/derived/${assetRef.id}/poster.jpg`;
  const thumbPath = `users/${r.ownerUid}/derived/${assetRef.id}/thumb.jpg`;
  await bucket.upload(posterLocal, { destination: posterPath, resumable: false, metadata: { contentType: 'image/jpeg' } });
  await bucket.upload(thumbLocal, { destination: thumbPath, resumable: false, metadata: { contentType: 'image/jpeg' } });
  const size = (await stat(finalFile)).size;

  const batch = db.batch();
  batch.set(assetRef, {
    ownerUid: r.ownerUid,
    projectId: r.projectId,
    kind: 'video',
    source: 'render',
    status: 'ready',
    title,
    fileName: finalName,
    mimeType: 'video/mp4',
    sizeBytes: size,
    storagePath: outPath,
    thumbPath,
    posterPath,
    waveformPath: null,
    width: info.width || r.width,
    height: info.height || r.height,
    durationSec: Math.round(info.durationSec * 1000) / 1000,
    fps: r.fps,
    hasAudio: true,
    favorite: false,
    tags: [r.quality, r.preset],
    collections: ['renders'],
    generation: aiSources.length ? { jobId: JOB_ID, modelId: models.join(', ') || 'mixed', prompt: '', params: { preset: r.preset, quality: r.quality }, provenance: { synthId: true, c2pa: 'absent', generator: 'AZ Studio renderer' } } : null,
    derivedFrom: null,
    c2pa: 'absent',
    rejection: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.collection('users').doc(r.ownerUid), { stats: { storageBytes: FieldValue.increment(size), assetCount: FieldValue.increment(1) } }, { merge: true });
  batch.set(renderRef, { status: 'completed', stage: 'Done', progress: 1, outputAssetId: assetRef.id, completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  batch.set(jobRef, { status: 'completed', stage: 'Done', progress: 1, result: { assetIds: [assetRef.id] }, completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), lease: FieldValue.delete() }, { merge: true });
  await batch.commit();
  await recordComputeUsage(r, (Date.now() - startedAt) / 1000);
  log('render completed', { outPath, size, seconds: Math.round((Date.now() - startedAt) / 1000) });
}

async function markFailed(message: string) {
  const job = await jobRef.get();
  const current = job.get('status') as JobStatus;
  if (current === 'completed' || current === 'failed' || current === 'cancelled') return;
  const cancelled = Boolean(job.get('cancelRequested'));
  const status: JobStatus = cancelled ? 'cancelled' : 'failed';
  const error = cancelled ? null : { code: 'render_failed', message: message.slice(0, 500), retryable: false };
  await Promise.all([
    renderRef.set({ status, stage: cancelled ? 'Render cancelled' : 'Failed', error, updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
    jobRef.set({ status, stage: cancelled ? 'Render cancelled' : 'Failed', error, completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
  ]);
}

process.on('SIGTERM', () => {
  stopping = true;
  log('SIGTERM received; stopping ffmpeg');
  child?.kill('SIGKILL');
});

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(JSON.stringify({ severity: 'ERROR', message: String((e as Error)?.stack ?? e), renderId: RENDER_ID, jobId: JOB_ID }));
    try {
      await markFailed(String((e as Error)?.message ?? e));
    } catch (inner) {
      console.error(JSON.stringify({ severity: 'ERROR', message: `could not mark failure: ${String(inner)}` }));
    }
    process.exit(stopping ? 0 : 1);
  });
