import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { emptyTimeline, makeClip, type Clip } from '@az-studio/shared';
import { buildAss, buildAudioMix, buildSegment, concatList, filterPath, muxArgs, planSegments, preroll, type RenderSnapshot } from '../src/graph';

function snapshot(clips: Clip[], durationSec: number, extra: Partial<RenderSnapshot> = {}): RenderSnapshot {
  const tl = emptyTimeline('16:9', 24);
  return { tracks: tl.tracks, clips, fps: 24, width: 640, height: 360, durationSec, quality: 'draft', assets: {}, ...extra };
}

describe('segment planning', () => {
  it('splits long timelines at clip boundaries and never inside a transition', () => {
    const tl = emptyTimeline();
    const v = tl.tracks[0]!.id;
    const clips = Array.from({ length: 30 }, (_, i) =>
      makeClip({ trackId: v, kind: 'video', start: i * 8, duration: 8, assetId: 'a', transitionIn: i % 3 === 1 ? { type: 'dissolve', duration: 1 } : { type: 'cut', duration: 0 } }),
    );
    const segs = planSegments({ clips, durationSec: 240, fps: 24 }, 60);
    expect(segs[0]!.start).toBe(0);
    expect(segs[segs.length - 1]!.end).toBe(240);
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.start).toBe(segs[i - 1]!.end);
    for (const s of segs.slice(0, -1)) {
      expect(s.end - s.start).toBeLessThanOrEqual(60);
      for (const c of clips.filter((x) => x.transitionIn.type !== 'cut')) {
        expect(s.end <= c.start - preroll(c) - 1 || s.end >= c.start + 1).toBe(true);
      }
    }
  });

  it('returns a single segment for short timelines', () => {
    expect(planSegments({ clips: [], durationSec: 12, fps: 24 }, 90)).toEqual([{ index: 0, start: 0, end: 12 }]);
  });
});

describe('text rendering (ASS)', () => {
  it('positions and styles captions and titles', () => {
    const tl = emptyTimeline();
    const cap = tl.tracks.find((t) => t.kind === 'caption')!.id;
    const ov = tl.tracks.find((t) => t.kind === 'overlay')!.id;
    const clips = [
      makeClip({ trackId: cap, kind: 'caption', start: 1, duration: 2, text: 'Hello {world}\nline two', fadeIn: 0.25 }),
      makeClip({ trackId: ov, kind: 'title', start: 0, duration: 3, text: 'Indigen World', position: { anchor: 'top', offset: 0.1, align: 'left' } }),
    ];
    const ass = buildAss(snapshot(clips, 3, { tracks: tl.tracks }), { index: 0, start: 0, end: 3 })!;
    expect(ass).toContain('PlayResY: 360');
    expect(ass).toContain('Hello \\{world\\}\\Nline two');
    expect(ass).toContain('{\\fad(250,0)}');
    expect(ass).toMatch(/Style: s1,EB Garamond,32,.*,7,/);
    expect(ass).toMatch(/Dialogue: 0,0:00:01\.00,0:00:03\.00,s0/);
  });

  it('returns null when there is no text', () => {
    expect(buildAss(snapshot([], 3), { index: 0, start: 0, end: 3 })).toBeNull();
  });
});

describe('command builders', () => {
  it('escapes filter paths for both graph and option parsing', () => {
    expect(filterPath('C:\\tmp\\a b\\seg0.ass')).toBe("'C\\:/tmp/a b/seg0.ass'");
    expect(filterPath("/tmp/it's.ass")).toBe("'/tmp/it'\\''s.ass'");
  });

  it('builds concat lists and mux args', () => {
    expect(concatList(['/tmp/a.mp4', "/tmp/b'c.mp4"])).toBe("file '/tmp/a.mp4'\nfile '/tmp/b'\\''c.mp4'\n");
    const args = muxArgs('v.mp4', 'a.m4a', 'out.mp4', 12.5, { title: 'T' });
    expect(args).toContain('+faststart');
    expect(args.slice(args.indexOf('-metadata'), args.indexOf('-metadata') + 2)).toEqual(['-metadata', 'title=T']);
  });

  it('generates silence when nothing is audible', () => {
    const mix = buildAudioMix(snapshot([], 5), () => 'x', 'out.m4a', 'f.txt');
    expect(mix.args).toContain('anullsrc=r=48000:cl=stereo');
    expect(mix.filter).toBe('[0:a]atrim=duration=5[aout]');
  });
});

