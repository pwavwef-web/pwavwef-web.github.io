import path from 'node:path';
import { logger } from 'firebase-functions';
import {
  analyzeBlocking,
  blockingDirection,
  compileContinuity,
  emptyExpectations,
  mergeApprovedState,
  planShotContinuity,
  shotContinuitySchema,
  stateDocId,
  VISUAL_BIBLE_ID,
  type BlockingPlanDoc,
  type CameraAxisDoc,
  type CharacterDoc,
  type ContinuitySnapshotDoc,
  type ContinuityState,
  type ContinuityWarning,
  type ElementDoc,
  type InspectionExpectations,
  type LocationDoc,
  type OmniMediaRef,
  type PlannedShot,
  type ProjectDoc,
  type PropBibleDoc,
  type ProtectedScreenDoc,
  type SceneDoc,
  type SetBibleDoc,
  type ShotContinuityInput,
  type ShotDoc,
  type TakeDoc,
  type VisualBibleDoc,
  type ContinuityPromptResult,
} from '@az-studio/shared';
import { VIDEO_CAPABILITIES } from '../config/models';
import { createAsset, withTmpDir } from './assets';
import { bucket, col, db, FieldValue } from './firebase';
import { lastFrameJpeg } from './signal';

/**
 * Continuity Director (server): gathers a shot's structured continuity — Visual Bible, Character and Set
 * Bibles, prop ledger, blocking plan, camera axis and the previous approved state — plans and compiles
 * it, and keeps the per-shot snapshot lifecycle. Only `approveContinuity` (called when the director
 * approves an inspected take) writes canonical character, prop and axis state.
 */

type WithId<T> = T & { id: string };

export interface ShotContinuityContext {
  project: WithId<ProjectDoc>;
  shot: WithId<ShotDoc>;
  scene: WithId<SceneDoc> | null;
  characters: WithId<CharacterDoc>[];
  location: WithId<LocationDoc> | null;
  setBible: SetBibleDoc | null;
  visualBible: VisualBibleDoc | null;
  props: { element: WithId<ElementDoc>; ledger: PropBibleDoc | null }[];
  screens: WithId<ProtectedScreenDoc>[];
  blocking: BlockingPlanDoc | null;
  axis: CameraAxisDoc | null;
  input: ShotContinuityInput | null;
  /** The latest approved shot before this one (any scene) and its snapshot. */
  previous: { shot: WithId<ShotDoc>; snapshot: ContinuitySnapshotDoc } | null;
  previousShotId: string | null;
  nextShotId: string | null;
}

const sub = (projectId: string, name: string) => col.sub(projectId, name);

async function getAllIn<T>(projectId: string, name: string, ids: string[]): Promise<WithId<T>[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  const snaps = await db.getAll(...unique.map((id) => sub(projectId, name).doc(id)));
  return snaps.filter((s) => s.exists).map((s) => ({ ...(s.data() as T), id: s.id }));
}

/** Validated continuity input of a shot (invalid input is ignored and reported, never trusted). */
export function shotInput(shot: Pick<ShotDoc, 'continuity'>): ShotContinuityInput | null {
  if (!shot.continuity) return null;
  const parsed = shotContinuitySchema.safeParse(shot.continuity);
  if (!parsed.success) {
    logger.warn('invalid shot continuity input ignored', { issues: parsed.error.issues.slice(0, 3) });
    return null;
  }
  return parsed.data as ShotContinuityInput;
}

