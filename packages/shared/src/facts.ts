import { allFacts, isConfirmed, type LinkAdDoc } from './linkad';
import { finding, type FinalFinding } from './final-inspection';
import { editDistance, wordSimilarity } from './text-align';

/**
 * Fact-check of the final cut. Adverts have gone out with details wrong: a take said a price wrong ("450" heard as
 * "for 150"), the aligner mangled a phone number read out digit by digit. A project keeps its approved facts
 * (prices, phone numbers, dates, links and handles — typed in the Short Ads workspace, or the confirmed facts of a
 * Link to Ad); `checkFacts` reads the final inspection's OCR text and transcript, normalises currency, digit
 * groups, spoken numbers ("four hundred and fifty"), digit-by-digit phone numbers and dates, and reports figures
 * that match no approved fact (with the closest one) and approved facts that appear wrong.
 */

export const FACT_FIGURE_KINDS = ['price', 'phone', 'date', 'url', 'number'] as const;
export type FactFigureKind = (typeof FACT_FIGURE_KINDS)[number];
export const FACT_FIGURE_LABELS: Record<FactFigureKind, string> = { price: 'Price', phone: 'Phone number', date: 'Date', url: 'Link or handle', number: 'Other number' };

export interface ApprovedFact {
  id: string;
  kind: FactFigureKind;
  /** As it should read or be said, e.g. "GH₵450", "024 123 4567", "12 November", "az-studio.web.app". */
  value: string;
  /** What it is ("Price of the honey jar"). */
  label: string;
}

export interface Figure {
  kind: FactFigureKind;
  /** As found in the text. */
  raw: string;
  /** Comparable form: amount, national phone digits, MM-DD, bare host/handle. */
  key: string;
  amount: number | null;
}

// ---------------------------------------------------------------------------
// Spoken numbers
// ---------------------------------------------------------------------------

const UNITS: Record<string, number> = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 };
const SUFFIX = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');

const lower = (w: string) => w.toLowerCase().replace(/[^a-z-]/g, '');
const isNumberWord = (w: string) => {
  const l = lower(w);
  return l in UNITS || l in TEENS || l in TENS || l in SCALES || l === 'double' || l === 'triple' || /^(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(?:one|two|three|four|five|six|seven|eight|nine)$/.test(l);
};

/** Value of a run of cardinal number words ("four hundred and fifty", "one thousand two hundred", "four fifty"). */
function cardinal(words: string[]): number | null {
  let total = 0;
  let current = 0;
  const vals: number[] = [];
  for (const raw of words) {
    const w = lower(raw);
    if (w === 'and') continue;
    const hyph = /^(\w+)-(\w+)$/.exec(w);
    if (hyph && hyph[1]! in TENS && hyph[2]! in UNITS) {
      current += TENS[hyph[1]!]! + UNITS[hyph[2]!]!;
      vals.push(-1);
      continue;
    }
    if (w in UNITS || w in TEENS || w in TENS) {
      const v = UNITS[w] ?? TEENS[w] ?? TENS[w]!;
      // "four fifty" (a unit or teen followed by tens without "hundred") is said for 450; "nineteen ninety" for 1990.
      const prev = vals[vals.length - 1];
      if (prev !== undefined && prev >= 0 && prev < 20 && v >= 10 && current === prev) current = prev * 100 + v;
      else if (prev !== undefined && prev >= 0 && (prev < 10 || (prev < 20 && v < 10))) return null; // "two one": not one number
      else current += v;
      vals.push(v);
      continue;
    }
    if (w in SCALES) {
      const s = SCALES[w]!;
      if (s === 100) current = (current || 1) * 100;
      else {
        total += (current || 1) * s;
        current = 0;
      }
      vals.push(-1);
      continue;
    }
    return null;
  }
  return total + current;
}

/**
 * Rewrites spoken numbers as digits: digit-by-digit sequences ("zero two four, one two three", "double four")
 * become one digit string, cardinal numbers become their value, ordinals become "12th". Other words are kept.
 */
export function spokenNumbersToDigits(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const punct = (w: string) => /[,.;:!?]+$/.exec(w)?.[0] ?? '';
  const bare = (w: string) => w.replace(/[,.;:!?]+$/, '');
  const digitish = (w: string | undefined) => w !== undefined && (lower(bare(w)) in UNITS || /^\d$/.test(bare(w)));
  const repeat = (w: string) => lower(w) === 'double' || lower(w) === 'triple';
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    const l = lower(w);
    const ord = /^(twenty|thirty)-(\w+)$/.exec(l);
    if (l in ORDINALS || (ord && ord[2]! in ORDINALS)) {
      const n = ord ? TENS[ord[1]!]! + ORDINALS[ord[2]!]! : ORDINALS[l]!;
      out.push(`${n}${SUFFIX(n)}${punct(w)}`);
      i++;
      continue;
    }
    // "oh", "double" and "triple" start a number only when a digit follows.
    const starts = isNumberWord(w) && (!(l === 'oh' || repeat(w)) || digitish(words[i + 1]));
    if (!starts) {
      out.push(w);
      i++;
      continue;
    }
    const run: string[] = [];
    let j = i;
    let trailing = '';
    while (j < words.length) {
      const x = words[j]!;
      const ok = isNumberWord(bare(x)) || /^\d$/.test(bare(x)) || (lower(x) === 'and' && run.length > 0 && words[j + 1] !== undefined && isNumberWord(bare(words[j + 1]!)));
      if (!ok) break;
      run.push(bare(x));
      trailing = punct(x);
      j++;
      // A comma between digit-by-digit groups does not end a phone number; anywhere else punctuation ends the number.
      const digitRun = run.every((r) => digitish(r) || repeat(r));
      if (trailing && !(digitRun && digitish(words[j]))) break;
    }
    const digitRun = run.every((r) => digitish(r) || repeat(r));
    let value: string | null = null;
    if (digitRun && run.filter((r) => !repeat(r)).length >= 3) {
      let digits = '';
      for (let k = 0; k < run.length; k++) {
        const r = run[k]!;
        const d = (x: string) => (/^\d$/.test(x) ? x : String(UNITS[lower(x)] ?? ''));
        if (repeat(r) && run[k + 1] !== undefined) {
          digits += d(run[k + 1]!).repeat(lower(r) === 'double' ? 2 : 3);
          k++;
        } else digits += d(r);
      }
      value = digits;
    } else if (!run.some((r) => /^\d$/.test(r))) {
      const v = cardinal(run);
      value = v === null ? null : String(v);
    }
    if (value === null) {
      out.push(...words.slice(i, j));
    } else out.push(`${value}${trailing}`);
    i = j;
  }
  return out.join(' ');
}

