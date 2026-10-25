import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Connect, Plugin } from 'vite';
import { renderSitePages, robotsTxt, sitemapXml } from './build';
import { NOT_FOUND, PUBLIC_PAGES, isStudioPath } from './config';

/** Rollup inputs for the generated public pages (virtual HTML files at the app root). */
export function siteInputs(): Record<string, string> {
  return Object.fromEntries([...PUBLIC_PAGES.map((p) => p.file), NOT_FOUND.file].map((f) => [`site-${f.replace(/\.html$/, '')}`, f]));
}

type Route = { kind: 'page'; file: string; status: number } | { kind: 'studio' } | { kind: 'pass' };

/**
 * How Firebase Hosting answers a path (firebase.json): public pages by clean URL, the studio's prefixes to
 * studio.html, files and API/embed paths untouched, anything else the 404 page. Used by the dev and preview servers.
 */
export function routeFor(pathname: string): Route {
  if (pathname.startsWith('/@') || pathname.startsWith('/__') || pathname.startsWith('/api/') || pathname.startsWith('/embed') || pathname.startsWith('/node_modules/')) return { kind: 'pass' };
  const page = PUBLIC_PAGES.find((p) => p.path === pathname || `/${p.file}` === pathname);
  if (page) return { kind: 'page', file: page.file, status: 200 };
  if (pathname === '/studio.html' || isStudioPath(pathname)) return { kind: 'studio' };
  if (/\.[a-z0-9]+$/i.test(pathname)) return { kind: 'pass' };
  return { kind: 'page', file: NOT_FOUND.file, status: 404 };
}

/**
 * Builds the public website (static pages generated from site/content.ts) alongside the studio SPA and the
 * embed player. Pages are virtual HTML entries, so Vite bundles and hashes their script and stylesheet like any
 * other page; robots.txt and sitemap.xml are emitted with the build.
 */
export function publicSite(): Plugin {
  let root = '';
  let outDir = '';
  let pages: Record<string, string> = {};
  const fileOf = (id: string) => path.relative(root, path.resolve(root, id.split('?')[0]!)).split(path.sep).join('/');

  return {
    name: 'az-public-site',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(root, config.build.outDir);
      pages = renderSitePages();
    },
    resolveId(id) {
      if (!id.endsWith('.html')) return null;
      const file = fileOf(id);
      if (pages[file] !== undefined) return path.resolve(root, file).split(path.sep).join('/');
      return null;
    },
    load(id) {
      if (!id.endsWith('.html')) return null;
      const file = fileOf(id);
      return pages[file] ?? null;
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robotsTxt() });
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemapXml() });
    },
    configureServer(server) {
      const handler: Connect.NextHandleFunction = (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = routeFor(url.pathname);
        if (route.kind === 'pass') return next();
        const source = route.kind === 'studio' ? readFileSync(path.join(root, 'studio.html'), 'utf8') : renderSitePages()[route.file]!;
        server
          .transformIndexHtml(req.url ?? '/', source)
          .then((out) => {
            res.statusCode = route.kind === 'page' ? route.status : 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(out);
          })
          .catch(next);
      };
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = routeFor(url.pathname);
        if (route.kind === 'pass') return next();
        const file = route.kind === 'studio' ? 'studio.html' : route.file;
        if (!existsSync(path.join(outDir, file))) return next();
        res.statusCode = route.kind === 'page' ? route.status : 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(readFileSync(path.join(outDir, file)));
      });
    },
  };
}