export async function loadShotContinuity(projectId: string, shotId: string): Promise<ShotContinuityContext> {
  const pref = col.projects().doc(projectId);
  const [projSnap, shotSnap] = await Promise.all([pref.get(), pref.collection('shots').doc(shotId).get()]);
  if (!projSnap.exists || !shotSnap.exists) throw new Error('Project or shot not found.');
  const project = { ...(projSnap.data() as ProjectDoc), id: projSnap.id };
  const shot = { ...(shotSnap.data() as ShotDoc), id: shotSnap.id };
  const input = shotInput(shot);
  const [scene, characters, locations, blockingSnap, visualSnap, neighbours] = await Promise.all([
    shot.sceneId ? pref.collection('scenes').doc(shot.sceneId).get() : Promise.resolve(null),
    getAllIn<CharacterDoc>(projectId, 'characters', shot.refs.characterIds),
    getAllIn<LocationDoc>(projectId, 'locations', shot.refs.locationIds),
    pref.collection('blockingPlans').doc(shotId).get(),
    pref.collection('visualBibles').doc(VISUAL_BIBLE_ID).get(),
    pref.collection('shots').orderBy('order', 'asc').get(),
  ]);
  const ordered = neighbours.docs.map((d) => ({ ...(d.data() as ShotDoc), id: d.id }));
  const idx = ordered.findIndex((s) => s.id === shotId);
  const previousShotId = idx > 0 ? ordered[idx - 1]!.id : null;
  const nextShotId = idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1]!.id : null;
  const location = locations[0] ?? null;
  const [setSnap, axisSnap, prevSnaps] = await Promise.all([
    location ? pref.collection('setBibles').doc(location.id).get() : Promise.resolve(null),
    shot.sceneId ? pref.collection('cameraAxes').doc(shot.sceneId).get() : Promise.resolve(null),
    idx > 0 ? db.getAll(...ordered.slice(Math.max(0, idx - 12), idx).reverse().map((s) => pref.collection('continuitySnapshots').doc(s.id))) : Promise.resolve([]),
  ]);
  let previous: ShotContinuityContext['previous'] = null;
  for (const s of prevSnaps) {
    if (!s.exists) continue;
    const snap = { ...(s.data() as ContinuitySnapshotDoc), id: s.id };
    if (!snap.approvedState) continue;
    const prevShot = ordered.find((x) => x.id === s.id);
    if (prevShot) {
      previous = { shot: prevShot, snapshot: snap };
      break;
    }
  }
  // Props in play: the shot's own, the ones planned for it, and anything its characters were holding.
  const held = previous ? Object.values(previous.snapshot.approvedState!.characters).flatMap((c) => [c.leftHand, c.rightHand]).filter((x): x is string => Boolean(x)) : [];
  const propIds = [...new Set([...shot.refs.elementIds, ...(input?.propIds ?? []), ...held.filter((h) => characters.some((c) => previous?.snapshot.approvedState?.characters[c.id]?.leftHand === h || previous?.snapshot.approvedState?.characters[c.id]?.rightHand === h))])];
  const [elements, ledgers, screens] = await Promise.all([getAllIn<ElementDoc>(projectId, 'elements', propIds), getAllIn<PropBibleDoc>(projectId, 'props', propIds), getAllIn<ProtectedScreenDoc>(projectId, 'protectedScreens', input?.screenIds ?? [])]);
  return {
    project,
    shot,
    scene: scene && scene.exists ? { ...(scene.data() as SceneDoc), id: scene.id } : null,
    characters,
    location,
    setBible: setSnap && setSnap.exists ? ({ ...setSnap.data(), id: setSnap.id } as SetBibleDoc) : null,
    visualBible: visualSnap.exists ? ({ ...visualSnap.data(), id: visualSnap.id } as VisualBibleDoc) : null,
    props: elements.map((e) => ({ element: e, ledger: ledgers.find((l) => l.id === e.id) ?? null })),
    screens,
    blocking: blockingSnap.exists ? ({ ...blockingSnap.data(), id: blockingSnap.id } as BlockingPlanDoc) : null,
    axis: axisSnap && axisSnap.exists ? ({ ...axisSnap.data(), id: axisSnap.id } as CameraAxisDoc) : null,
    input,
    previous,
    previousShotId,
    nextShotId,
  };
}

export interface ContinuityPlan {
  ctx: ShotContinuityContext;
  planned: PlannedShot;
  compiled: ContinuityPromptResult;
  before: ContinuityState | null;
  expectations: InspectionExpectations;
  names: { characters: Record<string, string>; props: Record<string, string> };
  /** Set views and bible references the reviewer compares the take with. */
  inspectionRefs: { assetId: string; label: string }[];
}

