import './common';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { transcribe } from '../../../functions/src/lib/audio-models';
import { say, WORK } from './common';
import { VIDEOS } from './scripts';

// Usage: 05-verify-audio.ts <v1..v4> [file]   transcribes the finished mix and compares it with the narration script
const key = process.argv[2]!;
const file = process.argv[3] ?? path.join(WORK, 'renders', `${key}-final.mp4`);
const ffmpeg = createRequire(import.meta.url)(path.resolve('node_modules/ffmpeg-static')) as string;
mkdirSync(path.join(WORK, 'scratch'), { recursive: true });
const wav = path.join(WORK, 'scratch', `${key}-mix.wav`);
spawnSync(ffmpeg, ['-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav], { stdio: 'ignore' });
const r = await transcribe({ data: readFileSync(wav), mimeType: 'audio/wav', languageCode: 'en', vocabulary: ['Kasem', 'Indigen World', 'Kawuri', 'TribeStudio'] });
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
const ref = norm(VIDEOS.find((v) => v.key === key)!.lines.join(' '));
const hyp = norm(r.text);
// word error rate by edit distance
const d: number[][] = Array.from({ length: ref.length + 1 }, (_, i) => [i, ...Array(hyp.length).fill(0)]);
for (let j = 0; j <= hyp.length; j++) d[0]![j] = j;
for (let i = 1; i <= ref.length; i++) for (let j = 1; j <= hyp.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
say(`${key} heard: ${r.text}`);
say(`${key} word error rate vs script: ${((d[ref.length]![hyp.length]! / ref.length) * 100).toFixed(1)} % (${ref.length} words)`);
process.exit(0);
