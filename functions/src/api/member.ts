import { HttpsError } from 'firebase-functions/v2/https';
import {
  BETA_VOICES,
  DEFAULT_BETA_VOICE,
  DEFAULT_WORDS_PER_MINUTE,
  estimateNarration,
  inviteProblem,
  memberAllowance,
  memberSpeechText,
  memberToday,
  normalizeInviteCode,
  reserveCreditsFor,
  submissionProblems,
  utcDay,
  type BetaFeedbackDoc,
  type BetaLedgerEntry,
  type InviteDoc,
  type MemberDoc,
  type MemberEditionDoc,
  type MemberRequest,
} from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { narrationRates } from '../config/pricing';
import { SIGNED_URL_TTL_SECONDS, IS_EMULATOR } from '../config/runtime';
import { bbucket, bcol, bdb, bpath, inviteId } from '../lib/beta-store';
import { assertBetaCaller, assertMember, type BetaCaller, type Member } from '../lib/member';
import { ImportError, checkImportUrl, importArticle } from '../lib/narrator-import';
import { assertRateLimit } from '../lib/usage';
import { memberMedia, memberQueue } from '../workers/member-speak';

type Req<O extends MemberRequest['op']> = Extract<MemberRequest, { op: O }>;
type WithId<T> = T & { id: string };

/**
 * The member callable's operations (`azsMember`). Members can make audio editions from pasted text or a
 * blogs.pwavwe.com article, voice them with a prebuilt Google voice, download the MP3, see their allowance and
 * credits, and send feedback — nothing else. There is no voice creation, publishing, studio data or settings here,
 * and every query is scoped to the caller's own `members/{uid}`.
 */

const modelId = () => MODEL_REGISTRY.narration.id;

function estimateFor(ed: Pick<MemberEditionDoc, 'title' | 'text'>) {
  const speech = memberSpeechText(ed.title, ed.text);
  const est = estimateNarration([speech], narrationRates(modelId()), { wordsPerMinute: DEFAULT_WORDS_PER_MINUTE, source: 'default' });
  return { chars: speech.length, speechSec: est.speechSec, usd: est.usd, requests: est.requests, notes: est.notes };
}

const editionView = (d: WithId<MemberEditionDoc>) => ({ id: d.id, title: d.title, voice: d.voice, status: d.status, rev: d.rev, chars: d.chars, sourceUrl: d.sourceUrl, audio: d.audio ? { durationSec: d.audio.durationSec, bytes: d.audio.bytes, at: d.audio.at } : null, error: d.error, updatedAt: d.updatedAt });

