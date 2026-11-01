import { compareCanaryRuns, dayKey, jsonShape, normaliseCanaryText, type CanaryChange, type CanaryProbe, type CanaryRun } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { speakLine, transcribe } from '../lib/audio-models';
import { toJobError } from '../lib/errors';
import { col, FieldValue } from '../lib/firebase';
import { isModelUnavailable } from '../lib/music-model';
import { recordUsage } from '../lib/usage';
import { geminiDeveloperApi, genai } from '../lib/vertex';
import { callReasoning } from '../workers/text';

/**
 * The daily model canary (azsCanary): a tiny probe per model role — about $0.002 a day in total (one short JSON
 * answer, one spoken sentence and its transcript; the other roles are listing calls or refusals, which are free) —
 * compared with the previous run. Changes are kept in runtime/canary until acknowledged in Settings and shown as a
 * banner across the studio. Image, video and vision are only checked for availability: a real probe would cost cents.
 */
const SENTENCE = 'This is the daily studio check.';

type Probe = Omit<CanaryProbe, 'latencyMs'> & { latencyMs?: number };

function failed(role: string, modelId: string, surface: string, e: unknown): Probe {
  const err = toJobError(e);
  const unavailable = isModelUnavailable(e);
  return { role, modelId, surface, outcome: unavailable ? 'unavailable' : 'error', signature: `${err.code}|${normaliseCanaryText(`${err.message} ${err.details ?? ''}`)}`, detail: err.message.slice(0, 300), costUsd: 0 };
}

async function listed(role: 'video' | 'image'): Promise<Probe> {
  const id = MODEL_REGISTRY[role].id;
  try {
    await genai().models.get({ model: id });
    return { role, modelId: id, surface: 'vertex', outcome: 'ok', signature: 'listed', detail: 'Listed for the project (availability only; no paid request).', costUsd: 0 };
  } catch (e) {
    return failed(role, id, 'vertex', e);
  }
}

async function reasoning(uid: string): Promise<Probe> {
  const id = MODEL_REGISTRY.reasoning.id;
  try {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' }, sum: { type: 'number' } }, required: ['ok', 'sum'] };
    const r = await callReasoning([{ text: 'Health check. Answer with JSON: ok is true and sum is two plus three.' }], { responseJsonSchema: schema }, 'LOW');
    const u = r.res.usageMetadata;
    const costUsd = await recordUsage({ uid, projectId: null, jobId: null, modelId: r.modelId, kind: 'text', inputTokens: u?.promptTokenCount ?? 0, outputTokens: u?.candidatesTokenCount ?? 0, thoughtTokens: u?.thoughtsTokenCount ?? 0, countJob: false });
    const j = r.json as { ok?: unknown; sum?: unknown } | null;
    const right = j?.ok === true && j?.sum === 5;
    return { role: 'reasoning', modelId: r.modelId, surface: 'vertex', outcome: 'ok', signature: `${jsonShape(r.json)}${right ? '' : ' wrong-answer'}${r.usedFallback ? ' fallback' : ''}`, detail: right ? 'Answered the JSON check correctly.' : `Answered with ${r.text.slice(0, 120)}`, costUsd, latencyMs: r.latencyMs };
  } catch (e) {
    return failed('reasoning', id, 'vertex', e);
  }
}

async function speechAndTranscript(uid: string): Promise<Probe[]> {
  const sid = MODEL_REGISTRY.speech.id;
  const tid = MODEL_REGISTRY.transcription.id;
  let wav: Buffer;
  let speech: Probe;
  try {
    const started = Date.now();
    const line = await speakLine(SENTENCE, 'Charon', '');
    wav = line.wav;
    const costUsd = await recordUsage({ uid, projectId: null, jobId: null, modelId: sid, kind: 'speech', inputTokens: line.usage.input, outputTokens: line.usage.output, thoughtTokens: 0, countJob: false });
    const sec = line.speech?.durationSec ?? 0;
    const plausible = sec >= 0.8 && sec <= 5;
    speech = { role: 'speech', modelId: sid, surface: 'vertex', outcome: 'ok', signature: plausible ? 'audio' : 'audio length-off', detail: `Spoke the check sentence in ${sec.toFixed(2)} s.`, costUsd, latencyMs: Date.now() - started };
  } catch (e) {
    return [failed('speech', sid, 'vertex', e), { role: 'transcription', modelId: tid, surface: 'vertex', outcome: 'skipped', signature: '', detail: 'No audio to transcribe.', costUsd: 0 }];
  }
  try {
    const t = await transcribe({ data: wav, mimeType: 'audio/wav', languageCode: 'en', vocabulary: [] });
    const costUsd = await recordUsage({ uid, projectId: null, jobId: null, modelId: tid, kind: 'transcription', inputTokens: t.usage.input, outputTokens: t.usage.output, thoughtTokens: t.usage.thoughts, countJob: false });
    const heard = normaliseCanaryText(t.text).replace(/[^a-z ]/g, '');
    const right = heard.includes('daily studio check');
    return [speech, { role: 'transcription', modelId: tid, surface: 'vertex', outcome: 'ok', signature: `${t.words.length ? 'words' : 'no-words'}${right ? '' : ' mismatch'}`, detail: `Heard “${t.text.slice(0, 120)}”.`, costUsd, latencyMs: t.latencyMs }];
  } catch (e) {
    return [speech, failed('transcription', tid, 'vertex', e)];
  }
}

