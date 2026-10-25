import { parse } from 'parse5';
import { resolveRef, sameSite, stableHash, stripInstructionLines, type FactConflict, type FactKind, type SourceFact } from '@az-studio/shared';

/**
 * Link to Ad: turns one page of HTML into sourced facts, picture candidates and links to related pages.
 * Pure (no network, no model): the same HTML always gives the same result, each fact keeps the page it came from
 * and the excerpt that supports it, and nothing is inferred beyond what the page literally says.
 */

type Node = { nodeName: string; tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: Node[]; content?: Node; value?: string; data?: string };

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe', 'object', 'canvas', 'select', 'option', 'button', 'textarea']);
const BLOCK = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'dd', 'dt', 'blockquote', 'figcaption', 'address', 'div', 'section', 'article', 'main', 'tr', 'ul', 'ol', 'dl', 'table', 'header', 'footer', 'nav', 'aside', 'form', 'details', 'summary', 'caption', 'br', 'hr']);
const NAV_TAGS = new Set(['nav', 'aside', 'menu']);

const attr = (n: Node, name: string) => n.attrs?.find((a) => a.name === name)?.value ?? '';
const children = (n: Node): Node[] => (n.nodeName === 'template' && n.content ? n.content.childNodes ?? [] : n.childNodes ?? []);
const ws = (s: string) => s.replace(/\s+/g, ' ').trim();

export interface TextBlock {
  text: string;
  tag: string;
  zone: 'main' | 'nav' | 'footer' | 'header';
  /** Nearest heading above the block. */
  heading: string;
}

export interface ImageCandidate {
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  role: 'logo' | 'image';
  score: number;
  from: string;
}

export interface PageLink {
  url: string;
  text: string;
}

export interface ExtractedPage {
  url: string;
  title: string;
  siteName: string;
  description: string;
  lang: string;
  canonical: string | null;
  themeColor: string | null;
  blocks: TextBlock[];
  text: string;
  images: ImageCandidate[];
  links: PageLink[];
  colours: string[];
  jsonld: Record<string, unknown>[];
  facts: SourceFact[];
  /** Pages that look like a login wall or an empty script shell. */
  looksLikeLogin: boolean;
  scriptShell: boolean;
  ignoredInstructions: string[];
  /** Name candidates, to detect conflicting business names. */
  nameCandidates: { name: string; from: string }[];
}

function isHidden(n: Node): boolean {
  if (n.attrs?.some((a) => a.name === 'hidden')) return true;
  if (attr(n, 'aria-hidden') === 'true') return true;
  const style = attr(n, 'style').replace(/\s+/g, '').toLowerCase();
  return style.includes('display:none') || style.includes('visibility:hidden');
}

function textOf(n: Node, out: string[] = []): string[] {
  if (n.nodeName === '#text') out.push(n.value ?? '');
  else if (n.tagName && !SKIP.has(n.tagName) && !isHidden(n)) for (const c of children(n)) textOf(c, out);
  return out;
}

function find(root: Node, pred: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (pred(root)) out.push(root);
  for (const c of children(root)) find(c, pred, out);
  return out;
}

