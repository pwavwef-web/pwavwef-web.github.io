import { decodePcm16Wav } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { IS_EMULATOR } from '../config/runtime';
import { readOptionalSecret } from './secrets';

/**
 * Pwavwe Narrator provider adapter — Gemini Developer API voice replication and speech (REST, documented on
 * ai.google.dev, verified 2026-10-17). The API key is read server-side from Secret Manager and never logged,
 * returned or stored; request bodies (recordings, article text) are never logged either.
 *
 * Charging semantics used by callers:
 *  - A definite HTTP error response means Google refused the request (nothing generated).
 *  - A dropped connection or timeout after the request was sent is AMBIGUOUS: Google may have created the
 *    voice or generated (and billed) the audio. Callers never resend such a request automatically.
 */

export type ProviderErrorKind = 'not_configured' | 'invalid_request' | 'auth' | 'quota' | 'rate_limited' | 'not_found' | 'server' | 'ambiguous' | 'policy' | 'unexpected';

export class NarratorProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly httpStatus: number | null = null,
    readonly providerStatus: string | null = null,
  ) {
    super(message);
  }
  /** Safe to send again without risking a duplicate charge or voice. */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'server';
  }
}

export const NOT_CONFIGURED =
  'Pwavwe Narrator needs the Gemini Developer API key (Secret Manager secret AZ_STUDIO_GEMINI_API_KEY, readable by the functions’ service account). Voice replication is a Gemini Developer API feature and is not served through Vertex AI.';

let keyOverride: string | null | undefined;
/** Tests only. */
export function setProviderKeyForTests(k: string | null | undefined): void {
  keyOverride = k;
}

async function apiKey(): Promise<string | null> {
  if (keyOverride !== undefined) return keyOverride;
  // Emulators never call the paid provider unless explicitly enabled.
  if (IS_EMULATOR && process.env.AZS_NARRATOR_LIVE !== '1') return null;
  return readOptionalSecret(MODEL_REGISTRY.narration.apiKeySecret);
}

export async function providerConfigured(): Promise<boolean> {
  return Boolean(await apiKey());
}

