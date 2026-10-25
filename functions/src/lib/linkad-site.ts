import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import {
  checkPublicUrl,
  LINKAD_LIMITS,
  sameSite,
  stableHash,
  storagePaths,
  type FactConflict,
  type LinkAdAsset,
  type LinkAdDoc,
  type LinkAdInput,
  type PageRecord,
  type SourceBundle,
  type SourceFact,
  type UserFact,
} from '@az-studio/shared';
import { createAsset, withTmpDir } from './assets';
import { bucket, col } from './firebase';
import { extractPage, findConflicts, pickRelatedPages, type ExtractedPage } from './linkad-extract';
import { FetchRefusal, IMAGE_LIMITS, PAGE_LIMITS, parseRobots, robotsAllows, ROBOTS_LIMITS, safeGet, type Transport } from './linkad-net';
import { probe } from './media';

/**
 * Link to Ad: reading a site. One submitted page, at most four related pages of the same site (a hard cap of
 * five in total), never a crawl. Pages that need a login, sit behind a paywall, ask robots not to be read or
 * come back empty are reported as such — they are never worked around.
 */

export const FIRECRAWL_SECRET = 'AZ_STUDIO_FIRECRAWL_API_KEY';

export interface SiteReadDeps {
  transport?: Transport;
  /** Firecrawl is used only for pages the built-in reader finds empty (script-built pages), and only when configured. */
  firecrawlKey?: string | null;
  now?: () => number;
  respectRobots?: boolean;
  onProgress?: (message: string) => Promise<void> | void;
  isCancelled?: () => Promise<boolean>;
  fetchFirecrawl?: (url: string, key: string) => Promise<{ markdown: string; title: string; description: string } | null>;
}

export interface SiteRead {
  pages: PageRecord[];
  extracted: ExtractedPage[];
  warnings: string[];
  ignoredInstructions: string[];
  extractor: SourceBundle['extractor'];
}

function decodeBody(body: Buffer, contentType: string): string {
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 2048).toString('latin1'))?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset.toLowerCase()).decode(body);
  } catch {
    return body.toString('utf8');
  }
}

/** Markdown from Firecrawl as the simple HTML the extractor reads (headings, paragraphs, list items, links). */
export function markdownToHtml(md: string, meta: { title: string; description: string }): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => esc(s).replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<img alt="$1" src="$2">').replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2">$1</a>').replace(/[*_`]{1,3}/g, '');
  const out: string[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`);
    else if (/^[-*+]\s+/.test(line)) out.push(`<ul><li>${inline(line.replace(/^[-*+]\s+/, ''))}</li></ul>`);
    else out.push(`<p>${inline(line)}</p>`);
  }
  return `<html><head><title>${esc(meta.title)}</title><meta name="description" content="${esc(meta.description)}"></head><body><main>${out.join('\n')}</main></body></html>`;
}

export async function fetchFirecrawl(url: string, key: string): Promise<{ markdown: string; title: string; description: string } | null> {
  // https://docs.firecrawl.dev/api-reference/endpoint/scrape — POST /v2/scrape, Bearer auth, formats: ["markdown"].
  const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, timeout: 45_000 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { success?: boolean; data?: { markdown?: string; metadata?: { title?: string; description?: string; statusCode?: number } } };
  if (!j.success || !j.data?.markdown) return null;
  if ((j.data.metadata?.statusCode ?? 200) >= 400) return null;
  return { markdown: j.data.markdown.slice(0, 60_000), title: j.data.metadata?.title ?? '', description: j.data.metadata?.description ?? '' };
}

interface OnePage {
  record: PageRecord;
  page: ExtractedPage | null;
}

