import { z } from 'zod';
import { GOOGLE_VOICES, type GoogleVoiceName } from './narrator';
import { applyEdits, cleanupEdits } from './narrator-text';

/**
 * The public beta ("members"), built switched off. docs/PUBLIC_PRODUCT_PREP.md holds the plan; this module holds
 * the parts both sides share: limits, credits, invitations, documents and the request schemas.
 *
 * - Off unless `runtime/features.beta.enabled === true` AND the deployment's kill switch `AZS_FEATURE_BETA` is not
 *   `off`. Off means no member call does anything; the owner studio is unaffected either way.
 * - Members are separate from the owner: they call their own callable (`azsMember`, gated by `assertMember`), never
 *   `azsApi`, and their data lives under `members/{uid}/…`, which no client rule exposes (deny-by-default).
 * - First tool: audio editions with Google's PREBUILT voices only (no voice replication for members).
 */

export interface BetaLimits {
  /** Characters a member may send to the voice per UTC day. */
  dailyChars: number;
  /** Minutes of audio a member may make per UTC day (estimated at submission, measured after). */
  dailyMinutes: number;
  /** Longest edition (characters) that can be voiced in one job. */
  maxEditionChars: number;
  maxEditions: number;
  /** Hard ceiling on the recorded provider cost of one job (USD); the worker stops at it. */
  jobCeilingUsd: number;
  /** Circuit breaker: recorded + reserved spend of all members together per UTC day (USD). */
  globalDailyUsd: number;
  /** Credits granted with an invitation. */
  inviteCredits: number;
  /** Days an invitation stays redeemable. */
  inviteDays: number;
}

export const BETA_DEFAULT_LIMITS: BetaLimits = {
  dailyChars: 20_000,
  dailyMinutes: 20,
  maxEditionChars: 12_000,
  maxEditions: 30,
  jobCeilingUsd: 0.1,
  globalDailyUsd: 2,
  inviteCredits: 300,
  inviteDays: 14,
};

/** Hard upper bounds a `runtime/features` override can never exceed. */
const MAX_LIMITS: BetaLimits = { dailyChars: 100_000, dailyMinutes: 120, maxEditionChars: 40_000, maxEditions: 200, jobCeilingUsd: 1, globalDailyUsd: 25, inviteCredits: 5_000, inviteDays: 60 };

/** One credit is $0.001 of recorded provider cost (no prices or margins are decided; see §5 of the plan). */
export const CREDIT_USD = 0.001;
export const creditsFor = (usd: number) => Math.max(0, Math.ceil(Math.round(usd * 1e6) / 1e6 / CREDIT_USD));

/** Waves of invitations (the plan's 5 → 20 → 100). */
export const BETA_WAVES = [
  { id: 'wave-1', label: 'Wave 1', size: 5 },
  { id: 'wave-2', label: 'Wave 2', size: 20 },
  { id: 'wave-3', label: 'Wave 3', size: 100 },
] as const;
export type BetaWave = (typeof BETA_WAVES)[number]['id'];

/** Prebuilt voices offered to members (Google's own; nothing replicated). */
export const BETA_VOICES = GOOGLE_VOICES;
export const DEFAULT_BETA_VOICE: GoogleVoiceName = 'Charon';
export const isBetaVoice = (name: string): name is GoogleVoiceName => GOOGLE_VOICES.some((v) => v.name === name);

