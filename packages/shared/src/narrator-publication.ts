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

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Height of the embedded player (its layout is designed to fit this from 280 px wide upwards). */
export const EMBED_HEIGHT_PX = 196;

/**
 * Blogger-ready markup: a responsive HTTPS iframe of the stable player URL (never a storage URL), an
 * accessible title, no autoplay permission, and a plain fallback link. No script is needed in the post.
 */
export function azStudioEmbedHtml(publicId: string, title: string, origin: string = PUBLIC_PLAYER_ORIGIN): string {
  const url = esc(playerUrl(publicId, origin));
  const t = esc(`Listen to ${title.trim()} — audio edition, The Pwavwe Papers`);
  return [
    `<!-- The Pwavwe Papers audio edition (AZ Studio player). Keep it near the top of the post. -->`,
    `<div class="pwavwe-audio-embed" style="margin:1.5em 0;max-width:760px;">`,
    `<iframe src="${url}" title="${t}" width="100%" height="${EMBED_HEIGHT_PX}" style="display:block;width:100%;height:${EMBED_HEIGHT_PX}px;border:0;border-radius:16px;overflow:hidden;" loading="lazy" scrolling="no" referrerpolicy="strict-origin-when-cross-origin">Listen to this paper: ${url}</iframe>`,
    `<p style="margin:.5em 0 0;font-size:.85em;"><a href="${url}" target="_blank" rel="noopener">Listen to this paper</a></p>`,
    `</div>`,
  ].join('\n');
}

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
