import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSitePages, robotsTxt, sitemapXml } from './build';
import { CONTACT_URL, NOT_FOUND, PUBLIC_PAGE_REGEX, PUBLIC_PAGES, SITE_ORIGIN, STUDIO_ROUTE_REGEX, isStudioPath } from './config';
import { SHOWCASE } from './content';
import { routeFor } from './plugin';

const firebase = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../firebase.json'), 'utf8')).hosting[0];
const pages = renderSitePages();
const all = (re: RegExp, s: string) => [...s.matchAll(re)].map((m) => m[1]!);

describe('Hosting routes match the site configuration', () => {
  it('sends the studio prefixes to studio.html and has no catch-all, so unknown paths get the 404 page', () => {
    const rewrites = firebase.rewrites as { source?: string; regex?: string; destination?: string; function?: unknown }[];
    expect(rewrites.find((r) => r.regex)).toEqual({ regex: STUDIO_ROUTE_REGEX, destination: '/studio.html' });
    expect(rewrites).toContainEqual({ source: '/assets', destination: '/studio.html' });
    expect(rewrites.some((r) => r.source === '**')).toBe(false);
    expect(rewrites.find((r) => r.source === '/api/public/**')?.function).toEqual({ functionId: 'azsPublic', region: 'us-central1' });
  });

  it('gives public pages a strict CSP and allows indexing after the studio block, and keeps noindex as the default', () => {
    const blocks = firebase.headers as { source?: string; regex?: string; headers: { key: string; value: string }[] }[];
    const studio = blocks.findIndex((b) => b.source === '**');
    const pub = blocks.findIndex((b) => b.regex === PUBLIC_PAGE_REGEX);
    expect(studio).toBe(0);
    expect(pub).toBeGreaterThan(studio);
    const get = (i: number, k: string) => blocks[i]!.headers.find((h) => h.key === k)?.value;
    expect(get(studio, 'X-Robots-Tag')).toBe('noindex, nofollow');
    expect(get(pub, 'X-Robots-Tag')).toBe('all');
    expect(get(pub, 'Content-Security-Policy')).toMatch(/script-src 'self';/);
    expect(get(pub, 'Content-Security-Policy')).toMatch(/frame-ancestors 'none'/);
    const re = new RegExp(PUBLIC_PAGE_REGEX);
    for (const p of PUBLIC_PAGES) expect(re.test(p.path), p.path).toBe(true);
    for (const p of ['/studio', '/projects/x', '/embed/audio/x', '/settings']) expect(re.test(p), p).toBe(false);
  });

  it('routes the dev server like Hosting', () => {
    expect(routeFor('/')).toEqual({ kind: 'page', file: 'index.html', status: 200 });
    expect(routeFor('/explore')).toEqual({ kind: 'page', file: 'explore.html', status: 200 });
    expect(routeFor('/studio')).toEqual({ kind: 'studio' });
    expect(routeFor('/projects/abc/film/script')).toEqual({ kind: 'studio' });
    expect(routeFor('/narrator/e/x')).toEqual({ kind: 'studio' });
    expect(routeFor('/assets')).toEqual({ kind: 'studio' });
    expect(routeFor('/assets/main-abc.js')).toEqual({ kind: 'pass' });
    expect(routeFor('/embed/audio/abc')).toEqual({ kind: 'pass' });
    expect(routeFor('/api/public/early-access')).toEqual({ kind: 'pass' });
    expect(routeFor('/nope')).toEqual({ kind: 'page', file: NOT_FOUND.file, status: 404 });
    expect(routeFor('/studios')).toEqual({ kind: 'page', file: NOT_FOUND.file, status: 404 });
    expect(isStudioPath('/studio/')).toBe(true);
    expect(isStudioPath('/about')).toBe(false);
  });
});

