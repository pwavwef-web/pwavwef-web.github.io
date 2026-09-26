import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Part } from '@google/genai';
import {
  frozenOutsideBlack,
  analyzeDialogue,
  compareStates,
  detectedToState,
  evaluateQuality,
  normalizeDirectorReview,
  PROBLEM_CATEGORIES,
  REPAIR_TYPES,
  round1,
  textOrientation,
  textSimilarity,
  tokenize,
  trackDirection,
  type ColourMeasurements,
  type ContinuitySnapshotDoc,
  type ContinuityState,
  type ContinuityWarning,
  type EditorialWindow,
  type ExpectedScene,
  type InspectionExpectations,
  type JobDoc,
  type Measurements,
  type ModelReview,
  type ProblemSeverity,
  type QualityReportDoc,
  type QualityReviewDoc,
  type QualitySettings,
  type Rgb,
  type TemporalMeasurements,
  type VisionFrame,
  type VisionMeasurements,
} from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { transcribe } from '../lib/audio-models';
import { withTmpDir } from '../lib/assets';
import { recordInspection } from '../lib/continuity';
import { bucket, col, FieldValue, gsUri } from '../lib/firebase';
import { fail } from '../lib/errors';
import { flipJpeg, regionMean, rgbStats, sampleFrames, temporalMeasurements, toColourStats, type SampledFrame } from '../lib/frames';
import { logInteraction } from '../lib/interactions';
import { probe } from '../lib/media';
import { progress, transition } from '../lib/jobs';
import { audioMeasurements, decodeMono, extractSpeechAudio, integratedLoudness, lastFrameJpeg, visualMeasurements } from '../lib/signal';
import { schemaErrors } from '../lib/schema-check';
import { recordUsage } from '../lib/usage';
import { annotateFrames, type AnnotatedFrame } from '../lib/vision';
import { callReasoning, usageFor, type ReasoningResult } from './text';
import { DIRECTOR_REVIEW_SCHEMA, REVIEW_SCHEMA } from './text-tasks';

export interface InspectReference {
  assetId: string;
  storagePath: string;
  mimeType: string;
  label: string;
}

/** What the Continuity Director expects in this shot (from the production's compiled continuity). */
export interface InspectContinuity {
  shotId: string;
  expectations: InspectionExpectations;
  names: { characters: Record<string, string>; props: Record<string, string> };
  /** Final frame of the previous approved shot of the same scene (first-frame and colour continuity). */
  previousFrame: { storagePath: string; title: string } | null;
  sameScenePrevious: boolean;
}

export interface InspectParams {
  productionId: string;
  versionId: string;
  versionIndex?: number;
  assetId: string;
  storagePath: string;
  takeRef: { shotId: string; takeId: string } | null;
  expected: ExpectedScene;
  plan: { requiredSec: number | null; plannedSec: number | null; plannedCuts: number[]; editorialCuts?: EditorialWindow[] };
  settings: QualitySettings;
  waivedCategories: string[];
  references: InspectReference[];
  previousShot: { storagePath: string; title: string } | null;
  label: string;
  continuity?: InspectContinuity | null;
}

const SEVERITIES: ProblemSeverity[] = ['minor', 'major', 'critical'];
const t = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const b = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const sev = (v: unknown): ProblemSeverity => (SEVERITIES.includes(v as ProblemSeverity) ? (v as ProblemSeverity) : 'minor');
const score = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

function region(v: unknown): { x: number; y: number; w: number; h: number } | null {
  const r = (v ?? {}) as Record<string, unknown>;
  const [x, y, w, h] = [r.x, r.y, r.w, r.h].map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : NaN)) as [number, number, number, number];
  if ([x, y, w, h].some((n) => Number.isNaN(n)) || w <= 0.01 || h <= 0.01 || x < 0 || y < 0 || x + w > 1.001 || y + h > 1.001) return null;
  return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, w: Math.round(w * 1000) / 1000, h: Math.round(h * 1000) / 1000 };
}

