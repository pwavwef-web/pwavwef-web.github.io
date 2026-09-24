import { HttpsError } from 'firebase-functions/v2/https';
import {
  EXPORT_PRESETS,
  compileImagePrompt,
  estimateImage,
  estimateMusic,
  estimateSpeech,
  estimateSpeechSeconds,
  estimateTranscription,
  languageName,
  movementPrompt,
  sumEstimates,
  estimateRender,
  estimateText,
  estimateVideo,
  inferVideoTask,
  planOmniMedia,
  presetDimensions,
  timelineDuration,
  checkLyricSync,
  toMillis,
  validateTimeline,
  withDeclaration,
  type AssetDoc,
  type AudioJobRequest,
  type CharacterDoc,
  type CostEstimate,
  type ImageJobRequest,
  type JobRequest,
  type JobTarget,
  type JobType,
  type LyricSyncIssue,
  type LyricsSheet,
  type LyricsAlignJobRequest,
  type LyricsTranscribeJobRequest,
  type MusicJobRequest,
  type OmniMediaRef,
  type ProjectDoc,
  type RenderJobRequest,
  type ScoreDoc,
  type SongDoc,
  type SpeechJobRequest,
  type TextJobRequest,
  type TimelineDoc,
  type VideoJobRequest,
} from '@az-studio/shared';
import { col, db } from './firebase';
import { IMAGE_CAPABILITIES, MODEL_REGISTRY, MUSIC_MODEL_LIMITATION, REASONING_CAPABILITIES, TRANSCRIPTION_CAPABILITIES, VIDEO_CAPABILITIES } from '../config/models';
import { PRICING } from '../config/pricing';
import { TEXT_TASK_SPECS } from '../workers/text-tasks';

export interface PreparedMedia {
  role: string;
  assetId: string;
  kind: 'image' | 'video';
  tag: string;
  binding: string;
  storagePath: string;
  mimeType: string;
  durationSec: number | null;
  label?: string;
}

export interface PreparedJob {
  type: JobType;
  projectId: string | null;
  modelId: string | null;
  label: string;
  params: Record<string, unknown>;
  estimate: CostEstimate;
  target: JobTarget | null;
  take?: { shotId: string; takeId: string; prompt: string; parentTakeId: string | null; params: Record<string, unknown>; label?: string };
  chain?: { chainId: string; turnId: string; isNew: boolean; kind: 'video' | 'image'; title: string; parentTurnId: string | null; prompt: string; mode: string };
  render?: { renderId: string; doc: Record<string, unknown> };
}

function bad(message: string): never {
  throw new HttpsError('invalid-argument', message);
}

const MIME_ALIASES: Record<string, string> = { 'image/jpg': 'image/jpeg', 'video/mov': 'video/quicktime', 'video/x-ms-wmv': 'video/x-ms-wmv' };
const normMime = (m: string) => MIME_ALIASES[m.toLowerCase()] ?? m.toLowerCase();

export async function loadAssets(uid: string, ids: string[]): Promise<Map<string, AssetDoc>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, AssetDoc>();
  if (!unique.length) return out;
  const snaps = await db.getAll(...unique.map((id) => col.assets().doc(id)));
  for (const s of snaps) {
    if (!s.exists) bad(`Referenced media ${s.id} no longer exists.`);
    const a = { id: s.id, ...s.data() } as AssetDoc;
    if (a.ownerUid !== uid) bad('Referenced media does not belong to you.');
    if (a.status !== 'ready') bad(`“${a.title || a.fileName}” is not ready yet (${a.status}).`);
    out.set(a.id, a);
  }
  return out;
}

async function loadProject(uid: string, projectId: string | null | undefined): Promise<ProjectDoc | null> {
  if (!projectId) return null;
  const snap = await col.projects().doc(projectId).get();
  if (!snap.exists) bad('Project not found.');
  const p = { id: snap.id, ...snap.data() } as ProjectDoc;
  if (p.ownerUid !== uid) bad('Project not found.');
  return p;
}

async function assertConsent(projectId: string | null | undefined, characterIds: string[]): Promise<void> {
  if (!characterIds.length) return;
  if (!projectId) bad('Characters can only be referenced inside a project.');
  const snaps = await db.getAll(...characterIds.map((id) => col.projects().doc(projectId!).collection('characters').doc(id)));
  for (const s of snaps) {
    if (!s.exists) bad('A referenced character no longer exists.');
    const c = s.data() as CharacterDoc;
    if (c.realPerson && !c.consentConfirmed) {
      bad(`“${c.name}” is marked as a real person. Confirm you have their consent on the character sheet before generating their likeness.`);
    }
  }
}

