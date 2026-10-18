import { GoogleAuth } from 'google-auth-library';
import { decodePcm16Wav, encodePcm16Wav, type NarratorRoute } from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { IS_EMULATOR, PROJECT_ID } from '../config/runtime';
import { readOptionalSecret } from './secrets';

/**
 * Pwavwe Narrator provider adapter — two routes to the same Gemini 3.8 TTS models:
 *  - `developer`: Gemini Developer API (REST, ai.google.dev, verified 2026-10-17). API key from Secret Manager.
 *    Voices: POST/GET/DELETE /v1beta/voices; speech: POST /v1beta/interactions.
 *  - `vertex`: Google Cloud Vertex AI / Gemini Enterprise Agent Platform (verified 2026-10-18). The functions'
 *    service account through Application Default Credentials (no key). Voices: /v1beta1/projects/{p}/locations/
 *    global/voices; speech: /v1/…/publishers/google/models/{model}:generateContent with `speechMetadata.style`
 *    on each text part. This is not the Cloud Text-to-Speech API (texttospeech.googleapis.com).
 * The two routes keep separate voice stores. Keys, tokens and request bodies (recordings, article text) are never
 * logged, returned or stored.
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
    /** How long Google asked to wait, when it said (e.g. "Please retry in 21h2m35s" or RetryInfo "21s"). */
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
  }
  /** Safe to send again without risking a duplicate charge or voice. */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'server';
  }
}

export const NOT_CONFIGURED =
  'Pwavwe Narrator needs the Gemini Developer API key (Secret Manager secret AZ_STUDIO_GEMINI_API_KEY, readable by the functions’ service account) for the Developer API route.';
export const CLOUD_NOT_CONFIGURED = 'The Google Cloud route needs Application Default Credentials (the functions’ service account in production). Emulators never call it unless AZS_NARRATOR_LIVE=1.';

let keyOverride: string | null | undefined;
/** Tests only. */
export function setProviderKeyForTests(k: string | null | undefined): void {
  keyOverride = k;
}

let tokenOverride: (() => Promise<string | null>) | undefined;
/** Tests only: replaces the ADC access token source of the Cloud route. */
export function setVertexTokenForTests(f: (() => Promise<string | null>) | undefined): void {
  tokenOverride = f;
}

async function apiKey(): Promise<string | null> {
  if (keyOverride !== undefined) return keyOverride;
  // Emulators never call the paid provider unless explicitly enabled.
  if (IS_EMULATOR && process.env.AZS_NARRATOR_LIVE !== '1') return null;
  return readOptionalSecret(MODEL_REGISTRY.narration.apiKeySecret);
}

let auth: GoogleAuth | null = null;
async function vertexToken(): Promise<string | null> {
  if (tokenOverride !== undefined) return tokenOverride();
  if (IS_EMULATOR && process.env.AZS_NARRATOR_LIVE !== '1') return null;
  try {
    auth ??= new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const t = await (await auth.getClient()).getAccessToken();
    return t.token ?? null;
  } catch (e) {
    throw new NarratorProviderError('auth', `No Google Cloud credentials for the functions (${sanitize(String((e as Error)?.message ?? e))}).`);
  }
}

export async function providerConfigured(route: NarratorRoute = 'developer'): Promise<boolean> {
  if (route === 'vertex') return tokenOverride !== undefined || !IS_EMULATOR || process.env.AZS_NARRATOR_LIVE === '1';
  return Boolean(await apiKey());
}

