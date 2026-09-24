import type { PricingTable } from '@az-studio/shared';
import { MODEL_REGISTRY } from './models';

/**
 * Published list prices (USD, standard pay-as-you-go, global endpoint).
 * Source: https://cloud.google.com/vertex-ai/generative-ai/pricing — retrieved 2026-09-21.
 * Cloud Run jobs: https://cloud.google.com/run/pricing (Tier 1, instance-based) — retrieved 2026-09-21.
 *
 * These are *list* prices used for estimates. Actual charges appear in Cloud Billing and may differ
 * (free tiers, credits, discounts, taxes). `expectedThoughtTokens` values are AZ Studio estimates
 * based on observed usage and are labelled as such in the UI.
 */
export const PRICING: PricingTable = {
  version: 'vertex-2026-09-21',
  source: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
  retrievedAt: '2026-09-21',
  currency: 'USD',
  video: {
    modelId: MODEL_REGISTRY.video.id,
    inputPerM: 1.5,
    textOutputPerM: 9.0,
    videoOutputPerM: 17.5,
    // "1931 tokens per second of 360p video, 5792 … 720p, 8688 … 1080p, 17376 … 4k (with audio)"
    outputTokensPerSecond: { '360p': 1931, '720p': 5792, '1080p': 8688, '4k': 17376 },
    // "1120 tokens per image … 5792 tokens per video second for inputs"
    inputTokensPerImage: 1120,
    inputTokensPerVideoSecond: 5792,
    // Observed ≈530 thought tokens on a 3 s test; estimate.
    expectedThoughtTokens: 800,
  },
  image: {
    modelId: MODEL_REGISTRY.image.id,
    inputPerM: 2.0,
    textOutputPerM: 12.0,
    imageOutputPerM: 120.0,
    // "1120 tokens ($0.134) for 1K and 2K … 2000 tokens ($0.24) for 4K"
    outputTokensPerImage: { '1K': 1120, '2K': 1120, '4K': 2000 },
    // "560 tokens per input image"
    inputTokensPerImage: 560,
    // Observed 256 thought tokens on a 1K test; estimate.
    expectedThoughtTokens: 400,
  },
  text: {
    [MODEL_REGISTRY.reasoning.id]: { inputPerM: 2.0, outputPerM: 12.0, inputPerMLong: 4.0, outputPerMLong: 18.0, longContextThreshold: 200_000, audioTokensPerSecond: 32 },
    [MODEL_REGISTRY.reasoning.fallbackId]: { inputPerM: 1.25, outputPerM: 10.0, inputPerMLong: 2.5, outputPerMLong: 15.0, longContextThreshold: 200_000, audioTokensPerSecond: 32 },
  },
  // Published 2026-09 (https://ai.google.dev/gemini-api/docs/pricing, Vertex AI list prices match):
  // "Gemini 2.5 Pro TTS — Input $1.00 (text), Output $20.00 (audio)"; observed 25 audio tokens/s.
  speech: { modelId: MODEL_REGISTRY.speech.id, inputPerM: 1.0, outputPerM: 20.0, audioTokensPerSecond: 25 },
  // "Gemini 3.5 Transcribe — Input $2.00 or $0.003/min (audio), Output $12.00"; 25 audio tokens/s (observed).
  transcription: { modelId: MODEL_REGISTRY.transcription.id, inputPerM: 2.0, outputPerM: 12.0, audioTokensPerSecond: 25 },
  // "Lyria 3.5 (Full Song) $0.08 per song" (Gemini API list price; not billable on Vertex for this project yet).
  music: { modelId: MODEL_REGISTRY.music.id, perSongUsd: 0.08, source: 'https://ai.google.dev/gemini-api/docs/pricing' },
  // Scene inspection watches video at 2 fps. 258 tokens per frame and 32 audio tokens/s are AZ Studio
  // estimates (actual tokens are recorded from the API response).
  inspection: { videoTokensPerFrame: 258, audioTokensPerSecond: 32, framesPerSecond: 2, expectedOutputTokens: 7000 },
  render: {
    vcpu: 4,
    memoryGiB: 16,
    perVcpuSecond: 0.000018,
    perGiBSecond: 0.000002,
    secondsPerOutputSecond: { draft: 0.6, final: 1.8 },
    overheadSeconds: 90,
    source: 'https://cloud.google.com/run/pricing',
  },
};
