import { spawn } from 'node:child_process';
import type { AudioMeasurements, VisualMeasurements } from '@az-studio/shared';
import { FFMPEG } from './media';

/**
 * Deterministic measurements of generated media. These run on the actual file (FFmpeg), so the
 * quality review never rests on a model's impression alone: cut-offs, silence, clipping, hard cuts,
 * black frames and motion at the end of a shot are measured.
 */

function run(args: string[], opts: { stdout?: boolean; timeoutMs?: number } = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', ...args]);
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs ?? 300_000);
    p.stdout.on('data', (d: Buffer) => opts.stdout !== false && out.push(d));
    p.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 4_000_000) err = err.slice(-2_000_000);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`ffmpeg exited with ${code}: ${err.split('\n').filter(Boolean).slice(-4).join(' | ')}`));
    });
  });
}

/** Decodes the audio of a file (local path or loopback URL) to mono float PCM. */
export async function decodeMono(input: string, rate = 16000): Promise<Float32Array> {
  const { stdout } = await run(['-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1']);
  const aligned = stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + (stdout.byteLength - (stdout.byteLength % 4)));
  return new Float32Array(aligned);
}

/** 16-bit little-endian PCM (e.g. TTS output) to float samples. */
export function pcm16ToFloat(pcm: Buffer): Float32Array {
  const n = Math.floor(pcm.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

/** Wraps 16-bit PCM in a WAV container. */
export function pcm16ToWav(pcm: Buffer, rate: number, channels = 1): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** RMS per frame (default 20 ms). */
export function rmsEnvelope(samples: Float32Array, rate: number, frameSec = 0.02): Float64Array {
  const hop = Math.max(1, Math.round(rate * frameSec));
  const n = Math.ceil(samples.length / hop);
  const env = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    const a = f * hop;
    const b = Math.min(samples.length, a + hop);
    for (let i = a; i < b; i++) s += samples[i]! * samples[i]!;
    env[f] = Math.sqrt(s / Math.max(1, b - a));
  }
  return env;
}

function percentile(values: ArrayLike<number>, p: number): number {
  const arr = Array.from(values).sort((a, b) => a - b);
  if (!arr.length) return 0;
  return arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))))]!;
}

/**
 * Where speech (or any clearly audible sound) starts and ends, ignoring leading/trailing silence.
 * Used to measure the real spoken length of a dialogue line.
 */
export function speechBounds(samples: Float32Array, rate: number): { start: number; end: number; durationSec: number } | null {
  const frame = 0.02;
  const env = rmsEnvelope(samples, rate, frame);
  const loud = percentile(env, 0.95);
  if (loud < 1e-4) return null;
  const th = Math.max(loud * 0.08, 0.003);
  let a = env.findIndex((v) => v >= th);
  let b = env.length - 1 - [...env].reverse().findIndex((v) => v >= th);
  if (a < 0 || b < a) return null;
  // Keep soft onsets/releases (consonants, breaths at the edge of words).
  a = Math.max(0, a - 2);
  b = Math.min(env.length - 1, b + 3);
  const start = a * frame;
  const end = Math.min(samples.length / rate, (b + 1) * frame);
  return { start: +start.toFixed(3), end: +end.toFixed(3), durationSec: +(end - start).toFixed(3) };
}

/** Level, clipping and how loud the final 150 ms are relative to the programme. */
export function audioMeasurements(samples: Float32Array, rate: number): Omit<AudioMeasurements, 'speechAtEnd' | 'integratedLufs'> & { endRatio: number } {
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]!);
    if (v > peak) peak = v;
    if (v >= 0.999) clipped++;
  }
  const env = rmsEnvelope(samples, rate, 0.02);
  const ref = percentile(env, 0.95) || 1e-9;
  const tailFrames = Math.max(1, Math.round(0.15 / 0.02));
  const tail = env.slice(Math.max(0, env.length - tailFrames));
  const tailRms = tail.length ? Math.sqrt(tail.reduce((s, v) => s + v * v, 0) / tail.length) : 0;
  const ratio = tailRms / ref;
  return {
    peakDbfs: peak > 0 ? +(20 * Math.log10(peak)).toFixed(2) : null,
    clippedRatio: samples.length ? +(clipped / samples.length).toFixed(5) : 0,
    endLevelDb: ratio > 0 ? +(20 * Math.log10(ratio)).toFixed(1) : null,
    endRatio: ratio,
  };
}

