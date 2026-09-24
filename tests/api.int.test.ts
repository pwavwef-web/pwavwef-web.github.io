import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ffmpegPath from 'ffmpeg-static';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDoc, initializeFirestore, onSnapshot, serverTimestamp, setDoc, type Firestore } from 'firebase/firestore';
import { connectStorageEmulator, getStorage, ref, uploadBytes } from 'firebase/storage';

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
    expect(r.result.capabilities.reasoning.modelId).toBe('gemini-3.8-flash');
    expect(r.result.capabilities.video.aspectRatios).toEqual(['16:9', '9:16']);
    expect(r.result.pricing.video.videoOutputPerM).toBe(17.5);
    expect(r.result.settings.dailyLimitUsd).toBeGreaterThan(0);
    // Quality control, lyrics and score models (music stays on the required model even when it is unavailable).
    expect(r.result.capabilities.transcription.modelId).toBe('gemini-3.5-transcribe-preview');
    expect(r.result.capabilities.transcription.wordTimestamps).toBe(true);
    expect(r.result.capabilities.speech.modelId).toBe('gemini-2.5-pro-tts');
    expect(r.result.capabilities.music.modelId).toBe('lyria-3.5');
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
    expect(first.modelId).toBe('gemini-3.8-flash');
    expect(first.estimate.basis).toBe('published_rate');
    // In the emulator the demo project has no Vertex AI access, so the worker must fail cleanly. That
    // denial is a real network round trip to Vertex AI (and its fallback model), so allow for latency.
    const done = await waitFor<{ status: string; error?: { message: string } }>(owner.db, `jobs/${jobId}`, (d) => ['completed', 'failed', 'cancelled'].includes(d.status), 100_000);
    expect(['failed', 'completed']).toContain(done.status);
    if (done.status === 'failed') expect(done.error?.message.length).toBeGreaterThan(5);
    await expect(getDoc(doc(intruder.db, 'jobs', jobId))).rejects.toMatchObject({ code: 'permission-denied' });
  }, 120_000);

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

