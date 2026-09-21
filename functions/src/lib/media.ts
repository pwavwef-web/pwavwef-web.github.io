import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { computePeaks } from '@az-studio/shared';

const execFileAsync = promisify(execFile);

export const FFMPEG = process.env.FFMPEG_BIN || (ffmpegStatic as unknown as string);
export const FFPROBE = process.env.FFPROBE_BIN || (ffprobeStatic as { path: string }).path;

export interface ProbeResult {
  formatName: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
}

function parseRate(r: string | undefined): number | null {
  if (!r) return null;
  const [n, d] = r.split('/').map(Number);
  if (!n || !d) return null;
  return Math.round((n / d) * 1000) / 1000;
}

/** Runs ffprobe on a local path or an https URL (signed URLs allow range reads without a download). */
export async function probe(input: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const data = JSON.parse(stdout) as {
    format?: { format_name?: string; duration?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; duration?: string }[];
  };
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const dur = Number(data.format?.duration ?? v?.duration ?? a?.duration);
  return {
    formatName: data.format?.format_name ?? '',
    durationSec: Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) / 1000 : null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    fps: parseRate(v?.avg_frame_rate) ?? parseRate(v?.r_frame_rate),
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
  };
}

async function ffmpeg(args: string[], timeoutMs = 300_000): Promise<void> {
  await execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
}

/** JPEG poster/thumbnail from a video frame. */
export async function videoFrame(input: string, output: string, atSec: number, width: number): Promise<void> {
  await ffmpeg(['-ss', String(Math.max(0, atSec)), '-i', input, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', output]);
}

/** JPEG thumbnail of an image. */
export async function imageThumb(input: string, output: string, width: number): Promise<void> {
  await ffmpeg(['-i', input, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-q:v', '3', output]);
}

/** Cuts a window out of a video (used to fit Omni's 10-second edit limit). */
export async function trimVideo(input: string, output: string, startSec: number, durationSec: number): Promise<void> {
  await ffmpeg(['-ss', String(startSec), '-i', input, '-t', String(durationSec), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output], 600_000);
}

/** Decodes audio to mono 8 kHz PCM and computes waveform peaks. */
export async function audioPeaks(input: string, bins = 1600): Promise<{ min: number[]; max: number[] }> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1']);
    const timer = setTimeout(() => p.kill('SIGKILL'), 300_000);
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`));
    });
  });
  const buf = Buffer.concat(chunks);
  const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  return computePeaks(samples, bins);
}

/**
 * Detects an embedded C2PA manifest (Content Credentials): PNG `caBX` chunk, MP4/HEIF `uuid` box
 * or JPEG APP11 JUMBF segments all contain the `c2pa` JUMBF label near the start of the file.
 */
export function detectC2pa(head: Buffer): 'present' | 'absent' {
  const hasLabel = head.includes(Buffer.from('c2pa'));
  const hasJumbf = head.includes(Buffer.from('jumb'));
  return hasLabel && hasJumbf ? 'present' : 'absent';
}
