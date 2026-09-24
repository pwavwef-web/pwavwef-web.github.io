import type { Box } from './inspection';

/**
 * Face-safe reframing for aspect-ratio conversion (16:9 → 9:16, 1:1, 4:5). Detected faces, the active
 * speaker, important objects and protected screens are weighted into a subject centre per sample; the
 * path is smoothed forwards and backwards, speed-limited and held inside a dead zone so the crop never
 * jerks, then simplified into keyframes. Manual keyframes always win. The renderer applies the path as
 * a time-varying FFmpeg crop — never a fixed centre crop.
 */

export interface SubjectSample {
  t: number;
  subjects: { box: Box; kind: 'face' | 'speaker' | 'object' | 'screen' | 'person'; weight?: number }[];
}

export interface ReframeKeyframe {
  t: number;
  /** Crop centre (0–1 of the source frame). */
  cx: number;
  cy: number;
  manual?: boolean;
}

export interface ReframeTrack {
  aspect: string;
  /** Crop size as a fraction of the source frame. */
  crop: { w: number; h: number };
  keyframes: ReframeKeyframe[];
  analysedAt: number | null;
  /** Samples where an important face could not be kept whole inside the crop. */
  cutHeads: number[];
}

const KIND_WEIGHT = { speaker: 5, face: 2.5, screen: 3, object: 1.2, person: 1 } as const;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Crop window (fractions of the source) that converts `srcAspect` (w/h) to `dstAspect`. */
export function cropSize(srcAspect: number, dstAspect: number): { w: number; h: number } {
  if (dstAspect < srcAspect) return { w: r4(dstAspect / srcAspect), h: 1 };
  return { w: 1, h: r4(srcAspect / dstAspect) };
}

export function aspectValue(a: string): number {
  const [w, h] = a.split(':').map(Number);
  return (w ?? 16) / (h ?? 9);
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** Where the crop should be centred for one sample (keeps every important face whole when it can). */
export function subjectCentre(s: SubjectSample, crop: { w: number; h: number }): { cx: number; cy: number; cut: boolean } | null {
  if (!s.subjects.length) return null;
  const faces = s.subjects.filter((x) => x.kind === 'face' || x.kind === 'speaker');
  const important = faces.length ? faces : s.subjects;
  let wx = 0;
  let wy = 0;
  let wt = 0;
  for (const x of s.subjects) {
    const w = (x.weight ?? KIND_WEIGHT[x.kind]) * Math.sqrt(Math.max(1e-4, x.box.w * x.box.h));
    wx += (x.box.x + x.box.w / 2) * w;
    wy += (x.box.y + x.box.h * (x.kind === 'face' || x.kind === 'speaker' ? 0.5 : 0.35)) * w;
    wt += w;
  }
  let cx = wx / wt;
  let cy = wy / wt;
  // Keep the union of important faces inside the crop when it fits; otherwise favour the speaker.
  const u = important.reduce((a, x) => ({ x0: Math.min(a.x0, x.box.x), y0: Math.min(a.y0, x.box.y), x1: Math.max(a.x1, x.box.x + x.box.w), y1: Math.max(a.y1, x.box.y + x.box.h) }), { x0: 1, y0: 1, x1: 0, y1: 0 });
  let cut = false;
  if (u.x1 - u.x0 <= crop.w * 0.96) cx = clamp(cx, u.x1 - crop.w / 2 + 0.01, u.x0 + crop.w / 2 - 0.01);
  else {
    const main = [...important].sort((a, b) => (b.weight ?? KIND_WEIGHT[b.kind]) * b.box.w * b.box.h - (a.weight ?? KIND_WEIGHT[a.kind]) * a.box.w * a.box.h)[0]!;
    cx = main.box.x + main.box.w / 2;
    cut = important.length > 1;
  }
  if (u.y1 - u.y0 <= crop.h * 0.96) cy = clamp(cy, u.y1 - crop.h / 2 + 0.01, u.y0 + crop.h / 2 - 0.01);
  // Leave head room: faces sit in the upper part of a vertical frame.
  if (crop.h < 1) cy -= crop.h * 0.08;
  return { cx: clamp(cx, crop.w / 2, 1 - crop.w / 2), cy: clamp(cy, crop.h / 2, 1 - crop.h / 2), cut };
}

function smooth(values: number[], alpha: number): number[] {
  if (!values.length) return values;
  const fwd = [...values];
  for (let i = 1; i < fwd.length; i++) fwd[i] = fwd[i - 1]! + alpha * (values[i]! - fwd[i - 1]!);
  const back = [...fwd];
  for (let i = back.length - 2; i >= 0; i--) back[i] = back[i + 1]! + alpha * (fwd[i]! - back[i + 1]!);
  return back;
}

function rateLimit(ts: number[], xs: number[], maxSpeed: number): number[] {
  const out = [...xs];
  for (let i = 1; i < out.length; i++) {
    const dt = Math.max(1e-3, ts[i]! - ts[i - 1]!);
    const d = out[i]! - out[i - 1]!;
    if (Math.abs(d) > maxSpeed * dt) out[i] = out[i - 1]! + Math.sign(d) * maxSpeed * dt;
  }
  return out;
}

function deadZone(xs: number[], zone: number): number[] {
  const out = [...xs];
  let held = out[0] ?? 0;
  for (let i = 0; i < out.length; i++) {
    if (Math.abs(xs[i]! - held) > zone) held = xs[i]!;
    out[i] = held;
  }
  return out;
}

/** Ramer–Douglas–Peucker simplification of a 1-D path over time. */
function simplify(points: { t: number; v: number }[], tol: number): { t: number; v: number }[] {
  if (points.length <= 2) return points;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  let worst = -1;
  let idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const lerp = a.v + ((b.v - a.v) * (p.t - a.t)) / Math.max(1e-6, b.t - a.t);
    const d = Math.abs(p.v - lerp);
    if (d > worst) {
      worst = d;
      idx = i;
    }
  }
  if (worst <= tol) return [a, b];
  return [...simplify(points.slice(0, idx + 1), tol).slice(0, -1), ...simplify(points.slice(idx), tol)];
}

