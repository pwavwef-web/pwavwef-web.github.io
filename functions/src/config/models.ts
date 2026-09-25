import type { ImageCapabilities, MusicCapabilities, ReasoningCapabilities, SeparationCapabilities, SpeechCapabilities, StudioCapabilities, TranscriptionCapabilities, VideoCapabilities, VisionCapabilities } from '@az-studio/shared';
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
 *
 * Re-verified 2026-09-24 for the quality-control, lyrics and film-score upgrade (live calls from
 * `az-learner`, location `global`):
 *  - video repairs: conversational edits/extensions use the same Omni model. `gemini-omni-1.1-flash`
 *               is still not a Vertex publisher model (404); `gemini-omni-1.1-flash-preview` is the
 *               Vertex ID of Gemini Omni 1.1 Flash and is used — not a downgrade.
 *  - reasoning: `gemini-3.5-pro` is now listed as a publisher model but this project has no access
 *               (404 "…or your project does not have access to it"), so gemini-3.1-pro-preview stays
 *               the newest usable reasoning model (inspection, lyrics writing, cue sheets).
 *  - transcription: gemini-3.5-transcribe-preview — generateContent with `audioTranscriptionConfig`
 *               (word timestamps) succeeded on speech and on sung vocals. The GA ID
 *               `gemini-3.5-transcribe` returns 404 (no access) and the Interactions API rejects it.
 *  - speech:    gemini-2.5-pro-tts — generateContent with AUDIO output succeeded (24 kHz PCM).
 *               `gemini-3.5-flash-tts` is listed but returns 404 (no access) for this project.
 *  - music:     lyria-3.5 is NOT available on Vertex AI for this project: `interactions.create`
 *               returns 400 "Unsupported model interaction: lyria-3.5" and the publisher model is
 *               not found (also checked lyria-3.5-preview / lyria-3-5 / us-central1). Only the older
 *               lyria-3-pro-preview and lyria-3-clip-preview exist there. AZ Studio does not
 *               substitute an older music model: music jobs fail fast (no charge) with this exact
 *               limitation until Google enables Lyria 3.5 on Vertex AI for the project.
 *
 * Re-verified 2026-09-24 for the Continuity Director upgrade (live calls from `az-learner`, `global`):
 *  - reasoning: `gemini-3.8-flash` is GA on Vertex AI (released 2026-09-02; 1M context, structured
 *               output, thinking levels, up to 10 videos / 3,000 images per prompt) and answered a
 *               structured video review with thinking MEDIUM. It is the newest production (GA) Gemini
 *               model this project can call (`gemini-3.5-pro` still 404s; `gemini-3.7-pro`/`3.8-pro` do
 *               not exist). It replaces the preview `gemini-3.1-pro-preview` for creative reasoning,
 *               script analysis and quality review. No fallback model is configured: a failure is
 *               reported, never silently answered by an older model.
 *  - music:     `lyria-3.5` is still refused by Vertex AI (400 "Unsupported model interaction") but is GA
 *               on the Gemini Developer API (ai.google.dev, since 2026-09-04) through the same Interactions
 *               API. AZ Studio calls it there, server-side, with an API key read from Secret Manager
 *               (`AZ_STUDIO_GEMINI_API_KEY`); the key never reaches the browser. Without the key, music
 *               jobs fail fast with the exact limitation; no older Lyria model is ever substituted.
 *  - transcription: `gemini-3.5-transcribe` (GA ID) still 404s for this project; the preview
 *               `gemini-3.5-transcribe-preview` remains the transcription model (word timestamps verified).
 *  - vision:    Cloud Vision API v1 (face, object and text detection) answered from `az-learner`.
 */
export const MODEL_REGISTRY = {
  video: {
    id: 'gemini-omni-1.1-flash-preview',
    /** The Gemini Developer API name of the same model (rejected by Vertex AI; recorded for the UI). */
    requestedAlias: 'gemini-omni-1.1-flash',
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
    id: 'gemini-3.8-flash',
    /** No fallback: a failure is reported, never answered silently by an older model. */
    fallbackId: null,
    displayName: 'Gemini 3.8 Flash',
    api: 'generateContent',
    location: 'global',
    launchStage: 'ga',
    docs: 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash',
  },
  transcription: {
    id: 'gemini-3.5-transcribe-preview',
    displayName: 'Gemini 3.5 Transcribe',
    api: 'generateContent',
    location: 'global',
    launchStage: 'preview',
    docs: 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-transcribe',
  },
  speech: {
    id: 'gemini-2.5-pro-tts',
    displayName: 'Gemini 2.5 Pro TTS',
    api: 'generateContent',
    location: 'global',
    launchStage: 'ga',
    docs: 'https://docs.cloud.google.com/text-to-speech/docs/gemini-tts',
  },
  music: {
    id: 'lyria-3.5',
    displayName: 'Lyria 3.5',
    api: 'interactions',
    location: 'global',
    launchStage: 'ga',
    /** Vertex AI first (if Google enables it for the project), else the Gemini Developer API. */
    surfaces: ['vertex', 'developer-api'],
    apiKeySecret: 'AZ_STUDIO_GEMINI_API_KEY',
    docs: 'https://ai.google.dev/gemini-api/docs/models/lyria-3.5',
  },
  vision: {
    id: 'cloud-vision-v1',
    displayName: 'Cloud Vision (faces, objects, text)',
    api: 'images:annotate',
    location: 'global',
    launchStage: 'ga',
    features: ['FACE_DETECTION', 'OBJECT_LOCALIZATION', 'TEXT_DETECTION'],
    docs: 'https://cloud.google.com/vision/docs',
  },
  separation: {
    id: 'htdemucs',
    displayName: 'Demucs v4 (hybrid transformer) stem separation',
    api: 'cloud-run-job',
    location: 'us-central1',
    launchStage: 'ga',
    job: 'az-studio-stems',
    stems: ['vocals', 'drums', 'bass', 'other'],
    docs: 'https://github.com/adefossez/demucs',
  },
} as const;

