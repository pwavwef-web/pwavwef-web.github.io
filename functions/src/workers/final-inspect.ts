import { spawn } from 'node:child_process';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Part } from '@google/genai';
import {
  blackFindings,
  creditsFindings,
  dialogueMaskingFindings,
  EXPORT_PRESETS,
  exportReadiness,
  finalScore,
  finding,
  formatFindings,
  frozenFindings,
  loudnessFindings,
  loudSpikes,
  lyricLayoutFindings,
  missingMediaFindings,
  musicRestartFindings,
  ocrCropFinding,
  privateInfoFindings,
  round1,
  silenceFindings,
  structureFindings,
  FINAL_CHECKS,
  type Clip,
  type FinalCheck,
  type FinalFinding,
  type FinalInspectionDoc,
  type JobDoc,
  type RenderDoc,
  type ShotDoc,
  type TimelineState,
} from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { transcribe } from '../lib/audio-models';
import { withTmpDir } from '../lib/assets';
import { bucket, col, db, FieldValue, gsUri } from '../lib/firebase';
import { fail } from '../lib/errors';
import { sampleFrames, temporalMeasurements } from '../lib/frames';
import { logInteraction } from '../lib/interactions';
import { FFMPEG, probe } from '../lib/media';
import { progress, transition } from '../lib/jobs';
import { blackSegments, extractSpeechAudio, loudnessStats, momentaryLoudness, silentSpans } from '../lib/signal';
import { recordUsage } from '../lib/usage';
import { annotateFrames } from '../lib/vision';
import { callReasoning, usageFor } from './text';
import { FINAL_REVIEW_SCHEMA } from './text-tasks';

interface FinalParams {
  renderId: string;
  timelineId: string;
  output: { assetId: string; storagePath: string; width: number | null; height: number | null; durationSec: number };
}

type RenderWithSnapshot = RenderDoc & {
  snapshot?: { tracks: TimelineState['tracks']; clips: Clip[]; aspectRatio: TimelineState['aspectRatio']; fps: number };
  textLayout?: { issues?: { lineId: string; kind: string; message: string; clipId?: string | null; start?: number | null }[]; credits?: { clipId: string; name: string; finishesAt: number; issues: string[] }[] } | null;
};

const clipEnd = (c: Clip) => c.start + c.duration;

/** Moments where the decoded stereo signal reaches near full scale (s, dBFS). */
async function peakMoments(input: string, thresholdDb = -0.5): Promise<{ t: number; db: number }[]> {
  const rate = 24000;
  const pcm = await new Promise<Buffer>((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', input, '-vn', '-ac', '2', '-ar', String(rate), '-f', 'f32le', 'pipe:1']);
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.on('error', reject);
    p.on('close', () => resolve(Buffer.concat(chunks)));
  });
  const f = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength - (pcm.byteLength % 4)));
  const win = Math.round(rate * 0.1) * 2;
  const limit = 10 ** (thresholdDb / 20);
  const out: { t: number; db: number }[] = [];
  for (let i = 0; i < f.length; i += win) {
    let m = 0;
    for (let k = i; k < Math.min(f.length, i + win); k++) m = Math.max(m, Math.abs(f[k]!));
    if (m >= limit) out.push({ t: Math.round((i / 2 / rate) * 100) / 100, db: Math.round(20 * Math.log10(m) * 10) / 10 });
  }
  return out;
}

function dialogueSpans(words: { start: number; end: number }[]): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    const last = spans[spans.length - 1];
    if (last && w.start - last.end < 0.8) last.end = Math.max(last.end, w.end);
    else spans.push({ start: w.start, end: w.end });
  }
  return spans;
}

/**
 * Final-film inspection of a finished render: format, structure against the approved shot list,
 * black/frozen/corrupted frames, peaks, loudness, silences, music restarts, dialogue masking, text
 * layout (lyrics and credits), OCR of the frames (cropped captions, private information) and a model
 * review of the cuts and the ending. Export stays blocked until errors are fixed or overridden.
 */
