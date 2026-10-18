import { renderDirections, type Direction, type DirectedSegment } from './narrator-direction';
import {
  DEFAULT_CLOSING,
  narratorHash,
  OPENING_TEMPLATE,
  makeIdFactory,
  passageInputHash,
  styleFor,
  type EditionSettings,
  type IdFactory,
  type NarratorPassage,
  type NarratorScript,
  type NarratorSection,
  type PronunciationEntry,
} from './narrator';

/**
 * Article text → narration script, reviewable cleanup proposals, pronunciation spellings and provider-sized
 * chunks. Nothing here rewrites or summarises the argument: every change to the spoken text is either typed
 * by Francis or proposed as an explicit, reviewable edit.
 */

// ---------------------------------------------------------------------------
// Article blocks
// ---------------------------------------------------------------------------

export interface ArticleBlock {
  type: 'heading' | 'paragraph';
  text: string;
  level?: number;
}

const flat = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();

/**
 * Splits pasted or imported text into headings and paragraphs. Paragraphs are separated by blank lines;
 * Markdown headings (`#`…`######`) become headings. Nothing else is inferred: a short line is still a
 * paragraph unless it is marked as a heading.
 */
export function parseArticleText(raw: string): ArticleBlock[] {
  const text = raw.replace(/\r\n?/g, '\n');
  const blocks: ArticleBlock[] = [];
  for (const chunk of text.split(/\n[ \t]*\n+/)) {
    const lines = chunk.split('\n');
    let buffer: string[] = [];
    const flush = () => {
      const t = flat(buffer.join('\n'));
      if (t) blocks.push({ type: 'paragraph', text: t });
      buffer = [];
    };
    for (const line of lines) {
      const h = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) {
        flush();
        blocks.push({ type: 'heading', text: flat(h[2]!), level: h[1]!.length });
      } else buffer.push(line);
    }
    flush();
  }
  return blocks;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[“”"'‘’.,:;!?*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const OPENING_MARKERS = [/you(?:'|’)re listening to the pwavwe papers/i, /written by francis pwavwe/i, /this is the pwavwe papers/i];
const CLOSING_MARKERS = [/thank you for listening to the pwavwe papers/i, /thanks for listening to the pwavwe papers/i];

export function looksLikeOpening(text: string): boolean {
  return OPENING_MARKERS.some((r) => r.test(text));
}
export function looksLikeClosing(text: string): boolean {
  return CLOSING_MARKERS.some((r) => r.test(text));
}

export function openingFromTemplate(template: string, title: string): string {
  const t = title.trim().replace(/[.!?]+$/, '');
  return (template || OPENING_TEMPLATE).replace(/\[Article title\]/gi, t || 'Untitled');
}

export interface BuildScriptInput {
  title: string;
  body: string;
  openingTemplate?: string;
  closingText?: string;
  /** An audio-edition opening supplied with an article package (used as is). */
  existingOpening?: string | null;
}

export interface BuiltScript {
  script: NarratorScript;
  notes: string[];
}

/**
 * Builds the narration script: opening → sections of paragraphs (a heading starts a section and is spoken
 * as its own passage) → closing. The original article text is kept in each passage's `source`.
 * - A first block repeating the title is not read twice (the opening already says it).
 * - An opening already present in the text (or supplied) is used instead of the default — never two intros.
 * - A closing already present in the text is used instead of the default.
 */
export function buildScript(input: BuildScriptInput, newId: IdFactory = makeIdFactory()): BuiltScript {
  const notes: string[] = [];
  const blocks = parseArticleText(input.body);
  if (blocks.length && norm(blocks[0]!.text) === norm(input.title) && norm(input.title)) {
    blocks.shift();
    notes.push('The first line repeats the title; it is not read twice because the opening says the title.');
  }
  let openingText: string;
  let openingSource = '';
  const supplied = input.existingOpening?.trim();
  if (supplied) {
    openingText = supplied;
    notes.push('Using the audio-edition opening supplied with the article.');
    if (blocks.length && blocks[0]!.type === 'paragraph' && looksLikeOpening(blocks[0]!.text)) {
      blocks.shift();
      notes.push('The article also began with an audio-edition introduction; only one is used.');
    }
  } else if (blocks.length && blocks[0]!.type === 'paragraph' && looksLikeOpening(blocks[0]!.text)) {
    openingText = blocks[0]!.text;
    openingSource = blocks[0]!.text;
    blocks.shift();
    notes.push('The article already starts with an audio-edition opening, so no second introduction was added.');
  } else {
    openingText = openingFromTemplate(input.openingTemplate ?? OPENING_TEMPLATE, input.title);
  }
  let closingText = input.closingText ?? DEFAULT_CLOSING;
  let closingSource = '';
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'paragraph' && looksLikeClosing(last.text)) {
    closingText = last.text;
    closingSource = last.text;
    blocks.pop();
    notes.push('The article already ends with an audio-edition closing; it is used as the closing.');
  }

  const sections: NarratorSection[] = [];
  let current: NarratorSection | null = null;
  for (const b of blocks) {
    if (b.type === 'heading') {
      current = { id: newId(), title: b.text, passages: [{ id: newId(), kind: 'heading', text: b.text, source: b.text }] };
      sections.push(current);
    } else {
      if (!current) {
        current = { id: newId(), title: null, passages: [] };
        sections.push(current);
      }
      current.passages.push({ id: newId(), kind: 'paragraph', text: b.text, source: b.text });
    }
  }
  return {
    script: {
      opening: { id: newId(), kind: 'opening', text: openingText, source: openingSource },
      sections,
      closing: { id: newId(), kind: 'closing', text: closingText, source: closingSource },
    },
    notes,
  };
}

