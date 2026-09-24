import type { LyricsSheet } from './lyrics';
import type { MusicAnalysis } from './music-analysis';
import type { SectionLabel, Time } from './types';

/**
 * Music Studio: a focused AI songwriting, soundtrack and finishing workspace (not a DAW). A music
 * project holds the song brief, its versions (generated, uploaded, arranged, mixed), mix tracks and
 * separated stems. Lyria 3.5 generates whole songs or passages; it cannot edit part of an existing
 * recording, so section work is done honestly: re-generating the song, generating a replacement
 * passage, or arranging/blending real audio with FFmpeg — and every version says which one it was.
 */

export const MUSIC_MODES = ['lyrics_only', 'song', 'instrumental', 'film_score', 'jingle', 'upload', 'alternate', 'intro_outro', 'scene_background', 'from_media'] as const;
export type MusicMode = (typeof MUSIC_MODES)[number];

export const MUSIC_MODE_LABELS: Record<MusicMode, string> = {
  lyrics_only: 'Lyrics only',
  song: 'Complete song',
  instrumental: 'Instrumental',
  film_score: 'Film score cue',
  jingle: 'Short jingle',
  upload: 'Upload & analyse',
  alternate: 'Alternate version',
  intro_outro: 'Intro or outro',
  scene_background: 'Scene background music',
  from_media: 'From an image, treatment or screenplay',
};

export const VOCAL_OPTIONS = ['none', 'lead', 'duet', 'group', 'choir', 'rap', 'spoken'] as const;
export type VocalOption = (typeof VOCAL_OPTIONS)[number];

export interface StructurePart {
  id: string;
  label: SectionLabel;
  name: string;
  /** Preferred length in seconds (null = let the model decide). */
  seconds: number | null;
  notes: string;
}

export interface MusicBrief {
  title: string;
  concept: string;
  language: string;
  genre: string;
  subgenre: string;
  mood: string;
  tempoBpm: number | null;
  key: string;
  timeSignature: string;
  durationSec: number;
  vocals: VocalOption;
  vocalCharacter: string;
  instrumentation: string[];
  structure: StructurePart[];
  introSec: number | null;
  verseCount: number;
  chorusCount: number;
  bridge: boolean;
  outro: boolean;
  energy: string;
  culturalDirection: string;
  avoidInstruments: string[];
  explicit: 'clean' | 'allowed';
}

export const EMPTY_BRIEF: MusicBrief = {
  title: '',
  concept: '',
  language: 'en',
  genre: '',
  subgenre: '',
  mood: '',
  tempoBpm: null,
  key: '',
  timeSignature: '4/4',
  durationSec: 150,
  vocals: 'lead',
  vocalCharacter: '',
  instrumentation: [],
  structure: [],
  introSec: null,
  verseCount: 2,
  chorusCount: 3,
  bridge: true,
  outro: true,
  energy: '',
  culturalDirection: '',
  avoidInstruments: [],
  explicit: 'clean',
};

export interface MusicMarker {
  id: string;
  t: number;
  label: string;
  color: string;
}

export interface SectionEdit {
  id: string;
  label: SectionLabel;
  name: string;
  start: number;
  end: number;
  /** Arrangement controls. */
  loop: number;
  muted: boolean;
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
  /** Visual idea attached to this part of the song (used by the music-video treatment). */
  visualIdea: string;
}

export interface MusicProjectDoc {
  id: string;
  mode: MusicMode;
  brief: MusicBrief;
  lyricsText: string;
  lyricsSheetId: string | null;
  /** Linked song (lyric sheet, analysis) used by music videos. */
  songId: string | null;
  masterVersionId: string | null;
  sections: SectionEdit[];
  markers: MusicMarker[];
  mix: MixSettings;
  updatedAt?: Time;
}

export type VersionSource = 'lyria' | 'upload' | 'recording' | 'arrangement' | 'mixdown' | 'replacement' | 'stems_remix';

export const VERSION_SOURCE_LABELS: Record<VersionSource, string> = {
  lyria: 'Generated song',
  upload: 'Uploaded audio',
  recording: 'Recorded in the studio',
  arrangement: 'Arrangement edit (real audio, re-ordered)',
  mixdown: 'Mixdown',
  replacement: 'Replacement passage blended in',
  stems_remix: 'Remix of separated stems',
};

