import { spawn } from 'node:child_process';
import { flickerIndex, statsFromRgb, type ColourStats, type Rgb, type RgbStats, type TemporalMeasurements } from '@az-studio/shared';
import { FFMPEG } from './media';

/**
 * Frame-level access to real media with FFmpeg: sampled JPEG frames (for Cloud Vision and the
 * reviewer), mirrored frames (to prove mirrored writing), RGB statistics (colour continuity) and
 * temporal analysis (freezes, stutter, flicker, jumps, decode errors).
 */

function ffmpeg(args: string[], opts: { timeoutMs?: number; input?: Buffer } = {}): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', ...args], { stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs ?? 300_000);
    p.stdout!.on('data', (d: Buffer) => out.push(d));
    p.stderr!.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 4_000_000) err = err.slice(-2_000_000);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: err, code: code ?? 1 });
    });
    if (opts.input) {
      p.stdin!.on('error', () => undefined);
      p.stdin!.end(opts.input);
    }
  });
}

/** Splits a concatenated MJPEG stream into individual JPEG files. */
export function splitJpegs(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = -1;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && start < 0) start = i;
    else if (buf[i] === 0xff && buf[i + 1] === 0xd9 && start >= 0) {
      out.push(buf.subarray(start, i + 2));
      start = -1;
      i++;
    }
  }
  return out;
}

export interface SampledFrame {
  t: number;
  jpeg: Buffer;
  width: number;
  height: number;
}

/**
 * Evenly sampled frames (at most `max`), always including the first and the last half-second, where
 * continuity with the neighbouring shots is decided.
 */
export async function sampleFrames(input: string, opts: { durationSec: number; fps: number; width: number; srcWidth: number | null; srcHeight: number | null; max?: number; flip?: boolean; from?: number; to?: number }): Promise<SampledFrame[]> {
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(opts.durationSec, opts.to ?? opts.durationSec);
  const span = Math.max(0.1, to - from);
  const max = opts.max ?? 24;
  const fps = Math.min(opts.fps, max / span);
  const vf = [`fps=${Math.round(fps * 1000) / 1000}`, `scale=${opts.width}:-2`, ...(opts.flip ? ['hflip'] : [])].join(',');
  const { stdout, code, stderr } = await ffmpeg(['-loglevel', 'error', '-ss', String(from), '-t', String(span), '-i', input, '-an', '-vf', vf, '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']);
  if (code !== 0 && !stdout.length) throw new Error(`frame sampling failed: ${stderr.split('\n').filter(Boolean).slice(-2).join(' | ')}`);
  const jpegs = splitJpegs(stdout);
  const height = opts.srcWidth && opts.srcHeight ? Math.round((opts.width * opts.srcHeight) / opts.srcWidth / 2) * 2 : Math.round((opts.width * 9) / 16);
  const frames = jpegs.map((jpeg, i) => ({ t: Math.round((from + (i + 0.5) / fps) * 1000) / 1000, jpeg, width: opts.width, height }));
  // The very last frame matters for the cut into the next shot.
  if (!opts.flip && to >= opts.durationSec - 0.05) {
    const last = await ffmpeg(['-loglevel', 'error', '-sseof', '-0.1', '-i', input, '-an', '-frames:v', '1', '-vf', `scale=${opts.width}:-2`, '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']);
    const lj = splitJpegs(last.stdout)[0];
    if (lj) frames.push({ t: Math.round(Math.max(0, opts.durationSec - 0.05) * 1000) / 1000, jpeg: lj, width: opts.width, height });
  }
  return frames;
}

