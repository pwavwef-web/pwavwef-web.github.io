import { liteId, stableHash, type LiteAspect, type LiteBible, type LiteImageStyle, type ShotImageCandidate, type ShotScale } from './lite';
import type { LyricCaptionMode, LyricsSheet } from './lyrics';
import type { LyricPreset } from './lyric-style';
import { DEFAULT_SHOT_MOTION, MOTION_PRESETS, type ClipLook, type MotionEase, type MotionPreset, type ShotMotion } from './motion';
import { productionRange, type TimeRange } from './range';
import { SECTION_LABELS, type SectionLabel, type SongAnalysis, type SongSection } from './types';

/**
 * Music Video Lite: a music video made from still images, slow camera motion and the song. The song is the
 * clock — sections follow its structure and every cut lands on its beat grid; the lyrics (synchronised to
 * the vocals) become captions. Like Film Studio Lite it never calls a video-generation or lip-sync model:
 * motion is made locally from the stills. The draft lives on the project (`project.mvlite`) and paid
 * images are durable jobs targeted at a shot, never requested twice for the same input.
 */

export const MV_STAGES = ['song', 'concept', 'shots', 'edit', 'export'] as const;
export type MvStage = (typeof MV_STAGES)[number];
export const MV_STAGE_LABELS: Record<MvStage, string> = { song: 'Song & lyrics', concept: 'Concept', shots: 'Shots', edit: 'Edit', export: 'Export' };

export const MV_DIRECTIONS = ['performance', 'narrative', 'atmospheric', 'lyric_visual', 'heritage', 'night_city'] as const;
export type MvDirectionId = (typeof MV_DIRECTIONS)[number];

/** Section energy band, measured from the song (drives the cut pace). */
export type EnergyBand = 'low' | 'mid' | 'high';

export interface MvDirection {
  id: MvDirectionId;
  label: string;
  blurb: string;
  imageStyle: LiteImageStyle;
  visual: string;
  palette: string;
  lighting: string;
  /** Planned bars per shot by section energy (a pace, not a rule). */
  barsPerShot: Record<EnergyBand, number>;
  motion: { prefer: MotionPreset[]; intensity: number; stillShare: number };
  /** Share of section changes that dissolve (the rest cut or flash). */
  dissolveShare: number;
  /** Choruses open with a flash (dip to white) instead of a cut. */
  flashOnChorus: boolean;
  captionMode: Exclude<LyricCaptionMode, 'vertical'>;
  lyricPreset: LyricPreset;
  look: Omit<ClipLook, 'seed'>;
  approach: string;
}

