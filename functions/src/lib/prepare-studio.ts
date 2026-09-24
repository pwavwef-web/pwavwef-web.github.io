import { HttpsError } from 'firebase-functions/v2/https';
import {
  estimateImage,
  estimateInspection,
  estimateLocalCompute,
  estimateMusic,
  estimateSeparation,
  estimateText,
  estimateTranscription,
  estimateVision,
  replacementPrompt,
  SET_VIEW_LABELS,
  sumEstimates,
  type AnalyzeSubjectsJobRequest,
  type ColorMatchJobRequest,
  type ContinuityCompareJobRequest,
  type FinalInspectJobRequest,
  type LocationDoc,
  type LyricsResyncAudioJobRequest,
  type MusicAnalyzeJobRequest,
  type MusicArrangeJobRequest,
  type MusicMixJobRequest,
  type MusicProjectDoc,
  type MusicReplaceSectionJobRequest,
  type MusicVersionDoc,
  type ProtectedScreenDoc,
  type ReferencePackJobRequest,
  type RenderDoc,
  type ScreenReplaceJobRequest,
  type SetBibleDoc,
  type StemsJobRequest,
  type VisualBibleDoc,
  VISUAL_BIBLE_ID,
} from '@az-studio/shared';
import { IMAGE_CAPABILITIES, MODEL_REGISTRY, SEPARATION_CAPABILITIES } from '../config/models';
import { PRICING } from '../config/pricing';
import { col } from './firebase';
import { loadAssets, type PreparedJob } from './prepare';

/**
 * Validation, pricing and parameters for the Continuity Director, finishing and Music Studio jobs.
 * Everything a worker needs is resolved here (paths, durations, prompts) so workers never trust the client.
 */

function bad(message: string): never {
  throw new HttpsError('invalid-argument', message);
}

async function project(uid: string, projectId: string) {
  const snap = await col.projects().doc(projectId).get();
  if (!snap.exists || snap.get('ownerUid') !== uid) bad('Project not found.');
  return snap;
}

// ---------------------------------------------------------------------------
// Set reference pack (Nano Banana Pro)
// ---------------------------------------------------------------------------

const VIEW_BRIEF: Record<string, string> = {
  wide: 'Wide establishing view of the whole set from its most characteristic angle.',
  front: 'Camera standing near the south wall, facing the NORTH wall.',
  rear: 'Camera standing near the north wall, facing the SOUTH wall.',
  left: 'Camera standing near the east wall, facing the WEST wall.',
  right: 'Camera standing near the west wall, facing the EAST wall.',
};

/** Where each floor-plan item appears from a view (left/right/centre, foreground/background). */
export function describeFromView(view: string, items: SetBibleDoc['floorPlan']): string[] {
  if (view === 'wide') return items.filter((i) => i.kind !== 'zone' && i.kind !== 'camera').map((i) => `${i.label || i.kind} (${i.kind}) at plan position ${Math.round(i.x * 100)}% east, ${Math.round(i.y * 100)}% south`);
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === 'zone' || it.kind === 'camera') continue;
    const cx = it.x + it.w / 2;
    const cy = it.y + it.h / 2;
    // Screen x (0 left … 1 right) and depth (0 near … 1 far) for a camera facing the given wall.
    const [sx, depth] = view === 'front' ? [cx, 1 - cy] : view === 'rear' ? [1 - cx, cy] : view === 'left' ? [1 - cy, 1 - cx] : [cy, cx];
    if (depth < 0.08) continue;
    const side = sx < 0.35 ? 'on the left' : sx > 0.65 ? 'on the right' : 'in the centre';
    const far = depth > 0.75 ? 'against the far wall' : depth > 0.4 ? 'in the middle distance' : 'in the foreground';
    out.push(`${it.label || it.kind} ${side}, ${far}`);
  }
  return out;
}

