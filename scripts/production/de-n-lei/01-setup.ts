import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseLyricsText, sheetFromParsed, sheetToLyricLines, type LyricsSheet } from '@az-studio/shared';
import { OUT, PORTRAIT, SONG_WAV, col, FieldValue, loadState, patchState, say, studioOwner, uploadFile, submitJobs, waitForJob, reporter } from './common';

const { log } = reporter('de-n-lei-01-setup');
const owner = await studioOwner();
let st = loadState();

if (!st.projectId) {
  const ref = col.projects().doc();
  await ref.set({
    ownerUid: owner.uid,
    title: 'De N Lei — Come Learn Kasem · Music Video (Oct 2026)',
    type: 'music_video',
    logline: 'A learner returns to the family compound, asks an elder, says the word twice — and passes it on.',
    genre: 'Highlife / Afropop',
    status: 'active',
    language: 'xsm',
    format: { aspectRatio: '16:9', fps: 24 },
    coverAssetId: null,
    idea: 'Passing it on: a learner (the artist) goes from asking an elder to teaching a child, with a whole community joining the final chorus. One production, two native framings: YouTube 16:9 and TikTok 9:16.',
    styleBible: {
      visualStyle: 'Realistic, cinematic and warm. Golden-hour light, natural skin texture, shallow depth of field on 35–50 mm lenses, handheld energy that settles on the beat. Real compound architecture with hand-painted geometric wall designs in black, white and red. No on-screen text, captions, signs or lettering anywhere in the picture.',
      palette: 'Terracotta Red, Warm Mustard, Chalk White, Deep Mahogany, Baobab Green, Dusk Blue',
    },
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  st = patchState({ projectId: ref.id });
  say(`project ${ref.id}`);
}
const projectId = st.projectId as string;

if (!st.songAssetId) {
  const a = await uploadFile(owner, projectId, SONG_WAV, 'audio', 'audio/wav', log);
  st = patchState({ songAssetId: a.id, songDurationSec: a.durationSec });
  say(`song asset ${a.id} duration ${a.durationSec}`);
}
if (!st.portraitAssetId) {
  const a = await uploadFile(owner, projectId, PORTRAIT, 'image', 'image/jpeg', log);
  st = patchState({ portraitAssetId: a.id });
  say(`portrait asset ${a.id}`);
}

// Song document + the creator's own lyric text (source of truth, never rewritten by the transcript).
const text = readFileSync(path.join(OUT, 'lyrics', 'lyrics.txt'), 'utf8');
const uploaded: LyricsSheet = sheetFromParsed(parseLyricsText(text, 'plain'), { source: 'uploaded', language: 'xsm' });
if (!st.songId) {
  await col.songs(projectId).doc('song').set({ title: 'De N Lei — Come Learn Kasem', artist: 'Indigen World', audioAssetId: st.songAssetId, durationSec: st.songDurationSec, analysis: null, ai: null, lyrics: null, createdAt: FieldValue.serverTimestamp() });
  st = patchState({ songId: 'song' });
}
await col.songs(projectId).doc('song').set({ lyricsSheet: uploaded, lyrics: { source: 'upload', lines: sheetToLyricLines(uploaded) }, instrumental: false }, { merge: true });
say(`lyric sheet: ${uploaded.lines.length} lines`);

if (!st.alignJobId) {
  const [id] = await submitJobs(owner, [{ type: 'lyrics.align', projectId, songId: 'song', audioAssetId: st.songAssetId, languageCode: 'xsm', retranscribe: true, label: 'De N Lei · align lyrics' }], 'De N Lei · align');
  st = patchState({ alignJobId: id });
}
const job = await waitForJob(st.alignJobId, log);
say(`align job ${job.status}`);
