/**
 * Capability descriptors. The server derives these from its model registry and sends them to the
 * client in `bootstrap`, so the UI renders only controls the active model genuinely supports.
 * No model IDs are hard-coded on the client.
 */

export type VideoTask = 'text_to_video' | 'image_to_video' | 'reference_to_video' | 'edit' | 'extend';

export interface VideoCapabilities {
  modelId: string;
  displayName: string;
  launchStage: 'preview' | 'ga';
  aspectRatios: string[];
  resolutions: string[];
  defaultResolution: string;
  durationSec: { min: number; max: number; default: number };
  tasks: VideoTask[];
  maxImageInputs: number;
  maxVideoInputs: number;
  /** Uploaded videos used for edit/extend must be this short (multi-turn chains are exempt). */
  maxEditInputSeconds: number;
  /** Video references: at most this many clips, each at most `maxVideoRefSeconds` long. */
  maxVideoRefSeconds: number;
  maxImageBytes: number;
  imageMimeTypes: string[];
  videoMimeTypes: string[];
  supportsAudioInput: boolean;
  supportsFirstLastFrame: boolean;
  supportsMultiTurn: boolean;
  outputsPerRequest: number;
  /** Total length reachable by repeated extension. */
  maxExtendedLengthSec: number;
  /** Days an interaction is retained for `previous_interaction_id` follow-ups (conservative). */
  interactionRetentionDays: number;
  generatesAudio: boolean;
  notes: string[];
}

export interface ImageCapabilities {
  modelId: string;
  displayName: string;
  launchStage: 'preview' | 'ga';
  aspectRatios: string[];
  imageSizes: string[];
  defaultImageSize: string;
  maxReferenceImages: number;
  maxInlineImageBytes: number;
  maxImageBytes: number;
  imageMimeTypes: string[];
  supportsSearchGrounding: boolean;
  supportsEditing: boolean;
  notes: string[];
}

export interface ReasoningCapabilities {
  modelId: string;
  fallbackModelId: string | null;
  displayName: string;
  launchStage: 'preview' | 'ga';
  supportsAudioInput: boolean;
  supportsStructuredOutput: boolean;
  maxAudioSeconds: number;
}

export interface StudioCapabilities {
  video: VideoCapabilities;
  image: ImageCapabilities;
  reasoning: ReasoningCapabilities;
  region: string;
  vertexLocation: string;
}
