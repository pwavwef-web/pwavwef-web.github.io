import { defaultLiteSpec, newScene, newShot, type LiteScene, type LiteShot, type LiteSpec, type ShotMotion } from '@az-studio/shared';

/**
 * "The Sky, the Woman and the Pestle" — an original dramatic adaptation of a widely told folktale premise
 * (a sky once near the earth that withdrew after being struck by a woman's pestle). It is a creative
 * adaptation: no specific people or tradition is claimed, and no cultural detail is presented as verified.
 */

export const TITLE = 'The Sky, the Woman and the Pestle';
export const LOGLINE = 'A tired woman pounding food keeps striking the low sky with her pestle — until one final blow sends it beyond reach.';

type MotionArg = [ShotMotion['preset'], number, number, number];
const mo = ([preset, intensity, x, y]: MotionArg): ShotMotion => ({ preset, intensity, focal: { x, y }, focalSize: null, ease: 'gentle', manual: null });

interface ShotDef {
  id: string;
  scale: LiteShot['scale'];
  sec: number;
  brief: string;
  composition: string;
  motion: MotionArg;
  woman?: boolean;
  transitionIn?: 'cut' | 'dissolve';
}

const WORLD = 'The same sun-baked courtyard of a West African village compound: swept red-brown earth, smooth plastered mud-brick walls, low conical thatched roofs, one old neem tree, a cotton clothesline strung between two wooden posts, a tall dark wooden mortar and a long pale-ended pestle.';
const SKY = 'The sky is a luminous, living blue hung impossibly low, its soft underside glowing and layered like folded cloth, with no face or figure in it.';

