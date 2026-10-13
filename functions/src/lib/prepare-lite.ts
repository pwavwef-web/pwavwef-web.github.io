import { HttpsError } from 'firebase-functions/v2/https';
import { AMBIENCE_LABELS, estimateLocalCompute, estimateSpeech, estimateTranscription, estimateNarrationSec, sumEstimates, type AmbienceJobRequest, type LiteNarrationJobRequest } from '@az-studio/shared';
import { MODEL_REGISTRY, SPEECH_VOICES, TRANSCRIPTION_CAPABILITIES } from '../config/models';
import { PRICING } from '../config/pricing';
import { col } from './firebase';
import { loadAssets, type PreparedJob } from './prepare';

/**
 * Film Studio Lite jobs: narration (speech + word timing from the real audio, or timing of an uploaded
 * recording) and synthesised ambience beds. Nothing here calls a video or lip-sync model.
 */

function bad(message: string): never {
  throw new HttpsError('invalid-argument', message);
}

async function liteProject(uid: string, projectId: string) {
  const snap = await col.projects().doc(projectId).get();
  if (!snap.exists || snap.get('ownerUid') !== uid) bad('Project not found.');
  if (snap.get('type') !== 'film_lite') bad('This job belongs to Film Studio Lite projects.');
  return snap;
}

/** Longest uploaded narration Film Studio Lite aligns (transcribed in 14-minute parts). */
export const LITE_MAX_NARRATION_SEC = 30 * 60;

export async function prepareLiteNarration(uid: string, req: LiteNarrationJobRequest): Promise<PreparedJob> {
  await liteProject(uid, req.projectId);
  if (req.mode === 'tts') {
    if (!req.sceneId) bad('Choose the scene to voice.');
    if (!req.spokenText.trim() || !req.text.trim()) bad('This scene has no narration text.');
    if (!req.voice || !SPEECH_VOICES.includes(req.voice)) bad(`Choose one of the available voices (${SPEECH_VOICES.join(', ')}).`);
    const seconds = estimateNarrationSec(req.spokenText, 140);
    const estimate = sumEstimates([estimateSpeech({ chars: req.spokenText.length + req.direction.length, seconds, lines: 1 }, PRICING), estimateTranscription({ seconds, words: req.text.split(/\s+/).length }, PRICING)], PRICING);
    estimate.notes.push('Each scene is spoken once, measured, and its words are timed from the real audio for subtitles.');
    return {
      type: 'lite.narration',
      projectId: req.projectId,
      modelId: MODEL_REGISTRY.speech.id,
      label: req.label ?? 'Narration',
      params: { mode: 'tts', sceneId: req.sceneId, text: req.text, spokenText: req.spokenText, voice: req.voice, direction: req.direction, languageCode: req.languageCode ?? null, vocabulary: req.vocabulary, inputHash: req.inputHash },
      estimate,
      target: { kind: 'lite_scene', id: req.sceneId! },
    };
  }
  if (!req.audioAssetId) bad('Choose the narration recording.');
  const a = (await loadAssets(uid, [req.audioAssetId!])).get(req.audioAssetId!)!;
  if (a.kind !== 'audio' && !(a.kind === 'video' && a.hasAudio)) bad('Choose an audio recording of the narration.');
  const durationSec = a.durationSec ?? 0;
  if (durationSec <= 0) bad('The recording has not been measured yet. Wait for the upload to finish processing.');
  if (durationSec > LITE_MAX_NARRATION_SEC) bad(`Narration recordings up to ${LITE_MAX_NARRATION_SEC / 60} minutes can be aligned.`);
  if (req.mode === 'align_scene' && (!req.sceneId || !req.text.trim())) bad('Choose the scene whose text this recording reads.');
  if (req.mode === 'align_whole' && !req.scenes.some((s) => s.text.trim())) bad('Write the narration script first: it is matched against the recording to find each scene.');
  const estimate = estimateTranscription({ seconds: durationSec }, PRICING);
  if (durationSec > TRANSCRIPTION_CAPABILITIES.maxTimedAudioSeconds - 60) estimate.notes.push('Long recordings are transcribed in parts of up to 14 minutes.');
  estimate.notes.push('The recording is the authority: the script only supplies spelling; words that are not heard are reported, not captioned as heard.');
  return {
    type: 'lite.narration',
    projectId: req.projectId,
    modelId: MODEL_REGISTRY.transcription.id,
    label: req.label ?? (req.mode === 'align_whole' ? 'Narration timing (whole recording)' : 'Narration timing'),
    params: { mode: req.mode, sceneId: req.sceneId ?? null, text: req.text, scenes: req.scenes, audioAssetId: a.id, storagePath: a.storagePath, mimeType: a.mimeType, durationSec, languageCode: req.languageCode ?? null, vocabulary: req.vocabulary, inputHash: req.inputHash },
    estimate,
    target: req.mode === 'align_scene' ? { kind: 'lite_scene', id: req.sceneId! } : { kind: 'lite_film', id: req.projectId },
  };
}

export async function prepareAmbience(uid: string, req: AmbienceJobRequest): Promise<PreparedJob> {
  await liteProject(uid, req.projectId);
  const estimate = estimateLocalCompute(`${AMBIENCE_LABELS[req.kind]} ambience (${Math.round(req.durationSec)} s, synthesised)`, PRICING);
  estimate.notes.push('Synthesised from filtered noise with FFmpeg (not a field recording); seamless when looped.');
  return {
    type: 'audio.ambience',
    projectId: req.projectId,
    modelId: null,
    label: req.label ?? `${AMBIENCE_LABELS[req.kind]} ambience`,
    params: { kind: req.kind, durationSec: req.durationSec, seed: req.seed },
    estimate,
    target: { kind: 'lite_film', id: req.projectId, sub: req.kind },
  };
}
