import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { bucket, col, loadState, OUT, say } from './common';
import { SHOTS } from './shots';

// Usage: 12-review.ts <aspect> [shots=1,2,3]   → downloads the selected/latest clips and writes contact sheets (rows of 6 frames)
const FF = 'C:/Users/DELL/Desktop/indigen-world/.tooling/ffmpeg/ffmpeg.exe';
const aspect = (process.argv[2] ?? '16:9') as '16:9' | '9:16';
const only = (process.argv.find((a) => a.startsWith('shots='))?.slice(6) ?? '').split(',').filter(Boolean).map(Number);
const st = loadState();
const dir = path.join(OUT, 'frames', aspect.replace(':', 'x'));
mkdirSync(dir, { recursive: true });
const list: { n: number; file: string }[] = [];
for (const s of SHOTS) {
  if (only.length && !only.includes(s.n)) continue;
  const assetId = st.selection?.[aspect]?.[s.n] ?? st.genResults?.[`${aspect}|${s.n}|1080p`]?.assetId;
  if (!assetId) continue;
  const file = path.join(dir, `${String(s.n).padStart(2, '0')}_${assetId}.mp4`);
  if (!existsSync(file)) {
    const a = (await col.assets().doc(assetId).get()).data()!;
    await bucket.file(a.storagePath).download({ destination: file });
  }
  list.push({ n: s.n, file });
}
const W = aspect === '16:9' ? 400 : 200;
for (let i = 0; i < list.length; i += 4) {
  const group = list.slice(i, i + 4);
  const out = path.join(dir, `sheet_${String(group[0]!.n).padStart(2, '0')}-${String(group.at(-1)!.n).padStart(2, '0')}.jpg`);
  const args = ['-v', 'error', '-y'];
  for (const g of group) args.push('-i', g.file);
  const filters = group.map((_, k) => `[${k}:v]fps=0.7,scale=${W}:-2,tile=6x1[r${k}]`).join(';');
  const stack = `${group.map((_, k) => `[r${k}]`).join('')}vstack=inputs=${group.length}`;
  args.push('-filter_complex', `${filters};${stack}`, '-frames:v', '1', '-q:v', '4', out);
  execFileSync(FF, args);
  say(`${out}  shots ${group.map((g) => g.n).join(',')}`);
}