/** Music: the Vertex refusal must still be recognised (so jobs take the Developer API), and that route must answer. */
async function music(): Promise<Probe[]> {
  const id = MODEL_REGISTRY.music.id;
  const out: Probe[] = [];
  try {
    await genai().models.get({ model: id });
    out.push({ role: 'music:vertex', modelId: id, surface: 'vertex', outcome: 'ok', signature: 'listed', detail: 'Vertex AI now lists Lyria 3.5 for the project; music jobs will use it.', costUsd: 0 });
  } catch (e) {
    const p = failed('music:vertex', id, 'vertex', e);
    out.push(isModelUnavailable(e) ? { ...p, detail: `Refused as expected and recognised as unavailable (jobs fall back): ${p.detail}` } : { ...p, outcome: 'error', detail: `Refused with wording the studio does not recognise — music jobs would fail instead of falling back: ${p.detail}` });
  }
  const dev = await geminiDeveloperApi();
  if (!dev) {
    out.push({ role: 'music:developer-api', modelId: id, surface: 'developer-api', outcome: 'unavailable', signature: 'no-key', detail: 'No Gemini API key is configured.', costUsd: 0 });
    return out;
  }
  try {
    await dev.models.get({ model: id });
    out.push({ role: 'music:developer-api', modelId: id, surface: 'developer-api', outcome: 'ok', signature: 'listed', detail: 'Listed on the Gemini Developer API.', costUsd: 0 });
  } catch (e) {
    out.push(failed('music:developer-api', id, 'developer-api', e));
  }
  return out;
}

async function narration(): Promise<Probe> {
  const id = MODEL_REGISTRY.narration.id;
  const dev = await geminiDeveloperApi();
  if (!dev) return { role: 'narration', modelId: id, surface: 'developer-api', outcome: 'unavailable', signature: 'no-key', detail: 'No Gemini API key is configured.', costUsd: 0 };
  try {
    await dev.models.get({ model: id });
    return { role: 'narration', modelId: id, surface: 'developer-api', outcome: 'ok', signature: 'listed', detail: 'Listed on the Gemini Developer API.', costUsd: 0 };
  } catch (e) {
    return failed('narration', id, 'developer-api', e);
  }
}

export interface CanaryState {
  latest: CanaryRun | null;
  previous: CanaryRun | null;
  changes: CanaryChange[];
  /** When the current changes were acknowledged in Settings (null = unacknowledged). */
  acknowledgedAt: number | null;
}

const stateRef = () => col.runtime().doc('canary');

export async function readCanary(): Promise<CanaryState> {
  const s = await stateRef().get();
  return { latest: (s.get('latest') as CanaryRun) ?? null, previous: (s.get('previous') as CanaryRun) ?? null, changes: (s.get('changes') as CanaryChange[]) ?? [], acknowledgedAt: (s.get('acknowledgedAt') as number) ?? null };
}

export async function acknowledgeCanary(): Promise<CanaryState> {
  await stateRef().set({ acknowledgedAt: Date.now() }, { merge: true });
  return readCanary();
}

/** Runs every probe, compares with the last run and stores the result (and a copy per day under runtime/canary/runs). */
export async function runCanary(uid: string): Promise<CanaryState> {
  const at = Date.now();
  const [r, spoken, mu, na, vi, im] = await Promise.all([reasoning(uid), speechAndTranscript(uid), music(), narration(), listed('video'), listed('image')]);
  const probes: CanaryProbe[] = [r, ...spoken, ...mu, na, vi, im].map((p) => ({ ...p, latencyMs: p.latencyMs ?? 0 }));
  const run: CanaryRun = { day: dayKey(new Date(at)), at, probes, costUsd: Math.round(probes.reduce((s, p) => s + p.costUsd, 0) * 1e6) / 1e6 };
  const prior = await readCanary();
  // Compare with the last run of an earlier day, so a manual re-run on the same day compares like with like.
  const baseline = prior.latest && prior.latest.day !== run.day ? prior.latest : prior.previous;
  const changes = compareCanaryRuns(baseline, run);
  const keepAck = prior.acknowledgedAt !== null && JSON.stringify(changes) === JSON.stringify(prior.changes);
  await stateRef().set({ latest: run, previous: baseline, changes, acknowledgedAt: keepAck ? prior.acknowledgedAt : changes.length ? null : at, updatedAt: FieldValue.serverTimestamp() });
  await stateRef().collection('runs').doc(run.day).set({ ...run, changes });
  return readCanary();
}