export const MV_DIRECTION_PRESETS: Record<MvDirectionId, MvDirection> = {
  performance: {
    id: 'performance',
    label: 'Performance',
    blurb: 'The artist at the centre: stage light, portraits, the band.',
    imageStyle: 'cinematic_realism',
    visual: 'The performer sings and plays: portraits from low and eye level, hands on instruments, the crowd and the stage, backlit haze, the band between lines.',
    palette: 'Deep blacks, saturated stage colour (amber, magenta, cyan), warm skin',
    lighting: 'Stage and concert light: hard backlight through haze, spotlights, practical bulbs',
    barsPerShot: { low: 4, mid: 2, high: 1 },
    motion: { prefer: ['push_in', 'pan_right', 'pull_out', 'still', 'drift'], intensity: 0.07, stillShare: 0.15 },
    dissolveShare: 0.15,
    flashOnChorus: true,
    captionMode: 'karaoke',
    lyricPreset: 'karaoke',
    look: { grain: 0.25, vignette: 0.3, haze: 0.2, warmth: 0.1 },
    approach: 'Verses stay close on the performer; choruses open up to the stage and the crowd; the bridge breaks the pattern (a quiet portrait, a detail, an empty stage).',
  },
  narrative: {
    id: 'narrative',
    label: 'Story video',
    blurb: 'A short story told across the song, with a turn at the bridge.',
    imageStyle: 'cinematic_realism',
    visual: 'A short film in stills: recurring characters in real places, story beats per section, reaction close-ups, establishing wides.',
    palette: 'Natural, cinematic colour with one recurring accent',
    lighting: 'Motivated, cinematic light; golden hour and night interiors',
    barsPerShot: { low: 4, mid: 2, high: 2 },
    motion: { prefer: ['push_in', 'still', 'pan_right', 'pull_out', 'tilt_down'], intensity: 0.06, stillShare: 0.2 },
    dissolveShare: 0.3,
    flashOnChorus: false,
    captionMode: 'line',
    lyricPreset: 'line_by_line',
    look: { grain: 0.3, vignette: 0.25, haze: 0.1, warmth: 0.15 },
    approach: 'Set up the characters and their want in the first verse; the chorus returns to one emotional image; the second verse complicates; the bridge is the turn; the final chorus resolves it.',
  },
  atmospheric: {
    id: 'atmospheric',
    label: 'Atmospheric mood',
    blurb: 'Places, light and texture that feel like the song.',
    imageStyle: 'cinematic_realism',
    visual: 'Mood over plot: landscapes, weather, empty rooms, textures, silhouettes, light through windows; few faces.',
    palette: 'Muted and tonal, following the song’s colour',
    lighting: 'Soft, atmospheric light: fog, dusk, dawn, moonlight',
    barsPerShot: { low: 8, mid: 4, high: 2 },
    motion: { prefer: ['drift', 'push_in', 'pan_left', 'pull_out', 'still'], intensity: 0.05, stillShare: 0.25 },
    dissolveShare: 0.55,
    flashOnChorus: false,
    captionMode: 'line',
    lyricPreset: 'minimal_cinematic',
    look: { grain: 0.3, vignette: 0.35, haze: 0.3, warmth: 0 },
    approach: 'Let each section be one place or one light; slow, long images; dissolve between sections; save the most striking image for the last chorus.',
  },
  lyric_visual: {
    id: 'lyric_visual',
    label: 'Lyric visualiser',
    blurb: 'Every line pictured; the words on screen are the star.',
    imageStyle: 'illustration',
    visual: 'Each image interprets the line being sung as a clear visual metaphor; graphic, uncluttered compositions with room for the lyrics.',
    palette: 'Bold, graphic colour fields with strong contrast for the text',
    lighting: 'Clean, graphic light',
    barsPerShot: { low: 4, mid: 2, high: 2 },
    motion: { prefer: ['push_in', 'drift', 'pull_out', 'pan_right'], intensity: 0.05, stillShare: 0.1 },
    dissolveShare: 0.35,
    flashOnChorus: true,
    captionMode: 'karaoke',
    lyricPreset: 'large_centred',
    look: { grain: 0.1, vignette: 0.15, haze: 0, warmth: 0 },
    approach: 'Follow the lyric line by line: one image per sung line where the pace allows; the chorus keeps one recognisable image world each time it returns.',
  },
  heritage: {
    id: 'heritage',
    label: 'Heritage & dance',
    blurb: 'Village, market and festival: dance, cloth, rhythm and ancestry.',
    imageStyle: 'cinematic_realism',
    visual: 'Celebration and place: dancers mid-step, drummers, patterned cloth, painted walls, markets, elders and children, the land at dusk.',
    palette: 'Ochre, indigo, kente gold and green, earth reds',
    lighting: 'Golden-hour sun, firelight at night, bright midday colour',
    barsPerShot: { low: 4, mid: 2, high: 1 },
    motion: { prefer: ['pan_right', 'push_in', 'tilt_up', 'pull_out', 'still'], intensity: 0.065, stillShare: 0.15 },
    dissolveShare: 0.25,
    flashOnChorus: true,
    captionMode: 'karaoke',
    lyricPreset: 'karaoke',
    look: { grain: 0.25, vignette: 0.25, haze: 0.1, warmth: 0.3 },
    approach: 'Open on the land and the people; verses visit daily life and craft; choruses are the dance and the gathering; end at dusk around the fire.',
  },
  night_city: {
    id: 'night_city',
    label: 'Night city',
    blurb: 'Neon, rain, traffic light and late-night streets.',
    imageStyle: 'cinematic_realism',
    visual: 'Urban night: neon reflections on wet streets, taxis, rooftops, a figure walking alone, convenience-store light, the city from above.',
    palette: 'Teal and magenta neon, sodium orange, deep blue-black',
    lighting: 'Night practicals, neon signs, headlights and rain bokeh',
    barsPerShot: { low: 4, mid: 2, high: 1 },
    motion: { prefer: ['pan_left', 'push_in', 'drift', 'pull_out', 'still'], intensity: 0.065, stillShare: 0.15 },
    dissolveShare: 0.2,
    flashOnChorus: false,
    captionMode: 'phrase',
    lyricPreset: 'lower_third',
    look: { grain: 0.3, vignette: 0.3, haze: 0.15, warmth: -0.2 },
    approach: 'Verses are close and lonely (one figure, reflections); choruses widen to the whole city; the bridge goes quiet (a rooftop, an empty street).',
  },
};

