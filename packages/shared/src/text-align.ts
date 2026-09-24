/**
 * Word-level text alignment shared by dialogue validation (screenplay vs. transcript) and lyric
 * synchronisation (authoritative lyrics vs. transcribed vocals).
 *
 * Matching uses a *normalised key* only: the original text of every word is kept untouched, so
 * spelling, diacritics and punctuation supplied by the creator are never rewritten.
 */

/** Letters used by Ghanaian and other West African orthographies, folded to ASCII for matching only. */
const FOLD: Record<string, string> = {
  ɛ: 'e',
  Ɛ: 'e',
  ɔ: 'o',
  Ɔ: 'o',
  ɩ: 'i',
  Ɩ: 'i',
  ɪ: 'i',
  ʋ: 'u',
  Ʋ: 'u',
  ʊ: 'u',
  ŋ: 'ng',
  Ŋ: 'ng',
  ɖ: 'd',
  Ɖ: 'd',
  ƒ: 'f',
  Ƒ: 'f',
  ɣ: 'g',
  Ɣ: 'g',
  ɲ: 'ny',
  ǝ: 'e',
  ə: 'e',
  ʒ: 'z',
  ß: 'ss',
};

const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  hundred: '100',
  thousand: '1000',
};

/** Lower-case letters and digits only, with accents and West African letters folded. */
function fold(word: string): string {
  let s = word.normalize('NFKD').replace(/\p{M}+/gu, '');
  s = [...s].map((ch) => FOLD[ch] ?? ch).join('');
  return s.toLowerCase().replace(/[’'`´]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Matching key for a word: lower-case, accents and West African letters folded, punctuation removed. */
export function normalizeWord(word: string): string {
  const s = fold(word);
  return NUMBER_WORDS[s] ?? s;
}

export interface Token {
  /** Exactly as written in the source text (punctuation included). */
  raw: string;
  /** Matching key (see normalizeWord). Empty for punctuation-only tokens. */
  norm: string;
}

/** Splits text into word tokens on whitespace and dashes used as separators; raw text is preserved. */
export function tokenize(text: string): Token[] {
  return text
    .split(/\s+|(?<=\p{L})[—–](?=\p{L})/u)
    .filter((t) => t.length > 0)
    .map((raw) => ({ raw, norm: normalizeWord(raw) }))
    .filter((t) => t.norm.length > 0);
}

/** Levenshtein distance (iterative, two rows). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** Similarity of two normalised words in [0, 1]. */
export function wordSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return Math.max(0, 1 - editDistance(a, b) / Math.max(a.length, b.length));
}

export type AlignOp =
  /** Expected word found (similarity ≥ matchThreshold). */
  | { op: 'match'; e: number; d: number; sim: number }
  /** Expected word heard as a different word. */
  | { op: 'substitute'; e: number; d: number; sim: number }
  /** Expected word not heard. */
  | { op: 'delete'; e: number }
  /** Heard word that is not in the expected text. */
  | { op: 'insert'; d: number };

export interface AlignOptions {
  /** Similarity at or above which two words count as the same word. */
  matchThreshold?: number;
  /** Leading/trailing unmatched detected words cost nothing (lyrics inside a longer song). */
  freeDetectedEnds?: boolean;
}

/**
 * Global (Needleman–Wunsch) alignment of expected vs. detected word keys. Returns the edit script in
 * order. O(n·m) memory is fine for dialogue and song lyrics (a few thousand words at most).
 */
export function alignWords(expected: string[], detected: string[], opts: AlignOptions = {}): AlignOp[] {
  const th = opts.matchThreshold ?? 0.75;
  const n = expected.length;
  const m = detected.length;
  const GAP_E = -1; // expected word missing
  const GAP_D = -0.7; // extra detected word (ASR noise, ad-libs, backing vocals)
  const score = (i: number, j: number) => {
    const s = wordSimilarity(expected[i]!, detected[j]!);
    return s >= th ? 2 * s : s >= 0.5 ? -0.4 + s * 0.4 : -1.2;
  };
  const W = m + 1;
  const dp = new Float64Array((n + 1) * W);
  const tb = new Uint8Array((n + 1) * W); // 1 diag, 2 up (delete), 3 left (insert)
  for (let i = 1; i <= n; i++) {
    dp[i * W] = dp[(i - 1) * W]! + GAP_E;
    tb[i * W] = 2;
  }
  for (let j = 1; j <= m; j++) {
    dp[j] = opts.freeDetectedEnds ? 0 : dp[j - 1]! + GAP_D;
    tb[j] = 3;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = dp[(i - 1) * W + j - 1]! + score(i - 1, j - 1);
      const up = dp[(i - 1) * W + j]! + GAP_E;
      const left = dp[i * W + j - 1]! + (opts.freeDetectedEnds && i === n ? 0 : GAP_D);
      let best = diag;
      let dir = 1;
      if (up > best) {
        best = up;
        dir = 2;
      }
      if (left > best) {
        best = left;
        dir = 3;
      }
      dp[i * W + j] = best;
      tb[i * W + j] = dir;
    }
  }
  const ops: AlignOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const dir = i > 0 && j > 0 ? tb[i * W + j]! : i > 0 ? 2 : 3;
    if (dir === 1) {
      const sim = wordSimilarity(expected[i - 1]!, detected[j - 1]!);
      ops.push(sim >= th ? { op: 'match', e: i - 1, d: j - 1, sim } : { op: 'substitute', e: i - 1, d: j - 1, sim });
      i--;
      j--;
    } else if (dir === 2) {
      ops.push({ op: 'delete', e: i - 1 });
      i--;
    } else {
      ops.push({ op: 'insert', d: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}

/** Rough syllable count used for timing estimates when no audio exists (works for Latin-script languages). */
export function countSyllables(word: string): number {
  const w = fold(word);
  if (!w) return 0;
  const digits = (w.match(/\d/g) ?? []).length;
  const letters = w.replace(/\d+/g, '');
  const groups = letters.match(/[aeiouy]+/g)?.length ?? 0;
  const silentE = /[^aeiouy]e$/.test(letters) && groups > 1 ? 1 : 0;
  return Math.max(1, groups - silentE + Math.ceil(digits * 1.3));
}

/** Removes a leading byte-order mark (files saved by Windows editors often start with one). */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
export const round1 = (n: number) => Math.round(n * 10) / 10;
