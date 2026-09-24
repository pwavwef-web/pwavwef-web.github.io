import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  alignLyrics,
  detectLyricsFormat,
  editLineText,
  lyricCaptionSpecs,
  needsLanguageVerification,
  parseLyricsText,
  phrasesOf,
  setLineTiming,
  sheetFromParsed,
  sheetText,
  sheetToLyricLines,
  toLrc,
  toSrt,
  toVtt,
  type AsrWord,
} from '../src/lyrics';
import { addAudioBed, applyLyricCaptions, checkLyricSync, emptyTimeline, moveClip, resyncLyricCaptions, songClipsChanged, splitClip, trimStart } from '../src/timeline';
import { applyScoreToTimeline, automationGain, DEFAULT_SCORE_MIX, movementPrompt, normalizeCueSheet, planMovements, SCORE_CLIP_PREFIX, scoreAutomation, type ScoreCue, type ScoreMovement } from '../src/score';

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
/** Real word-timed transcription (Gemini 3.5 Transcribe on Vertex AI) of a sung test clip. */
const SUNG = JSON.parse(fixture('sung-clip-asr.json')) as { words: AsrWord[] };
const SUNG_LYRICS = '[Verse]\nMorning light upon the Volta\nFishermen are singing low\n[Chorus]\nCarry me home, carry me home\nWhere the river waters flow\nCarry me home, carry me home\nWhere the river waters flow';

const ACUTE = String.fromCharCode(0x301);
const GRAVE = String.fromCharCode(0x300);
/** Kasem-orthography sample lines (ɛ ɔ ɩ ʋ ŋ with combining tone marks) — used to prove text is preserved exactly. */
const KASEM = [`Ʋ${ACUTE}ʋ bʋŋa daa kɩ nɩ`, `Wɛ${GRAVE} na${GRAVE}ɔ mʋ yi`];

describe('lyrics parsing', () => {
  it('detects every supported format', () => {
    expect(detectLyricsFormat('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi')).toBe('vtt');
    expect(detectLyricsFormat('1\n00:00:01,000 --> 00:00:02,000\nHi')).toBe('srt');
    expect(detectLyricsFormat('[00:12.50] Hello')).toBe('lrc');
    expect(detectLyricsFormat('[0.0:4.8] Hello')).toBe('lyria');
    expect(detectLyricsFormat('Hello\nWorld')).toBe('plain');
  });

  it('keeps plain text exactly and reads section headers', () => {
    const p = parseLyricsText(SUNG_LYRICS);
    expect(p.format).toBe('plain');
    expect(p.sections.map((s) => s.label)).toEqual(['verse', 'chorus']);
    expect(p.lines.map((l) => l.text)).toEqual(['Morning light upon the Volta', 'Fishermen are singing low', 'Carry me home, carry me home', 'Where the river waters flow', 'Carry me home, carry me home', 'Where the river waters flow']);
    const sheet = sheetFromParsed(p, { source: 'uploaded', language: 'en' });
    expect(sheet.status).toBe('approved');
    expect(sheetText(sheet)).toBe(SUNG_LYRICS.replace('\n[Chorus]', '\n\n[Chorus]'));
  });

  it('reads LRC with offsets, repeated tags and enhanced word timing', () => {
    const p = parseLyricsText('[ti:Volta]\n[offset:+500]\n[00:01.00]<00:01.00>Morning <00:01.60>light\n[00:05.00][00:20.00]Carry me home');
    expect(p.meta.title).toBe('Volta');
    expect(p.lines.map((l) => [l.text, l.start])).toEqual([
      ['Morning light', 1.5],
      ['Carry me home', 5.5],
      ['Carry me home', 20.5],
    ]);
    expect(p.lines[0]!.words?.map((w) => w.start)).toEqual([1.5, 2.1]);
  });

  it('reads SRT and WebVTT karaoke timestamps', () => {
    const srt = parseLyricsText('1\n00:00:01,000 --> 00:00:03,500\nMorning light\n\n2\n00:00:04,000 --> 00:00:06,000\nFishermen');
    expect(srt.lines.map((l) => [l.text, l.start, l.end])).toEqual([
      ['Morning light', 1, 3.5],
      ['Fishermen', 4, 6],
    ]);
    const vtt = parseLyricsText('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nMorning <00:00:01.600>light');
    expect(vtt.lines[0]!.text).toBe('Morning light');
    expect(vtt.lines[0]!.words?.map((w) => w.start)).toEqual([1, 1.6]);
  });

  it('reads Lyria’s real timed-lyrics output (lines, caption, BPM)', () => {
    const text = fixture('lyria-output-text.txt');
    const p = parseLyricsText(text);
    expect(p.format).toBe('lyria');
    expect(p.lines[0]).toMatchObject({ text: 'Morning light upon the Volta', start: 0, end: 4.8 });
    expect(p.lines).toHaveLength(6);
    expect(p.meta.bpm).toBe(100);
    expect(p.meta.caption).toMatch(/Highlife/);
    const sheet = sheetFromParsed(p, { source: 'lyria', language: 'en' });
    expect(sheet.status).toBe('draft');
    expect(sheet.timing.status).toBe('approximate');
  });
});