/** Mirrors a JPEG horizontally. */
export async function flipJpeg(jpeg: Buffer): Promise<Buffer> {
  const { stdout } = await ffmpeg(['-loglevel', 'error', '-f', 'mjpeg', '-i', 'pipe:0', '-vf', 'hflip', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { input: jpeg });
  return splitJpegs(stdout)[0] ?? jpeg;
}

/** Crops a JPEG to a 0–1 box (for skin tone, screens and OCR of a region). */
export async function cropJpeg(jpeg: Buffer, box: { x: number; y: number; w: number; h: number }, scaleWidth = 0): Promise<Buffer> {
  const f = `crop=iw*${box.w.toFixed(4)}:ih*${box.h.toFixed(4)}:iw*${box.x.toFixed(4)}:ih*${box.y.toFixed(4)}${scaleWidth ? `,scale=${scaleWidth}:-2` : ''}`;
  const { stdout } = await ffmpeg(['-loglevel', 'error', '-f', 'mjpeg', '-i', 'pipe:0', '-vf', f, '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { input: jpeg });
  return splitJpegs(stdout)[0] ?? jpeg;
}

/** Mean RGB of a JPEG region (0–1 box). */
export async function regionMean(jpeg: Buffer, box: { x: number; y: number; w: number; h: number }): Promise<Rgb | null> {
  const f = `crop=iw*${Math.max(0.01, box.w).toFixed(4)}:ih*${Math.max(0.01, box.h).toFixed(4)}:iw*${box.x.toFixed(4)}:ih*${box.y.toFixed(4)},scale=32:32,format=rgb24`;
  const { stdout } = await ffmpeg(['-loglevel', 'error', '-f', 'mjpeg', '-i', 'pipe:0', '-vf', f, '-f', 'rawvideo', 'pipe:1'], { input: jpeg });
  if (stdout.length < 3) return null;
  const s = statsFromRgb(stdout);
  return s.mean;
}

/** RGB statistics of a video (sampled frames) or image. */
export async function rgbStats(input: string, opts: { isImage?: boolean; fps?: number; from?: number; to?: number } = {}): Promise<RgbStats | null> {
  const args = ['-loglevel', 'error'];
  if (!opts.isImage && opts.from !== undefined) args.push('-ss', String(opts.from));
  if (!opts.isImage && opts.to !== undefined && opts.from !== undefined) args.push('-t', String(Math.max(0.1, opts.to - opts.from)));
  args.push('-i', input, '-an', '-vf', `${opts.isImage ? '' : `fps=${opts.fps ?? 2},`}scale=96:-2,format=rgb24`, ...(opts.isImage ? ['-frames:v', '1'] : []), '-f', 'rawvideo', 'pipe:1');
  const { stdout } = await ffmpeg(args);
  if (stdout.length < 30) return null;
  return statsFromRgb(stdout);
}

/** Freezes, stutter, flicker, camera jumps and decode errors of a clip. */
export async function temporalMeasurements(input: string): Promise<TemporalMeasurements> {
  const [freeze, luma, decode, dec] = await Promise.all([
    ffmpeg(['-i', input, '-an', '-vf', 'freezedetect=n=-55dB:d=0.3', '-f', 'null', '-']),
    ffmpeg(['-loglevel', 'error', '-i', input, '-an', '-vf', "scale=160:-2,signalstats,select='gte(scene\\,0)',metadata=print:file=-", '-f', 'null', '-']),
    ffmpeg(['-v', 'error', '-i', input, '-f', 'null', '-']),
    ffmpeg(['-i', input, '-an', '-vf', 'mpdecimate=hi=768:lo=320:frac=0.33', '-f', 'null', '-']),
  ]);
  const frozen: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const line of freeze.stderr.split('\n')) {
    const s = /freeze_start:\s*([\d.]+)/.exec(line);
    const e = /freeze_end:\s*([\d.]+)/.exec(line);
    if (s) open = Number(s[1]);
    if (e && open !== null) {
      frozen.push({ start: open, end: Number(e[1]) });
      open = null;
    }
  }
  if (open !== null) {
    const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(freeze.stderr);
    const dur = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : open + 0.3;
    frozen.push({ start: open, end: dur });
  }
  const yavg: number[] = [];
  const scenes: { t: number; s: number }[] = [];
  let t = 0;
  for (const line of luma.stdout.toString().split('\n')) {
    const pt = /pts_time:([\d.]+)/.exec(line);
    if (pt) t = Number(pt[1]);
    const y = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line);
    if (y) yavg.push(Number(y[1]));
    const sc = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (sc) scenes.push({ t, s: Number(sc[1]) });
  }
  const jumps = scenes.filter((x) => x.s >= 0.22 && x.s < 0.45).map((x) => Math.round(x.t * 100) / 100);
  const total = /frame=\s*(\d+)/g;
  let decFrames = 0;
  for (const m of dec.stderr.matchAll(total)) decFrames = Number(m[1]);
  const frames = yavg.length;
  const repeatedRatio = frames > 0 && decFrames > 0 ? Math.max(0, Math.min(1, 1 - decFrames / frames)) : 0;
  const decodeErrors = decode.stderr.split('\n').filter((l) => /error|corrupt|invalid|concealing/i.test(l)).length;
  return { frozen, repeatedRatio: Math.round(repeatedRatio * 1000) / 1000, flickerIndex: flickerIndex(yavg), jumps: [...new Set(jumps)].slice(0, 12), decodeErrors, frames };
}

/** RGB statistics as the colour-continuity measure (mean colour, luma and skin tone). */
export function toColourStats(st: RgbStats | null, skin: Rgb | null = st?.skin ?? null): ColourStats | null {
  if (!st) return null;
  const [r, g, b] = st.mean;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return { r: r1(r), g: r1(g), b: r1(b), luma: r1(0.2126 * r + 0.7152 * g + 0.0722 * b), skin: skin ? { r: Math.round(skin[0]), g: Math.round(skin[1]), b: Math.round(skin[2]) } : null };
}

/** One JPEG frame of a video (at a time) or of an image. */
export async function jpegAt(input: string, atSec: number, width = 768): Promise<Buffer | null> {
  const { stdout } = await ffmpeg(['-loglevel', 'error', '-ss', String(Math.max(0, atSec)), '-i', input, '-an', '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']);
  return splitJpegs(stdout)[0] ?? null;
}