export interface FlatPassage {
  passage: NarratorPassage;
  sectionId: string | null;
  sectionTitle: string | null;
  /** 0-based position in narration order. */
  index: number;
}

/** Every passage in narration order. The closing is included only when `includeClosing`. */
export function flattenScript(script: NarratorScript, includeClosing = true): FlatPassage[] {
  const out: FlatPassage[] = [];
  const push = (passage: NarratorPassage, sectionId: string | null, sectionTitle: string | null) => out.push({ passage, sectionId, sectionTitle, index: out.length });
  if (script.opening) push(script.opening, null, null);
  for (const s of script.sections) for (const p of s.passages) push(p, s.id, s.title);
  if (script.closing && includeClosing) push(script.closing, null, null);
  return out;
}

/** Passages that will actually be spoken (non-empty, not skipped). */
export function spokenPassages(script: NarratorScript, includeClosing = true): FlatPassage[] {
  return flattenScript(script, includeClosing).filter((f) => !f.passage.skip && f.passage.text.trim());
}

export function findPassage(script: NarratorScript, passageId: string): FlatPassage | null {
  return flattenScript(script, true).find((f) => f.passage.id === passageId) ?? null;
}

// ---------------------------------------------------------------------------
// Cleanup proposals (span edits on a passage's spoken text)
// ---------------------------------------------------------------------------

export type CleanupKind = 'markdown' | 'link' | 'url' | 'citation' | 'numbers' | 'abbreviation' | 'symbols' | 'list';
export const CLEANUP_LABELS: Record<CleanupKind, string> = {
  markdown: 'Markdown punctuation',
  link: 'Link markup (keeps the link text)',
  url: 'Raw web addresses',
  citation: 'Citation markers',
  numbers: 'Number and symbol expansion',
  abbreviation: 'Abbreviations',
  symbols: 'Symbols read aloud badly',
  list: 'List markers',
};

export interface SpanEdit {
  start: number;
  end: number;
  replacement: string;
  kind: CleanupKind;
}

export interface CleanupProposal {
  id: string;
  passageId: string;
  kind: CleanupKind;
  before: string;
  after: string;
  /** Short context around the change for review. */
  context: string;
}

