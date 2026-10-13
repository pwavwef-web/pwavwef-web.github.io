// Scripted captures of specific portal states (dev preview, labelled sample data).
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.TS_BASE ?? 'http://localhost:5199';
const OUT = path.resolve('exports/indigen-contributor-series/_work/ui');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'en-GB', colorScheme: 'light' });
const page = await ctx.newPage();
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log('saved', name); };
async function open(route, ready = /contributor portal/i) {
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await page.getByText(ready).first().waitFor({ timeout: 45000 });
  await page.waitForTimeout(1500);
}
const scrollBy = async (y) => { await page.evaluate((dy) => { const m = document.querySelector('main') ?? document.scrollingElement; const els = [document.scrollingElement, ...document.querySelectorAll('*')].filter((e) => e && e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY !== 'hidden'); (els[els.length - 1] ?? m).scrollBy(0, dy); }, y); await page.waitForTimeout(500); };

// V1 editor on e8 (new item): weak entry -> usage note typed in steps
await open('/contributor/preview/assignment/everyday?item=e8');
await shot('e8-empty');
const tr = page.getByPlaceholder(/Write the Kasem the way you would say it/i);
await tr.fill('[Sample Kasem translation]');
await shot('e8-weak');
await page.getByText(/Alternatives and usage note/i).first().click();
await page.waitForTimeout(700);
await scrollBy(560);
await shot('e8-note-empty');
const note = page.getByPlaceholder(/Who says this, to whom/i);
const full = 'Said to a friend or neighbour who is about to travel. Warm and everyday, not formal.';
for (const n of [14, 38, 62, full.length]) { await note.fill(full.slice(0, n)); await shot(`e8-note-${n}`); }
await scrollBy(-2000);
await shot('e8-strong-top');
// Kawuri check on e8
await page.getByRole('button', { name: /Check with Kawuri/i }).first().click().catch(() => {});
await page.waitForTimeout(2500);
await shot('e8-kawuri');
await scrollBy(700);
await shot('e8-kawuri-2');

// Returned (e3), awaiting (e2), approved (e1) with a proper wait
for (const k of ['e3', 'e2', 'e1']) {
  await open(`/contributor/preview/assignment/everyday?item=${k}`, /expression \d of 8/i);
  await shot(`ed-${k}`);
  await scrollBy(600);
  await shot(`ed-${k}-b`);
}
// Activity and contributions (top part)
await open('/contributor/preview/activity');
await shot('activity');
await open('/contributor/preview/contributions');
await shot('contributions');
await open('/contributor/preview/kawuri?work=everyday&item=e4&mode=check');
await shot('kawuri-page');
await scrollBy(500);
await shot('kawuri-page-b');
await browser.close();