/** Plans the shot's continuity and compiles direction + references on top of the shot's own media. */
export function planContinuity(ctx: ShotContinuityContext, existingMedia: OmniMediaRef[], opts: { lockRefs?: boolean; maxImages?: number } = {}): ContinuityPlan {
  const before = ctx.previous?.snapshot.approvedState ?? null;
  const dialogue = ctx.shot.directions.dialogue.filter((l) => l.line.trim());
  const planned = planShotContinuity({
    shot: { id: ctx.shot.id, sceneId: ctx.shot.sceneId, characterIds: ctx.characters.map((c) => c.id), locationId: ctx.location?.id ?? null, action: ctx.shot.directions.action || ctx.shot.description, dialogueLastLine: dialogue[dialogue.length - 1]?.line ?? null },
    before,
    beforeSceneId: ctx.previous?.shot.sceneId ?? null,
    previousShotId: ctx.previousShotId,
    nextShotId: ctx.nextShotId,
    characters: ctx.characters.map((c) => ({ id: c.id, name: c.name, bible: c.bible?.approvedAt ? c.bible : null, wardrobe: c.wardrobe })),
    props: ctx.props.map((p) => ({ id: p.element.id, name: p.element.name, initial: p.ledger?.initial ?? null, ownerId: p.ledger?.ownerId ?? p.element.characterId ?? null })),
    location: ctx.location ? { id: ctx.location.id, timeOfDay: ctx.shot.continuity?.environment?.timeOfDay || ctx.scene?.timeOfDay || ctx.location.timeOfDay, lightDirection: ctx.setBible?.lighting.keyDirection, lightColour: ctx.setBible?.lighting.colour } : null,
    continuity: ctx.input,
    blocking: ctx.blocking,
    axis: ctx.axis,
    floorPlan: ctx.setBible?.floorPlan ?? [],
    planSizeM: ctx.setBible?.planSizeM,
  });
  const names = { characters: Object.fromEntries(ctx.characters.map((c) => [c.id, c.name])), props: Object.fromEntries(ctx.props.map((p) => [p.element.id, p.element.name])) };
  const blockingLines = ctx.blocking && planned.blocking ? blockingDirection(ctx.blocking, planned.blocking, (e) => (e.refId && names.characters[e.refId]) || (e.refId && names.props[e.refId]) || e.label) : [];
  const travel = Object.entries(planned.planned.camera.travel)
    .filter(([id, d]) => (d === 'left_to_right' || d === 'right_to_left') && names.characters[id])
    .map(([id, d]) => ({ name: names.characters[id]!, direction: d }));
  const sameScene = Boolean(ctx.previous && ctx.previous.shot.sceneId && ctx.previous.shot.sceneId === ctx.shot.sceneId);
  const compiled = compileContinuity({
    sceneId: ctx.shot.sceneId,
    // Only the approved Visual Bible and approved Character Bibles reach the video model.
    visualBible: ctx.visualBible?.approved ?? null,
    characters: ctx.characters.map((c) => ({ id: c.id, name: c.name, bible: c.bible?.approvedAt ? c.bible : null, appearance: [c.appearance, c.wardrobe].filter(Boolean).join('; '), primaryRefAssetId: opts.lockRefs === false ? null : c.primaryRefAssetId, state: planned.planned.characters[c.id] ?? null })),
    location: ctx.location ? { id: ctx.location.id, name: ctx.location.name, description: [ctx.location.description, ctx.location.atmosphere].filter(Boolean).join('; '), set: ctx.setBible, primaryRefAssetId: opts.lockRefs === false ? null : ctx.location.primaryRefAssetId } : null,
    props: ctx.props.map((p) => ({ id: p.element.id, name: p.element.name, description: p.ledger?.description || p.element.description, refAssetId: p.ledger?.approvedRefAssetId ?? p.element.referenceAssetIds[0] ?? null, state: planned.planned.props[p.element.id] ?? null })),
    screens: ctx.screens,
    previous: ctx.previous ? { title: ctx.previous.shot.title, finalFrameAssetId: ctx.previous.snapshot.finalFrameAssetId, sameScene } : null,
    blockingLines,
    travel,
    cameraDirectionDeg: ctx.blocking?.camera.directionDeg ?? null,
    environment: planned.planned.environment,
    startFromPreviousFrame: Boolean(ctx.input?.startFromPreviousFrame),
    existingMedia,
    maxImages: opts.maxImages ?? VIDEO_CAPABILITIES.maxImageInputs,
  });
  const speakers = new Set(dialogue.map((l) => l.character.trim().toLowerCase()));
  const expectations: InspectionExpectations = {
    ...emptyExpectations(),
    characters: ctx.characters
      .filter((c) => planned.planned.characters[c.id]?.present !== false)
      .map((c) => {
        const e = ctx.blocking?.entities.find((x) => x.refId === c.id);
        const speaking = speakers.has(c.name.trim().toLowerCase());
        return { id: c.id, name: c.name, speaking, mustShowFace: e ? e.protectedVisibility === 'face' && !e.occlusionAllowed : speaking };
      }),
    travel: Object.entries(planned.planned.camera.travel)
      .filter(([id]) => names.characters[id])
      .map(([id, direction]) => ({ id, name: names.characters[id]!, direction })),
    screens: ctx.screens.map((s) => ({ id: s.id, name: s.name, expectedText: s.expectedText, mayMirror: s.mayMirror, composite: s.composite })),
    intentionalLook: Boolean(ctx.input?.intentionalLook?.trim()),
    planWarnings: planned.warnings,
  };
  // The reviewer compares against the canonical set views and the approved identity references.
  const inspectionRefs: { assetId: string; label: string }[] = [];
  const set = ctx.setBible;
  if (set?.canonical.status === 'locked') {
    const view = compiled.setView ?? 'wide';
    for (const [v, id] of [[view, set.views[view]], ['wide', set.views.wide]] as const) if (id && !inspectionRefs.some((r) => r.assetId === id)) inspectionRefs.push({ assetId: id, label: `Canonical set view (${v}) of ${ctx.location?.name ?? 'the location'} — the background must match it` });
  }
  for (const c of ctx.characters) {
    const id = c.bible?.approvedAt ? c.bible.approvedRefIds[0] ?? c.primaryRefAssetId : c.primaryRefAssetId;
    if (id && !inspectionRefs.some((r) => r.assetId === id)) inspectionRefs.push({ assetId: id, label: `Approved identity reference: ${c.name}` });
  }
  for (const p of ctx.props) {
    const id = p.ledger?.approvedRefAssetId ?? p.element.referenceAssetIds[0];
    if (id && !inspectionRefs.some((r) => r.assetId === id) && inspectionRefs.length < 8) inspectionRefs.push({ assetId: id, label: `Approved prop reference: ${p.element.name}` });
  }
  for (const s of ctx.screens) {
    const id = s.contentAssetId ?? s.referenceAssetId;
    if (id && !inspectionRefs.some((r) => r.assetId === id) && inspectionRefs.length < 9) inspectionRefs.push({ assetId: id, label: `Approved content of the protected surface “${s.name}”` });
  }
  return { ctx, planned, compiled, before, expectations, names, inspectionRefs };
}