function ageDays(t: unknown): number {
  const ms = toMillis(t as never);
  return ms === null ? Infinity : (Date.now() - ms) / 86_400_000;
}

// ---------------------------------------------------------------------------
// Video (Gemini Omni)
// ---------------------------------------------------------------------------

async function prepareVideo(uid: string, req: VideoJobRequest): Promise<PreparedJob> {
  const cap = VIDEO_CAPABILITIES;
  if (req.aspectRatio && !cap.aspectRatios.includes(req.aspectRatio)) bad(`${cap.displayName} supports aspect ratios ${cap.aspectRatios.join(' and ')}.`);
  if (req.resolution && !cap.resolutions.includes(req.resolution)) bad(`${cap.displayName} supports resolutions ${cap.resolutions.join(', ')}.`);
  // Ownership check only; the style bible is compiled client-side into the prompt body.
  await loadProject(uid, req.projectId);
  await assertConsent(req.projectId, req.characterIds);

  const mode = req.mode;
  let previousInteractionId: string | null = null;
  let chainFallbackAssetId: string | null = null;
  let parentDurationSec: number | null = null;
  let chain: PreparedJob['chain'];
  let take: PreparedJob['take'];
  let target: JobTarget | null = req.target ?? null;

  // Continue an interaction chain (Quick Video / Remix) ------------------------------------------
  if (req.parentTurnId) {
    if (!req.chainId) bad('A follow-up edit needs its chain.');
    const chainSnap = await col.chains().doc(req.chainId!).get();
    if (!chainSnap.exists || chainSnap.get('ownerUid') !== uid || chainSnap.get('kind') !== 'video') bad('Edit chain not found.');
    const turn = await chainSnap.ref.collection('turns').doc(req.parentTurnId).get();
    if (!turn.exists) bad('The result you are continuing from no longer exists.');
    if (turn.get('status') !== 'completed') bad('Wait for that result to finish before editing it.');
    const turnAssetId = (turn.get('assetId') as string | null) ?? null;
    if (turnAssetId) parentDurationSec = ((await loadAssets(uid, [turnAssetId])).get(turnAssetId)?.durationSec as number | null) ?? null;
    if (turn.get('interactionId') && ageDays(turn.get('createdAt')) < cap.interactionRetentionDays - 0.25) {
      previousInteractionId = turn.get('interactionId') as string;
    } else if (turnAssetId) {
      chainFallbackAssetId = turnAssetId;
    } else {
      bad('That result can no longer be continued.');
    }
    chain = { chainId: req.chainId!, turnId: col.chains().doc().id, isNew: false, kind: 'video', title: '', parentTurnId: req.parentTurnId, prompt: req.prompt, mode };
    target = { kind: 'chain', id: req.chainId!, sub: chain.turnId };
  }

  // Continue from a shot take (Film / Music Video) -----------------------------------------------
  const parentTakeId = req.parentTakeId ?? null;
  if (target?.kind === 'shot') {
    if (!req.projectId) bad('Shot generations need a project.');
    const shotRef = col.projects().doc(req.projectId!).collection('shots').doc(target.id);
    const shot = await shotRef.get();
    if (!shot.exists) bad('Shot not found.');
    if (parentTakeId) {
      const pt = await shotRef.collection('takes').doc(parentTakeId).get();
      if (!pt.exists || pt.get('status') !== 'completed') bad('The take you are editing is not available.');
      const ptAsset = (pt.get('assetId') as string | null) ?? null;
      if (ptAsset) parentDurationSec = ((await loadAssets(uid, [ptAsset])).get(ptAsset)?.durationSec as number | null) ?? null;
      if (pt.get('interactionId') && ageDays(pt.get('createdAt')) < cap.interactionRetentionDays - 0.25) previousInteractionId = pt.get('interactionId') as string;
      else if (ptAsset) chainFallbackAssetId = ptAsset;
      else bad('That take can no longer be edited.');
    }
    const takeId = shotRef.collection('takes').doc().id;
    take = { shotId: target.id, takeId, prompt: req.prompt, parentTakeId: parentTakeId ?? null, params: {} };
    target = { kind: 'shot', id: target.id, sub: takeId };
  }

  // Media ----------------------------------------------------------------------------------------
  const refs: OmniMediaRef[] = [...req.media];
  if (chainFallbackAssetId && (mode === 'edit' || mode === 'extend' || !refs.some((r) => r.role === 'source_video'))) {
    refs.push({ role: 'source_video', assetId: chainFallbackAssetId, label: 'previous result' });
  }
  const assets = await loadAssets(uid, refs.map((r) => r.assetId));
  for (const r of refs) {
    const a = assets.get(r.assetId)!;
    if (a.kind === 'audio') bad(`${cap.displayName} does not accept audio input. Songs drive timing directions instead and are mixed in the final render.`);
    const wantsImage = r.role === 'first_frame' || r.role === 'last_frame' || r.role === 'image_ref';
    if (wantsImage && a.kind !== 'image') bad(`“${a.title}” must be an image to be used as ${r.role.replace('_', ' ')}.`);
    if (!wantsImage && a.kind !== 'video') bad(`“${a.title}” must be a video to be used as ${r.role.replace('_', ' ')}.`);
    if (a.kind === 'image') {
      if (!cap.imageMimeTypes.includes(normMime(a.mimeType))) bad(`“${a.title}” is ${a.mimeType}; Omni accepts ${cap.imageMimeTypes.join(', ')}.`);
      if (a.sizeBytes > cap.maxImageBytes) bad(`“${a.title}” is larger than ${Math.round(cap.maxImageBytes / 1048576)} MB.`);
    } else {
      if (!cap.videoMimeTypes.includes(normMime(a.mimeType))) bad(`“${a.title}” (${a.mimeType}) is not a supported video format for Omni.`);
      if (r.role === 'video_ref' && (a.durationSec ?? 0) > cap.maxVideoRefSeconds + 0.05) bad(`Video references must be ${cap.maxVideoRefSeconds} seconds or shorter — trim “${a.title}” in the Remix trimmer first.`);
      if (r.role === 'source_video' && !previousInteractionId && (a.durationSec ?? 0) > cap.maxEditInputSeconds + 0.05) {
        bad(`Omni edits and extends uploaded videos of up to ${cap.maxEditInputSeconds} seconds. Trim “${a.title}” to a ${cap.maxEditInputSeconds}-second window first.`);
      }
    }
  }
  const planned = planOmniMedia(refs);
  const images = planned.media.filter((m) => m.kind === 'image');
  const videos = planned.media.filter((m) => m.kind === 'video');
  if (images.length > cap.maxImageInputs) bad(`Omni accepts up to ${cap.maxImageInputs} images per request.`);
  if (videos.length > cap.maxVideoInputs) bad(`Omni accepts up to ${cap.maxVideoInputs} videos per request.`);
  if (refs.some((r) => r.role === 'last_frame') && !refs.some((r) => r.role === 'first_frame')) bad('A last frame needs a first frame.');

  if (mode === 'edit' && previousInteractionId && (parentDurationSec ?? 0) > cap.maxEditInputSeconds + 0.05) {
    bad(`Omni edits videos of up to ${cap.maxEditInputSeconds} seconds; this take is ${Math.round(parentDurationSec ?? 0)} s. Regenerate it, or extend it instead.`);
  }
  const hasSource = planned.media.some((m) => m.role === 'source_video');
  if (mode === 'generate' && hasSource && !chainFallbackAssetId) bad('Use Edit or Extend mode to work on an existing video.');
  if ((mode === 'edit' || mode === 'extend') && !hasSource && !previousInteractionId) bad(`${mode === 'edit' ? 'Editing' : 'Extending'} needs a source video or a previous result.`);

  // Duration: generate & extend send it; edits keep the source length.
  let durationSec: number | null = null;
  if (mode !== 'edit') {
    durationSec = req.durationSec ?? cap.durationSec.default;
    if (!Number.isInteger(durationSec) || durationSec < cap.durationSec.min || durationSec > cap.durationSec.max) {
      bad(`${mode === 'extend' ? 'Extensions' : 'Clips'} can be ${cap.durationSec.min}–${cap.durationSec.max} seconds.`);
    }
  }
  const source = planned.media.find((m) => m.role === 'source_video');
  const sourceSeconds = source ? (assets.get(source.assetId)?.durationSec ?? 0) : (parentDurationSec ?? 0);
  if (mode === 'extend' && sourceSeconds + (durationSec ?? 0) > cap.maxExtendedLengthSec + 0.05) {
    bad(`Omni can extend a video up to ${cap.maxExtendedLengthSec} seconds in total (this would be ${Math.round(sourceSeconds + (durationSec ?? 0))} s).`);
  }

  const task = inferVideoTask(refs.filter((r) => r.role !== 'source_video'), Boolean(previousInteractionId), mode === 'generate' ? undefined : mode);
  const finalPrompt = withDeclaration(planned.declaration, req.prompt);
  const resolution = req.resolution ?? cap.defaultResolution;
  // Extensions return the whole video but are billed for the new seconds only; the earlier video counts as input.
  const outputSeconds = mode === 'edit' ? Math.max(1, sourceSeconds || parentDurationSec || cap.durationSec.default) : (durationSec ?? cap.durationSec.default);
  const videoInputSeconds = videos.reduce((s, m) => s + (assets.get(m.assetId)?.durationSec ?? 0), 0) + (previousInteractionId ? (parentDurationSec ?? 0) : 0);
  const estimate = estimateVideo({ resolution, outputSeconds, promptChars: finalPrompt.length, imageInputs: images.length, videoInputSeconds, task: task ?? mode }, PRICING);
  if (previousInteractionId) estimate.notes.push('Follow-up edits include the previous result as context; that context may be billed as input.');

  const media: PreparedMedia[] = planned.media.map((m) => {
    const a = assets.get(m.assetId)!;
    return { role: m.role, assetId: m.assetId, kind: m.kind, tag: m.tag, binding: m.binding, storagePath: a.storagePath, mimeType: normMime(a.mimeType), durationSec: a.durationSec ?? null, ...(m.label ? { label: m.label } : {}) };
  });

  // Every video job without a shot target lives in a chain so it can be continued conversationally.
  if (!target) {
    const chainId = col.chains().doc().id;
    chain = { chainId, turnId: col.chains().doc().id, isNew: true, kind: 'video', title: req.title ?? req.prompt.slice(0, 80), parentTurnId: null, prompt: req.prompt, mode };
    target = { kind: 'chain', id: chainId, sub: chain.turnId };
  }

  const params = {
    mode,
    task: task ?? null,
    aspectRatio: req.aspectRatio ?? null,
    resolution,
    resolutionExplicit: Boolean(req.resolution),
    durationSec,
    prompt: finalPrompt,
    promptBody: req.prompt,
    media,
    previousInteractionId,
    chainFallback: chainFallbackAssetId ? 'reupload_previous_result' : null,
    characterIds: req.characterIds,
    title: req.title ?? null,
  };
  if (take) take.params = params;
  return {
    type: 'video.generate',
    projectId: req.projectId ?? null,
    modelId: MODEL_REGISTRY.video.id,
    label: req.label ?? (mode === 'generate' ? 'Video generation' : mode === 'edit' ? 'Video edit' : 'Video extension'),
    params,
    estimate,
    target,
    ...(take ? { take } : {}),
    ...(chain ? { chain } : {}),
  };
}