describe('quality-controlled production', () => {
  const shotId = 'it-shot-overflow';
  const shot = {
    sceneId: null,
    sectionId: null,
    order: 1,
    number: '1A',
    title: 'Reef crossing',
    description: 'Ama and Kofi on the deck at dusk.',
    directions: {
      framing: 'Medium two-shot',
      cameraMovement: 'Slow push-in',
      lens: '35mm',
      lighting: 'Dusk',
      mood: 'Resolute',
      style: 'Naturalistic',
      performance: 'Quiet determination',
      action: '',
      dialogue: [
        { character: 'AMA', line: 'We have crossed the reef, but the journey has only begun. The tide will turn before nightfall, and we must be ready.' },
        { character: 'KOFI', line: 'Then we sail at first light. Tell the others to rest while they still can.' },
      ],
      ambientSound: 'Waves against the hull',
      avoid: '',
    },
    promptOverride: null,
    durationSec: 8,
    aspectRatio: '16:9',
    resolution: '360p',
    refs: { characterIds: [], locationIds: [], elementIds: [], assetIds: [], firstFrameAssetId: null, lastFrameAssetId: null, storyboardAssetId: null },
    lockRefs: false,
    status: 'planned',
    selectedTakeId: null,
    approvedTakeId: null,
    timing: null,
    takeCount: 0,
    notes: '',
  };
  const job = { type: 'video.generate', projectId: 'it-qc', mode: 'generate', prompt: 'Medium two-shot on a fishing boat deck at dusk. AMA and KOFI speak.', aspectRatio: '16:9', resolution: '360p', durationSec: 8, target: { kind: 'shot', id: shotId } };

  beforeAll(async () => {
    await setDoc(doc(owner.db, 'projects', 'it-qc'), { ownerUid: OWNER.uid, title: 'QC Integration', type: 'film', status: 'active', format: { aspectRatio: '16:9', fps: 24 }, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    await setDoc(doc(owner.db, 'projects', 'it-qc', 'shots', shotId), shot);
  });

  it('treats the requested duration as a preference and plans connected shots for dialogue that does not fit', async () => {
    const r = await call(owner.token, 'estimateProduction', { projectId: 'it-qc', shotId, job, options: { requestedSec: 8 } });
    expect(r.error).toBeUndefined();
    const plan = r.result.plan;
    expect(plan.requestedSec).toBe(8);
    expect(plan.requiredSec).toBeGreaterThan(10);
    expect(plan.strategy).toBe('extend_chain');
    // Text estimates before the guide audio is measured: every part fits one generation and together they cover the scene.
    expect(plan.segments.length).toBeGreaterThanOrEqual(2);
    for (const s of plan.segments) expect(s.durationSec).toBeLessThanOrEqual(10);
    expect(plan.segments.reduce((t: number, s: { durationSec: number }) => t + s.durationSec, 0)).toBeGreaterThanOrEqual(plan.requiredSec);
    expect(plan.message).toMatch(/^AZ Studio will create (two|three|four) connected shots to complete this scene\.$/);
    // Parts break only at sentence boundaries and together carry every word, in order.
    const spoken = plan.segments.flatMap((s: { units: { text: string }[] }) => s.units.map((u) => u.text)).join(' ');
    expect(spoken).toBe(shot.directions.dialogue.map((d) => d.line).join(' '));
    expect(r.result.quality).toMatchObject({ ensureCompleteDialogue: true, ensureCompleteAction: true, maxRepairAttempts: 3 });
    expect(r.result.audioMode).toBe('generated');
    expect(r.result.estimate.usd).toBeGreaterThan(0);
  });

  it('refuses production requests that do not match the shot, and hides productions from everyone else', async () => {
    const wrong = await call(owner.token, 'estimateProduction', { projectId: 'it-qc', shotId, job: { ...job, target: { kind: 'shot', id: 'another-shot' } }, options: { requestedSec: 8 } });
    expect(wrong.error?.status).toBe('INVALID_ARGUMENT');
    const missing = await call(owner.token, 'estimateProduction', { projectId: 'it-qc', shotId: 'no-such-shot', job: { ...job, target: { kind: 'shot', id: 'no-such-shot' } }, options: { requestedSec: 8 } });
    expect(missing.error?.status).toBe('NOT_FOUND');
    const foreign = await call(intruder.token, 'estimateProduction', { projectId: 'it-qc', shotId, job, options: { requestedSec: 8 } });
    expect(foreign.error?.status).toBe('PERMISSION_DENIED');
    const act = await call(owner.token, 'productionAction', { productionId: 'no-such-production', action: 'approve' });
    expect(act.error?.status).toBe('NOT_FOUND');
    const bad = await call(owner.token, 'productionAction', { productionId: 'no-such-production', action: 'approve_quietly' });
    expect(bad.error?.status).toBe('INVALID_ARGUMENT');
  });
});

/** 16-bit mono PCM WAV with a 440 Hz tone. */
function wav(seconds: number, rate = 8000): Uint8Array {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  return new Uint8Array(buf);
}

describe('uploads', () => {
  // Server-side validation reads large media with range requests (moov-at-end MP4s force seeking).
  it('validates uploaded audio and video on the server and marks them ready', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'azs-it-'));
    try {
      const mp4File = path.join(dir, 'take.mp4');
      execFileSync(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4File]);
      const storage = getStorage(owner.app, 'gs://az-studio-media-az-learner');
      connectStorageEmulator(storage, '127.0.0.1', 9199);
      const files = [
        { kind: 'audio', fileName: 'song.wav', mimeType: 'audio/wav', data: wav(2) },
        { kind: 'video', fileName: 'take.mp4', mimeType: 'video/mp4', data: new Uint8Array(readFileSync(mp4File)) },
      ];
      for (const f of files) {
        const r = await call(owner.token, 'createUpload', { kind: f.kind, fileName: f.fileName, mimeType: f.mimeType, sizeBytes: f.data.length, projectId: 'it-project' });
        expect(r.error).toBeUndefined();
        await uploadBytes(ref(storage, r.result.storagePath), f.data, { contentType: f.mimeType });
        const asset = await waitFor<{ status: string; durationSec: number | null; waveformPath: string | null; posterPath: string | null; rejection: { reason: string } | null }>(owner.db, `assets/${r.result.assetId}`, (d) => d.status === 'ready' || d.status === 'rejected', 60_000);
        expect(asset.rejection?.reason ?? null).toBeNull();
        expect(asset.status).toBe('ready');
        expect(asset.durationSec).toBeGreaterThan(1.5);
        if (f.kind === 'audio') expect(asset.waveformPath).toBeTruthy();
        else expect(asset.posterPath).toBeTruthy();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
