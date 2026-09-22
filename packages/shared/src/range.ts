import type { LyricLine, SongSection } from './types';

export interface TimeRange {
  start: number;
  end: number;
}

/** The part of the song being produced: the saved range clamped to the song, or the whole song. */
export function productionRange(range: TimeRange | null | undefined, durationSec: number): TimeRange {
  const dur = Math.max(0, durationSec || 0);
  if (!range || !(range.end > range.start)) return { start: 0, end: dur };
  const start = Math.min(Math.max(0, range.start), dur);
  const end = Math.min(Math.max(start, range.end), dur);
  return end - start > 0.05 ? { start, end } : { start: 0, end: dur };
}

export function isWholeSong(range: TimeRange, durationSec: number): boolean {
  return range.start <= 0.05 && range.end >= durationSec - 0.05;
}

/** Sections overlapping the range, trimmed to it, so bar-aligned shot slots stay inside the range. */
export function sectionsInRange(sections: SongSection[], range: TimeRange): SongSection[] {
  return sections
    .filter((s) => s.end > range.start + 0.05 && s.start < range.end - 0.05)
    .map((s) => ({ ...s, start: Math.max(s.start, range.start), end: Math.min(s.end, range.end) }));
}

/** Lyric lines inside the range, re-timed so the range start becomes 0. */
export function lyricsInRange(lines: LyricLine[], range: TimeRange): LyricLine[] {
  return lines
    .filter((l) => l.end > range.start + 0.05 && l.start < range.end - 0.05)
    .map((l) => ({ ...l, start: Math.max(0, l.start - range.start), end: Math.min(range.end, l.end) - range.start }));
}

/** Beat times inside the range, re-timed so the range start becomes 0. */
export function beatsInRange(beats: number[], range: TimeRange): number[] {
  return beats.filter((b) => b >= range.start - 1e-3 && b <= range.end + 1e-3).map((b) => Math.round((b - range.start) * 1000) / 1000);
}
