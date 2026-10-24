import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { WEB_PORT } from './global-setup';

/**
 * Film Studio Lite in a real browser against the emulators: create a film, write the narration, plan scenes,
 * upload stills and per-scene recordings, synthesise ambience, preview, render a draft with the real renderer
 * (run locally by the emulator), reopen and duplicate. Nothing here calls a billable model: the narration
 * timing a transcription would return is written as a stand-in (the test audio's word times are known).
 */

const PROJECT = 'demo-az-studio';
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const AUTH = 'http://127.0.0.1:9099';
const DB = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/az-studio/documents`;
const OWNER = { uid: 'owner-test-uid', email: 'owner@test.dev', password: 'owner-password-1' };
const require = createRequire(import.meta.url);
const FF = require('ffmpeg-static') as string;
const work = mkdtempSync(path.join(os.tmpdir(), 'azs-lite-e2e-'));

function fsValue(v: unknown): unknown {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, fsValue(x)])) } };
}
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
async function adminSet(p: string, data: Record<string, unknown>) {
  const res = await fetch(`${DB}/${p}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ fields: (fsValue(data) as { mapValue: { fields: unknown } }).mapValue.fields }) });
  if (!res.ok) throw new Error(`adminSet ${p}: ${res.status}`);
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

/** Synthetic narration: one voiced tone burst per word at known times (not speech). */
function narrationWav(text: string, file: string) {
  const RATE = 24000;
  const words: { text: string; start: number; end: number }[] = [];
  let t = 0.35;
  for (const w of text.split(/\s+/)) {
    const len = 0.16 + 0.045 * w.replace(/[^\w]/g, '').length;
    words.push({ text: w, start: +t.toFixed(3), end: +(t + len).toFixed(3) });
    t += len + (/[.!?]$/.test(w) ? 0.55 : /,$/.test(w) ? 0.25 : 0.07);
  }
  const total = +(t + 0.5).toFixed(3);
  const s = new Int16Array(Math.ceil(total * RATE));
  for (const w of words) for (let i = Math.floor(w.start * RATE); i < Math.floor(w.end * RATE); i++) s[i] = Math.round(9000 * Math.sin((Math.PI * (i / RATE - w.start)) / (w.end - w.start)) * Math.sin((2 * Math.PI * 160 * i) / RATE));
  const data = Buffer.from(s.buffer);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([h, data]));
  return { words, durationSec: total, speechStart: words[0]!.start, speechEnd: words[words.length - 1]!.end };
}

function chromePath(): string | undefined {
  const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return candidates.find((p) => p && existsSync(p));
}

const SCRIPT = ['In the village, the walls remember. Every season, the women paint them again.', 'The patterns are a language. Diamonds for the path, waves for the river.', 'When the rains come, the colours fade. And so they paint again.'];

let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

beforeAll(async () => {
  await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ localId: OWNER.uid, email: OWNER.email, password: OWNER.password, emailVerified: true }) });
  const executablePath = chromePath();
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => pageErrors.push(String(e)));
});
afterAll(async () => {
  await browser?.close();
});