/** Integrated loudness (EBU R128, LUFS). */
export async function integratedLoudness(input: string): Promise<number | null> {
  try {
    const { stderr } = await run(['-i', input, '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { stdout: false });
    const m = /I:\s+(-?[\d.]+)\s+LUFS/.exec(stderr.slice(stderr.lastIndexOf('Summary')));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Integrated loudness (LUFS), true peak (dBTP) and loudness range (LU), EBU R128. */
export async function loudnessStats(input: string): Promise<{ integratedLufs: number | null; truePeakDb: number | null; lra: number | null }> {
  try {
    const { stderr } = await run(['-i', input, '-vn', '-af', 'ebur128=framelog=quiet:peak=true', '-f', 'null', '-'], { stdout: false, timeoutMs: 600_000 });
    const sum = stderr.slice(stderr.lastIndexOf('Summary'));
    const num = (re: RegExp) => {
      const m = re.exec(sum);
      return m && m[1] !== '-inf' ? Number(m[1]) : null;
    };
    return { integratedLufs: num(/I:\s+(-?[\d.]+)\s+LUFS/), truePeakDb: num(/True peak:\s+Peak:\s+(-?[\d.]+|-inf)\s+dBFS/) ?? num(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/), lra: num(/LRA:\s+(-?[\d.]+)\s+LU/) };
  } catch {
    return { integratedLufs: null, truePeakDb: null, lra: null };
  }
}

/** Momentary loudness (EBU R128, 400 ms window) every 100 ms; `t` is the end of the window. */
export async function momentaryLoudness(input: string): Promise<{ t: number; m: number }[]> {
  const { stdout } = await run(['-loglevel', 'error', '-i', input, '-vn', '-af', 'aresample=48000,asetnsamples=n=4800:p=0,ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M:file=-', '-f', 'null', '-'], { timeoutMs: 600_000 });
  const out: { t: number; m: number }[] = [];
  let t: number | null = null;
  for (const line of stdout.toString().split('\n')) {
    const at = /pts_time:([\d.]+)/.exec(line);
    if (at) t = Number(at[1]) + 0.1;
    const m = /lavfi\.r128\.M=(-?[\d.]+)/.exec(line);
    if (m && t !== null) out.push({ t: Math.round(t * 1000) / 1000, m: Number(m[1]) });
  }
  return out;
}

/** Silent spans (below `noiseDb` for at least `minSec`). */
export async function silentSpans(input: string, noiseDb = -45, minSec = 1.5): Promise<{ start: number; end: number }[]> {
  const { stderr } = await run(['-i', input, '-vn', '-af', `silencedetect=n=${noiseDb}dB:d=${minSec}`, '-f', 'null', '-'], { stdout: false, timeoutMs: 600_000 });
  const out: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    if (e && open !== null) {
      out.push({ start: open, end: Number(e[1]) });
      open = null;
    }
  }
  return out;
}

/** 16 kHz mono FLAC for transcription (small, lossless for speech). */
export async function extractSpeechAudio(input: string, output: string, segment?: { startSec: number; durationSec: number }): Promise<void> {
  await run([
    '-loglevel', 'error', '-y',
    ...(segment ? ['-ss', String(segment.startSec), '-t', String(segment.durationSec)] : []),
    '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', output,
  ], { stdout: false });
}

/** Hard cuts (scene-change score above the threshold), in seconds. */
export async function sceneCuts(input: string, threshold = 0.45): Promise<number[]> {
  const { stdout } = await run(['-loglevel', 'error', '-i', input, '-an', '-vf', `scale=320:-2,select='gt(scene,${threshold})',metadata=print:file=-`, '-f', 'null', '-']);
  const cuts: number[] = [];
  for (const m of stdout.toString().matchAll(/pts_time:([\d.]+)/g)) cuts.push(+Number(m[1]).toFixed(3));
  return cuts;
}

export async function blackSegments(input: string): Promise<{ start: number; end: number }[]> {
  const { stderr } = await run(['-i', input, '-an', '-vf', 'blackdetect=d=0.15:pix_th=0.10', '-f', 'null', '-'], { stdout: false });
  const out: { start: number; end: number }[] = [];
  for (const m of stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)) out.push({ start: Number(m[1]), end: Number(m[2]) });
  return out;
}

/**
 * Motion over time: mean luma difference between consecutive frames. Compares the final half second
 * with the whole shot (still in motion at the end → movement may be unfinished; zero → frozen).
 */
export async function motionProfile(input: string): Promise<{ endMotionRatio: number | null; frozenAtEnd: boolean; samples: number }> {
  const { stdout } = await run(['-loglevel', 'error', '-i', input, '-an', '-vf', "scale=160:-2,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", '-f', 'null', '-']);
  const rows: { t: number; v: number }[] = [];
  let t = 0;
  for (const line of stdout.toString().split('\n')) {
    const pt = /pts_time:([\d.]+)/.exec(line);
    if (pt) t = Number(pt[1]);
    const val = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line);
    if (val) rows.push({ t, v: Number(val[1]) });
  }
  if (rows.length < 6) return { endMotionRatio: null, frozenAtEnd: false, samples: rows.length };
  const last = rows[rows.length - 1]!.t;
  const tail = rows.filter((r) => r.t >= last - 0.5);
  const mean = rows.reduce((s, r) => s + r.v, 0) / rows.length;
  const tailMean = tail.reduce((s, r) => s + r.v, 0) / Math.max(1, tail.length);
  return { endMotionRatio: mean > 0 ? +(tailMean / mean).toFixed(3) : null, frozenAtEnd: mean > 0.8 && tailMean < 0.05, samples: rows.length };
}

export async function visualMeasurements(input: string): Promise<VisualMeasurements> {
  const [cuts, black, motion] = await Promise.all([sceneCuts(input).catch(() => []), blackSegments(input).catch(() => []), motionProfile(input).catch(() => ({ endMotionRatio: null, frozenAtEnd: false, samples: 0 }))]);
  return { sceneCuts: cuts, blackSegments: black, endMotionRatio: motion.endMotionRatio, frozenAtEnd: motion.frozenAtEnd };
}

/** JPEG of the last frame of a video (for continuity with the next shot). */
export async function lastFrameJpeg(input: string, output: string, width = 1280): Promise<void> {
  await run(['-loglevel', 'error', '-y', '-sseof', '-0.08', '-i', input, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', output], { stdout: false });
}
