import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDoc, initializeFirestore, onSnapshot, serverTimestamp, setDoc, type Firestore } from 'firebase/firestore';

const PROJECT = 'demo-az-studio';
const AUTH = 'http://127.0.0.1:9099';
const FN = `http://127.0.0.1:5001/${PROJECT}/us-central1/azsApi`;
const OWNER = { uid: 'owner-test-uid', email: 'owner@test.dev', password: 'owner-password-1' };
const INTRUDER = { uid: 'intruder-uid', email: 'intruder@test.dev', password: 'intruder-password-1' };

interface Session {
  app: FirebaseApp;
  db: Firestore;
  token: string;
}

async function createUser(u: typeof OWNER) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId: u.uid, email: u.email, password: u.password, emailVerified: true }),
  });
  if (!res.ok && !(await res.text()).includes('DUPLICATE')) throw new Error(`createUser failed: ${res.status}`);
}

async function session(u: typeof OWNER, name: string): Promise<Session> {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'demo-key', appId: `1:1:web:${name}` }, name);
  const auth = getAuth(app);
  connectAuthEmulator(auth, AUTH, { disableWarnings: true });
  const cred = await signInWithEmailAndPassword(auth, u.email, u.password);
  const db = initializeFirestore(app, {}, 'az-studio');
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  return { app, db, token: await cred.user.getIdToken() };
}

async function call(token: string | null, action: string, payload: unknown): Promise<{ status: number; result?: any; error?: { status: string; message: string; details?: any } }> {
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ data: { action, payload } }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { status: string; message: string; details?: unknown } };
  return { status: res.status, ...body } as never;
}

