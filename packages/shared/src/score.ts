import { round3 } from './text-align';
import { addTrack, makeClip, type TimelineState } from './timeline';
import type { Clip } from './types';

/**
 * Film score: one musical identity per film. Gemini writes a musical bible and a cue sheet from the
 * screenplay; Lyria composes one continuous master score for a sequence (or connected movements for
 * longer films) from that same bible. The score is mixed centrally — never generated per shot — and
 * ducks under dialogue, crossfades between movements and honours deliberate silence.
 */

export type ScoreMode = 'none' | 'minimal' | 'cinematic';

export const SCORE_MODE_LABELS: Record<ScoreMode, string> = {
  none: 'No score',
  minimal: 'Minimal score',
  cinematic: 'Cinematic score',
};

export interface MusicalBible {
  mainTheme: string;
  emotionalMotif: string;
  instrumentation: string[];
  key: string;
  tempoRange: { min: number; max: number };
  culturalDirection: string;
  characterThemes: { character: string; theme: string }[];
  locationThemes: { location: string; theme: string }[];
  tensionLanguage: string;
  resolutionLanguage: string;
  avoid: string[];
  notes: string;
}

export const EMPTY_BIBLE: MusicalBible = {
  mainTheme: '',
  emotionalMotif: '',
  instrumentation: [],
  key: '',
  tempoRange: { min: 70, max: 100 },
  culturalDirection: '',
  characterThemes: [],
  locationThemes: [],
  tensionLanguage: '',
  resolutionLanguage: '',
  avoid: [],
  notes: '',
};

export type CueTransition = 'cut_in' | 'crossfade' | 'swell' | 'sting' | 'fade_in' | 'fade_out' | 'hard_out' | 'continue';

export interface ScoreCue {
  id: string;
  sceneId: string | null;
  scene: string;
  /** Film time (s). */
  start: number;
  end: number;
  purpose: string;
  /** 0 (barely there) – 10 (full orchestra). */
  intensity: number;
  theme: string;
  transitionIn: CueTransition;
  transitionOut: CueTransition;
  /** Deliberate silence: no score at all for this span. */
  silence: boolean;
  /** Lower the score under dialogue here. */
  duckForDialogue: boolean;
  notes: string;
}

export type MovementStatus = 'planned' | 'generating' | 'ready' | 'failed';

export interface ScoreMovement {
  id: string;
  index: number;
  /** Film time the movement covers (s), including its crossfade handles. */
  start: number;
  end: number;
  cueIds: string[];
  status: MovementStatus;
  jobId: string | null;
  assetId: string | null;
  durationSec: number | null;
  locked: boolean;
  prompt: string;
  error?: string | null;
}

export interface ScoreMix {
  ducking: boolean;
  /** How far the score drops under dialogue (dB, positive). */
  duckDb: number;
  crossfadeSec: number;
  /** Overall score level (dB). */
  volumeDb: number;
  /** Follow the cue sheet's intensity with volume automation. */
  intensityAutomation: boolean;
}

export const DEFAULT_SCORE_MIX: ScoreMix = { ducking: true, duckDb: 12, crossfadeSec: 2.5, volumeDb: -8, intensityAutomation: true };

export interface ScoreDoc {
  id: string;
  title: string;
  mode: ScoreMode;
  bible: MusicalBible;
  /** When set, the main theme is fixed and reused verbatim by every movement (and regeneration). */
  mainThemeLockedAt: number | null;
  bibleApprovedAt: number | null;
  cueSheet: ScoreCue[];
  movements: ScoreMovement[];
  mix: ScoreMix;
  /** An existing soundtrack imported instead of generating one. */
  importedAssetId: string | null;
  /** Length of the film/sequence the cue sheet covers (s). */
  durationSec: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

/** Longest movement requested from Lyria in one generation (s). */
export const MAX_MOVEMENT_SEC = 150;

const clampI = (v: number) => Math.max(0, Math.min(10, Math.round(Number.isFinite(v) ? v : 5)));

/** Cleans a model-written cue sheet: ordered, non-overlapping, inside the film, no zero-length cues. */
export function normalizeCueSheet(cues: Partial<ScoreCue>[], durationSec: number): ScoreCue[] {
  const D = Math.max(1, durationSec);
  const out = cues
    .map((c, i) => ({
      id: c.id || `cue${i + 1}`,
      sceneId: c.sceneId ?? null,
      scene: String(c.scene ?? '').slice(0, 160),
      start: Math.max(0, Math.min(D, Number(c.start) || 0)),
      end: Math.max(0, Math.min(D, Number(c.end) || 0)),
      purpose: String(c.purpose ?? '').slice(0, 400),
      intensity: clampI(Number(c.intensity)),
      theme: String(c.theme ?? '').slice(0, 200),
      transitionIn: (c.transitionIn ?? 'crossfade') as CueTransition,
      transitionOut: (c.transitionOut ?? 'crossfade') as CueTransition,
      silence: Boolean(c.silence),
      duckForDialogue: c.duckForDialogue ?? true,
      notes: String(c.notes ?? '').slice(0, 400),
    }))
    .filter((c) => c.end > c.start + 0.2)
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!;
    if (out[i]!.start < prev.end) prev.end = Math.max(prev.start + 0.2, out[i]!.start);
  }
  return out.map((c) => ({ ...c, start: round3(c.start), end: round3(c.end) }));
}

