import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EARLY_ACCESS_LIMITS, EARLY_ACCESS_NOTICE_VERSION, apiRequestSchema, earlyAccessCsv, validateEarlyAccess } from '@az-studio/shared';
import { resetFakes, store } from './fakes';

vi.mock('../src/lib/firebase', async () => import('./fakes'));
const logs: unknown[][] = [];
vi.mock('firebase-functions', async (orig) => ({
  ...(await orig<typeof import('firebase-functions')>()),
  logger: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a) },
}));

const { handleEarlyAccess } = await import('../src/public/early-access');
const { _resetEarlyAccessKeyCache, listEarlyAccess, deleteEarlyAccess, setEarlyAccessPaused, pruneEarlyAccessRate, registrationId } = await import('../src/lib/early-access');
type PublicRes = import('../src/public/audio').PublicRes;

const ORIGIN = 'https://az-studio.web.app';
const T0 = Date.UTC(2026, 9, 24, 10, 0, 0);

function fakeRes() {
  const out: { status: number; headers: Record<string, string>; body?: Record<string, unknown> } = { status: 200, headers: {} };
  const res: PublicRes = {
    status(code) {
      out.status = code;
      return res;
    },
    set(k, v) {
      out.headers[k.toLowerCase()] = v;
      return res;
    },
    json(b) {
      out.body = b as Record<string, unknown>;
    },
    end() {},
    redirect() {},
  };
  return { res, out };
}

const valid = (over: Record<string, unknown> = {}) => ({ email: 'Ama@Example.com ', name: 'Ama', interest: 'music', consent: true, noticeVersion: EARLY_ACCESS_NOTICE_VERSION, website: '', ...over });

async function post(body: unknown, { origin = ORIGIN, ip = '203.0.113.7', type = 'application/json', method = 'POST', now = T0 }: { origin?: string; ip?: string; type?: string; method?: string; now?: number } = {}) {
  const { res, out } = fakeRes();
  const raw = Buffer.from(JSON.stringify(body));
  await handleEarlyAccess({ method, headers: { origin, 'content-type': type, 'fastly-client-ip': ip }, body, rawBody: raw }, res, now);
  return out;
}

const registrations = () => [...store.entries()].filter(([p]) => p.startsWith('earlyAccess/'));

beforeEach(() => {
  resetFakes();
  _resetEarlyAccessKeyCache();
  logs.length = 0;
});

