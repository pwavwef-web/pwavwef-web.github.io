import { randomInt } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import { INVITE_ALPHABET, memberToday, utcDay, type BetaAdminRequest, type BetaFeedbackDoc, type BetaLedgerEntry, type InviteDoc, type MemberDoc, type MemberEditionDoc } from '@az-studio/shared';
import { BETA_IS_SEPARATE, BETA_PROJECT } from '../config/beta';
import { bcol, bdb, betaState, inviteId } from '../lib/beta-store';
import { earlyAccessCol } from '../lib/early-access';
import type { Owner } from '../lib/owner';

type Req<O extends BetaAdminRequest['op']> = Extract<BetaAdminRequest, { op: O }>;

/**
 * Owner-only beta administration (`azsApi` action `beta`; azsApi has already checked the owner). Invitations are made
 * only for early-access entries the owner picks, and AZ Studio sends nothing: the codes are shown to the owner to pass on.
 * Switching the beta on is deliberately not an operation here — it is the `runtime/features` flag (docs/OPERATIONS.md).
 */

const DAY = 86_400_000;

export function newInviteCode(): string {
  const c = Array.from({ length: 12 }, () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]).join('');
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
}

async function overview() {
  const state = await betaState();
  const now = Date.now();
  const [invites, members, feedback, spend] = await Promise.all([bcol.invites().get(), bcol.members().get(), bcol.feedback().orderBy('at', 'desc').limit(200).get(), bcol.spend(utcDay(now)).get()]);
  const memberRows = await Promise.all(
    members.docs.map(async (d) => {
      const m = d.data() as MemberDoc;
      const eds = (await bcol.editions(d.id).get()).docs.map((e) => e.data() as MemberEditionDoc);
      return { uid: d.id, email: m.email, wave: m.wave, status: m.status, joinedAt: m.joinedAt, revokedAt: m.revokedAt, credits: m.credits, today: memberToday(m, now), totals: m.totals, activeJob: m.activeJob ?? null, editions: eds.length, ready: eds.filter((e) => e.status === 'ready').length, failed: eds.filter((e) => e.status === 'failed').length };
    }),
  );
  return {
    state: { enabled: state.enabled, reason: state.reason, limits: state.limits, project: BETA_PROJECT, separate: BETA_IS_SEPARATE },
    spendToday: { usd: Number(spend.get('usd') ?? 0), reservedUsd: Number(spend.get('reservedUsd') ?? 0), ceilingUsd: state.limits.globalDailyUsd },
    invites: invites.docs
      .map((d) => {
        const i = d.data() as InviteDoc;
        return { id: d.id, code: i.code, email: i.email, wave: i.wave, credits: i.credits, status: i.status === 'open' && i.expiresAt <= now ? ('expired' as const) : i.status, createdAt: i.createdAt, expiresAt: i.expiresAt, redeemedAt: i.redeemedAt, earlyAccessId: i.earlyAccessId };
      })
      .sort((a, b) => b.createdAt - a.createdAt),
    members: memberRows.sort((a, b) => b.joinedAt - a.joinedAt),
    feedback: feedback.docs.map((d) => ({ id: d.id, ...(d.data() as BetaFeedbackDoc) })),
  };
}

/** One invitation per chosen early-access entry (skipped when that address already has an open invitation or is a member). */
async function invite(p: Req<'invite'>) {
  const state = await betaState();
  const now = Date.now();
  const expiresAt = now + (p.expiresDays ?? state.limits.inviteDays) * DAY;
  const credits = p.credits ?? state.limits.inviteCredits;
  const [open, members] = await Promise.all([bcol.invites().where('status', '==', 'open').get(), bcol.members().get()]);
  const taken = new Set([...open.docs.filter((d) => Number(d.get('expiresAt') ?? 0) > now).map((d) => String(d.get('email') ?? '').toLowerCase()), ...members.docs.map((d) => String(d.get('email') ?? '').toLowerCase())]);
  const created: { email: string; code: string; expiresAt: number; inviteId: string }[] = [];
  const skipped: { earlyAccessId: string; reason: string }[] = [];
  for (const eaId of [...new Set(p.earlyAccessIds)]) {
    const ea = await earlyAccessCol().doc(eaId).get();
    const email = String(ea.get('email') ?? '').trim().toLowerCase();
    if (!ea.exists || !email) {
      skipped.push({ earlyAccessId: eaId, reason: 'Not on the early-access list (it may have been deleted).' });
      continue;
    }
    if (taken.has(email)) {
      skipped.push({ earlyAccessId: eaId, reason: `${email} already has an open invitation or is a member.` });
      continue;
    }
    const code = newInviteCode();
    const id = inviteId(code);
    const doc: InviteDoc = { code, email, earlyAccessId: eaId, wave: p.wave, credits, status: 'open', createdAt: now, expiresAt, redeemedAt: null, redeemedBy: null, revokedAt: null };
    await bcol.invites().doc(id).set(doc);
    taken.add(email);
    created.push({ email, code, expiresAt, inviteId: id });
  }
  return { created, skipped, betaEnabled: state.enabled };
}

async function revokeInvite(p: Req<'revokeInvite'>) {
  const ref = bcol.invites().doc(p.inviteId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Invitation not found.');
  if (snap.get('status') !== 'open') return { status: snap.get('status') };
  await ref.update({ status: 'revoked', revokedAt: Date.now() });
  return { status: 'revoked' };
}

/** Ends a member's access at once (every member call is refused); a running job stops before its next request. */
async function revokeMember(p: Req<'revokeMember'>) {
  const ref = bcol.members().doc(p.uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Member not found.');
  const m = snap.data() as MemberDoc;
  await ref.update({ status: 'revoked', revokedAt: Date.now() });
  if (m.activeJob) {
    const ed = bcol.editions(p.uid).doc(m.activeJob.editionId);
    const job = (await ed.get()).get('job') as MemberEditionDoc['job'];
    if (job?.id === m.activeJob.jobId) await ed.set({ job: { ...job, cancelRequested: true } }, { merge: true });
  }
  return { status: 'revoked' };
}

async function grantCredits(p: Req<'grantCredits'>) {
  const ref = bcol.members().doc(p.uid);
  const now = Date.now();
  return bdb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Member not found.');
    const m = snap.data() as MemberDoc;
    const credits = Math.max(-m.credits.balance, p.credits);
    tx.set(ref, { credits: { ...m.credits, balance: m.credits.balance + credits, granted: m.credits.granted + Math.max(0, credits) } }, { merge: true });
    const entry: BetaLedgerEntry = { kind: credits >= 0 ? 'grant' : 'adjust', credits, usd: null, jobId: null, note: p.note || (credits >= 0 ? 'Credits added by the owner' : 'Credits removed by the owner'), at: now };
    tx.set(bcol.ledger(p.uid).doc(`owner-${now}`), entry);
    return { balance: m.credits.balance + credits };
  });
}

export async function beta(_owner: Owner, p: BetaAdminRequest): Promise<unknown> {
  switch (p.op) {
    case 'overview':
      return overview();
    case 'invite':
      return invite(p);
    case 'revokeInvite':
      return revokeInvite(p);
    case 'revokeMember':
      return revokeMember(p);
    case 'grantCredits':
      return grantCredits(p);
    default: {
      const unhandled: never = p;
      throw new HttpsError('invalid-argument', `Unknown beta operation ${(unhandled as { op?: string }).op ?? ''}.`);
    }
  }
}
