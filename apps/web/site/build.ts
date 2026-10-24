import { NOT_FOUND, PUBLIC_PAGES, SITE_ORIGIN, type PageId } from './config';
import { document } from './layout';
import { aboutPage, earlyAccessPage, explorePage, faqPage, homePage, notFoundPage, privacyPage, showcasePage, termsPage } from './pages';
import type { Html } from './html';

const BODIES: Record<PageId, () => Html> = {
  home: homePage,
  explore: explorePage,
  showcase: showcasePage,
  about: aboutPage,
  'early-access': earlyAccessPage,
  faq: faqPage,
  privacy: privacyPage,
  terms: termsPage,
};

/** Every public HTML file, keyed by its file name in the Hosting public directory. */
export function renderSitePages(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of PUBLIC_PAGES) out[p.file] = document({ id: p.id, title: p.title, description: p.description, path: p.path }, BODIES[p.id]());
  out[NOT_FOUND.file] = document({ id: null, title: NOT_FOUND.title, description: NOT_FOUND.description }, notFoundPage());
  return out;
}

/** Public pages only — the studio, API and embed routes are never listed. */
export function sitemapXml(lastmod = new Date().toISOString().slice(0, 10)): string {
  const urls = PUBLIC_PAGES.map((p) => `  <url><loc>${SITE_ORIGIN}${p.path}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * Crawling stays allowed on studio routes on purpose: they answer with `X-Robots-Tag: noindex` and a robots meta
 * tag, which crawlers can only see if they may fetch the page. (Access control is sign-in + owner checks, not this.)
 */
export function robotsTxt(): string {
  return `User-agent: *\nDisallow: /api/\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`;
}