export interface SkipProposal {
  passageId: string;
  reason: 'image_credit' | 'interface_text' | 'empty';
  text: string;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function under1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} hundred`);
  if (r) {
    if (h) parts.push('and');
    parts.push(r < 20 ? ONES[r]! : `${TENS[Math.floor(r / 10)]}${r % 10 ? `-${ONES[r % 10]}` : ''}`);
  }
  return parts.join(' ');
}

/** British-style cardinal words for 0 … 999,999,999,999. */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e12) return String(n);
  if (n < 20) return ONES[n]!;
  const scales: [number, string][] = [
    [1e9, 'billion'],
    [1e6, 'million'],
    [1e3, 'thousand'],
  ];
  const parts: string[] = [];
  let rest = n;
  for (const [v, name] of scales) {
    if (rest >= v) {
      parts.push(`${under1000(Math.floor(rest / v))} ${name}`);
      rest %= v;
    }
  }
  if (rest) parts.push(rest < 100 && parts.length ? `and ${under1000(rest)}` : under1000(rest));
  return parts.join(' ');
}

/** How a four-digit year is usually read: 1984 → nineteen eighty-four, 2026 → twenty twenty-six, 2005 → two thousand and five. */
export function yearToWords(y: number): string {
  if (y >= 2000 && y < 2010) return y === 2000 ? 'two thousand' : `two thousand and ${ONES[y - 2000]}`;
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  if (lo === 0) return `${under1000(hi)} hundred`;
  return `${under1000(hi)} ${lo < 10 ? `oh ${ONES[lo]}` : under1000(lo)}`;
}

interface Rule {
  kind: CleanupKind;
  re: RegExp;
  replace: (m: RegExpExecArray) => string;
}

const amount = (s: string) => Number(s.replace(/,/g, ''));
function spokenAmount(s: string): string {
  const [int, dec] = s.split('.');
  const n = amount(int!);
  if (!Number.isFinite(n)) return s;
  const words = numberToWords(n);
  return dec && Number(dec) ? `${words} point ${dec.split('').map((d) => ONES[Number(d)]).join(' ')}` : words;
}

const RULES: Rule[] = [
  // Markdown link [text](url) → text
  { kind: 'link', re: /\[([^\]\n]+)\]\((?:https?:\/\/|\/|#)[^)\s]*\)/g, replace: (m) => m[1]! },
  // Citation markers: [1], [12], [citation needed], ^3 after a word
  { kind: 'citation', re: /\s?\[(?:\d{1,3}(?:[,–-]\s?\d{1,3})*|citation needed|note \d+)\]/gi, replace: () => '' },
  // Raw URLs
  { kind: 'url', re: /\s?\(?\bhttps?:\/\/[^\s)]+\)?/g, replace: () => '' },
  // Bold / italic / inline code markers (keep the words)
  { kind: 'markdown', re: /(\*\*|__)(?=\S)([^*_\n]+?)(?<=\S)\1/g, replace: (m) => m[2]! },
  { kind: 'markdown', re: /(?<![\p{L}\p{N}*_])([*_])(?=\S)([^*_\n]+?)(?<=\S)\1(?![\p{L}\p{N}*_])/gu, replace: (m) => m[2]! },
  { kind: 'markdown', re: /`([^`\n]+)`/g, replace: (m) => m[1]! },
  { kind: 'markdown', re: /^>\s?/gm, replace: () => '' },
  // List markers at line starts
  { kind: 'list', re: /^\s*(?:[-*•]|\d{1,2}[.)])\s+/gm, replace: () => '' },
  // Money in Ghana cedis and dollars, percentages, years, ranges
  { kind: 'numbers', re: /(?:GH₵|GH¢|₵|GHS\s?)(\d[\d,]*(?:\.\d+)?)/g, replace: (m) => `${spokenAmount(m[1]!)} Ghana cedis` },
  { kind: 'numbers', re: /\$(\d[\d,]*(?:\.\d+)?)(\s?(?:million|billion|thousand))?/g, replace: (m) => `${spokenAmount(m[1]!)}${m[2] ?? ''} dollars` },
  { kind: 'numbers', re: /\b(\d+(?:\.\d+)?)\s?%/g, replace: (m) => `${spokenAmount(m[1]!)} percent` },
  { kind: 'numbers', re: /\b(1[1-9]\d\d|20\d\d)\s?[–-]\s?(1[1-9]\d\d|20\d\d)\b/g, replace: (m) => `${yearToWords(Number(m[1]))} to ${yearToWords(Number(m[2]))}` },
  { kind: 'numbers', re: /(?<![\d.,$₵])\b(1[1-9]\d\d|20\d\d)\b(?![\d.,]|\s?%)/g, replace: (m) => yearToWords(Number(m[1])) },
  // Abbreviations commonly misread
  { kind: 'abbreviation', re: /\be\.g\.(?=\s|,|$)/gi, replace: () => 'for example' },
  { kind: 'abbreviation', re: /\bi\.e\.(?=\s|,|$)/gi, replace: () => 'that is' },
  { kind: 'abbreviation', re: /\betc\.(?=\s|,|$)/gi, replace: () => 'et cetera' },
  { kind: 'abbreviation', re: /\bvs\.?(?=\s)/gi, replace: () => 'versus' },
  // Symbols
  { kind: 'symbols', re: /\s&\s/g, replace: () => ' and ' },
  { kind: 'symbols', re: /\b(and|or)\/(or|and)\b/gi, replace: (m) => `${m[1]} or ${m[2]}` },
];

