import type { LyricLine, SectionLabel } from './types';
import { alignWords, countSyllables, round3, stripBom, tokenize } from './text-align';

/**
 * Lyrics: drafts, uploads, transcription drafts and word-level synchronisation.
 *
 * Invariants
 *  - Line text is stored exactly as written by its author (spelling, diacritics, punctuation). Model
 *    output never replaces text the creator uploaded or approved — alignment only adds timing.
 *  - AI-written or AI-transcribed lyrics in languages AI handles poorly (e.g. Kasem) are marked as
 *    needing verification by a fluent speaker.
 */

export type LyricsSource = 'generated' | 'lyria' | 'transcribed' | 'uploaded' | 'manual';
export type WordFlag = 'aligned' | 'interpolated' | 'unaligned' | 'uncertain' | 'manual' | 'given';
export type LineFlag = 'low_confidence' | 'unaligned' | 'uncertain_words' | 'manual_timing' | 'adjusted' | 'given_timing' | 'no_vocal_match';

export interface LyricWord {
  text: string;
  start: number | null;
  end: number | null;
  /** 0–1: how sure AZ Studio is about this word's timing. */
  confidence: number;
  flag: WordFlag;
}

export interface LyricSheetLine {
  id: string;
  /** Exactly as written. */
  text: string;
  sectionId: string | null;
  start: number | null;
  end: number | null;
  words: LyricWord[];
  confidence: number;
  flags: LineFlag[];
}

export interface LyricSheetSection {
  id: string;
  label: SectionLabel;
  name: string;
}

export type TimingStatus = 'none' | 'approximate' | 'aligned' | 'manual' | 'needs_review';

export interface LyricsSheet {
  version: 1;
  source: LyricsSource;
  status: 'draft' | 'approved';
  approvedAt: number | null;
  /** BCP-47 code when known (Kasem: `xsm`). */
  language: string | null;
  languageName: string | null;
  requiresLanguageVerification: boolean;
  languageVerifiedAt: number | null;
  instrumental: boolean;
  sections: LyricSheetSection[];
  lines: LyricSheetLine[];
  timing: {
    status: TimingStatus;
    method: string | null;
    audioAssetId: string | null;
    alignedAt: number | null;
    lowConfidenceLineIds: string[];
    unalignedLineIds: string[];
    adjustments: number;
    notes: string[];
    /** Line anchors from the listening pass (by line id), reused when corrections are re-synchronised. */
    anchors?: { lineId: string; start: number; end: number; confidence: number }[];
  };
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

export interface LanguageOption {
  code: string;
  name: string;
}

/** Languages offered in the lyrics tools (any other BCP-47 code can be typed in). */
export const LYRIC_LANGUAGES: LanguageOption[] = [
  { code: 'en', name: 'English' },
  { code: 'xsm', name: 'Kasem' },
  { code: 'tw', name: 'Twi' },
  { code: 'ak', name: 'Akan (Fante)' },
  { code: 'gaa', name: 'Ga' },
  { code: 'ee', name: 'Ewe' },
  { code: 'dag', name: 'Dagbani' },
  { code: 'gur', name: 'Farefare (Gurenɛ)' },
  { code: 'dga', name: 'Dagaare' },
  { code: 'kus', name: 'Kusaal' },
  { code: 'bwu', name: 'Buli' },
  { code: 'sil', name: 'Sisaala' },
  { code: 'nzi', name: 'Nzema' },
  { code: 'ha', name: 'Hausa' },
  { code: 'yo', name: 'Yoruba' },
  { code: 'pcm', name: 'Nigerian Pidgin' },
  { code: 'sw', name: 'Swahili' },
  { code: 'fr', name: 'French' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'es', name: 'Spanish' },
];

/** Languages with strong support in current AI lyric writing and transcription. */
const WELL_SUPPORTED = new Set(['en', 'fr', 'es', 'pt', 'de', 'it', 'nl', 'ar', 'zh', 'ja', 'ko', 'hi', 'ru', 'tr', 'pl']);

export function languageName(code: string | null | undefined): string | null {
  if (!code) return null;
  const base = code.toLowerCase();
  return LYRIC_LANGUAGES.find((l) => l.code === base)?.name ?? code;
}

/** AI-written or AI-transcribed lyrics in these languages must be verified by a fluent speaker. */
export function needsLanguageVerification(code: string | null | undefined, source: LyricsSource): boolean {
  if (source === 'uploaded' || source === 'manual') return false;
  if (!code) return source !== 'transcribed';
  return !WELL_SUPPORTED.has(code.toLowerCase().split('-')[0]!);
}

export function isWellSupportedLanguage(code: string | null | undefined): boolean {
  return Boolean(code && WELL_SUPPORTED.has(code.toLowerCase().split('-')[0]!));
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type LyricsFormat = 'plain' | 'lrc' | 'srt' | 'vtt' | 'lyria';

export interface ParsedLyricLine {
  text: string;
  start: number | null;
  end: number | null;
  words: { text: string; start: number; end: number | null }[] | null;
  section: number | null;
}

export interface ParsedLyrics {
  format: LyricsFormat;
  lines: ParsedLyricLine[];
  sections: { label: SectionLabel; name: string; start: number | null; end: number | null }[];
  meta: { title?: string; artist?: string; bpm?: number; caption?: string; offsetSec?: number };
  problems: string[];
}

const LABEL_WORDS: [RegExp, SectionLabel][] = [
  [/^pre[\s-]?chorus/i, 'pre-chorus'],
  [/^post[\s-]?chorus/i, 'post-chorus'],
  [/^(chorus|refrain)/i, 'chorus'],
  [/^verse/i, 'verse'],
  [/^bridge/i, 'bridge'],
  [/^intro/i, 'intro'],
  [/^(outro|coda|ending)/i, 'outro'],
  [/^hook/i, 'hook'],
  [/^breakdown/i, 'breakdown'],
  [/^drop/i, 'drop'],
  [/^(instrumental|interlude|solo)/i, 'instrumental'],
];

/** Recognises a section header line such as `[Verse 1]`, `(Chorus)`, `Bridge:` or `## Outro`. */
export function sectionHeader(line: string): { label: SectionLabel; name: string } | null {
  const t = line.trim();
  const m = /^(?:\[([^\]]+)\]|\(([^)]+)\)|#{1,4}\s*(.+)|([A-Za-z][\w\s-]{1,24}):)$/.exec(t);
  const inner = (m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4] ?? '').trim();
  if (!inner) return null;
  const hit = LABEL_WORDS.find(([re]) => re.test(inner));
  if (!hit) return null;
  const name = inner.replace(/\s+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return { label: hit[1], name };
}

const LRC_TAG = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
const LRC_WORD = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;
const LYRIA_LINE = /^\[(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)\]\s*(.*)$/;
const LYRIA_STRUCT = /^\[(\d+):(\d{2})(?:\.\d+)?\s*[-–]\s*(\d+):(\d{2})(?:\.\d+)?\]\s*(.*)$/;
const TIMESTAMP = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

const lrcSeconds = (m: string, s: string) => Number(m) * 60 + Number(s.replace(':', '.'));

function vttSeconds(s: string): number | null {
  const m = TIMESTAMP.exec(s.trim());
  if (!m) return null;
  const [, h, min, sec, frac] = m;
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec) + Number(frac!.padEnd(3, '0')) / 1000;
}

