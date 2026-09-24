import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { emptyTimeline, makeClip, type Clip } from '@az-studio/shared';
import { automationExpr, buildAss, buildAudioMix, duckRatio, karaokeText, type RenderSnapshot } from '../src/graph';

function snapshot(clips: Clip[], durationSec: number, extra: Partial<RenderSnapshot> = {}): RenderSnapshot {
  const tl = emptyTimeline('16:9', 24);
  return { tracks: tl.tracks, clips, fps: 24, width: 640, height: 360, durationSec, quality: 'draft', assets: {}, ...extra };
}

describe('lyric highlighting (ASS karaoke)', () => {
  it('sweeps words with \\kf, keeps gaps, and escapes text', () => {
    const text = karaokeText(
      [
        { text: 'Carry', start: 0.2, end: 0.6 },
        { text: 'me', start: 0.6, end: 0.9 },
        { text: '{home}', start: 1.2, end: 2 },
      ],
      'sweep',
      false,
    );
    expect(text).toBe('{\\k20}{\\kf40}Carry {\\kf30}me {\\k30}{\\kf80}\\{home\\}');
    expect(karaokeText([{ text: 'Carry me home,', start: 0, end: 1.4 }], 'instant', true)).toBe('{\\k140}CARRY ME HOME,');
  });

  it('writes karaoke captions with the highlight colour and moves lyrics up in vertical exports', () => {
    const tl = emptyTimeline();
    const cap = tl.tracks.find((t) => t.kind === 'caption')!.id;
    const clip = makeClip({
      trackId: cap,
      kind: 'caption',
      start: 1,
      duration: 3,
      text: 'Carry me home',
      style: { font: 'Inter', sizePct: 5, color: '#FFFFFF', background: null, bold: true, italic: false, uppercase: false, outline: 2, shadow: true, highlight: '#F4B84A' },
      lyric: { songId: 's', lineId: 'l1', mode: 'karaoke' },
      karaoke: [
        { text: 'Carry', start: 0, end: 0.5 },
        { text: 'me', start: 0.5, end: 0.8 },
        { text: 'home', start: 0.8, end: 1.6 },
      ],
    });
    const land = buildAss(snapshot([clip], 5, { tracks: tl.tracks }), { index: 0, start: 0, end: 5 })!;
    expect(land).toContain('{\\kf50}Carry {\\kf30}me {\\kf80}home');
    // Primary (sung) = highlight #F4B84A → &H004AB8F4 ; Secondary (unsung) = white.
    expect(land).toMatch(/Style: s0,Inter,18,&H004AB8F4,&H00FFFFFF,/);
    // A segment that starts mid-caption shifts the highlight so it stays on the vocal.
    const mid = buildAss(snapshot([clip], 5, { tracks: tl.tracks }), { index: 1, start: 1.5, end: 5 })!;
    expect(mid).toContain('{\\kf1}Carry {\\kf29}me {\\kf80}home');
    const vertical = buildAss(snapshot([clip], 5, { tracks: tl.tracks, width: 360, height: 640 }), { index: 0, start: 0, end: 5 })!;
    const marginV = Number(/Style: s0(?:,[^,]*){20},(\d+),1$/m.exec(vertical)?.[1]);
    expect(marginV).toBeGreaterThanOrEqual(Math.round(0.2 * 640));
  });
});

describe('mix automation', () => {
  it('builds piecewise-linear gain expressions', () => {
    expect(automationExpr([], 0.8)).toBe('0.8');
    expect(automationExpr([{ t: 0, gain: 1 }, { t: 2, gain: 0 }], 0.5)).toBe('0.5*(if(lt(t,0),1,if(lt(t,2),1+(-1)*(t-0)/2,0)))');
    expect(duckRatio(12)).toBe(8);
    expect(duckRatio(6)).toBe(3);
  });

  it('routes ducked music through a sidechain compressor keyed by dialogue', () => {
    const tl = emptyTimeline();
    const v = tl.tracks[0]!.id;
    const a = tl.tracks.find((t) => t.kind === 'audio')!.id;
    const clips = [
      makeClip({ trackId: v, kind: 'video', start: 0, duration: 4, assetId: 'd', sourceDuration: 4, useSourceAudio: true }),
      makeClip({ trackId: a, kind: 'audio', start: 0, duration: 4, assetId: 'm', sourceDuration: 4, role: 'music', duck: true, duckDb: 12, fadeIn: 1 }),
    ];
    const mix = buildAudioMix(snapshot(clips, 4, { tracks: tl.tracks, assets: { d: { kind: 'video', storagePath: 'd', width: 1, height: 1, durationSec: 4, hasAudio: true }, m: { kind: 'audio', storagePath: 'm', width: null, height: null, durationSec: 4, hasAudio: true } } }), (id) => id, 'o.m4a', 'f.txt');
    expect(mix.filter).toContain('sidechaincompress=threshold=0.02:ratio=8');
    expect(mix.filter).toContain('[mus][dlgsc]');
    expect(mix.filter).toContain('curve=qsin');
  });
});