/** Span edits a passage would receive for the chosen kinds (non-overlapping, earlier rules win). */
export function cleanupEdits(text: string, kinds: readonly CleanupKind[] = Object.keys(CLEANUP_LABELS) as CleanupKind[]): SpanEdit[] {
  const edits: SpanEdit[] = [];
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  for (const rule of RULES) {
    if (!kinds.includes(rule.kind)) continue;
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      const replacement = rule.replace(m);
      if (replacement === m[0]) continue;
      edits.push({ start, end, replacement, kind: rule.kind });
      taken.push([start, end]);
    }
  }
  return edits.sort((a, b) => a.start - b.start);
}

/** Applies span edits; text outside the edits is preserved exactly (then double spaces are tidied). */
export function applyEdits(text: string, edits: readonly SpanEdit[]): string {
  let out = '';
  let at = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    if (e.start < at) continue;
    out += text.slice(at, e.start) + e.replacement;
    at = e.end;
  }
  out += text.slice(at);
  return edits.length ? out.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:!?])/g, '$1').trim() : out;
}

const CREDIT_RE = /^(?:\(?\s*)?(?:image|photo|photograph|picture|illustration|cover image|header image|featured image|graphic)s?(?:\s+(?:credit|source|by))?\s*[:：-]|^(?:credit|source)s?\s*[:：]|^photo(?:graph)? by\b.*\bon (?:unsplash|pexels|pixabay)\b|\b(?:CC BY(?:-SA|-ND|-NC)*|CC0|public domain)\b.*$/i;
const INTERFACE_RE = /^(?:share (?:this|paper|on)\b.*|read more\b.*|continue reading\b.*|subscribe\b.*|sign up for\b.*|click here\b.*|tap here\b.*|advertisement|sponsored|copy link|related posts?|you may also like\b.*|leave a comment\b.*|\d+ comments?|older posts?|newer posts?|home|back to top)\.?$/i;

/** Whole passages that look like image credits or interface text (proposed for skipping, never deleted). */
export function proposeSkips(script: NarratorScript): SkipProposal[] {
  const out: SkipProposal[] = [];
  for (const s of script.sections)
    for (const p of s.passages) {
      if (p.skip || p.kind !== 'paragraph') continue;
      const t = p.text.trim();
      if (!t) out.push({ passageId: p.id, reason: 'empty', text: t });
      else if (t.length <= 220 && CREDIT_RE.test(t)) out.push({ passageId: p.id, reason: 'image_credit', text: t });
      else if (t.length <= 80 && INTERFACE_RE.test(t)) out.push({ passageId: p.id, reason: 'interface_text', text: t });
    }
  return out;
}

/** Every reviewable text change across the script (one proposal per edit, with context). */
export function proposeCleanup(script: NarratorScript, kinds?: readonly CleanupKind[]): CleanupProposal[] {
  const out: CleanupProposal[] = [];
  for (const { passage } of flattenScript(script, true)) {
    if (passage.skip) continue;
    for (const e of cleanupEdits(passage.text, kinds)) {
      const before = passage.text.slice(e.start, e.end);
      const ctxStart = Math.max(0, e.start - 40);
      const ctxEnd = Math.min(passage.text.length, e.end + 40);
      out.push({
        id: `${passage.id}:${e.start}:${e.end}`,
        passageId: passage.id,
        kind: e.kind,
        before,
        after: e.replacement,
        context: `${ctxStart > 0 ? '…' : ''}${passage.text.slice(ctxStart, e.start)}⟦${before}→${e.replacement}⟧${passage.text.slice(e.end, ctxEnd)}${ctxEnd < passage.text.length ? '…' : ''}`,
      });
    }
  }
  return out;
}

/** Applies the accepted proposals (by id) to the script's spoken text. Sources are untouched. */
export function applyCleanup(script: NarratorScript, acceptedIds: ReadonlySet<string>, skipIds: ReadonlySet<string> = new Set()): NarratorScript {
  const fix = (p: NarratorPassage): NarratorPassage => {
    const edits = cleanupEdits(p.text).filter((e) => acceptedIds.has(`${p.id}:${e.start}:${e.end}`));
    const text = edits.length ? applyEdits(p.text, edits) : p.text;
    return { ...p, text, ...(skipIds.has(p.id) ? { skip: true } : {}) };
  };
  return {
    opening: script.opening ? fix(script.opening) : null,
    sections: script.sections.map((s) => ({ ...s, passages: s.passages.map(fix) })),
    closing: script.closing ? fix(script.closing) : null,
  };
}

// ---------------------------------------------------------------------------
// Pronunciation (speech-only spellings)
// ---------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface PronunciationResult {
  text: string;
  applied: { term: string; spokenAs: string; count: number }[];
}

