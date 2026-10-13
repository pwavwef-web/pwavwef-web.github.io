// node render-all.mjs <v1|v2|v3|v4> [only-seg-id…]
// Renders every graphics scene (HTML -> MP4) and conforms every human clip (trim, speed, 1080x1920) for one video.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { buildSpec } from './spec.mjs';

const require = createRequire(import.meta.url);
const ffmpeg = require(path.resolve('node_modules/ffmpeg-static'));
const WORK = path.resolve('exports/indigen-contributor-series/_work');
const key = process.argv[2];
const only = process.argv.slice(3);
const spec = buildSpec(key);
const dir = path.join(WORK, 'clips', key);
mkdirSync(dir, { recursive: true });
// the scene sources are part of each clip's identity: edit a scene and only that clip re-renders
const srcDir = path.resolve('scripts/production/indigen-series/scenes');
const srcHash = createHash('sha1');
for (const f of ['engine.js', 'jars.js', 'style.css']) srcHash.update(readFileSync(path.join(srcDir, f)));
const sceneSrc = (name) => readFileSync(path.join(srcDir, `scenes-${name.split('-')[0]}.js`));

for (const s of spec.segs) {
  if (only.length && !only.includes(s.id)) continue;
  const out = path.join(dir, `${s.id}.mp4`);
  const dur = Math.round((s.end - s.start) * 30) / 30;
  const id = createHash('sha1').update(JSON.stringify({ s, dur })).update(s.type === 'scene' ? srcHash.copy().update(sceneSrc(s.scene)).digest('hex') : '').digest('hex');
  const stamp = out + '.stamp';
  if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, 'utf8') === id) { console.log('skip', key, s.id); continue; }
  if (s.type === 'scene') {
    const r = spawnSync(process.execPath, ['scripts/production/indigen-series/render-scene.mjs', s.scene, String(dur), out, `--cues=${JSON.stringify(s.cues)}`], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`scene ${s.id} failed`);
  } else {
    const src = path.join(WORK, 'human', `shot-${s.shot}.mp4`);
    const vf = `setpts=PTS/${s.speed},fps=30,scale=1080:1920:flags=lanczos,setsar=1,format=yuv420p`;
    const r = spawnSync(ffmpeg, ['-y', '-ss', String(s.inPoint), '-i', src, '-an', '-vf', vf, '-t', String(dur), '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-movflags', '+faststart', out], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`human ${s.id} failed`);
  }
  writeFileSync(stamp, id);
  console.log('done', key, s.id, dur);
}
