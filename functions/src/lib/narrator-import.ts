import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { extractArticle, type ExtractedArticle } from '@az-studio/shared';

/**
 * Server-side import of a public Pwavwe Papers article. Only https pages on the allowed hosts are fetched;
 * every redirect is re-checked; DNS answers in private, loopback, link-local or otherwise non-public ranges
 * are refused at connect time (so a rebinding DNS answer cannot reach internal services); responses are
 * capped in time and size and must be HTML.
 */

export const IMPORT_HOSTS = ['blogs.pwavwe.com'] as const;
export const IMPORT_LIMITS = { maxBytes: 3 * 1024 * 1024, timeoutMs: 12_000, maxRedirects: 3 } as const;

export class ImportError extends Error {}

/** True for addresses that must never be fetched (RFC 1918, loopback, link-local, CGNAT, ULA, multicast…). */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v) || v.startsWith('64:ff9b:') || v.startsWith('2001:db8');
  }
  return true;
}

/** Validates an import URL (https, allowed host, default port, no credentials). Returns the normalised URL. */
export function checkImportUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ImportError('That is not a valid web address.');
  }
  if (u.protocol !== 'https:') throw new ImportError('Only https:// addresses can be imported.');
  if (u.username || u.password) throw new ImportError('Addresses with credentials are not accepted.');
  if (u.port && u.port !== '443') throw new ImportError('Addresses with a custom port are not accepted.');
  const host = u.hostname.toLowerCase();
  if (!(IMPORT_HOSTS as readonly string[]).includes(host)) throw new ImportError(`Only articles on ${IMPORT_HOSTS.join(', ')} can be imported. Paste the article text instead.`);
  u.hash = '';
  return u;
}

function safeLookup(hostname: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return cb(err, '', 4);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (!list.length || bad) return cb(Object.assign(new Error(`Refusing to connect to a non-public address for ${hostname}.`), { code: 'EPRIVATE' }), '', 4);
    if ((options as { all?: boolean }).all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}

type Fetcher = (url: URL) => Promise<{ status: number; location: string | null; contentType: string; body: Buffer }>;

const httpsFetch: Fetcher = (url) =>
  new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', lookup: safeLookup as never, headers: { 'user-agent': 'AZ-Studio-Pwavwe-Narrator/1.0 (+article import)', accept: 'text/html,application/xhtml+xml' }, timeout: IMPORT_LIMITS.timeoutMs }, (res) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === 'string' ? res.headers.location : null;
      const contentType = String(res.headers['content-type'] ?? '');
      if (status >= 300 && status < 400) {
        res.resume();
        return resolve({ status, location, contentType, body: Buffer.alloc(0) });
      }
      const declared = Number(res.headers['content-length'] ?? 0);
      if (declared > IMPORT_LIMITS.maxBytes) {
        req.destroy();
        return reject(new ImportError('The page is too large to import. Paste the article text instead.'));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (d: Buffer) => {
        size += d.length;
        if (size > IMPORT_LIMITS.maxBytes) {
          req.destroy(new ImportError('The page is too large to import. Paste the article text instead.'));
          return;
        }
        chunks.push(d);
      });
      res.on('end', () => resolve({ status, location, contentType, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new ImportError('The page took too long to answer. Paste the article text instead.')));
    req.on('error', (e) => reject(e instanceof ImportError ? e : new ImportError(`The page could not be fetched (${(e as Error).message}). Paste the article text instead.`)));
    req.end();
  });

let fetcher: Fetcher = httpsFetch;
/** Tests only. */
export function setImportFetcherForTests(f: Fetcher | null): void {
  fetcher = f ?? httpsFetch;
}

export async function importArticle(raw: string): Promise<ExtractedArticle & { url: string }> {
  let url = checkImportUrl(raw);
  const deadline = Date.now() + IMPORT_LIMITS.timeoutMs * 2;
  for (let hop = 0; hop <= IMPORT_LIMITS.maxRedirects; hop++) {
    if (Date.now() > deadline) throw new ImportError('The page took too long to answer. Paste the article text instead.');
    const res = await fetcher(url);
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new ImportError('The page redirected without a destination.');
      url = checkImportUrl(new URL(res.location, url).toString());
      continue;
    }
    if (res.status !== 200) throw new ImportError(`The page answered with HTTP ${res.status}. Paste the article text instead.`);
    if (!/^(text\/html|application\/xhtml\+xml)/i.test(res.contentType)) throw new ImportError('That address is not an HTML page.');
    const html = res.body.toString('utf8');
    return { ...extractArticle(html), url: url.toString() };
  }
  throw new ImportError('Too many redirects.');
}
