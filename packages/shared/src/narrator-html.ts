/**
 * Extracts the article (title, date, body) from a Pwavwe Papers / Blogger page without a DOM: a small tag
 * scanner finds the article body container and converts its block elements to text. Navigation, comments,
 * scripts, styles, forms, figures and captions (image credits), embeds and share/related widgets are left
 * out. When the container is not found or the result looks thin, the extraction is marked for review —
 * a whole web page is never narrated by accident.
 */

export interface ExtractedArticle {
  title: string;
  publishedDate: string | null;
  author: string | null;
  /** Paragraphs separated by blank lines; headings as Markdown `## …`. */
  body: string;
  confidence: 'high' | 'review';
  container: string | null;
  notes: string[];
  /** A SoundCloud player already in the post (the article may already have an audio edition). */
  existingAudio: string | null;
  words: number;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•', copy: '©', eacute: 'é', egrave: 'è', ecirc: 'ê', aacute: 'á', agrave: 'à', ocirc: 'ô', uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', shy: '' };

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: string;
  start: number;
  end: number;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function* tags(html: string, from = 0, to = html.length): Generator<Tag> {
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && m.index < to) {
    if (!m[2]) continue;
    yield { name: m[2].toLowerCase(), closing: m[1] === '/', selfClosing: m[4] === '/' || VOID.has(m[2].toLowerCase()), attrs: m[3] ?? '', start: m.index, end: m.index + m[0].length };
  }
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/** Index range of the element starting at `open` (content between its open and matching close tag). */
function elementRange(html: string, open: Tag): { innerStart: number; innerEnd: number; end: number } {
  let depth = 1;
  for (const t of tags(html, open.end)) {
    if (t.name !== open.name || t.selfClosing) continue;
    depth += t.closing ? -1 : 1;
    if (depth === 0) return { innerStart: open.end, innerEnd: t.start, end: t.end };
  }
  return { innerStart: open.end, innerEnd: html.length, end: html.length };
}

const CONTAINER_TESTS: { label: string; test: (t: Tag) => boolean; strong: boolean }[] = [
  { label: '#postContent', test: (t) => attr(t.attrs, 'id') === 'postContent', strong: true },
  { label: '[itemprop=articleBody]', test: (t) => attr(t.attrs, 'itemprop') === 'articleBody', strong: true },
  { label: '.post-body', test: (t) => /(?:^|\s)post-body(?:\s|$)/.test(attr(t.attrs, 'class') ?? ''), strong: true },
  { label: '.entry-content', test: (t) => /(?:^|\s)entry-content(?:\s|$)/.test(attr(t.attrs, 'class') ?? ''), strong: true },
  { label: 'article', test: (t) => t.name === 'article', strong: false },
];

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'video', 'audio', 'figure', 'figcaption', 'form', 'button', 'nav', 'aside', 'svg', 'template', 'ins', 'select', 'textarea', 'canvas', 'picture', 'footer', 'header']);
const SKIP_CLASS = /(?:^|[\s_-])(?:share|sharing|related|advert|ads?|sponsor(?:ed)?|newsletter|subscribe|comments?|toc|table-of-contents|post-nav|author-box|byline|breadcrumbs?|social)(?:$|[\s_-])/i;
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'div', 'section', 'ul', 'ol', 'table', 'tr', 'dd', 'dt', 'hr']);

