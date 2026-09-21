import type { SectionLabel, SongSection } from './types';

/**
 * Deterministic music analysis used by Music Video Studio:
 * waveform peaks, onset envelope (spectral flux), tempo (autocorrelation with a tempo prior),
 * beat tracking (dynamic programming, Ellis 2007), downbeats (4/4 accent phase), RMS energy and
 * structural segmentation (bar-level self-similarity + checkerboard novelty).
 */

// ---------------------------------------------------------------------------
// FFT
// ---------------------------------------------------------------------------

export class FFT {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(size: number) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.size = size;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }
  }

  /** In-place forward transform. */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]!;
      if (j > i) {
        const tr = re[i]!;
        re[i] = re[j]!;
        re[j] = tr;
        const ti = im[i]!;
        im[i] = im[j]!;
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step]!;
          const wi = this.sin[k * step]!;
          const a = i + k;
          const b = a + half;
          const xr = re[b]! * wr - im[b]! * wi;
          const xi = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - xr;
          im[b] = im[a]! - xi;
          re[a] = re[a]! + xr;
          im[a] = im[a]! + xi;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Basic signal helpers
// ---------------------------------------------------------------------------

/** Downsamples by an integer factor using box averaging (acts as a simple low-pass). */
export function decimate(samples: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return samples;
  const out = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    const o = i * factor;
    for (let k = 0; k < factor; k++) s += samples[o + k]!;
    out[i] = s / factor;
  }
  return out;
}

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i]! += ch[i]! / channels.length;
  return out;
}

/** Min/max waveform peaks for drawing. Values are rounded to 3 decimals to keep documents small. */
export function computePeaks(samples: Float32Array, bins: number): { min: number[]; max: number[] } {
  const min: number[] = new Array(bins).fill(0);
  const max: number[] = new Array(bins).fill(0);
  const per = samples.length / bins;
  for (let b = 0; b < bins; b++) {
    const s = Math.floor(b * per);
    const e = Math.min(samples.length, Math.floor((b + 1) * per));
    let lo = 0;
    let hi = 0;
    for (let i = s; i < e; i++) {
      const v = samples[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = Math.round(lo * 1000) / 1000;
    max[b] = Math.round(hi * 1000) / 1000;
  }
  return { min, max };
}

function movingAverage(x: Float64Array, radius: number): Float64Array {
  const out = new Float64Array(x.length);
  let acc = 0;
  let count = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < x.length; i++) {
    const nlo = Math.max(0, i - radius);
    const nhi = Math.min(x.length - 1, i + radius);
    while (hi < nhi) {
      hi++;
      acc += x[hi]!;
      count++;
    }
    while (lo < nlo) {
      acc -= x[lo]!;
      lo++;
      count--;
    }
    out[i] = acc / Math.max(1, count);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spectral features
// ---------------------------------------------------------------------------

export interface SpectralFeatures {
  hopSec: number;
  onset: Float64Array;
  /** Per-frame log energies in `bandCount` log-spaced bands. */
  bands: Float64Array[];
  rms: Float64Array;
}

export function spectralFeatures(samples: Float32Array, sampleRate: number, frameSize = 1024, hop = 512, bandCount = 16): SpectralFeatures {
  const fft = new FFT(frameSize);
  const window = new Float64Array(frameSize);
  for (let i = 0; i < frameSize; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameSize - 1));
  const frames = Math.max(0, Math.floor((samples.length - frameSize) / hop) + 1);
  const bins = frameSize / 2 + 1;
  const onset = new Float64Array(frames);
  const rms = new Float64Array(frames);
  const bands: Float64Array[] = [];

  // Log-spaced band edges between 40 Hz and Nyquist.
  const nyq = sampleRate / 2;
  const edges: number[] = [];
  for (let b = 0; b <= bandCount; b++) {
    const f = 40 * Math.pow(nyq / 40, b / bandCount);
    edges.push(Math.min(bins - 1, Math.max(1, Math.round((f / nyq) * (bins - 1)))));
  }

  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    let energy = 0;
    for (let i = 0; i < frameSize; i++) {
      const v = samples[off + i]!;
      energy += v * v;
      re[i] = v * window[i]!;
      im[i] = 0;
    }
    rms[f] = Math.sqrt(energy / frameSize);
    fft.transform(re, im);
    let flux = 0;
    for (let k = 0; k < bins; k++) {
      const mag = Math.hypot(re[k]!, im[k]!);
      const lm = Math.log1p(100 * mag);
      cur[k] = lm;
      if (f > 0) {
        const d = lm - prev[k]!;
        if (d > 0) flux += d;
      }
    }
    onset[f] = flux;
    const bandVals = new Float64Array(bandCount);
    for (let b = 0; b < bandCount; b++) {
      const lo = edges[b]!;
      const hi = Math.max(lo + 1, edges[b + 1]!);
      let s = 0;
      for (let k = lo; k < hi; k++) s += cur[k]!;
      bandVals[b] = s / (hi - lo);
    }
    bands.push(bandVals);
    const t = prev;
    prev = cur;
    cur = t;
  }

  // Local-mean removal and half-wave rectification make the envelope emphasise onsets.
  const mean = movingAverage(onset, Math.round(0.25 / (hop / sampleRate)));
  let maxOnset = 0;
  for (let i = 0; i < frames; i++) {
    const v = Math.max(0, onset[i]! - mean[i]!);
    onset[i] = v;
    if (v > maxOnset) maxOnset = v;
  }
  if (maxOnset > 0) for (let i = 0; i < frames; i++) onset[i]! /= maxOnset;
  return { hopSec: hop / sampleRate, onset, bands, rms };
}

// ---------------------------------------------------------------------------
// Tempo & beats
// ---------------------------------------------------------------------------

/** Triangular smoothing so sharp onsets still correlate at fractional-frame beat periods. */
function smoothEnvelope(x: Float64Array): Float64Array {
  const k = [0.25, 0.5, 1, 0.5, 0.25];
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    let w = 0;
    for (let j = -2; j <= 2; j++) {
      const v = x[i + j];
      if (v === undefined) continue;
      s += v * k[j + 2]!;
      w += k[j + 2]!;
    }
    out[i] = s / w;
  }
  return out;
}

