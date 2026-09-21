import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { getBytes, ref, uploadBytes } from 'firebase/storage';

const OWNER = 'owner-test-uid';
const BUCKET = 'gs://az-studio-media-az-learner';
const root = path.resolve(import.meta.dirname, '..');
let env: RulesTestEnvironment;

const owner = () => env.authenticatedContext(OWNER, { email: 'owner@test.dev', email_verified: true });
const unverifiedOwner = () => env.authenticatedContext(OWNER, { email: 'owner@test.dev', email_verified: false });
const intruder = () => env.authenticatedContext('intruder-uid', { email: 'intruder@test.dev', email_verified: true });
const anon = () => env.unauthenticatedContext();

const project = (ownerUid = OWNER) => ({ ownerUid, title: 'The Last Drum', type: 'film', status: 'active', format: { aspectRatio: '16:9', fps: 24 } });

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-az-studio',
    firestore: { rules: readFileSync(path.join(root, 'firebase/generated/firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
    storage: { rules: readFileSync(path.join(root, 'firebase/generated/storage.rules'), 'utf8'), host: '127.0.0.1', port: 9199 },
  });
});
afterAll(async () => env?.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
});

describe('Firestore rules — projects', () => {
  it('lets the owner create, read and update their project', async () => {
    const db = owner().firestore();
    await assertSucceeds(setDoc(doc(db, 'projects/p1'), project()));
    await assertSucceeds(getDoc(doc(db, 'projects/p1')));
    await assertSucceeds(updateDoc(doc(db, 'projects/p1'), { title: 'Renamed', logline: 'A drummer…' }));
    await assertSucceeds(getDocs(query(collection(db, 'projects'), where('ownerUid', '==', OWNER))));
  });

  it('blocks tampering with server-managed fields and direct deletes', async () => {
    const db = owner().firestore();
    await assertSucceeds(setDoc(doc(db, 'projects/p1'), project()));
    await assertFails(updateDoc(doc(db, 'projects/p1'), { usage: { costUsd: 0, jobs: 0 } }));
    await assertFails(updateDoc(doc(db, 'projects/p1'), { type: 'music_video' }));
    await assertFails(updateDoc(doc(db, 'projects/p1'), { ownerUid: 'someone-else' }));
    await assertFails(deleteDoc(doc(db, 'projects/p1')));
    await assertFails(setDoc(doc(db, 'projects/p2'), { ...project(), usage: { costUsd: 0 } }));
    await assertFails(setDoc(doc(db, 'projects/p3'), { ...project(), title: '' }));
  });

  it('denies every other signed-in user, unverified tokens and anonymous access', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'projects/p1'), project());
      await setDoc(doc(ctx.firestore(), 'projects/p1/shots/s1'), { title: 'Shot' });
    });
    for (const ctx of [intruder(), unverifiedOwner(), anon()]) {
      const db = ctx.firestore();
      await assertFails(getDoc(doc(db, 'projects/p1')));
      await assertFails(getDoc(doc(db, 'projects/p1/shots/s1')));
      await assertFails(setDoc(doc(db, 'projects/p1/shots/s2'), { title: 'x' }));
      await assertFails(getDocs(collection(db, 'projects')));
    }
    // A non-owner cannot create projects even for their own uid.
    await assertFails(setDoc(doc(intruder().firestore(), 'projects/mine'), project('intruder-uid')));
  });

  it('requires owner-scoped queries', async () => {
    await assertFails(getDocs(collection(owner().firestore(), 'projects')));
  });
});