// ---------------------------------------------------------------------------
// Real FFmpeg: measure that the score actually ducks under dialogue and honours silence
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
let FF: string | null = null;
try {
  FF = require('ffmpeg-static') as string;
} catch {
  FF = null;
}
const hasFfmpeg = Boolean(FF && existsSync(FF));
const work = mkdtempSync(path.join(os.tmpdir(), 'azs-mix-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!hasFfmpeg)('real FFmpeg mix', () => {
  it('lowers the score under dialogue, lets it rise in the gaps, and keeps deliberate silence silent', () => {
    const ff = (args: string[]) => execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });
    const dialogue = path.join(work, 'dialogue.mp4');
    const music = path.join(work, 'music.m4a');
    // "Dialogue": a 1 kHz voice-band tone speaking for 0–2 s and 4–5 s, silent otherwise.
    ff(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=24:d=6', '-f', 'lavfi', '-i', "sine=frequency=1000:duration=6,volume='if(lt(t,2)+between(t,4,5),0.5,0)':eval=frame", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', dialogue]);
    ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-af', 'volume=0.5', '-c:a', 'aac', music]);
    const tl = emptyTimeline();
    const v = tl.tracks[0]!.id;
    const a = tl.tracks.find((t) => t.kind === 'audio')!.id;
    const clips = [
      makeClip({ trackId: v, kind: 'video', start: 0, duration: 6, assetId: 'd', sourceDuration: 6, useSourceAudio: true }),
      // Score: ducked under dialogue, and automated to silence from 5.3 s (a deliberate silence cue).
      makeClip({ trackId: a, kind: 'audio', start: 0, duration: 6, assetId: 'm', sourceDuration: 6, role: 'music', duck: true, duckDb: 12, volumeAutomation: [{ t: 0, gain: 1 }, { t: 5, gain: 1 }, { t: 5.3, gain: 0 }] }),
    ];
    const snap = snapshot(clips, 6, { tracks: tl.tracks, assets: { d: { kind: 'video', storagePath: 'd', width: 160, height: 90, durationSec: 6, hasAudio: true }, m: { kind: 'audio', storagePath: 'm', width: null, height: null, durationSec: 6, hasAudio: true } } });
    const files: Record<string, string> = { d: dialogue, m: music };
    const out = path.join(work, 'mix.m4a');
    const mix = buildAudioMix(snap, (id) => files[id]!, out, path.join(work, 'mix.filter'));
    writeFileSync(path.join(work, 'mix.filter'), mix.filter);
    execFileSync(FF!, mix.args.map((x) => (x === 'pipe:1' ? '-' : x)), { stdio: 'pipe' });
    const level = (from: number, to: number) => {
      const r = spawnSync(FF!, ['-hide_banner', '-nostdin', '-ss', String(from), '-t', String(to - from), '-i', out, '-af', 'bandpass=f=220:width_type=q:w=4,astats=metadata=0', '-f', 'null', '-'], { encoding: 'utf8' });
      const m = /Overall[\s\S]*?RMS level dB:\s*(-?[\d.]+|-inf)/.exec(String(r.stderr));
      return m ? (m[1] === '-inf' ? -120 : Number(m[1])) : NaN;
    };
    const underDialogue = level(0.6, 1.8);
    const inGap = level(2.8, 3.8);
    const silence = level(5.5, 5.95);
    expect(Number.isFinite(underDialogue) && Number.isFinite(inGap)).toBe(true);
    expect(inGap - underDialogue).toBeGreaterThan(5); // ducked by several dB under speech
    expect(silence).toBeLessThan(inGap - 30); // deliberate silence
  }, 120_000);

  it('keeps the score playing after the last line of dialogue ends', () => {
    const ff = (args: string[]) => execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });
    const line = path.join(work, 'line.m4a');
    const music = path.join(work, 'long-music.m4a');
    // A 2-second line of dialogue at 1 s, under an 8-second score.
    ff(['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2', '-af', 'volume=0.5', '-c:a', 'aac', line]);
    ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-af', 'volume=0.5', '-c:a', 'aac', music]);
    const tl = emptyTimeline();
    const a = tl.tracks.find((t) => t.kind === 'audio')!.id;
    const clips = [
      makeClip({ trackId: a, kind: 'audio', start: 1, duration: 2, assetId: 'l', sourceDuration: 2, role: 'dialogue' }),
      makeClip({ trackId: a, kind: 'audio', start: 0, duration: 8, assetId: 'm', sourceDuration: 8, role: 'music', duck: true, duckDb: 12 }),
    ];
    const snap = snapshot(clips, 8, { tracks: tl.tracks, assets: { l: { kind: 'audio', storagePath: 'l', width: null, height: null, durationSec: 2, hasAudio: true }, m: { kind: 'audio', storagePath: 'm', width: null, height: null, durationSec: 8, hasAudio: true } } });
    const files: Record<string, string> = { l: line, m: music };
    const out = path.join(work, 'mix-after.m4a');
    const mix = buildAudioMix(snap, (id) => files[id]!, out, path.join(work, 'mix-after.filter'));
    expect(mix.filter).toContain('apad=whole_dur=8[dlgsc]');
    writeFileSync(path.join(work, 'mix-after.filter'), mix.filter);
    execFileSync(FF!, mix.args.map((x) => (x === 'pipe:1' ? '-' : x)), { stdio: 'pipe' });
    const level = (from: number, to: number) => {
      const r = spawnSync(FF!, ['-hide_banner', '-nostdin', '-ss', String(from), '-t', String(to - from), '-i', out, '-af', 'bandpass=f=220:width_type=q:w=4,astats=metadata=0', '-f', 'null', '-'], { encoding: 'utf8' });
      const m = /Overall[\s\S]*?RMS level dB:\s*(-?[\d.]+|-inf)/.exec(String(r.stderr));
      return m ? (m[1] === '-inf' ? -120 : Number(m[1])) : NaN;
    };
    const before = level(0.2, 0.9);
    const under = level(1.5, 2.8);
    const after = level(4.5, 7.5);
    expect(before - under).toBeGreaterThan(5);
    // The score comes back to its full level once the line has finished — it is not cut off.
    expect(Math.abs(after - before)).toBeLessThan(2);
  }, 120_000);
});
