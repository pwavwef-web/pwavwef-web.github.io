/**
 * Automatic lip-sync picker. Only shots where a person's mouth is visible AND the real audio (a sung line or a
 * spoken line) belongs to that person are sent to the lip-sync model; everything else (wide shots, backs of heads,
 * insert shots, b-roll, a voice-over over unrelated pictures) is left alone, so no money is spent where it cannot help.
 */

export interface LipSyncCandidate {
  /** Shot / scene title, description and directions, as written for the video model. */
  title?: string;
  description?: string;
  framing?: string;
  performance?: string;
  action?: string;
  /** Number of people named in the shot. */
  characterCount: number;
  /** Seconds of the shot covered by sung/spoken words (0 when the audio is silent or instrumental there). */
  voicedSec: number;
  durationSec: number;
  /** True when the track is a spoken/sung recording the picture should follow (music video lyric, ad narrator on camera). */
  voiceBelongsOnScreen: boolean;
}

export interface LipSyncDecision {
  apply: boolean;
  reason: string;
}

const FACE_FRAMING = /\b(close[- ]?up|ecu|extreme close|medium close|mcu|medium shot|portrait|head and shoulders|bust|over[- ]the[- ]shoulder|two[- ]shot|eye[- ]level|face)\b/i;
const NO_FACE_FRAMING = /\b(wide|establishing|aerial|drone|long shot|extreme wide|silhouette|from behind|back of|over his shoulder from behind|insert|detail shot|macro|hands only|feet)\b/i;
const SINGING = /\b(sing|sings|singing|sung|lip[- ]?sync|mouths? the|whisper(?:s|ing)? (?:the )?(?:lyrics?|words)|performs? (?:to|into|for) (?:the )?(?:camera|mirror)|vocal|speaks? (?:to|directly)|looks? (?:straight )?(?:into|at) (?:the )?camera|to camera|mouthing|rap(?:s|ping)?|talks? to camera|addresses? the camera)\b/i;
const NOT_THE_SPEAKER = /\b(background|blurred|barely visible|out of focus|distant)\b/i;

export function decideLipSync(c: LipSyncCandidate): LipSyncDecision {
  if (!c.voiceBelongsOnScreen) return { apply: false, reason: 'The audio is not a voice that belongs to a person on screen.' };
  if (c.characterCount < 1) return { apply: false, reason: 'No person is named in this shot.' };
  const voicedShare = c.durationSec > 0 ? c.voicedSec / c.durationSec : 0;
  if (c.voicedSec < 1.2 || voicedShare < 0.35) return { apply: false, reason: 'Too little of this shot carries the voice.' };
  const performanceText = [c.performance, c.action].filter(Boolean).join(' ');
  const all = [c.title, c.description, c.framing, performanceText].filter(Boolean).join(' ');
  if (!SINGING.test(all)) return { apply: false, reason: 'The shot is not directed as a person singing or speaking to camera.' };
  if (c.framing && NO_FACE_FRAMING.test(c.framing) && !FACE_FRAMING.test(c.framing)) return { apply: false, reason: 'The framing is too wide or turned away to show a mouth.' };
  if (c.framing && NOT_THE_SPEAKER.test(c.framing) && !FACE_FRAMING.test(c.framing)) return { apply: false, reason: 'The speaker is out of focus or in the background.' };
  if (!c.framing && NO_FACE_FRAMING.test(all) && !FACE_FRAMING.test(all)) return { apply: false, reason: 'The shot reads as wide or turned away.' };
  return { apply: true, reason: `A face is on screen for about ${c.voicedSec.toFixed(1)} s of voiced audio.` };
}

/** Seconds of [start,end) covered by timed words/lines (merged, so overlaps are not counted twice). */
export function voicedSeconds(spans: { start: number; end: number }[], start: number, end: number): number {
  const clipped = spans
    .map((s) => ({ start: Math.max(start, s.start), end: Math.min(end, s.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let cur: { start: number; end: number } | null = null;
  for (const s of clipped) {
    if (cur && s.start <= cur.end + 0.4) cur.end = Math.max(cur.end, s.end);
    else {
      if (cur) total += cur.end - cur.start;
      cur = { ...s };
    }
  }
  if (cur) total += cur.end - cur.start;
  return total;
}

/** Models offered on fal; the picker uses the standard model unless a close, long shot wants the pro one. */
export const LIPSYNC_MODELS = {
  standard: { id: 'fal-ai/sync-lipsync/v2', param: 'lipsync-2', usdPerSec: 0.05 },
  pro: { id: 'fal-ai/sync-lipsync/v2', param: 'lipsync-2-pro', usdPerSec: 0.083 },
} as const;

export function lipSyncEstimateUsd(durationSec: number, tier: keyof typeof LIPSYNC_MODELS = 'standard'): number {
  return Math.round(durationSec * LIPSYNC_MODELS[tier].usdPerSec * 1000) / 1000;
}
