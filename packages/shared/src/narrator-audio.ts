import { ENROLLMENT, type RecordingAnalysis, type RecordingIssue, type RecordingKind } from './narrator';

/**
 * Measurements on decoded PCM (Float32, mono): levels, clipping, silence and pauses for enrollment
 * recordings, speech bounds for generated clips, waveform peaks from the real samples, and the
 * click-free trim/fade/join used to assemble an edition. Pure functions — the backend decodes with FFmpeg.
 */

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -120);
const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Frame RMS (dBFS) of 20 ms frames. */
export function frameLevels(samples: Float32Array, sampleRate: number, frameSec = 0.02): number[] {
  const n = Math.max(1, Math.round(sampleRate * frameSec));
  const out: number[] = [];
  for (let i = 0; i < samples.length; i += n) {
    let sum = 0;
    const end = Math.min(samples.length, i + n);
    for (let j = i; j < end; j++) sum += samples[j]! * samples[j]!;
    out.push(db(Math.sqrt(sum / Math.max(1, end - i))));
  }
  return out;
}

/** Threshold for "speech present" in a frame: well above a typical room floor, below quiet speech. */
export const SPEECH_FRAME_DBFS = -42;

export interface SpeechBounds {
  startSec: number;
  endSec: number;
  speechSec: number;
  longestPauseSec: number;
}

export function speechBounds(samples: Float32Array, sampleRate: number): SpeechBounds | null {
  const levels = frameLevels(samples, sampleRate);
  const frame = 0.02;
  let first = -1;
  let last = -1;
  let voiced = 0;
  let pause = 0;
  let longest = 0;
  levels.forEach((l, i) => {
    if (l >= SPEECH_FRAME_DBFS) {
      if (first < 0) first = i;
      last = i;
      voiced++;
      longest = Math.max(longest, pause);
      pause = 0;
    } else if (first >= 0) pause++;
  });
  if (first < 0) return null;
  return { startSec: r3(first * frame), endSec: r3(Math.min(samples.length / sampleRate, (last + 1) * frame)), speechSec: r1(voiced * frame), longestPauseSec: r1(longest * frame) };
}

/** Recording checks for enrollment (Google: 10–30 s of clean, natural speech for the reference). */
export function analyzeRecording(samples: Float32Array, sampleRate: number, kind: RecordingKind): RecordingAnalysis {
  const durationSec = samples.length / sampleRate;
  let peak = 0;
  let sum = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    sum += samples[i]! * samples[i]!;
  }
  const levels = frameLevels(samples, sampleRate);
  const sorted = [...levels].sort((a, b) => a - b);
  const noiseFloor = sorted.length ? sorted[Math.floor(sorted.length * 0.1)]! : -120;
  const bounds = speechBounds(samples, sampleRate);
  const voicedLevels = levels.filter((l) => l >= SPEECH_FRAME_DBFS);
  const speechRms = voicedLevels.length ? db(Math.sqrt(voicedLevels.reduce((s, l) => s + Math.pow(10, l / 10), 0) / voicedLevels.length)) : -120;
  const clippedPct = samples.length ? (clipped / samples.length) * 100 : 0;
  const limits = ENROLLMENT[kind];
  const issues: RecordingIssue[] = [];
  if (!bounds || db(peak) < -45) issues.push({ code: 'silent', severity: 'error', message: 'No speech was detected. Check that the right microphone is selected and not muted.' });
  if (durationSec < limits.minSec - 0.05) issues.push({ code: 'too_short', severity: 'error', message: `The recording is ${r1(durationSec)} s; ${kind === 'reference' ? 'Google asks for 10–30 seconds of natural speech' : `at least ${limits.minSec} s is needed`}.` });
  if (durationSec > limits.maxSec + 0.25) issues.push({ code: 'too_long', severity: 'error', message: `The recording is ${r1(durationSec)} s; ${kind === 'reference' ? 'Google asks for at most 30 seconds' : `keep it under ${limits.maxSec} s`}. Record again or trim it before uploading.` });
  if (clippedPct > 0.05) issues.push({ code: 'clipping', severity: 'error', message: 'The recording is distorted (too loud — the signal hit full scale). Move back from the microphone or lower the input gain, then record again.' });
  else if (clippedPct > 0.002) issues.push({ code: 'clipping', severity: 'warning', message: 'A few peaks hit full scale. It may be fine, but a slightly lower input level is safer.' });
  if (bounds && speechRms < -36) issues.push({ code: 'too_quiet', severity: 'warning', message: 'The voice is quiet. Move closer to the microphone or raise the input level.' });
  if (noiseFloor > -48 && bounds) issues.push({ code: 'noisy', severity: 'warning', message: 'There is noticeable background noise between words. A quieter room gives a cleaner voice.' });
  if (bounds && bounds.longestPauseSec > 3) issues.push({ code: 'long_pause', severity: 'warning', message: `There is a ${bounds.longestPauseSec} s pause. Natural, continuous speech works best.` });
  if (bounds && durationSec - bounds.endSec > 3) issues.push({ code: 'trailing_silence', severity: 'warning', message: 'The recording ends with several seconds of silence.' });
  return {
    durationSec: r3(durationSec),
    speechSec: bounds?.speechSec ?? 0,
    peakDbfs: r1(db(peak)),
    rmsDbfs: r1(db(Math.sqrt(sum / Math.max(1, samples.length)))),
    clippedPct: Math.round(clippedPct * 10000) / 10000,
    noiseFloorDbfs: r1(noiseFloor),
    longestPauseSec: bounds?.longestPauseSec ?? 0,
    leadingSilenceSec: bounds ? r1(bounds.startSec) : r1(durationSec),
    trailingSilenceSec: bounds ? r1(durationSec - bounds.endSec) : 0,
    issues,
  };
}

