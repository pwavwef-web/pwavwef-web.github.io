// Measures every deliverable and writes exports/indigen-contributor-series/README.md
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { VIDEOS } from './scripts.ts';

const ffmpeg = createRequire(import.meta.url)(path.resolve('node_modules/ffmpeg-static'));
const ROOT = path.resolve('exports/indigen-contributor-series');
const WORK = path.join(ROOT, '_work');
const info = (f) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', f], { encoding: 'utf8' });
  const t = r.stderr;
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(t);
  const secs = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
  const v = /Video: (\w+).*?, (\d+x\d+)/.exec(t);
  const a = /Audio: (\w+).*?, (\d+) Hz, (\w+)/.exec(t);
  const l = spawnSync(ffmpeg, ['-hide_banner', '-i', f, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const lufs = /\n\s+I:\s+(-?[\d.]+) LUFS/.exec(l);
  const peak = /\n\s+Peak:\s+(-?[\d.]+) dBFS/.exec(l);
  return { secs, size: statSync(f).size, video: v ? `${v[1]} ${v[2]}` : '?', audio: a ? `${a[1]} ${a[2]} Hz ${a[3]}` : '?', lufs: lufs?.[1], peak: peak?.[1] };
};
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} (${s.toFixed(1)} s)`;
const targets = { v1: '75–90 s', v2: '45–60 s', v3: '45–60 s', v4: '60–90 s' };
const insp = (k) => { const f = path.join(WORK, 'renders', `${k}-final-inspection.json`); if (!existsSync(f)) return 'n/a'; const d = JSON.parse(readFileSync(f, 'utf8')); return `${d.findings?.length ?? 0} findings`; };
let md = `# Indigen World contributor series — delivery

Four separate vertical videos for existing Indigen World contributors, produced with AZ Studio (project folder: \`${path.basename(process.cwd())}\`). Narration, music and all footage were generated in AZ Studio (Gemini TTS, Lyria 3.5, Gemini Omni, Nano Banana Pro); the motion graphics were built from the real portal screens and brand mark; final renders and inspections ran on the AZ Studio renderer.

| # | Video | Duration (target) | Master 1080×1920 | WhatsApp 720×1280 |
|---|---|---|---|---|
`;
const notes = [];
for (const [i, v] of VIDEOS.entries()) {
  const dir = path.join(ROOT, v.slug);
  const m = path.join(dir, `${v.slug}-master-1080x1920.mp4`);
  const w = path.join(dir, `${v.slug}-whatsapp-720x1280.mp4`);
  if (!existsSync(m)) { md += `| ${i + 1} | ${v.title} | missing | | |\n`; continue; }
  const im = info(m), iw = info(w);
  md += `| ${i + 1} | ${v.title} | ${mmss(im.secs)} (${targets[v.key]}) | ${mb(im.size)} | ${mb(iw.size)} |\n`;
  notes.push(`- **${v.slug}** — master: ${im.video}, ${im.audio}, integrated loudness ${im.lufs} LUFS, true peak ${im.peak} dBFS. WhatsApp copy: ${iw.video}, ${iw.audio}, ${iw.lufs} LUFS. AZ Studio final inspection: ${insp(v.key)}.`);
}
md += `\n## Technical details\n\n${notes.join('\n')}\n\n## Each video folder contains\n\n- \`*-master-1080x1920.mp4\` — H.264 + AAC master\n- \`*-whatsapp-720x1280.mp4\` — smaller copy (H.264 main, ~1.6 Mbit/s max, AAC 96 kbit/s), captions remain readable\n- \`*.srt\` — captions matching the burned-in ones\n- \`*-narration-script.txt\` — final narration (English only)\n- \`*-cover.jpg\` — cover / thumbnail (1080×1920)\n- \`*-whatsapp-caption.txt\` — one-line WhatsApp caption with a single action\n\n## Shared folders\n\n- \`FACT-CHECK.md\` — every claim traced to the Indigen World project, plus what is deliberately not claimed\n- \`_project/<video>/\` — editable AZ Studio project and timeline JSON (also live in AZ Studio: projects titled “Indigen World contributors — …”)\n- \`_project/reusable-assets/\` — scene sources (HTML/CSS/JS), portal captures, SFX, covers, step scripts\n`;
writeFileSync(path.join(ROOT, 'README.md'), md);
console.log(md);
