import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOwner } from '../src/lib/owner';
import { toJobError, JobFailure } from '../src/lib/errors';
import { buildInteractionRequest, type VideoParams } from '../src/workers/video';
import { buildImageParts, type ImageParams } from '../src/workers/image';
import { sniffUpload } from '../src/triggers/upload';
import { normaliseSongAnalysis } from '../src/workers/text';
import { INSPECTION_SCHEMA, LYRIC_ANCHORS_SCHEMA, SONG_ANALYSIS_SCHEMA, TEXT_TASK_SPECS, VOCALS_SCHEMA } from '../src/workers/text-tasks';
import { parseTranscription, timedAudioSegments } from '../src/lib/audio-models';
import { extractMusic, isModelUnavailable } from '../src/lib/music-model';
import { normalizeReview } from '../src/workers/inspect';
import { productionEstimate, segmentPrompt } from '../src/lib/production';
import { parseLyricsText, planSceneDuration } from '@az-studio/shared';
import { IMAGE_CAPABILITIES, MODEL_REGISTRY, VIDEO_CAPABILITIES } from '../src/config/models';
import { PRICING } from '../src/config/pricing';
import { detectC2pa } from '../src/lib/media';

const owner = { uid: 'owner-uid', email: 'owner@example.com' };

describe('word-timed transcription windows', () => {
  it('covers a long film with requests below the model limit', () => {
    const segments = timedAudioSegments(31 * 60);
    expect(segments).toEqual([
      { startSec: 0, durationSec: 840 },
      { startSec: 840, durationSec: 840 },
      { startSec: 1680, durationSec: 180 },
    ]);
    expect(segments.every((segment) => segment.durationSec < 15 * 60)).toBe(true);
  });
});

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
    // Seen live (2026-09-24): continuing an Omni interaction the moment it finishes.
    expect(toJobError({ status: 400, message: '400 Previous interaction ChA3NmQ5 is in an invalid state (current state: IN_PROGRESS).' })).toMatchObject({ code: 'previous_in_progress', retryable: true });
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
    // Newest GA (production) Gemini model callable on Vertex AI for this project (verified 2026-09-24); no silent fallback.
    expect(MODEL_REGISTRY.reasoning.id).toBe('gemini-3.8-flash');
    expect(MODEL_REGISTRY.reasoning.fallbackId).toBeNull();
    expect(MODEL_REGISTRY.transcription.id).toBe('gemini-3.5-transcribe-preview');
    expect(MODEL_REGISTRY.speech.id).toBe('gemini-2.5-pro-tts');
    // Required model for songs and film score; never swapped for an older Lyria model.
    expect(MODEL_REGISTRY.music.id).toBe('lyria-3.5');
  });

  it('has a published price for every selectable option', () => {
    for (const r of VIDEO_CAPABILITIES.resolutions) expect(PRICING.video.outputTokensPerSecond[r]).toBeGreaterThan(0);
    for (const s of IMAGE_CAPABILITIES.imageSizes) expect(PRICING.image.outputTokensPerImage[s]).toBeGreaterThan(0);
    expect(PRICING.text[MODEL_REGISTRY.reasoning.id]).toBeDefined();
    expect(PRICING.vision?.perThousandUnits).toBeGreaterThan(0);
    expect(PRICING.separation?.secondsPerAudioSecond).toBeGreaterThan(0);
    expect(PRICING.speech.modelId).toBe(MODEL_REGISTRY.speech.id);
    expect(PRICING.transcription.modelId).toBe(MODEL_REGISTRY.transcription.id);
    expect(PRICING.music.modelId).toBe(MODEL_REGISTRY.music.id);
    expect(PRICING.music.perSongUsd).toBeGreaterThan(0);
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
    const idPattern = /['"`](gemini-[\w.-]+|imagen-[\w.-]+|veo-[\w.-]+|nano-banana[\w.-]*|lyria-[\w.-]+)['"`]/g;
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith(path.join('config', 'models.ts'))) continue;
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(idPattern)) offenders.push(`${path.relative(path.resolve(import.meta.dirname, '../..'), f)}: ${m[1]}`);
    }
    expect(offenders).toEqual([]);
    const registrySrc = readFileSync(path.resolve(import.meta.dirname, '../src/config/models.ts'), 'utf8');
    const ids = [...registrySrc.matchAll(/id: '([^']+)'|fallbackId: '([^']+)'/g)].map((m) => m[1] ?? m[2]);
    for (const forbidden of ['gemini-omni-flash-preview', 'gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview', 'imagen-4.0-generate-001', 'lyria-002', 'lyria-3-pro-preview', 'lyria-3-clip-preview']) expect(ids).not.toContain(forbidden);
  });
});