export async function readSite(input: LinkAdInput, deps: SiteReadDeps = {}): Promise<SiteRead> {
  const now = deps.now ?? Date.now;
  const first = checkPublicUrl(input.url);
  if (!first.ok) throw new FetchRefusal('bad_url', first.reason);
  const main = first.url;
  const cap = Math.min(LINKAD_LIMITS.maxPagesCap, Math.max(1, input.maxPages));
  const robotsCache = new Map<string, ReturnType<typeof parseRobots> | null>();
  const warnings: string[] = [];

  const robotsFor = async (u: URL) => {
    if (deps.respectRobots === false) return null;
    const key = u.origin;
    if (robotsCache.has(key)) return robotsCache.get(key)!;
    // No robots.txt (or an unreadable one) means nothing forbids reading.
    const rules = await safeGet(`${u.origin}/robots.txt`, ROBOTS_LIMITS, { transport: deps.transport, sameSiteOnly: true }).then(
      (r) => parseRobots(r.body.toString('utf8')),
      () => null,
    );
    robotsCache.set(key, rules);
    return rules;
  };

  const readOne = async (rawUrl: string): Promise<OnePage> => {
    const base: Omit<PageRecord, 'status'> = { url: rawUrl, finalUrl: null, title: '', httpStatus: null, fetchedAt: now(), bytes: 0, note: '', via: 'direct' };
    const u = checkPublicUrl(rawUrl);
    if (!u.ok) return { record: { ...base, status: 'skipped', note: u.reason }, page: null };
    const rules = await robotsFor(u.url);
    if (rules && !robotsAllows(rules, u.url.pathname + u.url.search)) return { record: { ...base, status: 'blocked', note: 'The site asks automated readers not to read this page, so it was skipped.' }, page: null };
    try {
      const res = await safeGet(u.url.toString(), PAGE_LIMITS, { transport: deps.transport, sameSiteOnly: true });
      let html = decodeBody(res.body, res.contentType);
      let page = extractPage(html, res.url, now());
      let via: PageRecord['via'] = 'direct';
      if (page.looksLikeLogin) return { record: { ...base, finalUrl: res.url, status: 'blocked', httpStatus: res.status, bytes: res.body.length, title: page.title, note: 'This looks like a login page. Pages behind a login are not read.' }, page: null };
      if (page.scriptShell && deps.firecrawlKey) {
        const fc = await (deps.fetchFirecrawl ?? fetchFirecrawl)(res.url, deps.firecrawlKey).catch(() => null);
        if (fc) {
          html = markdownToHtml(fc.markdown, fc);
          page = extractPage(html, res.url, now());
          via = 'firecrawl';
        }
      }
      const empty = page.text.length < 120 && page.facts.filter((f) => !['destination', 'business_name'].includes(f.kind)).length === 0;
      if (empty) return { record: { ...base, finalUrl: res.url, status: 'empty', httpStatus: res.status, bytes: res.body.length, title: page.title, via, note: page.scriptShell ? 'The page builds its content with scripts, so almost nothing could be read. Paste the details yourself, or add a Firecrawl key for script-built pages.' : 'The page had almost no readable text.' }, page: null };
      return { record: { ...base, finalUrl: res.url, status: 'ok', httpStatus: res.status, bytes: res.body.length, title: page.title, via, note: '' }, page };
    } catch (e) {
      if (e instanceof FetchRefusal) {
        const blocked = e.code === 'http_error' && [401, 402, 403].includes(e.httpStatus ?? 0);
        return { record: { ...base, status: blocked ? 'blocked' : 'failed', httpStatus: e.httpStatus, note: e.message }, page: null };
      }
      return { record: { ...base, status: 'failed', note: 'The page could not be read.' }, page: null };
    }
  };

  const pages: PageRecord[] = [];
  const extracted: ExtractedPage[] = [];
  const take = async (rawUrl: string) => {
    if (await deps.isCancelled?.()) throw new FetchRefusal('network', 'Stopped.');
    await deps.onProgress?.(`Reading ${new URL(rawUrl).hostname}${new URL(rawUrl).pathname === '/' ? '' : new URL(rawUrl).pathname}`);
    const r = await readOne(rawUrl);
    pages.push(r.record);
    if (r.page) extracted.push(r.page);
    return r;
  };

  const home = await take(main.toString());
  const wanted: string[] = [];
  // Supplementary pages the director named: same website only (a different site would need to be the submitted page).
  for (const raw of input.extraUrls.filter(Boolean)) {
    const c = checkPublicUrl(raw);
    if (!c.ok) warnings.push(`“${raw.slice(0, 80)}” was not read: ${c.reason}`);
    else if (!sameSite(c.url, main)) warnings.push(`“${c.url.hostname}” is a different website from the one you gave, so it was not read. Start a separate ad for it, or paste its details.`);
    else if (c.url.toString() !== main.toString()) wanted.push(c.url.toString());
  }
  if (home.page) for (const p of pickRelatedPages(home.record.finalUrl ?? main.toString(), home.page.links, cap - 1)) if (!wanted.includes(p.url)) wanted.push(p.url);
  for (const u of wanted) {
    if (pages.length >= cap) {
      warnings.push(`Only ${cap} pages are read for one ad, so ${new URL(u).pathname} was left out.`);
      continue;
    }
    await take(u);
  }

  const ignored = extracted.flatMap((p) => p.ignoredInstructions).slice(0, 10);
  if (ignored.length) warnings.push(`The website contained ${ignored.length} line${ignored.length === 1 ? '' : 's'} that talk to AI assistants. They were ignored.`);
  for (const p of pages) if (p.status !== 'ok') warnings.push(`${new URL(p.url).pathname === '/' ? 'The home page' : new URL(p.url).pathname}: ${p.note}`);
  return { pages, extracted, warnings, ignoredInstructions: ignored, extractor: pages.some((p) => p.via === 'firecrawl') ? 'firecrawl' : 'direct' };
}

