// node render-scene.mjs <scene> <durationSec> <out.mp4>            renders a scene to video (1080x1920, 30 fps, H.264)
// node render-scene.mjs <scene> <durationSec> <out.png> --at=2.5   renders one still at t
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ffmpeg = require(path.resolve('node_modules/ffmpeg-static'));
const [scene, durS, out, ...rest] = process.argv.slice(2);
const dur = Number(durS);
const at = rest.find((a) => a.startsWith('--at='))?.slice(5);
const cues = JSON.parse(rest.find((a) => a.startsWith('--cues='))?.slice(7) ?? '{}');
const FPS = 30;
const html = pathToFileURL(path.resolve('scripts/production/indigen-series/scenes/scene.html')).href;

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--allow-file-access-from-files', '--force-color-profile=srgb'] });
const page = await (await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 })).newPage();
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
await page.goto(html);
await page.evaluate(([n, d, c]) => window.__init(n, d, c), [scene, dur, cues]);
if (at !== undefined) {
  await page.evaluate((t) => window.__render(t), Number(at));
  await page.screenshot({ path: out });
  await browser.close();
  console.log('still', out);
  process.exit(0);
}
const frames = Math.round(dur * FPS);
const ff = spawn(ffmpeg, ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((r) => ff.on('close', r));
const t0 = Date.now();
for (let i = 0; i < frames; i++) {
  await page.evaluate((t) => window.__render(t), i / FPS);
  const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  if (i % 60 === 0) process.stdout.write(`\r${scene} ${i}/${frames} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
ff.stdin.end();
await done;
await browser.close();
console.log(`\nrendered ${out} (${frames} frames, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
