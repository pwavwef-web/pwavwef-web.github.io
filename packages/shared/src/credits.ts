import type { MeasureText, SceneBlock, SceneLine, SceneWord, TextPaint, TextScene } from './text-scene';

/**
 * Credits Studio: opening/closing, rolling, card and side-by-side credit sequences built from the
 * project's own metadata (writer, director, performers, music, models used…), edited by hand, laid out
 * with the same text engine as lyrics and checked so they always finish before the video ends.
 */

export const CREDIT_KINDS = ['opening', 'closing'] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];
export const CREDIT_LAYOUTS = ['rolling', 'cards', 'side_by_side'] as const;
export type CreditLayout = (typeof CREDIT_LAYOUTS)[number];

export const CREDIT_SECTION_TYPES = ['title', 'cast', 'crew', 'music', 'voices', 'ai_disclosure', 'special_thanks', 'copyright', 'branding', 'custom'] as const;
export type CreditSectionType = (typeof CREDIT_SECTION_TYPES)[number];

export interface CreditEntry {
  role: string;
  names: string[];
}

export interface CreditSection {
  id: string;
  type: CreditSectionType;
  title: string;
  entries: CreditEntry[];
  /** Free text (disclosure, copyright, licence). */
  body: string;
}

export interface CreditSequenceDoc {
  id: string;
  name: string;
  kind: CreditKind;
  layout: CreditLayout;
  sections: CreditSection[];
  logoAssetIds: string[];
  background: { type: 'transparent' | 'black' | 'colour'; colour: string };
  musicAssetId: string | null;
  musicVolume: number;
  fontFamily: string;
  titleSizePct: number;
  bodySizePct: number;
  /** Space between sections (fraction of frame height). */
  sectionSpacing: number;
  lineSpacing: number;
  align: 'center' | 'left';
  fadeSec: number;
  /** Total length on the timeline (s). */
  durationSec: number;
  /** Seconds per card (cards layout). */
  cardSec: number;
  /** Extra safe margin (fraction of frame). */
  safeMargin: number;
  textColor: string;
  accentColor: string;
  /** Timeline start (s) — closing credits default to the end of the edit. */
  startSec: number | null;
  updatedAt?: unknown;
}

export interface CreditMetadata {
  title: string;
  writer: string[];
  director: string[];
  producer: string[];
  editors: string[];
  performers: { character: string; performer: string }[];
  voices: { character: string; voice: string }[];
  music: { title: string; artist: string; generatedBy: string | null }[];
  score: { title: string; generatedBy: string | null } | null;
  models: { modelId: string; displayName: string; assets: number }[];
  generatedAssets: number;
  productionDate: string;
  brand: string;
}

let n = 0;
const sid = () => `cs${Date.now().toString(36)}${(n = (n + 1) % 10000).toString(36)}`;

