import { analyzeAudio, decimate, FFT } from './audio';
import type { SongSection } from './types';

/**
 * Uploaded-music analysis beyond beats and sections: musical key (chroma + Krumhansl–Schmuckler key
 * profiles), bars, quiet/loud regions, instrumental passages, major transitions and candidate edit
 * points. Deterministic DSP on the real audio; the director can correct every result.
 */

export const PITCH_CLASSES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

// Krumhansl–Kessler probe-tone profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Average 12-bin chroma of mono samples. */
export function chroma(samples: Float32Array, sampleRate: number, frameSize = 4096, hop = 2048): number[] {
  const factor = Math.max(1, Math.round(sampleRate / 11025));
  const x = decimate(samples, factor);
  const sr = sampleRate / factor;
  const fft = new FFT(frameSize);
  const win = new Float64Array(frameSize);
  for (let i = 0; i < frameSize; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameSize - 1));
  const bins = new Array<number>(12).fill(0);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  // Map FFT bins (55 Hz – 2 kHz) to pitch classes once.
  const pc: number[] = [];
  for (let k = 0; k < frameSize / 2; k++) {
    const f = (k * sr) / frameSize;
    if (f < 55 || f > 2000) {
      pc.push(-1);
      continue;
    }
    const midi = 69 + 12 * Math.log2(f / 440);
    pc.push(((Math.round(midi) % 12) + 12) % 12);
  }
  let frames = 0;
  for (let start = 0; start + frameSize <= x.length; start += hop) {
    for (let i = 0; i < frameSize; i++) {
      re[i] = x[start + i]! * win[i]!;
      im[i] = 0;
    }
    fft.transform(re, im);
    let energy = 0;
    const frame = new Array<number>(12).fill(0);
    for (let k = 1; k < frameSize / 2; k++) {
      const p = pc[k]!;
      if (p < 0) continue;
      const mag = Math.hypot(re[k]!, im[k]!);
      frame[p] = frame[p]! + mag;
      energy += mag;
    }
    if (energy <= 1e-6) continue;
    for (let c = 0; c < 12; c++) bins[c] = bins[c]! + frame[c]! / energy;
    frames++;
  }
  return bins.map((b) => (frames ? b / frames : 0));
}

/** Best-matching key for a chroma vector. */
export function detectKey(ch: number[]): { key: string; mode: 'major' | 'minor'; tonic: string; confidence: number; alternatives: { key: string; score: number }[] } {
  const scores: { key: string; mode: 'major' | 'minor'; tonic: string; score: number }[] = [];
  for (let t = 0; t < 12; t++) {
    const rot = (p: number[]) => p.map((_, i) => p[(i - t + 12) % 12]!);
    scores.push({ key: `${PITCH_CLASSES[t]} major`, mode: 'major', tonic: PITCH_CLASSES[t]!, score: pearson(ch, rot(MAJOR)) });
    scores.push({ key: `${PITCH_CLASSES[t]} minor`, mode: 'minor', tonic: PITCH_CLASSES[t]!, score: pearson(ch, rot(MINOR)) });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0]!;
  const second = scores[1]!;
  const confidence = Math.max(0, Math.min(1, (best.score - second.score) * 4 + Math.max(0, best.score) * 0.5));
  return { key: best.key, mode: best.mode, tonic: best.tonic, confidence: Math.round(confidence * 100) / 100, alternatives: scores.slice(1, 4).map((s) => ({ key: s.key, score: Math.round(s.score * 1000) / 1000 })) };
}

export interface Region {
  start: number;
  end: number;
}

export interface EditPoint {
  t: number;
  reason: 'section' | 'downbeat_low_energy' | 'transition' | 'phrase';
  strength: number;
}

export interface MusicAnalysis {
  durationSec: number;
  bpm: number;
  key: string;
  keyConfidence: number;
  timeSignature: string;
  beats: number[];
  downbeats: number[];
  bars: { index: number; start: number; end: number }[];
  sections: SongSection[];
  energy: number[];
  energyHop: number;
  quiet: Region[];
  loud: Region[];
  transitions: number[];
  /** Spans without vocals (from vocal detection when available). */
  instrumental: Region[];
  vocalPresence: Region[] | null;
  editPoints: EditPoint[];
  method: 'dsp' | 'dsp+ai';
  /** Fields the director corrected by hand (never overwritten by re-analysis). */
  corrected: string[];
  analyzedAt: number;
}

function regionsWhere(values: number[], hop: number, pred: (v: number) => boolean, minSec: number): Region[] {
  const out: Region[] = [];
  let start: number | null = null;
  values.forEach((v, i) => {
    if (pred(v)) {
      if (start === null) start = i * hop;
    } else if (start !== null) {
      if (i * hop - start >= minSec) out.push({ start, end: i * hop });
      start = null;
    }
  });
  if (start !== null && values.length * hop - start >= minSec) out.push({ start, end: values.length * hop });
  return out.map((r) => ({ start: Math.round(r.start * 1000) / 1000, end: Math.round(r.end * 1000) / 1000 }));
}