// ---------------------------------------------------------------------------
// Figures in text
// ---------------------------------------------------------------------------

const CURRENCY = '(?:GH[₵¢S]|GH₵|₵|¢|\\$|€|£|₦|USD|GHS|EUR|GBP|NGN|KES|ZAR)';
const AMOUNT = '\\d{1,3}(?:[,\\s]\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?';
const MONEY_A = new RegExp(`${CURRENCY}\\s?(${AMOUNT})`, 'gi');
const MONEY_B = new RegExp(`(${AMOUNT})\\s?(?:cedis?|ghana cedis|pesewas|dollars?|euros?|pounds?|naira|usd|ghs|eur|gbp)\\b`, 'gi');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_A = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, 'gi');
const DATE_B = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
const DATE_C = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b|\b(20\d{2})-(\d{2})-(\d{2})\b/g;
const URL_RE = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:com|org|net|app|io|me|gh|co|uk|edu|gov|info|biz|africa|store|shop|online|site|dev|ai)\b(?:\/[\w\-./]*)?/gi;
const HANDLE_RE = /(?<![\w.])@[a-z0-9_](?:[a-z0-9_.]{1,28}[a-z0-9_])?/gi;
const PHONE_RE = /\+?\(?\d[\d \t().-]{5,}\d/g;
const BARE = /(?<![\d.,])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])|(?<![\d.,])\d+(?:\.\d+)?(?![\d,])/g;

const amountOf = (s: string) => {
  const n = Number(s.replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const fmtAmount = (n: number) => String(Math.round(n * 100) / 100);

/** National phone digits (country code and trunk zero removed), compared on the last nine digits. */
export function phoneKey(s: string): string {
  let d = s.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  return d.length > 9 ? d.slice(-9) : d.replace(/^0+/, '');
}

export const urlKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/^@/, '')
    .replace(/[/.]+$/, '')
    .trim();

function isPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  const groups = raw.split(/[^\d]+/).filter(Boolean);
  return digits.length >= 9 && digits.length <= 15 && groups.length <= 5 && groups.some((g) => g.length >= 3);
}

