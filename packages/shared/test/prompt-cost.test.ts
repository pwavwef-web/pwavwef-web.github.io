import { describe, expect, it } from 'vitest';
import { compileImagePrompt, compileShotPrompt, EMPTY_DIRECTIONS, inferVideoTask, planOmniMedia, withDeclaration } from '../src/prompt';
import { costFromUsage, estimateImage, estimateRender, estimateText, estimateVideo, sumEstimates, type PricingTable } from '../src/cost';

/** Mirrors Google's published Vertex AI prices (retrieved 2026-09-21). */
const table: PricingTable = {
  version: 'test',
  source: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
  retrievedAt: '2026-09-21',
  currency: 'USD',
  video: {
    modelId: 'omni',
    inputPerM: 1.5,
    textOutputPerM: 9,
    videoOutputPerM: 17.5,
    outputTokensPerSecond: { '360p': 1931, '720p': 5792, '1080p': 8688, '4k': 17376 },
    inputTokensPerImage: 1120,
    inputTokensPerVideoSecond: 5792,
    expectedThoughtTokens: 600,
  },
  image: {
    modelId: 'nbp',
    inputPerM: 2,
    textOutputPerM: 12,
    imageOutputPerM: 120,
    outputTokensPerImage: { '1K': 1120, '2K': 1120, '4K': 2000 },
    inputTokensPerImage: 560,
    expectedThoughtTokens: 300,
  },
  text: { pro: { inputPerM: 2, outputPerM: 12, inputPerMLong: 4, outputPerMLong: 18, longContextThreshold: 200000, audioTokensPerSecond: 32 } },
  speech: { modelId: 'tts', inputPerM: 1, outputPerM: 20, audioTokensPerSecond: 25 },
  transcription: { modelId: 'asr', inputPerM: 2, outputPerM: 12, audioTokensPerSecond: 25 },
  music: { modelId: 'lyria', perSongUsd: 0.08, source: 'x' },
  inspection: { videoTokensPerFrame: 258, audioTokensPerSecond: 32, framesPerSecond: 2, expectedOutputTokens: 6000 },
  render: { vcpu: 4, memoryGiB: 16, perVcpuSecond: 0.000018, perGiBSecond: 0.000002, secondsPerOutputSecond: { draft: 0.5, final: 1.5 }, overheadSeconds: 60, source: 'x' },
};

describe('Omni media planning', () => {
  it('binds first/last frames and references explicitly', () => {
    const { media, declaration } = planOmniMedia([
      { role: 'image_ref', assetId: 'r1' },
      { role: 'first_frame', assetId: 'f' },
      { role: 'video_ref', assetId: 'v1' },
      { role: 'last_frame', assetId: 'l' },
      { role: 'image_ref', assetId: 'r2' },
    ]);
    expect(media.map((m) => [m.assetId, m.tag, m.binding])).toEqual([
      ['f', '<FIRST_FRAME>', 'Image1'],
      ['l', '<LAST_FRAME>', 'Image2'],
      ['r1', '<IMAGE_REF_0>', 'Image3'],
      ['r2', '<IMAGE_REF_1>', 'Image4'],
      ['v1', '<VIDEO_REF_0>', 'Video1'],
    ]);
    expect(declaration).toBe('[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2] [# References <IMAGE_REF_0>@Image3 <IMAGE_REF_1>@Image4 <VIDEO_REF_0>@Video1]');
  });

  it('drops a last frame without a first frame (Omni requires both)', () => {
    const { media, declaration } = planOmniMedia([{ role: 'last_frame', assetId: 'l' }]);
    expect(media).toEqual([]);
    expect(declaration).toBe('');
  });

  it('infers tasks only when unambiguous', () => {
    expect(inferVideoTask([], false)).toBe('text_to_video');
    expect(inferVideoTask([{ role: 'first_frame', assetId: 'a' }], false)).toBe('image_to_video');
    expect(inferVideoTask([{ role: 'image_ref', assetId: 'a' }], false)).toBe('reference_to_video');
    expect(inferVideoTask([{ role: 'first_frame', assetId: 'a' }, { role: 'image_ref', assetId: 'b' }], false)).toBeUndefined();
    expect(inferVideoTask([], true)).toBeUndefined();
    expect(inferVideoTask([], false, 'extend')).toBe('extend');
    // A follow-up on a stored interaction never carries a task (Vertex AI rejects the combination).
    expect(inferVideoTask([], true, 'extend')).toBeUndefined();
    expect(inferVideoTask([], true, 'edit')).toBeUndefined();
  });
});

