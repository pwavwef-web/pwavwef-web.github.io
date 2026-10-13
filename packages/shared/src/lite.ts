import { DEFAULT_SHOT_MOTION, MOTION_PRESETS, type ClipLook, type MotionEase, type MotionPreset, type ShotMotion } from './motion';
import type { TextFont } from './types';

/**
 * Film Studio Lite: cinematic stories from still images, voice and sound. The editorial draft lives on
 * the project (`project.lite`) and is saved from the browser as it is edited. Paid results (images,
 * narration, music) are durable jobs targeted at a shot / scene, so they survive a closed tab and are
 * never requested twice for the same input. The base workflow never calls a video-generation or
 * lip-sync model: motion is made locally from the stills.
 */

export const LITE_STAGES = ['story', 'scenes', 'sound', 'edit', 'export'] as const;
export type LiteStage = (typeof LITE_STAGES)[number];
export const LITE_STAGE_LABELS: Record<LiteStage, string> = { story: 'Story', scenes: 'Scenes', sound: 'Voice & Sound', edit: 'Edit', export: 'Export' };

export const LITE_ASPECTS = ['16:9', '9:16', '1:1'] as const;
export type LiteAspect = (typeof LITE_ASPECTS)[number];

/** Validated limits: TTS per scene, word-timed transcription (≤ 14 min per request, split beyond), a 6 h render job. */
export const LITE_DURATION = { min: 60, max: 20 * 60, presets: [120, 300, 600, 900] as const };

export const LITE_IMAGE_STYLES = ['cinematic_realism', 'documentary_photo', 'painterly', 'illustration'] as const;
export type LiteImageStyle = (typeof LITE_IMAGE_STYLES)[number];
export const LITE_IMAGE_STYLE_LABELS: Record<LiteImageStyle, string> = {
  cinematic_realism: 'Cinematic realism',
  documentary_photo: 'Documentary photograph',
  painterly: 'Painterly',
  illustration: 'Illustration',
};
export const LITE_IMAGE_STYLE_PROMPTS: Record<LiteImageStyle, string> = {
  cinematic_realism: 'Photorealistic cinematic film still: real people and real places, natural skin texture, motivated light, shallow depth of field where it helps, anamorphic-lens feel, subtle film grain. Not a cartoon, not a 3D render, not clay, not a painting.',
  documentary_photo: 'Photorealistic documentary photograph: available light, honest textures, candid composition, 35mm film look. Not staged-looking, not a cartoon, not a 3D render.',
  painterly: 'Painterly cinematic image with visible, restrained brushwork and rich natural light, like a matte painting for a film. Grounded proportions; not cartoonish, not clay, not 3D.',
  illustration: 'Hand-crafted illustrated film frame with a consistent, mature illustration style, careful lighting and grounded proportions. Not childish, not clay, not 3D.',
};

export const LITE_DIRECTIONS = ['folklore', 'documentary', 'personal', 'historical', 'essay', 'mystery'] as const;
export type LiteDirectionId = (typeof LITE_DIRECTIONS)[number];

export const AMBIENCE_KINDS = ['wind', 'rain', 'water', 'night', 'room'] as const;
export type AmbienceKind = (typeof AMBIENCE_KINDS)[number];
export const AMBIENCE_LABELS: Record<AmbienceKind, string> = { wind: 'Wind', rain: 'Rain', water: 'Flowing water', night: 'Night air', room: 'Room tone' };

export const SUBTITLE_PRESETS = ['cinema', 'serif', 'boxed', 'minimal'] as const;
export type SubtitlePreset = (typeof SUBTITLE_PRESETS)[number];

/** A starting direction: it changes planning, visual language, pacing and sound — every value can be overridden. */
export interface LiteDirection {
  id: LiteDirectionId;
  label: string;
  blurb: string;
  imageStyle: LiteImageStyle;
  wordsPerMinute: number;
  /** Typical shot length range (s) — a planning default, not a rule. */
  shotSec: [number, number];
  leadInSec: number;
  tailSec: number;
  visual: string;
  palette: string;
  lighting: string;
  motion: { prefer: MotionPreset[]; intensity: number; stillShare: number };
  narration: string;
  music: { style: string; instrumentation: string[]; tempo: [number, number]; levelDb: number };
  ambience: AmbienceKind[];
  /** Share of scene changes that dissolve (the rest cut). */
  dissolveShare: number;
  subtitle: SubtitlePreset;
  look: Omit<ClipLook, 'seed'>;
  structure: string;
}