describe('lyrics alignment (text is authoritative)', () => {
  it('aligns uploaded, untimed lyrics to real sung vocals without changing a word', () => {
    const sheet = sheetFromParsed(parseLyricsText(SUNG_LYRICS), { source: 'uploaded', language: 'en' });
    const { sheet: out, stats } = alignLyrics(sheet, SUNG.words, { durationSec: 28.8 });
    expect(out.lines.map((l) => l.text)).toEqual(sheet.lines.map((l) => l.text));
    expect(stats.coverage).toBeGreaterThan(0.95);
    expect(out.timing.status).toBe('aligned');
    const [first, second] = out.lines;
    expect(first!.start).toBeCloseTo(0.1, 1);
    expect(first!.end).toBeCloseTo(3.3, 1);
    expect(second!.start).toBeCloseTo(5, 1);
    expect(first!.words.map((w) => w.text)).toEqual(['Morning', 'light', 'upon', 'the', 'Volta']);
    // Repeated chorus lines get their own occurrence in the vocals.
    expect(out.lines[4]!.start).toBeGreaterThan(out.lines[2]!.end!);
  });

  it('flags lines the vocals do not support instead of inventing timing confidence', () => {
    const sheet = sheetFromParsed(parseLyricsText(`${SUNG_LYRICS}\nA line nobody sings`), { source: 'uploaded' });
    const { sheet: out } = alignLyrics(sheet, SUNG.words, { durationSec: 28.8 });
    const last = out.lines[out.lines.length - 1]!;
    expect(last.text).toBe('A line nobody sings');
    expect(last.flags).toContain('unaligned');
    expect(out.timing.status).toBe('needs_review');
    expect(out.timing.unalignedLineIds).toContain(last.id);
  });

  it('marks the whole sheet for review when the transcript barely matches (e.g. Kasem) even if every line got a time', () => {
    const kasem = sheetFromParsed(parseLyricsText('Ko ye tɛ\nBa na de gwa re da ne de za me sε\nA la ge so a ŋo ne ka sεm mo'), { source: 'uploaded', language: 'xsm' });
    // The transcriber heard something else entirely; the listening pass still placed every line.
    const heard: AsrWord[] = [
      { text: 'Hello', start: 0.5, end: 0.9 },
      { text: 'everyone', start: 1, end: 1.6 },
      { text: 'welcome', start: 4, end: 4.6 },
    ];
    const anchors = kasem.lines.map((_, i) => ({ lineIndex: i, start: i * 3, end: i * 3 + 2.5, confidence: 0.9 }));
    const { sheet: out, stats } = alignLyrics(kasem, heard, { durationSec: 12, anchors });
    expect(out.lines.map((l) => l.text)).toEqual(kasem.lines.map((l) => l.text));
    expect(out.lines.every((l) => l.start !== null)).toBe(true);
    expect(stats.coverage).toBeLessThan(0.5);
    expect(out.timing.status).toBe('needs_review');
    expect(out.timing.notes.join(' ')).toMatch(/Most words could not be matched/);
  });

  it('resynchronises a corrected line without re-transcribing and keeps manual timing pinned', () => {
    const sheet = alignLyrics(sheetFromParsed(parseLyricsText(SUNG_LYRICS), { source: 'uploaded' }), SUNG.words, { durationSec: 28.8 }).sheet;
    const pinned = setLineTiming(sheet, sheet.lines[1]!.id, 4.5, 8);
    const corrected = editLineText(pinned, pinned.lines[0]!.id, 'Morning light upon the Volta river');
    const { sheet: out } = alignLyrics(corrected, SUNG.words, { durationSec: 28.8 });
    expect(out.lines[0]!.text).toBe('Morning light upon the Volta river');
    expect(out.lines[0]!.words.at(-1)).toMatchObject({ text: 'river', flag: 'interpolated' });
    expect(out.lines[1]).toMatchObject({ start: 4.5, end: 8 });
    expect(out.lines[1]!.flags).toContain('manual_timing');
  });

  it('validates and improves supplied timestamps rather than discarding them', () => {
    const lrc = '[00:00.10]Morning light upon the Volta\n[00:06.20]Fishermen are singing low\n[00:09.90]Carry me home, carry me home';
    const sheet = sheetFromParsed(parseLyricsText(lrc), { source: 'uploaded' });
    const { sheet: out, stats } = alignLyrics(sheet, SUNG.words, { durationSec: 28.8, improveGiven: true });
    expect(out.lines[0]!.start).toBeCloseTo(0.1, 2);
    expect(out.lines[0]!.flags).toContain('given_timing');
    expect(out.lines[1]!.start).toBeCloseTo(5, 1); // 1.2 s early in the file → corrected
    expect(out.lines[1]!.flags).toContain('adjusted');
    expect(stats.adjusted).toBe(1);
  });

  it('preserves Kasem orthography exactly through alignment and every export', () => {
    const text = KASEM.join('\n');
    const sheet = sheetFromParsed(parseLyricsText(text), { source: 'uploaded', language: 'xsm' });
    expect(sheet.requiresLanguageVerification).toBe(false);
    const asr: AsrWord[] = [
      { text: 'Wu', start: 1.0, end: 1.4 },
      { text: 'bunga', start: 1.4, end: 1.9 },
      { text: 'da', start: 1.9, end: 2.2 },
      { text: 'kinney', start: 2.2, end: 2.9 },
      { text: 'when', start: 4.0, end: 4.4 },
      { text: 'know', start: 4.4, end: 4.9 },
      { text: 'mu', start: 4.9, end: 5.2 },
      { text: 'yee', start: 5.2, end: 5.8 },
    ];
    const { sheet: out } = alignLyrics(sheet, asr, { durationSec: 8 });
    expect(out.lines.map((l) => l.text)).toEqual(KASEM);
    expect(out.lines[1]!.text.normalize('NFC')).not.toBe(out.lines[1]!.text); // decomposed a + grave kept, not normalised to à
    expect(out.lines[0]!.start).toBeCloseTo(1, 1);
    expect(out.lines[1]!.start).toBeGreaterThan(3.5);
    for (const exported of [toLrc(out), toSrt(out), toVtt(out)]) for (const line of KASEM) expect(exported).toContain(line);
    expect(sheetToLyricLines(out).map((l) => l.text)).toEqual(KASEM);
  });

  it('marks AI-written or AI-transcribed lyrics in under-resourced languages for verification', () => {
    expect(needsLanguageVerification('xsm', 'generated')).toBe(true);
    expect(needsLanguageVerification('xsm', 'transcribed')).toBe(true);
    expect(needsLanguageVerification('xsm', 'uploaded')).toBe(false);
    expect(needsLanguageVerification('en', 'generated')).toBe(false);
    const sheet = sheetFromParsed(parseLyricsText(KASEM.join('\n')), { source: 'generated', language: 'xsm' });
    expect(sheet.requiresLanguageVerification).toBe(true);
    expect(sheet.status).toBe('draft');
  });
});

