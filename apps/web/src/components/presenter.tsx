import { useEffect, useState } from 'react';
import { PRESENTER_EVENT, presenterEnabled, setPresenterEnabled } from '../lib/presenter';

const CURSOR_SVG =
  '<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><path d="M3 2.2 21.6 14.1l-8.3 1.3-4.7 7.4z" fill="#fff" stroke="#05070b" stroke-width="1.6" stroke-linejoin="round"/></svg>';

/**
 * Presenter mode for tutorials and screen recordings:
 * - a smooth, clearly visible cursor that follows the pointer, with a highlight on every click;
 * - Alt+Shift+Z zooms smoothly toward the pointer (again, Alt+Shift+X or Esc to zoom out);
 * - Alt+Shift+F toggles full screen; Alt+Shift+P toggles presenter mode anywhere;
 * - elements marked `data-private` (email, recorded spend) are blurred.
 * The cursor lives outside <body> so zooming the page never scales or offsets it.
 */
export function Presenter() {
  const [on, setOn] = useState(presenterEnabled);

  useEffect(() => {
    const sync = () => setOn(presenterEnabled());
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && e.code === 'KeyP') {
        e.preventDefault();
        setPresenterEnabled(!presenterEnabled());
      }
    };
    window.addEventListener(PRESENTER_EVENT, sync);
    window.addEventListener('storage', sync);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(PRESENTER_EVENT, sync);
      window.removeEventListener('storage', sync);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute('data-presenter', on);
    if (!on) return;
    const cursor = document.createElement('div');
    cursor.className = 'presenter-cursor';
    cursor.innerHTML = CURSOR_SVG;
    root.appendChild(cursor);

    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;
    let zoomed = false;
    let resetTimer = 0;
    const place = () => {
      cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };
    place();
    const onMove = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      place();
    };
    const onDown = (e: PointerEvent) => {
      onMove(e);
      const ring = document.createElement('div');
      ring.className = 'presenter-ripple';
      ring.style.left = `${x}px`;
      ring.style.top = `${y}px`;
      root.appendChild(ring);
      window.setTimeout(() => ring.remove(), 750);
    };
    const body = document.body;
    const zoomTo = (scale: number) => {
      window.clearTimeout(resetTimer);
      if (scale > 1) {
        body.style.transformOrigin = `${x + window.scrollX}px ${y + window.scrollY}px`;
        body.style.transform = `scale(${scale})`;
        zoomed = true;
        return;
      }
      body.style.transform = 'scale(1)';
      zoomed = false;
      // Drop the transform once settled so fixed-position UI behaves normally again.
      resetTimer = window.setTimeout(() => {
        if (zoomed) return;
        body.style.transform = '';
        body.style.transformOrigin = '';
      }, 760);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && zoomed) return zoomTo(1);
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      if (e.code === 'KeyZ') {
        e.preventDefault();
        zoomTo(zoomed ? 1 : 1.8);
      } else if (e.code === 'KeyX') {
        e.preventDefault();
        zoomTo(1);
      } else if (e.code === 'KeyF') {
        e.preventDefault();
        if (document.fullscreenElement) void document.exitFullscreen();
        else void root.requestFullscreen().catch(() => undefined);
      }
    };
    window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    window.addEventListener('pointerdown', onDown, { capture: true, passive: true });
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('keydown', onKey, { capture: true });
      window.clearTimeout(resetTimer);
      cursor.remove();
      body.style.transform = '';
      body.style.transformOrigin = '';
      root.removeAttribute('data-presenter');
    };
  }, [on]);

  return null;
}