export function estimateTempo(rawOnset: Float64Array, hopSec: number, minBpm = 60, maxBpm = 200): { bpm: number; periodFrames: number } {
  const onset = smoothEnvelope(rawOnset);
  const minLag = Math.max(1, Math.floor(60 / (maxBpm * hopSec)));
  const maxLag = Math.min(onset.length - 1, Math.ceil(60 / (minBpm * hopSec)));
  if (maxLag <= minLag) return { bpm: 120, periodFrames: 60 / (120 * hopSec) };
  let bestLag = minLag;
  let bestScore = -Infinity;
  const scores = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < onset.length; i++) s += onset[i]! * onset[i - lag]!;
    s /= onset.length - lag;
    const bpm = 60 / (lag * hopSec);
    // Log-normal prior centred on 120 BPM (one octave spread) resolves octave ambiguity.
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1.0, 2));
    const score = s * prior;
    scores[lag] = score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  // Parabolic interpolation for sub-frame precision.
  let lag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = scores[bestLag - 1]!;
    const b = scores[bestLag]!;
    const c = scores[bestLag + 1]!;
    const denom = a - 2 * b + c;
    if (denom !== 0) lag = bestLag + (0.5 * (a - c)) / denom;
  }
  return { bpm: 60 / (lag * hopSec), periodFrames: lag };
}

/** Dynamic-programming beat tracker. Returns beat times in seconds. */
export function trackBeats(onset: Float64Array, hopSec: number, periodFrames: number, tightness = 100): number[] {
  const n = onset.length;
  if (n === 0) return [];
  const score = new Float64Array(n);
  const backlink = new Int32Array(n).fill(-1);
  const p = periodFrames;
  for (let t = 0; t < n; t++) {
    const lo = Math.max(0, Math.round(t - 2 * p));
    const hi = Math.round(t - p / 2);
    let best = 0;
    let bestIdx = -1;
    for (let prev = lo; prev <= hi && prev < t; prev++) {
      const penalty = -tightness * Math.pow(Math.log((t - prev) / p), 2);
      const s = score[prev]! + penalty;
      if (bestIdx === -1 || s > best) {
        best = s;
        bestIdx = prev;
      }
    }
    score[t] = onset[t]! + (bestIdx >= 0 ? best : 0);
    backlink[t] = bestIdx;
  }
  // Start from the best-scoring frame within the final beat period.
  let end = n - 1;
  let bestEnd = -Infinity;
  for (let t = Math.max(0, Math.floor(n - p)); t < n; t++) {
    if (score[t]! > bestEnd) {
      bestEnd = score[t]!;
      end = t;
    }
  }
  const beats: number[] = [];
  for (let t = end; t >= 0; t = backlink[t]!) {
    beats.push(t);
    if (backlink[t]! < 0) break;
  }
  beats.reverse();
  // Drop leading beats that sit in silence.
  const threshold = 0.05;
  let first = 0;
  while (first < beats.length - 1 && onset[beats[first]!]! < threshold && onset[beats[first + 1]!]! < threshold) first++;
  return beats.slice(first).map((f) => Math.round(f * hopSec * 1000) / 1000);
}