const SHOTS: Record<string, ShotDef[]> = {
  near: [
    { id: 'n1', scale: 'establishing', sec: 9, brief: `${WORLD} Early morning. ${SKY} Its lower edge hangs just above the thatched rooftops. A thread of cooking smoke rises from a hearth and leans against the sky. No people in view.`, composition: 'Courtyard and rooftops in the lower half, the glowing sky filling the upper half, smoke column right of centre', motion: ['push_in', 0.07, 0.55, 0.5] },
    { id: 'n2', scale: 'detail', sec: 8, brief: `Plain white cotton washing — the same white sheets and cloths seen on the clothesline in the other shots — lifts in a breeze on the clothesline and its top edge brushes the luminous low blue sky. ${SKY} Warm morning light, tactile fabric folds.`, composition: 'Cloth in the lower two thirds sweeping left to right, sky glow across the top', motion: ['pan_right', 0.07, 0.5, 0.5], transitionIn: 'dissolve' },
    { id: 'n3', scale: 'medium', sec: 9, brief: `A small child of about five, seen from behind and slightly to the side, stands on tiptoe in the courtyard with one arm stretched up; the fingertips almost touch the soft glowing underside of the low sky. ${SKY} Soft golden morning light on the child's skin.`, composition: 'Child at the lower centre, raised hand and the sky above with generous empty space', motion: ['tilt_up', 0.07, 0.5, 0.45], transitionIn: 'dissolve' },
  ],
  work: [
    { id: 'w1', scale: 'medium', sec: 9, woman: true, brief: `The woman stands at the tall wooden mortar in the courtyard, lifting the long pestle high with both hands; the top of the pestle touches the underside of the low sky and a faint ripple of pale light spreads across the blue. ${SKY} Hot late-morning light, dust in the air.`, composition: 'Woman in the centre-left, pestle top and the sky above her, courtyard wall behind', motion: ['push_in', 0.06, 0.45, 0.4] },
    { id: 'w2', scale: 'detail', sec: 8, woman: true, brief: 'Close detail of her strong, tired forearms and hands gripping the pestle as it drops into the mortar, grains of pounded cassava and a puff of flour in the air, a thin brass bangle on one wrist, sweat on the skin.', composition: 'Hands and pestle in the centre, mortar rim in the lower third', motion: ['drift', 0.05, 0.5, 0.55], transitionIn: 'cut' },
    { id: 'w3', scale: 'close', sec: 9, woman: true, brief: `Close-up of the woman's tired, proud face: sweat at her temple, jaw set, eyes lifting with irritation toward the low blue sky above, which casts a pale blue glow on her cheek. ${SKY}`, composition: 'Face in the centre-left third, eyes looking up and out of frame to the right, space above her', motion: ['push_in', 0.05, 0.42, 0.42] },
  ],
  warning: [
    { id: 'm1', scale: 'wide', sec: 10, woman: true, brief: `The same courtyard, the light has changed: the low sky has turned pale, thin silvery blue and very gentle, the washing hangs completely still. The woman stands frozen mid-lift at the mortar with the pestle half raised, looking up. ${SKY}`, composition: 'Small figure at the lower left third, mortar beside her, wide pale sky across the top, plenty of margin', motion: ['pull_out', 0.06, 0.4, 0.55] },
    { id: 'm2', scale: 'close', sec: 9, woman: true, brief: `Close-up of the woman's face lit by the pale silvery light, listening, her expression torn between tenderness and exhaustion, the pestle lowered in front of her chest. ${SKY}`, composition: 'Face in the centre, soft shallow depth of field, pestle shaft in the lower foreground', motion: ['still', 0.04, 0.5, 0.42] },
  ],
  blow: [
    { id: 'b1', scale: 'detail', sec: 6, woman: true, brief: 'Extreme close detail of her knuckles whitening around the pestle shaft, tendons tight in her wrist, dust drifting in a shaft of hard light.', composition: 'Hands centred, tight crop with the shaft diagonal', motion: ['push_in', 0.09, 0.5, 0.5] },
    { id: 'b2', scale: 'medium', sec: 6, woman: true, brief: `Low-angle shot of the woman angrily raising the pestle high above her head toward the low sky, her whole body stretched; the sky above seems to lean closer, the light tightening and turning harsh white-blue. ${SKY}`, composition: 'Woman at the lower centre, pestle and sky filling the upper two thirds', motion: ['push_in', 0.08, 0.5, 0.35] },
    { id: 'b3', scale: 'close', sec: 5, woman: true, brief: `The top of the pestle striking the glowing underside of the low sky in a bright flash, a hard shockwave ring of white-blue light radiating outward across the blue. ${SKY}`, composition: 'Pestle tip at the centre-low, ring of light spreading above', motion: ['still', 0.03, 0.5, 0.5] },
  ],
  silence: [
    { id: 's1', scale: 'wide', sec: 5, woman: true, brief: `Total stillness: the woman stands frozen with the pestle raised against the sky, dust motes hanging motionless in the air, the washing absolutely still, a faint pale light crack-glow where the pestle met the sky. ${SKY}`, composition: 'Woman small in the lower centre, pestle reaching up, a large expanse of sky above', motion: ['still', 0.03, 0.5, 0.55] },
  ],
  retreat: [
    { id: 'r1', scale: 'medium', sec: 8, woman: true, brief: `Low angle: the woman still holds the pestle up, but the sky above her has already lifted, a wide gap of white light now opening between the pestle tip and the blue. Her expression shifts from defiance to confusion. ${SKY}`, composition: 'Woman at lower centre, the pestle tip and the gap of light above her', motion: ['tilt_up', 0.08, 0.5, 0.4] },
    { id: 'r2', scale: 'wide', sec: 8, brief: `The whole courtyard seen from the doorway: the washing has fallen slack, the smoke column rises with nothing to lean on, and the glowing sky has lifted well above the roofs. ${WORLD} ${SKY} The woman is a small figure by the mortar.`, composition: 'Courtyard in the lower half, a visibly larger gap of sky above the roofs', motion: ['pull_out', 0.07, 0.5, 0.6] },
    { id: 'r3', scale: 'wide', sec: 8, brief: `Thatched rooftops of the village compound seen from a low rooftop angle, thin cooking smoke rising straight up into the empty air, the luminous sky far higher now and still climbing, a great space opening between roof and sky. ${SKY}`, composition: 'Roofs along the bottom third, a wide band of air, and the sky at the top', motion: ['tilt_up', 0.08, 0.5, 0.5] },
    { id: 'r4', scale: 'establishing', sec: 8, brief: `Wide view of the entire village of mud-brick compounds, thatched roofs and a few trees shrunken beneath a vast blue sky that has risen enormously high, huge cloud layers drifting at great distance. ${SKY}`, composition: 'Village in the bottom quarter, towering sky above', motion: ['pull_out', 0.06, 0.5, 0.7] },
    { id: 'r5', scale: 'establishing', sec: 10, brief: 'Extreme wide view of the whole land: the village is a continuous, tiny low line of terracotta roofs and a few trees running across the entire bottom edge of the frame, lit warm by the last sun, and above it an immense, cold, distant luminous blue sky with layered high cloud like folded cloth, endless empty space between earth and sky. Painterly, grounded, no figures.', composition: 'Thin continuous village horizon along the bottom tenth of the frame edge to edge; the rest of the frame is the distant sky', motion: ['tilt_up', 0.05, 0.5, 0.4] },
  ],
  reply: [
    { id: 'p1', scale: 'medium', sec: 9, woman: true, brief: `The woman has set the pestle against the mortar and stands with her head tipped back, calling upward with open hands, the sky now far above. Soft, cool afternoon light. ${WORLD}`, composition: 'Woman at the lower left third, upturned face and the distant sky in the upper right', motion: ['push_in', 0.06, 0.4, 0.42] },
    { id: 'p2', scale: 'close', sec: 8, woman: true, brief: 'Close-up of the woman looking up, her face vulnerable and stripped of defiance, eyes bright and wet, lips parted as if about to speak, cool silvery light from the distant sky on her face.', composition: 'Face centred, eyes toward the upper right, shallow depth of field', motion: ['still', 0.04, 0.5, 0.42] },
    { id: 'p3', scale: 'wide', sec: 9, woman: true, brief: `Wide shot: the small woman stands in the courtyard beneath the very distant sky, and a single thin thread of pale light falls from far above toward her but fades before it reaches the ground. ${WORLD} ${SKY}`, composition: 'Tiny woman in the lower centre, the thread of light descending through the upper centre', motion: ['pull_out', 0.05, 0.5, 0.65] },
  ],
  remains: [
    { id: 'e1', scale: 'medium', sec: 9, woman: true, brief: `Dusk. The woman sits on a low wooden stool beside the mortar, the long pestle resting across her knees, her face turned upward and quiet, the deep blue and amber evening sky very far above. ${WORLD}`, composition: 'Woman at the lower left third, mortar to her right, deep sky above', motion: ['push_in', 0.05, 0.4, 0.5] },
    { id: 'e2', scale: 'detail', sec: 9, brief: `The cotton washing hangs on the clothesline without a breath of wind at dusk, completely still and slack, with the luminous sky now far away above it, the gap between cloth and sky vast. Same framing and the same cloth as the opening washing shot. ${SKY}`, composition: 'Cloth in the lower two thirds, a wide empty band of sky across the top', motion: ['pan_right', 0.05, 0.5, 0.5], transitionIn: 'dissolve' },
    { id: 'e3', scale: 'medium', sec: 9, brief: `The same small child as in the opening, seen from behind and the side, stands on tiptoe in the dusk courtyard with an arm stretched upward, but the sky is now immensely far away above; the hand reaches into empty air. Same composition as the opening child shot, changed by distance.`, composition: 'Child at the lower centre, raised hand and a vast empty space above', motion: ['tilt_up', 0.05, 0.5, 0.55], transitionIn: 'dissolve' },
    { id: 'e4', scale: 'wide', sec: 12, woman: true, brief: `Final image: the courtyard at dusk, the woman sits small beside the abandoned wooden mortar, the pestle leaning against it, a single thread of smoke rising into the empty air, and far above an immense deep-blue sky with the first pale stars. The same courtyard, composition echoing the opening shot but changed by distance. ${WORLD}`, composition: 'Courtyard and woman in the lower third, the huge distant sky above, calm and spacious', motion: ['pull_out', 0.05, 0.45, 0.65] },
  ],
};

