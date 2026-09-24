import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Part } from '@google/genai';
import {
  analyzeDialogue,
  evaluateQuality,
  PROBLEM_CATEGORIES,
  REPAIR_TYPES,
  round1,
  tokenize,
  type EditorialWindow,
  type ExpectedScene,
  type JobDoc,
  type Measurements,
  type ModelReview,
  type ProblemSeverity,
  type QualityReportDoc,
  type QualitySettings,
} from '@az-studio/shared';
import { MODEL_REGISTRY } from '../config/models';
import { transcribe } from '../lib/audio-models';
import { withTmpDir } from '../lib/assets';
import { bucket, col, FieldValue, gsUri } from '../lib/firebase';
import { fail } from '../lib/errors';
import { logInteraction } from '../lib/interactions';
import { probe } from '../lib/media';
import { progress, transition } from '../lib/jobs';
import { audioMeasurements, decodeMono, extractSpeechAudio, integratedLoudness, lastFrameJpeg, visualMeasurements } from '../lib/signal';
import { recordUsage } from '../lib/usage';
import { callReasoning, usageFor } from './text';
import { INSPECTION_SCHEMA } from './text-tasks';

export interface InspectReference {
  assetId: string;
  storagePath: string;
  mimeType: string;
  label: string;
}

export interface InspectParams {
  productionId: string;
  versionId: string;
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
}

const SEVERITIES: ProblemSeverity[] = ['minor', 'major', 'critical'];
const t = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const b = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const sev = (v: unknown): ProblemSeverity => (SEVERITIES.includes(v as ProblemSeverity) ? (v as ProblemSeverity) : 'minor');
const score = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

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
    artefacts: arr('artefacts').map((a) => ({ description: s(a.description), severity: sev(a.severity), startSec: t(a.startSec), endSec: t(a.endSec) })),
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
  'You are AZ Studio’s quality-control supervisor — script supervisor, editor and dialogue mixer in one. You watch and listen to a generated film shot and judge whether it can go into the film. ' +
  'Be strict, specific and fair: report only problems you can actually see or hear, give times in seconds from the start of the clip, and never invent issues. Return only JSON matching the schema.';

