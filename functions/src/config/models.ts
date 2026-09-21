import type { ImageCapabilities, ReasoningCapabilities, StudioCapabilities, VideoCapabilities } from '@az-studio/shared';
import { REGION } from './runtime';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
 * ║  AZ STUDIO MODEL REGISTRY — the only place Vertex AI model IDs are defined.                ║
 * ║  To upgrade a model, change it here (and its capability/pricing entries) and redeploy.     ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Verified 2026-09-21 against Google's Vertex AI (Gemini Enterprise Agent Platform) documentation
 * and with authenticated live calls from project `az-learner`, location `global`:
 *  - video:     gemini-omni-1.1-flash-preview — Interactions API, background + polling succeeded.
 *               Vertex rejects the Gemini-Developer-API alias `gemini-omni-1.1-flash`
 *               (400 "Unsupported model interaction"). The older `gemini-omni-flash-preview`
 *               must not be used.
 *  - image:     gemini-3-pro-image (Nano Banana Pro, GA) — generateContent with IMAGE output succeeded.
 *  - reasoning: gemini-3.1-pro-preview — newest Pro model callable on Vertex for this project
 *               (gemini-3.5-pro / gemini-3-pro-preview return 404). gemini-2.5-pro (GA) is the
 *               recorded fallback, used only if the preview model is retired (404) and always
 *               reported on the job.
 */
export const MODEL_REGISTRY = {
  video: {
    id: 'gemini-omni-1.1-flash-preview',
    displayName: 'Gemini Omni 1.1 Flash',
    api: 'interactions',
    location: 'global',
    launchStage: 'preview',
    docs: 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/omni-1-1-flash',
  },
  image: {
    id: 'gemini-3-pro-image',
    displayName: 'Nano Banana Pro (Gemini 3 Pro Image)',
    api: 'generateContent',
    location: 'global',
    launchStage: 'ga',
    docs: 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-pro-image',
  },
  reasoning: {
    id: 'gemini-3.1-pro-preview',
    fallbackId: 'gemini-2.5-pro',
    displayName: 'Gemini 3.1 Pro',
    api: 'generateContent',
    location: 'global',
    launchStage: 'preview',
    docs: 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro',
  },
} as const;

export type ModelRole = keyof typeof MODEL_REGISTRY;

const MB = 1024 * 1024;

/** Capabilities of the active video model (from the model card and API reference). */
export const VIDEO_CAPABILITIES: VideoCapabilities = {
  modelId: MODEL_REGISTRY.video.id,
  displayName: MODEL_REGISTRY.video.displayName,
  launchStage: MODEL_REGISTRY.video.launchStage,
  aspectRatios: ['16:9', '9:16'],
  resolutions: ['360p', '720p', '1080p', '4k'],
  defaultResolution: '720p',
  durationSec: { min: 3, max: 10, default: 6 },
  tasks: ['text_to_video', 'image_to_video', 'reference_to_video', 'edit', 'extend'],
  maxImageInputs: 10,
  maxVideoInputs: 3,
  maxEditInputSeconds: 10,
  maxVideoRefSeconds: 3,
  maxImageBytes: 30 * MB,
  imageMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'],
  videoMimeTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/mpeg', 'video/3gpp', 'video/x-flv', 'video/x-ms-wmv'],
  supportsAudioInput: false,
  supportsFirstLastFrame: true,
  supportsMultiTurn: true,
  outputsPerRequest: 1,
  maxExtendedLengthSec: 40,
  interactionRetentionDays: 7,
  generatesAudio: true,
  notes: [
    'Outputs are 24 fps with generated dialogue, music and sound effects, and carry SynthID watermarks.',
    '1080p and 4K outputs are upscaled by the model.',
    'Audio files cannot be sent to Omni; AZ Studio turns a song’s beat map into timed prompt directions and lays the real track under the edit.',
    'Uploaded videos for editing or extension must be 10 seconds or shorter (follow-up edits in a chain are exempt).',
    'Video references: up to 3 clips of up to 3 seconds each; audio in references is ignored.',
    'Temperature, negative prompts and system instructions are not supported — write “Do not …” in the prompt instead.',
  ],
};

export const IMAGE_CAPABILITIES: ImageCapabilities = {
  modelId: MODEL_REGISTRY.image.id,
  displayName: MODEL_REGISTRY.image.displayName,
  launchStage: MODEL_REGISTRY.image.launchStage,
  aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '9:21', '1:4', '4:1', '1:8', '8:1'],
  imageSizes: ['1K', '2K', '4K'],
  defaultImageSize: '2K',
  maxReferenceImages: 14,
  maxInlineImageBytes: 7 * MB,
  maxImageBytes: 30 * MB,
  imageMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'],
  supportsSearchGrounding: true,
  supportsEditing: true,
  notes: ['Images carry SynthID watermarks and C2PA Content Credentials.', 'Up to 14 reference images per request for character and style consistency.'],
};

export const REASONING_CAPABILITIES: ReasoningCapabilities = {
  modelId: MODEL_REGISTRY.reasoning.id,
  fallbackModelId: MODEL_REGISTRY.reasoning.fallbackId,
  displayName: MODEL_REGISTRY.reasoning.displayName,
  launchStage: MODEL_REGISTRY.reasoning.launchStage,
  supportsAudioInput: true,
  supportsStructuredOutput: true,
  maxAudioSeconds: 60 * 60,
};

export function studioCapabilities(): StudioCapabilities {
  return {
    video: VIDEO_CAPABILITIES,
    image: IMAGE_CAPABILITIES,
    reasoning: REASONING_CAPABILITIES,
    region: REGION,
    vertexLocation: MODEL_REGISTRY.video.location,
  };
}