/** Every price, phone number, date, link/handle and other number in a text (spoken numbers rewritten as digits first). */
export function extractFigures(textIn: string, opts: { spoken?: boolean } = {}): (Figure & { index: number })[] {
  let text = opts.spoken ? spokenNumbersToDigits(textIn) : textIn;
  // Spoken links: "az studio dot web dot app" → "studio.web.app"; "slash" → "/".
  if (opts.spoken) text = text.replace(/\s+dot\s+(?=[a-z0-9])/gi, '.').replace(/\s+slash\s+/gi, '/');
  const out: (Figure & { index: number })[] = [];
  const used: [number, number][] = [];
  const free = (a: number, b: number) => !used.some(([x, y]) => a < y && b > x);
  const take = (kind: FactFigureKind, m: RegExpMatchArray, key: string, amount: number | null) => {
    const a = m.index!;
    const b = a + m[0].length;
    if (!free(a, b)) return;
    used.push([a, b]);
    out.push({ kind, raw: m[0].trim(), key, amount, index: a });
  };
  for (const m of text.matchAll(URL_RE)) take('url', m, urlKey(m[0]), null);
  for (const m of text.matchAll(HANDLE_RE)) take('url', m, urlKey(m[0]), null);
  for (const m of text.matchAll(MONEY_A)) {
    const n = amountOf(m[1]!);
    if (n !== null) take('price', m, fmtAmount(n), n);
  }
  for (const m of text.matchAll(MONEY_B)) {
    const n = amountOf(m[1]!);
    if (n !== null) take('price', m, fmtAmount(n), n);
  }
  for (const m of text.matchAll(DATE_A)) take('date', m, `${String(MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`, null);
  for (const m of text.matchAll(DATE_B)) take('date', m, `${String(MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`, null);
  for (const m of text.matchAll(DATE_C)) {
    // Day first (as written in Ghana and the UK), or ISO.
    const [day, month] = m[4] ? [m[6]!, m[5]!] : [m[1]!, m[2]!];
    if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31) take('date', m, `${month.padStart(2, '0')}-${day.padStart(2, '0')}`, null);
  }
  for (const m of text.matchAll(PHONE_RE)) if (isPhone(m[0])) take('phone', m, phoneKey(m[0]), null);
  for (const m of text.matchAll(BARE)) {
    const n = amountOf(m[0]);
    if (n === null || n < 10) continue;
    if (Number.isInteger(n) && n >= 1900 && n <= 2100) continue; // years
    take('number', m, fmtAmount(n), n);
  }
  return out.sort((a, b) => a.index - b.index);
}