export const LITE_DIRECTION_PRESETS: Record<LiteDirectionId, LiteDirection> = {
  folklore: {
    id: 'folklore',
    label: 'Cinematic folklore',
    blurb: 'Told by firelight: myth, ancestors and the land.',
    imageStyle: 'cinematic_realism',
    wordsPerMinute: 128,
    shotSec: [9, 18],
    leadInSec: 1.6,
    tailSec: 2.2,
    visual: 'Mythic but grounded: wide landscapes at dusk, firelight on faces, symbolic details (hands, objects, animals), low-angle heroes, deep shadow.',
    palette: 'Ochre, deep indigo, ember orange, earth browns',
    lighting: 'Firelight, moonlight and golden-hour sun; strong contrast, warm highlights',
    motion: { prefer: ['push_in', 'still', 'pan_right', 'pull_out'], intensity: 0.05, stillShare: 0.25 },
    narration: 'A warm, unhurried storyteller speaking to listeners gathered close; let important words land, pause between images.',
    music: { style: 'Atmospheric, rooted film score with a simple recurring melody', instrumentation: ['kologo lute', 'low strings', 'soft frame drum', 'wooden flute'], tempo: [60, 84], levelDb: -17 },
    ambience: ['night', 'wind'],
    dissolveShare: 0.4,
    subtitle: 'serif',
    look: { grain: 0.35, vignette: 0.35, haze: 0.15, warmth: 0.25 },
    structure: 'Open on the world and its rule; introduce the hero and a want; a test or transgression; a turn where the old knowledge matters; a resolution that is also a lesson; end on an image that echoes the opening.',
  },
  documentary: {
    id: 'documentary',
    label: 'Atmospheric documentary',
    blurb: 'Observed places, real textures, an honest voice.',
    imageStyle: 'documentary_photo',
    wordsPerMinute: 140,
    shotSec: [8, 16],
    leadInSec: 1.2,
    tailSec: 1.6,
    visual: 'Observational: establishing wides, environmental portraits, telling details, people at work; nothing staged-looking.',
    palette: 'Natural, slightly desaturated, true skin tones',
    lighting: 'Available light, overcast softness, practical lamps indoors',
    motion: { prefer: ['pan_right', 'push_in', 'still', 'tilt_down', 'pull_out'], intensity: 0.045, stillShare: 0.2 },
    narration: 'A clear, grounded documentary narrator: curious, measured and precise, never theatrical.',
    music: { style: 'Minimal ambient score, pulsing and patient', instrumentation: ['piano', 'soft synth pads', 'cello', 'light percussion'], tempo: [70, 96], levelDb: -19 },
    ambience: ['room', 'wind'],
    dissolveShare: 0.2,
    subtitle: 'cinema',
    look: { grain: 0.2, vignette: 0.15, haze: 0, warmth: 0 },
    structure: 'Open with a striking place or question; establish context; follow people and evidence; reveal the complication; reflect on meaning; close with an image that lingers.',
  },
  personal: {
    id: 'personal',
    label: 'Emotional personal story',
    blurb: 'Intimate memory: faces, hands, light through windows.',
    imageStyle: 'cinematic_realism',
    wordsPerMinute: 125,
    shotSec: [9, 20],
    leadInSec: 1.8,
    tailSec: 2.6,
    visual: 'Intimate and tactile: close faces, hands, keepsakes, empty rooms, windows, soft focus backgrounds.',
    palette: 'Soft warm neutrals, faded pastels, gentle highlights',
    lighting: 'Window light, late afternoon sun, soft lamps; gentle falloff',
    motion: { prefer: ['push_in', 'still', 'drift', 'pull_out'], intensity: 0.04, stillShare: 0.3 },
    narration: 'Soft, close and sincere, as if remembering aloud; slower on emotional lines, comfortable silences.',
    music: { style: 'Tender, sparse score that blooms at the emotional turn', instrumentation: ['felt piano', 'solo cello', 'warm strings', 'acoustic guitar'], tempo: [56, 76], levelDb: -18 },
    ambience: ['room'],
    dissolveShare: 0.45,
    subtitle: 'cinema',
    look: { grain: 0.25, vignette: 0.25, haze: 0.2, warmth: 0.3 },
    structure: 'Begin in the present with a small object or place; drift into memory; the person and what they meant; the loss or change; the turn of understanding; return to the present, changed.',
  },
  historical: {
    id: 'historical',
    label: 'Historical storytelling',
    blurb: 'Period detail, archives and consequence.',
    imageStyle: 'cinematic_realism',
    wordsPerMinute: 135,
    shotSec: [8, 18],
    leadInSec: 1.4,
    tailSec: 1.9,
    visual: 'Authentic period settings, costume and architecture; maps-free wides; portraits like old photographs; artefacts in detail.',
    palette: 'Sepia, muted greens, aged paper, deep blacks',
    lighting: 'Period-appropriate light: oil lamps, overcast daylight, dusty interiors',
    motion: { prefer: ['pan_right', 'push_in', 'pull_out', 'still', 'tilt_down'], intensity: 0.05, stillShare: 0.2 },
    narration: 'An authoritative, warm historian’s voice: measured pace, clear dates and names, gravity without melodrama.',
    music: { style: 'Restrained orchestral score with a period colour', instrumentation: ['strings', 'french horn', 'harp', 'timpani rolls'], tempo: [64, 90], levelDb: -18 },
    ambience: ['wind', 'room'],
    dissolveShare: 0.35,
    subtitle: 'serif',
    look: { grain: 0.4, vignette: 0.3, haze: 0.1, warmth: 0.15 },
    structure: 'Set the time and stakes; the world before; the people and decisions; the turning point; the consequences; what remains today.',
  },
  essay: {
    id: 'essay',
    label: 'Educational visual essay',
    blurb: 'Clear ideas, strong images, steady rhythm.',
    imageStyle: 'cinematic_realism',
    wordsPerMinute: 150,
    shotSec: [7, 14],
    leadInSec: 1.0,
    tailSec: 1.3,
    visual: 'Concept-driven: clean compositions with one clear subject per image, visual metaphors, details that explain.',
    palette: 'Clean and contemporary with one accent colour',
    lighting: 'Clean, even, modern light with gentle contrast',
    motion: { prefer: ['push_in', 'pan_right', 'still', 'pull_out', 'tilt_up'], intensity: 0.04, stillShare: 0.2 },
    narration: 'A clear, friendly explainer: confident, conversational, with emphasis on key terms.',
    music: { style: 'Light, curious score with gentle momentum', instrumentation: ['marimba', 'piano', 'plucked strings', 'soft beats'], tempo: [84, 110], levelDb: -21 },
    ambience: [],
    dissolveShare: 0.15,
    subtitle: 'boxed',
    look: { grain: 0, vignette: 0.1, haze: 0, warmth: 0 },
    structure: 'Hook with a question; define the idea; three developing points with examples; a surprising implication; a crisp conclusion that answers the hook.',
  },
  mystery: {
    id: 'mystery',
    label: 'Suspense or mystery',
    blurb: 'Shadows, clues and a slow reveal.',
    imageStyle: 'cinematic_realism',
    wordsPerMinute: 128,
    shotSec: [9, 20],
    leadInSec: 1.8,
    tailSec: 2.4,
    visual: 'Low-key frames with negative space, partial reveals, doorways, silhouettes, objects as clues; faces half in shadow.',
    palette: 'Cold blues and teals with sodium-orange accents',
    lighting: 'Low-key, hard side light, moonlight, a single practical lamp',
    motion: { prefer: ['push_in', 'still', 'pan_left', 'tilt_down'], intensity: 0.045, stillShare: 0.3 },
    narration: 'Low, deliberate and quietly tense; hold back, let silences build suspense.',
    music: { style: 'Dark ambient suspense score: drones, pulses and sparse motifs', instrumentation: ['low drones', 'prepared piano', 'bowed metal', 'deep pulse'], tempo: [50, 76], levelDb: -18 },
    ambience: ['wind', 'night', 'rain'],
    dissolveShare: 0.25,
    subtitle: 'cinema',
    look: { grain: 0.3, vignette: 0.4, haze: 0.2, warmth: -0.25 },
    structure: 'An unsettling opening image; the question; clues and false comfort; rising dread; the reveal; an ending that answers and leaves a chill.',
  },
};