// ---------------------------------------------------------------------------
// Draft shape
// ---------------------------------------------------------------------------

export interface MvTreatment {
  title: string;
  logline: string;
  /** The visual idea in a paragraph. */
  concept: string;
  /** How the video develops across the song (sections). */
  arc: string;
  /** Recurring images and motifs. */
  imagery: string;
  tone: string;
}

export type MvTransition = 'cut' | 'dissolve' | 'flash';
export type MvSectionTransition = MvTransition | 'fade_black';

export interface MvShot {
  id: string;
  /** What the image shows (becomes the image prompt). */
  brief: string;
  composition: string;
  scale: ShotScale;
  characterIds: string[];
  locationId: string | null;
  /** Planned length in bars; the section's real bars are shared out in proportion. */
  bars: number;
  image: {
    approvedAssetId: string | null;
    uploads: ShotImageCandidate[];
    /** Reuse another shot's image with different framing (a chorus callback, an economical plan). */
    reuseOfShotId: string | null;
  };
  motion: ShotMotion;
  transitionIn: MvTransition;
  look: Partial<ClipLook> | null;
  note: string;
}

export interface MvSection {
  id: string;
  label: SectionLabel;
  name: string;
  /** Song time (s), on the beat grid. */
  start: number;
  end: number;
  /** Visual idea of the section (why it exists in the video). */
  idea: string;
  mood: string;
  shots: MvShot[];
  transitionIn: MvSectionTransition;
  /** Lyrics show in this section (off for a full-screen moment that should stay clean). */
  lyrics: boolean;
}

export interface MvLyricSettings {
  enabled: boolean;
  /** Burned into the picture (otherwise only exported as a sidecar file). */
  burnIn: boolean;
  mode: Exclude<LyricCaptionMode, 'vertical'>;
  preset: LyricPreset;
}

export interface MvSetup {
  direction: MvDirectionId;
  aspect: LiteAspect;
  extraAspects: LiteAspect[];
  fps: 24 | 25 | 30;
  language: string;
  imageStyle: LiteImageStyle;
  imageSize: '2K' | '4K';
  visualPlan: 'economical' | 'rich';
  /** Cuts land on bar lines (downbeats) or on any beat. */
  cutOn: 'downbeat' | 'beat';
  look: ClipLook;
}

export interface MvLiteSpec {
  version: 1;
  stage: MvStage;
  setup: MvSetup;
  /** The song (a `songs` document of this project) and the part of it the video uses. */
  song: { songId: string | null; range: TimeRange | null };
  concept: { idea: string; treatment: MvTreatment | null; approvedAt: number | null };
  bible: LiteBible;
  sections: MvSection[];
  lyrics: MvLyricSettings;
  sound: { gainDb: number; fadeInSec: number; fadeOutSec: number; /** Picture held after the song ends (s). */ tailSec: number };
  timelines: Partial<Record<LiteAspect, string>>;
  renders: { renderId: string; aspect: LiteAspect; quality: 'draft' | 'final'; at: number }[];
  importedFrom: { projectId: string; title: string; at: number } | null;
  updatedAt: number;
}

/** The song as the workspace reads it: audio, measured length, beat grid and lyric sheet. */
export interface MvSong {
  id: string;
  title: string;
  audioAssetId: string;
  durationSec: number;
  analysis: Pick<SongAnalysis, 'bpm' | 'beats' | 'downbeats' | 'energy' | 'energyHop' | 'sections'> | null;
  sheet: LyricsSheet | null;
  instrumental: boolean;
}

