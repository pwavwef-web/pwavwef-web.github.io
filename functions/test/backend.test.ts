import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOwner } from '../src/lib/owner';
import { toJobError, JobFailure } from '../src/lib/errors';
import { buildInteractionRequest, type VideoParams } from '../src/workers/video';
import { buildImageParts, type ImageParams } from '../src/workers/image';
import { sniffUpload } from '../src/triggers/upload';
import { normaliseSongAnalysis } from '../src/workers/text';
import { IMAGE_CAPABILITIES, MODEL_REGISTRY, VIDEO_CAPABILITIES } from '../src/config/models';
import { PRICING } from '../src/config/pricing';
import { detectC2pa } from '../src/lib/media';

const owner = { uid: 'owner-uid', email: 'owner@example.com' };

describe('owner guard', () => {
  it('requires the configured uid and verified email', () => {
    expect(isOwner({ uid: 'owner-uid', token: { email: 'Owner@Example.com', email_verified: true } }, owner)).toBe(true);
    expect(isOwner({ uid: 'owner-uid', token: { email: 'owner@example.com', email_verified: false } }, owner)).toBe(false);
    expect(isOwner({ uid: 'someone-else', token: { email: 'owner@example.com', email_verified: true } }, owner)).toBe(false);
    expect(isOwner({ uid: 'owner-uid', token: { email: 'attacker@example.com', email_verified: true } }, owner)).toBe(false);
    expect(isOwner(null, owner)).toBe(false);
  });
});

describe('error mapping', () => {
  it('classifies safety, quota, permission and transient errors', () => {
    expect(toJobError({ status: 400, message: 'The request was blocked by Responsible AI practices' })).toMatchObject({ code: 'safety_blocked', safety: true, retryable: false });
    expect(toJobError({ status: 429, message: 'RESOURCE_EXHAUSTED' })).toMatchObject({ code: 'quota', retryable: true });
    expect(toJobError({ status: 403, message: 'PERMISSION_DENIED' })).toMatchObject({ code: 'permission', retryable: false });
    expect(toJobError({ status: 404, message: 'Publisher model not found' })).toMatchObject({ code: 'not_found' });
    expect(toJobError({ status: 400, message: 'Unsupported model interaction: x' })).toMatchObject({ code: 'invalid_request', retryable: false });
    expect(toJobError({ status: 503, message: 'UNAVAILABLE' })).toMatchObject({ code: 'unavailable', retryable: true });
    expect(toJobError(new Error('fetch failed'))).toMatchObject({ retryable: true });
    const f = new JobFailure({ code: 'x', message: 'y', retryable: false });
    expect(toJobError(f)).toBe(f.jobError);
  });
});

describe('Omni request builder', () => {
  const base: VideoParams = {
    mode: 'generate',
    task: 'image_to_video',
    aspectRatio: '9:16',
    resolution: '1080p',
    resolutionExplicit: true,
    durationSec: 6,
    prompt: '[# Sources <FIRST_FRAME>@Image1]\nA dancer spins.',
    promptBody: 'A dancer spins.',
    media: [{ role: 'first_frame', assetId: 'a1', kind: 'image', tag: '<FIRST_FRAME>', binding: 'Image1', storagePath: 'users/u/uploads/a1/f.png', mimeType: 'image/png', durationSec: null }],
    previousInteractionId: null,
    chainFallback: null,
    title: null,
  };

  it('sends only documented fields in the documented shape', () => {
    const r = buildInteractionRequest(base, 'users/u/generated/j1/');
    expect(r).toMatchObject({
      model: MODEL_REGISTRY.video.id,
      background: true,
      store: true,
      response_format: [{ type: 'video', delivery: 'uri', aspect_ratio: '9:16', resolution: '1080p', duration: '6s' }],
      generation_config: { video_config: { task: 'image_to_video' } },
    });
    expect((r.response_format[0] as { gcs_uri: string }).gcs_uri).toMatch(/^gs:\/\/.+\/users\/u\/generated\/j1\/$/);
    expect(r.input[0]!.content).toEqual([
      { type: 'text', text: base.prompt },
      { type: 'image', uri: expect.stringMatching(/^gs:\/\/.+\/users\/u\/uploads\/a1\/f\.png$/), mime_type: 'image/png' },
    ]);
    expect(r).not.toHaveProperty('previous_interaction_id');
  });

  it('omits unset options and continues chains', () => {
    const r = buildInteractionRequest({ ...base, mode: 'edit', task: null, aspectRatio: null, durationSec: null, media: [], previousInteractionId: 'int-123' }, 'p/');
    expect(r.previous_interaction_id).toBe('int-123');
    expect(r).not.toHaveProperty('generation_config');
    expect(r.response_format[0]).not.toHaveProperty('aspect_ratio');
    expect(r.response_format[0]).not.toHaveProperty('duration');
  });
});