// ---------------------------------------------------------------------------
// Draft shape
// ---------------------------------------------------------------------------

export interface LiteTreatment {
  title: string;
  logline: string;
  synopsis: string;
  beginning: string;
  development: string;
  turns: string[];
  ending: string;
  tone: string;
}

export interface LiteCharacter {
  id: string;
  name: string;
  description: string;
  clothing: string;
  /** Approved likeness references (images); used in every image of the character. */
  refAssetIds: string[];
}

export interface LiteLocation {
  id: string;
  name: string;
  description: string;
  refAssetIds: string[];
}

export interface LiteBible {
  characters: LiteCharacter[];
  locations: LiteLocation[];
  palette: string;
  lighting: string;
  imageTreatment: string;
  styleRefAssetIds: string[];
  avoid: string;
}

export interface Pronunciation {
  id: string;
  /** As written in the script and subtitles. */
  term: string;
  /** How the voice should say it (respelling), used only in the text sent to the speech model. */
  sayAs: string;
  note: string;
}

export type ShotScale = 'wide' | 'medium' | 'close' | 'detail' | 'establishing';

export interface ShotImageCandidate {
  assetId: string;
  source: 'generated' | 'upload' | 'import';
  jobId: string | null;
  prompt: string | null;
  at: number;
}

export interface LiteShot {
  id: string;
  /** What the image shows (becomes the image prompt). */
  brief: string;
  /** Composition guidance for slow movement (subject placement, space). */
  composition: string;
  scale: ShotScale;
  characterIds: string[];
  locationId: string | null;
  /** Planned length (s). */
  durationSec: number;
  /** Keep this exact length when narration timing changes. */
  lockDuration: boolean;
  image: {
    approvedAssetId: string | null;
    /** Uploaded or imported alternatives (generated ones come from this shot's jobs). */
    uploads: ShotImageCandidate[];
    /** Reuse another shot's image with different framing (economical plan). */
    reuseOfShotId: string | null;
  };
  motion: ShotMotion;
  transitionIn: 'cut' | 'dissolve';
  look: Partial<ClipLook> | null;
  /** Optional parallax: a clean background plate and a transparent foreground cut-out (both uploaded). */
  parallax: { backgroundAssetId: string; foregroundAssetId: string; strength: number } | null;
  note: string;
}

export type SceneMusicMode = 'score' | 'silence';

export interface SubtitleCueOverride {
  /** Relative to the start of the scene's narration (s). */
  start: number;
  end: number;
  text: string;
  source: 'manual' | 'imported';
}