export async function prepareReferencePack(uid: string, req: ReferencePackJobRequest): Promise<PreparedJob> {
  const proj = await project(uid, req.projectId);
  const loc = await proj.ref.collection('locations').doc(req.locationId).get();
  if (!loc.exists) bad('Location not found.');
  const location = loc.data() as LocationDoc;
  const setSnap = await proj.ref.collection('setBibles').doc(req.locationId).get();
  const set = setSnap.exists ? (setSnap.data() as SetBibleDoc) : null;
  if (set?.canonical.status === 'locked') bad('This set is locked. Unlock it before generating a new reference pack.');
  if (!IMAGE_CAPABILITIES.aspectRatios.includes(req.aspectRatio)) bad(`${IMAGE_CAPABILITIES.displayName} supports aspect ratios ${IMAGE_CAPABILITIES.aspectRatios.join(', ')}.`);
  if (!IMAGE_CAPABILITIES.imageSizes.includes(req.imageSize)) bad(`${IMAGE_CAPABILITIES.displayName} supports sizes ${IMAGE_CAPABILITIES.imageSizes.join(', ')}.`);
  const vb = (await proj.ref.collection('visualBibles').doc(VISUAL_BIBLE_ID).get()).data() as VisualBibleDoc | undefined;
  const style = vb?.approved ? Object.entries(vb.approved.entries).filter(([, e]) => e && e.level !== 'flexible' && e.value.trim()).map(([k, e]) => `${k}: ${e!.value}`).join('; ') : '';
  // An existing wide view (or the location's primary reference) anchors every other view.
  const anchor = set?.views.wide ?? location.primaryRefAssetId ?? null;
  if (anchor) await loadAssets(uid, [anchor]);
  const views = [...new Set(req.views)];
  const needsWide = !anchor && views.some((v) => v !== 'wide') && !views.includes('wide');
  if (needsWide) views.unshift('wide');
  const plan = set?.floorPlan ?? [];
  const common = [
    `Production-design reference of the set “${location.name}”: ${[location.description, location.atmosphere, location.timeOfDay && `time of day ${location.timeOfDay}`, set?.wallColours && `walls ${set.wallColours}`, set?.materials && `materials ${set.materials}`].filter(Boolean).join('; ')}.`,
    set?.neverChange.length ? `Never change: ${set.neverChange.join('; ')}.` : '',
    set?.protectedFeatures.length ? `Protected features: ${set.protectedFeatures.join('; ')}.` : '',
    set?.lighting.keyDirection ? `Key light: ${set.lighting.keyDirection}${set.lighting.colour ? `, ${set.lighting.colour}` : ''}.` : '',
    style ? `Project look: ${style}.` : '',
    req.direction ? `Director’s note: ${req.direction}` : '',
    'No people, no text overlays, no watermarks. Photoreal, even exposure, the whole room visible.',
  ].filter(Boolean);
  const prompts = views.map((v) => ({
    view: v,
    prompt: [
      ...common,
      `View: ${SET_VIEW_LABELS[v]} — ${VIEW_BRIEF[v]}`,
      describeFromView(v, plan).length ? `Layout from this view (from the floor plan): ${describeFromView(v, plan).join('; ')}.` : '',
      v !== 'wide' ? 'This is the SAME room as the reference image, seen from another direction: identical architecture, doors, windows, furniture, colours, materials and light; only the camera direction changes. Keep the layout geometrically consistent with the reference.' : '',
    ]
      .filter(Boolean)
      .join('\n'),
  }));
  const per = estimateImage({ imageSize: req.imageSize, referenceImages: anchor ? 1 : 0, promptChars: 1500, outputs: 1 }, PRICING);
  const estimate = sumEstimates(prompts.map(() => per), PRICING);
  estimate.notes.push('Each view is generated with the wide view as its reference so the pack stays coherent; nothing is locked until you approve it.');
  return {
    type: 'reference.pack',
    projectId: req.projectId,
    modelId: MODEL_REGISTRY.image.id,
    label: req.label ?? `Reference pack · ${location.name} (${views.length} view${views.length === 1 ? '' : 's'})`,
    params: { locationId: req.locationId, anchorAssetId: anchor, views: prompts, imageSize: req.imageSize, aspectRatio: req.aspectRatio, locationName: location.name },
    estimate,
    target: { kind: 'set', id: req.locationId },
  };
}

// ---------------------------------------------------------------------------
// Continuity comparison across shots (backgrounds of one location, approved frames)
// ---------------------------------------------------------------------------

