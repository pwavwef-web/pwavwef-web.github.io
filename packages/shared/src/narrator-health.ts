import type { NarratorExportDoc } from './narrator';
import { EMBED_HEIGHT_NARROW_PX, EMBED_HEIGHT_PX, EMBED_HEIGHT_TINY_PX, PLAYER_THEMES, PUBLIC_PLAYER_ORIGIN, azStudioEmbedHtml, playerEmbedUrl, playerUrl, type NarratorPublicationDoc, type PlayerTheme } from './narrator-publication';

/**
 * Publication health for the Narrator: which export each published paper plays, whether a newer finished export
 * of the same edition is waiting, and whether the live blog post still carries the current player markup.
 *
 * The post is read as text only (the server fetches it with the article importer's protections); nothing in it is
 * executed or copied anywhere. The comparison looks only at the player block: the iframe's src and `?theme=`, the
 * box height (the scoped `<style>` heights and the `height` fallback) and the fallback link below the player.
 */

export interface PlayerBlock {
  /** An iframe of this publication's AZ Studio player was found. */
  found: boolean;
  /** What the post embeds instead when it is not the AZ Studio player. */
  other: 'soundcloud' | 'other_player' | null;
  src: string | null;
  theme: PlayerTheme | null;
  /** The iframe's `height` attribute (fallback when a template drops the style block). */
  heightAttr: number | null;
  /** `--pwavwe-audio-h` values in the scoped style block, in source order (base, narrow, tiny). */
  styleHeights: number[];
  /** The small "Open audio in a new tab" link (class `pwavwe-audio-open`). */
  fallback: { href: string; text: string } | null;
  /** The older large "Listen to this paper" link that took the blog's link colour. */
  legacyLink: boolean;
}

export type EmbedProblemCode = 'no_player' | 'soundcloud' | 'other_player' | 'no_theme' | 'wrong_src' | 'height' | 'no_style' | 'fallback_missing' | 'fallback_old';

export interface EmbedProblem {
  code: EmbedProblemCode;
  message: string;
}

const decode = (s: string) =>
  s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '') : null;
};

