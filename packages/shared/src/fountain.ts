/**
 * Fountain screenplay parser (https://fountain.io/syntax). Produces typed elements for the
 * editor preview and print export, a scene list for breakdowns, and a page-count estimate.
 */

export type FountainElementType =
  | 'scene_heading'
  | 'action'
  | 'character'
  | 'dialogue'
  | 'parenthetical'
  | 'transition'
  | 'centered'
  | 'section'
  | 'synopsis'
  | 'note'
  | 'page_break'
  | 'lyric';

export interface FountainElement {
  type: FountainElementType;
  text: string;
  line: number;
  sceneNumber?: string;
  dual?: boolean;
  depth?: number;
}

export interface FountainScene {
  index: number;
  heading: string;
  intExt: 'INT' | 'EXT' | 'INT/EXT' | '';
  location: string;
  timeOfDay: string;
  number: string | null;
  characters: string[];
  line: number;
  /** Estimated length in screenplay pages (≈ minutes of screen time). */
  pages: number;
  synopsis: string;
}

export interface FountainDocument {
  titlePage: Record<string, string>;
  elements: FountainElement[];
  scenes: FountainScene[];
  characters: string[];
  pageCount: number;
}

const HEADING_RE = /^(?:\.(?!\.)|(?:int|ext|est|int\.?\/ext|i\/e)[. ])/i;
const TRANSITION_RE = /^[A-Z0-9 .'’-]+TO:$/;
const SCENE_NUMBER_RE = /\s*#([\w.-]+)#\s*$/;
const LINES_PER_PAGE = 55;

function isUpper(line: string): boolean {
  const letters = line.replace(/\(.*?\)/g, '').replace(/[^A-Za-z]/g, '');
  return letters.length > 0 && letters === letters.toUpperCase();
}

function stripBoneyard(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));
}

export function parseHeading(raw: string): { intExt: FountainScene['intExt']; location: string; timeOfDay: string; number: string | null; heading: string } {
  let heading = raw.trim();
  let number: string | null = null;
  const num = SCENE_NUMBER_RE.exec(heading);
  if (num) {
    number = num[1]!;
    heading = heading.replace(SCENE_NUMBER_RE, '');
  }
  if (heading.startsWith('.') && !heading.startsWith('..')) heading = heading.slice(1);
  heading = heading.trim();
  const upper = heading.toUpperCase();
  let intExt: FountainScene['intExt'] = '';
  let rest = heading;
  const m = /^(INT\.?\/EXT|I\/E|INT|EXT|EST)[.\s]+/i.exec(heading);
  if (m) {
    const tag = m[1]!.toUpperCase();
    intExt = tag.includes('/') ? 'INT/EXT' : tag.startsWith('INT') ? 'INT' : tag === 'EST' ? 'EXT' : 'EXT';
    rest = heading.slice(m[0].length);
  }
  const dash = rest.lastIndexOf(' - ');
  const location = (dash >= 0 ? rest.slice(0, dash) : rest).trim();
  const timeOfDay = dash >= 0 ? rest.slice(dash + 3).trim() : '';
  return { intExt, location, timeOfDay, number, heading: upper };
}

