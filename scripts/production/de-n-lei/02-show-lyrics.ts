import { col, loadState, say } from './common';
const st = loadState();
const song = (await col.songs(st.projectId).doc('song').get()).data()!;
const sheet = song.lyricsSheet;
say(`timing ${sheet.timing?.status} · asr words ${song.asr?.words?.length} · model ${song.asr?.modelId} · lang ${song.asr?.languageCode}`);
for (const l of sheet.lines) console.log(`${(l.start ?? NaN).toFixed(1).padStart(6)}–${(l.end ?? NaN).toFixed(1).padStart(6)} ${(l.flags ?? []).join(',').padEnd(22)} ${l.section ?? ''} | ${l.text}`);
console.log('SECTIONS', JSON.stringify(sheet.sections));
console.log('ANALYSIS', JSON.stringify(song.analysis ? { bpm: song.analysis.bpm, nb: song.analysis.beats?.length } : null), JSON.stringify(song.vocals));