describe('Nano Banana request builder', () => {
  it('puts the edited image first, then references, then the instruction', () => {
    const p: ImageParams = {
      mode: 'edit',
      purpose: 'free',
      prompt: 'Make it night',
      promptBody: 'Make it night',
      aspectRatio: '16:9',
      imageSize: '2K',
      source: { assetId: 's', storagePath: 'users/u/generated/j/s.png', mimeType: 'image/png' },
      references: [{ assetId: 'r', storagePath: 'users/u/uploads/r/r.jpg', mimeType: 'image/jpeg', title: 'Ama' }],
      grounding: false,
      collections: [],
      characterIds: [],
      title: null,
    };
    const parts = buildImageParts(p);
    expect(parts[0]!.fileData?.fileUri).toMatch(/s\.png$/);
    expect(parts[1]!.fileData?.mimeType).toBe('image/jpeg');
    expect(parts[2]!.text).toContain('Edit the first image. Make it night');
    expect(parts[2]!.text).toContain('1. Ama');
  });
});

describe('upload sniffing', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
  const mp4 = Buffer.concat([Buffer.from('000000206674797069736f6d0000020069736f6d69736f326176633161766331', 'hex'), Buffer.alloc(64)]);
  // ID3v2 tag (empty) followed by an MPEG-1 Layer III frame header.
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.from('fffb9064', 'hex'), Buffer.alloc(400)]);
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]);

  it('accepts real media and rejects disguised files', async () => {
    expect(await sniffUpload('image', png)).toEqual({ ok: true, mimeType: 'image/png' });
    expect(await sniffUpload('video', mp4)).toEqual({ ok: true, mimeType: 'video/mp4' });
    expect(await sniffUpload('audio', mp3)).toEqual({ ok: true, mimeType: 'audio/mpeg' });
    expect((await sniffUpload('image', exe)).ok).toBe(false);
    expect((await sniffUpload('video', png)).ok).toBe(false);
    expect(await sniffUpload('document', Buffer.from('Verse one\nlyrics here', 'utf8'))).toEqual({ ok: true, mimeType: 'text/plain' });
    expect((await sniffUpload('document', Buffer.from([0x41, 0x00, 0x42]))).ok).toBe(false);
  });

  it('detects embedded C2PA manifests', () => {
    expect(detectC2pa(Buffer.from('....jumb....c2pa....'))).toBe('present');
    expect(detectC2pa(png)).toBe('absent');
  });
});

describe('song analysis normalisation', () => {
  it('clamps times, drops invalid entries and maps unknown labels', () => {
    const r = normaliseSongAnalysis(
      {
        sections: [
          { label: 'chorus', name: 'Chorus 1', start: 30, end: 45 },
          { label: 'intro', name: 'Intro', start: -2, end: 12 },
          { label: 'weird', name: 'X', start: 50, end: 40 },
          { label: 'drop', name: 'Drop', start: 170, end: 400 },
        ],
        lyrics: [
          { start: 12.5, end: 15, text: '  Hello  ' },
          { start: 20, end: 19, text: 'bad' },
          { start: 21, end: 22, text: '' },
        ],
      },
      180,
    );
    expect(r.sections.map((s) => [s.label, s.start, s.end])).toEqual([
      ['intro', 0, 12],
      ['chorus', 30, 45],
      ['drop', 170, 180],
    ]);
    expect(r.lyrics).toEqual([{ id: 'ly_0', start: 12.5, end: 15, text: 'Hello' }]);
  });
});

describe('model registry', () => {
  it('uses the verified production model IDs', () => {
    expect(MODEL_REGISTRY.video.id).toBe('gemini-omni-1.1-flash-preview');
    expect(MODEL_REGISTRY.image.id).toBe('gemini-3-pro-image');
    expect(MODEL_REGISTRY.reasoning.id).toBe('gemini-3.1-pro-preview');
  });

  it('has a published price for every selectable option', () => {
    for (const r of VIDEO_CAPABILITIES.resolutions) expect(PRICING.video.outputTokensPerSecond[r]).toBeGreaterThan(0);
    for (const s of IMAGE_CAPABILITIES.imageSizes) expect(PRICING.image.outputTokensPerImage[s]).toBeGreaterThan(0);
    expect(PRICING.text[MODEL_REGISTRY.reasoning.id]).toBeDefined();
    expect(PRICING.text[MODEL_REGISTRY.reasoning.fallbackId]).toBeDefined();
  });

  it('defines model IDs only in the registry and never uses forbidden legacy models', () => {
    const roots = [path.resolve(import.meta.dirname, '../src'), path.resolve(import.meta.dirname, '../../apps/web/src'), path.resolve(import.meta.dirname, '../../services/renderer/src'), path.resolve(import.meta.dirname, '../../packages/shared/src')];
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    roots.forEach((r) => {
      try {
        walk(r);
      } catch {
        /* workspace may not exist yet */
      }
    });
    const idPattern = /['"`](gemini-[\w.-]+|imagen-[\w.-]+|veo-[\w.-]+|nano-banana[\w.-]*)['"`]/g;
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith(path.join('config', 'models.ts'))) continue;
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(idPattern)) offenders.push(`${path.relative(path.resolve(import.meta.dirname, '../..'), f)}: ${m[1]}`);
    }
    expect(offenders).toEqual([]);
    const registrySrc = readFileSync(path.resolve(import.meta.dirname, '../src/config/models.ts'), 'utf8');
    const ids = [...registrySrc.matchAll(/id: '([^']+)'|fallbackId: '([^']+)'/g)].map((m) => m[1] ?? m[2]);
    for (const forbidden of ['gemini-omni-flash-preview', 'gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview', 'imagen-4.0-generate-001']) expect(ids).not.toContain(forbidden);
  });
});
