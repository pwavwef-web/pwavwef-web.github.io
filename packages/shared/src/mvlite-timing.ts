import { snapToBeat } from './audio';
import { barSeconds, type MvLiteSpec, type MvSong } from './mvlite';
import { productionRange } from './range';

/**
 * Music Video Lite timing. The song is the clock: the video spans the chosen part of the song (plus a short
 * picture hold after it), sections are contiguous spans of song time, and each section's real length is
 * shared among its shots in proportion to their planned bars, with every cut snapped to the beat grid
 * (bar lines by default). Without a beat grid cuts fall where the bars put them and are reported.
 */

export interface MvShotTiming {
  shotId: string;
  /** Film time (s). */
  start: number;
  duration: number;
  /** Measured length in bars. */
  bars: number;
  /** The cut that opens this shot lands on the grid (the first shot of the video always does). */
  onGrid: boolean;
}

export interface MvSectionTiming {
  sectionId: string;
  index: number;
  /** Film time (s). */
  start: number;
  duration: number;
  /** Song time (s). */
  songStart: number;
  songEnd: number;
  shots: MvShotTiming[];
  plannedBars: number;
  /** Bars the section really lasts. */
  bars: number;
}

export interface MvTimingIssue {
  severity: 'error' | 'warning' | 'info';
  kind: string;
  message: string;
  sectionId: string | null;
  shotId: string | null;
  at: number | null;
}

export interface MvTiming {
  sections: MvSectionTiming[];
  /** Song time where the video starts / the song part ends. */
  songStart: number;
  songEnd: number;
  /** Film time where the song ends (the picture holds for the tail after it). */
  songSec: number;
  totalSec: number;
  bpm: number | null;
  /** Beats and bar lines in film time (inside the video). */
  beats: number[];
  downbeats: number[];
  /** The song has a beat grid (otherwise cuts are not musical). */
  gridded: boolean;
  issues: MvTimingIssue[];
}

/** Shortest shot the planner will make (s). */
export const MV_MIN_SHOT_SEC = 0.45;

const fr = (t: number, fps: number) => Math.round(t * fps) / fps;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function nearestInside(t: number, grid: number[], lo: number, hi: number): number | null {
  const inside = grid.filter((g) => g >= lo - 1e-6 && g <= hi + 1e-6);
  if (!inside.length) return null;
  return snapToBeat(t, inside);
}

