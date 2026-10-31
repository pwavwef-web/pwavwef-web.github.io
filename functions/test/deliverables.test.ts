import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { checkPackVideo, packCaptions, packReadme, packSlug } from '@az-studio/shared';
import { writeStoredZip } from '../src/lib/zip';

/** Reads a stored ZIP back from its central directory and checks every entry's CRC and bytes. */
function readZip(buf: Buffer): { name: string; data: Buffer }[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    expect(crc32(data) >>> 0).toBe(crc);
    out.push({ name, data });
    p += 46 + nameLen;
  }
  return out;
}

const dirs: string[] = [];
afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

describe('deliverables pack', () => {
  it('zips files byte for byte', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'azs-zip-'));
    dirs.push(dir);
    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    await writeFile(path.join(dir, 'a.mp4'), big);
    await writeFile(path.join(dir, 'README.txt'), 'Hello — pack');
    const bytes = await writeStoredZip([{ name: 'pack/README.txt', path: path.join(dir, 'README.txt') }, { name: 'pack/a.mp4', path: path.join(dir, 'a.mp4') }], path.join(dir, 'out.zip'));
    const zip = await readFile(path.join(dir, 'out.zip'));
    expect(zip.length).toBe(bytes);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['pack/README.txt', 'pack/a.mp4']);
    expect(entries[0]!.data.toString('utf8')).toBe('Hello — pack');
    expect(entries[1]!.data.equals(big)).toBe(true);
  });

  it('builds captions from caption clips only, merging repeats', () => {
    const cues = packCaptions([
      { kind: 'caption', start: 2, duration: 1, text: 'Second' },
      { kind: 'caption', start: 0, duration: 1, text: 'First' },
      { kind: 'caption', start: 1, duration: 0.5, text: 'First' },
      { kind: 'video', start: 0, duration: 5, text: '' },
      { kind: 'caption', start: 4, duration: 1, text: '   ' },
    ] as never);
    expect(cues).toEqual([
      { start: 0, end: 1.5, text: 'First' },
      { start: 2, end: 3, text: 'Second' },
    ]);
  });

  it('flags a short file, missing sound and loudness off target', () => {
    expect(checkPackVideo({ durationSec: 33, frames: 990, hasAudio: true, lufs: -14.2, truePeakDb: -1.6 }, { durationSec: 33, fps: 30, audioMaster: 'normalize' })).toEqual([]);
    const lost = checkPackVideo({ durationSec: 32.5, frames: 975, hasAudio: true, lufs: -14, truePeakDb: -1.5 }, { durationSec: 33, fps: 30, audioMaster: 'normalize' });
    expect(lost.join(' ')).toMatch(/975 frames instead of 990 \(0\.50 s short\)/);
    expect(checkPackVideo({ durationSec: 33, frames: 990, hasAudio: false, lufs: null, truePeakDb: null }, { durationSec: 33, fps: 30, audioMaster: 'preserve' })).toEqual(['The file has no sound.']);
    expect(checkPackVideo({ durationSec: 33, frames: 990, hasAudio: true, lufs: -9, truePeakDb: 0.2 }, { durationSec: 33, fps: 30, audioMaster: 'normalize' })).toHaveLength(2);
    expect(checkPackVideo({ durationSec: 33, frames: 990, hasAudio: true, lufs: -9, truePeakDb: 0.2 }, { durationSec: 33, fps: 30, audioMaster: 'preserve' })).toEqual([]);
  });

  it('names files safely and writes a read-me', () => {
    expect(packSlug('Bright Consult — Passport “Regular” v3')).toBe('bright-consult-passport-regular-v3');
    const readme = packReadme({ title: 'Passport advert', projectTitle: 'Bright Consult', createdAt: Date.UTC(2026, 9, 31), files: [{ name: 'a.mp4', kind: 'video', bytes: 1, width: 1080, height: 1920, durationSec: 33, frames: 990, lufs: -14, truePeakDb: -1.5, issues: [] }], captions: 12 });
    expect(readme).toContain('a.mp4 — 1080×1920, 33.00 s, 990 frames, -14.0 LUFS, peak -1.5 dBTP');
    expect(readme).toContain('Captions: 12 cues');
  });
});
