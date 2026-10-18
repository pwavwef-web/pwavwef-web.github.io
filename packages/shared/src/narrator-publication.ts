/**
 * Publishing an audio edition through AZ Studio's own hosted player. A publication is a stable public id with
 * one approved revision (an exact export's MP3 copied to a public-serving path). Everything else — drafts,
 * takes, WAV masters, enrollment audio, voices and generation endpoints — stays private and is never reachable
 * from the public routes.
 */

/** The deployed AZ Studio domain that serves the public player (Firebase Hosting site `az-studio`). */
export const PUBLIC_PLAYER_ORIGIN = 'https://az-studio.web.app';

/**
 * Origins allowed to frame the player (CSP `frame-ancestors` on /embed/**, set in firebase.json — a unit test
 * keeps the two in sync). blogger.com and *.blogspot.com cover Blogger's own preview of the post.
 * Note: limiting who may embed the player does not stop anyone copying audio that is publicly playable.
 */
export const PUBLICATION_ORIGINS = ['https://blogs.pwavwe.com', 'https://www.blogger.com', 'https://*.blogspot.com'] as const;

/** How long a withdrawn or replaced revision can still be served (see docs/OPERATIONS.md). */
export const PUBLICATION_CACHE = {
  /** Public metadata: browser 30 s, Hosting CDN 60 s. */
  metadataMaxAgeSec: 30,
  metadataSharedMaxAgeSec: 60,
  /** A replaced revision keeps playing for listeners who already started it, then is deleted. */
  replacedGraceSec: 15 * 60,
  /** Signed media links handed out by the stable stream route. */
  signedUrlTtlSec: 60 * 60,
} as const;

export const PUBLIC_ID_RE = /^[A-Za-z0-9]{12}$/;

export interface PublicSection {
  title: string;
  startSec: number;
}

/** Exactly what the public metadata endpoint returns — nothing private. */
export interface PublicAudioEdition {
  id: string;
  status: 'published';
  revision: number;
  title: string;
  author: string;
  publication: string;
  publishedDate: string | null;
  articleUrl: string | null;
  durationSec: number;
  sections: PublicSection[];
  peaks: number[];
  audio: { url: string; mimeType: 'audio/mpeg'; bytes: number };
  updatedAt: number;
}

export interface PublicationRevision {
  revision: number;
  exportId: string;
  exportVersion: number;
  audioPath: string;
  bytes: number;
  durationSec: number;
  title: string;
  author: string;
  publishedDate: string | null;
  articleUrl: string | null;
  sections: PublicSection[];
  peaks: number[];
  publishedAt: number;
}

export interface NarratorPublicationDoc {
  ownerUid: string;
  editionId: string;
  status: 'published' | 'unpublished';
  revision: number;
  current: PublicationRevision | null;
  /** Replaced revisions still inside their grace window (deleted by maintenance). */
  retired: { revision: number; audioPath: string; until: number }[];
  history: { revision: number; exportVersion: number; at: number; action: 'published' | 'unpublished' }[];
  unpublishedAt: number | null;
  updatedAt: number;
}

/** Public-safe projection of a publication (or null when it must not be served). */
export function publicView(id: string, p: NarratorPublicationDoc | null | undefined): PublicAudioEdition | null {
  if (!p || p.status !== 'published' || !p.current) return null;
  const c = p.current;
  return {
    id,
    status: 'published',
    revision: c.revision,
    title: c.title,
    author: c.author,
    publication: 'The Pwavwe Papers',
    publishedDate: c.publishedDate,
    articleUrl: c.articleUrl,
    durationSec: c.durationSec,
    sections: c.sections.map((s) => ({ title: s.title, startSec: s.startSec })),
    peaks: c.peaks,
    audio: { url: `/api/public/audio/${id}/r/${c.revision}`, mimeType: 'audio/mpeg', bytes: c.bytes },
    updatedAt: c.publishedAt,
  };
}