/**
 * Replaces notebook terms with their speech-only spellings (whole words, longest terms first). The visible
 * article and script text keep their spelling; only the text sent to the voice model changes.
 */
export function applyPronunciations(text: string, entries: readonly PronunciationEntry[]): PronunciationResult {
  const active = entries.filter((e) => e.term.trim() && e.spokenAs.trim() && e.spokenAs.trim() !== e.term.trim()).sort((a, b) => b.term.length - a.term.length);
  if (!active.length) return { text, applied: [] };
  const counts = new Map<string, number>();
  const pattern = new RegExp(active.map((e) => `(?<![\\p{L}\\p{N}])${escapeRe(e.term.trim())}(?![\\p{L}\\p{N}])`).join('|'), 'giu');
  const out = text.replace(pattern, (match) => {
    const entry = active.find((e) => (e.caseSensitive ? match === e.term.trim() : match.toLowerCase() === e.term.trim().toLowerCase()));
    if (!entry) return match;
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    return entry.spokenAs.trim();
  });
  return { text: out, applied: active.filter((e) => counts.has(e.id)).map((e) => ({ term: e.term, spokenAs: e.spokenAs, count: counts.get(e.id)! })) };
}

/** Exactly the text sent to the voice model for a passage: pronunciations applied, whitespace collapsed. */
export function providerTextFor(text: string, entries: readonly PronunciationEntry[]): PronunciationResult {
  const r = applyPronunciations(text, entries);
  return { ...r, text: r.text.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim() };
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Characters per synthesis request. The 3.8 TTS models accept 8,192 input tokens and return at most 16,384
 * output tokens (≈ 655 s at 25 audio tokens/s); 1,800 characters ≈ 2 minutes of speech keeps every request
 * far inside both limits and makes a failed request cheap to repeat.
 */
export const MAX_CHUNK_CHARS = 1800;

/** Sentence-sized pieces (a sentence ends with . ! ? or … followed by space, keeping closing quotes). */
export function splitNarrationSentences(text: string): string[] {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const out: string[] = [];
  const re = /[.!?…]+["'”’)\]]*\s+(?=["'“‘([]?[\p{Lu}\p{N}])/gu;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const end = m.index + m[0].trimEnd().length;
    out.push(t.slice(at, end));
    at = m.index + m[0].length;
  }
  out.push(t.slice(at));
  return out.filter(Boolean);
}

function splitLong(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  // Prefer clause boundaries, then words.
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = -1;
    for (const re of [/[;:]\s/g, /,\s/g, /\s[–—-]\s/g, /\s/g]) {
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(window))) if (m.index > max * 0.4) cut = m.index + m[0].trimEnd().length;
      if (cut > 0) break;
    }
    if (cut <= 0) cut = max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Splits text into requests of at most `max` characters at natural boundaries (sentences, then clauses,
 * then words). Order and every word are preserved: `chunks.join(' ')` equals the whitespace-normalised input.
 */
