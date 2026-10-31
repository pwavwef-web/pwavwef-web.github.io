import { estimateSpeechSeconds, implausibleGuideLength, splitSentences } from './duration';
import { round1, tokenize } from './text-align';

/**
 * Guard on every spoken take (the guide-voice speech model, `speakLine`). The model reads one prompt,
 * "direction: line", and has shown three failure modes: a second colon (in the line or the direction) made it
 * read its stage direction aloud; a pronunciation note in the direction turned a four-word line into a 20 s
 * improvised pitch; and lines about speech or transcription were improvised on. The guard cleans the spoken
 * text without changing its words, reduces the direction to delivery (tone, pace, emotion, accent) and checks
 * the measured length of the take against the words. Narrator synthesis (inline tags, `speech_metadata.style`)
 * does not go through it.
 */

export const SPEECH_PACE = { minWordsPerSec: 1.8, maxWordsPerSec: 3.6 } as const;
/** Longest delivery direction sent with a line (characters). */
export const MAX_DIRECTION_CHARS = 160;

export interface SpokenTextGuard {
  text: string;
  /** What was changed, in plain words (empty when nothing was). */
  changes: string[];
  /** Risks that cannot be fixed without changing words (the length check catches what they cause). */
  flags: string[];
}

/** Bracketed stage notes: short and lower-case ("[laughs]", "(whispering)"), or a known cue. */
const STAGE_CUE = /^(?:pause|beat|laughs?|laughing|sighs?|whisper(?:s|ing)?|softly|quietly|loudly|aside|smiles?|chuckles?|breath|breathes|inhales?|exhales?|music|sfx|applause|silence|cough(?:s)?|clears throat|excited(?:ly)?|sadly|happily)$/i;
const isStageNote = (inner: string) => {
  const t = inner.trim();
  return STAGE_CUE.test(t) || (/^[\p{Ll}\s'-]+$/u.test(t) && t.split(/\s+/).length <= 4);
};

const META_TEXT = /\b(?:text[- ]to[- ]speech|tts|speech model|voice model|transcri(?:be|bed|ption|ber)s?|read (?:this|the following) (?:aloud|out)|stage direction)\b/i;

/**
 * Removes punctuation the speech model treats as instructions: colons and semicolons (commas instead), stage
 * notes in brackets, quotation marks, Markdown emphasis and slashes between words. Words are never changed;
 * bracketed words that are part of the line are kept (only their brackets go).
 */
export function guardSpokenText(textIn: string): SpokenTextGuard {
  const changes: string[] = [];
  const flags: string[] = [];
  let t = textIn.replace(/\r?\n+/g, ' ');
  const note = (what: string, before: string, after: string) => {
    if (before !== after) changes.push(what);
    return after;
  };
  t = note('removed Markdown emphasis and symbols', t, t.replace(/\*+|`+|(?<!\w)_+|_+(?!\w)|^#+\s*|(?<=\s)#+\s+/g, ''));
  const dropped: string[] = [];
  t = t.replace(/\[([^\]]*)\]|\{([^}]*)\}|<([^>]*)>/g, (_m, a: string | undefined, b: string | undefined, c: string | undefined) => {
    const inner = (a ?? b ?? c ?? '').trim();
    if (!inner || isStageNote(inner)) {
      if (inner) dropped.push(inner);
      return ' ';
    }
    return ` ${inner} `;
  });
  t = t.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    if (!inner.trim() || isStageNote(inner)) {
      if (inner.trim()) dropped.push(inner.trim());
      return ' ';
    }
    return `, ${inner.trim()}, `;
  });
  if (dropped.length) changes.push(`dropped stage note${dropped.length > 1 ? 's' : ''} ${dropped.map((d) => `[${d}]`).join(', ')}`);
  t = note('removed brackets', t, t.replace(/[[\]{}()<>]/g, ' '));
  t = note('removed quotation marks', t, t.replace(/["“”„«»]|(?<![\p{L}\p{N}])['‘’]|['‘’](?![\p{L}\p{N}])/gu, ''));
  t = t.replace(/(\d):(\d{2})\b/g, '$1 $2');
  t = note('replaced colons and semicolons with commas', t, t.replace(/\s*[:;]+\s*(?!\/\/)/g, ', '));
  t = note('replaced slashes between words with spaces', t, t.replace(/(?<!\d)\s*\/+\s*|\s*\/+\s*(?!\d)/g, ' '));
  t = t
    .replace(/\s+([,.!?…])/g, '$1')
    .replace(/,(\s*,)+/g, ',')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .replace(/([.!?…])\s*,/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (META_TEXT.test(t)) flags.push('meta_text: the line talks about speech or transcription — the voice may improvise on it; listen to the take');
  return { text: t, changes: [...new Set(changes)], flags };
}

/** Sentences of a direction that are not about delivery: pronunciation, spelling, what to say or read, meta notes. */
const NOT_DELIVERY = /\b(?:pronounc\w*|spell\w*|spelt|letter[- ]by[- ]letter|rhymes? with|sounds? like|phonetic\w*|ipa|syllabl\w*|respell\w*)\b|\b(?:say|read|speak)(?:s|ing)?\s+(?:it\s+|this\s+)?(?:as|exactly|only|out|aloud|each|every|the (?:word|name|number|letters?|line|text|script))\b|\b(?:text[- ]to[- ]speech|tts|transcri\w*|captions?|subtitles?|script)\b|\b(?:do not|don'?t|never) (?:add|improvise|change|say|read)\b|\bnothing else\b|\bthe (?:word|name|number|brand)\b|\bstress (?:on|the)\b|\bemphasi[sz]e (?:the )?(?:word|name)\b/i;

export interface DirectionGuard {
  direction: string;
  /** Sentences or parts removed (not about delivery). */
  dropped: string[];
}

/**
 * Reduces a direction to delivery only — tone, pace, emotion, accent — colon-free and at most
 * `MAX_DIRECTION_CHARS` long. Sentences about pronunciation, spelling or what to say are dropped (a pronunciation
 * belongs in a respelling of the spoken text, never in the direction).
 */
export function deliveryDirection(directionIn: string, maxChars = MAX_DIRECTION_CHARS): DirectionGuard {
  const dropped: string[] = [];
  const cleaned = directionIn
    .replace(/\r?\n+/g, '. ')
    .replace(/["“”„«»*`_#[\]{}()<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const kept: string[] = [];
  for (const raw of splitSentences(cleaned)) {
    // "Tone: warm" → "Tone warm": a label before a colon is still about delivery; the colon itself goes.
    const s = raw.replace(/\s*[:;]+\s*/g, ', ').replace(/\s*\/\s*/g, ' or ').trim();
    if (!s) continue;
    if (NOT_DELIVERY.test(s)) dropped.push(raw.trim());
    else kept.push(s);
  }
  let out = kept.join(' ').replace(/\s+/g, ' ').replace(/,\s*([.!?])/g, '$1').trim();
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    out = sentenceEnd > maxChars * 0.5 ? cut.slice(0, sentenceEnd + 1) : cut.replace(/[\s,]+\S*$/, '');
    dropped.push('(shortened)');
  }
  out = out.replace(/[\s,]+$/, '').trim();
  return { direction: out, dropped };
}

/** The prompt sent to the speech model: one colon, between the delivery direction and the line. */
export function speechPrompt(direction: string, text: string): string {
  const d = direction.replace(/[\s.,!?…]+$/, '');
  return d ? `${d}: ${text}` : text;
}

export interface TakeLengthCheck {
  expectedSec: number;
  measuredSec: number | null;
  /** Spoken words per second (numbers count as the words they are read as). */
  wordsPerSec: number | null;
  verdict: 'ok' | 'too_long' | 'too_short' | 'no_speech';
  note: string | null;
}

/** Words a line is read as: "450" is several spoken words. */
export function spokenWordCount(text: string): number {
  return tokenize(text).reduce((n, t) => {
    const digits = t.raw.replace(/\D/g, '').length;
    return n + (digits ? Math.max(1, Math.min(digits, Math.ceil(digits * 1.4))) : 1);
  }, 0);
}

/**
 * Checks a take's measured speech against its words. A take is implausible when its pace leaves the
 * ~1.8–3.6 words-per-second band by a clear margin (a short line may be slow; a long improvisation or a
 * swallowed half of the line is not), or it is far longer than the text could take (`implausibleGuideLength`).
 */
export function checkTakeLength(text: string, measuredSec: number | null | undefined): TakeLengthCheck {
  const expectedSec = Math.max(0.4, estimateSpeechSeconds(text));
  const words = spokenWordCount(text);
  if (measuredSec === null || measuredSec === undefined || !Number.isFinite(measuredSec) || measuredSec <= 0.05) {
    return { expectedSec, measuredSec: null, wordsPerSec: null, verdict: words ? 'no_speech' : 'ok', note: words ? 'no speech was measured in the take' : null };
  }
  const wps = words / measuredSec;
  const r = (n: number) => Math.round(n * 100) / 100;
  if (implausibleGuideLength(measuredSec, text) || (wps < SPEECH_PACE.minWordsPerSec && measuredSec - expectedSec > Math.max(1.5, expectedSec * 0.6))) {
    return { expectedSec, measuredSec, wordsPerSec: r(wps), verdict: 'too_long', note: `${round1(measuredSec)} s of speech for ${words} word${words === 1 ? '' : 's'} (≈${round1(expectedSec)} s expected) — the voice may have read its direction or improvised` };
  }
  if (wps > SPEECH_PACE.maxWordsPerSec && expectedSec - measuredSec > Math.max(1, expectedSec * 0.35)) {
    return { expectedSec, measuredSec, wordsPerSec: r(wps), verdict: 'too_short', note: `${round1(measuredSec)} s of speech for ${words} words (≈${round1(expectedSec)} s expected) — part of the line may be missing` };
  }
  return { expectedSec, measuredSec, wordsPerSec: r(wps), verdict: 'ok', note: null };
}

export interface SpeechGuardPlan {
  text: string;
  direction: string;
  prompt: string;
  changes: string[];
  flags: string[];
  expectedSec: number;
}

/** Everything the guard does before a line is sent: clean text, delivery-only direction, the prompt. */
export function guardSpeech(textIn: string, directionIn: string): SpeechGuardPlan {
  const t = guardSpokenText(textIn);
  const d = deliveryDirection(directionIn);
  const changes = [...t.changes];
  if (d.dropped.length) changes.push(`direction reduced to delivery (dropped: ${d.dropped.map((x) => `“${x.slice(0, 60)}”`).join(', ')})`);
  return { text: t.text, direction: d.direction, prompt: speechPrompt(d.direction, t.text), changes, flags: t.flags, expectedSec: Math.max(0.4, estimateSpeechSeconds(t.text)) };
}

/** What the guard did and found for one spoken line (recorded with the take). */
export interface SpeechGuardRecord {
  text: string;
  direction: string;
  changes: string[];
  flags: string[];
  expectedSec: number;
  measuredSec: number | null;
  wordsPerSec: number | null;
  verdict: TakeLengthCheck['verdict'];
  /** Takes requested (2 = one automatic re-take because the first was implausible). */
  takes: number;
  retaken: boolean;
}
