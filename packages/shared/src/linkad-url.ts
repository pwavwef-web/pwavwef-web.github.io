/**
 * Link to Ad: URL and network-destination rules. Pure string logic (no DNS, no I/O) so the browser can give
 * early feedback and the server can apply exactly the same rules before and after name resolution.
 */

export const LINKAD_URL_MAX_CHARS = 2000;

export type UrlProblem = { ok: false; reason: string };
export type UrlOk = { ok: true; url: URL };

/** Hostnames that are never fetched, whatever they resolve to. */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.localdomain'];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'kubernetes.default.svc']);

/** Parses `a.b.c.d` (also the shorthand/octal/hex forms browsers accept) to four octets, or null. */
export function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === '')) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^\d+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  // A short form folds the last number into the remaining bytes (127.1 = 127.0.0.1; 2130706433 = 127.0.0.1).
  const last = nums[nums.length - 1]!;
  const head = nums.slice(0, -1);
  if (head.some((n) => n > 255)) return null;
  const room = 256 ** (4 - head.length);
  if (last >= room) return null;
  const out = [...head];
  for (let i = 4 - head.length - 1; i >= 0; i--) out.push(Math.floor(last / 256 ** i) % 256);
  return out as [number, number, number, number];
}

/** True when an IPv4 address is private, loopback, link-local, carrier-grade NAT, multicast, reserved or documentation space. */
export function isReservedIpv4(o: readonly number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF + documentation
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Expands an IPv6 literal to eight 16-bit groups, or null when it is not valid. */
export function parseIpv6(raw: string): number[] | null {
  let s = raw.replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
  if (!s.includes(':')) return null;
  // Embedded IPv4 tail (::ffff:1.2.3.4).
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const v4 = parseIpv4(m[2]!);
    if (!v4) return null;
    s = `${m[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (t: string) => (t === '' ? [] : t.split(':'));
  const head = toGroups(halves[0]!);
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const all = halves.length === 1 ? head : [...head, ...Array<string>(missing).fill('0'), ...tail];
  const out = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.length === 8 && out.every((n) => Number.isFinite(n)) ? out : null;
}

export function isReservedIpv6(g: readonly number[]): boolean {
  if (g.every((x, i) => (i < 7 ? x === 0 : x === 0 || x === 1))) return true; // :: and ::1
  // IPv4-mapped / compatible / NAT64 wrap an IPv4 address: judge that address.
  const v4 = () => [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isReservedIpv4(v4());
  if (g[0] === 0x64 && g[1] === 0xff9b) return isReservedIpv4(v4());
  if (g[0] === 0x2002) return isReservedIpv4([g[1]! >> 8, g[1]! & 255, g[2]! >> 8, g[2]! & 255]); // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // site-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  return false;
}

/** Whether a literal IP address (v4 or v6, any notation) is a destination that must never be fetched. */
export function isReservedAddress(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return isReservedIpv4(v4);
  const v6 = parseIpv6(ip);
  if (v6) return isReservedIpv6(v6);
  return true; // unparseable: refuse
}

/** The checks that need no DNS: scheme, credentials, port, hostname shape and literal addresses. */
export function checkPublicUrl(raw: string, opts: { allowHttp?: boolean } = {}): UrlOk | UrlProblem {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'Paste the address of a public page.' };
  if (text.length > LINKAD_URL_MAX_CHARS) return { ok: false, reason: 'That address is too long.' };
  // Anything other than a bare address with an optional http(s) scheme is refused before parsing guesses at it.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z0-9.-]+:\d+(\/|$)/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: 'That does not look like a web address.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'Only http and https addresses can be read.' };
  if (url.protocol === 'http:' && !opts.allowHttp) {
    // Plain http is allowed (many small sites still use it) but is upgraded to https when the site supports it.
  }
  if (url.username || url.password) return { ok: false, reason: 'Addresses with a username or password are not accepted.' };
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) return { ok: false, reason: 'Only standard web ports are accepted.' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'That address has no website name.' };
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, reason: 'That address points inside a private network, so it cannot be read.' };
  if (host.startsWith('[') || host.includes(':')) {
    if (isReservedAddress(host)) return { ok: false, reason: 'That address points inside a private network, so it cannot be read.' };
  } else if (/^[\d.]+$/.test(host) || /^0x/i.test(host)) {
    if (isReservedAddress(host)) return { ok: false, reason: 'That address points inside a private network, so it cannot be read.' };
  } else if (!host.includes('.')) {
    return { ok: false, reason: 'Use a full website address, such as example.com.' };
  }
  url.hash = '';
  return { ok: true, url };
}

/** The site a page belongs to, for the default same-site rule (www and the bare domain count as one site). */
export function siteKey(u: URL | string): string {
  const host = (typeof u === 'string' ? new URL(u) : u).hostname.toLowerCase().replace(/\.$/, '');
  return host.replace(/^www\./, '');
}

export function sameSite(a: URL | string, b: URL | string): boolean {
  try {
    return siteKey(a) === siteKey(b);
  } catch {
    return false;
  }
}

/** Resolves a possibly relative reference against a page; null for anything that is not a plain http(s) address. */
export function resolveRef(ref: string, base: string): URL | null {
  const t = ref.trim();
  if (!t || /^(javascript|data|mailto|tel|blob|file|about):/i.test(t)) return null;
  try {
    const u = new URL(t, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}
