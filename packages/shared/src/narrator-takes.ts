import { narratorHash, type EditionSettings, type NarratorScript, type PronunciationEntry } from './narrator';
import { frameLevels, SPEECH_FRAME_DBFS } from './narrator-audio';
import type { Direction, DirectedSegment } from './narrator-direction';
import { countWords, passageSynthesisInput, spokenPassages, type FlatPassage } from './narrator-text';

/**
 * "Read as one take": an edition is narrated in as few requests as possible — normally the whole article in one
 * request, so the voice keeps one continuous delivery (no per-paragraph joins). Each passage is still its own
 * text block with its own delivery style. Only an article longer than one request can hold is split, and then
 * only at section breaks (a section longer than a take on its own is split at a paragraph break).
 *
 * Limits (verified live 2026-10-18 on Google Cloud, gemini-3.8-flash-tts): one request returns at most 16,384
 * audio tokens = 655 s at 25 tokens/s; a 1,350-word paper came back as one 7.8-min take (STOP, nothing skipped).
 * Takes are planned at a deliberately slow 140 words per minute and capped at 600 s, which keeps a margin for
 * slower voices without depending on a measured pace (so the plan — and what counts as current — is stable).
 */
export const ONE_TAKE = {
  maxTakeSec: 600,
  planWordsPerMinute: 140,
} as const;

export type ReadMode = 'passages' | 'oneTake';
export const readModeOf = (settings: Pick<EditionSettings, 'readMode'>): ReadMode => settings.readMode ?? 'passages';

export interface TakeBlock {
  /** Stable while the block starts at the same passage: `take-{firstPassageId}`. */
  key: string;
  index: number;
  passages: { passageId: string; sectionId: string | null; kind: FlatPassage['passage']['kind']; chars: number; inputHash: string; text: string; providerText: string }[];
  /** All text blocks of the take, in order (one or more per passage). */
  segments: DirectedSegment[];
  /** Which passage each segment belongs to (parallel to `segments`). */
  segmentPassage: string[];
  providerText: string;
  style: string;
  inputHash: string;
  words: number;
  plannedSec: number;
  pronunciations: { term: string; spokenAs: string }[];
}

const plannedSec = (words: number) => (words / ONE_TAKE.planWordsPerMinute) * 60;

/** Contiguous groups of `sizes` (in order) into the fewest groups of at most `max`, as evenly sized as possible. */
export function balancedPartition(sizes: number[], max: number): number[][] {
  const n = sizes.length;
  if (!n) return [];
  const total = sizes.reduce((a, b) => a + b, 0);
  const prefix = [0];
  for (const s of sizes) prefix.push(prefix[prefix.length - 1]! + s);
  const sum = (a: number, b: number) => prefix[b]! - prefix[a]!;
  for (let k = Math.max(1, Math.ceil(total / max)); k <= n; k++) {
    // best[j][i]: smallest possible largest group when the first i items form j groups.
    const best = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(Infinity));
    const cut = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(0));
    best[0]![0] = 0;
    for (let j = 1; j <= k; j++) {
      for (let i = j; i <= n; i++) {
        for (let s = j - 1; s < i; s++) {
          const v = Math.max(best[j - 1]![s]!, sum(s, i));
          if (v < best[j]![i]!) {
            best[j]![i] = v;
            cut[j]![i] = s;
          }
        }
      }
    }
    if (best[k]![n]! <= max) {
      const groups: number[][] = [];
      let i = n;
      for (let j = k; j >= 1; j--) {
        const s = cut[j]![i]!;
        groups.unshift(Array.from({ length: i - s }, (_, x) => s + x));
        i = s;
      }
      return groups;
    }
  }
  return sizes.map((_, i) => [i]);
}

/**
 * The takes of an edition read as one take. Units are sections (the opening joins the first, the closing the
 * last); units are grouped into the fewest takes that fit, split only between units; a unit longer than a take
 * is first split at paragraph breaks.
 */