export function detectLyricsFormat(text: string): LyricsFormat {
  const t = stripBom(text).trimStart();
  if (/^WEBVTT/.test(t)) return 'vtt';
  if (/\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->/.test(t)) return 'srt';
  if (/^\s*\[\d+\.\d+:\d+\.\d+\]/m.test(t)) return 'lyria';
  if (/^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(t)) return 'lrc';
  return 'plain';
}

function parseCues(text: string, vtt: boolean): ParsedLyrics {
  const blocks = stripBom(text).replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const lines: ParsedLyricLine[] = [];
  const problems: string[] = [];
  for (const block of blocks) {
    const rows = block.split('\n');
    const i = rows.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a = '', b = ''] = rows[i]!.split('-->');
    const start = vttSeconds(a);
    const end = vttSeconds(b.trim().split(/\s+/)[0] ?? '');
    const body = rows.slice(i + 1).join('\n').replace(/\s+$/, '');
    if (start === null || end === null) {
      problems.push(`Unreadable cue timing “${rows[i]!.trim()}”.`);
      continue;
    }
    if (end <= start) problems.push(`Cue at ${start.toFixed(2)} s ends before it starts.`);
    // WebVTT karaoke: <00:00:01.500> timestamps between words.
    let words: ParsedLyricLine['words'] = null;
    if (vtt && /<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/.test(body)) {
      words = [];
      let t = start;
      for (const part of body.split(/(<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>)/)) {
        const ts = /^<(.+)>$/.exec(part);
        if (ts) {
          t = vttSeconds(ts[1]!) ?? t;
          continue;
        }
        for (const w of part.replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean)) words.push({ text: w, start: t, end: null });
      }
    }
    const clean = body.replace(/<[^>]+>/g, '');
    if (clean.trim()) lines.push({ text: clean.trim(), start, end: Math.max(end, start), words, section: null });
  }
  return { format: vtt ? 'vtt' : 'srt', lines: lines.sort((x, y) => (x.start ?? 0) - (y.start ?? 0)), sections: [], meta: {}, problems };
}

