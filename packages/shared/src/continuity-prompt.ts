import {
  applicableBibleEntries,
  SCREEN_DIRECTION_LABELS,
  SET_VIEW_LABELS,
  VISUAL_BIBLE_PROMPT,
  viewForDirection,
  type CharacterBible,
  type CharacterState,
  type ColourDirection,
  type ContinuityConstraint,
  type EnvironmentState,
  type PropState,
  type ProtectedScreenDoc,
  type ScreenDirection,
  type SetBibleDoc,
  type SetView,
  type VisualBibleDoc,
} from './continuity';
import { heldItems } from './continuity-state';
import { planOmniMedia, type OmniMediaRef } from './prompt';

/**
 * Compiles the Continuity Director's structured state into direction for the video model and picks
 * the reference images that carry it (within the model's image limit, most important first).
 * Protected constraints are phrased as requirements; preferences as guidance.
 */

export interface ContinuityPromptCharacter {
  id: string;
  name: string;
  bible: Partial<CharacterBible> | null;
  appearance: string;
  primaryRefAssetId: string | null;
  state: CharacterState | null;
}

export interface ContinuityPromptInput {
  sceneId: string | null;
  visualBible: Pick<VisualBibleDoc, 'entries' | 'lookbookAssetIds' | 'colour'> | null;
  characters: ContinuityPromptCharacter[];
  location: { id: string; name: string; description: string; set: SetBibleDoc | null; primaryRefAssetId: string | null } | null;
  props: { id: string; name: string; description: string; refAssetId: string | null; state: PropState | null }[];
  screens: ProtectedScreenDoc[];
  previous: { title: string; finalFrameAssetId: string | null; sameScene: boolean } | null;
  blockingLines: string[];
  travel: { name: string; direction: ScreenDirection }[];
  cameraDirectionDeg: number | null;
  environment: EnvironmentState | null;
  startFromPreviousFrame: boolean;
  /** Media already bound by the shot (first/last frame, character references). */
  existingMedia: OmniMediaRef[];
  maxImages: number;
}

export interface ContinuityPromptResult {
  text: string;
  media: OmniMediaRef[];
  added: { assetId: string; role: OmniMediaRef['role']; why: string }[];
  dropped: { assetId: string; why: string }[];
  protectedConstraints: ContinuityConstraint[];
  optionalPreferences: ContinuityConstraint[];
  setView: SetView | null;
}

const clean = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');
const list = (xs: (string | null | undefined)[]) => xs.map(clean).filter(Boolean);

function colourWords(c: ColourDirection | null | undefined): string[] {
  if (!c) return [];
  return list([
    c.palette.length ? `palette ${c.palette.join(', ')}` : '',
    c.contrast ? `${c.contrast} contrast` : '',
    c.saturation ? `${c.saturation} saturation` : '',
    c.grain && c.grain !== 'none' ? `${c.grain} film grain` : '',
    c.highlightRollOff ? `${c.highlightRollOff} highlight roll-off` : '',
    c.shadowTreatment ? `${c.shadowTreatment} shadows` : '',
    c.whiteBalanceK ? `white balance around ${c.whiteBalanceK} K` : '',
    c.look ? `${c.look} look` : '',
  ]);
}

const SET_VIEW_PROMPT: Record<SetView, string> = { wide: 'wide establishing view', front: 'view facing the north wall', rear: 'view facing the south wall', left: 'view facing the west wall', right: 'view facing the east wall' };

let constraintCounter = 0;
const cid = () => `k${Date.now().toString(36)}${(constraintCounter = (constraintCounter + 1) % 100000).toString(36)}`;

