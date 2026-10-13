import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
const OUT = path.resolve('exports/indigen-contributor-series/_work/ui');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'en-GB' });
const page = await ctx.newPage();
await page.goto('https://kasem-dictionary.web.app/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
await page.screenshot({ path: path.join(OUT, 'dict-home.png') });
const tab = page.getByText(/common phrases/i).first();
if (await tab.count()) { await tab.click().catch(() => {}); await page.waitForTimeout(5000); await page.screenshot({ path: path.join(OUT, 'dict-phrases.png') }); }
console.log(await page.title(), page.url());
await browser.close();
