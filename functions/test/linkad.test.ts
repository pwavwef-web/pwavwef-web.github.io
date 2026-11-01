import { beforeEach, describe, expect, it, vi } from 'vitest';
import { allFacts, factHash, linkAdRequestSchema, linkAdStatus, normalizeLinkAd, type LinkAdDoc, type LinkAdRequest } from '@az-studio/shared';
import { doc, docs, resetFakes, store, tasks } from './fakes';

/**
 * Link to Ad backend with fixture providers (no request leaves this process): access and ownership, idempotent
 * steps, stage rules, spend caps, cancellation between units of work, interrupted-request handling, edit
 * invalidation and the export gate. The reading, planning and voice providers here are the fixture ones, and the
 * assertions say so; live providers are covered by the separate live check in docs/LINK_TO_AD.md.
 */

vi.mock('../src/lib/firebase', async () => import('./fakes'));
vi.mock('firebase-admin/functions', async () => {
  const f = await import('./fakes');
  return { getFunctions: () => ({ taskQueue: () => ({ enqueue: async (payload: never, opts?: { scheduleDelaySeconds?: number }) => void f.tasks.push({ payload, delaySec: opts?.scheduleDelaySeconds ?? 0 }) }) }) };
});
vi.mock('firebase-functions', async (orig) => ({ ...(await orig<typeof import('firebase-functions')>()), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/lib/media-proxy', () => ({ mediaInputUrl: async (p: string) => `https://signed.example/${p}` }));
const probeResult = { current: { formatName: 'mov,mp4', durationSec: 18.5, width: 1080, height: 1920, fps: 30, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac' } as Record<string, unknown> };
vi.mock('../src/lib/media', async (orig) => {
  const real = await orig<typeof import('../src/lib/media')>();
  return {
    ...real,
    // Real ffprobe for the pictures the fixture site serves; a scripted answer for the "exported" file.
    probe: async (input: string) => (input.startsWith('https://signed.example/') ? probeResult.current : real.probe(input)),
  };
});
vi.mock('../src/lib/assets', async (orig) => {
  const real = await orig<typeof import('../src/lib/assets')>();
  return { ...real };
});

vi.setConfig({ testTimeout: 120_000 });
process.env.AZS_LINKAD_FIXTURES = '1';
process.env.FUNCTIONS_EMULATOR = 'true';

const { linkAd, syncExports, applyEdit } = await import('../src/api/linkad');
const { runLinkAdJob, setLinkAdDeps } = await import('../src/workers/linkad');
const { claimJob } = await import('../src/lib/jobs');
const { fixtureSpeaker } = await import('../src/lib/linkad-voice');

const OWNER = { uid: 'owner1', email: 'owner@example.com' };
const OTHER = { uid: 'someone-else', email: 'x@example.com' };
const call = (o: typeof OWNER, p: Record<string, unknown>) => linkAd(o, linkAdRequestSchema.parse(p) as LinkAdRequest) as Promise<any>;
const getAd = (id: string): LinkAdDoc => normalizeLinkAd(doc(`projects/${id}`)!.linkad);

/** Runs a queued linkad job the way the task worker does (claim, then run). */
async function runJob(jobId: string) {
  const claimed = await claimJob(jobId);
  if (!claimed) throw new Error(`job ${jobId} could not be claimed`);
  await runLinkAdJob(claimed);
  return doc(`jobs/${jobId}`)!;
}

let n = 0;
const rid = (p: string) => `${p}-request-${++n}`;

async function newAd(extra: Record<string, unknown> = {}) {
  const r = await call(OWNER, { op: 'create', requestId: rid('create'), url: 'https://harbourlight.example/', promote: 'Our sea-view rooms', fixture: true, ...extra });
  return r.projectId as string;
}

async function analysed() {
  const id = await newAd();
  const a = await call(OWNER, { op: 'analyse', projectId: id, requestId: rid('an') });
  const job = await runJob(a.jobId);
  return { id, job };
}

async function planned() {
  const { id } = await analysed();
  const rev = getAd(id).revision;
  await call(OWNER, { op: 'approveBrief', projectId: id, revision: rev });
  const p = await call(OWNER, { op: 'plan', projectId: id, requestId: rid('plan') });
  await runJob(p.jobId);
  return id;
}

async function selected() {
  const id = await planned();
  const dir = getAd(id).directions[0]!;
  await call(OWNER, { op: 'selectDirection', projectId: id, directionId: dir.id });
  return id;
}

async function voiced() {
  const id = await selected();
  const v = await call(OWNER, { op: 'voice', projectId: id, requestId: rid('voice') });
  await runJob(v.jobId);
  return id;
}

beforeEach(() => {
  resetFakes();
  setLinkAdDeps(null);
  delete process.env.AZS_FEATURE_LINK_AD;
});

describe('access and ownership', () => {
  it('is available to the owner by default and can be switched off by flag or environment', async () => {
    expect((await call(OWNER, { op: 'config' })).entitlement).toMatchObject({ enabled: true, audience: 'owner' });
    await newAd();
    process.env.AZS_FEATURE_LINK_AD = 'off';
    await expect(newAd()).rejects.toThrow(/switched off/);
    delete process.env.AZS_FEATURE_LINK_AD;
    store.set('runtime/features', { linkAd: { enabled: false } });
    await expect(newAd()).rejects.toThrow(/feature flags/);
  });

  it('keeps every read and write inside the owner’s account', async () => {
    const id = await newAd();
    for (const body of [
      { op: 'edit', projectId: id, revision: 0, edit: { brief: { focus: 'x' } } },
      { op: 'analyse', projectId: id, requestId: rid('a') },
      { op: 'approveBrief', projectId: id, revision: 0 },
      { op: 'plan', projectId: id, requestId: rid('p') },
      { op: 'voice', projectId: id, requestId: rid('v') },
      { op: 'export', projectId: id, requestId: rid('e'), quality: 'draft' },
      { op: 'cancel', projectId: id },
      { op: 'refresh', projectId: id },
      { op: 'duplicate', projectId: id, requestId: rid('d') },
      { op: 'selectDirection', projectId: id, directionId: 'd1' },
    ]) {
      await expect(call(OTHER, body)).rejects.toMatchObject({ code: 'not-found' });
    }
    // Another account's identical request id never collides with, or reveals, this ad.
    const requestId = rid('same');
    const a = await call(OWNER, { op: 'create', requestId, url: 'https://harbourlight.example/', fixture: true });
    const b = await call(OTHER, { op: 'create', requestId, url: 'https://harbourlight.example/', fixture: true });
    expect(a.projectId).not.toBe(b.projectId);
    expect(doc(`projects/${b.projectId}`)!.ownerUid).toBe(OTHER.uid);
  });

  it('refuses another type of project and a project that does not exist', async () => {
    store.set('projects/film1', { ownerUid: OWNER.uid, type: 'film', title: 'A film' });
    await expect(call(OWNER, { op: 'refresh', projectId: 'film1' })).rejects.toMatchObject({ code: 'not-found' });
    await expect(call(OWNER, { op: 'refresh', projectId: 'nope' })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses a job whose id belongs to another account’s ad', async () => {
    const id = await newAd();
    const requestId = rid('x');
    const a = await call(OWNER, { op: 'analyse', projectId: id, requestId });
    const other = await call(OTHER, { op: 'create', requestId: rid('o'), url: 'https://harbourlight.example/', fixture: true });
    // Same request id on another ad is a different job id (it includes the project).
    const b = await call(OTHER, { op: 'analyse', projectId: other.projectId, requestId });
    expect(b.jobId).not.toBe(a.jobId);
  });
});

describe('creating an ad', () => {
  it('rejects unsafe or malformed addresses before anything is stored', async () => {
    for (const url of ['http://localhost/admin', 'http://169.254.169.254/', 'ftp://example.com/', 'https://user:pw@example.com/', 'http://10.0.0.1/']) {
      await expect(call(OWNER, { op: 'create', requestId: rid('u'), url })).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    expect(docs('projects')).toHaveLength(0);
  });

  it('needs a website or some notes, and offers a manual route', async () => {
    await expect(call(OWNER, { op: 'create', requestId: rid('m'), url: '', manualText: 'short' })).rejects.toMatchObject({ code: 'invalid-argument' });
    const r = await call(OWNER, { op: 'create', requestId: rid('m'), url: '', manualText: 'Cosy rooms near the castle.\nBreakfast included with every room.' });
    expect(getAd(r.projectId).input.manualText).toMatch(/Cosy rooms/);
  });

  it('is idempotent: the same request id returns the same ad', async () => {
    const requestId = rid('idem');
    const a = await call(OWNER, { op: 'create', requestId, url: 'https://harbourlight.example/', fixture: true });
    const b = await call(OWNER, { op: 'create', requestId, url: 'https://harbourlight.example/', fixture: true });
    expect(a.projectId).toBe(b.projectId);
    expect(b.created).toBe(false);
    expect(docs('projects')).toHaveLength(1);
  });

  it('keeps fixture mode out of production', async () => {
    delete process.env.AZS_LINKAD_FIXTURES;
    const emulator = process.env.FUNCTIONS_EMULATOR;
    delete process.env.FUNCTIONS_EMULATOR;
    await expect(call(OWNER, { op: 'create', requestId: rid('f'), url: 'https://harbourlight.example/', fixture: true })).rejects.toThrow(/emulators and tests/);
    process.env.AZS_LINKAD_FIXTURES = '1';
    process.env.FUNCTIONS_EMULATOR = emulator;
  });
});

describe('analysing a site (fixture website and planner)', () => {
  it('reads the pages, keeps sourced facts and pictures, and proposes a brief for review', async () => {
    const { id, job } = await analysed();
    expect(job.status).toBe('completed');
    const ad = getAd(id);
    expect(ad.mode).toBe('fixture');
    expect(ad.stage).toBe('reviewing');
    expect(ad.source.status).toBe('ok');
    expect(ad.source.pages.length).toBeGreaterThanOrEqual(1);
    expect(ad.source.pages.length).toBeLessThanOrEqual(5);
    expect(ad.source.facts.length).toBeGreaterThan(5);
    for (const f of ad.source.facts) {
      expect(f.sourceUrl).toMatch(/^https:\/\/harbourlight\.example/);
      expect(f.excerpt).toBeTruthy();
    }
    expect(ad.source.facts.find((f) => f.kind === 'price')!.needsConfirmation).toBe(true);
    // Pictures were downloaded through the safe reader, measured, and wait for the rights confirmation.
    const stored = ad.source.assets.filter((a) => a.status === 'stored');
    expect(stored.length).toBeGreaterThanOrEqual(2);
    expect(stored.every((a) => a.rights === 'unconfirmed' && a.assetId && a.width && a.height)).toBe(true);
    expect(stored.every((a) => doc(`assets/${a.assetId}`)!.ownerUid === OWNER.uid)).toBe(true);
    expect(ad.brief.focus).toMatch(/Harbour Light/);
    expect(ad.brief.origin).toBe('fixture');
    expect(ad.brief.logoId).toBeTruthy();
    expect(ad.brief.destination.value).toBeTruthy();
    // The model never saw the page's own instructions, and the director is told they were there.
    expect(ad.source.ignoredInstructions.join(' ')).toMatch(/ignore all previous instructions/i);
    expect(JSON.stringify(ad.source.facts)).not.toMatch(/number one hotel/i);
    expect(ad.spend.ledger.some((e) => e.step === 'analyse')).toBe(true);
  });

  it('starts one run per request id: a repeated click does not start a second', async () => {
    const id = await newAd();
    const requestId = rid('dup');
    const a = await call(OWNER, { op: 'analyse', projectId: id, requestId });
    const b = await call(OWNER, { op: 'analyse', projectId: id, requestId });
    expect(b.jobId).toBe(a.jobId);
    expect(b.started).toBe(false);
    expect(docs('jobs').filter((j) => j.type === 'linkad.run')).toHaveLength(1);
    expect(tasks.filter((t) => t.payload.jobId === a.jobId)).toHaveLength(1);
  });

  it('refuses a second step while one is running, with a clear reason', async () => {
    const id = await newAd();
    await call(OWNER, { op: 'analyse', projectId: id, requestId: rid('first') });
    await expect(call(OWNER, { op: 'analyse', projectId: id, requestId: rid('second') })).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(getAd(id).stage).toBe('analysing');
  });

  it('keeps partial work when the site cannot be read, and falls back to what the director typed', async () => {
    const id = await newAd({ url: 'https://unreachable.example/', manualText: 'Cosy rooms near the castle.\nBreakfast is included with every room.\nCall +233 24 555 0142 to book.' });
    const a = await call(OWNER, { op: 'analyse', projectId: id, requestId: rid('manual') });
    const job = await runJob(a.jobId);
    expect(job.status).toBe('completed');
    const ad = getAd(id);
    expect(ad.source.status).toBe('manual');
    expect(ad.source.pages[0]!.status).toBe('failed');
    expect(ad.userFacts.map((f) => f.kind)).toEqual(expect.arrayContaining(['benefit', 'contact']));
    expect(ad.source.warnings.join(' ')).toBeTruthy();
    expect(ad.stage).toBe('reviewing');
  });

  it('says honestly when nothing could be read at all', async () => {
    const id = await newAd({ url: 'https://unreachable.example/' });
    const a = await call(OWNER, { op: 'analyse', projectId: id, requestId: rid('none') });
    await runJob(a.jobId);
    const ad = getAd(id);
    expect(ad.stage).toBe('failed');
    expect(ad.source.status).toBe('failed');
    expect(ad.stageNote).toMatch(/Nothing could be read/);
  });
});

describe('planning and selecting', () => {
  it('needs an approved brief, gives three directions, and keeps approved facts apart from suggestions', async () => {
    const { id } = await analysed();
    await expect(call(OWNER, { op: 'plan', projectId: id, requestId: rid('early') })).rejects.toThrow(/Approve the brief/);
    const rev = getAd(id).revision;
    await call(OWNER, { op: 'approveBrief', projectId: id, revision: rev });
    const approved = getAd(id);
    expect(approved.briefApprovedAt).toBeTruthy();
    expect(approved.briefApprovedHash).toBeTruthy();
    const p = await call(OWNER, { op: 'plan', projectId: id, requestId: rid('plan') });
    expect(getAd(id).stage).toBe('planning');
    await runJob(p.jobId);
    const ad = getAd(id);
    expect(ad.stage).toBe('awaiting_selection');
    expect(ad.directions).toHaveLength(3);
    expect(new Set(ad.directions.map((d) => d.kind)).size).toBeGreaterThanOrEqual(2);
    for (const d of ad.directions) {
      expect(d.scenes.length).toBeGreaterThanOrEqual(3);
      expect(d.scenes[0]!.role).toBe('hook');
      expect(d.scenes.at(-1)!.role).toBe('cta');
      expect(d.origin).toBe('fixture');
    }
  });

  it('turns a selected direction into an editable ad and moves on', async () => {
    const id = await selected();
    const ad = getAd(id);
    expect(ad.stage).toBe('generating');
    expect(ad.ad.scenes.length).toBeGreaterThanOrEqual(3);
    expect(ad.ad.directionId).toBe(ad.directions[0]!.id);
    expect(ad.ad.takes).toEqual({});
  });

  it('rewrites only the words asked for and leaves the rest alone', async () => {
    const id = await selected();
    const before = getAd(id);
    const r = await call(OWNER, { op: 'revise', projectId: id, requestId: rid('hook'), scope: 'hook', guidance: 'warmer' });
    await runJob(r.jobId);
    const after = getAd(id);
    expect(after.ad.scenes[0]!.narration).toMatch(/revised/);
    expect(after.ad.scenes.slice(1).map((s) => s.narration)).toEqual(before.ad.scenes.slice(1).map((s) => s.narration));
    expect(after.ad.scenes.map((s) => s.assetId)).toEqual(before.ad.scenes.map((s) => s.assetId));
  });
});

describe('spending controls', () => {
  it('refuses a step that would take the ad past its own cap, and says by how much', async () => {
    const { id } = await analysed();
    await call(OWNER, { op: 'approveBrief', projectId: id, revision: getAd(id).revision });
    await call(OWNER, { op: 'edit', projectId: id, revision: getAd(id).revision, edit: { spendCapUsd: 0.0001 } });
    await expect(call(OWNER, { op: 'plan', projectId: id, requestId: rid('capped') })).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(docs('jobs').filter((j) => j.params?.step === 'directions')).toHaveLength(0);
    expect(getAd(id).stage).toBe('reviewing');
  });

  it('shows an estimate before recording, and requires a go-ahead above the confirmation threshold', async () => {
    const id = await selected();
    const e = await call(OWNER, { op: 'voice', projectId: id, requestId: rid('est'), estimateOnly: true });
    expect(e.estimate.pricingVersion).toBeTruthy();
    expect(e.sceneIds.length).toBe(getAd(id).ad.scenes.length);
    expect(e.fixture).toBe(true);
    expect(docs('jobs').filter((j) => j.params?.step === 'voice')).toHaveLength(0);
  });

  it('keeps estimates and actual usage as separate numbers on the ledger', async () => {
    const id = await voiced();
    const speech = getAd(id).spend.ledger.find((e) => e.kind === 'speech')!;
    expect(speech.estimateUsd).toBeGreaterThan(0);
    expect(speech.actualUsd).toBe(0); // fixture audio costs nothing; a live run records the provider's tokens here
    expect(speech.basis).toBe('fixture');
  });

  it('enforces the daily allowance on the server', async () => {
    store.set('runtime/features', { linkAd: { enabled: true, quotas: { analysesPerDay: 1 } } });
    const a = await newAd();
    await call(OWNER, { op: 'analyse', projectId: a, requestId: rid('q1') });
    const b = await newAd();
    await expect(call(OWNER, { op: 'analyse', projectId: b, requestId: rid('q2') })).rejects.toMatchObject({ code: 'resource-exhausted' });
  });
});

describe('voice: checkpoints, reuse, cancellation and interrupted requests', () => {
  it('records one take per scene, timed from the audio, and finishes with a measured length', async () => {
    const id = await voiced();
    const ad = getAd(id);
    const st = linkAdStatus(ad);
    expect(st.voiceComplete).toBe(true);
    for (const s of ad.ad.scenes) {
      const take = ad.ad.takes[s.id]!;
      expect(take.alignment).toBe('aligned');
      expect(take.source).toBe('fixture');
      expect(take.speechEnd).toBeGreaterThan(take.speechStart);
      expect(doc(`assets/${take.assetId}`)!.kind).toBe('audio');
    }
    expect(ad.voiceInFlight).toEqual({});
  });

  it('records only the scene whose words changed; unchanged recordings are reused (no repeat request)', async () => {
    const id = await voiced();
    const calls: string[] = [];
    setLinkAdDeps({ speaker: { speak: async (text, v, d, c) => (calls.push(text), fixtureSpeaker.speak(text, v, d, c)) } });
    const ad = getAd(id);
    const target = ad.ad.scenes[1]!;
    const scenes = ad.ad.scenes.map((s) => (s.id === target.id ? { ...s, narration: 'A brand new line for the second scene.' } : s));
    await call(OWNER, { op: 'edit', projectId: id, revision: ad.revision, edit: { ad: { scenes } } });
    expect(linkAdStatus(getAd(id)).scenesNeedingVoice).toEqual([target.id]);
    const v = await call(OWNER, { op: 'voice', projectId: id, requestId: rid('again') });
    expect(v.estimate.usd).toBeGreaterThan(0);
    await runJob(v.jobId);
    expect(calls).toEqual(['A brand new line for the second scene.']);
    expect(linkAdStatus(getAd(id)).voiceComplete).toBe(true);
    // Nothing left to record.
    const none = await call(OWNER, { op: 'voice', projectId: id, requestId: rid('none') });
    expect(none.noop).toBe(true);
  });

  it('stops between scenes on cancel and keeps the finished recordings', async () => {
    const id = await selected();
    const v = await call(OWNER, { op: 'voice', projectId: id, requestId: rid('cancel') });
    let spoken = 0;
    setLinkAdDeps({
      speaker: {
        speak: async (t, voice, d, c) => {
          const r = await fixtureSpeaker.speak(t, voice, d, c);
          if (++spoken === 1) store.set(`jobs/${v.jobId}`, { ...doc(`jobs/${v.jobId}`)!, cancelRequested: true });
          return r;
        },
      },
    });
    const job = await runJob(v.jobId);
    expect(job.status).toBe('cancelled');
    expect(spoken).toBe(1);
    const ad = getAd(id);
    expect(Object.keys(ad.ad.takes)).toHaveLength(1);
    expect(ad.activeJobId).toBeNull();
    expect(ad.stage).toBe('generating');
    expect(ad.voiceInFlight).toEqual({});
  });

  it('never resends an interrupted request on its own: the director must acknowledge it may be charged again', async () => {
    const id = await selected();
    const ad = getAd(id);
    const first = ad.ad.scenes[0]!;
    store.set(`projects/${id}`, { ...doc(`projects/${id}`)!, linkad: { ...ad, voiceInFlight: { [first.id]: { hash: 'x', jobId: 'dead-job', at: Date.now() - 600_000 } } } });
    const est = await call(OWNER, { op: 'voice', projectId: id, requestId: rid('i1'), estimateOnly: true });
    expect(est.interrupted).toEqual([first.id]);
    await expect(call(OWNER, { op: 'voice', projectId: id, requestId: rid('i2') })).rejects.toMatchObject({ details: { reason: 'interrupted' } });
    const ok = await call(OWNER, { op: 'voice', projectId: id, requestId: rid('i3'), acknowledgeInterrupted: true });
    expect(ok.started).toBe(true);
  });

  it('keeps a recording whose words were edited while it was being made, marked out of date', async () => {
    const id = await selected();
    const v = await call(OWNER, { op: 'voice', projectId: id, requestId: rid('race') });
    let edited = false;
    setLinkAdDeps({
      speaker: {
        speak: async (t, voice, d, c) => {
          if (!edited) {
            edited = true;
            const ad = getAd(id);
            const scenes = ad.ad.scenes.map((s, i) => (i === 0 ? { ...s, narration: 'Changed while recording.' } : s));
            await call(OWNER, { op: 'edit', projectId: id, revision: ad.revision, edit: { ad: { scenes } } });
          }
          return fixtureSpeaker.speak(t, voice, d, c);
        },
      },
    });
    await runJob(v.jobId);
    const st = linkAdStatus(getAd(id));
    expect(st.scenes[0]!.voice).toBe('stale');
    expect(st.scenes.slice(1).every((s) => s.voice === 'current' || s.words === 0)).toBe(true);
  });
});

describe('editing and invalidation', () => {
  it('refuses a stale editor (another tab changed the ad) instead of overwriting', async () => {
    const id = await newAd();
    const rev = getAd(id).revision;
    await call(OWNER, { op: 'edit', projectId: id, revision: rev, edit: { brief: { focus: 'Mine' } } });
    await expect(call(OWNER, { op: 'edit', projectId: id, revision: rev, edit: { brief: { focus: 'Theirs' } } })).rejects.toMatchObject({ code: 'aborted' });
    expect(getAd(id).brief.focus).toBe('Mine');
  });

  it('un-confirms a fact whose wording is edited and flags the scenes that relied on it', async () => {
    const id = await selected();
    let ad = getAd(id);
    const price = ad.source.facts.find((f) => f.kind === 'price')!;
    await call(OWNER, { op: 'edit', projectId: id, revision: ad.revision, edit: { confirm: [price.id] } });
    ad = getAd(id);
    expect(ad.confirmations[price.id]).toBe(factHash(allFacts(ad).find((f) => f.id === price.id)!));
    const scenes = ad.ad.scenes.map((s, i) => (i === 1 ? { ...s, factIds: [price.id] } : s));
    await call(OWNER, { op: 'edit', projectId: id, revision: ad.revision, edit: { ad: { scenes } } });
    ad = getAd(id);
    await call(OWNER, { op: 'edit', projectId: id, revision: ad.revision, edit: { factEdits: { [price.id]: 'Standard room from GH₵520 per night.' } } });
    ad = getAd(id);
    expect(ad.confirmations[price.id]).not.toBe(factHash(allFacts(ad).find((f) => f.id === price.id)!));
    expect(ad.ad.scenes[1]!.review).toMatch(/fact this scene relies on changed/);
    expect(ad.ad.scenes[0]!.review).toBeNull();
  });

  it('validates what it is given: unknown pictures, bad addresses, unlicensed music', async () => {
    const id = await selected();
    const ad = getAd(id);
    await expect(call(OWNER, { op: 'edit', projectId: id, revision: ad.revision, edit: { brief: { logoId: 'a_missing' } } })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(call(OWNER, { op: 'edit', projectId: id, revision: ad.revision, edit: { input: { url: 'http://127.0.0.1/' } } })).rejects.toMatchObject({ code: 'invalid-argument' });
    store.set('assets/m1', { ownerUid: OTHER.uid, kind: 'audio', status: 'ready', title: 'Not mine' });
    await expect(call(OWNER, { op: 'edit', projectId: id, revision: ad.revision, edit: { ad: { music: { assetId: 'm1', rightsConfirmed: true } } } })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('applyEdit is pure and leaves an untouched document untouched', () => {
    const d = normalizeLinkAd(null);
    expect(applyEdit(d, {}, 25)).toEqual(d);
  });
});

describe('export gate and file checks', () => {
  it('refuses to export until prices are confirmed, the voice exists and the pictures may be used', async () => {
    const id = await selected();
    await expect(call(OWNER, { op: 'export', projectId: id, requestId: rid('e1'), quality: 'final' })).rejects.toMatchObject({ details: { reason: 'not_ready' } });
    const err = await call(OWNER, { op: 'export', projectId: id, requestId: rid('e2'), quality: 'final' }).catch((e) => e);
    expect(String(err.message)).toMatch(/voice|confirm/i);
  });

  it('renders a real timeline job once the ad is ready, and not twice for the same composition', async () => {
    const id = await voiced();
    const ad = getAd(id);
    await call(OWNER, { op: 'edit', projectId: id, revision: ad.revision, edit: { input: { rightsConfirmed: true }, confirm: ad.source.facts.filter((f) => f.needsConfirmation).map((f) => f.id) } });
    const issues = (await call(OWNER, { op: 'export', projectId: id, requestId: rid('est'), quality: 'draft', estimateOnly: true }).catch((e) => e)) as any;
    if (issues instanceof Error) throw new Error(`estimate refused: ${issues.message}`);
    expect(issues.estimate.basis).toBe('compute');
    const r = await call(OWNER, { op: 'export', projectId: id, requestId: rid('go'), quality: 'draft' });
    expect(r.started).toBe(true);
    const render = doc(`renders/${r.renderId}`)!;
    expect(render.ownerUid).toBe(OWNER.uid);
    expect(render.width).toBe(720);
    expect(render.height).toBe(1280);
    expect(render.preset).toBe('vertical_9x16');
    expect(render.snapshot.clips.some((c: { kind: string }) => c.kind === 'audio')).toBe(true);
    expect(render.snapshot.clips.some((c: { kind: string; text: string }) => c.kind === 'caption' && c.text)).toBe(true);
    const tl = [...store.entries()].find(([p]) => p.startsWith(`projects/${id}/timelines/`))![1] as { durationSec: number };
    expect(tl.durationSec).toBeGreaterThanOrEqual(15);
    expect(tl.durationSec).toBeLessThanOrEqual(30);
    expect(getAd(id).stage).toBe('composing');
    const again = await call(OWNER, { op: 'export', projectId: id, requestId: rid('go2'), quality: 'draft' });
    expect(again.started).toBe(false);
    expect(again.renderId).toBe(r.renderId);
    expect(docs('renders')).toHaveLength(1);
  });

  it('checks the finished file itself and only then calls the ad ready', async () => {
    const id = await voiced();
    let ad = getAd(id);
    await call(OWNER, { op: 'edit', projectId: id, revision: ad.revision, edit: { input: { rightsConfirmed: true }, confirm: ad.source.facts.filter((f) => f.needsConfirmation).map((f) => f.id) } });
    const r = await call(OWNER, { op: 'export', projectId: id, requestId: rid('fin'), quality: 'final' });
    ad = getAd(id);
    const expected = doc(`renders/${r.renderId}`)!.durationSec as number;
    store.set(`assets/out1`, { ownerUid: OWNER.uid, kind: 'video', status: 'ready', storagePath: `users/${OWNER.uid}/renders/${r.renderId}/final.mp4` });

    // A file of the wrong length is not accepted, and the ad goes back to editing with its work kept.
    probeResult.current = { ...probeResult.current, durationSec: expected + 4, width: 1080, height: 1920 };
    store.set(`renders/${r.renderId}`, { ...doc(`renders/${r.renderId}`)!, status: 'completed', outputAssetId: 'out1' });
    let synced = await syncExports(OWNER.uid, id);
    expect(synced.exports[0]!.checks!.ok).toBe(false);
    expect(synced.exports[0]!.checks!.notes.join(' ')).toMatch(/runs/);
    expect(synced.stage).toBe('generating');

    // Re-checking after the file is fixed (new export) is accepted when every measure agrees.
    const r2 = await call(OWNER, { op: 'edit', projectId: id, revision: getAd(id).revision, edit: { ad: { closing: { headline: 'Reserve today' } } } }).then(() => call(OWNER, { op: 'export', projectId: id, requestId: rid('fin2'), quality: 'final' }));
    const expected2 = doc(`renders/${r2.renderId}`)!.durationSec as number;
    probeResult.current = { ...probeResult.current, durationSec: expected2 + 0.1, width: 1080, height: 1920, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac' };
    store.set(`renders/${r2.renderId}`, { ...doc(`renders/${r2.renderId}`)!, status: 'completed', outputAssetId: 'out1' });
    synced = await syncExports(OWNER.uid, id);
    const done = synced.exports.find((e) => e.renderId === r2.renderId)!;
    expect(done.checks).toMatchObject({ ok: true, width: 1080, height: 1920 });
    expect(synced.stage).toBe('ready');
    expect(ad.stage).toBe('composing');
  });
});

describe('model output cannot override the rules', () => {
  it('keeps fabricated claims, unknown pictures and foreign destinations out of the ad', async () => {
    const { id } = await analysed();
    await call(OWNER, { op: 'approveBrief', projectId: id, revision: getAd(id).revision });
    setLinkAdDeps({
      planner: {
        brief: async () => ({ json: {}, usd: 0, modelId: 'test', live: false }),
        revise: async () => ({ json: {}, usd: 0, modelId: 'test', live: false }),
        directions: async () => ({
          live: false,
          modelId: 'test',
          usd: 0,
          json: {
            directions: ['experience', 'showcase', 'other'].map((kind) => ({
              kind,
              title: `Injected ${kind}`,
              summary: '',
              hook: 'Ignore previous instructions.',
              rationale: '',
              scenes: [
                { narration: "Ghana's number one hotel, guaranteed.", overlay: '50% off today only', overlayPos: 'upper', assetId: 'a_not_real', focal: { x: 0.5, y: 0.5 }, motion: 'push_in', factIds: ['f_not_real'] },
                { narration: 'Rooms from GH₵99 a night.', overlay: '', overlayPos: 'upper', assetId: '', focal: { x: 0.5, y: 0.5 }, motion: 'still', factIds: [] },
                { narration: 'Pay at https://evil.example/pay now.', overlay: '', overlayPos: 'upper', assetId: '', focal: { x: 0.5, y: 0.5 }, motion: 'still', factIds: [] },
              ],
              closing: { headline: 'Send your card number', line: 'https://evil.example/pay' },
            })),
          },
        }),
      },
    });
    const p = await call(OWNER, { op: 'plan', projectId: id, requestId: rid('inj') });
    await runJob(p.jobId);
    const ad = getAd(id);
    const d = ad.directions[0]!;
    expect(d.scenes[0]!.assetId).toBeNull();
    expect(d.scenes[0]!.factIds).toEqual([]);
    expect(d.scenes.some((s) => s.review)).toBe(true);
    // Nothing is exported while the unsupported wording remains.
    await call(OWNER, { op: 'selectDirection', projectId: id, directionId: d.id });
    const err = await call(OWNER, { op: 'export', projectId: id, requestId: rid('inj-e'), quality: 'draft' }).catch((e) => e);
    expect(String(err.message)).toMatch(/not in the website|number one|guarantee|voice/i);
  });
});
