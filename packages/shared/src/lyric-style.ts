import type { SectionLabel } from './types';
import type { Entrance, MeasureText, SceneBlock, SceneBox, SceneLine, SceneWord, TextAlign, TextPaint, TextScene, WordEffect } from './text-scene';

/**
 * Lyric Style Studio. A lyric style is a real rendering system: each preset lays out and animates
 * text differently (line-by-line, two-line subtitles, karaoke, active word, rolling credit,
 * typewriter, kinetic typography, …) from the same timing data. Styles have a global setting,
 * per-section overrides (verse, chorus, bridge…) and per-aspect-ratio positions; faces and platform
 * UI are avoided and the result is validated (cropping, safe areas, overlaps, diacritics).
 */

export const LYRIC_PRESETS = [
  'line_by_line',
  'two_line',
  'karaoke',
  'active_word',
  'rolling_credit',
  'typewriter',
  'kinetic',
  'large_centred',
  'lower_third',
  'call_response',
  'bouncing_ball',
  'vertical_captions',
  'dual_language',
  'minimal_cinematic',
  'poster',
  'environment',
  'full_chorus',
  'end_credit_scroll',
] as const;
export type LyricPreset = (typeof LYRIC_PRESETS)[number];

export const LYRIC_PRESET_LABELS: Record<LyricPreset, string> = {
  line_by_line: 'Line by line',
  two_line: 'Two-line subtitles',
  karaoke: 'Word-by-word karaoke',
  active_word: 'Active-word highlight',
  rolling_credit: 'Rolling credit',
  typewriter: 'Typewriter reveal',
  kinetic: 'Kinetic typography',
  large_centred: 'Large centred',
  lower_third: 'Lower third',
  call_response: 'Call and response',
  bouncing_ball: 'Bouncing-word sing-along',
  vertical_captions: 'Vertical (TikTok / Reels)',
  dual_language: 'Dual language',
  minimal_cinematic: 'Minimal cinematic',
  poster: 'Poster typography',
  environment: 'Integrated into the scene',
  full_chorus: 'Full-screen chorus',
  end_credit_scroll: 'End-credit scroll',
};

export const LYRIC_ASPECTS = ['16:9', '9:16', '1:1', '4:5'] as const;
export type LyricAspect = (typeof LYRIC_ASPECTS)[number];

export const ASPECT_SIZES: Record<LyricAspect, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
};

/** Platform-safe areas (fractions of the frame kept clear of UI chrome). */
export const SAFE_AREAS: Record<LyricAspect, { top: number; bottom: number; left: number; right: number }> = {
  '16:9': { top: 0.06, bottom: 0.08, left: 0.06, right: 0.06 },
  '9:16': { top: 0.12, bottom: 0.2, left: 0.07, right: 0.14 },
  '1:1': { top: 0.07, bottom: 0.09, left: 0.07, right: 0.07 },
  '4:5': { top: 0.08, bottom: 0.12, left: 0.07, right: 0.07 },
};

export interface AspectPlacement {
  x?: number;
  y?: number;
  fontSizePct?: number;
  align?: TextAlign;
  maxCharsPerLine?: number;
  /** Keep this position even when faces are detected behind it. */
  locked?: boolean;
}

export interface LyricStyle {
  preset: LyricPreset;
  fontFamily: string;
  fontWeight: number;
  /** Em size as a percentage of frame height. */
  fontSizePct: number;
  capitalisation: 'none' | 'upper' | 'lower' | 'title';
  italic: boolean;
  /** Extra space between letters (px at 1080 lines). */
  letterSpacing: number;
  /** Line height multiplier. */
  lineSpacing: number;
  maxCharsPerLine: number;
  maxLines: number;
  align: TextAlign;
  /** Anchor of the text block (0–1 of the frame). */
  x: number;
  y: number;
  activeColor: string;
  inactiveColor: string;
  outline: { width: number; color: string } | null;
  shadow: { x: number; y: number; blur: number; color: string; opacity: number } | null;
  glow: { radius: number; color: string; strength: number } | null;
  gradient: { from: string; to: string } | null;
  box: { color: string; opacity: number; padding: number; radius: number } | null;
  /** Blur the picture behind the text box (px at 1080 lines, 0 = off). */
  backgroundBlur: number;
  opacity: number;
  entrance: Entrance;
  exit: Entrance;
  wordAnimation: WordEffect;
  transitionMs: number;
  direction: 'ltr' | 'rtl';
  /** Extra margin inside the platform safe area (fraction of the frame). */
  safeMargin: number;
  /** Translation line colour and relative size (dual language). */
  translation: { color: string; sizeRatio: number };
  aspects: Partial<Record<LyricAspect, AspectPlacement>>;
}