export function chunkText(text: string, max = MAX_CHUNK_CHARS): string[] {
  const sentences = splitNarrationSentences(text).flatMap((s) => splitLong(s, max));
  const chunks: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (!cur) cur = s;
    else if (cur.length + 1 + s.length <= max) cur = `${cur} ${s}`;
    else {
      chunks.push(cur);
      cur = s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ---------------------------------------------------------------------------
// Durations and cost estimates
// ---------------------------------------------------------------------------

export const DEFAULT_WORDS_PER_MINUTE = 155;

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
}

/** Spoken seconds at a pace, plus a little for sentence ends (an estimate). */
export function estimateSpeechSec(text: string, wordsPerMinute = DEFAULT_WORDS_PER_MINUTE): number {
  const words = countWords(text);
  if (!words) return 0;
  const stops = (text.match(/[.!?…;:]/g) ?? []).length;
  return (words / Math.max(60, wordsPerMinute)) * 60 + stops * 0.15;
}

/** Speaking pace measured from real clips (words per minute of measured speech), or null without clips. */
export function measuredPace(clips: { text: string; speechSec: number | null }[]): number | null {
  let words = 0;
  let sec = 0;
  for (const c of clips) {
    if (!c.speechSec || c.speechSec < 2) continue;
    words += countWords(c.text);
    sec += c.speechSec;
  }
  return sec >= 10 ? Math.round((words / sec) * 60) : null;
}

export interface NarrationRates {
  modelId: string;
  inputPerM: number;
  outputPerM: number;
  audioTokensPerSecond: number;
  source: string;
  retrievedAt: string;
  validNote: string;
}

export interface NarrationEstimate {
  requests: number;
  speechSec: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  wordsPerMinute: number;
  paceSource: 'measured' | 'default';
  notes: string[];
}

/** Text tokens are not counted locally: about four characters per token is assumed (labelled). */
export const CHARS_PER_TEXT_TOKEN = 4;

export function estimateNarration(texts: string[], rates: NarrationRates, pace: { wordsPerMinute: number; source: 'measured' | 'default' }): NarrationEstimate {
  let requests = 0;
  let speechSec = 0;
  let inputTokens = 0;
  for (const t of texts) {
    const chunks = chunkText(t);
    requests += chunks.length;
    speechSec += estimateSpeechSec(t, pace.wordsPerMinute);
    inputTokens += chunks.reduce((s, c) => s + Math.ceil(c.length / CHARS_PER_TEXT_TOKEN) + 12, 0);
  }
  const outputTokens = Math.ceil(speechSec * rates.audioTokensPerSecond);
  const usd = Math.round(((inputTokens / 1e6) * rates.inputPerM + (outputTokens / 1e6) * rates.outputPerM) * 1e5) / 1e5;
  return {
    requests,
    speechSec: Math.round(speechSec * 10) / 10,
    inputTokens,
    outputTokens,
    usd,
    wordsPerMinute: pace.wordsPerMinute,
    paceSource: pace.source,
    notes: [
      `Estimate. Speech length from ${pace.source === 'measured' ? 'your measured speaking pace' : `an assumed ${pace.wordsPerMinute} words per minute`}; text tokens assumed at ~${CHARS_PER_TEXT_TOKEN} characters each.`,
      `Google list price for ${rates.modelId}: $${rates.inputPerM.toFixed(2)} per 1M text tokens in, $${rates.outputPerM.toFixed(2)} per 1M audio tokens out (${rates.audioTokensPerSecond} tokens per second of audio) — ${rates.validNote} Source: ${rates.source}, retrieved ${rates.retrievedAt}.`,
      'Actual billed tokens are recorded from Google’s response after each request.',
    ],
  };
}

/** Estimated running time of an edition: speech plus the configured pauses. */
export function editionDurationSec(passageSecs: { kind: NarratorPassage['kind']; sec: number; sectionChange: boolean }[], pauses: { afterOpeningSec: number; betweenParagraphsSec: number; betweenSectionsSec: number; afterHeadingSec: number; beforeClosingSec: number }): number {
  let total = 0;
  passageSecs.forEach((p, i) => {
    total += p.sec;
    const next = passageSecs[i + 1];
    if (!next) return;
    total += pauseBetween(p.kind, next.kind, next.sectionChange, pauses);
  });
  return total;
}

/** The silence placed after a passage, given what follows. */
export function pauseBetween(kind: NarratorPassage['kind'], nextKind: NarratorPassage['kind'], sectionChange: boolean, pauses: { afterOpeningSec: number; betweenParagraphsSec: number; betweenSectionsSec: number; afterHeadingSec: number; beforeClosingSec: number }): number {
  if (kind === 'opening') return pauses.afterOpeningSec;
  if (nextKind === 'closing') return pauses.beforeClosingSec;
  if (kind === 'heading') return pauses.afterHeadingSec;
  if (sectionChange || nextKind === 'heading') return pauses.betweenSectionsSec;
  return pauses.betweenParagraphsSec;
}

// ---------------------------------------------------------------------------
// What a passage's audio is made from
// ---------------------------------------------------------------------------

export interface SynthesisInput {
  /** What is sent, joined for display (tags and capitalised emphasis included when directions apply). */
  providerText: string;
  /** The passage's base delivery style. */
  style: string;
  /** Text blocks sent in one request; a style change from a direction starts a new block. */
  segments: DirectedSegment[];
  inputHash: string;
  applied: PronunciationResult['applied'];
  /** Accepted directions that could not be rendered for this provider (with the reason). */
  flagged: { id: string; reason: string }[];
  directionsApplied: number;
}

/**
 * The exact request inputs for a passage and the hash that decides whether existing audio is current. Accepted
 * directions are rendered for the provider first (tags between words, capitalised emphasis, styled segments),
 * then pronunciation spellings are applied to each segment; the visible script is never changed.
 */
export function passageSynthesisInput(p: NarratorPassage, settings: Pick<EditionSettings, 'preset' | 'customStyle'>, notebook: readonly PronunciationEntry[], voice: { id: string; modelId: string }, directions: readonly Direction[] = []): SynthesisInput {
  const style = p.style?.trim() ? p.style.trim().slice(0, 80) : styleFor(settings.preset, settings.customStyle);
  const mine = directions.filter((d) => d.passageId === p.id && d.status === 'accepted');
  if (!mine.length) {
    const { text, applied } = providerTextFor(p.text.replace(/</g, '‹').replace(/>/g, '›'), notebook);
    return { providerText: text, style, segments: [{ text, style }], inputHash: passageInputHash({ providerText: text, style, voiceId: voice.id, modelId: voice.modelId }), applied, flagged: [], directionsApplied: 0 };
  }
  const rendered = renderDirections(p.text, mine, style);
  const applied: PronunciationResult['applied'] = [];
  const segments = rendered.segments.map((s) => {
    const r = providerTextFor(s.text, notebook);
    applied.push(...r.applied);
    return { text: r.text, style: s.style || style };
  });
  const providerText = segments.map((s) => s.text).join(' ');
  const inputHash = narratorHash({ s: segments, v: voice.id, m: voice.modelId });
  return { providerText, style, segments, inputHash, applied, flagged: rendered.flagged, directionsApplied: rendered.applied.length };
}

/** Splits segments into requests of at most `max` characters (styles kept; long segments split at sentences). */
export function chunkSegments(segments: DirectedSegment[], max = MAX_CHUNK_CHARS): DirectedSegment[][] {
  const pieces = segments.flatMap((s) => chunkText(s.text, max).map((text) => ({ text, style: s.style })));
  const out: DirectedSegment[][] = [];
  let cur: DirectedSegment[] = [];
  let len = 0;
  for (const p of pieces) {
    if (cur.length && len + 1 + p.text.length > max) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(p);
    len += p.text.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

export type PassageAudioState = 'skipped' | 'empty' | 'missing' | 'current' | 'stale' | 'generating' | 'needs_recovery' | 'failed';

export const PASSAGE_STATE_LABELS: Record<PassageAudioState, string> = {
  skipped: 'Not narrated',
  empty: 'No text',
  missing: 'No audio yet',
  current: 'Audio current',
  stale: 'Text or settings changed — audio out of date',
  generating: 'Generating',
  needs_recovery: 'Needs recovery',
  failed: 'Failed',
};

/**
 * A passage's audio state: the selected take counts only if it was made from exactly the current inputs.
 * A newer failed or unresolved attempt for the current inputs is reported so it is never hidden.
 */
export function passageAudioState(p: NarratorPassage, inputHash: string | null, selected: { status: string; inputHash: string } | null, latestForHash: { status: string } | null, generating: boolean): PassageAudioState {
  if (p.skip) return 'skipped';
  if (!p.text.trim()) return 'empty';
  if (generating) return 'generating';
  if (selected && selected.status === 'ready' && selected.inputHash === inputHash) return 'current';
  if (latestForHash?.status === 'needs_recovery') return 'needs_recovery';
  if (latestForHash?.status === 'failed') return 'failed';
  if (selected && selected.status === 'ready') return 'stale';
  return 'missing';
}
