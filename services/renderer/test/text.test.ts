import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cropSize, emptyTimeline, LYRIC_PRESET_STYLES, makeClip, sceneEvents, sceneToAss, type Clip, type RenderTextInputs, type ReframeTrack } from '@az-studio/shared';
import { FontBook } from '../src/fonts';
import { buildSegment, reframeChain, type RenderSnapshot } from '../src/graph';
import { blurRegions, boxToOutput, buildTextScene } from '../src/text';

const reframe: ReframeTrack = { aspect: '9:16', crop: cropSize(16 / 9, 9 / 16), keyframes: [{ t: 0, cx: 0.3, cy: 0.5 }, { t: 4, cx: 0.7, cy: 0.5 }], analysedAt: 1, cutHeads: [] };

function vertical(clips: Clip[], extra: Partial<RenderSnapshot> = {}): RenderSnapshot {
  const tl = emptyTimeline('9:16', 24);
  return { tracks: tl.tracks, clips, fps: 24, width: 360, height: 640, durationSec: 4, quality: 'draft', assets: { vid: { kind: 'video', storagePath: 'vid', width: 1280, height: 720, durationSec: 4, hasAudio: false } }, ...extra };
}

function inputs(extra: Partial<RenderTextInputs> = {}): RenderTextInputs {
  const style = { ...LYRIC_PRESET_STYLES.lower_third, backgroundBlur: 14 };
  return { aspect: '9:16', lyricStyles: { s1: { style: { global: style, sections: {}, fonts: [] }, placements: {} } }, sections: { s1: { l1: 'chorus' } }, translations: {}, credits: {}, fonts: [], faces: {}, ...extra };
}

describe('face-safe reframing in the render graph', () => {
  it('maps source face boxes into the output frame through a centre crop and a reframe path', () => {
    const tl = emptyTimeline('9:16', 24);
    const clip = makeClip({ trackId: tl.tracks[0]!.id, kind: 'video', start: 0, duration: 4, assetId: 'vid', fit: 'fill' });
    const centred = boxToOutput({ x: 0.45, y: 0.4, w: 0.1, h: 0.2 }, clip, { w: 1280, h: 720 }, { w: 360, h: 640 }, '9:16', 1)!;
    expect(centred.x).toBeGreaterThan(0.2);
    expect(centred.x + centred.w).toBeLessThan(0.8);
    // With the path at cx = 0.3 (t = 0), a face at the left third lands in the middle of the vertical frame.
    const tracked = boxToOutput({ x: 0.25, y: 0.4, w: 0.1, h: 0.2 }, { ...clip, reframe: { '9:16': reframe } }, { w: 1280, h: 720 }, { w: 360, h: 640 }, '9:16', 0)!;
    expect(tracked.x + tracked.w / 2).toBeCloseTo(0.5, 1);
    expect(boxToOutput({ x: 0.9, y: 0.4, w: 0.05, h: 0.1 }, { ...clip, reframe: { '9:16': reframe } }, { w: 1280, h: 720 }, { w: 360, h: 640 }, '9:16', 0)).toBeNull();
  });

  it('builds a time-varying crop aligned to clip-local time', () => {
    const tl = emptyTimeline('9:16', 24);
    const clip = makeClip({ trackId: tl.tracks[0]!.id, kind: 'video', start: 0, duration: 4, assetId: 'vid', inPoint: 1, reframe: { '9:16': reframe } });
    expect(reframeChain(clip, '16:9', { w: 1280, h: 720 }, 360, 640, 0, 'a', 'b')).toBeNull();
    const chain = reframeChain(clip, '9:16', { w: 1280, h: 720 }, 360, 640, 0.5, 'a', 'b')!;
    expect(chain).toMatch(/^\[a\]crop=w=404:h=720:x='.*\(t\+0\.5\).*':y='.*',scale=360:640,setsar=1,format=yuva420p\[b\]$/);
  });
});

