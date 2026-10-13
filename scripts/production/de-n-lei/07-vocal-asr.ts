import { col, FieldValue, loadState, patchState, say, studioOwner, submitJobs, waitForJob, reporter } from './common';
const { log } = reporter('de-n-lei-07');
const owner = await studioOwner();
const st = loadState();
const vocalsAsset = st.stems.vocals as string;
const a = (await col.assets().doc(vocalsAsset).get()).data()!;
await col.songs(st.projectId).doc('vocals').set({ title: 'De N Lei — vocal stem', artist: '', audioAssetId: vocalsAsset, durationSec: a.durationSec ?? 211.56, analysis: null, ai: null, lyrics: null, createdAt: FieldValue.serverTimestamp() });
for (const lang of ['xsm']) {
  const [id] = await submitJobs(owner, [{ type: 'lyrics.transcribe', projectId: st.projectId, songId: 'vocals', audioAssetId: vocalsAsset, languageCode: lang, label: `De N Lei · transcribe vocal stem (${lang})` }], 'De N Lei · vocal asr');
  const job = await waitForJob(id!, log);
  say(`${lang}: ${job.status} ${job.error?.message ?? ''}`);
}
const song = (await col.songs(st.projectId).doc('vocals').get()).data()!;
const w = (song.asr?.words ?? []) as { text: string; start: number; end: number }[];
let line = '', t0 = 0, prev = 0;
for (const x of w) { if (x.start - prev > 0.7 && line) { console.log(`${t0.toFixed(1).padStart(6)}–${prev.toFixed(1).padStart(6)} ${line}`); line = ''; } if (!line) t0 = x.start; line += x.text + ' '; prev = x.end; }
console.log(`${t0.toFixed(1).padStart(6)}–${prev.toFixed(1).padStart(6)} ${line}`);
console.log('words', w.length);
patchState({ vocalWords: w });
