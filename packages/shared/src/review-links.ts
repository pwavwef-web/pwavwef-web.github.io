/**
 * Private review links for clients: a capability URL (`/review/{token}`, 32 random URL-safe characters) that plays
 * one finished render, takes comments pinned to a moment in the cut and records an approval or a change request.
 * The link expires, can be revoked at once, and exposes only the fields in `ReviewPublicView` — never the owner,
 * the project's other media or a storage path. Written by the API and the public function only.
 */
export const REVIEW_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
export const REVIEW_LIMITS = {
  minDays: 1,
  maxDays: 30,
  defaultDays: 14,
  commentChars: 1000,
  nameChars: 60,
  maxComments: 300,
  /** Comments and decisions per link per minute (a client typing quickly stays well under it). */
  perMinute: 12,
  /** Signed media URL lifetime. */
  mediaTtlSec: 3600,
} as const;

export type ReviewStatus = 'open' | 'approved' | 'changes_requested';

export interface ReviewDecision {
  decision: 'approved' | 'changes_requested';
  name: string;
  note: string;
  at: number;
}

export interface ReviewLinkDoc {
  token: string;
  ownerUid: string;
  projectId: string;
  projectTitle: string;
  renderId: string;
  assetId: string;
  storagePath: string;
  mimeType: string;
  title: string;
  /** Shown to the client, e.g. "Version 3". */
  versionLabel: string;
  durationSec: number;
  width: number;
  height: number;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  status: ReviewStatus;
  decisions: ReviewDecision[];
  commentCount: number;
  /** Recent write times (rate limit). */
  stamps: number[];
}

export interface ReviewComment {
  id: string;
  atSec: number;
  text: string;
  name: string;
  createdAt: number;
  resolved: boolean;
}

export interface ReviewPublicView {
  title: string;
  projectTitle: string;
  versionLabel: string;
  durationSec: number;
  width: number;
  height: number;
  expiresAt: number;
  status: ReviewStatus;
  decisions: ReviewDecision[];
  comments: Omit<ReviewComment, 'resolved'>[];
  mediaUrl: string;
}

export type ReviewLinkState = 'open' | 'expired' | 'revoked';

export function reviewLinkState(doc: Pick<ReviewLinkDoc, 'expiresAt' | 'revokedAt'>, now = Date.now()): ReviewLinkState {
  if (doc.revokedAt) return 'revoked';
  return now >= doc.expiresAt ? 'expired' : 'open';
}

export function reviewPublicView(doc: ReviewLinkDoc, comments: ReviewComment[]): ReviewPublicView {
  return {
    title: doc.title,
    projectTitle: doc.projectTitle,
    versionLabel: doc.versionLabel,
    durationSec: doc.durationSec,
    width: doc.width,
    height: doc.height,
    expiresAt: doc.expiresAt,
    status: doc.status,
    decisions: doc.decisions,
    comments: [...comments].sort((a, b) => a.atSec - b.atSec || a.createdAt - b.createdAt).map(({ id, atSec, text, name, createdAt }) => ({ id, atSec, text, name, createdAt })),
    mediaUrl: `/api/public/review/${doc.token}/media`,
  };
}

const clean = (s: unknown, max: number) =>
  String(s ?? '')
    // Control characters (except line breaks in comments) never reach the page or the studio.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);

export type ReviewInput<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseReviewComment(body: unknown, durationSec: number): ReviewInput<{ atSec: number; text: string; name: string }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = clean(b.text, REVIEW_LIMITS.commentChars);
  const name = clean(b.name, REVIEW_LIMITS.nameChars).replace(/\s+/g, ' ');
  const atSec = Number(b.atSec);
  if (!text) return { ok: false, error: 'Write a comment first.' };
  if (!Number.isFinite(atSec) || atSec < 0 || atSec > durationSec + 0.5) return { ok: false, error: 'The comment’s time is outside the video.' };
  return { ok: true, value: { atSec: Math.round(atSec * 10) / 10, text, name: name || 'Client' } };
}

export function parseReviewDecision(body: unknown): ReviewInput<{ decision: ReviewDecision['decision']; note: string; name: string }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const decision = b.decision === 'approved' || b.decision === 'changes_requested' ? b.decision : null;
  if (!decision) return { ok: false, error: 'Choose approve or request changes.' };
  const note = clean(b.note, REVIEW_LIMITS.commentChars);
  if (decision === 'changes_requested' && !note) return { ok: false, error: 'Say what should change.' };
  return { ok: true, value: { decision, note, name: clean(b.name, REVIEW_LIMITS.nameChars).replace(/\s+/g, ' ') || 'Client' } };
}

/** Sliding one-minute write limit for a link; returns the stamps to store, or null when the limit is reached. */
export function reviewRateStamps(stamps: number[], now = Date.now()): number[] | null {
  const recent = stamps.filter((t) => now - t < 60_000);
  if (recent.length >= REVIEW_LIMITS.perMinute) return null;
  return [...recent, now];
}

