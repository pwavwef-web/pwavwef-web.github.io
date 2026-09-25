import path from 'node:path';
import { logger } from 'firebase-functions';
import { defaultMixTrack, isTerminal, type JobDoc } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { PRICING } from '../config/pricing';
import { PROJECT_ID } from '../config/runtime';
import { createAsset, withTmpDir } from '../lib/assets';
import { bucket, col, db, FieldValue } from '../lib/firebase';
import { JobFailure } from '../lib/errors';
import { enqueueJob, failJob, getJob, progress, transition } from '../lib/jobs';
import { recordUsage } from '../lib/usage';
import { RUN_API, runApi, type Execution } from './render';

interface StemsParams {
  assetId: string;
  storagePath: string;
  durationSec: number;
  musicProjectId: string | null;
  versionId: string | null;
  title: string;
}

interface Manifest {
  model: string;
  stems: { name: string; path: string; durationSec: number }[];
  seconds: number;
}

const JOB = MODEL_REGISTRY.separation.job;
const REGION = MODEL_REGISTRY.separation.location;
const outPrefix = (job: JobDoc) => `users/${job.ownerUid}/generated/${job.id}/stems`;

/** Launches Demucs (htdemucs) on the `az-studio-stems` Cloud Run job for this recording. */
export async function startStemsJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as StemsParams;
  if (!(await transition(job.id, 'generating', { stage: 'Starting stem separation', progress: 0.03, lease: { until: Date.now() + 5 * 60_000 } }))) return;
  const url = `${RUN_API}/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB}:run`;
  let op: { metadata?: { name?: string } };
  try {
    op = await runApi(url, 'POST', { overrides: { containerOverrides: [{ env: [{ name: 'INPUT_PATH', value: p.storagePath }, { name: 'OUTPUT_PREFIX', value: outPrefix(job) }, { name: 'JOB_ID', value: job.id }] }], taskCount: 1, timeout: `${Math.min(6, Math.max(1, Math.ceil((p.durationSec * 4) / 3600) + 1)) * 3600}s` } });
  } catch (e) {
    const status = (e as { response?: { status?: number } }).response?.status;
    throw new JobFailure({ code: status === 404 ? 'separator_missing' : 'separator_launch_failed', message: status === 404 ? 'The stem-separation job (az-studio-stems) is not deployed.' : `Could not start stem separation: ${String((e as Error).message).slice(0, 200)}`, retryable: status === undefined || status >= 500 });
  }
  const executionName = op.metadata?.name ?? null;
  if (!executionName) throw new JobFailure({ code: 'separator_launch_failed', message: 'Cloud Run did not return an execution for the stem separation.', retryable: true });
  await transition(job.id, 'generating', { stage: `Separating vocals, drums, bass and other (${MODEL_REGISTRY.separation.displayName})`, progress: 0.08, external: { executionName }, lease: null });
  await enqueueJob(job.id, 'poll', { delaySec: 60, seq: 1 });
}

/** Follows the execution; when it succeeds the stems become assets (and mixer tracks of the music project). */
export async function watchStemsJob(job: JobDoc, seq: number): Promise<void> {
  const executionName = job.external?.executionName as string | undefined;
  if (isTerminal(job.status) || !executionName) return;
  let exec: Execution & { startTime?: string };
  try {
    exec = await runApi<Execution & { startTime?: string }>(`${RUN_API}/${executionName}`, 'GET');
  } catch (e) {
    logger.warn('stems execution lookup failed', { jobId: job.id, error: String(e) });
    await enqueueJob(job.id, 'poll', { delaySec: 90, seq: seq + 1 });
    return;
  }
  if (!exec.completionTime) {
    const p = job.params as unknown as StemsParams;
    const elapsed = exec.startTime ? (Date.now() - Date.parse(exec.startTime)) / 1000 : 0;
    const expected = PRICING.separation!.overheadSeconds + p.durationSec * PRICING.separation!.secondsPerAudioSecond;
    await progress(job.id, `Separating stems (≈${Math.max(1, Math.round((expected - elapsed) / 60))} min left)`, Math.min(0.9, 0.08 + (0.8 * elapsed) / Math.max(60, expected)));
    await enqueueJob(job.id, 'poll', { delaySec: 45, seq: seq + 1 });
    return;
  }
  const fresh = await getJob(job.id);
  if (!fresh || isTerminal(fresh.status)) return;
  const seconds = exec.startTime ? Math.max(1, (Date.parse(exec.completionTime) - Date.parse(exec.startTime)) / 1000) : null;
  if ((exec.succeededCount ?? 0) === 0) {
    const reason = exec.conditions?.find((c) => c.state === 'CONDITION_FAILED')?.message ?? 'The separator stopped without a result.';
    await failJob(fresh, { code: 'separation_failed', message: `Stem separation failed: ${reason.slice(0, 300)}`, retryable: false });
    return;
  }
  const p = fresh.params as unknown as StemsParams;
  const [raw] = await bucket.file(`${outPrefix(fresh)}/manifest.json`).download();
  const manifest = JSON.parse(raw.toString('utf8')) as Manifest;
  const s = PRICING.separation!;
  if (seconds) await recordUsage({ uid: fresh.ownerUid, projectId: fresh.projectId, jobId: fresh.id, modelId: MODEL_REGISTRY.separation.id, kind: 'compute', inputTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsdOverride: Math.round(seconds * (s.vcpu * s.perVcpuSecond + s.memoryGiB * s.perGiBSecond) * 1e6) / 1e6 });
  const created: Record<string, string> = {};
  await withTmpDir(async (dir) => {
    for (const st of manifest.stems) {
      const local = path.join(dir, `${st.name}${path.extname(st.path) || '.mp3'}`);
      await bucket.file(st.path).download({ destination: local });
      created[st.name] = await createAsset({ uid: fresh.ownerUid, projectId: fresh.projectId, kind: 'audio', source: 'derived', title: `${p.title} — ${st.name}`, fileName: path.basename(st.path), mimeType: st.path.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg', storagePath: st.path, localFile: local, dir, collections: ['stems'], derivedFrom: { assetId: p.assetId } });
    }
  });
  const stemsRef = col.sub(fresh.projectId!, 'stems').doc(fresh.id);
  const batch = db.batch();
  batch.set(stemsRef, { sourceAssetId: p.assetId, musicProjectId: p.musicProjectId, versionId: p.versionId, modelId: MODEL_REGISTRY.separation.id, stems: created, seconds, jobId: fresh.id, createdAt: FieldValue.serverTimestamp() });
  if (p.musicProjectId) {
    // Each stem becomes a mixer track of the music project (muted source version stays untouched).
    for (const [name, assetId] of Object.entries(created)) {
      const tref = col.sub(fresh.projectId!, 'audioTracks').doc();
      batch.set(tref, { ...defaultMixTrack(tref.id, name[0]!.toUpperCase() + name.slice(1), assetId, 'stem', name === 'vocals' ? 'vocal' : 'music'), musicProjectId: p.musicProjectId, order: Object.keys(created).indexOf(name), createdAt: FieldValue.serverTimestamp() });
    }
  }
  await batch.commit();
  await transition(fresh.id, 'completed', { stage: `${Object.keys(created).length} stems ready (${Object.keys(created).join(', ')})${seconds ? ` in ${Math.round(seconds / 60)} min` : ''}`, result: { assetIds: Object.values(created), data: { stems: created, stemsId: fresh.id } } });
}