async function loadEdition(uid: string, editionId: string): Promise<WithId<MemberEditionDoc>> {
  const snap = await bcol.editions(uid).doc(editionId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Edition not found.');
  return { ...(snap.data() as MemberEditionDoc), id: snap.id };
}

const busy = (s: MemberEditionDoc['status']) => s === 'queued' || s === 'speaking';

/** Only a blogs.pwavwe.com https address is kept as an edition's source link. */
function sourceLink(url: string | null): string | null {
  if (!url?.trim()) return null;
  try {
    return checkImportUrl(url).toString();
  } catch {
    return null;
  }
}

async function me(caller: BetaCaller) {
  const snap = await bcol.members().doc(caller.uid).get();
  const member = snap.exists ? (snap.data() as MemberDoc) : null;
  if (!member || member.status !== 'active') return { enabled: true, email: caller.email, emailVerified: caller.emailVerified, member: null, revoked: member?.status === 'revoked' };
  const editions = (await bcol.editions(caller.uid).get()).docs.map((d) => editionView({ ...(d.data() as MemberEditionDoc), id: d.id })).sort((a, b) => b.updatedAt - a.updatedAt);
  return { enabled: true, email: caller.email, emailVerified: caller.emailVerified, member: { wave: member.wave, joinedAt: member.joinedAt }, allowance: memberAllowance(member, caller.state.limits, Date.now()), voices: BETA_VOICES.map((v) => ({ name: v.name, character: v.character })), editions };
}

/** Single use, unexpired, bound to the invited email (verified); creates the member and grants the invitation's credits. */
async function redeem(caller: BetaCaller, p: Req<'redeem'>, isOwnerAccount: boolean) {
  await assertRateLimit(`beta-${caller.uid}`, 1, 5);
  if (isOwnerAccount) throw new HttpsError('failed-precondition', 'The studio owner uses the studio, not the beta.');
  const code = normalizeInviteCode(p.code);
  if (!code) throw new HttpsError('invalid-argument', 'That is not an invitation code (it looks like ABCD-EFGH-JKMN).');
  const invRef = bcol.invites().doc(inviteId(code));
  const memberRef = bcol.members().doc(caller.uid);
  const now = Date.now();
  return bdb.runTransaction(async (tx) => {
    const [inv, mem] = await Promise.all([tx.get(invRef), tx.get(memberRef)]);
    const existing = mem.exists ? (mem.data() as MemberDoc) : null;
    if (existing?.status === 'active') return { joined: true, already: true };
    if (existing?.status === 'revoked') throw new HttpsError('permission-denied', 'Your beta access has ended.');
    const invite = inv.exists ? (inv.data() as InviteDoc) : null;
    const problem = inviteProblem(invite, { email: caller.email, emailVerified: caller.emailVerified }, now);
    if (problem) throw new HttpsError('failed-precondition', problem);
    const member: MemberDoc = {
      uid: caller.uid,
      email: caller.email!,
      wave: invite!.wave,
      inviteId: invRef.id,
      status: 'active',
      joinedAt: now,
      revokedAt: null,
      credits: { balance: invite!.credits, granted: invite!.credits, spent: 0, reserved: 0 },
      today: { day: utcDay(now), chars: 0, seconds: 0, usd: 0 },
      totals: { chars: 0, seconds: 0, usd: 0, jobs: 0 },
      activeJob: null,
      lastSeenAt: now,
    };
    tx.set(memberRef, member);
    const grant: BetaLedgerEntry = { kind: 'grant', credits: invite!.credits, usd: null, jobId: null, note: `Invitation (${invite!.wave})`, at: now };
    tx.set(bcol.ledger(caller.uid).doc('invite-grant'), grant);
    tx.update(invRef, { status: 'redeemed', redeemedAt: now, redeemedBy: caller.uid });
    return { joined: true, already: false };
  });
}

async function editionCreate(m: Member, p: Req<'editionCreate'>) {
  await assertRateLimit(`beta-${m.uid}`, 1, 20);
  const count = (await bcol.editions(m.uid).get()).size;
  if (count >= m.state.limits.maxEditions) throw new HttpsError('resource-exhausted', `The beta keeps up to ${m.state.limits.maxEditions} editions. Delete one first.`);
  const now = Date.now();
  const ref = bcol.editions(m.uid).doc();
  const ed: MemberEditionDoc = { title: p.title || 'Untitled', text: p.text, sourceUrl: sourceLink(p.sourceUrl), voice: DEFAULT_BETA_VOICE, status: 'draft', rev: 1, chars: 0, job: null, audio: null, error: null, createdAt: now, updatedAt: now };
  ed.chars = estimateFor(ed).chars;
  await ref.set(ed);
  return { editionId: ref.id };
}

async function importUrl(m: Member, p: Req<'importUrl'>) {
  await assertRateLimit(`beta-${m.uid}`, 1, 6);
  try {
    const a = await importArticle(p.url);
    return { title: a.title, text: a.body, sourceUrl: a.url, confidence: a.confidence, notes: a.notes.slice(0, 5), words: a.words };
  } catch (e) {
    if (e instanceof ImportError) throw new HttpsError('invalid-argument', e.message);
    throw new HttpsError('unavailable', 'The page could not be read. Paste the text instead.');
  }
}

async function editionSave(m: Member, p: Req<'editionSave'>) {
  const ref = bcol.editions(m.uid).doc(p.editionId);
  return bdb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Edition not found.');
    const ed = snap.data() as MemberEditionDoc;
    if (ed.rev !== p.baseRev) throw new HttpsError('aborted', 'This edition was changed in another tab. Reload to continue.', { rev: ed.rev });
    if (busy(ed.status)) throw new HttpsError('failed-precondition', 'Wait for the voice to finish (or cancel it) before editing.');
    const next = { ...ed, ...(p.title !== undefined ? { title: p.title || 'Untitled' } : {}), ...(p.text !== undefined ? { text: p.text } : {}), ...(p.voice ? { voice: p.voice } : {}) };
    const patch = { title: next.title, text: next.text, voice: next.voice, chars: estimateFor(next).chars, rev: ed.rev + 1, status: ed.status === 'failed' ? 'draft' : ed.status, updatedAt: Date.now() };
    tx.update(ref, patch);
    return { rev: patch.rev };
  });
}