// ---------------------------------------------------------------------------
// Defaults and normalisation
// ---------------------------------------------------------------------------

export function mvDirectionOf(id: MvDirectionId | string | undefined): MvDirection {
  return MV_DIRECTION_PRESETS[(MV_DIRECTIONS as readonly string[]).includes(String(id)) ? (id as MvDirectionId) : 'performance'];
}

export function defaultMvLyrics(d: MvDirection): MvLyricSettings {
  return { enabled: true, burnIn: true, mode: d.captionMode, preset: d.lyricPreset };
}

export function defaultMvLiteSpec(input: { direction?: MvDirectionId; aspect?: LiteAspect; idea?: string; language?: string } = {}): MvLiteSpec {
  const d = mvDirectionOf(input.direction);
  return {
    version: 1,
    stage: 'song',
    setup: { direction: d.id, aspect: input.aspect ?? '16:9', extraAspects: [], fps: 24, language: input.language ?? 'en', imageStyle: d.imageStyle, imageSize: '2K', visualPlan: 'rich', cutOn: 'downbeat', look: { ...d.look, seed: 11 } },
    song: { songId: null, range: null },
    concept: { idea: input.idea ?? '', treatment: null, approvedAt: null },
    bible: { characters: [], locations: [], palette: d.palette, lighting: d.lighting, imageTreatment: d.visual, styleRefAssetIds: [], avoid: 'Readable text, logos, watermarks, microphones covering faces, distorted hands, extra limbs' },
    sections: [],
    lyrics: defaultMvLyrics(d),
    sound: { gainDb: 0, fadeInSec: 0.6, fadeOutSec: 2.5, tailSec: 1.5 },
    timelines: {},
    renders: [],
    importedFrom: null,
    updatedAt: Date.now(),
  };
}

/** Changing the direction re-derives what it controls (look, pace defaults, lyric style) — the plan is kept. */
export function applyMvDirection(spec: MvLiteSpec, id: MvDirectionId): MvLiteSpec {
  const d = mvDirectionOf(id);
  return {
    ...spec,
    setup: { ...spec.setup, direction: d.id, imageStyle: d.imageStyle, look: { ...d.look, seed: spec.setup.look.seed } },
    bible: { ...spec.bible, palette: d.palette, lighting: d.lighting, imageTreatment: d.visual },
    lyrics: { ...spec.lyrics, mode: d.captionMode, preset: d.lyricPreset },
  };
}

export function newMvShot(partial: Partial<MvShot> = {}): MvShot {
  return {
    id: liteId('sh'),
    brief: '',
    composition: '',
    scale: 'medium',
    characterIds: [],
    locationId: null,
    bars: 2,
    image: { approvedAssetId: null, uploads: [], reuseOfShotId: null },
    motion: { ...DEFAULT_SHOT_MOTION, intensity: 0.06 },
    transitionIn: 'cut',
    look: null,
    note: '',
    ...partial,
  };
}

export function newMvSection(partial: Partial<MvSection> = {}): MvSection {
  return { id: liteId('sc'), label: 'verse', name: '', start: 0, end: 8, idea: '', mood: '', shots: [newMvShot()], transitionIn: 'cut', lyrics: true, ...partial };
}

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const MV_ASPECTS: readonly LiteAspect[] = ['16:9', '9:16', '1:1'];

function normMotion(m: Partial<ShotMotion> | undefined): ShotMotion {
  const preset = (MOTION_PRESETS as readonly string[]).includes(String(m?.preset)) ? (m!.preset as MotionPreset) : DEFAULT_SHOT_MOTION.preset;
  const ease: MotionEase = m?.ease === 'linear' || m?.ease === 'ease_in_out' ? m.ease : 'gentle';
  return { preset, intensity: num(m?.intensity, 0.06, 0, 0.25), focal: { x: num(m?.focal?.x, 0.5, 0, 1), y: num(m?.focal?.y, 0.45, 0, 1) }, focalSize: m?.focalSize ?? null, ease, manual: m?.manual ?? null };
}

