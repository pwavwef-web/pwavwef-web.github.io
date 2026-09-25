import {
  LYRIC_ASPECTS,
  layoutCredits,
  layoutLyrics,
  reframeAt,
  resolveLyricStyle,
  type Box,
  type Clip,
  type LyricAspect,
  type LyricInputLine,
  type LyricStyle,
  type LyricStyleDoc,
  type RenderTextInputs,
  type SceneBlock,
  type TextScene,
} from '@az-studio/shared';
import type { FontBook } from './fonts';
import type { RenderSnapshot } from './graph';

export interface TextBuild {
  scene: TextScene | null;
  issues: { lineId: string; kind: string; message: string; clipId: string | null; start: number | null }[];
  credits: { clipId: string; name: string; finishesAt: number; issues: string[] }[];
  /** Clips drawn by the text engine (the legacy caption renderer skips them). */
  handled: Set<string>;
  notes: string[];
}

const end = (c: Clip) => c.start + c.duration;

/** Maps a source-frame box into the output frame for a picture clip (fit mode or reframe path). */
export function boxToOutput(box: Box, c: Clip, src: { w: number; h: number }, out: { w: number; h: number }, aspect: string, clipLocalT: number): Box | null {
  const track = c.reframe?.[aspect];
  let fx: number;
  let fy: number;
  let fw: number;
  let fh: number;
  if (track && track.keyframes.length) {
    const ctr = reframeAt(track.keyframes, clipLocalT);
    fw = track.crop.w;
    fh = track.crop.h;
    fx = Math.min(1 - fw, Math.max(0, ctr.cx - fw / 2));
    fy = Math.min(1 - fh, Math.max(0, ctr.cy - fh / 2));
  } else if (c.fit === 'fit' || c.fit === 'blur') {
    // The whole source is visible, letterboxed: map the output frame onto the source instead.
    const s = Math.min(out.w / src.w, out.h / src.h);
    const cw = (src.w * s) / out.w;
    const ch = (src.h * s) / out.h;
    return { x: (1 - cw) / 2 + box.x * cw, y: (1 - ch) / 2 + box.y * ch, w: box.w * cw, h: box.h * ch };
  } else {
    const s = Math.max(out.w / src.w, out.h / src.h);
    fw = out.w / (src.w * s);
    fh = out.h / (src.h * s);
    fx = (1 - fw) / 2;
    fy = (1 - fh) / 2;
  }
  const b = { x: (box.x - fx) / fw, y: (box.y - fy) / fh, w: box.w / fw, h: box.h / fh };
  if (b.x > 1 || b.y > 1 || b.x + b.w < 0 || b.y + b.h < 0) return null;
  return b;
}

/** Faces visible in the output frame during [start, end) (from the picture clips' face tracks). */
function facesDuring(snap: RenderSnapshot, inputs: RenderTextInputs, start: number, stop: number, aspect: string): Box[] {
  const visual = new Set(snap.tracks.filter((t) => (t.kind === 'video' || t.kind === 'overlay') && !t.muted).map((t) => t.id));
  const out: Box[] = [];
  for (const c of snap.clips) {
    if (!visual.has(c.trackId) || (c.kind !== 'video' && c.kind !== 'image') || !c.assetId) continue;
    if (c.start >= stop || end(c) <= start) continue;
    const samples = inputs.faces[c.assetId];
    const a = snap.assets[c.assetId];
    if (!samples?.length || !a?.width || !a.height) continue;
    const from = Math.max(start, c.start) - c.start + c.inPoint;
    const to = Math.min(stop, end(c)) - c.start + c.inPoint;
    for (const smp of samples) {
      if (smp.t < from - 0.6 || smp.t > to + 0.6) continue;
      for (const bx of smp.boxes) {
        const m = boxToOutput(bx, c, { w: a.width, h: a.height }, { w: snap.width, h: snap.height }, aspect, smp.t - c.inPoint);
        if (m) out.push(m);
      }
    }
  }
  return out;
}

function fontsOf(style: LyricStyle, fontsByLabel: Map<string, string>): { family: string; weight: number; italic: boolean }[] {
  const family = fontsByLabel.get(style.fontFamily) ?? style.fontFamily;
  return [
    { family, weight: style.fontWeight, italic: style.italic },
    { family, weight: style.fontWeight, italic: false },
  ];
}

/**
 * Lays out every styled lyric line and credit sequence of the render with the real fonts. The result
 * is one text scene with absolute times, drawn per segment by libass.
 */
