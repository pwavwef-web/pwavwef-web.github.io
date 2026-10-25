import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import { checkPublicUrl, isReservedAddress, resolveRef } from '@az-studio/shared';

/**
 * Link to Ad: the only way the studio reads an address someone else typed.
 *
 * Every request — the first and every redirect — passes the URL rules (scheme, credentials, port, hostname,
 * literal addresses) and then the *connection itself* is made only to an address that was resolved and checked
 * in the same step (a custom `lookup`), so a name that points at a private address, or that changes its answer
 * between a check and the connection (DNS rebinding), cannot reach the internal network. Time, redirects,
 * response size (also after decompression) and content type are bounded.
 */

export class FetchRefusal extends Error {
  constructor(
    readonly code: 'bad_url' | 'blocked_address' | 'too_many_redirects' | 'unsafe_redirect' | 'timeout' | 'too_large' | 'bad_type' | 'http_error' | 'network' | 'robots',
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }
}

export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  /** Lower-case content-type prefixes that may be returned (e.g. `text/html`). */
  accept: readonly string[];
}

export const PAGE_LIMITS: FetchLimits = { timeoutMs: 12_000, maxBytes: 2_500_000, maxRedirects: 4, accept: ['text/html', 'application/xhtml+xml'] };
export const IMAGE_LIMITS: FetchLimits = { timeoutMs: 15_000, maxBytes: 8_000_000, maxRedirects: 3, accept: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] };
export const ROBOTS_LIMITS: FetchLimits = { timeoutMs: 6_000, maxBytes: 200_000, maxRedirects: 2, accept: ['text/plain', 'text/html', 'application/octet-stream'] };

export const USER_AGENT = 'AZStudioLinkToAd/1.0 (+https://az-studio.web.app; reads one public page you ask it to)';

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}
export type Transport = (url: URL, limits: FetchLimits) => Promise<RawResponse>;
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

export interface SafeResponse {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  redirects: string[];
}

const defaultResolver: Resolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/** A `lookup` for http(s).request: resolves, refuses reserved addresses, and hands back only checked ones. */
type LookupDone = (err: Error | null, address?: unknown, family?: number) => void;
export function checkedLookup(resolver: Resolver = defaultResolver) {
  return (hostname: string, options: dns.LookupOptions | LookupDone, cb?: LookupDone) => {
    const done = (typeof options === 'function' ? options : cb) as LookupDone;
    const opts = (typeof options === 'function' ? {} : options) as dns.LookupOptions;
    resolver(hostname).then(
      (list) => {
        if (!list.length) return done(new FetchRefusal('network', 'That website name did not resolve.'));
        const bad = list.find((a) => isReservedAddress(a.address));
        if (bad) return done(new FetchRefusal('blocked_address', 'That address points inside a private network, so it cannot be read.'));
        if (opts.all) return done(null, list);
        done(null, list[0]!.address, list[0]!.family);
      },
      (e: Error) => done(new FetchRefusal('network', `That website could not be reached (${(e as NodeJS.ErrnoException).code ?? 'lookup failed'}).`)),
    );
  };
}

function decoder(encoding: string): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  const e = encoding.toLowerCase().trim();
  if (e === 'gzip' || e === 'x-gzip') return zlib.createGunzip();
  if (e === 'deflate') return zlib.createInflate();
  if (e === 'br') return zlib.createBrotliDecompress();
  return null;
}

/** One request, no redirects. Streams the body, stopping at the limit (also for the decompressed size). */
export function nodeTransport(resolver: Resolver = defaultResolver): Transport {
  return (url, limits) =>
    new Promise<RawResponse>((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const hostIsLiteral = net.isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0;
      if (hostIsLiteral && isReservedAddress(url.hostname)) return reject(new FetchRefusal('blocked_address', 'That address points inside a private network, so it cannot be read.'));
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(e);
      };
      const req = lib.request(
        url,
        {
          method: 'GET',
          lookup: checkedLookup(resolver) as never,
          headers: { 'user-agent': USER_AGENT, accept: limits.accept.join(', ') + ', */*;q=0.1', 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en;q=0.9, *;q=0.5' },
          timeout: limits.timeoutMs,
          agent: false,
        },
        (res) => {
          const headers = res.headers as RawResponse['headers'];
          const status = res.statusCode ?? 0;
          let stream: Readable = res;
          const enc = String(res.headers['content-encoding'] ?? '');
          if (enc && enc.toLowerCase() !== 'identity') {
            const d = decoder(enc);
            if (!d) return fail(new FetchRefusal('bad_type', 'The site answered in a format that cannot be read.'));
            res.pipe(d);
            d.on('error', () => fail(new FetchRefusal('network', 'The site sent damaged data.')));
            stream = d;
          }
          const declared = Number(res.headers['content-length'] ?? 0);
          if (!enc && declared > limits.maxBytes && status >= 200 && status < 300) return fail(new FetchRefusal('too_large', 'That file is too large to read.'));
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('data', (c: Buffer) => {
            size += c.length;
            if (size > limits.maxBytes) return fail(new FetchRefusal('too_large', 'That file is too large to read.'));
            chunks.push(c);
          });
          stream.on('end', () => {
            if (settled) return;
            settled = true;
            resolve({ status, headers, body: Buffer.concat(chunks) });
          });
          stream.on('error', () => fail(new FetchRefusal('network', 'The connection dropped while reading.')));
        },
      );
      req.on('timeout', () => fail(new FetchRefusal('timeout', 'The website took too long to answer.')));
      req.on('error', (e) => fail(e instanceof FetchRefusal ? e : new FetchRefusal('network', `That website could not be reached (${(e as NodeJS.ErrnoException).code ?? 'connection failed'}).`)));
      // Whole-request deadline, independent of socket activity.
      const timer = setTimeout(() => fail(new FetchRefusal('timeout', 'The website took too long to answer.')), limits.timeoutMs * 2);
      req.on('close', () => clearTimeout(timer));
      req.end();
    });
}

