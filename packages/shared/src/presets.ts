import type { FrameAspect, RenderQuality } from './types';

export interface ExportPreset {
  id: 'youtube_16x9' | 'vertical_9x16' | 'square_1x1';
  label: string;
  platform: string;
  aspect: FrameAspect;
  final: { width: number; height: number };
  draft: { width: number; height: number };
}

export const EXPORT_PRESETS: Record<ExportPreset['id'], ExportPreset> = {
  youtube_16x9: {
    id: 'youtube_16x9',
    label: 'YouTube 16:9',
    platform: 'YouTube, Vimeo, TV',
    aspect: '16:9',
    final: { width: 1920, height: 1080 },
    draft: { width: 1280, height: 720 },
  },
  vertical_9x16: {
    id: 'vertical_9x16',
    label: 'TikTok / Reels 9:16',
    platform: 'TikTok, Instagram Reels, YouTube Shorts',
    aspect: '9:16',
    final: { width: 1080, height: 1920 },
    draft: { width: 720, height: 1280 },
  },
  square_1x1: {
    id: 'square_1x1',
    label: 'Square 1:1',
    platform: 'Instagram feed, X, Facebook',
    aspect: '1:1',
    final: { width: 1080, height: 1080 },
    draft: { width: 720, height: 720 },
  },
};

export function presetDimensions(id: ExportPreset['id'], quality: RenderQuality): { width: number; height: number } {
  const p = EXPORT_PRESETS[id];
  return quality === 'final' ? p.final : p.draft;
}

export const ENCODE_SETTINGS: Record<RenderQuality, { preset: string; crf: number; audioBitrate: string; loudnorm: boolean }> = {
  draft: { preset: 'veryfast', crf: 26, audioBitrate: '160k', loudnorm: false },
  final: { preset: 'medium', crf: 18, audioBitrate: '256k', loudnorm: true },
};

export function aspectToRatio(a: FrameAspect): number {
  const [w, h] = a.split(':').map(Number);
  return (w ?? 16) / (h ?? 9);
}
