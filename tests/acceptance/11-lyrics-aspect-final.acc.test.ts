import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { describe, expect, it } from 'vitest';
import {
  addAudioBed,
  addClip,
  applyLyricCaptions,
  emptyTimeline,
  jobRequestSchema,
  LYRIC_PRESET_STYLES,
  makeClip,
  parseLyricsText,
  SAFE_AREAS,
  sheetFromParsed,
  sheetToLyricLines,
  timelineDuration,
  type Box,
  type Clip,
  type FinalInspectionDoc,
  type LyricPreset,
  type LyricsSheet,
  type LyricStyle,
  type TimelineState,
} from '@az-studio/shared';
import * as actions from '../../functions/src/api/actions';
import * as continuityApi from '../../functions/src/api/continuity';
import * as studio from '../../functions/src/api/studio';
import { bucket, col, FieldValue } from '../../functions/src/lib/firebase';
import type { Owner } from '../../functions/src/lib/owner';
import { annotateFrames, type AnnotatedFrame } from '../../functions/src/lib/vision';
import { FIXTURES, payload, qaProject, reporter, sleep, studioOwner, submitJobs, uploadFile, waitForJob, type Log } from './harness';

const FFMPEG = ffmpegPath as unknown as string;
const UPLOADED = ['[Verse]', 'Morning light upon the Volta', 'Fishermen are singing low', '', '[Chorus]', 'Carry me home, carry me home', 'Where the river waters flow', 'Carry me home, carry me home', 'Where the river waters flow'].join('\n');