describe('structured output schemas', () => {
  // Vertex AI answers 400 INVALID_ARGUMENT for maxItems on arrays of objects (found in production).
  const offending = (schema: unknown, path = '$'): string[] => {
    if (!schema || typeof schema !== 'object') return [];
    const s = schema as Record<string, unknown>;
    const here = s.type === 'array' && 'maxItems' in s && (s.items as Record<string, unknown> | undefined)?.type === 'object' ? [path] : [];
    return [...here, ...Object.entries(s).flatMap(([k, v]) => offending(v, `${path}.${k}`))];
  };
  it('never limit the length of object arrays', () => {
    for (const [task, spec] of Object.entries(TEXT_TASK_SPECS)) expect(offending(spec.schema), task).toEqual([]);
    expect(offending(SONG_ANALYSIS_SCHEMA)).toEqual([]);
    for (const schema of [INSPECTION_SCHEMA, VOCALS_SCHEMA, LYRIC_ANCHORS_SCHEMA]) expect(offending(schema)).toEqual([]);
  });
});

describe('transcription parsing (Vertex generateContent audioTranscriptionConfig)', () => {
  it('reads word offsets exactly as the API returns them', () => {
    // Shape of a real gemini-3.5-transcribe-preview response on Vertex AI (verified 2026-09-24).
    const res = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: 'We have crossed the reef.',
                audioTranscription: {
                  text: 'We have crossed the reef.',
                  words: [
                    { word: 'We', startOffset: '0.300s', endOffset: '0.800s' },
                    { word: 'have', startOffset: '0.800s', endOffset: '1s' },
                    { word: ' ', startOffset: '1s', endOffset: '1s' },
                    { word: 'reef.', startOffset: '1.700s', endOffset: '2.400s' },
                  ],
                },
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 143, candidatesTokenCount: 13 },
    };
    const t = parseTranscription(res as never);
    expect(t.text).toBe('We have crossed the reef.');
    expect(t.words).toEqual([
      { text: 'We', start: 0.3, end: 0.8, speaker: null },
      { text: 'have', start: 0.8, end: 1, speaker: null },
      { text: 'reef.', start: 1.7, end: 2.4, speaker: null },
    ]);
    expect(t.usage).toEqual({ input: 143, output: 13, thoughts: 0 });
  });
});

describe('Lyria output', () => {
  it('extracts the audio and the timed lyrics / caption text exactly as returned', () => {
    const interaction = {
      id: 'i1',
      status: 'completed',
      steps: [
        {
          type: 'model_output',
          content: [
            { type: 'text', text: '[0.0:4.8] Morning light upon the Volta' },
            { type: 'text', text: 'Caption: Highlife.\nBPM: 100.0' },
            { type: 'audio', data: Buffer.from('ID3').toString('base64'), mime_type: 'audio/mpeg' },
          ],
        },
      ],
    };
    const m = extractMusic(interaction);
    expect(m.audio?.mime_type).toBe('audio/mpeg');
    const parsed = parseLyricsText(m.text);
    expect(parsed.lines[0]).toMatchObject({ text: 'Morning light upon the Volta', start: 0, end: 4.8 });
    expect(parsed.meta.bpm).toBe(100);
    expect(parsed.meta.caption).toBe('Highlife.');
  });

  it('recognises the exact Vertex AI rejection for a model the project cannot use', () => {
    // Verbatim error returned for lyria-3.5 on project az-learner (2026-09-24).
    expect(isModelUnavailable(new Error('400 Unsupported model interaction: lyria-3.5'))).toBe(true);
    expect(isModelUnavailable(new Error('Publisher Model projects/az-learner/locations/global/publishers/google/models/lyria-3.5 not found.'))).toBe(true);
    expect(isModelUnavailable(new Error('Quota exceeded for aiplatform.googleapis.com'))).toBe(false);
  });
});

