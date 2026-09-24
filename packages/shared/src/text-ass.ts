import type { SceneBlock, SceneLine, SceneWord, TextPaint, TextScene } from './text-scene';

/**
 * Converts a text scene into Advanced SubStation (ASS) events for libass. Every line is placed with
 * an explicit position (`\pos` / `\move`) and wrapping is disabled, so libass draws exactly the layout
 * AZ Studio measured. Event times are absolute timeline seconds; the renderer shifts frame timestamps
 * around its subtitles filter, so a segment that starts mid-event keeps every animation on time.
 */

export interface AssOptions {
  /** ASS font size for an em size in px: em × (winAscent + winDescent) / unitsPerEm of the font. */
  fontScale?: (family: string, weight: number) => number;
  /** Only events overlapping this window (absolute seconds) are written. */
  window?: { start: number; end: number };
}

export function assColour(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const rgb = m ? m[1]! : 'FFFFFF';
  return `&H${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}&`.toUpperCase();
}

export function assAlpha(opacity: number): string {
  const a = Math.round(255 * (1 - Math.max(0, Math.min(1, opacity))));
  return `&H${a.toString(16).padStart(2, '0').toUpperCase()}&`;
}

export function assClock(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

export function assText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, ' ');
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const ms = (s: number) => Math.max(0, Math.round(s * 1000));

/** Rounded rectangle as an ASS drawing path. */
export function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr < 0.5) return `m ${r1(x)} ${r1(y)} l ${r1(x + w)} ${r1(y)} ${r1(x + w)} ${r1(y + h)} ${r1(x)} ${r1(y + h)}`;
  const k = 0.5523 * rr;
  return [
    `m ${r1(x + rr)} ${r1(y)}`,
    `l ${r1(x + w - rr)} ${r1(y)}`,
    `b ${r1(x + w - rr + k)} ${r1(y)} ${r1(x + w)} ${r1(y + rr - k)} ${r1(x + w)} ${r1(y + rr)}`,
    `l ${r1(x + w)} ${r1(y + h - rr)}`,
    `b ${r1(x + w)} ${r1(y + h - rr + k)} ${r1(x + w - rr + k)} ${r1(y + h)} ${r1(x + w - rr)} ${r1(y + h)}`,
    `l ${r1(x + rr)} ${r1(y + h)}`,
    `b ${r1(x + rr - k)} ${r1(y + h)} ${r1(x)} ${r1(y + h - rr + k)} ${r1(x)} ${r1(y + h - rr)}`,
    `l ${r1(x)} ${r1(y + rr)}`,
    `b ${r1(x)} ${r1(y + rr - k)} ${r1(x + rr - k)} ${r1(y)} ${r1(x + rr)} ${r1(y)}`,
  ].join(' ');
}

function circle(cx: number, cy: number, r: number): string {
  return roundedRect(cx - r, cy - r, 2 * r, 2 * r, r);
}

function fontTags(p: TextPaint, fontScale: AssOptions['fontScale'], scale = 1): string {
  const size = p.sizePx * scale * (fontScale ? fontScale(p.fontFamily, p.fontWeight) : 1.2);
  const tags = [`\\fn${p.fontFamily}`, `\\fs${r1(size)}`, `\\b${p.fontWeight >= 600 ? 1 : 0}`, `\\i${p.italic ? 1 : 0}`];
  if (p.letterSpacingPx) tags.push(`\\fsp${r1(p.letterSpacingPx)}`);
  if (p.outline && p.outline.width > 0) tags.push(`\\bord${r1(p.outline.width)}`, `\\3c${assColour(p.outline.color)}`);
  else tags.push('\\bord0');
  if (p.shadow) tags.push(`\\xshad${r1(p.shadow.x)}`, `\\yshad${r1(p.shadow.y)}`, `\\4c${assColour(p.shadow.color)}`, `\\4a${assAlpha(p.shadow.opacity * p.opacity)}`);
  else tags.push('\\shad0');
  return tags.join('');
}

interface Ev {
  layer: number;
  start: number;
  end: number;
  text: string;
}

