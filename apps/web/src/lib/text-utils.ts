import { parseFountain, type LyricLine, type SceneDoc, type ShotDoc } from '@az-studio/shared';

/** Screenplay text between a scene heading and the next one. */
export function sceneText(fountain: string, sceneIndex: number): string {
  const doc = parseFountain(fountain);
  const lines = fountain.replace(/\r\n?/g, '\n').split('\n');
  const start = doc.scenes[sceneIndex]?.line;
  if (start === undefined) return '';
  const end = doc.scenes[sceneIndex + 1]?.line ?? lines.length;
  return lines.slice(start, end).join('\n').slice(0, 20000);
}

/**
 * Parses LRC (`[mm:ss.xx] line`) or plain lyrics. Plain lines are spread evenly across the song so
 * they can be refined by hand or replaced by AI transcription.
 */
export function parseLyrics(text: string, duration: number): LyricLine[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const timed: { t: number; text: string }[] = [];
  const re = /\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]/g;
  for (const raw of lines) {
    const tags = [...raw.matchAll(re)];
    const body = raw.replace(re, '').trim();
    for (const m of tags) timed.push({ t: Number(m[1]) * 60 + Number(m[2]), text: body });
  }
  if (timed.length) {
    timed.sort((a, b) => a.t - b.t);
    const out: LyricLine[] = [];
    timed.forEach((l, i) => {
      if (!l.text) return;
      const end = Math.min(duration || Number.MAX_SAFE_INTEGER, timed[i + 1]?.t ?? l.t + 4);
      out.push({ id: `l${i}`, start: Math.round(l.t * 1000) / 1000, end: Math.round(Math.max(end, l.t + 0.1) * 1000) / 1000, text: l.text });
    });
    return out;
  }
  const plain = lines.map((l) => l.trim()).filter((l) => l && !/^\[.*\]$/.test(l));
  const step = (duration || plain.length * 4) / Math.max(1, plain.length);
  return plain.map((t, i) => ({ id: `l${i}`, start: Math.round(i * step * 100) / 100, end: Math.round((i + 1) * step * 100) / 100, text: t }));
}

const csvCell = (v: unknown) => {
  const s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function shotListCsv(scenes: (SceneDoc & { id: string })[], shots: (ShotDoc & { id: string })[]): string {
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const header = ['Scene', 'Heading', 'Shot', 'Title', 'Description', 'Framing', 'Camera', 'Lens', 'Lighting', 'Mood', 'Performance', 'Action', 'Dialogue', 'Sound', 'Duration (s)', 'Aspect', 'Resolution', 'Status', 'Takes', 'Approved take'];
  const rows = [...shots]
    .sort((a, b) => (sceneById.get(a.sceneId ?? '')?.order ?? 1e9) - (sceneById.get(b.sceneId ?? '')?.order ?? 1e9) || a.order - b.order)
    .map((s) => {
      const sc = s.sceneId ? sceneById.get(s.sceneId) : undefined;
      const d = s.directions;
      return [sc?.number ?? '', sc?.heading ?? '', s.number, s.title, s.description, d.framing, d.cameraMovement, d.lens, d.lighting, d.mood, d.performance, d.action, d.dialogue.map((l) => `${l.character}: ${l.line}`), d.ambientSound, s.durationSec, s.aspectRatio, s.resolution, s.status, s.takeCount, s.approvedTakeId ?? '']
        .map(csvCell)
        .join(',');
    });
  return [header.join(','), ...rows].join('\n') + '\n';
}
