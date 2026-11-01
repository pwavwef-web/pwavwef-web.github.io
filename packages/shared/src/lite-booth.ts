import { z } from 'zod';
import { estimateNarrationSec, stableHash, type LiteScene, type LiteSpec, type Pronunciation } from './lite';
import { NOISE_REDUCTION_LEVELS, type NoiseReduction, type RecordingAnalysis, type RecordingIssue } from './narrator';
import { chunkText, splitNarrationSentences } from './narrator-text';
import { PROTECTED_TERMS } from './protected-terms';

/**
 * Film Studio Lite recording booth. The speech models do not speak Kasem, so Kasem narration is recorded by a
 * person: each scene's narration paragraph is split into lines (sentences), shown one at a time in a prompter,
 * recorded in several takes, checked, and the director picks one take per line. "Use for scene" joins the picked
 * takes (with short pauses) into one recording that goes through the ordinary recorded-narration path
 * (`lite.narration` `align_scene`) — the only paid step, priced before it starts like the rest of Lite.
 *
 * Booth state lives in `projects/{id}/boothScenes/{sceneId}` (written by the API only, read by the owner).
 * Takes are ordinary uploaded audio assets (createUpload → storage → azsOnUpload validation).
 */

/** The booth's transcription language (Kasem, ISO 639-3). */
export const BOOTH_LANGUAGE = 'xsm';

export const BOOTH_LIMITS = {
  /** A line longer than this is split at clauses so it fits the prompter and one breath. */
  lineChars: 220,
  linesPerScene: 120,
  takesPerLine: 12,
  /** Longest single take accepted (s) and its largest file. */
  takeMaxSec: 90,
  takeMaxBytes: 25 * 1024 * 1024,
  pauseSec: { min: 0.15, max: 2, default: 0.45 },
} as const;

/** Silence kept around the speech of each picked take when lines are joined (human takes breathe more than TTS). */
export const BOOTH_TRIM = { leadSec: 0.08, tailSec: 0.25, fadeSec: 0.01 } as const;

export interface BoothNote {
  term: string;
  sayAs: string;
  note: string;
}

export interface BoothLine {
  /** Stable while the sentence's text and its occurrence in the scene stay the same. */
  id: string;
  index: number;
  text: string;
  /** Pronunciation notes for words in this line (the film's own list, then the shared protected words). */
  notes: BoothNote[];
  /** Expected speaking time at the film's pace (s). */
  expectedSec: number;
}

export type BoothTakeVerdict = 'good' | 'check' | 'redo';

export interface BoothTakeCheck {
  verdict: BoothTakeVerdict;
  issues: RecordingIssue[];
  expectedSec: number;
  /** Measured speech ÷ expected speech (1 = as long as the line suggests). */
  lengthRatio: number | null;
}

export interface BoothTake {
  id: string;
  assetId: string;
  lineId: string;
  /** The line's text when the take was recorded (a take for an edited line is kept but marked). */
  lineText: string;
  durationSec: number;
  analysis: RecordingAnalysis;
  check: BoothTakeCheck;
  createdAt: number;
}

export interface BoothJoined {
  assetId: string;
  /** Picked take ids in line order: the same picks give the same recording (no re-join). */
  picksHash: string;
  durationSec: number;
  noiseReduction: NoiseReduction;
  pauseSec: number;
  lines: number;
  at: number;
}

export interface BoothSceneDoc {
  ownerUid: string;
  sceneId: string;
  language: string;
  /** Hash of the narration the lines were made from. */
  narrationHash: string;
  lines: BoothLine[];
  takes: BoothTake[];
  /** lineId → take id. */
  picks: Record<string, string>;
  joined: BoothJoined | null;
  updatedAt: number;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text: string, term: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term.trim()).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu').test(text);

export const boothNarrationHash = (narration: string) => stableHash(clean(narration));