describe('prompt compilation', () => {
  it('compiles directions, references and dialogue into prompt text', () => {
    const p = compileShotPrompt(
      {
        ...EMPTY_DIRECTIONS,
        framing: 'Close-up',
        lens: '85mm portrait lens',
        cameraMovement: 'Slow push-in',
        action: 'Ama lifts her head and smiles',
        lighting: 'Golden hour sunlight',
        dialogue: [{ character: 'Ama', line: 'We made it "home"' }],
        ambientSound: 'distant drums',
        avoid: 'text overlays',
      },
      { characters: [{ tag: '<IMAGE_REF_0>', name: 'Ama', description: 'braided hair, indigo kente' }], styleBible: { palette: 'indigo and gold' } },
    );
    expect(p).toContain('Single continuous shot, no cuts.');
    expect(p).toContain('Close-up, 85mm portrait lens. Slow push-in.');
    expect(p).toContain('Characters: <IMAGE_REF_0> Ama (braided hair, indigo kente).');
    expect(p).toContain("Ama says: \"We made it 'home'\"");
    expect(p).toContain('Colour palette: indigo and gold.');
    expect(p).toContain('Avoid: Do not include text overlays.');
    expect(withDeclaration('[# Sources <FIRST_FRAME>@Image1]', 'body')).toBe('[# Sources <FIRST_FRAME>@Image1]\nbody');
  });

  it('states when there is no dialogue', () => {
    expect(compileShotPrompt(EMPTY_DIRECTIONS, { singleContinuousShot: false })).toBe('Dialogue: No dialogue.');
    expect(compileShotPrompt(EMPTY_DIRECTIONS, { singleContinuousShot: false, noOverlayText: true })).toMatch(/no captions, subtitles, titles or name labels/);
  });

  it('prefixes image purposes', () => {
    expect(compileImagePrompt('turnaround', 'Ama')).toMatch(/^Character turnaround reference sheet/);
    expect(compileImagePrompt('free', 'A lighthouse')).toBe('A lighthouse');
  });
});

describe('cost estimation', () => {
  it('uses published per-second video token rates', () => {
    const e = estimateVideo({ resolution: '720p', outputSeconds: 5, promptChars: 0, imageInputs: 0, videoInputSeconds: 0, task: 'text_to_video' }, table);
    // 5 s × 5792 tokens × $17.50/M = $0.5068, plus 600 reasoning tokens × $9/M = $0.0054
    expect(e.breakdown[0]!.usd).toBeCloseTo(0.5068, 4);
    expect(e.usd).toBeCloseTo(0.5122, 4);
    expect(e.basis).toBe('published_rate');
  });

  it('refuses to guess for unknown resolutions', () => {
    const e = estimateVideo({ resolution: '8k', outputSeconds: 5, promptChars: 0, imageInputs: 0, videoInputSeconds: 0, task: 'text_to_video' }, table);
    expect(e.basis).toBe('none');
    expect(e.usd).toBe(0);
  });

  it('estimates images from published per-image tokens', () => {
    const e = estimateImage({ imageSize: '4K', referenceImages: 2, promptChars: 400, outputs: 2 }, table);
    expect(e.breakdown[0]!.usd).toBeCloseTo((2 * 2000 * 120) / 1e6, 6);
    expect(e.confidence).toBe('high');
  });

  it('estimates text, render and sums', () => {
    const t = estimateText({ modelId: 'pro', inputChars: 4000, expectedOutputTokens: 2000, audioSeconds: 60 }, table);
    expect(t.usd).toBeCloseTo(((1000 + 1920) * 2 + 2000 * 12) / 1e6, 6);
    const r = estimateRender({ durationSec: 180, quality: 'final' }, table);
    expect(r.basis).toBe('compute');
    const s = sumEstimates([t, r], table);
    expect(s.usd).toBeCloseTo(t.usd + r.usd, 4);
    expect(s.confidence).toBe('low');
  });

  it('prices recorded usage', () => {
    // Values from the live Omni gate test: 41 input, 5793 video output, 529 thought tokens.
    const usd = costFromUsage('video', { inputTokens: 41, outputTokens: 5793, thoughtTokens: 529, outputByModality: { video: 5793 } }, table);
    expect(usd).toBeCloseTo(0.1062, 3);
    const img = costFromUsage('image', { inputTokens: 31, outputTokens: 1120, thoughtTokens: 256, outputByModality: { image: 1120 } }, table);
    expect(img).toBeCloseTo(0.1375, 3);
  });
});
