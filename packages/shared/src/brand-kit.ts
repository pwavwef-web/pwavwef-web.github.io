import { z } from 'zod';
import type { AdBrand } from './ads';
import type { ApprovedFact } from './facts';
import type { LinkAdBrand } from './linkad';
import { contrastRatio } from './linkad-checks';
import { isoDaySchema, KIT_CONTACT_KINDS, KIT_CONTACT_LABELS, kitFontSchema, priceSchema } from './brand-primitives';

/**
 * Brand kits: one per client (`brandKits/{id}`, owner-read, written through the API only). A kit holds what every
 * advert for that client must get right — colours, fonts, logos, contacts, prices with the day they were last
 * confirmed and the day they must be confirmed again, real product photos and notes — so the Short Ads brief, Link
 * to Ad and the Motion Poster Ad tool are filled from one checked source instead of being retyped (and mistyped).
 *
 * Prices and contacts go stale: a price list changes, a tier is renamed ("Normal" became "Regular"), a phone number
 * moves. Every price and contact therefore carries `confirmedOn` and `reviewBy`; anything past its review-by day is
 * reported wherever the kit is used and blocks a final export until it is re-confirmed.
 */

export const BRAND_KIT_LIMITS = { kits: 60, logos: 6, contacts: 16, offers: 40, photos: 24, notesChars: 3000 } as const;

/** Days until a newly confirmed entry must be confirmed again (the director can choose a different day). */
export const KIT_REVIEW_DAYS = { offer: 30, contact: 180 } as const;
/** An entry this close to its review-by day is shown as "due soon". */
export const KIT_DUE_SOON_DAYS = 7;

const id = z.string().min(1).max(80).regex(/^[\w.-]+$/, 'Invalid id');
const text = (max: number) => z.string().max(max);
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1F6F5B');

export const kitLogoSchema = z.object({ assetId: id, label: text(80).default(''), variant: z.enum(['full', 'mark', 'light', 'dark']).default('full') });
export const kitContactSchema = z.object({
  id,
  kind: z.enum(KIT_CONTACT_KINDS),
  label: text(80).default(''),
  value: text(200),
  confirmedOn: isoDaySchema,
  reviewBy: isoDaySchema,
});
export type KitContact = z.infer<typeof kitContactSchema>;

export const kitOfferSchema = z.object({
  id,
  /** What it is, as the client names it now ("Regular passport", "Honey 500 g"). */
  item: text(80),
  /** The amount as written ("450", "1,200", "12.50"). */
  price: priceSchema,
  currency: text(8).default('GH₵'),
  /** "per jar", "from", "per night"… */
  unit: text(40).default(''),
  note: text(200).default(''),
  confirmedOn: isoDaySchema,
  reviewBy: isoDaySchema,
  /** Earlier names of the item (a renamed tier keeps its history so a stale script is recognisable). */
  previousNames: z.array(text(80)).max(5).default([]),
});
export type KitOffer = z.infer<typeof kitOfferSchema>;

export const kitPhotoSchema = z.object({
  assetId: id,
  label: text(120).default(''),
  /** Which product or service the photo shows. */
  product: text(80).default(''),
  /** A real photograph of the real product, place or people (not generated). Real photos are offered first. */
  real: z.boolean().default(true),
});
export type KitPhoto = z.infer<typeof kitPhotoSchema>;

export const brandKitInputSchema = z.object({
  name: z.string().trim().min(1, 'Name the kit (the client or brand).').max(120),
  colours: z.object({ primary: colour.default('#1F6F5B'), background: colour.default('#0F1B1A'), accent: colour.default('#F4B84A'), text: colour.default('#FFFFFF') }).default({ primary: '#1F6F5B', background: '#0F1B1A', accent: '#F4B84A', text: '#FFFFFF' }),
  fonts: z.object({ heading: kitFontSchema.default(kitFontSchema.parse({})), body: kitFontSchema.default(kitFontSchema.parse({})) }).default({ heading: kitFontSchema.parse({}), body: kitFontSchema.parse({}) }),
  logos: z.array(kitLogoSchema).max(BRAND_KIT_LIMITS.logos).default([]),
  contacts: z.array(kitContactSchema).max(BRAND_KIT_LIMITS.contacts).default([]),
  offers: z.array(kitOfferSchema).max(BRAND_KIT_LIMITS.offers).default([]),
  photos: z.array(kitPhotoSchema).max(BRAND_KIT_LIMITS.photos).default([]),
  notes: text(BRAND_KIT_LIMITS.notesChars).default(''),
});
export type BrandKitInput = z.infer<typeof brandKitInputSchema>;