describe('lyric exports and caption layouts', () => {
  const aligned = alignLyrics(sheetFromParsed(parseLyricsText(SUNG_LYRICS), { source: 'uploaded' }), SUNG.words, { durationSec: 28.8 }).sheet;

  it('writes LRC (line and word level), SRT and WebVTT', () => {
    const lrc = toLrc(aligned, { title: 'Volta' });
    expect(lrc).toMatch(/^\[ti:Volta\]/);
    expect(lrc).toContain('[00:00.10]Morning light upon the Volta');
    expect(toLrc(aligned, { wordLevel: true })).toContain('[00:00.10]<00:00.10>Morning <00:00.60>light');
    expect(toSrt(aligned)).toContain('1\n00:00:00,100 --> 00:00:03,300\nMorning light upon the Volta');
    const vtt = toVtt(aligned, { wordLevel: true });
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('Morning <00:00:00.600>light');
    // Trimmed / re-timed export for a production range.
    expect(toSrt(aligned, { range: { start: 9, end: 20 } })).toMatch(/^1\n00:00:00,900 --> /);
  });

  it('builds karaoke and phrase highlight units relative to each caption', () => {
    const karaoke = lyricCaptionSpecs(aligned, 'karaoke');
    expect(karaoke[0]!.units![0]).toEqual({ text: 'Morning', start: 0, end: 0.5 });
    const phrases = phrasesOf(aligned.lines[2]!);
    expect(phrases.map((p) => p.text)).toEqual(['Carry me home,', 'carry me home']);
    expect(lyricCaptionSpecs(aligned, 'line')[0]!.units).toBeNull();
  });
});