const BASE: Omit<LyricStyle, 'preset'> = {
  fontFamily: 'Inter',
  fontWeight: 700,
  fontSizePct: 5.2,
  capitalisation: 'none',
  italic: false,
  letterSpacing: 0,
  lineSpacing: 1.25,
  maxCharsPerLine: 38,
  maxLines: 2,
  align: 'center',
  x: 0.5,
  y: 0.86,
  activeColor: '#F4B84A',
  inactiveColor: '#FFFFFF',
  outline: { width: 3, color: '#000000' },
  shadow: { x: 2, y: 3, blur: 4, color: '#000000', opacity: 0.55 },
  glow: null,
  gradient: null,
  box: null,
  backgroundBlur: 0,
  opacity: 1,
  entrance: 'fade',
  exit: 'fade',
  wordAnimation: 'none',
  transitionMs: 220,
  direction: 'ltr',
  safeMargin: 0,
  translation: { color: '#B9D2FF', sizeRatio: 0.72 },
  aspects: {},
};

/** Each preset is a distinct combination of layout, animation and look. */
export const LYRIC_PRESET_STYLES: Record<LyricPreset, LyricStyle> = {
  line_by_line: { ...BASE, preset: 'line_by_line' },
  two_line: { ...BASE, preset: 'two_line', fontWeight: 600, fontSizePct: 4.4, inactiveColor: '#C9D3E3', activeColor: '#FFFFFF', outline: { width: 2, color: '#000000' }, box: { color: '#000000', opacity: 0.55, padding: 16, radius: 10 }, maxLines: 2, y: 0.88, entrance: 'fade', exit: 'fade' },
  karaoke: { ...BASE, preset: 'karaoke', wordAnimation: 'sweep', activeColor: '#F4B84A', inactiveColor: '#FFFFFF', fontWeight: 800 },
  active_word: { ...BASE, preset: 'active_word', wordAnimation: 'highlight', activeColor: '#FF6B8A', inactiveColor: '#F2F4F8', fontWeight: 800, fontSizePct: 5.6 },
  rolling_credit: { ...BASE, preset: 'rolling_credit', fontWeight: 500, fontSizePct: 3.8, y: 0.5, activeColor: '#FFFFFF', inactiveColor: '#9FB0C8', outline: null, shadow: { x: 0, y: 2, blur: 6, color: '#000000', opacity: 0.7 }, entrance: 'none', exit: 'none', maxLines: 1, maxCharsPerLine: 60 },
  typewriter: { ...BASE, preset: 'typewriter', fontFamily: 'DejaVu Sans Mono', fontWeight: 400, fontSizePct: 4.2, wordAnimation: 'typewriter', align: 'left', x: 0.08, y: 0.82, entrance: 'none', outline: { width: 2, color: '#000000' }, letterSpacing: 1 },
  kinetic: { ...BASE, preset: 'kinetic', fontWeight: 900, fontSizePct: 7, capitalisation: 'upper', wordAnimation: 'pop', y: 0.5, maxCharsPerLine: 14, maxLines: 4, lineSpacing: 1.05, entrance: 'none', exit: 'fade', activeColor: '#FFFFFF', inactiveColor: '#FFFFFF', gradient: { from: '#FFFFFF', to: '#F4B84A' } },
  large_centred: { ...BASE, preset: 'large_centred', fontWeight: 800, fontSizePct: 8.5, y: 0.5, maxCharsPerLine: 20, maxLines: 3, lineSpacing: 1.1, entrance: 'scale', exit: 'fade' },
  lower_third: { ...BASE, preset: 'lower_third', fontWeight: 600, fontSizePct: 4.3, align: 'left', x: 0.07, y: 0.8, box: { color: '#0B1220', opacity: 0.72, padding: 18, radius: 4 }, outline: null, entrance: 'slide_left', exit: 'fade', maxCharsPerLine: 34 },
  call_response: { ...BASE, preset: 'call_response', fontWeight: 700, fontSizePct: 4.8, maxCharsPerLine: 26, activeColor: '#8AB6FF', inactiveColor: '#FFD166' },
  bouncing_ball: { ...BASE, preset: 'bouncing_ball', wordAnimation: 'highlight', activeColor: '#FFD166', inactiveColor: '#FFFFFF', fontWeight: 800, y: 0.84 },
  vertical_captions: { ...BASE, preset: 'vertical_captions', fontWeight: 900, fontSizePct: 4.6, capitalisation: 'upper', maxCharsPerLine: 16, maxLines: 2, y: 0.62, wordAnimation: 'pop', activeColor: '#FFE14D', inactiveColor: '#FFFFFF', outline: { width: 6, color: '#000000' }, entrance: 'scale', exit: 'none', transitionMs: 120 },
  dual_language: { ...BASE, preset: 'dual_language', fontWeight: 700, fontSizePct: 4.6, maxLines: 2, y: 0.84 },
  minimal_cinematic: { ...BASE, preset: 'minimal_cinematic', fontFamily: 'EB Garamond', fontWeight: 400, fontSizePct: 3.4, letterSpacing: 4, italic: true, outline: null, shadow: { x: 0, y: 1, blur: 8, color: '#000000', opacity: 0.8 }, opacity: 0.9, y: 0.9, entrance: 'fade', exit: 'fade', transitionMs: 600 },
  poster: { ...BASE, preset: 'poster', fontWeight: 900, fontSizePct: 9, capitalisation: 'upper', align: 'left', x: 0.08, y: 0.5, maxCharsPerLine: 10, maxLines: 4, lineSpacing: 0.98, outline: null, shadow: null, entrance: 'rise', exit: 'fade', activeColor: '#FFFFFF', inactiveColor: '#FFFFFF' },
  environment: { ...BASE, preset: 'environment', fontFamily: 'EB Garamond', fontWeight: 600, fontSizePct: 6, align: 'left', x: 0.1, y: 0.28, outline: null, shadow: { x: 0, y: 0, blur: 10, color: '#000000', opacity: 0.35 }, opacity: 0.78, entrance: 'blur', exit: 'blur', transitionMs: 500, maxCharsPerLine: 22, maxLines: 3 },
  full_chorus: { ...BASE, preset: 'full_chorus', fontWeight: 900, fontSizePct: 10, capitalisation: 'upper', y: 0.5, maxCharsPerLine: 16, maxLines: 3, lineSpacing: 1.02, glow: { radius: 18, color: '#F4B84A', strength: 0.6 }, entrance: 'scale', exit: 'fade' },
  end_credit_scroll: { ...BASE, preset: 'end_credit_scroll', fontWeight: 500, fontSizePct: 3.6, y: 0.5, outline: null, shadow: { x: 0, y: 2, blur: 4, color: '#000000', opacity: 0.6 }, entrance: 'none', exit: 'none', maxCharsPerLine: 60, maxLines: 1 },
};