/** Accepts any saved draft (older or partial) and returns a complete, valid spec. */
export function normalizeMvLiteSpec(raw: unknown): MvLiteSpec {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<MvLiteSpec>;
  const base = defaultMvLiteSpec({ direction: r.setup?.direction, aspect: r.setup?.aspect });
  const setup: MvSetup = { ...base.setup, ...(r.setup ?? {}), look: { ...base.setup.look, ...(r.setup?.look ?? {}) }, extraAspects: arr<LiteAspect>(r.setup?.extraAspects).filter((a) => MV_ASPECTS.includes(a) && a !== (r.setup?.aspect ?? base.setup.aspect)) };
  if (!MV_ASPECTS.includes(setup.aspect)) setup.aspect = '16:9';
  if (setup.cutOn !== 'beat') setup.cutOn = 'downbeat';
  const sections = arr<Partial<MvSection>>(r.sections).map((s) => {
    const sc = newMvSection();
    return {
      ...sc,
      ...s,
      id: str(s.id, sc.id),
      label: (SECTION_LABELS as readonly string[]).includes(String(s.label)) ? (s.label as SectionLabel) : 'other',
      start: num(s.start, 0, 0),
      end: num(s.end, num(s.start, 0, 0) + 8, 0),
      lyrics: s.lyrics !== false,
      transitionIn: (['cut', 'dissolve', 'flash', 'fade_black'] as const).includes(s.transitionIn as MvSectionTransition) ? (s.transitionIn as MvSectionTransition) : 'cut',
      shots: arr<Partial<MvShot>>(s.shots).map((x) => {
        const sh = newMvShot();
        return { ...sh, ...x, id: str(x.id, sh.id), bars: num(x.bars, 2, 0.25, 64), image: { ...sh.image, ...(x.image ?? {}), uploads: arr<ShotImageCandidate>(x.image?.uploads) }, motion: normMotion(x.motion), characterIds: arr<string>(x.characterIds), transitionIn: x.transitionIn === 'dissolve' || x.transitionIn === 'flash' ? x.transitionIn : 'cut' } as MvShot;
      }),
    } as MvSection;
  });
  const range = r.song?.range && Number.isFinite(r.song.range.start) && Number.isFinite(r.song.range.end) && r.song.range.end > r.song.range.start ? { start: r.song.range.start, end: r.song.range.end } : null;
  return {
    ...base,
    ...r,
    version: 1,
    stage: (MV_STAGES as readonly string[]).includes(String(r.stage)) ? (r.stage as MvStage) : 'song',
    setup,
    song: { songId: typeof r.song?.songId === 'string' && r.song.songId ? r.song.songId : null, range },
    concept: { ...base.concept, ...(r.concept ?? {}) },
    bible: { ...base.bible, ...(r.bible ?? {}), characters: arr(r.bible?.characters), locations: arr(r.bible?.locations), styleRefAssetIds: arr<string>(r.bible?.styleRefAssetIds) },
    sections,
    lyrics: { ...base.lyrics, ...(r.lyrics ?? {}), mode: (['line', 'karaoke', 'phrase', 'subtitle'] as const).includes(r.lyrics?.mode as MvLyricSettings['mode']) ? (r.lyrics!.mode as MvLyricSettings['mode']) : base.lyrics.mode },
    sound: { gainDb: num(r.sound?.gainDb, 0, -24, 6), fadeInSec: num(r.sound?.fadeInSec, base.sound.fadeInSec, 0, 10), fadeOutSec: num(r.sound?.fadeOutSec, base.sound.fadeOutSec, 0, 15), tailSec: num(r.sound?.tailSec, base.sound.tailSec, 0, 10) },
    timelines: { ...(r.timelines ?? {}) },
    renders: arr(r.renders),
    importedFrom: r.importedFrom ?? null,
    updatedAt: num(r.updatedAt, Date.now()),
  };
}

// ---------------------------------------------------------------------------
// Editing operations (pure; the workspace keeps an undo history of specs)
// ---------------------------------------------------------------------------

export function mapMvSection(spec: MvLiteSpec, sectionId: string, fn: (s: MvSection) => MvSection): MvLiteSpec {
  return { ...spec, sections: spec.sections.map((s) => (s.id === sectionId ? fn(s) : s)) };
}