async function editionDelete(m: Member, p: Req<'editionDelete'>) {
  const ed = await loadEdition(m.uid, p.editionId);
  if (busy(ed.status)) throw new HttpsError('failed-precondition', 'Cancel the voice first.');
  await memberMedia.removePrefix(bpath.editionDir(m.uid, ed.id)).catch(() => undefined);
  await bcol.editions(m.uid).doc(ed.id).delete();
  return { ok: true };
}

async function globalUsd(day: string): Promise<number> {
  const s = await bcol.spend(day).get();
  return Number(s.get('usd') ?? 0) + Number(s.get('reservedUsd') ?? 0);
}

async function estimate(m: Member, p: Req<'estimate'>) {
  const ed = await loadEdition(m.uid, p.editionId);
  const e = estimateFor(ed);
  const now = Date.now();
  const problems = submissionProblems({ limits: m.state.limits, member: m.member, chars: e.chars, estimateSec: e.speechSec, estimateUsd: e.usd, globalUsd: await globalUsd(utcDay(now)), now });
  if (m.member.activeJob) problems.push('Another edition is being voiced. Wait for it to finish.');
  return { ...e, credits: reserveCreditsFor(e.usd, m.state.limits), problems, allowance: memberAllowance(m.member, m.state.limits, now) };
}

/**
 * Starts voicing an edition. Everything is checked again inside one transaction — allowance, credits, the per-job
 * ceiling, the global daily breaker and one job per member — and the held credits and spend are recorded there, so
 * two tabs or a double click cannot start two jobs or overspend. The job id comes from the request id (idempotent).
 */
async function synthesize(m: Member, p: Req<'synthesize'>) {
  await assertRateLimit(`beta-${m.uid}`, 1, 10);
  const jobId = `mbr-${p.requestId}`;
  const edRef = bcol.editions(m.uid).doc(p.editionId);
  const memberRef = bcol.members().doc(m.uid);
  const now = Date.now();
  const day = utcDay(now);
  const spendRef = bcol.spend(day);
  const started = await bdb.runTransaction(async (tx) => {
    const [eSnap, mSnap, sSnap] = await Promise.all([tx.get(edRef), tx.get(memberRef), tx.get(spendRef)]);
    if (!eSnap.exists) throw new HttpsError('not-found', 'Edition not found.');
    const ed = eSnap.data() as MemberEditionDoc;
    if (ed.job?.id === jobId) return false;
    if (busy(ed.status)) throw new HttpsError('failed-precondition', 'This edition is already being voiced.');
    const member = mSnap.data() as MemberDoc;
    if (member.activeJob) throw new HttpsError('failed-precondition', 'Another edition is being voiced. Wait for it to finish.');
    const e = estimateFor(ed);
    const problems = submissionProblems({ limits: m.state.limits, member, chars: e.chars, estimateSec: e.speechSec, estimateUsd: e.usd, globalUsd: Number(sSnap.get('usd') ?? 0) + Number(sSnap.get('reservedUsd') ?? 0), now });
    if (problems.length) throw new HttpsError('failed-precondition', problems.join(' '));
    const reserve = reserveCreditsFor(e.usd, m.state.limits);
    if (p.confirmedCredits < reserve) throw new HttpsError('failed-precondition', `Confirm up to ${reserve} credits to start.`, { credits: reserve });
    const today = memberToday(member, now);
    tx.set(memberRef, { credits: { ...member.credits, reserved: member.credits.reserved + reserve }, today: { ...today, chars: today.chars + e.chars, seconds: today.seconds + e.speechSec }, totals: { ...member.totals, chars: member.totals.chars + e.chars }, activeJob: { editionId: p.editionId, jobId }, lastSeenAt: now }, { merge: true });
    tx.set(spendRef, { day, reservedUsd: Number(sSnap.get('reservedUsd') ?? 0) + e.usd, usd: Number(sSnap.get('usd') ?? 0) }, { merge: true });
    const hold: BetaLedgerEntry = { kind: 'reserve', credits: -reserve, usd: e.usd, jobId, note: `Held for “${ed.title.slice(0, 60)}” (estimate $${e.usd.toFixed(4)}).`, at: now };
    tx.set(bcol.ledger(m.uid).doc(`${jobId}-reserve`), hold);
    tx.update(edRef, { status: 'queued', error: null, job: { id: jobId, reservedCredits: reserve, estimateUsd: e.usd, estimateSec: e.speechSec, spentUsd: 0, chunks: [], inflight: null, startedAt: now, cancelRequested: false }, updatedAt: now });
    return true;
  });
  if (started) await memberQueue.enqueue({ uid: m.uid, editionId: p.editionId, jobId });
  return { jobId, duplicate: !started };
}