export interface LyricStyleDoc {
  id: string;
  name: string;
  global: LyricStyle;
  /** Section overrides, e.g. chorus → full-screen chorus treatment. */
  sections: Partial<Record<SectionLabel, Partial<LyricStyle>>>;
  /** Uploaded fonts (licence confirmed by the owner). */
  fonts: { family: string; assetId: string; licenceConfirmed: boolean }[];
  updatedAt?: unknown;
}

export function defaultLyricStyleDoc(preset: LyricPreset = 'karaoke'): Omit<LyricStyleDoc, 'id'> {
  return { name: LYRIC_PRESET_LABELS[preset], global: { ...LYRIC_PRESET_STYLES[preset] }, sections: {}, fonts: [] };
}

/** The style for one line: global → section override → aspect-ratio placement. */
export function resolveLyricStyle(doc: Pick<LyricStyleDoc, 'global' | 'sections'>, section: SectionLabel | null, aspect: LyricAspect): LyricStyle {
  const over = section ? doc.sections[section] : undefined;
  let s: LyricStyle = { ...doc.global };
  if (over) {
    // A section may switch preset: start from that preset's defaults, then apply its own settings.
    if (over.preset && over.preset !== s.preset) s = { ...LYRIC_PRESET_STYLES[over.preset], aspects: s.aspects };
    s = { ...s, ...over, aspects: { ...s.aspects, ...(over.aspects ?? {}) } } as LyricStyle;
  }
  const a = s.aspects[aspect];
  if (a) s = { ...s, ...(a.x !== undefined ? { x: a.x } : {}), ...(a.y !== undefined ? { y: a.y } : {}), ...(a.fontSizePct !== undefined ? { fontSizePct: a.fontSizePct } : {}), ...(a.align ? { align: a.align } : {}), ...(a.maxCharsPerLine ? { maxCharsPerLine: a.maxCharsPerLine } : {}) };
  // Vertical frames get a narrower column automatically unless placed by hand.
  if (aspect === '9:16' && !a?.maxCharsPerLine) s = { ...s, maxCharsPerLine: Math.min(s.maxCharsPerLine, s.preset === 'vertical_captions' ? 16 : 22) };
  return s;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface LyricInputLine {
  id: string;
  text: string;
  /** Absolute seconds on the output timeline. */
  start: number;
  end: number;
  section: SectionLabel | null;
  words: { text: string; start: number; end: number }[] | null;
  translation: string | null;
  /** Singer / part for call-and-response ("call" | "response" or a name). */
  part?: string | null;
  /** Detected faces/objects/text to avoid during this line (0–1 boxes). */
  avoid?: { x: number; y: number; w: number; h: number }[];
}

export interface LyricLayoutInput {
  lines: LyricInputLine[];
  doc: Pick<LyricStyleDoc, 'global' | 'sections'>;
  aspect: LyricAspect;
  width: number;
  height: number;
  measure: MeasureText;
  /** Output frame rate: event times snap to whole frames. */
  fps?: number;
  /** When end-credit scroll is used, the window it scrolls over (defaults to the song span). */
  scrollWindow?: { start: number; end: number } | null;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function capitalise(text: string, mode: LyricStyle['capitalisation']): string {
  if (mode === 'upper') return text.toLocaleUpperCase();
  if (mode === 'lower') return text.toLocaleLowerCase();
  if (mode === 'title') return text.replace(/(^|\s)(\p{Ll})/gu, (_m, a: string, b: string) => a + b.toLocaleUpperCase());
  return text;
}

const snap = (t: number, fps?: number) => (fps ? Math.round(t * fps) / fps : Math.round(t * 1000) / 1000);

function paintFor(s: LyricStyle, sizePx: number, scaleRef: number): TextPaint {
  const k = scaleRef / 1080;
  return {
    fontFamily: s.fontFamily,
    fontWeight: s.fontWeight,
    italic: s.italic,
    sizePx,
    letterSpacingPx: s.letterSpacing * k,
    color: s.activeColor,
    inactiveColor: s.inactiveColor,
    opacity: s.opacity,
    outline: s.outline ? { width: s.outline.width * k, color: s.outline.color } : null,
    shadow: s.shadow ? { ...s.shadow, x: s.shadow.x * k, y: s.shadow.y * k, blur: s.shadow.blur * k } : null,
    glow: s.glow ? { ...s.glow, radius: s.glow.radius * k } : null,
    gradient: s.gradient,
  };
}

interface WordTiming {
  text: string;
  start: number | null;
  end: number | null;
}

/** Splits words into rows that fit `maxWidth` and `maxChars`; shrinks the font when a row cannot fit. */
function wrapWords(words: WordTiming[], paint: TextPaint, measure: MeasureText, maxWidth: number, maxChars: number, maxLines: number): { rows: WordTiming[][]; sizePx: number; shrunk: boolean } {
  let size = paint.sizePx;
  const minSize = paint.sizePx * 0.55;
  for (;;) {
    const font = { family: paint.fontFamily, weight: paint.fontWeight, italic: paint.italic, sizePx: size, letterSpacingPx: paint.letterSpacingPx };
    const space = measure(' ', font).width || size * 0.28;
    const rows: WordTiming[][] = [];
    let row: WordTiming[] = [];
    let rowW = 0;
    let rowChars = 0;
    let tooWide = false;
    for (const w of words) {
      const ww = measure(w.text, font).width;
      if (ww > maxWidth) tooWide = true;
      const nextW = row.length ? rowW + space + ww : ww;
      const nextChars = rowChars + (row.length ? 1 : 0) + [...w.text].length;
      if (row.length && (nextW > maxWidth || nextChars > maxChars)) {
        rows.push(row);
        row = [w];
        rowW = ww;
        rowChars = [...w.text].length;
      } else {
        row.push(w);
        rowW = nextW;
        rowChars = nextChars;
      }
    }
    if (row.length) rows.push(row);
    if ((!tooWide && rows.length <= maxLines) || size <= minSize) return { rows, sizePx: size, shrunk: size < paint.sizePx };
    size = Math.max(minSize, size * 0.92);
  }
}

/** Distributes line timing over words when no word timing exists (proportional to length). */
function timedWords(line: LyricInputLine, text: string): WordTiming[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (line.words && line.words.length === tokens.length) return tokens.map((t, i) => ({ text: t, start: line.words![i]!.start, end: line.words![i]!.end }));
  const total = tokens.reduce((s, t) => s + [...t].length + 1, 0);
  let t = line.start;
  const span = Math.max(0.1, line.end - line.start) * 0.92;
  return tokens.map((tok) => {
    const d = (span * ([...tok].length + 1)) / total;
    const w = { text: tok, start: t, end: t + d };
    t += d;
    return w;
  });
}

export interface LayoutIssue {
  lineId: string;
  kind: 'cropped' | 'outside_safe_area' | 'covers_face' | 'overlaps_next' | 'animation_too_long' | 'diacritics_clipped' | 'shrunk' | 'unreadable_size';
  message: string;
}

export interface LyricLayout {
  scene: TextScene;
  issues: LayoutIssue[];
  /** Final position chosen per line (after face avoidance), 0–1. */
  positions: Record<string, { x: number; y: number; moved: boolean }>;
}

function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Lays out every lyric line for one aspect ratio with its resolved style. */
export function layoutLyrics(input: LyricLayoutInput): LyricLayout {
  const W = input.width;
  const H = input.height;
  const safe = SAFE_AREAS[input.aspect];
  const blocks: SceneBlock[] = [];
  const issues: LayoutIssue[] = [];
  const positions: LyricLayout['positions'] = {};
  const lines = [...input.lines].filter((l) => l.text.trim() && l.end > l.start).sort((a, b) => a.start - b.start);
  const scaleRef = Math.min(W, H) === W && H > W ? W * (16 / 9) * 0.5625 : H;

  // Two-line subtitles pair consecutive lines of the same section.
  const consumed = new Set<string>();
  let blockIndex = 0;
  const pushIssue = (lineId: string, kind: LayoutIssue['kind'], message: string) => issues.push({ lineId, kind, message });

  // End-credit scroll: one continuous scroll of every line, not synced per line.
  const style0 = (l: LyricInputLine) => resolveLyricStyle(input.doc, l.section, input.aspect);
  const scrollLines = lines.filter((l) => style0(l).preset === 'end_credit_scroll');
  if (scrollLines.length) {
    const s = style0(scrollLines[0]!);
    const sizePx = (s.fontSizePct / 100) * scaleRef;
    const paint = paintFor(s, sizePx, scaleRef);
    const lh = sizePx * s.lineSpacing * 1.3;
    const win = input.scrollWindow ?? { start: scrollLines[0]!.start, end: scrollLines[scrollLines.length - 1]!.end };
    const travel = H + lh * scrollLines.length;
    const dur = Math.max(1, win.end - win.start);
    const rows: SceneLine[] = scrollLines.map((l, i) => {
      const text = capitalise(l.text, s.capitalisation);
      const m = input.measure(text, { family: paint.fontFamily, weight: paint.fontWeight, italic: paint.italic, sizePx, letterSpacingPx: paint.letterSpacingPx });
      const x = (W - m.width) / 2;
      const y = H + lh * (i + 1);
      return { words: [{ text, x, y, width: m.width, start: null, end: null, scale: 1 }], y, x, width: m.width, ascent: m.ascent, descent: m.descent, paint, start: null, end: null };
    });
    blocks.push({ id: `scroll${blockIndex++}`, refs: scrollLines.map((l) => l.id), start: snap(win.start, input.fps), end: snap(win.end, input.fps), lines: rows, box: null, blur: null, entrance: 'none', exit: 'none', transitionSec: 0, effect: 'none', wordPop: false, motion: { dx: 0, dy: -travel }, rotation: null, ball: null, dim: null, layer: 2, bounds: { x: 0, y: H, w: W, h: lh * scrollLines.length } });
    for (const l of scrollLines) consumed.add(l.id);
    if (travel / dur > H / 4) pushIssue(scrollLines[0]!.id, 'unreadable_size', `The end-credit scroll moves ${Math.round(travel / dur)} px/s — slow it down (give it more time) so it can be read.`);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (consumed.has(line.id)) continue;
    const s = style0(line);
    const partner = s.preset === 'two_line' ? lines[i + 1] : undefined;
    const group = partner && partner.section === line.section && !consumed.has(partner.id) && partner.start - line.end < 1.5 ? [line, partner] : [line];
    for (const g of group) consumed.add(g.id);
    const next = lines.find((l, k) => k > i && !group.includes(l));
    const baseSize = (s.fontSizePct / 100) * scaleRef;
    const paint = paintFor(s, baseSize, scaleRef);
    const marginX = (Math.max(safe.left, safe.right) + s.safeMargin) * W;
    const colWidth = s.preset === 'call_response' ? W * 0.42 : W - 2 * marginX;
    const maxWidth = Math.max(80, colWidth);
    const rowsOut: SceneLine[] = [];
    let shrunk = false;
    let textHeight = 0;
    const lh = (sz: number) => sz * s.lineSpacing;
    const lineTexts = group.map((g) => ({ g, text: capitalise(g.text, s.capitalisation) }));
    // Vertical captions show short phrase chunks that follow the vocal.
    if (s.preset === 'vertical_captions') {
      const words = timedWords(line, lineTexts[0]!.text);
      const chunks: WordTiming[][] = [];
      let cur: WordTiming[] = [];
      for (const w of words) {
        cur.push(w);
        const chars = cur.reduce((n, x) => n + [...x.text].length + 1, 0);
        if (cur.length >= 3 || chars > s.maxCharsPerLine) {
          chunks.push(cur);
          cur = [];
        }
      }
      if (cur.length) chunks.push(cur);
      chunks.forEach((chunk, ci) => {
        const start = ci === 0 ? line.start : chunk[0]!.start ?? line.start;
        const end = ci === chunks.length - 1 ? line.end : chunks[ci + 1]![0]!.start ?? line.end;
        const wrapped = wrapWords(chunk, paint, input.measure, maxWidth, s.maxCharsPerLine, s.maxLines);
        const b = buildBlock(`${line.id}_c${ci}`, [line.id], start, end, wrapped.rows, wrapped.sizePx, s, paint, input, maxWidth, line.avoid ?? [], blockIndex++);
        blocks.push(b.block);
        positions[line.id] ??= b.position;
        if (wrapped.shrunk) shrunk = true;
      });
      if (shrunk) pushIssue(line.id, 'shrunk', `“${line.text.slice(0, 40)}” was made smaller to fit the safe area.`);
      continue;
    }
    for (const { g, text } of lineTexts) {
      const words = timedWords(g, text);
      const wrapped = wrapWords(words, paint, input.measure, maxWidth, s.maxCharsPerLine, group.length > 1 ? 1 : s.maxLines);
      if (wrapped.shrunk) shrunk = true;
      const rowPaint = { ...paint, sizePx: wrapped.sizePx };
      for (const row of wrapped.rows) {
        rowsOut.push(rowLine(row, rowPaint, input.measure, g.id === line.id || group.length === 1 ? null : { start: g.start, end: g.end }, s));
        textHeight += lh(wrapped.sizePx);
      }
      if (s.preset === 'dual_language' && g.translation) {
        const tPaint = { ...paint, sizePx: paint.sizePx * s.translation.sizeRatio, color: s.translation.color, inactiveColor: s.translation.color };
        const tw = wrapWords(g.translation.split(/\s+/).filter(Boolean).map((w) => ({ text: w, start: null, end: null })), tPaint, input.measure, maxWidth, s.maxCharsPerLine + 8, 2);
        for (const row of tw.rows) {
          rowsOut.push(rowLine(row, { ...tPaint, sizePx: tw.sizePx }, input.measure, null, s, true));
          textHeight += lh(tw.sizePx);
        }
      }
    }
    if (shrunk) pushIssue(line.id, 'shrunk', `“${line.text.slice(0, 40)}” was made smaller to fit the safe area.`);
    // Poster typography: the longest words are set larger.
    if (s.preset === 'poster') {
      for (const r of rowsOut) {
        const longest = Math.max(...r.words.map((w) => [...w.text].length));
        for (const w of r.words) w.scale = [...w.text].length === longest && r.words.length > 1 ? 1.25 : 1;
      }
    }
    const start = group[0]!.start;
    const end = group[group.length - 1]!.end;
    const assembled = assemble(`${line.id}`, group.map((g) => g.id), start, end, rowsOut, s, input, i, line.avoid ?? [], blockIndex++);
    blocks.push(assembled.block);
    positions[line.id] = assembled.position;
    if (assembled.coversFace) pushIssue(line.id, 'covers_face', `“${line.text.slice(0, 40)}” covers a face; move it or unlock automatic placement.`);
    const bb = assembled.block.bounds;
    if (bb.x < -1 || bb.y < -1 || bb.x + bb.w > W + 1 || bb.y + bb.h > H + 1) pushIssue(line.id, 'cropped', `“${line.text.slice(0, 40)}” runs outside the frame.`);
    else if (bb.x < safe.left * W - 1 || bb.x + bb.w > (1 - safe.right) * W + 1 || bb.y < safe.top * H - 1 || bb.y + bb.h > (1 - safe.bottom) * H + 1) {
      if (s.preset !== 'rolling_credit' && s.preset !== 'environment') pushIssue(line.id, 'outside_safe_area', `“${line.text.slice(0, 40)}” is outside the ${input.aspect} safe area.`);
    }
    const trans = (s.entrance === 'none' ? 0 : s.transitionMs) + (s.exit === 'none' ? 0 : s.transitionMs);
    if (trans / 1000 > end - start) pushIssue(line.id, 'animation_too_long', `The entrance and exit animations are longer than “${line.text.slice(0, 30)}” is on screen.`);
    if (next && end > next.start + 0.02 && s.preset !== 'rolling_credit') pushIssue(line.id, 'overlaps_next', `“${line.text.slice(0, 30)}” is still on screen when the next line starts.`);
    for (const r of rowsOut) {
      const room = lh(r.paint.sizePx);
      if (r.ascent + r.descent > room * 1.02 && rowsOut.length > 1) pushIssue(line.id, 'diacritics_clipped', `Accents in “${line.text.slice(0, 30)}” need more line spacing (${(room / r.paint.sizePx).toFixed(2)} × is too tight).`);
    }
    if (r0(baseSize) < H * 0.022) pushIssue(line.id, 'unreadable_size', `Text is smaller than 2.2% of the frame height and hard to read on phones.`);
  }
  return { scene: { width: W, height: H, blocks: blocks.sort((a, b) => a.start - b.start) }, issues: dedupeIssues(issues), positions };

  function rowLine(row: WordTiming[], rp: TextPaint, measure: MeasureText, timing: { start: number; end: number } | null, st: LyricStyle, translation = false): SceneLine {
    const font = { family: rp.fontFamily, weight: rp.fontWeight, italic: rp.italic, sizePx: rp.sizePx, letterSpacingPx: rp.letterSpacingPx };
    const space = measure(' ', font).width || rp.sizePx * 0.28;
    let x = 0;
    let asc = 0;
    let desc = 0;
    const ordered = st.direction === 'rtl' ? [...row].reverse() : row;
    const words: SceneWord[] = ordered.map((w) => {
      const m = measure(w.text, font);
      asc = Math.max(asc, m.ascent);
      desc = Math.max(desc, m.descent);
      const sw: SceneWord = { text: w.text, x, y: 0, width: m.width, start: translation ? null : w.start, end: translation ? null : w.end, scale: 1 };
      x += m.width + space;
      return sw;
    });
    return { words, y: 0, x: 0, width: Math.max(0, x - space), ascent: asc, descent: desc, paint: rp, start: timing?.start ?? null, end: timing?.end ?? null, rtl: st.direction === 'rtl' };
  }
}

const r0 = (n: number) => Math.round(n);

function dedupeIssues(xs: LayoutIssue[]): LayoutIssue[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(`${x.lineId}:${x.kind}`) ? false : (seen.add(`${x.lineId}:${x.kind}`), true)));
}

