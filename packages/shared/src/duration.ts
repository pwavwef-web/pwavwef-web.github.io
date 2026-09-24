import { countSyllables, round1, tokenize } from './text-align';

/**
 * Scene-duration intelligence. The duration a creator picks is a *preference*: before a scene is
 * generated AZ Studio measures (or, failing that, estimates) how long every line takes to say, adds
 * the opening and closing allowances, natural pauses between speakers and the time the described
 * action needs, and lengthens or splits the scene so dialogue and action are never cut off.
 */

export interface PlanLine {
  index: number;
  character: string;
  text: string;
  /** Spoken length of the line in seconds (speech only, silence trimmed). */
  seconds: number;
  /** True when `seconds` was measured from real audio rather than estimated from the text. */
  measured: boolean;
  /** Measured silence before this line (when all lines come from one continuous recording). */
  gapBeforeSec?: number | null;
}

export interface DurationCaps {
  /** Shortest single generation (s). */
  minSec: number;
  /** Longest single generation (s). */
  maxSec: number;
  /** Longest continuous take reachable by extending a generation (s). */
  maxChainSec: number;
}

export interface DurationPlanInput {
  lines: PlanLine[];
  action: string;
  description?: string;
  requestedSec: number;
  openingSec?: number;
  closingSec?: number;
  ensureCompleteDialogue: boolean;
  ensureCompleteAction: boolean;
  caps: DurationCaps;
}

export interface PlanSegment {
  index: number;
  /** Whole seconds requested from the video model for this part. */
  durationSec: number;
  /** Position of this part inside the finished scene (s). */
  startSec: number;
  endSec: number;
  /** Dialogue spoken in this part, as whole sentences in screenplay order. */
  units: { lineIndex: number; character: string; text: string; seconds: number }[];
  /** Planned speech window relative to the part's own start (s). */
  speechStartSec: number | null;
  speechEndSec: number | null;
  kind: 'opening' | 'continuation';
  /** Camera/editing idea for continuation parts (reaction shot, reverse angle…). */
  camera: string;
}

export type DurationStrategy = 'single' | 'lengthened' | 'extend_chain' | 'split_shots';

export interface DurationPlan {
  requestedSec: number;
  /** Minimum length the scene needs (s, one decimal). */
  requiredSec: number;
  /** Total seconds that will be generated. */
  plannedSec: number;
  breakdown: { openingSec: number; dialogueSec: number; pausesSec: number; actionSec: number; actionTailSec: number; closingSec: number };
  /** Every dialogue line was measured from audio. */
  measured: boolean;
  strategy: DurationStrategy;
  segments: PlanSegment[];
  /** Human summary, e.g. "AZ Studio will create two connected shots to complete this scene." */
  message: string;
  warnings: string[];
  /** The scene cannot be generated as planned (e.g. one sentence longer than a whole generation). */
  blocked: string | null;
}

export const OPENING_RANGE = { min: 0.4, max: 1, default: 0.6 } as const;
export const CLOSING_RANGE = { min: 0.8, max: 1.5, default: 1 } as const;
/** Natural pause when a different character speaks next, and between lines of the same speaker. */
export const SPEAKER_CHANGE_PAUSE = 0.35;
export const SAME_SPEAKER_PAUSE = 0.2;
/** Breath at an internal edit point between connected shots. */
const EDIT_BREATH = 0.3;
/** Seconds per physical action beat ("opens the door", "walks in"…). */
export const ACTION_BEAT_SEC = 1.5;
/** Cinematic dialogue is delivered more slowly than conversational speech. */
const SYLLABLES_PER_SEC = 3.3;

const clampRange = (v: number | undefined, r: { min: number; max: number; default: number }) => (v === undefined || !Number.isFinite(v) ? r.default : Math.min(r.max, Math.max(r.min, v)));

/** Estimated spoken length of a line (s) when no audio exists yet. */
export function estimateSpeechSeconds(text: string): number {
  const words = tokenize(text);
  if (!words.length) return 0;
  const syllables = words.reduce((s, w) => s + countSyllables(w.raw), 0);
  const commas = (text.match(/[,;:—–]/g) ?? []).length;
  const stops = (text.match(/[.!?…](?=\s|$)/g) ?? []).length;
  return round1(syllables / SYLLABLES_PER_SEC + commas * 0.18 + Math.max(0, stops - 1) * 0.3 + 0.15);
}