const clampInt = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Limits from the feature flag, each clamped to its hard maximum (missing values keep the defaults). */
export function normalizeBetaLimits(raw: unknown): BetaLimits {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof BetaLimits, unknown>>;
  const out = { ...BETA_DEFAULT_LIMITS };
  for (const k of Object.keys(BETA_DEFAULT_LIMITS) as (keyof BetaLimits)[]) out[k] = clampInt(r[k], 0, MAX_LIMITS[k], BETA_DEFAULT_LIMITS[k]);
  return out;
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/** XXXX-XXXX-XXXX from an alphabet without look-alikes (no 0/O, 1/I/L). */
export const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_RE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

export function normalizeInviteCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 12) return null;
  const code = `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
  return INVITE_CODE_RE.test(code) ? code : null;
}

export interface InviteDoc {
  /** Shown to the owner to pass on by hand (AZ Studio sends no email). Doc id = sha256(code). */
  code: string;
  email: string;
  earlyAccessId: string | null;
  wave: string;
  credits: number;
  status: 'open' | 'redeemed' | 'revoked';
  createdAt: number;
  expiresAt: number;
  redeemedAt: number | null;
  redeemedBy: string | null;
  revokedAt: number | null;
}

/** Why an invitation cannot be redeemed by this account (null = it can). Single use, unexpired, same verified email. */
export function inviteProblem(inv: Pick<InviteDoc, 'status' | 'expiresAt' | 'email'> | null, who: { email: string | null; emailVerified: boolean }, now: number): string | null {
  if (!inv || inv.status === 'revoked') return 'This invitation code is not valid.';
  if (inv.status === 'redeemed') return 'This invitation has already been used.';
  if (inv.expiresAt <= now) return 'This invitation has expired. Ask for a new one.';
  if (!who.email || !who.emailVerified) return 'Sign in with a verified email address first.';
  if (who.email.trim().toLowerCase() !== inv.email.trim().toLowerCase()) return 'This invitation was sent to a different email address. Sign in with that address.';
  return null;
}

// ---------------------------------------------------------------------------
// Members, editions, ledger, feedback
// ---------------------------------------------------------------------------

export interface MemberDay {
  day: string;
  chars: number;
  seconds: number;
  usd: number;
}

export interface MemberDoc {
  uid: string;
  email: string;
  wave: string;
  inviteId: string;
  status: 'active' | 'revoked';
  joinedAt: number;
  revokedAt: number | null;
  credits: { balance: number; granted: number; spent: number; reserved: number };
  today: MemberDay;
  totals: { chars: number; seconds: number; usd: number; jobs: number };
  /** One job at a time per member (queue fairness: one member cannot fill the shared voice queue). */
  activeJob: { editionId: string; jobId: string } | null;
  lastSeenAt: number;
}

export type MemberEditionStatus = 'draft' | 'queued' | 'speaking' | 'ready' | 'failed';

export interface MemberEditionDoc {
  title: string;
  text: string;
  sourceUrl: string | null;
  voice: GoogleVoiceName;
  status: MemberEditionStatus;
  rev: number;
  chars: number;
  job: { id: string; reservedCredits: number; estimateUsd: number; estimateSec: number; spentUsd: number; chunks: string[]; inflight: number | null; startedAt: number; cancelRequested?: boolean } | null;
  audio: { path: string; durationSec: number; bytes: number; at: number; textHash: string } | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * What the voice reads for a member's edition: the title, then the text with the Narrator's clean-up applied (Markdown,
 * links, raw URLs, citation markers, numbers, abbreviations) — the same rules the studio proposes, applied in full.
 */
export function memberSpeechText(title: string, text: string): string {
  const body = text.replace(/\r\n?/g, '\n').replace(/^#{1,6}\s+/gm, '');
  const cleaned = applyEdits(body, cleanupEdits(body)).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n\n').trim();
  const t = title.trim();
  return t ? `${t}${/[.!?]$/.test(t) ? '' : '.'}\n\n${cleaned}` : cleaned;
}

export type LedgerKind = 'grant' | 'reserve' | 'settle' | 'refund' | 'adjust';

/** Append-only credit movements (`members/{uid}/ledger/{id}`). `credits` is signed: + adds to the balance. */
export interface BetaLedgerEntry {
  kind: LedgerKind;
  credits: number;
  usd: number | null;
  jobId: string | null;
  note: string;
  at: number;
}

export interface BetaFeedbackDoc {
  uid: string;
  email: string;
  message: string;
  rating: number | null;
  page: string;
  at: number;
}

/** What a member sees about their allowance (the server is the only judge; this is for display). */
export interface MemberAllowance {
  limits: Pick<BetaLimits, 'dailyChars' | 'dailyMinutes' | 'maxEditionChars' | 'jobCeilingUsd'>;
  today: MemberDay;
  credits: MemberDoc['credits'];
  remaining: { chars: number; minutes: number; credits: number };
}

export function memberToday(m: Pick<MemberDoc, 'today'>, now: number): MemberDay {
  const day = utcDay(now);
  return m.today?.day === day ? m.today : { day, chars: 0, seconds: 0, usd: 0 };
}

export function memberAllowance(m: Pick<MemberDoc, 'today' | 'credits'>, limits: BetaLimits, now: number): MemberAllowance {
  const today = memberToday(m, now);
  return {
    limits: { dailyChars: limits.dailyChars, dailyMinutes: limits.dailyMinutes, maxEditionChars: limits.maxEditionChars, jobCeilingUsd: limits.jobCeilingUsd },
    today,
    credits: m.credits,
    remaining: { chars: Math.max(0, limits.dailyChars - today.chars), minutes: Math.max(0, Math.floor((limits.dailyMinutes * 60 - today.seconds) / 6) / 10), credits: Math.max(0, m.credits.balance - m.credits.reserved) },
  };
}

/** Credits held for a job before it starts: its estimate with a margin, never above the per-job ceiling. */
export const reserveCreditsFor = (estimateUsd: number, limits: Pick<BetaLimits, 'jobCeilingUsd'>) => creditsFor(Math.min(limits.jobCeilingUsd, estimateUsd * 1.5 + 0.002));

/**
 * Every server-side check before a member's job is created, in one place (the API runs it inside the submission
 * transaction). Returns the reasons it is refused; empty = allowed.
 */
export function submissionProblems(input: { limits: BetaLimits; member: Pick<MemberDoc, 'today' | 'credits' | 'status'>; chars: number; estimateSec: number; estimateUsd: number; globalUsd: number; now: number }): string[] {
  const { limits, member, chars, estimateSec, estimateUsd, globalUsd, now } = input;
  const out: string[] = [];
  if (member.status !== 'active') out.push('Your beta access has ended.');
  const today = memberToday(member, now);
  if (chars < 1) out.push('There is no text to read.');
  if (chars > limits.maxEditionChars) out.push(`This edition has ${chars.toLocaleString('en')} characters; the beta voices up to ${limits.maxEditionChars.toLocaleString('en')} at a time.`);
  if (today.chars + chars > limits.dailyChars) out.push(`Today's allowance is ${limits.dailyChars.toLocaleString('en')} characters; ${Math.max(0, limits.dailyChars - today.chars).toLocaleString('en')} remain (resets at 00:00 UTC).`);
  if (today.seconds + estimateSec > limits.dailyMinutes * 60) out.push(`Today's allowance is ${limits.dailyMinutes} minutes of audio; about ${Math.max(0, Math.floor((limits.dailyMinutes * 60 - today.seconds) / 60))} remain.`);
  if (estimateUsd > limits.jobCeilingUsd) out.push('This edition is too long for one job in the beta. Split it into shorter editions.');
  const need = reserveCreditsFor(estimateUsd, limits);
  if (member.credits.balance - member.credits.reserved < need) out.push(`This needs about ${need} credits; you have ${Math.max(0, member.credits.balance - member.credits.reserved)}.`);
  if (globalUsd + estimateUsd > limits.globalDailyUsd) out.push('The beta has reached its daily limit for everyone. Try again tomorrow.');
  return out;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(128).regex(/^[\w-]+$/, 'Invalid id');