interface SceneDef {
  key: keyof typeof SHOTS;
  id: string;
  title: string;
  purpose: string;
  narration: string;
  mood: string;
  transitionIn: LiteScene['transitionIn'];
  music: LiteScene['music'];
  ambience: LiteScene['ambience'];
  lead?: number;
  tail?: number;
  pauseBeforeSec?: number;
}

export const SCENES: SceneDef[] = [
  { key: 'near', id: 'sc_near', title: 'When the sky was near', purpose: 'Intimacy: a world lived beneath a sky close enough to touch.', narration: 'There was a time when the sky hung low over the village. So low that cooking smoke rose, and leaned against it. Washing lifted in the breeze and brushed its blue. Children held up their hands, and the sky was almost there to meet them.', mood: 'Warm, luminous, tender, alive with morning', transitionIn: 'fade_black', music: { mode: 'score', intensity: 3, direction: 'Warm and spacious: the theme alone on flute and plucked strings, soft hand-drum pulse far away like distant pounding' }, ambience: { kind: 'wind', assetId: null, levelDb: 0 } },
  { key: 'work', id: 'sc_work', title: 'The woman at work', purpose: 'Irritation: fatigue, rhythm, and a small inconvenience she stops noticing.', narration: 'In one courtyard, a woman pounded food in a wooden mortar. Her shoulders ached before the sun was high. Each time she lifted the pestle, it touched the sky. A small knock against the blue. She hardly noticed it, the way you stop noticing a low doorway.', mood: 'Hot, rhythmic, tired, practical', transitionIn: 'dissolve', music: { mode: 'score', intensity: 4, direction: 'A steady soft pulse like the pounding becomes the motif; warm but a little weary' }, ambience: { kind: 'wind', assetId: null, levelDb: 0 } },
  { key: 'warning', id: 'sc_warning', title: 'The warning', purpose: 'The sky pleads for care; her frustration is understandable.', narration: 'Then the light began to change. It grew thin, and pale, and very gentle. “Careful,” the sky said. “Each blow bruises me. I came this close because I wanted to be near you. Lift it a little less high.” She stopped. Her arms were shaking. The food would not pound itself. “Then make room,” she said, and went back to work.', mood: 'Hushed, fragile, then stubborn', transitionIn: 'dissolve', music: { mode: 'score', intensity: 4, direction: 'The pulse thins; held low strings and a fragile high flute; unease beneath the warmth' }, ambience: { kind: 'wind', assetId: null, levelDb: 0 } },
  { key: 'blow', id: 'sc_blow', title: 'The final blow', purpose: 'Defiance: tension tightens to a single strike.', narration: 'Again. Again. Faster now. She was tired of being careful, in her own courtyard. She lifted the pestle as high as it would go, and brought it down.', mood: 'Tight, hard, building', transitionIn: 'cut', music: { mode: 'score', intensity: 8, direction: 'Pulse accelerating, low strings climbing, tension building to the strike and cutting off cleanly' }, ambience: { kind: 'wind', assetId: null, levelDb: 0 } },
  { key: 'silence', id: 'sc_silence', title: 'Silence', purpose: 'A brief, meaningful silence after the strike.', narration: '', mood: 'Absolute stillness', transitionIn: 'cut', music: { mode: 'silence', intensity: 1, direction: '' }, ambience: { kind: 'none', assetId: null, levelDb: 0 }, lead: 0, tail: 0 },
  { key: 'retreat', id: 'sc_retreat', title: 'The retreat', purpose: 'Separation: the sky withdraws; the emotional centre of the film.', narration: 'The sky did not answer. It simply began to leave. The washing hung slack. The smoke had nothing left to lean on. Roofs slipped out from under it, then the lane, then the whole village, until the blue hung where it hangs now. Far. Cold. Beyond any hand.', mood: 'Awe, loss, vast distance', transitionIn: 'cut', music: { mode: 'score', intensity: 9, direction: 'A powerful expansion: the theme rises and opens into wide strings, flute and deep drum as the sky climbs, then thins at the end' }, ambience: { kind: 'wind', assetId: null, levelDb: 3 }, lead: 2.0, tail: 1.8 },
  { key: 'reply', id: 'sc_reply', title: 'The reply', purpose: 'She calls upward, vulnerable; the sky answers with hurt and resolve.', narration: 'She set the pestle down. “Come back,” she called. Then, smaller: “I only wanted room.” The answer came from very far away, thin as thread. “I asked for care, and you gave me blows. I cannot stay where I am struck.”', mood: 'Vulnerable, hushed, cool', transitionIn: 'dissolve', music: { mode: 'score', intensity: 4, direction: 'Sparse and exposed: solo flute and a single low string, the theme broken and unresolved' }, ambience: { kind: 'wind', assetId: null, levelDb: 0 } },
  { key: 'remains', id: 'sc_remains', title: 'What remains', purpose: 'Longing: the changed echo of the opening.', narration: 'Evening found her sitting beside the mortar. The washing hung without a breath. No child reached. She had wanted room to lift her hands. She had not known how much room sorrow needed.', mood: 'Dusk, quiet, unresolved longing', transitionIn: 'dissolve', music: { mode: 'score', intensity: 2, direction: 'Very sparse: the opening theme returns alone, slower, ending unresolved on an open note' }, ambience: { kind: 'night', assetId: null, levelDb: 0 }, tail: 3 },
];

