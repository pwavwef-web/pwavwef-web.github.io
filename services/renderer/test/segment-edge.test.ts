import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeClip, makeTrack, type ClipMotion } from '@az-studio/shared';
import { buildSegment, type RenderSnapshot, type Segment } from '../src/graph';

/**
 * A still drawn by its own filter chain (camera move, held framing, Ken Burns) must cover every frame of its
 * span, including the last frame of a segment. The chains used to emit exactly round(span × fps) frames and then
 * end; the stream then ended on the timestamp of its last frame, the overlay (eof_action=pass) treated that frame
 * as already past the end, and the black base showed through — one black frame at every segment edge covered by
 * a still (seen at 89.583 s and 89.958 s in a 146 s music video). Video clips were unaffected: their source runs
 * past the span and `trim` closes the stream at the span's end.
 */

const require = createRequire(import.meta.url);
let FF: string | null = null;
try {
  FF = require('ffmpeg-static') as string;
} catch {
  FF = null;
}
const hasFfmpeg = Boolean(FF && existsSync(FF));
const work = mkdtempSync(path.join(os.tmpdir(), 'azs-segment-edge-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// The music video's geometry: 9:16 output, a 9:16-ish 2K still, a segment edge at 90 s.
const W = 180;
const H = 320;
const FPS = 24;
const SW = 1536;
const SH = 2752;

describe.skipIf(!hasFfmpeg)('segment edges over stills', () => {
  const ff = (args: string[]) => execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  /** Mean luma of every frame of a file, in order. */
  const frameLumas = (file: string) => {
    const buf = execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=9:16', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 * 1024 * 1024 });
    const out: number[] = [];
    for (let i = 0; i + 144 <= buf.length; i += 144) out.push(buf.subarray(i, i + 144).reduce((a, b) => a + b, 0) / 144);
    return out;
  };
  const img = path.join(work, 'grey.png');
  const picture = () => {
    // A bright, even picture: any frame where the black base shows through stands out.
    if (!existsSync(img)) ff(['-f', 'lavfi', '-i', `color=c=0xC8C8C8:s=${SW}x${SH}:d=1`, '-frames:v', '1', img]);
    return img;
  };

  const push: ClipMotion = { from: { x: 0, y: 0.003876, w: 1, h: 0.992248 }, to: { x: 0.03271, y: 0.036333, w: 0.934579, h: 0.927335 }, ease: 'gentle' };
  const hold: ClipMotion = { from: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 }, to: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 }, ease: 'linear' };
  const cases: [string, Partial<Parameters<typeof makeClip>[0]>][] = [
    ['a camera move', { motion: push }],
    ['a held framing', { motion: hold }],
    ['Ken Burns', { kenBurns: true }],
  ];

  for (const [name, look] of cases) {
    it(`fills the last frame of a segment with ${name}`, () => {
      const v1 = makeTrack('video', 'V1');
      const v2 = makeTrack('video', 'V2');
      // As in the music video: one still runs 0.5 s under the next, and both reach the segment edge.
      const a = makeClip({ trackId: v1.id, kind: 'image', start: 85.25, duration: 4.75, assetId: 'img', label: 'A', ...look });
      const b = makeClip({ trackId: v2.id, kind: 'image', start: 89.5, duration: 4.375, assetId: 'img', label: 'B', ...look });
      const snap: RenderSnapshot = {
        tracks: [v1, v2],
        clips: [a, b],
        fps: FPS,
        width: W,
        height: H,
        durationSec: 100,
        quality: 'draft',
        assets: { img: { kind: 'image', storagePath: 'img', width: SW, height: SH, durationSec: null, hasAudio: false } },
      };
      const segments: Segment[] = [
        { index: 0, start: 89, end: 90 }, // the edge falls on A's end and 0.5 s into B
        { index: 1, start: 86.5, end: 89.625 }, // the edge falls 0.125 s into B, mid-A
      ];
      for (const seg of segments) {
        const base = path.join(work, `${name.replace(/\W/g, '')}-seg${seg.index}`);
        const plan = buildSegment(snap, seg, { resolve: picture, filterScriptPath: `${base}.filter`, assPath: `${base}.ass`, fontsDir: work, outputPath: `${base}.mp4` });
        writeFileSync(`${base}.filter`, plan.filter);
        execFileSync(FF!, plan.args.map((x) => (x === 'pipe:1' ? '-' : x)), { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
        const lumas = frameLumas(`${base}.mp4`);
        expect(lumas.length).toBe(Math.round((seg.end - seg.start) * FPS));
        const dark = lumas.map((l, i) => [i, Math.round(l)] as const).filter(([, l]) => l < 120);
        expect(dark, `segment ${seg.start}–${seg.end}: frames darker than the picture`).toEqual([]);
      }
    }, 120_000);
  }
});