export function compileContinuity(input: ContinuityPromptInput): ContinuityPromptResult {
  const protectedC: ContinuityConstraint[] = [];
  const prefs: ContinuityConstraint[] = [];
  const must = (source: ContinuityConstraint['source'], subjectId: string | null, text: string) => protectedC.push({ id: cid(), source, subjectId, text, level: 'locked' });
  const prefer = (source: ContinuityConstraint['source'], subjectId: string | null, text: string) => prefs.push({ id: cid(), source, subjectId, text, level: 'preferred' });

  // ---- reference images, most important first --------------------------------------------------
  const existing = input.existingMedia;
  const have = new Set(existing.map((m) => m.assetId));
  const imagesUsed = existing.filter((m) => m.role !== 'source_video' && m.role !== 'video_ref').length;
  const budget = Math.max(0, input.maxImages - imagesUsed);
  const candidates: { assetId: string; role: OmniMediaRef['role']; label: string; why: string }[] = [];
  const hasFirst = existing.some((m) => m.role === 'first_frame');
  if (input.startFromPreviousFrame && input.previous?.finalFrameAssetId && !hasFirst) {
    candidates.push({ assetId: input.previous.finalFrameAssetId, role: 'first_frame', label: 'previous shot final frame', why: 'The shot begins exactly where the previous approved shot ended.' });
  }
  for (const c of input.characters) {
    const refs = [...(c.bible?.approvedRefIds ?? []), c.primaryRefAssetId].filter((x): x is string => Boolean(x));
    const face = refs.find((id) => !have.has(id));
    if (face && !refs.slice(0, refs.indexOf(face)).some((id) => have.has(id))) candidates.push({ assetId: face, role: 'image_ref', label: c.name, why: `Approved identity reference for ${c.name}.` });
    const second = refs.filter((id) => id !== face && !have.has(id))[0];
    if (second && (c.bible?.approvedRefIds?.length ?? 0) > 1) candidates.push({ assetId: second, role: 'image_ref', label: `${c.name} (second angle)`, why: `Second approved angle of ${c.name}.` });
  }
  let setView: SetView | null = null;
  if (input.location) {
    const set = input.location.set;
    const locked = set?.canonical.status === 'locked';
    setView = viewForDirection(input.cameraDirectionDeg);
    const viewId = locked ? set?.views[setView] ?? set?.views.wide ?? null : null;
    const fallback = viewId ?? (locked ? null : input.location.primaryRefAssetId);
    if (fallback && !have.has(fallback)) candidates.push({ assetId: fallback, role: 'image_ref', label: `${input.location.name}${viewId ? ` — ${SET_VIEW_LABELS[set?.views[setView] === viewId ? setView : 'wide']}` : ''}`, why: locked ? 'Canonical set view matching the camera direction.' : 'Location reference.' });
  }
  if (input.previous?.finalFrameAssetId && input.previous.sameScene && !candidates.some((c) => c.assetId === input.previous!.finalFrameAssetId) && !have.has(input.previous.finalFrameAssetId)) {
    candidates.push({ assetId: input.previous.finalFrameAssetId, role: 'image_ref', label: 'previous shot final frame', why: 'Final approved frame of the preceding shot (continuity of state and background).' });
  }
  for (const p of input.props) if (p.refAssetId && !have.has(p.refAssetId) && p.state?.present !== false) candidates.push({ assetId: p.refAssetId, role: 'image_ref', label: p.name, why: `Approved reference for the ${p.name}.` });
  for (const s of input.screens) if (!s.composite && s.referenceAssetId && !have.has(s.referenceAssetId)) candidates.push({ assetId: s.referenceAssetId, role: 'image_ref', label: `${s.name} content`, why: 'Exact content of a protected screen/sign.' });
  const look = input.visualBible?.lookbookAssetIds?.[0];
  if (look && !have.has(look)) candidates.push({ assetId: look, role: 'image_ref', label: 'approved lookbook frame', why: 'Approved look of the film.' });

  const seen = new Set<string>();
  const unique = candidates.filter((c) => (seen.has(c.assetId) ? false : (seen.add(c.assetId), true)));
  const kept = unique.slice(0, budget);
  const dropped = unique.slice(budget).map((c) => ({ assetId: c.assetId, why: `${c.why} (left out: the video model accepts ${input.maxImages} images)` }));
  const media: OmniMediaRef[] = [...existing, ...kept.map((c) => ({ role: c.role, assetId: c.assetId, label: c.label }))];
  const planned = planOmniMedia(media);
  const tag = (assetId: string | null | undefined) => (assetId ? planned.media.find((m) => m.assetId === assetId)?.tag ?? '' : '');
  const refTag = (ids: (string | null | undefined)[]) => [...new Set(ids.map(tag).filter(Boolean))].slice(0, 2).join(' ');

  // ---- protected constraints --------------------------------------------------------------------
  const lines: string[] = [];
  for (const { key, entry, enforced } of applicableBibleEntries(input.visualBible, input.sceneId)) {
    const text = `${VISUAL_BIBLE_PROMPT[key]}: ${clean(entry.value)}`;
    if (key === 'prohibited') must('visual_bible', key, `Never show ${clean(entry.value)}`);
    else if (enforced) must('visual_bible', key, text);
    else prefer('visual_bible', key, text);
  }
  const colour = input.visualBible?.colour;
  const cw = colourWords(colour);
  if (cw.length) (colour?.approvedAt ? must : prefer)('colour', null, `Colour: ${cw.join('; ')}`);
  if (clean(colour?.skinTone)) must('colour', null, `Skin tones: ${clean(colour?.skinTone)}`);

  const propName = (id: string) => input.props.find((p) => p.id === id)?.name ?? id;
  for (const c of input.characters) {
    const b = c.bible;
    const s = c.state;
    const t = refTag([...(b?.approvedRefIds ?? []), c.primaryRefAssetId]);
    const identity = list([b?.ageRange && `age ${b.ageRange}`, b?.skinTone && `skin tone ${b.skinTone}`, b?.hair && `hair ${s?.hair || b.hair}`, b?.facialHair && `facial hair ${b.facialHair}`, b?.build && `build ${b.build}`, b?.height && `height ${b.height}`, b?.features && `distinguishing features: ${b.features}`]);
    const idText = identity.length ? identity.join(', ') : clean(c.appearance);
    must('character', c.id, `${c.name}${t ? ` ${t}` : ''} keeps exactly the same face and identity${idText ? `: ${idText}` : ''}`);
    for (const req of b?.protectedIdentity ?? []) if (clean(req)) must('character', c.id, `${c.name}: ${clean(req)}`);
    if (s) {
      if (!s.present) continue;
      if (clean(s.costume)) must('character', c.id, `${c.name} wears ${clean(s.costume)}`);
      if (s.accessories.length) must('character', c.id, `${c.name} wears/carries ${s.accessories.join(', ')}`);
      const held = heldItems(s, propName);
      must('character', c.id, held.length ? `${c.name} holds ${held.join(' and ')}` : `${c.name}’s hands are empty unless the action says otherwise`);
      if (clean(s.physical)) must('character', c.id, `${c.name}: ${clean(s.physical)}`);
      if (clean(s.emotion)) prefer('character', c.id, `${c.name}’s emotional state: ${clean(s.emotion)}`);
    }
    if (clean(b?.movementStyle)) prefer('character', c.id, `${c.name} moves ${clean(b?.movementStyle)}`);
  }

  if (input.location) {
    const set = input.location.set;
    const t = refTag([set?.views[setView ?? 'wide'], set?.views.wide, input.location.primaryRefAssetId]);
    const parts = list([
      set?.wallColours && `wall colours ${set.wallColours}`,
      set?.materials && `materials ${set.materials}`,
      set?.floorPlan.filter((f) => f.kind === 'door' || f.kind === 'window').length ? `${set.floorPlan.filter((f) => f.kind === 'door').length} door(s) and ${set.floorPlan.filter((f) => f.kind === 'window').length} window(s) exactly where they are in the reference` : '',
      set?.floorPlan.filter((f) => f.kind === 'furniture').length ? `furniture (${set.floorPlan.filter((f) => f.kind === 'furniture').map((f) => f.label).filter(Boolean).join(', ')}) in the same places` : '',
      set?.backgroundObjects.length ? `background objects: ${set.backgroundObjects.join(', ')}` : '',
    ]);
    must('set', input.location.id, `Location: ${input.location.name}${t ? ` ${t}` : ''}${set?.canonical.status === 'locked' && setView ? ` (${SET_VIEW_PROMPT[setView]})` : ''} — same architecture, layout and decoration${parts.length ? `: ${parts.join('; ')}` : clean(input.location.description) ? `: ${clean(input.location.description)}` : ''}`);
    for (const f of set?.protectedFeatures ?? []) if (clean(f)) must('set', input.location.id, `Protected feature: ${clean(f)}`);
    for (const f of set?.neverChange ?? []) if (clean(f)) must('set', input.location.id, `Never change: ${clean(f)}`);
    for (const sign of set?.readableSigns ?? []) if (clean(sign.text)) must('set', input.location.id, `The sign ${clean(sign.where) ? `on ${clean(sign.where)} ` : ''}reads exactly “${clean(sign.text)}”, correctly oriented, never mirrored`);
    if (set?.population) prefer('set', input.location.id, `Background population: ${clean(set.population)}`);
    for (const f of set?.mayChange ?? []) if (clean(f)) prefer('set', input.location.id, `May change: ${clean(f)}`);
  }
  const env = input.environment;
  if (env) {
    const e = list([env.timeOfDay && `time of day ${env.timeOfDay}`, env.weather && `weather ${env.weather}`, env.lightDirection && `key light ${env.lightDirection}`, env.lightColour && `light colour ${env.lightColour}`]);
    if (e.length) must('set', env.locationId, `Environment: ${e.join(', ')} — the same as the rest of the scene`);
  }
  for (const p of input.props) {
    const s = p.state;
    if (!s?.present) continue;
    const t = tag(p.refAssetId);
    const holder = s.holderId ? input.characters.find((c) => c.id === s.holderId)?.name : null;
    const where = holder ? `in ${holder}’s ${s.hand === 'both' ? 'hands' : `${(s.hand ?? 'right').toUpperCase()} hand`}` : clean(s.location) ? `at ${clean(s.location)}` : '';
    must('prop', p.id, `The ${p.name}${t ? ` ${t}` : ''} is the same object in every shot (same size, colour and design)${where ? `, ${where}` : ''}${s.status !== 'intact' ? `, ${s.status}` : ''}${clean(s.condition) ? ` (${clean(s.condition)})` : ''}`);
  }
  for (const s of input.screens) {
    if (s.composite) must('screen', s.id, `The ${s.surface} screen/surface (${s.name}) stays clean, evenly lit and fully visible, facing the camera, with no text, interface or logo on it — the approved content is composited in the edit; never cover it with hands or objects`);
    else if (clean(s.expectedText)) must('screen', s.id, `The ${s.surface} (${s.name})${tag(s.referenceAssetId) ? ` ${tag(s.referenceAssetId)}` : ''} shows exactly “${clean(s.expectedText)}”, readable, correctly spelled and NOT mirrored`);
  }
  for (const l of input.blockingLines) must('blocking', null, l.replace(/\.$/, ''));
  for (const t of input.travel) must('axis', null, `Screen direction: ${t.name} travels ${SCREEN_DIRECTION_LABELS[t.direction].toLowerCase()}, as established`);
  if (input.previous?.finalFrameAssetId && kept.some((k) => k.assetId === input.previous!.finalFrameAssetId)) {
    const t = tag(input.previous.finalFrameAssetId);
    must('previous_shot', null, input.startFromPreviousFrame && t === '<FIRST_FRAME>' ? `Start from the exact final frame of the previous shot “${clean(input.previous.title)}” and continue the action seamlessly` : `${t} is the final frame of the previous shot “${clean(input.previous.title)}”: continue from that state — same costumes, props, positions, lighting and background`);
  }

  if (protectedC.length) {
    lines.push('CONTINUITY (must hold for the whole shot):');
    for (const c of protectedC) lines.push(`- ${c.text}.`);
  }
  if (prefs.length) {
    lines.push('Preferences (follow unless the action requires otherwise):');
    for (const p of prefs) lines.push(`- ${p.text}.`);
  }
  if (protectedC.length || prefs.length) {
    lines.push('Do not mirror or flip the image; do not change anyone’s face, age, build or skin tone; do not add, remove or merge people; do not move doors, windows or furniture; do not change wall colours; do not render captions, watermarks or text that was not requested.');
  }
  let text = lines.join('\n');
  if (text.length > 6000) text = `${text.slice(0, 5990)}…`;
  return { text, media, added: kept.map((k) => ({ assetId: k.assetId, role: k.role, why: k.why })), dropped, protectedConstraints: protectedC, optionalPreferences: prefs, setView };
}