export interface LiteScene {
  id: string;
  title: string;
  /** Why the scene exists in the story. */
  purpose: string;
  narration: string;
  mood: string;
  shots: LiteShot[];
  /** Deliberate pause before the scene (s): a held image, or black when `pauseBlack`. */
  pauseBeforeSec: number;
  pauseBlack: boolean;
  /** Picture before the first word (s) and room after the last (s). */
  leadInSec: number;
  tailSec: number;
  transitionIn: 'cut' | 'dissolve' | 'fade_black';
  music: { mode: SceneMusicMode; intensity: number; direction: string };
  ambience: { kind: AmbienceKind | 'none' | 'upload'; assetId: string | null; levelDb: number };
  soundCue: { label: string; assetId: string | null; atSec: number; levelDb: number } | null;
  subtitles: boolean;
  subtitleOverrides: SubtitleCueOverride[] | null;
  /** Chosen narration take (a job id); null = the newest take for the current text. */
  voiceJobId: string | null;
  /** Uploaded narration for just this scene (aligned by a job). */
  voiceUploadAssetId: string | null;
}

export interface LiteSubtitleSettings {
  enabled: boolean;
  burnIn: boolean;
  preset: SubtitlePreset;
  font: TextFont;
  sizePct: number;
  /** 0 = text shadow only … 1 = solid box behind the text. */
  contrast: 'shadow' | 'outline' | 'box';
  /** Extra lift from the bottom (fraction of frame height, added to the format's safe margin). */
  lift: number;
  maxLines: 1 | 2;
}

export interface LiteMusicTrack {
  id: string;
  assetId: string;
  fromSceneId: string | null;
  /** Fit when the track is shorter than its span: crossfaded reuse, or end early with a fade. */
  fit: 'loop' | 'end';
  gainDb: number;
  licence: { kind: 'generated' | 'own' | 'licensed' | 'public_domain' | 'unknown'; source: string; attribution: string; url: string };
}

export interface LiteSound {
  music: {
    mode: 'score' | 'tracks' | 'none';
    /** Musical identity shared by every movement (coherence across the film). */
    identity: { style: string; instrumentation: string[]; key: string; tempo: [number, number]; motif: string; avoid: string[] };
    /** Score movements: id of the project's `scores` doc. */
    scoreId: string | null;
    /** Per-movement fit when a generated movement is shorter than its span. */
    fit: Record<string, 'loop' | 'end'>;
    tracks: LiteMusicTrack[];
  };
  levels: { voiceDb: number; musicDb: number; ambienceDb: number; effectsDb: number };
  duck: { depthDb: number; attackSec: number; releaseSec: number; bridgeGapSec: number };
  fadeInSec: number;
  fadeOutSec: number;
  /** Picture and music after the last line before the end (s). */
  endHoldSec: number;
}

export interface LiteVoice {
  mode: 'generate' | 'upload_whole' | 'upload_scenes';
  voice: string;
  delivery: string;
  pace: 'slow' | 'measured' | 'natural';
  /** One recording of the whole narration (aligned to the script to find each scene). */
  wholeAssetId: string | null;
  wholeJobId: string | null;
}

export interface LiteSetup {
  direction: LiteDirectionId;
  targetSec: number;
  aspect: LiteAspect;
  /** Extra formats to export (framing and subtitles adapt per format; timing is shared). */
  extraAspects: LiteAspect[];
  fps: 24 | 25 | 30;
  wordsPerMinute: number;
  language: string;
  imageStyle: LiteImageStyle;
  imageSize: '2K' | '4K';
  visualPlan: 'economical' | 'rich';
  look: ClipLook;
}