export function pickDownbeats(beats: number[], onset: Float64Array, hopSec: number, beatsPerBar = 4): number[] {
  if (beats.length < beatsPerBar) return beats.slice(0, 1);
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let phase = 0; phase < beatsPerBar; phase++) {
    let s = 0;
    let c = 0;
    for (let i = phase; i < beats.length; i += beatsPerBar) {
      s += onset[Math.min(onset.length - 1, Math.round(beats[i]! / hopSec))]!;
      c++;
    }
    const avg = s / Math.max(1, c);
    if (avg > bestScore) {
      bestScore = avg;
      bestPhase = phase;
    }
  }
  const out: number[] = [];
  for (let i = bestPhase; i < beats.length; i += beatsPerBar) out.push(beats[i]!);
  return out;
}

// ---------------------------------------------------------------------------
// Energy & structure
// ---------------------------------------------------------------------------

export function energyCurve(samples: Float32Array, sampleRate: number, hopSec = 0.5): number[] {
  const hop = Math.max(1, Math.round(hopSec * sampleRate));
  const out: number[] = [];
  let max = 0;
  for (let i = 0; i < samples.length; i += hop) {
    let s = 0;
    const e = Math.min(samples.length, i + hop);
    for (let k = i; k < e; k++) s += samples[k]! * samples[k]!;
    const v = Math.sqrt(s / Math.max(1, e - i));
    out.push(v);
    if (v > max) max = v;
  }
  return out.map((v) => (max > 0 ? Math.round((v / max) * 1000) / 1000 : 0));
}

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface SegmentationInput {
  features: SpectralFeatures;
  /** Boundaries of analysis units (bars) in seconds; length = units + 1. */
  unitEdges: number[];
  durationSec: number;
  minSectionUnits?: number;
  kernelHalf?: number;
}

/** Returns section boundaries (seconds), including 0 and the end. */
export function segmentStructure(input: SegmentationInput): { boundaries: number[]; unitFeatures: Float64Array[]; unitEnergy: number[] } {
  const { features, unitEdges } = input;
  const units = unitEdges.length - 1;
  const bandCount = features.bands[0]?.length ?? 0;
  const unitFeatures: Float64Array[] = [];
  const unitEnergy: number[] = [];
  for (let u = 0; u < units; u++) {
    const f0 = Math.floor(unitEdges[u]! / features.hopSec);
    const f1 = Math.max(f0 + 1, Math.floor(unitEdges[u + 1]! / features.hopSec));
    const v = new Float64Array(bandCount + 1);
    let e = 0;
    let count = 0;
    for (let f = f0; f < f1 && f < features.bands.length; f++) {
      const b = features.bands[f]!;
      for (let k = 0; k < bandCount; k++) v[k]! += b[k]!;
      e += features.rms[f]!;
      count++;
    }
    if (count) for (let k = 0; k < bandCount; k++) v[k]! /= count;
    const energy = count ? e / count : 0;
    v[bandCount] = energy * 20;
    unitFeatures.push(v);
    unitEnergy.push(energy);
  }
  // Mean-centre features so cosine similarity reflects timbre differences.
  const mean = new Float64Array(bandCount + 1);
  for (const v of unitFeatures) for (let k = 0; k <= bandCount; k++) mean[k]! += v[k]! / Math.max(1, units);
  const centred = unitFeatures.map((v) => v.map((x, k) => x - mean[k]!));

  const half = input.kernelHalf ?? 4;
  const novelty = new Float64Array(units + 1);
  for (let c = 1; c < units; c++) {
    let s = 0;
    for (let i = -half; i < half; i++) {
      for (let j = -half; j < half; j++) {
        const a = c + i;
        const b = c + j;
        if (a < 0 || b < 0 || a >= units || b >= units) continue;
        const sign = (i < 0) === (j < 0) ? 1 : -1;
        const w = Math.exp(-0.5 * (((i + 0.5) / half) ** 2 + ((j + 0.5) / half) ** 2));
        s += sign * w * cosine(centred[a]!, centred[b]!);
      }
    }
    novelty[c] = Math.max(0, s);
  }
  const minUnits = input.minSectionUnits ?? 4;
  const peaks: number[] = [];
  const nMax = Math.max(...novelty);
  const thresh = nMax * 0.3;
  const candidates = Array.from(novelty.keys())
    .filter((c) => c > 0 && c < units && novelty[c]! >= thresh && novelty[c]! >= (novelty[c - 1] ?? 0) && novelty[c]! >= (novelty[c + 1] ?? 0))
    .sort((a, b) => novelty[b]! - novelty[a]!);
  for (const c of candidates) {
    if (c < minUnits || units - c < minUnits) continue;
    if (peaks.every((p) => Math.abs(p - c) >= minUnits)) peaks.push(c);
  }
  peaks.sort((a, b) => a - b);
  const boundaries = [0, ...peaks.map((p) => unitEdges[p]!), input.durationSec];
  return { boundaries, unitFeatures: centred, unitEnergy };
}