describe('lyrics stay synchronised on the timeline', () => {
  const sheet = alignLyrics(sheetFromParsed(parseLyricsText(SUNG_LYRICS), { source: 'uploaded' }), SUNG.words, { durationSec: 28.8 }).sheet;
  const base = () => {
    let s = emptyTimeline('16:9', 24);
    s = addAudioBed(s, 'song-asset', 20, 'Song', { inPoint: 8, sourceDuration: 28.8, songId: 'song1' });
    return s;
  };

  it('places captions through the song clip (trimmed start) and passes the sync check', () => {
    const s = applyLyricCaptions(base(), 'song1', sheet, 'karaoke');
    const caps = s.clips.filter((c) => c.lyric);
    // Lines before the 8 s in-point are not playing, so they get no caption.
    expect(caps[0]!.text).toBe('Carry me home, carry me home');
    expect(caps[0]!.start).toBeCloseTo(sheet.lines[2]!.start! - 8, 3);
    expect(caps[0]!.karaoke?.length).toBe(6);
    expect(checkLyricSync(s, { song1: sheet })).toEqual([]);
  });

  it('re-times captions after the music is moved, trimmed or split, and the check catches drift first', () => {
    let s = applyLyricCaptions(base(), 'song1', sheet, 'line');
    const songClip = s.clips.find((c) => c.songId === 'song1')!;
    const moved = moveClip(s, songClip.id, 3);
    expect(songClipsChanged(s, moved)).toBe(true);
    const drift = checkLyricSync(moved, { song1: sheet });
    expect(drift.some((i) => i.kind === 'early')).toBe(true);
    s = resyncLyricCaptions(moved, { song1: sheet });
    expect(checkLyricSync(s, { song1: sheet })).toEqual([]);
    expect(s.clips.find((c) => c.lyric)!.start).toBeCloseTo(3 + sheet.lines[2]!.start! - 8, 3);
    // Trim the head of the song: inPoint moves, captions follow.
    const trimmed = resyncLyricCaptions(trimStart(s, songClip.id, 5), { song1: sheet });
    expect(checkLyricSync(trimmed, { song1: sheet })).toEqual([]);
    // Split the song clip: captions map through whichever part plays each line.
    const { state: split } = splitClip(trimmed, songClip.id, 12);
    expect(checkLyricSync(resyncLyricCaptions(split, { song1: sheet }), { song1: sheet })).toEqual([]);
    // Frame rate changes do not touch second-based timing.
    const fps30 = { ...s, fps: 30 as const };
    expect(checkLyricSync(fps30, { song1: sheet })).toEqual([]);
  });

  it('flags captions that linger, overrun the next line or no longer match corrected lyrics', () => {
    const s = applyLyricCaptions(base(), 'song1', sheet, 'line');
    const first = s.clips.find((c) => c.lyric)!;
    const longer = { ...s, clips: s.clips.map((c) => (c.id === first.id ? { ...c, duration: c.duration + 3 } : c)) };
    const kinds = checkLyricSync(longer, { song1: sheet }).map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['too_long', 'overruns']));
    const corrected = editLineText(sheet, sheet.lines[2]!.id, 'Carry me home, oh carry me home');
    expect(checkLyricSync(s, { song1: corrected }).some((i) => i.message.includes('corrected lyric'))).toBe(true);
  });
});

