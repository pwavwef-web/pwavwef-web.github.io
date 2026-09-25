import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import opentype from 'opentype.js';
import { approximateMeasure, type MeasureText, type TextMetrics } from '@az-studio/shared';

const execFileAsync = promisify(execFile);

/** CSS weight → fontconfig weight name. */
export function fcWeight(w: number): string {
  if (w <= 150) return 'thin';
  if (w <= 250) return 'extralight';
  if (w <= 350) return 'light';
  if (w <= 450) return 'regular';
  if (w <= 550) return 'medium';
  if (w <= 650) return 'demibold';
  if (w <= 750) return 'bold';
  if (w <= 850) return 'extrabold';
  return 'black';
}

interface Loaded {
  family: string;
  file: string;
  font: opentype.Font;
  /** libass font size for an em size: (winAscent + winDescent) / unitsPerEm. */
  assScale: number;
  substituted: boolean;
}

interface Registered {
  family: string;
  file: string;
  weight: number;
  italic: boolean;
}

const key = (family: string, weight: number, italic: boolean) => `${family.toLowerCase()}|${Math.round(weight / 100) * 100}|${italic ? 'i' : 'n'}`;

function parse(buf: Buffer): opentype.Font {
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

/**
 * The exact fonts libass will draw with, measured with their real metrics so the layout engine wraps,
 * places and checks text (cropping, diacritics, safe areas) against what is actually rendered.
 */
export class FontBook {
  private loaded = new Map<string, Loaded>();
  private registered: Registered[] = [];
  readonly notes: string[] = [];

  /** Registers an uploaded font file (it is also in libass's fontsdir). Returns its internal family name. */
  async register(file: string): Promise<string | null> {
    try {
      const font = parse(await readFile(file));
      const family = font.names.fontFamily?.en ?? Object.values(font.names.fontFamily ?? {})[0] ?? null;
      if (!family) return null;
      const os2 = font.tables.os2 as { usWeightClass?: number; fsSelection?: number } | undefined;
      this.registered.push({ family, file, weight: os2?.usWeightClass ?? 400, italic: Boolean((os2?.fsSelection ?? 0) & 1) });
      return family;
    } catch (e) {
      this.notes.push(`Could not read the uploaded font ${file}: ${String((e as Error).message).slice(0, 120)}`);
      return null;
    }
  }

  private async resolveFile(family: string, weight: number, italic: boolean): Promise<{ file: string; substituted: boolean }> {
    const own = this.registered.filter((r) => r.family.toLowerCase() === family.toLowerCase());
    if (own.length) {
      const best = [...own].sort((a, b) => Number(a.italic !== italic) - Number(b.italic !== italic) || Math.abs(a.weight - weight) - Math.abs(b.weight - weight))[0]!;
      return { file: best.file, substituted: false };
    }
    const { stdout } = await execFileAsync('fc-match', ['-f', '%{file}\n%{family}', `${family}:weight=${fcWeight(weight)}${italic ? ':slant=italic' : ''}`]);
    const [file, matched] = stdout.split('\n');
    if (!file) throw new Error(`No font found for ${family}`);
    const substituted = !(matched ?? '').toLowerCase().split(',').some((f) => f.trim() === family.toLowerCase());
    return { file: file.trim(), substituted };
  }

  /** Loads every font a layout will measure (measuring itself is synchronous). */
  async load(family: string, weight: number, italic: boolean): Promise<void> {
    const k = key(family, weight, italic);
    if (this.loaded.has(k)) return;
    try {
      const { file, substituted } = await this.resolveFile(family, weight, italic);
      const font = parse(await readFile(file));
      const os2 = font.tables.os2 as { usWinAscent?: number; usWinDescent?: number } | undefined;
      const assScale = os2?.usWinAscent && os2.usWinDescent ? (os2.usWinAscent + os2.usWinDescent) / font.unitsPerEm : (font.ascender - font.descender) / font.unitsPerEm;
      if (substituted) this.notes.push(`“${family}” is not installed; fontconfig substituted ${file.split('/').pop()}.`);
      this.loaded.set(k, { family, file, font, assScale, substituted });
    } catch (e) {
      this.notes.push(`Font ${family} ${weight}: ${String((e as Error).message).slice(0, 120)} — approximate metrics used.`);
    }
  }

  private get(family: string, weight: number, italic: boolean): Loaded | null {
    return this.loaded.get(key(family, weight, italic)) ?? null;
  }

  measure: MeasureText = (text, f): TextMetrics => {
    const lf = this.get(f.family, f.weight, f.italic);
    if (!lf) return approximateMeasure(text, f);
    const chars = [...text].length;
    const width = lf.font.getAdvanceWidth(text, f.sizePx, { kerning: true }) + Math.max(0, chars - 1) * f.letterSpacingPx;
    // Real glyph extents (accents and descenders included), not just the font's nominal ascent.
    const box = text.trim() ? lf.font.getPath(text, 0, 0, f.sizePx).getBoundingBox() : null;
    const scale = f.sizePx / lf.font.unitsPerEm;
    const ascent = box && Number.isFinite(box.y1) ? Math.max(-box.y1, lf.font.ascender * scale * 0.7) : lf.font.ascender * scale;
    const descent = box && Number.isFinite(box.y2) ? Math.max(box.y2, 0) : -lf.font.descender * scale;
    return { width, ascent, descent };
  };

  fontScale = (family: string, weight: number): number => this.get(family, weight, false)?.assScale ?? this.get(family, weight, true)?.assScale ?? 1.21;
}
