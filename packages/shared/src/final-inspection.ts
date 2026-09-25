import { clipEnd, clipsAt, trimEnd, trimStart, updateClip, type TimelineState } from './timeline';
import type { Clip } from './types';

/**
 * Final-film inspection: the assembled, rendered timeline is measured end to end before export.
 * Findings come from the real render (FFmpeg analysis, transcription, OCR, the reviewer) and from the
 * timeline itself; each finding says whether AZ Studio can fix it automatically (as a timeline edit,
 * followed by a re-render and re-inspection) or needs the director. Export stays blocked while any
 * error is open, unless the director overrides it explicitly (recorded).
 */

export const FINAL_CHECKS = [
  'missing_shot',
  'wrong_order',
  'repeated_shot',
  'black_frames',
  'frozen_frames',
  'corrupted_frames',
  'abrupt_cut',
  'continuity_between_shots',
  'colour_inconsistency',
  'audio_clipping',
  'loudness',
  'silence_gap',
  'music_restart',
  'dialogue_drowned',
  'missing_dialogue',
  'lyric_sync',
  'lyric_cropped',
  'credits_incorrect',
  'credits_cut_off',
  'aspect_ratio',
  'resolution',
  'missing_media',
  'watermark',
  'private_information',
  'incomplete_final_action',
] as const;
export type FinalCheck = (typeof FINAL_CHECKS)[number];

export const FINAL_CHECK_LABELS: Record<FinalCheck, string> = {
  missing_shot: 'Missing shot',
  wrong_order: 'Shots out of order',
  repeated_shot: 'Repeated shot',
  black_frames: 'Black frames',
  frozen_frames: 'Frozen frames',
  corrupted_frames: 'Corrupted frames',
  abrupt_cut: 'Abrupt cut',
  continuity_between_shots: 'Continuity between shots',
  colour_inconsistency: 'Colour inconsistency',
  audio_clipping: 'Audio clipping / peaks',
  loudness: 'Loudness',
  silence_gap: 'Silence gap',
  music_restart: 'Music restarts',
  dialogue_drowned: 'Dialogue drowned by music',
  missing_dialogue: 'Missing dialogue',
  lyric_sync: 'Unsynchronised lyrics',
  lyric_cropped: 'Cropped lyrics',
  credits_incorrect: 'Incorrect credits',
  credits_cut_off: 'Credits cut off',
  aspect_ratio: 'Aspect ratio',
  resolution: 'Export resolution',
  missing_media: 'Missing media',
  watermark: 'Unexpected watermark / logo',
  private_information: 'Private information',
  incomplete_final_action: 'Incomplete final action',
};

export type FindingSeverity = 'error' | 'warning' | 'info';

export type FixType = 'trim_clip_start' | 'trim_clip_end' | 'close_gap' | 'reduce_gain' | 'enable_limiter' | 'shrink_text' | 'reposition_text' | 'shorten_credits' | 'resync_lyrics' | 'color_match_shot';

export interface FinalFix {
  type: FixType;
  label: string;
  clipId: string | null;
  params: Record<string, number | string | boolean | null>;
}

export interface FinalFinding {
  id: string;
  check: FinalCheck;
  severity: FindingSeverity;
  startSec: number | null;
  endSec: number | null;
  message: string;
  clipIds: string[];
  source: 'measured' | 'timeline' | 'model' | 'ocr' | 'transcript';
  fix: FinalFix | null;
  /** Needs the director (no automatic fix, or the fix is a creative decision). */
  manual: boolean;
  resolvedAt?: number | null;
  overridden?: { at: number; note: string } | null;
  /** An automatic fix was applied to the timeline (verified only by the next render and inspection). */
  fixedAt?: number | null;
  fixedInTimelineVersion?: number | null;
}

export type ExportReadiness = 'ready' | 'blocked' | 'overridden';

