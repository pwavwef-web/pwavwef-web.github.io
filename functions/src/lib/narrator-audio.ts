import { execFile, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileTypeFromBuffer } from 'file-type';
import type { LoudnessMeasurement } from '@az-studio/shared';
import { FFMPEG } from './media';

const execFileAsync = promisify(execFile);

/** Containers browsers record (WebM/Opus, Ogg, MP4/AAC) and common uploads (WAV, MP3, FLAC, M4A). */
const AUDIO_EXT = new Set(['webm', 'ogg', 'opus', 'mp4', 'm4a', 'mp3', 'wav', 'flac', 'aac', 'oga', 'mka']);

/** Checks the real container from the file's bytes (a renamed file is not trusted). */
export async function sniffAudio(buf: Buffer): Promise<{ ext: string; mime: string } | null> {
  const t = await fileTypeFromBuffer(buf);
  if (!t) return null;
  // MediaRecorder WebM with only an audio track is reported as webm (video/webm by MIME tables).
  if (!AUDIO_EXT.has(t.ext) && !(t.ext === 'mp4' || t.ext === 'webm')) return null;
  return { ext: t.ext, mime: t.mime };
}

/** Decodes any supported audio to mono Float32 PCM at `rate` Hz. */
export async function decodeToFloat(input: string, rate = 24_000, timeoutMs = 300_000): Promise<Float32Array> {
  const chunks: Buffer[] = [];
  let err = '';
  await new Promise<void>((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1']);
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`The audio could not be decoded (${err.trim().split('\n').pop()?.slice(0, 200) || `ffmpeg exit ${code}`}).`));
    });
  });
  const buf = Buffer.concat(chunks);
  const aligned = buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.byteLength - (buf.byteLength % 4)));
  return new Float32Array(aligned);
}

/** Converts a recording to the provider's recommended format: 24 kHz, mono, 16-bit PCM WAV, no metadata. */
export async function toEnrollmentWav(input: string, output: string): Promise<void> {
  await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-f', 'wav', output], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
}

