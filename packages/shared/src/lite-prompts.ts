import { LITE_IMAGE_STYLE_PROMPTS, findShot, narrationHash, spokenText, stableHash, voiceDirection, type LiteScene, type LiteShot, type LiteSpec } from './lite';
import { MOTION_PRESET_LABELS } from './motion';

/**
 * Prompts for Film Studio Lite's paid requests, compiled the same way in the browser (to show and hash them)
 * and on the server (to send them). The prompt and reference inputs are recorded with every result so an
 * image can be repeated; a text prompt cannot guarantee an identical face, so references do the heavy lifting.
 */

const SCALE_WORDS: Record<LiteShot['scale'], string> = {
  establishing: 'Establishing extreme wide shot',
  wide: 'Wide shot',
  medium: 'Medium shot',
  close: 'Close-up',
  detail: 'Detail insert',
};

function placement(x: number, y: number): string {
  const h = x < 0.38 ? 'left third' : x > 0.62 ? 'right third' : 'centre';
  const v = y < 0.38 ? 'upper part' : y > 0.62 ? 'lower part' : 'middle';
  return h === 'centre' && v === 'middle' ? 'the centre of the frame' : `the ${v === 'middle' ? '' : `${v}, `}${h} of the frame`;
}

export interface LiteImageRequest {
  prompt: string;
  referenceAssetIds: string[];
  referenceLabels: string[];
  aspectRatio: string;
  imageSize: '2K' | '4K';
  hash: string;
}

/** Composition guidance so the still survives slow movement and every planned format. */
export function compositionForMotion(shot: Pick<LiteShot, 'motion'>, spec: { setup: Pick<LiteSpec['setup'], 'aspect' | 'extraAspects'> }): string {
  const m = shot.motion;
  const lines = [`Compose for a slow camera move (${MOTION_PRESET_LABELS[m.preset].toLowerCase()}): place the main subject in ${placement(m.focal.x, m.focal.y)} with generous space around it; keep everything essential away from the outer tenth of the frame.`];
  const formats = [spec.setup.aspect, ...spec.setup.extraAspects];
  if (formats.includes('9:16') && spec.setup.aspect !== '9:16') lines.push('The image will also be framed vertically: keep the main subject and faces within the central third horizontally.');
  if (formats.includes('16:9') && spec.setup.aspect === '9:16') lines.push('The image will also be framed as widescreen: keep the main subject within the central third vertically.');
  return lines.join(' ');
}

export function compileLiteImageRequest(spec: LiteSpec, scene: LiteScene, shot: LiteShot): LiteImageRequest {
  const b = spec.bible;
  const refs: { id: string; label: string }[] = [];
  const addRef = (id: string, label: string) => {
    if (refs.length < 14 && !refs.some((r) => r.id === id)) refs.push({ id, label });
  };
  const chars = shot.characterIds.map((id) => b.characters.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => Boolean(c));
  const loc = shot.locationId ? b.locations.find((l) => l.id === shot.locationId) ?? null : null;
  for (const c of chars) c.refAssetIds.slice(0, 3).forEach((id, i) => addRef(id, `${c.name} — likeness reference${c.refAssetIds.length > 1 ? ` ${i + 1}` : ''}`));
  if (loc) loc.refAssetIds.slice(0, 2).forEach((id) => addRef(id, `${loc.name} — location reference`));
  b.styleRefAssetIds.slice(0, 2).forEach((id) => addRef(id, 'Visual style reference (match its look, not its content)'));
  const refIndex = (id: string) => refs.findIndex((r) => r.id === id) + 1;

  const lines = [
    LITE_IMAGE_STYLE_PROMPTS[spec.setup.imageStyle],
    `${SCALE_WORDS[shot.scale]}. ${shot.brief.trim() || scene.narration.trim().slice(0, 400)}`,
    shot.composition.trim() ? `Composition: ${shot.composition.trim()}` : '',
    compositionForMotion(shot, spec),
    ...chars.map((c) => {
      const n = c.refAssetIds.slice(0, 3).map(refIndex).filter((x) => x > 0);
      return `${c.name}: ${c.description.trim()}${c.clothing.trim() ? ` Clothing: ${c.clothing.trim()}.` : ''}${n.length ? ` Match reference image${n.length > 1 ? 's' : ''} ${n.join(', ')} exactly for face, hair, skin tone and build.` : ''}`;
    }),
    loc ? `Location — ${loc.name}: ${loc.description.trim()}${loc.refAssetIds.length ? ` Match reference image ${refIndex(loc.refAssetIds[0]!)} for architecture and materials.` : ''}` : '',
    scene.mood.trim() ? `Mood: ${scene.mood.trim()}.` : '',
    b.imageTreatment.trim() ? `Visual language: ${b.imageTreatment.trim()}` : '',
    b.palette.trim() ? `Palette: ${b.palette.trim()}.` : '',
    b.lighting.trim() ? `Lighting: ${b.lighting.trim()}.` : '',
    `Avoid: ${[b.avoid.trim(), 'any readable text, captions, subtitles, logos, watermarks, borders or frames'].filter(Boolean).join('; ')}.`,
  ].filter(Boolean);
  const prompt = lines.join('\n').slice(0, 7800);
  const out = { prompt, referenceAssetIds: refs.map((r) => r.id), referenceLabels: refs.map((r) => r.label), aspectRatio: spec.setup.aspect, imageSize: spec.setup.imageSize };
  return { ...out, hash: stableHash(out) };
}

/** Terms that bias recognition of the narration: pronunciation terms, character and place names. */
export function liteVocabulary(spec: LiteSpec): string[] {
  const names = [...spec.bible.characters.map((c) => c.name), ...spec.bible.locations.map((l) => l.name), ...spec.pronunciation.map((p) => p.term)];
  return [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 1))].slice(0, 100);
}

export interface LiteNarrationRequest {
  sceneId: string;
  text: string;
  spokenText: string;
  voice: string;
  direction: string;
  languageCode: string;
  vocabulary: string[];
  hash: string;
}

export function compileNarrationRequest(spec: LiteSpec, scene: LiteScene): LiteNarrationRequest {
  return {
    sceneId: scene.id,
    text: scene.narration.trim(),
    spokenText: spokenText(scene.narration.trim(), spec.pronunciation),
    voice: spec.voice.voice,
    direction: voiceDirection(spec.voice),
    languageCode: spec.setup.language || 'en',
    vocabulary: liteVocabulary(spec),
    hash: narrationHash(scene, spec.voice, spec.pronunciation),
  };
}

/** Shots that need a generated image: no approved image, no upload chosen, not reusing another shot. */
export function shotsNeedingImages(spec: LiteSpec, only?: Set<string>): { scene: LiteScene; shot: LiteShot }[] {
  const out: { scene: LiteScene; shot: LiteShot }[] = [];
  for (const scene of spec.scenes)
    for (const shot of scene.shots) {
      if (only && !only.has(shot.id)) continue;
      if (shot.image.reuseOfShotId && findShot(spec, shot.image.reuseOfShotId)) continue;
      if (!only && shot.image.approvedAssetId) continue;
      out.push({ scene, shot });
    }
  return out;
}