const typeOf = (h: RawResponse['headers']) => String(h['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();

/**
 * GET with redirects followed manually: each hop is re-validated, an https page never redirects to http, and a
 * redirect may not leave the starting site unless `allowOffSite` says the destination was itself validated.
 */
export async function safeGet(rawUrl: string, limits: FetchLimits, opts: { transport?: Transport; sameSiteOnly?: boolean; allowHttp?: boolean } = {}): Promise<SafeResponse> {
  const transport = opts.transport ?? nodeTransport();
  const first = checkPublicUrl(rawUrl, { allowHttp: opts.allowHttp ?? true });
  if (!first.ok) throw new FetchRefusal('bad_url', first.reason);
  let url = first.url;
  const trail: string[] = [];
  for (let hop = 0; hop <= limits.maxRedirects; hop++) {
    const res = await transport(url, limits);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      const next = resolveRef(String(res.headers.location), url.toString());
      if (!next) throw new FetchRefusal('unsafe_redirect', 'The site redirected somewhere that cannot be read.');
      const check = checkPublicUrl(next.toString(), { allowHttp: true });
      if (!check.ok) throw new FetchRefusal('unsafe_redirect', check.reason);
      if (url.protocol === 'https:' && check.url.protocol === 'http:') throw new FetchRefusal('unsafe_redirect', 'The site tried to move from a secure to an insecure address.');
      if (opts.sameSiteOnly && check.url.hostname.replace(/^www\./, '') !== first.url.hostname.replace(/^www\./, '')) throw new FetchRefusal('unsafe_redirect', 'The page redirected to another website, which was not read.');
      trail.push(check.url.toString());
      url = check.url;
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      const msg = res.status === 401 || res.status === 403 ? 'The page needs a login or does not allow automated readers.' : res.status === 402 ? 'The page is behind a paywall.' : res.status === 404 || res.status === 410 ? 'The page was not found.' : res.status === 429 ? 'The site is limiting requests right now.' : `The site answered with an error (${res.status}).`;
      throw new FetchRefusal('http_error', msg, res.status);
    }
    const ct = typeOf(res.headers);
    if (!limits.accept.some((a) => ct === a || (ct === '' && a === 'text/html' && /^\s*<(?:!doctype|html)/i.test(res.body.subarray(0, 200).toString('utf8'))))) {
      throw new FetchRefusal('bad_type', ct ? `That address is a ${ct} file, not a web page.` : 'That address did not say what kind of file it is.');
    }
    return { url: url.toString(), status: res.status, contentType: ct || 'text/html', body: res.body, redirects: trail };
  }
  throw new FetchRefusal('too_many_redirects', 'The site redirected too many times.');
}

// ---------------------------------------------------------------------------
// robots.txt (courtesy: pages the site asks automated readers to skip are not read)
// ---------------------------------------------------------------------------

/** Disallowed path prefixes for the `*` and `azstudio` groups. */
export function parseRobots(text: string): { disallow: string[]; allow: string[] } {
  const disallow: string[] = [];
  const allow: string[] = [];
  let applies = false;
  let seenAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const k = m[1]!.toLowerCase();
    const v = m[2]!.trim();
    if (k === 'user-agent') {
      if (!seenAgent) applies = false;
      seenAgent = true;
      if (v === '*' || /azstudio/i.test(v)) applies = true;
    } else {
      seenAgent = false;
      if (!applies) continue;
      if (k === 'disallow' && v) disallow.push(v);
      if (k === 'allow' && v) allow.push(v);
    }
  }
  return { disallow, allow };
}

export function robotsAllows(rules: { disallow: string[]; allow: string[] }, pathAndQuery: string): boolean {
  const match = (p: string) => (p.endsWith('$') ? pathAndQuery === p.slice(0, -1) : pathAndQuery.startsWith(p.replace(/\*.*$/, '')));
  const d = rules.disallow.filter(match).sort((a, b) => b.length - a.length)[0];
  if (!d) return true;
  const a = rules.allow.filter(match).sort((x, y) => y.length - x.length)[0];
  return Boolean(a && a.length >= d.length);
}