/** Splits a line into sentences (keeps punctuation). */
export function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?…]+(?:[.!?…]+["'”’)]*|$)/g) ?? [text];
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Splits a sentence at breaths (commas, semicolons, dashes) for very long sentences. */
export function splitClauses(sentence: string): string[] {
  const parts = sentence.split(/(?<=[,;:—–])\s+/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Number of distinct physical beats in an action description. */
export function actionBeats(action: string): number {
  const text = action.trim();
  if (!text) return 0;
  const clauses = text
    .split(/[.;!?]+|,\s*|\s+(?:and then|then|and|before|after|while|as)\s+/i)
    .map((c) => c.trim())
    .filter((c) => c.split(/\s+/).filter((w) => w.length > 1).length >= 1);
  return Math.min(8, Math.max(1, clauses.length));
}

interface Unit {
  lineIndex: number;
  character: string;
  text: string;
  seconds: number;
  pauseBefore: number;
}

function unitsFor(lines: PlanLine[], maxUnitSec: number, warnings: string[]): Unit[] {
  const units: Unit[] = [];
  lines.forEach((line, li) => {
    const sentences = splitSentences(line.text);
    const totalChars = sentences.reduce((s, x) => s + x.length, 0) || 1;
    const prev = lines[li - 1];
    const linePause = li === 0 ? 0 : line.gapBeforeSec ?? (prev && prev.character.trim().toUpperCase() !== line.character.trim().toUpperCase() ? SPEAKER_CHANGE_PAUSE : SAME_SPEAKER_PAUSE);
    sentences.forEach((sentence, si) => {
      const seconds = (line.seconds * sentence.length) / totalChars;
      const pauseBefore = si === 0 ? linePause : 0.25;
      if (seconds <= maxUnitSec) {
        units.push({ lineIndex: line.index, character: line.character, text: sentence, seconds, pauseBefore });
        return;
      }
      // Very long sentence: cut only at breaths (never mid-phrase).
      const clauses = splitClauses(sentence);
      if (clauses.length > 1) warnings.push(`A long sentence from ${line.character || 'a character'} is split at a natural breath between shots.`);
      const clauseChars = clauses.reduce((s, x) => s + x.length, 0) || 1;
      clauses.forEach((c, ci) => units.push({ lineIndex: line.index, character: line.character, text: c, seconds: (seconds * c.length) / clauseChars, pauseBefore: ci === 0 ? pauseBefore : 0.15 }));
    });
  });
  return units;
}

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];

/** Plans the scene length (and, when needed, connected shots) from real or estimated line lengths. */
export function planSceneDuration(input: DurationPlanInput): DurationPlan {
  const { caps } = input;
  const opening = clampRange(input.openingSec, OPENING_RANGE);
  const closing = clampRange(input.closingSec, CLOSING_RANGE);
  const warnings: string[] = [];
  const lines = input.lines.filter((l) => l.text.trim() && l.seconds > 0);
  const dialogueSec = lines.reduce((s, l) => s + l.seconds, 0);
  let pausesSec = 0;
  lines.forEach((l, i) => {
    if (i === 0) return;
    const prev = lines[i - 1]!;
    pausesSec += l.gapBeforeSec ?? (prev.character.trim().toUpperCase() !== l.character.trim().toUpperCase() ? SPEAKER_CHANGE_PAUSE : SAME_SPEAKER_PAUSE);
  });
  const beats = input.ensureCompleteAction ? actionBeats(input.action || input.description || '') : 0;
  const actionSec = beats * ACTION_BEAT_SEC;
  // Action that outlasts the speech needs its own time after the last word.
  const speechSpan = dialogueSec + pausesSec;
  const actionTailSec = input.ensureCompleteAction && beats > 0 ? (lines.length ? Math.max(0, actionSec - speechSpan) : actionSec) : 0;
  const openingSec = lines.length ? opening : Math.min(opening, OPENING_RANGE.min);
  const closingSec = lines.length ? closing : CLOSING_RANGE.min;
  const requiredRaw = openingSec + dialogueSec + pausesSec + actionTailSec + closingSec;
  const requiredSec = round1(requiredRaw);
  const requestedSec = Math.round(input.requestedSec);
  const measured = lines.length > 0 && lines.every((l) => l.measured);
  const breakdown = { openingSec: round1(openingSec), dialogueSec: round1(dialogueSec), pausesSec: round1(pausesSec), actionSec: round1(actionSec), actionTailSec: round1(actionTailSec), closingSec: round1(closingSec) };
  const guard = input.ensureCompleteDialogue || input.ensureCompleteAction;
  const base = { requestedSec, requiredSec, breakdown, measured, warnings };

  const single = (sec: number, strategy: DurationStrategy, message: string): DurationPlan => {
    const speechStart = lines.length ? round1(openingSec) : null;
    return {
      ...base,
      plannedSec: sec,
      strategy,
      message,
      blocked: null,
      segments: [
        {
          index: 0,
          durationSec: sec,
          startSec: 0,
          endSec: sec,
          units: lines.map((l) => ({ lineIndex: l.index, character: l.character, text: l.text, seconds: round1(l.seconds) })),
          speechStartSec: speechStart,
          speechEndSec: lines.length ? round1(openingSec + dialogueSec + pausesSec) : null,
          kind: 'opening',
          camera: '',
        },
      ],
    };
  };

  const fitsRequested = requiredRaw <= requestedSec + 1e-6;
  if (fitsRequested || !guard) {
    const sec = Math.min(caps.maxSec, Math.max(caps.minSec, requestedSec));
    if (!fitsRequested) warnings.push(`The scene needs about ${requiredSec} s but complete dialogue and action checks are off, so the requested ${requestedSec} s is kept.`);
    return single(sec, 'single', fitsRequested ? `The requested ${requestedSec} s is enough (needs ${requiredSec} s).` : `Requested ${requestedSec} s kept (needs ≈ ${requiredSec} s).`);
  }
  const needed = Math.max(caps.minSec, Math.ceil(requiredRaw - 1e-6));
  if (needed <= caps.maxSec) {
    return single(needed, 'lengthened', `AZ Studio will lengthen this shot to ${needed} seconds so every word and action completes.`);
  }

  // Too long for one generation: connected shots, cut only between sentences (or breaths).
  const maxSpeechPerSeg = caps.maxSec - Math.max(openingSec, EDIT_BREATH) - EDIT_BREATH;
  const units = unitsFor(lines, maxSpeechPerSeg, warnings);
  const tooLong = units.find((u) => u.seconds > maxSpeechPerSeg);
  if (tooLong) {
    return {
      ...base,
      plannedSec: 0,
      strategy: 'split_shots',
      segments: [],
      message: `One line needs about ${round1(tooLong.seconds)} s without a pause — longer than a single ${caps.maxSec}-second generation.`,
      blocked: `Rewrite or break up the line “${tooLong.text.slice(0, 80)}${tooLong.text.length > 80 ? '…' : ''}” (${tooLong.character || 'unknown speaker'}): AZ Studio never cuts a character off mid-sentence.`,
    };
  }
  const segments: PlanSegment[] = [];
  let current: Unit[] = [];
  const segLength = (us: Unit[], first: boolean, last: boolean) => {
    const speech = us.reduce((s, u, i) => s + u.seconds + (i === 0 ? 0 : u.pauseBefore), 0);
    return (first ? openingSec : EDIT_BREATH) + speech + (last ? closingSec + actionTailSec : EDIT_BREATH);
  };
  const flush = (last: boolean) => {
    if (!current.length) return;
    const first = segments.length === 0;
    const length = segLength(current, first, last);
    const durationSec = Math.min(caps.maxSec, Math.max(caps.minSec, Math.ceil(length - 1e-6)));
    const lead = first ? openingSec : EDIT_BREATH;
    const speech = current.reduce((s, u, i) => s + u.seconds + (i === 0 ? 0 : u.pauseBefore), 0);
    const prevUnit = segments.length ? segments[segments.length - 1]!.units.at(-1) : undefined;
    const speakerChanged = prevUnit ? prevUnit.character.trim().toUpperCase() !== current[0]!.character.trim().toUpperCase() : false;
    const listener = lines.find((l) => l.character.trim().toUpperCase() !== current[0]!.character.trim().toUpperCase())?.character;
    segments.push({
      index: segments.length,
      durationSec,
      startSec: 0,
      endSec: 0,
      units: current.map((u) => ({ lineIndex: u.lineIndex, character: u.character, text: u.text, seconds: round1(u.seconds) })),
      speechStartSec: round1(lead),
      speechEndSec: round1(lead + speech),
      kind: first ? 'opening' : 'continuation',
      camera: first
        ? ''
        : speakerChanged
          ? `Cut to ${current[0]!.character || 'the next speaker'} as they begin speaking (reverse angle or over-the-shoulder).`
          : listener
            ? `Cut to a reaction shot of ${listener} while ${current[0]!.character || 'the speaker'} keeps talking, then back to the speaker if natural.`
            : `Cut to a tighter angle on ${current[0]!.character || 'the speaker'} as they continue.`,
    });
    current = [];
  };
  units.forEach((u, i) => {
    const isLastUnit = i === units.length - 1;
    const candidate = [...current, u];
    const first = segments.length === 0;
    if (current.length && segLength(candidate, first, isLastUnit) > caps.maxSec + 1e-6) flush(false);
    current.push(u);
  });
  // The greedy pass leaves at most one sentence whose closing hold (and action) no longer fits:
  // it ends on a breath and a short final part holds the moment / completes the action.
  if (segLength(current, segments.length === 0, true) > caps.maxSec + 1e-6) {
    flush(false);
    const holdSec = Math.max(caps.minSec, Math.ceil(EDIT_BREATH + closingSec + actionTailSec - 1e-6));
    segments.push({
      index: segments.length,
      durationSec: Math.min(caps.maxSec, holdSec),
      startSec: 0,
      endSec: 0,
      units: [],
      speechStartSec: null,
      speechEndSec: null,
      kind: 'continuation',
      camera: actionTailSec > 0 ? 'Stay with the characters as the described action completes, then hold the final beat.' : 'Hold on the characters for the final beat — no new dialogue.',
    });
  } else {
    flush(true);
  }
  let t = 0;
  for (const s of segments) {
    s.startSec = t;
    t += s.durationSec;
    s.endSec = t;
  }
  const plannedSec = t;
  const n = segments.length;
  const nWord = COUNT_WORDS[n] ?? String(n);
  if (plannedSec > caps.maxChainSec) {
    return {
      ...base,
      plannedSec,
      strategy: 'split_shots',
      segments,
      message: `This scene needs about ${requiredSec} s — more than one continuous ${caps.maxChainSec}-second take. AZ Studio will split it into ${nWord} separate shots at sentence boundaries.`,
      blocked: null,
    };
  }
  return {
    ...base,
    plannedSec,
    strategy: 'extend_chain',
    segments,
    message: `AZ Studio will create ${nWord} connected shots to complete this scene.`,
    blocked: null,
  };
}

/** A span of the finished scene where the plan itself asks for a cut (reaction shot, reverse angle). */
export interface EditorialWindow {
  startSec: number;
  endSec: number;
  /** Cutting away and back. */
  maxCuts: number;
  direction: string;
}

/** Continuation parts that were directed to cut to another angle; cuts there are intended, not accidental. */
export function editorialWindows(plan: Pick<DurationPlan, 'segments'>): EditorialWindow[] {
  return plan.segments.filter((s) => s.kind === 'continuation' && /^Cut to\b/.test(s.camera)).map((s) => ({ startSec: s.startSec, endSec: s.endSec, maxCuts: 2, direction: s.camera }));
}

/** Timing directions compiled into the video prompt for one planned part. */
export function segmentTimingDirections(plan: DurationPlan, segment: PlanSegment): string[] {
  const out: string[] = [];
  const last = segment.index === plan.segments.length - 1;
  if (segment.units.length) {
    out.push(`Let the scene breathe for about ${segment.kind === 'opening' ? plan.breakdown.openingSec : 0.3} seconds before the first word.`);
    out.push(`Every word of the dialogue must be spoken in full, at a natural unhurried pace; do not skip, shorten or repeat any words.`);
    if (segment.speechEndSec !== null) out.push(`The last word should finish by about ${segment.speechEndSec} seconds.`);
    out.push(last ? `After the final word, hold on the characters for about ${plan.breakdown.closingSec} seconds so the moment lands — do not cut off the last word or end mid-gesture.` : 'End on a natural breath after a complete sentence — never mid-word.');
  } else if (last) {
    out.push(`Complete the whole action before the end and hold the final moment for about ${plan.breakdown.closingSec} seconds.`);
  }
  if (last && plan.breakdown.actionTailSec > 0) out.push(`The described action must finish completely on screen before the shot ends (allow about ${plan.breakdown.actionTailSec} seconds after the dialogue).`);
  return out;
}
