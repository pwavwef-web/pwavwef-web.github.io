import {
  defaultCharacterState,
  defaultPropState,
  emptyContinuityState,
  warningId,
  type BlockingPlanDoc,
  type CameraAxisDoc,
  type CharacterBible,
  type CharacterState,
  type ContinuityState,
  type ContinuityWarning,
  type FloorItem,
  type PropEvent,
  type PropState,
  type ScreenDirection,
  type ShotContinuityInput,
} from './continuity';
import { analyzeBlocking, type BlockingAnalysis } from './spatial';

/**
 * Continuity state lifecycle for one shot:
 *   continuityBefore (the previous approved shot, or the bibles' defaults)
 *     + the director's planned changes and on-screen events
 *     = plannedState, with warnings for every change nothing on screen explains.
 * After inspection the detected state is compared with the plan; on approval the approved state becomes
 * canonical (waived deviations adopt what was actually filmed).
 */

export interface PlanShotInput {
  shot: { id: string; sceneId: string | null; characterIds: string[]; locationId: string | null; action: string; dialogueLastLine: string | null };
  /** Previous approved shot's state (null for the first shot or when nothing is approved yet). */
  before: ContinuityState | null;
  beforeSceneId: string | null;
  previousShotId: string | null;
  nextShotId: string | null;
  characters: { id: string; name: string; bible: Partial<CharacterBible> | null; wardrobe: string }[];
  props: { id: string; name: string; initial: PropState | null; ownerId: string | null }[];
  location: { id: string; timeOfDay: string; weather?: string; lightDirection?: string; lightColour?: string } | null;
  continuity: ShotContinuityInput | null;
  blocking: BlockingPlanDoc | null;
  axis: CameraAxisDoc | null;
  floorPlan: FloorItem[];
  planSizeM?: number;
}

export interface PlannedShot {
  planned: ContinuityState;
  warnings: ContinuityWarning[];
  blocking: BlockingAnalysis | null;
  /** Prop changes that on-screen events justify (for the prop timeline). */
  justified: { propId: string; event: PropEvent }[];
}

const handsOf = (s: CharacterState) => [s.leftHand, s.rightHand].filter((x): x is string => Boolean(x));

function mkWarning(input: Pick<PlanShotInput, 'previousShotId' | 'nextShotId'>, kind: ContinuityWarning['kind'], severity: ContinuityWarning['severity'], subjectId: string | null, message: string, expected: string, detected: string | null = null, proposed: ContinuityWarning['proposedRepair'] = null): ContinuityWarning {
  return { id: warningId(kind), kind, severity, subjectId, message, expected, detected, difference: detected ? `${expected} → ${detected}` : null, proposedRepair: proposed, affects: { previousShotId: input.previousShotId, nextShotId: input.nextShotId }, source: 'plan', status: 'open' };
}

