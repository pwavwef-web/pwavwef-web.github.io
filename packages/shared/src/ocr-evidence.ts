import { wordSimilarity } from './text-align';

/**
 * Let OCR settle text and logo findings. Reviewing models see text that is not there (subtitles inferred from
 * speech they hear, "brand text" on a plain surface). Text and logo recognition (Cloud Vision TEXT / LOGO
 * detection) on frames of the same file is the evidence: a model's text, subtitle or logo finding counts only when
 * recognition confirms it; an unconfirmed finding is kept as minor with a note. When recognition is unavailable
 * the finding stands as the model gave it (no evidence either way).
 */

/** Text and logos recognised on sampled frames. */
export interface TextEvidence {
  frames: number;
  words: { text: string; frames: number; heightPct: number }[];
  logos: { name: string; score: number; frames: number }[];
  /** False when only text detection ran (a logo finding is then settled by readable brand text alone). */
  logoChecked?: boolean;
}

const wordKey = (t: string) => t.normalize('NFC').replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();

/** Summarises per-frame recognition into words (letters only, deduplicated) and logos, with how many frames showed each. */
export function summarizeTextEvidence(frames: { text: { text: string; box: { h: number } | null }[]; logos?: { name: string; score: number }[] }[], opts: { logoChecked?: boolean; ignore?: readonly string[] } = {}): TextEvidence {
  const ignore = new Set((opts.ignore ?? []).flatMap((t) => t.split(/\s+/)).map(wordKey).filter(Boolean));
  const words = new Map<string, { frames: Set<number>; heightPct: number }>();
  const logos = new Map<string, { frames: Set<number>; score: number }>();
  frames.forEach((f, i) => {
    for (const t of f.text) {
      const key = wordKey(t.text);
      if (!key || ignore.has(key)) continue;
      const w = words.get(key) ?? { frames: new Set<number>(), heightPct: 0 };
      w.frames.add(i);
      w.heightPct = Math.max(w.heightPct, Math.round((t.box?.h ?? 0) * 1000) / 10);
      words.set(key, w);
    }
    for (const l of f.logos ?? []) {
      const key = l.name.trim();
      if (!key) continue;
      const g = logos.get(key) ?? { frames: new Set<number>(), score: 0 };
      g.frames.add(i);
      g.score = Math.max(g.score, l.score);
      logos.set(key, g);
    }
  });
  return {
    frames: frames.length,
    words: [...words].map(([text, w]) => ({ text, frames: w.frames.size, heightPct: w.heightPct })).sort((a, b) => b.frames - a.frames).slice(0, 20),
    logos: [...logos].map(([name, g]) => ({ name, score: Math.round(g.score * 100) / 100, frames: g.frames.size })).sort((a, b) => b.score - a.score).slice(0, 10),
    ...(opts.logoChecked !== undefined ? { logoChecked: opts.logoChecked } : {}),
  };
}

/** Readable words: three or more letters, read on two frames (or large on one). Stray letters are noise. */
export function readableWords(e: TextEvidence): TextEvidence['words'] {
  return e.words.filter((w) => w.text.replace(/\p{N}/gu, '').length >= 3 && (w.frames >= 2 || w.heightPct >= 3));
}

/** Logos recognised with reasonable confidence. */
export function recognisedLogos(e: TextEvidence): TextEvidence['logos'] {
  return e.logos.filter((l) => l.score >= 0.5);
}

export type OcrFindingKind = 'text' | 'logo';

export interface OcrVerdict {
  /** null: no evidence (recognition unavailable) — the finding stands as given. */
  confirmed: boolean | null;
  basis: string;
}

/** True when a finding is about a logo, watermark or brand mark rather than plain text. */
export const mentionsLogo = (s: string) => /\b(?:logos?|watermarks?|emblems?|brand(?:ed|ing)?|trademarks?)\b/i.test(s);

/**
 * Whether recognition confirms a text or logo finding. Text: a readable word (or the quoted text) was read.
 * Logo: a logo was recognised, or readable text (a brand name is text) was read.
 */
export function ocrConfirms(kind: OcrFindingKind, evidence: TextEvidence | null | undefined, opts: { quoted?: string | null } = {}): OcrVerdict {
  if (!evidence || !evidence.frames) return { confirmed: null, basis: 'no text recognition' };
  const words = readableWords(evidence);
  const logos = recognisedLogos(evidence);
  if (kind === 'logo' && logos.length) return { confirmed: true, basis: `logo recognised: ${logos.map((l) => l.name).join(', ')}` };
  const quoted = opts.quoted ? wordKey(opts.quoted) : '';
  if (quoted.length >= 3 && evidence.words.some((w) => w.text.length >= 3 && (quoted.includes(w.text) || wordSimilarity(w.text, quoted) >= 0.7))) return { confirmed: true, basis: `read “${opts.quoted!.slice(0, 40)}”` };
  if (words.length) return { confirmed: true, basis: `readable text: ${words.slice(0, 4).map((w) => `“${w.text}”`).join(', ')}` };
  const what = kind === 'logo' ? (evidence.logoChecked === false ? 'no readable text (logo detection not run)' : 'no logo or readable text') : 'no readable text';
  return { confirmed: false, basis: `${what} recognised on ${evidence.frames} sampled frame${evidence.frames === 1 ? '' : 's'}` };
}

/** The note added to a finding recognition did not confirm. */
export function unconfirmedNote(note: string, verdict: OcrVerdict, max = 300): string {
  return `${note} (not confirmed: ${verdict.basis})`.slice(0, max);
}

/**
 * The shared rule: a finding recognition does not confirm becomes minor with a note; a confirmed one, or one with no
 * evidence, is unchanged. `minor` is the caller's lowest severity ('minor', 'info'…).
 */
export function settleByOcr<F extends { severity: string }>(finding: F, kind: OcrFindingKind, evidence: TextEvidence | null | undefined, opts: { minor: F['severity']; note: (f: F) => string; withNote: (f: F, note: string) => F; quoted?: string | null }): F {
  const v = ocrConfirms(kind, evidence, { quoted: opts.quoted });
  if (v.confirmed !== false) return finding;
  return { ...opts.withNote(finding, unconfirmedNote(opts.note(finding), v)), severity: opts.minor };
}