export const PROJECT_KEY = 'the-sky-the-woman-and-the-pestle';

export const WOMAN = {
  id: 'woman',
  name: 'The woman',
  description: 'A West African woman in her early forties: strong, lean forearms, a broad forehead, deep-set tired but proud eyes, warm dark-brown skin with natural texture, small lines at the corners of her mouth. Hair in neat cornrows swept back under a simple ochre cotton head tie. A thin brass bangle on her left wrist.',
  clothing: 'Faded indigo wrapper skirt tied at the waist, a plain undyed cream cotton top with rolled sleeves, ochre cotton head tie. No other jewellery.',
};

export const COURTYARD = {
  id: 'courtyard',
  name: 'The courtyard',
  description: 'A swept red-brown earth courtyard inside a mud-brick compound: smooth plastered rounded walls in warm terracotta, low conical thatched roofs, one old neem tree, a cotton clothesline between two wooden posts, and a tall dark carved wooden mortar with a long straight wooden pestle pale at the striking end, always on the right side of the courtyard near the neem tree.',
};

/** Prompts for the reference assets, generated first and reused in every shot. */
export const REFERENCE_PROMPTS = {
  womanPortrait: `Painterly cinematic character reference, three-quarter portrait of one woman, shoulders up, soft overcast daylight against a plain mud-plaster wall. ${WOMAN.description} ${WOMAN.clothing} Grounded, believable anatomy, tactile skin and cloth texture, neutral calm expression, looking slightly off-camera. No text.`,
  womanFull: `Painterly cinematic character reference, the same woman shown full-length standing in a swept earth courtyard in soft daylight, facing three-quarters toward the camera, relaxed arms. ${WOMAN.description} ${WOMAN.clothing} Believable anatomy and proportions, tactile cloth and skin texture. Match reference image 1 exactly for face, hair and head tie. No text.`,
  mortar: 'Painterly cinematic prop reference: a tall dark carved wooden mortar made from a single log, worn smooth and darkened with use, with a long straight wooden pestle pale and worn at the striking end resting in it, standing on swept red-brown earth beside a plastered mud wall, soft daylight, tactile wood grain. No people, no text.',
  courtyard: `Painterly cinematic location reference: ${COURTYARD.description} Wide establishing view in soft morning light, no people, a plain pale luminous sky above the roofs. No text.`,
};

