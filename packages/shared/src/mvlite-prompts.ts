import { LITE_IMAGE_STYLE_PROMPTS, stableHash, type ShotScale } from './lite';
import { compositionForMotion, type LiteImageRequest } from './lite-prompts';
import type { LyricsSheet } from './lyrics';
import { findMvShot, lyricsDuring, mvDirectionOf, type MvLiteSpec, type MvSection, type MvShot } from './mvlite';
import type { MvTiming } from './mvlite-timing';

/**
 * Prompts for Music Video Lite's images, compiled the same way in the browser (to show and hash them) and on
 * the server (to send them). A shot's prompt carries the section's mood and the lyric sung over it — to
 * be interpreted visually, never written into the picture (the lyrics are captioned separately).
 */

const SCALE_WORDS: Record<ShotScale, string> = {
  establishing: 'Establishing extreme wide shot',
  wide: 'Wide shot',
  medium: 'Medium shot',
  close: 'Close-up',
  detail: 'Detail insert',
};

/** Trimmed text ending in exactly one full stop (no “accent..” or a missing stop before the next sentence). */
const sentence = (s: string) => {
  const t = s.trim();
  return t ? (/[.!?…]$/.test(t) ? t : `${t}.`) : '';
};

/** The lyric lines sung over each shot (song time), from the current timing. */
export function shotLyrics(timing: MvTiming, sheet: LyricsSheet | null | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const st of timing.sections)
    for (const sh of st.shots) {
      const a = timing.songStart + sh.start;
      out[sh.shotId] = lyricsDuring(sheet, a, a + sh.duration).map((l) => l.text);
    }
  return out;
}

export function compileMvImageRequest(spec: MvLiteSpec, section: MvSection, shot: MvShot, lyrics: string[]): LiteImageRequest {
  const b = spec.bible;
  const d = mvDirectionOf(spec.setup.direction);
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
  const sung = lyrics.map((l) => l.trim()).filter(Boolean).join(' / ').slice(0, 400);
  const treatment = spec.concept.treatment;

  const lines = [
    LITE_IMAGE_STYLE_PROMPTS[spec.setup.imageStyle],
    `A still frame from a music video (${d.label.toLowerCase()}), ${section.name || section.label} of the song.`,
    `${SCALE_WORDS[shot.scale]}. ${shot.brief.trim() || section.idea.trim() || treatment?.concept.trim().slice(0, 300) || 'An evocative image for this moment of the song.'}`,
    shot.composition.trim() ? `Composition: ${shot.composition.trim()}` : '',
    compositionForMotion(shot, spec),
    spec.lyrics.enabled && spec.lyrics.burnIn && section.lyrics ? 'Lyrics will be captioned over the lower part of the frame: keep faces and the main subject out of the bottom fifth.' : '',
    sung ? `Sung over this image: “${sung}” — express its feeling visually; never write these words or any text in the image.` : '',
    ...chars.map((c) => {
      const n = c.refAssetIds.slice(0, 3).map(refIndex).filter((x) => x > 0);
      // Wardrobe is a rule, not a description: the final inspection blocks outfits that change between cuts.
      return `${c.name}: ${sentence(c.description)}${c.clothing.trim() ? ` Wardrobe — identical in every image of the video: ${sentence(c.clothing)} No other garments or accessories, nothing added or removed.` : ''}${n.length ? ` Match reference image${n.length > 1 ? 's' : ''} ${n.join(', ')} exactly for face, hair, skin tone and build${c.clothing.trim() ? ', but dress them as described here, not as in the reference' : ''}.` : ''}`;
    }),
    loc ? `Location — ${loc.name}: ${sentence(loc.description)}${loc.refAssetIds.length ? ` Match reference image ${refIndex(loc.refAssetIds[0]!)} for architecture and materials.` : ''}` : '',
    section.mood.trim() ? `Mood: ${sentence(section.mood)}` : '',
    treatment?.imagery.trim() ? `Recurring imagery of the video: ${sentence(treatment.imagery.trim().slice(0, 400))}` : '',
    b.imageTreatment.trim() ? `Visual language: ${sentence(b.imageTreatment)}` : '',
    b.palette.trim() ? `Palette: ${sentence(b.palette)}` : '',
    b.lighting.trim() ? `Lighting: ${sentence(b.lighting)}` : '',
    `Avoid: ${[b.avoid.trim().replace(/[.;]+$/, ''), 'any readable text, lyrics, captions, subtitles, logos, watermarks, borders or frames', chars.some((c) => c.clothing.trim()) ? 'changing anyone’s clothing from the wardrobe above' : ''].filter(Boolean).join('; ')}.`,
  ].filter(Boolean);
  const prompt = lines.join('\n').slice(0, 7800);
  const out = { prompt, referenceAssetIds: refs.map((r) => r.id), referenceLabels: refs.map((r) => r.label), aspectRatio: spec.setup.aspect, imageSize: spec.setup.imageSize };
  return { ...out, hash: stableHash(out) };
}

/** Shots that need a generated image: no approved image and not reusing another shot. */
export function mvShotsNeedingImages(spec: MvLiteSpec, only?: Set<string>): { section: MvSection; shot: MvShot }[] {
  const out: { section: MvSection; shot: MvShot }[] = [];
  for (const section of spec.sections)
    for (const shot of section.shots) {
      if (only && !only.has(shot.id)) continue;
      if (shot.image.reuseOfShotId && findMvShot(spec, shot.image.reuseOfShotId)) continue;
      if (!only && shot.image.approvedAssetId) continue;
      out.push({ section, shot });
    }
  return out;
}
