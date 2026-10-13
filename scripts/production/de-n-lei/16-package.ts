import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bucket, col, loadState, OUT, say } from './common';
import { SHOTS } from './shots';

// Collects everything needed to revise the video later into the output folder:
// reference images, the selected clip of every shot (both formats), the vocal stem and both timelines.
const st = loadState();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
async function save(assetId: string, dest: string, original = true) {
  if (existsSync(dest)) return;
  mkdirSync(path.dirname(dest), { recursive: true });
  const a = (await col.assets().doc(assetId).get()).data()!;
  await bucket.file(original ? a.storagePath : a.thumbPath ?? a.storagePath).download({ destination: dest });
}

const refs: [string, string][] = [
  [st.portraitAssetId, 'references/the-learner_source-portrait.jpg'],
  [st.refResults.learner_portrait.assetIds[0], 'references/the-learner_portrait.png'],
  [st.ref2Results.learner_full.assetIds[0], 'references/the-learner_turnaround-sheet.png'],
  [st.ref2Results.alima_new.assetIds[0], 'references/mama-alima_portrait.png'],
  [st.ref2Results.amina_new.assetIds[0], 'references/amina_portrait.png'],
  [st.refResults.compound.assetIds[0], 'references/location_painted-compound.png'],
  [st.refResults.baobab.assetIds[0], 'references/location_baobab-gathering-ground.png'],
  [st.refResults.lane.assetIds[0], 'references/location_village-lane.png'],
];
for (const [id, rel] of refs) {
  const a = (await col.assets().doc(id).get()).data()!;
  const ext = path.extname(a.fileName || a.storagePath) || path.extname(rel);
  await save(id, path.join(OUT, 'assets', rel.replace(/\.[a-z0-9]+$/i, ext)));
}
await save(st.stems.vocals, path.join(OUT, 'assets', 'audio', 'vocal-stem.mp3'));
for (const aspect of ['16:9', '9:16'] as const) {
  for (const s of SHOTS) {
    const id = st.selection[aspect][s.n];
    await save(id, path.join(OUT, 'assets', 'clips', aspect.replace(':', 'x'), `${String(s.n).padStart(2, '0')}_${slug(s.title)}_${id}.mp4`));
  }
  const tl = (await col.timelines(st.projectId).doc(st.timelines[aspect]).get()).data()!;
  writeFileSync(path.join(OUT, 'timeline', `timeline_${aspect.replace(':', 'x')}.json`), JSON.stringify({ ...tl, createdAt: undefined, updatedAt: undefined }, null, 1));
}
copyFileSync(path.join(OUT, 'production-state.json'), path.join(OUT, 'timeline', 'production-state.json'));
say('packaged references, clips, stem and timelines');