/** Adds the continuity direction and references to a shot's video request (idempotent by marker). */
export function applyContinuityToRequest<T extends { prompt: string; media: OmniMediaRef[] }>(req: T, plan: ContinuityPlan): T {
  if (!plan.compiled.text) return { ...req, media: plan.compiled.media };
  const marker = 'CONTINUITY (must hold for the whole shot):';
  const base = req.prompt.includes(marker) ? req.prompt.slice(0, req.prompt.indexOf(marker)).trimEnd() : req.prompt;
  let text = plan.compiled.text;
  const room = 11800 - base.length - 2;
  if (text.length > room) {
    // Drop the preferences first; the protected constraints stay.
    const prefAt = text.indexOf('Preferences (');
    if (prefAt > 0) text = `${text.slice(0, prefAt).trimEnd()}\n${text.slice(text.lastIndexOf('Do not mirror'))}`;
    if (text.length > room) text = `${text.slice(0, Math.max(0, room - 1))}…`;
  }
  return { ...req, prompt: `${base}\n\n${text}`, media: plan.compiled.media };
}

/** Compact badge mirrored onto the shot (the snapshot's own status is set deliberately at each stage). */
function mirrorStatus(snapshot: Pick<ContinuitySnapshotDoc, 'continuityWarnings' | 'status'>) {
  return { status: snapshot.status, openWarnings: snapshot.continuityWarnings.filter((w) => w.status === 'open' && w.severity !== 'info').length, updatedAt: Date.now() };
}