function meta(doc: Node): Record<string, string> {
  const m: Record<string, string> = {};
  for (const n of find(doc, (x) => x.tagName === 'meta')) {
    const key = (attr(n, 'property') || attr(n, 'name') || attr(n, 'itemprop')).toLowerCase();
    const content = attr(n, 'content');
    if (key && content && !(key in m)) m[key] = ws(content);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Visible text blocks
// ---------------------------------------------------------------------------

function collectBlocks(root: Node): { blocks: TextBlock[]; password: boolean } {
  const blocks: TextBlock[] = [];
  let heading = '';
  let password = false;
  const flush = (buf: { t: string }, zone: TextBlock['zone'], tag: string) => {
    const t = ws(buf.t);
    buf.t = '';
    if (t.length < 2) return;
    blocks.push({ text: t, tag, zone, heading });
    if (/^h[1-6]$/.test(tag)) heading = t.slice(0, 120);
  };
  // Inline text accumulates in the nearest block's buffer; a block element flushes the text before it,
  // collects its own, and flushes again, so every block becomes one entry with its zone and heading.
  const walk = (n: Node, zone: TextBlock['zone'], tag: string, buf: { t: string }) => {
    if (n.nodeName === '#text') {
      buf.t += ` ${n.value ?? ''}`;
      return;
    }
    const name = n.tagName;
    if (!name) {
      for (const c of children(n)) walk(c, zone, tag, buf);
      return;
    }
    if (SKIP.has(name) || isHidden(n)) return;
    if (name === 'input' && attr(n, 'type') === 'password') password = true;
    const z: TextBlock['zone'] = NAV_TAGS.has(name) || attr(n, 'role') === 'navigation' ? 'nav' : name === 'footer' ? 'footer' : name === 'header' && zone === 'main' ? 'header' : zone;
    if (BLOCK.has(name)) {
      flush(buf, zone, tag);
      const own = { t: '' };
      for (const c of children(n)) walk(c, z, name, own);
      flush(own, z, name);
    } else {
      for (const c of children(n)) walk(c, z, tag, buf);
    }
  };
  const top = { t: '' };
  walk(root, 'main', 'body', top);
  flush(top, 'main', 'body');
  return { blocks: dedupeBlocks(blocks), password };
}

function dedupeBlocks(blocks: TextBlock[]): TextBlock[] {
  const seen = new Set<string>();
  const out: TextBlock[] = [];
  for (const b of blocks) {
    const k = b.text.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

function flattenLd(v: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(v)) for (const x of v) flattenLd(x, out);
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o['@graph'])) flattenLd(o['@graph'], out);
    out.push(o);
  }
  return out;
}

function ldTypes(o: Record<string, unknown>): string[] {
  const t = o['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string');
}

const str = (v: unknown): string => (typeof v === 'string' ? ws(v) : typeof v === 'number' ? String(v) : '');
const first = <T>(v: T | T[] | undefined): T | undefined => (Array.isArray(v) ? v[0] : v);