export function planTakes(input: {
  script: NarratorScript;
  settings: Pick<EditionSettings, 'preset' | 'customStyle' | 'includeClosing'>;
  notebook: readonly PronunciationEntry[];
  voice: { id: string; modelId: string };
  directions?: readonly Direction[];
}): TakeBlock[] {
  const spoken = spokenPassages(input.script, input.settings.includeClosing);
  if (!spoken.length) return [];
  const prepared = spoken.map((f) => ({ f, s: passageSynthesisInput(f.passage, input.settings, input.notebook, input.voice, input.directions ?? []), words: countWords(f.passage.text) }));
  // Units: one per section; the opening and closing ride with their neighbours.
  const units: (typeof prepared)[] = [];
  let pendingOpening: typeof prepared = [];
  for (const p of prepared) {
    if (p.f.sectionId === null && p.f.passage.kind === 'opening') {
      pendingOpening.push(p);
      continue;
    }
    if (p.f.sectionId === null) {
      if (units.length) units[units.length - 1]!.push(p);
      else pendingOpening.push(p);
      continue;
    }
    const last = units[units.length - 1];
    if (last && last[last.length - 1]!.f.sectionId === p.f.sectionId) last.push(p);
    else {
      units.push([...pendingOpening, p]);
      pendingOpening = [];
    }
  }
  if (pendingOpening.length) units.push(pendingOpening);
  // A unit longer than one take is split at paragraph breaks into even pieces.
  const pieces: (typeof prepared)[] = [];
  for (const u of units) {
    const sec = u.map((p) => plannedSec(p.words));
    if (sec.reduce((a, b) => a + b, 0) <= ONE_TAKE.maxTakeSec) pieces.push(u);
    else for (const g of balancedPartition(sec, ONE_TAKE.maxTakeSec)) pieces.push(g.map((i) => u[i]!));
  }
  const groups = balancedPartition(
    pieces.map((u) => u.reduce((a, p) => a + plannedSec(p.words), 0)),
    ONE_TAKE.maxTakeSec,
  );
  return groups.map((g, index) => {
    const members = g.flatMap((i) => pieces[i]!);
    const segments: DirectedSegment[] = [];
    const segmentPassage: string[] = [];
    for (const m of members)
      for (const seg of m.s.segments) {
        segments.push({ text: seg.text, style: seg.style || m.s.style });
        segmentPassage.push(m.f.passage.id);
      }
    const applied = new Map<string, string>();
    for (const m of members) for (const a of m.s.applied) applied.set(a.term, a.spokenAs);
    const words = members.reduce((a, m) => a + m.words, 0);
    return {
      key: `take-${members[0]!.f.passage.id}`,
      index,
      passages: members.map((m) => ({ passageId: m.f.passage.id, sectionId: m.f.sectionId, kind: m.f.passage.kind, chars: m.s.providerText.length, inputHash: m.s.inputHash, text: m.f.passage.text, providerText: m.s.providerText })),
      segments,
      segmentPassage,
      providerText: members.map((m) => m.s.providerText).join('\n\n'),
      style: members[0]!.s.style,
      // A take is current only while every passage in it, its grouping and the voice/model are unchanged.
      inputHash: narratorHash({ k: 'take', p: members.map((m) => [m.f.passage.id, m.s.inputHash]) }),
      words,
      plannedSec: Math.round(plannedSec(words)),
      pronunciations: [...applied].map(([term, spokenAs]) => ({ term, spokenAs })),
    };
  });
}

/** The take each passage belongs to (passage id → take key). */
export function takeOfPassage(blocks: readonly TakeBlock[]): Map<string, TakeBlock> {
  const m = new Map<string, TakeBlock>();
  for (const b of blocks) for (const p of b.passages) m.set(p.passageId, b);
  return m;
}

/**
 * Where each passage starts and ends inside one continuous take. Boundaries are first placed by the share of
 * text before them, then moved to the nearest natural pause (the model pauses between text blocks); without a
 * pause nearby the proportional estimate is kept. Good enough for chapters and seeking — not word-exact.
 */
