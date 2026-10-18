import { describe, expect, it } from 'vitest';
import { GOOGLE_VOICES, googleVoiceId, googleVoiceLabel, googleVoiceOf, narratorRequestSchema, normalizeNarratorSettings } from '../src';

describe('Google voices', () => {
  it('lists the 30 prebuilt voices once each, with a character and a gender hint', () => {
    expect(GOOGLE_VOICES).toHaveLength(30);
    expect(new Set(GOOGLE_VOICES.map((v) => v.name)).size).toBe(30);
    for (const v of GOOGLE_VOICES) expect(v.character.length).toBeGreaterThan(2);
  });

  it('round-trips edition voice ids and never mistakes a replicated voice for a prebuilt one', () => {
    expect(googleVoiceId('Kore')).toBe('google-Kore');
    expect(googleVoiceOf('google-Kore')).toMatchObject({ name: 'Kore', character: 'Firm' });
    expect(googleVoiceOf('google-Nobody')).toBeNull();
    expect(googleVoiceOf('v-v08d7ffb5df8d485691927b995e494937')).toBeNull();
    expect(googleVoiceOf(null)).toBeNull();
    expect(googleVoiceLabel(googleVoiceOf('google-Sulafat')!)).toBe('Sulafat — Warm (Google voice)');
  });

  it('fits the request id format, so editions can store one', () => {
    for (const v of GOOGLE_VOICES) {
      const r = narratorRequestSchema.safeParse({ op: 'editionSave', editionId: 'e1', baseRev: 1, patch: { voiceId: googleVoiceId(v.name) } });
      expect(r.success, v.name).toBe(true);
    }
  });
});

describe('noise reduction setting', () => {
  it('defaults to standard and accepts only the known levels', () => {
    expect(normalizeNarratorSettings(null).noiseReduction).toBe('standard');
    expect(normalizeNarratorSettings({ noiseReduction: 'strong' }).noiseReduction).toBe('strong');
    expect(normalizeNarratorSettings({ noiseReduction: 'off' }).noiseReduction).toBe('off');
    expect(normalizeNarratorSettings({ noiseReduction: 'loud' as never }).noiseReduction).toBe('standard');
    expect(narratorRequestSchema.safeParse({ op: 'profileSave', settings: { noiseReduction: 'strong' } }).success).toBe(true);
    expect(narratorRequestSchema.safeParse({ op: 'profileSave', settings: { noiseReduction: 'loud' } }).success).toBe(false);
  });
});
