import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AD_LOGO_BOX, AD_SCREEN_BOX, assembleAdTimeline, defaultAdSpec, sheetFromScript, type AdAssemblyScene } from '@az-studio/shared';
import { buildAudioMix, buildSegment, concatList, muxArgs, planSegments, type RenderSnapshot } from '../src/graph';

/**
 * A short advert assembled exactly as the Short Ads workspace does it (scenes cut on the narration, a product
 * screen boxed on the brand ground, a typography card, an end card with the logo, captions and a tagline),
 * rendered with real FFmpeg. Checks the picture where the composition matters and that the approved
 * soundtrack comes out at the level it went in.
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
const work = mkdtempSync(path.join(os.tmpdir(), 'azs-ad-render-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const W = 360;
const H = 640;
const D = 12;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Where a picture of the given size lands inside a layout box (the renderer's fitting rule). */
function fitted(box: { x: number; y: number; w: number; h: number }, aw: number, ah: number) {
  const bx = Math.round(box.x * W);
  const by = Math.round(box.y * H);
  const bw = Math.round(box.w * W);
  const bh = Math.round(box.h * H);
  const s = Math.min(bw / aw, bh / ah);
  const fw = Math.min(even(aw * s), bw - (bw % 2));
  const fh = Math.min(even(ah * s), bh - (bh % 2));
  return { x: bx + Math.round((bw - fw) / 2), y: by + Math.round((bh - fh) / 2), w: fw, h: fh };
}

