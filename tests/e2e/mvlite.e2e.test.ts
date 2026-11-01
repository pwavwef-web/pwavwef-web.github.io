import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { WEB_PORT } from './global-setup';

/**
 * Music Video Lite in a real browser against the emulators: create a video, upload a song, detect its beats
 * and sections in the browser, plan the shots from the song, price the images (and cancel), place uploaded
 * stills, preview, render a draft with the real renderer (run locally by the emulator), reopen and duplicate.
 * Nothing here calls a billable model: the word timing a lyric synchronisation would return is written as a
 * stand-in (the test song's sung words are at known times).
 */

const PROJECT = 'demo-az-studio';
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const AUTH = 'http://127.0.0.1:9099';
const DB = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/az-studio/documents`;
const OWNER = { uid: 'owner-test-uid', email: 'owner@test.dev', password: 'owner-password-1' };
const require = createRequire(import.meta.url);
const FF = require('ffmpeg-static') as string;
const work = mkdtempSync(path.join(os.tmpdir(), 'azs-mvlite-e2e-'));

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
/** Merges fields into a document (only the named top-level fields change). */
async function adminPatch(p: string, data: Record<string, unknown>) {
  const mask = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${DB}/${p}?${mask}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ fields: (fsValue(data) as { mapValue: { fields: unknown } }).mapValue.fields }) });
  if (!res.ok) throw new Error(`adminPatch ${p}: ${res.status}`);
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

const BPM = 120;
const SONG_SEC = 32;
/** Sung words at known times (two lines in the verse, two in the chorus). */
const LINES = [
  { text: 'walking down the river road', start: 8.5 },
  { text: 'carry home the evening light', start: 12.2 },
  { text: 'sing it loud tonight', start: 16.3 },
  { text: 'the whole town hears the drum', start: 20.2 },
];

/**
 * A synthetic song: kick on every beat (accented on bar lines), a bass pulse, a pad whose level follows the
 * sections (quiet intro, verse, loud chorus, quiet outro) and voiced tone bursts where the words are sung.
 */
function songWav(file: string) {
  const RATE = 22050;
  const s = new Float32Array(SONG_SEC * RATE);
  const beat = 60 / BPM;
  const level = (t: number) => (t < 8 ? 0.25 : t < 16 ? 0.5 : t < 24 ? 1 : 0.25);
  for (let b = 0; b * beat < SONG_SEC; b++) {
    const t0 = b * beat;
    const accent = b % 4 === 0 ? 1 : 0.55;
    for (let i = 0; i < 0.12 * RATE; i++) {
      const k = Math.floor(t0 * RATE) + i;
      if (k >= s.length) break;
      const t = i / RATE;
      s[k] = s[k]! + 0.7 * accent * level(t0) * Math.exp(-t * 30) * Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-t * 40)) * t);
    }
  }
  for (let k = 0; k < s.length; k++) {
    const t = k / RATE;
    const chord = [220, 277.18, 329.63].reduce((a, f) => a + Math.sin(2 * Math.PI * f * t), 0) / 3;
    s[k] = s[k]! + 0.12 * level(t) * chord + 0.1 * level(t) * Math.sin(2 * Math.PI * 55 * t) * (0.5 + 0.5 * Math.cos((2 * Math.PI * t) / beat));
  }
  const words: { text: string; start: number; end: number }[] = [];
  for (const l of LINES) {
    let t = l.start;
    for (const w of l.text.split(' ')) {
      const len = 0.22 + 0.04 * w.length;
      words.push({ text: w, start: +t.toFixed(3), end: +(t + len).toFixed(3) });
      for (let k = Math.floor(t * RATE); k < Math.floor((t + len) * RATE); k++) s[k] = s[k]! + 0.25 * Math.sin((Math.PI * (k / RATE - t)) / len) * Math.sin(2 * Math.PI * 330 * (k / RATE));
      t += len + 0.08;
    }
  }
  const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const pcm = new Int16Array(s.length);
  for (let k = 0; k < s.length; k++) pcm[k] = Math.round((s[k]! / peak) * 0.9 * 32767);
  const data = Buffer.from(pcm.buffer);
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
  return words;
}

function chromePath(): string | undefined {
  const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return candidates.find((p) => p && existsSync(p));
}

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
  // In production the browser reads media through V4 signed URLs. The emulator's stand-in URLs carry no token,
  // so owner-only storage rules refuse them; this shim fetches them as the emulator admin (like a signed URL).
  await page.route(/127\.0\.0\.1:9199\/v0\/b\/.+\?alt=media/, async (route) => {
    const res = await fetch(route.request().url(), { headers: { Authorization: 'Bearer owner' } });
    await route.fulfill({ status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'access-control-allow-origin': '*' }, body: Buffer.from(await res.arrayBuffer()) });
  });
});
afterEach(async (ctx) => {
  // A failed step leaves a screenshot of the page next to the test's work files.
  if (ctx.task.result?.state === 'fail') await page?.screenshot({ path: path.join(work, `${ctx.task.name.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true }).catch(() => undefined);
});
afterAll(async () => {
  console.log(`e2e work files: ${work}`);
  await browser?.close();
});