/** Defensive normalisation of the model's structured review (missing fields get neutral values). */
export function normalizeReview(raw: unknown): ModelReview {
  const r = (raw ?? {}) as Record<string, unknown>;
  const arr = (k: string) => (Array.isArray(r[k]) ? (r[k] as Record<string, unknown>[]) : []);
  const o = (k: string) => (r[k] && typeof r[k] === 'object' ? (r[k] as Record<string, unknown>) : {});
  const sc = o('scores');
  const rr = o('recommendedRepair');
  const repairType = s(rr.type);
  return {
    summary: s(r.summary).slice(0, 1200),
    speakerAttribution: arr('speakerAttribution').map((a) => ({ lineIndex: Number(a.lineIndex) || 0, expectedCharacter: s(a.expectedCharacter), deliveredBy: s(a.deliveredBy), correct: b(a.correct, true), note: s(a.note) })),
    lipSync: { applicable: b(o('lipSync').applicable, false), drift: (['none', 'minor', 'severe'].includes(s(o('lipSync').drift)) ? s(o('lipSync').drift) : 'none') as ModelReview['lipSync']['drift'], note: s(o('lipSync').note) },
    performanceFinished: b(r.performanceFinished, true),
    dialogueOverMusic: (['clear', 'music_loud', 'music_overpowering', 'not_applicable'].includes(s(r.dialogueOverMusic)) ? s(r.dialogueOverMusic) : 'clear') as ModelReview['dialogueOverMusic'],
    abruptCutDuringSpeech: b(r.abruptCutDuringSpeech, false),
    actions: arr('actions').map((a) => ({ beat: s(a.beat), completed: b(a.completed, true), startSec: t(a.startSec), endSec: t(a.endSec), note: s(a.note) })),
    actionComplete: b(r.actionComplete, true),
    unfinishedMovementAtEnd: b(r.unfinishedMovementAtEnd, false),
    continuity: arr('continuity').map((c) => ({ aspect: s(c.aspect), ok: b(c.ok, true), severity: (['none', ...SEVERITIES].includes(s(c.severity)) ? s(c.severity) : 'none') as 'none' | ProblemSeverity, note: s(c.note) })),
    cameraMatchesDirection: b(r.cameraMatchesDirection, true),
    screenDirectionConsistent: b(r.screenDirectionConsistent, true),
    emotionalPerformanceMatches: b(r.emotionalPerformanceMatches, true),
    renderedText: { present: b(o('renderedText').present, false), acceptable: b(o('renderedText').acceptable, true), note: s(o('renderedText').note) },
    artefacts: arr('artefacts').map((a) => ({ description: s(a.description), severity: sev(a.severity), startSec: t(a.startSec), endSec: t(a.endSec), region: region(a.region) })),
    suddenDisappearance: b(r.suddenDisappearance, false),
    accidentalSceneChange: b(r.accidentalSceneChange, false),
    firstFrame: { quality: (['good', 'acceptable', 'poor'].includes(s(o('firstFrame').quality)) ? s(o('firstFrame').quality) : 'good') as 'good', note: s(o('firstFrame').note) },
    lastFrame: { quality: (['good', 'acceptable', 'poor'].includes(s(o('lastFrame').quality)) ? s(o('lastFrame').quality) : 'good') as 'good', note: s(o('lastFrame').note) },
    scores: {
      actionCompleteness: score(sc.actionCompleteness, 70),
      visualAccuracy: score(sc.visualAccuracy, 70),
      characterContinuity: typeof sc.characterContinuity === 'number' && sc.characterContinuity >= 0 ? sc.characterContinuity : null,
      audioQuality: score(sc.audioQuality, 70),
      storyContinuity: score(sc.storyContinuity, 70),
      overallUsability: score(sc.overallUsability, 70),
    },
    problems: arr('problems').map((p) => ({ category: s(p.category), severity: sev(p.severity), startSec: t(p.startSec), endSec: t(p.endSec), description: s(p.description) })),
    recommendedRepair: repairType && repairType !== 'none' && (REPAIR_TYPES as readonly string[]).includes(repairType) ? { type: repairType, instruction: s(rr.instruction), sectionStartSec: t(rr.sectionStartSec), sectionEndSec: t(rr.sectionEndSec), rationale: s(rr.rationale) } : null,
  };
}

const INSPECTOR_SYSTEM =
  'You are AZ Studio’s quality-control supervisor — script supervisor, continuity supervisor, editor and dialogue mixer in one. You watch and listen to a generated film shot and judge whether it can go into the film. ' +
  'Be strict, specific and fair: report only problems you can actually see or hear, give times in seconds from the start of the clip, and never invent issues. Compare faces, costumes, props and the set against the reference images. Return only JSON matching the schema.';

// ---------------------------------------------------------------------------
// Measurements the reviewer is shown (and the verdict uses directly)
// ---------------------------------------------------------------------------

/** Mean colour of the central part of the most confident face (skin tone), if a face is visible. */
async function skinOf(frame: { jpeg: Buffer } | null, annotated: Pick<VisionFrame, 'faces'> | null): Promise<Rgb | null> {
  const face = annotated?.faces.filter((f) => f.confidence >= 0.6).sort((a, c) => c.box.w * c.box.h - a.box.w * a.box.h)[0];
  if (!frame || !face || face.box.w < 0.04) return null;
  const box = { x: face.box.x + face.box.w * 0.25, y: face.box.y + face.box.h * 0.3, w: face.box.w * 0.5, h: face.box.h * 0.45 };
  return regionMean(frame.jpeg, box).catch(() => null);
}

