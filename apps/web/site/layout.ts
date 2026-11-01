import { html, type Html } from './html';
import { icon, mark } from './icons';
import { CONTACT_URL, PUBLIC_PAGES, SITE_NAME, SITE_ORIGIN, STUDIO_ENTRY, type PageId } from './config';

export interface DocumentMeta {
  /** Current page (marks the active navigation link); null for the 404 page. */
  id: PageId | null;
  title: string;
  description: string;
  /** Canonical path; omitted pages (404) are not indexed. */
  path?: string;
}

const OG_IMAGE = `${SITE_ORIGIN}/og.png`;

function header(active: PageId | null): Html {
  const links = PUBLIC_PAGES.filter((p) => p.nav);
  return html`<header class="site-header">
  <div class="container header-row">
    <a class="brand" href="/" aria-label="AZ Studio home">${mark()}<span>AZ Studio</span></a>
    <button class="menu-button" type="button" aria-expanded="false" aria-controls="site-nav" data-menu-button>
      <span class="menu-open">${icon('menu')}</span><span class="menu-close">${icon('close')}</span><span class="visually-hidden">Menu</span>
    </button>
    <nav class="site-nav" id="site-nav" aria-label="Main">
      <ul>
        ${links.map((p) => html`<li><a href="${p.path}"${active === p.id ? html` aria-current="page"` : ''}>${p.nav}</a></li>`)}
      </ul>
      <a class="button button-primary button-small" href="/early-access"${active === 'early-access' ? html` aria-current="page"` : ''}>Early access</a>
    </nav>
  </div>
</header>`;
}

function footer(): Html {
  const year = new Date().getUTCFullYear();
  return html`<footer class="site-footer">
  <div class="container footer-grid">
    <div class="footer-brand">
      <a class="brand" href="/">${mark()}<span>AZ Studio</span></a>
      <p>An independent creative workspace by Francis Pwavwe, being prepared for its first public visitors.</p>
    </div>
    <nav aria-label="Site">
      <h2 class="footer-heading">Site</h2>
      <ul>
        <li><a href="/">Home</a></li>
        <li><a href="/explore">Explore</a></li>
        <li><a href="/showcase">Showcase</a></li>
        <li><a href="/about">About</a></li>
      </ul>
    </nav>
    <nav aria-label="Help and policies">
      <h2 class="footer-heading">Help</h2>
      <ul>
        <li><a href="/early-access">Early access</a></li>
        <li><a href="/faq">FAQ</a></li>
        <li><a href="${CONTACT_URL}" rel="noopener">Contact</a></li>
        <li><a href="/privacy">Privacy</a></li>
        <li><a href="/terms">Terms</a></li>
      </ul>
    </nav>
  </div>
  <div class="container footer-base">
    <p>© ${year} Francis Pwavwe. No cookies or tracking on this site.</p>
    <a class="studio-link" href="${STUDIO_ENTRY}" rel="nofollow">${icon('lock', 'icon icon-small')}Studio sign in</a>
  </div>
</footer>`;
}

/** A complete public page. Vite rewrites the module script into hashed assets at build time. */
export function document(meta: DocumentMeta, main: Html): string {
  const canonical = meta.path ? `${SITE_ORIGIN}${meta.path}` : null;
  return html`<!doctype html>
<html lang="en-GB" class="no-js">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${meta.title}</title>
    <meta name="description" content="${meta.description}" />
    ${canonical ? html`<link rel="canonical" href="${canonical}" />
    <meta name="robots" content="index, follow" />` : html`<meta name="robots" content="noindex" />`}
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content="#f7f8fb" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#070b13" media="(prefers-color-scheme: dark)" />
    <meta name="referrer" content="strict-origin-when-cross-origin" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${SITE_NAME}" />
    <meta property="og:title" content="${meta.title}" />
    <meta property="og:description" content="${meta.description}" />
    ${canonical ? html`<meta property="og:url" content="${canonical}" />` : ''}
    <meta property="og:image" content="${OG_IMAGE}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="AZ Studio — make room for your next creative idea." />
    <meta property="og:locale" content="en_GB" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${meta.title}" />
    <meta name="twitter:description" content="${meta.description}" />
    <meta name="twitter:image" content="${OG_IMAGE}" />
    <script type="module" src="/site/client/main.ts"></script>
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>
    ${header(meta.id)}
    <main id="main" tabindex="-1">
${main}
    </main>
    ${footer()}
  </body>
</html>
`.value;
}