/** Converts the body HTML into paragraphs and `## headings`. */
export function htmlToArticleText(html: string): string {
  const blocks: string[] = [];
  let buf = '';
  let heading = 0;
  const flush = () => {
    const t = decodeHtmlEntities(buf)
      .replace(/[ \t\r\f\v]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
    if (t) blocks.push(heading ? `## ${t.replace(/\n/g, ' ')}` : t);
    buf = '';
    heading = 0;
  };
  let at = 0;
  const skipStack: string[] = [];
  for (const t of tags(html)) {
    if (!skipStack.length) buf += html.slice(at, t.start).replace(/\s+/g, ' ');
    at = t.end;
    if (skipStack.length) {
      if (t.name === skipStack[skipStack.length - 1] && !t.selfClosing) {
        if (t.closing) skipStack.pop();
        else skipStack.push(t.name);
      }
      continue;
    }
    if (!t.closing && !t.selfClosing && (SKIP_TAGS.has(t.name) || SKIP_CLASS.test(attr(t.attrs, 'class') ?? '') || attr(t.attrs, 'hidden') !== null || /display\s*:\s*none/i.test(attr(t.attrs, 'style') ?? ''))) {
      skipStack.push(t.name);
      continue;
    }
    if (t.name === 'br') buf += '\n';
    else if (BLOCK_TAGS.has(t.name)) {
      flush();
      if (!t.closing && /^h[1-6]$/.test(t.name)) heading = Number(t.name[1]);
    }
  }
  if (!skipStack.length) buf += html.slice(at).replace(/\s+/g, ' ');
  flush();
  return blocks.join('\n\n');
}

function metaContent(html: string, key: string, value: string): string | null {
  for (const t of tags(html)) {
    if (t.name !== 'meta') continue;
    if ((attr(t.attrs, key) ?? '').toLowerCase() === value.toLowerCase()) return attr(t.attrs, 'content');
  }
  return null;
}

function firstElementText(html: string, test: (t: Tag) => boolean): string | null {
  for (const t of tags(html)) {
    if (t.closing || t.selfClosing || !test(t)) continue;
    const r = elementRange(html, t);
    return decodeHtmlEntities(html.slice(r.innerStart, r.innerEnd).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() || null;
  }
  return null;
}

function isoDate(s: string | null): string | null {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim());
  return m ? m[1]! : null;
}

export function extractArticle(html: string): ExtractedArticle {
  const notes: string[] = [];
  let container: { label: string; strong: boolean; range: { innerStart: number; innerEnd: number } } | null = null;
  for (const c of CONTAINER_TESTS) {
    for (const t of tags(html)) {
      if (t.closing || t.selfClosing || !c.test(t)) continue;
      container = { label: c.label, strong: c.strong, range: elementRange(html, t) };
      break;
    }
    if (container) break;
  }
  const inner = container ? html.slice(container.range.innerStart, container.range.innerEnd) : '';
  const body = inner ? htmlToArticleText(inner) : '';
  const title =
    firstElementText(html, (t) => t.name === 'h1' && /(?:^|\s)(?:article-title|post-title|entry-title)(?:\s|$)/.test(attr(t.attrs, 'class') ?? '')) ??
    firstElementText(html, (t) => (t.name === 'h1' || t.name === 'h3') && attr(t.attrs, 'itemprop') === 'headline') ??
    (metaContent(html, 'property', 'og:title') ? decodeHtmlEntities(metaContent(html, 'property', 'og:title')!) : null) ??
    firstElementText(html, (t) => t.name === 'title') ??
    '';
  const publishedDate = isoDate(metaContent(html, 'itemprop', 'datePublished')) ?? isoDate(metaContent(html, 'property', 'article:published_time'));
  const byline = /<span>\s*By\s*<strong>([^<]{2,80})<\/strong>/i.exec(html)?.[1];
  const author = byline ? decodeHtmlEntities(byline).trim() : null;
  let existingAudio: string | null = null;
  for (const t of tags(inner)) {
    if (t.name !== 'iframe' || t.closing) continue;
    const src = attr(t.attrs, 'src') ?? '';
    if (/^https:\/\/w\.soundcloud\.com\/player\//i.test(src)) {
      existingAudio = src;
      break;
    }
  }
  const words = body.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const paragraphs = body.split(/\n\n/).filter((b) => b && !b.startsWith('## ')).length;
  let confidence: ExtractedArticle['confidence'] = 'high';
  if (!container) {
    confidence = 'review';
    notes.push('The article body could not be located on this page. Paste the article text instead.');
  } else if (!container.strong) {
    confidence = 'review';
    notes.push(`The body was taken from the page’s <${container.label}> element, which may include more than the article. Review it before narrating.`);
  }
  if (container && (words < 120 || paragraphs < 3)) {
    confidence = 'review';
    notes.push(`Only ${words} words in ${paragraphs} paragraph${paragraphs === 1 ? '' : 's'} were found — check that nothing is missing.`);
  }
  if (existingAudio) notes.push('This post already contains a SoundCloud player.');
  if (!title) notes.push('No title was found.');
  return { title: title.replace(/\s+[|–—-]\s+The Pwavwe Papers\s*$/i, '').trim(), publishedDate, author, body, confidence, container: container?.label ?? null, notes, existingAudio, words };
}
