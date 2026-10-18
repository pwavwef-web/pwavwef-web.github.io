import { afterEach, describe, expect, it } from 'vitest';
import { encodePcm16Wav } from '@az-studio/shared';
import { createVoice, deleteVoice, NarratorProviderError, sanitize, setFetchForTests, setProviderKeyForTests, synthesize } from '../src/lib/narrator-provider';
import { checkImportUrl, importArticle, isPrivateAddress, setImportFetcherForTests } from '../src/lib/narrator-import';

/** The REST adapter against a fake fetch (MOCKED — request/response shapes from Google's documentation and the 2026-10-17 probes). */

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (c: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  setFetchForTests((async (url: string, init: RequestInit) => {
    const c = { url: String(url), init };
    calls.push(c);
    return respond(c);
  }) as unknown as typeof fetch);
  return calls;
}

const wavB64 = Buffer.from(encodePcm16Wav(new Float32Array(2400).fill(0.1), 24000)).toString('base64');

afterEach(() => {
  setFetchForTests(null);
  setProviderKeyForTests(undefined);
  setImportFetcherForTests(null);
});

describe('provider adapter', () => {
  it('reports a setup state, not a fake success, when no key is configured', async () => {
    setProviderKeyForTests(null);
    await expect(synthesize({ modelId: 'm', voiceId: 'voice_x', segments: [{ text: 'Hi', style: '' }] })).rejects.toMatchObject({ kind: 'not_configured' });
  });

  it('sends the documented Interactions request (style as speech_metadata, store false) and reads the WAV', async () => {
    setProviderKeyForTests('test-key');
    const calls = fakeFetch(() => new Response(JSON.stringify({ status: 'completed', usage: { total_input_tokens: 12, total_output_tokens: 96 }, steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: wavB64 }] }] }), { status: 200 }));
    const r = await synthesize({ modelId: 'gemini-3.8-flash-tts', voiceId: 'voice_abc', segments: [{ text: 'Hello there.', style: 'natural and conversational' }] });
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: 'gemini-3.8-flash-tts',
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'Hello there.', annotations: [{ type: 'speech_metadata', style: 'natural and conversational' }] }] }],
      response_format: { type: 'audio', mime_type: 'audio/wav' },
      generation_config: { speech_config: [{ voice: 'voice_abc' }] },
      store: false,
    });
    expect(r).toMatchObject({ sampleRate: 24000, inputTokens: 12, outputTokens: 96 });
  });

  it('creates a stateful replicated voice with both recordings as base64 WAV', async () => {
    setProviderKeyForTests('k');
    const calls = fakeFetch(() => new Response(JSON.stringify({ id: 'voice_new123', type: 'replicated', display_name: 'Francis — Pwavwe Papers' }), { status: 200 }));
    const r = await createVoice({ modelId: 'gemini-3.8-flash-tts', displayName: 'Francis — Pwavwe Papers', referenceWav: Buffer.from('REF'), consentWav: Buffer.from('CON') });
    expect(r.voiceId).toBe('voice_new123');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(calls[0]!.url).toMatch(/\/v1beta\/voices$/);
    expect(body).toEqual({ store: true, voice: { model: 'gemini-3.8-flash-tts', type: 'replicated', display_name: 'Francis — Pwavwe Papers', replicated: { source_audio: { mime_type: 'audio/wav', data: Buffer.from('REF').toString('base64') }, consent_audio: { mime_type: 'audio/wav', data: Buffer.from('CON').toString('base64') } } } });
  });

  it('classifies failures: refusals are definite, dropped connections are ambiguous, 429 is retryable', async () => {
    setProviderKeyForTests('k');
    fakeFetch(() => new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Consent audio could not be verified against the source speaker.' } }), { status: 400 }));
    await expect(createVoice({ modelId: 'm', displayName: 'x', referenceWav: Buffer.from('a'), consentWav: Buffer.from('b') })).rejects.toMatchObject({ kind: 'policy', httpStatus: 400 });
    fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const amb = await synthesize({ modelId: 'm', voiceId: 'voice_a', segments: [{ text: 't', style: '' }] }).catch((e) => e as NarratorProviderError);
    expect(amb).toMatchObject({ kind: 'ambiguous' });
    expect((amb as NarratorProviderError).retryable).toBe(false);
    fakeFetch(() => new Response(JSON.stringify({ error: { message: 'Rate limit exceeded, try again later' } }), { status: 429 }));
    const rl = await synthesize({ modelId: 'm', voiceId: 'voice_a', segments: [{ text: 't', style: '' }] }).catch((e) => e as NarratorProviderError);
    expect((rl as NarratorProviderError).retryable).toBe(true);
    fakeFetch(() => new Response('{}', { status: 404 }));
    expect(await deleteVoice('voice_gone')).toBe('already_gone');
  });

  it('never echoes keys or stateless voice keys in messages', () => {
    expect(sanitize('bad key AIzaSyA1234567890abcdefghijk and voicekey_secret123 at https://x?key=abc&y=1')).toBe('bad key [key] and voicekey_[redacted] at https://x?key=[redacted]&y=1');
  });
});

describe('URL import safety', () => {
  it('accepts only https Pwavwe Papers addresses', () => {
    expect(checkImportUrl('https://blogs.pwavwe.com/2026/10/x.html#top').toString()).toBe('https://blogs.pwavwe.com/2026/10/x.html');
    for (const bad of ['http://blogs.pwavwe.com/x', 'https://evil.com/x', 'https://blogs.pwavwe.com.evil.com/x', 'https://user:pw@blogs.pwavwe.com/x', 'https://blogs.pwavwe.com:8443/x', 'file:///etc/passwd', 'not a url']) expect(() => checkImportUrl(bad)).toThrow();
  });

  it('treats private, loopback, link-local and metadata addresses as non-public', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['142.250.80.1', '2607:f8b0:4004:800::2004']) expect(isPrivateAddress(ip)).toBe(false);
  });

  it('re-checks every redirect and refuses one that leaves the allowed host', async () => {
    setImportFetcherForTests(async () => ({ status: 302, location: 'http://169.254.169.254/latest/meta-data', contentType: '', body: Buffer.alloc(0) }));
    await expect(importArticle('https://blogs.pwavwe.com/2026/10/x.html')).rejects.toThrow(/https/);
    setImportFetcherForTests(async () => ({ status: 200, location: null, contentType: 'application/json', body: Buffer.from('{}') }));
    await expect(importArticle('https://blogs.pwavwe.com/2026/10/x.html')).rejects.toThrow(/not an HTML page/);
  });

  it('falls back to review when the page has no article body', async () => {
    setImportFetcherForTests(async () => ({ status: 200, location: null, contentType: 'text/html; charset=UTF-8', body: Buffer.from('<html><body><p>Just a page</p></body></html>') }));
    const r = await importArticle('https://blogs.pwavwe.com/');
    expect(r.confidence).toBe('review');
    expect(r.body).toBe('');
  });
});