// ---------------------------------------------------------------------------
// Image (Nano Banana Pro)
// ---------------------------------------------------------------------------

async function prepareImage(uid: string, req: ImageJobRequest): Promise<PreparedJob> {
  const cap = IMAGE_CAPABILITIES;
  if (!cap.aspectRatios.includes(req.aspectRatio)) bad(`${cap.displayName} supports aspect ratios ${cap.aspectRatios.join(', ')}.`);
  if (!cap.imageSizes.includes(req.imageSize)) bad(`${cap.displayName} supports sizes ${cap.imageSizes.join(', ')}.`);
  if (req.grounding && !cap.supportsSearchGrounding) bad('Search grounding is not available for this model.');
  const project = await loadProject(uid, req.projectId);
  await assertConsent(req.projectId, req.characterIds);

  let sourceAssetId = req.sourceAssetId ?? null;
  let chain: PreparedJob['chain'];
  let target: JobTarget | null = req.target ?? null;
  if (req.parentTurnId) {
    if (!req.chainId) bad('A follow-up edit needs its chain.');
    const chainSnap = await col.chains().doc(req.chainId!).get();
    if (!chainSnap.exists || chainSnap.get('ownerUid') !== uid || chainSnap.get('kind') !== 'image') bad('Edit chain not found.');
    const turn = await chainSnap.ref.collection('turns').doc(req.parentTurnId).get();
    if (!turn.exists || turn.get('status') !== 'completed' || !turn.get('assetId')) bad('The image you are editing is not available.');
    sourceAssetId = sourceAssetId ?? (turn.get('assetId') as string);
    chain = { chainId: req.chainId!, turnId: col.chains().doc().id, isNew: false, kind: 'image', title: '', parentTurnId: req.parentTurnId, prompt: req.prompt, mode: 'edit' };
    target = { kind: 'chain', id: req.chainId!, sub: chain.turnId };
  }
  const refIds = [...(sourceAssetId ? [sourceAssetId] : []), ...req.referenceAssetIds.filter((id) => id !== sourceAssetId)];
  if (refIds.length > cap.maxReferenceImages) bad(`${cap.displayName} accepts up to ${cap.maxReferenceImages} images per request.`);
  const assets = await loadAssets(uid, refIds);
  for (const a of assets.values()) {
    if (a.kind !== 'image') bad(`“${a.title}” is not an image.`);
    if (!cap.imageMimeTypes.includes(normMime(a.mimeType))) bad(`“${a.title}” (${a.mimeType}) is not a supported image format.`);
    if (a.sizeBytes > cap.maxImageBytes) bad(`“${a.title}” is larger than ${Math.round(cap.maxImageBytes / 1048576)} MB.`);
  }
  const prompt = compileImagePrompt(req.purpose, req.prompt, req.applyStyleBible ? project?.styleBible ?? null : null);
  const estimate = estimateImage({ imageSize: req.imageSize, referenceImages: refIds.length, promptChars: prompt.length, outputs: 1 }, PRICING);

  if (!target) {
    const chainId = col.chains().doc().id;
    chain = { chainId, turnId: col.chains().doc().id, isNew: true, kind: 'image', title: req.title ?? req.prompt.slice(0, 80), parentTurnId: null, prompt: req.prompt, mode: sourceAssetId ? 'edit' : 'generate' };
    target = { kind: 'chain', id: chainId, sub: chain.turnId };
  }
  const ref = (id: string) => {
    const a = assets.get(id)!;
    return { assetId: id, storagePath: a.storagePath, mimeType: normMime(a.mimeType), title: a.title };
  };
  return {
    type: 'image.generate',
    projectId: req.projectId ?? null,
    modelId: MODEL_REGISTRY.image.id,
    label: req.label ?? (sourceAssetId ? 'Image edit' : `${req.purpose === 'free' ? 'Image' : req.purpose.replace('_', ' ')} generation`),
    params: {
      mode: sourceAssetId ? 'edit' : 'generate',
      purpose: req.purpose,
      prompt,
      promptBody: req.prompt,
      aspectRatio: req.aspectRatio,
      imageSize: req.imageSize,
      source: sourceAssetId ? ref(sourceAssetId) : null,
      references: req.referenceAssetIds.filter((id) => id !== sourceAssetId).map(ref),
      grounding: req.grounding,
      collections: req.collections,
      characterIds: req.characterIds,
      title: req.title ?? null,
    },
    estimate,
    target,
    ...(chain ? { chain } : {}),
  };
}

