import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { buildSegment, type RenderSnapshot } from '../../../services/renderer/src/graph';
const require = createRequire(import.meta.url);
const ff = require('ffmpeg-static') as string;
const out = path.join(process.cwd(), 'exports', 'francis-has-a-plan');
const st = JSON.parse(readFileSync(path.join(out, 'production-state.json'), 'utf8'));
const t = JSON.parse(readFileSync(path.join(out, 'timeline.json'), 'utf8'));
const picture = t.clips.filter((c: any) => c.kind === 'video');
const begins = [0, 8.875, 18.75], durations = [9, 10, 10];
picture.forEach((c: any, i: number) => { c.start = begins[i]; c.duration = durations[i]; });
const snap: RenderSnapshot = { ...t, width: 720, height: 1280, durationSec: 30, quality: 'draft', assets: Object.fromEntries(st.assetIds.slice(0, 3).map((id: string, i: number) => [id, { kind: 'video', storagePath: id, width: 720, height: 1280, durationSec: i ? 10.027 : 9.024, hasAudio: true }])) };
const files = Object.fromEntries(st.assetIds.slice(0, 3).map((id: string, i: number) => [id, path.join(out, 'sources', `${i + 1}-${['start', 'obstacle', 'control'][i]}.mp4`)]));
mkdirSync(path.join(out, 'verification'), { recursive: true });
for (const [i, begin] of [8, 18].entries()) {
  const base = path.join(out, 'verification', `join-${i + 1}`);
  const p = buildSegment(snap, { index: i, start: begin, end: begin + 2 }, { resolve: id => files[id], filterScriptPath: `${base}.filter`, assPath: `${base}.ass`, fontsDir: out, outputPath: `${base}.mp4` });
  writeFileSync(`${base}.filter`, p.filter);
  if (p.ass) writeFileSync(`${base}.ass`, p.ass);
  const r = spawnSync(ff, p.args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (r.status) throw new Error(r.stderr);
  const check = spawnSync(ff, ['-hide_banner', '-i', `${base}.mp4`, '-vf', 'blackdetect=d=0.01:pix_th=0.1', '-f', 'null', '-'], { encoding: 'utf8' });
  const blacks = check.stderr.split('\n').filter(s => s.includes('black_start'));
  console.log(JSON.stringify({ join: i + 1, blackFrames: blacks }));
  if (blacks.length) throw new Error('Join still contains black frames');
}
