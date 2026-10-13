import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assembleLiteTimeline, buildLiteScore, clipMotionProgress, computeLiteTiming, defaultLiteSpec, motionRectAt, newScene, newShot, type LiteNarrationTake } from '@az-studio/shared';
import { buildAudioMix, buildSegment, concatList, muxArgs, planSegments, type RenderSnapshot } from '../src/graph';

/**
 * A small Film Studio Lite film assembled exactly as the workspace does it and rendered with real FFmpeg.
 * The source image is a colour ramp (red = x, green = y), so every output pixel says which source point it
 * shows: the rendered frames are compared with the shared `motionRectAt` path the browser preview draws —
 * the same framing at the same time, never beyond the image edge. Also checks deliberate black, burned-in
 * subtitles and that music is measurably ducked under the narration.
 */

const require = createRequire(import.meta.url);
let FF: string | null = null;
let FP: string | null = null;
try {
  FF = require('ffmpeg-static') as string;
  FP = (require('ffprobe-static') as { path: string }).path;
} catch {
  FF = null;
}
const hasFfmpeg = Boolean(FF && existsSync(FF) && FP && existsSync(FP));
const work = mkdtempSync(path.join(os.tmpdir(), 'azs-lite-render-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const W = 640;
const H = 360;
const SW = 1376;
const SH = 768;

describe.skipIf(!hasFfmpeg)('real FFmpeg render of a Film Studio Lite timeline', () => {
  const ff = (args: string[]) => execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  const frameAt = (file: string, t: number) => {
    const buf = execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
    return (x: number, y: number) => {
      const i = (Math.round(y) * W + Math.round(x)) * 3;
      return [buf[i]!, buf[i + 1]!, buf[i + 2]!] as const;
    };
  };
  /** Mean level (dBFS) of a band around `hz` within [from, from + dur]. */
  const bandLevel = (file: string, hz: number, from: number, dur: number) => {
    const r = spawnSync(FF!, ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(dur), '-i', file, '-vn', '-af', `bandpass=f=${hz}:width_type=q:w=30,volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
    if (!m) throw new Error('no level');
    return Number(m[1]);
  };

  it('renders the approved framing, timing and mix', () => {
    const ramp = path.join(work, 'ramp.png');
    // Red follows x, green follows y, blue constant: a pixel's colour locates it in the source.
    ff(['-f', 'lavfi', '-i', `color=c=black:s=${SW}x${SH}:d=1`, '-vf', `format=rgb24,geq=r='X/W*255':g='Y/H*255':b='96'`, '-frames:v', '1', ramp]);
    const voiceA = path.join(work, 'voiceA.wav');
    const voiceB = path.join(work, 'voiceB.wav');
    const music = path.join(work, 'music.wav');
    // "Narration": 3 s of a 300 Hz tone after 0.3 s of silence, then 0.5 s of silence.
    for (const f of [voiceA, voiceB]) ff(['-f', 'lavfi', '-i', "aevalsrc='if(between(t,0.3,3.3),0.3*sin(2*PI*300*t),0)':s=48000:d=3.8", f]);
    ff(['-f', 'lavfi', '-i', "aevalsrc='0.2*sin(2*PI*3000*t)':s=48000:d=40", music]);

    const spec = defaultLiteSpec({ direction: 'documentary', aspect: '16:9', targetSec: 60 });
    spec.setup.look = { grain: 0, vignette: 0, haze: 0, warmth: 0, seed: 1 };
    spec.subtitles = { ...spec.subtitles, contrast: 'box' };
    spec.sound.endHoldSec = 3;
    spec.scenes = [
      newScene({ id: 'a', title: 'One', narration: 'One two three four five six.', leadInSec: 1.2, tailSec: 1.6, shots: [newShot({ id: 'a1', durationSec: 4, motion: { preset: 'push_in', intensity: 0.08, focal: { x: 0.7, y: 0.4 }, ease: 'gentle' } }), newShot({ id: 'a2', durationSec: 3, transitionIn: 'dissolve', motion: { preset: 'pan_right', intensity: 0.1, focal: { x: 0.5, y: 0.5 }, ease: 'linear' } })] }),
      newScene({ id: 'b', title: 'Two', narration: 'Seven eight nine ten.', pauseBeforeSec: 1, pauseBlack: true, leadInSec: 1.2, tailSec: 1.6, shots: [newShot({ id: 'b1', durationSec: 5, motion: { preset: 'still', intensity: 0.05, focal: { x: 0.3, y: 0.6 }, ease: 'gentle' } })] }),
    ];
    for (const s of spec.scenes) for (const sh of s.shots) sh.image.approvedAssetId = 'ramp';
    const take = (sceneId: string, assetId: string, text: string): LiteNarrationTake => {
      const ws = text.split(' ');
      return { jobId: `j${sceneId}`, sceneId, hash: 'h', assetId, inPoint: 0, outPoint: 3.8, speechStart: 0.3, speechEnd: 3.3, words: ws.map((w, i) => ({ text: w, start: 0.3 + (3 * i) / ws.length, end: 0.3 + (3 * (i + 0.85)) / ws.length, confidence: 0.95 })), alignment: 'aligned', coverage: 1, flags: [], source: 'generated', voice: 'Sulafat', createdAt: 1 };
    };
    const takes = { a: take('a', 'voiceA', spec.scenes[0]!.narration), b: take('b', 'voiceB', spec.scenes[1]!.narration) };
    const timing = computeLiteTiming(spec, takes);
    const score = buildLiteScore(spec, timing, null, 'Test');
    score.movements = score.movements.map((m) => ({ ...m, status: 'ready', assetId: 'music', durationSec: 40 }));
    const assets = { ramp: { width: SW, height: SH, durationSec: null }, voiceA: { width: null, height: null, durationSec: 3.8 }, voiceB: { width: null, height: null, durationSec: 3.8 }, music: { width: null, height: null, durationSec: 40 } };
    const { state, issues, durationSec: D, speech } = assembleLiteTimeline({ spec, timing, takes, assets, aspect: '16:9', outWidth: W, score, ambience: {} });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);

    const snap: RenderSnapshot = {
      tracks: state.tracks,
      clips: state.clips,
      fps: 24,
      width: W,
      height: H,
      durationSec: D,
      quality: 'draft',
      assets: {
        ramp: { kind: 'image', storagePath: 'ramp', width: SW, height: SH, durationSec: null, hasAudio: false },
        voiceA: { kind: 'audio', storagePath: 'voiceA', width: null, height: null, durationSec: 3.8, hasAudio: true },
        voiceB: { kind: 'audio', storagePath: 'voiceB', width: null, height: null, durationSec: 3.8, hasAudio: true },
        music: { kind: 'audio', storagePath: 'music', width: null, height: null, durationSec: 40, hasAudio: true },
      },
    };
    const files: Record<string, string> = { ramp, voiceA, voiceB, music };
    const resolve = (id: string) => files[id]!;
    const segFiles: string[] = [];
    // Short segments: a camera move continues correctly across segment boundaries.
    for (const seg of planSegments(snap, 5)) {
      const base = path.join(work, `seg${seg.index}`);
      const plan = buildSegment(snap, seg, { resolve, filterScriptPath: `${base}.filter`, assPath: `${base}.ass`, fontsDir: work, outputPath: `${base}.mp4`, aspect: '16:9' });
      writeFileSync(`${base}.filter`, plan.filter);
      if (plan.ass) writeFileSync(`${base}.ass`, plan.ass);
      execFileSync(FF!, plan.args.map((a) => (a === 'pipe:1' ? '-' : a)), { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
      segFiles.push(`${base}.mp4`);
    }
    const list = path.join(work, 'list.txt');
    writeFileSync(list, concatList(segFiles.map((f) => f.replace(/\\/g, '/'))));
    const joined = path.join(work, 'video.mp4');
    ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
    const mix = buildAudioMix(snap, resolve, path.join(work, 'audio.m4a'), path.join(work, 'audio.filter'));
    writeFileSync(path.join(work, 'audio.filter'), mix.filter);
    execFileSync(FF!, mix.args.map((a) => (a === 'pipe:1' ? '-' : a)), { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
    const out = path.join(work, 'lite.mp4');
    execFileSync(FF!, muxArgs(joined, path.join(work, 'audio.m4a'), out, D, { title: 'lite' }), { stdio: 'pipe' });

    const probe = JSON.parse(execFileSync(FP!, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', out]).toString()) as { format: { duration: string }; streams: { codec_type: string; codec_name: string; width?: number; height?: number }[] };
    expect(probe.streams.find((s) => s.codec_type === 'video')!.codec_name).toBe('h264');
    expect(probe.streams.find((s) => s.codec_type === 'audio')!.codec_name).toBe('aac');
    expect(Math.abs(Number(probe.format.duration) - D)).toBeLessThan(0.1);

    // Framing: at several instants of each moving shot, output pixels show the source point the shared
    // motion path says they should (within compression tolerance) — preview and export agree, edges never show.
    const pics = state.clips.filter((c) => c.kind === 'image');
    for (const c of pics) {
      for (const f of [0.15, 0.35, 0.5, 0.7, 0.85]) {
        const t = c.start + f * c.duration;
        if (pics.some((o) => o !== c && t >= o.start - 1.3 && t <= o.start + 0.1)) continue; // skip dissolves
        if (t < c.start + c.fadeIn + 0.1 || t > c.start + c.duration - c.fadeOut - 0.1) continue; // and fades from/to black
        const rect = motionRectAt(c.motion!, clipMotionProgress(c, t));
        const px = frameAt(out, t);
        for (const [ox, oy] of [[0.08, 0.1], [0.92, 0.1], [0.5, 0.4], [0.1, 0.62], [0.9, 0.62]] as const) {
          const [r, g] = px(ox * (W - 1), oy * (H - 1));
          const expR = (rect.x + ox * rect.w) * 255;
          const expG = (rect.y + oy * rect.h) * 255;
          expect(Math.abs(r - expR), `${c.label} red at ${t.toFixed(2)}s (${ox},${oy})`).toBeLessThan(9);
          expect(Math.abs(g - expG), `${c.label} green at ${t.toFixed(2)}s (${ox},${oy})`).toBeLessThan(9);
        }
      }
    }
    // Deliberate black between the scenes.
    const black = state.clips.find((c) => c.intentional === 'black')!;
    const bk = frameAt(out, black.start + black.duration / 2)(W / 2, H / 2);
    expect(Math.max(...bk)).toBeLessThan(24);
    // A burned-in subtitle box darkens the bottom of the frame while a line is spoken.
    const sub = state.clips.find((c) => c.kind === 'caption')!;
    const atSub = frameAt(out, sub.start + sub.duration / 2);
    const noSub = frameAt(out, black.start - 0.5);
    expect(atSub(W / 2, H * (1 - 0.07) - 8)[1]).toBeLessThan(noSub(W / 2, H * (1 - 0.07) - 8)[1] - 30);

    // Music (3 kHz) is quieter while the narration plays than in the pause after it.
    const s0 = speech[0]!;
    const under = bandLevel(out, 3000, s0.start + 0.6, Math.max(0.5, s0.end - s0.start - 1));
    const open = bandLevel(out, 3000, black.start + 0.1, 0.6);
    // Duck depth is 9 dB (attack/release ramps excluded from the windows).
    expect(open - under).toBeGreaterThan(7.5);
    expect(open - under).toBeLessThan(10.5);
    if (process.env.AZS_KEEP_RENDER) execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-c', 'copy', process.env.AZS_KEEP_RENDER]);
  }, 300_000);
});
