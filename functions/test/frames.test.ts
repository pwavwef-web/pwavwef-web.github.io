import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { jpegSize } from '../src/lib/frames';
import { FFMPEG } from '../src/lib/media';

const jpeg = (w: number, h: number) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=red:s=${w}x${h}:d=0.1`, '-frames:v', '1', '-f', 'mjpeg', 'pipe:1']);

describe('jpegSize', () => {
  it('reads portrait and landscape frames from the JPEG header', () => {
    expect(jpegSize(jpeg(720, 1280))).toEqual({ width: 720, height: 1280 });
    expect(jpegSize(jpeg(1280, 720))).toEqual({ width: 1280, height: 720 });
  });

  it('returns null for data that is not a JPEG', () => {
    expect(jpegSize(Buffer.from('not a jpeg at all'))).toBeNull();
  });
});