export type ModelRole = keyof typeof MODEL_REGISTRY;

/** Exact limitation recorded when the music model is not served by Vertex AI for this project. */
export const MUSIC_MODEL_LIMITATION =
  'Lyria 3.5 (lyria-3.5) is not served by Vertex AI for project az-learner (Google returns 400 “Unsupported model interaction: lyria-3.5”), and no Gemini API key is configured for the Gemini Developer API, where Lyria 3.5 is available. Add a key to Secret Manager as AZ_STUDIO_GEMINI_API_KEY (see docs/OPERATIONS.md). AZ Studio does not switch to an older music model; upload or import audio meanwhile.';

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
    'Edits work on videos of up to 10 seconds (generated or uploaded; verified 2026-09-24). Uploaded clips to extend must also be 10 seconds or shorter; a generated take can be extended up to 40 seconds.',
    'Video references: up to 3 clips of up to 3 seconds each; audio in references is ignored.',
    'Temperature, negative prompts and system instructions are not supported — write “Do not …” in the prompt instead.',
    'Voices cannot be edited, and dialogue cannot be added when extending an uploaded video that already has someone talking.',
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
  maxVideosPerPrompt: 10,
};

/** Prebuilt voices of the Gemini TTS models (voice names, not model IDs). */
export const SPEECH_VOICES = ['Kore', 'Charon', 'Puck', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Zephyr', 'Algieba', 'Despina', 'Gacrux', 'Sulafat', 'Achird', 'Schedar', 'Umbriel', 'Rasalgethi'];

export const SPEECH_CAPABILITIES: SpeechCapabilities = {
  modelId: MODEL_REGISTRY.speech.id,
  displayName: MODEL_REGISTRY.speech.displayName,
  launchStage: MODEL_REGISTRY.speech.launchStage,
  voices: SPEECH_VOICES,
  notes: ['Dialogue guide audio: each line is spoken once so its real length can be measured before the scene is generated. Omni still performs the dialogue on screen.'],
};

export const TRANSCRIPTION_CAPABILITIES: TranscriptionCapabilities = {
  modelId: MODEL_REGISTRY.transcription.id,
  displayName: MODEL_REGISTRY.transcription.displayName,
  launchStage: MODEL_REGISTRY.transcription.launchStage,
  wordTimestamps: true,
  maxTimedAudioSeconds: 15 * 60,
  notes: ['Word-level timestamps for dialogue validation and lyric synchronisation. Timed audio requests are limited to 15 minutes; longer final films are transcribed in segments. Automatic language detection; languages with little training data (e.g. Kasem) are transcribed approximately and never replace uploaded lyrics.'],
};

export const MUSIC_CAPABILITIES: MusicCapabilities = {
  modelId: MODEL_REGISTRY.music.id,
  displayName: MODEL_REGISTRY.music.displayName,
  launchStage: MODEL_REGISTRY.music.launchStage,
  perSongUsd: 0.08,
  maxImageInputs: 10,
  supportsLyrics: true,
  notes: [
    'Full songs (about 2 minutes, controllable by prompt and timestamps) with vocals and lyrics, or instrumental music when prompted; 44.1 kHz stereo MP3.',
    'Single-turn only: Lyria cannot edit or extend part of an existing song. AZ Studio regenerates the song, generates a replacement passage and blends it, or arranges the real audio — and every version says which.',
    'Served by the Gemini Developer API (server-side key in Secret Manager) while Vertex AI does not offer Lyria 3.5 for this project.',
  ],
  surface: 'developer-api',
};

/** Language hints the transcription model accepts reliably; others use automatic detection. */
export const TRANSCRIPTION_LANGUAGE_HINTS = new Set(['en', 'fr', 'es', 'pt', 'de', 'it', 'nl', 'ar', 'zh', 'ja', 'ko', 'hi', 'ru', 'tr', 'pl', 'sw', 'ha', 'yo', 'ig', 'zu', 'am']);

export const VISION_CAPABILITIES: VisionCapabilities = {
  modelId: MODEL_REGISTRY.vision.id,
  displayName: MODEL_REGISTRY.vision.displayName,
  launchStage: MODEL_REGISTRY.vision.launchStage,
  features: [...MODEL_REGISTRY.vision.features],
  maxImagesPerRequest: 16,
  notes: ['Detects faces (with head pan), people and objects, and reads text in sampled frames: face visibility, occlusion, screen direction, mirrored text, face-safe reframing and lyric placement use it.'],
};

export const SEPARATION_CAPABILITIES: SeparationCapabilities = {
  modelId: MODEL_REGISTRY.separation.id,
  displayName: MODEL_REGISTRY.separation.displayName,
  launchStage: MODEL_REGISTRY.separation.launchStage,
  stems: [...MODEL_REGISTRY.separation.stems],
  maxAudioSeconds: 15 * 60,
  notes: ['Open-source Demucs v4 runs on a Cloud Run job; neither Gemini nor Lyria returns stems.'],
};

export function studioCapabilities(): StudioCapabilities {
  return {
    video: VIDEO_CAPABILITIES,
    image: IMAGE_CAPABILITIES,
    reasoning: REASONING_CAPABILITIES,
    music: MUSIC_CAPABILITIES,
    speech: SPEECH_CAPABILITIES,
    transcription: TRANSCRIPTION_CAPABILITIES,
    vision: VISION_CAPABILITIES,
    separation: SEPARATION_CAPABILITIES,
    region: REGION,
    vertexLocation: MODEL_REGISTRY.video.location,
  };
}
