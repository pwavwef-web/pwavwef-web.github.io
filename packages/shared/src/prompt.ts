import type { DialogueLine, ShotDirections, StyleBible } from './types';

/**
 * Direction vocabularies. These are *prompt* vocabulary for Omni and Nano Banana Pro — they are
 * compiled into prompt text, never sent as API parameters.
 */
export const DIRECTION_OPTIONS = {
  framing: [
    'Extreme wide shot',
    'Wide establishing shot',
    'Full shot',
    'Medium wide shot',
    'Medium shot',
    'Medium close-up',
    'Close-up',
    'Extreme close-up',
    'Over-the-shoulder shot',
    'Two-shot',
    'Insert shot',
    'Aerial drone shot',
    'Point-of-view shot',
    'Low-angle shot',
    'High-angle shot',
  ],
  cameraMovement: [
    'Static, locked-off camera',
    'Slow push-in',
    'Slow pull-out',
    'Tracking shot alongside the subject',
    'Steadicam follow from behind',
    'Pan left',
    'Pan right',
    'Tilt up',
    'Tilt down',
    'Crane up',
    'Crane down',
    'Handheld, subtle shake',
    'Slow orbit around the subject',
    'Whip pan',
    'Slow zoom in',
    'Rack focus from foreground to subject',
  ],
  lens: ['14mm ultra-wide lens', '24mm wide lens', '35mm lens', '50mm lens', '85mm portrait lens', '135mm telephoto lens', 'Anamorphic lens with oval bokeh', 'Macro lens'],
  lighting: [
    'Golden hour sunlight',
    'Blue hour twilight',
    'Soft overcast daylight',
    'Hard midday sun',
    'High-key studio lighting',
    'Low-key chiaroscuro lighting',
    'Neon practical lights',
    'Warm candlelight',
    'Cool moonlight',
    'Silhouette backlight',
    'Volumetric haze with light shafts',
    'Three-point studio lighting',
  ],
  mood: ['Triumphant', 'Intimate', 'Melancholic', 'Euphoric', 'Tense', 'Mysterious', 'Serene', 'Playful', 'Defiant', 'Nostalgic', 'Ominous', 'Romantic'],
  style: [
    'Photoreal cinematic, shallow depth of field',
    '35mm film look with natural grain',
    '16mm documentary texture',
    'Anamorphic widescreen blockbuster',
    'Glossy music-video aesthetic',
    'Afrofuturist, rich saturated colour',
    'Black-and-white noir',
    'Dreamlike, soft diffusion',
    'Vintage VHS camcorder',
    'Stylised 3D animation',
    'Hand-drawn 2D animation',
  ],
} as const;

export const EMPTY_DIRECTIONS: ShotDirections = {
  framing: '',
  cameraMovement: '',
  lens: '',
  lighting: '',
  mood: '',
  style: '',
  performance: '',
  action: '',
  dialogue: [],
  ambientSound: '',
  avoid: '',
};

// ---------------------------------------------------------------------------
// Omni media planning (prompt tag bindings)
// ---------------------------------------------------------------------------

export type OmniMediaRole = 'first_frame' | 'last_frame' | 'image_ref' | 'video_ref' | 'source_video';

export interface OmniMediaRef {
  role: OmniMediaRole;
  assetId: string;
  /** Human label, e.g. a character name, used to describe the reference in the prompt. */
  label?: string;
}

export interface PlannedOmniMedia extends OmniMediaRef {
  kind: 'image' | 'video';
  /** Tag used inside the prompt body, e.g. `<IMAGE_REF_0>`; empty for source videos. */
  tag: string;
  /** Position among inputs of the same kind (1-based), e.g. `Image2`. */
  binding: string;
}

/**
 * Orders media inputs and builds Omni's explicit binding declaration, e.g.
 * `[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2] [# References <IMAGE_REF_0>@Image3 <VIDEO_REF_0>@Video1]`.
 * The media array must be sent to the API in the returned order (images first, then videos).
 */