/** Applies on-screen prop events to the prop and character states (in order). */
export function applyPropEvents(props: Record<string, PropState>, characters: Record<string, CharacterState>, events: PropEvent[]): { props: Record<string, PropState>; characters: Record<string, CharacterState> } {
  const P: Record<string, PropState> = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, { ...v }]));
  const C: Record<string, CharacterState> = Object.fromEntries(Object.entries(characters).map(([k, v]) => [k, { ...v }]));
  const release = (propId: string) => {
    for (const c of Object.values(C)) {
      if (c.leftHand === propId) c.leftHand = null;
      if (c.rightHand === propId) c.rightHand = null;
    }
  };
  const grip = (charId: string | null, propId: string, hand: 'left' | 'right' | 'both' | null) => {
    if (!charId || !C[charId]) return;
    const c = C[charId]!;
    const h = hand ?? (c.rightHand ? 'left' : 'right');
    if (h === 'left' || h === 'both') c.leftHand = propId;
    if (h === 'right' || h === 'both') c.rightHand = propId;
  };
  for (const e of events) {
    const p = (P[e.propId] ??= defaultPropState());
    switch (e.type) {
      case 'pick_up':
      case 'reveal':
        release(e.propId);
        p.present = true;
        p.holderId = e.characterId;
        p.hand = e.characterId ? e.hand ?? 'right' : null;
        if (e.characterId) grip(e.characterId, e.propId, p.hand);
        break;
      case 'hand_over':
        release(e.propId);
        p.holderId = e.toCharacterId;
        p.hand = e.toCharacterId ? e.hand ?? 'right' : null;
        if (e.toCharacterId) grip(e.toCharacterId, e.propId, p.hand);
        break;
      case 'switch_hands':
        if (p.holderId) {
          release(e.propId);
          p.hand = e.hand ?? (p.hand === 'left' ? 'right' : 'left');
          grip(p.holderId, e.propId, p.hand);
        }
        break;
      case 'put_down':
        release(e.propId);
        p.holderId = null;
        p.hand = null;
        if (e.location) p.location = e.location;
        break;
      case 'lose':
        release(e.propId);
        p.holderId = null;
        p.hand = null;
        p.present = false;
        if (e.location) p.location = e.location;
        break;
      case 'open':
        p.status = 'open';
        break;
      case 'close':
        p.status = 'closed';
        break;
      case 'fill':
        p.status = 'full';
        break;
      case 'empty':
        p.status = 'empty';
        break;
      case 'damage':
        p.status = 'damaged';
        if (e.note) p.condition = e.note;
        break;
      case 'repair':
        p.status = 'intact';
        if (e.note) p.condition = e.note;
        break;
      case 'switch_on':
        p.status = 'on';
        break;
      case 'switch_off':
        p.status = 'off';
        break;
    }
  }
  return { props: P, characters: C };
}

const IRREVERSIBLE: Partial<Record<PropState['status'], PropState['status'][]>> = {
  // Without an on-screen event these changes are continuity errors.
  empty: ['full'],
  damaged: ['intact'],
  missing: ['intact', 'open', 'closed', 'full', 'empty', 'on', 'off'],
};