export function parseFountain(source: string): FountainDocument {
  const src = stripBoneyard(source.replace(/\r\n?/g, '\n'));
  const lines = src.split('\n');
  const titlePage: Record<string, string> = {};
  let i = 0;

  // Title page: key/value pairs at the very top, terminated by a blank line.
  if (lines.length && /^[A-Za-z ]+:/.test(lines[0] ?? '')) {
    let key = '';
    for (; i < lines.length; i++) {
      const l = lines[i]!;
      if (!l.trim()) {
        i++;
        break;
      }
      const kv = /^([A-Za-z ]+):\s*(.*)$/.exec(l);
      if (kv && !/^\s/.test(l)) {
        key = kv[1]!.trim().toLowerCase();
        titlePage[key] = kv[2]!.trim();
      } else if (key) {
        titlePage[key] = `${titlePage[key] ? `${titlePage[key]}\n` : ''}${l.trim()}`;
      }
    }
  }

  const elements: FountainElement[] = [];
  let inDialogue = false;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trimEnd();
    const trimmed = line.trim();
    const prevBlank = i === 0 || !(lines[i - 1] ?? '').trim();
    const nextLine = lines[i + 1] ?? '';
    const nextBlank = !nextLine.trim();

    if (!trimmed) {
      inDialogue = false;
      continue;
    }
    if (/^={3,}$/.test(trimmed)) {
      elements.push({ type: 'page_break', text: '', line: i });
      inDialogue = false;
      continue;
    }
    if (inDialogue) {
      if (/^\(.*\)$/.test(trimmed)) elements.push({ type: 'parenthetical', text: trimmed, line: i });
      else elements.push({ type: 'dialogue', text: trimmed.replace(/^ {2}$/, ''), line: i });
      continue;
    }
    if (trimmed.startsWith('#')) {
      const depth = /^#+/.exec(trimmed)![0].length;
      elements.push({ type: 'section', text: trimmed.slice(depth).trim(), line: i, depth });
      continue;
    }
    if (trimmed.startsWith('=') && !trimmed.startsWith('==')) {
      elements.push({ type: 'synopsis', text: trimmed.slice(1).trim(), line: i });
      continue;
    }
    if (/^\[\[[\s\S]*\]\]$/.test(trimmed)) {
      elements.push({ type: 'note', text: trimmed.slice(2, -2).trim(), line: i });
      continue;
    }
    if (trimmed.startsWith('~')) {
      elements.push({ type: 'lyric', text: trimmed.slice(1).trim(), line: i });
      continue;
    }
    if (trimmed.startsWith('!')) {
      elements.push({ type: 'action', text: trimmed.slice(1), line: i });
      continue;
    }
    if (/^>.*<$/.test(trimmed)) {
      elements.push({ type: 'centered', text: trimmed.slice(1, -1).trim(), line: i });
      continue;
    }
    if (prevBlank && HEADING_RE.test(trimmed)) {
      const h = parseHeading(trimmed);
      elements.push({ type: 'scene_heading', text: h.heading, line: i, ...(h.number ? { sceneNumber: h.number } : {}) });
      continue;
    }
    if (trimmed.startsWith('>') || (prevBlank && nextBlank && TRANSITION_RE.test(trimmed))) {
      elements.push({ type: 'transition', text: trimmed.replace(/^>\s*/, '').toUpperCase(), line: i });
      continue;
    }
    const forcedChar = trimmed.startsWith('@');
    if (prevBlank && !nextBlank && (forcedChar || (isUpper(trimmed) && !/^[^A-Za-z]*$/.test(trimmed)))) {
      let name = forcedChar ? trimmed.slice(1) : trimmed;
      const dual = name.endsWith('^');
      if (dual) name = name.slice(0, -1).trim();
      elements.push({ type: 'character', text: name.trim(), line: i, ...(dual ? { dual: true } : {}) });
      inDialogue = true;
      continue;
    }
    // Action (consecutive lines are kept as separate elements for line accuracy).
    elements.push({ type: 'action', text: line.replace(/^\t/, '    '), line: i });
  }

  // Scenes and characters.
  const scenes: FountainScene[] = [];
  const allChars = new Set<string>();
  let current: FountainScene | null = null;
  let currentLines = 0;
  const flush = () => {
    if (current) {
      current.pages = Math.round((currentLines / LINES_PER_PAGE) * 100) / 100;
      scenes.push(current);
    }
  };
  let totalLines = 0;
  for (const el of elements) {
    const l = estimateLines(el);
    totalLines += l;
    if (el.type === 'scene_heading') {
      flush();
      const h = parseHeading(el.text);
      current = {
        index: scenes.length,
        heading: h.heading,
        intExt: h.intExt,
        location: h.location,
        timeOfDay: h.timeOfDay,
        number: el.sceneNumber ?? null,
        characters: [],
        line: el.line,
        pages: 0,
        synopsis: '',
      };
      currentLines = l;
      continue;
    }
    currentLines += l;
    if (el.type === 'character') {
      const name = characterName(el.text);
      if (name) {
        allChars.add(name);
        if (current && !current.characters.includes(name)) current.characters.push(name);
      }
    }
    if (el.type === 'synopsis' && current && !current.synopsis) current.synopsis = el.text;
  }
  flush();
  return {
    titlePage,
    elements,
    scenes,
    characters: [...allChars].sort(),
    pageCount: Math.max(elements.length ? 0.1 : 0, Math.round((totalLines / LINES_PER_PAGE) * 10) / 10),
  };
}

/** Removes extensions such as (V.O.), (O.S.), (CONT'D). */
export function characterName(raw: string): string {
  return raw
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function wrapCount(text: string, width: number): number {
  return Math.max(1, Math.ceil(text.length / width));
}

function estimateLines(el: FountainElement): number {
  switch (el.type) {
    case 'scene_heading':
      return 3;
    case 'action':
      return wrapCount(el.text, 60) + 1;
    case 'character':
      return 2;
    case 'dialogue':
      return wrapCount(el.text, 35);
    case 'parenthetical':
      return wrapCount(el.text, 25);
    case 'transition':
      return 2;
    case 'centered':
    case 'lyric':
      return 2;
    case 'page_break':
      return 0;
    default:
      return 0;
  }
}

/** Estimated runtime in minutes (industry rule of thumb: one page ≈ one minute). */
export function estimateRuntimeMinutes(doc: FountainDocument): number {
  return Math.round(doc.pageCount * 10) / 10;
}

/** Replaces the Fountain text between [start, end) character offsets. */
export function replaceRange(source: string, start: number, end: number, replacement: string): string {
  return source.slice(0, start) + replacement + source.slice(end);
}