export async function prepareContinuityCompare(uid: string, req: ContinuityCompareJobRequest): Promise<PreparedJob> {
  const proj = await project(uid, req.projectId);
  const shots = await Promise.all(req.shotIds.map((id) => proj.ref.collection('shots').doc(id).get()));
  const items: { shotId: string; title: string; assetId: string; storagePath: string; durationSec: number }[] = [];
  for (const s of shots) {
    if (!s.exists) bad('A shot no longer exists.');
    const takeId = (s.get('approvedTakeId') as string | null) ?? (s.get('selectedTakeId') as string | null);
    if (!takeId) bad(`“${s.get('title')}” has no approved or selected take to compare.`);
    const take = await s.ref.collection('takes').doc(takeId!).get();
    const assetId = take.get('assetId') as string | null;
    if (!assetId) bad(`“${s.get('title')}” has no video.`);
    const a = (await loadAssets(uid, [assetId!])).get(assetId!)!;
    items.push({ shotId: s.id, title: String(s.get('title') ?? ''), assetId: a.id, storagePath: a.storagePath, durationSec: a.durationSec ?? 8 });
  }
  const total = items.reduce((t, i) => t + i.durationSec, 0);
  const estimate = sumEstimates([estimateInspection({ modelId: MODEL_REGISTRY.reasoning.id, durationSec: total, referenceImages: 4, promptChars: 6000 }, PRICING)], PRICING);
  return { type: 'continuity.compare', projectId: req.projectId, modelId: MODEL_REGISTRY.reasoning.id, label: req.label ?? `Continuity comparison · ${items.length} shots`, params: { items }, estimate, target: { kind: 'project', id: req.projectId } };
}

// ---------------------------------------------------------------------------
// Screen replacement, colour match, subject analysis
// ---------------------------------------------------------------------------

export async function prepareScreenReplace(uid: string, req: ScreenReplaceJobRequest): Promise<PreparedJob> {
  const proj = await project(uid, req.projectId);
  const src = (await loadAssets(uid, [req.sourceAssetId])).get(req.sourceAssetId)!;
  if (src.kind !== 'video') bad('Screen replacement works on video.');
  const screenSnap = await proj.ref.collection('protectedScreens').doc(req.screenId).get();
  if (!screenSnap.exists) bad('Protected screen not found.');
  const screen = { ...(screenSnap.data() as ProtectedScreenDoc), id: screenSnap.id };
  const contentId = screen.contentAssetId ?? screen.referenceAssetId;
  if (!contentId) bad(`Add the approved content (interface capture or graphic) to “${screen.name}” first.`);
  const content = (await loadAssets(uid, [contentId!])).get(contentId!)!;
  if (content.kind !== 'image' && content.kind !== 'video') bad('Screen content must be an image or a video.');
  const d = src.durationSec ?? 8;
  const estimate = sumEstimates([estimateText({ modelId: MODEL_REGISTRY.reasoning.id, inputChars: 3000, expectedOutputTokens: 3000, audioSeconds: 0 }, PRICING), estimateVision({ images: Math.ceil(d * 2) * 2, features: 1 }, PRICING), estimateLocalCompute('Perspective composite (FFmpeg)', PRICING)], PRICING);
  estimate.notes.push('The screen corners are located on every sampled frame, the approved content is composited with matched brightness, blur and reflection, and the result is read back with OCR.');
  return {
    type: 'media.screen_replace',
    projectId: req.projectId,
    modelId: MODEL_REGISTRY.reasoning.id,
    label: req.label ?? `Screen replacement · ${screen.name}`,
    params: { sourceAssetId: src.id, storagePath: src.storagePath, width: src.width, height: src.height, durationSec: d, fps: src.fps, screen, content: { assetId: content.id, storagePath: content.storagePath, kind: content.kind, mimeType: content.mimeType }, shotId: req.shotId ?? null },
    estimate,
    target: req.shotId ? { kind: 'shot', id: req.shotId } : { kind: 'screen', id: req.screenId },
  };
}

