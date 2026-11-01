import { stableHash } from './lite';
import { allFacts, isConfirmed, newId, stampFor, type AdClosing, type AdScene, type FactKind, type LinkAdBrief, type LinkAdDoc, type UserFact } from './linkad';
import { checkClaims, contrastRatio, linkAdFactChecks, readableOn } from './linkad-checks';
import { factsFromLinkAd, staleApprovedFacts, type FactCheck } from './facts';
import { drawingFamily, KIT_CONTACT_LABELS, type KitFont } from './brand-primitives';
import { currencyWord, formatPrice, reviewState, todayKey } from './brand-kit';
import { POSTER_FORMATS, type PosterContact, type PosterForm, type PosterFormatId, type PosterPrice, type PosterTemplate } from './poster-schema';
import type { MeasureText } from './text-scene';
import { numberToWords } from './narrator-text';

/**
 * Motion Poster Ad: the hand-made client pipeline (an HTML poster from the facts and real product photos, a voice
 * per line, word-timed captions, an instrumental bed ducked under the voice, a 1080 × 1920 MP4 and a poster PNG)
 * as a studio tool. It is a Link to Ad whose source is a facts form instead of a website: the form becomes the
 * ad's director facts (`userFacts`, ids `pf_…`, confirmations and claim checks unchanged), the template writes a
 * first script deterministically (no model call), and voice, timing, assembly, caps and export validation are
 * Link to Ad's own.
 *
 * The poster is laid out here, in pixels, from measured text (`MeasureText`): the browser measures and draws with
 * the real fonts and uploads the PNG it drew, so the preview is the export.
 */

export const POSTER_TEMPLATE_INFO: Record<PosterTemplate, { label: string; body: string; needs: string }> = {
  product_hero: { label: 'Product hero', body: 'One product, a big real photo, the price and how to order.', needs: 'A headline and a real photo; a price if you have one.' },
  price_list: { label: 'Price list', body: 'Several items with their prices, a photo band and the contacts.', needs: 'A headline and at least one price.' },
  event: { label: 'Event or announcement', body: 'What, when and where — date block, place and how to register.', needs: 'A headline, a date and a place.' },
  service_promo: { label: 'Service promo', body: 'A service, what it includes, a starting price and how to book.', needs: 'A headline and a contact.' },
};

/** A first instrumental bed per template (the director can change it before generating). */
export const POSTER_MUSIC_PROMPTS: Record<PosterTemplate, string> = {
  product_hero: 'Warm, bright, modern instrumental bed for a 30 second product advert. Light Afro-pop guitar and soft percussion, steady mid tempo, optimistic. Strictly instrumental, no vocals, no humming.',
  price_list: 'Friendly, upbeat instrumental bed for a 30 second shop advert listing prices. Clean marimba and light percussion, steady tempo, uncluttered so a voice sits clearly on top. Strictly instrumental, no vocals.',
  event: 'Uplifting, confident instrumental bed for a 30 second event announcement. Soft synth pads, gentle kick and claps building slightly, celebratory but calm under a voice. Strictly instrumental, no vocals.',
  service_promo: 'Calm, trustworthy corporate instrumental bed for a 30 second service advert. Soft piano and light pulse, warm and professional, leaves room for a voice. Strictly instrumental, no vocals.',
};

// ---------------------------------------------------------------------------
// Spoken forms (the voice says numbers in words; the screen shows the figures)
// ---------------------------------------------------------------------------

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
/** "450" GH₵ → "four hundred and fifty Ghana cedis"; "12.50" $ → "twelve dollars fifty". */
export function spokenPrice(price: string, currency: string): string {
  const [int = '0', frac = ''] = price.replace(/,/g, '').split('.');
  const word = currencyWord(currency);
  const major = word === 'cedis' ? 'Ghana cedis' : word;
  const cents = frac ? Number(frac.padEnd(2, '0')) : 0;
  return `${numberToWords(Number(int))}${major ? ` ${major}` : ''}${cents ? ` ${numberToWords(cents)}` : ''}`;
}