export interface MusicVersionDoc {
  id: string;
  musicProjectId: string;
  index: number;
  source: VersionSource;
  label: string;
  assetId: string;
  parentVersionId: string | null;
  jobId: string | null;
  prompt: string | null;
  lyricsText: string | null;
  modelId: string | null;
  /** How this version was made, in plain words (e.g. "Lyria generated a 12-second bridge; blended at 1:31"). */
  method: string;
  durationSec: number | null;
  loudness: { integratedLufs: number | null; truePeakDb: number | null } | null;
  analysis: MusicAnalysis | null;
  /** Maps parent-version time → this version's time (arrangements), for lyric re-sync. */
  timeMap: { src: number; dst: number; len: number }[] | null;
  createdAt?: Time;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** Timestamped structure for Lyria (it follows "[0:00 - 0:10] Intro: …" directions). */
export function structureTimeline(brief: Pick<MusicBrief, 'structure' | 'durationSec' | 'introSec' | 'verseCount' | 'chorusCount' | 'bridge' | 'outro'>): { label: string; start: number; end: number; notes: string }[] {
  let parts = brief.structure.length ? brief.structure.map((p) => ({ label: p.name || p.label, seconds: p.seconds, notes: p.notes })) : [];
  if (!parts.length) {
    parts.push({ label: 'Intro', seconds: brief.introSec, notes: '' });
    for (let i = 0; i < Math.max(brief.verseCount, brief.chorusCount); i++) {
      if (i < brief.verseCount) parts.push({ label: `Verse ${i + 1}`, seconds: null, notes: '' });
      if (i < brief.chorusCount) parts.push({ label: 'Chorus', seconds: null, notes: '' });
      if (brief.bridge && i === Math.max(0, Math.min(brief.verseCount, brief.chorusCount) - 2)) parts.push({ label: 'Bridge', seconds: null, notes: '' });
    }
    if (brief.outro) parts.push({ label: 'Outro', seconds: null, notes: '' });
  }
  parts = parts.filter((p) => p.label);
  const fixed = parts.reduce((s, p) => s + (p.seconds ?? 0), 0);
  const free = parts.filter((p) => p.seconds === null);
  const rest = Math.max(free.length * 4, brief.durationSec - fixed);
  let t = 0;
  return parts.map((p) => {
    const len = p.seconds ?? rest / Math.max(1, free.length);
    const out = { label: p.label, start: Math.round(t), end: Math.round(t + len), notes: p.notes };
    t += len;
    return out;
  });
}

/** Lyria prompt for a brief (mode decides vocals, length and use). Lyrics are sung exactly as given. */
export function musicBriefPrompt(brief: MusicBrief, opts: { mode: MusicMode; lyrics?: string | null; languageName?: string | null; context?: string | null }): string {
  const instrumental = opts.mode === 'instrumental' || opts.mode === 'film_score' || opts.mode === 'scene_background' || brief.vocals === 'none';
  const len = opts.mode === 'jingle' ? Math.min(30, brief.durationSec || 20) : opts.mode === 'intro_outro' ? Math.min(40, brief.durationSec || 20) : brief.durationSec;
  const lines = [
    opts.mode === 'jingle' ? `A short, catchy jingle${brief.title ? ` for “${brief.title}”` : ''}.` : opts.mode === 'film_score' || opts.mode === 'scene_background' ? `Instrumental ${opts.mode === 'film_score' ? 'film score cue' : 'background music for a scene'}${brief.title ? ` — “${brief.title}”` : ''}.` : `A complete ${instrumental ? 'instrumental piece' : 'song'}${brief.title ? ` titled “${brief.title}”` : ''}.`,
    brief.concept ? `Concept: ${brief.concept}.` : '',
    opts.context ? `Inspired by: ${opts.context}` : '',
    [brief.genre, brief.subgenre].filter(Boolean).length ? `Genre: ${[brief.genre, brief.subgenre].filter(Boolean).join(' / ')}.` : '',
    brief.mood ? `Mood: ${brief.mood}.` : '',
    brief.tempoBpm ? `Tempo: ${brief.tempoBpm} BPM.` : '',
    brief.key ? `Key: ${brief.key}.` : '',
    brief.timeSignature && brief.timeSignature !== '4/4' ? `Time signature: ${brief.timeSignature}.` : '',
    `Length: about ${mmss(len)} (${Math.round(len)} seconds).`,
    brief.instrumentation.length ? `Instrumentation: ${brief.instrumentation.join(', ')}.` : '',
    brief.avoidInstruments.length ? `Do not use: ${brief.avoidInstruments.join(', ')}.` : '',
    brief.culturalDirection ? `Cultural direction: ${brief.culturalDirection}.` : '',
    brief.energy ? `Energy progression: ${brief.energy}.` : '',
    instrumental ? 'Instrumental only, no vocals: no singing, no spoken words, no lyrics.' : `Vocals: ${brief.vocals}${brief.vocalCharacter ? ` — ${brief.vocalCharacter}` : ''}.`,
    !instrumental && opts.languageName ? `Sing in ${opts.languageName}.` : '',
    brief.explicit === 'clean' ? 'Keep the lyrics clean (no explicit language).' : '',
  ];
  if (opts.mode !== 'jingle') {
    const tl = structureTimeline({ ...brief, durationSec: len });
    if (tl.length > 1) {
      lines.push('Structure:');
      for (const p of tl) lines.push(`[${mmss(p.start)} - ${mmss(p.end)}] ${p.label}${p.notes ? `: ${p.notes}` : ''}`);
    }
  }
  if (!instrumental) {
    if (opts.lyrics?.trim()) lines.push(`Sing exactly these lyrics, in this order, without changing, adding or dropping any word (section tags mark the structure):\n${opts.lyrics.trim()}`);
    else lines.push('Write original lyrics that fit this brief and sing them.');
  }
  return lines.filter(Boolean).join('\n');
}

/** Prompt for a replacement passage that must sit inside an existing song. */
export function replacementPrompt(input: { brief: MusicBrief; section: Pick<SectionEdit, 'label' | 'name' | 'start' | 'end'>; analysis: Pick<MusicAnalysis, 'bpm' | 'key'> | null; direction: string; lyrics: string | null }): string {
  const len = Math.max(5, Math.round(input.section.end - input.section.start + 2));
  return [
    `A ${len}-second ${input.lyrics ? 'sung' : 'instrumental'} passage to replace the ${input.section.name || input.section.label} of an existing song.`,
    input.analysis ? `It must match the song exactly: ${Math.round(input.analysis.bpm)} BPM, key of ${input.analysis.key}.` : '',
    [input.brief.genre, input.brief.subgenre].filter(Boolean).length ? `Genre: ${[input.brief.genre, input.brief.subgenre].filter(Boolean).join(' / ')}.` : '',
    input.brief.instrumentation.length ? `Same instrumentation: ${input.brief.instrumentation.join(', ')}.` : '',
    input.direction ? `Direction for the new passage: ${input.direction}.` : '',
    'Start and end on the downbeat at a steady level so it can be crossfaded into the song.',
    input.lyrics ? `Sing exactly: ${input.lyrics}` : 'Instrumental only, no vocals.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Arrangement (real audio re-ordering, loops, trims, fades)
// ---------------------------------------------------------------------------

export interface ArrangementSegment {
  sectionId: string;
  srcStart: number;
  srcEnd: number;
  dstStart: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
}

export interface ArrangementPlan {
  segments: ArrangementSegment[];
  durationSec: number;
  crossfadeSec: number;
  timeMap: { src: number; dst: number; len: number }[];
}

const dbToLin = (db: number) => Math.round(10 ** (db / 20) * 1000) / 1000;

/** Lays the sections in their new order (repeats for loops, skips muted ones) with crossfades. */
export function arrangementPlan(sections: SectionEdit[], crossfadeSec = 0.08): ArrangementPlan {
  const segments: ArrangementSegment[] = [];
  const timeMap: ArrangementPlan['timeMap'] = [];
  let t = 0;
  for (const s of sections) {
    if (s.muted || s.end - s.start < 0.2) continue;
    for (let k = 0; k < Math.max(1, s.loop); k++) {
      const len = s.end - s.start;
      const start = segments.length ? t - crossfadeSec : 0;
      segments.push({ sectionId: s.id, srcStart: s.start, srcEnd: s.end, dstStart: Math.round(start * 1000) / 1000, gain: dbToLin(s.gainDb), fadeIn: k === 0 ? s.fadeIn : 0, fadeOut: k === Math.max(1, s.loop) - 1 ? s.fadeOut : 0 });
      timeMap.push({ src: s.start, dst: Math.round(start * 1000) / 1000, len: Math.round(len * 1000) / 1000 });
      t = start + len;
    }
  }
  return { segments, durationSec: Math.round(t * 1000) / 1000, crossfadeSec, timeMap };
}

/** FFmpeg filter graph for an arrangement of one input ([0:a]). */
export function arrangementFilter(plan: ArrangementPlan): string {
  const parts: string[] = [];
  const labels: string[] = [];
  const xf = plan.crossfadeSec;
  plan.segments.forEach((s, i) => {
    const len = Math.round((s.srcEnd - s.srcStart) * 1000) / 1000;
    const fi = Math.max(s.fadeIn, i > 0 ? xf : 0);
    const fo = Math.max(s.fadeOut, i < plan.segments.length - 1 ? xf : 0);
    parts.push(
      `[0:a]atrim=start=${s.srcStart}:end=${s.srcEnd},asetpts=PTS-STARTPTS,volume=${s.gain}${fi > 0 ? `,afade=t=in:st=0:d=${fi}:curve=qsin` : ''}${fo > 0 ? `,afade=t=out:st=${Math.max(0, len - fo)}:d=${fo}:curve=qsin` : ''},adelay=${Math.round(s.dstStart * 1000)}:all=1[s${i}]`,
    );
    labels.push(`[s${i}]`);
  });
  parts.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,atrim=duration=${plan.durationSec}[out]`);
  return parts.join(';');
}

/** Moves a lyric sheet through an arrangement's time map (repeated sections repeat their lines). */
export function remapSheet(sheet: LyricsSheet, timeMap: { src: number; dst: number; len: number }[]): LyricsSheet {
  const lines: LyricsSheet['lines'] = [];
  let copy = 0;
  for (const m of timeMap) {
    for (const l of sheet.lines) {
      if (l.start === null || l.end === null) continue;
      if (l.start < m.src - 0.05 || l.start >= m.src + m.len - 0.05) continue;
      const shift = m.dst - m.src;
      const seen = lines.some((x) => x.id === l.id);
      lines.push({
        ...l,
        id: seen ? `${l.id}_r${++copy}` : l.id,
        start: Math.round((l.start + shift) * 1000) / 1000,
        end: Math.round((Math.min(l.end, m.src + m.len) + shift) * 1000) / 1000,
        words: l.words.map((w) => ({ ...w, start: w.start === null ? null : Math.round((w.start + shift) * 1000) / 1000, end: w.end === null ? null : Math.round((w.end + shift) * 1000) / 1000 })),
        flags: [...new Set([...l.flags, 'adjusted' as const])],
      });
    }
  }
  lines.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  return { ...sheet, lines, updatedAt: Date.now(), timing: { ...sheet.timing, adjustments: sheet.timing.adjustments + 1, notes: [...sheet.timing.notes, 'Re-timed through an arrangement edit.'] } };
}

/** Shifts a lyric sheet by a constant offset (a re-exported or re-mastered version of the same take). */
export function shiftSheet(sheet: LyricsSheet, offsetSec: number): LyricsSheet {
  const sh = (t: number | null) => (t === null ? null : Math.round((t + offsetSec) * 1000) / 1000);
  return { ...sheet, lines: sheet.lines.map((l) => ({ ...l, start: sh(l.start), end: sh(l.end), words: l.words.map((w) => ({ ...w, start: sh(w.start), end: sh(w.end) })) })), updatedAt: Date.now(), timing: { ...sheet.timing, adjustments: sheet.timing.adjustments + 1, notes: [...sheet.timing.notes, `Shifted by ${offsetSec.toFixed(3)} s to follow a replaced audio version.`] } };
}

/** Snaps lyric timing to whole frames of the export frame rate. */
export function snapSheetToFrames(sheet: LyricsSheet, fps: number): LyricsSheet {
  const f = (t: number | null) => (t === null ? null : Math.round(t * fps) / fps);
  return { ...sheet, lines: sheet.lines.map((l) => ({ ...l, start: f(l.start), end: f(l.end), words: l.words.map((w) => ({ ...w, start: f(w.start), end: f(w.end) })) })) };
}

// ---------------------------------------------------------------------------
// Mixing
// ---------------------------------------------------------------------------

export interface MixTrack {
  id: string;
  name: string;
  assetId: string;
  kind: 'version' | 'stem' | 'recording' | 'upload';
  role: 'music' | 'vocal' | 'dialogue' | 'fx';
  volumeDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  offsetSec: number;
  fadeIn: number;
  fadeOut: number;
  eq: { lowDb: number; midDb: number; highDb: number };
  compressor: { enabled: boolean; thresholdDb: number; ratio: number };
  noiseReduction: boolean;
  /** Duck this track under another (dialogue or vocal) track. */
  duck: { enabled: boolean; keyTrackId: string | null; amountDb: number };
}

export interface MixSettings {
  limiter: boolean;
  targetLufs: number | null;
  preset: string;
}

export const DEFAULT_MIX: MixSettings = { limiter: true, targetLufs: -14, preset: 'balanced' };

export function defaultMixTrack(id: string, name: string, assetId: string, kind: MixTrack['kind'], role: MixTrack['role'] = 'music'): MixTrack {
  return { id, name, assetId, kind, role, volumeDb: 0, pan: 0, mute: false, solo: false, offsetSec: 0, fadeIn: 0, fadeOut: 0, eq: { lowDb: 0, midDb: 0, highDb: 0 }, compressor: { enabled: false, thresholdDb: -18, ratio: 3 }, noiseReduction: false, duck: { enabled: false, keyTrackId: null, amountDb: 10 } };
}

/** Safe presets (they only set sensible values; everything stays adjustable). */
export const MIX_PRESETS: Record<string, { label: string; apply: (t: MixTrack) => MixTrack; settings: Partial<MixSettings> }> = {
  balanced: { label: 'Balanced', apply: (t) => ({ ...t, eq: { lowDb: 0, midDb: 0, highDb: 0 }, compressor: { enabled: t.role === 'vocal', thresholdDb: -18, ratio: 2.5 } }), settings: { limiter: true, targetLufs: -14 } },
  vocal_forward: { label: 'Vocal forward', apply: (t) => (t.role === 'vocal' ? { ...t, volumeDb: t.volumeDb + 2, eq: { lowDb: -2, midDb: 2, highDb: 2 }, compressor: { enabled: true, thresholdDb: -20, ratio: 3 } } : { ...t, eq: { ...t.eq, midDb: -1.5 } }), settings: { limiter: true, targetLufs: -14 } },
  warm: { label: 'Warm & full', apply: (t) => ({ ...t, eq: { lowDb: 2, midDb: 0, highDb: -1.5 } }), settings: { limiter: true, targetLufs: -14 } },
  dialogue_clarity: { label: 'Dialogue clarity', apply: (t) => (t.role === 'dialogue' ? { ...t, noiseReduction: true, eq: { lowDb: -4, midDb: 2, highDb: 1 }, compressor: { enabled: true, thresholdDb: -22, ratio: 3 } } : { ...t, duck: { enabled: true, keyTrackId: t.duck.keyTrackId, amountDb: 12 } }), settings: { limiter: true, targetLufs: -16 } },
  streaming: { label: 'Streaming loudness (−14 LUFS)', apply: (t) => t, settings: { limiter: true, targetLufs: -14 } },
};

const f2 = (n: number) => Math.round(n * 100) / 100;

/** FFmpeg filter graph for a mixdown. Inputs are given in track order; returns `[out]`. */
export function mixFilterGraph(tracks: MixTrack[], settings: MixSettings, durationSec: number): { filter: string; inputs: string[] } {
  const soloed = tracks.some((t) => t.solo);
  const live = tracks.filter((t) => !t.mute && (!soloed || t.solo));
  const parts: string[] = [];
  const labels = new Map<string, string>();
  live.forEach((t, i) => {
    const chain = [`[${i}:a]aresample=48000,aformat=channel_layouts=stereo`];
    if (t.noiseReduction) chain.push('afftdn=nf=-25');
    if (t.eq.lowDb) chain.push(`bass=g=${f2(t.eq.lowDb)}:f=120`);
    if (t.eq.midDb) chain.push(`equalizer=f=1800:t=q:w=1:g=${f2(t.eq.midDb)}`);
    if (t.eq.highDb) chain.push(`treble=g=${f2(t.eq.highDb)}:f=6000`);
    if (t.compressor.enabled) chain.push(`acompressor=threshold=${f2(10 ** (t.compressor.thresholdDb / 20))}:ratio=${f2(t.compressor.ratio)}:attack=15:release=200:makeup=1`);
    const pan = Math.max(-1, Math.min(1, t.pan));
    if (pan) chain.push(`pan=stereo|c0=${f2(Math.min(1, 1 - pan))}*c0|c1=${f2(Math.min(1, 1 + pan))}*c1`);
    chain.push(`volume=${f2(10 ** (t.volumeDb / 20))}`);
    if (t.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${f2(t.fadeIn)}`);
    if (t.fadeOut > 0) chain.push(`afade=t=out:st=${f2(Math.max(0, durationSec - t.offsetSec - t.fadeOut))}:d=${f2(t.fadeOut)}`);
    if (t.offsetSec > 0) chain.push(`adelay=${Math.round(t.offsetSec * 1000)}:all=1`);
    chain.push('apad');
    chain.push(`atrim=duration=${f2(durationSec)}`);
    parts.push(`${chain.join(',')}[t${i}]`);
    labels.set(t.id, `t${i}`);
  });
  // Ducking: a track is compressed by its key track (the key is split so it is still heard).
  const keyUses = new Map<string, number>();
  for (const t of live) if (t.duck.enabled && t.duck.keyTrackId && labels.has(t.duck.keyTrackId) && t.duck.keyTrackId !== t.id) keyUses.set(t.duck.keyTrackId, (keyUses.get(t.duck.keyTrackId) ?? 0) + 1);
  for (const [keyId, uses] of keyUses) {
    const l = labels.get(keyId)!;
    const outs = Array.from({ length: uses + 1 }, (_, k) => `${l}k${k}`);
    parts.push(`[${l}]asplit=${uses + 1}${outs.map((o) => `[${o}]`).join('')}`);
    labels.set(keyId, `${l}k0`);
  }
  const used = new Map<string, number>();
  for (const t of live) {
    if (!(t.duck.enabled && t.duck.keyTrackId && keyUses.has(t.duck.keyTrackId) && t.duck.keyTrackId !== t.id)) continue;
    const keyBase = labels.get(t.duck.keyTrackId)!.replace(/k0$/, '');
    const k = (used.get(t.duck.keyTrackId) ?? 0) + 1;
    used.set(t.duck.keyTrackId, k);
    const ratio = Math.max(2, Math.min(20, t.duck.amountDb / 1.5));
    const me = labels.get(t.id)!;
    parts.push(`[${me}][${keyBase}k${k}]sidechaincompress=threshold=0.03:ratio=${f2(ratio)}:attack=20:release=400[${me}d]`);
    labels.set(t.id, `${me}d`);
  }
  const all = live.map((t) => `[${labels.get(t.id)!}]`);
  const master: string[] = [];
  if (settings.targetLufs !== null) master.push(`loudnorm=I=${settings.targetLufs}:TP=-1.5:LRA=11`);
  if (settings.limiter) master.push('alimiter=limit=0.94:level=disabled');
  if (!all.length) return { filter: `anullsrc=r=48000:cl=stereo,atrim=duration=${f2(durationSec)}[out]`, inputs: [] };
  parts.push(`${all.join('')}amix=inputs=${all.length}:normalize=0:dropout_transition=0${master.length ? `,${master.join(',')}` : ''},aresample=48000[out]`);
  return { filter: parts.join(';'), inputs: live.map((t) => t.assetId) };
}
