export interface Cue {
  start: number;
  end: number;
  text: string;
}

const TIMESTAMP = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function parseTimestamp(s: string): number | null {
  const m = TIMESTAMP.exec(s.trim());
  if (!m) return null;
  const [, h, min, sec, frac] = m;
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec) + Number(frac!.padEnd(3, '0')) / 1000;
}

/** Parses SubRip (.srt) or WebVTT (.vtt) into cues; numbering, headers, cue settings and tags are ignored. */
export function parseSubtitles(text: string): Cue[] {
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a = '', b = ''] = lines[i]!.split('-->');
    const start = parseTimestamp(a);
    const end = parseTimestamp(b.trim().split(/\s+/)[0] ?? '');
    if (start === null || end === null || end <= start) continue;
    const body = lines
      .slice(i + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\[^}]*\}/g, '')
      .trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

function srtTimestamp(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(Math.floor((ms % 60_000) / 1000))},${pad(ms % 1000, 3)}`;
}

export function formatSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(c.end)}\n${c.text}\n`).join('\n');
}