/** Pronunciation notes for one line: the film's own entries first, then the shared protected words it uses. */
export function lineNotes(text: string, pronunciation: readonly Pronunciation[]): BoothNote[] {
  const out: BoothNote[] = [];
  const seen = new Set<string>();
  for (const p of pronunciation) {
    if (!p.term.trim() || !hasWord(text, p.term) || seen.has(p.term.trim().toLowerCase())) continue;
    seen.add(p.term.trim().toLowerCase());
    out.push({ term: p.term.trim(), sayAs: p.sayAs.trim(), note: p.note.trim() });
  }
  for (const t of PROTECTED_TERMS) {
    if (seen.has(t.term.toLowerCase()) || !hasWord(text, t.term)) continue;
    seen.add(t.term.toLowerCase());
    out.push({ term: t.term, sayAs: t.respelling, note: 'Protected spelling — keep it exactly as written.' });
  }
  return out;
}

/** The scene's narration as prompter lines (sentences; very long ones split at clauses). */
export function boothLines(narration: string, pronunciation: readonly Pronunciation[] = [], wordsPerMinute = 140): BoothLine[] {
  const pieces = splitNarrationSentences(narration).flatMap((s) => (s.length > BOOTH_LIMITS.lineChars ? chunkText(s, BOOTH_LIMITS.lineChars) : [s]));
  const seen = new Map<string, number>();
  return pieces.slice(0, BOOTH_LIMITS.linesPerScene).map((text, index) => {
    const k = clean(text).toLowerCase();
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return { id: `l${stableHash({ k, n })}`, index, text, notes: lineNotes(text, pronunciation), expectedSec: estimateNarrationSec(text, wordsPerMinute) };
  });
}

/** Lines for a scene of a film (the film's pace and pronunciation list). */
export const sceneBoothLines = (spec: Pick<LiteSpec, 'pronunciation' | 'setup'>, scene: Pick<LiteScene, 'narration'>) => boothLines(scene.narration, spec.pronunciation, spec.setup.wordsPerMinute);

/**
 * Checks one take against its line: length (speech vs what the line needs), peak and clipping, noise floor, and the
 * silence before and after the speech. Built on the Narrator's `analyzeRecording` measurements; its enrollment
 * length limits do not apply here and are replaced by the line's own expected length.
 */
export function checkBoothTake(a: RecordingAnalysis, expectedSec: number): BoothTakeCheck {
  const issues: RecordingIssue[] = a.issues.filter((i) => i.code !== 'too_short' && i.code !== 'too_long' && i.code !== 'trailing_silence' && i.code !== 'long_pause');
  const speech = a.speechSec;
  const ratio = expectedSec > 0.3 && speech > 0 ? Math.round((speech / expectedSec) * 100) / 100 : null;
  if (ratio !== null && ratio < 0.45) issues.push({ code: 'too_short', severity: 'error', message: `Only ${speech.toFixed(1)} s of speech for a line that needs about ${expectedSec.toFixed(1)} s — the take may be cut off or missing words.` });
  else if (ratio !== null && ratio < 0.65) issues.push({ code: 'too_short', severity: 'warning', message: `Quicker than expected (${speech.toFixed(1)} s for about ${expectedSec.toFixed(1)} s). Check that every word is there.` });
  if (ratio !== null && ratio > 2.6) issues.push({ code: 'too_long', severity: 'error', message: `${speech.toFixed(1)} s of speech for a line of about ${expectedSec.toFixed(1)} s — it may contain a restart or another line.` });
  else if (ratio !== null && ratio > 1.8) issues.push({ code: 'too_long', severity: 'warning', message: `Slower than expected (${speech.toFixed(1)} s for about ${expectedSec.toFixed(1)} s). Fine if deliberate.` });
  if (a.longestPauseSec > 2) issues.push({ code: 'long_pause', severity: 'warning', message: `A ${a.longestPauseSec.toFixed(1)} s pause inside the line.` });
  if (a.leadingSilenceSec > 2) issues.push({ code: 'trailing_silence', severity: 'warning', message: `${a.leadingSilenceSec.toFixed(1)} s of silence before the first word (trimmed when the scene is joined).` });
  if (a.trailingSilenceSec > 2.5) issues.push({ code: 'trailing_silence', severity: 'warning', message: `${a.trailingSilenceSec.toFixed(1)} s of silence after the last word (trimmed when the scene is joined).` });
  if (a.peakDbfs > -0.3 && a.clippedPct <= 0.002) issues.push({ code: 'clipping', severity: 'warning', message: `Peaks reach ${a.peakDbfs} dBFS — a little lower input level leaves headroom.` });
  const verdict: BoothTakeVerdict = issues.some((i) => i.severity === 'error') ? 'redo' : issues.length ? 'check' : 'good';
  return { verdict, issues, expectedSec, lengthRatio: ratio };
}

