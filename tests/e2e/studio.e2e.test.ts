import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { WEB_PORT } from './global-setup';

const PROJECT = 'demo-az-studio';
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const AUTH = 'http://127.0.0.1:9099';
const DB = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/az-studio/documents`;
const OWNER = { uid: 'owner-test-uid', email: 'owner@test.dev', password: 'owner-password-1' };

// ---------------------------------------------------------------------------
// Emulator helpers (admin bypass for seeding server-written documents)
// ---------------------------------------------------------------------------

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

async function adminSet(path: string, data: Record<string, unknown>) {
  const res = await fetch(`${DB}/${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ fields: (fsValue(data) as { mapValue: { fields: unknown } }).mapValue.fields }) });
  if (!res.ok) throw new Error(`adminSet ${path}: ${res.status} ${await res.text()}`);
}

async function adminGet<T = Record<string, unknown>>(path: string): Promise<T | null> {
  const res = await fetch(`${DB}/${path}`, { headers: { Authorization: 'Bearer owner' } });
  if (res.status === 404) return null;
  const body = (await res.json()) as { fields?: Record<string, Record<string, unknown>> };
  return fromValue({ mapValue: { fields: body.fields ?? {} } }) as T;
}

async function adminList(path: string): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const res = await fetch(`${DB}/${path}?pageSize=100`, { headers: { Authorization: 'Bearer owner' } });
  const body = (await res.json()) as { documents?: { name: string; fields?: Record<string, Record<string, unknown>> }[] };
  return (body.documents ?? []).map((d) => ({ id: d.name.split('/').pop()!, data: fromValue({ mapValue: { fields: d.fields ?? {} } }) as Record<string, unknown> }));
}

async function until<T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function createOwner() {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId: OWNER.uid, email: OWNER.email, password: OWNER.password, emailVerified: true }),
  });
  if (!res.ok && !(await res.text()).includes('DUPLICATE')) throw new Error(`createOwner failed: ${res.status}`);
}

function chromePath(): string | undefined {
  const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return candidates.find((p) => p && existsSync(p));
}

// ---------------------------------------------------------------------------

let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

async function open(path: string) {
  await page.goto(`${BASE}${path}`);
}

async function newProject(type: RegExp, title: string, urlPart: string): Promise<string> {
  await open('/projects');
  await page.getByRole('button', { name: 'New project' }).first().click();
  await page.getByRole('radio', { name: type }).click();
  await page.locator('#np-title').fill(title);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(new RegExp(`/projects/[^/]+/${urlPart}`));
  return new URL(page.url()).pathname.split('/')[2]!;
}

beforeAll(async () => {
  await createOwner();
  const executablePath = chromePath();
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => pageErrors.push(String(e)));
});

afterAll(async () => {
  await browser?.close();
});

