/**
 * Public website configuration: the canonical origin, the public pages and the studio's URL space.
 * firebase.json mirrors STUDIO_ROUTE_REGEX and PUBLIC_PAGE_REGEX — a unit test (site/site.test.ts) keeps them equal.
 */

/** Canonical origin (Firebase Hosting site `az-studio`; no custom domain is configured). */
export const SITE_ORIGIN = 'https://az-studio.web.app';
export const SITE_NAME = 'AZ Studio';

/** Verified public destinations (Francis Pwavwe's own sites). */
export const CONTACT_URL = 'https://blogs.pwavwe.com/p/contact.html';
export const BLOG_URL = 'https://blogs.pwavwe.com/';

export type PageId = 'home' | 'explore' | 'showcase' | 'about' | 'early-access' | 'faq' | 'privacy' | 'terms';

export interface PublicPage {
  id: PageId;
  /** URL path (clean URL, no trailing slash). */
  path: string;
  /** Emitted file in the Hosting public directory. */
  file: string;
  title: string;
  description: string;
  /** Label in the header navigation (omitted pages appear only in the footer). */
  nav?: string;
}

export const PUBLIC_PAGES: PublicPage[] = [
  {
    id: 'home',
    path: '/',
    file: 'index.html',
    title: 'AZ Studio — a creative workspace for video, images, music and narration',
    description: 'AZ Studio is an independent creative workspace by Francis Pwavwe for turning ideas into videos, images, music and narrated stories. See what it can make and join the early-access list.',
  },
  {
    id: 'explore',
    path: '/explore',
    file: 'explore.html',
    title: 'Explore AZ Studio — creative workflows and what’s available',
    description: 'The creative workflows inside AZ Studio — video and storytelling, images, music and narration — and which of them work today, which are being prepared and which are ideas.',
    nav: 'Explore',
  },
  {
    id: 'showcase',
    path: '/showcase',
    file: 'showcase.html',
    title: 'Showcase — work made with AZ Studio',
    description: 'Selected, publicly released work made with AZ Studio, including narrated audio editions of essays from The Pwavwe Papers.',
    nav: 'Showcase',
  },
  {
    id: 'about',
    path: '/about',
    file: 'about.html',
    title: 'About AZ Studio — an independent project by Francis Pwavwe',
    description: 'Why Francis Pwavwe built AZ Studio: to bring creative workflows into one place and make room for experiments.',
    nav: 'About',
  },
  {
    id: 'early-access',
    path: '/early-access',
    file: 'early-access.html',
    title: 'Join the early-access list — AZ Studio',
    description: 'Register your interest in trying AZ Studio. Access will be introduced gradually, in small groups; joining the list does not guarantee an invitation or a date.',
  },
  {
    id: 'faq',
    path: '/faq',
    file: 'faq.html',
    title: 'FAQ and contact — AZ Studio',
    description: 'Answers about using AZ Studio, early access, paid features and launch plans, and how to send feedback.',
    nav: 'FAQ',
  },
  {
    id: 'privacy',
    path: '/privacy',
    file: 'privacy.html',
    title: 'Privacy notice — AZ Studio',
    description: 'What the AZ Studio website collects, why, who processes it, how long it is kept and how to ask for deletion.',
  },
  {
    id: 'terms',
    path: '/terms',
    file: 'terms.html',
    title: 'Terms of use — AZ Studio',
    description: 'Terms for using the AZ Studio website, the early-access list and the showcase during this launch phase.',
  },
];

export const NOT_FOUND = { file: '404.html', title: 'Page not found — AZ Studio', description: 'This page doesn’t exist on the AZ Studio website.' };

/**
 * Top-level URL prefixes of the private studio app (served by studio.html; sign-in and owner check required).
 * `/assets` alone is the studio's media library; `/assets/…` are build files.
 */
export const STUDIO_PREFIXES = ['studio', 'projects', 'ads', 'lite', 'mvlite', 'narrator', 'create', 'jobs', 'settings', 'print', 'home'] as const;
export const STUDIO_ROUTE_REGEX = `^/(${STUDIO_PREFIXES.join('|')})(/.*)?$`;
export const PUBLIC_PAGE_REGEX = `^/(${PUBLIC_PAGES.filter((p) => p.path !== '/').map((p) => p.path.slice(1)).join('|')})?(\\.html)?$`;

export const isStudioPath = (pathname: string) => pathname === '/assets' || new RegExp(STUDIO_ROUTE_REGEX).test(pathname);

/** Reserved for a future public product (docs/PUBLIC_PRODUCT_PREP.md); it is the 404 page until then. */
export const RESERVED_PUBLIC_APP_PREFIX = '/app';

/** The studio's private entry point, linked from the footer. */
export const STUDIO_ENTRY = '/studio';