async function cancel(m: Member, p: Req<'cancel'>) {
  const ed = await loadEdition(m.uid, p.editionId);
  if (!busy(ed.status) || !ed.job) return { status: ed.status };
  await bcol.editions(m.uid).doc(ed.id).set({ job: { ...ed.job, cancelRequested: true }, updatedAt: Date.now() }, { merge: true });
  return { status: 'cancelling' };
}

async function audioUrl(m: Member, p: Req<'audioUrl'>) {
  const ed = await loadEdition(m.uid, p.editionId);
  if (!ed.audio) throw new HttpsError('not-found', 'This edition has no audio yet.');
  const expiresAt = Date.now() + Math.min(SIGNED_URL_TTL_SECONDS, 3600) * 1000;
  if (IS_EMULATOR) return { url: `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '127.0.0.1:9199'}/v0/b/${bbucket.name}/o/${encodeURIComponent(ed.audio.path)}?alt=media`, expiresAt };
  const name = `${(ed.title || 'audio-edition').replace(/[^\w.-]+/g, '-').slice(0, 80)}.mp3`;
  const [url] = await bbucket.file(ed.audio.path).getSignedUrl({ version: 'v4', action: 'read', expires: expiresAt, ...(p.download ? { responseDisposition: `attachment; filename="${name}"` } : {}) });
  return { url, expiresAt };
}

async function feedback(m: Member, p: Req<'feedback'>) {
  await assertRateLimit(`beta-${m.uid}`, 1, 3);
  const doc: BetaFeedbackDoc = { uid: m.uid, email: m.email, message: p.message, rating: p.rating, page: p.page, at: Date.now() };
  await bcol.feedback().add(doc);
  return { ok: true };
}

/** Dispatch for `azsMember`. `isOwnerAccount` keeps the owner out of the member role. */
export async function member(auth: Parameters<typeof assertBetaCaller>[0], p: MemberRequest, isOwnerAccount: boolean): Promise<unknown> {
  if (p.op === 'me') return me(await assertBetaCaller(auth));
  if (p.op === 'redeem') return redeem(await assertBetaCaller(auth), p, isOwnerAccount);
  const m = await assertMember(auth);
  switch (p.op) {
    case 'editionCreate':
      return editionCreate(m, p);
    case 'importUrl':
      return importUrl(m, p);
    case 'editionSave':
      return editionSave(m, p);
    case 'editionGet': {
      const ed = await loadEdition(m.uid, p.editionId);
      return { ...editionView(ed), text: ed.text };
    }
    case 'editionDelete':
      return editionDelete(m, p);
    case 'estimate':
      return estimate(m, p);
    case 'synthesize':
      return synthesize(m, p);
    case 'cancel':
      return cancel(m, p);
    case 'audioUrl':
      return audioUrl(m, p);
    case 'feedback':
      return feedback(m, p);
    default: {
      const unhandled: never = p;
      throw new HttpsError('invalid-argument', `Unknown operation ${(unhandled as { op?: string }).op ?? ''}.`);
    }
  }
}
