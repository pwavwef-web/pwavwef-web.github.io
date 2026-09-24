import type { Clip, ClipKind, FrameAspect, LyricLine, TextPosition, TextStyle, TimelineDoc, Track, TrackKind } from './types';
import { lyricCaptionSpecs, type LyricCaptionMode, type LyricsSheet } from './lyrics';

export const MIN_CLIP_SECONDS = 0.1;
const EPS = 1e-6;

export type TimelineState = Pick<TimelineDoc, 'tracks' | 'clips' | 'markers' | 'fps' | 'aspectRatio' | 'beatGrid'>;

let counter = 0;
/** Short unique id (not cryptographic). */
export function uid(prefix = 'c'): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}${counter.toString(36)}`;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  font: 'Inter',
  sizePct: 5,
  color: '#FFFFFF',
  background: null,
  bold: true,
  italic: false,
  uppercase: false,
  outline: 2,
  shadow: true,
};

export const DEFAULT_CAPTION_POSITION: TextPosition = { anchor: 'bottom', offset: 0.08, align: 'center' };
export const DEFAULT_TITLE_POSITION: TextPosition = { anchor: 'middle', offset: 0, align: 'center' };

export function trackAccepts(kind: TrackKind, clip: ClipKind): boolean {
  switch (kind) {
    case 'video':
      return clip === 'video' || clip === 'image';
    case 'overlay':
      return clip === 'image' || clip === 'title' || clip === 'video';
    case 'caption':
      return clip === 'caption';
    case 'audio':
      return clip === 'audio';
  }
}

export function makeTrack(kind: TrackKind, name: string): Track {
  return { id: uid('t'), kind, name, muted: false, locked: false, volume: 1 };
}

export function defaultTracks(): Track[] {
  return [
    makeTrack('video', 'V1 Picture'),
    makeTrack('video', 'V2 Picture'),
    makeTrack('overlay', 'Overlays & titles'),
    makeTrack('caption', 'Captions'),
    makeTrack('audio', 'A1 Music'),
    makeTrack('audio', 'A2 Dialogue'),
    makeTrack('audio', 'A3 Effects'),
  ];
}

export function emptyTimeline(aspectRatio: FrameAspect = '16:9', fps: 24 | 25 | 30 = 24): TimelineState {
  return { tracks: defaultTracks(), clips: [], markers: [], fps, aspectRatio, beatGrid: null };
}

export function makeClip(partial: Partial<Clip> & Pick<Clip, 'trackId' | 'kind' | 'start' | 'duration'>): Clip {
  const isText = partial.kind === 'caption' || partial.kind === 'title';
  return {
    id: uid('c'),
    assetId: null,
    inPoint: 0,
    sourceDuration: null,
    volume: 1,
    useSourceAudio: partial.kind === 'video',
    fadeIn: 0,
    fadeOut: 0,
    transitionIn: { type: 'cut', duration: 0 },
    fit: 'fill',
    kenBurns: false,
    text: '',
    style: isText ? { ...DEFAULT_TEXT_STYLE, ...(partial.kind === 'title' ? { sizePct: 9, font: 'EB Garamond' as const } : {}) } : null,
    position: isText ? (partial.kind === 'title' ? DEFAULT_TITLE_POSITION : DEFAULT_CAPTION_POSITION) : null,
    label: '',
    shotId: null,
    takeId: null,
    ...partial,
  };
}

export const clipEnd = (c: Pick<Clip, 'start' | 'duration'>) => c.start + c.duration;

export function timelineDuration(clips: Clip[]): number {
  return clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

export function clipsOnTrack(state: Pick<TimelineState, 'clips'>, trackId: string, exceptId?: string): Clip[] {
  return state.clips.filter((c) => c.trackId === trackId && c.id !== exceptId).sort((a, b) => a.start - b.start);
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd - EPS && bStart < aEnd - EPS;
}

/**
 * Finds the free position closest to `desired` on a track for a clip of `duration` seconds.
 * Clips on the same track never overlap.
 */
export function findFreeStart(others: Clip[], desired: number, duration: number): number {
  const start = Math.max(0, desired);
  const sorted = [...others].sort((a, b) => a.start - b.start);
  const collides = (s: number) => sorted.some((o) => overlaps(s, s + duration, o.start, clipEnd(o)));
  if (!collides(start)) return start;
  const candidates = new Set<number>([0]);
  for (const o of sorted) {
    candidates.add(clipEnd(o));
    candidates.add(Math.max(0, o.start - duration));
  }
  let best = Number.POSITIVE_INFINITY;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    if (c < 0 || collides(c)) continue;
    const dist = Math.abs(c - start);
    if (dist < bestDist - EPS || (Math.abs(dist - bestDist) < EPS && c > best)) {
      best = c;
      bestDist = dist;
    }
  }
  if (Number.isFinite(best)) return best;
  return sorted.length ? clipEnd(sorted[sorted.length - 1]!) : start;
}

function replaceClip(state: TimelineState, clip: Clip): TimelineState {
  return { ...state, clips: state.clips.map((c) => (c.id === clip.id ? clip : c)) };
}

function getClip(state: TimelineState, id: string): Clip {
  const c = state.clips.find((x) => x.id === id);
  if (!c) throw new Error(`Clip ${id} not found`);
  return c;
}

function getTrack(state: TimelineState, id: string): Track {
  const t = state.tracks.find((x) => x.id === id);
  if (!t) throw new Error(`Track ${id} not found`);
  return t;
}

export function addClip(state: TimelineState, clip: Clip): TimelineState {
  const track = getTrack(state, clip.trackId);
  if (!trackAccepts(track.kind, clip.kind)) throw new Error(`A ${clip.kind} clip cannot go on a ${track.kind} track`);
  const start = findFreeStart(clipsOnTrack(state, clip.trackId), clip.start, clip.duration);
  return { ...state, clips: [...state.clips, { ...clip, start }] };
}

export function addClips(state: TimelineState, clips: Clip[]): TimelineState {
  return clips.reduce((s, c) => addClip(s, c), state);
}

/** Moves a clip in time and optionally to another compatible track. */
export function moveClip(state: TimelineState, id: string, desiredStart: number, trackId?: string): TimelineState {
  const clip = getClip(state, id);
  const targetTrackId = trackId ?? clip.trackId;
  const track = getTrack(state, targetTrackId);
  if (track.locked || getTrack(state, clip.trackId).locked) return state;
  if (!trackAccepts(track.kind, clip.kind)) return state;
  const start = findFreeStart(clipsOnTrack(state, targetTrackId, id), desiredStart, clip.duration);
  return replaceClip(state, { ...clip, start, trackId: targetTrackId });
}

/** Moves the clip's left edge (changes start, in-point and duration together). */
export function trimStart(state: TimelineState, id: string, newStart: number): TimelineState {
  const clip = getClip(state, id);
  if (getTrack(state, clip.trackId).locked) return state;
  const end = clipEnd(clip);
  const prev = clipsOnTrack(state, clip.trackId, id).filter((c) => clipEnd(c) <= clip.start + EPS).pop();
  let start = Math.min(newStart, end - MIN_CLIP_SECONDS);
  start = Math.max(start, prev ? clipEnd(prev) : 0);
  const hasSource = clip.sourceDuration !== null && (clip.kind === 'video' || clip.kind === 'audio');
  if (hasSource) {
    // Cannot reveal media before the source start.
    start = Math.max(start, clip.start - clip.inPoint);
  }
  const delta = start - clip.start;
  const inPoint = hasSource ? Math.max(0, clip.inPoint + delta) : clip.inPoint;
  return replaceClip(state, { ...clip, start, duration: end - start, inPoint });
}

/** Moves the clip's right edge. */
export function trimEnd(state: TimelineState, id: string, newEnd: number): TimelineState {
  const clip = getClip(state, id);
  if (getTrack(state, clip.trackId).locked) return state;
  const next = clipsOnTrack(state, clip.trackId, id).find((c) => c.start >= clipEnd(clip) - EPS);
  let end = Math.max(newEnd, clip.start + MIN_CLIP_SECONDS);
  if (next) end = Math.min(end, next.start);
  if (clip.sourceDuration !== null && (clip.kind === 'video' || clip.kind === 'audio')) {
    end = Math.min(end, clip.start + (clip.sourceDuration - clip.inPoint));
  }
  return replaceClip(state, { ...clip, duration: Math.max(MIN_CLIP_SECONDS, end - clip.start) });
}

/** Splits a clip at timeline time `t`. Returns the new state and the id of the right-hand part. */
export function splitClip(state: TimelineState, id: string, t: number): { state: TimelineState; rightId: string | null } {
  const clip = getClip(state, id);
  if (t <= clip.start + MIN_CLIP_SECONDS || t >= clipEnd(clip) - MIN_CLIP_SECONDS) return { state, rightId: null };
  const leftDuration = t - clip.start;
  const left: Clip = { ...clip, duration: leftDuration, fadeOut: 0 };
  const right: Clip = {
    ...clip,
    id: uid('c'),
    start: t,
    duration: clip.duration - leftDuration,
    inPoint: clip.kind === 'video' || clip.kind === 'audio' ? clip.inPoint + leftDuration : clip.inPoint,
    fadeIn: 0,
    transitionIn: { type: 'cut', duration: 0 },
  };
  return { state: { ...state, clips: state.clips.flatMap((c) => (c.id === id ? [left, right] : [c])) }, rightId: right.id };
}

export function deleteClips(state: TimelineState, ids: string[]): TimelineState {
  const set = new Set(ids);
  const lockedTracks = new Set(state.tracks.filter((t) => t.locked).map((t) => t.id));
  return { ...state, clips: state.clips.filter((c) => !set.has(c.id) || lockedTracks.has(c.trackId)) };
}

/** Deletes clips and closes the gaps they leave on their tracks. */
export function rippleDelete(state: TimelineState, ids: string[]): TimelineState {
  let next = state;
  const targets = state.clips.filter((c) => ids.includes(c.id)).sort((a, b) => b.start - a.start);
  for (const t of targets) {
    next = deleteClips(next, [t.id]);
    next = {
      ...next,
      clips: next.clips.map((c) => (c.trackId === t.trackId && c.start >= clipEnd(t) - EPS ? { ...c, start: Math.max(0, c.start - t.duration) } : c)),
    };
  }
  return next;
}

export function updateClip(state: TimelineState, id: string, patch: Partial<Omit<Clip, 'id' | 'trackId' | 'start' | 'duration'>>): TimelineState {
  const clip = getClip(state, id);
  const next = { ...clip, ...patch };
  // Transitions and fades can never exceed the clip itself.
  next.fadeIn = clamp(next.fadeIn, 0, next.duration / 2);
  next.fadeOut = clamp(next.fadeOut, 0, next.duration / 2);
  next.transitionIn = { ...next.transitionIn, duration: next.transitionIn.type === 'cut' ? 0 : clamp(next.transitionIn.duration, 0.1, Math.min(3, next.duration)) };
  next.volume = clamp(next.volume, 0, 2);
  return replaceClip(state, next);
}

export function setClipDuration(state: TimelineState, id: string, duration: number): TimelineState {
  const clip = getClip(state, id);
  return trimEnd(state, id, clip.start + duration);
}

export function updateTrack(state: TimelineState, id: string, patch: Partial<Omit<Track, 'id' | 'kind'>>): TimelineState {
  return { ...state, tracks: state.tracks.map((t) => (t.id === id ? { ...t, ...patch, volume: clamp(patch.volume ?? t.volume, 0, 2) } : t)) };
}

export function addTrack(state: TimelineState, kind: TrackKind, name?: string): TimelineState {
  const count = state.tracks.filter((t) => t.kind === kind).length + 1;
  const label = name ?? `${kind === 'video' ? 'V' : kind === 'audio' ? 'A' : kind === 'caption' ? 'Captions ' : 'Overlay '}${count}`;
  const track = makeTrack(kind, label);
  // Keep tracks grouped by kind in display order.
  const order: TrackKind[] = ['video', 'overlay', 'caption', 'audio'];
  const tracks = [...state.tracks, track].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return { ...state, tracks };
}

export function removeTrack(state: TimelineState, id: string): TimelineState {
  return { ...state, tracks: state.tracks.filter((t) => t.id !== id), clips: state.clips.filter((c) => c.trackId !== id) };
}

/** Lays the given clips back-to-back on their track in the given order, starting at the earliest start. */
export function resequence(state: TimelineState, trackId: string, orderedIds: string[]): TimelineState {
  const onTrack = clipsOnTrack(state, trackId);
  const byId = new Map(onTrack.map((c) => [c.id, c]));
  const ordered = orderedIds.map((id) => byId.get(id)).filter((c): c is Clip => Boolean(c));
  const rest = onTrack.filter((c) => !orderedIds.includes(c.id));
  let cursor = ordered.length ? Math.min(...ordered.map((c) => c.start)) : 0;
  const placed = new Map<string, Clip>();
  for (const c of ordered) {
    placed.set(c.id, { ...c, start: cursor });
    cursor += c.duration;
  }
  // Clips not in the list keep their relative order after the sequence.
  for (const c of rest.sort((a, b) => a.start - b.start)) {
    const start = Math.max(c.start, cursor);
    placed.set(c.id, { ...c, start });
    cursor = start + c.duration;
  }
  return { ...state, clips: state.clips.map((c) => placed.get(c.id) ?? c) };
}

export function clipsAt(state: Pick<TimelineState, 'clips'>, t: number): Clip[] {
  return state.clips.filter((c) => t >= c.start - EPS && t < clipEnd(c) - EPS);
}

/** Snap candidates: clip edges, markers, beats and the playhead. */
export function snapPoints(state: TimelineState, excludeClipId?: string, playhead?: number): number[] {
  const pts: number[] = [0];
  for (const c of state.clips) {
    if (c.id === excludeClipId) continue;
    pts.push(c.start, clipEnd(c));
  }
  for (const m of state.markers) pts.push(m.time);
  if (state.beatGrid) pts.push(...state.beatGrid.beats);
  if (playhead !== undefined) pts.push(playhead);
  return pts;
}

export function snap(t: number, points: number[], threshold: number): number {
  let best = t;
  let bestD = threshold;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
}

// ---------------------------------------------------------------------------
// Assembly helpers
// ---------------------------------------------------------------------------

export interface AssemblyItem {
  assetId: string;
  kind: 'video' | 'image';
  durationSec: number;
  sourceDuration: number | null;
  label: string;
  shotId?: string | null;
  takeId?: string | null;
  /** Preferred timeline start (music videos place shots at their song position). */
  at?: number | null;
}

/** Places picture items on the first video track: at their `at` time when given, otherwise back-to-back. */
export function assemblePicture(state: TimelineState, items: AssemblyItem[], transition: Clip['transitionIn'] = { type: 'cut', duration: 0 }): TimelineState {
  const track = state.tracks.find((t) => t.kind === 'video');
  if (!track) throw new Error('Timeline has no video track');
  let cursor = timelineDuration(clipsOnTrack(state, track.id));
  let next = state;
  for (const [i, it] of items.entries()) {
    const start = it.at ?? cursor;
    const duration = it.sourceDuration ? Math.min(it.durationSec, it.sourceDuration) : it.durationSec;
    const clip = makeClip({
      trackId: track.id,
      kind: it.kind,
      start,
      duration,
      assetId: it.assetId,
      sourceDuration: it.kind === 'video' ? it.sourceDuration : null,
      label: it.label,
      shotId: it.shotId ?? null,
      takeId: it.takeId ?? null,
      transitionIn: i === 0 ? { type: 'cut', duration: 0 } : transition,
      useSourceAudio: it.kind === 'video',
    });
    next = addClip(next, clip);
    cursor = clipEnd(next.clips[next.clips.length - 1]!);
  }
  return next;
}

export function lyricsToCaptions(state: TimelineState, lines: LyricLine[], style?: Partial<TextStyle>): TimelineState {
  const track = state.tracks.find((t) => t.kind === 'caption');
  if (!track) throw new Error('Timeline has no caption track');
  const clips = lines
    .filter((l) => l.text.trim() && l.end > l.start)
    .map((l) =>
      makeClip({
        trackId: track.id,
        kind: 'caption',
        start: l.start,
        duration: Math.max(MIN_CLIP_SECONDS, l.end - l.start),
        text: l.text.trim(),
        style: { ...DEFAULT_TEXT_STYLE, ...style },
        position: DEFAULT_CAPTION_POSITION,
        label: 'Lyric',
      }),
    );
  return addClips(state, clips);
}

/** Lays the song on the first audio track; `inPoint` starts it part-way (a production range). */
export function addAudioBed(state: TimelineState, assetId: string, durationSec: number, label = 'Song', opts: { inPoint?: number; sourceDuration?: number; songId?: string | null } = {}): TimelineState {
  const track = state.tracks.find((t) => t.kind === 'audio');
  if (!track) throw new Error('Timeline has no audio track');
  return addClip(state, makeClip({ trackId: track.id, kind: 'audio', start: 0, duration: durationSec, assetId, inPoint: opts.inPoint ?? 0, sourceDuration: opts.sourceDuration ?? durationSec, label, useSourceAudio: false, ...(opts.songId ? { songId: opts.songId, role: 'music' as const } : {}) }));
}

// ---------------------------------------------------------------------------
// Song-linked lyric captions
// ---------------------------------------------------------------------------

/** Caption presets per lyric layout (text is never altered — layout comes from size, margins and wrapping). */
export const LYRIC_CAPTION_PRESETS: Record<LyricCaptionMode, { style: Partial<TextStyle>; position: TextPosition }> = {
  line: { style: {}, position: DEFAULT_CAPTION_POSITION },
  karaoke: { style: { highlight: '#F4B84A' }, position: DEFAULT_CAPTION_POSITION },
  phrase: { style: { highlight: '#8AB6FF' }, position: DEFAULT_CAPTION_POSITION },
  subtitle: { style: { bold: false, sizePct: 4.2, outline: 2, shadow: true, background: null }, position: { anchor: 'bottom', offset: 0.06, align: 'center' } },
  vertical: { style: { sizePct: 6.2, outline: 3, highlight: '#F4B84A' }, position: { anchor: 'bottom', offset: 0.24, align: 'center' } },
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function songClips(state: Pick<TimelineState, 'clips'>, songId: string): Clip[] {
  return state.clips.filter((c) => c.kind === 'audio' && c.songId === songId).sort((a, b) => a.start - b.start);
}

/** Timeline time at which song time `t` is heard, or null when that part of the song is not on the timeline. */
export function songTimeToTimeline(state: Pick<TimelineState, 'clips'>, songId: string, t: number): number | null {
  for (const c of songClips(state, songId)) if (t >= c.inPoint - 1e-6 && t < c.inPoint + c.duration - 1e-6) return c.start + (t - c.inPoint);
  return null;
}

export interface LyricPlacement {
  lineId: string;
  start: number;
  duration: number;
  text: string;
  units: { text: string; start: number; end: number }[] | null;
}

/** Where each lyric line belongs on the timeline, following the song's audio clip(s). */
export function lyricPlacements(state: Pick<TimelineState, 'clips'>, songId: string, sheet: LyricsSheet, mode: LyricCaptionMode): LyricPlacement[] {
  const audio = songClips(state, songId);
  const out: LyricPlacement[] = [];
  for (const sp of lyricCaptionSpecs(sheet, mode)) {
    const a = audio.find((c) => sp.start >= c.inPoint - 1e-6 && sp.start < c.inPoint + c.duration - 1e-6);
    if (!a) continue;
    const endSong = Math.min(sp.end, a.inPoint + a.duration);
    const duration = endSong - sp.start;
    if (duration < MIN_CLIP_SECONDS) continue;
    out.push({
      lineId: sp.lineId,
      start: r3(a.start + (sp.start - a.inPoint)),
      duration: r3(duration),
      text: sp.text,
      units: sp.units ? sp.units.filter((u) => u.start < duration).map((u) => ({ ...u, end: r3(Math.min(u.end, duration)) })) : null,
    });
  }
  return out;
}

/**
 * (Re)creates a song's lyric captions from its sheet on a dedicated caption track. Style and position
 * already chosen for this song are kept when the layout is unchanged.
 */
export function applyLyricCaptions(state: TimelineState, songId: string, sheet: LyricsSheet, mode: LyricCaptionMode): TimelineState {
  const previous = state.clips.filter((c) => c.lyric?.songId === songId);
  const sameMode = previous.find((c) => c.lyric?.mode === mode);
  let next: TimelineState = { ...state, clips: state.clips.filter((c) => c.lyric?.songId !== songId) };
  let trackId = previous[0]?.trackId;
  if (!trackId || !next.tracks.some((t) => t.id === trackId)) {
    const free = next.tracks.find((t) => t.kind === 'caption' && (t.name === 'Lyrics' || !clipsOnTrack(next, t.id).length));
    if (free) trackId = free.id;
    else {
      next = addTrack(next, 'caption', 'Lyrics');
      trackId = next.tracks.filter((t) => t.kind === 'caption').pop()!.id;
    }
  }
  const preset = LYRIC_CAPTION_PRESETS[mode];
  const style: TextStyle = sameMode?.style ?? { ...DEFAULT_TEXT_STYLE, ...preset.style };
  const position: TextPosition = sameMode?.position ?? preset.position;
  const clips = lyricPlacements(next, songId, sheet, mode).map((p) =>
    makeClip({ trackId: trackId!, kind: 'caption', start: p.start, duration: p.duration, text: p.text, style, position, label: 'Lyric', lyric: { songId, lineId: p.lineId, mode }, karaoke: p.units }),
  );
  return { ...next, clips: [...next.clips, ...clips] };
}

/** Re-times every song's lyric captions (after the song is moved, trimmed or its lyrics corrected). */
export function resyncLyricCaptions(state: TimelineState, sheets: Record<string, LyricsSheet | null | undefined>): TimelineState {
  const songs = [...new Set(state.clips.map((c) => c.lyric?.songId).filter((x): x is string => Boolean(x)))];
  let next = state;
  for (const songId of songs) {
    const sheet = sheets[songId];
    if (!sheet) continue;
    const mode = state.clips.find((c) => c.lyric?.songId === songId)!.lyric!.mode;
    next = applyLyricCaptions(next, songId, sheet, mode);
  }
  return next;
}

/** True when a song's audio clip moved, was trimmed or split between two timeline states. */
export function songClipsChanged(a: Pick<TimelineState, 'clips'>, b: Pick<TimelineState, 'clips'>): boolean {
  const key = (s: Pick<TimelineState, 'clips'>) =>
    s.clips
      .filter((c) => c.kind === 'audio' && c.songId)
      .map((c) => `${c.id}:${c.songId}:${r3(c.start)}:${r3(c.inPoint)}:${r3(c.duration)}`)
      .sort()
      .join('|');
  return key(a) !== key(b);
}

export type LyricSyncIssueKind = 'early' | 'late' | 'too_long' | 'overruns' | 'orphaned' | 'outside_audio' | 'missing';

export interface LyricSyncIssue {
  songId: string;
  lineId: string;
  clipId: string | null;
  kind: LyricSyncIssueKind;
  deltaSec: number;
  message: string;
}

/**
 * Final synchronisation check before rendering: every lyric caption must start with its vocal, not
 * linger, and end before the next sung line.
 */
export function checkLyricSync(state: Pick<TimelineState, 'clips'>, sheets: Record<string, LyricsSheet | null | undefined>, tolerance = 0.15): LyricSyncIssue[] {
  const issues: LyricSyncIssue[] = [];
  const captions = state.clips.filter((c) => c.kind === 'caption' && c.lyric);
  const songs = [...new Set(captions.map((c) => c.lyric!.songId))];
  const short = (t: string) => (t.length > 40 ? `${t.slice(0, 40)}…` : t);
  for (const songId of songs) {
    const sheet = sheets[songId];
    const mine = captions.filter((c) => c.lyric!.songId === songId);
    if (!sheet) {
      for (const c of mine) issues.push({ songId, lineId: c.lyric!.lineId, clipId: c.id, kind: 'orphaned', deltaSec: 0, message: `“${short(c.text)}” belongs to a song whose lyrics are no longer available.` });
      continue;
    }
    const mode = mine[0]!.lyric!.mode;
    const expected = new Map(lyricPlacements(state, songId, sheet, mode).map((p) => [p.lineId, p]));
    const order = sheet.lines.map((l) => l.id);
    for (const c of mine) {
      const lineId = c.lyric!.lineId;
      const exp = expected.get(lineId);
      const line = sheet.lines.find((l) => l.id === lineId);
      if (!line) {
        issues.push({ songId, lineId, clipId: c.id, kind: 'orphaned', deltaSec: 0, message: `“${short(c.text)}” is no longer in the lyric sheet.` });
        continue;
      }
      if (!exp) {
        issues.push({ songId, lineId, clipId: c.id, kind: 'outside_audio', deltaSec: 0, message: `“${short(line.text)}” is shown where that part of the song is not playing.` });
        continue;
      }
      if (c.text !== line.text) issues.push({ songId, lineId, clipId: c.id, kind: 'orphaned', deltaSec: 0, message: `“${short(c.text)}” no longer matches the corrected lyric “${short(line.text)}”.` });
      const d = r3(c.start - exp.start);
      if (d < -tolerance) issues.push({ songId, lineId, clipId: c.id, kind: 'early', deltaSec: d, message: `“${short(line.text)}” appears ${Math.abs(d).toFixed(2)} s before it is sung.` });
      else if (d > tolerance) issues.push({ songId, lineId, clipId: c.id, kind: 'late', deltaSec: d, message: `“${short(line.text)}” appears ${d.toFixed(2)} s after it is sung.` });
      const endDiff = r3(c.start + c.duration - (exp.start + exp.duration));
      if (endDiff > 0.6) issues.push({ songId, lineId, clipId: c.id, kind: 'too_long', deltaSec: endDiff, message: `“${short(line.text)}” stays on screen ${endDiff.toFixed(2)} s after the phrase ends.` });
      const nextId = order[order.indexOf(lineId) + 1];
      const next = nextId ? expected.get(nextId) : undefined;
      if (next && c.start + c.duration > next.start + 0.05) issues.push({ songId, lineId, clipId: c.id, kind: 'overruns', deltaSec: r3(c.start + c.duration - next.start), message: `“${short(line.text)}” is still showing when the next line is sung.` });
    }
    const shown = new Set(mine.map((c) => c.lyric!.lineId));
    for (const [lineId, p] of expected) if (!shown.has(lineId)) issues.push({ songId, lineId, clipId: null, kind: 'missing', deltaSec: 0, message: `“${short(p.text)}” is sung but has no caption.` });
  }
  return issues;
}

/** Where the next clip goes when appending to a track: the end of its last clip. */
export function trackEnd(state: Pick<TimelineState, 'clips'>, trackId: string): number {
  return timelineDuration(clipsOnTrack(state, trackId));
}

/** Structural validation before saving or rendering. Returns human-readable problems. */
export function validateTimeline(state: TimelineState): string[] {
  const problems: string[] = [];
  const trackIds = new Set(state.tracks.map((t) => t.id));
  for (const c of state.clips) {
    if (!trackIds.has(c.trackId)) problems.push(`Clip “${c.label || c.id}” is on a missing track.`);
    if (!(c.duration >= MIN_CLIP_SECONDS)) problems.push(`Clip “${c.label || c.id}” is too short.`);
    if (c.start < -EPS) problems.push(`Clip “${c.label || c.id}” starts before zero.`);
    if ((c.kind === 'video' || c.kind === 'image' || c.kind === 'audio') && !c.assetId) problems.push(`Clip “${c.label || c.id}” has no media.`);
    if ((c.kind === 'caption' || c.kind === 'title') && !c.text.trim()) problems.push(`A ${c.kind} clip has no text.`);
    if (c.sourceDuration !== null && c.inPoint + c.duration > c.sourceDuration + 0.05) problems.push(`Clip “${c.label || c.id}” runs past the end of its media.`);
  }
  for (const t of state.tracks) {
    const cs = clipsOnTrack(state, t.id);
    for (let i = 1; i < cs.length; i++) {
      if (overlaps(cs[i - 1]!.start, clipEnd(cs[i - 1]!), cs[i]!.start, clipEnd(cs[i]!))) problems.push(`Clips overlap on track “${t.name}”.`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

export function pushHistory<T>(h: History<T>, next: T, limit = 200): History<T> {
  if (next === h.present) return h;
  const past = [...h.past, h.present];
  if (past.length > limit) past.splice(0, past.length - limit);
  return { past, present: next, future: [] };
}

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  const prev = h.past[h.past.length - 1]!;
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  const [next, ...rest] = h.future;
  return { past: [...h.past, h.present], present: next!, future: rest };
}