// ---------------------------------------------------------------------------
// Notes written by the director
// ---------------------------------------------------------------------------

const PRICE_LINE = /(GH[₵S]|₵|\$|€|£|₦|USD|GHS|EUR|GBP)\s?\d|\d\s?(GH[₵S]|cedis?|USD|GHS)\b/i;
const URL_LINE = /\bhttps?:\/\/\S+|\bwww\.\S+/i;
const EMAIL_LINE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_LINE = /(?:\+|00)?\d[\d\s().-]{7,16}\d/;
const DATE_LINE = /\b(?:until|valid|expires?|ends?|from)\b.*\b(?:20\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

/** Splits pasted text into the director's own facts (never presented as sourced). */
export function factsFromNotes(text: string, at: number): UserFact[] {
  const out: UserFact[] = [];
  for (const raw of text.split(/\r?\n+/)) {
    const line = raw.replace(/^[-*•\d.)\s]+/, '').trim();
    if (line.length < 4) continue;
    const kind: UserFact['kind'] = URL_LINE.test(line) ? 'destination' : EMAIL_LINE.test(line) ? 'contact' : PRICE_LINE.test(line) ? 'price' : DATE_LINE.test(line) ? 'date' : PHONE_LINE.test(line) && line.replace(/\D/g, '').length >= 9 && line.length < 60 ? 'contact' : /%\s*off|discount|offer|free\b/i.test(line) ? 'offer' : line.length <= 90 ? 'benefit' : 'description';
    out.push({ id: `u_${stableHash([kind, line.toLowerCase()])}`, kind, text: line.slice(0, 400), at });
    if (out.length >= 40) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merging a reading into the document
// ---------------------------------------------------------------------------

const assetId = (url: string) => `a_${createHash('sha1').update(url).digest('hex').slice(0, 12)}`;

/** The source bundle after a reading. The director's edits to wording and every confirmation survive a re-read. */
export function applySiteRead(doc: LinkAdDoc, read: SiteRead | null, now: number): SourceBundle {
  const prev = doc.source;
  const edited = new Map(prev.facts.filter((f) => f.edited).map((f) => [f.id, f]));
  const facts: SourceFact[] = [];
  const conflicts: FactConflict[] = read ? findConflicts(read.extracted) : prev.conflicts;
  if (read) {
    const seen = new Set<string>();
    const seenText = new Set<string>();
    for (const page of read.extracted) {
      for (const f of page.facts) {
        // The same wording on several pages (the business name in every header) is one fact, from the first page that has it.
        // Phone numbers compare by their digits, so “+233 24 555 0142” and “+233245550142” are one fact.
        const same = f.kind === 'contact' && f.value && /\d{6,}/.test(f.value.replace(/\D/g, '')) ? `contact|${f.value.replace(/\D/g, '').replace(/^0+/, '').slice(-9)}` : `${f.kind}|${f.text.toLowerCase()}`;
        if (seen.has(f.id) || seenText.has(same)) continue;
        seen.add(f.id);
        seenText.add(same);
        facts.push(edited.get(f.id) ?? f);
      }
    }
    // Facts the director edited that the new reading no longer contains stay (they are theirs now).
    for (const [id, f] of edited) if (!seen.has(id)) facts.push(f);
  } else facts.push(...prev.facts);

  const assets: LinkAdAsset[] = [];
  const prevAssets = new Map(prev.assets.map((a) => [a.id, a]));
  if (read) {
    const logos: LinkAdAsset[] = [];
    const images: LinkAdAsset[] = [];
    const seen = new Set<string>();
    for (const page of read.extracted) {
      for (const c of page.images) {
        const id = assetId(c.url);
        if (seen.has(id)) continue;
        seen.add(id);
        const old = prevAssets.get(id);
        const a: LinkAdAsset = old ?? { id, assetId: null, role: c.role, origin: 'site', url: c.url, pageUrl: page.url, alt: c.alt, width: c.width, height: c.height, bytes: null, mime: null, status: 'candidate', rejectReason: null, rights: 'unconfirmed', needsReview: false, reviewed: false, selected: false, note: '' };
        (c.role === 'logo' ? logos : images).push(a);
      }
    }
    assets.push(...logos.slice(0, 4), ...images.slice(0, LINKAD_LIMITS.maxImages));
    // Uploads and previously stored items the new reading does not list are kept.
    for (const a of prev.assets) if (!assets.some((x) => x.id === a.id) && (a.origin !== 'site' || a.status === 'stored')) assets.push(a);
  } else assets.push(...prev.assets);

  const pagesOk = read?.pages.filter((p) => p.status === 'ok').length ?? 0;
  const mainOk = read?.pages[0]?.status === 'ok';
  const status: SourceBundle['status'] = !read ? (doc.userFacts.length ? 'manual' : prev.status) : !pagesOk ? (doc.userFacts.length ? 'manual' : 'failed') : mainOk && read.pages.every((p) => p.status === 'ok') ? 'ok' : 'partial';
  const missing: string[] = [];
  const has = (k: SourceFact['kind']) => facts.some((f) => f.kind === k) || doc.userFacts.some((f) => f.kind === k);
  if (!has('price')) missing.push('No price was found. The ad will not mention one unless you add it.');
  if (!has('contact') && !has('destination')) missing.push('No phone, email or booking link was found for people to act on.');
  if (!assets.some((a) => a.role === 'image')) missing.push('No usable pictures were found. You can upload your own, or make a text-led ad.');
  if (!assets.some((a) => a.role === 'logo')) missing.push('No logo was found. You can upload one.');
  if (!has('benefit') && !has('description')) missing.push('No description of what is offered was found.');
  return {
    status,
    extractor: read?.extractor ?? (status === 'manual' ? 'manual' : prev.extractor),
    startedAt: now,
    fetchedAt: read ? now : prev.fetchedAt,
    siteName: read?.extracted[0]?.siteName ?? prev.siteName,
    pages: read ? read.pages.map((p) => ({ ...p })) : prev.pages,
    facts: facts.slice(0, LINKAD_LIMITS.maxFacts),
    assets: assets.slice(0, 40),
    colours: read ? [...new Set(read.extracted.flatMap((p) => p.colours))].slice(0, 6) : prev.colours,
    warnings: read?.warnings.slice(0, 30) ?? prev.warnings,
    conflicts: conflicts.slice(0, 20),
    missing,
    ignoredInstructions: read?.ignoredInstructions ?? prev.ignoredInstructions,
  };
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

const IMAGE_MIME = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif']]);
const MAX_PIXELS = 40_000_000;

export interface StoredPicture {
  assetId: string;
  width: number;
  height: number;
  bytes: number;
  mime: string;
}

/**
 * Downloads one picture through the same safe reader and keeps it only if it really is a picture of an allowed type
 * and a sensible size. Nothing is stored for a refused candidate; the reason is recorded on it.
 */
export async function storeSitePicture(opts: { uid: string; projectId: string; ref: LinkAdAsset; jobId: string; transport?: Transport; title: string }): Promise<StoredPicture> {
  const { ref } = opts;
  if (!ref.url) throw new FetchRefusal('bad_url', 'This picture has no address.');
  const res = await safeGet(ref.url, { ...IMAGE_LIMITS }, { transport: opts.transport });
  const sniff = await fileTypeFromBuffer(res.body);
  if (!sniff || !IMAGE_MIME.has(sniff.mime)) throw new FetchRefusal('bad_type', 'That file is not a JPEG, PNG, WebP or GIF picture.');
  const ext = IMAGE_MIME.get(sniff.mime)!;
  return withTmpDir(async (dir) => {
    const local = path.join(dir, `picture.${ext}`);
    await writeFile(local, res.body);
    const info = await probe(local);
    if (!info.width || !info.height) throw new FetchRefusal('bad_type', 'The picture could not be decoded.');
    if (info.width * info.height > MAX_PIXELS) throw new FetchRefusal('too_large', 'The picture is larger than the 40-megapixel limit.');
    const minSide = ref.role === 'logo' ? 48 : 240;
    if (Math.min(info.width, info.height) < minSide) throw new FetchRefusal('bad_type', `The picture is too small to use (${info.width}×${info.height}).`);
    const id = col.assets().doc().id;
    const storagePath = `${storagePaths.generatedDir(opts.uid, opts.jobId)}${id}.${ext}`;
    await bucket.upload(local, { destination: storagePath, resumable: false, metadata: { contentType: sniff.mime, cacheControl: 'private, max-age=31536000' } });
    await createAsset({ uid: opts.uid, assetId: id, projectId: opts.projectId, kind: 'image', source: 'upload', title: opts.title.slice(0, 120) || 'Website picture', fileName: `picture.${ext}`, mimeType: sniff.mime, storagePath, localFile: local, dir, collections: ['linkad:site'] });
    await col.assets().doc(id).set({ tags: ['from-website'], origin: { url: ref.url, pageUrl: ref.pageUrl } }, { merge: true });
    return { assetId: id, width: info.width, height: info.height, bytes: res.body.length, mime: sniff.mime };
  });
}