export interface ReframeOptions {
  /** Largest crop movement per second (fraction of the frame). */
  maxSpeed?: number;
  /** Ignore subject movement smaller than this (fraction of the frame). */
  deadZone?: number;
  smoothing?: number;
  manual?: ReframeKeyframe[];
}

/** Computes a smooth crop path for a clip from subject samples (times relative to the clip). */
export function computeReframe(samples: SubjectSample[], srcAspect: number, dstAspect: number, opts: ReframeOptions = {}): ReframeTrack {
  const crop = cropSize(srcAspect, dstAspect);
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const cutHeads: number[] = [];
  const raw: { t: number; cx: number; cy: number; lo: number | null; hi: number | null }[] = [];
  let last = { cx: 0.5, cy: 0.5 };
  for (const s of sorted) {
    const c = subjectCentre(s, crop);
    if (c) {
      last = { cx: c.cx, cy: c.cy };
      if (c.cut) cutHeads.push(s.t);
    }
    // The range of centres that keeps every important face whole (when they fit together).
    const faces = s.subjects.filter((x) => x.kind === 'face' || x.kind === 'speaker');
    let lo: number | null = null;
    let hi: number | null = null;
    if (faces.length) {
      const x0 = Math.min(...faces.map((f) => f.box.x));
      const x1 = Math.max(...faces.map((f) => f.box.x + f.box.w));
      if (x1 - x0 <= crop.w * 0.98) {
        lo = clamp(x1 - crop.w / 2 + 0.005, crop.w / 2, 1 - crop.w / 2);
        hi = clamp(x0 + crop.w / 2 - 0.005, crop.w / 2, 1 - crop.w / 2);
      }
    }
    raw.push({ t: s.t, ...last, lo, hi });
  }
  if (!raw.length) raw.push({ t: 0, cx: 0.5, cy: 0.5, lo: null, hi: null });
  const ts = raw.map((p) => p.t);
  const alpha = opts.smoothing ?? 0.35;
  const speed = opts.maxSpeed ?? 0.22;
  const zone = opts.deadZone ?? 0.035;
  // Smoothness never wins over framing: a centre that would cut a face is pulled back into range.
  const xs = deadZone(rateLimit(ts, smooth(raw.map((p) => p.cx), alpha), speed), zone).map((x, i) => {
    const r = raw[i]!;
    return r.lo !== null && r.hi !== null && r.lo <= r.hi ? clamp(x, r.lo, r.hi) : x;
  });
  const ys = deadZone(rateLimit(ts, smooth(raw.map((p) => p.cy), alpha), speed * 0.6), zone);
  const kx = simplify(ts.map((t, i) => ({ t, v: xs[i]! })), 0.008);
  const ky = simplify(ts.map((t, i) => ({ t, v: ys[i]! })), 0.008);
  const times = [...new Set([...kx.map((p) => p.t), ...ky.map((p) => p.t)])].sort((a, b) => a - b);
  const at = (arr: { t: number; v: number }[], t: number) => {
    if (t <= arr[0]!.t) return arr[0]!.v;
    for (let i = 1; i < arr.length; i++) if (t <= arr[i]!.t) return arr[i - 1]!.v + ((arr[i]!.v - arr[i - 1]!.v) * (t - arr[i - 1]!.t)) / Math.max(1e-6, arr[i]!.t - arr[i - 1]!.t);
    return arr[arr.length - 1]!.v;
  };
  let keyframes: ReframeKeyframe[] = times.map((t) => ({ t: r4(t), cx: r4(clamp(at(kx, t), crop.w / 2, 1 - crop.w / 2)), cy: r4(clamp(at(ky, t), crop.h / 2, 1 - crop.h / 2)) }));
  if (opts.manual?.length) keyframes = mergeManual(keyframes, opts.manual, crop);
  return { aspect: '', crop, keyframes, analysedAt: Date.now(), cutHeads };
}