/** Downsamples stored peaks for the public player (≤ 400 values). */
export function publicPeaks(peaks: number[] | null | undefined, max = 400): number[] {
  if (!peaks?.length) return [];
  if (peaks.length <= max) return peaks.map((x) => Math.round(x * 1000) / 1000);
  const out: number[] = [];
  for (let i = 0; i < max; i++) {
    const a = Math.floor((i / max) * peaks.length);
    const b = Math.max(a + 1, Math.floor(((i + 1) / max) * peaks.length));
    let m = 0;
    for (let j = a; j < b; j++) m = Math.max(m, peaks[j] ?? 0);
    out.push(Math.round(m * 1000) / 1000);
  }
  return out;
}

export const playerUrl = (publicId: string, origin: string = PUBLIC_PLAYER_ORIGIN) => `${origin.replace(/\/$/, '')}/embed/audio/${publicId}`;

/**
 * How the player colours itself. `light` is the Pwavwe Papers theme (warm ivory, near-black text, blue
 * playback accents) and the player's own default; `dark` is the coordinated navy; `auto` follows the
 * reader's system setting. An iframe does not inherit the blog's own light/dark toggle, so the embed says
 * which one it wants — see `PLAYER_THEME_SYNC` for the optional Blogger-side synchronisation.
 */
export type PlayerTheme = 'light' | 'dark' | 'auto';
export const PLAYER_THEMES = ['light', 'dark', 'auto'] as const satisfies readonly PlayerTheme[];
/** The theme the player uses when the URL says nothing (and the one the Papers embed asks for). */
export const DEFAULT_PLAYER_THEME: PlayerTheme = 'light';