/** The comparable form of an approved fact (its first figure of the declared kind, else the first figure). */
export function approvedFigure(f: ApprovedFact): Figure | null {
  const figs = extractFigures(f.value);
  const want = (k: FactFigureKind) => (f.kind === 'number' || f.kind === 'price' ? k === 'price' || k === 'number' : k === f.kind);
  const hit = figs.find((x) => want(x.kind)) ?? null;
  if (hit) return { kind: f.kind, raw: f.value, key: hit.key, amount: hit.amount };
  if (f.kind === 'url' && f.value.trim()) return { kind: 'url', raw: f.value, key: urlKey(f.value), amount: null };
  if (f.kind === 'phone' && f.value.replace(/\D/g, '').length >= 7) return { kind: 'phone', raw: f.value, key: phoneKey(f.value), amount: null };
  return null;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export interface FactCheck {
  status: 'mismatch' | 'unapproved';
  severity: 'error' | 'warning';
  kind: FactFigureKind;
  raw: string;
  source: 'ocr' | 'transcript';
  at: number | null;
  /** The approved fact it most resembles (null when none of a comparable kind exists). */
  closest: ApprovedFact | null;
  message: string;
}

const numeric = (k: FactFigureKind) => k === 'price' || k === 'number';
const comparable = (a: FactFigureKind, b: FactFigureKind) => a === b || (numeric(a) && numeric(b));

function closeness(fig: Figure, ap: Figure): number {
  if (numeric(fig.kind) && fig.amount !== null && ap.amount !== null) return 1 - Math.min(1, Math.abs(fig.amount - ap.amount) / Math.max(fig.amount, ap.amount, 1));
  if (fig.kind === 'phone') return 1 - editDistance(fig.key, ap.key) / Math.max(fig.key.length, ap.key.length, 1);
  if (fig.kind === 'date') return fig.key.slice(0, 2) === ap.key.slice(0, 2) ? 0.8 : fig.key.slice(3) === ap.key.slice(3) ? 0.6 : 0.2;
  return wordSimilarity(fig.key.replace(/[^a-z0-9]/g, ''), ap.key.replace(/[^a-z0-9]/g, ''));
}

/** A figure close enough to an approved fact that it is most likely that fact, said or shown wrong. */
function looksLike(fig: Figure, ap: Figure): boolean {
  if (numeric(fig.kind) && fig.amount !== null && ap.amount !== null) {
    const a = fmtAmount(fig.amount).replace('.', '');
    const b = fmtAmount(ap.amount).replace('.', '');
    return editDistance(a, b) <= 1 || (a.length === b.length && editDistance(a, b) <= 2) || (fig.amount / ap.amount > 0.5 && fig.amount / ap.amount < 2);
  }
  if (fig.kind === 'phone') return editDistance(fig.key, ap.key) <= 3;
  if (fig.kind === 'date') return closeness(fig, ap) >= 0.6;
  return closeness(fig, ap) >= 0.6;
}

const matches = (fig: Figure, ap: Figure) => {
  if (numeric(fig.kind) && fig.amount !== null && ap.amount !== null) return Math.abs(fig.amount - ap.amount) < 0.005;
  if (fig.kind === 'url') return fig.key === ap.key || ap.key.endsWith(fig.key) || fig.key.endsWith(ap.key);
  return fig.key === ap.key;
};

export interface FactCheckInput {
  facts: readonly ApprovedFact[];
  /** OCR text of sampled frames. */
  ocr: readonly { t: number; text: string }[];
  /** Word-timed transcript. */
  words: readonly { text: string; start: number; end: number }[];
}

/**
 * Checks what the film shows and says against the approved facts. Nothing is reported when the project has no
 * approved facts. A figure close to an approved fact but different (a price said wrong, a digit missing from a
 * phone number) is an error; a price, phone number, date or link matching no approved fact is an error; another
 * number matching none is a warning. Years and numbers below ten are ignored.
 */
export function checkFacts(input: FactCheckInput): FactCheck[] {
  const approved = input.facts.map((f) => ({ fact: f, fig: approvedFigure(f) })).filter((x): x is { fact: ApprovedFact; fig: Figure } => Boolean(x.fig));
  if (!approved.length) return [];
  const found: (Figure & { source: FactCheck['source']; at: number | null })[] = [];
  for (const o of input.ocr) for (const f of extractFigures(o.text)) found.push({ ...f, source: 'ocr', at: o.t });
  if (input.words.length) {
    // Spoken figures: the transcript as one text, each figure timed by the word it starts in.
    let text = '';
    const starts: { at: number; time: number }[] = [];
    for (const w of input.words) {
      starts.push({ at: text.length, time: w.start });
      text += `${w.text} `;
    }
    const converted = spokenTimed(text, starts);
    for (const f of extractFigures(converted.text)) found.push({ ...f, source: 'transcript', at: converted.timeAt(f.index) });
  }
  const seen = new Set<string>();
  const out: FactCheck[] = [];
  for (const fig of found) {
    const id = `${fig.source}|${fig.kind}|${fig.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const pool = approved.filter((a) => comparable(fig.kind, a.fig.kind));
    if (pool.some((a) => matches(fig, a.fig))) continue;
    // A bare number that is part of an approved phone number, date or link is that fact, not a new figure.
    if (fig.kind === 'number' && approved.some((a) => !numeric(a.fig.kind) && a.fig.key.includes(fig.key))) continue;
    const best = pool.map((a) => ({ a, c: closeness(fig, a.fig) })).sort((x, y) => y.c - x.c)[0] ?? null;
    const where = fig.source === 'ocr' ? `On screen${fig.at !== null ? ` at ${fig.at.toFixed(1)} s` : ''}` : `Spoken${fig.at !== null ? ` at ${fig.at.toFixed(1)} s` : ''}`;
    const what = FACT_FIGURE_LABELS[fig.kind].toLowerCase();
    if (best && looksLike(fig, best.a.fig)) {
      out.push({ status: 'mismatch', severity: 'error', kind: fig.kind, raw: fig.raw, source: fig.source, at: fig.at, closest: best.a.fact, message: `${where}: “${fig.raw}” does not match the approved ${FACT_FIGURE_LABELS[best.a.fact.kind].toLowerCase()} “${best.a.fact.value}”${best.a.fact.label ? ` (${best.a.fact.label})` : ''} — the approved fact appears wrong here.` });
    } else {
      out.push({ status: 'unapproved', severity: fig.kind === 'number' ? 'warning' : 'error', kind: fig.kind, raw: fig.raw, source: fig.source, at: fig.at, closest: best?.a.fact ?? null, message: `${where}: ${what} “${fig.raw}” matches no approved fact${best ? ` (closest: “${best.a.fact.value}”${best.a.fact.label ? `, ${best.a.fact.label}` : ''})` : ''}.` });
    }
  }
  return out;
}

/** Spoken numbers rewritten as digits, keeping a map from positions in the new text back to word times. */
function spokenTimed(text: string, starts: { at: number; time: number }[]): { text: string; timeAt: (index: number) => number | null } {
  // Convert word by word in windows so positions stay traceable: each original word's start maps to its time.
  const words = text.split(' ').filter((w) => w.length);
  const pieces: { text: string; time: number }[] = [];
  let k = 0;
  while (k < words.length) {
    // Grow a run of number words (and "and"/"double"/"dot") so a spoken figure converts as one.
    let j = k;
    while (j < words.length && (isNumberWord(words[j]!) || /^\d/.test(words[j]!) || ((lower(words[j]!) === 'and' || lower(words[j]!) === 'dot') && j > k))) j++;
    if (j === k) j = k + 1;
    pieces.push({ text: spokenNumbersToDigits(words.slice(k, j).join(' ')), time: starts[k]?.time ?? 0 });
    k = j;
  }
  let out = '';
  const marks: { at: number; time: number }[] = [];
  for (const p of pieces) {
    marks.push({ at: out.length, time: p.time });
    out += `${p.text} `;
  }
  return {
    text: out,
    timeAt: (index) => {
      let t: number | null = null;
      for (const m of marks) if (m.at <= index) t = m.time;
      return t === null ? null : Math.round(t * 100) / 100;
    },
  };
}

/** Fact-check results as final-inspection findings (errors block export unless overridden). */
export function factFindings(checks: readonly FactCheck[]): FinalFinding[] {
  return checks.map((c) => finding('fact_mismatch', c.severity, c.message.slice(0, 400), c.source === 'ocr' ? 'ocr' : 'transcript', { startSec: c.at }));
}

// ---------------------------------------------------------------------------
// Where approved facts come from
// ---------------------------------------------------------------------------

let factSeq = 0;
export const factId = () => `fact_${Date.now().toString(36)}${(factSeq = (factSeq + 1) % 1000).toString(36)}`;

/** Approved facts in a Short Ads draft (malformed entries dropped). */
export function normalizeFacts(raw: unknown): ApprovedFact[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === 'object')
    .map((f) => ({ id: String(f.id ?? factId()).slice(0, 40), kind: (FACT_FIGURE_KINDS as readonly string[]).includes(String(f.kind)) ? (f.kind as FactFigureKind) : 'number', value: String(f.value ?? '').slice(0, 120), label: String(f.label ?? '').slice(0, 120) }))
    .filter((f) => f.value.trim())
    .slice(0, 40);
}

/** The confirmed facts of a Link to Ad (prices, phone numbers, dates, links found in each fact's wording). */
export function factsFromLinkAd(doc: Pick<LinkAdDoc, 'source' | 'userFacts' | 'confirmations'>): ApprovedFact[] {
  const out: ApprovedFact[] = [];
  for (const f of allFacts(doc)) {
    if (!isConfirmed(doc, f)) continue;
    const text = [f.currency && f.value ? `${f.currency}${f.value}` : f.value ?? '', f.text].filter(Boolean).join(' · ');
    for (const fig of extractFigures(text)) {
      if (out.some((o) => o.kind === fig.kind && approvedFigure(o)?.key === fig.key)) continue;
      out.push({ id: `${f.id}_${out.length}`.slice(0, 40), kind: fig.kind, value: fig.raw, label: f.text.slice(0, 120) });
    }
  }
  return out.slice(0, 60);
}

/** Every approved fact of a project: the Short Ads list and the confirmed facts of a Link to Ad. */
export function projectApprovedFacts(project: { ad?: { facts?: unknown } | null; linkad?: Pick<LinkAdDoc, 'source' | 'userFacts' | 'confirmations'> | null } | null | undefined): ApprovedFact[] {
  if (!project) return [];
  const own = normalizeFacts(project.ad?.facts);
  let linked: ApprovedFact[];
  try {
    linked = project.linkad?.source && project.linkad.userFacts && project.linkad.confirmations ? factsFromLinkAd(project.linkad) : [];
  } catch {
    linked = [];
  }
  return [...own, ...linked];
}