/** Writes mono Float32 samples to a raw file FFmpeg can read (`-f f32le -ar … -ac 1`). */
export async function writeRawFloat(file: string, samples: Float32Array): Promise<void> {
  await writeFile(file, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
}

function parseLoudnorm(stderr: string): { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string; output_i?: string; output_tp?: string; output_lra?: string } {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Loudness measurement failed.');
  return JSON.parse(stderr.slice(start, end + 1));
}

const num = (s: string | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : -70;
};

/** EBU R128 integrated loudness, true peak and loudness range of a file (FFmpeg loudnorm analysis). */
export async function measureLoudness(input: string, rawRate?: number, channels: 1 | 2 = 1): Promise<LoudnessMeasurement> {
  const pre = rawRate ? ['-f', 'f32le', '-ar', String(rawRate), '-ac', String(channels)] : [];
  const { stderr } = await execFileAsync(FFMPEG, ['-hide_banner', '-nostats', ...pre, '-i', input, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
  const j = parseLoudnorm(stderr);
  return { integratedLufs: num(j.input_i), truePeakDbtp: num(j.input_tp), lra: num(j.input_lra) };
}

export interface MasterResult {
  before: LoudnessMeasurement;
  after: LoudnessMeasurement;
  wavPath: string;
  mp3Path: string;
  processing: string[];
}

/**
 * Normalises the joined narration (two-pass EBU R128 loudnorm in linear mode — one gain for the whole file,
 * so the speaker's dynamics are kept; the true-peak limit prevents clipping) and writes the WAV master
 * (24 kHz, 16-bit) and a 192 kbps MP3 (44.1 kHz) with title/artist/album tags. Both outputs are measured.
 */
export async function renderMasters(input: { rawPath: string; rate: number; dir: string; channels: 1 | 2; target: { integratedLufs: number; truePeakDbtp: number }; meta: { title: string; artist: string; album: string; date: string | null; comment: string } }): Promise<MasterResult> {
  const { rawPath, rate, dir, channels, target } = input;
  const rawIn = ['-f', 'f32le', '-ar', String(rate), '-ac', '1', '-i', rawPath];
  const { stderr } = await execFileAsync(FFMPEG, ['-hide_banner', '-nostats', ...rawIn, '-af', `loudnorm=I=${target.integratedLufs}:TP=${target.truePeakDbtp}:LRA=11:print_format=json`, '-f', 'null', '-'], { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
  const m = parseLoudnorm(stderr);
  const before: LoudnessMeasurement = { integratedLufs: num(m.input_i), truePeakDbtp: num(m.input_tp), lra: num(m.input_lra) };
  const norm = `loudnorm=I=${target.integratedLufs}:TP=${target.truePeakDbtp}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=json`;
  const layout = channels === 2 ? ',pan=stereo|c0=c0|c1=c0' : '';
  const tags = (fmt: 'wav' | 'mp3') => {
    const t = ['-metadata', `title=${input.meta.title}`, '-metadata', `artist=${input.meta.artist}`, '-metadata', `album=${input.meta.album}`, '-metadata', `comment=${input.meta.comment}`];
    if (input.meta.date) t.push('-metadata', fmt === 'mp3' ? `date=${input.meta.date.slice(0, 4)}` : `ICRD=${input.meta.date}`);
    return t;
  };
  const wavPath = path.join(dir, 'master.wav');
  const mp3Path = path.join(dir, 'master.mp3');
  const normWav = path.join(dir, 'normalised.f32');
  // One normalisation pass, written once as float; both deliverables are encoded from it (identical gain).
  const pass2 = await execFileAsync(FFMPEG, ['-hide_banner', '-nostats', '-y', ...rawIn, '-af', `${norm},aresample=${rate}${layout}`, '-f', 'f32le', '-ac', String(channels), normWav], { timeout: 900_000, maxBuffer: 32 * 1024 * 1024 });
  const normType = /"normalization_type"\s*:\s*"(\w+)"/.exec(String(pass2.stderr))?.[1] ?? 'unknown';
  const normIn = ['-f', 'f32le', '-ar', String(rate), '-ac', String(channels), '-i', normWav];
  await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...normIn, '-c:a', 'pcm_s16le', '-af', 'aresample=osf=s16:dither_method=triangular', ...tags('wav'), wavPath], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...normIn, '-af', 'aresample=44100', '-c:a', 'libmp3lame', '-b:a', '192k', '-id3v2_version', '3', ...tags('mp3'), mp3Path], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  const after = await measureLoudness(wavPath);
  return {
    before,
    after,
    wavPath,
    mp3Path,
    processing: [
      'Each clip decoded to 24 kHz mono float; silence beyond 60 ms before and 150 ms after speech trimmed; 8 ms fades at every join.',
      'Clips joined sample-accurately with the configured pauses (no encoded bytes concatenated).',
      normType === 'linear' ? `Loudness: two-pass EBU R128 (FFmpeg loudnorm, linear mode — one gain for the whole edition) to ${target.integratedLufs} LUFS, true-peak ceiling ${target.truePeakDbtp} dBTP. No compression, de-breathing or noise reduction.` : `Loudness: two-pass EBU R128 (FFmpeg loudnorm) to ${target.integratedLufs} LUFS, true-peak ceiling ${target.truePeakDbtp} dBTP. One fixed gain could not reach the target within the peak ceiling, so loudnorm used its dynamic mode (${normType}). No de-breathing or noise reduction.`,
      `WAV master: ${rate / 1000} kHz, 16-bit PCM (triangular dither), ${channels === 2 ? 'stereo (dual mono)' : 'mono'}. MP3: 44.1 kHz, 192 kbps CBR, ID3v2.3 tags.`,
    ],
  };
}
