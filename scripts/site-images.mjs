#!/usr/bin/env node
// Renders the public website's raster images into apps/web/public/:
//   og.png               1200 × 630 sharing image (Open Graph / Twitter)
//   apple-touch-icon.png 180 × 180 home-screen icon (the favicon.svg mark)
// Uses the locally installed Chrome through playwright-core and the self-hosted fonts. Re-run after changing the
// tagline or the mark: node scripts/site-images.mjs
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}apps/web/public`;
// Embedded as data URLs: a page set with setContent() may not load file:// fonts.
const font = (p) => `data:font/woff2;base64,${readFileSync(`${root}node_modules/${p}`).toString('base64')}`;
const mark = readFileSync(`${out}/favicon.svg`, 'utf8');

const og = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: 'Instrument Serif'; src: url('${font('@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2')}') format('woff2'); }
@font-face { font-family: 'Inter'; font-weight: 100 900; src: url('${font('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')}') format('woff2'); }
html, body { margin: 0; }
body { width: 1200px; height: 630px; box-sizing: border-box; padding: 72px 84px; background: #0b1426; color: #eef3fb; font-family: 'Inter', sans-serif; position: relative; overflow: hidden; }
.brand { display: flex; align-items: center; gap: 18px; font-family: 'Instrument Serif', serif; font-size: 44px; }
.brand svg { width: 64px; height: 64px; }
h1 { font-family: 'Instrument Serif', serif; font-weight: 400; font-size: 92px; line-height: 1.02; letter-spacing: -0.01em; margin: 64px 0 0; max-width: 900px; }
.foot { position: absolute; left: 84px; right: 84px; bottom: 64px; display: flex; justify-content: space-between; font-size: 26px; color: #a9b8d3; }
.foot b { color: #8ab6ff; font-weight: 600; }
.track { position: absolute; right: 84px; top: 84px; display: flex; gap: 8px; }
.track span { display: block; height: 14px; border-radius: 7px; }
</style></head><body>
<div class="brand">${mark}<span>AZ Studio</span></div>
<div class="track"><span style="width:90px;background:#3f74e0"></span><span style="width:130px;background:#6f9dff"></span><span style="width:60px;background:#2d4f8f"></span><span style="width:80px;background:#8ab6ff"></span></div>
<h1>Make room for your next creative idea.</h1>
<div class="foot"><span>Video · Images · Music · Narration</span><b>az-studio.web.app</b></div>
</body></html>`;

const icon = `<!doctype html><html><head><style>html,body{margin:0;background:#070a10}svg{display:block;width:180px;height:180px}</style></head><body>${mark}</body></html>`;

const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(og, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${out}/og.png`, type: 'png' });
  await page.setViewportSize({ width: 180, height: 180 });
  await page.setContent(icon, { waitUntil: 'load' });
  await page.screenshot({ path: `${out}/apple-touch-icon.png`, type: 'png', omitBackground: false });
  console.log('Wrote apps/web/public/og.png and apps/web/public/apple-touch-icon.png');
} finally {
  await browser.close();
}
