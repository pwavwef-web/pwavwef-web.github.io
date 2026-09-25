import type { CreditSequenceDoc } from './credits';
import type { Box } from './inspection';
import type { LyricStyleDoc } from './lyric-style';
import type { SectionLabel } from './types';

/**
 * Inputs of the renderer's text engine, resolved by the API when a render is requested (so the render
 * uses exactly the styles, credits and fonts that existed then): lyric styles and locked placements per
 * song, line sections and translations, credit sequences, uploaded fonts and face tracks for placement.
 */
export interface RenderTextInputs {
  /** Export aspect ratio (16:9, 9:16, 1:1, 4:5). */
  aspect: string;
  /** Lyric style and per-line placements (for this aspect) by song. */
  lyricStyles: Record<string, { style: Pick<LyricStyleDoc, 'global' | 'sections' | 'fonts'>; placements: Record<string, { x: number; y: number; locked: boolean }> }>;
  /** Section of each lyric line (song → line → section). */
  sections: Record<string, Record<string, SectionLabel | null>>;
  /** Translation of each lyric line, when the creator wrote one (dual-language styles). */
  translations: Record<string, Record<string, string>>;
  credits: Record<string, CreditSequenceDoc>;
  /** Uploaded fonts (licence confirmed) by the family label used in styles. */
  fonts: { family: string; storagePath: string }[];
  /** Faces per source asset (source time, 0–1 boxes), for keeping lyrics clear of faces. */
  faces: Record<string, { t: number; boxes: Box[] }[]>;
}