export async function runFinalInspectJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as FinalParams;
  if (!job.projectId) fail('invalid_request', 'Final inspection needs a project.');
  if (!(await transition(job.id, 'generating', { stage: 'Measuring the finished film', progress: 0.05, lease: { until: Date.now() + 28 * 60_000 } }))) return;
  const started = Date.now();
  const usage = { uid: job.ownerUid, projectId: job.projectId, jobId: job.id };
  const renderRef = col.renders().doc(p.renderId);
  const render = { ...((await renderRef.get()).data() as RenderWithSnapshot), id: p.renderId };
  const state: Pick<TimelineState, 'clips' | 'tracks'> = { clips: render.snapshot?.clips ?? [], tracks: render.snapshot?.tracks ?? [] };
  const inspRef = col.sub(job.projectId!, 'finalInspections').doc(p.renderId);
  const base: Omit<FinalInspectionDoc, 'id'> = { projectId: job.projectId!, timelineId: p.timelineId, timelineVersion: render.timelineVersion, renderId: p.renderId, renderAssetId: p.output.assetId, jobId: job.id, status: 'running', findings: [], score: null, errors: 0, warnings: 0, readiness: 'blocked', override: null, measurements: {}, summary: '' };
  await inspRef.set({ ...base, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  await renderRef.set({ finalInspection: { id: p.renderId, status: 'running', readiness: null, score: null, errors: 0, warnings: 0 } }, { merge: true });

  try {
    const m = await withTmpDir(async (dir) => {
      const local = path.join(dir, 'film.mp4');
      await bucket.file(p.output.storagePath).download({ destination: local });
      const info = await probe(local);
      const D = info.durationSec ?? p.output.durationSec;
      await progress(job.id, 'Measuring black and frozen frames, peaks, loudness and silences', 0.15);
      const [black, temporal, loud, silences, peaks, momentary] = await Promise.all([
        blackSegments(local).catch(() => []),
        temporalMeasurements(local).catch(() => null),
        loudnessStats(local),
        info.hasAudio ? silentSpans(local, -50, 2).catch(() => []) : Promise.resolve([]),
        info.hasAudio ? peakMoments(local).catch(() => []) : Promise.resolve([]),
        info.hasAudio ? momentaryLoudness(local).catch(() => []) : Promise.resolve([]),
      ]);
      let words: { text: string; start: number; end: number }[] = [];
      if (info.hasAudio) {
        await progress(job.id, 'Transcribing the dialogue', 0.3);
        const flac = path.join(dir, 'speech.flac');
        await extractSpeechAudio(local, flac);
        const project = (await col.projects().doc(job.projectId!).get()).data() as { language?: string } | undefined;
        const tr = await transcribe({ data: await readFile(flac), mimeType: 'audio/flac', languageCode: project?.language ?? null, vocabulary: [] });
        await recordUsage({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: tr.modelId, kind: 'transcription', inputTokens: tr.usage.input, outputTokens: tr.usage.output, thoughtTokens: tr.usage.thoughts });
        words = tr.words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
      }
      await progress(job.id, 'Reading text in the frames', 0.45);
      const fps = Math.min(1, 90 / Math.max(1, D));
      const frames = await sampleFrames(local, { durationSec: D, fps, width: 1280, srcWidth: info.width, srcHeight: info.height, max: 90 });
      // Frames at the middle of every text clip too (captions, lyrics, titles), so a cropped line is read.
      const textClips = state.clips.filter((c) => (c.kind === 'caption' || c.kind === 'title' || c.lyric) && c.text.trim()).slice(0, 40);
      const extra = [];
      for (const c of textClips) {
        const t = c.start + Math.min(c.duration / 2, 1.2);
        if (frames.some((f) => Math.abs(f.t - t) < 0.3)) continue;
        const one = await sampleFrames(local, { durationSec: D, fps: 1, width: 1280, srcWidth: info.width, srcHeight: info.height, from: t, to: Math.min(D, t + 0.5), max: 1 });
        if (one[0]) extra.push({ ...one[0], t });
      }
      const annotated = await annotateFrames({ frames: [...frames, ...extra], features: ['TEXT_DETECTION'], usage });
      return { D, info, black, temporal, loud, silences, peaks, spikes: loudSpikes(momentary), words, ocr: annotated.map((a) => ({ t: a.t, text: a.fullText })) };
    });

    const findings: FinalFinding[] = [];
    // Format and structure.
    findings.push(...formatFindings({ width: m.info.width ?? 0, height: m.info.height ?? 0, durationSec: m.D, hasAudio: m.info.hasAudio }, { width: render.width, height: render.height, durationSec: render.durationSec }));
    const shots = (await col.projects().doc(job.projectId!).collection('shots').orderBy('order', 'asc').get()).docs.map((d) => ({ ...(d.data() as ShotDoc), id: d.id }));
    findings.push(...structureFindings(state, shots.map((s) => ({ id: s.id, number: s.number, title: s.title, order: s.order, approvedTakeId: s.approvedTakeId, sceneId: s.sceneId }))));
    const ids = [...new Set(state.clips.map((c) => c.assetId).filter((x): x is string => Boolean(x)))];
    const snaps = ids.length ? await db.getAll(...ids.map((id) => col.assets().doc(id))) : [];
    findings.push(...missingMediaFindings(state, new Set(snaps.filter((s) => s.exists && s.get('status') === 'ready').map((s) => s.id))));
    // Picture.
    findings.push(...blackFindings(m.black, state));
    if (m.temporal) {
      findings.push(...frozenFindings(m.temporal.frozen, state));
      if (m.temporal.decodeErrors > 0) findings.push(finding('corrupted_frames', m.temporal.decodeErrors > 3 ? 'error' : 'warning', `${m.temporal.decodeErrors} frame(s) failed to decode in the export.`, 'measured'));
    }
    // Sound.
    findings.push(...loudnessFindings({ integratedLufs: m.loud.integratedLufs, truePeakDb: m.loud.truePeakDb, peaks: m.peaks, spikes: m.spikes }, state));
    findings.push(...silenceFindings(m.silences, state));
    findings.push(...musicRestartFindings(state));
    findings.push(...dialogueMaskingFindings(state, dialogueSpans(m.words)));
    // Text: layout issues recorded by the renderer (real font metrics), credits, OCR.
    findings.push(...lyricLayoutFindings(render.textLayout?.issues ?? [], { clips: state.clips, aspect: EXPORT_PRESETS[render.preset as keyof typeof EXPORT_PRESETS]?.aspect ?? null }));
    findings.push(...creditsFindings(render.textLayout?.credits ?? [], m.D));
    for (const c of state.clips.filter((x) => (x.kind === 'caption' || x.kind === 'title' || x.lyric) && x.text.trim())) {
      const at = c.start + Math.min(c.duration / 2, 1.2);
      const frame = m.ocr.reduce<{ t: number; text: string } | null>((best, f) => (Math.abs(f.t - at) < 0.35 && (!best || Math.abs(f.t - at) < Math.abs(best.t - at)) ? f : best), null);
      const f = frame ? ocrCropFinding(c.text.replace(/\s+/g, ' ').slice(0, 120), frame.text, at, c.id) : null;
      if (f) findings.push(f);
    }
    const allowed = (await col.projects().doc(job.projectId!).get()).get('allowedOnScreenText') as string[] | undefined;
    findings.push(...privateInfoFindings(m.ocr, allowed ?? []));

    // Model review of the cuts and the ending.
    await progress(job.id, 'Reviewing the cuts and the ending', 0.65);
    const cuts = [...new Set(state.clips.filter((c) => state.tracks.find((t) => t.id === c.trackId)?.kind === 'video').map((c) => round1(c.start)).filter((t) => t > 0.2))].sort((a, b) => a - b);
    const parts: Part[] = [
      { fileData: { fileUri: gsUri(p.output.storagePath), mimeType: 'video/mp4' }, videoMetadata: { fps: m.D <= 180 ? 1 : 0.5 } },
      {
        text: [
          'FINAL FILM REVIEW — this is the finished export of a film edited from separately generated shots.',
          `Length ${round1(m.D)} s. Cuts between clips at: ${cuts.slice(0, 80).join(', ') || 'none'} s.`,
          'Check each cut for continuity breaks between shots (costume, props, positions, screen direction, lighting), jarring colour jumps inside a scene, and abrupt cuts that chop a line or an action. Check that the film ends on a complete moment (the final action and line finish), that no text or caption is cut off at the frame edge, that lyrics or titles do not sit over faces, that credits finish before the end, that dialogue is not drowned by music, and that there is no unexpected visible logo or watermark, or readable private information.',
          'Report only real problems you can see or hear, with times. Measured checks (black frames, loudness, peaks, silence, OCR) are run separately — do not guess at those.',
        ].join('\n'),
      },
    ];
    const r = await callReasoning(parts, { systemInstruction: 'You are the final quality-control editor before a film is delivered. Return only JSON matching the schema.', responseJsonSchema: FINAL_REVIEW_SCHEMA }, 'MEDIUM');
    await usageFor(job, r, 'text', false);
    await logInteraction({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: r.modelId, api: 'generateContent', request: { task: 'final_film_review', durationSec: m.D, cuts: cuts.length }, response: { usage: r.res.usageMetadata ?? null }, latencyMs: r.latencyMs });
    const review = (r.json ?? {}) as { summary?: string; findings?: { check?: string; severity?: string; startSec?: number; endSec?: number; message?: string }[]; endingComplete?: boolean };
    for (const x of review.findings ?? []) {
      if (!(FINAL_CHECKS as readonly string[]).includes(String(x.check)) || !x.message) continue;
      const at = typeof x.startSec === 'number' && x.startSec >= 0 ? x.startSec : null;
      const clipIds = at === null ? [] : state.clips.filter((c) => at >= c.start && at < clipEnd(c)).map((c) => c.id);
      findings.push(finding(x.check as FinalCheck, x.severity === 'error' ? 'error' : x.severity === 'info' ? 'info' : 'warning', x.message.slice(0, 400), 'model', { startSec: at, endSec: typeof x.endSec === 'number' && x.endSec >= 0 ? x.endSec : null, clipIds }));
    }
    if (review.endingComplete === false && !findings.some((f) => f.check === 'incomplete_final_action')) findings.push(finding('incomplete_final_action', 'warning', 'The film does not end on a complete moment.', 'model', { startSec: Math.max(0, m.D - 3) }));

    const score = finalScore(findings);
    const readiness = exportReadiness(findings, null);
    const errors = findings.filter((f) => f.severity === 'error').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const measurements = { durationSec: m.D, width: m.info.width, height: m.info.height, hasAudio: m.info.hasAudio, integratedLufs: m.loud.integratedLufs, truePeakDb: m.loud.truePeakDb, lra: m.loud.lra, blackSegments: m.black.slice(0, 50), frozen: m.temporal?.frozen.slice(0, 50) ?? [], decodeErrors: m.temporal?.decodeErrors ?? null, silences: m.silences.slice(0, 50), peaks: m.peaks.slice(0, 50), loudSpikes: m.spikes.slice(0, 20), dialogueWords: m.words.length, ocrFrames: m.ocr.length, modelIds: { review: r.modelId, transcription: MODEL_REGISTRY.transcription.id, vision: MODEL_REGISTRY.vision.id } };
    const summary = review.summary?.slice(0, 1500) || (errors ? `${errors} error(s) must be fixed or overridden before export.` : 'Ready to export.');
    await inspRef.set({ status: 'completed', findings, score, errors, warnings, readiness, measurements, summary, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await renderRef.set({ finalInspection: { id: p.renderId, status: 'completed', readiness, score, errors, warnings } }, { merge: true });
    await transition(job.id, 'completed', { stage: `${readiness === 'ready' ? 'Ready to export' : 'Export blocked'} · ${score}/100 · ${errors} error(s), ${warnings} warning(s)`, result: { text: summary, data: { inspectionId: p.renderId, readiness, score, errors, warnings, ms: Date.now() - started } } });
  } catch (e) {
    await inspRef.set({ status: 'failed', summary: String((e as Error)?.message ?? e).slice(0, 500), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await renderRef.set({ finalInspection: { id: p.renderId, status: 'failed', readiness: 'blocked', score: null, errors: 0, warnings: 0 } }, { merge: true });
    throw e;
  }
}
