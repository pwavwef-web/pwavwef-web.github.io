import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { addDoc, collection, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { getBytes, ref, uploadBytes } from 'firebase/storage';

/**
 * Public beta (members) and the recording booth: deny-by-default. Members, invitations, feedback and members' audio are
 * reached only through the member callable and the owner-only API, so no client — a member, a stranger or the owner —
 * reads or writes them directly. Booth state is owner-readable and API-written like the other typed project collections.
 */

const OWNER = 'owner-test-uid';
const MEMBER = 'member-uid';
const BUCKET = 'gs://az-studio-media-az-learner';
const root = path.resolve(import.meta.dirname, '..');
let env: RulesTestEnvironment;

const owner = () => env.authenticatedContext(OWNER, { email: 'owner@test.dev', email_verified: true });
const member = () => env.authenticatedContext(MEMBER, { email: 'ama@example.com', email_verified: true });
const stranger = () => env.authenticatedContext('stranger-uid', { email: 'x@example.com', email_verified: true });
const anon = () => env.unauthenticatedContext();

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
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `members/${MEMBER}`), { uid: MEMBER, email: 'ama@example.com', status: 'active', credits: { balance: 300, granted: 300, spent: 0, reserved: 0 } });
    await setDoc(doc(db, `members/${MEMBER}/editions/e1`), { title: 'Mine', text: 'Private text', status: 'ready' });
    await setDoc(doc(db, `members/${MEMBER}/ledger/invite-grant`), { kind: 'grant', credits: 300 });
    await setDoc(doc(db, 'invites/abc'), { code: 'ABCD-EFGH-JKMN', email: 'ama@example.com', status: 'open' });
    await setDoc(doc(db, 'betaFeedback/f1'), { uid: MEMBER, message: 'Nice' });
    await setDoc(doc(db, 'runtime/features'), { beta: { enabled: true } });
    await setDoc(doc(db, 'projects/p1'), { ownerUid: OWNER, title: 'Film', type: 'film_lite', status: 'active' });
    await setDoc(doc(db, 'projects/p1/boothScenes/s1'), { ownerUid: OWNER, sceneId: 's1', lines: [], takes: [], picks: {} });
  });
});

describe('Firestore rules — public beta', () => {
  it('lets no member read or write their own records directly (only the member callable does)', async () => {
    const db = member().firestore();
    await assertFails(getDoc(doc(db, `members/${MEMBER}`)));
    await assertFails(getDoc(doc(db, `members/${MEMBER}/editions/e1`)));
    await assertFails(getDocs(collection(db, `members/${MEMBER}/editions`)));
    await assertFails(getDoc(doc(db, `members/${MEMBER}/ledger/invite-grant`)));
    await assertFails(updateDoc(doc(db, `members/${MEMBER}`), { 'credits.balance': 1_000_000 }));
    await assertFails(setDoc(doc(db, `members/${MEMBER}/ledger/free`), { kind: 'grant', credits: 1000 }));
    await assertFails(setDoc(doc(db, `members/${MEMBER}/editions/e2`), { title: 'x' }));
  });

  it('keeps invitations, feedback and the feature flag away from every client', async () => {
    for (const ctx of [member(), stranger(), anon(), owner()]) {
      const db = ctx.firestore();
      await assertFails(getDoc(doc(db, 'invites/abc')));
      await assertFails(getDocs(collection(db, 'invites')));
      await assertFails(updateDoc(doc(db, 'invites/abc'), { status: 'redeemed' }));
      await assertFails(setDoc(doc(db, 'invites/new'), { email: 'me@example.com', status: 'open' }));
      await assertFails(getDoc(doc(db, 'betaFeedback/f1')));
      await assertFails(addDoc(collection(db, 'betaFeedback'), { message: 'spam' }));
      await assertFails(getDoc(doc(db, 'runtime/features')));
      await assertFails(setDoc(doc(db, 'runtime/features'), { beta: { enabled: true } }));
    }
  });

  it('gives a member nothing of the owner studio, and no one else a member’s data', async () => {
    const m = member().firestore();
    await assertFails(getDoc(doc(m, 'projects/p1')));
    await assertFails(getDoc(doc(m, 'narratorEditions/any')));
    await assertFails(getDoc(doc(m, `users/${MEMBER}`)));
    await assertFails(getDoc(doc(m, 'earlyAccess/any')));
    for (const ctx of [stranger(), anon(), owner()]) {
      await assertFails(getDoc(doc(ctx.firestore(), `members/${MEMBER}/editions/e1`)));
      await assertFails(getDocs(collection(ctx.firestore(), 'members')));
    }
  });

  it('lets the owner read booth state but not write it (the API does)', async () => {
    const db = owner().firestore();
    await assertSucceeds(getDoc(doc(db, 'projects/p1/boothScenes/s1')));
    await assertFails(setDoc(doc(db, 'projects/p1/boothScenes/s1'), { picks: { l1: 't1' } }));
    await assertFails(getDoc(doc(member().firestore(), 'projects/p1/boothScenes/s1')));
    await assertFails(getDoc(doc(stranger().firestore(), 'projects/p1/boothScenes/s1')));
  });
});

describe('Storage rules — public beta', () => {
  it('serves members’ audio to no client directly', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(BUCKET), `members/${MEMBER}/editions/e1/job.mp3`), new Uint8Array([73, 68, 51]), { contentType: 'audio/mpeg' });
    });
    for (const ctx of [member(), stranger(), anon(), owner()]) {
      await assertFails(getBytes(ref(ctx.storage(BUCKET), `members/${MEMBER}/editions/e1/job.mp3`)));
      await assertFails(uploadBytes(ref(ctx.storage(BUCKET), `members/${MEMBER}/editions/e1/other.mp3`), new Uint8Array([1]), { contentType: 'audio/mpeg' }));
    }
    // A member cannot use the owner's upload area either.
    await assertFails(uploadBytes(ref(member().storage(BUCKET), `users/${MEMBER}/uploads/a1/take.webm`), new Uint8Array([1]), { contentType: 'audio/webm' }));
  });
});
