import { MOTION_PRESETS, type MotionPreset } from './motion';
import { liteId, type LiteCharacter, type LiteLocation, type ShotScale } from './lite';
import { sheetText } from './lyrics';
import { barsIn, energyBand, lyricsDuring, mvDirectionOf, mvSectionsFromSong, newMvShot, songSectionsInRange, spanEnergy, type MvLiteSpec, type MvSection, type MvSectionTransition, type MvShot, type MvSong } from './mvlite';
import { productionRange } from './range';

/** The structured output of the mvlite.shots planning task, as the model returns it. */
export interface MvPlanOut {
  sections?: {
    index?: number;
    idea?: string;
    mood?: string;
    transitionIn?: string;
    lyrics?: boolean;
    shots?: { brief?: string; composition?: string; scale?: string; characters?: string[]; location?: string; motion?: string; focusX?: number; focusY?: number; bars?: number; transitionIn?: string; reuseOf?: number }[];
  }[];
  notes?: string;
}

const SCALES: ShotScale[] = ['establishing', 'wide', 'medium', 'close', 'detail'];
const clamp01 = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d);

/** Turns the model's plan into sections: the song's structure is kept, its shots and ideas filled in. */
export function mvPlanFromModel(spec: MvLiteSpec, base: MvSection[], out: MvPlanOut): MvSection[] {
  const d = mvDirectionOf(spec.setup.direction);
  const byName = (name: string | undefined) => spec.bible.characters.find((c) => c.name.toLowerCase() === (name ?? '').trim().toLowerCase())?.id;
  const locByName = (name: string | undefined) => spec.bible.locations.find((l) => l.name.toLowerCase() === (name ?? '').trim().toLowerCase())?.id ?? null;
  const flat: MvShot[] = [];
  const plans = new Map<number, NonNullable<MvPlanOut['sections']>[number]>();
  for (const s of out.sections ?? []) if (Number.isInteger(s.index) && !plans.has(s.index!)) plans.set(s.index!, s);
  return base.map((sec, i) => {
    const p = plans.get(i);
    if (!p?.shots?.length) {
      flat.push(...sec.shots);
      return sec;
    }
    const shots = p.shots.map((x) => {
      const shot = newMvShot({
        brief: String(x.brief ?? '').slice(0, 1200),
        composition: String(x.composition ?? '').slice(0, 600),
        scale: (SCALES as string[]).includes(String(x.scale)) ? (x.scale as ShotScale) : 'medium',
        characterIds: (x.characters ?? []).map(byName).filter((v): v is string => Boolean(v)),
        locationId: locByName(x.location),
        bars: Math.max(0.5, Math.min(16, Math.round((Number(x.bars) || 2) * 4) / 4)),
        transitionIn: x.transitionIn === 'dissolve' || x.transitionIn === 'flash' ? x.transitionIn : 'cut',
        motion: { preset: (MOTION_PRESETS as readonly string[]).includes(String(x.motion)) ? (x.motion as MotionPreset) : 'push_in', intensity: d.motion.intensity, focal: { x: clamp01(x.focusX, 0.5), y: clamp01(x.focusY, 0.45) }, focalSize: null, ease: 'gentle', manual: null },
      });
      const src = typeof x.reuseOf === 'number' && x.reuseOf >= 0 ? flat[x.reuseOf] : undefined;
      if (src && !src.image.reuseOfShotId) shot.image.reuseOfShotId = src.id;
      return shot;
    });
    flat.push(...shots);
    const tr = p.transitionIn;
    return { ...sec, idea: String(p.idea ?? '').slice(0, 600), mood: String(p.mood ?? '').slice(0, 200), lyrics: p.lyrics !== false, transitionIn: i === 0 ? 'cut' : tr === 'dissolve' || tr === 'flash' || tr === 'fade_black' ? (tr as MvSectionTransition) : 'cut', shots };
  });
}

// ---------------------------------------------------------------------------
// Inputs of the planning tasks (the same in the workspace and in tests)
// ---------------------------------------------------------------------------

