// Captures the real TribeStudio contributor UI (dev preview, labelled sample data) as phone-sized stills.
//   node scripts/production/indigen-series/capture-ui.mjs [routeKey…]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.TS_BASE ?? 'http://localhost:5199';
const OUT = path.resolve('exports/indigen-contributor-series/_work/ui');
mkdirSync(OUT, { recursive: true });

const routes = {
  overview: '/contributor/preview',
  assignments: '/contributor/preview/assignments',
  contributions: '/contributor/preview/contributions',
  activity: '/contributor/preview/activity',
  guide: '/contributor/preview/guide?section=alternatives-context',
  'ed-e6': '/contributor/preview/assignment/everyday?item=e6',
  'ed-e3': '/contributor/preview/assignment/everyday?item=e3',
  'ed-e2': '/contributor/preview/assignment/everyday?item=e2',
  'ed-e1': '/contributor/preview/assignment/everyday?item=e1',
  'ed-e4': '/contributor/preview/assignment/everyday?item=e4',
  'kawuri-e4': '/contributor/preview/kawuri?work=everyday&item=e4&mode=check',
  'ed-list': '/contributor/preview/assignment/everyday',
};
const want = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'en-GB', colorScheme: 'light' });
const page = await ctx.newPage();
for (const [key, route] of Object.entries(routes)) {
  if (want.length && !want.includes(key)) continue;
  await page.goto(BASE + route, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(OUT, `${key}.png`) });
  console.log('saved', key, await page.title());
}
await browser.close();