export function mapMvShot(spec: MvLiteSpec, shotId: string, fn: (s: MvShot) => MvShot): MvLiteSpec {
  return { ...spec, sections: spec.sections.map((s) => (s.shots.some((x) => x.id === shotId) ? { ...s, shots: s.shots.map((x) => (x.id === shotId ? fn(x) : x)) } : s)) };
}

export function findMvShot(spec: MvLiteSpec, shotId: string): { section: MvSection; shot: MvShot; index: number } | null {
  for (const section of spec.sections) {
    const index = section.shots.findIndex((x) => x.id === shotId);
    if (index >= 0) return { section, shot: section.shots[index]!, index };
  }
  return null;
}

export function allMvShots(spec: MvLiteSpec): { section: MvSection; shot: MvShot; sectionIndex: number; shotIndex: number }[] {
  return spec.sections.flatMap((section, sectionIndex) => section.shots.map((shot, shotIndex) => ({ section, shot, sectionIndex, shotIndex })));
}

/** The image a shot shows: its own approved image, or the approved image of the shot it reuses. */
export function mvShotImageId(spec: MvLiteSpec, shot: MvShot): string | null {
  if (shot.image.reuseOfShotId) {
    const src = findMvShot(spec, shot.image.reuseOfShotId);
    return src ? src.shot.image.approvedAssetId : null;
  }
  return shot.image.approvedAssetId;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Splits a shot in two halves of its bars; the second reuses the first's image with a different move. */
export function splitMvShot(spec: MvLiteSpec, shotId: string): MvLiteSpec {
  const hit = findMvShot(spec, shotId);
  if (!hit) return spec;
  const half = Math.max(0.25, hit.shot.bars / 2);
  const second: MvShot = { ...clone(hit.shot), id: liteId('sh'), bars: half, image: { ...hit.shot.image, uploads: [], reuseOfShotId: hit.shot.image.reuseOfShotId ?? hit.shot.id }, motion: { ...hit.shot.motion, preset: hit.shot.motion.preset === 'push_in' ? 'pull_out' : 'push_in', manual: null } };
  return mapMvSection(spec, hit.section.id, (s) => ({ ...s, shots: s.shots.flatMap((x) => (x.id === shotId ? [{ ...x, bars: half }, second] : [x])) }));
}

export function duplicateMvShot(spec: MvLiteSpec, shotId: string): MvLiteSpec {
  const hit = findMvShot(spec, shotId);
  if (!hit) return spec;
  const copy: MvShot = { ...clone(hit.shot), id: liteId('sh') };
  return mapMvSection(spec, hit.section.id, (s) => ({ ...s, shots: s.shots.flatMap((x) => (x.id === shotId ? [x, copy] : [x])) }));
}

export function removeMvShot(spec: MvLiteSpec, shotId: string): MvLiteSpec {
  return { ...spec, sections: spec.sections.map((s) => ({ ...s, shots: s.shots.filter((x) => x.id !== shotId).map((x) => (x.image.reuseOfShotId === shotId ? { ...x, image: { ...x.image, reuseOfShotId: null } } : x)) })) };
}

export function moveMvShot(spec: MvLiteSpec, shotId: string, delta: -1 | 1): MvLiteSpec {
  const hit = findMvShot(spec, shotId);
  if (!hit) return spec;
  const to = hit.index + delta;
  if (to < 0 || to >= hit.section.shots.length) return spec;
  return mapMvSection(spec, hit.section.id, (s) => {
    const shots = [...s.shots];
    const [x] = shots.splice(hit.index, 1);
    shots.splice(to, 0, x!);
    return { ...s, shots };
  });
}

/**
 * Moves the boundary between a section and the next (song time), keeping both at least a beat long.
 * Shots keep their planned bars; their real lengths follow the new span.
 */
export function moveMvBoundary(spec: MvLiteSpec, sectionId: string, at: number): MvLiteSpec {
  const i = spec.sections.findIndex((s) => s.id === sectionId);
  const a = spec.sections[i];
  const b = spec.sections[i + 1];
  if (!a || !b) return spec;
  const t = Math.max(a.start + 0.5, Math.min(b.end - 0.5, at));
  return { ...spec, sections: spec.sections.map((s, k) => (k === i ? { ...s, end: r3(t) } : k === i + 1 ? { ...s, start: r3(t) } : s)) };
}

/** Joins a section with the next one (shots are kept in order). */
export function mergeMvSections(spec: MvLiteSpec, sectionId: string): MvLiteSpec {
  const i = spec.sections.findIndex((s) => s.id === sectionId);
  const a = spec.sections[i];
  const b = spec.sections[i + 1];
  if (!a || !b) return spec;
  const merged: MvSection = { ...a, end: b.end, shots: [...a.shots, ...b.shots], idea: [a.idea, b.idea].filter((x) => x.trim()).join(' / ') };
  return { ...spec, sections: spec.sections.flatMap((s, k) => (k === i ? [merged] : k === i + 1 ? [] : [s])) };
}

/** Splits a section at a song time (snapped by the caller); shots are shared out by their position. */
export function splitMvSection(spec: MvLiteSpec, sectionId: string, at: number): MvLiteSpec {
  const s = spec.sections.find((x) => x.id === sectionId);
  if (!s || at <= s.start + 0.5 || at >= s.end - 0.5) return spec;
  const share = (at - s.start) / (s.end - s.start);
  const total = s.shots.reduce((acc, x) => acc + x.bars, 0);
  let acc = 0;
  let k = 0;
  while (k < s.shots.length && acc + s.shots[k]!.bars / 2 <= share * total) acc += s.shots[k++]!.bars;
  k = Math.max(s.shots.length > 1 ? 1 : 0, Math.min(s.shots.length - 1, k));
  const first: MvSection = { ...s, end: r3(at), shots: s.shots.length > 1 ? s.shots.slice(0, k) : s.shots };
  const second: MvSection = { ...s, id: liteId('sc'), name: `${s.name || s.label} (cont.)`, start: r3(at), transitionIn: 'cut', shots: s.shots.length > 1 ? s.shots.slice(k) : [{ ...clone(s.shots[0]!), id: liteId('sh'), image: { ...s.shots[0]!.image, uploads: [], reuseOfShotId: s.shots[0]!.id } }] };
  return { ...spec, sections: spec.sections.flatMap((x) => (x.id === sectionId ? [first, second] : [x])) };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------
// Song structure → plan (no model call)
// ---------------------------------------------------------------------------

/** Mean energy of a span of the song (0–1 scale of the song's own range). */
export function spanEnergy(analysis: Pick<SongAnalysis, 'energy' | 'energyHop'> | null, start: number, end: number): number {
  if (!analysis?.energy.length) return 0.5;
  const e = analysis.energy;
  const lo = Math.min(...e);
  const hi = Math.max(...e);
  const a = Math.max(0, Math.floor(start / analysis.energyHop));
  const b = Math.min(e.length, Math.max(a + 1, Math.ceil(end / analysis.energyHop)));
  const slice = e.slice(a, b);
  const mean = slice.reduce((x, y) => x + y, 0) / Math.max(1, slice.length);
  return hi - lo > 1e-9 ? (mean - lo) / (hi - lo) : 0.5;
}

export function energyBand(energy: number): EnergyBand {
  return energy >= 0.62 ? 'high' : energy <= 0.33 ? 'low' : 'mid';
}

/** Bar length (s) from the grid, or from the tempo when downbeats are sparse. */
export function barSeconds(analysis: Pick<SongAnalysis, 'bpm' | 'downbeats'> | null): number {
  if (!analysis) return 2;
  const d = analysis.downbeats;
  if (d.length >= 3) {
    const gaps = d.slice(1).map((x, i) => x - d[i]!).sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)]!;
  }
  return analysis.bpm > 0 ? (60 / analysis.bpm) * 4 : 2;
}

