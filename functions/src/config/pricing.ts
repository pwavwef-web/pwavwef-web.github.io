import type { PricingTable } from '@az-studio/shared';
import { MODEL_REGISTRY } from './models';

/**
 * Published list prices (USD, standard pay-as-you-go, global endpoint).
 * Source: https://cloud.google.com/vertex-ai/generative-ai/pricing — retrieved 2026-09-21; Gemini 3.8 Flash, Cloud
 * Vision and the stem-separation job added 2026-09-24.
 * Cloud Run jobs: https://cloud.google.com/run/pricing (Tier 1, instance-based) — retrieved 2026-09-21.
 *
 * These are *list* prices used for estimates. Actual charges appear in Cloud Billing and may differ
 * (free tiers, credits, discounts, taxes). `expectedThoughtTokens` values are AZ Studio estimates
 * based on observed usage and are labelled as such in the UI.
 */
/** Gemini 3.8 Flash list rates: introductory until 2026-12-31, standard from 2027-01-01. */
function reasoningRates(now = Date.now()) {
  const intro = now < Date.UTC(2027, 0, 1);
  return intro
    ? { inputPerM: 0.75, outputPerM: 3.75, inputPerMLong: 0.75, outputPerMLong: 3.75, longContextThreshold: 1_000_000, audioTokensPerSecond: 32 }
    : { inputPerM: 1.5, outputPerM: 7.5, inputPerMLong: 1.5, outputPerMLong: 7.5, longContextThreshold: 1_000_000, audioTokensPerSecond: 32 };
}

export const PRICING: PricingTable = {
  version: 'vertex-2026-09-24',
  source: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
  retrievedAt: '2026-09-24',
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
  // "Gemini 3.8 Flash, Gemini 3.7 Flash … introductory pricing of $0.75 / $3.75 per 1M tokens input / output
  // through December 31, 2026. Starting January 1, 2027, standard pricing of $1.5 / $7.5" (retrieved 2026-09-24).
  text: {
    [MODEL_REGISTRY.reasoning.id]: reasoningRates(),
  },
  // Published 2026-09 (https://ai.google.dev/gemini-api/docs/pricing, Vertex AI list prices match):
  // "Gemini 2.5 Pro TTS — Input $1.00 (text), Output $20.00 (audio)"; observed 25 audio tokens/s.
  speech: { modelId: MODEL_REGISTRY.speech.id, inputPerM: 1.0, outputPerM: 20.0, audioTokensPerSecond: 25 },
  // "Gemini 3.5 Transcribe — Input $2.00 or $0.003/min (audio), Output $12.00"; 25 audio tokens/s (observed).
  transcription: { modelId: MODEL_REGISTRY.transcription.id, inputPerM: 2.0, outputPerM: 12.0, audioTokensPerSecond: 25 },
  // "Lyria 3.5 (Full Song) $0.08 per song" (Gemini API list price — the surface AZ Studio uses for Lyria 3.5).
  music: { modelId: MODEL_REGISTRY.music.id, perSongUsd: 0.08, source: 'https://ai.google.dev/gemini-api/docs/pricing' },
  // Scene inspection watches video at 4 fps. Observed 2026-09-24 with gemini-3.8-flash: 792 video tokens for
  // 3 s at 4 fps (≈66 per frame); 32 audio tokens/s. Estimates — actual tokens are recorded per call.
  inspection: { videoTokensPerFrame: 70, audioTokensPerSecond: 32, framesPerSecond: 4, expectedOutputTokens: 9000 },
  // "Face Detection / Object Localization / Text Detection: first 1000 units/month free, then $1.50 per 1000
  // units" (https://cloud.google.com/vision/pricing, retrieved 2026-09-24).
  vision: { perThousandUnits: 1.5, freeUnitsPerMonth: 1000, source: 'https://cloud.google.com/vision/pricing' },
  // Demucs on a Cloud Run job (4 vCPU / 16 GiB, same Tier-1 rates as the renderer). Seconds of compute per
  // second of audio is an AZ Studio estimate for CPU inference (htdemucs).
  separation: { vcpu: 4, memoryGiB: 16, perVcpuSecond: 0.000018, perGiBSecond: 0.000002, secondsPerAudioSecond: 1.6, overheadSeconds: 120, source: 'https://cloud.google.com/run/pricing' },
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
