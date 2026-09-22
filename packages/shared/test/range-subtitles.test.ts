import { describe, expect, it } from 'vitest';
import { addAudioBed, beatsInRange, emptyTimeline, formatSrt, isWholeSong, lyricsInRange, parseSubtitles, productionRange, sectionsInRange, trackEnd, type SongSection } from '../src';

const sections: SongSection[] = [
  { id: 's0', label: 'intro', name: 'Intro', start: 0, end: 12, energy: 0.2 },
  { id: 's1', label: 'verse', name: 'Verse 1', start: 12, end: 44, energy: 0.5 },
  { id: 's2', label: 'chorus', name: 'Chorus', start: 44, end: 70, energy: 0.9 },
  { id: 's3', label: 'outro', name: 'Outro', start: 70, end: 90, energy: 0.3 },
];

describe('production range', () => {
  it('defaults to the whole song and clamps saved ranges to it', () => {
    expect(productionRange(null, 90)).toEqual({ start: 0, end: 90 });
    expect(productionRange({ start: 30, end: 200 }, 90)).toEqual({ start: 30, end: 90 });
    expect(productionRange({ start: 50, end: 40 }, 90)).toEqual({ start: 0, end: 90 });
    expect(isWholeSong(productionRange(undefined, 90), 90)).toBe(true);
    expect(isWholeSong({ start: 20, end: 75 }, 90)).toBe(false);
  });

  it('keeps only the sections, lyrics and beats inside the range, re-timed to it', () => {
    const r = { start: 30, end: 80 };
    expect(sectionsInRange(sections, r).map((s) => [s.name, s.start, s.end])).toEqual([
      ['Verse 1', 30, 44],
      ['Chorus', 44, 70],
      ['Outro', 70, 80],
    ]);
    const lines = [
      { id: 'a', start: 10, end: 14, text: 'before' },
      { id: 'b', start: 31, end: 35, text: 'inside' },
      { id: 'c', start: 78, end: 84, text: 'straddles the end' },
    ];
    expect(lyricsInRange(lines, r)).toEqual([
      { id: 'b', start: 1, end: 5, text: 'inside' },
      { id: 'c', start: 48, end: 50, text: 'straddles the end' },
    ]);
    expect(beatsInRange([29.5, 30, 30.5, 79.9, 80.5], r)).toEqual([0, 0.5, 49.9]);
  });

  it('lays a song bed that starts at the range in-point', () => {
    const s = addAudioBed(emptyTimeline('16:9', 30), 'song', 50, 'Beyond the Reef', { inPoint: 30, sourceDuration: 90 });
    const bed = s.clips[0]!;
    expect([bed.start, bed.duration, bed.inPoint, bed.sourceDuration]).toEqual([0, 50, 30, 90]);
    expect(s.fps).toBe(30);
    expect(trackEnd(s, bed.trackId)).toBe(50);
  });
});

describe('subtitles', () => {
  it('parses SubRip and WebVTT, ignoring numbering, headers, settings and tags', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:03,500\r\nHello <i>there</i>\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,250\r\nTwo\r\nlines\r\n';
    expect(parseSubtitles(srt)).toEqual([
      { start: 1, end: 3.5, text: 'Hello there' },
      { start: 4, end: 6.25, text: 'Two\nlines' },
    ]);
    const vtt = 'WEBVTT\n\nNOTE header\n\n00:01.000 --> 00:02.500 align:center\nShort form\n\n01:02:03.4 --> 01:02:05.000\nHours\n';
    expect(parseSubtitles(vtt)).toEqual([
      { start: 1, end: 2.5, text: 'Short form' },
      { start: 3723.4, end: 3725, text: 'Hours' },
    ]);
    expect(parseSubtitles('00:00:05,000 --> 00:00:04,000\nbackwards')).toEqual([]);
  });

  it('round-trips through SRT', () => {
    const cues = [
      { start: 0.5, end: 2.04, text: 'First' },
      { start: 62.345, end: 3725.9, text: 'Second' },
    ];
    const srt = formatSrt(cues);
    expect(srt).toContain('1\n00:00:00,500 --> 00:00:02,040\nFirst');
    expect(srt).toContain('2\n00:01:02,345 --> 01:02:05,900\nSecond');
    expect(parseSubtitles(srt)).toEqual(cues);
  });
});