export interface BrandKitDoc extends BrandKitInput {
  ownerUid: string;
  revision: number;
  createdAt: unknown;
  updatedAt: unknown;
}

export const brandKitRequestSchema = z.discriminatedUnion('op', [
  /** Creates (kitId null) or replaces a kit. `revision` is the one the editor loaded; another tab's change is a conflict. */
  z.object({ op: z.literal('save'), kitId: id.nullable().default(null), revision: z.number().int().nonnegative().nullable().default(null), kit: brandKitInputSchema }),
  z.object({ op: z.literal('delete'), kitId: id }),
  /** The director checked these prices/contacts are still right today: confirmed today, next review in the usual interval. */
  z.object({ op: z.literal('reconfirm'), kitId: id, entryIds: z.array(id).min(1).max(60) }),
]);
export type BrandKitRequest = z.output<typeof brandKitRequestSchema>;
export type BrandKitRequestInput = z.input<typeof brandKitRequestSchema>;

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** Today as YYYY-MM-DD (UTC, like every other day key in the studio). */
export function todayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  return new Date((Number.isFinite(t) ? t : Date.now()) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export type ReviewState = 'current' | 'due_soon' | 'overdue';

export function reviewState(reviewBy: string | null | undefined, today: string): ReviewState {
  if (!reviewBy) return 'current';
  const left = daysBetween(today, reviewBy);
  return left < 0 ? 'overdue' : left <= KIT_DUE_SOON_DAYS ? 'due_soon' : 'current';
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/** "GH₵ 450" / "$12.50": a symbol sits close, a code takes a space. */
export function formatPrice(currency: string, price: string): string {
  const c = currency.trim();
  if (!c) return price;
  return /^[A-Z]{3}$/.test(c) || /[A-Za-z]$/.test(c) ? `${c} ${price}` : `${c}${price}`;
}

export function offerText(o: Pick<KitOffer, 'item' | 'price' | 'currency' | 'unit'>): string {
  return [o.item.trim(), formatPrice(o.currency, o.price), o.unit.trim()].filter(Boolean).join(' ');
}

export interface KitWarning {
  entryId: string;
  kind: 'offer' | 'contact';
  label: string;
  reviewBy: string;
  state: Exclude<ReviewState, 'current'>;
  message: string;
}

/** Prices and contacts that are past (or close to) their review-by day. */
export function kitWarnings(kit: Pick<BrandKitInput, 'offers' | 'contacts' | 'name'>, today = todayKey()): KitWarning[] {
  const out: KitWarning[] = [];
  const push = (entryId: string, kind: KitWarning['kind'], label: string, reviewBy: string) => {
    const state = reviewState(reviewBy, today);
    if (state === 'current') return;
    const over = -daysBetween(today, reviewBy);
    out.push({ entryId, kind, label, reviewBy, state, message: state === 'overdue' ? `“${label}” was due for re-confirmation on ${reviewBy} (${over} day${over === 1 ? '' : 's'} ago). Check it with ${kit.name || 'the client'} and re-confirm it before it goes in an ad.` : `“${label}” is due for re-confirmation on ${reviewBy}.` });
  };
  for (const o of kit.offers) push(o.id, 'offer', offerText(o), o.reviewBy);
  for (const c of kit.contacts) push(c.id, 'contact', `${KIT_CONTACT_LABELS[c.kind]} ${c.value}`, c.reviewBy);
  return out;
}

/** Readability of the kit's own colour pairs (the same thresholds the export checks use). */
export function kitColourIssues(kit: Pick<BrandKitInput, 'colours'>): string[] {
  const out: string[] = [];
  const c = kit.colours;
  const tb = contrastRatio(c.text, c.background);
  if (tb < 4.5) out.push(`Text on the background colour is hard to read (contrast ${tb}:1, needs 4.5:1).`);
  const ab = contrastRatio(c.accent, c.background);
  if (ab < 3) out.push(`The accent on the background colour is faint (contrast ${ab}:1).`);
  return out;
}

// ---------------------------------------------------------------------------
// Saving: edits re-confirm what they change
// ---------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Prepares a kit for storage against the previous version: a price or contact whose wording changed was just typed
 * by the director, so it is confirmed today (a renamed item keeps its old name in `previousNames`); unchanged
 * entries keep their dates; a review-by day earlier than the confirmation is moved to the usual interval.
 */
export function prepareKitSave(next: BrandKitInput, prev: BrandKitInput | null, today = todayKey()): BrandKitInput {
  const before = new Map((prev?.offers ?? []).map((o) => [o.id, o]));
  const offers = next.offers.map((o) => {
    const p = before.get(o.id);
    const changed = !p || p.item.trim() !== o.item.trim() || p.price !== o.price || p.currency !== o.currency || p.unit.trim() !== o.unit.trim();
    const previousNames = p && p.item.trim() !== o.item.trim() && p.item.trim() ? [...new Set([p.item.trim(), ...o.previousNames, ...p.previousNames])].filter((n) => n !== o.item.trim()).slice(0, 5) : o.previousNames;
    const confirmedOn = changed ? today : o.confirmedOn;
    // A review-by day the director picked is kept; otherwise a changed price gets the usual interval.
    const reviewBy = changed && (!p || p.reviewBy === o.reviewBy) ? addDays(today, KIT_REVIEW_DAYS.offer) : o.reviewBy;
    return { ...o, item: o.item.trim(), unit: o.unit.trim(), previousNames, confirmedOn, reviewBy: daysBetween(confirmedOn, reviewBy) < 0 ? addDays(confirmedOn, KIT_REVIEW_DAYS.offer) : reviewBy };
  });
  const cBefore = new Map((prev?.contacts ?? []).map((c) => [c.id, c]));
  const contacts = next.contacts.map((c) => {
    const p = cBefore.get(c.id);
    const changed = !p || p.kind !== c.kind || p.value.trim() !== c.value.trim();
    const confirmedOn = changed ? today : c.confirmedOn;
    const reviewBy = changed && (!p || p.reviewBy === c.reviewBy) ? addDays(today, KIT_REVIEW_DAYS.contact) : c.reviewBy;
    return { ...c, value: c.value.trim(), confirmedOn, reviewBy: daysBetween(confirmedOn, reviewBy) < 0 ? addDays(confirmedOn, KIT_REVIEW_DAYS.contact) : reviewBy };
  });
  return { ...next, name: next.name.trim(), offers, contacts, notes: next.notes.trim() };
}

/** Re-confirms the named entries today. Unknown ids are ignored (the caller reports them). */
export function reconfirmKit(kit: BrandKitInput, entryIds: readonly string[], today = todayKey()): BrandKitInput {
  const ids = new Set(entryIds);
  return {
    ...kit,
    offers: kit.offers.map((o) => (ids.has(o.id) ? { ...o, confirmedOn: today, reviewBy: addDays(today, KIT_REVIEW_DAYS.offer) } : o)),
    contacts: kit.contacts.map((c) => (ids.has(c.id) ? { ...c, confirmedOn: today, reviewBy: addDays(today, KIT_REVIEW_DAYS.contact) } : c)),
  };
}

/** Problems that make a kit unsafe to save (duplicates). Field formats are checked by the schema. */
export function kitProblems(kit: BrandKitInput): string[] {
  const out: string[] = [];
  const ids = [...kit.offers.map((o) => o.id), ...kit.contacts.map((c) => c.id)];
  if (new Set(ids).size !== ids.length) out.push('Two prices or contacts share an id.');
  const items = kit.offers.map((o) => `${o.item.trim().toLowerCase()}|${o.unit.trim().toLowerCase()}`);
  const dup = items.find((x, i) => items.indexOf(x) !== i);
  if (dup) out.push(`“${dup.split('|')[0]}” is listed twice. Keep one price per item.`);
  if (new Set(kit.photos.map((p) => p.assetId)).size !== kit.photos.length) out.push('A photo is listed twice.');
  return out;
}

// ---------------------------------------------------------------------------
// Filling the tools
// ---------------------------------------------------------------------------

const MAJOR: Record<string, string> = { 'GH₵': 'cedis', '₵': 'cedis', GHS: 'cedis', GHC: 'cedis', $: 'dollars', USD: 'dollars', '€': 'euros', EUR: 'euros', '£': 'pounds', GBP: 'pounds', '₦': 'naira', NGN: 'naira', KES: 'shillings', ZAR: 'rand' };

/** The kit's prices and contacts as approved facts for the fact check (prices and phone numbers on screen and spoken). */
export function kitApprovedFacts(kit: Pick<BrandKitInput, 'offers' | 'contacts'>): ApprovedFact[] {
  const out: ApprovedFact[] = [];
  for (const o of kit.offers) out.push({ id: `kit_${o.id}`.slice(0, 40), kind: 'price', value: formatPrice(o.currency, o.price), label: [o.item, o.unit].filter(Boolean).join(' ').slice(0, 120), reviewBy: o.reviewBy, origin: 'kit' });
  for (const c of kit.contacts) {
    const kind = c.kind === 'phone' || c.kind === 'whatsapp' ? 'phone' : c.kind === 'website' || c.kind === 'social' ? 'url' : null;
    if (!kind) continue;
    out.push({ id: `kit_${c.id}`.slice(0, 40), kind, value: c.value.slice(0, 120), label: (c.label || KIT_CONTACT_LABELS[c.kind]).slice(0, 120), reviewBy: c.reviewBy, origin: 'kit' });
  }
  return out.slice(0, 40);
}

/** Merges kit facts into a list of approved facts: kit entries replace their earlier copies, the director's own stay. */
export function mergeKitFacts(existing: readonly ApprovedFact[], kitFacts: readonly ApprovedFact[]): ApprovedFact[] {
  const own = existing.filter((f) => !f.id.startsWith('kit_'));
  return [...own, ...kitFacts].slice(0, 40);
}

export const currencyWord = (currency: string) => MAJOR[currency.trim()] ?? MAJOR[currency.trim().toUpperCase()] ?? currency.trim();

/** The kit as a Short Ads brand (colours, renderer font, licensed upload, logo and where it came from). */
export function kitToAdBrand(kit: Pick<BrandKitInput, 'name' | 'colours' | 'fonts' | 'logos'>, base: AdBrand): AdBrand {
  const f = kit.fonts.heading;
  return {
    ...base,
    primary: kit.colours.primary,
    background: kit.colours.background,
    accent: kit.colours.accent,
    text: kit.colours.text,
    font: f.family,
    fontAssetId: f.uploadAssetId && f.licenceConfirmed ? f.uploadAssetId : null,
    logoAssetId: kit.logos[0]?.assetId ?? base.logoAssetId,
    logoSource: kit.logos[0] ? `Brand kit “${kit.name}”${kit.logos[0].label ? ` · ${kit.logos[0].label}` : ''}` : base.logoSource,
  };
}

/** The kit as a Link to Ad / Motion Poster Ad brand (the video's text uses a renderer font). */
export function kitToLinkAdBrand(kit: Pick<BrandKitInput, 'colours' | 'fonts'>): LinkAdBrand {
  return { primary: kit.colours.primary, background: kit.colours.background, text: kit.colours.text, accent: kit.colours.accent, font: kit.fonts.heading.family };
}

/** Real photos first (the tools offer them before any generated picture). */
export function kitPhotosFirst(kit: Pick<BrandKitInput, 'photos'>): KitPhoto[] {
  return [...kit.photos].sort((a, b) => Number(b.real) - Number(a.real));
}

export function emptyBrandKit(name = ''): BrandKitInput {
  return brandKitInputSchema.parse({ name: name || 'New brand' });
}

/** Reads a stored kit; anything unreadable becomes an empty kit with the same name rather than breaking a page. */
export function normalizeBrandKit(raw: unknown): BrandKitInput {
  const parsed = brandKitInputSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const name = raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string' ? String((raw as { name: string }).name).slice(0, 120) : '';
  return emptyBrandKit(name);
}

/** Whether a kit's content differs (for "unsaved changes"). */
export const kitChanged = (a: BrandKitInput, b: BrandKitInput) => !same(a, b);
