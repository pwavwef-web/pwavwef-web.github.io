import { col, loadState } from './common';
const st = loadState();
const song = (await col.songs(st.projectId).doc('song').get()).data()!;
const w = song.asr.words as { text: string; start: number; end: number; confidence?: number }[];
let line = '', t0 = 0, prev = 0;
for (const x of w) {
  if (x.start - prev > 1.2 && line) { console.log(`${t0.toFixed(1).padStart(6)}–${prev.toFixed(1).padStart(6)} ${line}`); line = ''; }
  if (!line) t0 = x.start;
  line += x.text + ' ';
  prev = x.end;
}
console.log(`${t0.toFixed(1).padStart(6)}–${prev.toFixed(1).padStart(6)} ${line}`);
console.log('n words', w.length, 'fields', Object.keys(song.asr));
