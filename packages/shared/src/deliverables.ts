import type { Clip } from './types';
import type { Cue } from './subtitles';

/**
 * One-click deliverables pack: one edit rendered in every format the client asked for (final quality, each inspected
 * like any final render), plus a poster, a thumbnail per format, captions (SRT and VTT) and a read-me, each file
 * verified (frame count, length, sound present, loudness and peak) and zipped. A pack waits for its renders and their
 * export checks; a blocked check holds the pack until it is resolved or overridden.
 */
export const PACK_PRESETS = ['vertical_9x16', 'portrait_4x5', 'square_1x1', 'youtube_16x9'] as const;
export type PackPreset = (typeof PACK_PRESETS)[number];
export const PACK_PRESET_LABELS: Record<PackPreset, string> = { vertical_9x16: '9:16 vertical', portrait_4x5: '4:5 portrait', square_1x1: '1:1 square', youtube_16x9: '16:9 landscape' };

export type PackStatus = 'rendering' | 'waiting_checks' | 'blocked' | 'assembling' | 'ready' | 'failed';

export interface PackFileCheck {
  name: string;
  kind: 'video' | 'poster' | 'thumbnail' | 'captions' | 'readme';
  bytes: number;
  preset?: PackPreset;
  width?: number;
  height?: number;
  durationSec?: number;
  frames?: number;
  expectedFrames?: number;
  lufs?: number | null;
  truePeakDb?: number | null;
  issues: string[];
}

export interface PackDoc {
  id: string;
  ownerUid: string;
  projectId: string;
  timelineId: string;
  title: string;
  presets: PackPreset[];
  posterAtSec: number;
  audioMaster: 'normalize' | 'preserve';
  status: PackStatus;
  message: string;
  renderIds: Partial<Record<PackPreset, string>>;
  files: PackFileCheck[];
  zip: { storagePath: string; bytes: number } | null;
  jobId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Caption cues from a timeline's caption clips (narration captions and lyric captions), in time order, merged when identical. */
export function packCaptions(clips: Pick<Clip, 'kind' | 'start' | 'duration' | 'text'>[]): Cue[] {
  const cues = clips
    .filter((c) => c.kind === 'caption' && (c.text ?? '').trim())
    .map((c) => ({ start: Math.max(0, c.start), end: Math.max(0, c.start + c.duration), text: (c.text ?? '').trim() }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Cue[] = [];
  for (const c of cues) {
    const prev = out.at(-1);
    if (prev && prev.text === c.text && c.start <= prev.end + 0.05) prev.end = Math.max(prev.end, c.end);
    else out.push({ ...c });
  }
  return out;
}

/** What is wrong with one rendered file (empty = fine). Loudness is judged only when the mix was normalised. */
export function checkPackVideo(m: { durationSec: number | null; frames: number | null; hasAudio: boolean; lufs: number | null; truePeakDb: number | null }, expected: { durationSec: number; fps: number; audioMaster: 'normalize' | 'preserve' }): string[] {
  const issues: string[] = [];
  const want = Math.round(expected.durationSec * expected.fps);
  if (m.frames === null) issues.push('The frame count could not be read.');
  else if (Math.abs(m.frames - want) > 1) issues.push(`${m.frames} frames instead of ${want} (${(Math.abs(m.frames - want) / expected.fps).toFixed(2)} s ${m.frames < want ? 'short' : 'long'}).`);
  if (m.durationSec !== null && Math.abs(m.durationSec - expected.durationSec) > 2 / expected.fps + 0.05) issues.push(`The file runs ${m.durationSec.toFixed(2)} s instead of ${expected.durationSec.toFixed(2)} s.`);
  if (!m.hasAudio) issues.push('The file has no sound.');
  else if (expected.audioMaster === 'normalize') {
    if (m.lufs !== null && Math.abs(m.lufs - -14) > 1.5) issues.push(`Loudness ${m.lufs.toFixed(1)} LUFS, outside −14 ± 1.5.`);
    if (m.truePeakDb !== null && m.truePeakDb > -0.5) issues.push(`True peak ${m.truePeakDb.toFixed(1)} dBTP, above −0.5.`);
  }
  return issues;
}

export function packReadme(p: { title: string; projectTitle: string; createdAt: number; files: PackFileCheck[]; captions: number }): string {
  const lines = [
    `${p.title}`,
    `${'='.repeat(Math.min(72, Math.max(8, p.title.length)))}`,
    '',
    `Project: ${p.projectTitle}`,
    `Made with AZ Studio on ${new Date(p.createdAt).toISOString().slice(0, 10)}.`,
    '',
    'Files',
    '-----',
  ];
  for (const f of p.files) {
    const spec = f.kind === 'video' ? ` — ${f.width}×${f.height}, ${f.durationSec?.toFixed(2)} s, ${f.frames} frames${f.lufs !== null && f.lufs !== undefined ? `, ${f.lufs.toFixed(1)} LUFS` : ''}${f.truePeakDb !== null && f.truePeakDb !== undefined ? `, peak ${f.truePeakDb.toFixed(1)} dBTP` : ''}` : f.width ? ` — ${f.width}×${f.height}` : '';
    lines.push(`${f.name}${spec}${f.issues.length ? `  [check: ${f.issues.join(' ')}]` : ''}`);
  }
  lines.push('', p.captions ? `Captions: ${p.captions} cues, as SubRip (.srt) and WebVTT (.vtt).` : 'Captions: this edit has no captions.', '', 'Every video was checked after rendering: frame count and length against the edit, sound present, loudness and true peak.', '');
  return lines.join('\n');
}

/** A file-name-safe slug. */
export function packSlug(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .toLowerCase()
      .slice(0, 60) || 'deliverables'
  );
}
