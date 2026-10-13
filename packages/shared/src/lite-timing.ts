import { directionOf, estimateNarrationSec, type LiteScene, type LiteSpec } from './lite';
import type { LyricsSheet } from './lyrics';
import type { JobDoc } from './types';

/**
 * Film Studio Lite timing. Before audio exists every length is an estimate from the speaking pace; once a
 * scene has a narration take its measured speech decides. A scene is never shorter than its lead-in +
 * speech + tail: when narration grows, unlocked shots lengthen (locked ones keep their length) — voice
 * is never truncated. Changes against the acknowledged baseline are reported, not applied silently.
 */

export interface LiteWord {
  text: string;
  /** Seconds in the narration asset. */
  start: number;
  end: number;
  /** 0–1: how sure the alignment is about this word's timing. */
  confidence: number;
  /** The script sentence this word ends, if any (subtitle breaks prefer it). */
  sentenceEnd?: boolean;
}

/** A narration take for one scene: the audio, which part of it the scene uses, and the measured words. */
export interface LiteNarrationTake {
  jobId: string;
  sceneId: string;
  /** Input hash of the text/voice it was made from (out of date when the scene's hash differs). */
  hash: string;
  assetId: string;
  /** Window of the asset that belongs to this scene (s). */
  inPoint: number;
  outPoint: number;
  /** Measured speech inside the asset (s). */
  speechStart: number;
  speechEnd: number;
  words: LiteWord[];
  /** `aligned`: word timings from transcription of the real audio; `estimated`: spread over the measured speech. */
  alignment: 'aligned' | 'estimated';
  coverage: number | null;
  flags: string[];
  source: 'generated' | 'upload_scene' | 'upload_whole';
  voice: string | null;
  createdAt: number;
}

export interface ShotTiming {
  shotId: string;
  start: number;
  duration: number;
}

export interface SceneTiming {
  sceneId: string;
  index: number;
  /** Deliberate black before the scene (s) and where it starts. */
  blackStart: number;
  blackSec: number;
  start: number;
  duration: number;
  shots: ShotTiming[];
  /** Where the first spoken word lands on the timeline, and the speech length. */
  voiceAt: number | null;
  speechSec: number;
  /** Speech length is an estimate (no measured take yet). */
  estimated: boolean;
  /** Seconds added to locked shots because the narration needed them. */
  overrunSec: number;
}

export interface LiteTiming {
  scenes: SceneTiming[];
  /** Last scene end; the closing hold follows. */
  storyEnd: number;
  totalSec: number;
  estimated: boolean;
}

const fr = (t: number, fps: number) => Math.round(t * fps) / fps;

export function speechSeconds(take: Pick<LiteNarrationTake, 'speechStart' | 'speechEnd'> | null | undefined): number {
  return take ? Math.max(0, take.speechEnd - take.speechStart) : 0;
}

