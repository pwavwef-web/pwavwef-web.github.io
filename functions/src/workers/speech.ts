import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { JobDoc } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { speakLine, voiceFor } from '../lib/audio-models';
import { createAsset, withTmpDir } from '../lib/assets';
import { bucket, col } from '../lib/firebase';
import { logInteraction } from '../lib/interactions';
import { progress, transition } from '../lib/jobs';
import { recordUsage } from '../lib/usage';

export interface SpeechLineParams {
  index: number;
  character: string;
  text: string;
  voice: string | null;
  direction: string;
}

export interface SpokenLineResult {
  index: number;
  character: string;
  text: string;
  voice: string;
  assetId: string;
  fileSeconds: number;
  /** Measured spoken length (silence trimmed). */
  seconds: number | null;
  speechStart: number | null;
  speechEnd: number | null;
}

/**
 * Generates the dialogue guide audio: every line is spoken once with a consistent voice per
 * character and measured, so the scene can be planned from real line lengths.
 */
export async function runSpeechJob(job: JobDoc): Promise<void> {
  const p = job.params as { lines: SpeechLineParams[]; languageCode: string | null };
  if (!(await transition(job.id, 'generating', { stage: 'Speaking the dialogue', progress: 0.1, lease: { until: Date.now() + 9 * 60_000 } }))) return;
  const results: SpokenLineResult[] = [];
  const started = Date.now();
  await withTmpDir(async (dir) => {
    for (const [i, line] of p.lines.entries()) {
      const voice = line.voice || voiceFor(line.character, line.direction);
      const spoken = await speakLine(line.text, voice, line.direction);
      await recordUsage({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: MODEL_REGISTRY.speech.id, kind: 'speech', inputTokens: spoken.usage.input, outputTokens: spoken.usage.output, thoughtTokens: 0, countJob: i === 0 });
      const assetId = col.assets().doc().id;
      const fileName = `line-${line.index + 1}.wav`;
      const storagePath = `users/${job.ownerUid}/generated/${job.id}/${assetId}.wav`;
      const local = path.join(dir, fileName);
      await writeFile(local, spoken.wav);
      await bucket.upload(local, { destination: storagePath, resumable: false, metadata: { contentType: 'audio/wav', cacheControl: 'private, max-age=31536000' } });
      await createAsset({
        uid: job.ownerUid,
        assetId,
        projectId: job.projectId,
        kind: 'audio',
        source: 'generated',
        title: `${line.character || 'Line'} — “${line.text.slice(0, 60)}${line.text.length > 60 ? '…' : ''}”`,
        fileName,
        mimeType: 'audio/wav',
        storagePath,
        localFile: local,
        dir,
        collections: ['dialogue'],
        generation: { jobId: job.id, modelId: MODEL_REGISTRY.speech.id, prompt: line.text, params: { voice, direction: line.direction, purpose: 'dialogue_guide' } },
      });
      results.push({
        index: line.index,
        character: line.character,
        text: line.text,
        voice,
        assetId,
        fileSeconds: spoken.fileSeconds,
        seconds: spoken.speech?.durationSec ?? null,
        speechStart: spoken.speech?.start ?? null,
        speechEnd: spoken.speech?.end ?? null,
      });
      await progress(job.id, `Spoken ${i + 1} of ${p.lines.length} lines`, 0.1 + (0.85 * (i + 1)) / p.lines.length);
    }
  });
  await logInteraction({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: MODEL_REGISTRY.speech.id, api: 'generateContent', request: { lines: p.lines.length, voices: [...new Set(results.map((r) => r.voice))] }, response: { measured: results.map((r) => ({ index: r.index, seconds: r.seconds })) }, latencyMs: Date.now() - started });
  const total = results.reduce((s, r) => s + (r.seconds ?? 0), 0);
  await transition(job.id, 'completed', { stage: `Measured ${results.length} line${results.length === 1 ? '' : 's'} · ${total.toFixed(1)} s of speech`, result: { assetIds: results.map((r) => r.assetId), data: { lines: results } } });
}
