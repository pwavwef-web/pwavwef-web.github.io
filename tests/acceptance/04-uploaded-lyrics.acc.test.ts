import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  addAudioBed,
  applyLyricCaptions,
  checkLyricSync,
  editLineText,
  emptyTimeline,
  moveClip,
  parseLyricsText,
  resyncLyricCaptions,
  resyncSheet,
  sheetFromParsed,
  sheetToLyricLines,
  timelineDuration,
  toLrc,
  toSrt,
  toVtt,
  type AsrWord,
  type LyricsSheet,
  type TimelineState,
} from '@az-studio/shared';
import { col, FieldValue } from '../../functions/src/lib/firebase';
import { FIXTURES, qaProject, reporter, studioOwner, submitJobs, uploadFile, waitForJob } from './harness';

// The creator's lyrics, pasted without timing (section tags are recognised, never sung).
const UPLOADED = ['[Verse]', 'Morning light upon the Volta', 'Fishermen are singing low', '', '[Chorus]', 'Carry me home, carry me home', 'Where the river waters flow', 'Carry me home, carry me home', 'Where the river waters flow'].join('\n');
const LINES = UPLOADED.split('\n').filter((l) => l && !l.startsWith('['));

async function saveTimeline(projectId: string, ownerUid: string, id: string, s: TimelineState) {
  await col.timelines(projectId).doc(id).set({ ownerUid, projectId, name: 'Lyric video', fps: s.fps, aspectRatio: s.aspectRatio, tracks: s.tracks, clips: s.clips, markers: s.markers, beatGrid: s.beatGrid, version: 1, durationSec: timelineDuration(s.clips), updatedAt: FieldValue.serverTimestamp() });
}