/**
 * Groups consecutive cues into movements no longer than `maxSec`. Boundaries prefer deliberate
 * silence or the quietest cue change, so crossfades land where the score is already low.
 */
export function planMovements(cues: ScoreCue[], opts: { maxSec?: number; crossfadeSec?: number } = {}): ScoreMovement[] {
  const maxSec = opts.maxSec ?? MAX_MOVEMENT_SEC;
  const xf = opts.crossfadeSec ?? DEFAULT_SCORE_MIX.crossfadeSec;
  const music = cues.filter((c) => !c.silence);
  if (!music.length) return [];
  const groups: ScoreCue[][] = [];
  let cur: ScoreCue[] = [];
  const span = (g: ScoreCue[]) => (g.length ? g[g.length - 1]!.end - g[0]!.start : 0);
  for (const c of music) {
    const prev = cur[cur.length - 1];
    const silenceBetween = prev ? cues.some((s) => s.silence && s.start >= prev.end - 0.05 && s.end <= c.start + 0.05) || c.start - prev.end > 1 : false;
    if (cur.length && (silenceBetween || span([...cur, c]) + xf > maxSec)) {
      // Prefer splitting before the quietest cue when the group is merely too long.
      if (!silenceBetween && cur.length > 2) {
        const candidates = cur.slice(1).map((x, i) => ({ i: i + 1, v: x.intensity + (cur[i]!.intensity ?? 0) }));
        const best = candidates.reduce((a, b) => (b.v <= a.v ? b : a));
        if (span(cur.slice(best.i)) + span([c]) < maxSec) {
          groups.push(cur.slice(0, best.i));
          cur = cur.slice(best.i);
        } else {
          groups.push(cur);
          cur = [];
        }
      } else {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(c);
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, i) => {
    const first = g[0]!;
    const last = g[g.length - 1]!;
    const next = groups[i + 1];
    // Movements overlap the next one by the crossfade so there is never a gap in the score.
    const handle = next && next[0]!.start - last.end < 0.5 ? xf : 0;
    return {
      id: `mv${i + 1}`,
      index: i,
      start: round3(Math.max(0, first.start - (i > 0 && first.start - groups[i - 1]![groups[i - 1]!.length - 1]!.end < 0.5 ? xf : 0))),
      end: round3(last.end + handle),
      cueIds: g.map((c) => c.id),
      status: 'planned' as MovementStatus,
      jobId: null,
      assetId: null,
      durationSec: null,
      locked: false,
      prompt: '',
    };
  });
}

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function intensityWords(v: number): string {
  if (v <= 1) return 'barely audible';
  if (v <= 3) return 'sparse and quiet';
  if (v <= 5) return 'restrained';
  if (v <= 7) return 'building, fuller';
  if (v <= 9) return 'powerful';
  return 'full climax';
}

/** Lyria prompt for one movement, built only from the bible and cue sheet (instrumental, no vocals). */
export function movementPrompt(score: Pick<ScoreDoc, 'bible' | 'mode' | 'cueSheet' | 'title'>, movement: ScoreMovement, totalMovements: number): string {
  const b = score.bible;
  const cues = score.cueSheet.filter((c) => movement.cueIds.includes(c.id));
  const len = Math.max(10, Math.round(movement.end - movement.start));
  const minimal = score.mode === 'minimal';
  const lines = [
    `Instrumental film score for “${score.title}”${totalMovements > 1 ? `, movement ${movement.index + 1} of ${totalMovements}` : ''}. Strictly instrumental: no vocals, no singing, no spoken words, no lyrics.`,
    `Length: exactly ${mmss(len)} (${len} seconds).`,
    b.mainTheme ? `Main theme (use it recognisably${totalMovements > 1 ? '; every movement shares it' : ''}): ${b.mainTheme}.` : '',
    b.emotionalMotif ? `Recurring emotional motif: ${b.emotionalMotif}.` : '',
    b.instrumentation.length ? `Instrumental palette — use only these: ${b.instrumentation.join(', ')}.` : '',
    b.key ? `Key: ${b.key}.` : '',
    `Tempo between ${b.tempoRange.min} and ${b.tempoRange.max} BPM.`,
    b.culturalDirection ? `Style and cultural direction: ${b.culturalDirection}.` : '',
    b.tensionLanguage ? `Tension is expressed with: ${b.tensionLanguage}.` : '',
    b.resolutionLanguage ? `Resolution is expressed with: ${b.resolutionLanguage}.` : '',
    minimal ? 'Keep the arrangement minimal and spacious: few instruments, lots of air, understated.' : 'Cinematic arrangement with a clear dynamic arc.',
    b.avoid.length ? `Avoid: ${b.avoid.join(', ')}.` : '',
    'Leave room for dialogue: no dense mid-range melodies under spoken scenes.',
    'Structure (timestamps are relative to the start of this piece):',
    ...cues.map((c) => {
      const s = Math.max(0, c.start - movement.start);
      const e = Math.min(len, c.end - movement.start);
      const theme = c.theme ? ` Theme: ${c.theme}.` : '';
      const entry = c.transitionIn === 'swell' ? ' Swell in.' : c.transitionIn === 'sting' ? ' Enter with a short sting.' : c.transitionIn === 'fade_in' ? ' Fade in from nothing.' : '';
      const exit = c.transitionOut === 'fade_out' ? ' Fade out at the end.' : c.transitionOut === 'hard_out' ? ' Stop cleanly on the last beat.' : '';
      return `[${mmss(s)} - ${mmss(e)}] ${c.purpose || c.scene} — ${intensityWords(c.intensity)} (intensity ${c.intensity}/10).${theme}${entry}${exit}${c.duckForDialogue ? ' Dialogue plays here: keep it low and uncluttered.' : ''}`;
    }),
    movement.index > 0 ? 'Begin as a natural continuation of the previous movement (same palette and theme), not a new song.' : '',
    movement.index < totalMovements - 1 ? 'End open, sustaining softly so it can crossfade into the next movement.' : 'End with a clear resolution.',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Volume automation (film time → linear gain) for a movement from the cue sheet: intensity sets the
 * bed level and deliberate silences drop to zero with short fades.
 */
export function scoreAutomation(cues: ScoreCue[], movement: Pick<ScoreMovement, 'start' | 'end'>, opts: { fadeSec?: number } = {}): { t: number; gain: number }[] {
  const fade = opts.fadeSec ?? 0.8;
  const pts: { t: number; gain: number }[] = [];
  const level = (i: number) => round3(0.35 + 0.065 * i);
  const blend = 0.75;
  const within = cues.filter((c) => c.end > movement.start && c.start < movement.end).sort((a, b) => a.start - b.start);
  within.forEach((c, k) => {
    const s = Math.max(0, Math.max(movement.start, c.start) - movement.start);
    const e = Math.min(movement.end, c.end) - movement.start;
    if (c.silence) {
      pts.push({ t: round3(s), gain: 0 }, { t: round3(e), gain: 0 });
      return;
    }
    const prev = within[k - 1];
    const next = within[k + 1];
    // Fade out of / into deliberate silence; blend intensity changes between cues.
    const a = prev ? Math.min(e, s + (prev.silence ? fade : blend)) : s;
    const b = next ? Math.max(a, e - (next.silence ? fade : blend)) : e;
    const g = level(c.intensity);
    pts.push({ t: round3(a), gain: g }, { t: round3(b), gain: g });
  });
  // Smooth steps between cues.
  const out: { t: number; gain: number }[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - p.t) < 1e-3) {
      last.gain = p.gain;
      continue;
    }
    out.push({ ...p });
  }
  return out;
}

/** Evaluates piecewise-linear automation at time t (holds the end values). */
export function automationGain(points: { t: number; gain: number }[] | null | undefined, t: number): number {
  if (!points?.length) return 1;
  if (t <= points[0]!.t) return points[0]!.gain;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (t <= b.t) return b.t - a.t < 1e-6 ? b.gain : a.gain + ((b.gain - a.gain) * (t - a.t)) / (b.t - a.t);
  }
  return points[points.length - 1]!.gain;
}