describe.skipIf(!hasFfmpeg)('real FFmpeg render of a Short Ads timeline', () => {
  const ff = (args: string[]) => execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  /** Mean level (dBFS) of a file's audio, from volumedetect (reported on stderr). */
  const readMean = (file: string) => {
    const r = spawnSync(FF!, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
    if (!m) throw new Error(`no mean volume for ${file}`);
    return Number(m[1]);
  };
  const frameAt = (file: string, t: number) => {
    const buf = execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
    return (x: number, y: number) => {
      const i = (Math.round(y) * W + Math.round(x)) * 3;
      return [buf[i]!, buf[i + 1]!, buf[i + 2]!] as const;
    };
  };
  const near = (a: readonly number[], b: readonly number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

  it('boxes screens and the logo on the brand ground, composes text cards and keeps the soundtrack untouched', () => {
    const scene = path.join(work, 'scene.mp4');
    const screen = path.join(work, 'screen.png');
    const logo = path.join(work, 'logo.png');
    const soundtrack = path.join(work, 'soundtrack.m4a');
    // A generated scene carries its own (loud) sound, which must not reach the mix.
    ff(['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=24:duration=4`, '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', scene]);
    // A phone screenshot (tall) in a known colour, and a logo with a transparent surround.
    ff(['-f', 'lavfi', '-i', 'color=c=0xE07020:s=1080x2400:d=1', '-frames:v', '1', screen]);
    ff(['-f', 'lavfi', '-i', 'color=c=white:s=400x400:d=1', '-vf', "format=rgba,geq=r=255:g=255:b=255:a='if(lt(hypot(X-200,Y-200),150),255,0)'", '-frames:v', '1', logo]);
    ff(['-f', 'lavfi', '-i', `aevalsrc='0.1*sin(2*PI*330*t)|0.1*sin(2*PI*330*t)':s=48000:d=${D}`, '-c:a', 'aac', '-b:a', '256k', soundtrack]);

    const ad = defaultAdSpec('audio_first', '9:16');
    const brand = { ...ad.brand, logoAssetId: 'logo' };
    const sheet = sheetFromScript(['Starting with Kasem.', 'A language opens a door.', 'Keep the conversation going.', 'Discover Indigen World.'], D);
    const scenes: AdAssemblyScene[] = [
      { id: 's1', kind: 'generated_video', title: 'Moment', start: 0, end: 3, media: { assetId: 'scene', kind: 'video', durationSec: 4, width: W, height: H }, inPoint: 0, motion: 'push_in', onScreenText: '', subText: '', captions: true },
      { id: 's2', kind: 'product_screen', title: 'Learn', start: 3, end: 6.5, media: { assetId: 'screen', kind: 'image', durationSec: null, width: 1080, height: 2400 }, inPoint: 0, motion: 'push_in', onScreenText: '', subText: '', captions: true },
      { id: 's3', kind: 'typography', title: 'Line', start: 6.5, end: 9, media: null, inPoint: 0, motion: 'none', onScreenText: 'Keep the conversation going', subText: '', captions: false },
      { id: 's4', kind: 'end_card', title: 'End card', start: 9, end: D, media: null, inPoint: 0, motion: 'none', onScreenText: 'Discover Indigen World', subText: 'indigenworld.com', captions: true },
    ];
    const { state, issues } = assembleAdTimeline({ aspect: '9:16', fps: 24, durationSec: D, audio: { assetId: 'soundtrack', songId: 'song', label: 'Approved soundtrack' }, sheet, captions: true, brand, tagline: { text: 'Starting with Kasem', start: 0.5, end: 2.8 }, scenes });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);

    const snap: RenderSnapshot = {
      tracks: state.tracks,
      clips: state.clips,
      fps: 24,
      width: W,
      height: H,
      durationSec: D,
      quality: 'final',
      audioMaster: 'preserve',
      assets: {
        scene: { kind: 'video', storagePath: 'scene', width: W, height: H, durationSec: 4, hasAudio: true },
        screen: { kind: 'image', storagePath: 'screen', width: 1080, height: 2400, durationSec: null, hasAudio: false },
        logo: { kind: 'image', storagePath: 'logo', width: 400, height: 400, durationSec: null, hasAudio: false },
        soundtrack: { kind: 'audio', storagePath: 'soundtrack', width: null, height: null, durationSec: D, hasAudio: true },
      },
    };
    const files: Record<string, string> = { scene, screen, logo, soundtrack };
    const resolve = (id: string) => files[id]!;
    const segFiles: string[] = [];
    for (const seg of planSegments(snap, 6)) {
      const base = path.join(work, `seg${seg.index}`);
      const plan = buildSegment(snap, seg, { resolve, filterScriptPath: `${base}.filter`, assPath: `${base}.ass`, fontsDir: work, outputPath: `${base}.mp4`, aspect: '9:16' });
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
    const out = path.join(work, 'advert.mp4');
    execFileSync(FF!, muxArgs(joined, path.join(work, 'audio.m4a'), out, D, { title: 'advert' }), { stdio: 'pipe' });

    const probe = JSON.parse(execFileSync(FP!, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', out]).toString()) as {
      format: { duration: string };
      streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
    };
    const v = probe.streams.find((s) => s.codec_type === 'video')!;
    expect(v.codec_name).toBe('h264');
    expect([v.width, v.height]).toEqual([W, H]);
    expect(probe.streams.find((s) => s.codec_type === 'audio')!.codec_name).toBe('aac');
    expect(Math.abs(Number(probe.format.duration) - D)).toBeLessThan(0.1);

    const ground = [0x0f, 0x18, 0x30] as const;
    // Product screen: the whole screenshot inside its box, rounded corners showing the ground.
    const s = fitted(AD_SCREEN_BOX['9:16'], 1080, 2400);
    const atScreen = frameAt(out, 4.75);
    const [r, g, b] = atScreen(s.x + s.w / 2, s.y + s.h / 2);
    expect(r).toBeGreaterThan(190);
    expect(g).toBeGreaterThan(80);
    expect(g).toBeLessThan(150);
    expect(b).toBeLessThan(80);
    expect(atScreen(s.x + 1, s.y + 1)[0]).toBeLessThan(90);
    expect(near(atScreen(4, 4), ground, 16)).toBe(true);
    // Typography card: a plain brand ground behind composed text.
    expect(near(frameAt(out, 7.5)(4, 4), ground, 16)).toBe(true);
    // End card: the logo's transparent surround shows the ground; its disc is white.
    const l = fitted(AD_LOGO_BOX['9:16'], 400, 400);
    const atEnd = frameAt(out, 10.5);
    expect(atEnd(l.x + l.w / 2, l.y + l.h / 2).every((c) => c > 200)).toBe(true);
    expect(near(atEnd(l.x + 1, l.y + 1), ground, 20)).toBe(true);
    // The generated scene fills the frame (not the ground).
    expect(near(frameAt(out, 1.5)(W / 2, H / 2), ground, 16)).toBe(false);

    // The approved soundtrack comes out at the level it went in: no normalisation, limiting or scene sound.
    const before = readMean(soundtrack);
    const after = readMean(out);
    expect(Math.abs(after - before)).toBeLessThan(0.5);
    // …whereas the normal master would have changed it.
    const normal = buildAudioMix({ ...snap, audioMaster: 'normalize' }, resolve, path.join(work, 'normal.m4a'), path.join(work, 'normal.filter'));
    writeFileSync(path.join(work, 'normal.filter'), normal.filter);
    execFileSync(FF!, normal.args.map((a) => (a === 'pipe:1' ? '-' : a)), { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
    expect(Math.abs(readMean(path.join(work, 'normal.m4a')) - before)).toBeGreaterThan(2);
    if (process.env.AZS_KEEP_RENDER) execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-c', 'copy', process.env.AZS_KEEP_RENDER]);
  }, 240_000);
});
