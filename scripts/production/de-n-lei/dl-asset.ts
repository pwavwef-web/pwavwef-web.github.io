import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { col, bucket, OUT } from './common';
// Usage: dl-asset.ts <outDir> <assetId>…  (downloads the derived thumbnail for images, the original for others)
const [outDir, ...ids] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
for (const id of ids) {
  const a = (await col.assets().doc(id).get()).data()!;
  const src = a.kind === 'image' && a.thumbPath ? a.thumbPath : a.storagePath;
  const dest = path.join(outDir, `${id}${path.extname(src)}`);
  await bucket.file(src).download({ destination: dest });
  console.log(dest, a.kind, a.width, a.height, a.title);
}