export function planOmniMedia(refs: OmniMediaRef[]): { media: PlannedOmniMedia[]; declaration: string } {
  const first = refs.filter((r) => r.role === 'first_frame').slice(0, 1);
  const last = first.length ? refs.filter((r) => r.role === 'last_frame').slice(0, 1) : [];
  const imageRefs = refs.filter((r) => r.role === 'image_ref');
  const sourceVideos = refs.filter((r) => r.role === 'source_video').slice(0, 1);
  const videoRefs = refs.filter((r) => r.role === 'video_ref');

  const media: PlannedOmniMedia[] = [];
  let img = 0;
  let vid = 0;
  const sources: string[] = [];
  const references: string[] = [];

  for (const r of first) {
    img += 1;
    media.push({ ...r, kind: 'image', tag: '<FIRST_FRAME>', binding: `Image${img}` });
    sources.push(`<FIRST_FRAME>@Image${img}`);
  }
  for (const r of last) {
    img += 1;
    media.push({ ...r, kind: 'image', tag: '<LAST_FRAME>', binding: `Image${img}` });
    sources.push(`<LAST_FRAME>@Image${img}`);
  }
  imageRefs.forEach((r, i) => {
    img += 1;
    media.push({ ...r, kind: 'image', tag: `<IMAGE_REF_${i}>`, binding: `Image${img}` });
    references.push(`<IMAGE_REF_${i}>@Image${img}`);
  });
  for (const r of sourceVideos) {
    vid += 1;
    media.push({ ...r, kind: 'video', tag: '', binding: `Video${vid}` });
  }
  videoRefs.forEach((r, i) => {
    vid += 1;
    media.push({ ...r, kind: 'video', tag: `<VIDEO_REF_${i}>`, binding: `Video${vid}` });
    references.push(`<VIDEO_REF_${i}>@Video${vid}`);
  });

  const parts: string[] = [];
  if (sources.length) parts.push(`[# Sources ${sources.join(' ')}]`);
  if (references.length) parts.push(`[# References ${references.join(' ')}]`);
  return { media, declaration: parts.join(' ') };
}

/** Infers the Omni task, or `undefined` when the combination is mixed and the model should infer it. */
export function inferVideoTask(refs: OmniMediaRef[], hasPreviousInteraction: boolean, requested?: 'edit' | 'extend'): string | undefined {
  // Continuing a stored interaction: Vertex AI rejects any task alongside previous_interaction_id
  // ("previous_interaction_id is not allowed when video task is set") — the prompt says what to change.
  if (hasPreviousInteraction) return undefined;
  if (requested) return requested;
  const hasFirst = refs.some((r) => r.role === 'first_frame');
  const hasRefs = refs.some((r) => r.role === 'image_ref' || r.role === 'video_ref');
  if (hasFirst && !hasRefs) return 'image_to_video';
  if (!hasFirst && hasRefs) return 'reference_to_video';
  if (!hasFirst && !hasRefs) return 'text_to_video';
  return undefined;
}

// ---------------------------------------------------------------------------
// Shot prompt compilation
// ---------------------------------------------------------------------------

export interface PromptReference {
  tag: string;
  name: string;
  description?: string;
}

export interface CompileOptions {
  styleBible?: StyleBible | null;
  characters?: PromptReference[];
  locations?: PromptReference[];
  elements?: PromptReference[];
  /** Extra references without a named role. */
  others?: PromptReference[];
  durationSec?: number;
  /** Timed cues, e.g. from a song's beat map: `[0-2s] ...`. */
  timedCues?: string[];
  singleContinuousShot?: boolean;
  description?: string;
  /** Films are scored centrally: keep generated shots free of background music. */
  noBackgroundMusic?: boolean;
  /** Studio shots: captions, titles and name labels are added in the edit, never burned into the video. */
  noOverlayText?: boolean;
}

