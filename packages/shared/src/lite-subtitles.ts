import type { LiteAspect, LiteScene, LiteSubtitleSettings } from './lite';
import type { LiteNarrationTake, LiteTiming, LiteWord } from './lite-timing';
import type { Cue } from './subtitles';
import type { TextFont, TextPosition, TextStyle } from './types';

/**
 * Subtitles for Film Studio Lite, timed from the real narration audio: word timings from transcription
 * aligned to the script (`aligned`), the director's edits (`manual`), imported SRT/VTT (`imported`), or —
 * only when no alignment exists — spread across the measured speech and labelled `estimated`.
 */

export type CueTiming = 'aligned' | 'estimated' | 'manual' | 'imported';

export interface LiteCue extends Cue {
  sceneId: string;
  timing: CueTiming;
  /** Average word-timing confidence (aligned cues). */
  confidence: number | null;
}

/** Characters per line that stay readable at the default size, per format. */
export const SUBTITLE_LINE_CHARS: Record<LiteAspect, number> = { '16:9': 42, '1:1': 32, '9:16': 26 };
/** Bottom safe margin per format (fraction of frame height): clear of player controls and platform UI. */
export const SUBTITLE_SAFE_BOTTOM: Record<LiteAspect, number> = { '16:9': 0.07, '1:1': 0.09, '9:16': 0.17 };

const MIN_CUE = 1.0;
const MAX_CUE = 6.5;
const GAP = 0.084;