function ldImage(v: unknown): string[] {
  const out: string[] = [];
  for (const x of Array.isArray(v) ? v : [v]) {
    if (typeof x === 'string') out.push(x);
    else if (x && typeof x === 'object') {
      const u = (x as Record<string, unknown>).url ?? (x as Record<string, unknown>).contentUrl;
      if (typeof u === 'string') out.push(u);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Money, dates, contacts
// ---------------------------------------------------------------------------

const CURRENCY_CODES: Record<string, string> = { 'GH₵': 'GHS', '₵': 'GHS', GHS: 'GHS', '$': 'USD', USD: 'USD', '€': 'EUR', EUR: 'EUR', '£': 'GBP', GBP: 'GBP', '₦': 'NGN', NGN: 'NGN', KES: 'KES', ZAR: 'ZAR' };
const MONEY = /(GH[₵S]|₵|\$|€|£|₦|USD|GHS|EUR|GBP|NGN|KES|ZAR)\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(GH[₵S]|cedis?|USD|GHS|EUR|GBP)\b/gi;
const BEFORE_Q = /(from|starting at|starts at|as low as|only|up to|was|now|just|save)\s*$/i;
const AFTER_Q = /^\s*(\/|per\b|a\b|each\b|\+|incl|excl|plus|VAT|onwards|and up)\s*([a-z]+(?:\s[a-z]+)?)?/i;
const OFFER_WORDS = /\b(\d+\s?%\s?off|discount|special offer|promo(?:tion)?|free\b|complimentary|package|bundle|deal\b|early[- ]bird|limited|offer ends|valid (?:until|till|through)|expires?|ends on|book by|until)\b/i;
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_RE = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?(?:,?\\s+20\\d{2})?\\b|\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+20\\d{2})?\\b|\\b20\\d{2}-\\d{2}-\\d{2}\\b`, 'gi');
const PHONE_RE = /(?:\+|00)?\d[\d\s().-]{7,16}\d/g;

function currencyCode(sym: string): string {
  const k = sym.toUpperCase() === 'CEDIS' || sym.toLowerCase().startsWith('cedi') ? 'GHS' : sym;
  return CURRENCY_CODES[k] ?? CURRENCY_CODES[k.toUpperCase()] ?? k.toUpperCase();
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function excerptAround(text: string, idx: number, len: number, radius = 90): string {
  const from = Math.max(0, idx - radius);
  const to = Math.min(text.length, idx + len + radius);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

function hexNorm(h: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  let v = m[1]!.toLowerCase();
  if (v.length === 3) v = v.split('').map((c) => c + c).join('');
  return `#${v}`;
}

function saturation(hex: string): { s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  return { s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l };
}

function brandColours(css: string, themeColor: string | null): string[] {
  const scores = new Map<string, number>();
  const bump = (hex: string | null, w: number) => {
    if (!hex) return;
    const { s, l } = saturation(hex);
    if (s < 0.18 || l < 0.1 || l > 0.9) return;
    scores.set(hex, (scores.get(hex) ?? 0) + w);
  };
  bump(themeColor ? hexNorm(themeColor) : null, 6);
  for (const m of css.matchAll(/--(?:[a-z-]*)(?:primary|brand|accent|main|theme)[a-z-]*\s*:\s*(#[0-9a-f]{3,6})\b/gi)) bump(hexNorm(m[1]!), 5);
  for (const m of css.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)) bump(hexNorm(m[0]), 1);
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([h]) => h);
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

const JUNK_IMG = /(sprite|pixel|spacer|tracking|beacon|1x1|blank|placeholder|loader|spinner|arrow|chevron|caret|icon[-_]|facebook|twitter|instagram|linkedin|youtube|whatsapp|tiktok|payment|visa|mastercard|paypal|flag[-_]|avatar|emoji|badge|captcha|ads?[-_/])/i;

function largestFromSrcset(srcset: string): { url: string; w: number | null } | null {
  let best: { url: string; w: number | null } | null = null;
  for (const part of srcset.split(',')) {
    const [u, d] = part.trim().split(/\s+/);
    if (!u) continue;
    const w = d && /w$/.test(d) ? parseInt(d, 10) : d && /x$/.test(d) ? Math.round(parseFloat(d) * 800) : null;
    if (!best || (w ?? 0) > (best.w ?? 0)) best = { url: u, w };
  }
  return best;
}

function collectImages(doc: Node, base: string, m: Record<string, string>, ld: Record<string, unknown>[]): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  const seen = new Set<string>();
  const add = (raw: string, o: Omit<ImageCandidate, 'url'>) => {
    const u = resolveRef(raw, base);
    if (!u) return;
    const href = u.toString();
    if (seen.has(href) || /\.svg(\?|$)/i.test(u.pathname) || /\.ico(\?|$)/i.test(u.pathname)) return;
    if (/^data:/i.test(raw)) return;
    seen.add(href);
    out.push({ url: href, ...o });
  };
  for (const k of ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']) if (m[k]) add(m[k], { alt: m['og:image:alt'] ?? '', width: Number(m['og:image:width']) || null, height: Number(m['og:image:height']) || null, role: 'image', score: 60, from: k });
  if (m['og:logo']) add(m['og:logo'], { alt: 'Logo', width: null, height: null, role: 'logo', score: 80, from: 'og:logo' });
  for (const o of ld) {
    const types = ldTypes(o).join(' ');
    for (const u of ldImage(o.logo)) add(u, { alt: 'Logo', width: null, height: null, role: 'logo', score: 85, from: 'structured data logo' });
    for (const u of ldImage(o.image)) add(u, { alt: str(o.name), width: null, height: null, role: 'image', score: /Product|Hotel|Restaurant|LocalBusiness|Service|Offer/.test(types) ? 65 : 50, from: 'structured data' });
  }
  for (const n of find(doc, (x) => x.tagName === 'link')) {
    const rel = attr(n, 'rel').toLowerCase();
    if (rel.includes('apple-touch-icon')) add(attr(n, 'href'), { alt: 'Site icon', width: parseInt(attr(n, 'sizes'), 10) || 180, height: parseInt(attr(n, 'sizes'), 10) || 180, role: 'logo', score: 35, from: 'apple-touch-icon' });
    else if (rel.includes('image_src')) add(attr(n, 'href'), { alt: '', width: null, height: null, role: 'image', score: 40, from: 'image_src' });
  }
  // <img> and <picture> sources, with the zone they sit in.
  const walk = (n: Node, zone: string) => {
    if (!n.tagName) return void children(n).forEach((c) => walk(c, zone));
    if (SKIP.has(n.tagName) && n.tagName !== 'noscript') return;
    const z = NAV_TAGS.has(n.tagName) ? 'nav' : n.tagName === 'footer' ? 'footer' : n.tagName === 'header' ? 'header' : zone;
    if (n.tagName === 'img' || n.tagName === 'source') {
      const srcset = attr(n, 'srcset') || attr(n, 'data-srcset');
      const big = srcset ? largestFromSrcset(srcset) : null;
      const src = big?.url ?? attr(n, 'src') ?? attr(n, 'data-src') ?? '';
      const raw = src || attr(n, 'data-src') || attr(n, 'data-lazy-src');
      if (raw) {
        const w = parseInt(attr(n, 'width'), 10) || big?.w || null;
        const h = parseInt(attr(n, 'height'), 10) || null;
        const alt = ws(attr(n, 'alt'));
        const label = `${attr(n, 'class')} ${attr(n, 'id')} ${alt} ${raw}`;
        const isLogo = /logo|brand(?:mark)?/i.test(label) && !/footer-?logo.*partner/i.test(label);
        const tiny = (w !== null && w < 80) || (h !== null && h < 80);
        if (!(JUNK_IMG.test(raw) && !isLogo) && !tiny) {
          const score = (isLogo ? 70 : 20) + (w && h ? Math.min(30, Math.round((w * h) / 40_000)) : 8) + (alt ? 8 : 0) + (z === 'main' ? 8 : z === 'header' && isLogo ? 10 : -10) + (n.tagName === 'source' ? 0 : 3);
          add(raw, { alt, width: w, height: h, role: isLogo ? 'logo' : 'image', score, from: `picture in page ${z}` });
        }
      }
    }
    for (const c of children(n)) walk(c, z);
  };
  walk(doc, 'main');
  return out.sort((a, b) => b.score - a.score).slice(0, 24);
}

// ---------------------------------------------------------------------------
// Related pages
// ---------------------------------------------------------------------------

const PAGE_KINDS: { re: RegExp; weight: number; kind: string }[] = [
  { re: /(book|reserv|rooms?|suites?|accommodation|menu|order|shop|products?|services?|packages?|rates|pricing|prices|offers?|deals?|programmes?|courses?|tickets?|events?|stay|dining)/i, weight: 9, kind: 'offer' },
  { re: /(about|our[- ]story|who[- ]we[- ]are|company)/i, weight: 6, kind: 'about' },
  { re: /(contact|find[- ]us|location|visit|directions|enquir|get[- ]in[- ]touch)/i, weight: 5, kind: 'contact' },
];
const SKIP_PATH = /(login|log-in|signin|sign-in|account|cart|checkout|privacy|terms|cookie|policy|admin|wp-|cdn-cgi|feed|\.(pdf|zip|docx?|xlsx?|jpe?g|png|gif|webp|mp4|mp3)(\?|$))/i;

export function pickRelatedPages(pageUrl: string, links: PageLink[], max: number): { url: string; why: string }[] {
  const scored = new Map<string, { url: string; why: string; score: number }>();
  for (const l of links) {
    let u: URL;
    try {
      u = new URL(l.url);
    } catch {
      continue;
    }
    if (!sameSite(u, pageUrl) || SKIP_PATH.test(u.pathname) || u.pathname === '/' || u.toString() === pageUrl) continue;
    const label = `${u.pathname} ${l.text}`;
    for (const k of PAGE_KINDS) {
      if (k.re.test(label)) {
        const prev = scored.get(u.toString());
        const s = k.weight + (l.text.length > 2 && l.text.length < 40 ? 1 : 0);
        if (!prev || prev.score < s) scored.set(u.toString(), { url: u.toString(), why: k.kind, score: s });
      }
    }
  }
  // One of each kind first (offer, about, contact), then the best of what is left.
  const all = [...scored.values()].sort((a, b) => b.score - a.score);
  const picked: typeof all = [];
  for (const kind of ['offer', 'about', 'contact']) {
    const p = all.find((x) => x.why === kind && !picked.includes(x));
    if (p && picked.length < max) picked.push(p);
  }
  for (const p of all) if (picked.length < max && !picked.includes(p)) picked.push(p);
  return picked.slice(0, max).map(({ url, why }) => ({ url, why }));
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const CTA_RE = /\b(book(?:\s+now)?|reserve|order(?:\s+now)?|buy(?:\s+now)?|shop(?:\s+now)?|contact(?:\s+us)?|call(?:\s+us)?|enquire|whatsapp|get\s+started|sign\s+up|register|apply|visit|learn\s+more|get\s+a\s+quote|request)\b/i;

export function extractPage(html: string, pageUrl: string, retrievedAt: number): ExtractedPage {
  const root = parse(html) as unknown as Node;
  const htmlEl = find(root, (n) => n.tagName === 'html')[0] ?? root;
  const m = meta(root);
  const title = ws(textOf(find(root, (n) => n.tagName === 'title')[0] ?? { nodeName: 'x' }).join(' '));
  const lang = attr(htmlEl, 'lang') || m['og:locale'] || '';
  const canonicalHref = find(root, (n) => n.tagName === 'link' && attr(n, 'rel').toLowerCase() === 'canonical')[0];
  const canonical = canonicalHref ? resolveRef(attr(canonicalHref, 'href'), pageUrl)?.toString() ?? null : null;
  const themeColor = m['theme-color'] ?? null;

  const body = find(root, (n) => n.tagName === 'body')[0] ?? root;
  const { blocks: rawBlocks, password } = collectBlocks(body);
  const jsonld: Record<string, unknown>[] = [];
  for (const n of find(root, (x) => x.tagName === 'script' && attr(x, 'type').toLowerCase().includes('ld+json'))) {
    const raw = children(n).map((c) => c.value ?? '').join('');
    try {
      jsonld.push(...flattenLd(JSON.parse(raw)));
    } catch {
      // malformed structured data is ignored
    }
  }
  const css = find(root, (n) => n.tagName === 'style').map((n) => children(n).map((c) => c.value ?? '').join('')).join('\n');

  // Strip lines that talk to an AI instead of to visitors; remember them so the director can be told.
  const ignored: string[] = [];
  const blocks = rawBlocks.filter((b) => {
    const r = stripInstructionLines(b.text);
    if (r.ignored.length) {
      ignored.push(...r.ignored);
      return false;
    }
    return true;
  });
  const mainBlocks = blocks.filter((b) => b.zone !== 'nav');
  const text = mainBlocks.map((b) => b.text).join('\n').slice(0, 14_000);
  const visibleChars = text.length;

  const nameCandidates: { name: string; from: string }[] = [];
  const ldOrg = jsonld.find((o) => ldTypes(o).some((t) => /Organization|LocalBusiness|Hotel|Restaurant|Store|Corporation|EducationalOrganization|LodgingBusiness|FoodEstablishment|ProfessionalService/.test(t)));
  if (ldOrg && str(ldOrg.name)) nameCandidates.push({ name: str(ldOrg.name), from: 'structured data' });
  if (m['og:site_name']) nameCandidates.push({ name: m['og:site_name'], from: 'og:site_name' });
  if (m['application-name']) nameCandidates.push({ name: m['application-name'], from: 'application-name' });
  const footerName = blocks.filter((b) => b.zone === 'footer').map((b) => /(?:©|\(c\)|copyright)\s*(?:20\d{2}\s*)?([A-Z][\w&.' -]{2,50}?)(?:[.,|]|\s+(?:all rights|\||$))/.exec(b.text)).find(Boolean);
  if (footerName) nameCandidates.push({ name: ws(footerName[1]!), from: 'page footer' });
  if (!nameCandidates.length && title) nameCandidates.push({ name: ws(title.split(/\s[|–—-]\s/).pop() ?? title), from: 'page title' });
  const siteName = nameCandidates[0]?.name ?? '';

  const facts: SourceFact[] = [];
  const add = (kind: FactKind, textIn: string, extra: Partial<Pick<SourceFact, 'value' | 'currency' | 'qualifier' | 'needsConfirmation'>>, excerpt: string, src = pageUrl) => {
    const t = clip(ws(textIn), 400);
    if (!t) return;
    const key = `${kind}|${t.toLowerCase()}`;
    if (facts.some((f) => `${f.kind}|${f.text.toLowerCase()}` === key)) return;
    facts.push({ id: `f_${stableHash([kind, t.toLowerCase(), src])}`, kind, text: t, value: extra.value ?? null, currency: extra.currency ?? null, qualifier: extra.qualifier ?? null, sourceUrl: src, excerpt: clip(ws(excerpt || t), 600), retrievedAt, needsConfirmation: extra.needsConfirmation ?? false, edited: false });
  };

  // Names
  for (const c of nameCandidates.slice(0, 1)) add('business_name', c.name, {}, `${c.from}: ${c.name}`);
  const ldProduct = jsonld.find((o) => ldTypes(o).some((t) => /Product|Service|Course|Event|Offer$/.test(t)));
  const h1 = mainBlocks.find((b) => b.tag === 'h1');
  const productName = str(ldProduct?.name) || m['og:title'] || h1?.text || '';
  if (productName && productName.toLowerCase() !== siteName.toLowerCase()) add('product_name', productName.split(/\s[|–—-]\s/)[0]!, {}, `${ldProduct ? 'structured data' : h1 ? 'main heading' : 'page title'}: ${productName}`);

  // Descriptions
  for (const [from, d] of [['meta description', m.description], ['og:description', m['og:description']], ['structured data', str(ldProduct?.description ?? ldOrg?.description)]] as const) if (d && d.length >= 30) add('description', clip(d, 380), {}, `${from}: ${d}`);
  const paras = mainBlocks.filter((b) => b.tag === 'p' && b.zone === 'main' && b.text.length >= 70 && b.text.length <= 420).slice(0, 3);
  for (const p of paras) add('description', p.text, {}, p.text);

  // Benefits: list items and short feature lines under the page's own headings.
  let benefits = 0;
  for (const b of mainBlocks) {
    if (benefits >= 12) break;
    if (b.zone !== 'main' || b.tag !== 'li') continue;
    if (b.text.length < 14 || b.text.length > 150 || /^(home|about|contact|menu|login|sign|cart|blog|faq|terms|privacy|follow|share)(?![-\w])/i.test(b.text)) continue;
    if (PHONE_RE.test(b.text) && b.text.length < 24) continue;
    PHONE_RE.lastIndex = 0;
    add('benefit', b.text, {}, b.heading ? `Under “${b.heading}”: ${b.text}` : b.text);
    benefits++;
  }

  // Prices, with qualifiers, from the page text and structured offers.
  let prices = 0;
  for (const b of mainBlocks) {
    if (prices >= 12 || b.zone === 'footer' && prices > 6) break;
    MONEY.lastIndex = 0;
    for (const mm of b.text.matchAll(MONEY)) {
      if (prices >= 12) break;
      const sym = mm[1] ?? mm[4]!;
      const amt = (mm[2] ?? mm[3])!;
      const idx = mm.index ?? 0;
      const before = b.text.slice(Math.max(0, idx - 24), idx);
      const after = b.text.slice(idx + mm[0].length, idx + mm[0].length + 30);
      const qb = BEFORE_Q.exec(before)?.[1];
      const qa = AFTER_Q.exec(after);
      const qualifier = ws([qb ?? '', qa ? `${qa[1]} ${qa[2] ?? ''}` : ''].join(' ').replace(/\s*\/\s*/g, ' per ')) || null;
      const amount = amt.replace(/,/g, '');
      const wording = b.text.length <= 200 ? b.text : excerptAround(b.text, idx, mm[0].length, 70);
      add('price', wording, { value: `${currencyCode(sym)} ${amount}`, currency: currencyCode(sym), qualifier, needsConfirmation: true }, b.heading ? `Under “${b.heading}”: ${wording}` : wording);
      prices++;
    }
  }
  for (const o of jsonld) {
    const offers = flattenLd(o.offers ?? (ldTypes(o).includes('Offer') ? o : []));
    for (const off of offers.slice(0, 4)) {
      const price = str(off.price ?? (first(off.priceSpecification as Record<string, unknown> | Record<string, unknown>[] | undefined) as Record<string, unknown> | undefined)?.price);
      const cur = str(off.priceCurrency);
      if (price && /^\d/.test(price)) add('price', `${str(o.name) || productName || 'Price'}: ${cur} ${price}`, { value: `${cur} ${price}`.trim(), currency: cur || null, qualifier: str(off.description) || null, needsConfirmation: true }, `Structured offer: ${JSON.stringify({ price, priceCurrency: cur, validThrough: off.priceValidUntil ?? null })}`);
      if (off.priceValidUntil) add('date', `Price valid until ${str(off.priceValidUntil)}`, { value: str(off.priceValidUntil), needsConfirmation: true }, `Structured offer: priceValidUntil ${str(off.priceValidUntil)}`);
    }
    const rating = (o.aggregateRating ?? null) as Record<string, unknown> | null;
    if (rating && str(rating.ratingValue)) add('rating', `Rated ${str(rating.ratingValue)} from ${str(rating.reviewCount ?? rating.ratingCount) || 'an unstated number of'} reviews`, { value: str(rating.ratingValue), needsConfirmation: true }, `Structured rating: ${JSON.stringify(rating).slice(0, 200)}`);
  }

  // Offers and dates in running text.
  let offers = 0;
  let dates = 0;
  for (const b of mainBlocks) {
    if (b.zone === 'footer') continue;
    if (offers < 6 && OFFER_WORDS.test(b.text) && b.text.length <= 260) {
      add('offer', b.text, { needsConfirmation: true }, b.heading ? `Under “${b.heading}”: ${b.text}` : b.text);
      offers++;
    }
    DATE_RE.lastIndex = 0;
    const dm = dates < 4 ? DATE_RE.exec(b.text) : null;
    if (dm && OFFER_WORDS.test(b.text) && b.text.length <= 260) {
      add('date', b.text, { value: dm[0], needsConfirmation: true }, b.text);
      dates++;
    }
  }

  // Contact details
  const contactNodes = find(root, (n) => n.tagName === 'a' && /^(tel|mailto):/i.test(attr(n, 'href')));
  for (const a of contactNodes.slice(0, 6)) {
    const href = attr(a, 'href');
    const v = decodeURIComponent(href.replace(/^(tel|mailto):/i, '').split('?')[0]!).trim();
    if (!v) continue;
    add('contact', /^tel:/i.test(href) ? `Phone ${v}` : `Email ${v}`, { value: v }, `Link on the page: ${href.split('?')[0]}`);
  }
  for (const b of blocks.filter((x) => x.zone === 'footer' || /contact|call|phone|tel|whatsapp/i.test(x.heading + x.text)).slice(0, 30)) {
    PHONE_RE.lastIndex = 0;
    const pm = PHONE_RE.exec(b.text);
    if (pm && b.text.length < 160 && pm[0].replace(/\D/g, '').length >= 9 && pm[0].replace(/\D/g, '').length <= 15 && !/\b20\d{2}\b.*\b20\d{2}\b/.test(pm[0])) add('contact', `Phone ${ws(pm[0])}`, { value: ws(pm[0]) }, b.text);
  }
  const addr = jsonld.map((o) => o.address ?? (o.location as Record<string, unknown> | undefined)?.address).find(Boolean) as Record<string, unknown> | string | undefined;
  if (addr) {
    const a = typeof addr === 'string' ? addr : [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.addressCountry].map(str).filter(Boolean).join(', ');
    if (a) add('location', a, {}, `Structured address: ${a}`);
  }
  const phoneLd = str(ldOrg?.telephone);
  if (phoneLd) add('contact', `Phone ${phoneLd}`, { value: phoneLd }, `Structured data telephone: ${phoneLd}`);

  // Where an ad should send people
  const links: PageLink[] = [];
  for (const a of find(root, (n) => n.tagName === 'a' && Boolean(attr(n, 'href')))) {
    const href = attr(a, 'href');
    const u = resolveRef(href, pageUrl);
    const label = ws(textOf(a).join(' ')).slice(0, 80);
    if (u) links.push({ url: u.toString(), text: label });
    if (u && label && CTA_RE.test(label) && sameSite(u, pageUrl) && !SKIP_PATH.test(u.pathname) && facts.filter((f) => f.kind === 'destination').length < 3) add('destination', `${label} → ${u.toString()}`, { value: u.toString() }, `Button or link “${label}” on the page`);
    if (u && /(^|\.)wa\.me$|whatsapp\.com$/i.test(u.hostname)) add('destination', `WhatsApp ${u.toString()}`, { value: u.toString() }, `WhatsApp link on the page`);
  }
  add('destination', canonical ?? pageUrl, { value: canonical ?? pageUrl }, `This page: ${canonical ?? pageUrl}`);

  const images = collectImages(root, pageUrl, m, jsonld);
  const colours = brandColours(css, themeColor);
  const scripts = find(root, (n) => n.tagName === 'script').length;
  return {
    url: pageUrl,
    title,
    siteName,
    description: m.description ?? m['og:description'] ?? '',
    lang,
    canonical,
    themeColor,
    blocks,
    text,
    images,
    links,
    colours,
    jsonld,
    facts,
    looksLikeLogin: password && visibleChars < 900,
    scriptShell: visibleChars < 200 && scripts >= 3,
    ignoredInstructions: ignored.slice(0, 10),
    nameCandidates,
  };
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

const normName = (s: string) => s.toLowerCase().replace(/\b(ltd|limited|inc|llc|co|company|the)\b/g, '').replace(/[^a-z0-9]/g, '');

/** Facts from different pages (or sources) that disagree, so the director sees them instead of the model guessing. */
export function findConflicts(pages: { url: string; facts: SourceFact[]; nameCandidates: { name: string; from: string }[] }[]): FactConflict[] {
  const out: FactConflict[] = [];
  const all = pages.flatMap((p) => p.facts);
  const names = pages.flatMap((p) => p.nameCandidates.map((c) => ({ ...c, url: p.url })));
  const distinct = new Map<string, string>();
  for (const n of names) {
    const k = normName(n.name);
    if (!k || [...distinct.keys()].some((x) => x.includes(k) || k.includes(x))) continue;
    distinct.set(k, n.name);
  }
  if (distinct.size > 1) out.push({ id: `c_name_${stableHash([...distinct.values()])}`, kind: 'business_name', message: `The pages give different names for the business: ${[...distinct.values()].map((n) => `“${n}”`).join(' and ')}. Check which one to use.`, factIds: all.filter((f) => f.kind === 'business_name').map((f) => f.id).slice(0, 5) });
  const byKind = (k: FactKind) => all.filter((f) => f.kind === k);
  const contacts = byKind('contact');
  for (const type of ['Phone', 'Email']) {
    const set = contacts.filter((f) => f.text.startsWith(type));
    const norm = new Map(set.map((f) => [type === 'Phone' ? (f.value ?? '').replace(/\D/g, '').replace(/^0+/, '').slice(-9) : (f.value ?? '').toLowerCase(), f]));
    if (norm.size > 1 && new Set(set.map((f) => f.sourceUrl)).size > 1) out.push({ id: `c_${type.toLowerCase()}_${stableHash([...norm.keys()])}`, kind: 'contact', message: `Different ${type === 'Phone' ? 'phone numbers' : 'email addresses'} appear on different pages: ${[...norm.values()].map((f) => f.value).join(', ')}. Choose the one to show.`, factIds: [...norm.values()].map((f) => f.id).slice(0, 6) });
  }
  const prices = byKind('price');
  const group = new Map<string, SourceFact[]>();
  for (const p of prices) {
    const at = p.text.search(/[\d₵$€£₦]|GH[₵S]/);
    const label = ws((at > 0 ? p.text.slice(0, at) : p.text).replace(/\b(from|starting at|starts at|as low as|only|up to|was|now|just)\b/gi, '')).toLowerCase().slice(0, 40);
    const key = `${p.currency ?? ''}|${label}`;
    group.set(key, [...(group.get(key) ?? []), p]);
  }
  for (const list of group.values()) {
    const amounts = new Set(list.map((p) => p.value));
    if (amounts.size > 1 && new Set(list.map((p) => p.sourceUrl)).size > 1) out.push({ id: `c_price_${stableHash(list.map((p) => p.id))}`, kind: 'price', message: `The same offering appears with different prices on different pages (${[...amounts].join(' and ')}). Confirm the current price.`, factIds: list.map((p) => p.id).slice(0, 6) });
  }
  return out;
}