describe('film score planning', () => {
  const cues: Partial<ScoreCue>[] = [
    { id: 'c1', scene: 'EXT. LAKE - DAWN', start: 0, end: 50, purpose: 'Opening calm', intensity: 3, theme: 'Main theme on kora' },
    { id: 'c2', scene: 'INT. HUT - DAY', start: 48, end: 110, purpose: 'Tension grows', intensity: 6, duckForDialogue: true },
    { id: 'c3', scene: 'INT. HUT - DAY', start: 110, end: 118, purpose: 'Silence before the reveal', silence: true },
    { id: 'c4', scene: 'EXT. MARKET - DAY', start: 118, end: 200, purpose: 'Resolution', intensity: 7 },
  ];
  const sheet = normalizeCueSheet(cues, 200);

  it('normalises the cue sheet (ordered, inside the film, no overlaps)', () => {
    expect(sheet.map((c) => [c.id, c.start, c.end])).toEqual([
      ['c1', 0, 48],
      ['c2', 48, 110],
      ['c3', 110, 118],
      ['c4', 118, 200],
    ]);
  });

  it('plans connected movements that break at deliberate silence and overlap for crossfades', () => {
    const mv = planMovements(sheet, { maxSec: 150, crossfadeSec: 2 });
    expect(mv).toHaveLength(2);
    expect(mv[0]!.cueIds).toEqual(['c1', 'c2']);
    expect(mv[1]!.cueIds).toEqual(['c4']);
    const long = planMovements(normalizeCueSheet([{ start: 0, end: 100, intensity: 4 }, { start: 100, end: 200, intensity: 2 }, { start: 200, end: 300, intensity: 6 }], 300), { maxSec: 150, crossfadeSec: 2 });
    expect(long.length).toBeGreaterThan(1);
    for (const m of long) expect(m.end - m.start).toBeLessThanOrEqual(152);
    for (let i = 1; i < long.length; i++) expect(long[i]!.start).toBeLessThan(long[i - 1]!.end); // crossfade overlap
  });

  it('writes instrumental Lyria prompts from the musical bible and cue sheet', () => {
    const [m] = planMovements(sheet);
    const prompt = movementPrompt({ title: 'Lake', mode: 'cinematic', cueSheet: sheet, bible: { mainTheme: 'a rising three-note kora figure', emotionalMotif: 'hope', instrumentation: ['kora', 'strings', 'talking drum'], key: 'D minor', tempoRange: { min: 70, max: 90 }, culturalDirection: 'Ghanaian, Sahelian', characterThemes: [], locationThemes: [], tensionLanguage: 'low drones', resolutionLanguage: 'major lift', avoid: ['EDM drops'], notes: '' } }, m!, 2);
    expect(prompt).toMatch(/Strictly instrumental/);
    expect(prompt).toMatch(/D minor/);
    expect(prompt).toMatch(/\[0:00 - 0:48\]/);
    expect(prompt).toMatch(/Avoid: EDM drops/);
  });

  it('automates silence and intensity', () => {
    const pts = scoreAutomation(sheet, { start: 100, end: 130 });
    expect(automationGain(pts, 13)).toBe(0);
    expect(automationGain(pts, 2)).toBeGreaterThan(0.5);
  });

  it('lays connected movements on alternating tracks with crossfades, ducking and automation', () => {
    const mv = (index: number, start: number, end: number): ScoreMovement => ({ id: `m${index}`, index, start, end, cueIds: [], status: 'ready', jobId: null, assetId: `asset-${index}`, durationSec: end - start, locked: false, prompt: '' });
    const score = { mode: 'cinematic' as const, mix: DEFAULT_SCORE_MIX, cueSheet: sheet, importedAssetId: null, movements: [mv(0, 0, 112.5), mv(1, 110, 200)] };
    const tl = applyScoreToTimeline(emptyTimeline('16:9', 24), score, { filmDurationSec: 200 });
    const clips = tl.clips.filter((c) => c.label.startsWith(SCORE_CLIP_PREFIX));
    expect(clips).toHaveLength(2);
    const [first, second] = clips;
    // Alternate tracks so the movements can overlap for the crossfade.
    expect(first!.trackId).not.toBe(second!.trackId);
    expect(first!.start + first!.duration).toBeCloseTo(112.5, 3);
    expect(first!.fadeOut).toBe(DEFAULT_SCORE_MIX.crossfadeSec);
    expect(second!.fadeIn).toBe(DEFAULT_SCORE_MIX.crossfadeSec);
    for (const c of clips) expect(c).toMatchObject({ role: 'music', duck: true, duckDb: 12, useSourceAudio: false });
    // The deliberate silence (110–118 s) is automated to zero inside the second movement.
    expect(automationGain(second!.volumeAutomation!, 114 - second!.start)).toBe(0);
    // Re-applying replaces the score instead of stacking a second copy; "No score" removes it.
    expect(applyScoreToTimeline(tl, score, { filmDurationSec: 200 }).clips.filter((c) => c.label.startsWith(SCORE_CLIP_PREFIX))).toHaveLength(2);
    expect(applyScoreToTimeline(tl, { ...score, mode: 'none' }).clips.filter((c) => c.label.startsWith(SCORE_CLIP_PREFIX))).toHaveLength(0);
  });
});
