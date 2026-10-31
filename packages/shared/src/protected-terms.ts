import { normalizeWord, tokenize } from './text-align';

/**
 * One list of protected words for every tool that speaks or transcribes: names, places and brands whose
 * spelling must be exact in captions and transcripts, how the voice should say them (only where a respelling is
 * unambiguous — letter-by-letter acronyms; nothing is guessed), extra spellings that help the transcriber, and
 * the mishearings seen in real takes, corrected when the term is expected. Per-project terms (an advert's
 * protected terms, a film's character names and pronunciations) are added on top of this list.
 */

export interface ProtectedTerm {
  term: string;
  /** Speech-only spelling sent to the voice ('' = say it as written). */
  respelling: string;
  /** Extra spellings that bias transcription toward the term. */
  hints: string[];
  /** What transcription has heard instead (corrected to the term when the term is expected). */
  heardAs: string[];
  /** Seeded into the Narrator's pronunciation notebook (in this order; spoken forms start empty there). */
  narratorSeed?: boolean;
}

export const PROTECTED_TERMS: readonly ProtectedTerm[] = [
  { term: 'Francis Pwavwe', respelling: '', hints: ['Pwavwe'], heardAs: [], narratorSeed: true },
  { term: 'The Pwavwe Papers', respelling: '', hints: ['Pwavwe Papers'], heardAs: [], narratorSeed: true },
  { term: 'Indigen World', respelling: '', hints: ['Indigen'], heardAs: ['Within World', 'Indie Gen World', 'Indigent World', 'Indigene World'], narratorSeed: true },
  { term: 'Kasem', respelling: '', hints: [], heardAs: ['Casa', 'Kassa', 'Kasam', 'Kassem'], narratorSeed: true },
  { term: 'University of Cape Coast', respelling: '', hints: ['Cape Coast'], heardAs: [], narratorSeed: true },
  { term: 'Pwavwe', respelling: '', hints: [], heardAs: [] },
  { term: 'AZ Studio', respelling: 'A Z Studio', hints: ['AZ'], heardAs: ['A Studio', 'Az Studio', 'Ay Zed Studio', 'AC Studio'] },
  { term: 'UCC SRC', respelling: 'U C C, S R C', hints: ['SRC'], heardAs: ['UCCRC', 'UCC RC', 'UCSRC', 'UC SRC'] },
  { term: 'UCC', respelling: 'U C C', hints: [], heardAs: [] },
  { term: 'GTHRC', respelling: 'G T H R C', hints: [], heardAs: [] },
  { term: 'Obaapaz', respelling: '', hints: [], heardAs: [] },
  { term: 'Luban', respelling: '', hints: [], heardAs: [] },
  { term: 'Nakben', respelling: '', hints: [], heardAs: [] },
  { term: 'Bright Consult', respelling: '', hints: [], heardAs: [] },
  { term: 'Lyria', respelling: '', hints: [], heardAs: [] },
];

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const key = (s: string) => tokenize(s).map((t) => t.norm).join(' ');

/** Shared terms plus per-project extras, deduplicated (first spelling wins, case-insensitively). */
export function protectedTermList(extras: readonly string[] = [], opts: { shared?: boolean } = {}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...extras, ...(opts.shared === false ? [] : PROTECTED_TERMS.map((p) => p.term))]) {
    const c = clean(t);
    const k = key(c);
    if (c.length < 2 || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/**
 * Custom vocabulary for transcription: the shared list (terms, their words and hints) and the project's own
 * terms, deduplicated and capped. Shared terms come first so a long project list never pushes them out.
 */
export function transcriptionVocabulary(extras: readonly string[] = [], cap = 100): string[] {
  const shared = PROTECTED_TERMS.flatMap((p) => [p.term, ...p.hints, ...(tokenize(p.term).length > 1 ? p.term.split(/\s+/).filter((w) => w.length > 2 && !/^(?:the|of|and)$/i.test(w)) : [])]);
  const own = extras.flatMap((t) => [t, ...(t.trim().split(/\s+/).length > 1 ? t.trim().split(/\s+/).filter((w) => w.length > 2) : [])]);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of [...shared, ...own]) {
    const c = clean(v);
    const k = c.toLowerCase();
    if (c.length < 2 || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= cap) break;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Applies speech respellings to the text sent to a voice (never to captions or the visible script). Per-project
 * respellings win over shared ones; a term is matched as whole words, case-insensitively.
 */
export function applySpeechRespellings(text: string, extra: readonly { term: string; sayAs: string }[] = []): string {
  const pairs = [...extra.filter((p) => p.term.trim() && p.sayAs.trim()).map((p) => ({ term: p.term.trim(), sayAs: p.sayAs.trim() })), ...PROTECTED_TERMS.filter((p) => p.respelling).map((p) => ({ term: p.term, sayAs: p.respelling }))];
  const seen = new Set<string>();
  // Longest terms first, so "UCC SRC" is respelled before "UCC".
  const ordered = pairs.filter((p) => !seen.has(p.term.toLowerCase()) && seen.add(p.term.toLowerCase())).sort((a, b) => b.term.length - a.term.length);
  let out = text;
  for (const p of ordered) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p.term).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu'), p.sayAs);
  return out;
}

export interface Mishearing {
  term: string;
  /** Normalised heard words (see `normalizeWord`). */
  heard: string[];
}

/** Known mishearings of the given terms (shared list), as normalised word sequences. */
export function mishearingsFor(terms: readonly string[]): Mishearing[] {
  const wanted = new Set(terms.map((t) => key(t)));
  return PROTECTED_TERMS.filter((p) => wanted.has(key(p.term))).flatMap((p) => p.heardAs.map((h) => ({ term: p.term, heard: tokenize(h).map((t) => t.norm) })).filter((m) => m.heard.length > 0));
}

/** Shared terms the reference script uses (so a reconciled transcript protects them without being told). */
export function sharedTermsIn(reference: string | null | undefined): string[] {
  if (!reference?.trim()) return [];
  const words = ` ${tokenize(reference).map((t) => t.norm).join(' ')} `;
  return PROTECTED_TERMS.map((p) => p.term).filter((t) => words.includes(` ${key(t)} `));
}

/**
 * Corrects known mishearings of expected terms in a list of heard words (e.g. "Casa" → "Kasem" when Kasem is
 * expected). Matching is on whole normalised words; the corrected word keeps the first heard word's timing.
 */
export function correctMishearings<W extends { text: string; start: number; end: number }>(words: readonly W[], terms: readonly string[]): { words: W[]; corrected: { heard: string; term: string; start: number }[] } {
  const list = mishearingsFor(terms).sort((a, b) => b.heard.length - a.heard.length);
  const corrected: { heard: string; term: string; start: number }[] = [];
  if (!list.length) return { words: [...words], corrected };
  const norms = words.map((w) => normalizeWord(w.text));
  const out: W[] = [];
  for (let i = 0; i < words.length; i++) {
    const hit = list.find((m) => m.heard.every((h, k) => norms[i + k] === h));
    if (!hit) {
      out.push(words[i]!);
      continue;
    }
    const span = words.slice(i, i + hit.heard.length);
    const punct = /[,.;:!?]+$/.exec(span[span.length - 1]!.text)?.[0] ?? '';
    out.push({ ...span[0]!, text: `${hit.term}${punct}`, end: span[span.length - 1]!.end });
    corrected.push({ heard: span.map((w) => w.text).join(' '), term: hit.term, start: span[0]!.start });
    i += hit.heard.length - 1;
  }
  return { words: out, corrected };
}