function brief(p: InspectParams, durationSec: number, words: { text: string; start: number; end: number }[], dialogueSummary: string): string {
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
    '',
    `Problem categories: ${PROBLEM_CATEGORIES.join(', ')}.`,
    'Scores are 0–100 (90+ excellent, 75 usable, below 60 not usable). characterContinuity is -1 when no recurring character appears. Use -1 for any time that does not apply.',
    'For every line, say who actually delivers it. Decompose the required action into beats and say whether each completes, and when. Check the first and last frames, text rendered in the frame, warped hands/faces or other artefacts, sudden disappearance, and whether any movement or speech is still unfinished at the very end.',
    'Recommend the least destructive repair: trim_ending when unwanted material follows a completed moment; extend_scene when the ending is cut short; conversational_edit for picture-only fixes that keep the timing; cutaway for a short local picture fault under good dialogue; regenerate_longer when dialogue is missing, altered or rushed; none when nothing needs fixing.',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function runInspectJob(job: JobDoc): Promise<void> {
  const p = job.params as unknown as InspectParams;
  if (!job.projectId) fail('invalid_request', 'Inspection needs a project.');
  if (!(await transition(job.id, 'generating', { stage: 'Measuring the scene', progress: 0.08, lease: { until: Date.now() + 20 * 60_000 } }))) return;
  const started = Date.now();
  const e = p.expected;
  const vocabulary = [...new Set([...e.characters.map((c) => c.name), ...e.lines.flatMap((l) => tokenize(l.text).map((w) => w.raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter((w) => /^\p{Lu}/u.test(w) || /[^\x20-\x7e]/.test(w)))])].slice(0, 100);

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
      await progress(job.id, 'Transcribing the dialogue with word timing', 0.2);
      const tr = await transcribe({ data: await readFile(flac), mimeType: 'audio/flac', languageCode: e.language, vocabulary });
      await recordUsage({ uid: job.ownerUid, projectId: job.projectId, jobId: job.id, modelId: tr.modelId, kind: 'transcription', inputTokens: tr.usage.input, outputTokens: tr.usage.output, thoughtTokens: tr.usage.thoughts });
      words = tr.words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
      transcriptText = tr.text;
      languageCode = tr.languageCode;
    }
    await progress(job.id, 'Measuring cuts, black frames and motion', 0.3);
    const visual = await visualMeasurements(local);
    // Continuity with the previous approved shot: its last frame is shown to the reviewer.
    let previousFrame: { storagePath: string } | null = null;
    if (p.previousShot) {
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
    return { durationSec, fps: info.fps, hasAudio: info.hasAudio, words, transcriptText, languageCode, audio, endRatio, visual, previousFrame };
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

  await progress(job.id, 'Reviewing picture, performance and continuity', 0.45);
  const references = [...p.references, ...(measured.previousFrame ? [{ assetId: '', storagePath: measured.previousFrame.storagePath, mimeType: 'image/jpeg', label: `Last frame of the previous approved shot (${p.previousShot!.title}) — continuity reference` }] : [])];
  const fps = measured.durationSec <= 12 ? 4 : measured.durationSec <= 24 ? 3 : 2;
  const parts: Part[] = [
    { fileData: { fileUri: gsUri(p.storagePath), mimeType: 'video/mp4' }, videoMetadata: { fps } },
    ...references.map((r) => ({ fileData: { fileUri: gsUri(r.storagePath), mimeType: r.mimeType } })),
    { text: brief({ ...p, references }, measured.durationSec, measured.words, dialogueSummary) },
  ];
  const r = await callReasoning(parts, { systemInstruction: INSPECTOR_SYSTEM, responseJsonSchema: INSPECTION_SCHEMA }, 'MEDIUM');
  const reviewCost = await usageFor(job, r, 'text', false);
  const review = normalizeReview(r.json);
  const measurements: Measurements = { durationSec: measured.durationSec, fps: measured.fps, hasAudio: measured.hasAudio, audio: measured.audio, visual: measured.visual };
  const verdict = evaluateQuality({ dialogue, review, measurements, settings: p.settings, plannedCuts: p.plan.plannedCuts, editorialCuts: p.plan.editorialCuts ?? [], hasCharacters: e.characters.length > 0, waivedCategories: p.waivedCategories });

  const reportRef = col.productions().doc(p.productionId).collection('reports').doc();
  const costUsd = Number((await col.jobs().doc(job.id).get()).get('usageUsd') ?? reviewCost);
  const report: Omit<QualityReportDoc, 'id'> = {
    productionId: p.productionId,
    versionId: p.versionId,
    jobId: job.id,
    assetId: p.assetId,
    modelIds: { review: r.modelId, transcription: MODEL_REGISTRY.transcription.id },
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
  };
  await reportRef.set({ ...report, createdAt: FieldValue.serverTimestamp() });
  const verdictLabel = verdict.passed ? 'passed' : 'failed';
  await col.productions().doc(p.productionId).collection('versions').doc(p.versionId).set({ reportId: reportRef.id, verdict: verdictLabel, overall: verdict.overall, scores: verdict.scores, durationSec: measured.durationSec }, { merge: true });
  if (p.takeRef) {
    await col.projects().doc(job.projectId!).collection('shots').doc(p.takeRef.shotId).collection('takes').doc(p.takeRef.takeId).set({ versionId: p.versionId, productionId: p.productionId, quality: { verdict: verdictLabel, overall: verdict.overall, reportId: reportRef.id } }, { merge: true });
  }
  await logInteraction({
    uid: job.ownerUid,
    projectId: job.projectId,
    jobId: job.id,
    modelId: r.modelId,
    api: 'generateContent',
    request: { task: 'quality_inspection', durationSec: measured.durationSec, fps, references: references.length, lines: e.lines.length },
    response: { passed: verdict.passed, overall: verdict.overall, problems: verdict.problems.length, usage: r.res.usageMetadata ?? null },
    latencyMs: Date.now() - started,
  });
  await transition(job.id, 'completed', {
    stage: `${verdict.passed ? 'Passed' : 'Failed'} quality review · ${verdict.overall}/100${verdict.problems.filter((x) => x.blocking).length ? ` · ${verdict.problems.filter((x) => x.blocking).length} blocking issue(s)` : ''}`,
    modelId: r.modelId,
    result: { reportId: reportRef.id, text: review.summary.slice(0, 1000) },
  });
}