/** Frames stored with the report: compact (no pixels, limited text). */
function compactFrames(frames: AnnotatedFrame[]): VisionFrame[] {
  return frames.map((f) => ({ t: f.t, faces: f.faces.slice(0, 8), people: f.people.slice(0, 8), objects: f.objects.slice(0, 10), text: f.text.slice(0, 12).map((x) => ({ text: x.text.slice(0, 80), box: x.box })) }));
}

/** One OCR verdict per protected screen: the frame where its text is most legible, as filmed and mirrored. */
function screenReadings(expect: InspectionExpectations, frames: AnnotatedFrame[], flipped: Map<number, string>): VisionMeasurements['screenText'] {
  const out: VisionMeasurements['screenText'] = [];
  for (const sc of expect.screens) {
    if (!sc.expectedText.trim()) continue;
    let best: { t: number; normal: string; flipped: string; legibility: number } | null = null;
    for (const f of frames) {
      if (!flipped.has(f.t)) continue;
      const fl = flipped.get(f.t) ?? '';
      const o = textOrientation(sc.expectedText, f.fullText, fl);
      const legibility = Math.max(o.normal, o.flipped);
      if (!best || legibility > best.legibility) best = { t: f.t, normal: f.fullText.slice(0, 400), flipped: fl.slice(0, 400), legibility };
    }
    if (best) out.push({ screenId: sc.id, expected: sc.expectedText, t: best.t, normal: best.normal, flipped: best.flipped });
  }
  return out;
}