/** A take still belongs to its line when the line reads the same as when it was recorded. */
export const takeMatchesLine = (take: Pick<BoothTake, 'lineText'>, line: Pick<BoothLine, 'text'>) => clean(take.lineText) === clean(line.text);

export interface BoothJoinPlan {
  ready: boolean;
  /** Picked takes in line order. */
  takes: BoothTake[];
  missing: BoothLine[];
  /** Picks whose line text changed since the take was recorded. */
  outdated: BoothLine[];
  picksHash: string;
}

/** What "Use for scene" would join: one picked, current take per line, in order. */
export function boothJoinPlan(doc: Pick<BoothSceneDoc, 'lines' | 'takes' | 'picks'>, opts: { noiseReduction: NoiseReduction; pauseSec: number }): BoothJoinPlan {
  const byId = new Map(doc.takes.map((t) => [t.id, t]));
  const takes: BoothTake[] = [];
  const missing: BoothLine[] = [];
  const outdated: BoothLine[] = [];
  for (const line of doc.lines) {
    const t = byId.get(doc.picks[line.id] ?? '');
    if (!t || t.lineId !== line.id) missing.push(line);
    else if (!takeMatchesLine(t, line)) outdated.push(line);
    else takes.push(t);
  }
  return { ready: doc.lines.length > 0 && !missing.length && !outdated.length, takes, missing, outdated, picksHash: stableHash({ t: takes.map((t) => t.id), n: opts.noiseReduction, p: Math.round(opts.pauseSec * 100) }) };
}

/** Reconciles stored booth state with the scene's current narration: lines are re-made, takes and picks of unchanged lines kept. */
export function refreshBoothLines<T extends Pick<BoothSceneDoc, 'lines' | 'picks' | 'narrationHash'>>(doc: T, lines: BoothLine[], narration: string): T {
  const ids = new Set(lines.map((l) => l.id));
  return { ...doc, lines, narrationHash: boothNarrationHash(narration), picks: Object.fromEntries(Object.entries(doc.picks).filter(([k]) => ids.has(k))) };
}

/** Transcription vocabulary for a booth recording: the shared protected words, then the film's names and terms. */
export { transcriptionVocabulary as boothVocabulary } from './protected-terms';

// ---------------------------------------------------------------------------
// API (`azsApi` action `liteBooth`, one `op` per operation)
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(128).regex(/^[\w-]+$/, 'Invalid id');

export const liteBoothRequestSchema = z.discriminatedUnion('op', [
  /** Makes (or refreshes) the scene's lines from its current narration. */
  z.object({ op: z.literal('open'), projectId: id, sceneId: id }),
  /** Adds an uploaded, validated audio asset as a take of a line and checks it. */
  z.object({ op: z.literal('takeAdd'), projectId: id, sceneId: id, lineId: id, assetId: id }),
  z.object({ op: z.literal('takeDelete'), projectId: id, sceneId: id, takeId: id }),
  z.object({ op: z.literal('pick'), projectId: id, sceneId: id, lineId: id, takeId: id.nullable() }),
  /** Joins the picked takes into one recording for the scene (FFmpeg in the API; no model is called). */
  z.object({ op: z.literal('useForScene'), projectId: id, sceneId: id, noiseReduction: z.enum(NOISE_REDUCTION_LEVELS).default('off'), pauseSec: z.number().min(BOOTH_LIMITS.pauseSec.min).max(BOOTH_LIMITS.pauseSec.max).default(BOOTH_LIMITS.pauseSec.default) }),
]);
export type LiteBoothRequest = z.infer<typeof liteBoothRequestSchema>;
