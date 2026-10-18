import { autoDirectPrompt, makeIdFactory, validateSuggestions, type Direction, type DirectionIntensity, type DirectPassage, type JobDoc } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { failJob, progress, transition } from '../lib/jobs';
import { logInteraction } from '../lib/interactions';
import { providerFailure } from '../lib/errors';
import { callReasoning, usageFor } from './text';

/** Passages per reasoning request (keeps replies small and failures cheap). */
export const DIRECT_BATCH = 18;

interface DirectParams {
  editionId: string;
  intensity: DirectionIntensity;
  passages: DirectPassage[];
  vocalAlready: number;
}

/**
 * Auto-direct: asks the reasoning model for delivery suggestions and validates every one against the passage
 * text. The result is a list of suggestions on the job; nothing is applied to the edition here, no speech is
 * generated and nothing is published. The editor merges the suggestions into the draft for review.
 */
export async function runNarratorDirectJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as DirectParams;
  if (!(await transition(job.id, 'generating', { stage: 'Reading the script for delivery', progress: 0.05, lease: { until: Date.now() + 20 * 60_000 } }))) return;
  const newId = makeIdFactory('d');
  const suggestions: Direction[] = [];
  const discarded: { reason: string }[] = [];
  let vocal = p.vocalAlready;
  try {
    const batches: DirectPassage[][] = [];
    for (let i = 0; i < p.passages.length; i += DIRECT_BATCH) batches.push(p.passages.slice(i, i + DIRECT_BATCH));
    for (const [n, batch] of batches.entries()) {
      await progress(job.id, batches.length > 1 ? `Suggesting directions (${n + 1} of ${batches.length})` : 'Suggesting directions', 0.1 + (0.85 * n) / batches.length);
      const started = Date.now();
      const r = await callReasoning([{ text: autoDirectPrompt(batch, p.intensity) }], { temperature: 0.4 }, 'LOW');
      await usageFor(job, r, 'text', n === 0);
      const v = validateSuggestions(r.json, batch, p.intensity, { newId, jobId: job.id, vocalAlready: vocal });
      vocal += v.directions.filter((d) => d.kind === 'vocal').length;
      suggestions.push(...v.directions);
      discarded.push(...v.discarded);
      await logInteraction({ uid: job.ownerUid, projectId: null, jobId: job.id, modelId: r.modelId, api: 'generateContent', request: { task: 'narrator_autodirect', passages: batch.length, intensity: p.intensity }, response: { suggestions: v.directions.length, discarded: v.discarded.length }, latencyMs: Date.now() - started });
    }
    await transition(job.id, 'completed', {
      stage: `${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'} to review${discarded.length ? ` · ${discarded.length} invalid suggestion${discarded.length === 1 ? '' : 's'} discarded` : ''}`,
      result: { data: { editionId: p.editionId, suggestions, discarded: discarded.slice(0, 50), analysed: p.passages.map((x) => x.id) } },
    });
  } catch (e) {
    const err = providerFailure(e, { modelId: MODEL_REGISTRY.reasoning.id, what: 'request', surface: 'vertex' });
    await failJob(job, err.jobError);
  }
}
