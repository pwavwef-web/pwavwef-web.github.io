import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { WEB_PORT } from './global-setup';

/**
 * Link to Ad in a real browser against the emulators, FIXTURE MODE: a made-up guesthouse website, the
 * fixture planner and a tone-per-word voice stand in for the live providers (nothing leaves this machine and
 * nothing is billed), while everything else is the real thing: the extraction, the checks, the confirmations,
 * the saved timeline, the studio's own FFmpeg renderer (run locally by the emulator) and the checks on the
 * finished MP4. The ad is labelled "Fixture run" throughout and so is this test's claim: it is not a live
 * provider run.
 */

const PROJECT = 'demo-az-studio';
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const AUTH = 'http://127.0.0.1:9099';
const DB = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/az-studio/documents`;
const OWNER = { uid: 'owner-test-uid', email: 'owner@test.dev', password: 'owner-password-1' };
const require = createRequire(import.meta.url);
const FF = require('ffmpeg-static') as string;
const FP = (require('ffprobe-static') as { path: string }).path;
const work = process.env.AZS_LINKAD_E2E_OUT ? process.env.AZS_LINKAD_E2E_OUT : mkdtempSync(path.join(os.tmpdir(), 'azs-linkad-e2e-'));
mkdirSync(work, { recursive: true });

function fromValue(v: Record<string, unknown>): unknown {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return ((v.arrayValue as { values?: Record<string, unknown>[] }).values ?? []).map(fromValue);
  if ('mapValue' in v) return Object.fromEntries(Object.entries((v.mapValue as { fields?: Record<string, Record<string, unknown>> }).fields ?? {}).map(([k, x]) => [k, fromValue(x)]));
  return undefined;
}
async function adminGet(p: string): Promise<any> {
  const res = await fetch(`${DB}/${p}`, { headers: { Authorization: 'Bearer owner' } });
  if (res.status === 404) return null;
  const body = (await res.json()) as { fields?: Record<string, Record<string, unknown>> };
  return fromValue({ mapValue: { fields: body.fields ?? {} } });
}
async function adminList(p: string): Promise<{ id: string; data: any }[]> {
  const res = await fetch(`${DB}/${p}?pageSize=300`, { headers: { Authorization: 'Bearer owner' } });
  const body = (await res.json()) as { documents?: { name: string; fields?: Record<string, Record<string, unknown>> }[] };
  return (body.documents ?? []).map((d) => ({ id: d.name.split('/').pop()!, data: fromValue({ mapValue: { fields: d.fields ?? {} } }) }));
}
async function until<T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function chromePath(): string | undefined {
  const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return candidates.find((p) => p && existsSync(p));
}

let browser: Browser;
let page: Page;
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
/** The text of any error toast currently on the page (the page's own explanation of what went wrong). */
const toasts = async () => (await page.locator('[data-sonner-toast]').allInnerTexts().catch(() => [])).join(' | ');

/** Downloads a stored file from the storage emulator as the emulator admin (production uses signed URLs). */
async function download(storagePath: string, file: string) {
  const res = await fetch(`http://127.0.0.1:9199/v0/b/az-studio-media-az-learner/o/${encodeURIComponent(storagePath)}?alt=media`, { headers: { Authorization: 'Bearer owner' } });
  if (!res.ok) throw new Error(`download ${storagePath}: ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}
/** Screenshots of each step are kept next to the exported videos (evidence of what the page showed). */
const shot = async (name: string) => page.screenshot({ path: path.join(work, `ui-${name}.png`), fullPage: true }).catch(() => undefined);
const probe = (file: string) => JSON.parse(execFileSync(FP, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString()) as { format: { duration: string }; streams: { codec_type: string; codec_name: string; width?: number; height?: number }[] };

beforeAll(async () => {
  await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ localId: OWNER.uid, email: OWNER.email, password: OWNER.password, emailVerified: true }) });
  const executablePath = chromePath();
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 300)));
  await page.route(/127\.0\.0\.1:9199\/v0\/b\/.+\?alt=media/, async (route) => {
    const res = await fetch(route.request().url(), { headers: { Authorization: 'Bearer owner' } });
    await route.fulfill({ status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'access-control-allow-origin': '*' }, body: Buffer.from(await res.arrayBuffer()) });
  });
});
afterEach(async (ctx) => {
  if (ctx.task.result?.state === 'fail') await page?.screenshot({ path: path.join(work, `${ctx.task.name.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true }).catch(() => undefined);
});
afterAll(async () => {
  console.log(`e2e work files: ${work}`);
  await browser?.close();
});