/** Full deterministic analysis of a song's samples. */
export function analyzeMusic(samples: Float32Array, sampleRate: number, opts: { vocalPresence?: Region[] | null; beatsPerBar?: number } = {}): MusicAnalysis {
  const base = analyzeAudio(samples, sampleRate, { peakBins: 400 });
  const key = detectKey(chroma(samples, sampleRate));
  const bpb = opts.beatsPerBar ?? 4;
  const bars = base.downbeats.map((d, i) => ({ index: i + 1, start: d, end: base.downbeats[i + 1] ?? Math.min(base.durationSec, d + (60 / Math.max(40, base.bpm)) * bpb) }));
  const e = base.energy;
  const sorted = [...e].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))] ?? 0;
  const quiet = regionsWhere(e, base.energyHop, (v) => v <= q(0.2), 2);
  const loud = regionsWhere(e, base.energyHop, (v) => v >= q(0.85), 2);
  const transitions = base.sections.slice(1).map((s) => s.start);
  const vocals = opts.vocalPresence ?? null;
  const instrumental: Region[] = [];
  if (vocals) {
    let cursor = 0;
    for (const v of [...vocals].sort((a, b) => a.start - b.start)) {
      if (v.start - cursor >= 2) instrumental.push({ start: cursor, end: v.start });
      cursor = Math.max(cursor, v.end);
    }
    if (base.durationSec - cursor >= 2) instrumental.push({ start: cursor, end: base.durationSec });
  }
  const editPoints: EditPoint[] = [];
  for (const t of transitions) editPoints.push({ t, reason: 'section', strength: 1 });
  const energyAt = (t: number) => e[Math.min(e.length - 1, Math.max(0, Math.round(t / base.energyHop)))] ?? 0;
  for (const d of base.downbeats) {
    if (transitions.some((t) => Math.abs(t - d) < 1)) continue;
    const drop = energyAt(d - 0.5) - energyAt(d + 0.5);
    if (energyAt(d) <= q(0.35)) editPoints.push({ t: d, reason: 'downbeat_low_energy', strength: 0.6 });
    else if (Math.abs(drop) > 0.25) editPoints.push({ t: d, reason: 'transition', strength: 0.7 });
  }
  editPoints.sort((a, b) => a.t - b.t);
  return {
    durationSec: base.durationSec,
    bpm: base.bpm,
    key: key.key,
    keyConfidence: key.confidence,
    timeSignature: `${bpb}/4`,
    beats: base.beats,
    downbeats: base.downbeats,
    bars,
    sections: base.sections,
    energy: base.energy,
    energyHop: base.energyHop,
    quiet,
    loud,
    transitions,
    instrumental,
    vocalPresence: vocals,
    editPoints: editPoints.slice(0, 200),
    method: vocals ? 'dsp+ai' : 'dsp',
    corrected: [],
    analyzedAt: Date.now(),
  };
}

/** Applies the director's corrections on top of a (re-)analysis. */
export function applyCorrections(a: MusicAnalysis, corrections: Partial<Pick<MusicAnalysis, 'bpm' | 'key' | 'timeSignature' | 'sections' | 'downbeats'>>): MusicAnalysis {
  const out: MusicAnalysis = { ...a, corrected: [...new Set([...a.corrected, ...Object.keys(corrections)])] };
  if (corrections.bpm) out.bpm = corrections.bpm;
  if (corrections.key) out.key = corrections.key;
  if (corrections.timeSignature) out.timeSignature = corrections.timeSignature;
  if (corrections.sections) out.sections = corrections.sections;
  if (corrections.downbeats) out.downbeats = corrections.downbeats;
  return out;
}

/**
 * Offset (s) of `b` relative to `a` from their onset envelopes (a replaced audio version of the same
 * song). Positive = `b` is later. Confidence is the normalised correlation peak.
 */
export function alignVersions(a: Float32Array, b: Float32Array, sampleRate: number, maxLagSec = 12): { offsetSec: number; confidence: number } {
  const env = (x: Float32Array) => {
    const hop = Math.round(sampleRate * 0.01);
    const out: number[] = [];
    let prev = 0;
    for (let i = 0; i + hop <= x.length; i += hop) {
      let s = 0;
      for (let k = 0; k < hop; k++) s += x[i + k]! * x[i + k]!;
      const v = Math.sqrt(s / hop);
      out.push(Math.max(0, v - prev));
      prev = v;
    }
    const m = out.reduce((p, c) => p + c, 0) / Math.max(1, out.length);
    return out.map((v) => v - m);
  };
  const ea = env(a);
  const eb = env(b);
  const maxLag = Math.round(maxLagSec / 0.01);
  let best = 0;
  let bestLag = 0;
  const norm = Math.sqrt(ea.reduce((s, v) => s + v * v, 0) * eb.reduce((s, v) => s + v * v, 0)) || 1;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < ea.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= eb.length) continue;
      s += ea[i]! * eb[j]!;
    }
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  return { offsetSec: Math.round(bestLag * 10) / 1000, confidence: Math.round((best / norm) * 1000) / 1000 };
}