describe('text engine', () => {
  it('lays out styled lyrics, keeps them clear of faces and reports what it handled', async () => {
    const tl = emptyTimeline('9:16', 24);
    const v = tl.tracks[0]!.id;
    const cap = tl.tracks.find((t) => t.kind === 'caption')!.id;
    const lyric = makeClip({ trackId: cap, kind: 'caption', start: 0.5, duration: 3, text: 'Wɔ yɛ adwuma', lyric: { songId: 's1', lineId: 'l1', mode: 'karaoke' }, karaoke: [{ text: 'Wɔ', start: 0, end: 0.6 }, { text: 'yɛ', start: 0.6, end: 1.2 }, { text: 'adwuma', start: 1.2, end: 2.6 }] });
    const plain = makeClip({ trackId: cap, kind: 'caption', start: 0, duration: 1, text: 'Plain caption' });
    const video = makeClip({ trackId: v, kind: 'video', start: 0, duration: 4, assetId: 'vid', fit: 'fill' });
    const snap = vertical([video, lyric, plain], { tracks: tl.tracks });
    // A face exactly where the lower third would sit (bottom-left of the vertical frame, in source terms).
    const face = { x: 0.36, y: 0.72, w: 0.08, h: 0.2 };
    const res = await buildTextScene(snap, inputs({ faces: { vid: [{ t: 1, boxes: [face] }, { t: 2, boxes: [face] }] } }), new FontBook(), new Map());
    expect(res.handled.has(lyric.id)).toBe(true);
    expect(res.handled.has(plain.id)).toBe(false);
    expect(res.scene?.blocks.length).toBeGreaterThan(0);
    const block = res.scene!.blocks[0]!;
    expect(block.start).toBeCloseTo(0.5, 2);
    // The lower third moved away from the face (or reports that it covers it).
    const faceOut = boxToOutput(face, video, { w: 1280, h: 720 }, { w: 360, h: 640 }, '9:16', 1)!;
    const b = block.bounds;
    const overlaps = b.x / 360 < faceOut.x + faceOut.w && (b.x + b.w) / 360 > faceOut.x && b.y / 640 < faceOut.y + faceOut.h && (b.y + b.h) / 640 > faceOut.y;
    expect(!overlaps || res.issues.some((i) => i.kind === 'covers_face')).toBe(true);
    expect(blurRegions(res.scene, { start: 0, end: 4 }).length).toBe(1);
    const ass = sceneToAss(res.scene!, { window: { start: 0, end: 4 } });
    expect(ass).toContain('Wɔ');
  });

  it('honours a locked per-line placement', async () => {
    const tl = emptyTimeline('9:16', 24);
    const cap = tl.tracks.find((t) => t.kind === 'caption')!.id;
    const lyric = makeClip({ trackId: cap, kind: 'caption', start: 0, duration: 2, text: 'Top line', lyric: { songId: 's1', lineId: 'l1', mode: 'line' } });
    const res = await buildTextScene(vertical([lyric], { tracks: tl.tracks }), inputs({ lyricStyles: { s1: { style: { global: LYRIC_PRESET_STYLES.lower_third, sections: {}, fonts: [] }, placements: { l1: { x: 0.5, y: 0.2, locked: true } } } } }), new FontBook(), new Map());
    const b = res.scene!.blocks[0]!.bounds;
    expect((b.y + b.h / 2) / 640).toBeLessThan(0.35);
  });
});

// ---------------------------------------------------------------------------
// Real FFmpeg: vertical export with a moving reframe, a styled lyric in absolute time and a blur region
// ---------------------------------------------------------------------------

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
const work = mkdtempSync(path.join(os.tmpdir(), 'azs-text-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasFfmpeg)('real FFmpeg text and reframe render', () => {
  it('renders the reframed picture with the lyric scene and blur region on time', async () => {
    const ff = (args: string[]) => execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
    const src = path.join(work, 'src.mp4');
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
    const tl = emptyTimeline('9:16', 24);
    const cap = tl.tracks.find((t) => t.kind === 'caption')!.id;
    const video = makeClip({ trackId: tl.tracks[0]!.id, kind: 'video', start: 0, duration: 4, assetId: 'vid', sourceDuration: 4, fit: 'fill', reframe: { '9:16': reframe } });
    const lyric = makeClip({ trackId: cap, kind: 'caption', start: 2.2, duration: 1.6, text: 'ON TIME', lyric: { songId: 's1', lineId: 'l1', mode: 'line' } });
    const snap = vertical([video, lyric], { tracks: tl.tracks });
    const book = new FontBook();
    const text = await buildTextScene(snap, inputs(), book, new Map());
    // Two segments: the second starts mid-way, so the scene's absolute times must survive the shift.
    const segs = [{ index: 0, start: 0, end: 2 }, { index: 1, start: 2, end: 4 }];
    const render = (withText: boolean) =>
      segs.map((seg) => {
        const base = path.join(work, `${withText ? 't' : 'n'}${seg.index}`);
        const window = { start: seg.start, end: seg.end };
        const sceneAss = withText && text.scene && sceneEvents(text.scene, { window }).length ? sceneToAss(text.scene, { fontScale: book.fontScale, window }) : null;
        const plan = buildSegment(snap, seg, { resolve: () => src, filterScriptPath: `${base}.filter`, assPath: `${base}.ass`, fontsDir: work, outputPath: `${base}.mp4`, aspect: '9:16', sceneAss, sceneAssPath: `${base}.scene.ass`, handledText: text.handled, blurs: withText ? blurRegions(text.scene, window) : [] });
        writeFileSync(`${base}.filter`, plan.filter);
        if (plan.ass) writeFileSync(`${base}.ass`, plan.ass);
        if (sceneAss) writeFileSync(`${base}.scene.ass`, sceneAss);
        execFileSync(FF!, plan.args.map((a) => (a === 'pipe:1' ? '-' : a)), { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
        return `${base}.mp4`;
      });
    const withText = render(true);
    const without = render(false);
    const probe = JSON.parse(execFileSync(FP!, ['-v', 'error', '-print_format', 'json', '-show_streams', withText[1]!]).toString()) as { streams: { width?: number; height?: number }[] };
    expect([probe.streams[0]!.width, probe.streams[0]!.height]).toEqual([360, 640]);
    // Mean absolute difference between the two renders, first segment vs second (the lyric is only in the second).
    const frame = (file: string, t: number) => execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 * 1024 * 1024 });
    const diff = (a: Buffer, b: Buffer) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;
    expect(diff(frame(withText[0]!, 1), frame(without[0]!, 1))).toBeLessThan(0.5);
    expect(diff(frame(withText[1]!, 0.8), frame(without[1]!, 0.8))).toBeGreaterThan(1);
  }, 180_000);
});
