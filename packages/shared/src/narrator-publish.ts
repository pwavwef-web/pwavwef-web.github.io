import { NARRATOR, type NarratorEditionDoc, type NarratorExportDoc, type NarratorScript } from './narrator';
import { flattenScript } from './narrator-text';

/**
 * Export names, transcript, SoundCloud handoff text and the Blogger embed. Pasted SoundCloud input is
 * parsed as text and validated; nothing pasted is ever executed or copied into the embed — the embed is
 * rebuilt from the validated track URL only.
 */

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

export function slugify(s: string, max = 80): string {
  const base = s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[“”"'‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (base.slice(0, max).replace(/-+$/g, '') || 'audio-edition');
}

export function exportFileNames(title: string, publishedDate: string | null, version: number): NarratorExportDoc['fileNames'] {
  const date = publishedDate && /^\d{4}-\d{2}-\d{2}$/.test(publishedDate) ? `${publishedDate}-` : '';
  const base = `pwavwe-papers-${date}${slugify(title, 70)}${version > 1 ? `-v${version}` : ''}`;
  return { wav: `${base}.wav`, mp3: `${base}.mp3`, transcript: `${base}-transcript.txt`, chapters: `${base}-sections.txt` };
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/** A readable transcript of what is spoken (in order; skipped passages left out). */
export function transcriptText(edition: Pick<NarratorEditionDoc, 'title' | 'author' | 'publishedDate' | 'sourceUrl' | 'script' | 'settings'>): string {
  const lines: string[] = [edition.title, `By ${edition.author || NARRATOR.defaultAuthor}`];
  if (edition.publishedDate) lines.push(`Published ${edition.publishedDate}`);
  if (edition.sourceUrl) lines.push(edition.sourceUrl);
  lines.push('', `Audio edition transcript — ${NARRATOR.publication}`, '');
  for (const f of flattenScript(edition.script, edition.settings.includeClosing)) {
    if (f.passage.skip || !f.passage.text.trim()) continue;
    if (f.passage.kind === 'heading') lines.push('', f.passage.text.toUpperCase(), '');
    else lines.push(f.passage.text.trim(), '');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Section start times measured from the assembled audio. */
export function sectionsText(sections: NarratorExportDoc['sections']): string {
  return `${sections.map((s) => `${fmtClock(s.startSec)}  ${s.title}`).join('\n')}\n`;
}

export function sectionTitleOf(script: NarratorScript, sectionId: string | null, kind: string): string {
  if (kind === 'opening') return 'Opening';
  if (kind === 'closing') return 'Closing';
  return script.sections.find((s) => s.id === sectionId)?.title ?? 'Introduction';
}

// ---------------------------------------------------------------------------
// SoundCloud
// ---------------------------------------------------------------------------

export function defaultSoundCloudTitle(title: string): string {
  return `${title} — ${NARRATOR.publication}`.slice(0, 100);
}

/** Editable description for the manual SoundCloud upload. Nothing is invented: only known fields are used. */
export function defaultSoundCloudDescription(edition: Pick<NarratorEditionDoc, 'title' | 'author' | 'publishedDate' | 'sourceUrl'>): string {
  const lines = [`${edition.title}`, `Written and read by ${edition.author || NARRATOR.defaultAuthor}.`, `An audio edition of ${NARRATOR.publication}.`];
  if (edition.sourceUrl) lines.push('', `Read the article: ${edition.sourceUrl}`);
  lines.push('', `More papers: ${NARRATOR.site}`);
  lines.push('', 'Narrated with a replica of the author’s own voice, created with his recorded consent.');
  return lines.join('\n');
}

export type SoundCloudParse = { ok: true; trackUrl: string; playerSrc: string; pageUrl: string } | { ok: false; error: string };

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));

function safeUrl(s: string): URL | null {
  try {
    const u = new URL(s.trim());
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
    return u;
  } catch {
    return null;
  }
}

/** A public (or secret-token) SoundCloud track page: soundcloud.com/{user}/{track}[/s-{token}]. */
export function soundCloudTrackPage(raw: string): string | null {
  const u = safeUrl(raw);
  if (!u || !/^(?:www\.|m\.)?soundcloud\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return null;
  const [user, track, token] = parts;
  if (!/^[\w-]{1,100}$/.test(user!) || !/^[\w-]{1,255}$/.test(track!)) return null;
  if (['sets', 'tracks', 'likes', 'reposts', 'albums', 'popular-tracks', 'following', 'followers', 'comments'].includes(track!.toLowerCase())) return null;
  if (token !== undefined && !/^s-[\w]{3,40}$/.test(token)) return null;
  return `https://soundcloud.com/${user}/${track}${token ? `/${token}` : ''}`;
}

/** An API track URL as found in the player's `url` parameter: api.soundcloud.com/tracks/{id}[?secret_token=s-…]. */
function apiTrackUrl(raw: string): string | null {
  const u = safeUrl(raw);
  if (!u || u.hostname.toLowerCase() !== 'api.soundcloud.com') return null;
  const m = /^\/tracks\/(?:soundcloud(?::|%3A)tracks(?::|%3A))?(\d{1,20})\/?$/i.exec(u.pathname);
  if (!m) return null;
  const token = u.searchParams.get('secret_token');
  if (token !== null && !/^s-[\w]{3,40}$/.test(token)) return null;
  return `https://api.soundcloud.com/tracks/${m[1]}${token ? `?secret_token=${token}` : ''}`;
}

const PLAYER_PARAMS = 'color=%231d4fb8&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false';

export function playerSrcFor(trackUrl: string): string {
  return `https://w.soundcloud.com/player/?url=${encodeURIComponent(trackUrl)}&${PLAYER_PARAMS}`;
}

/**
 * Accepts a SoundCloud track URL, or SoundCloud's own embed code (only an `iframe` whose `src` is the
 * w.soundcloud.com player is read; every other attribute and element is ignored). Short links
 * (on.soundcloud.com) and playlists are refused with an explanation.
 */
export function parseSoundCloudInput(input: string): SoundCloudParse {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Paste the SoundCloud track URL or its embed code.' };
  if (raw.length > 5000) return { ok: false, error: 'That is too long to be a SoundCloud link or embed code.' };
  if (/^https?:\/\/on\.soundcloud\.com\//i.test(raw)) return { ok: false, error: 'Short links (on.soundcloud.com) cannot be checked here. Open the track and copy the full soundcloud.com address, or use Share → Embed.' };
  if (/^https?:\/\//i.test(raw)) {
    const page = soundCloudTrackPage(raw);
    if (!page) return { ok: false, error: raw.includes('/sets/') ? 'This is a playlist. Paste the link of the single track for this paper.' : 'This is not a SoundCloud track address (expected https://soundcloud.com/you/track-name).' };
    return { ok: true, trackUrl: page, playerSrc: playerSrcFor(page), pageUrl: page };
  }
  const iframe = /<iframe\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(raw);
  if (!iframe) return { ok: false, error: 'No SoundCloud player was found. Paste the track URL, or the embed code from Share → Embed.' };
  const src = safeUrl(decodeEntities(iframe[1] ?? iframe[2] ?? iframe[3] ?? ''));
  if (!src || src.hostname.toLowerCase() !== 'w.soundcloud.com' || !/^\/player\/?$/.test(src.pathname)) return { ok: false, error: 'The embed code does not use SoundCloud’s player (w.soundcloud.com). Only SoundCloud embeds are accepted.' };
  const inner = src.searchParams.get('url') ?? '';
  const track = apiTrackUrl(inner) ?? soundCloudTrackPage(inner);
  if (!track) return { ok: false, error: inner.includes('/playlists/') ? 'This embed is a playlist. Embed the single track instead.' : 'The embed does not point to a SoundCloud track.' };
  // SoundCloud's copied code ends with a credit line linking the track page; use it as the fallback link.
  const pages = [...raw.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => soundCloudTrackPage(decodeEntities(m[1] ?? m[2] ?? ''))).filter((p): p is string => Boolean(p));
  const page = pages[pages.length - 1] ?? (track.startsWith('https://soundcloud.com/') ? track : null);
  if (!page) return { ok: false, error: 'The embed has no link to the track page. Paste the track URL as well (or instead).' };
  return { ok: true, trackUrl: track, playerSrc: playerSrcFor(track), pageUrl: page };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Blogger HTML for the paper's audio. `theme`: The Pwavwe Papers theme (blogs.pwavwe.com) moves the first
 * SoundCloud player in a post into its own "Listen to this paper" panel under the title — so the block is the
 * player plus SoundCloud's credit line (the theme keeps it as the fallback link). `standalone`: a self-contained
 * responsive block with its own label, for any other template. Paste it at the top of the post body; the rest
 * of the post HTML stays as it is.
 */
export function bloggerEmbedHtml(link: { playerSrc: string; pageUrl: string }, title: string, variant: 'theme' | 'standalone'): string {
  const src = esc(link.playerSrc);
  const page = esc(link.pageUrl);
  const label = esc(`Listen to ${title} on SoundCloud`);
  if (variant === 'theme') {
    return [
      `<!-- Pwavwe Narrator audio edition: keep this at the top of the post. -->`,
      `<iframe width="100%" height="166" scrolling="no" frameborder="no" allow="autoplay" loading="lazy" title="${label}" src="${src}"></iframe>`,
      `<div style="font-size: 10px; color: #cccccc; line-break: anywhere; word-break: normal; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;"><a href="${page}" target="_blank" rel="noopener">Listen to this paper on SoundCloud</a></div>`,
    ].join('\n');
  }
  return [
    `<!-- Pwavwe Narrator audio edition: place under the title / introduction. -->`,
    `<figure class="pwavwe-audio" style="margin:1.5em 0;padding:0;">`,
    `  <figcaption style="font-weight:600;margin:0 0 .5em;">Listen to this paper</figcaption>`,
    `  <iframe style="display:block;width:100%;max-width:100%;border:0;" height="166" scrolling="no" allow="autoplay" loading="lazy" title="${label}" src="${src}"></iframe>`,
    `  <p style="font-size:.85em;margin:.4em 0 0;"><a href="${page}" target="_blank" rel="noopener">Open the audio on SoundCloud</a></p>`,
    `</figure>`,
  ].join('\n');
}