describe('Link to Ad in a real browser (fixture run)', () => {
  let adId = '';
  const step = (name: RegExp) => page.getByRole('navigation', { name: 'Link to Ad steps' }).getByRole('button', { name });
  const ad = async () => (await adminGet(`projects/${adId}`))?.linkad;

  it('starts from a website address and reads the (fixture) site into a sourced bundle', async () => {
    await page.goto(`${BASE}/studio`);
    await page.locator('#email, nav[aria-label="Primary"]').first().waitFor({ timeout: 120_000 });
    if (await page.locator('#email').count()) {
      await page.locator('#email').fill(OWNER.email);
      await page.locator('#password').fill(OWNER.password);
      await page.getByRole('button', { name: 'Sign in with email' }).click();
    }
    await page.getByRole('link', { name: 'Projects' }).first().waitFor({ timeout: 120_000 });
    await page.goto(`${BASE}/linkad`);
    await page.getByRole('heading', { name: 'Link to Ad' }).first().waitFor();
    await page.locator('#linkad-url').fill('https://harbourlight.example/');
    await page.locator('#linkad-promote').fill('Our sea-view rooms');
    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('checkbox', { name: /Fixture run/ }).check();
    await page.getByRole('button', { name: 'Analyse website' }).click();
    await page.waitForURL(/\/linkad\/[^/]+\/source/);
    adId = new URL(page.url()).pathname.split('/')[2]!;
    const doc = await until(async () => {
      const d = await ad();
      return d?.stage === 'reviewing' ? d : null;
    }, 'site read and brief proposed', 240_000);
    expect(doc.mode).toBe('fixture');
    expect(doc.source.status).toBe('ok');
    expect(doc.source.facts.length).toBeGreaterThan(5);
    expect(doc.source.facts.every((f: { sourceUrl: string; excerpt: string; retrievedAt: number }) => f.sourceUrl.startsWith('https://harbourlight.example') && f.excerpt && f.retrievedAt)).toBe(true);
    expect(doc.source.assets.filter((a: { status: string }) => a.status === 'stored').length).toBeGreaterThanOrEqual(2);
    await page.getByText('What I found').first().waitFor();
    await page.getByText(/talks? to AI assistants|talk to AI assistants/).first().waitFor();
    await page.getByText('Fixture run').first().waitFor();
    await shot('1-website');
  });

  it('keeps found facts apart from the director’s own, and needs confirmation for prices and rights for pictures', async () => {
    await page.getByRole('heading', { name: 'Facts', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Confirm this is current' }).first().waitFor();
    await page.getByRole('textbox', { name: 'Fact', exact: true }).fill('Free airport pickup on request');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('Free airport pickup on request').waitFor();
    // Pictures must not appear until the director says they may be used.
    const before = await ad();
    expect(before.source.assets.filter((a: { status: string; rights: string }) => a.status === 'stored').every((a: { rights: string }) => a.rights === 'unconfirmed')).toBe(true);
    await page.getByRole('checkbox', { name: /I own these pictures/ }).check();
    await until(async () => (await ad())?.source?.assets?.filter((a: { origin: string }) => a.origin === 'site').every((a: { rights: string }) => a.rights === 'confirmed'), 'rights confirmed on the server');
    expect((await ad()).userFacts.some((f: { text: string }) => f.text === 'Free airport pickup on request')).toBe(true);
    await shot('2-facts-and-pictures');
  });

  it('shows the proposed ad and needs the price confirmed before the final export', async () => {
    await page.getByRole('button', { name: 'Continue', exact: true }).first().click();
    await page.getByRole('heading', { name: 'Here is the ad I propose:' }).waitFor();
    await page.getByText('AI recommendation').first().waitFor();
    await shot('3-proposed-ad');
    // Not confirmed yet: the planner is allowed to start, the export is not (checked on the Export step later).
    await page.getByRole('button', { name: /Approve and plan three directions/ }).click();
    await page.waitForURL(/\/directions/);
    const planned = await until(async () => {
      const d = await ad();
      return d?.directions?.length === 3 ? d : null;
    }, 'three directions', 240_000);
    expect(planned.briefApprovedAt).toBeTruthy();
    expect(planned.stage).toBe('awaiting_selection');
    expect(new Set(planned.directions.map((d: { title: string }) => d.title)).size).toBe(3);
    await page.getByRole('button', { name: 'Use this direction' }).first().waitFor();
    await shot('4-directions');
    await page.getByRole('button', { name: 'Rough preview' }).first().click();
    await page.getByText(/Rough preview · no voice/).first().waitFor();
    await page.keyboard.press('Escape');
  });

  it('opens the chosen direction as an editable ad, records the voice and times the captions', async () => {
    await page.getByRole('button', { name: 'Use this direction' }).first().click();
    await page.waitForURL(/\/edit/);
    await page.getByRole('heading', { name: 'Voice', exact: true }).waitFor();
    const scene2 = page.locator('textarea[id^="n-"]').nth(1);
    await scene2.fill('Every room opens onto a shared terrace that is open from sunrise until late in the evening.');
    await until(async () => (await ad())?.ad?.scenes?.[1]?.narration?.startsWith('Every room opens'), 'edit saved');
    await page.getByRole('button', { name: /Make the voice/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Record' }).click();
    const voiced = await until(async () => {
      const d = await ad();
      const s = d?.ad?.scenes ?? [];
      if (/Could not/.test(await toasts())) throw new Error(`the page reported: ${await toasts()} · console: ${consoleErrors.join(' / ')} · last error: ${JSON.stringify(d?.lastError)}`);
      if (d?.lastError?.step === 'voice') throw new Error(`voice step failed: ${JSON.stringify(d.lastError)}`);
      return s.length && s.every((x: { id: string }) => d.ad.takes?.[x.id]) && !d.activeJobId ? d : null;
    }, 'voice recorded', 300_000);
    for (const s of voiced.ad.scenes as { id: string }[]) {
      const t = voiced.ad.takes[s.id];
      expect(t.alignment).toBe('aligned');
      expect(t.source).toBe('fixture');
      expect(t.words.length).toBeGreaterThan(3);
    }
    await page.getByRole('button', { name: 'Voice is up to date' }).waitFor();
    // The real composition is previewed once the voice exists.
    await page.getByRole('img', { name: 'Film preview' }).waitFor();
    await shot('5-editor');
    // Changing a caption colour needs no new recording.
    await page.locator('#c-c').fill('#ffe08a');
    await until(async () => (await ad())?.ad?.captions?.color === '#FFE08A', 'caption colour saved');
    expect(Object.keys((await ad()).ad.takes)).toHaveLength(voiced.ad.scenes.length);
  });

  it('refuses the final export until prices are confirmed, then exports a draft and a final MP4 that pass the file checks', async () => {
    await step(/Export/).click();
    await page.getByRole('heading', { name: 'Export', exact: true }).waitFor();
    // The wording used in the ad may only use confirmed facts: with an unconfirmed price in the brief the final is blocked or the planner kept clear of it.
    const doc0 = await ad();
    const pricesUsed = (doc0.brief.usedFactIds as string[]).filter((id) => doc0.source.facts.some((f: { id: string; kind: string }) => f.id === id && f.kind === 'price'));
    if (pricesUsed.length && !pricesUsed.every((id) => doc0.confirmations[id])) await page.getByText(/must be fixed before the final export/).waitFor();

    await page.getByRole('button', { name: 'Quick preview (draft)' }).click();
    const draft = await until(async () => {
      const e = (await ad())?.exports?.find((x: { quality: string; status: string }) => x.quality === 'draft' && ['completed', 'failed'].includes(x.status));
      return e ?? null;
    }, 'draft render', 600_000);
    expect(draft.status, draft.error).toBe('completed');
    expect(draft.checks.ok, draft.checks.notes?.join(' ')).toBe(true);
    const asset = await adminGet(`assets/${draft.outputAssetId}`);
    const file = path.join(work, 'link-to-ad-draft.mp4');
    await download(asset.storagePath, file);
    const pr = probe(file);
    expect(pr.streams.find((s) => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: 720, height: 1280 });
    expect(pr.streams.find((s) => s.codec_type === 'audio')?.codec_name).toBe('aac');
    const dur = Number(pr.format.duration);
    expect(dur).toBeGreaterThanOrEqual(15);
    expect(dur).toBeLessThanOrEqual(30);
    await page.getByText('Duration, picture, sound and codecs all match').first().waitFor();
    await shot('6-export-draft');

    // Final: confirm what must be confirmed (the page lists it), then export 1080 x 1920.
    const need = await ad();
    const toConfirm = (need.source.facts as { id: string; needsConfirmation: boolean }[]).filter((f) => f.needsConfirmation).map((f) => f.id);
    await page.goto(`${BASE}/linkad/${adId}/source`);
    await page.getByRole('heading', { name: 'Facts', exact: true }).waitFor();
    const buttons = page.getByRole('button', { name: 'Confirm this is current' });
    await until(async () => (await buttons.count()) > 0, 'confirm buttons rendered');
    for (let left = await buttons.count(); left > 0; left = await buttons.count()) {
      await buttons.first().click();
      // Each click is a server round trip; the button reads “Confirmed as current” once the document comes back.
      await until(async () => (await buttons.count()) < left, 'a confirmation applied');
    }
    await until(async () => Object.keys((await ad()).confirmations).length >= toConfirm.length, 'confirmations saved');
    await step(/Export/).click();
    await page.getByRole('button', { name: 'Export final MP4' }).click();
    const final = await until(async () => {
      const e = (await ad())?.exports?.find((x: { quality: string; status: string }) => x.quality === 'final' && ['completed', 'failed'].includes(x.status));
      return e ?? null;
    }, 'final render', 900_000);
    expect(final.status, final.error).toBe('completed');
    expect(final.checks.ok, final.checks.notes?.join(' ')).toBe(true);
    expect(final.checks).toMatchObject({ width: 1080, height: 1920, videoCodec: 'h264', audioCodec: 'aac' });
    const fAsset = await adminGet(`assets/${final.outputAssetId}`);
    const fFile = path.join(work, 'link-to-ad-final.mp4');
    await download(fAsset.storagePath, fFile);
    const fp = probe(fFile);
    expect(fp.streams.find((s) => s.codec_type === 'video')).toMatchObject({ width: 1080, height: 1920 });
    // A contact sheet to look at.
    execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-i', fFile, '-vf', `fps=1/${Math.max(1.5, Number(fp.format.duration) / 8).toFixed(2)},scale=270:-1,tile=4x2`, '-frames:v', '1', path.join(work, 'link-to-ad-final-sheet.png')]);
    expect((await ad()).stage).toBe('ready');
    await page.reload();
    await page.getByText('Final 1080 × 1920').first().waitFor();
    await shot('7-export-final');
  });

  it('restores everything on reload, marks exports out of date after a change, and duplicates without regenerating', async () => {
    await page.reload();
    await page.getByRole('heading', { name: 'Export', exact: true }).waitFor();
    await page.getByText('Final 1080 × 1920').first().waitFor();
    await step(/Edit/).click();
    expect(await page.locator('textarea[id^="n-"]').nth(1).inputValue()).toMatch(/^Every room opens/);
    await page.locator('#cl-h').fill('Reserve today');
    await until(async () => (await ad())?.ad?.closing?.headline === 'Reserve today', 'closing saved');
    await step(/Export/).click();
    await page.getByText(/Out of date/).first().waitFor();
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await page.waitForURL((u) => !u.pathname.includes(adId));
    const copyId = new URL(page.url()).pathname.split('/')[2]!;
    const copy = await until(async () => {
      const d = (await adminGet(`projects/${copyId}`))?.linkad;
      return d?.importedFrom ? d : null;
    }, 'copy saved');
    expect(copy.importedFrom.projectId).toBe(adId);
    expect(copy.exports).toEqual([]);
    expect(Object.keys(copy.ad.takes).length).toBeGreaterThan(0);
    expect((await adminList('jobs')).filter((j) => j.data.projectId === copyId)).toHaveLength(0);
    expect(pageErrors).toEqual([]);
  });
});