/** Plans a shot's continuity and lists every unexplained change. */
export function planShotContinuity(input: PlanShotInput): PlannedShot {
  const before = input.before;
  const sameScene = Boolean(before && input.shot.sceneId && input.beforeSceneId === input.shot.sceneId);
  const c = input.continuity;
  const planned = emptyContinuityState();
  const warnings: ContinuityWarning[] = [];

  // Characters: continue from the previous shot, else from the bible.
  for (const ch of input.characters) {
    const prev = before?.characters[ch.id];
    const base: CharacterState = prev ? { ...prev, present: true, entry: 'none', exit: 'none' } : defaultCharacterState(ch.bible, ch.wardrobe);
    const over = c?.characters[ch.id] ?? {};
    const { costumeChangeReason, ...changes } = over;
    const next: CharacterState = { ...base, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) } as CharacterState;
    if (prev && sameScene) {
      if (changes.costume !== undefined && changes.costume.trim() && changes.costume.trim() !== prev.costume.trim() && !costumeChangeReason) {
        warnings.push(mkWarning(input, 'costume', 'warning', ch.id, `${ch.name}’s costume changes within the scene with no reason given.`, prev.costume || 'unchanged costume', changes.costume, { type: 'edit_plan', label: 'Keep the costume, or record why it changes', estimateUsd: null }));
      }
      if (changes.hair !== undefined && changes.hair.trim() && changes.hair.trim() !== prev.hair.trim()) {
        warnings.push(mkWarning(input, 'hair', 'warning', ch.id, `${ch.name}’s hair changes within the scene.`, prev.hair || 'unchanged hair', changes.hair));
      }
      const lost = prev.accessories.filter((a) => !next.accessories.includes(a));
      if (changes.accessories && lost.length) {
        warnings.push(mkWarning(input, 'accessory', 'warning', ch.id, `${ch.name} loses ${lost.join(', ')} between shots.`, prev.accessories.join(', '), next.accessories.join(', ') || 'none'));
      }
    }
    planned.characters[ch.id] = next;
  }
  // Characters who were present before but are not in this shot stay in the canonical state (off screen).
  if (before) for (const [id, s] of Object.entries(before.characters)) if (!planned.characters[id]) planned.characters[id] = { ...s, present: false };

  // Props: previous state (or initial ledger state), then on-screen events.
  const propIds = [...new Set([...(c?.propIds ?? []), ...input.props.map((p) => p.id)])];
  const props: Record<string, PropState> = {};
  for (const id of propIds) {
    const ledger = input.props.find((p) => p.id === id);
    props[id] = before?.props[id] ? { ...before.props[id]! } : ledger?.initial ? { ...ledger.initial } : defaultPropState();
  }
  if (before) for (const [id, s] of Object.entries(before.props)) if (!props[id]) props[id] = { ...s };
  // Hands in the character state must agree with the prop ledger before events are applied.
  for (const [pid, p] of Object.entries(props)) {
    if (!p.holderId || !planned.characters[p.holderId]) continue;
    const holder = planned.characters[p.holderId]!;
    if (p.hand === 'left' || p.hand === 'both') holder.leftHand = pid;
    if (p.hand === 'right' || p.hand === 'both') holder.rightHand = pid;
  }
  const events = c?.propEvents ?? [];
  const applied = applyPropEvents(props, planned.characters, events);
  planned.props = applied.props;
  planned.characters = applied.characters;
  const justifiedIds = new Set(events.map((e) => e.propId));
  const warnedProps = new Set<string>();

  // Explicit hand overrides that contradict the ledger are unexplained changes.
  for (const ch of input.characters) {
    const over = c?.characters[ch.id];
    const now = planned.characters[ch.id]!;
    for (const hand of ['leftHand', 'rightHand'] as const) {
      const wanted = over?.[hand];
      if (wanted === undefined) continue;
      const had = now[hand];
      if (wanted !== had) {
        const propId = wanted ?? had;
        if (propId && justifiedIds.has(propId)) continue;
        const name = input.props.find((p) => p.id === propId)?.name ?? propId ?? 'an object';
        const side = hand === 'leftHand' ? 'left' : 'right';
        warnings.push(
          mkWarning(input, 'prop_hand', sameScene ? 'critical' : 'warning', propId ?? ch.id, `${ch.name}’s ${side} hand changes from ${had ? input.props.find((p) => p.id === had)?.name ?? had : 'empty'} to ${wanted ? name : 'empty'} with no on-screen action.`, had ? `${input.props.find((p) => p.id === had)?.name ?? had} in the ${side} hand` : 'empty hand', wanted ? `${name}` : 'empty', {
            type: 'edit_plan',
            label: 'Add a pick-up / hand-over / switch-hands event, or keep the prop where it was',
            estimateUsd: null,
          }),
        );
        if (propId) warnedProps.add(propId);
        now[hand] = wanted;
        // The director's plan wins (with the warning): keep the ledger consistent with the hands.
        if (wanted && planned.props[wanted]) {
          const p = planned.props[wanted]!;
          p.holderId = ch.id;
          p.hand = now.leftHand === wanted && now.rightHand === wanted ? 'both' : side;
        }
        if (had && had !== wanted && planned.props[had] && planned.props[had]!.holderId === ch.id && now.leftHand !== had && now.rightHand !== had) {
          planned.props[had]!.holderId = null;
          planned.props[had]!.hand = null;
        }
      }
    }
  }

  // Prop state changes that no event explains.
  if (before) {
    for (const [id, prev] of Object.entries(before.props)) {
      const next = planned.props[id];
      if (!next || justifiedIds.has(id) || warnedProps.has(id)) continue;
      const name = input.props.find((p) => p.id === id)?.name ?? id;
      if (prev.holderId !== next.holderId || prev.hand !== next.hand) {
        warnings.push(mkWarning(input, 'prop_hand', 'critical', id, `${name} moves from ${prev.holderId ? `${input.characters.find((x) => x.id === prev.holderId)?.name ?? prev.holderId}’s ${prev.hand ?? ''} hand` : prev.location || 'where it was'} with no on-screen action.`, `${prev.holderId ?? 'nobody'} / ${prev.hand ?? prev.location}`, `${next.holderId ?? 'nobody'} / ${next.hand ?? next.location}`));
      } else if (!prev.holderId && prev.location && next.location && prev.location !== next.location) {
        warnings.push(mkWarning(input, 'prop_teleport', 'warning', id, `${name} changes place (${prev.location} → ${next.location}) with no on-screen action.`, prev.location, next.location));
      }
      if (IRREVERSIBLE[prev.status]?.includes(next.status)) {
        warnings.push(mkWarning(input, 'prop_state', 'critical', id, `${name} goes from ${prev.status} to ${next.status} with no on-screen action.`, prev.status, next.status));
      }
      if (prev.present && !next.present) warnings.push(mkWarning(input, 'prop_missing', 'warning', id, `${name} disappears with no on-screen action.`, 'present', 'missing'));
    }
  }

  // Environment: location, time of day, weather and light carry through a scene.
  const env = planned.environment;
  env.locationId = input.shot.locationId ?? before?.environment.locationId ?? null;
  const prevEnv = sameScene ? before!.environment : null;
  env.timeOfDay = c?.environment.timeOfDay ?? prevEnv?.timeOfDay ?? input.location?.timeOfDay ?? '';
  env.weather = c?.environment.weather ?? prevEnv?.weather ?? input.location?.weather ?? '';
  env.lightDirection = c?.environment.lightDirection ?? prevEnv?.lightDirection ?? input.location?.lightDirection ?? '';
  env.lightColour = c?.environment.lightColour ?? prevEnv?.lightColour ?? input.location?.lightColour ?? '';
  env.background = c?.environment.background ?? prevEnv?.background ?? '';
  if (prevEnv) {
    if (prevEnv.locationId && env.locationId && prevEnv.locationId !== env.locationId) warnings.push(mkWarning(input, 'location', 'warning', env.locationId, 'The location changes inside one scene.', prevEnv.locationId, env.locationId));
    if (c?.environment.timeOfDay && prevEnv.timeOfDay && c.environment.timeOfDay !== prevEnv.timeOfDay) warnings.push(mkWarning(input, 'time_of_day', 'warning', null, 'Time of day changes inside one scene.', prevEnv.timeOfDay, c.environment.timeOfDay));
    if (c?.environment.weather && prevEnv.weather && c.environment.weather !== prevEnv.weather) warnings.push(mkWarning(input, 'weather', 'warning', null, 'Weather changes inside one scene.', prevEnv.weather, c.environment.weather));
    if (c?.environment.lightDirection && prevEnv.lightDirection && c.environment.lightDirection !== prevEnv.lightDirection && !c.intentionalLook) warnings.push(mkWarning(input, 'lighting', 'warning', null, 'The key light direction changes inside one scene without a reason.', prevEnv.lightDirection, c.environment.lightDirection));
  }

  // Blocking, axis and screen direction.
  let analysis: BlockingAnalysis | null = null;
  if (input.blocking) {
    analysis = analyzeBlocking(input.blocking, {
      planSizeM: input.planSizeM,
      floorPlan: input.floorPlan,
      axis: input.axis,
      axisCrossingAllowed: Boolean(c?.axisCrossing),
      shotId: input.shot.id,
      previousShotId: input.previousShotId,
      nextShotId: input.nextShotId,
    });
    warnings.push(...analysis.warnings);
    planned.camera.side = analysis.cameraSide;
    planned.camera.directionDeg = input.blocking.camera.directionDeg;
    for (const e of input.blocking.entities) {
      if (e.kind !== 'character' || !e.refId || !planned.characters[e.refId]) continue;
      const s = planned.characters[e.refId]!;
      s.position = { ...e.position };
      s.facingDeg = e.facingDeg;
      s.posture = e.posture;
      if (e.gaze.kind === 'camera') s.gaze = 'camera';
      else if (e.gaze.kind === 'entity' && e.gaze.targetId) s.gaze = input.blocking.entities.find((x) => x.id === e.gaze.targetId)?.refId ?? e.gaze.targetId;
      const a = analysis.entities.find((x) => x.id === e.id);
      if (a) {
        if (a.entry) s.entry = a.entry;
        if (a.exit) s.exit = a.exit;
        if (a.travel !== 'static') planned.camera.travel[e.refId] = a.travel;
      }
    }
    // Travel must keep its screen direction through connected shots.
    const established: Record<string, ScreenDirection> = { ...(sameScene ? before!.camera.travel : {}) };
    for (const t of input.axis?.travel ?? []) established[t.refId] ??= t.direction;
    for (const [refId, dir] of Object.entries(planned.camera.travel)) {
      const prev = established[refId];
      const lateral = (d: ScreenDirection) => d === 'left_to_right' || d === 'right_to_left';
      if (prev && lateral(prev) && lateral(dir) && prev !== dir && c?.directionChange?.refId !== refId) {
        const name = input.characters.find((x) => x.id === refId)?.name ?? refId;
        warnings.push(
          mkWarning(input, 'screen_direction', 'critical', refId, `${name} travelled ${prev === 'left_to_right' ? 'left → right' : 'right → left'} but now travels ${dir === 'left_to_right' ? 'left → right' : 'right → left'} — the audience will read it as turning back.`, prev, dir, {
            type: 'neutral_shot',
            label: 'Insert a neutral (head-on or tail-away) shot, or correct the direction',
            estimateUsd: null,
          }),
        );
      }
    }
    // Entering the frame on the side they left.
    if (sameScene && before) {
      for (const e of input.blocking.entities) {
        if (e.kind !== 'character' || !e.refId) continue;
        const prevExit = before.characters[e.refId]?.exit;
        const now = planned.characters[e.refId];
        if (!now || !prevExit || (prevExit !== 'left' && prevExit !== 'right') || (now.entry !== 'left' && now.entry !== 'right')) continue;
        if (prevExit === now.entry) {
          warnings.push(mkWarning(input, 'entry_exit', 'warning', e.refId, `${e.label} left the previous shot frame ${prevExit} but enters this one from the ${now.entry} — they should enter from the opposite side.`, `enter from frame ${prevExit === 'left' ? 'right' : 'left'}`, `enter from frame ${now.entry}`));
        }
      }
    }
  } else if (before && sameScene) {
    planned.camera = { ...before.camera, travel: { ...before.camera.travel } };
  }

  for (const id of c?.screenIds ?? []) planned.screens[id] = { content: 'approved content', orientation: 'normal' };
  planned.dialogue = { lastLine: input.shot.dialogueLastLine, complete: true };
  planned.action = { description: input.shot.action, complete: true };
  return { planned, warnings, blocking: analysis, justified: events.map((e) => ({ propId: e.propId, event: e })) };
}

