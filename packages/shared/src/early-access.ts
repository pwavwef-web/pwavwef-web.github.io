/**
 * Early-access registration for the public website (phase 1: interest list only — no accounts, no access).
 *
 * Dependency-free on purpose: the public site's small script imports this module directly
 * (`@az-studio/shared/early-access`) so the browser and the `azsPublic` endpoint apply exactly the same
 * validation without shipping a schema library to visitors.
 */

/**
 * Version of the privacy notice and consent wording shown next to the form. Stored with every registration;
 * change it whenever the notice or the consent sentence changes (see docs/PUBLIC_SITE.md).
 */
export const EARLY_ACCESS_NOTICE_VERSION = '2026-10-24';

/** The exact consent sentence shown beside the checkbox (kept with the notice version). */
export const EARLY_ACCESS_CONSENT_TEXT = 'I agree to receive emails from AZ Studio about early access. I can ask to be removed at any time.';

export const EARLY_ACCESS_INTERESTS = [
  { value: 'video', label: 'Video and storytelling' },
  { value: 'music_video', label: 'Music videos' },
  { value: 'image', label: 'Images' },
  { value: 'music', label: 'Music' },
  { value: 'narration', label: 'Narration and audio' },
  { value: 'other', label: 'Something else' },
] as const;
export type EarlyAccessInterest = (typeof EARLY_ACCESS_INTERESTS)[number]['value'];

export const EARLY_ACCESS_LIMITS = {
  emailMax: 254,
  nameMax: 80,
  /** Largest request body the endpoint reads. */
  bodyMaxBytes: 2048,
  /** Submissions per (hashed) network address. */
  perIpHour: 5,
  perIpDay: 20,
  /** All submissions per UTC day; beyond it the endpoint answers "busy" until the next day. */
  globalDay: 1000,
  /** Hashed addresses are deleted after this long. */
  rateRetentionHours: 48,
} as const;

/** Endpoint path (same origin, through the Hosting rewrite /api/public/** → azsPublic). */
export const EARLY_ACCESS_PATH = '/api/public/early-access';

// Practical address check: one @, no spaces or angle brackets, a dotted domain with a 2–63 letter TLD.
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
// Control characters are never stored (C0, DEL and C1 ranges).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

export const normalizeEmail = (raw: string) => raw.trim().toLowerCase();

export interface EarlyAccessInput {
  email?: unknown;
  name?: unknown;
  interest?: unknown;
  consent?: unknown;
  noticeVersion?: unknown;
  /** Honeypot: hidden from people, left empty by them. */
  website?: unknown;
}

export interface EarlyAccessSubmission {
  email: string;
  name: string | null;
  interest: EarlyAccessInterest | null;
  noticeVersion: string;
}

export type EarlyAccessField = 'email' | 'name' | 'interest' | 'consent' | 'form';

export type EarlyAccessValidation = { ok: true; value: EarlyAccessSubmission } | { ok: false; errors: Partial<Record<EarlyAccessField, string>>; bot?: boolean };

/** Validates and normalises a submission. Messages are written for the form's inline errors. */
export function validateEarlyAccess(input: EarlyAccessInput): EarlyAccessValidation {
  const errors: Partial<Record<EarlyAccessField, string>> = {};
  if (typeof input.website === 'string' ? input.website.trim() !== '' : input.website != null) {
    return { ok: false, bot: true, errors: { form: 'This submission could not be accepted. Please try again.' } };
  }
  const email = typeof input.email === 'string' ? normalizeEmail(input.email) : '';
  if (!email) errors.email = 'Enter your email address.';
  else if (email.length > EARLY_ACCESS_LIMITS.emailMax || !EMAIL_RE.test(email)) errors.email = 'Enter a valid email address, like name@example.com.';

  let name: string | null = null;
  if (input.name != null && input.name !== '') {
    if (typeof input.name !== 'string') errors.name = 'Enter your name as text.';
    else {
      name = input.name.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim() || null;
      if (name && name.length > EARLY_ACCESS_LIMITS.nameMax) errors.name = `Keep your name under ${EARLY_ACCESS_LIMITS.nameMax} characters.`;
    }
  }

  let interest: EarlyAccessInterest | null = null;
  if (input.interest != null && input.interest !== '') {
    const match = EARLY_ACCESS_INTERESTS.find((i) => i.value === input.interest);
    if (!match) errors.interest = 'Choose one of the listed interests.';
    else interest = match.value;
  }

  if (input.consent !== true) errors.consent = 'Tick the box to agree to early-access emails — it’s the only thing the list is used for.';

  const noticeVersion = typeof input.noticeVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.noticeVersion) ? input.noticeVersion : '';
  if (!noticeVersion && !errors.form) errors.form = 'This page is out of date. Reload it and try again.';

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { email, name, interest, noticeVersion } };
}

/** Owner view of one registration (milliseconds since the epoch). */
export interface EarlyAccessRecord {
  id: string;
  email: string;
  name: string | null;
  interest: EarlyAccessInterest | null;
  consent: { updates: true; noticeVersion: string; at: number | null };
  createdAt: number | null;
  lastSubmittedAt: number | null;
  submissions: number;
  source: string;
}

/** Spreadsheet-safe CSV (cells that start with = + - @ or a tab are prefixed so they are not run as formulas). */
export function earlyAccessCsv(records: EarlyAccessRecord[]): string {
  const cell = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : '');
  const label = (v: EarlyAccessInterest | null) => EARLY_ACCESS_INTERESTS.find((i) => i.value === v)?.label ?? '';
  const header = ['email', 'name', 'interest', 'consented_at', 'notice_version', 'registered_at', 'last_submitted_at', 'submissions', 'source'];
  const rows = records.map((r) => [r.email, r.name, label(r.interest), iso(r.consent.at), r.consent.noticeVersion, iso(r.createdAt), iso(r.lastSubmittedAt), r.submissions, r.source]);
  return [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