function waitFor<T>(db: Firestore, path: string, pred: (d: T) => boolean, ms = 45_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out waiting for ${path}`));
    }, ms);
    const unsub = onSnapshot(doc(db, path), (s) => {
      const d = s.data() as T | undefined;
      if (d && pred(d)) {
        clearTimeout(t);
        unsub();
        resolve(d);
      }
    });
  });
}

let owner: Session;
let intruder: Session;

beforeAll(async () => {
  await createUser(OWNER);
  await createUser(INTRUDER);
  owner = await session(OWNER, 'owner');
  intruder = await session(INTRUDER, 'intruder');
});
afterAll(async () => {
  await Promise.all([owner && deleteApp(owner.app), intruder && deleteApp(intruder.app)]);
});

describe('authentication and access control', () => {
  it('rejects unauthenticated calls', async () => {
    const r = await call(null, 'bootstrap', {});
    expect(r.error?.status).toBe('UNAUTHENTICATED');
  });

  it('rejects signed-in users who are not the owner', async () => {
    const r = await call(intruder.token, 'bootstrap', {});
    expect(r.error?.status).toBe('PERMISSION_DENIED');
    const s = await call(intruder.token, 'submitJobs', { jobs: [{ type: 'text.assist', task: 'prompt.polish', input: { prompt: 'x' } }] });
    expect(s.error?.status).toBe('PERMISSION_DENIED');
  });

  it('bootstraps the owner with the server-side model registry and published pricing', async () => {
    const r = await call(owner.token, 'bootstrap', {});
    expect(r.error).toBeUndefined();
    expect(r.result.owner.uid).toBe(OWNER.uid);
    expect(r.result.capabilities.video.modelId).toBe('gemini-omni-1.1-flash-preview');
    expect(r.result.capabilities.image.modelId).toBe('gemini-3-pro-image');
    expect(r.result.capabilities.reasoning.modelId).toBe('gemini-3.1-pro-preview');
    expect(r.result.capabilities.video.aspectRatios).toEqual(['16:9', '9:16']);
    expect(r.result.pricing.video.videoOutputPerM).toBe(17.5);
    expect(r.result.settings.dailyLimitUsd).toBeGreaterThan(0);
  });

  it('rejects malformed API requests', async () => {
    const r = await call(owner.token, 'dropEverything', {});
    expect(r.error?.status).toBe('INVALID_ARGUMENT');
  });
});

describe('project creation', () => {
  it('lets the owner create a project that nobody else can read', async () => {
    await setDoc(doc(owner.db, 'projects', 'it-project'), { ownerUid: OWNER.uid, title: 'Integration Test', type: 'film', status: 'active', format: { aspectRatio: '16:9', fps: 24 }, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    const snap = await getDoc(doc(owner.db, 'projects', 'it-project'));
    expect(snap.data()?.title).toBe('Integration Test');
    await expect(getDoc(doc(intruder.db, 'projects', 'it-project'))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(setDoc(doc(intruder.db, 'projects', 'intruder-project'), { ownerUid: INTRUDER.uid, title: 'Mine', type: 'film', status: 'active', format: { aspectRatio: '16:9', fps: 24 } })).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('job submission', () => {
  it('never forwards parameters the model does not support', async () => {
    const res8k = await call(owner.token, 'estimate', { jobs: [{ type: 'video.generate', prompt: 'A drummer at dawn', resolution: '8k', durationSec: 6 }] });
    expect(res8k.error?.status).toBe('INVALID_ARGUMENT');
    expect(res8k.error?.message).toMatch(/360p, 720p, 1080p, 4k/);
    const square = await call(owner.token, 'estimate', { jobs: [{ type: 'video.generate', prompt: 'A drummer', aspectRatio: '1:1' }] });
    expect(square.error?.status).toBe('INVALID_ARGUMENT');
    const long = await call(owner.token, 'estimate', { jobs: [{ type: 'video.generate', prompt: 'A drummer', durationSec: 25 }] });
    expect(long.error?.status).toBe('INVALID_ARGUMENT');
    const img = await call(owner.token, 'estimate', { jobs: [{ type: 'image.generate', prompt: 'Poster', aspectRatio: '16:9', imageSize: '8K' }] });
    expect(img.error?.status).toBe('INVALID_ARGUMENT');
  });

  it('estimates from published rates and requires confirmation for multi-video batches', async () => {
    const job = { type: 'video.generate', prompt: 'A drummer on a Cape Coast rampart at dawn', resolution: '720p', durationSec: 5, aspectRatio: '16:9' };
    const est = await call(owner.token, 'estimate', { jobs: [job, job] });
    expect(est.error).toBeUndefined();
    // 2 × 5 s × 5792 tokens/s × $17.50 per 1M video tokens = $1.0136 before reasoning/input tokens.
    expect(est.result.estimate.usd).toBeGreaterThan(1.01);
    expect(est.result.confirmation.required).toBe(true);
    const sub = await call(owner.token, 'submitJobs', { jobs: [job, job] });
    expect(sub.error?.status).toBe('FAILED_PRECONDITION');
    expect(sub.error?.details?.reason).toBe('confirmation_required');
  });

  it('queues a durable job that survives in Firestore and reaches a terminal state', async () => {
    const r = await call(owner.token, 'submitJobs', { jobs: [{ type: 'text.assist', projectId: 'it-project', task: 'prompt.polish', input: { prompt: 'wide shot of a market', kind: 'video' } }] });
    expect(r.error).toBeUndefined();
    const jobId = r.result.jobIds[0] as string;
    const first = (await getDoc(doc(owner.db, 'jobs', jobId))).data()!;
    expect(first.ownerUid).toBe(OWNER.uid);
    expect(first.modelId).toBe('gemini-3.1-pro-preview');
    expect(first.estimate.basis).toBe('published_rate');
    // In the emulator the demo project has no Vertex AI access, so the worker must fail cleanly.
    const done = await waitFor<{ status: string; error?: { message: string } }>(owner.db, `jobs/${jobId}`, (d) => ['completed', 'failed', 'cancelled'].includes(d.status));
    expect(['failed', 'completed']).toContain(done.status);
    if (done.status === 'failed') expect(done.error?.message.length).toBeGreaterThan(5);
    await expect(getDoc(doc(intruder.db, 'jobs', jobId))).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('cancels a queued job before any paid request', async () => {
    const job = { type: 'video.generate', prompt: 'A slow push-in on a kora player', resolution: '360p', durationSec: 3 };
    const sub = await call(owner.token, 'submitJobs', { jobs: [job], confirmedUsd: 10 });
    expect(sub.error).toBeUndefined();
    const jobId = sub.result.jobIds[0] as string;
    const c = await call(owner.token, 'cancelJob', { jobId });
    expect(c.error).toBeUndefined();
    const final = await waitFor<{ status: string }>(owner.db, `jobs/${jobId}`, (d) => ['completed', 'failed', 'cancelled'].includes(d.status));
    expect(['cancelled', 'failed']).toContain(final.status);
  });

  it('enforces spending limits server-side', async () => {
    const off = await call(owner.token, 'updateSettings', { dailyLimitUsd: 0, monthlyLimitUsd: 0 });
    expect(off.error).toBeUndefined();
    const r = await call(owner.token, 'submitJobs', { jobs: [{ type: 'image.generate', prompt: 'Poster', aspectRatio: '2:3', imageSize: '1K' }] });
    expect(r.error?.status).toBe('RESOURCE_EXHAUSTED');
    const on = await call(owner.token, 'updateSettings', { dailyLimitUsd: 25, monthlyLimitUsd: 250 });
    expect(on.error).toBeUndefined();
  });

  it('rejects disallowed uploads before reserving storage', async () => {
    const r = await call(owner.token, 'createUpload', { kind: 'image', fileName: 'tool.exe', mimeType: 'application/x-msdownload', sizeBytes: 1000 });
    expect(r.error?.status).toBe('INVALID_ARGUMENT');
    const ok = await call(owner.token, 'createUpload', { kind: 'image', fileName: 'still.png', mimeType: 'image/png', sizeBytes: 1000, projectId: 'it-project' });
    expect(ok.error).toBeUndefined();
    expect(ok.result.storagePath).toMatch(/^users\/owner-test-uid\/uploads\/[\w-]+\/still\.png$/);
  });
});