describe('Firestore rules — creative documents and server records', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'projects/p1'), project());
      await setDoc(doc(db, 'projects/p1/shots/s1/takes/t1'), { status: 'completed', rating: 0, notes: '', approved: false, assetId: 'a1' });
      await setDoc(doc(db, 'jobs/j1'), { ownerUid: OWNER, status: 'queued' });
      await setDoc(doc(db, 'assets/a1'), { ownerUid: OWNER, title: 'Clip', favorite: false, storagePath: 'users/x/a.mp4' });
      await setDoc(doc(db, 'runtime/owner-test-uid_slots'), { active: {} });
      await setDoc(doc(db, 'users/owner-test-uid'), { settings: { dailyLimitUsd: 25 } });
    });
  });

  it('lets the owner edit screenplay, shots and bibles', async () => {
    const db = owner().firestore();
    await assertSucceeds(addDoc(collection(db, 'projects/p1/scripts'), { title: 'Draft', content: 'INT. HOUSE - DAY' }));
    await assertSucceeds(setDoc(doc(db, 'projects/p1/shots/s1'), { title: 'Wide' }));
    await assertSucceeds(addDoc(collection(db, 'projects/p1/characters'), { name: 'Ama' }));
    await assertSucceeds(addDoc(collection(db, 'projects/p1/timelines'), { name: 'Cut 1', clips: [] }));
    await assertFails(addDoc(collection(db, 'projects/p1/aiRuns'), { output: 'forged' }));
    await assertFails(addDoc(collection(db, 'projects/p1/unknown'), { x: 1 }));
  });

  it('only allows rating / notes / approval on takes', async () => {
    const db = owner().firestore();
    await assertSucceeds(updateDoc(doc(db, 'projects/p1/shots/s1/takes/t1'), { rating: 4, notes: 'Great light' }));
    await assertFails(updateDoc(doc(db, 'projects/p1/shots/s1/takes/t1'), { assetId: 'other' }));
    await assertFails(setDoc(doc(db, 'projects/p1/shots/s1/takes/t2'), { status: 'completed' }));
  });

  it('keeps jobs, usage and runtime state server-controlled', async () => {
    const db = owner().firestore();
    await assertSucceeds(getDoc(doc(db, 'jobs/j1')));
    await assertFails(updateDoc(doc(db, 'jobs/j1'), { status: 'completed' }));
    await assertFails(setDoc(doc(db, 'jobs/j2'), { ownerUid: OWNER, status: 'queued' }));
    await assertFails(setDoc(doc(db, 'usageDaily/owner-test-uid_2026-09-21'), { ownerUid: OWNER, costUsd: 0 }));
    await assertFails(getDoc(doc(db, 'runtime/owner-test-uid_slots')));
    await assertFails(updateDoc(doc(db, 'users/owner-test-uid'), { settings: { dailyLimitUsd: 99999 } }));
    await assertSucceeds(getDoc(doc(db, 'users/owner-test-uid')));
  });

  it('limits asset edits to metadata', async () => {
    const db = owner().firestore();
    await assertSucceeds(updateDoc(doc(db, 'assets/a1'), { favorite: true, title: 'Hero clip' }));
    await assertFails(updateDoc(doc(db, 'assets/a1'), { storagePath: 'users/other/secret.mp4' }));
    await assertFails(setDoc(doc(db, 'assets/a2'), { ownerUid: OWNER, storagePath: 'x' }));
    await assertFails(getDoc(doc(intruder().firestore(), 'assets/a1')));
  });
});

describe('Storage rules', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('lets the owner upload into a reserved upload path only', async () => {
    const st = owner().storage(BUCKET);
    await assertSucceeds(uploadBytes(ref(st, `users/${OWNER}/uploads/a1/still.png`), png, { contentType: 'image/png' }));
    await assertFails(uploadBytes(ref(st, `users/${OWNER}/generated/j1/fake.png`), png, { contentType: 'image/png' }));
    await assertFails(uploadBytes(ref(st, `users/${OWNER}/uploads/a2/tool.exe`), png, { contentType: 'application/x-msdownload' }));
    await assertFails(uploadBytes(ref(st, `users/someone-else/uploads/a3/still.png`), png, { contentType: 'image/png' }));
  });

  it('denies other users and anonymous access to the owner’s media', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(BUCKET), `users/${OWNER}/generated/j1/out.png`), png, { contentType: 'image/png' });
    });
    await assertSucceeds(getBytes(ref(owner().storage(BUCKET), `users/${OWNER}/generated/j1/out.png`)));
    await assertFails(getBytes(ref(intruder().storage(BUCKET), `users/${OWNER}/generated/j1/out.png`)));
    await assertFails(getBytes(ref(anon().storage(BUCKET), `users/${OWNER}/generated/j1/out.png`)));
    await assertFails(uploadBytes(ref(intruder().storage(BUCKET), `users/intruder-uid/uploads/a1/x.png`), png, { contentType: 'image/png' }));
  });
});