/** Strips anything key-like or signed-URL-like from provider text before it is stored or shown. */
export function sanitize(s: string): string {
  return s
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[key]')
    .replace(/([?&](?:key|token|signature|X-Goog-Signature)=)[^&\s"]+/gi, '$1[redacted]')
    .replace(/voicekey_[\w-]+/g, 'voicekey_[redacted]')
    .slice(0, 400);
}

let fetchImpl: typeof fetch = (...a) => fetch(...a);
/** Tests only. */
export function setFetchForTests(f: typeof fetch | null): void {
  fetchImpl = f ?? ((...a) => fetch(...a));
}

interface Raw {
  status: number;
  json: Record<string, unknown> | null;
}

async function call(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, timeoutMs: number, opts: { sideEffect: boolean }): Promise<Raw> {
  const key = await apiKey();
  if (!key) throw new NarratorProviderError('not_configured', NOT_CONFIGURED);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${MODEL_REGISTRY.narration.baseUrl}${path}`, {
      method,
      headers: { 'x-goog-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    const aborted = ctrl.signal.aborted;
    // The request may have reached Google: for operations with side effects this is ambiguous.
    if (opts.sideEffect) throw new NarratorProviderError('ambiguous', aborted ? `No answer from Google within ${Math.round(timeoutMs / 1000)} s. The request may still have been processed.` : `The connection to Google dropped (${sanitize(String((e as Error)?.message ?? e))}). The request may still have been processed.`);
    throw new NarratorProviderError('server', aborted ? 'Google did not answer in time.' : `Could not reach Google (${sanitize(String((e as Error)?.message ?? e))}).`);
  } finally {
    clearTimeout(timer);
  }
  let json: Record<string, unknown> | null = null;
  let text = '';
  try {
    text = await res.text();
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    if (res.ok && opts.sideEffect) throw new NarratorProviderError('ambiguous', 'Google answered, but the reply could not be read. The request may have been processed.', res.status);
  }
  if (!res.ok) throw httpError(res.status, json, text);
  return { status: res.status, json };
}

function httpError(status: number, json: Record<string, unknown> | null, text: string): NarratorProviderError {
  const err = (json?.error ?? null) as { message?: string; status?: string } | null;
  const message = sanitize(err?.message ?? (text || `HTTP ${status}`));
  const pstatus = err?.status ?? null;
  if (status === 400) {
    if (/consent|verif|speaker|same (?:person|speaker)|policy|safety|blocked/i.test(message)) return new NarratorProviderError('policy', message, status, pstatus);
    return new NarratorProviderError('invalid_request', message, status, pstatus);
  }
  if (status === 401 || (status === 403 && !/quota|billing/i.test(message))) return new NarratorProviderError('auth', `Google refused the API key: ${message}`, status, pstatus);
  if (status === 403) return new NarratorProviderError('quota', message, status, pstatus);
  if (status === 404) return new NarratorProviderError('not_found', message, status, pstatus);
  if (status === 429) return new NarratorProviderError(/quota|billing|exhaust/i.test(message) && !/rate|per minute|try again/i.test(message) ? 'quota' : 'rate_limited', message, status, pstatus);
  if (status >= 500) return new NarratorProviderError('server', message, status, pstatus);
  return new NarratorProviderError('unexpected', message, status, pstatus);
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface ProviderStatus {
  configured: boolean;
  surface: 'google_gemini_api';
  checkedAt: number;
  models: { id: string; displayName: string; available: boolean; message: string | null; inputTokenLimit: number | null; outputTokenLimit: number | null }[];
  voicesApi: { available: boolean; message: string | null; replicatedVoices: number | null };
  message: string | null;
}

export async function checkCapabilities(): Promise<ProviderStatus> {
  const checkedAt = Date.now();
  const configured = await providerConfigured();
  const names = MODEL_REGISTRY.narration.displayNames as Record<string, string>;
  if (!configured) {
    return { configured, surface: 'google_gemini_api', checkedAt, models: MODEL_REGISTRY.narration.allowedIds.map((id) => ({ id, displayName: names[id] ?? id, available: false, message: 'Not checked (no key).', inputTokenLimit: null, outputTokenLimit: null })), voicesApi: { available: false, message: 'Not checked (no key).', replicatedVoices: null }, message: NOT_CONFIGURED };
  }
  const models: ProviderStatus['models'] = [];
  for (const id of MODEL_REGISTRY.narration.allowedIds) {
    try {
      const r = await call('GET', `/models/${id}`, null, 20_000, { sideEffect: false });
      models.push({ id, displayName: names[id] ?? id, available: true, message: null, inputTokenLimit: Number(r.json?.inputTokenLimit ?? 0) || null, outputTokenLimit: Number(r.json?.outputTokenLimit ?? 0) || null });
    } catch (e) {
      models.push({ id, displayName: names[id] ?? id, available: false, message: e instanceof NarratorProviderError ? e.message : sanitize(String(e)), inputTokenLimit: null, outputTokenLimit: null });
    }
  }
  let voicesApi: ProviderStatus['voicesApi'];
  try {
    const voices = await listReplicatedVoices();
    voicesApi = { available: true, message: null, replicatedVoices: voices.length };
  } catch (e) {
    voicesApi = { available: false, message: e instanceof NarratorProviderError ? e.message : sanitize(String(e)), replicatedVoices: null };
  }
  const ok = models.some((m) => m.available) && voicesApi.available;
  return { configured, surface: 'google_gemini_api', checkedAt, models, voicesApi, message: ok ? null : 'Google did not confirm access to voice replication for this key. See the details below.' };
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

export interface ProviderVoice {
  id: string;
  displayName: string | null;
  type: string | null;
  createTime: string | null;
}

function voiceIdFrom(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  for (const k of ['id', 'name', 'voice_id', 'voiceId']) {
    const s = typeof o[k] === 'string' ? (o[k] as string).replace(/^voices\//, '') : '';
    if (/^voice_[\w-]+$/.test(s)) return s;
  }
  for (const k of ['voice', 'replicated_voice', 'replicatedVoice']) {
    const inner = voiceIdFrom(o[k]);
    if (inner) return inner;
  }
  return null;
}

function toVoice(v: Record<string, unknown>): ProviderVoice | null {
  const id = voiceIdFrom(v);
  if (!id) return null;
  return { id, displayName: typeof v.display_name === 'string' ? v.display_name : typeof v.displayName === 'string' ? v.displayName : null, type: typeof v.type === 'string' ? v.type : null, createTime: typeof v.create_time === 'string' ? v.create_time : typeof v.createTime === 'string' ? v.createTime : null };
}

/**
 * Creates a stateful replicated voice (store: true → `voice_…` id, kept by Google for one year from last use).
 * Both clips must be real recordings of the same adult speaker; Google verifies the consent statement.
 */
export async function createVoice(input: { modelId: string; displayName: string; referenceWav: Buffer; consentWav: Buffer }): Promise<{ voiceId: string }> {
  const r = await call(
    'POST',
    '/voices',
    {
      store: true,
      voice: {
        model: input.modelId,
        type: 'replicated',
        display_name: input.displayName,
        replicated: {
          source_audio: { mime_type: 'audio/wav', data: input.referenceWav.toString('base64') },
          consent_audio: { mime_type: 'audio/wav', data: input.consentWav.toString('base64') },
        },
      },
    },
    180_000,
    { sideEffect: true },
  );
  const voiceId = voiceIdFrom(r.json);
  if (!voiceId) throw new NarratorProviderError('ambiguous', 'Google accepted the request but its reply did not include a voice id. The voice may exist — use “Check Google for voices” in Settings.', r.status);
  return { voiceId };
}

export async function getVoice(voiceId: string): Promise<ProviderVoice | null> {
  try {
    const r = await call('GET', `/voices/${encodeURIComponent(voiceId)}`, null, 30_000, { sideEffect: false });
    return r.json ? (toVoice(r.json) ?? { id: voiceId, displayName: null, type: null, createTime: null }) : null;
  } catch (e) {
    if (e instanceof NarratorProviderError && e.kind === 'not_found') return null;
    throw e;
  }
}

/** Stored replicated voices in the project (Google lists custom voices first, newest first). */
export async function listReplicatedVoices(): Promise<ProviderVoice[]> {
  const out: ProviderVoice[] = [];
  let token = '';
  for (let page = 0; page < 10; page++) {
    const r = await call('GET', `/voices?type=replicated&page_size=200${token ? `&page_token=${encodeURIComponent(token)}` : ''}`, null, 30_000, { sideEffect: false });
    for (const v of (r.json?.voices as Record<string, unknown>[] | undefined) ?? []) {
      const voice = toVoice(v);
      if (voice && (!voice.type || voice.type === 'replicated')) out.push(voice);
    }
    token = typeof r.json?.next_page_token === 'string' ? r.json.next_page_token : '';
    if (!token) break;
  }
  return out;
}

export async function deleteVoice(voiceId: string): Promise<'deleted' | 'already_gone'> {
  try {
    await call('DELETE', `/voices/${encodeURIComponent(voiceId)}`, null, 30_000, { sideEffect: false });
    return 'deleted';
  } catch (e) {
    if (e instanceof NarratorProviderError && e.kind === 'not_found') return 'already_gone';
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

export interface SpeechResult {
  wav: Buffer;
  sampleRate: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * One unary synthesis (WAV out). `style` goes in `speech_metadata.style` (sustained delivery), never in the
 * spoken text. `store: false` (accepted by the Interactions API, verified 2026-10-17) keeps no interaction.
 */
export async function synthesize(input: { modelId: string; voiceId: string; segments: { text: string; style: string }[] }): Promise<SpeechResult> {
  // One text block per segment; a sustained style rides on its block's speech_metadata (never in the words).
  const content = input.segments.map((s) => ({ type: 'text', text: s.text, ...(s.style.trim() ? { annotations: [{ type: 'speech_metadata', style: s.style.trim() }] } : {}) }));
  const r = await call(
    'POST',
    '/interactions',
    {
      model: input.modelId,
      input: [{ type: 'user_input', content }],
      response_format: { type: 'audio', mime_type: 'audio/wav' },
      generation_config: { speech_config: [{ voice: input.voiceId }] },
      store: false,
    },
    240_000,
    { sideEffect: true },
  );
  const it = r.json ?? {};
  const status = typeof it.status === 'string' ? it.status : 'completed';
  if (status !== 'completed') {
    const errs = (it.errors as { message?: string }[] | undefined) ?? [];
    const msg = sanitize(errs.map((x) => x.message ?? '').join(' ') || `The speech request ended as “${status}”.`);
    throw new NarratorProviderError(/safety|policy|blocked/i.test(msg) ? 'policy' : 'unexpected', msg, r.status, status);
  }
  type Block = { type?: string; data?: string; mime_type?: string };
  const blocks = ((it.steps as { type?: string; content?: Block[] }[] | undefined) ?? []).filter((s) => s.type === 'model_output' || !s.type).flatMap((s) => s.content ?? []);
  const audio = [...blocks].reverse().find((b) => b.type === 'audio' && b.data) ?? ((it.output_audio as Block | undefined)?.data ? (it.output_audio as Block) : null);
  if (!audio?.data) throw new NarratorProviderError('unexpected', 'Google returned no audio for this passage (it may still have been billed).', r.status);
  const wav = Buffer.from(audio.data, 'base64');
  const decoded = decodePcm16Wav(wav);
  if (!decoded || !decoded.samples.length) throw new NarratorProviderError('unexpected', `Google returned audio AZ Studio could not read (${audio.mime_type ?? 'unknown type'}).`, r.status);
  const usage = (it.usage ?? {}) as { total_input_tokens?: number; total_output_tokens?: number };
  return { wav, sampleRate: decoded.sampleRate, inputTokens: Number(usage.total_input_tokens ?? 0), outputTokens: Number(usage.total_output_tokens ?? 0) };
}