describe('AZ Studio in a real browser', () => {
  it('signs the owner in', async () => {
    await open('/');
    await page.locator('#email').fill(OWNER.email);
    await page.locator('#password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in with email' }).click();
    await page.getByRole('link', { name: /Projects/ }).first().waitFor();
  });

  let filmId = '';

  it('builds a film with staged workspaces: bibles, Set Bible floor plan, blocking and continuity', async () => {
    filmId = await newProject(/^Film$/, 'E2E Film', 'film');
    for (const stage of ['Develop', 'Bibles', 'Direct', 'Finish']) await page.getByRole('tab', { name: stage, exact: true }).waitFor();
    // Advanced workspaces are hidden until the project asks for them.
    await page.getByRole('tab', { name: 'Direct', exact: true }).click();
    expect(await page.getByRole('tab', { name: 'Blocking', exact: true }).count()).toBe(0);
    await page.getByRole('button', { name: 'Project settings' }).click();
    await page.getByRole('switch', { name: /advanced continuity workspaces/ }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('tab', { name: 'Blocking', exact: true }).waitFor();

    // Two characters and a location.
    await open(`/projects/${filmId}/film/characters`);
    for (const name of ['Ama', 'Kojo']) {
      await page.getByRole('button', { name: 'Add character' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name').fill(name);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
    }
    await open(`/projects/${filmId}/film/locations`);
    await page.getByRole('button', { name: 'Add location' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Market square');
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const locations = await until(async () => (await adminList(`projects/${filmId}/locations`)).filter((l) => l.data.name === 'Market square'), 'location saved');
    const locationId = locations[0]!.id;

    // Set Bible: a protected piece of furniture on the floor plan and the wall colours.
    await page.getByRole('button', { name: 'Set Bible' }).first().click();
    const setDialog = page.getByRole('dialog');
    await setDialog.getByRole('button', { name: 'Add', exact: true }).first().click();
    await setDialog.getByLabel('Wall colours').fill('ochre lime plaster');
    await setDialog.getByRole('button', { name: 'Save', exact: true }).click();
    const bible = await until(async () => {
      const d = await adminGet<{ floorPlan?: unknown[]; wallColours?: string }>(`projects/${filmId}/setBibles/${locationId}`);
      return d?.wallColours === 'ochre lime plaster' ? d : null;
    }, 'set bible saved');
    expect(bible.floorPlan).toHaveLength(1);
    await page.keyboard.press('Escape');

    // A shot, blocked with both characters.
    await open(`/projects/${filmId}/film/shots`);
    await page.getByRole('button', { name: 'Add shot' }).click();
    const shots = await until(async () => {
      const s = await adminList(`projects/${filmId}/shots`);
      return s.length ? s : null;
    }, 'shot added');
    await open(`/projects/${filmId}/film/blocking`);
    await page.getByRole('button', { name: /Untitled shot|New shot|not blocked/ }).first().click();
    const addChar = page.getByLabel('Add a character');
    await addChar.selectOption({ label: 'Ama' });
    await addChar.selectOption({ label: 'Kojo' });
    await page.getByRole('button', { name: 'Save blocking' }).click();
    const plan = await until(async () => {
      const d = await adminGet<{ entities?: { label: string }[] }>(`projects/${filmId}/blockingPlans/${shots[0]!.id}`);
      return d?.entities?.length === 2 ? d : null;
    }, 'blocking saved');
    expect(plan.entities!.map((e) => e.label).sort()).toEqual(['Ama', 'Kojo']);
    await page.getByText('Camera view (schematic)').waitFor();

    // Continuity overview lists the planned shot.
    await open(`/projects/${filmId}/film/continuity`);
    await page.getByRole('button', { name: 'Plan all unapproved shots' }).waitFor();
    await page.getByRole('radio', { name: 'Coverage' }).click();
    await page.getByRole('button', { name: 'Suggest coverage' }).waitFor();
  });

  it('drafts closing credits from the project and saves them', async () => {
    await open(`/projects/${filmId}/film/credits`);
    await page.getByRole('button', { name: 'Closing credits' }).click();
    await page.getByRole('img', { name: 'Credits preview' }).waitFor();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const seqs = await until(async () => {
      const s = await adminList(`projects/${filmId}/creditSequences`);
      return s.length ? s : null;
    }, 'credits saved');
    expect(seqs[0]!.data.kind).toBe('closing');
    expect((seqs[0]!.data.sections as unknown[]).length).toBeGreaterThan(1);
  });

  it('blocks export of a render with open errors until the director overrides with a note', async () => {
    const renderId = 'e2e-render';
    const now = new Date();
    await adminSet(`renders/${renderId}`, { ownerUid: OWNER.uid, projectId: filmId, timelineId: 'tl', timelineVersion: 1, preset: 'youtube_16x9', quality: 'final', inspect: true, width: 1920, height: 1080, fps: 24, durationSec: 12, status: 'completed', stage: 'Done', progress: 1, jobId: 'j', executionName: null, outputAssetId: null, error: null, finalInspection: { id: renderId, status: 'completed', readiness: 'blocked', score: 55, errors: 1, warnings: 0 }, createdAt: now, updatedAt: now });
    await adminSet(`projects/${filmId}/finalInspections/${renderId}`, { projectId: filmId, timelineId: 'tl', timelineVersion: 1, renderId, renderAssetId: null, jobId: 'j', status: 'completed', findings: [{ id: 'f1', check: 'black_frames', severity: 'error', startSec: 3, endSec: 4.5, message: 'Black frames for 1.5 s', clipIds: [], source: 'measured', fix: null, manual: true }], score: 55, errors: 1, warnings: 0, readiness: 'blocked', override: null, measurements: {}, summary: 'One black gap.', createdAt: now, updatedAt: now });
    await open(`/projects/${filmId}/film/final`);
    await page.getByText('Export blocked · 1 error').first().waitFor();
    await page.getByText('Black frames for 1.5 s').waitFor();
    await page.getByLabel('Override note').fill('Intentional fade to black before the title');
    await page.getByRole('button', { name: 'Override and allow export' }).click();
    await page.getByText('Export by override').first().waitFor();
    const r = await until(async () => {
      const d = await adminGet<{ finalInspection?: { readiness?: string } }>(`renders/${renderId}`);
      return d?.finalInspection?.readiness === 'overridden' ? d : null;
    }, 'override recorded');
    expect(r.finalInspection!.readiness).toBe('overridden');
    const events = await adminList(`projects/${filmId}/finalInspections/${renderId}/events`);
    expect(events.some((e) => e.data.action === 'override' && String(e.data.note).includes('Intentional'))).toBe(true);
  });

  it('starts a Music Studio piece and saves its brief', async () => {
    const musicId = await newProject(/Music Studio/, 'E2E Music', 'studio');
    await page.getByRole('button', { name: 'New piece' }).first().click();
    await page.getByRole('button', { name: /Complete song/ }).waitFor();
    await page.getByLabel('Title').first().fill('River of light');
    await page.getByRole('button', { name: 'Save brief' }).click();
    const pieces = await until(async () => {
      const s = (await adminList(`projects/${musicId}/musicProjects`)).filter((m) => (m.data.brief as { title?: string }).title === 'River of light');
      return s.length ? s : null;
    }, 'music brief saved');
    expect(pieces[0]!.data.mode).toBe('song');
  });

  it('styles a song’s lyrics in four aspect ratios and applies the style', async () => {
    const mv = 'e2e-mv';
    const now = new Date();
    await adminSet(`projects/${mv}`, { ownerUid: OWNER.uid, title: 'E2E Music Video', type: 'music_video', status: 'active', format: { aspectRatio: '16:9', fps: 24 }, createdAt: now, updatedAt: now });
    const words = (text: string, start: number) => text.split(' ').map((w, i) => ({ text: w, start: start + i * 0.6, end: start + i * 0.6 + 0.5, confidence: 1, flag: 'aligned' }));
    await adminSet(`projects/${mv}/songs/song1`, {
      audioAssetId: 'no-audio',
      title: 'Homecoming',
      artist: '',
      durationSec: 12,
      analysis: null,
      lyrics: null,
      ai: null,
      createdAt: now,
      updatedAt: now,
      lyricsSheet: {
        version: 1,
        source: 'manual',
        status: 'approved',
        approvedAt: null,
        language: 'en',
        languageName: 'English',
        requiresLanguageVerification: false,
        languageVerifiedAt: null,
        instrumental: false,
        sections: [{ id: 's1', label: 'chorus', name: 'Chorus' }],
        lines: [
          { id: 'l1', text: 'Carry me home tonight', sectionId: 's1', start: 1, end: 3.8, words: words('Carry me home tonight', 1), confidence: 1, flags: [] },
          { id: 'l2', text: 'Sing it loud', sectionId: 's1', start: 4.2, end: 6.4, words: words('Sing it loud', 4.2), confidence: 1, flags: [] },
        ],
        timing: { status: 'aligned', method: 'manual', audioAssetId: 'no-audio', alignedAt: 0, lowConfidenceLineIds: [], unalignedLineIds: [], adjustments: 0, notes: [] },
        updatedAt: 0,
      },
    });
    await open(`/projects/${mv}/music/lyrics`);
    for (const a of ['16:9', '9:16', '1:1', '4:5']) await page.getByRole('img', { name: `${a} lyric preview` }).first().waitFor();
    await page.getByRole('button', { name: /Line by line/ }).first().click();
    await page.getByRole('button', { name: 'Use for this song' }).click();
    const track = await until(async () => {
      const d = await adminGet<{ styleId?: string | null }>(`projects/${mv}/lyricsTracks/song1`);
      return d?.styleId ? d : null;
    }, 'style applied');
    const style = await adminGet<{ global?: { preset?: string } }>(`projects/${mv}/lyricStyles/${track.styleId}`);
    expect(style?.global?.preset).toBe('line_by_line');
  });

  it('ran without uncaught page errors', () => {
    expect(pageErrors).toEqual([]);
  });
});
