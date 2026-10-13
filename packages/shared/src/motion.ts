/**
 * Cinematic motion for still images (Film Studio Lite): editable start/end framing, focal points, presets
 * chosen from narrative intent, bounds that never expose an image edge, and resolution checks.
 *
 * Coordinates are fractions of the SOURCE image (0–1 on each axis). A framing rectangle always has the
 * output aspect ratio in source pixels, so the picture is never stretched. Preview (canvas) and export
 * (FFmpeg) both sample `motionRectAt`, so the exported film moves exactly as the approved preview.
 */

export const MOTION_PRESETS = ['still', 'push_in', 'pull_out', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down', 'drift'] as const;
export type MotionPreset = (typeof MOTION_PRESETS)[number];

export const MOTION_PRESET_LABELS: Record<MotionPreset, string> = {
  still: 'Still hold',
  push_in: 'Slow push-in',
  pull_out: 'Slow pull-out',
  pan_left: 'Pan left',
  pan_right: 'Pan right',
  tilt_up: 'Tilt up',
  tilt_down: 'Tilt down',
  drift: 'Diagonal drift',
};

/** What each movement is for (shown beside the choice, used when the planner picks one). */
export const MOTION_PRESET_INTENT: Record<MotionPreset, string> = {
  still: 'Stillness: let a line, a face or a reveal land.',
  push_in: 'Attention or intimacy: move toward what matters.',
  pull_out: 'Scale, revelation or loneliness: let the world grow around the subject.',
  pan_left: 'Environmental reveal, travelling right to left.',
  pan_right: 'Environmental reveal, travelling left to right.',
  tilt_up: 'Reveal height, hope or an approaching sky.',
  tilt_down: 'Settle onto the ground, a detail or a person.',
  drift: 'Very restrained diagonal movement where the composition allows it.',
};

export const MOTION_EASES = ['gentle', 'linear', 'ease_in_out'] as const;
export type MotionEase = (typeof MOTION_EASES)[number];

export interface NRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A framing: centre (source fractions) and zoom relative to the largest rectangle that covers the frame. */
export interface Framing {
  cx: number;
  cy: number;
  /** 1 = the largest output-shaped rectangle that fits the image; 1.06 = 6 % closer. */
  zoom: number;
}

/** Resolved motion of a clip (stored on timeline clips; the renderer and preview both use it). */
export interface ClipMotion {
  from: NRect;
  to: NRect;
  ease: MotionEase;
}

/** The editorial motion of a shot (independent of the output aspect ratio). */
export interface ShotMotion {
  preset: MotionPreset;
  /** Amount of movement: zoom change for push/pull, travel as a fraction of the frame for pans (0–0.25). */
  intensity: number;
  /** What must stay in view (source fractions), e.g. a face. */
  focal: { x: number; y: number };
  /** Optional size of the protected subject (source fractions) — kept inside the safe area. */
  focalSize?: { w: number; h: number } | null;
  ease: MotionEase;
  /** Hand-set start/end framing per output aspect ratio (overrides the preset for that format). */
  manual?: Partial<Record<string, { from: Framing; to: Framing }>> | null;
}

export const DEFAULT_SHOT_MOTION: ShotMotion = { preset: 'push_in', intensity: 0.05, focal: { x: 0.5, y: 0.45 }, focalSize: null, ease: 'gentle', manual: null };

/** Limits that keep movement cinematic rather than busy. */
export const MOTION_LIMITS = {
  maxIntensity: 0.25,
  /** Zoom change per second above which a move feels hurried (log ratio / s). */
  maxZoomRatePerSec: 0.012,
  /** Travel per second as a fraction of the frame width/height. */
  maxPanRatePerSec: 0.035,
  /** Safe area margin (fraction of the frame) the focal subject should stay inside. */
  safeMargin: 0.1,
  /** Output pixels per source pixel above which the picture is noticeably upscaled. */
  softScale: 1.12,
  blurryScale: 1.5,
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function aspectNumber(aspect: string): number {
  const [w, h] = aspect.split(':').map(Number);
  return w && h ? w / h : 16 / 9;
}

/** The largest output-shaped rectangle that fits the source (fractions of the source). */
export function coverSize(src: { w: number; h: number }, outAspect: number): { w: number; h: number } {
  const srcAspect = src.w / src.h;
  return srcAspect >= outAspect ? { w: outAspect / srcAspect, h: 1 } : { w: 1, h: srcAspect / outAspect };
}

/** Rectangle of a framing, clamped inside the image. */
export function framingRect(f: Framing, src: { w: number; h: number }, outAspect: number): NRect {
  const base = coverSize(src, outAspect);
  const zoom = Math.max(1, f.zoom);
  const w = base.w / zoom;
  const h = base.h / zoom;
  return { x: r6(clamp(f.cx - w / 2, 0, 1 - w)), y: r6(clamp(f.cy - h / 2, 0, 1 - h)), w: r6(w), h: r6(h) };
}

export function rectFraming(r: NRect, src: { w: number; h: number }, outAspect: number): Framing {
  const base = coverSize(src, outAspect);
  return { cx: r6(r.x + r.w / 2), cy: r6(r.y + r.h / 2), zoom: r6(Math.max(1, base.w / r.w)) };
}

export function easeValue(ease: MotionEase, p: number): number {
  const t = clamp(p, 0, 1);
  if (ease === 'linear') return t;
  const smooth = t * t * (3 - 2 * t);
  if (ease === 'ease_in_out') return 0.5 - 0.5 * Math.cos(Math.PI * t);
  // Gentle: starts and settles softly without a long dead zone at either end.
  return 0.55 * t + 0.45 * smooth;
}

/**
 * The visible rectangle at progress p (0–1 over the clip). Centres move linearly and the size changes
 * geometrically, so a zoom feels even and the left/top edges stay concave (bounds hold at every instant
 * when they hold at both ends).
 */
export function motionRectAt(m: ClipMotion, p: number): NRect {
  const e = easeValue(m.ease, p);
  const cx = m.from.x + m.from.w / 2 + (m.to.x + m.to.w / 2 - (m.from.x + m.from.w / 2)) * e;
  const cy = m.from.y + m.from.h / 2 + (m.to.y + m.to.h / 2 - (m.from.y + m.from.h / 2)) * e;
  const w = m.from.w * (m.to.w / m.from.w) ** e;
  const h = m.from.h * (m.to.h / m.from.h) ** e;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function isStill(m: ClipMotion): boolean {
  return Math.abs(m.from.x - m.to.x) < 1e-5 && Math.abs(m.from.y - m.to.y) < 1e-5 && Math.abs(m.from.w - m.to.w) < 1e-5;
}

/** True when every sampled instant of the move stays inside the image (no exposed edge). */
export function motionInBounds(m: ClipMotion, samples = 48): boolean {
  for (let i = 0; i <= samples; i++) {
    const r = motionRectAt(m, i / samples);
    if (r.x < -1e-6 || r.y < -1e-6 || r.x + r.w > 1 + 1e-6 || r.y + r.h > 1 + 1e-6 || r.w <= 0 || r.h <= 0) return false;
  }
  return true;
}

function presetFramings(motion: ShotMotion, src: { w: number; h: number }, outAspect: number): { from: Framing; to: Framing } {
  const f = { x: clamp(motion.focal.x, 0, 1), y: clamp(motion.focal.y, 0, 1) };
  const k = clamp(motion.intensity, 0, MOTION_LIMITS.maxIntensity);
  const base = coverSize(src, outAspect);
  // Zoom at which a pan has room to travel `k` of the frame (never less than a hair over 1).
  const panZoom = (axis: 'w' | 'h') => {
    const room = 1 - base[axis];
    const need = base[axis] * k * 1.4;
    return room >= need ? 1 : Math.max(1, base[axis] * (1 + k * 1.4));
  };
  // A wide framing drifts toward the image centre but always keeps the focal point well inside it.
  const wideCentre = (zoom: number) => {
    const w = base.w / zoom;
    const h = base.h / zoom;
    return { cx: clamp(0.5 + (f.x - 0.5) * 0.4, f.x - w * 0.3, f.x + w * 0.3), cy: clamp(0.5 + (f.y - 0.5) * 0.4, f.y - h * 0.3, f.y + h * 0.3) };
  };
  switch (motion.preset) {
    case 'still':
      return { from: { cx: f.x, cy: f.y, zoom: 1 + k * 0.3 }, to: { cx: f.x, cy: f.y, zoom: 1 + k * 0.3 } };
    case 'push_in':
      return { from: { ...wideCentre(1), zoom: 1 }, to: { cx: f.x, cy: f.y, zoom: 1 + k } };
    case 'pull_out':
      return { from: { cx: f.x, cy: f.y, zoom: 1 + k }, to: { ...wideCentre(1), zoom: 1 } };
    case 'pan_left':
    case 'pan_right': {
      const zoom = panZoom('w');
      const travel = (base.w / zoom) * k * 1.4;
      const dir = motion.preset === 'pan_right' ? 1 : -1;
      return { from: { cx: f.x - (dir * travel) / 2, cy: f.y, zoom }, to: { cx: f.x + (dir * travel) / 2, cy: f.y, zoom } };
    }
    case 'tilt_up':
    case 'tilt_down': {
      const zoom = panZoom('h');
      const travel = (base.h / zoom) * k * 1.4;
      const dir = motion.preset === 'tilt_down' ? 1 : -1;
      return { from: { cx: f.x, cy: f.y - (dir * travel) / 2, zoom }, to: { cx: f.x, cy: f.y + (dir * travel) / 2, zoom } };
    }
    case 'drift': {
      const zoom = 1 + k * 0.8;
      const tx = (base.w / zoom) * k * 0.6;
      const ty = (base.h / zoom) * k * 0.4;
      return { from: { cx: f.x - tx / 2, cy: f.y - ty / 2, zoom }, to: { cx: f.x + tx / 2, cy: f.y + ty / 2, zoom: zoom + k * 0.25 } };
    }
  }
}

/**
 * Keeps a pan's travel when one end would leave the image: both ends shift together instead of one being
 * clamped (which would shorten or stop the move unevenly).
 */
function fitPair(a: NRect, b: NRect): [NRect, NRect] {
  const dx = Math.max(-Math.min(a.x, b.x), 0) + Math.min(0, 1 - Math.max(a.x + a.w, b.x + b.w));
  const dy = Math.max(-Math.min(a.y, b.y), 0) + Math.min(0, 1 - Math.max(a.y + a.h, b.y + b.h));
  const move = (r: NRect): NRect => ({ ...r, x: r6(clamp(r.x + dx, 0, 1 - r.w)), y: r6(clamp(r.y + dy, 0, 1 - r.h)) });
  return [move(a), move(b)];
}

function unclampedRect(f: Framing, src: { w: number; h: number }, outAspect: number): NRect {
  const base = coverSize(src, outAspect);
  const zoom = Math.max(1, f.zoom);
  const w = base.w / zoom;
  const h = base.h / zoom;
  return { x: f.cx - w / 2, y: f.cy - h / 2, w, h };
}

export type MotionIssueKind = 'upscaled' | 'blurry' | 'focal_outside' | 'too_fast' | 'adjusted' | 'no_dimensions';

export interface MotionIssue {
  kind: MotionIssueKind;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface ResolvedMotion {
  motion: ClipMotion;
  issues: MotionIssue[];
  /** Output pixels per source pixel at the closest framing (> 1 means upscaled). */
  scale: number | null;
}

/**
 * Resolves a shot's editorial motion for one output format: start and end rectangles inside the image,
 * plus resolution, safe-framing and speed checks. Excessive crops are reported, never stretched.
 */
export function resolveShotMotion(motion: ShotMotion, src: { w: number | null; h: number | null }, opts: { aspect: string; durationSec: number; outWidth?: number }): ResolvedMotion {
  const issues: MotionIssue[] = [];
  const outAspect = aspectNumber(opts.aspect);
  const dims = src.w && src.h ? { w: src.w, h: src.h } : null;
  if (!dims) issues.push({ kind: 'no_dimensions', severity: 'warning', message: 'The image size is unknown, so framing cannot be checked yet.' });
  const s = dims ?? { w: outAspect, h: 1 };
  const manual = motion.manual?.[opts.aspect];
  const framings = manual ?? presetFramings(motion, s, outAspect);
  const rawA = unclampedRect(framings.from, s, outAspect);
  const rawB = unclampedRect(framings.to, s, outAspect);
  let [a, b] = fitPair(rawA, rawB);
  if (motion.preset === 'still' && !manual) b = { ...a };
  const moved = Math.abs(a.x - rawA.x) + Math.abs(a.y - rawA.y) + Math.abs(b.x - rawB.x) + Math.abs(b.y - rawB.y);
  // Presets are fitted silently; a hand-set frame that had to move is worth telling the director about.
  if (manual && moved > 0.01) issues.push({ kind: 'adjusted', severity: 'info', message: 'The framing was moved so the image edge never shows.' });
  if (a.w > 1 || b.w > 1 || a.h > 1 || b.h > 1) {
    a = framingRect(framings.from, s, outAspect);
    b = framingRect(framings.to, s, outAspect);
  }
  const m: ClipMotion = { from: a, to: b, ease: motion.ease };

  let scale: number | null = null;
  if (dims && opts.outWidth) {
    const minW = Math.min(a.w, b.w) * dims.w;
    scale = Math.round((opts.outWidth / minW) * 100) / 100;
    if (scale >= MOTION_LIMITS.blurryScale) issues.push({ kind: 'blurry', severity: 'error', message: `This framing enlarges the image ${scale.toFixed(2)}× — it will look visibly soft. Frame wider, use a larger image, or regenerate at a higher resolution.` });
    else if (scale > MOTION_LIMITS.softScale) issues.push({ kind: 'upscaled', severity: 'warning', message: `This framing enlarges the image ${scale.toFixed(2)}× (slight softening).` });
  }

  // The focal subject stays inside the safe area for the whole move.
  const margin = MOTION_LIMITS.safeMargin;
  const fw = motion.focalSize?.w ?? 0;
  const fh = motion.focalSize?.h ?? 0;
  for (let i = 0; i <= 8; i++) {
    const r = motionRectAt(m, i / 8);
    const lx = (motion.focal.x - fw / 2 - r.x) / r.w;
    const rx = (motion.focal.x + fw / 2 - r.x) / r.w;
    const ty = (motion.focal.y - fh / 2 - r.y) / r.h;
    const by = (motion.focal.y + fh / 2 - r.y) / r.h;
    if (lx < margin * 0.5 || rx > 1 - margin * 0.5 || ty < margin * 0.5 || by > 1 - margin * 0.5) {
      issues.push({ kind: 'focal_outside', severity: lx < 0 || rx > 1 || ty < 0 || by > 1 ? 'error' : 'warning', message: lx < 0 || rx > 1 || ty < 0 || by > 1 ? 'The focal subject leaves the frame during this move.' : 'The focal subject comes close to the frame edge during this move.' });
      break;
    }
  }

  if (opts.durationSec > 0 && !isStill(m)) {
    const zoomRate = Math.abs(Math.log(a.w / b.w)) / opts.durationSec;
    const panRate = Math.max(Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) / Math.min(a.w, b.w), Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) / Math.min(a.h, b.h)) / opts.durationSec;
    if (zoomRate > MOTION_LIMITS.maxZoomRatePerSec * 1.6 || panRate > MOTION_LIMITS.maxPanRatePerSec * 1.6) issues.push({ kind: 'too_fast', severity: 'warning', message: 'This move is fast for its length and may feel hurried. Lower the amount or lengthen the shot.' });
    else if (zoomRate > MOTION_LIMITS.maxZoomRatePerSec || panRate > MOTION_LIMITS.maxPanRatePerSec) issues.push({ kind: 'too_fast', severity: 'info', message: 'A brisk move for a slow film; consider less movement.' });
  }
  return { motion: m, issues, scale };
}

/** A foreground layer moves a little further than the background (subtle parallax). */
export function parallaxMotion(bg: ClipMotion, strength: number): ClipMotion {
  const k = 1 + clamp(strength, 0, 1) * 0.6;
  const c0 = { x: bg.from.x + bg.from.w / 2, y: bg.from.y + bg.from.h / 2 };
  const c1 = { x: bg.to.x + bg.to.w / 2, y: bg.to.y + bg.to.h / 2 };
  const mid = { x: (c0.x + c1.x) / 2, y: (c0.y + c1.y) / 2 };
  const wMid = Math.sqrt(bg.from.w * bg.to.w);
  const hMid = Math.sqrt(bg.from.h * bg.to.h);
  const at = (c: { x: number; y: number }, w: number, h: number): NRect => {
    const cx = mid.x + (c.x - mid.x) * k;
    const cy = mid.y + (c.y - mid.y) * k;
    const ww = wMid * (w / wMid) ** k;
    const hh = hMid * (h / hMid) ** k;
    return { x: r6(clamp(cx - ww / 2, 0, 1 - ww)), y: r6(clamp(cy - hh / 2, 0, 1 - hh)), w: r6(Math.min(1, ww)), h: r6(Math.min(1, hh)) };
  };
  return { from: at(c0, bg.from.w, bg.from.h), to: at(c1, bg.to.w, bg.to.h), ease: bg.ease };
}

/** Optional, deterministic image treatment (rendered locally; never required). */
export interface ClipLook {
  /** Film grain (0–1). */
  grain: number;
  /** Darkened corners (0–1). */
  vignette: number;
  /** Lifted, softened atmosphere like mist (0–1). */
  haze: number;
  /** −1 cool … +1 warm. */
  warmth: number;
  /** Seed for the grain pattern (same seed → same frames). */
  seed: number;
}

export const NO_LOOK: ClipLook = { grain: 0, vignette: 0, haze: 0, warmth: 0, seed: 1 };

export function hasLook(l: ClipLook | null | undefined): l is ClipLook {
  return Boolean(l && (l.grain > 0.001 || l.vignette > 0.001 || l.haze > 0.001 || Math.abs(l.warmth) > 0.001));
}

/** FFmpeg filters for a look (appended to a clip's picture chain). Subtle by design: caps keep faces and text clear. */
export function lookFilters(l: ClipLook): string[] {
  const out: string[] = [];
  const g = clamp(l.grain, 0, 1);
  const v = clamp(l.vignette, 0, 1);
  const hz = clamp(l.haze, 0, 1);
  const w = clamp(l.warmth, -1, 1);
  if (hz > 0.001) out.push(`eq=contrast=${(1 - 0.14 * hz).toFixed(3)}:brightness=${(0.035 * hz).toFixed(3)}:saturation=${(1 - 0.18 * hz).toFixed(3)}`);
  if (Math.abs(w) > 0.001) out.push(`colorbalance=rm=${(0.05 * w).toFixed(3)}:gm=${(0.01 * w).toFixed(3)}:bm=${(-0.05 * w).toFixed(3)}:rh=${(0.03 * w).toFixed(3)}:bh=${(-0.03 * w).toFixed(3)}`);
  if (v > 0.001) out.push(`vignette=angle=${(0.22 + 0.33 * v).toFixed(3)}`);
  if (g > 0.001) out.push(`noise=c0s=${Math.round(3 + 9 * g)}:c0f=t+u:all_seed=${Math.max(1, Math.round(l.seed)) % 2147483647}`);
  return out;
}