/** Heuristic section labelling from repetition and energy. AI labelling can refine it later. */
export function labelSections(boundaries: number[], unitEdges: number[], unitFeatures: Float64Array[], unitEnergy: number[]): SongSection[] {
  const sections: { start: number; end: number; feature: Float64Array; energy: number }[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!;
    const end = boundaries[i + 1]!;
    const units = unitEdges.map((e, k) => ({ e, k })).filter(({ e, k }) => k < unitFeatures.length && e >= start - 1e-6 && e < end - 1e-6);
    const dim = unitFeatures[0]?.length ?? 1;
    const feature = new Float64Array(dim);
    let energy = 0;
    for (const { k } of units) {
      const f = unitFeatures[k]!;
      for (let d = 0; d < dim; d++) feature[d]! += f[d]! / Math.max(1, units.length);
      energy += unitEnergy[k]! / Math.max(1, units.length);
    }
    sections.push({ start, end, feature, energy });
  }
  const maxEnergy = Math.max(1e-9, ...sections.map((s) => s.energy));
  // Group sections that sound alike.
  const group: number[] = new Array(sections.length).fill(-1);
  let groups = 0;
  for (let i = 0; i < sections.length; i++) {
    if (group[i] !== -1) continue;
    group[i] = groups;
    for (let j = i + 1; j < sections.length; j++) {
      if (group[j] === -1 && cosine(sections[i]!.feature, sections[j]!.feature) > 0.85) group[j] = groups;
    }
    groups++;
  }
  const groupEnergy = new Map<number, number>();
  const groupCount = new Map<number, number>();
  sections.forEach((s, i) => {
    const g = group[i]!;
    groupEnergy.set(g, (groupEnergy.get(g) ?? 0) + s.energy / maxEnergy);
    groupCount.set(g, (groupCount.get(g) ?? 0) + 1);
  });
  let chorusGroup = -1;
  let best = -1;
  for (const [g, e] of groupEnergy) {
    const c = groupCount.get(g)!;
    const avg = e / c;
    const score = avg + (c > 1 ? 0.25 : 0);
    if (score > best) {
      best = score;
      chorusGroup = g;
    }
  }
  const labels: SectionLabel[] = sections.map((s, i) => {
    const rel = s.energy / maxEnergy;
    const first = i === 0;
    const last = i === sections.length - 1;
    if (first && rel < 0.6 && sections.length > 2) return 'intro';
    if (last && rel < 0.6 && sections.length > 2) return 'outro';
    if (group[i] === chorusGroup) return 'chorus';
    if ((groupCount.get(group[i]!) ?? 1) === 1 && i > sections.length / 2 && !last) return 'bridge';
    return rel < 0.45 ? 'instrumental' : 'verse';
  });
  const counters = new Map<SectionLabel, number>();
  return sections.map((s, i) => {
    const label = labels[i]!;
    const n = (counters.get(label) ?? 0) + 1;
    counters.set(label, n);
    const pretty = label.charAt(0).toUpperCase() + label.slice(1).replace('-', ' ');
    const repeats = labels.filter((l) => l === label).length > 1;
    return {
      id: `sec_${i}`,
      label,
      name: repeats ? `${pretty} ${n}` : pretty,
      start: Math.round(s.start * 1000) / 1000,
      end: Math.round(s.end * 1000) / 1000,
      energy: Math.round((s.energy / maxEnergy) * 1000) / 1000,
    };
  });
}