// ---------------------------------------------------------------------------
// Real FFmpeg end-to-end render (uses the ffmpeg-static binary from the workspace)
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
const work = mkdtempSync(path.join(os.tmpdir(), 'azs-render-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasFfmpeg)('real FFmpeg render', () => {
  it('renders transitions, stills, titles, captions and a music bed into a valid MP4', () => {
    const ff = (args: string[]) => execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });
    const video = path.join(work, 'clip.mp4');
    const still = path.join(work, 'still.png');
    const song = path.join(work, 'song.m4a');
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
    ff(['-f', 'lavfi', '-i', 'testsrc=size=1080x1080:rate=1:duration=1', '-frames:v', '1', still]);
    ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', '-c:a', 'aac', song]);

    const tl = emptyTimeline('16:9', 24);
    const [v1, , ov, cap, a1] = [tl.tracks[0]!, tl.tracks[1]!, tl.tracks[2]!, tl.tracks[3]!, tl.tracks[4]!];
    const clips: Clip[] = [
      makeClip({ trackId: v1.id, kind: 'video', start: 0, duration: 4, assetId: 'vid', sourceDuration: 4, useSourceAudio: true, volume: 0.5 }),
      makeClip({ trackId: v1.id, kind: 'image', start: 4, duration: 4, assetId: 'img', kenBurns: true, fit: 'fill', transitionIn: { type: 'dissolve', duration: 1 } }),
      makeClip({ trackId: v1.id, kind: 'video', start: 8, duration: 3, assetId: 'vid', inPoint: 0.5, sourceDuration: 4, fit: 'blur', transitionIn: { type: 'dip_white', duration: 0.6 }, fadeOut: 0.5 }),
      makeClip({ trackId: ov.id, kind: 'title', start: 0, duration: 2, text: 'AZ STUDIO', style: { font: 'Inter', sizePct: 10, color: '#FFFFFF', background: '#0B1220', bold: true, italic: false, uppercase: true, outline: 0, shadow: false }, fadeOut: 0.4 }),
      makeClip({ trackId: cap.id, kind: 'caption', start: 5, duration: 3, text: 'Lyric line — ɛ ɔ ŋ' }),
      makeClip({ trackId: a1.id, kind: 'audio', start: 0, duration: 11, assetId: 'song', sourceDuration: 12, fadeOut: 1 }),
    ];
    const snap = snapshot(clips, 11, {
      tracks: tl.tracks,
      assets: {
        vid: { kind: 'video', storagePath: 'vid', width: 1280, height: 720, durationSec: 4, hasAudio: true },
        img: { kind: 'image', storagePath: 'img', width: 1080, height: 1080, durationSec: null, hasAudio: false },
        song: { kind: 'audio', storagePath: 'song', width: null, height: null, durationSec: 12, hasAudio: true },
      },
    });
    const files: Record<string, string> = { vid: video, img: still, song };
    const resolve = (id: string) => files[id]!;
    const segs = planSegments(snap, 5);
    expect(segs.length).toBeGreaterThan(1);
    const segFiles: string[] = [];
    for (const seg of segs) {
      const base = path.join(work, `seg${seg.index}`);
      const plan = buildSegment(snap, seg, { resolve, filterScriptPath: `${base}.filter`, assPath: `${base}.ass`, fontsDir: work, outputPath: `${base}.mp4` });
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
    const out = path.join(work, 'final.mp4');
    execFileSync(FF!, muxArgs(joined, path.join(work, 'audio.m4a'), out, 11, { title: 'test' }), { stdio: 'pipe' });

    const probe = JSON.parse(execFileSync(FP!, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', out]).toString()) as {
      format: { duration: string };
      streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
    };
    const v = probe.streams.find((s) => s.codec_type === 'video')!;
    const a = probe.streams.find((s) => s.codec_type === 'audio')!;
    expect(v.codec_name).toBe('h264');
    expect([v.width, v.height]).toEqual([640, 360]);
    expect(a.codec_name).toBe('aac');
    expect(Math.abs(Number(probe.format.duration) - 11)).toBeLessThan(0.15);
    if (process.env.AZS_KEEP_RENDER) execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-c', 'copy', process.env.AZS_KEEP_RENDER]);
  }, 180_000);
});