function entranceTags(b: SceneBlock, x: number, y: number, align: number): { pos: string; extra: string } {
  const dur = b.end - b.start;
  const t = ms(Math.min(b.transitionSec, dur / 2));
  const shift = Math.round(b.bounds.h * 0.35 + 10);
  const extra: string[] = [];
  let pos = `\\an${align}\\pos(${r1(x)},${r1(y)})`;
  if (b.motion) pos = `\\an${align}\\move(${r1(x)},${r1(y)},${r1(x + b.motion.dx)},${r1(y + b.motion.dy)})`;
  else if (b.entrance === 'rise') pos = `\\an${align}\\move(${r1(x)},${r1(y + shift)},${r1(x)},${r1(y)},0,${t})`;
  else if (b.entrance === 'drop') pos = `\\an${align}\\move(${r1(x)},${r1(y - shift)},${r1(x)},${r1(y)},0,${t})`;
  else if (b.entrance === 'slide_left') pos = `\\an${align}\\move(${r1(x + shift * 2)},${r1(y)},${r1(x)},${r1(y)},0,${t})`;
  else if (b.entrance === 'slide_right') pos = `\\an${align}\\move(${r1(x - shift * 2)},${r1(y)},${r1(x)},${r1(y)},0,${t})`;
  const fadeIn = b.entrance !== 'none' ? t : 0;
  const fadeOut = b.exit !== 'none' ? t : 0;
  if (fadeIn || fadeOut) extra.push(`\\fad(${fadeIn},${fadeOut})`);
  if (b.entrance === 'scale') extra.push(`\\fscx82\\fscy82\\t(0,${t},\\fscx100\\fscy100)`);
  if (b.entrance === 'blur') extra.push(`\\blur9\\t(0,${t},\\blur0)`);
  if (b.exit === 'blur') extra.push(`\\t(${Math.max(0, ms(dur) - t)},${ms(dur)},\\blur9)`);
  if (b.rotation) extra.push(`\\frz${b.rotation.z}\\fry${b.rotation.y}\\blur1.2`);
  return { pos, extra: extra.join('') };
}

function rowText(line: SceneLine): string {
  // libass applies the bidi algorithm itself, so right-to-left rows go in logical order.
  const words = line.rtl ? [...line.words].reverse() : line.words;
  return words.map((w) => w.text).join(' ');
}

/** Event text for a row with its per-word effect (times relative to the event start `t0`). */
function rowBody(b: SceneBlock, line: SceneLine, t0: number): string {
  const p = line.paint;
  const words = line.words;
  if (b.effect === 'sweep' && words.some((w) => w.start !== null)) {
    // \kf fills SecondaryColour → PrimaryColour as each word is sung.
    let cursor = t0;
    return words
      .map((w, i) => {
        const s = w.start ?? cursor;
        const e = Math.max(w.end ?? s + 0.2, s + 0.01);
        const gap = Math.round((s - cursor) * 100);
        cursor = e;
        return `${gap > 0 ? `{\\k${gap}}` : ''}{\\kf${Math.max(1, Math.round((e - s) * 100))}}${assText(w.text)}${i < words.length - 1 ? ' ' : ''}`;
      })
      .join('');
  }
  if (b.effect === 'highlight') {
    return words
      .map((w, i) => {
        const inactive = `\\1c${assColour(p.inactiveColor)}`;
        if (w.start === null || w.end === null) return `{${inactive}}${assText(w.text)}${i < words.length - 1 ? ' ' : ''}`;
        const a = ms(w.start - t0);
        const z = ms(Math.max(w.end, w.start + 0.08) - t0);
        return `{${inactive}\\t(${a},${a + 60},\\1c${assColour(p.color)}\\fscx110\\fscy110)\\t(${z},${z + 80},${inactive}\\fscx100\\fscy100)}${assText(w.text)}{\\fscx100\\fscy100}${i < words.length - 1 ? ' ' : ''}`;
      })
      .join('');
  }
  if (b.effect === 'typewriter') {
    const chars: { ch: string; at: number }[] = [];
    words.forEach((w, i) => {
      const s = w.start ?? t0;
      const e = Math.max(w.end ?? s + 0.3, s + 0.05);
      const cs = [...w.text];
      cs.forEach((ch, k) => chars.push({ ch, at: s + ((e - s) * k) / Math.max(1, cs.length) }));
      if (i < words.length - 1) chars.push({ ch: ' ', at: e });
    });
    return chars.map((c) => (c.ch === ' ' ? ' ' : `{\\alpha&HFF&\\t(${ms(c.at - t0)},${ms(c.at - t0) + 40},\\alpha${assAlpha(p.opacity)})}${assText(c.ch)}`)).join('');
  }
  if (b.effect === 'instant' && line.start !== null && line.end !== null) {
    const a = ms(line.start - t0);
    const z = ms(line.end - t0);
    return `{\\1c${assColour(p.inactiveColor)}\\t(${a},${a + 1},\\1c${assColour(p.color)})\\t(${z},${z + 1},\\1c${assColour(p.inactiveColor)})}${assText(rowText(line))}`;
  }
  return assText(rowText(line));
}