export const hasBlockingIssue = (a: RecordingAnalysis | null | undefined) => Boolean(a?.issues.some((i) => i.severity === 'error'));

/** Peak envelope (max |x| per bin, 0–1, 3 decimals) — waveforms always come from the real samples. */
export function peakEnvelope(samples: Float32Array, bins: number): number[] {
  const out: number[] = [];
  if (!samples.length || bins < 1) return out;
  const step = samples.length / bins;
  for (let b = 0; b < bins; b++) {
    const s = Math.floor(b * step);
    const e = Math.min(samples.length, Math.max(s + 1, Math.floor((b + 1) * step)));
    let m = 0;
    for (let i = s; i < e; i++) {
      const a = Math.abs(samples[i]!);
      if (a > m) m = a;
    }
    out.push(Math.round(m * 1000) / 1000);
  }
  return out;
}

/** Peaks to store with a clip or render: ~12 bins per second, between 40 and 1,600. */
export function peaksFor(samples: Float32Array, sampleRate: number): number[] {
  const sec = samples.length / sampleRate;
  return peakEnvelope(samples, Math.max(40, Math.min(1600, Math.round(sec * 12))));
}

/**
 * Trims silence at both ends of a generated clip (keeping a margin so no word is clipped) and applies short
 * fades so joins never click. Speech inside the clip is untouched.
 */
export function trimClip(samples: Float32Array, sampleRate: number, opts: { leadSec?: number; tailSec?: number; fadeSec?: number } = {}): Float32Array {
  const lead = opts.leadSec ?? 0.06;
  const tail = opts.tailSec ?? 0.15;
  const fade = opts.fadeSec ?? 0.008;
  const b = speechBounds(samples, sampleRate);
  if (!b) return new Float32Array(0);
  const s = Math.max(0, Math.floor((b.startSec - lead) * sampleRate));
  const e = Math.min(samples.length, Math.ceil((b.endSec + tail) * sampleRate));
  const out = samples.slice(s, e);
  applyFades(out, sampleRate, fade);
  return out;
}

export function applyFades(samples: Float32Array, sampleRate: number, fadeSec: number): void {
  const n = Math.min(Math.floor(samples.length / 2), Math.round(fadeSec * sampleRate));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    samples[i]! *= g;
    samples[samples.length - 1 - i]! *= g;
  }
}

/** Joins decoded clips with exact silences between them (sample-accurate). Returns the joined samples and each part's span. */
export function joinWithPauses(parts: { samples: Float32Array; pauseAfterSec: number }[], sampleRate: number): { samples: Float32Array; spans: { startSec: number; endSec: number }[] } {
  let total = 0;
  const gaps = parts.map((p, i) => (i < parts.length - 1 ? Math.round(Math.max(0, p.pauseAfterSec) * sampleRate) : 0));
  parts.forEach((p, i) => (total += p.samples.length + gaps[i]!));
  const out = new Float32Array(total);
  const spans: { startSec: number; endSec: number }[] = [];
  let at = 0;
  parts.forEach((p, i) => {
    out.set(p.samples, at);
    spans.push({ startSec: r3(at / sampleRate), endSec: r3((at + p.samples.length) / sampleRate) });
    at += p.samples.length + gaps[i]!;
  });
  return { samples: out, spans };
}

/** Joins the chunks of one long passage with a short natural breath-length gap. */
export const CHUNK_JOIN_PAUSE_SEC = 0.35;

/** Reads a canonical 16-bit PCM WAV (as returned by the 3.8 TTS models) into mono Float32 samples. */
export function decodePcm16Wav(buf: Uint8Array): { samples: Float32Array; sampleRate: number; channels: number } | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
  if (buf.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let o = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (o + 8 <= buf.length) {
    const id = tag(o);
    const size = view.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') fmt = { format: view.getUint16(body, true), channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    if (id === 'data' && fmt) {
      if (fmt.format !== 1 || fmt.bits !== 16) return null;
      const end = Math.min(buf.length, body + (size === 0xffffffff || size === 0 ? buf.length : size));
      const frames = Math.floor((end - body) / (2 * fmt.channels));
      const samples = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) s += view.getInt16(body + (f * fmt.channels + c) * 2, true);
        samples[f] = s / fmt.channels / 32768;
      }
      return { samples, sampleRate: fmt.rate, channels: fmt.channels };
    }
    o = body + size + (size % 2);
  }
  return null;
}

/** Encodes mono Float32 samples as a 16-bit PCM WAV (with TPDF dither). */
export function encodePcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  w(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let seed = 22222;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < samples.length; i++) {
    const d = (rnd() - rnd()) / 32768;
    const v = Math.max(-1, Math.min(1, samples[i]! + d));
    view.setInt16(44 + i * 2, Math.round(v < 0 ? v * 32768 : v * 32767), true);
  }
  return out;
}