/** Bars in a span of the song (measured from the grid). */
export function barsIn(analysis: Pick<SongAnalysis, 'bpm' | 'downbeats'> | null, start: number, end: number): number {
  return Math.max(0.25, Math.round(((end - start) / barSeconds(analysis)) * 4) / 4);
}

/** Planned bar lengths for a section: about `perShot` bars each, summing to the section's bars. */
export function shareBars(totalBars: number, perShot: number): number[] {
  const n = Math.max(1, Math.round(totalBars / Math.max(0.25, perShot)));
  const whole = Math.floor((totalBars / n) * 4) / 4;
  const out = Array.from({ length: n }, () => whole);
  let rest = Math.round((totalBars - whole * n) * 4);
  for (let i = out.length - 1; rest > 0; i = (i - 1 + out.length) % out.length, rest--) out[i] = out[i]! + 0.25;
  return out.map((b) => Math.max(0.25, b));
}

/** The song's sections inside the video's range, contiguous from the range start to its end. */
export function songSectionsInRange(sections: SongSection[], range: TimeRange): SongSection[] {
  const inside = [...sections].sort((a, b) => a.start - b.start).filter((s) => s.end > range.start + 0.25 && s.start < range.end - 0.25);
  if (!inside.length) return [{ id: 's0', label: 'other', name: 'Song', start: range.start, end: range.end, energy: 0.5 }];
  return inside.map((s, i) => ({ ...s, start: i === 0 ? range.start : Math.max(range.start, s.start), end: i === inside.length - 1 ? range.end : Math.min(range.end, inside[i + 1]!.start) }));
}

