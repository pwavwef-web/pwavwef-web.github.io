/**
 * Colour Director maths: per-channel statistics of sampled frames, a limited Reinhard-style transfer
 * toward an approved reference (exposure, white balance, contrast) with skin-tone protection, and the
 * FFmpeg filter that applies it. Corrections are deliberately capped — a colour match must never turn
 * skin grey or orange, or flatten a look that is intentionally different.
 */

export type Rgb = [number, number, number];

export interface RgbStats {
  mean: Rgb;
  std: Rgb;
  /** Mean of detected skin/face regions, when available. */
  skin: Rgb | null;
  samples: number;
}

/** Statistics of interleaved 8-bit RGB pixels. */
export function statsFromRgb(pixels: ArrayLike<number>, skin: Rgb | null = null): RgbStats {
  const n = Math.floor(pixels.length / 3);
  const sum: Rgb = [0, 0, 0];
  const sq: Rgb = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = pixels[i * 3 + c]!;
      sum[c] = sum[c]! + v;
      sq[c] = sq[c]! + v * v;
    }
  }
  const mean = sum.map((s) => s / Math.max(1, n)) as Rgb;
  const std = sq.map((s, c) => Math.sqrt(Math.max(0, s / Math.max(1, n) - mean[c]! * mean[c]!))) as Rgb;
  return { mean, std, skin, samples: n };
}

export interface ColourCorrection {
  gain: Rgb;
  offset: Rgb;
  strength: number;
  skinProtected: boolean;
  notes: string[];
}

export interface MatchOptions {
  /** 0–1 blend toward the full transfer. */
  strength?: number;
  /** Largest per-channel gain (and its inverse as the smallest). */
  maxGain?: number;
  /** Largest per-channel offset in 8-bit levels. */
  maxOffset?: number;
  /** Largest skin hue change allowed (degrees) before the correction is weakened. */
  maxSkinHueShift?: number;
}

export function applyCorrection(c: Pick<ColourCorrection, 'gain' | 'offset'>, rgb: Rgb): Rgb {
  return rgb.map((v, i) => Math.max(0, Math.min(255, v * c.gain[i]! + c.offset[i]!))) as Rgb;
}

/** Hue angle (degrees) of an RGB colour in the YUV chroma plane. */
export function hueOf(rgb: Rgb): number {
  const [r, g, b] = rgb;
  const u = -0.14713 * r - 0.28886 * g + 0.436 * b;
  const v = 0.615 * r - 0.51499 * g - 0.10001 * b;
  return ((Math.atan2(v, u) * 180) / Math.PI + 360) % 360;
}

function hueDiff(a: number, b: number) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

/** Computes a capped per-channel transfer from `src` toward `ref`. */
export function computeColourMatch(src: RgbStats, ref: RgbStats, opts: MatchOptions = {}): ColourCorrection {
  const maxGain = opts.maxGain ?? 1.35;
  const maxOffset = opts.maxOffset ?? 40;
  const notes: string[] = [];
  let strength = Math.max(0, Math.min(1, opts.strength ?? 0.8));
  const full = (s: number) => {
    const gain = [0, 1, 2].map((c) => {
      const g = src.std[c]! > 1 ? ref.std[c]! / src.std[c]! : 1;
      return Math.max(1 / maxGain, Math.min(maxGain, g));
    }) as Rgb;
    const offset = [0, 1, 2].map((c) => Math.max(-maxOffset, Math.min(maxOffset, ref.mean[c]! - gain[c]! * src.mean[c]!))) as Rgb;
    return { gain: gain.map((g) => 1 + s * (g - 1)) as Rgb, offset: offset.map((o) => s * o) as Rgb };
  };
  let c = full(strength);
  let skinProtected = false;
  if (src.skin) {
    const target = ref.skin ?? src.skin;
    const limit = opts.maxSkinHueShift ?? 8;
    for (let i = 0; i < 6; i++) {
      const after = applyCorrection(c, src.skin);
      const shift = hueDiff(hueOf(after), hueOf(target));
      const before = hueDiff(hueOf(src.skin), hueOf(target));
      // Only accept corrections that keep skin within the limit of its target (or do not make it worse).
      if (shift <= Math.max(limit, before)) break;
      strength *= 0.6;
      c = full(strength);
      skinProtected = true;
    }
    if (skinProtected) notes.push(`Strength reduced to ${Math.round(strength * 100)}% to protect skin tones.`);
  }
  const lumaGain = (c.gain[0] * 0.2126 + c.gain[1] * 0.7152 + c.gain[2] * 0.0722).toFixed(2);
  notes.push(`Gains R ${c.gain[0].toFixed(2)} G ${c.gain[1].toFixed(2)} B ${c.gain[2].toFixed(2)} (luma ≈ ×${lumaGain}); offsets ${c.offset.map((o) => o.toFixed(0)).join(' / ')}.`);
  return { ...c, strength, skinProtected, notes };
}

const f3 = (n: number) => Math.round(n * 1000) / 1000;

/** FFmpeg filter applying a correction (8-bit RGB lookup). */
export function lutrgbFilter(c: Pick<ColourCorrection, 'gain' | 'offset'>): string {
  const ch = (i: number) => `clip(val*${f3(c.gain[i]!)}+${f3(c.offset[i]!)},0,255)`;
  return `format=rgb24,lutrgb=r='${ch(0)}':g='${ch(1)}':b='${ch(2)}',format=yuv420p`;
}

/** Approximate RGB multipliers for a colour temperature (Tanner Helland's fit), normalised to G = 1. */
export function kelvinToRgb(kelvin: number): Rgb {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clampC = (v: number) => Math.max(1, Math.min(255, v));
  const G = clampC(g);
  return [f3(clampC(r) / G), 1, f3(clampC(b) / G)];
}