// ---------------------------------------------------------------------------
// Detected state (from the reviewer) vs the plan
// ---------------------------------------------------------------------------

export interface DetectedCharacter {
  characterId: string | null;
  name: string;
  present: boolean;
  costume: string;
  hair: string;
  leftHand: string;
  rightHand: string;
  posture: string;
  screenSide: 'left' | 'centre' | 'right' | 'absent';
  facing: string;
  emotion: string;
  matchesReference: boolean;
}

export interface DetectedProp {
  propId: string | null;
  name: string;
  present: boolean;
  holder: string;
  hand: 'left' | 'right' | 'both' | 'none';
  status: string;
  condition: string;
}

export interface DetectedState {
  characters: DetectedCharacter[];
  props: DetectedProp[];
  environment: { timeOfDay: string; weather: string; lightDirection: string; background: string };
  travel: { name: string; direction: ScreenDirection | 'mixed' }[];
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const mentions = (hay: string, needle: string) => Boolean(needle) && norm(hay).includes(norm(needle));

/** Builds the detected continuity state (continuityAfter) from the reviewer's observations. */
export function detectedToState(planned: ContinuityState, d: DetectedState, names: { characters: Record<string, string>; props: Record<string, string> }): ContinuityState {
  const out: ContinuityState = JSON.parse(JSON.stringify(planned)) as ContinuityState;
  for (const [id, s] of Object.entries(out.characters)) {
    const det = d.characters.find((c) => c.characterId === id) ?? d.characters.find((c) => norm(c.name) === norm(names.characters[id]));
    if (!det) continue;
    s.present = det.present;
    if (det.costume) s.costume = det.costume;
    if (det.hair) s.hair = det.hair;
    const propByText = (t: string) => {
      if (!t || /^(none|empty|nothing|n\/a)$/i.test(t.trim())) return null;
      const hit = Object.entries(names.props).find(([, n]) => mentions(t, n));
      return hit ? hit[0] : t;
    };
    s.leftHand = propByText(det.leftHand);
    s.rightHand = propByText(det.rightHand);
    if (det.emotion) s.emotion = det.emotion;
  }
  for (const [id, p] of Object.entries(out.props)) {
    const det = d.props.find((x) => x.propId === id) ?? d.props.find((x) => norm(x.name) === norm(names.props[id]));
    if (!det) continue;
    p.present = det.present;
    const holder = Object.entries(names.characters).find(([, n]) => mentions(det.holder, n));
    p.holderId = holder ? holder[0] : null;
    p.hand = det.hand === 'none' ? null : det.hand;
    if (det.status) p.status = (['intact', 'open', 'closed', 'full', 'empty', 'damaged', 'missing', 'on', 'off', 'lit', 'unlit'].includes(det.status) ? det.status : p.status) as PropState['status'];
    if (det.condition) p.condition = det.condition;
  }
  if (d.environment.timeOfDay) out.environment.timeOfDay = d.environment.timeOfDay;
  if (d.environment.weather) out.environment.weather = d.environment.weather;
  if (d.environment.lightDirection) out.environment.lightDirection = d.environment.lightDirection;
  for (const t of d.travel) {
    const id = Object.entries(names.characters).find(([, n]) => norm(n) === norm(t.name))?.[0];
    if (id && t.direction !== 'mixed') out.camera.travel[id] = t.direction;
  }
  return out;
}

/** Deviations between what was planned and what the reviewer saw (inspection warnings). */
export function compareStates(expected: ContinuityState, detected: ContinuityState, names: { characters: Record<string, string>; props: Record<string, string> }, ctx: { previousShotId: string | null; nextShotId: string | null }): ContinuityWarning[] {
  const out: ContinuityWarning[] = [];
  const w = (kind: ContinuityWarning['kind'], severity: ContinuityWarning['severity'], subjectId: string | null, message: string, exp: string, det: string) =>
    out.push({ id: warningId(kind), kind, severity, subjectId, message, expected: exp, detected: det, difference: `${exp} → ${det}`, proposedRepair: null, affects: ctx, source: 'inspection', status: 'open' });
  const pname = (id: string | null) => (id ? names.props[id] ?? id : 'nothing');
  for (const [id, e] of Object.entries(expected.characters)) {
    const d = detected.characters[id];
    if (!d || !e.present) continue;
    const n = names.characters[id] ?? id;
    if (!d.present) w('character_presence', 'critical', id, `${n} should be in the shot but was not seen.`, 'present', 'absent');
    for (const hand of ['leftHand', 'rightHand'] as const) {
      if ((e[hand] ?? null) !== (d[hand] ?? null) && (e[hand] || d[hand])) {
        w('prop_hand', 'critical', e[hand] ?? d[hand], `${n} holds ${pname(d[hand])} in the ${hand === 'leftHand' ? 'left' : 'right'} hand; the plan has ${pname(e[hand])}.`, pname(e[hand]), pname(d[hand]));
      }
    }
  }
  for (const [id, e] of Object.entries(expected.props)) {
    const d = detected.props[id];
    if (!d) continue;
    const n = names.props[id] ?? id;
    if (e.present && !d.present) w('prop_missing', 'critical', id, `${n} is missing.`, 'present', 'missing');
    if (e.status !== d.status && d.present) w('prop_state', 'warning', id, `${n} is ${d.status}; the plan has it ${e.status}.`, e.status, d.status);
  }
  for (const [id, dir] of Object.entries(expected.camera.travel)) {
    const d = detected.camera.travel[id];
    if (d && d !== dir && (dir === 'left_to_right' || dir === 'right_to_left') && (d === 'left_to_right' || d === 'right_to_left')) {
      w('screen_direction', 'critical', id, `${names.characters[id] ?? id} travels ${d.replace(/_/g, ' ')} instead of ${dir.replace(/_/g, ' ')}.`, dir, d);
    }
  }
  if (expected.environment.timeOfDay && detected.environment.timeOfDay && norm(expected.environment.timeOfDay) !== norm(detected.environment.timeOfDay) && !mentions(detected.environment.timeOfDay, expected.environment.timeOfDay)) {
    w('time_of_day', 'warning', null, `The shot looks like ${detected.environment.timeOfDay}; the scene is ${expected.environment.timeOfDay}.`, expected.environment.timeOfDay, detected.environment.timeOfDay);
  }
  return out;
}

/**
 * The approved (canonical) state: the plan, except where the director accepted a deviation — then the
 * canonical record follows what was actually filmed so later shots continue from reality.
 */
export function mergeApprovedState(planned: ContinuityState, detected: ContinuityState | null, waivedKinds: string[]): ContinuityState {
  const out: ContinuityState = JSON.parse(JSON.stringify(planned)) as ContinuityState;
  if (!detected) return out;
  const waived = new Set(waivedKinds);
  const adopt = (k: string) => waived.has(k);
  for (const [id, d] of Object.entries(detected.characters)) {
    const s = out.characters[id];
    if (!s) continue;
    if (adopt('costume') || adopt('costume_change')) s.costume = d.costume;
    if (adopt('hairstyle') || adopt('hair_change') || adopt('hair')) s.hair = d.hair;
    if (adopt('prop_hand') || adopt('props')) {
      s.leftHand = d.leftHand;
      s.rightHand = d.rightHand;
    }
  }
  if (adopt('prop_hand') || adopt('props') || adopt('prop_state')) {
    for (const [id, d] of Object.entries(detected.props)) if (out.props[id]) out.props[id] = { ...d };
  }
  if (adopt('screen_direction') || adopt('direction_reversal')) out.camera.travel = { ...detected.camera.travel };
  if (adopt('time_of_day')) out.environment.timeOfDay = detected.environment.timeOfDay;
  if (adopt('weather')) out.environment.weather = detected.environment.weather;
  return out;
}

/** Everything a character holds, for prompts ("the brass key in her right hand"). */
export function heldItems(s: CharacterState, propName: (id: string) => string): string[] {
  const out: string[] = [];
  if (s.leftHand && s.leftHand === s.rightHand) return [`${propName(s.leftHand)} in both hands`];
  if (s.rightHand) out.push(`${propName(s.rightHand)} in the RIGHT hand`);
  if (s.leftHand) out.push(`${propName(s.leftHand)} in the LEFT hand`);
  return out;
}

export { handsOf };