describe('Music Video Lite in a real browser', () => {
  let videoId = '';
  let songId = '';
  const stage = (name: RegExp) => page.getByRole('navigation', { name: 'Music video workflow' }).getByRole('button', { name });

  it('creates a video from the studio list and adds the song', async () => {
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
    await page.goto(`${BASE}/mvlite`);
    await page.getByRole('button', { name: 'New video' }).first().click();
    await page.locator('#mvlite-title').fill('E2E music video');
    await page.getByRole('radio', { name: /Performance/ }).click();
    await page.getByRole('button', { name: 'Create video' }).click();
    await page.waitForURL(/\/mvlite\/[^/]+\/song/);
    videoId = new URL(page.url()).pathname.split('/')[2]!;
    const file = path.join(work, 'song.wav');
    songWav(file);
    await page.getByRole('button', { name: 'Upload or choose song' }).click();
    await page.getByRole('dialog').locator('input[type=file]').first().setInputFiles(file);
    // The picker hands over only processed media: wait until the upload is measured and ready.
    await until(async () => (await adminList('assets')).some((x) => x.data.projectId === videoId && x.data.kind === 'audio' && x.data.status === 'ready'), 'song processed', 360_000);
    await page.getByRole('dialog').getByRole('button', { name: 'Use selection' }).click();
    const p = await until(async () => {
      const d = await adminGet(`projects/${videoId}`);
      return d?.mvlite?.song?.songId ? d : null;
    }, 'song chosen');
    expect(p.type).toBe('mv_lite');
    songId = p.mvlite.song.songId;
  });

  it('detects beats and sections in the browser and takes the synchronised lyrics', async () => {
    const song = await until(async () => {
      const s = await adminGet(`projects/${videoId}/songs/${songId}`);
      return s?.durationSec > 30 ? s : null;
    }, 'song measured', 180_000);
    expect(song.audioAssetId).toBeTruthy();
    await page.getByRole('button', { name: 'Detect beats & sections' }).click();
    const analysed = await until(async () => {
      const s = await adminGet(`projects/${videoId}/songs/${songId}`);
      return s?.analysis?.downbeats?.length ? s : null;
    }, 'beats detected', 120_000);
    expect(Math.abs(analysed.analysis.bpm - BPM)).toBeLessThan(3);
    // Stand-in for the lyric synchronisation provider: the sheet lyrics.align writes for this audio.
    const words = songWav(path.join(work, 'again.wav'));
    let w = 0;
    const lines = LINES.map((l, i) => {
      const ws = l.text.split(' ').map(() => words[w++]!);
      return { id: `l${i}`, text: l.text, sectionId: i < 2 ? 'v' : 'c', start: ws[0]!.start, end: ws[ws.length - 1]!.end, words: ws.map((x) => ({ text: x.text, start: x.start, end: x.end, confidence: 0.95, flag: 'aligned' })), confidence: 0.95, flags: [] };
    });
    await adminPatch(`projects/${videoId}/songs/${songId}`, {
      lyricsSheet: { version: 1, source: 'uploaded', status: 'approved', approvedAt: Date.now(), language: 'en', languageName: 'English', requiresLanguageVerification: false, languageVerifiedAt: null, instrumental: false, sections: [{ id: 'v', label: 'verse', name: 'Verse' }, { id: 'c', label: 'chorus', name: 'Chorus' }], lines, timing: { status: 'aligned', method: 'e2e stand-in: synthetic song, word times known', audioAssetId: song.audioAssetId, alignedAt: Date.now(), lowConfidenceLineIds: [], unalignedLineIds: [], adjustments: 0, notes: [] }, updatedAt: Date.now() },
    });
    await page.getByText('4/4 lines timed').first().waitFor();
  });

  it('plans the shots from the song, prices the images and places uploaded stills', async () => {
    await stage(/Shots/).click();
    await page.getByRole('button', { name: 'From the song (no AI)' }).click();
    const spec = await until(async () => {
      const m = (await adminGet(`projects/${videoId}`))?.mvlite;
      return m?.sections?.length ? m : null;
    }, 'sections planned');
    const shotCount = (spec.sections as { shots: unknown[] }[]).reduce((a, s) => a + s.shots.length, 0);
    expect(shotCount).toBeGreaterThanOrEqual(spec.sections.length);
    // The server plans and prices the images; nothing starts until it is confirmed.
    await page.getByRole('button', { name: /Review & generate/ }).click();
    await page.getByText('Review before generating images').waitFor({ timeout: 60_000 });
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    expect((await adminList('jobs')).filter((j) => j.data.projectId === videoId && j.data.type === 'image.generate')).toHaveLength(0);
    const files = Array.from({ length: shotCount }, (_, i) => {
      const f = path.join(work, `still${i}.png`);
      execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=2752x1536:d=1,hue=h=${(i * 47) % 360}`, '-frames:v', '1', f]);
      return f;
    });
    await page.locator('input[type=file][multiple][accept*="image"]').setInputFiles(files);
    await until(async () => {
      const s = (await adminGet(`projects/${videoId}`))?.mvlite?.sections;
      return s?.every((x: { shots: { image: { approvedAssetId: string | null } }[] }) => x.shots.every((sh) => sh.image.approvedAssetId)) ? s : null;
    }, 'images approved', 180_000);
  });

  it('cuts on the bar lines, captions the lyrics and saves the composition', async () => {
    await stage(/Edit/).click();
    await page.getByRole('img', { name: 'Film preview' }).waitFor();
    const timelines = await until(async () => {
      const l = await adminList(`projects/${videoId}/timelines`);
      return l.length ? l : null;
    }, 'composition saved');
    const clips = timelines[0]!.data.clips as { trackId: string; kind: string; start: number; motion?: unknown; songId?: string; karaoke?: unknown[]; lyric?: unknown }[];
    const pictures = clips.filter((c) => c.kind === 'image' && c.motion);
    expect(pictures.length).toBeGreaterThanOrEqual(4);
    const bar = (60 / BPM) * 4;
    for (const c of pictures) expect(Math.abs(c.start / bar - Math.round(c.start / bar)) * bar).toBeLessThan(0.15);
    expect(clips.filter((c) => c.kind === 'audio' && c.songId === songId)).toHaveLength(1);
    const lyrics = clips.filter((c) => c.lyric);
    expect(lyrics).toHaveLength(4);
    expect(lyrics.every((c) => c.karaoke?.length)).toBe(true);
    expect(timelines[0]!.data.beatGrid?.beats?.length).toBeGreaterThan(40);
  });

  it('renders a draft with the real renderer, then reopens and duplicates the video', async () => {
    await stage(/Export/).click();
    // Report the checks when something blocks the export (the message names the problem).
    const checks = page.getByRole('heading', { name: 'Checks before export' }).locator('xpath=ancestor::section[1]');
    await checks.waitFor();
    await until(async () => ((await checks.innerText()).includes('No blocking problems for 16:9.') ? true : null), 'no blocking problems', 30_000).catch(async (e) => {
      throw new Error(`${(e as Error).message}
${await checks.innerText()}`);
    });
    await page.getByRole('button', { name: 'Render draft preview' }).click();
    const render = await until(async () => (await adminList('renders')).find((r) => r.data.projectId === videoId && ['completed', 'failed'].includes(r.data.status)), 'draft render', 600_000);
    expect(render.data.status, render.data.error?.message).toBe('completed');
    const asset = await adminGet(`assets/${render.data.outputAssetId}`);
    expect(asset.kind).toBe('video');
    expect(Math.abs(asset.durationSec - (SONG_SEC + 1.5))).toBeLessThan(0.3);
    await page.reload();
    await page.getByText('Saved exports').waitFor();
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await page.waitForURL((u) => !u.pathname.includes(videoId));
    const copyId = new URL(page.url()).pathname.split('/')[2]!;
    const copy = await until(async () => {
      const d = await adminGet(`projects/${copyId}`);
      return d?.mvlite?.song?.songId ? d : null;
    }, 'copy saved');
    expect(copy.mvlite.importedFrom.projectId).toBe(videoId);
    expect((await adminGet(`projects/${copyId}/songs/${copy.mvlite.song.songId}`))?.lyricsSheet?.lines?.length).toBe(4);
    expect(pageErrors).toEqual([]);
  });
});