/** The player URL an embed points at: the stable listening link plus the theme it should use. */
export function playerEmbedUrl(publicId: string, opts: { origin?: string; theme?: PlayerTheme } = {}): string {
  const theme = opts.theme ?? DEFAULT_PLAYER_THEME;
  return `${playerUrl(publicId, opts.origin ?? PUBLIC_PLAYER_ORIGIN)}?theme=${theme}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Height of the embedded player's box, per width of the page around it.
 *
 * The player keeps its transport on one row while it is at least ~550 px wide and drops it to a second row
 * below that; the title may also take another line as the column narrows. The heights below are the tallest
 * the player measures in each band (with a title long enough to wrap), so nothing is ever clipped.
 *
 * A `<style>` media query can only see the *page's* width, not the iframe's, and on The Pwavwe Papers the
 * post column runs about 28 px narrower than the viewport — hence the breakpoints. They are a close fit, not
 * a law: a template whose column is much narrower than its viewport should either raise them or use
 * `PLAYER_THEME_SYNC`, which sizes each iframe to its player exactly.
 */
export const EMBED_HEIGHT_PX = 156;
export const EMBED_HEIGHT_NARROW_PX = 224;
export const EMBED_HEIGHT_TINY_PX = 264;
export const EMBED_NARROW_MAX_PX = 576;
export const EMBED_TINY_MAX_PX = 312;

/**
 * Blogger-ready markup: a responsive HTTPS iframe of the stable player URL (never a storage URL), an
 * accessible title, no autoplay permission, and a small muted fallback link. No script is needed in the post.
 *
 * The height lives in a scoped `<style>` block (a media query gives narrow screens a taller box) with the
 * iframe's `height` attribute as the fallback if a template strips the block — so nothing here depends on
 * JavaScript, and the iframe is never left with a band of empty space below the player.
 */
export function azStudioEmbedHtml(publicId: string, title: string, opts: { origin?: string; theme?: PlayerTheme } = {}): string {
  const url = esc(playerEmbedUrl(publicId, opts));
  const open = esc(playerUrl(publicId, opts.origin ?? PUBLIC_PLAYER_ORIGIN));
  const t = esc(`Listen to ${title.trim()} — audio edition, The Pwavwe Papers`);
  const css = [
    `.pwavwe-audio-embed{--pwavwe-audio-h:${EMBED_HEIGHT_PX}px}`,
    `@media (max-width:${EMBED_NARROW_MAX_PX}px){.pwavwe-audio-embed{--pwavwe-audio-h:${EMBED_HEIGHT_NARROW_PX}px}}`,
    `@media (max-width:${EMBED_TINY_MAX_PX}px){.pwavwe-audio-embed{--pwavwe-audio-h:${EMBED_HEIGHT_TINY_PX}px}}`,
    `.pwavwe-audio-embed iframe{display:block;width:100%;height:var(--pwavwe-audio-h);border:0;border-radius:12px;overflow:hidden}`,
    `.pwavwe-audio-embed p{margin:.45em 0 0}`,
    // Specific enough to beat a theme's own `.post-content a` colour: the fallback link stays muted, and
    // takes the surrounding text's colour in whichever theme the blog is showing.
    `.pwavwe-audio-embed a.pwavwe-audio-open{font-size:.78em;color:inherit;opacity:.62;text-decoration:underline;text-underline-offset:.2em}`,
    `.pwavwe-audio-embed a.pwavwe-audio-open:hover,.pwavwe-audio-embed a.pwavwe-audio-open:focus{opacity:1}`,
  ].join('');
  return [
    `<!-- The Pwavwe Papers audio edition (AZ Studio player). Keep it near the top of the post. -->`,
    `<div class="pwavwe-audio-embed" style="margin:1.75em 0;max-width:760px;">`,
    `<style>${css}</style>`,
    `<iframe src="${url}" title="${t}" width="100%" height="${EMBED_HEIGHT_PX}" style="display:block;width:100%;border:0;border-radius:12px;overflow:hidden;" loading="lazy" scrolling="no" referrerpolicy="strict-origin-when-cross-origin">Listen to this paper: ${open}</iframe>`,
    `<p><a class="pwavwe-audio-open" href="${open}" target="_blank" rel="noopener">Open audio in a new tab</a></p>`,
    `</div>`,
  ].join('\n');
}

/**
 * Optional, separate from the post markup: the smallest Blogger-theme snippet that keeps the player in step
 * with the blog's own light/dark toggle, and sizes the iframe to the player exactly. It is given to the author
 * to paste into the theme (not into a post) — the embed above works without it.
 *
 * Written for The Pwavwe Papers theme as it stands (checked live 2026-10-18): dark mode is the class `dark`
 * on `<html>` (kept in `localStorage.pwavwe-theme`), not a `data-theme` attribute, and Blogger parses the
 * theme as XML, so the script body is inside `//<![CDATA[ … //]]>` like the theme's own scripts.
 *
 * The player answers `pwavwe-player-size` messages and accepts `pwavwe-player-theme` only from
 * `PUBLICATION_ORIGINS`; this side checks `event.origin` against the player origin before resizing.
 */
export const PLAYER_THEME_SYNC = `<script>
//<![CDATA[
/* The Pwavwe Papers audio player: keep embedded players on the blog's theme, and size them to their content. */
(function () {
  var ORIGIN = ${JSON.stringify(PUBLIC_PLAYER_ORIGIN)};
  var root = document.documentElement;
  function frames() { return document.querySelectorAll('.pwavwe-audio-embed iframe'); }
  function send() {
    // blogs.pwavwe.com marks dark mode with a class on <html>; data-theme is read too, for other templates.
    var dark = root.classList.contains('dark') || root.getAttribute('data-theme') === 'dark';
    Array.prototype.forEach.call(frames(), function (f) {
      if (f.contentWindow) f.contentWindow.postMessage({ type: 'pwavwe-player-theme', theme: dark ? 'dark' : 'light' }, ORIGIN);
    });
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN || !e.data || e.data.type !== 'pwavwe-player-size') return;
    var h = Number(e.data.height);
    if (!(h > 0) || h > 600) return;
    Array.prototype.forEach.call(frames(), function (f) {
      if (f.contentWindow === e.source) f.style.height = Math.round(h) + 'px';
    });
    send();
  });
  new MutationObserver(send).observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  window.addEventListener('load', send);
})();
//]]>
</script>`;

/** Parses a single Range header (`bytes=a-b`, `bytes=a-`, `bytes=-n`) against a size. */
export function parseRange(header: string | undefined | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    const n = Number(m[2]);
    if (!n) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