/** Builds a first draft of the credit sections from the project's metadata (always editable). */
export function creditsFromMetadata(m: CreditMetadata, kind: CreditKind): CreditSection[] {
  const sections: CreditSection[] = [];
  const entry = (role: string, names: string[]) => ({ role, names: names.filter((x) => x.trim()) });
  if (kind === 'opening') {
    sections.push({ id: sid(), type: 'branding', title: '', entries: [], body: `${m.brand} presents` });
    sections.push({ id: sid(), type: 'title', title: m.title, entries: [], body: '' });
    const crew = [entry('Written by', m.writer), entry('Directed by', m.director)].filter((e) => e.names.length);
    if (crew.length) sections.push({ id: sid(), type: 'crew', title: '', entries: crew, body: '' });
    return sections;
  }
  sections.push({ id: sid(), type: 'title', title: m.title, entries: [], body: '' });
  const crew = [entry('Directed by', m.director), entry('Written by', m.writer), entry('Produced by', m.producer), entry('Edited by', m.editors)].filter((e) => e.names.length);
  if (crew.length) sections.push({ id: sid(), type: 'crew', title: 'Crew', entries: crew, body: '' });
  const cast = m.performers.filter((p) => p.performer.trim()).map((p) => entry(p.character, [p.performer]));
  if (cast.length) sections.push({ id: sid(), type: 'cast', title: 'Cast', entries: cast, body: '' });
  const voices = m.voices.filter((v) => v.voice.trim()).map((v) => entry(v.character, [v.voice]));
  if (voices.length) sections.push({ id: sid(), type: 'voices', title: 'Voices', entries: voices, body: '' });
  const music = m.music.map((s) => entry(`“${s.title}”`, [s.artist || (s.generatedBy ? `Generated with ${s.generatedBy}` : '')]));
  if (m.score) music.push(entry('Original score', [m.score.generatedBy ? `Composed with ${m.score.generatedBy}` : m.score.title]));
  if (music.length) sections.push({ id: sid(), type: 'music', title: 'Music', entries: music.filter((e) => e.names.length), body: '' });
  if (m.models.length) {
    const lines = m.models.map((x) => `${x.displayName} (${x.modelId}) — ${x.assets} asset${x.assets === 1 ? '' : 's'}`);
    sections.push({
      id: sid(),
      type: 'ai_disclosure',
      title: 'AI disclosure',
      entries: [],
      body: `This production contains ${m.generatedAssets} AI-generated asset${m.generatedAssets === 1 ? '' : 's'} made in AZ Studio on Google Vertex AI: ${lines.join('; ')}. Generated media carries Google SynthID watermarks.`,
    });
  }
  sections.push({ id: sid(), type: 'copyright', title: '', entries: [], body: `© ${m.productionDate.slice(0, 4)} ${m.brand}. All rights reserved.` });
  sections.push({ id: sid(), type: 'branding', title: '', entries: [], body: `Made with AZ Studio · ${m.brand}` });
  return sections;
}

export function defaultCreditSequence(kind: CreditKind, sections: CreditSection[]): Omit<CreditSequenceDoc, 'id'> {
  return {
    name: kind === 'opening' ? 'Opening credits' : 'Closing credits',
    kind,
    layout: kind === 'opening' ? 'cards' : 'rolling',
    sections,
    logoAssetIds: [],
    background: { type: kind === 'opening' ? 'transparent' : 'black', colour: '#000000' },
    musicAssetId: null,
    musicVolume: 0.8,
    fontFamily: 'Inter',
    titleSizePct: 5.5,
    bodySizePct: 3.2,
    sectionSpacing: 0.06,
    lineSpacing: 1.45,
    align: 'center',
    fadeSec: 0.8,
    durationSec: kind === 'opening' ? 9 : 30,
    cardSec: 3,
    safeMargin: 0.06,
    textColor: '#F5F7FB',
    accentColor: '#F4B84A',
    startSec: null,
  };
}

interface Row {
  kind: 'title' | 'heading' | 'entry' | 'body' | 'gap';
  left: string;
  right: string;
  sectionId: string;
}

function rowsOf(seq: Pick<CreditSequenceDoc, 'sections'>): Row[] {
  const rows: Row[] = [];
  for (const s of seq.sections) {
    if (rows.length) rows.push({ kind: 'gap', left: '', right: '', sectionId: s.id });
    if (s.type === 'title' && s.title.trim()) rows.push({ kind: 'title', left: s.title, right: '', sectionId: s.id });
    else if (s.title.trim()) rows.push({ kind: 'heading', left: s.title, right: '', sectionId: s.id });
    for (const e of s.entries) {
      if (!e.names.length) continue;
      e.names.forEach((name, i) => rows.push({ kind: 'entry', left: i === 0 ? e.role : '', right: name, sectionId: s.id }));
    }
    if (s.body.trim()) rows.push({ kind: 'body', left: s.body, right: '', sectionId: s.id });
  }
  return rows;
}

export interface CreditsLayoutResult {
  scene: TextScene;
  /** The moment the last line leaves the frame / the last card ends (s, absolute). */
  finishesAt: number;
  issues: string[];
}

