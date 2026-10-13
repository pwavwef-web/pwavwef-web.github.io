import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseLyricsText, sheetFromParsed, sheetToLyricLines, setLineTiming, toSrt, toLrc, type LyricsSheet } from '@az-studio/shared';
import { OUT, col, loadState, patchState, say } from './common';

// Line timings: English lines are anchored on the word-timed transcript (gemini-3.5-transcribe, run on the whole mix and on the
// isolated vocal stem); Kasem lines sit in the gaps between them, bounded by the vocal stem's phrase breaths and split by syllable count.
const ch1: [number, number][] = [[56.5, 59.8], [60.0, 62.1], [62.4, 64.5], [64.7, 66.9], [67.0, 68.6], [68.7, 71.6], [71.8, 73.5], [73.7, 75.9]];
const plus = (a: [number, number][], d: number): [number, number][] => a.map(([s, e]) => [+(s + d).toFixed(2), +(e + d).toFixed(2)]);
const T: [number, number][] = [
  [6.8, 11.1], [14.2, 16.0],
  [28.35, 31.85], [33.9, 36.5], [38.0, 40.3], [40.4, 43.3], [43.4, 46.2], [46.5, 48.9], [49.3, 53.2], [53.5, 56.1],
  ...ch1,
  [84.8, 87.2], [87.8, 89.5], [89.7, 92.8], [93.0, 94.7], [94.8, 97.2], [97.3, 98.7], [98.85, 101.0], [101.1, 103.3], [103.4, 104.7],
  ...plus(ch1, 49.1),
  [134.1, 137.9], [138.1, 142.7], [143.2, 145.0], [145.5, 147.4], [147.6, 149.8], [149.9, 152.1], [152.3, 153.1],
  ...plus(ch1, 105.3), [188.2, 190.5],
  [192.3, 195.4], [195.6, 198.0], [198.7, 199.9],
];
const st = loadState();
const text = readFileSync(path.join(OUT, 'lyrics', 'lyrics.txt'), 'utf8');
let sheet: LyricsSheet = sheetFromParsed(parseLyricsText(text, 'plain'), { source: 'uploaded', language: 'xsm' });
if (sheet.lines.length !== T.length) throw new Error(`sheet has ${sheet.lines.length} lines, timing table ${T.length}`);
sheet.lines.forEach((l, i) => { sheet = setLineTiming(sheet, l.id, T[i]![0], T[i]![1]); });
sheet = { ...sheet, timing: { ...sheet.timing, status: 'manual', method: 'manual', audioAssetId: st.songAssetId } as any };
await col.songs(st.projectId).doc('song').set({ lyricsSheet: sheet, lyrics: { source: 'upload', lines: sheetToLyricLines(sheet) }, instrumental: false }, { merge: true });
writeFileSync(path.join(OUT, 'lyrics', 'lyrics.srt'), toSrt(sheet));
writeFileSync(path.join(OUT, 'lyrics', 'lyrics.lrc'), toLrc(sheet));
writeFileSync(path.join(OUT, 'lyrics', 'line-timing.json'), JSON.stringify(sheet.lines.map((l) => ({ text: l.text, start: l.start, end: l.end })), null, 1));
patchState({ lineTimes: T });
say(`sheet ${sheet.lines.length} lines, sections ${sheet.sections.map((s) => s.name).join(', ')}`);