/** Strips anything key-like, token-like or signed-URL-like from provider text before it is stored or shown. */
export function sanitize(s: string): string {
  return s
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[key]')
    .replace(/ya29\.[0-9A-Za-z._-]+/g, '[token]')
    .replace(/Bearer\s+[0-9A-Za-z._-]+/gi, 'Bearer [token]')
    .replace(/([?&](?:key|token|access_token|signature|X-Goog-Signature)=)[^&\s"]+/gi, '$1[redacted]')
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

const V = MODEL_REGISTRY.narration.vertex;
/** Cloud URLs: project voice store, model resource and generateContent (all in `global`). */
export const vertexUrl = {
  voices: (suffix = '') => `${V.host}/${V.voicesVersion}/projects/${PROJECT_ID}/locations/${V.location}/voices${suffix}`,
  model: (id: string) => `${V.host}/${V.voicesVersion}/publishers/google/models/${id}`,
  generate: (id: string) => `${V.host}/${V.generateVersion}/projects/${PROJECT_ID}/locations/${V.location}/publishers/google/models/${id}:generateContent`,
};

/**
 * One REST call. `target` is a path under the Developer API base, or a full Cloud URL for the vertex route.
 */
async function call(route: NarratorRoute, method: 'GET' | 'POST' | 'DELETE', target: string, body: unknown, timeoutMs: number, opts: { sideEffect: boolean }): Promise<Raw> {
  let url: string;
  let authHeader: Record<string, string>;
  if (route === 'vertex') {
    const token = await vertexToken();
    if (!token) throw new NarratorProviderError('not_configured', CLOUD_NOT_CONFIGURED);
    url = target;
    authHeader = { authorization: `Bearer ${token}` };
  } else {
    const key = await apiKey();
    if (!key) throw new NarratorProviderError('not_configured', NOT_CONFIGURED);
    url = `${MODEL_REGISTRY.narration.baseUrl}${target}`;
    authHeader = { 'x-goog-api-key': key };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { ...authHeader, ...(body ? { 'content-type': 'application/json' } : {}) },
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
  if (!res.ok) throw httpError(route, res.status, json, text);
  return { status: res.status, json };
}

/** Reads "retry in 21h2m35s" / "retry in 45s" / "retry after 3m" from a provider message (seconds), or null. */
export function parseRetryAfter(message: string): number | null {
  const m = /retry (?:in|after)\s+((?:\d+(?:\.\d+)?\s*[hms]\s*){1,3})/i.exec(message);
  if (!m) return null;
  let sec = 0;
  for (const [, n, unit] of m[1]!.matchAll(/(\d+(?:\.\d+)?)\s*([hms])/gi)) sec += Number(n) * (unit!.toLowerCase() === 'h' ? 3600 : unit!.toLowerCase() === 'm' ? 60 : 1);
  return sec > 0 ? Math.round(sec) : null;
}

/** google.rpc.RetryInfo `retryDelay` ("21s", "1.5s") from an error's details, in seconds. */
function retryInfoSec(details: unknown): number | null {
  for (const d of Array.isArray(details) ? (details as Record<string, unknown>[]) : []) {
    if (String(d['@type'] ?? '').endsWith('google.rpc.RetryInfo') && typeof d.retryDelay === 'string') {
      const n = Number.parseFloat(d.retryDelay);
      if (Number.isFinite(n) && n > 0) return Math.ceil(n);
    }
  }
  return null;
}

function httpError(route: NarratorRoute, status: number, json: Record<string, unknown> | null, text: string): NarratorProviderError {
  const err = (json?.error ?? null) as { message?: string; status?: string; details?: unknown } | null;
  const message = sanitize(err?.message ?? (text || `HTTP ${status}`));
  const pstatus = err?.status ?? null;
  const retryAfter = retryInfoSec(err?.details) ?? parseRetryAfter(message);
  if (status === 400) {
    if (/consent|verif|speaker|same (?:person|speaker)|policy|safety|blocked/i.test(message)) return new NarratorProviderError('policy', message, status, pstatus);
    return new NarratorProviderError('invalid_request', message, status, pstatus);
  }
  const who = route === 'vertex' ? 'Google Cloud refused the functions’ service account' : 'Google refused the API key';
  if (status === 401 || (status === 403 && !/quota|billing/i.test(message))) return new NarratorProviderError('auth', `${who}: ${message}`, status, pstatus);
  if (status === 403) return new NarratorProviderError('quota', message, status, pstatus, retryAfter);
  if (status === 404) return new NarratorProviderError('not_found', message, status, pstatus);
  if (status === 429) {
    // A per-day (or otherwise exhausted) allowance will not recover in seconds: never retried automatically.
    // Observed 2026-10-18 (developer): "Rate limit exceeded for model … (limit: 100 requests per day on Tier 1). Please retry in 21h2m35s …"
    // Vertex pay-as-you-go answers 429 RESOURCE_EXHAUSTED when the shared pool is busy: short, retryable.
    const daily =
      route === 'vertex'
        ? /per day|daily|billing/i.test(message) && !/per minute/i.test(message)
        : /per day|daily|requests per day|RPD|exhausted|billing|quota/i.test(message) && !/per minute|RPM/i.test(message);
    return new NarratorProviderError(daily ? 'quota' : 'rate_limited', message, status, pstatus, retryAfter);
  }
  if (status >= 500) return new NarratorProviderError('server', message, status, pstatus, retryAfter);
  return new NarratorProviderError('unexpected', message, status, pstatus);
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

interface ModelCheck {
  id: string;
  displayName: string;
  available: boolean;
  message: string | null;
  inputTokenLimit: number | null;
  outputTokenLimit: number | null;
}

export interface ProviderStatus {
  configured: boolean;
  surface: 'google_gemini_api';
  checkedAt: number;
  models: ModelCheck[];
  voicesApi: { available: boolean; message: string | null; replicatedVoices: number | null };
  message: string | null;
  /** The Google Cloud route, checked with the functions' own credentials (free calls only). */
  cloud?: { configured: boolean; models: ModelCheck[]; voicesApi: { available: boolean; message: string | null; replicatedVoices: number | null }; message: string | null };
}

const errText = (e: unknown) => (e instanceof NarratorProviderError ? e.message : sanitize(String(e)));

async function checkRoute(route: NarratorRoute): Promise<Omit<ProviderStatus, 'surface' | 'checkedAt' | 'cloud'>> {
  const configured = await providerConfigured(route);
  const names = MODEL_REGISTRY.narration.displayNames as Record<string, string>;
  const notChecked = route === 'vertex' ? 'Not checked (no Cloud credentials in this environment).' : 'Not checked (no key).';
  if (!configured) {
    return { configured, models: MODEL_REGISTRY.narration.allowedIds.map((id) => ({ id, displayName: names[id] ?? id, available: false, message: notChecked, inputTokenLimit: null, outputTokenLimit: null })), voicesApi: { available: false, message: notChecked, replicatedVoices: null }, message: route === 'vertex' ? CLOUD_NOT_CONFIGURED : NOT_CONFIGURED };
  }
  const models: ModelCheck[] = [];
  for (const id of MODEL_REGISTRY.narration.allowedIds) {
    try {
      const r = await call(route, 'GET', route === 'vertex' ? vertexUrl.model(id) : `/models/${id}`, null, 20_000, { sideEffect: false });
      models.push({ id, displayName: names[id] ?? id, available: true, message: null, inputTokenLimit: Number(r.json?.inputTokenLimit ?? 0) || null, outputTokenLimit: Number(r.json?.outputTokenLimit ?? 0) || null });
    } catch (e) {
      models.push({ id, displayName: names[id] ?? id, available: false, message: errText(e), inputTokenLimit: null, outputTokenLimit: null });
    }
  }
  let voicesApi: ProviderStatus['voicesApi'];
  try {
    const voices = await listReplicatedVoices(route);
    voicesApi = { available: true, message: null, replicatedVoices: voices.length };
  } catch (e) {
    voicesApi = { available: false, message: errText(e), replicatedVoices: null };
  }
  const ok = models.some((m) => m.available) && voicesApi.available;
  return { configured, models, voicesApi, message: ok ? null : `Google did not confirm access to voice replication on the ${route === 'vertex' ? 'Google Cloud' : 'Developer API'} route. See the details below.` };
}

export async function checkCapabilities(): Promise<ProviderStatus> {
  const checkedAt = Date.now();
  const [dev, cloud] = await Promise.all([checkRoute('developer'), checkRoute('vertex')]);
  return { ...dev, surface: 'google_gemini_api', checkedAt, cloud };
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
    const s = typeof o[k] === 'string' ? (o[k] as string).replace(/^.*voices\//, '') : '';
    if (/^voice_[\w-]+$/.test(s)) return s;
  }
  for (const k of ['voice', 'replicated_voice', 'replicatedVoice']) {
    const inner = voiceIdFrom(o[k]);
    if (inner) return inner;
  }
  return null;
}

/** "replicated" (developer) and "VOICE_TYPE_REPLICATED" (Cloud) both read as `replicated`. */
const voiceType = (t: unknown): string | null => (typeof t === 'string' ? t.replace(/^VOICE_TYPE_/, '').toLowerCase() : null);

function toVoice(v: Record<string, unknown>): ProviderVoice | null {
  const id = voiceIdFrom(v);
  if (!id) return null;
  return { id, displayName: typeof v.display_name === 'string' ? v.display_name : typeof v.displayName === 'string' ? v.displayName : null, type: voiceType(v.type), createTime: typeof v.create_time === 'string' ? v.create_time : typeof v.createTime === 'string' ? v.createTime : null };
}

/**
 * Creates a stateful replicated voice (store: true → `voice_…` id, kept by Google for one year from last use).
 * Both clips must be real recordings of the same adult speaker; Google verifies the consent statement, whose
 * wording differs per route. On the Cloud route `voice.model` must be omitted with store: true (documented).
 */
export async function createVoice(input: { route?: NarratorRoute; modelId: string; displayName: string; referenceWav: Buffer; consentWav: Buffer }): Promise<{ voiceId: string }> {
  const route = input.route ?? 'developer';
  const ref = input.referenceWav.toString('base64');
  const con = input.consentWav.toString('base64');
  const r =
    route === 'vertex'
      ? await call('vertex', 'POST', vertexUrl.voices(), { store: true, voice: { type: 'VOICE_TYPE_REPLICATED', displayName: input.displayName, replicated: { sourceAudio: { mimeType: 'audio/wav', data: ref }, consentAudio: { mimeType: 'audio/wav', data: con } } } }, 180_000, { sideEffect: true })
      : await call(
          'developer',
          'POST',
          '/voices',
          { store: true, voice: { model: input.modelId, type: 'replicated', display_name: input.displayName, replicated: { source_audio: { mime_type: 'audio/wav', data: ref }, consent_audio: { mime_type: 'audio/wav', data: con } } } },
          180_000,
          { sideEffect: true },
        );
  const voiceId = voiceIdFrom(r.json);
  if (!voiceId) throw new NarratorProviderError('ambiguous', 'Google accepted the request but its reply did not include a voice id. The voice may exist — use “Check Google for voices” in Settings.', r.status);
  return { voiceId };
}

export async function getVoice(voiceId: string, route: NarratorRoute = 'developer'): Promise<ProviderVoice | null> {
  try {
    const r = await call(route, 'GET', route === 'vertex' ? vertexUrl.voices(`/${encodeURIComponent(voiceId)}`) : `/voices/${encodeURIComponent(voiceId)}`, null, 30_000, { sideEffect: false });
    return r.json ? (toVoice(r.json) ?? { id: voiceId, displayName: null, type: null, createTime: null }) : null;
  } catch (e) {
    if (e instanceof NarratorProviderError && e.kind === 'not_found') return null;
    throw e;
  }
}

/** Stored replicated voices in the project's store for this route (Google lists custom voices first). */
export async function listReplicatedVoices(route: NarratorRoute = 'developer'): Promise<ProviderVoice[]> {
  const out: ProviderVoice[] = [];
  let token = '';
  for (let page = 0; page < 10; page++) {
    const q = route === 'vertex' ? `?type=replicated&pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ''}` : `?type=replicated&page_size=200${token ? `&page_token=${encodeURIComponent(token)}` : ''}`;
    const r = await call(route, 'GET', route === 'vertex' ? vertexUrl.voices(q) : `/voices${q}`, null, 30_000, { sideEffect: false });
    for (const v of (r.json?.voices as Record<string, unknown>[] | undefined) ?? []) {
      const voice = toVoice(v);
      if (voice && (!voice.type || voice.type === 'replicated')) out.push(voice);
    }
    const next = r.json?.next_page_token ?? r.json?.nextPageToken;
    token = typeof next === 'string' ? next : '';
    if (!token) break;
  }
  return out;
}

export async function deleteVoice(voiceId: string, route: NarratorRoute = 'developer'): Promise<'deleted' | 'already_gone'> {
  try {
    await call(route, 'DELETE', route === 'vertex' ? vertexUrl.voices(`/${encodeURIComponent(voiceId)}`) : `/voices/${encodeURIComponent(voiceId)}`, null, 30_000, { sideEffect: false });
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
  /** Why generation ended when Google said (Cloud: STOP, MAX_TOKENS…); MAX_TOKENS means the audio was cut off. */
  finish?: string | null;
}

export interface SpeechInput {
  route?: NarratorRoute;
  modelId: string;
  /** A stored voice (`voice_…`) or, on the Cloud route only, a prebuilt voice name (Cloud test). */
  voiceId: string;
  segments: { text: string; style: string }[];
  /** A whole-article take can need minutes; passage requests keep the shorter default. */
  timeoutMs?: number;
}

/**
 * One unary synthesis (WAV out). Each segment is one text block; its sustained `style` rides on that block's
 * speech metadata, never in the spoken words. Developer route: Interactions API with `store: false` (accepted,
 * verified 2026-10-17). Cloud route: generateContent with `speechMetadata` per text part (verified 2026-10-18).
 */
export async function synthesize(input: SpeechInput): Promise<SpeechResult> {
  return (input.route ?? 'developer') === 'vertex' ? synthesizeVertex(input) : synthesizeDeveloper(input);
}

async function synthesizeDeveloper(input: SpeechInput): Promise<SpeechResult> {
  const content = input.segments.map((s) => ({ type: 'text', text: s.text, ...(s.style.trim() ? { annotations: [{ type: 'speech_metadata', style: s.style.trim() }] } : {}) }));
  const r = await call(
    'developer',
    'POST',
    '/interactions',
    {
      model: input.modelId,
      input: [{ type: 'user_input', content }],
      response_format: { type: 'audio', mime_type: 'audio/wav' },
      generation_config: { speech_config: [{ voice: input.voiceId }] },
      store: false,
    },
    input.timeoutMs ?? 240_000,
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
  const { wav, sampleRate } = readAudio(Buffer.from(audio.data, 'base64'), audio.mime_type ?? null, r.status);
  const usage = (it.usage ?? {}) as { total_input_tokens?: number; total_output_tokens?: number };
  return { wav, sampleRate, inputTokens: Number(usage.total_input_tokens ?? 0), outputTokens: Number(usage.total_output_tokens ?? 0) };
}

async function synthesizeVertex(input: SpeechInput): Promise<SpeechResult> {
  const parts = input.segments.map((s) => ({ text: s.text, ...(s.style.trim() ? { speechMetadata: { style: s.style.trim() } } : {}) }));
  const stored = /^voice(?:key)?_[\w-]+$/.test(input.voiceId);
  const r = await call(
    'vertex',
    'POST',
    vertexUrl.generate(input.modelId),
    {
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: stored ? { voice: input.voiceId } : { prebuiltVoiceConfig: { voiceName: input.voiceId } } } },
    },
    input.timeoutMs ?? 240_000,
    { sideEffect: true },
  );
  const j = r.json ?? {};
  const block = (j.promptFeedback as { blockReason?: string } | undefined)?.blockReason;
  if (block) throw new NarratorProviderError('policy', `Google blocked this text (${sanitize(block)}).`, r.status, block);
  const cand = ((j.candidates as Record<string, unknown>[] | undefined) ?? [])[0];
  const finish = typeof cand?.finishReason === 'string' ? cand.finishReason : null;
  type Part = { inlineData?: { mimeType?: string; data?: string } };
  const audio = (((cand?.content as { parts?: Part[] } | undefined)?.parts ?? []) as Part[]).find((p) => p.inlineData?.data)?.inlineData;
  if (!audio?.data) {
    const policy = finish && /SAFETY|PROHIBITED|BLOCK|SPII|RECITATION/i.test(finish);
    throw new NarratorProviderError(policy ? 'policy' : 'unexpected', policy ? `Google stopped this passage (${finish}).` : `Google returned no audio for this passage${finish ? ` (finish: ${finish})` : ''} (it may still have been billed).`, r.status, finish);
  }
  const { wav, sampleRate } = readAudio(Buffer.from(audio.data, 'base64'), audio.mimeType ?? null, r.status);
  const usage = (j.usageMetadata ?? {}) as { promptTokenCount?: number; candidatesTokenCount?: number };
  return { wav, sampleRate, inputTokens: Number(usage.promptTokenCount ?? 0), outputTokens: Number(usage.candidatesTokenCount ?? 0), finish };
}

/** WAV as returned; raw 16-bit PCM (audio/L16, audio/pcm) is wrapped into a WAV at its stated rate. */
function readAudio(buf: Buffer, mime: string | null, httpStatus: number): { wav: Buffer; sampleRate: number } {
  const decoded = decodePcm16Wav(buf);
  if (decoded && decoded.samples.length) return { wav: buf, sampleRate: decoded.sampleRate };
  if (mime && /audio\/(?:L16|pcm)/i.test(mime) && buf.length >= 2) {
    const rate = Number(/rate=(\d+)/i.exec(mime)?.[1] ?? 24000);
    const n = Math.floor(buf.length / 2);
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = buf.readInt16LE(i * 2) / 32768;
    return { wav: Buffer.from(encodePcm16Wav(f, rate)), sampleRate: rate };
  }
  throw new NarratorProviderError('unexpected', `Google returned audio AZ Studio could not read (${mime ?? 'unknown type'}).`, httpStatus);
}
