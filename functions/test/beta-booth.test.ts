import { beforeEach, describe, expect, it, vi } from 'vitest';
import { azStudioEmbedHtml, defaultLiteSpec, encodePcm16Wav, newScene, type BoothSceneDoc, type JobDoc, type LiteSpec } from '@az-studio/shared';
import { doc, docs, resetFakes, store } from './fakes';

vi.mock('../src/lib/firebase', async () => import('./fakes'));
vi.mock('firebase-functions', async (orig) => ({ ...(await orig<typeof import('firebase-functions')>()), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/lib/narrator-limits', async (orig) => ({ ...(await orig<typeof import('../src/lib/narrator-limits')>()), acquireRequest: async () => ({ ok: true, used: 1, limit: null }), releaseRequest: async () => undefined }));
const synthesize = vi.fn();
vi.mock('../src/lib/narrator-provider', async (orig) => ({ ...(await orig<typeof import('../src/lib/narrator-provider')>()), synthesize: (...a: unknown[]) => synthesize(...a) }));

const { member } = await import('../src/api/member');
const { beta } = await import('../src/api/beta');
const { memberMedia, memberQueue, runMemberSpeak } = await import('../src/workers/member-speak');
const { inviteId } = await import('../src/lib/beta-store');
const { boothIo, liteBooth } = await import('../src/api/lite-booth');
const { planLiteWork } = await import('../src/api/lite');
const { narrator } = await import('../src/api/narrator');
const { setImportFetcherForTests } = await import('../src/lib/narrator-import');

const owner = { uid: 'owner', email: 'o@x.co' };
const auth = (uid: string, email: string, verified = true) => ({ uid, token: { email, email_verified: verified } });
const AMA = auth('ama', 'ama@example.com');
const queued: unknown[] = [];
const files = new Map<string, Buffer>();

beforeEach(() => {
  resetFakes();
  queued.length = 0;
  files.clear();
  synthesize.mockReset();
  delete process.env.AZS_FEATURE_BETA;
  memberQueue.enqueue = async (t) => void queued.push(t);
  memberMedia.save = async (p, d) => void files.set(p, Buffer.from(d));
  memberMedia.read = async (p) => files.get(p)!;
  memberMedia.removePrefix = async () => undefined;
  memberMedia.master = async (wavs) => ({ mp3: Buffer.from(`ID3${wavs.length}`), durationSec: 12.5 });
});

const turnOn = (limits: Record<string, number> = {}) => store.set('runtime/features', { beta: { enabled: true, limits } });
const code = 'ABCD-EFGH-JKMN';
const seedInvite = (email = 'ama@example.com', over: Record<string, unknown> = {}) => store.set(`invites/${inviteId(code)}`, { code, email, earlyAccessId: null, wave: 'wave-1', credits: 300, status: 'open', createdAt: 0, expiresAt: Date.now() + 86_400_000, redeemedAt: null, redeemedBy: null, revokedAt: null, ...over });

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return `${(e as { code?: string }).code}: ${(e as Error).message}`;
  }
  return 'resolved';
}

describe('public beta: switched off by default', () => {
  it('refuses every member operation while the flag is missing, false or the env kill switch is set', async () => {
    seedInvite();
    expect(await refusal(member(AMA, { op: 'me' }, false))).toMatch(/permission-denied: The AZ Studio beta is not open/);
    expect(await refusal(member(AMA, { op: 'redeem', code }, false))).toMatch(/not open/);
    store.set('runtime/features', { beta: { enabled: false } });
    expect(await refusal(member(AMA, { op: 'editionCreate', title: 't', text: 'x', sourceUrl: null }, false))).toMatch(/not open/);
    turnOn();
    process.env.AZS_FEATURE_BETA = 'off';
    expect(await refusal(member(AMA, { op: 'me' }, false))).toMatch(/not open/);
    expect(doc(`members/ama`)).toBeUndefined();
    expect(doc(`invites/${inviteId(code)}`)!.status).toBe('open');
  });

  it('refuses callers without a sign-in, and accounts that have not redeemed an invitation', async () => {
    turnOn();
    expect(await refusal(member(null, { op: 'me' }, false))).toMatch(/unauthenticated/);
    expect(await refusal(member(AMA, { op: 'estimate', editionId: 'e1' }, false))).toMatch(/has not joined/);
  });
});

describe('public beta: invitations', () => {
  it('redeems once, only for the invited verified email, never for the owner', async () => {
    turnOn();
    seedInvite('Ama@Example.com');
    expect(await refusal(member(auth('kofi', 'kofi@example.com'), { op: 'redeem', code }, false))).toMatch(/different email/);
    expect(await refusal(member(auth('ama', 'ama@example.com', false), { op: 'redeem', code }, false))).toMatch(/verified/);
    expect(await refusal(member(AMA, { op: 'redeem', code }, true))).toMatch(/owner/);
    expect(await member(AMA, { op: 'redeem', code: 'abcd efgh jkmn' }, false)).toEqual({ joined: true, already: false });
    expect(doc('members/ama')).toMatchObject({ status: 'active', email: 'ama@example.com', credits: { balance: 300, reserved: 0 } });
    expect(doc('members/ama/ledger/invite-grant')).toMatchObject({ kind: 'grant', credits: 300 });
    expect(doc(`invites/${inviteId(code)}`)).toMatchObject({ status: 'redeemed', redeemedBy: 'ama' });
    // Single use: another account with the same email cannot use it again.
    expect(await refusal(member(auth('ama2', 'ama@example.com'), { op: 'redeem', code }, false))).toMatch(/already been used/);
  });

  it('lets the owner invite chosen early-access entries (no email is sent) and revoke', async () => {
    store.set('earlyAccess/' + 'a'.repeat(64), { email: 'ama@example.com' });
    store.set('earlyAccess/' + 'b'.repeat(64), { email: 'kofi@example.com' });
    const r = (await beta(owner, { op: 'invite', earlyAccessIds: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)], wave: 'wave-1' })) as { created: { email: string; code: string }[]; skipped: unknown[]; betaEnabled: boolean };
    expect(r.created.map((c) => c.email)).toEqual(['ama@example.com', 'kofi@example.com']);
    expect(r.created[0]!.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(r.skipped).toHaveLength(1);
    expect(r.betaEnabled).toBe(false);
    // A second invitation for the same address is skipped while the first is open.
    const again = (await beta(owner, { op: 'invite', earlyAccessIds: ['a'.repeat(64)], wave: 'wave-2' })) as { created: unknown[] };
    expect(again.created).toHaveLength(0);
    const id = inviteId(r.created[0]!.code);
    await beta(owner, { op: 'revokeInvite', inviteId: id });
    turnOn();
    expect(await refusal(member(AMA, { op: 'redeem', code: r.created[0]!.code }, false))).toMatch(/not valid/);
  });
});