export async function buildTextScene(snap: RenderSnapshot, inputs: RenderTextInputs | null | undefined, book: FontBook, fontsByLabel: Map<string, string>): Promise<TextBuild> {
  const empty: TextBuild = { scene: null, issues: [], credits: [], handled: new Set(), notes: [] };
  if (!inputs) return empty;
  const aspect = ((LYRIC_ASPECTS as readonly string[]).includes(inputs.aspect) ? inputs.aspect : '16:9') as LyricAspect;
  const visible = new Set(snap.tracks.filter((t) => !t.muted).map((t) => t.id));
  const blocks: SceneBlock[] = [];
  const out: TextBuild = { scene: null, issues: [], credits: [], handled: new Set(), notes: [] };
  const rename = (s: LyricStyle): LyricStyle => ({ ...s, fontFamily: fontsByLabel.get(s.fontFamily) ?? s.fontFamily });

  // Lyrics, song by song (each song has its own style document).
  const bySong = new Map<string, Clip[]>();
  for (const c of snap.clips) {
    if (!c.lyric || !visible.has(c.trackId) || !c.text.trim() || !inputs.lyricStyles[c.lyric.songId]) continue;
    const list = bySong.get(c.lyric.songId) ?? [];
    list.push(c);
    bySong.set(c.lyric.songId, list);
  }
  for (const [songId, clips] of bySong) {
    const entry = inputs.lyricStyles[songId]!;
    const doc = { global: rename(entry.style.global), sections: Object.fromEntries(Object.entries(entry.style.sections ?? {}).map(([k, v]) => [k, v?.fontFamily ? { ...v, fontFamily: fontsByLabel.get(v.fontFamily) ?? v.fontFamily } : v])) } as Pick<LyricStyleDoc, 'global' | 'sections'>;
    const lines: LyricInputLine[] = clips.map((c) => {
      const section = inputs.sections[songId]?.[c.lyric!.lineId] ?? null;
      return {
        id: c.id,
        text: c.text,
        start: c.start,
        end: end(c),
        section,
        words: c.karaoke?.length ? c.karaoke.map((u) => ({ text: u.text, start: c.start + u.start, end: c.start + u.end })) : null,
        translation: inputs.translations[songId]?.[c.lyric!.lineId] ?? null,
        avoid: facesDuring(snap, inputs, c.start, end(c), aspect),
        placement: entry.placements[c.lyric!.lineId] ?? null,
      };
    });
    const wanted = new Map<string, { family: string; weight: number; italic: boolean }>();
    for (const l of lines) for (const f of fontsOf(resolveLyricStyle(doc, l.section, aspect), fontsByLabel)) wanted.set(`${f.family}|${f.weight}|${f.italic}`, f);
    for (const f of wanted.values()) await book.load(f.family, f.weight, f.italic);
    const layout = layoutLyrics({ lines, doc, aspect, width: snap.width, height: snap.height, measure: book.measure, fps: snap.fps });
    blocks.push(...layout.scene.blocks);
    for (const i of layout.issues) {
      const c = clips.find((x) => x.id === i.lineId);
      out.issues.push({ lineId: i.lineId, kind: i.kind, message: i.message, clipId: c?.id ?? null, start: c?.start ?? null });
    }
    for (const c of clips) out.handled.add(c.id);
  }

  // Credit sequences.
  for (const c of snap.clips) {
    if (!c.credits || !visible.has(c.trackId)) continue;
    const seq = inputs.credits[c.credits.sequenceId];
    if (!seq) {
      out.notes.push(`Credit sequence ${c.credits.sequenceId} no longer exists; its clip was left empty.`);
      out.handled.add(c.id);
      continue;
    }
    const family = fontsByLabel.get(seq.fontFamily) ?? seq.fontFamily;
    for (const w of [300, 400, 500, 600, 700, 800]) await book.load(family, w, false);
    await book.load(family, 400, true);
    const res = layoutCredits({ ...seq, fontFamily: family }, { width: snap.width, height: snap.height }, c.start, book.measure, snap.durationSec);
    blocks.push(...res.scene.blocks);
    out.credits.push({ clipId: c.id, name: seq.kind === 'opening' ? 'Opening credits' : 'Closing credits', finishesAt: res.finishesAt, issues: res.issues });
    out.handled.add(c.id);
  }
  out.notes.push(...book.notes);
  out.scene = blocks.length ? { width: snap.width, height: snap.height, blocks } : null;
  return out;
}

/** Background-blur regions of text blocks that overlap a window (absolute seconds, output px). */
export function blurRegions(scene: TextScene | null, window: { start: number; end: number }): { x: number; y: number; w: number; h: number; radius: number; start: number; end: number }[] {
  if (!scene) return [];
  return scene.blocks
    .filter((b) => b.blur && b.start < window.end && b.end > window.start && !b.motion)
    .map((b) => ({ ...b.blur!, start: Math.max(b.start, window.start), end: Math.min(b.end, window.end) }));
}

export type { RenderSnapshot, RenderTextInputs };