// ---------------------------------------------------------------------------
// Full analysis
// ---------------------------------------------------------------------------

export interface AudioAnalysisResult {
  durationSec: number;
  peaks: { min: number[]; max: number[] };
  bpm: number;
  beats: number[];
  downbeats: number[];
  energy: number[];
  energyHop: number;
  sections: SongSection[];
}

export function analyzeAudio(samples: Float32Array, sampleRate: number, opts: { peakBins?: number } = {}): AudioAnalysisResult {
  const durationSec = samples.length / sampleRate;
  const peaks = computePeaks(samples, opts.peakBins ?? 1600);
  const factor = Math.max(1, Math.round(sampleRate / 22050));
  const x = decimate(samples, factor);
  const sr = sampleRate / factor;
  const feats = spectralFeatures(x, sr);
  const { bpm: rawBpm, periodFrames } = estimateTempo(feats.onset, feats.hopSec);
  const beats = trackBeats(feats.onset, feats.hopSec, periodFrames);
  const downbeats = pickDownbeats(beats, feats.onset, feats.hopSec);
  const energyHop = 0.5;
  const energy = energyCurve(x, sr, energyHop);

  // Bars (from downbeats) are the analysis units; fall back to 2-second units when beats are sparse.
  let unitEdges: number[];
  if (downbeats.length >= 8) {
    unitEdges = [0, ...downbeats.filter((d) => d > 0.05), durationSec];
  } else {
    unitEdges = [];
    for (let t = 0; t < durationSec; t += 2) unitEdges.push(t);
    unitEdges.push(durationSec);
  }
  const seg = segmentStructure({ features: feats, unitEdges, durationSec, minSectionUnits: 4, kernelHalf: 4 });
  const sections = labelSections(seg.boundaries, unitEdges, seg.unitFeatures, seg.unitEnergy);
  return {
    durationSec: Math.round(durationSec * 1000) / 1000,
    peaks,
    bpm: Math.round(rawBpm * 10) / 10,
    beats,
    downbeats,
    energy,
    energyHop,
    sections,
  };
}

/** Snaps a time to the nearest beat. */
export function snapToBeat(t: number, beats: number[]): number {
  if (!beats.length) return t;
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  const a = beats[Math.max(0, lo - 1)]!;
  const b = beats[lo]!;
  return Math.abs(a - t) <= Math.abs(b - t) ? a : b;
}

/**
 * Splits a song section into shot slots between `minSec` and `maxSec` (Omni supports 3–10 s),
 * aligned to bar lines where possible.
 */
export function planShotSlots(section: { start: number; end: number }, downbeats: number[], minSec = 3, maxSec = 8): { start: number; end: number }[] {
  const slots: { start: number; end: number }[] = [];
  const bars = downbeats.filter((d) => d > section.start + 0.01 && d < section.end - 0.01);
  const edges = [section.start, ...bars, section.end];
  let cursor = section.start;
  for (let i = 1; i < edges.length; i++) {
    const e = edges[i]!;
    const len = e - cursor;
    const isLast = i === edges.length - 1;
    if (len >= maxSec) {
      // Split long spans evenly.
      const n = Math.ceil(len / maxSec);
      const step = len / n;
      for (let k = 0; k < n; k++) slots.push({ start: cursor + k * step, end: cursor + (k + 1) * step });
      cursor = e;
    } else if (len >= minSec && (isLast || edges[i + 1]! - cursor > maxSec)) {
      slots.push({ start: cursor, end: e });
      cursor = e;
    } else if (isLast) {
      if (slots.length && len < minSec) slots[slots.length - 1]!.end = e;
      else slots.push({ start: cursor, end: e });
      cursor = e;
    }
  }
  return slots.map((s) => ({ start: Math.round(s.start * 1000) / 1000, end: Math.round(s.end * 1000) / 1000 }));
}