describe('public beta: allowances, credits and the voice', () => {
  async function joined(limits: Record<string, number> = {}) {
    turnOn(limits);
    seedInvite();
    await member(AMA, { op: 'redeem', code }, false);
    const { editionId } = (await member(AMA, { op: 'editionCreate', title: 'A paper', text: 'One sentence here. Another sentence there.', sourceUrl: 'https://evil.example/x' }, false)) as { editionId: string };
    return editionId;
  }

  it('drops source links that are not on blogs.pwavwe.com, prices first and holds credits on submission', async () => {
    const id = await joined();
    expect(doc(`members/ama/editions/${id}`)!.sourceUrl).toBeNull();
    const est = (await member(AMA, { op: 'estimate', editionId: id }, false)) as { credits: number; problems: string[]; usd: number };
    expect(est.problems).toEqual([]);
    expect(await refusal(member(AMA, { op: 'synthesize', editionId: id, requestId: 'req-00000001', confirmedCredits: 0 }, false))).toMatch(/Confirm up to/);
    const r = (await member(AMA, { op: 'synthesize', editionId: id, requestId: 'req-00000001', confirmedCredits: est.credits }, false)) as { jobId: string; duplicate: boolean };
    expect(r).toEqual({ jobId: 'mbr-req-00000001', duplicate: false });
    expect(queued).toEqual([{ uid: 'ama', editionId: id, jobId: 'mbr-req-00000001' }]);
    expect(doc('members/ama')!.credits.reserved).toBe(est.credits);
    expect(doc('members/ama')!.activeJob).toEqual({ editionId: id, jobId: 'mbr-req-00000001' });
    // The same request again is a duplicate, not a second job; another job while one runs is refused.
    expect(((await member(AMA, { op: 'synthesize', editionId: id, requestId: 'req-00000001', confirmedCredits: est.credits }, false)) as { duplicate: boolean }).duplicate).toBe(true);
    const { editionId: other } = (await member(AMA, { op: 'editionCreate', title: 'B', text: 'More text.', sourceUrl: null }, false)) as { editionId: string };
    expect(await refusal(member(AMA, { op: 'synthesize', editionId: other, requestId: 'req-00000002', confirmedCredits: 99 }, false))).toMatch(/Another edition/);
    expect(queued).toHaveLength(1);
  });

  it('voices with a prebuilt voice, then charges the recorded cost and releases the hold', async () => {
    const id = await joined();
    const est = (await member(AMA, { op: 'estimate', editionId: id }, false)) as { credits: number };
    await member(AMA, { op: 'synthesize', editionId: id, requestId: 'req-00000003', confirmedCredits: est.credits }, false);
    synthesize.mockResolvedValue({ wav: Buffer.from(encodePcm16Wav(new Float32Array(2400).fill(0.2), 24000)), sampleRate: 24000, inputTokens: 40, outputTokens: 300, finish: 'STOP' });
    await runMemberSpeak({ uid: 'ama', editionId: id, jobId: 'mbr-req-00000003' });
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize.mock.calls[0]![0]).toMatchObject({ route: 'developer', voiceId: 'Charon' });
    const ed = doc(`members/ama/editions/${id}`)!;
    expect(ed.status).toBe('ready');
    expect(ed.audio.path).toBe(`members/ama/editions/${id}/mbr-req-00000003.mp3`);
    const m = doc('members/ama')!;
    expect(m.credits.reserved).toBe(0);
    // 40 text + 300 audio tokens at the published rate: a fraction of a cent, charged as whole credits.
    expect(m.credits.spent).toBeGreaterThanOrEqual(1);
    expect(m.credits.spent).toBeLessThan(est.credits);
    expect(m.credits.balance).toBe(300 - m.credits.spent);
    expect(m.activeJob).toBeNull();
    expect(doc('members/ama/ledger/mbr-req-00000003-settle')).toMatchObject({ kind: 'settle', credits: est.credits - m.credits.spent });
    const day = new Date(ed.job.startedAt).toISOString().slice(0, 10);
    expect(doc(`runtime/beta-spend-${day}`)!.reservedUsd).toBeCloseTo(0, 9);
    expect(doc(`runtime/beta-spend-${day}`)!.usd).toBeGreaterThan(0);
  });

  it('stops before sending when the beta is switched off mid-job, and never resends an in-flight request', async () => {
    const id = await joined();
    const est = (await member(AMA, { op: 'estimate', editionId: id }, false)) as { credits: number };
    await member(AMA, { op: 'synthesize', editionId: id, requestId: 'req-00000004', confirmedCredits: est.credits }, false);
    store.set('runtime/features', { beta: { enabled: false } });
    await runMemberSpeak({ uid: 'ama', editionId: id, jobId: 'mbr-req-00000004' });
    expect(synthesize).not.toHaveBeenCalled();
    expect(doc(`members/ama/editions/${id}`)!.status).toBe('failed');
    expect(doc('members/ama')!.credits).toMatchObject({ reserved: 0, balance: 300 });

    turnOn();
    const { editionId: e2 } = (await member(AMA, { op: 'editionCreate', title: 'C', text: 'Text to read.', sourceUrl: null }, false)) as { editionId: string };
    await member(AMA, { op: 'synthesize', editionId: e2, requestId: 'req-00000005', confirmedCredits: 999 }, false);
    // A previous delivery died while the request was in flight.
    const ed = doc(`members/ama/editions/${e2}`)!;
    store.set(`members/ama/editions/${e2}`, { ...ed, status: 'speaking', job: { ...ed.job, inflight: 0 } });
    await runMemberSpeak({ uid: 'ama', editionId: e2, jobId: 'mbr-req-00000005' });
    expect(synthesize).not.toHaveBeenCalled();
    expect(doc(`members/ama/editions/${e2}`)!.status).toBe('failed');
    expect(doc('members/ama')!.credits.spent).toBeGreaterThan(0);
  });

  it('refuses work past the daily allowance and the global breaker', async () => {
    const id = await joined({ dailyChars: 20 });
    const est = (await member(AMA, { op: 'estimate', editionId: id }, false)) as { problems: string[] };
    expect(est.problems.join(' ')).toMatch(/Today's allowance is 20 characters/);
    store.set('runtime/features', { beta: { enabled: true, limits: { globalDailyUsd: 0 } } });
    expect(await refusal(member(AMA, { op: 'synthesize', editionId: id, requestId: 'req-00000006', confirmedCredits: 999 }, false))).toMatch(/daily limit for everyone/);
  });

  it('ends access at once when the owner revokes a member', async () => {
    await joined();
    await beta(owner, { op: 'revokeMember', uid: 'ama' });
    expect(await refusal(member(AMA, { op: 'editionCreate', title: 'x', text: 'y', sourceUrl: null }, false))).toMatch(/ended/);
  });
});