export interface LiteSpec {
  version: 1;
  stage: LiteStage;
  setup: LiteSetup;
  story: {
    idea: string;
    sourceText: string;
    treatment: LiteTreatment | null;
    script: string;
    scriptApprovedAt: number | null;
  };
  bible: LiteBible;
  pronunciation: Pronunciation[];
  scenes: LiteScene[];
  voice: LiteVoice;
  subtitles: LiteSubtitleSettings;
  sound: LiteSound;
  /** Scene timing the director last acknowledged (reconciliation baseline). */
  timing: { baseline: Record<string, { start: number; duration: number }> | null; totalSec: number | null; acknowledgedAt: number | null };
  /** Derived composition per format (timeline docs). */
  timelines: Partial<Record<LiteAspect, string>>;
  renders: { renderId: string; aspect: LiteAspect; quality: 'draft' | 'final'; at: number }[];
  importedFrom: { projectId: string; title: string; at: number } | null;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Ids, hashing, text
// ---------------------------------------------------------------------------

export function liteId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** Stable 32-bit FNV-1a hash (hex) — identifies an input so the same paid request is never repeated. */
export function stableHash(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
}

/** Spoken length estimate from the configured pace plus punctuation pauses — an estimate, never a guarantee. */
export function estimateNarrationSec(text: string, wordsPerMinute: number): number {
  const words = wordCount(text);
  if (!words) return 0;
  const sentences = (text.match(/[.!?…]+(\s|$)/g) ?? []).length;
  const commas = (text.match(/[,;:—–]/g) ?? []).length;
  return Math.round(((words / Math.max(60, wordsPerMinute)) * 60 + sentences * 0.35 + commas * 0.12) * 10) / 10;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text sent to the speech model: pronunciation respellings applied (subtitles keep the written spelling). */
export function spokenText(text: string, rules: Pronunciation[]): string {
  let out = text;
  for (const r of rules) {
    if (!r.term.trim() || !r.sayAs.trim()) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(r.term.trim())}(?![\\p{L}\\p{N}])`, 'giu'), r.sayAs.trim());
  }
  return out;
}

const PACE_WORDS: Record<LiteVoice['pace'], string> = { slow: 'Speak slowly, with generous pauses at full stops', measured: 'Speak at a measured, unhurried pace with natural pauses', natural: 'Speak at a natural conversational pace' };

/** Delivery direction for the speech model (prompted; the model follows it approximately). */
export function voiceDirection(voice: LiteVoice): string {
  return [voice.delivery.trim(), PACE_WORDS[voice.pace]].filter(Boolean).join('. ');
}

/** Identifies a narration take's input: changing any of these makes an earlier take out of date. */
export function narrationHash(scene: Pick<LiteScene, 'narration'>, voice: Pick<LiteVoice, 'voice' | 'delivery' | 'pace'>, rules: Pronunciation[]): string {
  return stableHash({ t: spokenText(scene.narration.trim(), rules), v: voice.voice, d: voice.delivery.trim(), p: voice.pace });
}

// ---------------------------------------------------------------------------
// Defaults and normalisation
// ---------------------------------------------------------------------------

export function directionOf(id: LiteDirectionId | string | undefined): LiteDirection {
  return LITE_DIRECTION_PRESETS[(LITE_DIRECTIONS as readonly string[]).includes(String(id)) ? (id as LiteDirectionId) : 'documentary'];
}

export function defaultSubtitles(direction: LiteDirection): LiteSubtitleSettings {
  const preset = direction.subtitle;
  return { enabled: true, burnIn: true, preset, font: preset === 'serif' ? 'EB Garamond' : 'Inter', sizePct: preset === 'serif' ? 4.6 : 4.2, contrast: preset === 'boxed' ? 'box' : 'shadow', lift: 0, maxLines: 2 };
}

export function defaultSound(direction: LiteDirection): LiteSound {
  return {
    music: { mode: 'score', identity: { style: direction.music.style, instrumentation: [...direction.music.instrumentation], key: '', tempo: [...direction.music.tempo] as [number, number], motif: '', avoid: ['vocals', 'lyrics', 'drum-kit grooves under narration'] }, scoreId: null, fit: {}, tracks: [] },
    levels: { voiceDb: 0, musicDb: direction.music.levelDb, ambienceDb: -26, effectsDb: -12 },
    duck: { depthDb: 9, attackSec: 0.35, releaseSec: 0.9, bridgeGapSec: 1.6 },
    fadeInSec: 2,
    fadeOutSec: 4,
    endHoldSec: 5,
  };
}

export function defaultLiteSpec(input: { direction?: LiteDirectionId; targetSec?: number; aspect?: LiteAspect; idea?: string; language?: string } = {}): LiteSpec {
  const d = directionOf(input.direction);
  return {
    version: 1,
    stage: 'story',
    setup: {
      direction: d.id,
      targetSec: clampDuration(input.targetSec ?? 300),
      aspect: input.aspect ?? '16:9',
      extraAspects: [],
      fps: 24,
      wordsPerMinute: d.wordsPerMinute,
      language: input.language ?? 'en',
      imageStyle: d.imageStyle,
      imageSize: '2K',
      visualPlan: 'rich',
      look: { ...d.look, seed: 7 },
    },
    story: { idea: input.idea ?? '', sourceText: '', treatment: null, script: '', scriptApprovedAt: null },
    bible: { characters: [], locations: [], palette: d.palette, lighting: d.lighting, imageTreatment: d.visual, styleRefAssetIds: [], avoid: 'Readable text, logos, watermarks, distorted hands, extra limbs' },
    pronunciation: [],
    scenes: [],
    voice: { mode: 'generate', voice: 'Sulafat', delivery: d.narration, pace: 'measured', wholeAssetId: null, wholeJobId: null },
    subtitles: defaultSubtitles(d),
    sound: defaultSound(d),
    timing: { baseline: null, totalSec: null, acknowledgedAt: null },
    timelines: {},
    renders: [],
    importedFrom: null,
    updatedAt: Date.now(),
  };
}

export function clampDuration(sec: number): number {
  return Math.round(Math.max(LITE_DURATION.min, Math.min(LITE_DURATION.max, Number.isFinite(sec) ? sec : 300)));
}

/** Changing the direction re-derives what the direction controls (pace, look, sound, subtitles) — the story is kept. */
export function applyDirection(spec: LiteSpec, id: LiteDirectionId): LiteSpec {
  const d = directionOf(id);
  return {
    ...spec,
    setup: { ...spec.setup, direction: d.id, wordsPerMinute: d.wordsPerMinute, imageStyle: d.imageStyle, look: { ...d.look, seed: spec.setup.look.seed } },
    bible: { ...spec.bible, palette: d.palette, lighting: d.lighting, imageTreatment: d.visual },
    voice: { ...spec.voice, delivery: d.narration },
    subtitles: { ...defaultSubtitles(d), enabled: spec.subtitles.enabled, burnIn: spec.subtitles.burnIn },
    sound: { ...spec.sound, music: { ...spec.sound.music, identity: defaultSound(d).music.identity }, levels: { ...spec.sound.levels, musicDb: d.music.levelDb } },
  };
}

export function newShot(partial: Partial<LiteShot> = {}): LiteShot {
  return {
    id: liteId('sh'),
    brief: '',
    composition: '',
    scale: 'wide',
    characterIds: [],
    locationId: null,
    durationSec: 10,
    lockDuration: false,
    image: { approvedAssetId: null, uploads: [], reuseOfShotId: null },
    motion: { ...DEFAULT_SHOT_MOTION },
    transitionIn: 'cut',
    look: null,
    parallax: null,
    note: '',
    ...partial,
  };
}

export function newScene(partial: Partial<LiteScene> = {}, direction?: LiteDirection): LiteScene {
  const d = direction ?? LITE_DIRECTION_PRESETS.documentary;
  return {
    id: liteId('sc'),
    title: '',
    purpose: '',
    narration: '',
    mood: '',
    shots: [newShot()],
    pauseBeforeSec: 0,
    pauseBlack: false,
    leadInSec: d.leadInSec,
    tailSec: d.tailSec,
    transitionIn: 'cut',
    music: { mode: 'score', intensity: 4, direction: '' },
    ambience: { kind: 'none', assetId: null, levelDb: 0 },
    soundCue: null,
    subtitles: true,
    subtitleOverrides: null,
    voiceJobId: null,
    voiceUploadAssetId: null,
    ...partial,
  };
}

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function normMotion(m: Partial<ShotMotion> | undefined): ShotMotion {
  const preset = (MOTION_PRESETS as readonly string[]).includes(String(m?.preset)) ? (m!.preset as MotionPreset) : DEFAULT_SHOT_MOTION.preset;
  const ease: MotionEase = m?.ease === 'linear' || m?.ease === 'ease_in_out' ? m.ease : 'gentle';
  return { preset, intensity: num(m?.intensity, 0.05, 0, 0.25), focal: { x: num(m?.focal?.x, 0.5, 0, 1), y: num(m?.focal?.y, 0.45, 0, 1) }, focalSize: m?.focalSize ?? null, ease, manual: m?.manual ?? null };
}

/** Accepts any saved draft (older or partial) and returns a complete, valid spec. */
export function normalizeLiteSpec(raw: unknown): LiteSpec {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<LiteSpec>;
  const base = defaultLiteSpec({ direction: r.setup?.direction, aspect: r.setup?.aspect, targetSec: r.setup?.targetSec });
  const d = directionOf(base.setup.direction);
  const setup: LiteSetup = { ...base.setup, ...(r.setup ?? {}), targetSec: clampDuration(num(r.setup?.targetSec, base.setup.targetSec)), look: { ...base.setup.look, ...(r.setup?.look ?? {}) }, extraAspects: arr<LiteAspect>(r.setup?.extraAspects).filter((a) => (LITE_ASPECTS as readonly string[]).includes(a) && a !== (r.setup?.aspect ?? base.setup.aspect)) };
  if (!(LITE_ASPECTS as readonly string[]).includes(setup.aspect)) setup.aspect = '16:9';
  const scenes = arr<Partial<LiteScene>>(r.scenes).map((s) => {
    const sc = newScene({}, d);
    return {
      ...sc,
      ...s,
      id: str(s.id, sc.id),
      shots: arr<Partial<LiteShot>>(s.shots).map((x) => {
        const sh = newShot();
        return { ...sh, ...x, id: str(x.id, sh.id), durationSec: num(x.durationSec, 10, 1, 120), image: { ...sh.image, ...(x.image ?? {}), uploads: arr<ShotImageCandidate>(x.image?.uploads) }, motion: normMotion(x.motion), characterIds: arr<string>(x.characterIds) };
      }),
      pauseBeforeSec: num(s.pauseBeforeSec, 0, 0, 30),
      leadInSec: num(s.leadInSec, sc.leadInSec, 0, 10),
      tailSec: num(s.tailSec, sc.tailSec, 0, 15),
      music: { ...sc.music, ...(s.music ?? {}) },
      ambience: { ...sc.ambience, ...(s.ambience ?? {}) },
      subtitleOverrides: Array.isArray(s.subtitleOverrides) ? s.subtitleOverrides : null,
    } as LiteScene;
  });
  return {
    ...base,
    ...r,
    version: 1,
    stage: (LITE_STAGES as readonly string[]).includes(String(r.stage)) ? (r.stage as LiteStage) : 'story',
    setup,
    story: { ...base.story, ...(r.story ?? {}) },
    bible: { ...base.bible, ...(r.bible ?? {}), characters: arr<LiteCharacter>(r.bible?.characters), locations: arr<LiteLocation>(r.bible?.locations), styleRefAssetIds: arr<string>(r.bible?.styleRefAssetIds) },
    pronunciation: arr<Pronunciation>(r.pronunciation),
    scenes,
    voice: { ...base.voice, ...(r.voice ?? {}) },
    subtitles: { ...base.subtitles, ...(r.subtitles ?? {}) },
    sound: {
      ...base.sound,
      ...(r.sound ?? {}),
      music: { ...base.sound.music, ...(r.sound?.music ?? {}), identity: { ...base.sound.music.identity, ...(r.sound?.music?.identity ?? {}) }, fit: { ...(r.sound?.music?.fit ?? {}) }, tracks: arr<LiteMusicTrack>(r.sound?.music?.tracks) },
      levels: { ...base.sound.levels, ...(r.sound?.levels ?? {}) },
      duck: { ...base.sound.duck, ...(r.sound?.duck ?? {}) },
    },
    timing: { ...base.timing, ...(r.timing ?? {}) },
    timelines: { ...(r.timelines ?? {}) },
    renders: arr(r.renders),
    importedFrom: r.importedFrom ?? null,
    updatedAt: num(r.updatedAt, Date.now()),
  };
}

// ---------------------------------------------------------------------------
// Editing operations (pure; the workspace keeps an undo history of specs)
// ---------------------------------------------------------------------------

export function mapScene(spec: LiteSpec, sceneId: string, fn: (s: LiteScene) => LiteScene): LiteSpec {
  return { ...spec, scenes: spec.scenes.map((s) => (s.id === sceneId ? fn(s) : s)) };
}

export function mapShot(spec: LiteSpec, shotId: string, fn: (s: LiteShot) => LiteShot): LiteSpec {
  return { ...spec, scenes: spec.scenes.map((s) => (s.shots.some((x) => x.id === shotId) ? { ...s, shots: s.shots.map((x) => (x.id === shotId ? fn(x) : x)) } : s)) };
}

export function findShot(spec: LiteSpec, shotId: string): { scene: LiteScene; shot: LiteShot; index: number } | null {
  for (const scene of spec.scenes) {
    const index = scene.shots.findIndex((x) => x.id === shotId);
    if (index >= 0) return { scene, shot: scene.shots[index]!, index };
  }
  return null;
}

export function moveScene(spec: LiteSpec, sceneId: string, toIndex: number): LiteSpec {
  const from = spec.scenes.findIndex((s) => s.id === sceneId);
  if (from < 0) return spec;
  const scenes = [...spec.scenes];
  const [s] = scenes.splice(from, 1);
  scenes.splice(Math.max(0, Math.min(scenes.length, toIndex)), 0, s!);
  return { ...spec, scenes };
}

export function insertScene(spec: LiteSpec, afterSceneId: string | null, scene?: LiteScene): LiteSpec {
  const s = scene ?? newScene({ title: `Scene ${spec.scenes.length + 1}` }, directionOf(spec.setup.direction));
  const i = afterSceneId ? spec.scenes.findIndex((x) => x.id === afterSceneId) + 1 : spec.scenes.length;
  const scenes = [...spec.scenes];
  scenes.splice(i <= 0 ? spec.scenes.length : i, 0, s);
  return { ...spec, scenes };
}

/** A copy with new ids. Approved images are kept (reused, no new generation); narration must be re-voiced only if the text changes. */
export function duplicateScene(spec: LiteSpec, sceneId: string): LiteSpec {
  const src = spec.scenes.find((s) => s.id === sceneId);
  if (!src) return spec;
  const copy: LiteScene = { ...structuredCloneSafe(src), id: liteId('sc'), title: `${src.title || 'Scene'} (copy)`, voiceJobId: null, shots: src.shots.map((x) => ({ ...structuredCloneSafe(x), id: liteId('sh') })) };
  return insertScene(spec, sceneId, copy);
}

export function removeScene(spec: LiteSpec, sceneId: string): LiteSpec {
  const removed = new Set(spec.scenes.find((s) => s.id === sceneId)?.shots.map((x) => x.id) ?? []);
  return { ...spec, scenes: spec.scenes.filter((s) => s.id !== sceneId).map((s) => ({ ...s, shots: s.shots.map((x) => (x.image.reuseOfShotId && removed.has(x.image.reuseOfShotId) ? { ...x, image: { ...x.image, reuseOfShotId: null } } : x)) })) };
}

/**
 * Splits a scene at a sentence boundary of its narration: shots are shared out in order. The new scene needs
 * its own narration take (its text changed); images are kept.
 */
export function splitScene(spec: LiteSpec, sceneId: string, atChar: number): LiteSpec {
  const s = spec.scenes.find((x) => x.id === sceneId);
  if (!s) return spec;
  const text = s.narration;
  const cut = Math.max(0, Math.min(text.length, atChar));
  const a = text.slice(0, cut).trim();
  const b = text.slice(cut).trim();
  const k = Math.max(1, Math.min(s.shots.length - 1, Math.round((s.shots.length * a.length) / Math.max(1, text.length))));
  const first: LiteScene = { ...s, narration: a, voiceJobId: null, shots: s.shots.length > 1 ? s.shots.slice(0, k) : s.shots };
  const second: LiteScene = { ...newScene({}, directionOf(spec.setup.direction)), title: `${s.title || 'Scene'} (cont.)`, purpose: s.purpose, mood: s.mood, music: { ...s.music }, ambience: { ...s.ambience }, narration: b, shots: s.shots.length > 1 ? s.shots.slice(k) : [{ ...structuredCloneSafe(s.shots[0]!), id: liteId('sh') }] };
  const scenes = spec.scenes.flatMap((x) => (x.id === sceneId ? [first, second] : [x]));
  return { ...spec, scenes };
}

export function splitShot(spec: LiteSpec, shotId: string): LiteSpec {
  const hit = findShot(spec, shotId);
  if (!hit) return spec;
  const half = Math.max(1.5, hit.shot.durationSec / 2);
  const second: LiteShot = { ...structuredCloneSafe(hit.shot), id: liteId('sh'), durationSec: half, image: { ...hit.shot.image, uploads: [], reuseOfShotId: hit.shot.id }, motion: { ...hit.shot.motion, preset: hit.shot.motion.preset === 'push_in' ? 'still' : 'push_in', manual: null } };
  return mapScene(spec, hit.scene.id, (s) => ({ ...s, shots: s.shots.flatMap((x) => (x.id === shotId ? [{ ...x, durationSec: half }, second] : [x])) }));
}

export function duplicateShot(spec: LiteSpec, shotId: string): LiteSpec {
  const hit = findShot(spec, shotId);
  if (!hit) return spec;
  const copy: LiteShot = { ...structuredCloneSafe(hit.shot), id: liteId('sh') };
  return mapScene(spec, hit.scene.id, (s) => ({ ...s, shots: s.shots.flatMap((x) => (x.id === shotId ? [x, copy] : [x])) }));
}

export function removeShot(spec: LiteSpec, shotId: string): LiteSpec {
  return { ...spec, scenes: spec.scenes.map((s) => ({ ...s, shots: s.shots.filter((x) => x.id !== shotId).map((x) => (x.image.reuseOfShotId === shotId ? { ...x, image: { ...x.image, reuseOfShotId: null } } : x)) })) };
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** The image a shot shows: its own approved image, or the approved image of the shot it reuses. */
export function shotImageId(spec: LiteSpec, shot: LiteShot): string | null {
  if (shot.image.reuseOfShotId) {
    const src = findShot(spec, shot.image.reuseOfShotId);
    return src ? src.shot.image.approvedAssetId : null;
  }
  return shot.image.approvedAssetId;
}

export function allShots(spec: LiteSpec): { scene: LiteScene; shot: LiteShot; sceneIndex: number; shotIndex: number }[] {
  return spec.scenes.flatMap((scene, sceneIndex) => scene.shots.map((shot, shotIndex) => ({ scene, shot, sceneIndex, shotIndex })));
}

/** Script paragraphs (blank-line separated) — each usually becomes one scene's narration. */
export function scriptParagraphs(script: string): string[] {
  return script
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** A plain scene plan straight from the script (no model call): one scene per paragraph, shots by length. */
export function scenesFromScript(spec: LiteSpec): LiteScene[] {
  const d = directionOf(spec.setup.direction);
  const [lo, hi] = d.shotSec;
  return scriptParagraphs(spec.story.script).map((p, i) => {
    const sec = estimateNarrationSec(p, spec.setup.wordsPerMinute) + d.leadInSec + d.tailSec;
    const shotsN = Math.max(1, Math.round(sec / ((lo + hi) / 2)));
    const prefer = d.motion.prefer;
    return newScene(
      {
        title: `Scene ${i + 1}`,
        narration: p,
        transitionIn: i === 0 ? 'fade_black' : i % Math.max(2, Math.round(1 / Math.max(0.1, d.dissolveShare))) === 0 ? 'dissolve' : 'cut',
        ambience: { kind: d.ambience[0] ?? 'none', assetId: null, levelDb: 0 },
        shots: Array.from({ length: shotsN }, (_, k) => newShot({ brief: '', durationSec: Math.round((sec / shotsN) * 10) / 10, scale: (['wide', 'medium', 'close', 'detail'] as const)[(i + k) % 4], motion: { ...DEFAULT_SHOT_MOTION, preset: prefer[(i + k) % prefer.length] ?? 'push_in', intensity: d.motion.intensity } })),
      },
      d,
    );
  });
}

/**
 * Languages the speech model documents for synthesis (Gemini TTS, checked 2026-09). Others — Kasem, Twi,
 * Ewe and many West African languages — may be spoken with a foreign accent or not at all: record or upload
 * the narration instead. Never promise native pronunciation from an unsupported voice.
 */
export const SPEECH_DOCUMENTED_LANGUAGES = ['en', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'ar', 'hi', 'ja', 'ko', 'ru', 'tr', 'pl', 'id', 'th', 'vi', 'uk', 'ro', 'bn', 'ta', 'te', 'mr'] as const;

export function speechLanguageSupported(code: string): boolean {
  return (SPEECH_DOCUMENTED_LANGUAGES as readonly string[]).includes(code.toLowerCase().split('-')[0] ?? '');
}

export const LITE_LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'xsm', name: 'Kasem' },
  { code: 'tw', name: 'Twi' },
  { code: 'ee', name: 'Ewe' },
  { code: 'ha', name: 'Hausa' },
  { code: 'fr', name: 'French' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'es', name: 'Spanish' },
];