/** Manual keyframes replace the automatic path within ±0.75 s of them. */
export function mergeManual(auto: ReframeKeyframe[], manual: ReframeKeyframe[], crop: { w: number; h: number }): ReframeKeyframe[] {
  const m = manual.map((k) => ({ ...k, manual: true, cx: clamp(k.cx, crop.w / 2, 1 - crop.w / 2), cy: clamp(k.cy, crop.h / 2, 1 - crop.h / 2) }));
  const kept = auto.filter((a) => !m.some((k) => Math.abs(k.t - a.t) < 0.75));
  return [...kept, ...m].sort((a, b) => a.t - b.t);
}

export function reframeAt(keys: ReframeKeyframe[], t: number): { cx: number; cy: number } {
  if (!keys.length) return { cx: 0.5, cy: 0.5 };
  if (t <= keys[0]!.t) return { cx: keys[0]!.cx, cy: keys[0]!.cy };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (t <= b.t) {
      const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
      // Ease in/out between keyframes so the camera move feels operated, not mechanical.
      const e = u * u * (3 - 2 * u);
      return { cx: a.cx + (b.cx - a.cx) * e, cy: a.cy + (b.cy - a.cy) * e };
    }
  }
  const z = keys[keys.length - 1]!;
  return { cx: z.cx, cy: z.cy };
}

/**
 * FFmpeg crop expressions for the path: x/y of the crop's top-left corner in source pixels as a
 * function of the clip-local time `t` (piecewise smoothstep between keyframes).
 */
export function reframeCropExpressions(keys: ReframeKeyframe[], srcW: number, srcH: number, crop: { w: number; h: number }, timeOffset = 0): { w: number; h: number; x: string; y: string } {
  const cw = Math.max(2, Math.round((srcW * crop.w) / 2) * 2);
  const ch = Math.max(2, Math.round((srcH * crop.h) / 2) * 2);
  const expr = (pick: (k: ReframeKeyframe) => number, size: number, total: number) => {
    const px = (v: number) => Math.round(Math.min(total - size, Math.max(0, v * total - size / 2)) * 10) / 10;
    if (!keys.length) return String(px(0.5));
    const tt = timeOffset ? `(t+${timeOffset})` : 't';
    let e = String(px(pick(keys[keys.length - 1]!)));
    for (let i = keys.length - 1; i > 0; i--) {
      const a = keys[i - 1]!;
      const b = keys[i]!;
      const pa = px(pick(a));
      const pb = px(pick(b));
      const d = Math.max(1e-3, b.t - a.t);
      const u = `clip((${tt}-${a.t})/${Math.round(d * 1000) / 1000},0,1)`;
      const seg = Math.abs(pb - pa) < 0.05 ? String(pa) : `${pa}+(${Math.round((pb - pa) * 10) / 10})*(${u})*(${u})*(3-2*(${u}))`;
      e = `if(lt(${tt},${b.t}),${seg},${e})`;
    }
    return `if(lt(${tt},${keys[0]!.t}),${px(pick(keys[0]!))},${e})`;
  };
  return { w: cw, h: ch, x: expr((k) => k.cx, cw, srcW), y: expr((k) => k.cy, ch, srcH) };
}

/** Samples where a planned subject box is not fully inside the crop (a cut-off head). */
export function headsCut(samples: SubjectSample[], keys: ReframeKeyframe[], crop: { w: number; h: number }): number[] {
  const out: number[] = [];
  for (const s of samples) {
    const c = reframeAt(keys, s.t);
    const x0 = c.cx - crop.w / 2;
    const x1 = c.cx + crop.w / 2;
    const y0 = c.cy - crop.h / 2;
    const y1 = c.cy + crop.h / 2;
    const faces = s.subjects.filter((x) => x.kind === 'face' || x.kind === 'speaker');
    if (faces.some((f) => f.box.x < x0 - 0.005 || f.box.x + f.box.w > x1 + 0.005 || f.box.y < y0 - 0.005 || f.box.y + f.box.h > y1 + 0.005)) out.push(s.t);
  }
  return out;
}