/** Candidate anchor positions tried in order when the preferred one covers a face. */
const ALTERNATES: { x: number; y: number }[] = [
  { x: 0.5, y: 0.86 },
  { x: 0.5, y: 0.14 },
  { x: 0.5, y: 0.72 },
  { x: 0.28, y: 0.84 },
  { x: 0.72, y: 0.84 },
  { x: 0.5, y: 0.3 },
];

function assemble(id: string, refs: string[], start: number, end: number, rows: SceneLine[], s: LyricStyle, input: LyricLayoutInput, index: number, avoid: { x: number; y: number; w: number; h: number }[], layer: number): { block: SceneBlock; position: { x: number; y: number; moved: boolean }; coversFace: boolean } {
  return buildBlock(id, refs, start, end, null, 0, s, null, input, 0, avoid, layer, rows, index);
}

function buildBlock(
  id: string,
  refs: string[],
  start: number,
  end: number,
  wrappedRows: WordTiming[][] | null,
  sizePx: number,
  s: LyricStyle,
  paint: TextPaint | null,
  input: LyricLayoutInput,
  _maxWidth: number,
  avoid: { x: number; y: number; w: number; h: number }[],
  layer: number,
  preRows?: SceneLine[],
  lineIndex = 0,
): { block: SceneBlock; position: { x: number; y: number; moved: boolean }; coversFace: boolean } {
  const W = input.width;
  const H = input.height;
  const safe = SAFE_AREAS[input.aspect];
  let rows: SceneLine[] = preRows ?? [];
  if (wrappedRows && paint) {
    const rp = { ...paint, sizePx };
    const font = { family: rp.fontFamily, weight: rp.fontWeight, italic: rp.italic, sizePx: rp.sizePx, letterSpacingPx: rp.letterSpacingPx };
    const space = input.measure(' ', font).width || sizePx * 0.28;
    rows = wrappedRows.map((row) => {
      let x = 0;
      let asc = 0;
      let desc = 0;
      const words = row.map((w) => {
        const m = input.measure(w.text, font);
        asc = Math.max(asc, m.ascent);
        desc = Math.max(desc, m.descent);
        const sw: SceneWord = { text: w.text, x, y: 0, width: m.width, start: w.start, end: w.end, scale: 1 };
        x += m.width + space;
        return sw;
      });
      return { words, y: 0, x: 0, width: Math.max(0, x - space), ascent: asc, descent: desc, paint: rp, start: null, end: null };
    });
  }
  const heights = rows.map((r) => r.paint.sizePx * s.lineSpacing);
  const blockH = heights.reduce((a, c) => a + c, 0);
  const scaled = (r: SceneLine) => r.width * Math.max(1, ...r.words.map((w) => w.scale));
  const blockW = Math.max(0, ...rows.map(scaled));
  const pad = s.box ? s.box.padding * (Math.min(W, H) === W && H > W ? W / 1080 : H / 1080) : 0;
  // Call-and-response alternates sides by part (or by line parity).
  let anchor = { x: s.x, y: s.y };
  let align: TextAlign = s.align;
  if (s.preset === 'call_response') {
    const part = input.lines.find((l) => l.id === refs[0])?.part ?? null;
    const response = part ? /resp|b$|2$/i.test(part) : lineIndex % 2 === 1;
    anchor = { x: response ? 0.94 : 0.06, y: response ? 0.78 : 0.7 };
    align = response ? 'right' : 'left';
  }
  const placeAt = (ax: number, ay: number) => {
    let left = align === 'left' ? ax * W : align === 'right' ? ax * W - blockW : ax * W - blockW / 2;
    let top = ay * H - blockH / 2;
    // Keep inside the platform safe area (vertical frames keep clear of the UI on the right and bottom).
    const minL = (safe.left + s.safeMargin) * W + pad;
    const maxR = (1 - safe.right - s.safeMargin) * W - pad;
    const minT = (safe.top + s.safeMargin) * H + pad;
    const maxB = (1 - safe.bottom - s.safeMargin) * H - pad;
    if (s.preset !== 'environment') {
      left = Math.min(Math.max(left, minL), Math.max(minL, maxR - blockW));
      top = Math.min(Math.max(top, minT), Math.max(minT, maxB - blockH));
    }
    return { left, top };
  };
  const covers = (left: number, top: number) => avoid.some((a) => rectsOverlap({ x: (left - pad) / W, y: (top - pad) / H, w: (blockW + 2 * pad) / W, h: (blockH + 2 * pad) / H }, a));
  const locked = s.aspects[input.aspect]?.locked ?? false;
  let pos = placeAt(anchor.x, anchor.y);
  let moved = false;
  let coversFace = covers(pos.left, pos.top);
  if (coversFace && !locked && s.preset !== 'full_chorus' && s.preset !== 'rolling_credit') {
    for (const alt of ALTERNATES) {
      const p = placeAt(alt.x, alt.y);
      if (!covers(p.left, p.top)) {
        pos = p;
        anchor = alt;
        moved = true;
        coversFace = false;
        break;
      }
    }
  }
  // Final row positions.
  let y = pos.top;
  rows.forEach((r, k) => {
    const h = heights[k]!;
    const baseline = y + (h + r.ascent - r.descent) / 2;
    const rowW = scaled(r);
    const rowLeft = align === 'left' ? pos.left : align === 'right' ? pos.left + blockW - rowW : pos.left + (blockW - rowW) / 2;
    r.x = rowLeft;
    r.y = baseline;
    let wx = rowLeft;
    for (const w of r.words) {
      w.x = wx;
      w.y = baseline;
      wx += w.width * w.scale + (r.words.length > 1 ? (r.width - r.words.reduce((a, c) => a + c.width, 0)) / Math.max(1, r.words.length - 1) : 0);
    }
    y += h;
  });
  const box: SceneBox | null = s.box ? { x: pos.left - pad, y: pos.top - pad, w: blockW + 2 * pad, h: blockH + 2 * pad, color: s.box.color, opacity: s.box.opacity, radius: s.box.radius * (H / 1080) } : null;
  const effect: WordEffect = s.preset === 'karaoke' ? 'sweep' : s.preset === 'active_word' || s.preset === 'bouncing_ball' ? 'highlight' : s.preset === 'typewriter' ? 'typewriter' : s.preset === 'kinetic' || s.preset === 'vertical_captions' ? 'pop' : s.preset === 'two_line' ? 'instant' : s.wordAnimation;
  let motion: SceneBlock['motion'] = null;
  let bStart = start;
  let bEnd = end;
  if (s.preset === 'rolling_credit') {
    // Each line scrolls up through the frame and crosses the anchor exactly when it is sung.
    const travel = H * 0.6;
    const speed = travel / 6;
    const lead = (pos.top + blockH / 2 - H * 0.2) / speed;
    bStart = start - Math.max(0.5, lead * 0.5);
    bEnd = Math.max(end, bStart + 6);
    motion = { dx: 0, dy: -speed * (bEnd - bStart) };
  }
  const block: SceneBlock = {
    id,
    refs,
    start: snap(Math.max(0, bStart), input.fps),
    end: snap(bEnd, input.fps),
    lines: rows,
    box,
    blur: s.backgroundBlur > 0 && box ? { x: box.x, y: box.y, w: box.w, h: box.h, radius: s.backgroundBlur * (H / 1080) } : null,
    entrance: s.entrance,
    exit: s.exit,
    transitionSec: s.transitionMs / 1000,
    effect,
    wordPop: s.preset === 'kinetic' || s.preset === 'vertical_captions',
    motion,
    rotation: s.preset === 'environment' ? { z: -4, y: 18 } : null,
    ball: s.preset === 'bouncing_ball' ? { radius: Math.max(6, (rows[0]?.paint.sizePx ?? 40) * 0.16), color: s.activeColor, lift: (rows[0]?.paint.sizePx ?? 40) * 0.9 } : null,
    dim: s.preset === 'full_chorus' ? { color: '#000000', opacity: 0.42 } : null,
    layer,
    bounds: { x: pos.left - pad, y: pos.top - pad, w: blockW + 2 * pad, h: blockH + 2 * pad },
  };
  return { block, position: { x: anchor.x, y: anchor.y, moved }, coversFace };
}

/** Distinct visual signature of a preset (used by tests and the style picker). */
export function presetSignature(p: LyricPreset): string {
  const s = LYRIC_PRESET_STYLES[p];
  return [s.fontFamily, s.fontWeight, s.fontSizePct, s.capitalisation, s.align, s.x, s.y, s.wordAnimation, s.entrance, s.exit, Boolean(s.box), Boolean(s.glow), Boolean(s.gradient), s.italic, p].join('|');
}