/** "054 216 1486" → "zero five four, two one six, one four eight six" (the groups as written). */
export function spokenPhone(value: string): string {
  const plus = value.trim().startsWith('+');
  const groups = value.replace(/[^\d\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
  const said = groups.map((g) => [...g].map((d) => ONES[Number(d)]).join(' ')).join(', ');
  return plus ? `plus ${said}` : said;
}

export function contactLine(c: Pick<PosterContact, 'kind' | 'value'>): string {
  const v = c.value.trim();
  if (c.kind === 'phone') return `Call ${v}`;
  if (c.kind === 'whatsapp') return `WhatsApp ${v}`;
  return v;
}

function spokenContact(c: Pick<PosterContact, 'kind' | 'value'>): string {
  const v = c.value.trim();
  if (c.kind === 'phone') return `Call ${spokenPhone(v)}`;
  if (c.kind === 'whatsapp') return `WhatsApp ${spokenPhone(v)}`;
  if (c.kind === 'email') return `Email ${v.replace('@', ' at ')}`;
  if (c.kind === 'website') return `Visit ${v.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  if (c.kind === 'social') return `Follow ${v}`;
  return `Find us at ${v}`;
}

export const priceLine = (p: Pick<PosterPrice, 'item' | 'price' | 'currency' | 'unit'>) => [p.item.trim(), formatPrice(p.currency, p.price), p.unit.trim()].filter(Boolean).join(' ');
const spokenPriceLine = (p: Pick<PosterPrice, 'item' | 'price' | 'currency' | 'unit'>) => [p.item.trim(), spokenPrice(p.price, p.currency), p.unit.trim()].filter(Boolean).join(', ');

// ---------------------------------------------------------------------------
// The form as the ad's facts
// ---------------------------------------------------------------------------

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
/** A spoken line never carries a colon (the voice reads it as a pause or says it). */
const sayable = (s: string) => flat(s.replace(/:/g, ',')).replace(/[,\s]+$/, '');
const sentence = (s: string) => {
  const t = sayable(s);
  return !t ? '' : /[.!?]$/.test(t) ? t : `${t}.`;
};

interface FormFact {
  id: string;
  kind: FactKind;
  text: string;
  kit: { kitId: string; entryId: string; reviewBy: string } | null;
}

/** Facts the poster form states, with stable ids (an unchanged field keeps its id and therefore its confirmation). */
export function posterFormFacts(poster: PosterForm, kitId: string | null): FormFact[] {
  const out: FormFact[] = [];
  const kit = (entryId: string | null, reviewBy: string | null) => (kitId && entryId && reviewBy ? { kitId, entryId, reviewBy } : null);
  if (flat(poster.headline)) out.push({ id: 'pf_headline', kind: 'product_name', text: flat(poster.headline), kit: null });
  if (flat(poster.subhead)) out.push({ id: 'pf_subhead', kind: 'description', text: flat(poster.subhead), kit: null });
  if (flat(poster.offer)) out.push({ id: 'pf_offer', kind: 'offer', text: flat(poster.offer), kit: null });
  for (const p of poster.prices) out.push({ id: `pf_p_${p.id}`.slice(0, 80), kind: 'price', text: priceLine(p), kit: kit(p.kitEntryId, p.reviewBy) });
  for (const c of poster.contacts) if (flat(c.value)) out.push({ id: `pf_c_${c.id}`.slice(0, 80), kind: c.kind === 'website' || c.kind === 'social' ? 'destination' : c.kind === 'address' ? 'location' : 'contact', text: contactLine(c), kit: kit(c.kitEntryId, c.reviewBy) });
  if (flat(poster.date) || flat(poster.time)) out.push({ id: 'pf_date', kind: 'date', text: [flat(poster.date), flat(poster.time)].filter(Boolean).join(', '), kit: null });
  if (flat(poster.place)) out.push({ id: 'pf_place', kind: 'location', text: flat(poster.place), kit: null });
  return out;
}

/** Replaces the form's facts among the director facts (the director's other notes and the kit's name stay). */
export function syncPosterFacts(doc: LinkAdDoc, now = Date.now()): LinkAdDoc {
  if (!doc.poster) return doc;
  const keep = doc.userFacts.filter((f) => !f.id.startsWith('pf_'));
  const before = new Map(doc.userFacts.map((f) => [f.id, f]));
  const form: UserFact[] = posterFormFacts(doc.poster, doc.brandKit?.kitId ?? null).map((f) => {
    const prev = before.get(f.id);
    return { id: f.id, kind: f.kind, text: f.text.slice(0, 400), at: prev && prev.text === f.text ? prev.at : now, kit: f.kit };
  });
  const userFacts = [...keep, ...form].slice(0, 40);
  const known = new Set(userFacts.map((f) => f.id));
  // A confirmation of a field that no longer exists goes with it.
  const confirmations = Object.fromEntries(Object.entries(doc.confirmations).filter(([k]) => !k.startsWith('pf_') || known.has(k)));
  return { ...doc, userFacts, confirmations };
}

/** Hash of the form's wording (what the script was built from). */
export function posterFormHash(poster: PosterForm): string {
  return stableHash(['pf1', poster.template, posterFormFacts(poster, null).map((f) => [f.id, f.text]), flat(poster.cta), poster.photoIds]);
}

// ---------------------------------------------------------------------------
// The first script (deterministic, no model)
// ---------------------------------------------------------------------------

export interface PosterScript {
  scenes: AdScene[];
  closing: AdClosing;
  brief: Partial<LinkAdBrief>;
  title: string;
}

const sceneOf = (id: string, role: AdScene['role'], narration: string, overlay: string, assetId: string | null, motion: AdScene['motion'], factIds: string[]): AdScene => ({
  id,
  role,
  narration: narration.slice(0, 420),
  overlay: flat(overlay).slice(0, 70),
  overlayPos: 'upper',
  assetId,
  focal: { x: 0.5, y: 0.5 },
  motion,
  factIds: factIds.slice(0, 8),
  factStamp: {},
  review: null,
});

/**
 * Writes the motion ad from the form: hook → offer / details → call to action, each scene on a real photo where the
 * form has one (the closing is text-led so the call to action reads), every figure spoken in words and shown in
 * figures. Scene ids are fixed per role, so rebuilding after a small change keeps the recordings of unchanged lines.
 */
export function buildPosterScript(doc: LinkAdDoc): PosterScript {
  const poster = doc.poster!;
  const stored = new Set(doc.source.assets.filter((a) => a.status === 'stored').map((a) => a.id));
  const photos = poster.photoIds.filter((x) => stored.has(x));
  const photo = (i: number) => photos[i] ?? photos[0] ?? null;
  const facts = new Map(posterFormFacts(poster, null).map((f) => [f.id, f]));
  const has = (fid: string) => (facts.has(fid) ? [fid] : []);
  const priceIds = poster.prices.map((p) => `pf_p_${p.id}`.slice(0, 80));
  const contacts = poster.contacts.filter((c) => flat(c.value));
  const contactIds = contacts.map((c) => `pf_c_${c.id}`.slice(0, 80));
  const headline = flat(poster.headline);
  const sub = flat(poster.subhead);
  const cta = flat(poster.cta) || (poster.template === 'event' ? 'Register today' : poster.template === 'service_promo' ? 'Book today' : 'Order today');
  const scenes: AdScene[] = [];

  scenes.push(sceneOf('ps_hook', 'hook', [sentence(headline), sentence(sub)].filter(Boolean).join(' '), headline, photo(0), 'push_in', [...has('pf_headline'), ...has('pf_subhead')]));

  const pricesScene = (list: PosterPrice[], idx: number) => {
    const ids = list.map((p) => `pf_p_${p.id}`.slice(0, 80));
    const said = list.map((p) => sentence(spokenPriceLine(p))).join(' ');
    const shown = list.map(priceLine).join(' · ');
    return sceneOf(`ps_price_${idx}`, 'offer', said, shown.length <= 70 ? shown : priceLine(list[0]!), photo(1 + idx), idx % 2 ? 'pan_left' : 'pan_right', ids);
  };

  if (poster.template === 'price_list') {
    // Two prices per scene when they fit on screen together, at most four price scenes.
    const groups: PosterPrice[][] = [];
    for (const p of poster.prices) {
      const last = groups[groups.length - 1];
      if (last && last.length < 2 && [...last, p].map(priceLine).join(' · ').length <= 70) last.push(p);
      else groups.push([p]);
    }
    groups.slice(0, 4).forEach((g, i) => scenes.push(pricesScene(g, i)));
    if (flat(poster.offer)) scenes.push(sceneOf('ps_offer', 'detail', sentence(poster.offer), poster.offer, photo(2), 'push_in', has('pf_offer')));
  } else if (poster.template === 'event') {
    const when = [flat(poster.date), flat(poster.time)].filter(Boolean).join(', ');
    const where = flat(poster.place);
    if (when || where) scenes.push(sceneOf('ps_when', 'detail', sentence([when, where ? `at ${where}` : ''].filter(Boolean).join(', ')), [when, where].filter(Boolean).join(' · '), photo(1), 'pan_right', [...has('pf_date'), ...has('pf_place')]));
    if (flat(poster.offer)) scenes.push(sceneOf('ps_offer', 'detail', sentence(poster.offer), poster.offer, photo(2), 'push_in', has('pf_offer')));
    if (poster.prices.length) scenes.push(pricesScene(poster.prices.slice(0, 2), 0));
  } else {
    // Product hero and service promo: the price (from), then the offer line.
    if (poster.prices.length) scenes.push(pricesScene(poster.prices.slice(0, 2), 0));
    if (flat(poster.offer)) scenes.push(sceneOf('ps_offer', 'detail', sentence(poster.offer), poster.offer, photo(2), 'push_in', has('pf_offer')));
    if (poster.template === 'service_promo' && flat(poster.place)) scenes.push(sceneOf('ps_place', 'detail', sentence(`Find us at ${poster.place}`), poster.place, photo(2), 'pan_left', has('pf_place')));
  }

  const spokenContacts = contacts.slice(0, 2).map((c) => sentence(spokenContact(c))).join(' ');
  scenes.push(sceneOf('ps_cta', 'cta', [sentence(cta), spokenContacts].filter(Boolean).join(' '), '', null, 'still', contactIds.slice(0, 2)));
  const closing: AdClosing = { headline: cta.slice(0, 70), line: contacts.slice(0, 2).map(contactLine).join(' · ').slice(0, 120), showLogo: true };

  const first = contacts[0];
  const brief: Partial<LinkAdBrief> = {
    focus: (headline || 'Your offer').slice(0, 240),
    message: sub.slice(0, 240),
    action: cta.slice(0, 120),
    destination: first ? { kind: first.kind === 'phone' || first.kind === 'whatsapp' ? 'phone' : first.kind === 'email' ? 'email' : first.kind === 'website' ? 'url' : 'text', value: first.value.trim().slice(0, 300), factId: contactIds[0] ?? null } : { kind: 'text', value: '', factId: null },
    logoId: doc.brief.logoId,
    imageIds: photos,
    usedFactIds: [...facts.keys(), ...priceIds, ...contactIds].filter((v, i, a) => a.indexOf(v) === i).slice(0, 40),
    origin: 'manual',
  };
  const withStamps = scenes.slice(0, 8).map((s) => ({ ...s, factStamp: stampFor(doc, s.factIds) }));
  return { scenes: withStamps, closing, brief, title: headline || 'Motion poster ad' };
}

// ---------------------------------------------------------------------------
// Layout (pixels of the chosen format)
// ---------------------------------------------------------------------------

export interface PosterBrand {
  primary: string;
  background: string;
  accent: string;
  text: string;
}

export type PosterItem =
  | { kind: 'rect'; id: string; x: number; y: number; w: number; h: number; fill: string; radius: number; opacity: number }
  | { kind: 'image'; id: string; x: number; y: number; w: number; h: number; assetId: string; fit: 'cover' | 'contain'; focal: { x: number; y: number }; radius: number }
  | { kind: 'text'; id: string; role: string; x: number; y: number; w: number; h: number; lines: string[]; baselines: number[]; family: string; weight: number; sizePx: number; color: string; align: 'left' | 'center' | 'right' };

export interface PosterLayoutIssue {
  severity: 'error' | 'warning';
  field: string;
  message: string;
}

export interface PosterLayout {
  format: PosterFormatId;
  width: number;
  height: number;
  background: string;
  items: PosterItem[];
  issues: PosterLayoutIssue[];
  /** Every text drawn, in reading order (for the fact check). */
  texts: string[];
}

export interface PosterLayoutInput {
  poster: PosterForm;
  brand: PosterBrand;
  format: PosterFormatId;
  /** Studio asset ids of the photos and logo (null = not available yet). */
  photoAssetIds: string[];
  logoAssetId: string | null;
  measure: MeasureText;
}

interface Font {
  family: string;
  weight: number;
}

/** Splits text into lines no wider than `maxW`; a single word wider than the line stays whole (and is reported). */
export function wrapLines(textIn: string, font: Font, sizePx: number, maxW: number, measure: MeasureText): { lines: string[]; overflow: boolean } {
  const words = flat(textIn).split(' ').filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  let overflow = false;
  const width = (t: string) => measure(t, { family: font.family, weight: font.weight, italic: false, sizePx, letterSpacingPx: 0 }).width;
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (width(next) <= maxW || !cur) {
      if (!cur && width(w) > maxW) overflow = true;
      cur = next;
    } else {
      lines.push(cur);
      cur = w;
      if (width(w) > maxW) overflow = true;
    }
  }
  if (cur) lines.push(cur);
  return { lines, overflow };
}

interface TextSpec {
  id: string;
  role: string;
  field: string;
  text: string;
  font: Font;
  size: number;
  min: number;
  maxLines: number;
  color: string;
  align: 'left' | 'center' | 'right';
}

const LH = 1.14;

/** Fits text at the largest size from `size` down to `min` that keeps within `maxLines`. */
function fitText(spec: TextSpec, maxW: number, scale: number, measure: MeasureText): { lines: string[]; size: number; ok: boolean } {
  const start = Math.max(spec.min, spec.size * scale);
  for (let s = start; s >= spec.min - 0.01; s -= Math.max(1, s * 0.04)) {
    const r = wrapLines(spec.text, spec.font, s, maxW, measure);
    if (r.lines.length <= spec.maxLines && !r.overflow) return { lines: r.lines, size: Math.round(s * 10) / 10, ok: true };
  }
  const r = wrapLines(spec.text, spec.font, spec.min, maxW, measure);
  return { lines: r.lines, size: spec.min, ok: false };
}

const blockH = (lines: number, size: number) => (lines ? size * (1 + (lines - 1) * LH) + size * 0.24 : 0);

/**
 * Lays out the poster for one format: a stack of blocks from the top (logo, headline, subhead, date block, prices,
 * offer), a photo that takes the room left (within limits), and the contacts and call-to-action bar anchored at the
 * bottom. Text is wrapped with the measured widths and shrunk to fit; anything that still does not fit is an error
 * (a poster never silently drops or cuts a fact).
 */
export function layoutPoster(input: PosterLayoutInput): PosterLayout {
  const { poster, brand, measure } = input;
  const fmt = POSTER_FORMATS[input.format];
  const W = fmt.width;
  const H = fmt.height;
  const m = Math.round(W * 0.065);
  const innerW = W - 2 * m;
  const tall = H / W;
  const heading: Font = { family: drawingFamily(poster.fonts.heading), weight: 700 };
  const body: Font = { family: drawingFamily(poster.fonts.body), weight: 400 };
  const bodyBold: Font = { family: body.family, weight: 600 };
  const issues: PosterLayoutIssue[] = [];
  const issue = (severity: PosterLayoutIssue['severity'], field: string, message: string) => issues.push({ severity, field, message });
  const tpl = poster.template;
  const photoId = input.photoAssetIds[0] ?? null;
  const bleed = tpl === 'product_hero' || tpl === 'event';
  const onAccent = readableOn(brand.accent);

  // ---- What goes on the poster ----
  const top: TextSpec[] = [];
  if (flat(poster.headline)) top.push({ id: 'headline', role: 'headline', field: 'headline', text: flat(poster.headline), font: heading, size: W * (tpl === 'price_list' ? 0.085 : 0.095), min: W * 0.05, maxLines: 3, color: brand.text, align: 'left' });
  else issue('error', 'headline', 'Write a headline.');
  if (flat(poster.subhead)) top.push({ id: 'subhead', role: 'subhead', field: 'subhead', text: flat(poster.subhead), font: body, size: W * 0.042, min: W * 0.03, maxLines: 3, color: brand.text, align: 'left' });
  const when = [flat(poster.date), flat(poster.time)].filter(Boolean).join(' · ');
  if (tpl === 'event' && when) top.push({ id: 'when', role: 'date', field: 'date', text: when, font: heading, size: W * 0.062, min: W * 0.04, maxLines: 2, color: brand.accent, align: 'left' });
  if (tpl === 'event' && flat(poster.place)) top.push({ id: 'place', role: 'place', field: 'place', text: flat(poster.place), font: bodyBold, size: W * 0.04, min: W * 0.03, maxLines: 2, color: brand.text, align: 'left' });
  if (tpl !== 'event' && tpl !== 'price_list' && flat(poster.place)) top.push({ id: 'place', role: 'place', field: 'place', text: flat(poster.place), font: body, size: W * 0.034, min: W * 0.028, maxLines: 2, color: brand.text, align: 'left' });
  const offerSpec: TextSpec | null = flat(poster.offer) ? { id: 'offer', role: 'offer', field: 'offer', text: flat(poster.offer), font: bodyBold, size: W * 0.044, min: W * 0.032, maxLines: 2, color: brand.accent, align: 'left' } : null;
  const contacts = poster.contacts.filter((c) => flat(c.value));
  const contactSpec: TextSpec | null = contacts.length ? { id: 'contacts', role: 'contacts', field: 'contacts', text: contacts.map(contactLine).join('  ·  '), font: bodyBold, size: W * 0.036, min: W * 0.027, maxLines: 3, color: brand.text, align: 'center' } : null;
  const cta = flat(poster.cta);
  if (!contacts.length) issue('warning', 'contacts', 'No contact: say how people order or book.');
  if (tpl === 'price_list' && !poster.prices.length) issue('error', 'prices', 'A price list needs at least one price.');
  if (tpl === 'event' && !flat(poster.date)) issue('error', 'date', 'An event poster needs its date.');
  if (tpl === 'event' && !flat(poster.place)) issue('error', 'place', 'An event poster needs its place.');
  if ((tpl === 'product_hero' || tpl === 'event') && !photoId) issue('warning', 'photos', 'No photo yet: a real photo of the product, place or people sells far better than type alone.');

  const priceRows = tpl === 'price_list' ? poster.prices : tpl === 'service_promo' ? poster.prices.slice(0, 3) : [];
  const badgePrice = tpl === 'product_hero' || tpl === 'event' ? poster.prices[0] ?? null : null;
  if (tpl === 'product_hero' && poster.prices.length > 1) issue('warning', 'prices', 'Only the first price fits on a product-hero poster. Use the price list template for several.');

  // ---- Fit everything at one scale ----
  const gap = Math.round(W * 0.028);
  const ctaH = cta ? Math.round(W * 0.12) : 0;
  const logoH = input.logoAssetId ? Math.round(W * (tall > 1.6 ? 0.11 : 0.095)) : 0;
  const photoMax = H * (bleed ? (tall > 1.6 ? 0.52 : tall > 1.1 ? 0.5 : 0.44) : tall > 1.6 ? 0.34 : 0.28);
  const photoMin = H * (bleed ? 0.3 : 0.16);
  let scale = 1;
  let fitted: { spec: TextSpec; lines: string[]; size: number; ok: boolean }[] = [];
  let rows: { item: string[]; price: string; size: number; ok: boolean }[] = [];
  let photoH = 0;
  let fixed = 0;
  for (; scale >= 0.7; scale -= 0.05) {
    const specs = [...top, ...(offerSpec ? [offerSpec] : []), ...(contactSpec ? [contactSpec] : [])];
    fitted = specs.map((spec) => ({ spec, ...fitText(spec, innerW, scale, measure) }));
    const rowSize = Math.max(W * 0.032, W * (priceRows.length > 5 ? 0.04 : 0.048) * scale);
    rows = priceRows.map((p) => {
      const price = formatPrice(p.currency, p.price);
      const pw = measure(price, { family: heading.family, weight: 700, italic: false, sizePx: rowSize, letterSpacingPx: 0 }).width;
      const itemText = [p.item.trim(), p.unit.trim()].filter(Boolean).join(' ');
      const w = wrapLines(itemText, body, rowSize, innerW - pw - W * 0.04, measure);
      return { item: w.lines, price, size: rowSize, ok: w.lines.length <= 2 && !w.overflow };
    });
    const textH = fitted.reduce((a, f) => a + blockH(f.lines.length, f.size), 0) + fitted.length * gap;
    const rowsH = rows.reduce((a, r) => a + r.size * (1 + (Math.max(1, r.item.length) - 1) * LH) + r.size * 0.9, 0) + (rows.length ? gap : 0);
    fixed = textH + rowsH + (ctaH ? ctaH + gap : 0) + (!bleed && logoH ? logoH + gap : 0) + 2 * m + (bleed ? gap : 0);
    const room = H - fixed;
    photoH = photoId ? Math.min(photoMax, room) : 0;
    if ((!photoId || photoH >= photoMin) && fitted.every((f) => f.ok) && rows.every((r) => r.ok) && room >= 0) break;
  }
  scale = Math.max(0.7, scale);
  for (const f of fitted) if (!f.ok) issue('error', f.spec.field, `The ${f.spec.role} is too long for the ${input.format} poster. Shorten it.`);
  rows.forEach((r, i) => !r.ok && issue('error', 'prices', `Price ${i + 1} (“${priceRows[i]!.item}”) is too long to fit next to its price. Shorten the item name.`));
  if (photoId && photoH < photoMin) {
    issue(photoH <= 0 ? 'error' : 'warning', 'photos', photoH <= 0 ? `There is no room left for the photo on the ${input.format} poster. Shorten the text or remove a price.` : `The photo is small on the ${input.format} poster because there is a lot of text.`);
    photoH = Math.max(0, photoH);
  }
  if (H - fixed - photoH < -1) issue('error', 'layout', `The text does not fit on the ${input.format} poster. Shorten it or remove a line.`);

  // ---- Place ----
  const items: PosterItem[] = [{ kind: 'rect', id: 'ground', x: 0, y: 0, w: W, h: H, fill: brand.background, radius: 0, opacity: 1 }];
  const texts: string[] = [];
  const addText = (id: string, role: string, x: number, y: number, w: number, lines: string[], font: Font, sizePx: number, color: string, align: 'left' | 'center' | 'right') => {
    const baselines = lines.map((_, i) => Math.round((y + sizePx * 0.9 + i * sizePx * LH) * 10) / 10);
    const h = blockH(lines.length, sizePx);
    items.push({ kind: 'text', id, role, x, y, w, h, lines, baselines, family: font.family, weight: font.weight, sizePx, color, align });
    texts.push(lines.join(' '));
    return h;
  };
  let y = m;
  let photoBox: { x: number; y: number; w: number; h: number } | null = null;
  if (bleed && photoId && photoH > 0) {
    photoBox = { x: 0, y: 0, w: W, h: Math.round(photoH + m) };
    items.push({ kind: 'image', id: 'photo', ...photoBox, assetId: photoId, fit: 'cover', focal: poster.focal, radius: 0 });
    // A band of the brand colour where the photo meets the text, so the headline never sits on a busy picture.
    items.push({ kind: 'rect', id: 'band', x: 0, y: photoBox.h - Math.round(W * 0.012), w: W, h: Math.round(W * 0.012), fill: brand.primary, radius: 0, opacity: 1 });
    y = photoBox.h + gap;
  }
  if (input.logoAssetId) {
    if (bleed && photoBox) {
      // Logo on a plate of the brand colour over the photo's top-left corner.
      const pw = Math.round(W * 0.3);
      items.push({ kind: 'rect', id: 'logo_plate', x: m - Math.round(W * 0.02), y: m - Math.round(W * 0.02), w: pw + Math.round(W * 0.04), h: logoH + Math.round(W * 0.04), fill: brand.background, radius: Math.round(W * 0.025), opacity: 0.92 });
      items.push({ kind: 'image', id: 'logo', x: m, y: m, w: pw, h: logoH, assetId: input.logoAssetId, fit: 'contain', focal: { x: 0, y: 0.5 }, radius: 0 });
    } else {
      items.push({ kind: 'image', id: 'logo', x: m, y, w: Math.round(W * 0.34), h: logoH, assetId: input.logoAssetId, fit: 'contain', focal: { x: 0, y: 0.5 }, radius: 0 });
      y += logoH + gap;
    }
  }
  const byId = new Map(fitted.map((f) => [f.spec.id, f]));
  for (const spec of top) {
    const f = byId.get(spec.id)!;
    y += addText(spec.id, spec.role, m, y, innerW, f.lines, spec.font, f.size, spec.color, spec.align) + gap;
  }
  if (!bleed && photoId && photoH > 0) {
    photoBox = { x: m, y, w: innerW, h: Math.round(photoH) };
    items.push({ kind: 'image', id: 'photo', ...photoBox, assetId: photoId, fit: 'cover', focal: poster.focal, radius: Math.round(W * 0.03) });
    y += photoBox.h + gap;
  }
  rows.forEach((r, i) => {
    const rowH = r.size * (1 + (Math.max(1, r.item.length) - 1) * LH);
    addText(`price_item_${i}`, 'price item', m, y, innerW - W * 0.25, r.item, body, r.size, brand.text, 'left');
    items.push({ kind: 'text', id: `price_${i}`, role: 'price', x: m, y, w: innerW, h: rowH, lines: [r.price], baselines: [Math.round((y + r.size * 0.9) * 10) / 10], family: heading.family, weight: 700, sizePx: r.size, color: brand.accent, align: 'right' });
    texts.push(r.price);
    y += rowH + r.size * 0.45;
    if (i < rows.length - 1) items.push({ kind: 'rect', id: `rule_${i}`, x: m, y: Math.round(y - r.size * 0.2), w: innerW, h: Math.max(2, Math.round(W * 0.002)), fill: brand.text, radius: 0, opacity: 0.18 });
    y += r.size * 0.45;
  });
  if (rows.length) y += gap;
  const offerFit = offerSpec ? byId.get('offer')! : null;
  if (offerSpec && offerFit) y += addText('offer', 'offer', m, y, innerW, offerFit.lines, offerSpec.font, offerFit.size, offerSpec.color, 'left') + gap;

  // Bottom: contacts above the call-to-action bar.
  let bottom = H - m;
  if (cta) {
    const bar = { x: m, y: bottom - ctaH, w: innerW, h: ctaH };
    items.push({ kind: 'rect', id: 'cta_bar', ...bar, fill: brand.accent, radius: Math.round(ctaH / 2), opacity: 1 });
    const fit = fitText({ id: 'cta', role: 'call to action', field: 'cta', text: cta, font: heading, size: ctaH * 0.42, min: ctaH * 0.28, maxLines: 1, color: onAccent, align: 'center' }, innerW - ctaH, 1, measure);
    if (!fit.ok) issue('error', 'cta', 'The call to action is too long for its button. Shorten it.');
    addText('cta', 'call to action', m, bar.y + (ctaH - fit.size * 1.14) / 2, innerW, fit.lines, heading, fit.size, onAccent, 'center');
    bottom = bar.y - gap;
    if (contrastRatio(onAccent, brand.accent) < 4.5) issue('warning', 'colours', 'The call-to-action text is hard to read on the accent colour.');
  }
  const contactFit = contactSpec ? byId.get('contacts')! : null;
  if (contactSpec && contactFit) {
    const h = blockH(contactFit.lines.length, contactFit.size);
    const cy = bottom - h;
    if (cy < y - 1) issue('error', 'layout', `The contacts collide with the text above them on the ${input.format} poster. Shorten the text.`);
    addText('contacts', 'contacts', m, cy, innerW, contactFit.lines, contactSpec.font, contactFit.size, contactSpec.color, 'center');
    bottom = cy - gap;
  }
  if (y > bottom + gap + 1 && !issues.some((i) => i.field === 'layout')) issue('error', 'layout', `The poster's text runs into its contacts or button on the ${input.format} format. Shorten it.`);

  // Price badge over the photo (product hero, event).
  if (badgePrice && photoBox) {
    const price = formatPrice(badgePrice.currency, badgePrice.price);
    const size = W * 0.07;
    const pw = measure(price, { family: heading.family, weight: 700, italic: false, sizePx: size, letterSpacingPx: 0 }).width;
    const label = [badgePrice.item.trim(), badgePrice.unit.trim()].filter(Boolean).join(' ');
    const ls = W * 0.03;
    const lw = label ? wrapLines(label, bodyBold, ls, W * 0.36, measure) : { lines: [], overflow: false };
    const bw = Math.min(W * 0.46, Math.max(pw, ...lw.lines.map((l) => measure(l, { family: bodyBold.family, weight: 600, italic: false, sizePx: ls, letterSpacingPx: 0 }).width)) + W * 0.06);
    const bh = size * 1.25 + (lw.lines.length ? blockH(Math.min(2, lw.lines.length), ls) : 0) + W * 0.03;
    const bx = W - m - bw;
    const by = photoBox.y + photoBox.h - bh - m * 0.6;
    if (pw > bw) issue('error', 'prices', 'The price is too wide for its badge.');
    items.push({ kind: 'rect', id: 'badge', x: bx, y: by, w: bw, h: bh, fill: brand.accent, radius: Math.round(W * 0.03), opacity: 1 });
    if (lw.lines.length) addText('badge_item', 'price item', bx, by + W * 0.02, bw, lw.lines.slice(0, 2), bodyBold, ls, onAccent, 'center');
    addText('badge_price', 'price', bx, by + bh - size * 1.2 - W * 0.012, bw, [price], heading, size, onAccent, 'center');
  }

  const tb = contrastRatio(brand.text, brand.background);
  if (tb < 4.5) issue('error', 'colours', `Text on the background colour is hard to read (contrast ${tb}:1).`);
  if (contrastRatio(brand.accent, brand.background) < 3) issue('warning', 'colours', 'The accent colour (prices, offer) is faint on the background colour.');
  return { format: input.format, width: W, height: H, background: brand.background, items, issues, texts };
}

// ---------------------------------------------------------------------------
// Currency of saved posters and the checks before export
// ---------------------------------------------------------------------------

/** What a poster drawing depends on: the form, the brand colours and fonts, the photo and logo files, the format. */
export function posterInputHash(doc: Pick<LinkAdDoc, 'poster' | 'ad' | 'source' | 'brief'>, format: PosterFormatId): string {
  const p = doc.poster;
  if (!p) return 'none';
  const files = new Map(doc.source.assets.map((a) => [a.id, a.assetId]));
  const brand = doc.ad.brand;
  return stableHash(['pl1', format, { ...p, exports: undefined, scriptFor: undefined, formats: undefined }, [brand.primary, brand.background, brand.accent, brand.text], p.photoIds.map((x) => files.get(x) ?? null), doc.brief.logoId ? files.get(doc.brief.logoId) ?? null : null]);
}

export interface PosterIssue {
  severity: 'error' | 'warning';
  message: string;
}

/** Studio asset ids of the form's photos (in order) and the logo, when stored. */
export function posterFiles(doc: Pick<LinkAdDoc, 'poster' | 'source' | 'brief'>): { photos: string[]; logo: string | null } {
  const byId = new Map(doc.source.assets.filter((a) => a.status === 'stored' && a.assetId).map((a) => [a.id, a]));
  const photos = (doc.poster?.photoIds ?? []).map((x) => byId.get(x)?.assetId).filter((x): x is string => Boolean(x));
  const logo = doc.brief.logoId ? byId.get(doc.brief.logoId)?.assetId ?? null : null;
  return { photos, logo };
}

/** Brand-kit facts of the ad that are past their review-by day. */
export function staleKitFacts(doc: Pick<LinkAdDoc, 'source' | 'userFacts'>, today = todayKey()) {
  return allFacts(doc).filter((f) => f.reviewBy && reviewState(f.reviewBy, today) === 'overdue');
}

/**
 * Everything that blocks (errors) or deserves a look before a poster is saved: the form's own requirements, stale
 * brand-kit prices and contacts, unconfirmed prices/dates/offers, unsupported claims, figures that do not match
 * the approved facts (the same check the final cut gets), photo rights and colour contrast. Layout fit is checked
 * by `layoutPoster` with the real fonts in the browser.
 */
export function posterReadiness(doc: LinkAdDoc, today = todayKey()): PosterIssue[] {
  const out: PosterIssue[] = [];
  const p = doc.poster;
  if (!p) return [{ severity: 'error', message: 'This ad has no poster form.' }];
  const add = (severity: PosterIssue['severity'], message: string) => out.push({ severity, message });
  if (!flat(p.headline)) add('error', 'Write a headline.');
  for (const f of staleKitFacts(doc, today)) add('error', `“${f.text.slice(0, 80)}” comes from the brand kit and was due for re-confirmation on ${f.reviewBy}. Re-confirm it in the brand kit, then apply the kit again.`);
  const facts = allFacts(doc).filter((f) => f.id.startsWith('pf_'));
  for (const f of facts) if (f.needsConfirmation && !isConfirmed(doc, f)) add('error', `Confirm “${f.text.slice(0, 80)}” is current before it goes on the poster.`);
  const all = allFacts(doc);
  const seen = new Set<string>();
  // A line is checked against the other facts: the headline cannot vouch for a price or a "best in town" in itself.
  for (const [label, t, own] of [['Headline', p.headline, 'pf_headline'], ['Subhead', p.subhead, 'pf_subhead'], ['Offer', p.offer, 'pf_offer'], ['Call to action', p.cta, '']] as const) {
    for (const c of checkClaims(t, all.filter((f) => f.id !== own), (f) => isConfirmed(doc, f))) {
      if (c.kind === 'unconfirmed_fact' || seen.has(c.match)) continue;
      seen.add(c.match);
      add(c.severity, `${label}: ${c.message.replace('The website you gave does not say it', 'None of your facts says it').replace('is not in the website or your own facts', 'is not one of your facts')}`);
    }
  }
  for (const c of posterFactChecks(doc)) add(c.severity, c.message);
  const byId = new Map(doc.source.assets.map((a) => [a.id, a]));
  p.photoIds.forEach((pid, i) => {
    const a = byId.get(pid);
    if (!a || a.status !== 'stored') add('error', `Photo ${i + 1} is not available. Choose another.`);
    else if (a.rights !== 'confirmed') add('error', `Photo ${i + 1} needs your confirmation that you may use it.`);
    else if (a.needsReview && !a.reviewed) add('error', `Photo ${i + 1} was made or changed by AI. Look at it and mark it reviewed first.`);
    else if (!a.real && a.origin === 'generated') add('warning', `Photo ${i + 1} is AI-made. Real photos of the real product are more trustworthy.`);
  });
  const logo = doc.brief.logoId ? byId.get(doc.brief.logoId) : null;
  if (logo && logo.rights !== 'confirmed') add('error', 'The logo needs your confirmation that you may use it.');
  const b = doc.ad.brand;
  if (contrastRatio(b.text, b.background) < 4.5) add('error', `Text on the background colour is hard to read (contrast ${contrastRatio(b.text, b.background)}:1).`);
  return out;
}

/** The approved-facts check on the poster's texts plus the motion ad's screen text and recorded voice. */
export function posterFactChecks(doc: LinkAdDoc, extraTexts: readonly string[] = []): FactCheck[] {
  const p = doc.poster;
  return linkAdFactChecks(doc, [...(p ? [p.headline, p.subhead, p.offer, p.cta] : []), ...extraTexts]);
}

/** Stale approved facts (kit prices and contacts past review-by) of a Link to Ad or poster ad. */
export function staleLinkAdFacts(doc: LinkAdDoc, today = todayKey()) {
  return staleApprovedFacts(factsFromLinkAd(doc), today);
}

/** A fresh local id for a price or contact row. */
export const posterRowId = (prefix: 'p' | 'c') => newId(prefix);

export const contactKindLabel = (k: PosterContact['kind']) => KIT_CONTACT_LABELS[k];

export type { KitFont };