const clean = (s: string | undefined | null) => (s ?? '').trim().replace(/\s+/g, ' ');
const sentence = (s: string) => {
  const t = clean(s);
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

function dialogueText(lines: DialogueLine[]): string {
  const valid = lines.filter((l) => clean(l.line));
  if (!valid.length) return 'No dialogue.';
  return valid.map((l) => `${clean(l.character) || 'A character'} says: "${clean(l.line).replace(/"/g, "'")}"`).join(' ');
}

/** Compiles structured shot directions into an Omni prompt body (without the media declaration). */
export function compileShotPrompt(d: ShotDirections, opts: CompileOptions = {}): string {
  const lines: string[] = [];
  const camera = [clean(d.framing), clean(d.lens)].filter(Boolean).join(', ');
  const move = clean(d.cameraMovement);
  if (opts.singleContinuousShot !== false) lines.push('Single continuous shot, no cuts.');
  if (camera || move) lines.push(sentence([camera, move].filter(Boolean).join('. ')));
  const action = clean(d.action) || clean(opts.description);
  if (action) lines.push(sentence(action));

  const chars = opts.characters ?? [];
  if (chars.length) {
    lines.push(
      sentence(
        chars
          .map((c) => `${c.tag ? `${c.tag} ` : ''}${c.name}${c.description ? ` (${clean(c.description)})` : ''}`)
          .join('; '),
      ).replace(/^/, 'Characters: '),
    );
  }
  const locs = opts.locations ?? [];
  if (locs.length) {
    lines.push(`Setting: ${sentence(locs.map((l) => `${l.tag ? `${l.tag} ` : ''}${l.name}${l.description ? ` — ${clean(l.description)}` : ''}`).join('; '))}`);
  }
  const els = [...(opts.elements ?? []), ...(opts.others ?? [])];
  if (els.length) {
    lines.push(`Also featuring: ${sentence(els.map((e) => `${e.tag ? `${e.tag} ` : ''}${e.name}${e.description ? ` (${clean(e.description)})` : ''}`).join('; '))}`);
  }
  if (clean(d.performance)) lines.push(`Performance: ${sentence(d.performance)}`);

  const sb = opts.styleBible ?? {};
  const lighting = [clean(d.lighting), clean(sb.lighting)].filter(Boolean).join('; ');
  if (lighting) lines.push(`Lighting: ${sentence(lighting)}`);
  if (clean(d.mood)) lines.push(`Mood: ${sentence(d.mood)}`);
  const style = [clean(d.style), clean(sb.visualStyle), clean(sb.texture)].filter(Boolean).join('; ');
  if (style) lines.push(`Visual style: ${sentence(style)}`);
  if (clean(sb.palette)) lines.push(`Colour palette: ${sentence(sb.palette ?? '')}`);
  if (clean(sb.cameraLanguage)) lines.push(`Camera language: ${sentence(sb.cameraLanguage ?? '')}`);
  if (clean(sb.continuityNotes)) lines.push(`Continuity: ${sentence(sb.continuityNotes ?? '')}`);

  lines.push(`Dialogue: ${dialogueText(d.dialogue)}`);
  if (clean(d.ambientSound)) lines.push(`Sound design: ${sentence(d.ambientSound)}`);
  if (opts.noBackgroundMusic) lines.push('Music: no background music or score — only dialogue, ambience and sound effects (the film score is added in the edit).');
  if (opts.timedCues?.length) lines.push(`Timing: ${opts.timedCues.join(' ')}`);
  if (opts.noOverlayText) lines.push('On-screen text: none — no captions, subtitles, titles or name labels (text is added in the edit).');
  if (clean(d.avoid)) lines.push(`Avoid: ${sentence(d.avoid.startsWith('Do not') ? d.avoid : `Do not include ${d.avoid}`)}`);
  return lines.filter(Boolean).join('\n');
}

/** Adds the media binding declaration in front of a prompt body. */
export function withDeclaration(declaration: string, body: string): string {
  return declaration ? `${declaration}\n${body}` : body;
}

// ---------------------------------------------------------------------------
// Nano Banana Pro purposes
// ---------------------------------------------------------------------------

export const IMAGE_PURPOSES = {
  free: { label: 'Free generation', template: '' },
  character: {
    label: 'Character design',
    template: 'Character design portrait for a film. Full attention on face, hair, skin texture and wardrobe details. Neutral backdrop, cinematic key light.',
  },
  turnaround: {
    label: 'Character turnaround',
    template:
      'Character turnaround reference sheet on a plain light-grey background: front view, three-quarter view, side profile and back view of the same character, identical outfit and proportions in every view, neutral standing pose, even lighting, no text.',
  },
  costume: { label: 'Costume concept', template: 'Costume concept art: full-body outfit presentation with fabric, texture and accessory details, clean background.' },
  location: { label: 'Location / set', template: 'Cinematic location concept frame, production-design quality, strong sense of place, atmospheric depth.' },
  poster: { label: 'Poster', template: 'Theatrical key-art poster with a strong focal composition and deliberate negative space for title typography.' },
  thumbnail: { label: 'Thumbnail', template: 'High-impact video thumbnail: bold subject, clear silhouette, saturated contrast, readable at small sizes.' },
  storyboard: { label: 'Storyboard frame', template: 'Cinematic storyboard frame showing the exact composition, framing and blocking of the shot.' },
  product: { label: 'Product placement', template: 'Natural, cinematic product placement within the scene — product clearly visible, lit and integrated, not an advert.' },
  style_match: { label: 'Style match', template: 'Match the visual style, colour grade, lighting and texture of the reference image(s) exactly.' },
  lookbook: { label: 'Lookbook frame', template: 'Cinematic lookbook frame defining the film’s visual language: palette, lighting, lensing and texture.' },
} as const;
export type ImagePurpose = keyof typeof IMAGE_PURPOSES;

export function compileImagePrompt(purpose: ImagePurpose, prompt: string, styleBible?: StyleBible | null): string {
  const tpl = IMAGE_PURPOSES[purpose]?.template ?? '';
  const parts = [tpl, clean(prompt)];
  if (styleBible) {
    const s = [clean(styleBible.visualStyle), clean(styleBible.palette) && `Palette: ${clean(styleBible.palette)}`, clean(styleBible.lighting) && `Lighting: ${clean(styleBible.lighting)}`]
      .filter(Boolean)
      .join('. ');
    if (s) parts.push(`Project style: ${s}.`);
  }
  return parts.filter(Boolean).join('\n');
}
