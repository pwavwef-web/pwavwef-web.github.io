import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRangeServer, parseRange, type RangeSource } from '../src/lib/media-proxy';
import { FFMPEG, audioPeaks, probe, videoFrame } from '../src/lib/media';

const memorySource = (buf: Buffer, contentType: string): RangeSource => ({
  size: buf.length,
  contentType,
  open: (start, end) => Readable.from([buf.subarray(start, end + 1)]),
});

describe('range parsing', () => {
  it('handles open, closed, suffix and unsatisfiable ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual([0, 99]);
    expect(parseRange('bytes=10-19', 100)).toEqual([10, 19]);
    expect(parseRange('bytes=90-500', 100)).toEqual([90, 99]);
    expect(parseRange('bytes=-10', 100)).toEqual([90, 99]);
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
  });
});

describe('loopback media proxy', () => {
  const server = createRangeServer();
  let dir = '';
  let mp4 = Buffer.alloc(0);

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'azs-proxy-'));
    const file = path.join(dir, 'clip.mp4');
    // The mp4 muxer writes the moov atom last by default, like camera footage, so probing has to seek.
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
    mp4 = readFileSync(file);
  }, 60_000);

  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves byte ranges on a loopback address and rejects unknown tokens', async () => {
    const url = await server.register(memorySource(mp4, 'video/mp4'), 'clip.mp4');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/clip\.mp4$/);
    const part = await fetch(url, { headers: { Range: 'bytes=4-11' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 4-11/${mp4.length}`);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(mp4.subarray(4, 12));
    const head = await fetch(url, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe(String(mp4.length));
    expect(head.headers.get('accept-ranges')).toBe('bytes');
    expect((await fetch(url.replace(/\/[0-9a-f]{32}\//, `/${'0'.repeat(32)}/`))).status).toBe(404);
  });

  it('lets ffprobe and ffmpeg seek a moov-at-end MP4 through the proxy', async () => {
    expect(mp4.indexOf('moov')).toBeGreaterThan(mp4.indexOf('mdat'));
    const url = await server.register(memorySource(mp4, 'video/mp4'), 'clip.mp4');
    const info = await probe(url);
    expect(info).toMatchObject({ hasVideo: true, hasAudio: true, width: 320, height: 180 });
    expect(info.durationSec).toBeGreaterThan(1.9);
    const frame = path.join(dir, 'frame.jpg');
    await videoFrame(url, frame, 1, 160);
    expect(statSync(frame).size).toBeGreaterThan(500);
    const peaks = await audioPeaks(url, 64);
    expect(peaks.max).toHaveLength(64);
    expect(Math.max(...peaks.max)).toBeGreaterThan(0.1);
  }, 60_000);
});