export const dbToGain = (db: number) => round3(10 ** (db / 20));

// ---------------------------------------------------------------------------
// Timeline placement
// ---------------------------------------------------------------------------

export const SCORE_CLIP_PREFIX = 'Score ·';

/**
 * Lays the score on the timeline: movements alternate between two score tracks so they can overlap
 * and crossfade (equal-power in the renderer), every clip is marked as music (ducked under dialogue
 * when enabled) and follows the cue sheet's intensity and silence automation. Previous score clips are
 * replaced; dialogue, effects and picture are untouched.
 */
export function applyScoreToTimeline(state: TimelineState, score: Pick<ScoreDoc, 'mix' | 'cueSheet' | 'movements' | 'importedAssetId' | 'mode'>, opts: { importedDurationSec?: number | null; filmDurationSec?: number } = {}): TimelineState {
  let next: TimelineState = { ...state, clips: state.clips.filter((c) => !(c.kind === 'audio' && c.label.startsWith(SCORE_CLIP_PREFIX))) };
  if (score.mode === 'none') return next;
  const trackNamed = (name: string) => {
    let t = next.tracks.find((x) => x.kind === 'audio' && x.name === name);
    if (!t) {
      next = addTrack(next, 'audio', name);
      t = next.tracks.find((x) => x.kind === 'audio' && x.name === name)!;
    }
    return t;
  };
  const a = trackNamed('Score A');
  const b = trackNamed('Score B');
  const gain = dbToGain(score.mix.volumeDb);
  const film = opts.filmDurationSec ?? Math.max(0, ...next.clips.map((c) => c.start + c.duration));
  const clips: Clip[] = [];
  if (score.importedAssetId && opts.importedDurationSec) {
    const duration = Math.max(0.5, Math.min(opts.importedDurationSec, film || opts.importedDurationSec));
    clips.push(
      makeClip({ trackId: a.id, kind: 'audio', start: 0, duration, assetId: score.importedAssetId, sourceDuration: opts.importedDurationSec, useSourceAudio: false, label: `${SCORE_CLIP_PREFIX} imported soundtrack`, role: 'music', duck: score.mix.ducking, duckDb: score.mix.duckDb, volume: gain, fadeIn: 1, fadeOut: 2.5 }),
    );
  } else {
    const ready = score.movements.filter((m) => m.status === 'ready' && m.assetId && m.durationSec).sort((x, y) => x.start - y.start);
    ready.forEach((m, i) => {
      const prev = ready[i - 1];
      const after = ready[i + 1];
      const duration = Math.max(0.5, Math.min(m.durationSec!, (film || m.end) - m.start, after ? after.start + score.mix.crossfadeSec - m.start : Infinity));
      const overlapIn = prev ? prev.start + (prev.durationSec ?? 0) > m.start + 0.05 : false;
      const overlapOut = after ? m.start + duration > after.start + 0.05 : false;
      clips.push(
        makeClip({
          trackId: i % 2 === 0 ? a.id : b.id,
          kind: 'audio',
          start: round3(m.start),
          duration: round3(duration),
          assetId: m.assetId,
          sourceDuration: m.durationSec,
          useSourceAudio: false,
          label: `${SCORE_CLIP_PREFIX} movement ${m.index + 1}`,
          role: 'music',
          duck: score.mix.ducking,
          duckDb: score.mix.duckDb,
          volume: gain,
          fadeIn: overlapIn ? score.mix.crossfadeSec : 0.8,
          fadeOut: overlapOut ? score.mix.crossfadeSec : 2,
          volumeAutomation: score.mix.intensityAutomation ? scoreAutomation(score.cueSheet, { start: m.start, end: m.start + duration }) : null,
        }),
      );
    });
  }
  return { ...next, clips: [...next.clips, ...clips] };
}
