import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { TextScene } from '@az-studio/shared';
import { drawTextScene, type DrawOptions } from '../lib/text-canvas';
import { cx } from './ui';

/**
 * Canvas preview of a text scene at time t (lyrics, credits). Drawing uses scene pixels, so what is shown
 * is the measured layout the export renders. `onPoint` reports clicks as 0–1 frame coordinates.
 */
export function TextScenePreview({ scene, time, background, safeArea, faces, className, onPoint, label }: { scene: TextScene; time: number; background?: CanvasImageSource | null; safeArea?: DrawOptions['safeArea']; faces?: DrawOptions['faces']; className?: string; onPoint?: (p: { x: number; y: number }) => void; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const cssW = c.clientWidth || 320;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const k = (cssW * dpr) / scene.width;
    const w = Math.max(1, Math.round(scene.width * k));
    const h = Math.max(1, Math.round(scene.height * k));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawTextScene(ctx, scene, time, { background: background ?? null, safeArea: safeArea ?? null, faces: faces ?? [] });
  }, [scene, time, background, safeArea, faces]);
  const click = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!onPoint) return;
    const r = e.currentTarget.getBoundingClientRect();
    onPoint({ x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) });
  };
  return <canvas ref={ref} role="img" aria-label={label ?? 'Text preview'} onPointerDown={click} className={cx('block w-full rounded-lg bg-black', onPoint && 'cursor-crosshair', className)} style={{ aspectRatio: `${scene.width} / ${scene.height}` }} />;
}