// ---------------------------------------------------------------------------
// Text assist (Gemini Pro)
// ---------------------------------------------------------------------------

async function prepareText(uid: string, req: TextJobRequest): Promise<PreparedJob> {
  await loadProject(uid, req.projectId);
  const spec = TEXT_TASK_SPECS[req.task];
  const inputChars = JSON.stringify(req.input).length;
  if (inputChars > 800_000) bad('That input is too large for one request.');
  const problem = spec.validate?.(req.input);
  if (problem) bad(problem);
  const modelId = MODEL_REGISTRY.reasoning.id;
  const estimate = estimateText({ modelId, inputChars: inputChars + spec.system.length, expectedOutputTokens: spec.expectedOutputTokens }, PRICING);
  return {
    type: 'text.assist',
    projectId: req.projectId ?? null,
    modelId,
    label: req.label ?? spec.label,
    params: { task: req.task, input: req.input },
    estimate,
    target: req.target ?? null,
  };
}

// ---------------------------------------------------------------------------
// Song analysis (Gemini Pro audio understanding)
// ---------------------------------------------------------------------------

async function prepareAudio(uid: string, req: AudioJobRequest): Promise<PreparedJob> {
  await loadProject(uid, req.projectId);
  const song = await col.projects().doc(req.projectId).collection('songs').doc(req.songId).get();
  if (!song.exists) bad('Song not found.');
  const assets = await loadAssets(uid, [req.audioAssetId]);
  const a = assets.get(req.audioAssetId)!;
  if (a.kind !== 'audio') bad('Choose an audio file to analyse.');
  const durationSec = a.durationSec ?? 0;
  if (durationSec > REASONING_CAPABILITIES.maxAudioSeconds) bad('Songs longer than an hour cannot be analysed in one request.');
  const modelId = MODEL_REGISTRY.reasoning.id;
  const estimate = estimateText({ modelId, inputChars: 4000, expectedOutputTokens: 8000, audioSeconds: durationSec }, PRICING);
  return {
    type: 'audio.analyze',
    projectId: req.projectId,
    modelId,
    label: req.label ?? 'Song analysis',
    params: { songId: req.songId, audioAssetId: req.audioAssetId, storagePath: a.storagePath, mimeType: a.mimeType, durationSec, transcribeLyrics: req.transcribeLyrics },
    estimate,
    target: { kind: 'song', id: req.songId },
  };
}

