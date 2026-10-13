// node make-deliverables.mjs <v1..v4>
// Packages one finished video: master MP4, WhatsApp copy, SRT, narration script, WhatsApp caption, cover image.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildSpec } from './spec.mjs';
import { VIDEOS } from './scripts.ts';

const require = createRequire(import.meta.url);
const ffmpeg = require(path.resolve('node_modules/ffmpeg-static'));
const key = process.argv[2];
const def = VIDEOS.find((v) => v.key === key);
const spec = buildSpec(key);
const ROOT = path.resolve('exports/indigen-contributor-series');
const WORK = path.join(ROOT, '_work');
const dir = path.join(ROOT, def.slug);
mkdirSync(dir, { recursive: true });
const base = def.slug;

const ts = (s) => { const ms = Math.round(s * 1000); const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), x = Math.floor((ms % 60000) / 1000), r = ms % 1000; const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(h)}:${p(m)}:${p(x)},${p(r, 3)}`; };
// same overlap handling as the timeline's caption track
let prevEnd = 0; const rows = [];
for (const c of spec.captions) { const start = Math.max(Math.round(c.start * 30) / 30, prevEnd); const dur = Math.round((c.end - start) * 1000) / 1000; if (dur <= 0.2) continue; rows.push({ start, end: start + dur, text: c.text }); prevEnd = start + dur; }
writeFileSync(path.join(dir, `${base}.srt`), rows.map((r, i) => `${i + 1}\n${ts(r.start)} --> ${ts(r.end)}\n${r.text}\n`).join('\n'), 'utf8');
writeFileSync(path.join(dir, `${base}-narration-script.txt`), `${def.title}\nNarrator (AZ Studio voice "${'Sulafat'}"), English only; no Kasem is spoken.\n\n${def.lines.map((l, i) => `${String(i + 1).padStart(2, '0')}. ${l}`).join('\n\n')}\n`, 'utf8');
writeFileSync(path.join(dir, `${base}-whatsapp-caption.txt`), def.whatsapp + '\n', 'utf8');
const cover = path.join(WORK, 'covers', `${key}.png`);
if (existsSync(cover)) spawnSync(ffmpeg, ['-y', '-i', cover, '-q:v', '2', path.join(dir, `${base}-cover.jpg`)], { stdio: 'ignore' });
const master = path.join(WORK, 'renders', `${key}-final.mp4`);
if (!existsSync(master)) throw new Error('no final render for ' + key);
copyFileSync(master, path.join(dir, `${base}-master-1080x1920.mp4`));
const wa = path.join(dir, `${base}-whatsapp-720x1280.mp4`);
const r = spawnSync(ffmpeg, ['-y', '-i', master, '-vf', 'scale=720:1280:flags=lanczos,setsar=1', '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'slow', '-crf', '26', '-maxrate', '1600k', '-bufsize', '3200k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', wa], { stdio: 'inherit' });
if (r.status !== 0) throw new Error('whatsapp encode failed');
console.log('packaged', dir);