export function computeMvTiming(spec: MvLiteSpec, song: Pick<MvSong, 'durationSec' | 'analysis'> | null): MvTiming {
  const fps = spec.setup.fps;
  const issues: MvTimingIssue[] = [];
  const issue = (severity: MvTimingIssue['severity'], kind: string, message: string, sectionId: string | null = null, shotId: string | null = null, at: number | null = null) => issues.push({ severity, kind, message, sectionId, shotId, at });
  const ordered = [...spec.sections].sort((a, b) => a.start - b.start);
  const songDur = song?.durationSec ?? (ordered.length ? ordered[ordered.length - 1]!.end : 0);
  const range = productionRange(spec.song.range, songDur);
  const a0 = range.start;
  const analysis = song?.analysis ?? null;
  const beats = analysis?.beats ?? [];
  const downbeats = analysis && analysis.downbeats.length >= 4 ? analysis.downbeats : [];
  const grid = spec.setup.cutOn === 'beat' ? beats : downbeats.length ? downbeats : beats;
  const gridded = grid.length >= 4;
  const barSec = barSeconds(analysis);
  if (ordered.length && !gridded) issue('warning', 'no_grid', 'The song has no beat grid yet, so cuts are not on the beat. Detect beats and sections on the Song stage.');

  // Contiguous boundaries in song time: each section runs to the next one's start.
  const bounds: number[] = [a0];
  ordered.forEach((s, i) => {
    if (i === 0) return;
    const prev = bounds[bounds.length - 1]!;
    bounds.push(Math.max(prev + 0.5, Math.min(range.end - 0.5 * (ordered.length - i), Math.max(a0, s.start))));
  });
  bounds.push(range.end);
  ordered.forEach((s, i) => {
    const next = ordered[i + 1];
    if (next && Math.abs(s.end - next.start) > 0.05) issue('info', 'section_adjusted', `${s.name || s.label} ended at ${s.end.toFixed(2)} s; it now runs to the next section (${next.start.toFixed(2)} s).`, s.id);
  });
  if (ordered.length && Math.abs(ordered[0]!.start - a0) > 0.05) issue('info', 'section_adjusted', `The first section now starts where the video does (${a0.toFixed(2)} s of the song).`, ordered[0]!.id);

  const sections: MvSectionTiming[] = ordered.map((s, index) => {
    const songStart = bounds[index]!;
    const songEnd = bounds[index + 1]!;
    const span = songEnd - songStart;
    const planned = s.shots.reduce((acc, x) => acc + x.bars, 0);
    const bars = Math.round((span / barSec) * 100) / 100;
    if (!s.shots.length) issue('error', 'no_shots', `${s.name || s.label} has no shots.`, s.id, null, r3(songStart - a0));
    if (s.shots.length && Math.abs(planned - bars) > 0.5) issue('info', 'bars_scaled', `${s.name || s.label} lasts ${bars.toFixed(1)} bars; its shots plan ${planned.toFixed(1)}, so their lengths are scaled to fit.`, s.id, null, r3(songStart - a0));
    // Cuts: proportional targets snapped to the grid, kept in order and at least the minimum length apart.
    const cuts: { t: number; onGrid: boolean }[] = [{ t: songStart, onGrid: true }];
    let cum = 0;
    for (let k = 0; k < s.shots.length - 1; k++) {
      cum += s.shots[k]!.bars;
      const target = songStart + (cum / Math.max(1e-6, planned)) * span;
      const lo = cuts[cuts.length - 1]!.t + MV_MIN_SHOT_SEC;
      const hi = songEnd - MV_MIN_SHOT_SEC * (s.shots.length - 1 - k);
      const snapped = gridded ? nearestInside(target, grid, lo, hi) : null;
      if (snapped !== null && Math.abs(snapped - target) <= Math.max(barSec * 0.75, 0.6)) cuts.push({ t: snapped, onGrid: true });
      else cuts.push({ t: Math.max(lo, Math.min(hi, target)), onGrid: false });
    }
    const firstOnGrid = index === 0 || !gridded || grid.some((g) => Math.abs(g - songStart) < 0.06);
    cuts[0]!.onGrid = firstOnGrid;
    const shots = s.shots.map((x, k) => {
      const a = fr(cuts[k]!.t - a0, fps);
      const b = k === s.shots.length - 1 ? fr(songEnd - a0, fps) : fr(cuts[k + 1]!.t - a0, fps);
      // Exact frame difference (never rounded): each shot ends exactly where the next begins.
      const duration = Math.max(1 / fps, b - a);
      if (duration < MV_MIN_SHOT_SEC + 0.01) issue('warning', 'short_shot', `${s.name || s.label}, shot ${k + 1} lasts only ${duration.toFixed(2)} s — fewer shots or more bars.`, s.id, x.id, a);
      return { shotId: x.id, start: a, duration, bars: Math.round((duration / barSec) * 100) / 100, onGrid: cuts[k]!.onGrid };
    });
    const start = fr(songStart - a0, fps);
    return { sectionId: s.id, index, start, duration: fr(songEnd - a0, fps) - start, songStart: r3(songStart), songEnd: r3(songEnd), shots, plannedBars: planned, bars };
  });

  const songSec = fr(range.end - a0, fps);
  const totalSec = fr(songSec + (sections.length ? spec.sound.tailSec : 0), fps);
  const toFilm = (list: number[]) => list.filter((t) => t >= a0 - 1e-6 && t < range.end).map((t) => r3(t - a0));
  return { sections, songStart: r3(a0), songEnd: r3(range.end), songSec, totalSec, bpm: analysis?.bpm ?? null, beats: toFilm(beats), downbeats: toFilm(downbeats), gridded, issues };
}

/** Section and shot at a film time (for the editor's selection). */
export function mvSectionAt(timing: MvTiming, t: number): MvSectionTiming | null {
  return timing.sections.find((s) => t >= s.start && t < s.start + s.duration) ?? (timing.sections.length && t >= timing.songSec ? timing.sections[timing.sections.length - 1]! : null);
}

/** Film time → song time. */
export const mvSongTime = (timing: Pick<MvTiming, 'songStart'>, t: number) => r3(timing.songStart + t);