export function alignTakeSpans(samples: Float32Array, sampleRate: number, weights: number[]): { startSec: number; endSec: number }[] {
  const frame = 0.02;
  const levels = frameLevels(samples, sampleRate, frame);
  const total = levels.length * frame;
  let first = levels.findIndex((l) => l >= SPEECH_FRAME_DBFS);
  let last = levels.length - 1 - [...levels].reverse().findIndex((l) => l >= SPEECH_FRAME_DBFS);
  if (first < 0) {
    first = 0;
    last = levels.length - 1;
  }
  const speechStart = first * frame;
  const speechEnd = (last + 1) * frame;
  // Pauses (centre, length) of at least 0.2 s inside the speech.
  const pauses: { at: number; len: number; from: number; to: number }[] = [];
  let run = 0;
  for (let i = first; i <= last + 1; i++) {
    if (i <= last && levels[i]! < SPEECH_FRAME_DBFS) run++;
    else {
      if (run * frame >= 0.2) pauses.push({ at: (i - run / 2) * frame, len: run * frame, from: (i - run) * frame, to: i * frame });
      run = 0;
    }
  }
  const sumW = weights.reduce((a, b) => a + b, 0) || 1;
  const span = speechEnd - speechStart;
  const cuts: { from: number; to: number }[] = [];
  let acc = 0;
  let floor = speechStart;
  for (let i = 0; i < weights.length - 1; i++) {
    acc += weights[i]!;
    const guess = speechStart + (acc / sumW) * span;
    const window = Math.max(1.5, span * 0.06);
    const near = pauses.filter((p) => p.at > floor && Math.abs(p.at - guess) <= window).sort((a, b) => Math.abs(a.at - guess) / (0.5 + a.len) - Math.abs(b.at - guess) / (0.5 + b.len))[0];
    const c = near ? { from: near.from, to: near.to } : { from: Math.max(floor, guess), to: Math.max(floor, guess) };
    cuts.push(c);
    floor = c.to;
  }
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return weights.map((_, i) => ({ startSec: r3(i === 0 ? speechStart : cuts[i - 1]!.to), endSec: r3(Math.min(total, i === weights.length - 1 ? speechEnd : cuts[i]!.from)) }));
}

const normWords = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

/**
 * Passage spans from a word-timestamp transcript of the take: the heard words are aligned with each passage's
 * spoken text (longest common subsequence), a passage starts at its first matched word and ends at its last.
 * Also measures how much of the text was heard — a low share means Google skipped or garbled part of the take.
 * Verified on a live 8-minute take: all 56 passage starts found (a pause-only estimate was off by a median 4.4 s).
 */
export function alignSpansFromWords(passageTexts: string[], words: { text: string; start: number; end: number }[]): { spans: { startSec: number; endSec: number }[]; coverage: number; passagesHeard: number; heard: boolean[] } {
  const src: { w: string; p: number }[] = [];
  passageTexts.forEach((t, p) => normWords(t).forEach((w) => src.push({ w, p })));
  const heard = words.flatMap((x) => normWords(x.text).map((w) => ({ w, start: x.start, end: x.end })));
  const n = src.length;
  const m = heard.length;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  if (!n || !m) return { spans: passageTexts.map(() => ({ startSec: 0, endSec: 0 })), coverage: 0, passagesHeard: 0, heard: passageTexts.map(() => false) };
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) row[j] = src[i]!.w === heard[j]!.w ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
  }
  const first = new Array<number | null>(passageTexts.length).fill(null);
  const last = new Array<number | null>(passageTexts.length).fill(null);
  const matched = new Array<number>(passageTexts.length).fill(0);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (src[i]!.w === heard[j]!.w) {
      const p = src[i]!.p;
      if (first[p] === null) first[p] = heard[j]!.start;
      last[p] = heard[j]!.end;
      matched[p]!++;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  // Passages with no matched word get the gap between their neighbours.
  const total = heard[m - 1]!.end;
  const spans = passageTexts.map((_, p) => ({ startSec: first[p], endSec: last[p] }));
  for (let p = 0; p < spans.length; p++) {
    if (spans[p]!.startSec !== null) continue;
    const prevEnd = [...spans.slice(0, p)].reverse().find((s) => s.endSec !== null)?.endSec ?? 0;
    const nextStart = spans.slice(p + 1).find((s) => s.startSec !== null)?.startSec ?? total;
    spans[p] = { startSec: prevEnd, endSec: Math.max(prevEnd, nextStart) };
  }
  let floor = 0;
  const out = spans.map((s) => {
    const startSec = Math.max(floor, s.startSec!);
    const endSec = Math.max(startSec, s.endSec!);
    floor = endSec;
    return { startSec: r3(startSec), endSec: r3(endSec) };
  });
  // A passage counts as read when at least half of its words were heard (one stray match is not enough).
  const totals = passageTexts.map((t) => normWords(t).length);
  const read = totals.map((w, p) => (w ? matched[p]! >= Math.max(1, Math.ceil(w / 2)) : true));
  return { spans: out, coverage: Math.round((dp[0]![0]! / n) * 1000) / 1000, passagesHeard: read.filter(Boolean).length, heard: read };
}