export interface FinalInspectionDoc {
  id: string;
  projectId: string;
  timelineId: string;
  timelineVersion: number;
  renderId: string;
  renderAssetId: string | null;
  jobId: string;
  status: 'running' | 'completed' | 'failed';
  findings: FinalFinding[];
  score: number | null;
  errors: number;
  warnings: number;
  readiness: ExportReadiness;
  override: { at: number; note: string } | null;
  measurements: Record<string, unknown>;
  summary: string;
  /** Fixes were applied to the timeline after this render: render and inspect again to verify them. */
  needsRerender?: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

let counter = 0;
const fid = (c: string) => `f_${c}_${Date.now().toString(36)}${(counter = (counter + 1) % 100000).toString(36)}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function finding(check: FinalCheck, severity: FindingSeverity, message: string, source: FinalFinding['source'], extra: Partial<FinalFinding> = {}): FinalFinding {
  return { id: fid(check), check, severity, startSec: null, endSec: null, message, clipIds: [], source, fix: null, manual: !extra.fix, ...extra };
}

const pictureClips = (s: Pick<TimelineState, 'clips' | 'tracks'>) => {
  const visual = new Set(s.tracks.filter((t) => t.kind === 'video' && !t.muted).map((t) => t.id));
  return s.clips.filter((c) => visual.has(c.trackId) && (c.kind === 'video' || c.kind === 'image')).sort((a, b) => a.start - b.start);
};

// ---------------------------------------------------------------------------
// Structure: missing, repeated and out-of-order shots (timeline vs the approved shot list)
// ---------------------------------------------------------------------------

export function structureFindings(state: Pick<TimelineState, 'clips' | 'tracks'>, shots: { id: string; number: string; title: string; order: number; approvedTakeId: string | null; sceneId: string | null }[]): FinalFinding[] {
  const out: FinalFinding[] = [];
  const pics = pictureClips(state);
  const used = pics.filter((c) => c.shotId);
  for (const s of shots.filter((x) => x.approvedTakeId)) {
    if (!used.some((c) => c.shotId === s.id)) out.push(finding('missing_shot', 'warning', `Approved shot ${s.number || ''} “${s.title}” is not in the edit.`, 'timeline'));
  }
  const seen = new Map<string, Clip>();
  for (const c of used) {
    const key = `${c.shotId}:${c.takeId ?? c.assetId}`;
    const prev = seen.get(key);
    if (prev && Math.abs(prev.inPoint - c.inPoint) < 0.5) out.push(finding('repeated_shot', 'warning', `“${c.label || 'A shot'}” appears twice (at ${r2(prev.start)} s and ${r2(c.start)} s).`, 'timeline', { startSec: c.start, endSec: clipEnd(c), clipIds: [prev.id, c.id] }));
    else seen.set(key, c);
  }
  const orderOf = new Map(shots.map((s) => [s.id, s.order]));
  const seq = used.map((c) => ({ c, o: orderOf.get(c.shotId!) })).filter((x): x is { c: Clip; o: number } => x.o !== undefined);
  for (let i = 1; i < seq.length; i++) {
    if (seq[i]!.o < seq[i - 1]!.o) {
      const a = shots.find((s) => s.id === seq[i - 1]!.c.shotId);
      const b = shots.find((s) => s.id === seq[i]!.c.shotId);
      out.push(finding('wrong_order', 'info', `Shot ${b?.number || b?.title} plays after ${a?.number || a?.title} although the shot list has it earlier — check this is intended.`, 'timeline', { startSec: seq[i]!.c.start, clipIds: [seq[i]!.c.id] }));
    }
  }
  return out;
}

/** Clips referencing media that no longer exists (or is not ready). */
export function missingMediaFindings(state: Pick<TimelineState, 'clips'>, available: Set<string>): FinalFinding[] {
  return state.clips.filter((c) => c.assetId && !available.has(c.assetId)).map((c) => finding('missing_media', 'error', `“${c.label || c.kind}” uses media that is missing or not ready.`, 'timeline', { startSec: c.start, endSec: clipEnd(c), clipIds: [c.id] }));
}

// ---------------------------------------------------------------------------
// Picture measurements
// ---------------------------------------------------------------------------

/** Black frames: trim the clip edge that holds them, or close an empty gap. */
export function blackFindings(segments: { start: number; end: number }[], state: Pick<TimelineState, 'clips' | 'tracks'>, opts: { intentional?: { start: number; end: number }[] } = {}): FinalFinding[] {
  const out: FinalFinding[] = [];
  const pics = pictureClips(state);
  const dur = Math.max(0, ...state.clips.map((c) => clipEnd(c)));
  for (const b of segments) {
    if (b.end - b.start < 0.04) continue;
    if ((opts.intentional ?? []).some((x) => b.start >= x.start - 0.1 && b.end <= x.end + 0.1)) continue;
    // Fade-to-black at the very start/end of the film is intentional when it is short.
    if ((b.start < 0.05 || b.end > dur - 0.05) && b.end - b.start <= 1.5) continue;
    const mid = (b.start + b.end) / 2;
    const under = pics.filter((c) => mid >= c.start && mid < clipEnd(c));
    let fix: FinalFix | null = null;
    let clipIds: string[] = [];
    if (!under.length) {
      const next = pics.find((c) => c.start >= b.end - 0.05);
      if (next) fix = { type: 'close_gap', label: `Close the ${r2(b.end - b.start)} s gap`, clipId: next.id, params: { from: r2(b.start), to: r2(b.end) } };
    } else {
      const c = under[0]!;
      clipIds = [c.id];
      if (b.start - c.start < 0.2) fix = { type: 'trim_clip_start', label: `Trim ${r2(b.end - c.start)} s of black from the start of “${c.label || 'the clip'}”`, clipId: c.id, params: { to: r2(b.end + 0.02) } };
      else if (clipEnd(c) - b.end < 0.2) fix = { type: 'trim_clip_end', label: `Trim ${r2(clipEnd(c) - b.start)} s of black from the end of “${c.label || 'the clip'}”`, clipId: c.id, params: { to: r2(b.start - 0.02) } };
    }
    out.push(finding('black_frames', 'error', `Black frames from ${r2(b.start)} s to ${r2(b.end)} s${under[0] ? ` (in “${under[0].label || 'a clip'}”)` : ' (a gap between clips)'}.`, 'measured', { startSec: r2(b.start), endSec: r2(b.end), clipIds, fix, manual: !fix }));
  }
  return out;
}

export function frozenFindings(frozen: { start: number; end: number }[], state: Pick<TimelineState, 'clips' | 'tracks'>): FinalFinding[] {
  const pics = pictureClips(state);
  return frozen
    .filter((f) => f.end - f.start >= 0.6)
    .filter((f) => !pics.some((c) => c.kind === 'image' && f.start >= c.start - 0.05 && f.end <= clipEnd(c) + 0.05 && !c.kenBurns))
    .map((f) => finding('frozen_frames', f.end - f.start > 2 ? 'error' : 'warning', `The picture freezes from ${r2(f.start)} s to ${r2(f.end)} s.`, 'measured', { startSec: r2(f.start), endSec: r2(f.end), clipIds: clipsAt({ clips: pics }, (f.start + f.end) / 2).map((c) => c.id) }));
}

// ---------------------------------------------------------------------------
// Sound measurements
// ---------------------------------------------------------------------------

export interface LoudnessMeasure {
  integratedLufs: number | null;
  truePeakDb: number | null;
  /** Moments where the sample peak reaches or exceeds the limit (s, dBFS). */
  peaks: { t: number; db: number }[];
}

export function loudnessFindings(m: LoudnessMeasure, state: Pick<TimelineState, 'clips' | 'tracks'>, target = -14): FinalFinding[] {
  const out: FinalFinding[] = [];
  const audible = (c: Clip) => c.kind === 'audio' || (c.kind === 'video' && c.useSourceAudio);
  const groups: { t: number; db: number }[] = [];
  for (const p of [...m.peaks].sort((a, b) => a.t - b.t)) {
    const g = groups[groups.length - 1];
    if (g && p.t - g.t < 1) g.db = Math.max(g.db, p.db);
    else groups.push({ ...p });
  }
  for (const g of groups.slice(0, 12)) {
    const under = state.clips.filter((c) => audible(c) && g.t >= c.start && g.t < clipEnd(c)).sort((a, b) => b.volume - a.volume);
    const loudest = under[0];
    const over = g.db + 1;
    const fix: FinalFix | null = loudest ? { type: 'reduce_gain', label: `Lower “${loudest.label || 'the clip'}” by ${Math.max(1, Math.ceil(over + 1))} dB`, clipId: loudest.id, params: { db: Math.max(1, Math.ceil(over + 1)) } } : { type: 'enable_limiter', label: 'Add a limiter to the master', clipId: null, params: {} };
    out.push(finding('audio_clipping', g.db >= -0.1 ? 'error' : 'warning', `Audio peaks at ${g.db.toFixed(1)} dBFS at ${r2(g.t)} s${loudest ? ` (“${loudest.label || 'a clip'}”)` : ''}.`, 'measured', { startSec: r2(g.t), endSec: r2(g.t + 0.5), clipIds: under.map((c) => c.id), fix, manual: false }));
  }
  if (m.truePeakDb !== null && m.truePeakDb > -1 && !groups.length) out.push(finding('audio_clipping', 'warning', `True peak ${m.truePeakDb.toFixed(1)} dBTP exceeds −1 dBTP.`, 'measured', { fix: { type: 'enable_limiter', label: 'Add a limiter to the master', clipId: null, params: {} }, manual: false }));
  if (m.integratedLufs !== null && Math.abs(m.integratedLufs - target) > 3) out.push(finding('loudness', 'warning', `Integrated loudness is ${m.integratedLufs.toFixed(1)} LUFS (target ${target} LUFS for streaming).`, 'measured', { manual: false, fix: { type: 'enable_limiter', label: `Normalise the master to ${target} LUFS (final render)`, clipId: null, params: { target } } }));
  return out;
}

export function silenceFindings(silences: { start: number; end: number }[], state: Pick<TimelineState, 'clips' | 'tracks'>, minSec = 2): FinalFinding[] {
  const dur = Math.max(0, ...state.clips.map((c) => clipEnd(c)));
  return silences
    .filter((s) => s.end - s.start >= minSec && s.start > 0.5 && s.end < dur - 0.5)
    .map((s) => finding('silence_gap', 'warning', `${r2(s.end - s.start)} s of silence from ${r2(s.start)} s — intended?`, 'measured', { startSec: r2(s.start), endSec: r2(s.end) }));
}

/** A song or score that starts again from its beginning mid-film, or leaves a short hole between movements. */
export function musicRestartFindings(state: Pick<TimelineState, 'clips' | 'tracks'>): FinalFinding[] {
  const out: FinalFinding[] = [];
  const music = state.clips.filter((c) => c.kind === 'audio' && (c.role === 'music' || c.songId)).sort((a, b) => a.start - b.start);
  for (let i = 1; i < music.length; i++) {
    const a = music[i - 1]!;
    const b = music[i]!;
    const gap = b.start - clipEnd(a);
    const sameSource = a.assetId === b.assetId;
    if (sameSource && b.inPoint < a.inPoint + a.duration - 1 && b.inPoint <= 0.5 && gap < 5) {
      out.push(finding('music_restart', 'warning', `“${b.label || 'The music'}” starts again from the beginning at ${r2(b.start)} s.`, 'timeline', { startSec: r2(b.start), clipIds: [a.id, b.id] }));
    } else if (gap > 0.15 && gap < 2 && !b.fadeIn && !a.fadeOut) {
      out.push(finding('music_restart', 'info', `Music stops for ${r2(gap)} s at ${r2(clipEnd(a))} s and restarts without a fade.`, 'timeline', { startSec: r2(clipEnd(a)), endSec: r2(b.start), clipIds: [a.id, b.id] }));
    }
  }
  return out;
}

/** Music that is not ducked while dialogue plays, at a level likely to cover it. */
export function dialogueMaskingFindings(state: Pick<TimelineState, 'clips' | 'tracks'>, dialogueSpans: { start: number; end: number }[]): FinalFinding[] {
  const out: FinalFinding[] = [];
  const tracks = new Map(state.tracks.map((t) => [t.id, t]));
  const music = state.clips.filter((c) => c.kind === 'audio' && c.role === 'music' && !tracks.get(c.trackId)?.muted);
  for (const m of music) {
    if (m.duck) continue;
    const gain = m.volume * (tracks.get(m.trackId)?.volume ?? 1);
    const overlap = dialogueSpans.filter((d) => d.start < clipEnd(m) && d.end > m.start);
    if (overlap.length && gain > 0.35) {
      out.push(
        finding('dialogue_drowned', 'warning', `“${m.label || 'Music'}” plays at ${Math.round(20 * Math.log10(gain))} dB under ${overlap.length} dialogue passage(s) without ducking.`, 'timeline', {
          startSec: r2(overlap[0]!.start),
          clipIds: [m.id],
          fix: { type: 'reduce_gain', label: `Duck “${m.label || 'the music'}” under dialogue`, clipId: m.id, params: { duck: true, db: 0 } },
          manual: false,
        }),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text: lyrics and credits
// ---------------------------------------------------------------------------

export function lyricLayoutFindings(issues: { lineId: string; kind: string; message: string; clipId?: string | null; start?: number | null }[]): FinalFinding[] {
  return issues
    .filter((i) => i.kind === 'cropped' || i.kind === 'outside_safe_area' || i.kind === 'covers_face' || i.kind === 'overlaps_next' || i.kind === 'diacritics_clipped')
    .map((i) =>
      finding(i.kind === 'overlaps_next' ? 'lyric_sync' : 'lyric_cropped', i.kind === 'cropped' || i.kind === 'diacritics_clipped' ? 'error' : 'warning', i.message, 'timeline', {
        startSec: i.start ?? null,
        clipIds: i.clipId ? [i.clipId] : [],
        fix: i.clipId && (i.kind === 'cropped' || i.kind === 'outside_safe_area' || i.kind === 'diacritics_clipped') ? { type: 'shrink_text', label: 'Reduce the text size so it fits the safe area', clipId: i.clipId, params: { factor: 0.82 } } : i.clipId && i.kind === 'covers_face' ? { type: 'reposition_text', label: 'Move the lyric clear of faces', clipId: i.clipId, params: {} } : null,
        manual: !i.clipId,
      }),
    );
}

/** OCR of a rendered caption against its text: missing leading/trailing characters mean it is cropped. */
export function ocrCropFinding(expected: string, ocr: string, at: number, clipId: string | null): FinalFinding | null {
  const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const e = norm(expected);
  const o = norm(ocr);
  if (!e || o.includes(e)) return null;
  const head = e.slice(0, Math.min(4, e.length));
  const tail = e.slice(-Math.min(4, e.length));
  const cutStart = !o.includes(head) && o.includes(e.slice(Math.min(e.length - 1, 5), Math.min(e.length, 12)));
  const cutEnd = !o.includes(tail) && o.includes(e.slice(0, Math.min(8, e.length)));
  if (!cutStart && !cutEnd) return null;
  return finding('lyric_cropped', 'error', `The rendered text “${expected.slice(0, 50)}” is cut off at the ${cutStart ? 'start' : 'end'} (OCR read “${ocr.slice(0, 50)}”).`, 'ocr', { startSec: r2(at), clipIds: clipId ? [clipId] : [], fix: clipId ? { type: 'shrink_text', label: 'Reduce the text size so it fits', clipId, params: { factor: 0.8 } } : null, manual: !clipId });
}

export function creditsFindings(credits: { clipId: string; name: string; finishesAt: number; issues: string[] }[], videoEnd: number): FinalFinding[] {
  const out: FinalFinding[] = [];
  for (const c of credits) {
    if (c.finishesAt > videoEnd + 0.01) out.push(finding('credits_cut_off', 'error', `${c.name} finish at ${r2(c.finishesAt)} s but the video ends at ${r2(videoEnd)} s.`, 'timeline', { startSec: r2(videoEnd), clipIds: [c.clipId], fix: { type: 'shorten_credits', label: `Fit ${c.name} before the end`, clipId: c.clipId, params: { endAt: r2(videoEnd - 0.3) } }, manual: false }));
    for (const i of c.issues.filter((x) => !/finish at/i.test(x))) out.push(finding('credits_incorrect', 'warning', `${c.name}: ${i}`, 'timeline', { clipIds: [c.clipId] }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Format and privacy
// ---------------------------------------------------------------------------

export function formatFindings(probe: { width: number; height: number; durationSec: number; hasAudio: boolean }, expected: { width: number; height: number; durationSec: number }): FinalFinding[] {
  const out: FinalFinding[] = [];
  const ra = probe.width / Math.max(1, probe.height);
  const ea = expected.width / Math.max(1, expected.height);
  if (Math.abs(ra - ea) > 0.01) out.push(finding('aspect_ratio', 'error', `The export is ${probe.width}×${probe.height} (${ra.toFixed(3)}), expected aspect ${ea.toFixed(3)}.`, 'measured'));
  else if (probe.width !== expected.width || probe.height !== expected.height) out.push(finding('resolution', 'error', `The export is ${probe.width}×${probe.height}; the preset needs ${expected.width}×${expected.height}.`, 'measured'));
  if (Math.abs(probe.durationSec - expected.durationSec) > 0.25) out.push(finding('resolution', 'warning', `The export lasts ${r2(probe.durationSec)} s; the timeline is ${r2(expected.durationSec)} s.`, 'measured'));
  if (!probe.hasAudio) out.push(finding('missing_dialogue', 'error', 'The export has no audio track.', 'measured'));
  return out;
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/;
const URL = /\b(?:https?:\/\/|www\.)\S+/i;

/** Personal data visible in the picture (emails, phone numbers, web addresses not approved). */
export function privateInfoFindings(frames: { t: number; text: string }[], allowed: string[] = []): FinalFinding[] {
  const out: FinalFinding[] = [];
  const ok = (s: string) => allowed.some((a) => a && s.toLowerCase().includes(a.toLowerCase()));
  for (const f of frames) {
    for (const [re, label] of [
      [EMAIL, 'an email address'],
      [PHONE, 'a phone number'],
      [URL, 'a web address'],
    ] as const) {
      const m = re.exec(f.text);
      if (m && !ok(m[0])) out.push(finding('private_information', 'error', `${label[0]!.toUpperCase()}${label.slice(1)} is readable at ${r2(f.t)} s: “${m[0].slice(0, 40)}”.`, 'ocr', { startSec: r2(f.t) }));
    }
  }
  return dedupeByMessage(out);
}

function dedupeByMessage(xs: FinalFinding[]): FinalFinding[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.message.replace(/at [\d.]+ s/, '')) ? false : (seen.add(x.message.replace(/at [\d.]+ s/, '')), true)));
}

// ---------------------------------------------------------------------------
// Score, readiness and fixes
// ---------------------------------------------------------------------------

export function finalScore(findings: FinalFinding[]): number {
  const open = findings.filter((f) => !f.resolvedAt && !f.overridden);
  const penalty = open.reduce((s, f) => s + (f.severity === 'error' ? 14 : f.severity === 'warning' ? 5 : 1), 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

export function exportReadiness(findings: FinalFinding[], override: { at: number; note: string } | null): ExportReadiness {
  const blocking = findings.filter((f) => f.severity === 'error' && !f.resolvedAt && !f.overridden);
  if (!blocking.length) return 'ready';
  return override ? 'overridden' : 'blocked';
}

/** Applies one automatic fix to the timeline (pure). Returns null when the fix no longer applies. */
export function applyFinalFix(state: TimelineState, fix: FinalFix): TimelineState | null {
  const clip = fix.clipId ? state.clips.find((c) => c.id === fix.clipId) : null;
  switch (fix.type) {
    case 'trim_clip_start':
      return clip ? trimStart(state, clip.id, Number(fix.params.to)) : null;
    case 'trim_clip_end':
      return clip ? trimEnd(state, clip.id, Number(fix.params.to)) : null;
    case 'close_gap': {
      if (!clip) return null;
      const from = Number(fix.params.from);
      const to = Number(fix.params.to);
      const gap = to - from;
      // Prefer filling the hole with real picture (keeps every cut on the music): extend the previous
      // clip if its source runs on, else start the next clip earlier if it has a handle; otherwise ripple
      // only the picture track.
      const track = clip.trackId;
      const prev = state.clips.filter((c) => c.trackId === track && clipEnd(c) <= clip.start + 0.05).sort((a, b) => clipEnd(b) - clipEnd(a))[0];
      if (prev && prev.kind === 'video' && prev.sourceDuration !== null && prev.sourceDuration - prev.inPoint - prev.duration >= gap - 0.01) return trimEnd(state, prev.id, clipEnd(prev) + gap);
      if (prev && prev.kind === 'image') return trimEnd(state, prev.id, clipEnd(prev) + gap);
      if (clip.kind === 'video' && clip.inPoint >= gap - 0.01) return trimStart(state, clip.id, clip.start - gap);
      return { ...state, clips: state.clips.map((c) => (c.trackId === track && c.start >= to - 0.05 ? { ...c, start: Math.max(0, Math.round((c.start - gap) * 1000) / 1000) } : c)) };
    }
    case 'reduce_gain': {
      if (!clip) return null;
      if (fix.params.duck) return updateClip(state, clip.id, { duck: true, duckDb: Math.max(clip.duckDb ?? 0, 12), role: clip.role ?? 'music' });
      const db = Number(fix.params.db) || 3;
      return updateClip(state, clip.id, { volume: Math.round(clip.volume * 10 ** (-db / 20) * 1000) / 1000 });
    }
    case 'shrink_text': {
      if (!clip || !clip.style) return null;
      const factor = Number(fix.params.factor) || 0.85;
      return updateClip(state, clip.id, { style: { ...clip.style, sizePct: Math.max(2, Math.round(clip.style.sizePct * factor * 100) / 100) } });
    }
    case 'reposition_text': {
      if (!clip || !clip.position) return null;
      return updateClip(state, clip.id, { position: { ...clip.position, anchor: clip.position.anchor === 'bottom' ? 'top' : 'bottom' } });
    }
    case 'shorten_credits': {
      if (!clip) return null;
      const endAt = Number(fix.params.endAt);
      const dur = Math.max(2, endAt - clip.start);
      return { ...state, clips: state.clips.map((c) => (c.id === clip.id ? { ...c, duration: Math.round(dur * 1000) / 1000 } : c)) };
    }
    default:
      return null;
  }
}