function wrap(text: string, paint: TextPaint, measure: MeasureText, maxW: number): string[] {
  const font = { family: paint.fontFamily, weight: paint.fontWeight, italic: paint.italic, sizePx: paint.sizePx, letterSpacingPx: paint.letterSpacingPx };
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && measure(next, font).width > maxW) {
      out.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

/** Lays out a credit sequence starting at `start` (absolute seconds) in a frame. */
export function layoutCredits(seq: CreditSequenceDoc, frame: { width: number; height: number }, start: number, measure: MeasureText, videoEnd: number | null = null): CreditsLayoutResult {
  const W = frame.width;
  const H = frame.height;
  const ref = H > W ? W : H;
  const issues: string[] = [];
  const paint = (sizePct: number, weight: number, color: string, italic = false): TextPaint => ({
    fontFamily: seq.fontFamily,
    fontWeight: weight,
    italic,
    sizePx: (sizePct / 100) * ref,
    letterSpacingPx: 0,
    color,
    inactiveColor: color,
    opacity: 1,
    outline: seq.background.type === 'transparent' ? { width: ref / 540, color: '#000000' } : null,
    shadow: seq.background.type === 'transparent' ? { x: 0, y: ref / 540, blur: 2, color: '#000000', opacity: 0.6 } : null,
    glow: null,
    gradient: null,
  });
  const titleP = paint(seq.titleSizePct, 800, seq.textColor);
  const headP = paint(seq.bodySizePct * 0.8, 700, seq.accentColor);
  const roleP = paint(seq.bodySizePct, 400, seq.textColor);
  const nameP = paint(seq.bodySizePct, 700, seq.textColor);
  const bodyP = paint(seq.bodySizePct * 0.85, 400, seq.textColor, true);
  const margin = (seq.safeMargin + 0.02) * W;
  const colW = W - 2 * margin;
  const sideBySide = seq.layout === 'side_by_side';
  const gutter = ref * 0.03;
  const rows = rowsOf(seq);
  const lines: SceneLine[] = [];
  let y = 0;
  const mk = (text: string, p: TextPaint, x: number): SceneLine => {
    const m = measure(text, { family: p.fontFamily, weight: p.fontWeight, italic: p.italic, sizePx: p.sizePx, letterSpacingPx: 0 });
    const word: SceneWord = { text, x, y: 0, width: m.width, start: null, end: null, scale: 1 };
    return { words: [word], x, y: 0, width: m.width, ascent: m.ascent, descent: m.descent, paint: p, start: null, end: null };
  };
  const place = (l: SceneLine, align: 'center' | 'left' | 'right', anchorX: number) => {
    l.x = align === 'center' ? anchorX - l.width / 2 : align === 'right' ? anchorX - l.width : anchorX;
    l.words[0]!.x = l.x;
  };
  const rowGroups: { lines: SceneLine[]; top: number; bottom: number; sectionId: string }[] = [];
  for (const r of rows) {
    if (r.kind === 'gap') {
      y += seq.sectionSpacing * H;
      continue;
    }
    const top = y;
    // Visual rows of this credit row: items in one visual row share a baseline.
    const visual: SceneLine[][] = [];
    if (r.kind === 'entry') {
      const role = r.left ? mk(r.left, roleP, 0) : null;
      const name = mk(r.right, nameP, 0);
      if (seq.align === 'left' && !sideBySide) {
        const l = mk(r.left ? `${r.left} — ${r.right}` : r.right, nameP, margin);
        visual.push([l]);
      } else if (sideBySide || (role && role.width + name.width + gutter < colW) || !role) {
        if (role) place(role, 'right', W / 2 - gutter / 2);
        place(name, role || sideBySide ? 'left' : 'center', role || sideBySide ? W / 2 + gutter / 2 : W / 2);
        visual.push(role ? [role, name] : [name]);
      } else {
        place(role, 'center', W / 2);
        place(name, 'center', W / 2);
        visual.push([role], [name]);
      }
    } else {
      const p = r.kind === 'title' ? titleP : r.kind === 'heading' ? headP : bodyP;
      for (const text of wrap(r.left, p, measure, colW)) {
        const l = mk(text, p, 0);
        place(l, seq.align === 'left' ? 'left' : 'center', seq.align === 'left' ? margin : W / 2);
        visual.push([l]);
      }
    }
    const group: SceneLine[] = [];
    for (const row of visual) {
      const lh = Math.max(...row.map((l) => l.paint.sizePx)) * seq.lineSpacing;
      const asc = Math.max(...row.map((l) => l.ascent));
      const desc = Math.max(...row.map((l) => l.descent));
      const baseline = y + (lh + asc - desc) / 2;
      for (const l of row) {
        l.y = baseline;
        l.words[0]!.y = baseline;
        group.push(l);
      }
      y += lh;
    }
    lines.push(...group);
    rowGroups.push({ lines: group, top, bottom: y, sectionId: r.sectionId });
  }
  const totalH = y;
  const blocks: SceneBlock[] = [];
  const bg = seq.background.type === 'transparent' ? null : { color: seq.background.type === 'black' ? '#000000' : seq.background.colour, opacity: 1 };
  let finishesAt: number;
  const baseBlock = (id: string, s: number, e: number, ls: SceneLine[], motion: SceneBlock['motion'], entrance: SceneBlock['entrance'], exit: SceneBlock['exit']): SceneBlock => ({
    id,
    refs: [seq.id],
    start: s,
    end: e,
    lines: ls,
    box: null,
    blur: null,
    entrance,
    exit,
    transitionSec: seq.fadeSec,
    effect: 'none',
    wordPop: false,
    motion,
    rotation: null,
    ball: null,
    dim: bg,
    layer: 6,
    bounds: { x: margin, y: 0, w: colW, h: totalH },
  });
  if (seq.layout === 'rolling') {
    // Everything starts just below the frame and scrolls until the last line has left the top.
    const travel = H + totalH;
    const dur = Math.max(1, seq.durationSec);
    const speed = travel / dur;
    const shifted = lines.map((l) => ({ ...l, y: l.y + H, words: l.words.map((w) => ({ ...w, y: w.y + H })) }));
    blocks.push(baseBlock(`${seq.id}_roll`, start, start + dur, shifted, { dx: 0, dy: -travel }, 'none', 'none'));
    finishesAt = start + dur;
    if (speed > ref * 0.12) issues.push(`Credits scroll at ${Math.round(speed)} px/s — too fast to read; lengthen the sequence to at least ${Math.ceil(travel / (ref * 0.12))} s.`);
  } else {
    // Cards: sections grouped so each card fits the safe area; each card holds for cardSec.
    const usable = H * (1 - 2 * (seq.safeMargin + 0.04));
    const cards: (typeof rowGroups)[] = [];
    let cur: typeof rowGroups = [];
    let h = 0;
    for (const g of rowGroups) {
      const gh = g.bottom - g.top;
      const newSection = cur.length && cur[cur.length - 1]!.sectionId !== g.sectionId;
      if (cur.length && (h + gh > usable || (newSection && h > usable * 0.45))) {
        cards.push(cur);
        cur = [];
        h = 0;
      }
      cur.push(g);
      h += gh;
    }
    if (cur.length) cards.push(cur);
    let t = start;
    cards.forEach((card, i) => {
      const cardTop = card[0]!.top;
      const cardH = card[card.length - 1]!.bottom - cardTop;
      const offset = (H - cardH) / 2 - cardTop;
      const ls = card.flatMap((g) => g.lines).map((l) => ({ ...l, y: l.y + offset, words: l.words.map((w) => ({ ...w, y: w.y + offset })) }));
      blocks.push({ ...baseBlock(`${seq.id}_card${i}`, t, t + seq.cardSec, ls, null, 'fade', 'fade'), bounds: { x: margin, y: (H - cardH) / 2, w: colW, h: cardH } });
      t += seq.cardSec;
      if (cardH > H * 0.95) issues.push(`Card ${i + 1} is taller than the frame — reduce the text size or split the section.`);
    });
    finishesAt = t;
  }
  if (videoEnd !== null && finishesAt > videoEnd + 1e-3) issues.push(`The credits finish at ${finishesAt.toFixed(1)} s but the video ends at ${videoEnd.toFixed(1)} s — shorten them, start earlier or extend the ending.`);
  for (const l of lines) if (l.width > W - 2 * (seq.safeMargin * W)) issues.push(`“${l.words[0]!.text.slice(0, 40)}” is wider than the safe area.`);
  return { scene: { width: W, height: H, blocks }, finishesAt, issues: [...new Set(issues)] };
}

/** Where closing credits should start so they end exactly `tail` seconds before the video ends. */
export function closingCreditsStart(videoEnd: number, durationSec: number, tail = 0.5): number {
  return Math.max(0, Math.round((videoEnd - durationSec - tail) * 1000) / 1000);
}
