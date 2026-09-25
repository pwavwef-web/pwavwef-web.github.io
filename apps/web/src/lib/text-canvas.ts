import { useEffect, useState } from 'react';
import { blockAlpha, blockAt, blockTransform, sweepProgress, type MeasureText, type SceneBlock, type SceneLine, type SceneWord, type TextPaint, type TextScene } from '@az-studio/shared';


/**
 * Browser drawing of a text scene (lyrics, credits). It uses the same measured layout the exporter turns
 * into ASS events: explicit word positions and baselines, the same entrance/exit timing, karaoke sweep,
 * active-word highlight, typewriter, pop and bouncing-ball effects, boxes, dimming, glow and gradients.
 * Fonts are the same families (bundled web fonts or the owner's uploaded, licence-confirmed files).
 */

const FAMILY_STACK: Record<string, string> = {
  Inter: '"Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif',
  'EB Garamond': '"EB Garamond", Georgia, serif',
  'DejaVu Sans': '"DejaVu Sans", Verdana, sans-serif',
  'DejaVu Sans Mono': '"DejaVu Sans Mono", ui-monospace, Menlo, Consolas, monospace',
  'Noto Sans': '"Noto Sans", system-ui, sans-serif',
};

export function cssFont(f: { family: string; weight: number; italic: boolean; sizePx: number }): string {
  const stack = FAMILY_STACK[f.family] ?? `"${f.family.replace(/"/g, '')}", ui-sans-serif, sans-serif`;
  return `${f.italic ? 'italic ' : ''}${Math.round(f.weight)} ${Math.max(1, f.sizePx).toFixed(2)}px ${stack}`;
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** Real glyph metrics from the browser (accents and descenders included), like the renderer's font engine. */
export const canvasMeasure: MeasureText = (text, f) => {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  const ctx = measureCtx;
  if (!ctx) return { width: text.length * f.sizePx * 0.55, ascent: f.sizePx * 0.8, descent: f.sizePx * 0.24 };
  ctx.font = cssFont({ family: f.family, weight: f.weight, italic: f.italic, sizePx: f.sizePx });
  const m = ctx.measureText(text);
  const chars = [...text].length;
  const width = m.width + Math.max(0, chars - 1) * f.letterSpacingPx;
  const nominalAscent = m.fontBoundingBoxAscent || f.sizePx * 0.9;
  const nominalDescent = m.fontBoundingBoxDescent || f.sizePx * 0.24;
  if (!text.trim()) return { width, ascent: nominalAscent, descent: nominalDescent };
  return { width, ascent: Math.max(m.actualBoundingBoxAscent || 0, nominalAscent * 0.7), descent: Math.max(m.actualBoundingBoxDescent || 0, 0) };
};

const loadedUploads = new Map<string, Promise<void>>();

/** Registers an uploaded font file under the family name the style uses (preview only). */
export function loadUploadedFont(family: string, assetId: string): Promise<void> {
  const key = `${family}|${assetId}`;
  let p = loadedUploads.get(key);
  if (!p) {
    p = (async () => {
      const { getMediaUrls } = await import('./media');
      const urls = await getMediaUrls(assetId);
      if (!urls.file) throw new Error('Font file unavailable');
      const face = new FontFace(family, `url(${urls.file})`);
      await face.load();
      document.fonts.add(face);
    })();
    loadedUploads.set(key, p);
    p.catch(() => loadedUploads.delete(key));
  }
  return p;
}

/**
 * Loads the families a layout will use (bundled fonts at the needed weights and uploaded font files) and
 * returns a counter that changes once they are ready, so layouts are measured with the real fonts.
 */
export function useFontsReady(fonts: { family: string; weight: number; italic?: boolean }[], uploads: { family: string; assetId: string }[] = []): number {
  const [version, setVersion] = useState(0);
  const key = JSON.stringify([fonts, uploads]);
  useEffect(() => {
    let alive = true;
    const jobs: Promise<unknown>[] = [
      ...uploads.map((u) => loadUploadedFont(u.family, u.assetId).catch(() => undefined)),
      ...fonts.map((f) => document.fonts.load(cssFont({ family: f.family, weight: f.weight, italic: Boolean(f.italic), sizePx: 32 }), 'AaÀà').catch(() => undefined)),
    ];
    void Promise.all(jobs).then(() => {
      if (alive) setVersion((v) => v + 1);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return version;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------


function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function applyFont(ctx: CanvasRenderingContext2D, p: TextPaint, scale = 1) {
  ctx.font = cssFont({ family: p.fontFamily, weight: p.fontWeight, italic: p.italic, sizePx: p.sizePx * scale });
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ('letterSpacing' in c) c.letterSpacing = `${(p.letterSpacingPx * scale).toFixed(2)}px`;
}

/** Draws one run of text with outline, shadow, glow and fill (baseline at y). */
function drawRun(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, p: TextPaint, fill: string | CanvasGradient, alpha: number) {
  if (alpha <= 0.001) return;
  ctx.save();
  ctx.globalAlpha = alpha * p.opacity;
  ctx.lineJoin = 'round';
  if (p.glow && p.glow.strength > 0) {
    ctx.save();
    ctx.globalAlpha = alpha * p.opacity * p.glow.strength;
    ctx.filter = `blur(${(p.glow.radius * 0.6).toFixed(1)}px)`;
    ctx.strokeStyle = p.glow.color;
    ctx.lineWidth = p.glow.radius * 2;
    ctx.strokeText(text, x, y);
    ctx.restore();
  }
  if (p.shadow) {
    ctx.save();
    ctx.globalAlpha = alpha * p.opacity * p.shadow.opacity;
    ctx.fillStyle = p.shadow.color;
    ctx.strokeStyle = p.shadow.color;
    if (p.outline && p.outline.width > 0) {
      ctx.lineWidth = p.outline.width * 2;
      ctx.strokeText(text, x + p.shadow.x, y + p.shadow.y);
    }
    ctx.fillText(text, x + p.shadow.x, y + p.shadow.y);
    ctx.restore();
  }
  if (p.outline && p.outline.width > 0) {
    ctx.strokeStyle = p.outline.color;
    ctx.lineWidth = p.outline.width * 2;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function lineText(l: SceneLine): string {
  return l.words.map((w) => w.text).join(' ');
}

function gradientFill(ctx: CanvasRenderingContext2D, l: SceneLine): CanvasGradient | null {
  const g = l.paint.gradient;
  if (!g) return null;
  const top = l.y - l.ascent;
  const bottom = l.y + l.descent;
  const mid = l.y - (l.ascent - l.descent) / 2;
  const grad = ctx.createLinearGradient(0, top, 0, bottom);
  const k = Math.max(0, Math.min(1, (mid - top) / Math.max(1, bottom - top)));
  grad.addColorStop(0, g.from);
  grad.addColorStop(k, g.from);
  grad.addColorStop(Math.min(1, k + 0.001), g.to);
  grad.addColorStop(1, g.to);
  return grad;
}

function drawLine(ctx: CanvasRenderingContext2D, b: SceneBlock, l: SceneLine, t: number, alpha: number) {
  const p = l.paint;
  applyFont(ctx, p);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if (b.effect === 'sweep' && l.words.some((w) => w.start !== null)) {
    for (const w of l.words) {
      drawRun(ctx, w.text, w.x, w.y, p, p.inactiveColor, alpha);
      const k = sweepProgress(w, t);
      if (k <= 0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(w.x - p.sizePx, w.y - l.ascent - p.sizePx, w.width * k + p.sizePx, l.ascent + l.descent + p.sizePx * 2);
      ctx.clip();
      drawRun(ctx, w.text, w.x, w.y, { ...p, shadow: null, glow: null }, p.color, alpha);
      ctx.restore();
    }
    return;
  }
  if (b.effect === 'highlight') {
    for (const w of l.words) {
      const on = w.start !== null && w.end !== null && t >= w.start && t < Math.max(w.end, w.start + 0.08);
      if (!on) {
        drawRun(ctx, w.text, w.x, w.y, p, p.inactiveColor, alpha);
        continue;
      }
      ctx.save();
      const cx = w.x + w.width / 2;
      const cy = w.y - (l.ascent - l.descent) / 2;
      ctx.translate(cx, cy);
      ctx.scale(1.1, 1.1);
      ctx.translate(-cx, -cy);
      drawRun(ctx, w.text, w.x, w.y, p, p.color, alpha);
      ctx.restore();
    }
    return;
  }
  if (b.effect === 'typewriter') {
    for (const w of l.words) {
      const s = w.start ?? b.start;
      const e = Math.max(w.end ?? s + 0.3, s + 0.05);
      const chars = [...w.text];
      const shown = t >= e ? chars.length : t < s ? 0 : Math.floor(((t - s) / (e - s)) * chars.length) + 1;
      if (shown > 0) drawRun(ctx, chars.slice(0, Math.min(shown, chars.length)).join(''), w.x, w.y, p, p.inactiveColor, alpha);
    }
    return;
  }
  const text = lineText(l);
  if (b.effect === 'instant' && l.start !== null && l.end !== null) {
    drawRun(ctx, text, l.x, l.y, p, t >= l.start && t < l.end ? p.color : p.inactiveColor, alpha);
    return;
  }
  const grad = b.effect === 'none' || b.effect === 'instant' ? gradientFill(ctx, l) : null;
  // Words carry explicit positions (right-to-left rows included); draw them where the layout put them.
  if (l.rtl || l.words.length > 1) {
    for (const w of l.words) drawRun(ctx, w.text, w.x, w.y, p, grad ?? p.inactiveColor, alpha);
  } else drawRun(ctx, text, l.x, l.y, p, grad ?? p.inactiveColor, alpha);
}

function drawPopWords(ctx: CanvasRenderingContext2D, b: SceneBlock, t: number) {
  for (const l of b.lines) {
    for (const w of l.words) {
      const s = Math.min(b.end - 0.05, Math.max(b.start, w.start ?? b.start));
      if (t < s) continue;
      const dt = (t - s) * 1000;
      const pop = dt < 90 ? 0.55 + (1.18 - 0.55) * (dt / 90) : dt < 190 ? 1.18 - 0.18 * ((dt - 90) / 100) : 1;
      const exitA = b.exit !== 'none' ? Math.max(0, Math.min(1, (b.end - t) / Math.max(0.001, b.transitionSec))) : 1;
      const sung = w.end === null || t < w.end + 0.08;
      const cx = w.x + (w.width * w.scale) / 2;
      const cy = w.y - (l.ascent - l.descent) / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(pop * w.scale, pop * w.scale);
      ctx.translate(-cx, -cy);
      applyFont(ctx, l.paint);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      drawRun(ctx, w.text, cx, w.y, l.paint, sung ? l.paint.color : l.paint.inactiveColor, exitA);
      ctx.restore();
    }
  }
}

function ballPosition(b: SceneBlock, t: number): { x: number; y: number } | null {
  if (!b.ball) return null;
  const words: { w: SceneWord; top: number }[] = b.lines.flatMap((l) => l.words.map((w) => ({ w, top: w.y - l.ascent })));
  let prev: { x: number; y: number; t: number } | null = null;
  for (const { w, top } of words) {
    if (w.start === null) continue;
    const cx = w.x + w.width / 2;
    const cy = top - b.ball.radius * 1.6;
    const from = prev ?? { x: cx, y: cy, t: Math.max(b.start, w.start - 0.25) };
    const t2 = w.start;
    const mid = (from.t + t2) / 2;
    const apex = { x: (from.x + cx) / 2, y: Math.min(from.y, cy) - b.ball.lift };
    if (t >= from.t && t < t2 && t2 - from.t > 0.04) {
      if (t < mid) {
        const k = (t - from.t) / Math.max(0.001, mid - from.t);
        return { x: from.x + (apex.x - from.x) * k, y: from.y + (apex.y - from.y) * k };
      }
      const k = (t - mid) / Math.max(0.001, t2 - mid);
      return { x: apex.x + (cx - apex.x) * k, y: apex.y + (cy - apex.y) * k };
    }
    const hold = Math.max(t2 + 0.05, w.end ?? t2 + 0.2);
    if (t >= t2 && t < hold) return { x: cx, y: cy };
    prev = { x: cx, y: cy, t: hold };
  }
  return null;
}

export interface DrawOptions {
  /** Picture under the text (video frame or still), drawn to cover the frame. */
  background?: CanvasImageSource | null;
  /** Outline the platform safe area and highlight detected faces (0–1 boxes). */
  safeArea?: { top: number; bottom: number; left: number; right: number } | null;
  faces?: { x: number; y: number; w: number; h: number }[];
}

function drawCover(ctx: CanvasRenderingContext2D, src: CanvasImageSource, W: number, H: number) {
  const sw = (src as HTMLVideoElement).videoWidth || (src as HTMLImageElement).naturalWidth || W;
  const sh = (src as HTMLVideoElement).videoHeight || (src as HTMLImageElement).naturalHeight || H;
  const k = Math.max(W / sw, H / sh);
  const dw = sw * k;
  const dh = sh * k;
  ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

/** Draws the scene at time t into a context whose coordinates are the scene's pixels. */
export function drawTextScene(ctx: CanvasRenderingContext2D, scene: TextScene, t: number, opts: DrawOptions = {}) {
  const W = scene.width;
  const H = scene.height;
  ctx.clearRect(0, 0, W, H);
  if (opts.background) drawCover(ctx, opts.background, W, H);
  else {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#1a2436');
    g.addColorStop(1, '#0b0f17');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  for (const f of opts.faces ?? []) {
    ctx.save();
    ctx.strokeStyle = 'rgba(62,214,144,0.9)';
    ctx.lineWidth = Math.max(2, W / 480);
    ctx.setLineDash([W / 120, W / 160]);
    ctx.strokeRect(f.x * W, f.y * H, f.w * W, f.h * H);
    ctx.restore();
  }
  for (const b of blockAt(scene, t)) {
    const alpha = blockAlpha(b, t);
    const tr = blockTransform(b, t);
    if (b.dim) {
      ctx.save();
      ctx.globalAlpha = b.dim.opacity * alpha;
      ctx.fillStyle = b.dim.color;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    if (b.blur && opts.background) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.blur.x, b.blur.y, b.blur.w, b.blur.h);
      ctx.clip();
      ctx.filter = `blur(${b.blur.radius}px)`;
      drawCover(ctx, opts.background, W, H);
      ctx.restore();
    }
    if (b.box) {
      ctx.save();
      ctx.globalAlpha = b.box.opacity * alpha;
      ctx.fillStyle = b.box.color;
      roundRect(ctx, b.box.x, b.box.y, b.box.w, b.box.h, b.box.radius);
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    const cx = b.bounds.x + b.bounds.w / 2;
    const cy = b.bounds.y + b.bounds.h / 2;
    ctx.translate(tr.dx, tr.dy);
    if (tr.scale !== 1) {
      ctx.translate(cx, cy);
      ctx.scale(tr.scale, tr.scale);
      ctx.translate(-cx, -cy);
    }
    if (b.rotation) {
      ctx.translate(cx, cy);
      ctx.rotate((-b.rotation.z * Math.PI) / 180);
      ctx.scale(Math.cos((b.rotation.y * Math.PI) / 180), 1);
      ctx.translate(-cx, -cy);
    }
    if (tr.blur > 0.2) ctx.filter = `blur(${tr.blur.toFixed(1)}px)`;
    if (b.effect === 'pop') drawPopWords(ctx, b, t);
    else for (const l of b.lines) drawLine(ctx, b, l, t, alpha);
    ctx.restore();
    const ball = ballPosition(b, t);
    if (ball && b.ball) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = b.ball.color;
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(ball.x + b.ball.radius, ball.y + b.ball.radius, b.ball.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
  if (opts.safeArea) {
    const s = opts.safeArea;
    ctx.save();
    ctx.strokeStyle = 'rgba(244,184,74,0.7)';
    ctx.lineWidth = Math.max(1.5, W / 640);
    ctx.setLineDash([W / 90, W / 120]);
    ctx.strokeRect(s.left * W, s.top * H, (1 - s.left - s.right) * W, (1 - s.top - s.bottom) * H);
    ctx.restore();
  }
}

