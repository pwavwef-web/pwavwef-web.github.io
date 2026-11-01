import { useEffect, useState } from 'react';
import { drawingFamily, type PosterForm, type PosterItem, type PosterLayout } from '@az-studio/shared';
import { getMediaUrls } from './media';
import { cssFont, useFontsReady } from './text-canvas';

/**
 * Draws a Motion Poster Ad poster. The layout (`layoutPoster`) is measured with the browser's real fonts
 * (`canvasMeasure`), and the same `drawPoster` paints both the on-screen preview and the exported PNG at the format's
 * full pixel size, so what the director approves is exactly the file that is uploaded.
 */

export type PosterImages = Map<string, ImageBitmap>;

const bitmaps = new Map<string, Promise<ImageBitmap>>();

/** Loads a studio picture as a bitmap (fetched with CORS, so the canvas stays exportable). */
export function loadBitmap(assetId: string): Promise<ImageBitmap> {
  let p = bitmaps.get(assetId);
  if (!p) {
    p = (async () => {
      const urls = await getMediaUrls(assetId);
      if (!urls.file) throw new Error('The picture is not available.');
      const res = await fetch(urls.file, { mode: 'cors' });
      if (!res.ok) throw new Error(`The picture could not be loaded (${res.status}).`);
      return createImageBitmap(await res.blob());
    })();
    bitmaps.set(assetId, p);
    p.catch(() => bitmaps.delete(assetId));
  }
  return p;
}

/** The pictures a layout draws, loaded; `error` names a picture that could not be read. */
export function usePosterImages(ids: string[]): { images: PosterImages; loading: boolean; error: string | null } {
  const key = [...new Set(ids.filter(Boolean))].sort().join(',');
  const [state, setState] = useState<{ images: PosterImages; loading: boolean; error: string | null }>({ images: new Map(), loading: Boolean(key), error: null });
  useEffect(() => {
    let alive = true;
    if (!key) {
      setState({ images: new Map(), loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    void Promise.allSettled(key.split(',').map(async (id) => [id, await loadBitmap(id)] as const)).then((res) => {
      if (!alive) return;
      const images: PosterImages = new Map();
      let error: string | null = null;
      for (const r of res) {
        if (r.status === 'fulfilled') images.set(r.value[0], r.value[1]);
        else error = r.reason instanceof Error ? r.reason.message : String(r.reason);
      }
      setState({ images, loading: false, error });
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return state;
}

/** Loads the poster's fonts (bundled families at the weights used, licensed uploads); the counter changes when ready. */
export function usePosterFonts(poster: PosterForm | null): { version: number; missing: string[] } {
  const fonts = poster ? [poster.fonts.heading, poster.fonts.body] : [];
  const families = fonts.flatMap((f) => [{ family: drawingFamily(f), weight: 400 }, { family: drawingFamily(f), weight: 600 }, { family: drawingFamily(f), weight: 700 }]);
  const uploads = fonts.filter((f) => f.uploadAssetId && f.licenceConfirmed).map((f) => ({ family: drawingFamily(f), assetId: f.uploadAssetId! }));
  const version = useFontsReady(families, uploads);
  const [missing, setMissing] = useState<string[]>([]);
  useEffect(() => {
    // A family the browser does not have would be drawn with a fallback: say so rather than export it silently.
    setMissing([...new Set(families.map((f) => f.family))].filter((fam) => !document.fonts.check(cssFont({ family: fam, weight: 400, italic: false, sizePx: 32 }), 'Aa')).map((fam) => (fam.startsWith('kit-') ? 'the uploaded brand font' : fam)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  return { version, missing };
}

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

function drawImage(ctx: CanvasRenderingContext2D, it: Extract<PosterItem, { kind: 'image' }>, img: ImageBitmap) {
  ctx.save();
  roundRect(ctx, it.x, it.y, it.w, it.h, it.radius);
  ctx.clip();
  const sr = img.width / img.height;
  const br = it.w / it.h;
  if (it.fit === 'cover') {
    // Crop the source around the focal point so the box is filled without stretching.
    const sw = sr > br ? img.height * br : img.width;
    const sh = sr > br ? img.height : img.width / br;
    const sx = Math.min(img.width - sw, Math.max(0, it.focal.x * img.width - sw / 2));
    const sy = Math.min(img.height - sh, Math.max(0, it.focal.y * img.height - sh / 2));
    ctx.drawImage(img, sx, sy, sw, sh, it.x, it.y, it.w, it.h);
  } else {
    const w = sr > br ? it.w : it.h * sr;
    const h = sr > br ? it.w / sr : it.h;
    const x = it.x + (it.w - w) * it.focal.x;
    const y = it.y + (it.h - h) / 2;
    ctx.drawImage(img, x, y, w, h);
  }
  ctx.restore();
}

/** Paints a laid-out poster at its full size. Missing pictures are left as their box (the export refuses them). */
export function drawPoster(ctx: CanvasRenderingContext2D, layout: PosterLayout, images: PosterImages): void {
  ctx.save();
  ctx.clearRect(0, 0, layout.width, layout.height);
  for (const it of layout.items) {
    if (it.kind === 'rect') {
      ctx.globalAlpha = it.opacity;
      ctx.fillStyle = it.fill;
      roundRect(ctx, it.x, it.y, it.w, it.h, it.radius);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else if (it.kind === 'image') {
      const img = images.get(it.assetId);
      if (img) drawImage(ctx, it, img);
      else {
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        roundRect(ctx, it.x, it.y, it.w, it.h, it.radius);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = it.color;
      ctx.font = cssFont({ family: it.family, weight: it.weight, italic: false, sizePx: it.sizePx });
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = it.align;
      const x = it.align === 'left' ? it.x : it.align === 'right' ? it.x + it.w : it.x + it.w / 2;
      it.lines.forEach((line, i) => ctx.fillText(line, x, it.baselines[i]!));
    }
  }
  ctx.restore();
}

/** The poster as a PNG file of exactly the format's size. */
export async function posterPng(layout: PosterLayout, images: PosterImages, name: string): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw the poster.');
  drawPoster(ctx, layout, images);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The poster could not be exported.');
  return new File([blob], `${name.replace(/[^\w-]+/g, '-').slice(0, 60) || 'poster'}-${layout.format.replace(':', 'x')}.png`, { type: 'image/png' });
}