// ---------------------------------------------------------------------------
// Render (FFmpeg on Cloud Run)
// ---------------------------------------------------------------------------

async function prepareRender(uid: string, req: RenderJobRequest): Promise<PreparedJob> {
  await loadProject(uid, req.projectId);
  const snap = await col.timelines(req.projectId).doc(req.timelineId).get();
  if (!snap.exists) bad('Timeline not found.');
  const tl = { id: snap.id, ...snap.data() } as TimelineDoc;
  const problems = validateTimeline(tl);
  if (problems.length) bad(`Fix the timeline before rendering: ${problems.slice(0, 3).join(' ')}`);
  // Final synchronisation check: lyric captions must follow the vocals they belong to.
  const songIds = [...new Set(tl.clips.map((c) => c.lyric?.songId).filter((x): x is string => Boolean(x)))];
  let lyricSync: LyricSyncIssue[] = [];
  if (songIds.length) {
    const songs = await db.getAll(...songIds.map((id) => col.songs(req.projectId).doc(id)));
    const sheets = Object.fromEntries(songs.map((s) => [s.id, s.exists ? ((s.get('lyricsSheet') as LyricsSheet | null) ?? null) : null]));
    lyricSync = checkLyricSync(tl, sheets);
    if (lyricSync.length && !req.acceptLyricSync) {
      throw new HttpsError('failed-precondition', `Lyric captions are out of sync: ${lyricSync.slice(0, 3).map((i) => i.message).join(' ')}${lyricSync.length > 3 ? ` (+${lyricSync.length - 3} more)` : ''} Resync the lyrics in the editor, or render anyway.`, { reason: 'lyric_sync', issues: lyricSync.slice(0, 50) });
    }
  }
  const durationSec = timelineDuration(tl.clips);
  if (durationSec <= 0) bad('The timeline is empty.');
  const assetIds = tl.clips.map((c) => c.assetId).filter((x): x is string => Boolean(x));
  const assets = await loadAssets(uid, assetIds);
  for (const c of tl.clips) {
    if (!c.assetId) continue;
    const a = assets.get(c.assetId)!;
    const ok = (c.kind === 'video' && a.kind === 'video') || (c.kind === 'image' && a.kind === 'image') || (c.kind === 'audio' && (a.kind === 'audio' || (a.kind === 'video' && a.hasAudio)));
    if (!ok) bad(`Clip “${c.label || a.title}” does not match its media type.`);
  }
  const dims = presetDimensions(req.preset, req.quality);
  const renderId = col.renders().doc().id;
  const estimate = estimateRender({ durationSec, quality: req.quality }, PRICING);
  const assetMap = Object.fromEntries(
    [...assets.values()].map((a) => [a.id, { storagePath: a.storagePath, kind: a.kind, mimeType: a.mimeType, width: a.width ?? null, height: a.height ?? null, durationSec: a.durationSec ?? null, hasAudio: a.hasAudio ?? null, title: a.title, provenance: a.generation?.provenance ?? null, modelId: a.generation?.modelId ?? null }]),
  );
  return {
    type: 'render.timeline',
    projectId: req.projectId,
    modelId: null,
    label: req.label ?? `${EXPORT_PRESETS[req.preset].label} · ${req.quality === 'final' ? 'Final' : 'Draft'} render`,
    params: { renderId, timelineId: req.timelineId, preset: req.preset, quality: req.quality, width: dims.width, height: dims.height, fps: tl.fps, durationSec, lyricSyncIssues: lyricSync.length },
    estimate,
    target: { kind: 'timeline', id: req.timelineId, sub: renderId },
    render: {
      renderId,
      doc: {
        ownerUid: uid,
        projectId: req.projectId,
        timelineId: req.timelineId,
        timelineVersion: tl.version ?? 0,
        timelineName: tl.name,
        preset: req.preset,
        quality: req.quality,
        width: dims.width,
        height: dims.height,
        fps: tl.fps,
        durationSec,
        snapshot: { tracks: tl.tracks, clips: tl.clips, aspectRatio: tl.aspectRatio, fps: tl.fps },
        lyricSync: { checkedAt: Date.now(), issues: lyricSync.slice(0, 50) },
        assets: assetMap,
        computeRates: { vcpu: PRICING.render.vcpu, memoryGiB: PRICING.render.memoryGiB, perVcpuSecond: PRICING.render.perVcpuSecond, perGiBSecond: PRICING.render.perGiBSecond },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Dialogue guide audio (TTS)
// ---------------------------------------------------------------------------

async function prepareSpeech(uid: string, req: SpeechJobRequest): Promise<PreparedJob> {
  await loadProject(uid, req.projectId);
  const chars = req.lines.reduce((s, l) => s + l.text.length, 0);
  const seconds = req.lines.reduce((s, l) => s + estimateSpeechSeconds(l.text) + 0.6, 0);
  const estimate = estimateSpeech({ chars, seconds, lines: req.lines.length }, PRICING);
  return {
    type: 'speech.generate',
    projectId: req.projectId,
    modelId: MODEL_REGISTRY.speech.id,
    label: req.label ?? `Dialogue audio · ${req.lines.length} line${req.lines.length === 1 ? '' : 's'}`,
    params: { lines: req.lines.map((l) => ({ index: l.index, character: l.character, text: l.text, voice: l.voice ?? null, direction: l.direction ?? '' })), languageCode: req.languageCode ?? null },
    estimate,
    target: req.target ?? { kind: 'project', id: req.projectId },
  };
}

// ---------------------------------------------------------------------------
// Music (Lyria)
// ---------------------------------------------------------------------------

async function prepareMusic(uid: string, req: MusicJobRequest): Promise<PreparedJob> {
  const project = await loadProject(uid, req.projectId);
  if (req.instrumental && req.lyrics?.trim()) bad('Instrumental music cannot have lyrics. Turn off “instrumental” or remove the lyrics.');
  const images = await loadAssets(uid, req.imageAssetIds);
  for (const a of images.values()) if (a.kind !== 'image') bad(`“${a.title}” is not an image.`);
  let prompt = req.prompt.trim();
  let target: JobTarget | null = null;
  if (req.purpose === 'song') {
    if (req.songId) {
      const song = await col.songs(req.projectId).doc(req.songId).get();
      if (!song.exists) bad('Song not found.');
      target = { kind: 'song', id: req.songId };
    }
    const lang = languageName(req.languageCode ?? null);
    prompt = [
      prompt,
      req.instrumental
        ? 'Instrumental only: no vocals, no singing, no spoken words, no lyrics.'
        : req.lyrics?.trim()
          ? `Sing exactly these lyrics, in this order, without changing, adding or dropping any word (section tags mark the structure):\n${req.lyrics.trim()}`
          : 'Write original lyrics that fit this brief and sing them.',
      !req.instrumental && lang ? `Sing in ${lang}.` : '',
    ]
      .filter(Boolean)
      .join('\n');
  } else {
    if (!req.scoreId || !req.movementId) bad('A score movement needs its score and movement.');
    if (project?.type !== 'film') bad('Film scores belong to film projects. Music videos keep their song as the master audio.');
    const snap = await col.scores(req.projectId).doc(req.scoreId!).get();
    if (!snap.exists) bad('Score not found.');
    const score = { id: snap.id, ...snap.data() } as ScoreDoc;
    if (score.mode === 'none') bad('This film is set to “No score”. Choose minimal or cinematic score first.');
    const movement = score.movements.find((m) => m.id === req.movementId);
    if (!movement) bad('Movement not found.');
    if (movement!.locked) bad('This movement is locked. Unlock it before regenerating.');
    prompt = [movementPrompt(score, movement!, score.movements.length), req.prompt.trim() && req.prompt.trim() !== 'score' ? `Director’s note: ${req.prompt.trim()}` : ''].filter(Boolean).join('\n');
    target = { kind: 'score', id: req.scoreId!, sub: req.movementId! };
  }
  const estimate = estimateMusic({ songs: 1 }, PRICING);
  estimate.notes.push(MUSIC_MODEL_LIMITATION);
  return {
    type: 'music.generate',
    projectId: req.projectId,
    modelId: MODEL_REGISTRY.music.id,
    label: req.label ?? (req.purpose === 'song' ? 'Song generation' : 'Score movement'),
    params: {
      purpose: req.purpose,
      prompt,
      lyricsProvided: Boolean(req.lyrics?.trim()),
      lyrics: req.lyrics?.trim() ?? null,
      instrumental: req.instrumental,
      languageCode: req.languageCode ?? null,
      images: [...images.values()].map((a) => ({ assetId: a.id, storagePath: a.storagePath, mimeType: normMime(a.mimeType) })),
      songId: req.songId ?? null,
      scoreId: req.scoreId ?? null,
      movementId: req.movementId ?? null,
      title: req.title ?? null,
    },
    estimate,
    target,
  };
}

// ---------------------------------------------------------------------------
// Lyrics extraction & synchronisation
// ---------------------------------------------------------------------------

async function songAudio(uid: string, projectId: string, songId: string, audioAssetId: string) {
  await loadProject(uid, projectId);
  const song = await col.songs(projectId).doc(songId).get();
  if (!song.exists) bad('Song not found.');
  const a = (await loadAssets(uid, [audioAssetId])).get(audioAssetId)!;
  if (a.kind !== 'audio' && !(a.kind === 'video' && a.hasAudio)) bad('Choose the song’s audio.');
  const durationSec = a.durationSec ?? 0;
  if (durationSec > TRANSCRIPTION_CAPABILITIES.maxTimedAudioSeconds) bad(`Songs longer than ${Math.round(TRANSCRIPTION_CAPABILITIES.maxTimedAudioSeconds / 60)} minutes cannot be transcribed with word timing in one request.`);
  return { song: { id: song.id, ...song.data() } as SongDoc, asset: a, durationSec };
}

async function prepareLyricsTranscribe(uid: string, req: LyricsTranscribeJobRequest): Promise<PreparedJob> {
  const { song, asset, durationSec } = await songAudio(uid, req.projectId, req.songId, req.audioAssetId);
  if (song.instrumental) bad('This song is marked instrumental, so there are no lyrics to extract. Clear “instrumental” first if it has vocals.');
  const estimate = sumEstimates([estimateTranscription({ seconds: durationSec }, PRICING), estimateText({ modelId: MODEL_REGISTRY.reasoning.id, inputChars: 3000, expectedOutputTokens: 5000, audioSeconds: durationSec }, PRICING)], PRICING);
  return {
    type: 'lyrics.transcribe',
    projectId: req.projectId,
    modelId: MODEL_REGISTRY.transcription.id,
    label: req.label ?? 'Extract lyrics',
    params: { songId: req.songId, audioAssetId: asset.id, storagePath: asset.storagePath, mimeType: asset.mimeType, durationSec, languageCode: req.languageCode ?? null },
    estimate,
    target: { kind: 'song', id: req.songId },
  };
}

async function prepareLyricsAlign(uid: string, req: LyricsAlignJobRequest): Promise<PreparedJob> {
  const { song, asset, durationSec } = await songAudio(uid, req.projectId, req.songId, req.audioAssetId);
  if (song.instrumental) bad('This song is marked instrumental — there are no lyrics to synchronise.');
  if (!song.lyricsSheet?.lines.length) bad('Add, generate or extract the lyrics first.');
  const cached = !req.retranscribe && song.asr?.audioAssetId === asset.id && song.asr.words.length > 0;
  const parts = [estimateText({ modelId: MODEL_REGISTRY.reasoning.id, inputChars: 4000 + JSON.stringify(song.lyricsSheet!.lines.map((l) => l.text)).length, expectedOutputTokens: 3000, audioSeconds: durationSec }, PRICING)];
  if (!cached) parts.push(estimateTranscription({ seconds: durationSec }, PRICING));
  const estimate = sumEstimates(parts, PRICING);
  if (cached) estimate.notes.push('Reuses the cached word-timed transcription of this audio.');
  return {
    type: 'lyrics.align',
    projectId: req.projectId,
    modelId: MODEL_REGISTRY.transcription.id,
    label: req.label ?? 'Synchronise lyrics',
    params: { songId: req.songId, audioAssetId: asset.id, storagePath: asset.storagePath, mimeType: asset.mimeType, durationSec, languageCode: req.languageCode ?? song.lyricsSheet!.language ?? null, useCache: cached },
    estimate,
    target: { kind: 'song', id: req.songId },
  };
}

export async function prepareJob(uid: string, req: JobRequest): Promise<PreparedJob> {
  switch (req.type) {
    case 'video.generate':
      return prepareVideo(uid, req);
    case 'image.generate':
      return prepareImage(uid, req);
    case 'text.assist':
      return prepareText(uid, req);
    case 'audio.analyze':
      return prepareAudio(uid, req);
    case 'render.timeline':
      return prepareRender(uid, req);
    case 'speech.generate':
      return prepareSpeech(uid, req);
    case 'music.generate':
      return prepareMusic(uid, req);
    case 'lyrics.transcribe':
      return prepareLyricsTranscribe(uid, req);
    case 'lyrics.align':
      return prepareLyricsAlign(uid, req);
  }
}