const stripTags = (s: string) => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Reads the player block of one publication from a page's HTML (Blogger re-serialises markup; attributes are read loosely). */
export function readPlayerBlock(html: string, publicId: string, origin: string = PUBLIC_PLAYER_ORIGIN): PlayerBlock {
  const out: PlayerBlock = { found: false, other: null, src: null, theme: null, heightAttr: null, styleHeights: [], fallback: null, legacyLink: false };
  const player = playerUrl(publicId, origin);
  const iframes = [...html.matchAll(/<iframe\b[^>]*>/gi)].map((m) => ({ tag: m[0], at: m.index ?? 0 }));
  const mine = iframes.find((f) => (attr(f.tag, 'src') ?? '').split(/[?#]/)[0]!.replace(/\/$/, '') === player);
  if (!mine) {
    const srcs = iframes.map((f) => attr(f.tag, 'src') ?? '');
    if (srcs.some((s) => /^https:\/\/w\.soundcloud\.com\/player/i.test(s))) out.other = 'soundcloud';
    else if (srcs.some((s) => s.includes('/embed/audio/'))) out.other = 'other_player';
    return out;
  }
  out.found = true;
  out.src = attr(mine.tag, 'src');
  try {
    const t = new URL(out.src ?? '').searchParams.get('theme');
    out.theme = (PLAYER_THEMES as readonly string[]).includes(t ?? '') ? (t as PlayerTheme) : null;
  } catch {
    out.theme = null;
  }
  const h = Number(attr(mine.tag, 'height'));
  out.heightAttr = Number.isFinite(h) && h > 0 ? h : null;
  // The player block: from the wrapper that opens before the iframe to a little after it.
  const from = Math.max(0, mine.at - 6000);
  let start = mine.at;
  for (const m of html.slice(from, mine.at).matchAll(/<div\b[^>]*\bpwavwe-audio-embed\b[^>]*>/gi)) start = from + (m.index ?? 0);
  const block = html.slice(start, Math.min(html.length, mine.at + 4000));
  const style = /<style\b[^>]*>([\s\S]*?)<\/style>/i.exec(html.slice(start, mine.at))?.[1] ?? '';
  out.styleHeights = [...style.matchAll(/--pwavwe-audio-h\s*:\s*(\d+(?:\.\d+)?)px/gi)].map((m) => Number(m[1]));
  const after = block.slice(block.indexOf(mine.tag) + mine.tag.length);
  for (const m of after.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(` ${m[1]}`, 'href') ?? '';
    const cls = attr(` ${m[1]}`, 'class') ?? '';
    const text = stripTags(m[2] ?? '');
    if (/\bpwavwe-audio-open\b/.test(cls)) out.fallback = { href, text };
    else if (href.split(/[?#]/)[0] === player && /listen to this paper/i.test(text)) out.legacyLink = true;
    if (out.fallback) break;
  }
  return out;
}

/** The block today's markup would produce for this publication (theme kept from the post when it states one). */
export function expectedPlayerBlock(publicId: string, title: string, theme: PlayerTheme | null, origin: string = PUBLIC_PLAYER_ORIGIN): PlayerBlock & { html: string } {
  const html = azStudioEmbedHtml(publicId, title, { origin, theme: theme ?? undefined });
  return { ...readPlayerBlock(html, publicId, origin), html };
}

/** Differences between the live block and today's markup (empty = current). */
export function compareEmbed(found: PlayerBlock, publicId: string, origin: string = PUBLIC_PLAYER_ORIGIN): EmbedProblem[] {
  if (!found.found) {
    if (found.other === 'soundcloud') return [{ code: 'soundcloud', message: 'The post plays the SoundCloud copy, not the AZ Studio player.' }];
    if (found.other === 'other_player') return [{ code: 'other_player', message: 'The post embeds a different AZ Studio player (another publication id).' }];
    return [{ code: 'no_player', message: 'No AZ Studio player for this paper was found in the post.' }];
  }
  const problems: EmbedProblem[] = [];
  const want = expectedPlayerBlock(publicId, '', found.theme, origin);
  if (!found.theme) problems.push({ code: 'no_theme', message: 'The iframe does not state a theme (`?theme=`), so it may not match the blog.' });
  else if (found.src !== playerEmbedUrl(publicId, { origin, theme: found.theme })) problems.push({ code: 'wrong_src', message: `The iframe address differs from today's (${playerEmbedUrl(publicId, { origin, theme: found.theme })}).` });
  if (!found.styleHeights.length) problems.push({ code: 'no_style', message: 'The scoped style block is missing, so narrow screens do not get the taller box.' });
  else if (want.styleHeights.join(',') !== found.styleHeights.join(',')) problems.push({ code: 'height', message: `Box heights ${found.styleHeights.join(' / ')} px differ from today's ${[EMBED_HEIGHT_PX, EMBED_HEIGHT_NARROW_PX, EMBED_HEIGHT_TINY_PX].join(' / ')} px.` });
  if (found.heightAttr !== EMBED_HEIGHT_PX) problems.push({ code: 'height', message: `The iframe's height fallback is ${found.heightAttr ?? 'missing'}${found.heightAttr ? ' px' : ''}; today's is ${EMBED_HEIGHT_PX} px.` });
  if (found.legacyLink) problems.push({ code: 'fallback_old', message: 'The post still has the large "Listen to this paper" link under the player.' });
  else if (!found.fallback || found.fallback.href !== want.fallback?.href) problems.push({ code: 'fallback_missing', message: 'The small "Open audio in a new tab" link is missing or points elsewhere.' });
  return problems;
}

export type ExportWaiting = 'none' | 'ready' | 'rendering' | 'failed';

export interface PublicationExportState {
  liveExportId: string | null;
  liveVersion: number | null;
  /** The newest export of the edition that is newer than the live one. */
  newer: { exportId: string; version: number; status: NarratorExportDoc['status']; durationSec: number | null } | null;
  /**
   * `ready`: a finished export is waiting to be published (exports record no listening review — the publish step asks
   * for it); `rendering` / `failed`: the newest export is not usable yet.
   */
  waiting: ExportWaiting;
}

export function publicationExportState(pub: Pick<NarratorPublicationDoc, 'current' | 'status'>, exports: (Pick<NarratorExportDoc, 'version' | 'status' | 'durationSec'> & { id: string })[]): PublicationExportState {
  const liveVersion = pub.current?.exportVersion ?? null;
  const later = exports.filter((e) => e.version > (liveVersion ?? 0)).sort((a, b) => b.version - a.version);
  const readyNewer = later.find((e) => e.status === 'ready');
  const pick = readyNewer ?? later[0] ?? null;
  return {
    liveExportId: pub.current?.exportId ?? null,
    liveVersion,
    newer: pick ? { exportId: pick.id, version: pick.version, status: pick.status, durationSec: pick.durationSec } : null,
    waiting: readyNewer ? 'ready' : pick ? (pick.status === 'failed' ? 'failed' : 'rendering') : 'none',
  };
}