describe('Acceptance 4 — uploaded lyrics', () => {
  it('aligns the creator’s exact wording to the vocals, keeps it in sync through corrections, edits and exports, and checks sync before rendering', async () => {
    const { log, save } = reporter('04-uploaded-lyrics');
    const owner = await studioOwner();
    const projectId = await qaProject(owner, 'lyrics-upload', 'Uploaded lyrics', 'music_video', { language: 'en' });

    // Song audio (a 28.8 s sung test clip) validated server-side like any upload.
    const audio = await uploadFile(owner, projectId, path.join(FIXTURES, 'sung-clip.mp3'), 'audio', 'audio/mpeg', log);
    const durationSec = Number(audio.durationSec);
    log(`song audio ready: ${durationSec} s`);
    await col.songs(projectId).doc('song').set({ title: 'Volta Morning (test clip)', artist: '', audioAssetId: audio.id, durationSec, analysis: null, ai: null, lyrics: null, createdAt: FieldValue.serverTimestamp() });

    // Upload the lyrics exactly as the Lyrics tab does.
    const parsed = parseLyricsText(UPLOADED);
    expect(parsed.format).toBe('plain');
    const uploaded = sheetFromParsed(parsed, { source: 'uploaded', language: 'en' });
    await col.songs(projectId).doc('song').set({ lyricsSheet: uploaded, lyrics: { source: 'upload', lines: sheetToLyricLines(uploaded) }, instrumental: false }, { merge: true });

    // Word-timed transcription + alignment (the text is authoritative).
    const [jobId] = await submitJobs(owner, [{ type: 'lyrics.align', projectId, songId: 'song', audioAssetId: audio.id, languageCode: 'en', retranscribe: false, label: 'QA · synchronise lyrics' }], 'QA · lyric sync');
    const job = await waitForJob(jobId!, log);
    expect(job.status).toBe('completed');
    const song = (await col.songs(projectId).doc('song').get()).data()!;
    const sheet = song.lyricsSheet as LyricsSheet;
    const asr = (song.asr?.words ?? []) as AsrWord[];
    for (const l of sheet.lines) log(`  ${l.start?.toFixed(2)}–${l.end?.toFixed(2)}  ${l.text}${l.flags.length ? `  [${l.flags.join(', ')}]` : ''}`);
    log(`timing ${sheet.timing.status} via ${sheet.timing.method}; ${sheet.timing.notes.join(' ')}; transcript ${asr.length} words (${song.asr?.modelId})`);

    // Wording untouched, every line timed in order inside the song.
    expect(sheet.lines.map((l) => l.text)).toEqual(LINES);
    expect(sheet.source).toBe('uploaded');
    expect(['aligned', 'needs_review']).toContain(sheet.timing.status);
    expect(asr.length).toBeGreaterThan(20);
    let prev = -1;
    for (const l of sheet.lines) {
      expect(l.start).not.toBeNull();
      expect(l.end!).toBeGreaterThan(l.start!);
      expect(l.start!).toBeGreaterThanOrEqual(prev - 0.05);
      expect(l.end!).toBeLessThanOrEqual(durationSec + 0.5);
      prev = l.start!;
    }
    expect(sheet.lines.filter((l) => l.words?.length).length).toBeGreaterThanOrEqual(LINES.length - 1);
    expect(sheet.lines[0]!.start!).toBeLessThan(4);
    expect(sheet.lines.at(-1)!.end!).toBeGreaterThan(durationSec * 0.7);

    // A correction re-synchronises instantly from the cached transcript and keeps the new wording.
    const target = sheet.lines[1]!;
    const corrected = resyncSheet(editLineText(sheet, target.id, 'Fishermen are singing slow'), asr, durationSec);
    expect(corrected.lines[1]!.text).toBe('Fishermen are singing slow');
    expect(corrected.lines.filter((l) => l.id !== target.id).map((l) => l.text)).toEqual(LINES.filter((_, i) => i !== 1));
    expect(corrected.lines[1]!.start).not.toBeNull();
    await col.songs(projectId).doc('song').set({ lyricsSheet: corrected, lyrics: { source: 'upload', lines: sheetToLyricLines(corrected) } }, { merge: true });

    // Exports round-trip text and timing.
    const exports = { lrc: toLrc(corrected), srt: toSrt(corrected), vtt: toVtt(corrected) };
    for (const [fmt, text] of Object.entries(exports)) {
      const back = parseLyricsText(text);
      expect(back.lines.map((l) => l.text)).toEqual(corrected.lines.map((l) => l.text));
      back.lines.forEach((l, i) => expect(Math.abs((l.start ?? -9) - corrected.lines[i]!.start!)).toBeLessThanOrEqual(0.011));
      log(`${fmt.toUpperCase()} export round-trips ${back.lines.length} lines`);
    }

    // Vertical lyric video: captions follow the song clip, and the server refuses to render them out of sync.
    let tl = addAudioBed(emptyTimeline('9:16', 24), audio.id, durationSec, 'Song', { songId: 'song' });
    tl = applyLyricCaptions(tl, 'song', corrected, 'vertical');
    expect(checkLyricSync(tl, { song: corrected })).toEqual([]);
    const songClip = tl.clips.find((c) => c.songId === 'song')!;
    const moved = moveClip(tl, songClip.id, songClip.start + 2);
    const drift = checkLyricSync(moved, { song: corrected });
    log(`moving the song 2 s without resync → ${drift.length} sync issue(s), e.g. ${drift[0]?.message}`);
    expect(drift.length).toBeGreaterThan(0);
    await saveTimeline(projectId, owner.uid, 'lyric-video', moved);
    const refusal = await submitJobs(owner, [{ type: 'render.timeline', projectId, timelineId: 'lyric-video', preset: 'vertical_9x16', quality: 'draft', acceptLyricSync: false }], 'QA · render').catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(HttpsError);
    expect((refusal as HttpsError).details).toMatchObject({ reason: 'lyric_sync' });
    log(`render refused before resync: ${(refusal as HttpsError).message}`);

    const resynced = resyncLyricCaptions(moved, { song: corrected });
    expect(checkLyricSync(resynced, { song: corrected })).toEqual([]);
    await saveTimeline(projectId, owner.uid, 'lyric-video', resynced);
    const [renderId] = await submitJobs(owner, [{ type: 'render.timeline', projectId, timelineId: 'lyric-video', preset: 'vertical_9x16', quality: 'draft', acceptLyricSync: false }], 'QA · render');
    const render = await waitForJob(renderId!, log, 30 * 60_000);
    expect(render.status).toBe('completed');
    const out = (await col.assets().doc(String(render.result?.assetIds?.[0])).get()).data()!;
    log(`rendered ${out.width}x${out.height}, ${out.durationSec} s → asset ${render.result?.assetIds?.[0]}`);
    expect(out.kind).toBe('video');
    expect(Math.abs(Number(out.durationSec) - timelineDuration(resynced.clips))).toBeLessThan(0.6);

    save({ projectId, audioAssetId: audio.id, transcriptModel: song.asr?.modelId, timing: sheet.timing, lines: sheet.lines.map((l) => ({ text: l.text, start: l.start, end: l.end, flags: l.flags, words: l.words?.length ?? 0 })), corrected: corrected.lines.map((l) => ({ text: l.text, start: l.start, end: l.end })), exports, driftIssues: drift.map((d) => d.message), renderAssetId: render.result?.assetIds?.[0], renderJob: renderId });
  });
});