/** Writes (or refreshes) the planned part of a shot's continuity snapshot. Approved state is kept. */
export async function savePlan(plan: ContinuityPlan, extra: { productionId?: string | null } = {}): Promise<ContinuitySnapshotDoc> {
  const { ctx } = plan;
  const ref = sub(ctx.project.id, 'continuitySnapshots').doc(ctx.shot.id);
  const existing = await ref.get();
  const prev = existing.exists ? (existing.data() as ContinuitySnapshotDoc) : null;
  // Overridden plan warnings stay overridden when the same issue is found again.
  const overridden = new Map((prev?.continuityWarnings ?? []).filter((w) => w.status === 'overridden').map((w) => [`${w.kind}:${w.subjectId}:${w.expected}`, w]));
  const warnings: ContinuityWarning[] = [
    ...plan.planned.warnings.map((w) => {
      const o = overridden.get(`${w.kind}:${w.subjectId}:${w.expected}`);
      return o ? { ...w, status: 'overridden' as const, note: o.note ?? '' } : w;
    }),
    ...(prev?.continuityWarnings ?? []).filter((w) => w.source === 'inspection'),
  ];
  const doc: Omit<ContinuitySnapshotDoc, 'id'> = {
    shotId: ctx.shot.id,
    sceneId: ctx.shot.sceneId,
    order: ctx.shot.order,
    previousShotId: ctx.previousShotId,
    nextShotId: ctx.nextShotId,
    continuityBefore: plan.before,
    plannedState: plan.planned.planned,
    continuityAfter: prev?.continuityAfter ?? null,
    approvedState: prev?.approvedState ?? null,
    continuityWarnings: warnings,
    protectedConstraints: plan.compiled.protectedConstraints,
    optionalPreferences: plan.compiled.optionalPreferences,
    // Before approval, plan-time problems show as a warning (failure is decided by inspection).
    status: prev?.approvedState ? prev.status : warnings.some((w) => w.status === 'open' && w.severity !== 'info') ? 'warning' : 'planned',
    productionId: extra.productionId ?? prev?.productionId ?? null,
    versionId: prev?.versionId ?? null,
    finalFrameAssetId: prev?.finalFrameAssetId ?? null,
    approvedAt: prev?.approvedAt ?? null,
    plannedAt: Date.now(),
  };
  await ref.set({ ...doc, updatedAt: FieldValue.serverTimestamp() });
  await col.projects().doc(ctx.project.id).collection('shots').doc(ctx.shot.id).set({ continuityStatus: mirrorStatus(doc) }, { merge: true });
  return { ...doc, id: ref.id };
}

