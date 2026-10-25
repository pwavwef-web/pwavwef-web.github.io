import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkPublicUrl, isReservedAddress } from '@az-studio/shared';
import { checkedLookup, FetchRefusal, PAGE_LIMITS, parseRobots, robotsAllows, safeGet, type RawResponse, type Resolver, type Transport } from '../src/lib/linkad-net';
import { extractPage, findConflicts, pickRelatedPages } from '../src/lib/linkad-extract';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(path.join(here, 'fixtures/linkad', n), 'utf8');
const ORIGIN = 'https://harbourlight.example';

describe('URL rules', () => {
  it.each([
    'http://localhost/admin',
    'http://127.0.0.1/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://10.0.0.5/',
    'http://172.16.4.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://100.64.0.1/',
    'https://printer.local/',
    'https://intranet/',
    'ftp://example.com/file',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pass@example.com/',
    'https://example.com:22/',
  ])('refuses %s', (u) => {
    expect(checkPublicUrl(u).ok).toBe(false);
  });

  it('accepts ordinary public addresses and adds https to a bare name', () => {
    const a = checkPublicUrl('example.com/rooms?x=1#top');
    expect(a.ok && a.url.toString()).toBe('https://example.com/rooms?x=1');
    expect(checkPublicUrl('http://example.com/').ok).toBe(true);
    expect(checkPublicUrl('https://8.8.8.8/').ok).toBe(true);
  });

  it('classifies reserved addresses', () => {
    for (const ip of ['0.0.0.0', '127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.1.1', '::', '::1', '::ffff:10.0.0.1', 'fc00::1', '64:ff9b::7f00:1']) expect(isReservedAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isReservedAddress(ip), ip).toBe(false);
  });
});

describe('safe fetching', () => {
  const html = (body: string): RawResponse => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(body) });

  it('checks the resolved address at connection time (names that point at private space are refused)', async () => {
    const resolver: Resolver = async (host) => (host === 'evil.example' ? [{ address: '10.0.0.7', family: 4 }] : host === 'mixed.example' ? [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
    const lookup = checkedLookup(resolver);
    const run = (host: string) => new Promise<{ err: Error | null; addr?: unknown }>((res) => lookup(host, { all: true }, (err: Error | null, addr?: unknown) => res({ err, addr })));
    expect((await run('evil.example')).err).toBeInstanceOf(FetchRefusal);
    expect(((await run('evil.example')).err as FetchRefusal).code).toBe('blocked_address');
    expect(((await run('mixed.example')).err as FetchRefusal).code).toBe('blocked_address');
    expect((await run('fine.example')).err).toBeNull();
  });

  it('re-validates every redirect and refuses private, off-site or downgraded destinations', async () => {
    const mk = (location: string): Transport => async (u) => (u.pathname === '/start' ? { status: 302, headers: { location }, body: Buffer.alloc(0) } : html('<html>ok</html>'));
    await expect(safeGet(`${ORIGIN}/start`, PAGE_LIMITS, { transport: mk('http://169.254.169.254/latest/meta-data/') })).rejects.toMatchObject({ code: 'unsafe_redirect' });
    await expect(safeGet(`${ORIGIN}/start`, PAGE_LIMITS, { transport: mk('http://localhost:8080/') })).rejects.toMatchObject({ code: 'unsafe_redirect' });
    await expect(safeGet(`${ORIGIN}/start`, PAGE_LIMITS, { transport: mk('http://harbourlight.example/plain') })).rejects.toMatchObject({ code: 'unsafe_redirect' });
    await expect(safeGet(`${ORIGIN}/start`, PAGE_LIMITS, { transport: mk('https://other.example/'), sameSiteOnly: true })).rejects.toMatchObject({ code: 'unsafe_redirect' });
    const ok = await safeGet(`${ORIGIN}/start`, PAGE_LIMITS, { transport: mk('/landing'), sameSiteOnly: true });
    expect(ok.url).toBe(`${ORIGIN}/landing`);
    expect(ok.redirects).toEqual([`${ORIGIN}/landing`]);
  });

  it('stops redirect loops', async () => {
    const loop: Transport = async () => ({ status: 301, headers: { location: '/again' }, body: Buffer.alloc(0) });
    await expect(safeGet(`${ORIGIN}/x`, PAGE_LIMITS, { transport: loop })).rejects.toMatchObject({ code: 'too_many_redirects' });
  });

  it('refuses unexpected content types and login or paywall answers', async () => {
    await expect(safeGet(`${ORIGIN}/a.pdf`, PAGE_LIMITS, { transport: async () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.from('%PDF') }) })).rejects.toMatchObject({ code: 'bad_type' });
    await expect(safeGet(`${ORIGIN}/members`, PAGE_LIMITS, { transport: async () => ({ status: 403, headers: {}, body: Buffer.alloc(0) }) })).rejects.toMatchObject({ code: 'http_error', httpStatus: 403 });
    await expect(safeGet(`${ORIGIN}/premium`, PAGE_LIMITS, { transport: async () => ({ status: 402, headers: {}, body: Buffer.alloc(0) }) })).rejects.toThrow(/paywall/);
  });

  it('refuses unsafe starting addresses without calling the network', async () => {
    let called = 0;
    const t: Transport = async () => (called++, html('x'));
    for (const u of ['http://localhost/', 'http://10.0.0.1/', 'https://user:pw@harbourlight.example/']) await expect(safeGet(u, PAGE_LIMITS, { transport: t })).rejects.toMatchObject({ code: 'bad_url' });
    expect(called).toBe(0);
  });

  it('reads robots.txt rules for the generic and own agent groups', () => {
    const r = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/public\n\nUser-agent: googlebot\nDisallow: /');
    expect(robotsAllows(r, '/rooms')).toBe(true);
    expect(robotsAllows(r, '/private/area')).toBe(false);
    expect(robotsAllows(r, '/private/public/page')).toBe(true);
    expect(robotsAllows(parseRobots('User-agent: AZStudioLinkToAd\nDisallow: /'), '/rooms')).toBe(false);
  });
});