describe('early-access validation (shared by the form and the endpoint)', () => {
  it('normalises the address and keeps only the expected fields', () => {
    const r = validateEarlyAccess(valid({ name: '  Ama \n Mensah ', extra: 'x' } as never));
    expect(r).toEqual({ ok: true, value: { email: 'ama@example.com', name: 'Ama Mensah', interest: 'music', noticeVersion: EARLY_ACCESS_NOTICE_VERSION } });
  });

  it('requires a valid email and explicit consent, and rejects unknown interests', () => {
    const r = validateEarlyAccess(valid({ email: 'not-an-email', consent: false, interest: 'crypto' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['consent', 'email', 'interest']);
    expect(validateEarlyAccess(valid({ consent: 'true' })).ok).toBe(false);
    expect(validateEarlyAccess(valid({ email: `${'a'.repeat(250)}@x.io` })).ok).toBe(false);
    expect(validateEarlyAccess(valid({ name: 'x'.repeat(EARLY_ACCESS_LIMITS.nameMax + 1) })).ok).toBe(false);
  });

  it('treats a filled honeypot as a bot', () => {
    const r = validateEarlyAccess(valid({ website: 'https://spam.example' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.bot).toBe(true);
  });

  it('exports spreadsheet-safe CSV', () => {
    const csv = earlyAccessCsv([{ id: 'a', email: 'x@y.io', name: '=HYPERLINK("evil")', interest: 'music', consent: { updates: true, noticeVersion: '2026-10-24', at: T0 }, createdAt: T0, lastSubmittedAt: T0, submissions: 2, source: 'website' }]);
    expect(csv.split('\r\n')[0]).toBe('email,name,interest,consented_at,notice_version,registered_at,last_submitted_at,submissions,source');
    expect(csv).toContain(`"'=HYPERLINK(""evil"")"`);
    expect(csv).toContain('Music,2026-10-24T10:00:00.000Z,2026-10-24');
  });
});

describe('POST /api/public/early-access', () => {
  it('stores a registration with consent time and notice version, and answers only once it is stored', async () => {
    const out = await post(valid());
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    expect(out.headers['cache-control']).toBe('no-store');
    const doc = store.get(`earlyAccess/${registrationId('ama@example.com')}`) as Record<string, any>;
    expect(doc).toMatchObject({ email: 'ama@example.com', name: 'Ama', interest: 'music', source: 'website', submissions: 1, consent: { updates: true, noticeVersion: EARLY_ACCESS_NOTICE_VERSION } });
    expect(typeof doc.consent.at.toMillis).toBe('function');
    expect(Object.keys(doc).sort()).toEqual(['consent', 'createdAt', 'email', 'interest', 'lastSubmittedAt', 'name', 'source', 'submissions']);
  });

  it('answers a repeated address exactly like a new one and never overwrites the first registration', async () => {
    await post(valid());
    const again = await post(valid({ name: 'Someone Else', interest: 'image', email: 'AMA@example.com' }), { ip: '198.51.100.9' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true });
    expect(registrations()).toHaveLength(1);
    const doc = registrations()[0]![1] as Record<string, unknown>;
    expect(doc).toMatchObject({ name: 'Ama', interest: 'music', submissions: 2 });
  });

  it('rejects invalid input with field messages and stores nothing', async () => {
    const out = await post(valid({ email: 'nope', consent: false }));
    expect(out.status).toBe(400);
    expect(Object.keys(out.body!.fields as object).sort()).toEqual(['consent', 'email']);
    expect(registrations()).toHaveLength(0);
  });

  it('refuses other origins, other methods, non-JSON bodies, oversized bodies and the honeypot', async () => {
    expect((await post(valid(), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(valid(), { origin: '' })).status).toBe(403);
    expect((await post(valid(), { method: 'GET' })).status).toBe(405);
    expect((await post(valid(), { type: 'text/plain' })).status).toBe(415);
    expect((await post(valid({ name: 'x'.repeat(EARLY_ACCESS_LIMITS.bodyMaxBytes) }))).status).toBe(413);
    const bot = await post(valid({ website: 'filled' }));
    expect(bot.status).toBe(400);
    expect(registrations()).toHaveLength(0);
    // Preview channels of the same site are accepted.
    expect((await post(valid(), { origin: 'https://az-studio--preview-abc123.web.app' })).status).toBe(200);
  });

  it('limits submissions per network address per hour and per day, then lets them through again', async () => {
    for (let i = 0; i < EARLY_ACCESS_LIMITS.perIpHour; i++) expect((await post(valid({ email: `p${i}@example.com` }))).status).toBe(200);
    const limited = await post(valid({ email: 'late@example.com' }));
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('3600');
    expect(registrations()).toHaveLength(EARLY_ACCESS_LIMITS.perIpHour);
    expect((await post(valid({ email: 'other-net@example.com' }), { ip: '192.0.2.1' })).status).toBe(200);
    expect((await post(valid({ email: 'late@example.com' }), { now: T0 + 3_600_000 })).status).toBe(200);
  });

  it('honours the owner pause switch and the global daily cap', async () => {
    await setEarlyAccessPaused(true);
    const paused = await post(valid());
    expect(paused.status).toBe(503);
    expect(paused.body!.error).toBe('paused');
    await setEarlyAccessPaused(false);
    store.set('runtime/earlyAccess', { day: '2026-10-24', dayCount: EARLY_ACCESS_LIMITS.globalDay });
    expect((await post(valid())).body!.error).toBe('busy');
    expect((await post(valid(), { now: T0 + 86_400_000 })).status).toBe(200);
  });

  it('never logs email or network addresses, and keeps the address only hashed', async () => {
    await post(valid());
    await post(valid({ email: 'bad' }));
    const text = JSON.stringify(logs);
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('203.0.113.7');
    const rate = [...store.entries()].filter(([p]) => p.startsWith('earlyAccessRate/'));
    expect(rate).toHaveLength(1);
    expect(JSON.stringify(rate)).not.toContain('203.0.113.7');
    expect(rate[0]![1]).toMatchObject({ hourCount: 1, dayCount: 1, expireAt: T0 + EARLY_ACCESS_LIMITS.rateRetentionHours * 3_600_000 });
    expect(await pruneEarlyAccessRate(T0 + 47 * 3_600_000)).toBe(0);
    expect(await pruneEarlyAccessRate(T0 + 49 * 3_600_000)).toBe(1);
  });
});

describe('owner administration', () => {
  it('lists, exports and deletes registrations, and validates the owner-only API payload', async () => {
    await post(valid());
    await post(valid({ email: 'kojo@example.com', name: '', interest: '' }));
    const { records, paused } = await listEarlyAccess();
    expect(paused).toBe(false);
    expect(records.map((r) => r.email).sort()).toEqual(['ama@example.com', 'kojo@example.com']);
    expect(records.find((r) => r.email === 'kojo@example.com')).toMatchObject({ name: null, interest: null, submissions: 1 });
    expect(await deleteEarlyAccess(registrationId('kojo@example.com'))).toBe(true);
    expect(await deleteEarlyAccess(registrationId('kojo@example.com'))).toBe(false);
    expect(registrations()).toHaveLength(1);
    expect(apiRequestSchema.safeParse({ action: 'earlyAccess', payload: { op: 'delete', id: '../users/x' } }).success).toBe(false);
    expect(apiRequestSchema.safeParse({ action: 'earlyAccess', payload: { op: 'list' } }).success).toBe(true);
  });

  it('is denied to clients by the Firestore rules (backend-only collections)', () => {
    const rules = readFileSync(path.resolve(import.meta.dirname, '../../firebase/firestore.rules.template'), 'utf8');
    expect(rules).toMatch(/match \/earlyAccess\/\{document=\*\*\} \{ allow read, write: if false; \}/);
    expect(rules).toMatch(/match \/earlyAccessRate\/\{document=\*\*\} \{ allow read, write: if false; \}/);
  });
});