/** A plain plan straight from the song's structure: one section per song section, shots by energy. */
export function mvSectionsFromSong(spec: MvLiteSpec, song: Pick<MvSong, 'analysis' | 'durationSec'>): MvSection[] {
  const d = mvDirectionOf(spec.setup.direction);
  const range = productionRange(spec.song.range, song.durationSec);
  const parts = songSectionsInRange(song.analysis?.sections ?? [], range);
  let shotNo = 0;
  return parts.map((p, i) => {
    const band = energyBand(spanEnergy(song.analysis, p.start, p.end));
    const bars = shareBars(barsIn(song.analysis, p.start, p.end), d.barsPerShot[band]);
    const prev = parts[i - 1];
    const chorus = p.label === 'chorus' || p.label === 'hook' || p.label === 'drop';
    const transitionIn: MvSectionTransition = i === 0 ? 'cut' : chorus && d.flashOnChorus ? 'flash' : prev && (band === 'low' || i % Math.max(2, Math.round(1 / Math.max(0.1, d.dissolveShare))) === 0) ? 'dissolve' : 'cut';
    return newMvSection({
      label: p.label,
      name: p.name || p.label,
      start: r3(p.start),
      end: r3(p.end),
      transitionIn,
      shots: bars.map((b) => {
        const k = shotNo++;
        const preset = Math.abs(Math.sin(k * 12.9898)) % 1 < d.motion.stillShare ? 'still' : (d.motion.prefer[k % d.motion.prefer.length] ?? 'push_in');
        return newMvShot({ bars: b, scale: (['wide', 'medium', 'close', 'detail'] as const)[(i + k) % 4], motion: { ...DEFAULT_SHOT_MOTION, preset, intensity: d.motion.intensity } });
      }),
    });
  });
}

/** Lyric lines sung during a span of song time (each line once, in order). */
export function lyricsDuring(sheet: LyricsSheet | null | undefined, start: number, end: number): { id: string; text: string; start: number; end: number }[] {
  if (!sheet) return [];
  return sheet.lines.filter((l) => l.start !== null && l.end !== null && l.text.trim() && l.end > start + 0.05 && l.start < end - 0.05).map((l) => ({ id: l.id, text: l.text, start: l.start!, end: l.end! }));
}

/** Identifies what the shot plan was made from (song structure + concept), so a stale plan can be flagged. */
export function mvPlanBasis(spec: MvLiteSpec, song: Pick<MvSong, 'audioAssetId' | 'analysis'> | null): string {
  return stableHash({ a: song?.audioAssetId ?? null, s: song?.analysis?.sections.map((x) => [x.start, x.end]) ?? null, r: spec.song.range });
}

export function mvTitle(spec: MvLiteSpec, fallback: string): string {
  return spec.concept.treatment?.title?.trim() || fallback;
}