function visionSummary(frames: AnnotatedFrame[], expect: InspectionExpectations | null): string {
  if (!frames.length) return '';
  const faces = frames.map((f) => `${round1(f.t)}s:${f.faces.filter((x) => x.confidence >= 0.5).length}`).join(' ');
  const people = frames.map((f) => f.people.filter((x) => x.score >= 0.5).length);
  const words = [...new Set(frames.flatMap((f) => f.fullText.split(/\s+/)).filter((w) => w.length > 1))].slice(0, 40);
  const travel = trackDirection(frames);
  return [
    `Measured by frame analysis (Cloud Vision, ${frames.length} sampled frames): faces per frame ${faces}; people per frame min ${Math.min(...people)} / max ${Math.max(...people)}.`,
    travel.samples >= 3 ? `Tracked main subject travel: ${travel.direction.replace(/_/g, ' ')} (Δx ${travel.dx}).` : '',
    words.length ? `Text read in the frames: ${words.join(' ')}` : 'No readable text detected in the frames.',
    expect?.screens.length ? 'Mirrored writing is also checked by reading each protected surface in horizontally flipped frames.' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function continuityBrief(c: InspectContinuity | null | undefined, e: ExpectedScene): string[] {
  if (!c) return [];
  const x = c.expectations;
  const lines: string[] = ['', 'CONTINUITY DIRECTOR CHECKS'];
  if (x.characters.length) lines.push(`Characters who must appear: ${x.characters.map((ch) => `${ch.name}${ch.speaking ? ' (speaks)' : ''}${ch.mustShowFace ? ' — face must stay visible' : ''}`).join('; ')}. Expected number of people: ${x.characters.length}.`);
  if (x.travel.length) lines.push(`Established screen direction: ${x.travel.map((tr) => `${tr.name} travels ${tr.direction.replace(/_/g, ' ')}`).join('; ')}.`);
  if (x.screens.length) lines.push(`Protected surfaces (writing must read exactly and never mirrored${x.screens.some((sc) => sc.mayMirror) ? ', except where noted' : ''}): ${x.screens.map((sc) => `“${sc.name}” must read “${sc.expectedText || '(approved graphic)'}”${sc.mayMirror ? ' (may appear mirrored: seen in a mirror)' : ''}${sc.composite ? ' (its content is composited after generation)' : ''}`).join('; ')}.`);
  if (x.intentionalLook) lines.push('This shot has an intentionally different look; do not report its colour or lighting as a continuity fault.');
  const open = x.planWarnings.filter((w) => w.status === 'open' && w.severity !== 'info');
  if (open.length) lines.push(`Watch especially: ${open.map((w) => w.message).join(' ')}`);
  if (c.previousFrame) lines.push(`The last reference image is the final frame of the previous approved shot (${c.previousFrame.title}); judge whether this shot’s first frame continues from it (edges.firstFrameContinues).`);
  lines.push(
    'Fill every continuity section: characters (identity against the approved references), background (only aspects that differ from the canonical set views), blocking, direction, text (every visible writing), props (hands and states), temporal (frame-level faults with times), edges (first and last second), detectedState (what is actually on screen in the FINAL frames: who holds what in which hand, costume, posture, screen side, prop states, environment, travel), and categoryScores (0–100 each, -1 when not applicable).',
  );
  if (e.props.length) lines.push(`Props to track: ${e.props.join(', ')}.`);
  return lines;
}

function brief(p: InspectParams, durationSec: number, words: { text: string; start: number; end: number }[], dialogueSummary: string, measuredSummary: string): string {
  const e = p.expected;
  const lines = e.lines.length ? e.lines.map((l) => `  ${l.index}. ${l.character || 'UNKNOWN'}: "${l.text}"`).join('\n') : '  (none — no one should speak in this shot)';
  const transcript = words.length ? words.map((w) => `[${w.start.toFixed(2)}–${w.end.toFixed(2)}] ${w.text}`).join(' ') : '(no speech detected)';
  const refs = p.references.map((r, i) => `  Image ${i + 1}: ${r.label}`).join('\n');
  const music =
    e.music === 'no_background_music'
      ? 'Films are scored centrally: this shot should carry dialogue, ambience and sound effects only. Background music is a problem only if it covers dialogue.'
      : e.music === 'song_laid_later'
        ? 'Music-video footage: the song is laid over the edit later. No spoken dialogue is expected; judge picture and performance.'
        : 'Judge the sound design as directed.';
  return [
    'QUALITY REVIEW BRIEF',
    `Shot: ${p.label}`,
    `Clip length: ${round1(durationSec)} s${p.plan.plannedSec ? ` (planned ${p.plan.plannedSec} s)` : ''}${p.plan.requiredSec ? `; the scene needs at least ${p.plan.requiredSec} s` : ''}.`,
    `Planned internal cuts (connected shots — intentional, not accidental): ${p.plan.plannedCuts.length ? p.plan.plannedCuts.map((c) => `${round1(c)} s`).join(', ') : 'none (this should be one continuous shot)'}.`,
    (p.plan.editorialCuts ?? []).length
      ? `Optional camera changes the plan allowed (a cut to another angle here is intentional — do not report it as an accidental scene change unless it breaks continuity or cuts someone off; staying on one angle is equally fine and is not a problem): ${p.plan.editorialCuts!.map((w) => `${round1(w.startSec)}–${round1(w.endSec)} s: ${w.direction}`).join(' ')}`
      : '',
    '',
    'Screenplay dialogue — every word must be delivered exactly, in order, by the right character:',
    lines,
    '',
    `Word-timed transcript of the actual audio (speech recognition): ${transcript}`,
    `Measured dialogue check: ${dialogueSummary}`,
    measuredSummary,
    '',
    `Required action (every beat must complete on screen before the end): ${e.action || e.description || '—'}`,
    e.description && e.action ? `Shot description: ${e.description}` : '',
    `Characters: ${e.characters.length ? e.characters.map((c) => `${c.name} — ${c.description || 'no description'}`).join('; ') : 'none specified'}`,
    `Location: ${e.location ? `${e.location.name} — ${e.location.description}` : '—'}; time of day: ${e.location?.timeOfDay || '—'}`,
    `Props: ${e.props.join(', ') || '—'}`,
    `Camera direction: ${e.camera || '—'}`,
    `Screen direction / blocking: ${e.screenDirection || 'keep consistent throughout'}`,
    `Performance: ${e.performance || '—'}; mood: ${e.mood || '—'}; style: ${e.style || '—'}`,
    `Sound: ${music}`,
    refs ? `Reference images (after the video, in order):\n${refs}` : 'No reference images.',
    ...continuityBrief(p.continuity, e),
    '',
    `Problem categories: ${PROBLEM_CATEGORIES.join(', ')}.`,
    'Scores are 0–100 (90+ excellent, 75 usable, below 60 not usable). characterContinuity is -1 when no recurring character appears. Use -1 for any time that does not apply.',
    'For every line, say who actually delivers it. Decompose the required action into beats and say whether each completes, and when. Check the first and last frames, text rendered in the frame, warped hands/faces or other artefacts (give the frame region of an artefact when it is local), sudden disappearance, and whether any movement or speech is still unfinished at the very end.',
    'Recommend the least destructive repair: trim_ending when unwanted material follows a completed moment; extend_scene when the ending is cut short; conversational_edit for picture-only fixes that keep the timing; replace_background when only the set drifts; correct_blocking for occlusion, merging or wrong positions; correct_direction for reversed screen direction; regenerate_with_references for identity or costume drift; cutaway for a short local picture fault under good dialogue; regenerate_longer when dialogue is missing, altered or rushed; none when nothing needs fixing.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export async function runInspectJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as InspectParams;
  if (!job.projectId) fail('invalid_request', 'Inspection needs a project.');
  if (!(await transition(job.id, 'generating', { stage: 'Measuring the scene', progress: 0.08, lease: { until: Date.now() + 20 * 60_000 } }))) return;
  const started = Date.now();
  const e = p.expected;
  const c = p.continuity ?? null;
  const vocabulary = [...new Set([...e.characters.map((ch) => ch.name), ...e.lines.flatMap((l) => tokenize(l.text).map((w) => w.raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter((w) => /^\p{Lu}/u.test(w) || /[^\x20-\x7e]/.test(w)))])].slice(0, 100);
  const usage = { uid: job.ownerUid, projectId: job.projectId, jobId: job.id };

  const measured = await withTmpDir(async (dir) => {
    const local = path.join(dir, 'version.mp4');
    await bucket.file(p.storagePath).download({ destination: local });
    const info = await probe(local);
    const durationSec = info.durationSec ?? 0;
    if (!info.hasVideo || durationSec <= 0) fail('invalid_media', 'The version has no readable video stream.');
    let words: { text: string; start: number; end: number }[] = [];
    let transcriptText = '';
    let languageCode: string | null = null;
    let audio: Measurements['audio'] = null;
    let endRatio = 0;
    if (info.hasAudio) {
      const flac = path.join(dir, 'speech.flac');
      await extractSpeechAudio(local, flac);
      const samples = await decodeMono(local, 16000);
      const am = audioMeasurements(samples, 16000);
      endRatio = am.endRatio;
      audio = { peakDbfs: am.peakDbfs, clippedRatio: am.clippedRatio, endLevelDb: am.endLevelDb, speechAtEnd: false, integratedLufs: await integratedLoudness(local) };
      await progress(job.id, 'Transcribing the dialogue with word timing', 0.18);
      const tr = await transcribe({ data: await readFile(flac), mimeType: 'audio/flac', languageCode: e.language, vocabulary });
      await recordUsage({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: tr.modelId, kind: 'transcription', inputTokens: tr.usage.input, outputTokens: tr.usage.output, thoughtTokens: tr.usage.thoughts });
      words = tr.words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
      transcriptText = tr.text;
      languageCode = tr.languageCode;
    }
    await progress(job.id, 'Measuring cuts, black and frozen frames, flicker and motion', 0.28);
    const [visual, measuredTemporal] = await Promise.all([visualMeasurements(local), temporalMeasurements(local).catch(() => null as TemporalMeasurements | null)]);
    // Black stretches are reported as black frames; they are not a second, frozen-picture fault.
    const temporal = measuredTemporal && { ...measuredTemporal, frozen: frozenOutsideBlack(measuredTemporal.frozen, visual.blackSegments) };

    // Frame analysis: faces, people, objects and text on sampled frames (plus the very last frame).
    await progress(job.id, 'Reading faces, people, objects and text in sampled frames', 0.36);
    let frames: SampledFrame[] = [];
    let annotated: AnnotatedFrame[] = [];
    const flippedText = new Map<number, string>();
    let visionError: string | null = null;
    try {
      frames = await sampleFrames(local, { durationSec, fps: 1, width: 768, srcWidth: info.width, srcHeight: info.height, max: 16 });
      annotated = await annotateFrames({ frames, features: ['FACE_DETECTION', 'OBJECT_LOCALIZATION', 'TEXT_DETECTION'], usage });
      // Mirrored writing reads correctly only in the mirror image: OCR the flipped frames too.
      if (c?.expectations.screens.some((sc) => sc.expectedText.trim())) {
        const withText = annotated.filter((f) => f.fullText.trim().length > 0);
        const pool = (withText.length ? withText : annotated).map((f) => f.t);
        const step = Math.max(1, Math.floor(pool.length / 4));
        const chosen = pool.filter((_, i) => i % step === 0).slice(0, 4);
        const flips = await Promise.all(chosen.map(async (tt) => ({ t: tt, jpeg: await flipJpeg(frames.find((f) => f.t === tt)!.jpeg), width: frames[0]!.width, height: frames[0]!.height })));
        const readings = await annotateFrames({ frames: flips, features: ['TEXT_DETECTION'], usage });
        for (const r of readings) flippedText.set(r.t, r.fullText);
      }
    } catch (err) {
      // Frame analysis is an extra check: its failure is recorded, never hidden, and never passes a take by itself.
      visionError = String((err as Error)?.message ?? err).slice(0, 300);
    }

    // Colour continuity with the previous approved shot of the same scene (the cut between them).
    let colour: ColourMeasurements | null = null;
    let previousFrame: { storagePath: string } | null = null;
    if (c?.previousFrame) {
      previousFrame = { storagePath: c.previousFrame.storagePath };
      if (c.sameScenePrevious && !c.expectations.intentionalLook) {
        try {
          const prevLocal = path.join(dir, 'previous-final.jpg');
          await bucket.file(c.previousFrame.storagePath).download({ destination: prevLocal });
          const prevJpeg = await readFile(prevLocal);
          const [shotStats, prevStats, prevFaces] = await Promise.all([
            rgbStats(local, { fps: 4, from: 0, to: Math.min(1.5, durationSec) }),
            rgbStats(prevLocal, { isImage: true }),
            annotateFrames({ frames: [{ t: 0, jpeg: prevJpeg, width: 1280, height: 720 }], features: ['FACE_DETECTION'], usage }).catch(() => [] as AnnotatedFrame[]),
          ]);
          const firstWithFace = annotated.find((f) => f.t <= 1.6 && f.faces.some((x) => x.confidence >= 0.6)) ?? null;
          const shotSkin = await skinOf(firstWithFace ? frames.find((f) => f.t === firstWithFace.t) ?? null : null, firstWithFace);
          const prevSkin = await skinOf({ jpeg: prevJpeg }, prevFaces[0] ?? null);
          colour = { shot: toColourStats(shotStats, shotSkin), reference: null, previous: toColourStats(prevStats, prevSkin) };
        } catch {
          colour = null;
        }
      }
    } else if (p.previousShot) {
      // Earlier productions: the previous approved shot's last frame is extracted from its video.
      try {
        const prevLocal = path.join(dir, 'previous.mp4');
        await bucket.file(p.previousShot.storagePath).download({ destination: prevLocal });
        const jpg = path.join(dir, 'previous-last.jpg');
        await lastFrameJpeg(prevLocal, jpg);
        const dest = `users/${job.ownerUid}/derived/${p.assetId}/qa-previous-last-frame.jpg`;
        await bucket.upload(jpg, { destination: dest, resumable: false, metadata: { contentType: 'image/jpeg' } });
        previousFrame = { storagePath: dest };
      } catch {
        previousFrame = null;
      }
    }
    const vision: VisionMeasurements | null = annotated.length ? { frames: compactFrames(annotated), screenText: c ? screenReadings(c.expectations, annotated, flippedText) : [] } : null;
    return { durationSec, fps: info.fps, hasAudio: info.hasAudio, words, transcriptText, languageCode, audio, endRatio, visual, temporal, vision, annotated, colour, previousFrame, visionError };
  });

  const lastWordEnd = measured.words.length ? Math.max(...measured.words.map((w) => w.end)) : null;
  const speechAtEnd = lastWordEnd !== null && measured.durationSec - lastWordEnd < 0.3 && measured.endRatio > 0.12;
  if (measured.audio) measured.audio.speechAtEnd = speechAtEnd;
  const dialogue = analyzeDialogue({ expected: e.lines, words: measured.words, durationSec: measured.durationSec, speechAtEnd, plannedCuts: p.plan.plannedCuts });
  const dialogueSummary = !dialogue.applicable
    ? measured.words.length
      ? `no dialogue is scripted but ${measured.words.length} spoken words were detected.`
      : 'no dialogue scripted and none detected.'
    : `${Math.round(dialogue.wordCoverage * 100)}% of scripted words heard; missing: ${dialogue.missingWords.join(', ') || 'none'}; changed: ${dialogue.alteredWords.map((a) => `${a.expected}→${a.detected}`).join(', ') || 'none'}; repeated: ${dialogue.repeatedWords.join(', ') || 'none'}; truncated final word: ${dialogue.truncatedFinalWord ? `yes (cut at ${dialogue.cutoffTime} s)` : 'no'}; first word at ${dialogue.firstWordStart ?? '—'} s; last word ends at ${dialogue.lastWordEnd ?? '—'} s; room after it: ${dialogue.trailingRoomSec ?? '—'} s.`;
  const temporalSummary = measured.temporal
    ? `Frame analysis: ${measured.temporal.frozen.length ? `frozen ${measured.temporal.frozen.map((f) => `${round1(f.start)}–${round1(f.end)} s`).join(', ')}; ` : ''}repeated frames ${Math.round(measured.temporal.repeatedRatio * 100)}%; flicker index ${measured.temporal.flickerIndex}; ${measured.temporal.decodeErrors} decode error(s).`
    : '';
  const measuredSummary = [visionSummary(measured.annotated, c?.expectations ?? null), temporalSummary, measured.visionError ? `(Frame analysis unavailable: ${measured.visionError})` : ''].filter(Boolean).join(' ');

  await progress(job.id, c ? 'Reviewing picture, performance and continuity against the bibles' : 'Reviewing picture, performance and continuity', 0.5);
  const references = [...p.references, ...(measured.previousFrame ? [{ assetId: '', storagePath: measured.previousFrame.storagePath, mimeType: 'image/jpeg', label: `Last frame of the previous approved shot (${c?.previousFrame?.title ?? p.previousShot?.title ?? 'previous shot'}) — continuity reference` }] : [])];
  const fps = measured.durationSec <= 12 ? 4 : measured.durationSec <= 24 ? 3 : 2;
  const parts: Part[] = [
    { fileData: { fileUri: gsUri(p.storagePath), mimeType: 'video/mp4' }, videoMetadata: { fps } },
    ...references.map((r) => ({ fileData: { fileUri: gsUri(r.storagePath), mimeType: r.mimeType } })),
    { text: brief({ ...p, references }, measured.durationSec, measured.words, dialogueSummary, measuredSummary) },
  ];
  // Two structured passes over the same video, each schema-enforced by the API (the combined schema is too
  // complex to enforce): the scene review, then the continuity-director details.
  const passes = [
    { name: 'review', schema: REVIEW_SCHEMA, note: 'THIS PASS: return the scene review sections (summary, dialogue and speakers, lip sync, action beats, continuity list, artefacts, first/last frame, scores, problems, recommended repair). The continuity-director details are collected in a separate pass.' },
    { name: 'continuity director', schema: DIRECTOR_REVIEW_SCHEMA, note: 'THIS PASS: return only the continuity-director sections (characters, background, blocking, direction, text, props, temporal, edges, detected state and category scores). The scene review is collected in a separate pass.' },
  ];
  const results = await Promise.all(passes.map((x) => callReasoning([...parts, { text: x.note }], { systemInstruction: INSPECTOR_SYSTEM, responseJsonSchema: x.schema }, 'MEDIUM')));
  // Nothing is scored from an incomplete reply: a missing or mistyped field would otherwise read as “fine”.
  results.forEach((res, i) => {
    const invalid = schemaErrors(res.json, passes[i]!.schema);
    if (invalid.length) fail('invalid_output', `The ${passes[i]!.name} reply was incomplete (${invalid.slice(0, 3).join('; ')}), so nothing was scored from it.`, { details: invalid.join('\n').slice(0, 900), retryable: true });
  });
  const [r, d] = results as [ReasoningResult, ReasoningResult];
  const reviewCost = (await usageFor(job, r, 'text', false)) + (await usageFor(job, d, 'text', false));
  const review = normalizeReview(r.json);
  review.director = normalizeDirectorReview(d.json);
  const measurements: Measurements = { durationSec: measured.durationSec, fps: measured.fps, hasAudio: measured.hasAudio, audio: measured.audio, visual: measured.visual, temporal: measured.temporal, vision: measured.vision, colour: measured.colour };
  const verdict = evaluateQuality({ expect: c?.expectations ?? null, dialogue, review, measurements, settings: p.settings, plannedCuts: p.plan.plannedCuts, editorialCuts: p.plan.editorialCuts ?? [], hasCharacters: e.characters.length > 0, waivedCategories: p.waivedCategories });

  // Continuity: what is actually on screen at the end of the take, against the plan (never canonical here).
  let continuity: QualityReportDoc['continuity'] = null;
  if (c && review.director) {
    const snap = await col.sub(job.projectId!, 'continuitySnapshots').doc(c.shotId).get();
    const planned = snap.exists ? (snap.data() as ContinuitySnapshotDoc) : null;
    if (planned?.plannedState) {
      const detected: ContinuityState = detectedToState(planned.plannedState, review.director.detected, c.names);
      const warnings: ContinuityWarning[] = compareStates(planned.plannedState, detected, c.names, { previousShotId: planned.previousShotId, nextShotId: planned.nextShotId });
      // Protected screens read back with OCR (as filmed and mirrored).
      for (const st of measured.vision?.screenText ?? []) {
        const sc = c.expectations.screens.find((x) => x.id === st.screenId);
        const o = textOrientation(st.expected, st.normal, st.flipped);
        if (sc && o.verdict !== 'correct' && !(o.verdict === 'mirrored' && sc.mayMirror)) {
          warnings.push({ id: `w_screen_${sc.id}`.slice(0, 60), kind: o.verdict === 'mirrored' ? 'mirrored_text' : 'screen_content', severity: o.verdict === 'mirrored' ? 'critical' : 'warning', subjectId: sc.id, message: `“${sc.name}” ${o.verdict === 'mirrored' ? 'is mirrored' : o.verdict === 'misspelled' ? 'is misspelled' : 'is not readable'} at ${round1(st.t)} s (OCR ${Math.round(textSimilarity(st.expected, st.normal) * 100)}% as filmed, ${Math.round(textSimilarity(st.expected, st.flipped) * 100)}% mirrored).`, expected: st.expected, detected: st.normal.slice(0, 120), difference: o.verdict, proposedRepair: sc.composite ? { type: 'screen_composite', label: 'Composite the approved screen content', estimateUsd: null } : null, affects: { previousShotId: planned.previousShotId, nextShotId: planned.nextShotId }, source: 'inspection', status: 'open' });
        }
      }
      continuity = { detected, warnings };
      await recordInspection(job.projectId!, c.shotId, { detected, warnings, versionId: p.versionId, productionId: p.productionId, passed: verdict.passed });
    }
  }

  const reportRef = col.productions().doc(p.productionId).collection('reports').doc();
  const costUsd = Number((await col.jobs().doc(job.id).get()).get('usageUsd') ?? reviewCost);
  const modelIds = { review: r.modelId, transcription: MODEL_REGISTRY.transcription.id, vision: measured.vision ? MODEL_REGISTRY.vision.id : null };
  const report: Omit<QualityReportDoc, 'id'> = {
    productionId: p.productionId,
    versionId: p.versionId,
    jobId: job.id,
    assetId: p.assetId,
    modelIds,
    measurements,
    transcript: { text: measured.transcriptText, words: measured.words, languageCode: measured.languageCode },
    dialogue,
    review,
    scores: verdict.scores,
    overall: verdict.overall,
    problems: verdict.problems,
    passed: verdict.passed,
    threshold: p.settings.minApprovalScore,
    reasons: verdict.reasons,
    plannedDurationSec: p.plan.plannedSec,
    recommendedRepair: null,
    summary: review.summary,
    costUsd,
    categoryScores: verdict.categoryScores,
    continuity,
  };
  await reportRef.set({ ...report, createdAt: FieldValue.serverTimestamp() });
  const verdictLabel = verdict.passed ? 'passed' : 'failed';
  await col.productions().doc(p.productionId).collection('versions').doc(p.versionId).set({ reportId: reportRef.id, verdict: verdictLabel, overall: verdict.overall, scores: verdict.scores, categoryScores: verdict.categoryScores, durationSec: measured.durationSec }, { merge: true });
  if (p.takeRef) {
    await col.projects().doc(job.projectId!).collection('shots').doc(p.takeRef.shotId).collection('takes').doc(p.takeRef.takeId).set({ versionId: p.versionId, productionId: p.productionId, quality: { verdict: verdictLabel, overall: verdict.overall, reportId: reportRef.id, categoryScores: verdict.categoryScores } }, { merge: true });
  }
  // Project-wide review line (lists, dashboards); the full report stays under the production.
  const shotId = c?.shotId ?? p.takeRef?.shotId ?? null;
  if (shotId) {
    const line: Omit<QualityReviewDoc, 'id'> = {
      shotId,
      takeId: p.takeRef?.takeId ?? null,
      productionId: p.productionId,
      versionId: p.versionId,
      versionIndex: p.versionIndex ?? null,
      reportId: reportRef.id,
      assetId: p.assetId,
      passed: verdict.passed,
      overall: verdict.overall,
      threshold: p.settings.minApprovalScore,
      scores: verdict.scores,
      categoryScores: verdict.categoryScores,
      blocking: verdict.problems.filter((x) => x.blocking).slice(0, 20).map((x) => ({ category: x.category, severity: x.severity, description: x.description.slice(0, 300) })),
      problemCount: verdict.problems.length,
      continuityWarnings: continuity?.warnings.length ?? 0,
      summary: review.summary.slice(0, 1200),
      modelIds,
      costUsd,
    };
    await col.sub(job.projectId!, 'qualityReviews').doc(reportRef.id).set({ ...line, createdAt: FieldValue.serverTimestamp() });
  }
  await logInteraction({
    uid: job.ownerUid,
    projectId: job.projectId,
    jobId: job.id,
    modelId: r.modelId,
    api: 'generateContent',
    request: { task: 'quality_inspection', durationSec: measured.durationSec, fps, references: references.length, lines: e.lines.length, visionFrames: measured.annotated.length, continuity: Boolean(c) },
    response: { passed: verdict.passed, overall: verdict.overall, problems: verdict.problems.length, continuityWarnings: continuity?.warnings.length ?? 0, usage: { review: r.res.usageMetadata ?? null, director: d.res.usageMetadata ?? null } },
    latencyMs: Date.now() - started,
  });
  const blocking = verdict.problems.filter((x) => x.blocking).length;
  await transition(job.id, 'completed', {
    stage: `${verdict.passed ? 'Passed' : 'Failed'} quality review · ${verdict.overall}/100${blocking ? ` · ${blocking} blocking issue(s)` : ''}${continuity?.warnings.length ? ` · ${continuity.warnings.length} continuity warning(s)` : ''}`,
    modelId: r.modelId,
    result: { reportId: reportRef.id, text: review.summary.slice(0, 1000) },
  });
}
