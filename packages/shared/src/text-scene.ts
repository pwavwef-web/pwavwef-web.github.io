/**
 * A renderer-neutral description of animated text on screen (lyrics, credits, titles). The browser
 * draws it on a canvas for previews; the renderer turns it into positioned ASS events for libass.
 * Every block carries explicit positions (measured with real font metrics), so the preview and the
 * export lay text out the same way and nothing is re-wrapped by the subtitle renderer.
 */

export type TextAlign = 'left' | 'center' | 'right';
export type Entrance = 'none' | 'fade' | 'rise' | 'drop' | 'scale' | 'slide_left' | 'slide_right' | 'blur';
export type WordEffect = 'none' | 'sweep' | 'instant' | 'highlight' | 'pop' | 'typewriter' | 'reveal';

export interface TextPaint {
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  /** Font em size in output pixels. */
  sizePx: number;
  letterSpacingPx: number;
  color: string;
  /** Colour of words not yet sung / not active. */
  inactiveColor: string;
  opacity: number;
  outline: { width: number; color: string } | null;
  shadow: { x: number; y: number; blur: number; color: string; opacity: number } | null;
  glow: { radius: number; color: string; strength: number } | null;
  gradient: { from: string; to: string } | null;
}

export interface SceneWord {
  text: string;
  /** Left edge (px) relative to the frame, baseline y (px). */
  x: number;
  y: number;
  width: number;
  /** Times the word is sung (absolute seconds), when known. */
  start: number | null;
  end: number | null;
  /** Per-word size multiplier (poster, kinetic emphasis). */
  scale: number;
}

export interface SceneLine {
  words: SceneWord[];
  /** Baseline y (px). */
  y: number;
  x: number;
  width: number;
  ascent: number;
  descent: number;
  paint: TextPaint;
  /** Optional explicit timing of the line within the block (two-line subtitles). */
  start: number | null;
  end: number | null;
  /** Right-to-left script: `words` are in visual order; the logical order is reversed. */
  rtl?: boolean;
}

export interface SceneBox {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  opacity: number;
  radius: number;
}

export interface SceneMotion {
  /** Linear move of the whole block over its lifetime (rolling / scrolling text), px. */
  dx: number;
  dy: number;
}

export interface SceneBlock {
  id: string;
  /** Source ids (lyric line ids or credit entries). */
  refs: string[];
  start: number;
  end: number;
  lines: SceneLine[];
  box: SceneBox | null;
  /** Region behind the text to blur (px). */
  blur: { x: number; y: number; w: number; h: number; radius: number } | null;
  entrance: Entrance;
  exit: Entrance;
  transitionSec: number;
  effect: WordEffect;
  /** Scale pop per word for kinetic / pop effects. */
  wordPop: boolean;
  motion: SceneMotion | null;
  /** Perspective / rotation for "integrated into the environment" (degrees). */
  rotation: { z: number; y: number } | null;
  /** Bouncing ball over the sung words. */
  ball: { radius: number; color: string; lift: number } | null;
  /** Full-frame dimming behind the text (full-screen chorus treatment). */
  dim: { color: string; opacity: number } | null;
  /** Stacking order (higher draws on top). */
  layer: number;
  bounds: { x: number; y: number; w: number; h: number };
}

export interface TextScene {
  width: number;
  height: number;
  blocks: SceneBlock[];
}

export interface TextMetrics {
  width: number;
  /** Ascent and descent of the actual glyphs (includes diacritics), px. */
  ascent: number;
  descent: number;
}

/** Measures a run of text in a font at an em size (canvas in the browser, font files in the renderer). */
export type MeasureText = (text: string, font: { family: string; weight: number; italic: boolean; sizePx: number; letterSpacingPx: number }) => TextMetrics;

/** Approximate metrics when no font measurement is available (unit tests, server-side estimates). */
export const approximateMeasure: MeasureText = (text, f) => {
  let w = 0;
  for (const ch of text) {
    if (ch === ' ') w += 0.28;
    else if (/[iljI.,;:'|!]/.test(ch)) w += 0.3;
    else if (/[mwMW@]/.test(ch)) w += 0.85;
    else if (/[A-Z0-9]/.test(ch)) w += 0.66;
    else w += 0.54;
  }
  const weight = 1 + Math.max(0, f.weight - 400) / 2000;
  const combining = [...text.normalize('NFD')].some((c) => c.charCodeAt(0) >= 0x300 && c.charCodeAt(0) <= 0x36f);
  return { width: w * f.sizePx * weight + Math.max(0, [...text].length - 1) * f.letterSpacingPx, ascent: f.sizePx * (combining ? 0.98 : 0.8), descent: f.sizePx * 0.24 };
};

export function blockAt(scene: TextScene, t: number): SceneBlock[] {
  return scene.blocks.filter((b) => t >= b.start - 1e-6 && t < b.end - 1e-6).sort((a, b) => a.layer - b.layer);
}

/** Alpha (0–1) of a block at time t from its entrance/exit transition. */
export function blockAlpha(b: SceneBlock, t: number): number {
  const d = Math.max(0.001, b.transitionSec);
  let a = 1;
  if (b.entrance !== 'none') a = Math.min(a, (t - b.start) / d);
  if (b.exit !== 'none') a = Math.min(a, (b.end - t) / d);
  return Math.max(0, Math.min(1, a));
}

/** Offset (px) and scale of a block at time t from its entrance/exit animation and motion. */
export function blockTransform(b: SceneBlock, t: number): { dx: number; dy: number; scale: number; blur: number } {
  const d = Math.max(0.001, b.transitionSec);
  const inP = Math.max(0, Math.min(1, (t - b.start) / d));
  const outP = Math.max(0, Math.min(1, (b.end - t) / d));
  let dx = 0;
  let dy = 0;
  let scale = 1;
  let blur = 0;
  const shift = Math.round(b.bounds.h * 0.35 + 10);
  const apply = (kind: Entrance, p: number, dir: 1 | -1) => {
    const q = 1 - p;
    if (kind === 'rise') dy += dir * shift * q;
    if (kind === 'drop') dy -= dir * shift * q;
    if (kind === 'slide_left') dx += dir * shift * 2 * q;
    if (kind === 'slide_right') dx -= dir * shift * 2 * q;
    if (kind === 'scale') scale *= 1 - 0.18 * q;
    if (kind === 'blur') blur = Math.max(blur, 10 * q);
  };
  apply(b.entrance, inP, 1);
  apply(b.exit, outP, -1);
  if (b.motion) {
    const p = Math.max(0, Math.min(1, (t - b.start) / Math.max(0.001, b.end - b.start)));
    dx += b.motion.dx * p;
    dy += b.motion.dy * p;
  }
  return { dx, dy, scale, blur };
}

/** Index of the word being sung at time t (or -1). */
export function activeWordIndex(words: SceneWord[], t: number): number {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.start === null || w.end === null) continue;
    if (t >= w.start && t < Math.max(w.end, w.start + 0.05)) return i;
  }
  return -1;
}

/** Karaoke sweep progress (0–1) of a word at time t. */
export function sweepProgress(w: SceneWord, t: number): number {
  if (w.start === null || w.end === null) return 0;
  if (t <= w.start) return 0;
  if (t >= w.end) return 1;
  return (t - w.start) / Math.max(0.01, w.end - w.start);
}