/** Input of the `mvlite.concept` task: the direction, the song's structure and energy, its lyrics and the idea. */
export function mvConceptInput(spec: MvLiteSpec, song: MvSong): Record<string, unknown> {
  const d = mvDirectionOf(spec.setup.direction);
  const range = productionRange(spec.song.range, song.durationSec);
  return {
    direction: { name: d.label, visual: d.visual, approach: d.approach, palette: d.palette, lighting: d.lighting },
    song: {
      title: song.title,
      durationSec: Math.round(range.end - range.start),
      bpm: song.analysis?.bpm ?? null,
      sections: songSectionsInRange(song.analysis?.sections ?? [], range).map((x) => ({ label: x.label, name: x.name, start: Math.round(x.start), end: Math.round(x.end), energy: Math.round(spanEnergy(song.analysis, x.start, x.end) * 100) / 100 })),
      language: song.sheet?.languageName ?? spec.setup.language,
    },
    lyrics: song.sheet && !song.instrumental ? sheetText(song.sheet) : '',
    idea: spec.concept.idea,
    characters: spec.bible.characters.map((c) => ({ name: c.name, description: c.description, clothing: c.clothing })),
  };
}

export interface MvConceptOut {
  title?: string;
  logline?: string;
  concept?: string;
  arc?: string;
  imagery?: string;
  tone?: string;
  characters?: { name?: string; description?: string; clothing?: string }[];
  locations?: { name?: string; description?: string }[];
  palette?: string;
  lighting?: string;
  imageTreatment?: string;
  notes?: string;
}

/** Applies a written concept: the treatment, new characters and locations (existing ones keep what they have). */
export function applyMvConcept(s: MvLiteSpec, out: MvConceptOut): MvLiteSpec {
  let chars: LiteCharacter[] = [...s.bible.characters];
  for (const c of out.characters ?? []) {
    if (!c.name?.trim()) continue;
    const key = c.name.trim().toLowerCase();
    if (chars.some((x) => x.name.toLowerCase() === key)) chars = chars.map((x) => (x.name.toLowerCase() === key ? { ...x, description: x.description || c.description || '', clothing: x.clothing || c.clothing || '' } : x));
    else chars.push({ id: liteId('ch'), name: c.name.trim(), description: c.description ?? '', clothing: c.clothing ?? '', refAssetIds: [] });
  }
  const locs: LiteLocation[] = [...s.bible.locations];
  for (const l of out.locations ?? []) if (l.name?.trim() && !locs.some((x) => x.name.toLowerCase() === l.name!.trim().toLowerCase())) locs.push({ id: liteId('lo'), name: l.name.trim(), description: l.description ?? '', refAssetIds: [] });
  return {
    ...s,
    concept: { ...s.concept, treatment: { title: out.title ?? '', logline: out.logline ?? '', concept: out.concept ?? '', arc: out.arc ?? '', imagery: out.imagery ?? '', tone: out.tone ?? '' }, approvedAt: null },
    bible: { ...s.bible, characters: chars, locations: locs, palette: out.palette || s.bible.palette, lighting: out.lighting || s.bible.lighting, imageTreatment: out.imageTreatment || s.bible.imageTreatment },
  };
}

/** Input of the `mvlite.shots` task: every song section with its bars, energy, suggested pace and lyrics. */
export function mvShotsInput(spec: MvLiteSpec, song: MvSong): Record<string, unknown> {
  const d = mvDirectionOf(spec.setup.direction);
  return {
    direction: { name: d.label, visual: d.visual, approach: d.approach, motion: d.motion, barsPerShot: d.barsPerShot },
    aspect: spec.setup.aspect,
    visualPlan: spec.setup.visualPlan,
    sections: mvSectionsFromSong(spec, song).map((s, i) => {
      const e = spanEnergy(song.analysis, s.start, s.end);
      return { index: i, label: s.label, name: s.name, bars: barsIn(song.analysis, s.start, s.end), energy: Math.round(e * 100) / 100, suggestedBarsPerShot: d.barsPerShot[energyBand(e)], lyrics: lyricsDuring(song.sheet, s.start, s.end).map((l) => l.text) };
    }),
    characters: spec.bible.characters.map((c) => ({ name: c.name, description: c.description })),
    locations: spec.bible.locations.map((l) => ({ name: l.name, description: l.description })),
    concept: spec.concept.treatment,
  };
}