describe('page extraction', () => {
  const page = extractPage(fixture('guesthouse-home.html'), `${ORIGIN}/`, 1_700_000_000_000);
  const byKind = (k: string) => page.facts.filter((f) => f.kind === k);

  it('finds the business and what it offers, each fact with its source, excerpt and retrieval time', () => {
    expect(page.siteName).toBe('Harbour Light Guesthouse');
    expect(byKind('business_name')[0]!.text).toBe('Harbour Light Guesthouse');
    expect(byKind('benefit').map((f) => f.text)).toEqual(expect.arrayContaining(['Sea-view terrace open from sunrise', 'Home-cooked breakfast included with every room']));
    for (const f of page.facts) {
      expect(f.sourceUrl).toBe(`${ORIGIN}/`);
      expect(f.excerpt.length).toBeGreaterThan(2);
      expect(f.retrievedAt).toBe(1_700_000_000_000);
    }
  });

  it('reads prices with currency and qualifiers, and marks them for confirmation', () => {
    const prices = byKind('price');
    const standard = prices.find((p) => /Standard room/.test(p.text))!;
    expect(standard.value).toBe('GHS 450');
    expect(standard.currency).toBe('GHS');
    expect(standard.qualifier).toMatch(/from/i);
    expect(standard.qualifier).toMatch(/per night/i);
    expect(standard.needsConfirmation).toBe(true);
  });

  it('finds offers and their dates as facts needing confirmation (a fetch time proves nothing about currency)', () => {
    expect(byKind('offer').some((f) => /10% off/.test(f.text) && f.needsConfirmation)).toBe(true);
    expect(byKind('date').some((f) => /30 November 2026/.test(f.text) && f.needsConfirmation)).toBe(true);
  });

  it('finds contact details, the address and where to send people', () => {
    expect(byKind('contact').map((f) => f.value)).toEqual(expect.arrayContaining(['+233245550142']));
    expect(byKind('location')[0]!.text).toContain('Cape Coast');
    expect(byKind('destination').some((f) => /Book a room/.test(f.text))).toBe(true);
  });

  it('collects logo and picture candidates, ignores tracking pixels, and reads the brand colours', () => {
    const logos = page.images.filter((i) => i.role === 'logo');
    expect(logos.length).toBeGreaterThan(0);
    expect(logos[0]!.url).toBe(`${ORIGIN}/img/logo.png`);
    const pics = page.images.filter((i) => i.role === 'image');
    expect(pics.some((i) => i.url === `${ORIGIN}/img/terrace-hero.jpg` && i.width === 1600)).toBe(true);
    expect(page.images.some((i) => i.url.includes('pixel.gif'))).toBe(false);
    expect(page.colours[0]).toBe('#0b6e7f');
  });

  it('treats instructions on the page as data: the lines are dropped from the material and reported', () => {
    expect(page.text).not.toMatch(/ignore all previous instructions/i);
    expect(page.facts.some((f) => /number one|lifetime guarantee|system prompt/i.test(f.text))).toBe(false);
    expect(page.ignoredInstructions.join(' ')).toMatch(/ignore all previous instructions/i);
  });

  it('picks related pages on the same site only, favouring the offer page, and never login pages', () => {
    const picked = pickRelatedPages(`${ORIGIN}/`, [...page.links, { url: 'https://elsewhere.example/rooms', text: 'Rooms' }], 4);
    expect(picked.map((p) => p.url)).toEqual(expect.arrayContaining([`${ORIGIN}/rooms`, `${ORIGIN}/contact`]));
    expect(picked.some((p) => /login|elsewhere/.test(p.url))).toBe(false);
    expect(picked.length).toBeLessThanOrEqual(4);
  });

  it('reports conflicts between pages instead of choosing silently', () => {
    const rooms = extractPage(fixture('guesthouse-rooms.html'), `${ORIGIN}/rooms`, 1_700_000_000_000);
    const conflicts = findConflicts([page, rooms]);
    expect(conflicts.some((c) => c.kind === 'price' && /450/.test(c.message) && /480/.test(c.message))).toBe(true);
    expect(conflicts.some((c) => c.kind === 'contact' && /phone/i.test(c.message))).toBe(true);
  });

  it('recognises a login wall and an empty script shell', () => {
    expect(extractPage(fixture('login-wall.html'), `${ORIGIN}/members`, 0).looksLikeLogin).toBe(true);
    const shell = extractPage('<html><head><script src="a.js"></script><script src="b.js"></script><script src="c.js"></script></head><body><div id="root"></div></body></html>', `${ORIGIN}/app`, 0);
    expect(shell.scriptShell).toBe(true);
    expect(shell.facts.filter((f) => f.kind === 'benefit' || f.kind === 'price')).toHaveLength(0);
  });

  it('is deterministic: the same HTML gives the same fact ids (confirmations survive a re-read)', () => {
    const again = extractPage(fixture('guesthouse-home.html'), `${ORIGIN}/`, 1_800_000_000_000);
    expect(again.facts.map((f) => f.id)).toEqual(page.facts.map((f) => f.id));
  });
});