describe('recording booth', () => {
  const KASEM = 'Kasem ba bɛ zʋŋa. Ba ŋʋ yɛ tʋʋnɛ ka.';
  const spec = (): LiteSpec => {
    const s = defaultLiteSpec({ language: 'xsm' });
    s.voice.mode = 'upload_scenes';
    s.scenes = [newScene({ id: 's1', title: 'Opening', narration: KASEM }, { leadInSec: 1, tailSec: 1 } as never)];
    return s;
  };
  const speech = (sec: number) => new Float32Array(24000 * sec).map((_, i) => (i > 2400 && i < 24000 * sec - 2400 ? 0.3 * Math.sin(i / 7) : 0));

  beforeEach(() => {
    store.set('projects/p1', { ownerUid: 'owner', type: 'film_lite', title: 'Film', lite: spec() });
    boothIo.decode = async () => speech(3);
    boothIo.store = async (input) => {
      store.set('assets/joined1', { ownerUid: input.uid, projectId: input.projectId, kind: 'audio', status: 'ready', storagePath: 'users/owner/derived/joined1/booth-narration.wav' });
      return 'joined1';
    };
    for (const a of ['a1', 'a2', 'a3']) store.set(`assets/${a}`, { ownerUid: 'owner', projectId: 'p1', kind: 'audio', status: 'ready', sizeBytes: 50_000, durationSec: 3, storagePath: `users/owner/uploads/${a}/t.webm` });
  });

  it('makes lines, checks takes, picks, joins and reuses the joined recording', async () => {
    const opened = (await liteBooth(owner, { op: 'open', projectId: 'p1', sceneId: 's1' })) as BoothSceneDoc;
    expect(opened.lines.map((l) => l.text)).toEqual(['Kasem ba bɛ zʋŋa.', 'Ba ŋʋ yɛ tʋʋnɛ ka.']);
    expect(opened.language).toBe('xsm');
    const [l1, l2] = opened.lines;
    const t1 = (await liteBooth(owner, { op: 'takeAdd', projectId: 'p1', sceneId: 's1', lineId: l1!.id, assetId: 'a1' })) as { take: { id: string; check: { verdict: string } } };
    expect(t1.take.check.verdict).not.toBe('redo');
    expect(await refusal(liteBooth(owner, { op: 'useForScene', projectId: 'p1', sceneId: 's1', noiseReduction: 'off', pauseSec: 0.45 }))).toMatch(/1 line\(s\) have no picked take/);
    await liteBooth(owner, { op: 'takeAdd', projectId: 'p1', sceneId: 's1', lineId: l2!.id, assetId: 'a2' });
    const t3 = (await liteBooth(owner, { op: 'takeAdd', projectId: 'p1', sceneId: 's1', lineId: l2!.id, assetId: 'a3' })) as { take: { id: string } };
    await liteBooth(owner, { op: 'pick', projectId: 'p1', sceneId: 's1', lineId: l2!.id, takeId: t3.take.id });
    expect((doc('projects/p1/boothScenes/s1') as BoothSceneDoc).picks).toEqual({ [l1!.id]: t1.take.id, [l2!.id]: t3.take.id });
    const joined = (await liteBooth(owner, { op: 'useForScene', projectId: 'p1', sceneId: 's1', noiseReduction: 'off', pauseSec: 0.5 })) as { assetId: string; durationSec: number; reused: boolean; spans: unknown[] };
    expect(joined).toMatchObject({ assetId: 'joined1', reused: false });
    expect(joined.spans).toHaveLength(2);
    expect(((await liteBooth(owner, { op: 'useForScene', projectId: 'p1', sceneId: 's1', noiseReduction: 'off', pauseSec: 0.5 })) as { reused: boolean }).reused).toBe(true);
  });

  it('refuses takes from another project or owner', async () => {
    const { lines } = (await liteBooth(owner, { op: 'open', projectId: 'p1', sceneId: 's1' })) as BoothSceneDoc;
    store.set('assets/x', { ownerUid: 'someone', projectId: 'p1', kind: 'audio', status: 'ready', sizeBytes: 1, durationSec: 1, storagePath: 'x' });
    expect(await refusal(liteBooth(owner, { op: 'takeAdd', projectId: 'p1', sceneId: 's1', lineId: lines[0]!.id, assetId: 'x' }))).toMatch(/not-found/);
  });

  it('times a booth recording as Kasem with the shared protected words; other uploads keep the film language', () => {
    const s = spec();
    s.setup.language = 'en';
    s.scenes[0]!.voiceUploadAssetId = 'joined1';
    const booth = { s1: { assetId: 'joined1', language: 'xsm' } };
    const plan = planLiteWork(s, 'Film', 'p1', [] as (JobDoc & { id: string })[], 'narration', { booth });
    const req = plan.planned[0]!.request as { mode: string; languageCode: string; vocabulary: string[] };
    expect(req.mode).toBe('align_scene');
    expect(req.languageCode).toBe('xsm');
    expect(req.vocabulary).toContain('Kasem');
    s.scenes[0]!.voiceUploadAssetId = 'some-other-upload';
    const other = planLiteWork(s, 'Film', 'p1', [], 'narration', { booth }).planned[0]!.request as { languageCode: string };
    expect(other.languageCode).toBe('en');
  });
});