/** Computes the film's timing from the scene plan and the measured narration (frame-accurate boundaries). */
export function computeLiteTiming(spec: LiteSpec, takes: Record<string, LiteNarrationTake | null | undefined>): LiteTiming {
  const fps = spec.setup.fps;
  const wpm = spec.setup.wordsPerMinute;
  let t = 0;
  let estimated = false;
  const scenes: SceneTiming[] = spec.scenes.map((s, index) => {
    const take = takes[s.id] ?? null;
    const hasText = Boolean(s.narration.trim());
    const speech = take ? speechSeconds(take) : hasText ? estimateNarrationSec(s.narration, wpm) : 0;
    const isEstimate = !take && hasText;
    estimated ||= isEstimate;
    const blackSec = s.pauseBlack ? s.pauseBeforeSec : 0;
    const blackStart = fr(t, fps);
    t += blackSec;
    const start = fr(t, fps);
    // The first line waits until the opening fade-in has established the sound bed (no voice out of silence).
    const lead = Math.max(s.leadInSec, index === 0 ? spec.sound.fadeInSec + 1.2 : 0) + (s.pauseBlack ? 0 : s.pauseBeforeSec);
    const needed = speech > 0 ? lead + speech + s.tailSec : 0;
    const planned = s.shots.reduce((a, x) => a + x.durationSec, 0);
    const duration = Math.max(planned, needed, s.shots.length ? 1 : 0);
    // Share the extra time among unlocked shots in proportion to their planned length.
    const extra = duration - planned;
    const unlocked = s.shots.filter((x) => !x.lockDuration);
    const unlockedSum = unlocked.reduce((a, x) => a + x.durationSec, 0);
    let overrunSec = 0;
    const lengths = s.shots.map((x) => x.durationSec);
    if (extra > 1e-6) {
      if (unlocked.length) s.shots.forEach((x, i) => (lengths[i] = x.lockDuration ? x.durationSec : x.durationSec + (extra * x.durationSec) / Math.max(1e-6, unlockedSum)));
      else if (lengths.length) {
        lengths[lengths.length - 1] = lengths[lengths.length - 1]! + extra;
        overrunSec = extra;
      }
    }
    // Frame-accurate boundaries: each shot ends where the next starts.
    const shots: ShotTiming[] = [];
    let acc = start;
    s.shots.forEach((x, i) => {
      const a = fr(acc, fps);
      acc += lengths[i]!;
      const b = i === s.shots.length - 1 ? fr(start + duration, fps) : fr(acc, fps);
      shots.push({ shotId: x.id, start: a, duration: Math.max(1 / fps, b - a) });
    });
    t = start + duration;
    return { sceneId: s.id, index, blackStart, blackSec, start, duration: fr(start + duration, fps) - start, shots, voiceAt: speech > 0 ? fr(start + lead, fps) : null, speechSec: speech, estimated: isEstimate, overrunSec };
  });
  const storyEnd = fr(t, fps);
  const totalSec = fr(storyEnd + (scenes.length ? spec.sound.endHoldSec : 0), fps);
  return { scenes, storyEnd, totalSec, estimated };
}

export interface TimingChange {
  sceneId: string;
  title: string;
  before: { start: number; duration: number } | null;
  after: { start: number; duration: number };
  /** Why the length changed (narration, pause, shots). */
  reason: string;
}

/** What moved since the director last acknowledged the timing (explicit reconciliation). */
export function reconcileTiming(spec: LiteSpec, timing: LiteTiming, tolerance = 0.05): { changes: TimingChange[]; totalBefore: number | null; totalAfter: number } {
  const base = spec.timing.baseline;
  const changes: TimingChange[] = [];
  if (!base) return { changes, totalBefore: null, totalAfter: timing.totalSec };
  const byId = new Map(spec.scenes.map((s) => [s.id, s]));
  for (const st of timing.scenes) {
    const before = base[st.sceneId] ?? null;
    const scene = byId.get(st.sceneId)!;
    if (before && Math.abs(before.start - st.start) <= tolerance && Math.abs(before.duration - st.duration) <= tolerance) continue;
    const reason = !before ? 'New scene' : Math.abs(before.duration - st.duration) > tolerance ? (st.overrunSec > 0 ? 'Narration is longer than the locked shots — the last shot holds longer' : st.estimated ? 'Length estimated from the script' : 'Measured narration or pauses changed the scene length') : 'Moved by an earlier change';
    changes.push({ sceneId: st.sceneId, title: scene.title || `Scene ${st.index + 1}`, before, after: { start: st.start, duration: st.duration }, reason });
  }
  return { changes, totalBefore: spec.timing.totalSec, totalAfter: timing.totalSec };
}

export function timingBaseline(timing: LiteTiming): { baseline: Record<string, { start: number; duration: number }>; totalSec: number } {
  return { baseline: Object.fromEntries(timing.scenes.map((s) => [s.sceneId, { start: s.start, duration: s.duration }])), totalSec: timing.totalSec };
}

/** Planned film length before any audio exists (estimate from the speaking pace and the shot plan). */
export function estimatedFilmSec(spec: LiteSpec): number {
  return computeLiteTiming(spec, {}).totalSec;
}

/** Words of the script that fit the target length at the configured pace (planning hint). */
export function targetWords(spec: Pick<LiteSpec, 'setup'>): number {
  const d = directionOf(spec.setup.direction);
  // Leave breathing room: about 18 % of a narrated film is lead-ins, tails and pauses.
  return Math.round(((spec.setup.targetSec * 0.82) / 60) * Math.min(spec.setup.wordsPerMinute, d.wordsPerMinute + 30));
}

export function sceneAt(timing: LiteTiming, t: number): SceneTiming | null {
  return timing.scenes.find((s) => t >= s.blackStart && t < s.start + s.duration) ?? (timing.scenes.length && t >= timing.storyEnd ? timing.scenes[timing.scenes.length - 1]! : null);
}