const words = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
/** How much of a lyric line OCR read in a frame (fraction of its distinct words). */
function lineSeen(ocr: string, line: string): number {
  const have = new Set(words(ocr));
  const want = [...new Set(words(line))];
  return want.filter((w) => have.has(w)).length / Math.max(1, want.length);
}
const area = (b: Box) => b.w * b.h;
function overlap(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

async function saveTimeline(projectId: string, ownerUid: string, id: string, name: string, s: TimelineState) {
  const ref = col.timelines(projectId).doc(id);
  const version = Number((await ref.get()).get('version') ?? 0) + 1;
  await ref.set({ ownerUid, projectId, name, fps: s.fps, aspectRatio: s.aspectRatio, tracks: s.tracks, clips: s.clips, markers: s.markers, beatGrid: s.beatGrid, version, durationSec: timelineDuration(s.clips), updatedAt: FieldValue.serverTimestamp() });
}

interface Rendered {
  renderId: string;
  assetId: string;
  storagePath: string;
  file: string;
  width: number;
  height: number;
  durationSec: number;
}

async function render(owner: Owner, projectId: string, timelineId: string, preset: 'youtube_16x9' | 'vertical_9x16', quality: 'draft' | 'final', opts: { inspect?: boolean; acceptLyricSync?: boolean }, dir: string, log: Log): Promise<Rendered> {
  const [jobId] = await submitJobs(owner, [{ type: 'render.timeline', projectId, timelineId, preset, quality, inspect: opts.inspect ?? false, acceptLyricSync: opts.acceptLyricSync ?? false, label: `QA · ${timelineId} · ${preset} ${quality}` }], 'QA · render');
  return finishRender(jobId!, dir, log);
}

async function finishRender(jobId: string, dir: string, log: Log): Promise<Rendered> {
  const job = await waitForJob(jobId, log, 30 * 60_000);
  expect(job.status, job.error?.message).toBe('completed');
  const assetId = String(job.result?.assetIds?.[0]);
  const a = (await col.assets().doc(assetId).get()).data()!;
  const renderId = String((job.params as { renderId?: string }).renderId);
  const file = path.join(dir, `${renderId}.mp4`);
  await bucket.file(String(a.storagePath)).download({ destination: file });
  return { renderId, assetId, storagePath: String(a.storagePath), file, width: Number(a.width), height: Number(a.height), durationSec: Number(a.durationSec) };
}

async function finalInspection(projectId: string, renderId: string, log: Log): Promise<FinalInspectionDoc> {
  const until = Date.now() + 25 * 60_000;
  let last = '';
  for (;;) {
    const fi = (await col.renders().doc(renderId).get()).get('finalInspection') as { status?: string } | null;
    const line = fi?.status ?? 'not started';
    if (line !== last) log(`final inspection of ${renderId}: ${line}`);
    last = line;
    if (line === 'completed' || line === 'failed') break;
    if (Date.now() > until) throw new Error(`The final inspection of ${renderId} did not finish (${line}).`);
    await sleep(10_000);
  }
  const d = await col.sub(projectId, 'finalInspections').doc(renderId).get();
  return { ...(d.data() as FinalInspectionDoc), id: d.id };
}

function jpegAt(file: string, t: number, width: number): Buffer {
  return spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { maxBuffer: 64 << 20 }).stdout;
}
function rgbAt(file: string, t: number): Uint8Array {
  return new Uint8Array(spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=384:216', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 16 << 20 }).stdout);
}
/** Share of pixels (%) that differ visibly in colour between two frames (a gold word sweep over white text counts). */
function changedPct(a: Uint8Array, b: Uint8Array): number {
  const n = Math.floor(Math.min(a.length, b.length) / 3);
  let changed = 0;
  for (let i = 0; i < n; i++) if (Math.max(Math.abs(a[3 * i]! - b[3 * i]!), Math.abs(a[3 * i + 1]! - b[3 * i + 1]!), Math.abs(a[3 * i + 2]! - b[3 * i + 2]!)) > 40) changed++;
  return n ? (100 * changed) / n : 0;
}
/** Momentary loudness every 100 ms (EBU R128), to compare the sound of two exports. */
function loudness(file: string): number[] {
  const out = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-af', 'aresample=48000,asetnsamples=n=4800:p=0,ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M:file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout;
  return [...out.matchAll(/lavfi\.r128\.M=(-?[\d.]+)/g)].map((m) => Number(m[1]));
}

/** OCR and face detection (Cloud Vision) on frames of a render. */
async function read(r: Rendered, times: number[]): Promise<AnnotatedFrame[]> {
  const width = r.width >= r.height ? 1280 : 720;
  const height = Math.round((width * r.height) / r.width / 2) * 2;
  return annotateFrames({ frames: times.map((t) => ({ t, jpeg: jpegAt(r.file, t, width), width, height })), features: ['TEXT_DETECTION', 'FACE_DETECTION'] });
}

const LYRIC_WORDS = new Set(words(UPLOADED));
/** OCR words that are lyrics — OCR also “reads” text in picture textures (ripples on the river), which is not ours. */
const lyricWords = (f: AnnotatedFrame) => f.text.filter((w) => words(w.text).some((x) => LYRIC_WORDS.has(x)));
/** Share of a face covered by lyric text (0 = clear). */
const faceCover = (f: AnnotatedFrame) => Math.max(0, ...f.faces.filter((x) => x.confidence >= 0.5).map((face) => lyricWords(f).reduce((s, w) => s + (w.box ? overlap(w.box, face.box) : 0), 0) / Math.max(1e-6, area(face.box))));
/** Text boxes outside a safe area (fractions of the frame, with a small tolerance). */
function outsideSafe(f: AnnotatedFrame, safe: { top: number; bottom: number; left: number; right: number }, horizontalOnly = false): string[] {
  const tol = 0.02;
  return lyricWords(f).filter((w) => w.box && (w.box.x < safe.left - tol || w.box.x + w.box.w > 1 - safe.right + tol || (!horizontalOnly && (w.box.y < safe.top - tol || w.box.y + w.box.h > 1 - safe.bottom + tol)))).map((w) => w.text);
}

async function useStyle(owner: Owner, projectId: string, songId: string, name: string, global: LyricStyle): Promise<string> {
  const saved = await continuityApi.continuitySave(owner, payload('continuitySave', { projectId, collection: 'lyricStyles', data: { name, global, sections: {}, fonts: [] } }));
  await continuityApi.continuitySave(owner, payload('continuitySave', { projectId, collection: 'lyricsTracks', data: { songId, styleId: saved.id, placements: {} } }));
  return saved.id;
}

describe('Acceptance 11 — lyric styles, 16:9 and 9:16 exports, final-film inspection', () => {
  it('renders four lyric presets differently and in time without covering faces, exports both shapes with identical timing, and blocks a flawed film until fixed or overridden', async () => {
    const { log, save } = reporter('11-lyrics-aspect-final');
    const owner = await studioOwner();
    const projectId = await qaProject(owner, 'lyric-video', 'Lyric styles, exports and final inspection', 'music_video', { language: 'en' });
    const results: Record<string, unknown> = {};
    const dir = mkdtempSync(path.join(tmpdir(), 'azs-acc11-'));
    try {
      // Song, lyrics (aligned to the vocal) and a singer shot tracked for faces.
      const audio = await uploadFile(owner, projectId, path.join(FIXTURES, 'sung-clip.mp3'), 'audio', 'audio/mpeg', log);
      const songSec = Number(audio.durationSec);
      const uploaded = sheetFromParsed(parseLyricsText(UPLOADED), { source: 'uploaded', language: 'en' });
      await col.songs(projectId).doc('song').set({ title: 'Volta Morning (test clip)', artist: '', audioAssetId: audio.id, durationSec: songSec, analysis: null, ai: null, lyricsSheet: uploaded, lyrics: { source: 'upload', lines: sheetToLyricLines(uploaded) }, instrumental: false, createdAt: FieldValue.serverTimestamp() });
      const singerReq = jobRequestSchema.parse({ type: 'video.generate', projectId, mode: 'generate', prompt: 'Medium shot, static camera, 35mm lens. A Ghanaian woman in her thirties with short natural hair and a mustard-yellow kaba blouse sings softly on a riverbank at dawn. She stands on the left third of the frame, her face turned three-quarters toward the camera and clearly visible, swaying gently; mist on the calm water behind her, open sky on the right side of the frame. Natural soft light. No text, no captions, no logos.', aspectRatio: '16:9', resolution: '360p', durationSec: 8, media: [], characterIds: [], title: 'Singer by the river', label: 'QA · singer shot' });
      const [alignJob, singerJob] = await submitJobs(owner, [{ type: 'lyrics.align', projectId, songId: 'song', audioAssetId: audio.id, languageCode: 'en', retranscribe: false, label: 'QA · synchronise lyrics' }, singerReq], 'QA · lyrics and singer');
      const [align, singer] = await Promise.all([waitForJob(alignJob!, log), waitForJob(singerJob!, log)]);
      expect(align.status, align.error?.message).toBe('completed');
      expect(singer.status, singer.error?.message).toBe('completed');
      const sheet = (await col.songs(projectId).doc('song').get()).get('lyricsSheet') as LyricsSheet;
      const lines = sheet.lines.filter((l) => l.start !== null && l.end !== null) as (LyricsSheet['lines'][number] & { start: number; end: number })[];
      log(`lyrics ${sheet.timing.status}: ${lines.map((l) => `${l.start.toFixed(2)}–${l.end.toFixed(2)} ${l.text}`).join(' | ')}`);
      expect(lines.length).toBeGreaterThanOrEqual(5);
      const videoId = String(singer.result?.assetIds?.[0]);
      const videoSec = Number((await col.assets().doc(videoId).get()).get('durationSec'));
      const [trackJob] = await submitJobs(owner, [{ type: 'media.analyze_subjects', projectId, assetIds: [videoId], fps: 2, label: 'QA · track faces' }], 'QA · faces');
      const tracked = await waitForJob(trackJob!, log);
      expect(tracked.status, tracked.error?.message).toBe('completed');
      const faces = (await col.sub(projectId, 'subjectTracks').doc(videoId).get()).get('samples') as { faces: unknown[] }[] | undefined;
      log(`singer ${videoId}: ${videoSec} s; face tracking: ${faces?.filter((s) => s.faces.length).length ?? 0}/${faces?.length ?? 0} samples with a face`);
      expect(faces?.some((s) => s.faces.length)).toBe(true);

      // The music video: the singer shot repeated under the whole song, lyrics timed from the sheet.
      let mv = addAudioBed(emptyTimeline('16:9', 24), audio.id, songSec, 'Song', { songId: 'song' });
      const v1 = mv.tracks.find((t) => t.kind === 'video')!.id;
      for (let start = 0, i = 1; start < songSec - 0.05; start += videoSec, i++) {
        mv = addClip(mv, makeClip({ trackId: v1, kind: 'video', start, duration: Math.min(videoSec, songSec - start), assetId: videoId, sourceDuration: videoSec, label: `Singer ${i}`, useSourceAudio: false, fit: 'smart' }));
      }
      mv = applyLyricCaptions(mv, 'song', sheet, 'karaoke');
      await saveTimeline(projectId, owner.uid, 'mv', 'Lyric video', mv);
      const lyricClips = mv.clips.filter((c) => c.lyric).sort((a, b) => a.start - b.start);
      log(`timeline: ${timelineDuration(mv.clips).toFixed(2)} s, ${lyricClips.length} lyric clips`);

      // ---------------------------------------------------------------------------------------------
      // 1. Lyric styles: four presets from the same timing data.
      // ---------------------------------------------------------------------------------------------
      const PRESETS: LyricPreset[] = ['line_by_line', 'karaoke', 'rolling_credit', 'vertical_captions'];
      const jobs: Record<string, string> = {};
      for (const preset of PRESETS) {
        await useStyle(owner, projectId, 'song', `QA · ${preset}`, { ...LYRIC_PRESET_STYLES[preset], aspects: {} });
        const [jobId] = await submitJobs(owner, [{ type: 'render.timeline', projectId, timelineId: 'mv', preset: 'youtube_16x9', quality: 'draft', inspect: false, acceptLyricSync: false, label: `QA · lyric preset ${preset}` }], 'QA · render');
        jobs[preset] = jobId!;
      }
      const renders = Object.fromEntries(await Promise.all(PRESETS.map(async (p) => [p, await finishRender(jobs[p]!, dir, log)] as const))) as Record<LyricPreset, Rendered>;
      const mids = lyricClips.map((c) => ({ t: Math.round((c.start + Math.min(c.duration / 2, 1.2)) * 100) / 100, text: c.text }));
      const presetReport: Record<string, unknown> = {};
      for (const preset of PRESETS) {
        const r = renders[preset];
        const layout = ((await col.renders().doc(r.renderId).get()).get('textLayout') ?? {}) as { issues?: { kind: string; message: string }[] };
        const seen = await read(r, mids.map((m) => m.t));
        const timing = mids.map((m, i) => ({ t: m.t, line: m.text, seen: Math.round(lineSeen(seen[i]?.fullText ?? '', m.text) * 100) / 100 }));
        const covered = seen.map((f) => Math.round(faceCover(f) * 1000) / 1000);
        const unsafe = seen.flatMap((f) => outsideSafe(f, SAFE_AREAS['16:9'], preset === 'rolling_credit'));
        const facesSeen = seen.filter((f) => f.faces.some((x) => x.confidence >= 0.5)).length;
        log(`${preset}: layout issues ${JSON.stringify((layout.issues ?? []).map((i) => i.kind))}; lyric read at its time ${timing.map((x) => x.seen).join(' ')}; faces in ${facesSeen}/${seen.length} frames, covered ${covered.join(' ')}; outside safe area ${JSON.stringify(unsafe)}`);
        expect((layout.issues ?? []).filter((i) => i.kind === 'cropped' || i.kind === 'covers_face')).toEqual([]);
        // Timing: each line is on screen while it is sung (vertical captions show it a few words at a time).
        const need = preset === 'vertical_captions' ? 0.2 : 0.6;
        expect(timing.filter((x) => x.seen >= need).length).toBeGreaterThanOrEqual(Math.ceil(timing.length * 0.8));
        expect(Math.max(...covered)).toBeLessThan(0.05);
        expect(unsafe).toEqual([]);
        presetReport[preset] = { renderId: r.renderId, assetId: r.assetId, layoutIssues: layout.issues ?? [], timing, faceCoverage: covered, facesSeen };
      }
      // Nothing is on screen before the first line is sung (line by line).
      if (lines[0]!.start >= 1.2) {
        const [early] = await read(renders.line_by_line, [Math.round((lines[0]!.start / 2) * 100) / 100]);
        log(`before the first line (${(lines[0]!.start / 2).toFixed(2)} s): OCR “${early?.fullText ?? ''}”`);
        expect(lines.some((l) => lineSeen(early?.fullText ?? '', l.text) >= 0.5)).toBe(false);
      }
      // Each preset renders differently: the same frames differ between every pair of presets.
      const probeTimes = [mids[0]!.t, mids[Math.min(3, mids.length - 1)]!.t];
      const diffs: Record<string, number> = {};
      for (let i = 0; i < PRESETS.length; i++) {
        for (let k = i + 1; k < PRESETS.length; k++) {
          const a = PRESETS[i]!;
          const b = PRESETS[k]!;
          diffs[`${a}~${b}`] = Math.round(Math.max(...probeTimes.map((t) => changedPct(rgbAt(renders[a].file, t), rgbAt(renders[b].file, t)))) * 1000) / 1000;
        }
      }
      log(`pixels that differ between presets (% of the frame): ${JSON.stringify(diffs)}`);
      // The picture is identical in every render, so any visible difference is the lyric rendering itself.
      for (const d of Object.values(diffs)) expect(d).toBeGreaterThan(0.3);
      results.presets = { report: presetReport, differences: diffs };

      // ---------------------------------------------------------------------------------------------
      // 2. The same music video exported 16:9 and 9:16 (final renders, inspected before export).
      // ---------------------------------------------------------------------------------------------
      await useStyle(owner, projectId, 'song', 'QA · karaoke (exports)', { ...LYRIC_PRESET_STYLES.karaoke, aspects: {} });
      const [wideJob, tallJob] = await submitJobs(owner, [
        { type: 'render.timeline', projectId, timelineId: 'mv', preset: 'youtube_16x9', quality: 'final', inspect: true, acceptLyricSync: false, label: 'QA · export 16:9' },
        { type: 'render.timeline', projectId, timelineId: 'mv', preset: 'vertical_9x16', quality: 'final', inspect: true, acceptLyricSync: false, label: 'QA · export 9:16' },
      ], 'QA · exports');
      const [wide, tall] = await Promise.all([finishRender(wideJob!, dir, log), finishRender(tallJob!, dir, log)]);
      log(`exports: 16:9 ${wide.width}x${wide.height} ${wide.durationSec} s · 9:16 ${tall.width}x${tall.height} ${tall.durationSec} s`);
      expect(wide.width / wide.height).toBeCloseTo(16 / 9, 2);
      expect(tall.width / tall.height).toBeCloseTo(9 / 16, 2);
      expect(Math.abs(wide.durationSec - tall.durationSec)).toBeLessThan(0.05);
      // The sound is the same mix in both shapes.
      const [lw, lt] = [loudness(wide.file), loudness(tall.file)];
      const n = Math.min(lw.length, lt.length);
      const audioDelta = lw.slice(0, n).reduce((s, x, i) => s + Math.abs(x - lt[i]!), 0) / Math.max(1, n);
      log(`momentary loudness difference between the exports: ${audioDelta.toFixed(3)} LU over ${n} windows`);
      expect(audioDelta).toBeLessThan(0.5);
      // Faces stay in the vertical frame (face-safe reframing); lyrics move into each shape's safe area.
      const tallSnap = (await col.renders().doc(tall.renderId).get()).get('snapshot') as { clips: Clip[] };
      const reframed = tallSnap.clips.filter((c) => c.kind === 'video' && c.reframe?.['9:16']?.keyframes?.length);
      log(`9:16 reframe paths: ${reframed.length}/${tallSnap.clips.filter((c) => c.kind === 'video').length} picture clips; faces cut at ${JSON.stringify(reframed.flatMap((c) => c.reframe?.['9:16']?.cutHeads ?? []))}`);
      expect(reframed.length).toBe(tallSnap.clips.filter((c) => c.kind === 'video').length);
      const [seenWide, seenTall] = await Promise.all([read(wide, mids.map((m) => m.t)), read(tall, mids.map((m) => m.t))]);
      const tallFaces = seenTall.map((f) => f.faces.filter((x) => x.confidence >= 0.5).sort((a, b) => area(b.box) - area(a.box))[0] ?? null);
      log(`9:16 faces: ${tallFaces.map((f) => (f ? `${f.box.x.toFixed(2)}+${f.box.w.toFixed(2)}` : '—')).join(' ')}`);
      expect(tallFaces.filter(Boolean).length).toBeGreaterThanOrEqual(Math.ceil(tallFaces.length * 0.7));
      for (const f of tallFaces) if (f) expect(f.box.x > 0.01 && f.box.x + f.box.w < 0.99).toBe(true);
      const timingWide = mids.map((m, i) => lineSeen(seenWide[i]?.fullText ?? '', m.text));
      const timingTall = mids.map((m, i) => lineSeen(seenTall[i]?.fullText ?? '', m.text));
      log(`lyrics at their times — 16:9 ${timingWide.map((x) => x.toFixed(2)).join(' ')} · 9:16 ${timingTall.map((x) => x.toFixed(2)).join(' ')}`);
      expect(timingWide.filter((x) => x >= 0.6).length).toBeGreaterThanOrEqual(Math.ceil(mids.length * 0.8));
      expect(timingTall.filter((x) => x >= 0.6).length).toBeGreaterThanOrEqual(Math.ceil(mids.length * 0.8));
      expect(seenWide.flatMap((f) => outsideSafe(f, SAFE_AREAS['16:9']))).toEqual([]);
      expect(seenTall.flatMap((f) => outsideSafe(f, SAFE_AREAS['9:16']))).toEqual([]);
      expect(Math.max(...seenWide.map(faceCover), ...seenTall.map(faceCover))).toBeLessThan(0.05);
      const [fiWide, fiTall] = await Promise.all([finalInspection(projectId, wide.renderId, log), finalInspection(projectId, tall.renderId, log)]);
      for (const [name, fi] of [['16:9', fiWide], ['9:16', fiTall]] as const) {
        log(`final inspection ${name}: ${fi.status} ${fi.readiness} ${fi.score}/100 — ${fi.findings.map((f) => `${f.check}/${f.severity}`).join(', ') || 'no findings'}`);
        expect(fi.status).toBe('completed');
        expect(fi.findings.filter((f) => f.check === 'lyric_cropped' && f.severity === 'error')).toEqual([]);
      }
      results.exports = { wide: { renderId: wide.renderId, assetId: wide.assetId, size: `${wide.width}x${wide.height}`, durationSec: wide.durationSec, inspection: { readiness: fiWide.readiness, score: fiWide.score, findings: fiWide.findings.map((f) => `${f.check}/${f.severity}: ${f.message}`) } }, tall: { renderId: tall.renderId, assetId: tall.assetId, size: `${tall.width}x${tall.height}`, durationSec: tall.durationSec, inspection: { readiness: fiTall.readiness, score: fiTall.score, findings: fiTall.findings.map((f) => `${f.check}/${f.severity}: ${f.message}`) } }, audioDeltaLu: audioDelta, timingWide, timingTall };

      // ---------------------------------------------------------------------------------------------
      // 3. Final-film inspection: a black gap, a loud peak and a cropped lyric in one film.
      // ---------------------------------------------------------------------------------------------
      await col.songs(projectId).doc('song-qc').set({ title: 'Volta Morning (QC)', artist: '', audioAssetId: audio.id, durationSec: songSec, analysis: null, ai: null, lyricsSheet: sheet, lyrics: { source: 'upload', lines: sheetToLyricLines(sheet) }, instrumental: false, createdAt: FieldValue.serverTimestamp() });
      const qcStyleId = await useStyle(owner, projectId, 'song-qc', 'QA · oversized', { ...LYRIC_PRESET_STYLES.environment, x: 0.8, y: 0.5, fontSizePct: 11, align: 'left', aspects: {} });
      const beepFile = path.join(dir, 'beep.wav');
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.6:sample_rate=48000', '-af', 'volume=17dB', '-ac', '2', '-c:a', 'pcm_s16le', beepFile]);
      const beep = await uploadFile(owner, projectId, beepFile, 'audio', 'audio/wav', log);
      const QC = 12;
      const GAP = { start: 5, end: 6.2 };
      let qc = addAudioBed(emptyTimeline('16:9', 24), audio.id, QC, 'Song bed', { songId: 'song-qc', sourceDuration: songSec });
      qc = { ...qc, clips: qc.clips.map((c) => (c.songId === 'song-qc' ? { ...c, volume: 0.3 } : c)) };
      const qv = qc.tracks.find((t) => t.kind === 'video')!.id;
      qc = addClip(qc, makeClip({ trackId: qv, kind: 'video', start: 0, duration: GAP.start, assetId: videoId, sourceDuration: videoSec, label: 'Singer A', useSourceAudio: false }));
      qc = addClip(qc, makeClip({ trackId: qv, kind: 'video', start: GAP.end, duration: Math.min(QC - GAP.end, videoSec - 1.5), inPoint: 1.5, assetId: videoId, sourceDuration: videoSec, label: 'Singer B', useSourceAudio: false }));
      const fx = qc.tracks.filter((t) => t.kind === 'audio').at(-1)!.id;
      qc = addClip(qc, makeClip({ trackId: fx, kind: 'audio', start: 9, duration: 0.6, assetId: beep.id, sourceDuration: 0.6, label: 'Beep', volume: 2, useSourceAudio: false }));
      qc = applyLyricCaptions(qc, 'song-qc', sheet, 'line');
      // No lyric over the black gap (text would stop the picture reading as black).
      qc = { ...qc, clips: qc.clips.filter((c) => !(c.lyric && c.start < GAP.end + 0.1 && c.start + c.duration > GAP.start - 0.1)) };
      expect(qc.clips.filter((c) => c.lyric).length).toBeGreaterThan(0);
      await saveTimeline(projectId, owner.uid, 'qc', 'Final inspection test', qc);
      const flawed = await render(owner, projectId, 'qc', 'youtube_16x9', 'draft', { inspect: true, acceptLyricSync: true }, dir, log);
      const fi = await finalInspection(projectId, flawed.renderId, log);
      for (const f of fi.findings) log(`  ${f.check}/${f.severity} ${f.fix ? `[fix: ${f.fix.type}]` : '[manual]'} ${f.message}`);
      const black = fi.findings.find((f) => f.check === 'black_frames');
      const loud = fi.findings.find((f) => f.check === 'audio_clipping' && f.clipIds.some((id) => qc.clips.find((c) => c.id === id)?.label === 'Beep'));
      const cropped = fi.findings.find((f) => f.check === 'lyric_cropped' && f.severity === 'error');
      expect(black).toMatchObject({ severity: 'error', fix: { type: 'close_gap' } });
      expect(loud?.fix).toMatchObject({ type: 'reduce_gain' });
      expect(loud?.severity).toBe('error');
      expect(cropped?.fix).toMatchObject({ type: 'fit_lyric_style' });
      expect(fi.readiness).toBe('blocked');
      // Export is refused while it is blocked (server-side), allowed once overridden with a note.
      const blockedMsg = await actions.exportBlock(flawed.storagePath);
      const urls = await actions.mediaUrls(owner, payload('mediaUrls', { assetIds: [flawed.assetId], variants: ['file'], download: true }));
      log(`export gate: ${blockedMsg}; download URL ${urls.urls[flawed.assetId]?.file ? 'issued' : `refused (${urls.urls[flawed.assetId]?.blocked})`}`);
      expect(blockedMsg).toBeTruthy();
      expect(urls.urls[flawed.assetId]?.file).toBeUndefined();
      const overridden = await studio.finalInspectionAction(owner, payload('finalInspectionAction', { projectId, inspectionId: fi.id, action: 'override', note: 'QA: approved for internal review only' }));
      expect(overridden.readiness).toBe('overridden');
      expect(await actions.exportBlock(flawed.storagePath)).toBeNull();
      await studio.finalInspectionAction(owner, payload('finalInspectionAction', { projectId, inspectionId: fi.id, action: 'clear_override' }));
      expect(await actions.exportBlock(flawed.storagePath)).toBeTruthy();
      // The automatic fixes change the timeline and the lyric style; the film is rendered and inspected again.
      const fixed = await studio.finalInspectionAction(owner, payload('finalInspectionAction', { projectId, inspectionId: fi.id, action: 'apply_all_fixes' }));
      log(`applied ${fixed.applied.length} fix(es) → timeline v${fixed.timelineVersion}; readiness ${fixed.readiness} until re-rendered`);
      expect(fixed.applied).toEqual(expect.arrayContaining([black!.id, loud!.id, cropped!.id]));
      expect(fixed.readiness).toBe('blocked');
      const style = (await col.sub(projectId, 'lyricStyles').doc(qcStyleId).get()).get('global') as LyricStyle;
      log(`fitted style for 16:9: ${JSON.stringify(style.aspects['16:9'])}`);
      expect(style.aspects['16:9']?.fontSizePct).toBeLessThan(11);
      const rerender = await render(owner, projectId, 'qc', 'youtube_16x9', 'draft', { inspect: true, acceptLyricSync: true }, dir, log);
      const fi2 = await finalInspection(projectId, rerender.renderId, log);
      for (const f of fi2.findings) log(`  after fixes: ${f.check}/${f.severity} ${f.message}`);
      expect(fi2.findings.filter((f) => f.check === 'black_frames')).toEqual([]);
      expect(fi2.findings.filter((f) => f.check === 'audio_clipping' && f.severity === 'error')).toEqual([]);
      expect(fi2.findings.filter((f) => f.check === 'lyric_cropped' && f.severity === 'error')).toEqual([]);
      results.finalInspection = {
        flawed: { renderId: flawed.renderId, readiness: fi.readiness, score: fi.score, findings: fi.findings.map((f) => ({ check: f.check, severity: f.severity, fix: f.fix?.type ?? null, message: f.message })), exportBlock: blockedMsg },
        applied: fixed.applied.length,
        rerendered: { renderId: rerender.renderId, readiness: fi2.readiness, score: fi2.score, findings: fi2.findings.map((f) => ({ check: f.check, severity: f.severity, message: f.message })) },
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
      save({ projectId, ...results });
    }
  });
});
