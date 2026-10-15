import type { PricingTable } from '@az-studio/shared';
import { MODEL_REGISTRY } from './models';

/**
 * Published list prices (USD, standard pay-as-you-go, global endpoint).
 * Source: https://cloud.google.com/vertex-ai/generative-ai/pricing — retrieved 2026-09-21; Cloud Vision and the
 * stem-separation job added 2026-09-24; Gemini 4 Argon (reasoning) added 2026-10-15.
 * Cloud Run jobs: https://cloud.google.com/run/pricing (Tier 1, instance-based) — retrieved 2026-09-21.
 *
 * These are *list* prices used for estimates. Actual charges appear in Cloud Billing and may differ
 * (free tiers, credits, discounts, taxes). `expectedThoughtTokens` values are AZ Studio estimates
 * based on observed usage and are labelled as such in the UI.
 */
/** Gemini 4 Argon list rates: introductory until 2026-11-30, standard from 2026-12-01. */
function reasoningRates(now = Date.now()) {
  const intro = now < Date.UTC(2026, 11, 1);
  return intro
    ? { inputPerM: 2, outputPerM: 10, inputPerMLong: 2, outputPerMLong: 10, longContextThreshold: 1_000_000, audioTokensPerSecond: 32 }
    : { inputPerM: 4, outputPerM: 20, inputPerMLong: 4, outputPerMLong: 20, longContextThreshold: 1_000_000, audioTokensPerSecond: 32 };
}

export const PRICING: PricingTable = {
  version: 'vertex-2026-10-15',
  source: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
  retrievedAt: '2026-10-15',
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
  // "Gemini 4 Argon* through November 30, 2026 — Input (text, image, video, audio) Global $2 … Text output (response
  // and reasoning) Global $10"; "Gemini 4 Argon (Starting December 1, 2026) … Global $4 … $20" (retrieved 2026-10-15).
  // The introductory rate is "provided through 50% credits back on net spend", so Cloud Billing shows the full rate
  // with a credit. One tier across the 1M window. Audio tokens/s carried over from 3.8 Flash (not yet measured).
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
  // Scene inspection watches video at 4 fps. countTokens 2026-10-15 with gemini-4-argon: 3,306 tokens for 3 s at
  // 4 fps with audio (≈258 per frame; 3.8 Flash counted 1,050). Estimates — actual tokens are recorded per call.
  inspection: { videoTokensPerFrame: 258, audioTokensPerSecond: 32, framesPerSecond: 4, expectedOutputTokens: 9000 },
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