describe('Generated public pages', () => {
  it('emits every page plus the 404 page', () => {
    expect(Object.keys(pages).sort()).toEqual([...PUBLIC_PAGES.map((p) => p.file), NOT_FOUND.file].sort());
  });

  it('gives each page a unique title, description, canonical URL and sharing metadata', () => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();
    for (const p of PUBLIC_PAGES) {
      const doc = pages[p.file]!;
      const title = all(/<title>([^<]+)<\/title>/g, doc)[0]!;
      const description = all(/<meta name="description" content="([^"]+)"/g, doc)[0]!;
      titles.add(title);
      descriptions.add(description);
      expect(doc).toContain(`<link rel="canonical" href="${SITE_ORIGIN}${p.path}" />`);
      expect(doc).toContain(`<meta property="og:url" content="${SITE_ORIGIN}${p.path}" />`);
      expect(doc).toContain(`<meta property="og:image" content="${SITE_ORIGIN}/og.png" />`);
      expect(doc).toContain('<meta name="twitter:card" content="summary_large_image" />');
      expect(doc).toContain('<meta name="robots" content="index, follow" />');
      expect((doc.match(/<h1[\s>]/g) ?? []).length, `${p.file} has one h1`).toBe(1);
    }
    expect(titles.size).toBe(PUBLIC_PAGES.length);
    expect(descriptions.size).toBe(PUBLIC_PAGES.length);
    expect(pages[NOT_FOUND.file]).toContain('<meta name="robots" content="noindex" />');
    expect(pages[NOT_FOUND.file]).not.toContain('rel="canonical"');
  });

  it('works under the public CSP: no inline scripts or styles, no third-party resources', () => {
    for (const [file, doc] of Object.entries(pages)) {
      expect(all(/<script([^>]*)>/g, doc).every((attrs) => /\bsrc="\/site\/client\/main\.ts"/.test(attrs)), file).toBe(true);
      expect(doc, file).not.toMatch(/\sstyle="/);
      expect(doc, file).not.toMatch(/<style[\s>]/);
      expect(doc, file).not.toMatch(/\son[a-z]+="/);
      for (const src of all(/\s(?:src|href)="(https?:[^"]+)"/g, doc)) {
        // Only plain links may leave the site (Francis's own sites); nothing is loaded from elsewhere.
        expect(src.startsWith(SITE_ORIGIN) || src.startsWith('https://blogs.pwavwe.com/'), `${file}: ${src}`).toBe(true);
      }
    }
  });

  it('links only to pages that exist', () => {
    const known = new Set([...PUBLIC_PAGES.map((p) => p.path), '/studio', '/favicon.svg', '/apple-touch-icon.png']);
    for (const [file, doc] of Object.entries(pages)) {
      for (const href of all(/\shref="(\/[^"#]*)(?:#[^"]*)?"/g, doc)) {
        if (href.startsWith('/embed/audio/')) continue;
        expect(known.has(href), `${file} → ${href}`).toBe(true);
      }
    }
  });

  it('contains no secrets, private media URLs or studio data', () => {
    const text = Object.values(pages).join('\n');
    for (const bad of [/AIza[0-9A-Za-z_-]{20,}/, /az-studio-media/, /gs:\/\//, /storage\.googleapis\.com/, /X-Goog-Signature/i, /firebaseapp\.com/, /ownerUid/, /@gmail\.com/]) expect(text).not.toMatch(bad);
    expect(text).toContain(CONTACT_URL);
  });

  it('shows only showcase work with a recorded approval, played through the public player', () => {
    for (const s of SHOWCASE) {
      expect(s.approval.length).toBeGreaterThan(20);
      if (s.kind === 'audio') expect(s.audioEditionId).toMatch(/^[A-Za-z0-9]{12}$/);
      expect(pages['showcase.html']).toContain(`id="${s.id}"`);
    }
    expect(pages['showcase.html']).not.toMatch(/autoplay/);
  });

  it('builds the early-access form with labels, the consent checkbox unticked and the submit button off until the script runs', () => {
    const doc = pages['early-access.html']!;
    for (const id of ['ea-email', 'ea-name', 'ea-interest', 'ea-consent']) expect(doc).toContain(`for="${id}"`);
    expect(doc).toMatch(/<input id="ea-consent" name="consent" type="checkbox" value="yes" required/);
    expect(doc).not.toMatch(/ea-consent[^>]*checked/);
    expect(doc).toMatch(/data-submit disabled/);
    expect(doc).toContain('data-endpoint="/api/public/early-access"');
  });
});

describe('Search files', () => {
  it('lists public pages only in the sitemap', () => {
    const xml = sitemapXml('2026-10-24');
    expect(all(/<loc>([^<]+)<\/loc>/g, xml)).toEqual(PUBLIC_PAGES.map((p) => `${SITE_ORIGIN}${p.path}`));
    expect(xml).not.toMatch(/\.app\/(studio|projects|embed|api|settings)/);
  });

  it('points robots.txt at the sitemap and keeps the API out of crawls', () => {
    expect(robotsTxt()).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
    expect(robotsTxt()).toContain('Disallow: /api/');
  });
});