export async function prepareColorMatch(uid: string, req: ColorMatchJobRequest): Promise<PreparedJob> {
  const proj = await project(uid, req.projectId);
  const src = (await loadAssets(uid, [req.sourceAssetId])).get(req.sourceAssetId)!;
  if (src.kind !== 'video' && src.kind !== 'image') bad('Colour matching works on video or stills.');
  const vb = (await proj.ref.collection('visualBibles').doc(VISUAL_BIBLE_ID).get()).data() as VisualBibleDoc | undefined;
  const refId = req.referenceAssetId ?? vb?.approved?.colour.referenceAssetId ?? null;
  if (!refId) bad('Choose a reference still, or approve one in the Colour Director.');
  const ref = (await loadAssets(uid, [refId!])).get(refId!)!;
  const lutId = req.applyLut ? vb?.approved?.colour.lutAssetId ?? null : null;
  const lut = lutId ? (await loadAssets(uid, [lutId])).get(lutId)! : null;
  if (lut && !/\.cube$/i.test(lut.fileName)) bad('The creative LUT must be a .cube file.');
  return {
    type: 'media.color_match',
    projectId: req.projectId,
    modelId: null,
    label: req.label ?? `Colour match · ${src.title}`,
    params: { source: { assetId: src.id, storagePath: src.storagePath, kind: src.kind, durationSec: src.durationSec, title: src.title }, reference: { assetId: ref.id, storagePath: ref.storagePath, kind: ref.kind }, strength: req.strength, lut: lut ? { storagePath: lut.storagePath, strength: vb?.approved?.colour.lutStrength ?? 0.6 } : null, skinTone: vb?.approved?.colour.skinTone ?? '', shotId: req.shotId ?? null },
    estimate: sumEstimates([estimateLocalCompute('Measured colour transfer (FFmpeg)', PRICING), estimateVision({ images: 4, features: 1 }, PRICING)], PRICING),
    target: req.shotId ? { kind: 'shot', id: req.shotId } : { kind: 'asset', id: src.id },
  };
}

export async function prepareAnalyzeSubjects(uid: string, req: AnalyzeSubjectsJobRequest): Promise<PreparedJob> {
  await project(uid, req.projectId);
  const assets = await loadAssets(uid, req.assetIds);
  let frames = 0;
  for (const a of assets.values()) {
    if (a.kind !== 'video' && a.kind !== 'image') bad(`“${a.title}” is not a picture.`);
    frames += a.kind === 'image' ? 1 : Math.min(120, Math.ceil((a.durationSec ?? 8) * req.fps) + 1);
  }
  return {
    type: 'media.analyze_subjects',
    projectId: req.projectId,
    modelId: MODEL_REGISTRY.vision.id,
    label: req.label ?? `Face & object tracking · ${assets.size} clip${assets.size === 1 ? '' : 's'}`,
    params: { assets: [...assets.values()].map((a) => ({ assetId: a.id, storagePath: a.storagePath, kind: a.kind, durationSec: a.durationSec, width: a.width, height: a.height })), fps: req.fps },
    estimate: estimateVision({ images: frames, features: 3 }, PRICING),
    target: { kind: 'project', id: req.projectId },
  };
}

// ---------------------------------------------------------------------------
// Final-film inspection
// ---------------------------------------------------------------------------

export async function prepareFinalInspect(uid: string, req: FinalInspectJobRequest): Promise<PreparedJob> {
  await project(uid, req.projectId);
  const r = await col.renders().doc(req.renderId).get();
  if (!r.exists || r.get('ownerUid') !== uid || r.get('projectId') !== req.projectId) bad('Render not found.');
  const render = { ...(r.data() as RenderDoc), id: r.id };
  if (render.status !== 'completed' || !render.outputAssetId) bad('Inspect a finished render.');
  const out = (await loadAssets(uid, [render.outputAssetId!])).get(render.outputAssetId!)!;
  const d = out.durationSec ?? render.durationSec;
  const samples = Math.min(90, Math.ceil(d));
  const estimate = sumEstimates(
    [
      estimateTranscription({ seconds: d }, PRICING),
      estimateVision({ images: samples, features: 2 }, PRICING),
      estimateText({ modelId: MODEL_REGISTRY.reasoning.id, inputChars: 12000, expectedOutputTokens: 5000, audioSeconds: 0 }, PRICING),
      estimateInspection({ modelId: MODEL_REGISTRY.reasoning.id, durationSec: Math.min(d, 60), referenceImages: 0, promptChars: 4000 }, PRICING),
    ],
    PRICING,
  );
  estimate.notes.push('The rendered file is measured (black and frozen frames, peaks, loudness, silence), transcribed, read with OCR and reviewed at the cuts and the ending.');
  return {
    type: 'final.inspect',
    projectId: req.projectId,
    modelId: MODEL_REGISTRY.reasoning.id,
    label: req.label ?? `Final-film inspection · ${render.preset} ${render.quality}`,
    params: { renderId: render.id, timelineId: render.timelineId, output: { assetId: out.id, storagePath: out.storagePath, width: out.width, height: out.height, durationSec: d } },
    estimate,
    target: { kind: 'render', id: render.id },
  };
}