const requestId = z.string().min(8).max(64).regex(/^[\w-]+$/, 'Invalid request id');
const voice = z.string().refine(isBetaVoice, 'Choose one of the listed voices');

/** The member callable (`azsMember`). There is no voice-creation, publishing or studio operation here. */
export const memberRequestSchema = z.discriminatedUnion('op', [
  /** Feature state, membership, allowance and editions. */
  z.object({ op: z.literal('me') }),
  z.object({ op: z.literal('redeem'), code: z.string().max(40) }),
  z.object({ op: z.literal('editionCreate'), title: z.string().trim().max(200).default(''), text: z.string().max(60_000).default(''), sourceUrl: z.string().max(500).nullable().default(null) }),
  /** Reads an article on blogs.pwavwe.com (the Narrator's safe importer) and returns its text; nothing is stored. */
  z.object({ op: z.literal('importUrl'), url: z.string().max(500) }),
  z.object({ op: z.literal('editionSave'), editionId: id, baseRev: z.number().int().min(0), title: z.string().trim().max(200).optional(), text: z.string().max(60_000).optional(), voice: voice.optional() }),
  z.object({ op: z.literal('editionGet'), editionId: id }),
  z.object({ op: z.literal('editionDelete'), editionId: id }),
  z.object({ op: z.literal('estimate'), editionId: id }),
  z.object({ op: z.literal('synthesize'), editionId: id, requestId, confirmedCredits: z.number().int().min(0) }),
  z.object({ op: z.literal('cancel'), editionId: id }),
  z.object({ op: z.literal('audioUrl'), editionId: id, download: z.boolean().default(false) }),
  z.object({ op: z.literal('feedback'), message: z.string().trim().min(3).max(4000), rating: z.number().int().min(1).max(5).nullable().default(null), page: z.string().max(120).default('') }),
]);
export type MemberRequest = z.infer<typeof memberRequestSchema>;

/** Owner side (`azsApi` action `beta`): invitations from the early-access list, members, usage, feedback. */
export const betaAdminRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('overview') }),
  z.object({ op: z.literal('invite'), earlyAccessIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100), wave: z.string().trim().min(1).max(40), expiresDays: z.number().int().min(1).max(60).optional(), credits: z.number().int().min(0).max(5_000).optional() }),
  z.object({ op: z.literal('revokeInvite'), inviteId: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ op: z.literal('revokeMember'), uid: id }),
  z.object({ op: z.literal('grantCredits'), uid: id, credits: z.number().int().min(-5_000).max(5_000), note: z.string().trim().max(200).default('') }),
]);
export type BetaAdminRequest = z.infer<typeof betaAdminRequestSchema>;