/** Builds all ASS events of a scene. Styles are inlined as override tags (one neutral style "L"). */
export function sceneEvents(scene: TextScene, opts: AssOptions = {}): string[] {
  const win = opts.window ?? { start: 0, end: Number.POSITIVE_INFINITY };
  const events: Ev[] = [];
  for (const b of scene.blocks) {
    if (b.end <= win.start || b.start >= win.end) continue;
    // Events keep absolute timeline times (override tags are relative to the event start); the renderer
    // shifts frame timestamps around the subtitles filter so a segment can start mid-event.
    const t0 = b.start;
    const push = (layer: number, text: string, start = b.start, end = b.end) => {
      if (Math.min(end, win.end) - Math.max(start, win.start) < 0.01) return;
      events.push({ layer, start, end, text });
    };
    const base = b.layer * 10;
    if (b.dim) push(base, `{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\1c${assColour(b.dim.color)}\\alpha${assAlpha(b.dim.opacity)}\\fad(${ms(b.transitionSec)},${ms(b.transitionSec)})}${roundedRect(0, 0, scene.width, scene.height, 0)}`);
    if (b.box) push(base + 1, `{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\1c${assColour(b.box.color)}\\alpha${assAlpha(b.box.opacity)}\\fad(${ms(b.transitionSec)},${ms(b.transitionSec)})}${roundedRect(b.box.x, b.box.y, b.box.w, b.box.h, b.box.radius)}`);
    if (b.effect === 'pop') {
      // Kinetic / vertical captions: every word is its own event that pops in as it is sung.
      for (const l of b.lines) {
        for (const w of l.words) {
          const s = Math.min(b.end - 0.05, Math.max(b.start, w.start ?? b.start));
          const cx = w.x + (w.width * w.scale) / 2;
          const inactive = assColour(l.paint.inactiveColor);
          const active = assColour(l.paint.color);
          const sung = w.end !== null ? `\\1c${active}\\t(${ms(Math.max(0, w.end - s))},${ms(Math.max(0, w.end - s)) + 80},\\1c${inactive})` : `\\1c${inactive}`;
          const pop = `\\fscx${Math.round(55 * w.scale)}\\fscy${Math.round(55 * w.scale)}\\t(0,90,\\fscx${Math.round(118 * w.scale)}\\fscy${Math.round(118 * w.scale)})\\t(90,190,\\fscx${Math.round(100 * w.scale)}\\fscy${Math.round(100 * w.scale)})`;
          push(base + 3, `{\\an5\\pos(${r1(cx)},${r1(w.y - (l.ascent - l.descent) / 2)})${fontTags(l.paint, opts.fontScale)}\\alpha${assAlpha(l.paint.opacity)}${sung}${pop}${b.exit !== 'none' ? `\\fad(0,${ms(b.transitionSec)})` : ''}}${assText(w.text)}`, s, b.end);
        }
      }
    } else {
      for (const l of b.lines) {
        const x = l.x;
        const y = l.y - (l.ascent - l.descent) / 2;
        const { pos, extra } = entranceTags(b, x, y, 4);
        const common = `${pos}${fontTags(l.paint, opts.fontScale)}\\q2${extra}`;
        const colours = b.effect === 'sweep' ? `\\1c${assColour(l.paint.color)}\\2c${assColour(l.paint.inactiveColor)}` : `\\1c${assColour(b.effect === 'highlight' || b.effect === 'instant' ? l.paint.inactiveColor : l.paint.inactiveColor)}`;
        if (l.paint.glow && l.paint.glow.strength > 0) {
          push(base + 2, `{${common}\\1a&HFF&\\bord${r1(l.paint.glow.radius)}\\3c${assColour(l.paint.glow.color)}\\3a${assAlpha(l.paint.glow.strength * l.paint.opacity)}\\blur${r1(l.paint.glow.radius * 0.6)}\\shad0}${assText(rowText(l))}`);
        }
        const opacity = `\\alpha${assAlpha(l.paint.opacity)}`;
        if (l.paint.gradient && (b.effect === 'none' || b.effect === 'instant')) {
          // Two-band vertical gradient: the top half in one colour, the bottom half in the other.
          const top = l.y - l.ascent;
          const mid = l.y - (l.ascent - l.descent) / 2;
          const bottom = l.y + l.descent;
          push(base + 3, `{${common}${opacity}\\1c${assColour(l.paint.gradient.from)}\\clip(0,${Math.floor(top - 20)},${scene.width},${Math.round(mid)})}${assText(rowText(l))}`);
          push(base + 3, `{${common}${opacity}\\1c${assColour(l.paint.gradient.to)}\\clip(0,${Math.round(mid)},${scene.width},${Math.ceil(bottom + 20)})}${assText(rowText(l))}`);
        } else {
          push(base + 3, `{${common}${opacity}${colours}}${rowBody(b, l, t0)}`);
        }
      }
    }
    if (b.ball) {
      // Bouncing ball: arcs from word to word, landing on each word as it is sung.
      const words = b.lines.flatMap((l) => l.words.map((w) => ({ w, top: w.y - l.ascent })));
      let prev: { x: number; y: number; t: number } | null = null;
      for (const { w, top } of words) {
        if (w.start === null) continue;
        const cx = w.x + w.width / 2;
        const cy = top - b.ball.radius * 1.6;
        const from = prev ?? { x: cx, y: cy, t: Math.max(b.start, w.start - 0.25) };
        const t1 = from.t;
        const t2 = w.start;
        const mid = (t1 + t2) / 2;
        const apexX = (from.x + cx) / 2;
        const apexY = Math.min(from.y, cy) - b.ball.lift;
        const ball = (x1: number, y1: number, x2: number, y2: number) => `{\\an7\\move(${r1(x1)},${r1(y1)},${r1(x2)},${r1(y2)})\\p1\\bord1\\3c&H000000&\\shad0\\1c${assColour(b.ball!.color)}}${circle(0, 0, b.ball!.radius)}`;
        if (t2 - t1 > 0.04) {
          push(base + 4, ball(from.x, from.y, apexX, apexY), t1, mid);
          push(base + 4, ball(apexX, apexY, cx, cy), mid, t2);
        }
        const hold = Math.max(t2 + 0.05, w.end ?? t2 + 0.2);
        push(base + 4, `{\\an7\\pos(${r1(cx)},${r1(cy)})\\p1\\bord1\\3c&H000000&\\shad0\\1c${assColour(b.ball.color)}}${circle(0, 0, b.ball.radius)}`, t2, hold);
        prev = { x: cx, y: cy, t: hold };
      }
    }
  }
  return events.sort((a, b) => a.start - b.start || a.layer - b.layer).map((e) => `Dialogue: ${e.layer},${assClock(Math.max(0, e.start))},${assClock(e.end)},L,,0,0,0,,${e.text}`);
}

/** A complete ASS script for a scene (used for lyric/credit layers and in tests). */
export function sceneToAss(scene: TextScene, opts: AssOptions = {}): string {
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${scene.width}`,
    `PlayResY: ${scene.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ASS_BASE_STYLE,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...sceneEvents(scene, opts),
    '',
  ].join('\n');
}

export const ASS_BASE_STYLE = 'Style: L,Inter,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,7,0,0,0,1';

export type { SceneWord };