describe('inspection review normalisation', () => {
  it('fills neutral defaults and turns -1 times and scores into null', () => {
    const r = normalizeReview({
      summary: 'Door closes after the cut.',
      actions: [{ beat: 'door closes', completed: false, startSec: 4.2, endSec: -1 }],
      scores: { overallUsability: 81, characterContinuity: -1 },
      recommendedRepair: { type: 'extend_scene', instruction: 'Let the door close.', sectionStartSec: -1, sectionEndSec: -1, rationale: '' },
    });
    expect(r.actions[0]).toMatchObject({ beat: 'door closes', completed: false, startSec: 4.2, endSec: null });
    expect(r.scores.characterContinuity).toBeNull();
    expect(r.scores.overallUsability).toBe(81);
    expect(r.recommendedRepair).toMatchObject({ type: 'extend_scene', sectionStartSec: null, sectionEndSec: null });
    expect(r.lipSync.drift).toBe('none');
    expect(normalizeReview({ recommendedRepair: { type: 'none' } }).recommendedRepair).toBeNull();
    expect(normalizeReview({ recommendedRepair: { type: 'make_it_better' } }).recommendedRepair).toBeNull();
  });
});

describe('connected-shot prompts', () => {
  it('gives each part only its own sentences and never restarts the dialogue', () => {
    const plan = planSceneDuration({
      lines: [
        { index: 0, character: 'AMA', text: 'We have crossed the reef, but the journey has only begun. The tide will turn before nightfall, and we must be ready.', seconds: 7.2, measured: true },
        { index: 1, character: 'KOFI', text: 'Then we sail at first light. Tell the others to rest while they still can.', seconds: 4.6, measured: true },
      ],
      action: '',
      requestedSec: 8,
      ensureCompleteDialogue: true,
      ensureCompleteAction: true,
      caps: { minSec: 3, maxSec: 10, maxChainSec: 40 },
    });
    expect(plan.requiredSec).toBeGreaterThan(8);
    expect(plan.strategy).toBe('extend_chain');
    expect(plan.segments.length).toBeGreaterThanOrEqual(2);
    const base = ['Single continuous shot, no cuts.', 'Medium two-shot on the deck.', 'Dialogue: AMA says: "We have crossed the reef, but the journey has only begun. The tide will turn before nightfall, and we must be ready." KOFI says: "Then we sail at first light. Tell the others to rest while they still can."', 'Sound design: waves.'].join('\n');
    const prompts = plan.segments.map((seg) => segmentPrompt(base, plan, seg));
    expect(prompts[0]).toContain('Dialogue (this part only');
    for (const later of prompts.slice(1)) {
      expect(later).toMatch(/^Continue this exact scene/);
      expect(later).toContain('do not repeat anything already said');
    }
    // A review of an existing take is priced as one inspection; a production adds guide audio and generations.
    const draft = { dialogueAudio: { mode: 'generated', lines: [{ index: 0, character: 'AMA', text: 'We have crossed the reef.', assetId: null, seconds: null, estimatedSec: 1.8, voice: null }], jobId: null, note: '' }, request: { prompt: base, resolution: '360p', media: [] }, plan };
    const review = productionEstimate(draft as never, plan, { reviewSec: 4 });
    const full = productionEstimate(draft as never, plan);
    expect(review.usd).toBeGreaterThan(0);
    expect(review.usd).toBeLessThan(full.usd);
    // Every sentence is spoken in exactly one part.
    const sentences = plan.segments.flatMap((seg) => seg.units.map((u) => u.text));
    expect(sentences.join(' ')).toBe('We have crossed the reef, but the journey has only begun. The tide will turn before nightfall, and we must be ready. Then we sail at first light. Tell the others to rest while they still can.');
    for (const sentence of sentences) expect(prompts.filter((pr) => pr.includes(sentence))).toHaveLength(1);
  });
});