export function buildSpec(refs: { woman: string[]; courtyard: string[] }, approved: Record<string, string>): LiteSpec {
  const spec = defaultLiteSpec({ direction: 'folklore', aspect: '16:9', targetSec: 210, idea: LOGLINE });
  spec.setup.extraAspects = ['9:16'];
  spec.setup.imageStyle = 'painterly';
  spec.setup.imageSize = '2K';
  spec.setup.wordsPerMinute = 130;
  spec.setup.look = { ...spec.setup.look, grain: 0.22, vignette: 0.3, haze: 0.12, warmth: 0.2, seed: 11 };
  spec.story = {
    idea: LOGLINE,
    sourceText: '',
    treatment: { title: TITLE, logline: LOGLINE, synopsis: 'An original dramatic adaptation of a folktale premise. A creative retelling; no specific origin or verified cultural detail is claimed.', beginning: 'The sky hangs low enough to touch over a village courtyard.', development: 'A tired woman pounds food; each lift of the pestle knocks the sky; it warns her, and she goes on.', turns: ['The sky warns her', 'The final blow', 'The sky withdraws'], ending: 'She sits beside the mortar beneath a sky she can no longer reach.', tone: 'Intimate, restrained, luminous, then bereft' },
    script: SCENES.filter((s) => s.narration).map((s) => s.narration).join('\n\n'),
    scriptApprovedAt: Date.now(),
  };
  spec.bible = {
    ...spec.bible,
    characters: [{ ...WOMAN, refAssetIds: refs.woman }],
    locations: [{ ...COURTYARD, refAssetIds: refs.courtyard }],
    palette: 'Warm earth tones — terracotta, ochre, dark wood, faded indigo — against a luminous blue sky',
    lighting: 'Natural light that shifts with the sky: warm golden morning, hard white noon, pale silver when the sky pleads, cool dusk',
    imageTreatment: 'Cinematic illustrated realism with tactile detail: visible grain of wood, cloth and earth; believable anatomy; grounded West African village setting kept consistent. The sky is a living luminous presence shown only through light, colour and cloud — never a face.',
    avoid: 'Readable text, logos, watermarks, subtitles, distorted hands, extra limbs, faces in the sky or clouds, cartoon style, collage of unrelated cultural symbols',
  };
  spec.voice = { ...spec.voice, voice: 'Sulafat', pace: 'natural', delivery: 'A warm, expressive storyteller with natural phrasing and clear pronunciation. Intimate and grounded, not an epic trailer voice. Lines spoken by the sky are gentler, softer and a little distant; the woman’s lines are plain, tired and increasingly vulnerable. Leave short, deliberate pauses between sentences.' };
  spec.subtitles = { ...spec.subtitles, preset: 'serif', font: 'EB Garamond', sizePct: 4.6, contrast: 'shadow', maxLines: 2, enabled: true, burnIn: true };
  spec.sound.music.identity = {
    style: 'Intimate cinematic folk score with warmth and life, built around one simple recurring melody',
    instrumentation: ['wooden flute', 'plucked lamellophone', 'soft hand drum', 'warm low strings', 'sparse piano'],
    key: 'D minor / F major',
    tempo: [64, 84],
    motif: 'A gentle four-note rising figure over a soft, steady two-beat pulse that echoes the sound of pounding; when the sky retreats the figure climbs and opens, and at the end it returns alone, slower, unresolved',
    avoid: ['vocals', 'lyrics', 'drum-kit grooves', 'constant mournfulness (the opening is warm and alive)'],
  };
  spec.sound.levels = { ...spec.sound.levels, musicDb: -16, ambienceDb: -27 };
  spec.sound.endHoldSec = 6;
  spec.sound.fadeOutSec = 5;
  spec.scenes = SCENES.map((d) => {
    const shots = SHOTS[d.key]!.map((s) =>
      newShot({
        id: s.id,
        brief: s.brief,
        composition: s.composition,
        scale: s.scale,
        characterIds: s.woman ? ['woman'] : [],
        locationId: 'courtyard',
        durationSec: s.sec,
        motion: mo(s.motion),
        transitionIn: s.transitionIn ?? 'cut',
        image: { approvedAssetId: approved[s.id] ?? null, uploads: [], reuseOfShotId: null },
      }),
    );
    return newScene({ id: d.id, title: d.title, purpose: d.purpose, narration: d.narration, mood: d.mood, transitionIn: d.transitionIn, music: d.music, ambience: d.ambience, leadInSec: d.lead ?? 1.2, tailSec: d.tail ?? 1.6, pauseBeforeSec: d.pauseBeforeSec ?? 0, shots }, undefined);
  });
  spec.stage = 'edit';
  return spec;
}

export const SHOT_COUNT = Object.values(SHOTS).reduce((a, b) => a + b.length, 0);