describe('narrator publication health', () => {
  it('reports the live export, a newer export waiting and the post markup', async () => {
    store.set('narratorEditions/e1', { ownerUid: 'owner', title: 'A Paper', sourceUrl: 'https://blogs.pwavwe.com/2026/10/a.html', publication: { publicId: 'kOZQ0h9lETB6', status: 'published', exportId: 'x1', exportVersion: 1, revision: 1, publishedAt: 1, unpublishedAt: null }, deleted: false });
    store.set('narratorEditions/e1/exports/x1', { ownerUid: 'owner', version: 1, status: 'ready', durationSec: 60 });
    store.set('narratorEditions/e1/exports/x2', { ownerUid: 'owner', version: 2, status: 'ready', durationSec: 61 });
    store.set('narratorPublications/kOZQ0h9lETB6', { ownerUid: 'owner', editionId: 'e1', status: 'published', revision: 1, current: { revision: 1, exportId: 'x1', exportVersion: 1, articleUrl: 'https://blogs.pwavwe.com/2026/10/a.html', title: 'A Paper', publishedAt: 1 }, retired: [], history: [] });
    const old = '<div><iframe src="https://az-studio.web.app/embed/audio/kOZQ0h9lETB6" height="166"></iframe><a href="https://az-studio.web.app/embed/audio/kOZQ0h9lETB6">Listen to this paper</a></div>';
    const fetched: string[] = [];
    setImportFetcherForTests(async (u) => {
      fetched.push(u.toString());
      return { status: 200, location: null, contentType: 'text/html; charset=utf-8', body: Buffer.from(old) };
    });
    const r = (await narrator(owner, { op: 'publicationHealth', checkPosts: true })) as { rows: { exports: { waiting: string; newer: { exportId: string } }; post: { status: string; problems: { code: string }[] }; consistent: boolean; markup: string }[] };
    expect(fetched).toEqual(['https://blogs.pwavwe.com/2026/10/a.html']);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.consistent).toBe(true);
    expect(r.rows[0]!.exports).toMatchObject({ waiting: 'ready', newer: { exportId: 'x2' } });
    expect(r.rows[0]!.post.status).toBe('outdated');
    expect(r.rows[0]!.post.problems.map((p) => p.code)).toContain('fallback_old');
    expect(r.rows[0]!.markup).toBe(azStudioEmbedHtml('kOZQ0h9lETB6', 'A Paper', { theme: 'light' }));
    setImportFetcherForTests(async () => ({ status: 200, location: null, contentType: 'text/html', body: Buffer.from(r.rows[0]!.markup) }));
    const again = (await narrator(owner, { op: 'publicationHealth', checkPosts: true })) as { rows: { post: { status: string } }[] };
    expect(again.rows[0]!.post.status).toBe('current');
    // A redirect off the allowed host is refused, as in the importer.
    setImportFetcherForTests(async () => ({ status: 302, location: 'http://169.254.169.254/', contentType: '', body: Buffer.alloc(0) }));
    const blocked = (await narrator(owner, { op: 'publicationHealth', checkPosts: true })) as { rows: { post: { status: string } }[] };
    expect(['unreachable', 'unchecked']).toContain(blocked.rows[0]!.post.status);
    setImportFetcherForTests(null);
    expect(docs('narratorPublications')).toHaveLength(1);
  });
});
