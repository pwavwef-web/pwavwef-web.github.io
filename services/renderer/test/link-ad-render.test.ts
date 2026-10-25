import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assembleLinkAd, defaultLinkAd, sceneVoiceHash, stampFor, VERTICAL_ZONES, type AdScene, type LinkAdDoc, type LiteWord } from '@az-studio/shared';
import { buildAudioMix, buildSegment, concatList, muxArgs, planSegments, type RenderSnapshot } from '../src/graph';

/**
 * A Link to Ad composition rendered with real FFmpeg exactly as the studio renders it (same graph code, same
 * mix). The voice here is the fixture voice — a short tone per word — because the test must run anywhere and
 * spend nothing; what it proves is the composition: framing, exact on-screen text, captions timed to the audio,
 * the closing call to action and logo, the safe zones, the mix (music ducked under the voice) and the file itself
 * (codecs, dimensions, duration). A recording by a real speech model changes only the audio samples.
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
const work = mkdtempSync(path.join(os.tmpdir(), 'azs-linkad-render-'));
const fonts = path.join(work, 'fonts');
mkdirSync(fonts);
afterAll(() => rmSync(work, { recursive: true, force: true }));

const W = 720;
const H = 1280;

describe.skipIf(!hasFfmpeg)('real FFmpeg render of a Link to Ad timeline', () => {
  const ff = (args: string[]) => execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  const frameAt = (file: string, t: number) => {
    const buf = execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
    const px = (x: number, y: number) => {
      const i = (Math.round(y) * W + Math.round(x)) * 3;
      return [buf[i]!, buf[i + 1]!, buf[i + 2]!] as const;
    };
    /** Rows (as fractions of the height) that contain at least `min` near-white pixels. */
    const whiteRows = (min = 6) => {
      const rows: number[] = [];
      for (let y = 0; y < H; y++) {
        let n = 0;
        for (let x = 0; x < W; x += 2) {
          const i = (y * W + x) * 3;
          if (buf[i]! > 235 && buf[i + 1]! > 235 && buf[i + 2]! > 235) n++;
        }
        if (n >= min) rows.push(y / H);
      }
      return rows;
    };
    return { px, whiteRows };
  };
  const bandLevel = (file: string, hz: number, from: number, dur: number) => {
    const r = spawnSync(FF!, ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(dur), '-i', file, '-vn', '-af', `bandpass=f=${hz}:width_type=q:w=30,volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
    if (!m) throw new Error('no level');
    return Number(m[1]);
  };
  const probeOf = (file: string) => JSON.parse(execFileSync(FP!, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString()) as { format: { duration: string; format_name: string }; streams: { codec_type: string; codec_name: string; width?: number; height?: number }[] };

  it('renders the approved composition: framing, text, captions, closing, mix and file', () => {
    // --- media -------------------------------------------------------------------------------------------------
    const hero = path.join(work, 'hero.png');
    const room = path.join(work, 'room.png');
    const logo = path.join(work, 'logo.png');
    // Landscape pictures: red follows x, green follows y; each colour tells where on the picture a pixel came from.
    ff(['-f', 'lavfi', '-i', 'color=c=black:s=1600x1066', '-vf', "format=rgb24,geq=r='X/W*255':g='Y/H*255':b='40'", '-frames:v', '1', hero]);
    ff(['-f', 'lavfi', '-i', 'color=c=black:s=1200x800', '-vf', "format=rgb24,geq=r='255-X/W*255':g='Y/H*255':b='200'", '-frames:v', '1', room]);
    ff(['-f', 'lavfi', '-i', 'color=c=0xff00ff:s=320x120', '-frames:v', '1', logo]);
    const tone = (file: string, words: number) => {
      const per = 0.28;
      const expr = Array.from({ length: words }, (_, i) => `between(t,${(0.12 + i * per).toFixed(3)},${(0.12 + i * per + per * 0.7).toFixed(3)})*0.3*sin(2*PI*${240 + (i % 5) * 40}*t)`).join('+');
      ff(['-f', 'lavfi', '-i', `aevalsrc='${expr}':s=24000:d=${(0.12 + words * per + 0.2).toFixed(3)}`, '-ac', '1', '-c:a', 'pcm_s16le', file]);
      return { fileSec: 0.12 + words * per + 0.2, per };
    };
    const music = path.join(work, 'music.wav');
    ff(['-f', 'lavfi', '-i', "aevalsrc='0.2*sin(2*PI*3000*t)':s=48000:d=40", music]);

    // --- the ad ------------------------------------------------------------------------------------------------
    const d: LinkAdDoc = defaultLinkAd({ url: 'https://harbourlight.example/' });
    d.ad.brand = { primary: '#0B6E7F', background: '#0F1B1A', text: '#FFFFFF', accent: '#F4B84A', font: 'Inter' };
    d.source.assets = [
      { id: 'a_hero', assetId: 'hero', role: 'image', origin: 'site', url: null, pageUrl: null, alt: 'Terrace', width: 1600, height: 1066, bytes: 1, mime: 'image/png', status: 'stored', rejectReason: null, rights: 'confirmed', needsReview: false, reviewed: false, selected: true, note: '' },
      { id: 'a_room', assetId: 'room', role: 'image', origin: 'site', url: null, pageUrl: null, alt: 'Room', width: 1200, height: 800, bytes: 1, mime: 'image/png', status: 'stored', rejectReason: null, rights: 'confirmed', needsReview: false, reviewed: false, selected: true, note: '' },
      { id: 'a_logo', assetId: 'logo', role: 'logo', origin: 'site', url: null, pageUrl: null, alt: 'Logo', width: 320, height: 120, bytes: 1, mime: 'image/png', status: 'stored', rejectReason: null, rights: 'confirmed', needsReview: false, reviewed: false, selected: true, note: '' },
    ];
    d.brief = { ...d.brief, logoId: 'a_logo', imageIds: ['a_hero', 'a_room'], origin: 'manual', focus: 'Harbour Light Guesthouse' };
    const scene = (id: string, role: AdScene['role'], narration: string, extra: Partial<AdScene> = {}): AdScene => ({ id, role, narration, overlay: '', overlayPos: 'upper', assetId: null, focal: { x: 0.5, y: 0.5 }, motion: 'still', factIds: [], factStamp: {}, review: null, ...extra });
    d.ad.scenes = [
      scene('s1', 'hook', 'Wake up to the sea in Cape Coast, with a sea view terrace and a home cooked breakfast.', { assetId: 'a_hero', motion: 'push_in', overlay: 'Wake up to the sea' }),
      scene('s2', 'offer', 'Every room opens onto a shared terrace that is open from sunrise until late in the evening.', { assetId: 'a_room', motion: 'pan_right', overlay: 'Rooms with a view' }),
      scene('s3', 'detail', 'Breakfast is cooked fresh each morning by our kitchen team, and it is included.', { overlay: 'Breakfast included', overlayPos: 'middle' }),
      scene('s4', 'cta', 'Call Harbour Light Guesthouse today to book your stay.', {}),
    ];
    d.ad.scenes = d.ad.scenes.map((s) => ({ ...s, factStamp: stampFor(d, s.factIds) }));
    d.ad.closing = { headline: 'Book your stay', line: '+233 24 555 0142', showLogo: true };
    d.ad.music = { assetId: 'music', title: 'Test tone', rightsConfirmed: true, gainDb: -17 };
    const files: Record<string, string> = { hero, room, logo, music };
    const assets: Record<string, { width: number | null; height: number | null; durationSec: number | null }> = { hero: { width: 1600, height: 1066, durationSec: null }, room: { width: 1200, height: 800, durationSec: null }, logo: { width: 320, height: 120, durationSec: null }, music: { width: null, height: null, durationSec: 40 } };
    const takes: LinkAdDoc['ad']['takes'] = {};
    for (const s of d.ad.scenes) {
      const words = s.narration.split(' ').length;
      const file = path.join(work, `voice-${s.id}.wav`);
      const t = tone(file, words);
      files[`voice-${s.id}`] = file;
      assets[`voice-${s.id}`] = { width: null, height: null, durationSec: t.fileSec };
      const ws: LiteWord[] = s.narration.split(' ').map((w, i) => ({ text: w, start: 0.12 + i * t.per, end: 0.12 + i * t.per + t.per * 0.7, confidence: 0.99 }));
      takes[s.id] = { hash: sceneVoiceHash(s, d.brief.voice, d.brief.voiceDirection), assetId: `voice-${s.id}`, jobId: 'j', fileSec: t.fileSec, speechStart: ws[0]!.start, speechEnd: ws.at(-1)!.end, words: ws, alignment: 'aligned', coverage: 1, flags: [], source: 'fixture', voice: d.brief.voice, createdAt: 1 };
    }
    d.ad.takes = takes;

    const a = assembleLinkAd({ doc: d, assets, outWidth: W });
    expect(a.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(a.durationSec).toBeGreaterThanOrEqual(15);
    expect(a.durationSec).toBeLessThanOrEqual(30);
    const D = a.durationSec;

    const snap: RenderSnapshot = {
      tracks: a.state.tracks,
      clips: a.state.clips,
      fps: 30,
      width: W,
      height: H,
      durationSec: D,
      quality: 'draft',
      assets: Object.fromEntries(Object.entries(assets).map(([id, i]) => [id, { kind: id === 'music' || id.startsWith('voice-') ? 'audio' : 'image', storagePath: id, width: i.width, height: i.height, durationSec: i.durationSec, hasAudio: id === 'music' || id.startsWith('voice-') }])),
    };
    const resolve = (id: string) => files[id]!;
    const segFiles: string[] = [];
    for (const seg of planSegments(snap, 6)) {
      const base = path.join(work, `seg${seg.index}`);
      const plan = buildSegment(snap, seg, { resolve, filterScriptPath: `${base}.filter`, assPath: `${base}.ass`, fontsDir: fonts, outputPath: `${base}.mp4`, aspect: '9:16' });
      writeFileSync(`${base}.filter`, plan.filter);
      if (plan.ass) writeFileSync(`${base}.ass`, plan.ass);
      execFileSync(FF!, plan.args.map((x) => (x === 'pipe:1' ? '-' : x)), { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
      segFiles.push(`${base}.mp4`);
    }
    const list = path.join(work, 'list.txt');
    writeFileSync(list, concatList(segFiles.map((f) => f.replace(/\\/g, '/'))));
    const joined = path.join(work, 'video.mp4');
    ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
    const mix = buildAudioMix(snap, resolve, path.join(work, 'audio.m4a'), path.join(work, 'audio.filter'));
    writeFileSync(path.join(work, 'audio.filter'), mix.filter);
    execFileSync(FF!, mix.args.map((x) => (x === 'pipe:1' ? '-' : x)), { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
    const out = path.join(work, 'ad.mp4');
    execFileSync(FF!, muxArgs(joined, path.join(work, 'audio.m4a'), out, D, { title: 'Link to Ad test' }), { stdio: 'pipe' });

    if (process.env.AZS_KEEP_RENDER) execFileSync(FF!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-c', 'copy', process.env.AZS_KEEP_RENDER]);

    // --- the file -----------------------------------------------------------------------------------------------
    const pr = probeOf(out);
    const v = pr.streams.find((s) => s.codec_type === 'video')!;
    const au = pr.streams.find((s) => s.codec_type === 'audio')!;
    expect([v.codec_name, au.codec_name]).toEqual(['h264', 'aac']);
    expect([v.width, v.height]).toEqual([W, H]);
    expect(Math.abs(Number(pr.format.duration) - D)).toBeLessThan(0.1);

    // --- picture ------------------------------------------------------------------------------------------------
    const win = a.windows;
    const mid = (i: number) => (win[i]!.start + win[i]!.end) / 2;
    const bg = [0x0f, 0x1b, 0x1a];
    const near = (c: readonly number[], t: number[], tol = 14) => c.every((x, k) => Math.abs(x - t[k]!) <= tol);
    const f1 = frameAt(out, mid(0) - 0.4);
    // A landscape photo does not fill the tall frame: it is shown whole and framed, on the brand colour.
    expect(a.issues.some((i) => i.kind === 'framed')).toBe(true);
    expect(near(f1.px(W * 0.2, H * 0.47), bg)).toBe(false); // inside the frame band the picture shows
    expect(near(f1.px(W * 0.01, H * 0.47), bg, 30)).toBe(true); // outside it, brand colour
    expect(near(f1.px(W * 0.01, H * 0.2), bg, 30)).toBe(true);
    const picL = f1.px(W * 0.1, H * 0.47);
    const picR = f1.px(W * 0.9, H * 0.47);
    expect(picR[0]).toBeGreaterThan(picL[0] + 100); // red grows left to right: the whole width of the photo is visible
    // --- exact text ---------------------------------------------------------------------------------------------
    const textRows = f1.whiteRows();
    const inZone = (rows: number[], z: { from: number; to: number }) => rows.filter((r) => r >= z.from - 0.005 && r <= z.to + 0.005);
    expect(inZone(textRows, VERTICAL_ZONES.overlayUpper).length).toBeGreaterThan(8); // the overlay text sits in its zone
    expect(textRows.every((r) => r > VERTICAL_ZONES.platformTop.to - 0.001 && r < VERTICAL_ZONES.platformBottom.from + 0.001)).toBe(true); // nothing in the platform margins
    // --- captions timed to the voice -----------------------------------------------------------------------------
    const cue = a.cues[1]!;
    const withCaption = frameAt(out, (cue.start + cue.end) / 2);
    const capRows = withCaption.whiteRows();
    expect(inZone(capRows, VERTICAL_ZONES.captions).length).toBeGreaterThan(8);
    // Before any speech in the first scene there is no caption.
    const quiet = frameAt(out, 0.1);
    expect(inZone(quiet.whiteRows(), VERTICAL_ZONES.captions).length).toBe(0);
    // --- closing: headline, destination and logo, clear of the captions --------------------------------------------
    const last = win.at(-1)!;
    const closing = frameAt(out, last.speechEnd! + 0.5);
    const closingRows = closing.whiteRows();
    expect(inZone(closingRows, VERTICAL_ZONES.closingHeadline).length).toBeGreaterThan(8);
    const logoPx = closing.px(W * 0.5, H * (VERTICAL_ZONES.logoCta.from + VERTICAL_ZONES.logoCta.to) / 2);
    expect(logoPx[0]).toBeGreaterThan(200); // the magenta logo block is drawn
    expect(logoPx[2]).toBeGreaterThan(200);
    expect(logoPx[1]).toBeLessThan(60);
    // While the last line is spoken, the captions and the closing text occupy separate bands.
    const speaking = frameAt(out, (last.speechStart! + last.speechEnd!) / 2);
    const rows = speaking.whiteRows();
    expect(inZone(rows, VERTICAL_ZONES.captions).length).toBeGreaterThan(8);
    expect(rows.filter((r) => r > VERTICAL_ZONES.closingLine.to + 0.01 && r < VERTICAL_ZONES.captions.from - 0.01).length).toBe(0);

    // --- sound -----------------------------------------------------------------------------------------------------
    const s1 = win[0]!;
    const under = bandLevel(out, 3000, s1.speechStart! + 0.4, 1.2);
    // The same mix with ducking switched off: under the voice the music is measurably lower than it would be.
    const flat: RenderSnapshot = { ...snap, clips: snap.clips.map((c) => (c.role === 'music' ? { ...c, duck: false } : c)) };
    const mix2 = buildAudioMix(flat, resolve, path.join(work, 'audio2.m4a'), path.join(work, 'audio2.filter'));
    writeFileSync(path.join(work, 'audio2.filter'), mix2.filter);
    execFileSync(FF!, mix2.args.map((x) => (x === 'pipe:1' ? '-' : x)), { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
    const open = bandLevel(path.join(work, 'audio2.m4a'), 3000, s1.speechStart! + 0.4, 1.2);
    expect(open - under).toBeGreaterThan(6); // the music is lowered while the voice speaks
    const voiceDuring = bandLevel(out, 240, s1.speechStart! + 0.1, 0.2);
    const voiceAfter = bandLevel(out, 240, s1.end - 0.15, 0.1);
    expect(voiceDuring).toBeGreaterThan(voiceAfter + 8); // the voice is there when the scene says it is
  }, 300_000);
});