/** The newest take whose input matches the scene (or the chosen one). Out-of-date takes are returned with `stale`. */
export function pickTake(scene: Pick<LiteScene, 'id' | 'voiceJobId'>, hash: string, takes: LiteNarrationTake[]): { take: LiteNarrationTake | null; stale: boolean } {
  const mine = takes.filter((t) => t.sceneId === scene.id).sort((a, b) => b.createdAt - a.createdAt);
  if (scene.voiceJobId) {
    const chosen = mine.find((t) => t.jobId === scene.voiceJobId);
    if (chosen) return { take: chosen, stale: chosen.source === 'generated' && chosen.hash !== hash };
  }
  const current = mine.find((t) => t.source !== 'generated' || t.hash === hash);
  if (current) return { take: current, stale: false };
  return { take: mine[0] ?? null, stale: Boolean(mine[0]) };
}

// ---------------------------------------------------------------------------
// Narration results (shared by the narration worker and the workspace)
// ---------------------------------------------------------------------------

/** A take as stored in a `lite.narration` job result (the job id and time come from the job). */
export type StoredTake = Omit<LiteNarrationTake, 'jobId' | 'createdAt'>;

/** Words of an aligned sheet in order, marking the last word of each script sentence. */
export function sheetWords(sheet: LyricsSheet, paragraph?: number): LiteWord[] {
  const sections = new Map(sheet.sections.map((s) => [s.id, s]));
  const out: LiteWord[] = [];
  const lines = sheet.lines.filter((l) => paragraph === undefined || sections.get(l.sectionId ?? '')?.paragraph === paragraph);
  lines.forEach((l, li) => {
    const lastOfSentence = li === lines.length - 1 || lines[li + 1]!.sectionId !== l.sectionId;
    l.words.forEach((w, wi) => {
      if (w.start === null || w.end === null) return;
      out.push({ text: w.text, start: w.start, end: w.end, confidence: Math.round(w.confidence * 100) / 100, ...(lastOfSentence && wi === l.words.length - 1 ? { sentenceEnd: true } : {}) });
    });
  });
  return out;
}

/**
 * Splits one aligned recording of the whole narration into per-scene windows. Each scene keeps its own
 * words; cuts fall in the silence between scenes (never inside speech).
 */
export function splitWholeNarration(sheet: LyricsSheet, scenes: { sceneId: string; paragraph: number }[], durationSec: number): { sceneId: string; inPoint: number; outPoint: number; speechStart: number; speechEnd: number; words: LiteWord[] }[] {
  const found = scenes.map((s) => ({ ...s, words: sheetWords(sheet, s.paragraph) })).filter((s) => s.words.length);
  return found.map((s, i) => {
    const first = s.words[0]!.start;
    const last = s.words[s.words.length - 1]!.end;
    const prev = found[i - 1];
    const next = found[i + 1];
    const prevEnd = prev ? prev.words[prev.words.length - 1]!.end : 0;
    const nextStart = next ? next.words[0]!.start : durationSec;
    const inPoint = prev ? Math.max(prevEnd, first - Math.min(0.6, (first - prevEnd) / 2)) : Math.max(0, first - 0.6);
    const outPoint = next ? Math.min(nextStart, last + Math.min(0.8, (nextStart - last) / 2)) : Math.min(durationSec, last + 1);
    const r = (n: number) => Math.round(n * 1000) / 1000;
    return { sceneId: s.sceneId, inPoint: r(inPoint), outPoint: r(outPoint), speechStart: r(first), speechEnd: r(last), words: s.words };
  });
}

/** Every narration take recorded by the project's completed `lite.narration` jobs. */
export function takesFromJobs(jobs: (Pick<JobDoc, 'type' | 'status' | 'result'> & { id: string; completedAt?: unknown; createdAt?: unknown })[]): LiteNarrationTake[] {
  const ms = (t: unknown) => (t && typeof (t as { toMillis?: () => number }).toMillis === 'function' ? (t as { toMillis: () => number }).toMillis() : typeof t === 'number' ? t : 0);
  return jobs
    .filter((j) => j.type === 'lite.narration' && j.status === 'completed')
    .flatMap((j) => ((j.result?.data?.takes as StoredTake[] | undefined) ?? []).map((t) => ({ ...t, jobId: j.id, createdAt: ms(j.completedAt) || ms(j.createdAt) })));
}
