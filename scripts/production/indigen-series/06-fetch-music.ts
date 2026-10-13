import './common';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { bucket, col, loadState, OUT, say } from './common';

// Downloads the four generated scores into the reusable-assets folder.
const st = loadState();
const dir = path.join(OUT, '_project', 'reusable-assets', 'music');
mkdirSync(dir, { recursive: true });
for (const k of ['v1', 'v2', 'v3', 'v4']) {
  const id = st.music[k].result.assetIds[0] as string;
  const a = (await col.assets().doc(id).get()).data()!;
  const dest = path.join(dir, `${k}-score${path.extname(a.storagePath) || '.wav'}`);
  await bucket.file(a.storagePath).download({ destination: dest });
  say(`${dest} ${a.durationSec}s`);
}
process.exit(0);