/** Records what the inspection saw (never canonical): detected state and inspection warnings. */
export async function recordInspection(projectId: string, shotId: string, input: { detected: ContinuityState | null; warnings: ContinuityWarning[]; versionId: string; productionId: string; passed: boolean }): Promise<void> {
  const ref = sub(projectId, 'continuitySnapshots').doc(shotId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const cur = snap.data() as ContinuitySnapshotDoc;
    const warnings = [...cur.continuityWarnings.filter((w) => w.source !== 'inspection'), ...input.warnings];
    const next: Partial<ContinuitySnapshotDoc> = { continuityAfter: input.detected, continuityWarnings: warnings, productionId: input.productionId };
    if (!cur.approvedState) next.status = input.passed ? (warnings.some((w) => w.status === 'open' && w.severity !== 'info') ? 'needs_review' : 'consistent') : 'failed';
    tx.set(ref, { ...next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    const merged = { ...cur, ...next } as ContinuitySnapshotDoc;
    tx.set(col.projects().doc(projectId).collection('shots').doc(shotId), { continuityStatus: { status: cur.approvedState ? merged.status : (next.status ?? merged.status), openWarnings: warnings.filter((w) => w.status === 'open' && w.severity !== 'info').length, updatedAt: Date.now() } }, { merge: true });
  });
}

/**
 * The only path that updates canonical continuity: the director approved an (inspected) take.
 * Writes the approved state, per-character and per-prop records, the camera axis side and travel
 * direction, and saves the take's final frame as the reference for the next shot.
 */
export async function approveContinuity(projectId: string, shotId: string, input: { versionId: string | null; productionId: string | null; waivedKinds: string[]; takeAssetId: string | null; repaired: boolean; inspected: boolean; ownerUid: string }): Promise<void> {
  const ref = sub(projectId, 'continuitySnapshots').doc(shotId);
  let snap = await ref.get();
  if (!snap.exists) {
    // A shot approved without a plan: plan it now from its current bibles (no warnings are hidden).
    try {
      const ctx = await loadShotContinuity(projectId, shotId);
      await savePlan(planContinuity(ctx, []));
      snap = await ref.get();
    } catch (e) {
      logger.warn('could not plan continuity at approval', { projectId, shotId, error: String(e) });
      return;
    }
  }
  const cur = snap.data() as ContinuitySnapshotDoc;
  const approved = mergeApprovedState(cur.plannedState, cur.continuityAfter, input.waivedKinds);
  let finalFrameAssetId: string | null = cur.finalFrameAssetId;
  if (input.takeAssetId) {
    try {
      finalFrameAssetId = await saveFinalFrame(input.ownerUid, projectId, shotId, input.takeAssetId);
    } catch (e) {
      logger.warn('final frame extraction failed', { shotId, error: String(e) });
    }
  }
  const overridden = input.waivedKinds.length > 0 || cur.continuityWarnings.some((w) => w.status === 'overridden');
  const status = !input.inspected ? 'needs_review' : input.repaired ? 'repaired' : overridden ? 'overridden' : 'locked';
  const batch = db.batch();
  batch.set(ref, { approvedState: approved, approvedAt: Date.now(), versionId: input.versionId, productionId: input.productionId ?? cur.productionId, finalFrameAssetId, status, continuityWarnings: cur.continuityWarnings.map((w) => (w.status === 'open' && input.waivedKinds.includes(w.kind) ? { ...w, status: 'overridden', note: 'Accepted at approval' } : w)), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  for (const [cid, state] of Object.entries(approved.characters)) {
    if (!state.present && !cur.plannedState.characters[cid]?.present) continue;
    batch.set(sub(projectId, 'characterStates').doc(stateDocId(shotId, cid)), { characterId: cid, shotId, sceneId: cur.sceneId, order: cur.order, planned: cur.plannedState.characters[cid] ?? state, approved: state, approvedAt: Date.now(), versionId: input.versionId }, { merge: true });
  }
  for (const [pid, state] of Object.entries(approved.props)) {
    batch.set(sub(projectId, 'propStates').doc(stateDocId(shotId, pid)), { propId: pid, shotId, sceneId: cur.sceneId, order: cur.order, planned: cur.plannedState.props[pid] ?? state, approved: state, events: [], approvedAt: Date.now(), versionId: input.versionId }, { merge: true });
  }
  // The first approved shot of a scene establishes the camera side of the line and travel directions.
  if (cur.sceneId) {
    const axisRef = sub(projectId, 'cameraAxes').doc(cur.sceneId);
    const axisSnap = await axisRef.get();
    const axis = axisSnap.exists ? (axisSnap.data() as CameraAxisDoc) : null;
    const blocking = (await sub(projectId, 'blockingPlans').doc(shotId).get()).data() as BlockingPlanDoc | undefined;
    const patch: Partial<CameraAxisDoc> & { sceneId: string } = { sceneId: cur.sceneId };
    if (blocking) {
      const analysis = analyzeBlocking(blocking, { axis });
      const derivedAxis = axis?.axis ?? (() => {
        const chars = blocking.entities.filter((e) => e.kind === 'character');
        return chars.length >= 2 ? { aId: chars[0]!.refId, bId: chars[1]!.refId, a: chars[0]!.position, b: chars[1]!.position } : null;
      })();
      if (!axis?.axis && derivedAxis) patch.axis = derivedAxis;
      if (!axis?.establishedSide && analysis.cameraSide) patch.establishedSide = analysis.cameraSide;
    }
    const travel = [...(axis?.travel ?? [])];
    for (const [refId, direction] of Object.entries(approved.camera.travel)) if (!travel.some((t) => t.refId === refId)) travel.push({ refId, direction });
    patch.travel = travel;
    if (!axis) Object.assign(patch, { crossings: [] });
    batch.set(axisRef, { ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  batch.set(col.projects().doc(projectId).collection('shots').doc(shotId), { continuityStatus: { status, openWarnings: cur.continuityWarnings.filter((w) => w.status === 'open' && !input.waivedKinds.includes(w.kind) && w.severity !== 'info').length, updatedAt: Date.now() } }, { merge: true });
  await batch.commit();
}

/** Withdrawn approval: the canonical records of this shot are removed (later shots re-plan). */
export async function withdrawContinuity(projectId: string, shotId: string): Promise<void> {
  const ref = sub(projectId, 'continuitySnapshots').doc(shotId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const cur = snap.data() as ContinuitySnapshotDoc;
  const batch = db.batch();
  batch.set(ref, { approvedState: null, approvedAt: null, status: cur.continuityWarnings.some((w) => w.status === 'open' && w.severity === 'critical') ? 'failed' : 'planned', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  for (const cid of Object.keys(cur.approvedState?.characters ?? {})) batch.delete(sub(projectId, 'characterStates').doc(stateDocId(shotId, cid)));
  for (const pid of Object.keys(cur.approvedState?.props ?? {})) batch.delete(sub(projectId, 'propStates').doc(stateDocId(shotId, pid)));
  batch.set(col.projects().doc(projectId).collection('shots').doc(shotId), { continuityStatus: { status: 'planned', openWarnings: 0, updatedAt: Date.now() } }, { merge: true });
  await batch.commit();
}

/** Last frame of an approved take, stored as an image asset (reference for the next shot). */
async function saveFinalFrame(uid: string, projectId: string, shotId: string, takeAssetId: string): Promise<string | null> {
  const asset = await col.assets().doc(takeAssetId).get();
  if (!asset.exists || asset.get('kind') !== 'video') return null;
  // Deterministic id: re-approving the same take never creates a duplicate frame.
  const newId = `ff_${takeAssetId}`.slice(0, 120);
  const existing = await col.assets().doc(newId).get();
  if (existing.exists) return newId;
  return withTmpDir(async (dir) => {
    const local = path.join(dir, 'take.mp4');
    await bucket.file(String(asset.get('storagePath'))).download({ destination: local });
    const jpg = path.join(dir, 'final-frame.jpg');
    await lastFrameJpeg(local, jpg, Math.min(1920, Number(asset.get('width') ?? 1280)));
    const storagePath = `users/${uid}/derived/${newId}/final-frame.jpg`;
    await bucket.upload(jpg, { destination: storagePath, resumable: false, metadata: { contentType: 'image/jpeg' } });
    await createAsset({ uid, assetId: newId, projectId, kind: 'image', source: 'derived', title: `Final frame · shot ${shotId}`, fileName: 'final-frame.jpg', mimeType: 'image/jpeg', storagePath, localFile: jpg, dir, collections: ['continuity-frames'], derivedFrom: { assetId: takeAssetId, atSec: Number(asset.get('durationSec') ?? 0) } });
    return newId;
  });
}

/** The approved take of a shot, if any. */
export async function approvedTake(projectId: string, shotId: string): Promise<WithId<TakeDoc> | null> {
  const shot = await col.projects().doc(projectId).collection('shots').doc(shotId).get();
  const takeId = shot.get('approvedTakeId') as string | null;
  if (!takeId) return null;
  const t = await shot.ref.collection('takes').doc(takeId).get();
  return t.exists ? { ...(t.data() as TakeDoc), id: t.id } : null;
}