/** Balanced line breaks (two lines of similar length, preferring a break before a conjunction or after punctuation). */
export function wrapCue(text: string, maxChars: number, maxLines: 1 | 2): string {
  const words = text.trim().split(/\s+/);
  if (maxLines === 1 || text.length <= maxChars) return words.join(' ');
  let best = -1;
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    if (a.length > maxChars + 4 || b.length > maxChars + 4) continue;
    const prev = words[i - 1]!;
    const next = words[i]!.toLowerCase();
    const score = Math.abs(a.length - b.length) - (/[,;:—–]$/.test(prev) ? 8 : 0) - (/^(and|but|or|so|when|that|who|which|with|to|for|because|while|as)$/.test(next) ? 4 : 0) + (b.length > a.length ? 2 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return words.join(' ');
  return `${words.slice(0, best).join(' ')}\n${words.slice(best).join(' ')}`;
}

/** Groups timed words into readable cues: breaks at sentence ends, long pauses and the line budget. */
export function cuesFromWords(words: LiteWord[], opts: { maxChars: number; maxLines: 1 | 2; offset: number; sceneId: string; timing: CueTiming }): LiteCue[] {
  const budget = opts.maxChars * opts.maxLines;
  const groups: LiteWord[][] = [];
  let cur: LiteWord[] = [];
  const len = (ws: LiteWord[]) => ws.reduce((s, w) => s + w.text.length + 1, -1);
  words.forEach((w, i) => {
    const next = words[i + 1];
    if (cur.length && len([...cur, w]) > budget) {
      // Over budget: break after the last comma in the cue when there is one (never strand a clause's tail).
      let at = -1;
      for (let k = cur.length - 2; k >= 1; k--) {
        if (/[,;:—–]$/.test(cur[k]!.text)) {
          at = k;
          break;
        }
      }
      if (at > 0) {
        groups.push(cur.slice(0, at + 1));
        cur = cur.slice(at + 1);
      } else {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(w);
    const pause = next ? next.start - w.end : 0;
    const span = w.end - cur[0]!.start;
    const softBreak = /[,;:—–]$/.test(w.text) && len(cur) > budget * 0.55;
    if (!next || w.sentenceEnd || /[.!?…]["”’)]?$/.test(w.text) || pause >= 0.7 || span >= MAX_CUE || softBreak) {
      groups.push(cur);
      cur = [];
    }
  });
  if (cur.length) groups.push(cur);
  // Fragments (one or two words, or under a second on screen) join a neighbour when the result still fits.
  const dur = (g: LiteWord[]) => g[g.length - 1]!.end - g[0]!.start;
  const merged: LiteWord[][] = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    const small = g.length <= 2 || dur(g) < MIN_CUE;
    if (prev && small && len([...prev, ...g]) <= budget + 6 && g[0]!.start - prev[prev.length - 1]!.end < 0.6) merged[merged.length - 1] = [...prev, ...g];
    else merged.push(g);
  }
  for (let k = 0; k < merged.length - 1; k++) {
    const g = merged[k]!;
    const next = merged[k + 1]!;
    if (dur(g) < MIN_CUE - 0.25 && len([...g, ...next]) <= budget + 6 && next[0]!.start - g[g.length - 1]!.end < 0.6) {
      merged.splice(k, 2, [...g, ...next]);
      k--;
    }
  }
  const cues: LiteCue[] = merged.map((g) => ({
    sceneId: opts.sceneId,
    start: g[0]!.start + opts.offset,
    end: g[g.length - 1]!.end + opts.offset + 0.25,
    text: wrapCue(g.map((w) => w.text).join(' '), opts.maxChars, opts.maxLines),
    timing: opts.timing,
    confidence: opts.timing === 'aligned' ? Math.round((g.reduce((s, w) => s + w.confidence, 0) / g.length) * 100) / 100 : null,
  }));
  // Minimum duration, no overlaps, a small gap between cues.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    const next = cues[i + 1];
    if (c.end - c.start < MIN_CUE) c.end = c.start + MIN_CUE;
    if (next && c.end > next.start - GAP) c.end = Math.max(c.start + 0.3, next.start - GAP);
    c.start = Math.round(c.start * 1000) / 1000;
    c.end = Math.round(c.end * 1000) / 1000;
  }
  return cues;
}

/** Spreads the script's words across the measured speech in proportion to their length (estimate only). */
export function estimatedWords(text: string, speechStart: number, speechEnd: number): LiteWord[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const weights = tokens.map((t) => t.length + 2 + (/[.!?…]$/.test(t) ? 6 : /[,;:]$/.test(t) ? 3 : 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const span = Math.max(0.1, speechEnd - speechStart);
  let acc = 0;
  return tokens.map((text, i) => {
    const start = speechStart + (acc / total) * span;
    acc += weights[i]!;
    return { text, start, end: speechStart + (acc / total) * span - (/[.!?,;:]$/.test(text) ? Math.min(0.25, span / tokens.length / 2) : 0), confidence: 0, sentenceEnd: /[.!?…]$/.test(text) };
  });
}

/** Every subtitle cue of the film for one format, on the film timeline. */
export function buildLiteCues(scenes: LiteScene[], timing: LiteTiming, takes: Record<string, LiteNarrationTake | null | undefined>, settings: Pick<LiteSubtitleSettings, 'maxLines'>, aspect: LiteAspect): LiteCue[] {
  const maxChars = SUBTITLE_LINE_CHARS[aspect];
  const out: LiteCue[] = [];
  for (const st of timing.scenes) {
    const scene = scenes[st.index]!;
    if (!scene.subtitles || st.voiceAt === null) continue;
    const take = takes[scene.id] ?? null;
    // Timeline time of asset time 0 for this scene's narration clip.
    const offset = take ? st.voiceAt - take.speechStart : st.voiceAt;
    if (scene.subtitleOverrides?.length) {
      for (const o of scene.subtitleOverrides) out.push({ sceneId: scene.id, start: st.voiceAt + o.start, end: st.voiceAt + o.end, text: wrapCue(o.text, maxChars, settings.maxLines), timing: o.source, confidence: null });
      continue;
    }
    if (take && take.alignment === 'aligned' && take.words.length) {
      out.push(...cuesFromWords(take.words, { maxChars, maxLines: settings.maxLines, offset, sceneId: scene.id, timing: 'aligned' }));
    } else if (scene.narration.trim()) {
      const words = take ? estimatedWords(scene.narration, take.speechStart, take.speechEnd) : estimatedWords(scene.narration, 0, st.speechSec);
      out.push(...cuesFromWords(words, { maxChars, maxLines: settings.maxLines, offset, sceneId: scene.id, timing: 'estimated' }));
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Converts imported cues (film time) into per-scene overrides relative to each scene's first word. */
export function importCuesToScenes(cues: Cue[], timing: LiteTiming): Record<string, { start: number; end: number; text: string; source: 'imported' }[]> {
  const out: Record<string, { start: number; end: number; text: string; source: 'imported' }[]> = {};
  for (const c of cues) {
    const st = timing.scenes.find((s) => c.start >= s.blackStart - 0.05 && c.start < s.start + s.duration) ?? timing.scenes[timing.scenes.length - 1];
    if (!st || st.voiceAt === null) continue;
    (out[st.sceneId] ??= []).push({ start: Math.round((c.start - st.voiceAt) * 1000) / 1000, end: Math.round((c.end - st.voiceAt) * 1000) / 1000, text: c.text.replace(/\n+/g, ' '), source: 'imported' });
  }
  return out;
}

export interface CueProblem {
  index: number;
  sceneId: string;
  kind: 'overlap' | 'too_fast' | 'too_short' | 'too_long' | 'uncertain';
  message: string;
}

/** Readability and timing problems in a cue list. */
export function cueProblems(cues: LiteCue[]): CueProblem[] {
  const out: CueProblem[] = [];
  cues.forEach((c, i) => {
    const d = c.end - c.start;
    const next = cues[i + 1];
    if (next && c.end > next.start + 0.001) out.push({ index: i, sceneId: c.sceneId, kind: 'overlap', message: `Subtitle “${c.text.slice(0, 40)}” overlaps the next one.` });
    const cps = c.text.replace(/\s+/g, '').length / Math.max(0.01, d);
    if (cps > 21) out.push({ index: i, sceneId: c.sceneId, kind: 'too_fast', message: `“${c.text.slice(0, 40)}” is on screen too briefly to read (${cps.toFixed(0)} characters per second).` });
    if (d < 0.7) out.push({ index: i, sceneId: c.sceneId, kind: 'too_short', message: `“${c.text.slice(0, 40)}” lasts only ${d.toFixed(2)} s.` });
    if (d > 8) out.push({ index: i, sceneId: c.sceneId, kind: 'too_long', message: `“${c.text.slice(0, 40)}” stays for ${d.toFixed(1)} s.` });
    if (c.timing === 'aligned' && c.confidence !== null && c.confidence < 0.55) out.push({ index: i, sceneId: c.sceneId, kind: 'uncertain', message: `Timing of “${c.text.slice(0, 40)}” is uncertain (low alignment confidence) — check it against the audio.` });
  });
  return out;
}

function vttTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1000))}.${pad(ms % 1000, 3)}`;
}

export function formatVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}\n`).join('\n')}`;
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

/** Highest code point each font is known to cover for Latin text (Kasem needs IPA letters such as ɛ ɔ ŋ and combining tone marks). */
function needsExtendedLatin(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    // Latin Extended-B, IPA extensions, combining diacritics, Latin Extended Additional.
    if ((c >= 0x180 && c <= 0x2af) || (c >= 0x300 && c <= 0x36f) || (c >= 0x1e00 && c <= 0x1eff)) return true;
  }
  return false;
}

/** Fonts in the renderer image whose coverage is known to include the text (Noto Sans and DejaVu Sans cover extended Latin and IPA). */
export function fontSupports(font: TextFont, text: string): boolean {
  if (font === 'Noto Sans' || font === 'DejaVu Sans') return true;
  return !needsExtendedLatin(text);
}

/** Caption style and position for the timeline (shared by preview and render). */
export function liteCaptionStyle(settings: LiteSubtitleSettings, aspect: LiteAspect, sample: string): { style: TextStyle; position: TextPosition; fontSubstituted: boolean } {
  const fontOk = fontSupports(settings.font, sample);
  const font: TextFont = fontOk ? settings.font : 'Noto Sans';
  const portrait = aspect === '9:16';
  const size = settings.sizePct * (portrait ? 0.82 : aspect === '1:1' ? 0.92 : 1);
  const style: TextStyle = {
    font,
    sizePct: Math.round(size * 100) / 100,
    color: settings.preset === 'minimal' ? '#F2F2EE' : '#FFFFFF',
    background: settings.contrast === 'box' ? '#000000' : null,
    bold: settings.preset === 'cinema' || settings.preset === 'boxed',
    italic: false,
    uppercase: false,
    outline: settings.contrast === 'outline' ? 2.2 : settings.contrast === 'shadow' ? 0.9 : 0,
    shadow: settings.contrast !== 'box',
    highlight: null,
  };
  return { style, position: { anchor: 'bottom', offset: Math.round((SUBTITLE_SAFE_BOTTOM[aspect] + settings.lift) * 1000) / 1000, align: 'center' }, fontSubstituted: !fontOk };
}