/** Parses pasted or uploaded lyrics (plain text, .txt, .lrc, .srt, .vtt, or Lyria's timed text). */
export function parseLyricsText(input: string, format: LyricsFormat | 'auto' = 'auto'): ParsedLyrics {
  const text = stripBom(input).replace(/\r\n?/g, '\n');
  const fmt = format === 'auto' ? detectLyricsFormat(text) : format;
  if (fmt === 'srt' || fmt === 'vtt') return parseCues(text, fmt === 'vtt');
  const out: ParsedLyrics = { format: fmt, lines: [], sections: [], meta: {}, problems: [] };
  let section: number | null = null;
  const openSection = (label: SectionLabel, name: string, start: number | null = null, end: number | null = null) => {
    out.sections.push({ label, name, start, end });
    section = out.sections.length - 1;
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();
    if (!t) continue;
    if (fmt === 'lrc') {
      const meta = /^\[(ti|ar|al|by|offset|length|re|ve|au):\s*(.*)\]$/i.exec(t);
      if (meta) {
        const k = meta[1]!.toLowerCase();
        if (k === 'ti') out.meta.title = meta[2]!.trim();
        if (k === 'ar') out.meta.artist = meta[2]!.trim();
        if (k === 'offset') out.meta.offsetSec = Number(meta[2]) / 1000 || 0;
        continue;
      }
      const tags = [...t.matchAll(LRC_TAG)];
      if (tags.length) {
        const body = t.replace(LRC_TAG, '').trim();
        const header = sectionHeader(body);
        if (header) {
          openSection(header.label, header.name, lrcSeconds(tags[0]![1]!, tags[0]![2]!));
          continue;
        }
        if (!body) continue;
        let words: ParsedLyricLine['words'] = null;
        if (LRC_WORD.test(body)) {
          words = [];
          LRC_WORD.lastIndex = 0;
          let at = lrcSeconds(tags[0]![1]!, tags[0]![2]!);
          for (const part of body.split(/(<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>)/)) {
            const ts = /^<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>$/.exec(part);
            if (ts) {
              at = lrcSeconds(ts[1]!, ts[2]!);
              continue;
            }
            for (const w of part.split(/\s+/).filter(Boolean)) words.push({ text: w, start: at, end: null });
          }
        }
        const clean = body.replace(LRC_WORD, '').replace(/\s{2,}/g, ' ').trim();
        // A line may repeat at several times: [00:12.00][01:30.00]Chorus line
        for (const tag of tags) out.lines.push({ text: clean, start: lrcSeconds(tag[1]!, tag[2]!), end: null, words: tags.length === 1 ? words : null, section });
        continue;
      }
    }
    if (fmt === 'lyria') {
      const caption = /^caption:\s*(.*)$/i.exec(t);
      if (caption) {
        out.meta.caption = caption[1]!.trim();
        continue;
      }
      const bpm = /^bpm:\s*([\d.]+)/i.exec(t);
      if (bpm) {
        out.meta.bpm = Number(bpm[1]);
        continue;
      }
      if (/^[A-Za-z]{2,12}:\s*[\d.]+$/.test(t) || t === '---') continue; // other numeric metadata
      const st = LYRIA_STRUCT.exec(t);
      if (st) {
        const start = Number(st[1]) * 60 + Number(st[2]);
        const end = Number(st[3]) * 60 + Number(st[4]);
        const rest = st[5]!.trim();
        const header = sectionHeader(`[${rest.split(':')[0]}]`) ?? { label: 'other' as SectionLabel, name: rest.split(':')[0] || 'Section' };
        openSection(header.label, header.name, start, end);
        continue;
      }
      const ly = LYRIA_LINE.exec(t);
      if (ly) {
        const body = ly[3]!.trim();
        const header = sectionHeader(body);
        if (header) {
          openSection(header.label, header.name, Number(ly[1]), Number(ly[2]));
          continue;
        }
        if (body) out.lines.push({ text: body, start: Number(ly[1]), end: Number(ly[2]), words: null, section });
        continue;
      }
    }
    const header = sectionHeader(t);
    if (header) {
      openSection(header.label, header.name);
      continue;
    }
    out.lines.push({ text: t, start: null, end: null, words: null, section });
  }
  if (fmt === 'lrc') {
    const off = out.meta.offsetSec ?? 0;
    out.lines.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    out.lines.forEach((l, i) => {
      if (l.start !== null) l.start = Math.max(0, l.start + off);
      if (l.words) for (const w of l.words) w.start = Math.max(0, w.start + off);
      const next = out.lines[i + 1]?.start;
      l.end = l.start === null ? null : next !== null && next !== undefined ? Math.max(l.start + 0.1, next + off - 0.05) : l.start + 4;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

let lineCounter = 0;
export function lyricId(prefix = 'ln'): string {
  lineCounter = (lineCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${lineCounter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** Word list for a line (raw words exactly as written; punctuation-only tokens carry no timing). */
export function wordsOf(text: string): LyricWord[] {
  return tokenize(text).map((t) => ({ text: t.raw, start: null, end: null, confidence: 0, flag: 'unaligned' as WordFlag }));
}

export function emptyTiming(): LyricsSheet['timing'] {
  return { status: 'none', method: null, audioAssetId: null, alignedAt: null, lowConfidenceLineIds: [], unalignedLineIds: [], adjustments: 0, notes: [] };
}

export interface SheetOptions {
  source: LyricsSource;
  language?: string | null;
  status?: 'draft' | 'approved';
  instrumental?: boolean;
}

/** Builds a lyric sheet from parsed text, keeping every line's text exactly as parsed. */
export function sheetFromParsed(parsed: ParsedLyrics, opts: SheetOptions): LyricsSheet {
  const sections: LyricSheetSection[] = parsed.sections.map((s) => ({ id: lyricId('sec'), label: s.label, name: s.name }));
  const lines: LyricSheetLine[] = parsed.lines.map((l) => {
    const words = wordsOf(l.text);
    const timed = l.start !== null;
    if (l.words?.length) {
      // Word timing supplied by the file (enhanced LRC / WebVTT karaoke).
      const given = l.words;
      words.forEach((w, i) => {
        const g = given[i];
        if (!g) return;
        w.start = g.start;
        w.end = g.end ?? given[i + 1]?.start ?? l.end ?? g.start + 0.4;
        w.confidence = 0.8;
        w.flag = 'given';
      });
    } else if (timed && l.end !== null) {
      distribute(words, l.start!, l.end, 0.4, 'given');
    }
    return {
      id: lyricId(),
      text: l.text,
      sectionId: l.section !== null ? sections[l.section]?.id ?? null : null,
      start: l.start,
      end: l.end,
      words,
      confidence: timed ? 0.6 : 0,
      flags: timed ? (['given_timing'] as LineFlag[]) : [],
    };
  });
  const anyTimed = lines.some((l) => l.start !== null);
  const source = opts.source;
  // Text the creator uploads or types is their approved source of truth; model output starts as a draft.
  const status = opts.status ?? (source === 'uploaded' || source === 'manual' ? 'approved' : 'draft');
  return {
    version: 1,
    source,
    status,
    approvedAt: status === 'approved' ? Date.now() : null,
    language: opts.language ?? null,
    languageName: languageName(opts.language ?? null),
    requiresLanguageVerification: needsLanguageVerification(opts.language ?? null, source),
    languageVerifiedAt: null,
    instrumental: Boolean(opts.instrumental),
    sections,
    lines,
    timing: { ...emptyTiming(), status: anyTimed ? (source === 'lyria' ? 'approximate' : 'manual') : 'none', method: anyTimed ? (source === 'lyria' ? 'model_structure' : `file_${parsed.format}`) : null },
    updatedAt: Date.now(),
  };
}

/** Replaces the text of one line (e.g. a correction) and resets its word timing for re-alignment. */
export function editLineText(sheet: LyricsSheet, lineId: string, text: string): LyricsSheet {
  return {
    ...sheet,
    lines: sheet.lines.map((l) => (l.id === lineId ? { ...l, text, words: wordsOf(text), confidence: 0, flags: l.flags.filter((f) => f === 'manual_timing') } : l)),
    updatedAt: Date.now(),
  };
}

/** Plain lyric lines (the legacy `songs.lyrics` projection used by planning and captions). */
export function sheetToLyricLines(sheet: LyricsSheet): LyricLine[] {
  return sheet.lines.filter((l) => l.start !== null && l.end !== null && l.end > l.start).map((l) => ({ id: l.id, start: round3(l.start!), end: round3(l.end!), text: l.text }));
}

/** The whole text of a sheet (sections as `[Name]` headers). */
export function sheetText(sheet: LyricsSheet, withSections = true): string {
  const out: string[] = [];
  let current: string | null = null;
  for (const l of sheet.lines) {
    if (withSections && l.sectionId !== current) {
      current = l.sectionId;
      const s = sheet.sections.find((x) => x.id === l.sectionId);
      if (s) out.push(out.length ? `\n[${s.name}]` : `[${s.name}]`);
    }
    out.push(l.text);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Alignment (authoritative text → vocal timing)
// ---------------------------------------------------------------------------

export interface AsrWord {
  text: string;
  start: number;
  end: number;
}

export interface LineAnchor {
  lineIndex: number;
  start: number;
  end: number;
  confidence: number;
}

export interface AlignLyricsOptions {
  durationSec: number;
  /** Line-level anchors from a second opinion (e.g. a model listening for each exact line). */
  anchors?: LineAnchor[];
  /** Existing timing (LRC/SRT/VTT or manual) is validated and improved rather than discarded. */
  improveGiven?: boolean;
  audioAssetId?: string | null;
  method?: string;
}

export interface AlignStats {
  totalWords: number;
  matchedWords: number;
  coverage: number;
  lowConfidence: number;
  unaligned: number;
  adjusted: number;
}

/** Spreads words across [start, end] in proportion to their syllables. */
function distribute(words: LyricWord[], start: number, end: number, confidence: number, flag: WordFlag): void {
  if (!words.length) return;
  const weights = words.map((w) => Math.max(1, countSyllables(w.text)));
  const total = weights.reduce((s, w) => s + w, 0);
  const span = Math.max(0.05, end - start);
  let t = start;
  words.forEach((w, i) => {
    const d = (span * weights[i]!) / total;
    w.start = round3(t);
    w.end = round3(t + d);
    w.confidence = confidence;
    w.flag = flag;
    t += d;
  });
}

const MIN_LINE_CONFIDENCE = 0.6;

const isPinned = (l: LyricSheetLine) => l.flags.includes('manual_timing') && l.start !== null && l.end !== null;

/**
 * Aligns authoritative lyrics to transcribed vocals. Text is never changed; only timing is set.
 * Lines the vocals do not confidently match are flagged for review in the waveform editor.
 */
export function alignLyrics(sheet: LyricsSheet, asr: AsrWord[], opts: AlignLyricsOptions): { sheet: LyricsSheet; stats: AlignStats } {
  const D = Math.max(0, opts.durationSec);
  const lines: LyricSheetLine[] = sheet.lines.map((l) => ({ ...l, words: wordsOf(l.text).map((w, i) => ({ ...w, ...(l.flags.includes('manual_timing') && l.words[i] ? { start: l.words[i]!.start, end: l.words[i]!.end } : {}) })), flags: [...l.flags] }));
  const flat: { li: number; wi: number; norm: string }[] = [];
  lines.forEach((l, li) => tokenize(l.text).forEach((t, wi) => flat.push({ li, wi, norm: t.norm })));
  const asrClean = asr.filter((w) => tokenize(w.text).length).map((w) => ({ ...w, norm: tokenize(w.text)[0]!.norm }));
  const ops = alignWords(
    flat.map((f) => f.norm),
    asrClean.map((w) => w.norm),
    { freeDetectedEnds: true, matchThreshold: 0.7 },
  );
  let matched = 0;
  for (const op of ops) {
    if (op.op !== 'match' && op.op !== 'substitute') continue;
    if (op.op === 'substitute' && op.sim < 0.5) continue;
    const f = flat[op.e]!;
    const w = lines[f.li]!.words[f.wi]!;
    const a = asrClean[op.d]!;
    w.start = round3(a.start);
    w.end = round3(Math.max(a.end, a.start + 0.05));
    w.confidence = op.op === 'match' ? round3(0.55 + 0.45 * op.sim) : round3(0.35 + 0.3 * op.sim);
    w.flag = op.op === 'match' ? 'aligned' : 'uncertain';
    if (op.op === 'match') matched++;
  }
  const anchors = new Map((opts.anchors ?? []).map((a) => [a.lineIndex, a]));
  let adjusted = 0;

  lines.forEach((l, li) => {
    const original = sheet.lines[li]!;
    // Manually timed lines are pinned: their own word timing wins over the transcript.
    if (isPinned(original)) {
      const same = original.words.length === l.words.length && original.words.every((w, i) => w.text === l.words[i]!.text && w.start !== null && w.end !== null);
      if (same) l.words = original.words.map((w) => ({ ...w, flag: 'manual' as WordFlag, confidence: 0.95 }));
      else distribute(l.words, original.start!, original.end!, 0.9, 'manual');
      return;
    }
    const timed = l.words.filter((w) => w.start !== null);
    const lineConf = timed.length ? timed.reduce((s, w) => s + w.confidence, 0) / l.words.length : 0;
    const anchor = anchors.get(li);
    if ((!timed.length || lineConf < 0.35) && anchor && anchor.end > anchor.start) {
      distribute(l.words, anchor.start, anchor.end, round3(Math.min(0.75, anchor.confidence * 0.8)), 'interpolated');
      l.flags = [...l.flags.filter((f) => f !== 'no_vocal_match'), 'no_vocal_match'];
      return;
    }
    // Fill untimed words inside the line from their timed neighbours.
    for (let i = 0; i < l.words.length; i++) {
      if (l.words[i]!.start !== null) continue;
      let j = i;
      while (j < l.words.length && l.words[j]!.start === null) j++;
      const prevEnd = i > 0 ? l.words[i - 1]!.end : null;
      const nextStart = j < l.words.length ? l.words[j]!.start : null;
      if (prevEnd !== null || nextStart !== null) {
        const gapWords = l.words.slice(i, j);
        const est = gapWords.reduce((s, w) => s + Math.max(1, countSyllables(w.text)) * 0.28, 0);
        const s0 = prevEnd ?? Math.max(0, (nextStart ?? 0) - est);
        const s1 = nextStart ?? Math.min(D || s0 + est, s0 + est);
        distribute(gapWords, s0, Math.max(s0 + 0.05 * gapWords.length, s1), 0.3, 'interpolated');
      }
      i = j;
    }
  });

  // Lines with no timing at all: place them between neighbours (flagged).
  lines.forEach((l, li) => {
    if (l.words.every((w) => w.start !== null) || !l.words.length) return;
    const prev = [...lines.slice(0, li)].reverse().find((x) => x.words.some((w) => w.end !== null));
    const next = lines.slice(li + 1).find((x) => x.words.some((w) => w.start !== null));
    const s0 = prev ? Math.max(...prev.words.map((w) => w.end ?? 0)) + 0.1 : 0;
    const s1 = next ? Math.min(...next.words.filter((w) => w.start !== null).map((w) => w.start!)) - 0.1 : Math.min(D || s0 + 4, s0 + 4);
    distribute(l.words, s0, Math.max(s0 + 0.3, s1), 0.1, 'unaligned');
  });

  const lowIds: string[] = [];
  const unalignedIds: string[] = [];
  lines.forEach((l, li) => {
    const original = sheet.lines[li]!;
    if (isPinned(original)) {
      l.start = original.start;
      l.end = original.end;
      l.confidence = 0.95;
      return;
    }
    const ws = l.words.filter((w) => w.start !== null);
    let start = ws.length ? Math.min(...ws.map((w) => w.start!)) : original.start;
    let end = ws.length ? Math.max(...ws.map((w) => w.end ?? w.start!)) : original.end;
    const conf = l.words.length ? l.words.reduce((s, w) => s + w.confidence, 0) / l.words.length : 0;
    // Existing timing: keep it unless the vocals clearly place the line elsewhere.
    if (opts.improveGiven && original.flags.includes('given_timing') && original.start !== null && original.end !== null) {
      const delta = start === null ? 0 : Math.abs(start - original.start);
      if (conf >= 0.7 && delta > 0.25) {
        adjusted++;
        l.flags = [...l.flags.filter((f) => f !== 'given_timing'), 'adjusted'];
      } else {
        // Keep the supplied line timing; keep aligned word times only when they agree with it.
        const agrees = conf >= 0.5 && start !== null && Math.abs(start - original.start) <= 0.25;
        start = original.start;
        end = original.end;
        if (!agrees) distribute(l.words, start, end, Math.max(0.6, conf), 'given');
      }
    }
    l.start = start === null ? null : round3(Math.max(0, start));
    l.end = end === null ? null : round3(Math.min(D || end, Math.max(end, (start ?? 0) + 0.1)));
    l.confidence = round3(conf);
    const flags = new Set(l.flags.filter((f) => !['low_confidence', 'unaligned', 'uncertain_words'].includes(f)));
    if (l.words.some((w) => w.flag === 'uncertain')) flags.add('uncertain_words');
    if (conf < 0.25) {
      flags.add('unaligned');
      unalignedIds.push(l.id);
    } else if (conf < MIN_LINE_CONFIDENCE) {
      flags.add('low_confidence');
      lowIds.push(l.id);
    }
    l.flags = [...flags];
  });

  // Keep lines in order and non-overlapping.
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]!;
    const cur = lines[i]!;
    if (prev.start === null || cur.start === null || prev.end === null) continue;
    const prevPinned = isPinned(sheet.lines[i - 1]!);
    const curPinned = isPinned(sheet.lines[i]!);
    if (cur.start < prev.start && !curPinned) cur.start = round3(prev.start + 0.05);
    if (prev.end > cur.start) {
      if (!prevPinned) prev.end = round3(Math.max(prev.start + 0.1, cur.start - 0.02));
      else if (!curPinned) cur.start = round3(Math.min((cur.end ?? prev.end) - 0.1, prev.end + 0.02));
    }
  }

  const totalWords = flat.length;
  const stats: AlignStats = { totalWords, matchedWords: matched, coverage: totalWords ? round3(matched / totalWords) : 0, lowConfidence: lowIds.length, unaligned: unalignedIds.length, adjusted };
  // When few words could be matched (common for languages the transcriber knows poorly, such as Kasem),
  // the line times come mostly from listening to the song, so the whole sheet is marked for review.
  const weakMatch = totalWords > 0 && matched / totalWords < 0.5;
  const out: LyricsSheet = {
    ...sheet,
    lines,
    timing: {
      status: lowIds.length || unalignedIds.length || weakMatch ? 'needs_review' : 'aligned',
      method: opts.method ?? 'transcript_alignment',
      audioAssetId: opts.audioAssetId ?? sheet.timing.audioAssetId,
      alignedAt: Date.now(),
      lowConfidenceLineIds: lowIds,
      unalignedLineIds: unalignedIds,
      adjustments: adjusted,
      anchors: (opts.anchors ?? []).filter((a) => lines[a.lineIndex]).map((a) => ({ lineId: lines[a.lineIndex]!.id, start: a.start, end: a.end, confidence: a.confidence })),
      notes: [
        `${matched} of ${totalWords} words matched the vocals directly.`,
        ...(adjusted ? [`${adjusted} line time${adjusted > 1 ? 's were' : ' was'} corrected from the uploaded timing.`] : []),
        ...(lowIds.length || unalignedIds.length ? [`${lowIds.length + unalignedIds.length} line(s) need a listen in the waveform editor.`] : []),
        ...(weakMatch ? ['Most words could not be matched in the transcript, so line times come mainly from listening to the song — check them in the waveform editor.'] : []),
      ],
    },
    updatedAt: Date.now(),
  };
  return { sheet: out, stats };
}

/** Re-aligns a corrected sheet with the cached transcript and the stored line anchors (no model call). */
export function resyncSheet(sheet: LyricsSheet, asr: AsrWord[], durationSec: number): LyricsSheet {
  const anchors: LineAnchor[] = (sheet.timing.anchors ?? []).map((a) => ({ lineIndex: sheet.lines.findIndex((l) => l.id === a.lineId), start: a.start, end: a.end, confidence: a.confidence })).filter((a) => a.lineIndex >= 0);
  return alignLyrics(sheet, asr, { durationSec, anchors, audioAssetId: sheet.timing.audioAssetId, method: sheet.timing.method ?? 'word_timed_transcript' }).sheet;
}

/** Sets a line's timing by hand (waveform editor); it stays pinned through later re-alignment. */
export function setLineTiming(sheet: LyricsSheet, lineId: string, start: number, end: number): LyricsSheet {
  return {
    ...sheet,
    lines: sheet.lines.map((l) => {
      if (l.id !== lineId) return l;
      const words = l.words.map((w) => ({ ...w }));
      const oldStart = l.start;
      const oldEnd = l.end;
      if (oldStart !== null && oldEnd !== null && oldEnd > oldStart && words.every((w) => w.start !== null && w.end !== null)) {
        const k = (end - start) / (oldEnd - oldStart);
        for (const w of words) {
          w.start = round3(start + (w.start! - oldStart) * k);
          w.end = round3(start + (w.end! - oldStart) * k);
          w.flag = 'manual';
          w.confidence = 0.95;
        }
      } else distribute(words, start, end, 0.95, 'manual');
      const flags = [...new Set([...l.flags.filter((f) => f !== 'unaligned' && f !== 'low_confidence'), 'manual_timing' as LineFlag])];
      return { ...l, start: round3(start), end: round3(end), words, confidence: 0.95, flags };
    }),
    timing: { ...sheet.timing, lowConfidenceLineIds: sheet.timing.lowConfidenceLineIds.filter((id) => id !== lineId), unalignedLineIds: sheet.timing.unalignedLineIds.filter((id) => id !== lineId) },
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Export (.lrc / .srt / .vtt)
// ---------------------------------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function lrcTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  return `${pad(Math.floor(cs / 6000))}:${pad(Math.floor((cs % 6000) / 100))}.${pad(cs % 100)}`;
}
function clockTime(t: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(t * 1000));
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1000))}${sep}${pad(ms % 1000, 3)}`;
}

export interface ExportOptions {
  /** Shift so this song time becomes 0 (production range start, trimmed song). */
  offsetSec?: number;
  /** Only lines inside [start, end) of song time. */
  range?: { start: number; end: number } | null;
  wordLevel?: boolean;
  title?: string;
  artist?: string;
}

function exportLines(sheet: LyricsSheet, opts: ExportOptions) {
  const off = opts.offsetSec ?? opts.range?.start ?? 0;
  const r = opts.range;
  return sheet.lines
    .filter((l) => l.start !== null && l.end !== null && (!r || (l.end! > r.start + 0.05 && l.start! < r.end - 0.05)))
    .map((l) => {
      const start = Math.max(0, l.start! - off);
      const end = Math.max(start + 0.1, (r ? Math.min(r.end, l.end!) : l.end!) - off);
      return { line: l, start, end, words: l.words.filter((w) => w.start !== null).map((w) => ({ text: w.text, start: Math.max(0, w.start! - off), end: Math.max(0, (w.end ?? w.start!) - off) })) };
    });
}

/** LRC (optionally "enhanced" with per-word `<mm:ss.xx>` tags). UTF-8 text is written exactly. */
export function toLrc(sheet: LyricsSheet, opts: ExportOptions = {}): string {
  const head = [opts.title ? `[ti:${opts.title}]` : '', opts.artist ? `[ar:${opts.artist}]` : '', '[re:AZ Studio]'].filter(Boolean);
  const body = exportLines(sheet, opts).map(({ line, start, words }) => {
    if (opts.wordLevel && words.length) return `[${lrcTime(start)}]${words.map((w) => `<${lrcTime(w.start)}>${w.text}`).join(' ')}`;
    return `[${lrcTime(start)}]${line.text.replace(/\n/g, ' ')}`;
  });
  return `${[...head, ...body].join('\n')}\n`;
}

export function toSrt(sheet: LyricsSheet, opts: ExportOptions = {}): string {
  return exportLines(sheet, opts)
    .map(({ line, start, end }, i) => `${i + 1}\n${clockTime(start, ',')} --> ${clockTime(end, ',')}\n${line.text}\n`)
    .join('\n');
}

/** WebVTT; with `wordLevel`, inline `<hh:mm:ss.mmm>` timestamps drive karaoke highlighting in players. */
export function toVtt(sheet: LyricsSheet, opts: ExportOptions = {}): string {
  const cues = exportLines(sheet, opts).map(({ line, start, end, words }, i) => {
    const text = opts.wordLevel && words.length > 1 ? words.map((w, k) => (k === 0 ? w.text : `<${clockTime(w.start, '.')}>${w.text}`)).join(' ') : line.text;
    return `${i + 1}\n${clockTime(start, '.')} --> ${clockTime(end, '.')}\n${text}\n`;
  });
  return `WEBVTT\n\n${cues.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Caption layouts
// ---------------------------------------------------------------------------

export const LYRIC_CAPTION_MODES = ['line', 'karaoke', 'phrase', 'subtitle', 'vertical'] as const;
export type LyricCaptionMode = (typeof LYRIC_CAPTION_MODES)[number];
export const LYRIC_CAPTION_MODE_LABELS: Record<LyricCaptionMode, string> = {
  line: 'Line by line',
  karaoke: 'Word-by-word karaoke',
  phrase: 'Phrase highlighting',
  subtitle: 'Traditional subtitles',
  vertical: 'Vertical lyric layout',
};

export interface LyricCaptionSpec {
  lineId: string;
  /** Song time (s). */
  start: number;
  end: number;
  text: string;
  /** Highlight units relative to the caption start (words for karaoke, phrases for phrase mode). */
  units: { text: string; start: number; end: number }[] | null;
}

/** Phrases within a line: split at punctuation or at pauses of 0.35 s or more between words. */
export function phrasesOf(line: LyricSheetLine): { text: string; start: number; end: number }[] {
  const ws = line.words.filter((w) => w.start !== null && w.end !== null);
  const out: { text: string; start: number; end: number }[] = [];
  let cur: typeof ws = [];
  ws.forEach((w, i) => {
    cur.push(w);
    const next = ws[i + 1];
    const pause = next ? next.start! - w.end! : 0;
    if (!next || /[,;:!?.…—–]$/.test(w.text) || pause >= 0.35) {
      out.push({ text: cur.map((x) => x.text).join(' '), start: cur[0]!.start!, end: cur[cur.length - 1]!.end! });
      cur = [];
    }
  });
  return out;
}

/** Caption timing per line for a layout; the line text itself is never changed. */
export function lyricCaptionSpecs(sheet: LyricsSheet, mode: LyricCaptionMode): LyricCaptionSpec[] {
  const lines = sheet.lines.filter((l) => l.start !== null && l.end !== null && l.end > l.start && l.text.trim());
  return lines.map((l, i) => {
    const next = lines[i + 1];
    const maxEnd = next ? next.start! - 0.05 : l.end! + 1.5;
    const hold = mode === 'subtitle' ? Math.max(0, Math.min(maxEnd, l.start! + 1) - l.end!) : 0;
    const end = Math.max(l.start! + 0.3, Math.min(maxEnd, l.end! + Math.max(hold, 0.35)));
    let units: LyricCaptionSpec['units'] = null;
    if (mode === 'karaoke' || mode === 'vertical') {
      const ws = l.words.filter((w) => w.start !== null && w.end !== null);
      if (ws.length) units = ws.map((w) => ({ text: w.text, start: round3(Math.max(0, w.start! - l.start!)), end: round3(Math.max(0, w.end! - l.start!)) }));
    } else if (mode === 'phrase') {
      const ps = phrasesOf(l);
      if (ps.length) units = ps.map((p) => ({ text: p.text, start: round3(p.start - l.start!), end: round3(p.end - l.start!) }));
    }
    return { lineId: l.id, start: round3(l.start!), end: round3(end), text: l.text, units };
  });
}