// ---------------------------------------------------------------------------
// Music Studio
// ---------------------------------------------------------------------------

async function musicProject(uid: string, projectId: string, musicProjectId: string) {
  const proj = await project(uid, projectId);
  const mp = await proj.ref.collection('musicProjects').doc(musicProjectId).get();
  if (!mp.exists) bad('Music project not found.');
  return { proj, mp: { ...(mp.data() as MusicProjectDoc), id: mp.id } };
}

async function version(projectId: string, versionId: string) {
  const v = await col.sub(projectId, 'musicVersions').doc(versionId).get();
  if (!v.exists) bad('Music version not found.');
  return { ...(v.data() as MusicVersionDoc), id: v.id };
}

export async function prepareMusicAnalyze(uid: string, req: MusicAnalyzeJobRequest): Promise<PreparedJob> {
  await project(uid, req.projectId);
  const a = (await loadAssets(uid, [req.audioAssetId])).get(req.audioAssetId)!;
  if (a.kind !== 'audio' && !(a.kind === 'video' && a.hasAudio)) bad('Choose audio to analyse.');
  const d = a.durationSec ?? 180;
  const parts = [estimateLocalCompute('Beat, bar, key, energy and section analysis (DSP)', PRICING)];
  if (req.detectVocals) parts.push(estimateText({ modelId: MODEL_REGISTRY.reasoning.id, inputChars: 2000, expectedOutputTokens: 2500, audioSeconds: d }, PRICING));
  return {
    type: 'music.analyze',
    projectId: req.projectId,
    modelId: req.detectVocals ? MODEL_REGISTRY.reasoning.id : null,
    label: req.label ?? `Music analysis · ${a.title}`,
    params: { assetId: a.id, storagePath: a.storagePath, mimeType: a.mimeType, durationSec: d, musicProjectId: req.musicProjectId ?? null, versionId: req.versionId ?? null, detectVocals: req.detectVocals },
    estimate: sumEstimates(parts, PRICING),
    target: req.musicProjectId ? { kind: 'music_project', id: req.musicProjectId } : { kind: 'asset', id: a.id },
  };
}

export async function prepareMusicArrange(uid: string, req: MusicArrangeJobRequest): Promise<PreparedJob> {
  const { mp } = await musicProject(uid, req.projectId, req.musicProjectId);
  const v = await version(req.projectId, req.versionId);
  if (v.musicProjectId !== mp.id) bad('That version belongs to another music project.');
  if (!mp.sections.some((s) => !s.muted)) bad('Mark at least one section to keep.');
  const a = (await loadAssets(uid, [v.assetId])).get(v.assetId)!;
  return { type: 'music.arrange', projectId: req.projectId, modelId: null, label: req.label ?? `Arrangement · ${mp.brief.title || 'song'}`, params: { musicProjectId: mp.id, versionId: v.id, source: { assetId: a.id, storagePath: a.storagePath, durationSec: a.durationSec }, sections: mp.sections }, estimate: estimateLocalCompute('Arrangement render (FFmpeg)', PRICING), target: { kind: 'music_project', id: mp.id } };
}

export async function prepareMusicMix(uid: string, req: MusicMixJobRequest): Promise<PreparedJob> {
  const { mp } = await musicProject(uid, req.projectId, req.musicProjectId);
  const tracks = await col.sub(req.projectId, 'audioTracks').where('musicProjectId', '==', mp.id).get();
  if (tracks.empty) bad('Add tracks to the mix first (a version, stems or a recording).');
  const assets = await loadAssets(uid, tracks.docs.map((t) => String(t.get('assetId'))));
  const durationSec = Math.max(...tracks.docs.map((t) => (assets.get(String(t.get('assetId')))?.durationSec ?? 0) + Number(t.get('offsetSec') ?? 0)));
  if (durationSec > 20 * 60) bad('Mixdowns are limited to 20 minutes.');
  return {
    type: 'music.mix',
    projectId: req.projectId,
    modelId: null,
    label: req.label ?? `Mixdown · ${mp.brief.title || 'song'}`,
    params: { musicProjectId: mp.id, mix: mp.mix, durationSec, tracks: tracks.docs.map((t) => ({ ...t.data(), id: t.id, storagePath: assets.get(String(t.get('assetId')))!.storagePath })) },
    estimate: estimateLocalCompute('Mixdown with EQ, compression, ducking, loudness normalisation and limiting (FFmpeg)', PRICING),
    target: { kind: 'music_project', id: mp.id },
  };
}