describe('Film Studio Lite in a real browser', () => {
  let filmId = '';

  it('creates a film from the studio list and saves the narration', async () => {
    await page.goto(`${BASE}/studio`);
    // The first visit compiles the app in the dev server; give it time on a busy machine.
    await page.locator('#email, nav[aria-label="Primary"]').first().waitFor({ timeout: 120_000 });
    if (await page.locator('#email').count()) {
      await page.locator('#email').fill(OWNER.email);
      await page.locator('#password').fill(OWNER.password);
      await page.getByRole('button', { name: 'Sign in with email' }).click();
    }
    // The studio is opened from the Create page since the sidebar was trimmed; go to it directly.
    await page.getByRole('link', { name: 'Projects' }).first().waitFor({ timeout: 120_000 });
    await page.goto(`${BASE}/lite`);
    await page.getByRole('button', { name: 'New film' }).first().click();
    await page.locator('#lite-title').fill('E2E Lite film');
    await page.getByRole('radio', { name: /Atmospheric documentary/ }).click();
    await page.getByRole('radio', { name: '2 min' }).click();
    await page.getByRole('button', { name: 'Create film' }).click();
    await page.waitForURL(/\/lite\/[^/]+\/story/);
    filmId = new URL(page.url()).pathname.split('/')[2]!;
    await page.locator('#lite-script').fill(SCRIPT.join('\n\n'));
    const p = await until(async () => {
      const d = await adminGet(`projects/${filmId}`);
      return d?.lite?.story?.script?.includes('rains') ? d : null;
    }, 'script saved');
    expect(p.type).toBe('film_lite');
    expect(p.lite.setup.direction).toBe('documentary');
  });

  it('plans scenes without AI and places uploaded stills', async () => {
    await page.getByRole('button', { name: 'Plan scenes →' }).click();
    await page.getByRole('button', { name: 'From script (no AI)' }).click();
    await until(async () => ((await adminGet(`projects/${filmId}`))?.lite?.scenes?.length === 3 ? true : null), 'three scenes');
    const files = ['one', 'two', 'three'].map((n, i) => {
      const f = path.join(work, `${n}.png`);
      execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=1376x768:d=1,hue=h=${i * 90}`, '-frames:v', '1', f]);
      return f;
    });
    await page.locator('input[type=file][multiple][accept*="image"]').setInputFiles(files);
    const scenes = await until(async () => {
      const s = (await adminGet(`projects/${filmId}`))?.lite?.scenes;
      return s?.every((x: { shots: { image: { approvedAssetId: string | null } }[] }) => x.shots.every((sh) => sh.image.approvedAssetId)) ? s : null;
    }, 'images approved', 120_000);
    expect(scenes).toHaveLength(3);
  });

  it('times per-scene recordings, synthesises ambience and previews the edit', async () => {
    await page.getByRole('navigation', { name: 'Film workflow' }).getByRole('button', { name: /Voice & Sound/ }).click();
    await page.getByRole('radio', { name: 'A recording per scene' }).click();
    const timings = SCRIPT.map((text, i) => narrationWav(text, path.join(work, `scene${i}.wav`)));
    const inputs = page.locator('li input[type=file][accept="audio/*"]');
    for (let i = 0; i < 3; i++) await inputs.nth(i).setInputFiles(path.join(work, `scene${i}.wav`));
    const spec = await until(async () => {
      const d = await adminGet(`projects/${filmId}`);
      return d?.lite?.scenes?.every((s: { voiceUploadAssetId: string | null }) => s.voiceUploadAssetId) ? d.lite : null;
    }, 'recordings uploaded', 120_000);
    // Stand-in for the transcription provider: the result the narration worker writes for each recording.
    for (const [i, s] of (spec.scenes as { id: string; voiceUploadAssetId: string }[]).entries()) {
      const t = timings[i]!;
      const take = { sceneId: s.id, hash: `e2e-${i}`, assetId: s.voiceUploadAssetId, inPoint: 0, outPoint: t.durationSec, speechStart: t.speechStart, speechEnd: t.speechEnd, words: t.words.map((w) => ({ ...w, confidence: 1 })), alignment: 'aligned', coverage: 1, flags: ['local_stand_in: synthetic recording, word times known'], source: 'upload_scene', voice: null };
      await adminSet(`jobs/e2e-take-${filmId}-${i}`, { ownerUid: OWNER.uid, projectId: filmId, type: 'lite.narration', status: 'completed', stage: 'stand-in', progress: 1, target: { kind: 'lite_scene', id: s.id }, params: { mode: 'align_scene', inputHash: take.hash }, result: { assetIds: [s.voiceUploadAssetId], data: { takes: [take] } }, error: null, cancelRequested: false, createdAt: new Date(), completedAt: new Date() });
    }
    await page.getByText('3/3 scenes voiced').waitFor();
    await page.getByRole('radio', { name: 'No music' }).click();
    await page.getByRole('button', { name: 'Make ambience beds' }).click();
    await until(async () => (await adminList('jobs')).some((j) => j.data.projectId === filmId && j.data.type === 'audio.ambience' && j.data.status === 'completed'), 'ambience bed', 120_000);
    await page.getByRole('navigation', { name: 'Film workflow' }).getByRole('button', { name: /Edit/ }).click();
    await page.getByRole('img', { name: 'Film preview' }).waitFor();
    await page.getByRole('button', { name: 'Accept this timing' }).click();
    // The composition is saved as the format's timeline (what preview shows and the renderer reads).
    const timelines = await until(async () => {
      const l = await adminList(`projects/${filmId}/timelines`);
      return l.length ? l : null;
    }, 'composition saved');
    const clips = timelines[0]!.data.clips as { trackId: string; kind: string; motion?: unknown }[];
    expect(clips.filter((c) => c.kind === 'image' && c.motion).length).toBeGreaterThanOrEqual(3);
    expect(clips.some((c) => c.trackId === 'lt_voice')).toBe(true);
    expect(clips.some((c) => c.kind === 'caption')).toBe(true);
  });

  it('renders a draft with the real renderer, then reopens and duplicates the film', async () => {
    await page.getByRole('navigation', { name: 'Film workflow' }).getByRole('button', { name: /Export/ }).click();
    await page.getByText('No blocking problems for 16:9.').waitFor();
    await page.getByRole('button', { name: 'Render draft preview' }).click();
    const render = await until(async () => (await adminList('renders')).find((r) => r.data.projectId === filmId && ['completed', 'failed'].includes(r.data.status)), 'draft render', 600_000);
    expect(render.data.status, render.data.error?.message).toBe('completed');
    const asset = await adminGet(`assets/${render.data.outputAssetId}`);
    expect(asset.kind).toBe('video');
    expect(Math.abs(asset.durationSec - render.data.durationSec)).toBeLessThan(0.2);
    await page.reload();
    await page.getByText('Saved exports').waitFor();
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await page.waitForURL((u) => !u.pathname.includes(filmId));
    await page.getByText('3/3 scenes').waitFor();
    expect(pageErrors).toEqual([]);
  });
});
