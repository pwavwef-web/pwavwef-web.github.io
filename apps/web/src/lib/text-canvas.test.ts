import { describe, expect, it } from 'vitest';
import { approximateMeasure, ASPECT_SIZES, defaultLyricStyleDoc, layoutLyrics, SAFE_AREAS, type LyricInputLine } from '@az-studio/shared';
import { drawTextScene } from './text-canvas';

/** A 2D context that records what is drawn (jsdom has no canvas implementation). */
function recorder() {
  const calls: { op: string; args: unknown[]; fill: unknown; alpha: number; clipped: number }[] = [];
  let clipDepth = 0;
  const stack: number[] = [];
  const state = { fillStyle: '#000000' as unknown, strokeStyle: '#000000' as unknown, globalAlpha: 1, font: '', lineWidth: 1, lineJoin: 'miter', textAlign: 'left', textBaseline: 'alphabetic', filter: 'none', letterSpacing: '0px' };
  const ctx = new Proxy(state as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        if (prop === 'save') stack.push(clipDepth);
        if (prop === 'restore') clipDepth = stack.pop() ?? 0;
        if (prop === 'clip') clipDepth++;
        if (prop === 'createLinearGradient') return { addColorStop: () => undefined };
        calls.push({ op: prop, args, fill: target.fillStyle, alpha: target.globalAlpha as number, clipped: clipDepth });
        return undefined;
      };
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const lines: LyricInputLine[] = [{ id: 'l1', text: 'Sing it loud', start: 2, end: 4, section: 'chorus', words: [{ text: 'Sing', start: 2, end: 2.5 }, { text: 'it', start: 2.5, end: 2.8 }, { text: 'loud', start: 2.8, end: 3.8 }], translation: null }];
const layout = (preset: 'karaoke' | 'line_by_line') => layoutLyrics({ lines, doc: defaultLyricStyleDoc(preset), aspect: '16:9', ...ASPECT_SIZES['16:9'], measure: approximateMeasure, fps: 25 });

describe('canvas preview of the lyric scene', () => {
  it('draws nothing before the line and the whole line while it is sung', () => {
    const scene = layout('line_by_line').scene;
    const before = recorder();
    drawTextScene(before.ctx, scene, 1);
    expect(before.calls.filter((c) => c.op === 'fillText')).toHaveLength(0);
    const during = recorder();
    drawTextScene(during.ctx, scene, 3);
    const texts = during.calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]);
    expect(texts.join(' ')).toContain('Sing');
    expect(texts.join(' ')).toContain('loud');
  });

  it('sweeps the active colour through the word being sung (karaoke)', () => {
    const style = defaultLyricStyleDoc('karaoke').global;
    const r = recorder();
    // Halfway through “loud”: the word is drawn in the inactive colour, then again clipped in the active colour.
    drawTextScene(r.ctx, layout('karaoke').scene, 3.3);
    const loud = r.calls.filter((c) => c.op === 'fillText' && c.args[0] === 'loud');
    expect(loud.some((c) => c.fill === style.inactiveColor && c.clipped === 0)).toBe(true);
    expect(loud.some((c) => c.fill === style.activeColor && c.clipped > 0)).toBe(true);
    // “Sing” has been sung completely: its active pass is clipped to its full width.
    const clipRects = r.calls.filter((c) => c.op === 'rect');
    expect(clipRects.length).toBeGreaterThanOrEqual(3);
  });

  it('outlines the platform safe area when asked', () => {
    const r = recorder();
    drawTextScene(r.ctx, layout('line_by_line').scene, 3, { safeArea: SAFE_AREAS['16:9'] });
    const box = r.calls.find((c) => c.op === 'strokeRect');
    expect(box?.args[0]).toBeCloseTo(SAFE_AREAS['16:9'].left * 1920, 3);
  });
});