export async function prepareMusicReplaceSection(uid: string, req: MusicReplaceSectionJobRequest): Promise<PreparedJob> {
  const { mp } = await musicProject(uid, req.projectId, req.musicProjectId);
  const v = await version(req.projectId, req.versionId);
  const section = mp.sections.find((s) => s.id === req.sectionId);
  if (!section) bad('Section not found.');
  const a = (await loadAssets(uid, [v.assetId])).get(v.assetId)!;
  const prompt = replacementPrompt({ brief: mp.brief, section: section!, analysis: v.analysis ? { bpm: v.analysis.bpm, key: v.analysis.key } : null, direction: req.direction, lyrics: req.lyrics ?? null });
  const estimate = estimateMusic({ songs: 1 }, PRICING);
  estimate.notes.push('Lyria cannot edit part of an existing song: it generates a new passage matched to the song’s tempo and key, which AZ Studio blends in at the section boundaries with beat-aligned crossfades.');
  return {
    type: 'music.replace_section',
    projectId: req.projectId,
    modelId: MODEL_REGISTRY.music.id,
    label: req.label ?? `Replacement passage · ${section!.name || section!.label}`,
    params: { musicProjectId: mp.id, versionId: v.id, section, source: { assetId: a.id, storagePath: a.storagePath, durationSec: a.durationSec }, prompt, beats: v.analysis?.beats ?? [], downbeats: v.analysis?.downbeats ?? [] },
    estimate,
    target: { kind: 'music_project', id: mp.id },
  };
}

export async function prepareStems(uid: string, req: StemsJobRequest): Promise<PreparedJob> {
  await project(uid, req.projectId);
  const a = (await loadAssets(uid, [req.audioAssetId])).get(req.audioAssetId)!;
  if (a.kind !== 'audio' && !(a.kind === 'video' && a.hasAudio)) bad('Choose audio to separate.');
  const d = a.durationSec ?? 180;
  if (d > SEPARATION_CAPABILITIES.maxAudioSeconds) bad(`Stem separation is limited to ${Math.round(SEPARATION_CAPABILITIES.maxAudioSeconds / 60)} minutes of audio.`);
  return {
    type: 'audio.stems',
    projectId: req.projectId,
    modelId: MODEL_REGISTRY.separation.id,
    label: req.label ?? `Stems · ${a.title}`,
    params: { assetId: a.id, storagePath: a.storagePath, durationSec: d, musicProjectId: req.musicProjectId ?? null, versionId: req.versionId ?? null, title: a.title },
    estimate: estimateSeparation({ audioSeconds: d }, PRICING),
    target: req.musicProjectId ? { kind: 'music_project', id: req.musicProjectId } : { kind: 'asset', id: a.id },
  };
}

export async function prepareLyricsResyncAudio(uid: string, req: LyricsResyncAudioJobRequest): Promise<PreparedJob> {
  await project(uid, req.projectId);
  const song = await col.songs(req.projectId).doc(req.songId).get();
  if (!song.exists) bad('Song not found.');
  if (!song.get('lyricsSheet')) bad('This song has no lyric sheet to re-synchronise.');
  const assets = await loadAssets(uid, [req.fromAssetId, req.toAssetId]);
  const from = assets.get(req.fromAssetId)!;
  const to = assets.get(req.toAssetId)!;
  for (const a of [from, to]) if (a.kind !== 'audio' && !(a.kind === 'video' && a.hasAudio)) bad('Choose two audio versions.');
  return {
    type: 'lyrics.resync_audio',
    projectId: req.projectId,
    modelId: null,
    label: req.label ?? 'Re-sync lyrics to a new audio version',
    params: { songId: req.songId, from: { assetId: from.id, storagePath: from.storagePath }, to: { assetId: to.id, storagePath: to.storagePath, durationSec: to.durationSec } },
    estimate: estimateLocalCompute('Audio alignment of the two versions (onset cross-correlation)', PRICING),
    target: { kind: 'song', id: req.songId },
  };
}
