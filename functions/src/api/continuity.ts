import { HttpsError } from 'firebase-functions/v2/https';
import {
  ACTIVE_STATUSES,
  CONTINUITY_DOC_SCHEMAS,
  coverageBlocking,
  EMPTY_DIRECTIONS,
  VISUAL_BIBLE_ID,
  type ApiRequest,
  type CameraAxisDoc,
  type CharacterDoc,
  type ContinuityCollection,
  type ContinuitySnapshotDoc,
  type CreditMetadata,
  type ElementDoc,
  type LocationDoc,
  type OmniMediaRef,
  type ProjectDoc,
  type SetBibleDoc,
  type ShotDoc,
  type SongDoc,
  type VisualBibleDoc,
} from '@az-studio/shared';
import { MODEL_REGISTRY, VIDEO_CAPABILITIES } from '../config/models';
import { col, db, FieldValue } from '../lib/firebase';
import { loadShotContinuity, planContinuity, savePlan } from '../lib/continuity';
import { cancelJobDoc } from '../lib/jobs';
import type { Owner } from '../lib/owner';

type Payload<A extends ApiRequest['action']> = Extract<ApiRequest, { action: A }>['payload'];

async function ownedProject(uid: string, projectId: string): Promise<ProjectDoc & { id: string }> {
  const snap = await col.projects().doc(projectId).get();
  if (!snap.exists || snap.get('ownerUid') !== uid) throw new HttpsError('not-found', 'Project not found.');
  return { ...(snap.data() as ProjectDoc), id: snap.id };
}

/** Every asset id a document references must be media the owner owns. */
async function assertOwnedAssets(uid: string, ids: (string | null | undefined)[]): Promise<void> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return;
  const snaps = await db.getAll(...unique.map((id) => col.assets().doc(id)));
  for (const s of snaps) if (!s.exists || s.get('ownerUid') !== uid) throw new HttpsError('invalid-argument', `Referenced media ${s.id} is not in your library.`);
}

function assetIdsIn(value: unknown, keyHint = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = `${keyHint}.${k}`;
    if (typeof v === 'string' && /(asset(Id|Ids)?|AssetId|refs\.\w+|views\.\w+|approvedRefIds)$/i.test(key) && v) out.push(v);
    else if (Array.isArray(v) && /(AssetIds|approvedRefIds|detailAssetIds|lookbookAssetIds|referenceAssetIds|logoAssetIds)$/i.test(k)) out.push(...v.filter((x): x is string => typeof x === 'string'));
    else if (v && typeof v === 'object') out.push(...assetIdsIn(v, key));
  }
  return out;
}

const DOC_ID_RULE: Partial<Record<ContinuityCollection, (data: Record<string, unknown>) => string>> = {
  visualBibles: () => VISUAL_BIBLE_ID,
  setBibles: (d) => String(d.locationId),
  props: (d) => String(d.elementId),
  blockingPlans: (d) => String(d.shotId),
  cameraAxes: (d) => String(d.sceneId),
  lyricsTracks: (d) => String(d.songId),
};

// ---------------------------------------------------------------------------
// Typed writes
// ---------------------------------------------------------------------------

export async function continuitySave(owner: Owner, p: Payload<'continuitySave'>) {
  await ownedProject(owner.uid, p.projectId);
  const schema = CONTINUITY_DOC_SCHEMAS[p.collection];
  const parsed = schema.safeParse(p.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || p.collection}: ${i.message}`).join('; '));
  const data = parsed.data as Record<string, unknown>;
  await assertOwnedAssets(owner.uid, assetIdsIn(data));
  const fixedId = DOC_ID_RULE[p.collection]?.(data);
  if (fixedId && p.id && p.id !== fixedId) throw new HttpsError('invalid-argument', `This ${p.collection} document must use the id ${fixedId}.`);
  const ref = fixedId ? col.sub(p.projectId, p.collection).doc(fixedId) : p.id ? col.sub(p.projectId, p.collection).doc(p.id) : col.sub(p.projectId, p.collection).doc();
  const existing = await ref.get();

  if (p.collection === 'visualBibles') {
    // Draft edits never reach generation until the director approves the bible again.
    const prev = existing.exists ? (existing.data() as VisualBibleDoc) : null;
    await ref.set({ ...data, approvedAt: null, version: (prev?.version ?? 0) + 1, approved: prev?.approved ?? null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { id: ref.id, needsApproval: true };
  }
  if (p.collection === 'setBibles') {
    const locRef = col.projects().doc(p.projectId).collection('locations').doc(String(data.locationId));
    if (!(await locRef.get()).exists) throw new HttpsError('not-found', 'Location not found.');
    const prev = existing.exists ? (existing.data() as SetBibleDoc) : null;
    if (prev?.canonical.status === 'locked') {
      const protectedKeys = ['views', 'floorPlan', 'neverChange', 'protectedFeatures', 'readableSigns', 'wallColours', 'materials', 'planSizeM'] as const;
      const changed = protectedKeys.filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(data[k]));
      if (changed.length) throw new HttpsError('failed-precondition', `This set is locked. Unlock it before changing ${changed.join(', ')} — every approved shot in this location depends on them.`);
    }
    await ref.set({ ...data, canonical: prev?.canonical ?? { status: 'draft', approvedAt: null, approvedViews: [], packJobId: null }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { id: ref.id };
  }
  if (p.collection === 'blockingPlans') {
    const shot = await col.projects().doc(p.projectId).collection('shots').doc(String(data.shotId)).get();
    if (!shot.exists) throw new HttpsError('not-found', 'Shot not found.');
  }
  if (p.collection === 'props') {
    const el = await col.projects().doc(p.projectId).collection('elements').doc(String(data.elementId)).get();
    if (!el.exists) throw new HttpsError('not-found', 'The prop is not in the Props & costumes list.');
  }
  if (p.collection === 'audioTracks') {
    const mp = await col.sub(p.projectId, 'musicProjects').doc(String(data.musicProjectId)).get();
    if (!mp.exists) throw new HttpsError('not-found', 'Music project not found.');
  }
  await ref.set({ ...data, updatedAt: FieldValue.serverTimestamp(), ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() }) }, { merge: false });
  return { id: ref.id };
}

export async function continuityDelete(owner: Owner, p: Payload<'continuityDelete'>) {
  await ownedProject(owner.uid, p.projectId);
  const ref = col.sub(p.projectId, p.collection).doc(p.id);
  const snap = await ref.get();
  if (!snap.exists) return { deleted: false };
  if (p.collection === 'setBibles' && (snap.data() as SetBibleDoc).canonical?.status === 'locked') throw new HttpsError('failed-precondition', 'Unlock the set before deleting it.');
  if (p.collection === 'musicProjects') {
    const tracks = await col.sub(p.projectId, 'audioTracks').where('musicProjectId', '==', p.id).get();
    const b = db.batch();
    tracks.docs.forEach((d) => b.delete(d.ref));
    b.delete(ref);
    await b.commit();
    return { deleted: true };
  }
  await ref.delete();
  return { deleted: true };
}

export async function characterBibleSave(owner: Owner, p: Payload<'characterBibleSave'>) {
  await ownedProject(owner.uid, p.projectId);
  const ref = col.projects().doc(p.projectId).collection('characters').doc(p.characterId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Character not found.');
  const c = snap.data() as CharacterDoc;
  await assertOwnedAssets(owner.uid, [...Object.values(p.bible.refs), ...p.bible.approvedRefIds, ...p.bible.costumes.map((x) => x.assetId)]);
  if (p.approve && c.realPerson && !c.consentConfirmed) throw new HttpsError('failed-precondition', `“${c.name}” depicts a real person. Confirm their consent before approving identity references.`);
  if (p.approve && !p.bible.approvedRefIds.length) throw new HttpsError('failed-precondition', 'Choose at least one approved face reference before locking the character.');
  const bible = { ...p.bible, approvedAt: p.approve ? Date.now() : null };
  await ref.set({ bible, locked: p.approve ? true : c.locked, ...(p.approve && !c.primaryRefAssetId && p.bible.approvedRefIds[0] ? { primaryRefAssetId: p.bible.approvedRefIds[0] } : {}) }, { merge: true });
  return { approvedAt: bible.approvedAt };
}

export async function bibleApprove(owner: Owner, p: Payload<'bibleApprove'>) {
  await ownedProject(owner.uid, p.projectId);
  if (p.kind === 'visual') {
    const ref = col.sub(p.projectId, 'visualBibles').doc(VISUAL_BIBLE_ID);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Create the Visual Bible first.');
    const v = snap.data() as VisualBibleDoc;
    if (!p.approve) {
      await ref.set({ approvedAt: null, approved: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { approved: false };
    }
    const at = Date.now();
    await ref.set({ approvedAt: at, approved: { entries: v.entries ?? {}, lookbookAssetIds: v.lookbookAssetIds ?? [], colour: { ...v.colour, approvedAt: v.colour?.referenceAssetId || v.colour?.palette?.length ? at : null }, approvedAt: at, version: v.version ?? 1 }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { approved: true, approvedAt: at };
  }
  if (p.kind === 'character') {
    const ref = col.projects().doc(p.projectId).collection('characters').doc(p.id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Character not found.');
    const c = snap.data() as CharacterDoc;
    if (p.approve && !c.bible?.approvedRefIds?.length) throw new HttpsError('failed-precondition', 'Choose approved face references in the Character Bible first.');
    if (p.approve && c.realPerson && !c.consentConfirmed) throw new HttpsError('failed-precondition', `“${c.name}” depicts a real person. Confirm their consent first.`);
    await ref.set({ bible: { ...(c.bible ?? {}), approvedAt: p.approve ? Date.now() : null }, locked: p.approve }, { merge: true });
    return { approved: p.approve };
  }
  const ref = col.sub(p.projectId, 'setBibles').doc(p.id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Create the Set Bible first.');
  const s = snap.data() as SetBibleDoc;
  if (p.approve) {
    const views = p.views.length ? p.views : (Object.entries(s.views).filter(([, id]) => id).map(([v]) => v) as SetBibleDoc['canonical']['approvedViews']);
    if (!views.length || !views.some((v) => s.views[v])) throw new HttpsError('failed-precondition', 'Approve at least one reference view of the set (the wide establishing view is best).');
    await ref.set({ canonical: { status: 'locked', approvedAt: Date.now(), approvedViews: views.filter((v) => s.views[v]), packJobId: s.canonical?.packJobId ?? null }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await col.projects().doc(p.projectId).collection('locations').doc(p.id).set({ locked: true, ...(s.views.wide ? { primaryRefAssetId: s.views.wide } : {}) }, { merge: true });
    return { approved: true };
  }
  await ref.set({ canonical: { ...(s.canonical ?? {}), status: 'draft', approvedAt: null }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { approved: false };
}

// ---------------------------------------------------------------------------
// Continuity check (plan, warnings, compiled direction, references)
// ---------------------------------------------------------------------------

/** The media a shot binds on its own (mirrors the web client's shot media). */
export function shotOwnMedia(shot: ShotDoc, characters: (CharacterDoc & { id: string })[], locations: (LocationDoc & { id: string })[], elements: (ElementDoc & { id: string })[]): OmniMediaRef[] {
  const refs: OmniMediaRef[] = [];
  if (shot.refs.firstFrameAssetId) refs.push({ role: 'first_frame', assetId: shot.refs.firstFrameAssetId, label: 'first frame' });
  if (shot.refs.firstFrameAssetId && shot.refs.lastFrameAssetId) refs.push({ role: 'last_frame', assetId: shot.refs.lastFrameAssetId, label: 'last frame' });
  const imgs: OmniMediaRef[] = [];
  if (shot.lockRefs) {
    for (const id of shot.refs.characterIds) {
      const c = characters.find((x) => x.id === id);
      if (c?.primaryRefAssetId) imgs.push({ role: 'image_ref', assetId: c.primaryRefAssetId, label: c.name });
    }
    for (const id of shot.refs.locationIds) {
      const l = locations.find((x) => x.id === id);
      if (l?.primaryRefAssetId) imgs.push({ role: 'image_ref', assetId: l.primaryRefAssetId, label: l.name });
    }
    for (const id of shot.refs.elementIds) {
      const e = elements.find((x) => x.id === id);
      if (e?.referenceAssetIds[0]) imgs.push({ role: 'image_ref', assetId: e.referenceAssetIds[0], label: e.name });
    }
  }
  for (const id of shot.refs.assetIds) imgs.push({ role: 'image_ref', assetId: id, label: 'reference' });
  const unique = imgs.filter((r, i) => imgs.findIndex((x) => x.assetId === r.assetId) === i);
  return [...refs, ...unique.slice(0, Math.max(0, VIDEO_CAPABILITIES.maxImageInputs - refs.length))];
}

export async function continuityCheck(owner: Owner, p: Payload<'continuityCheck'>) {
  await ownedProject(owner.uid, p.projectId);
  const ctx = await loadShotContinuity(p.projectId, p.shotId);
  const locs = ctx.location ? [ctx.location] : [];
  const own = shotOwnMedia(ctx.shot, ctx.characters, locs, ctx.props.map((x) => x.element));
  const plan = planContinuity(ctx, own, { lockRefs: ctx.shot.lockRefs });
  if (p.save) await savePlan(plan);
  return {
    warnings: plan.planned.warnings,
    text: plan.compiled.text,
    added: plan.compiled.added,
    dropped: plan.compiled.dropped,
    setView: plan.compiled.setView,
    protectedConstraints: plan.compiled.protectedConstraints,
    optionalPreferences: plan.compiled.optionalPreferences,
    planned: plan.planned.planned,
    before: plan.before,
    previousShotId: ctx.previous?.shot.id ?? null,
    blocking: plan.planned.blocking ? { screenOrder: plan.planned.blocking.screenOrder, cameraSide: plan.planned.blocking.cameraSide, entities: plan.planned.blocking.entities } : null,
    names: plan.names,
  };
}

export async function continuityWarning(owner: Owner, p: Payload<'continuityWarning'>) {
  await ownedProject(owner.uid, p.projectId);
  const ref = col.sub(p.projectId, 'continuitySnapshots').doc(p.shotId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Run a continuity check first.');
    const s = snap.data() as ContinuitySnapshotDoc;
    const w = s.continuityWarnings.find((x) => x.id === p.warningId);
    if (!w) throw new HttpsError('not-found', 'Warning not found.');
    const status = p.action === 'override' ? 'overridden' : p.action === 'resolve' ? 'resolved' : 'open';
    if (status === 'overridden' && !p.note.trim()) throw new HttpsError('invalid-argument', 'Say why this is intended — overrides are recorded.');
    const warnings = s.continuityWarnings.map((x) => (x.id === p.warningId ? { ...x, status, note: p.note.trim() || x.note } : x));
    tx.set(ref, { continuityWarnings: warnings, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(col.projects().doc(p.projectId).collection('shots').doc(p.shotId), { continuityStatus: { status: s.approvedState ? s.status : warnings.some((x) => x.status === 'open' && x.severity !== 'info') ? 'warning' : status === 'overridden' ? 'overridden' : 'planned', openWarnings: warnings.filter((x) => x.status === 'open' && x.severity !== 'info').length, updatedAt: Date.now() } }, { merge: true });
    return { warning: w, status, sceneId: s.sceneId };
  });
  // Overriding a line crossing is recorded on the scene's axis as a director override.
  if (result.warning.kind === 'axis_crossing' && result.sceneId && result.status === 'overridden') {
    await col.sub(p.projectId, 'cameraAxes').doc(result.sceneId).set({ sceneId: result.sceneId, crossings: FieldValue.arrayUnion({ shotId: p.shotId, reason: 'override', note: p.note.slice(0, 300), at: Date.now() }), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  return { status: result.status };
}

// ---------------------------------------------------------------------------
// Editorial helpers: neutral shots and coverage
// ---------------------------------------------------------------------------

export async function insertNeutralShot(owner: Owner, p: Payload<'insertNeutralShot'>) {
  await ownedProject(owner.uid, p.projectId);
  const shotsCol = col.projects().doc(p.projectId).collection('shots');
  const afterSnap = await shotsCol.doc(p.afterShotId).get();
  if (!afterSnap.exists) throw new HttpsError('not-found', 'Shot not found.');
  const after = afterSnap.data() as ShotDoc;
  const nextSnap = await shotsCol.where('order', '>', after.order).orderBy('order', 'asc').limit(1).get();
  const order = nextSnap.empty ? after.order + 1 : (after.order + Number(nextSnap.docs[0]!.get('order'))) / 2;
  const subject = after.refs.characterIds[0] ?? null;
  const names = subject ? (await col.projects().doc(p.projectId).collection('characters').doc(subject).get()).get('name') : 'the character';
  const kinds = {
    head_on: { title: 'Neutral head-on', framing: 'Medium wide shot', move: 'Static, locked-off camera', action: `${names} walks straight toward the camera along the line of travel, centred in frame, and exits past the lens.`, note: 'Neutral shot on the line of action: it lets the next shot reverse screen direction without confusing the audience.' },
    tail_away: { title: 'Neutral tail-away', framing: 'Medium wide shot', move: 'Static, locked-off camera', action: `${names} walks straight away from the camera along the line of travel, centred in frame.`, note: 'Neutral shot on the line of action (tail-away): bridges a change of screen direction.' },
    cutaway: { title: 'Cutaway', framing: 'Insert shot', move: 'Slow push-in', action: 'A detail of the setting that fits the moment; no one speaks.', note: 'Cutaway that separates two shots whose screen direction or axis differ.' },
  }[p.kind];
  const ref = shotsCol.doc();
  const { createdAt: _created, updatedAt: _updated, ...afterFields } = after;
  void _created;
  void _updated;
  const shot: Omit<ShotDoc, 'id' | 'createdAt' | 'updatedAt'> = {
    ...afterFields,
    order,
    number: after.number ? `${after.number}N` : '',
    title: kinds.title,
    description: kinds.action,
    directions: { ...EMPTY_DIRECTIONS, ...after.directions, framing: kinds.framing, cameraMovement: kinds.move, action: kinds.action, dialogue: [] },
    promptOverride: null,
    durationSec: 4,
    status: 'planned',
    selectedTakeId: null,
    approvedTakeId: null,
    takeCount: 0,
    notes: kinds.note,
    production: null,
    continuity: { ...(after.continuity ?? { characters: {}, propIds: [], propEvents: [], environment: {}, screenIds: [], axisCrossing: null, directionChange: null, startFromPreviousFrame: false, intentionalLook: '', notes: '' }), propEvents: [], directionChange: null, axisCrossing: { reason: 'neutral_shot', note: kinds.note } },
    continuityStatus: null,
  };
  await ref.set({ ...shot, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  // Camera on the line of action for head-on / tail-away.
  const blocking = await col.sub(p.projectId, 'blockingPlans').doc(p.afterShotId).get();
  if (blocking.exists && p.kind !== 'cutaway') {
    const b = blocking.data() as { entities: { refId: string | null; position: { x: number; y: number }; path: { x: number; y: number }[] }[] };
    const mover = b.entities.find((e) => e.refId === subject && e.path.length) ?? b.entities.find((e) => e.path.length);
    if (mover) {
      const a = mover.position;
      const z = mover.path[mover.path.length - 1]!;
      const dir = Math.atan2(z.x - a.x, -(z.y - a.y));
      const deg = ((dir * 180) / Math.PI + 360) % 360;
      const cam = p.kind === 'head_on' ? { x: z.x + Math.sin(dir) * 0.12, y: z.y - Math.cos(dir) * 0.12, directionDeg: (deg + 180) % 360 } : { x: a.x - Math.sin(dir) * 0.12, y: a.y + Math.cos(dir) * 0.12, directionDeg: deg };
      await col.sub(p.projectId, 'blockingPlans').doc(ref.id).set({ ...(blocking.data() as object), shotId: ref.id, camera: { position: { x: Math.min(0.98, Math.max(0.02, cam.x)), y: Math.min(0.98, Math.max(0.02, cam.y)) }, directionDeg: cam.directionDeg, lensMm: 35, height: 'eye', endPosition: null }, notes: kinds.note, updatedAt: FieldValue.serverTimestamp() });
    }
  }
  return { shotId: ref.id };
}

export async function coverageApply(owner: Owner, p: Payload<'coverageApply'>) {
  await ownedProject(owner.uid, p.projectId);
  const accepted = p.suggestions.filter((s) => s.accepted);
  if (!accepted.length) throw new HttpsError('invalid-argument', 'Accept at least one suggestion.');
  const shotsCol = col.projects().doc(p.projectId).collection('shots');
  const master = p.masterShotId ? await shotsCol.doc(p.masterShotId).get() : null;
  const masterShot = master?.exists ? (master.data() as ShotDoc) : null;
  const masterBlocking = p.masterShotId ? await col.sub(p.projectId, 'blockingPlans').doc(p.masterShotId).get() : null;
  const axis = p.sceneId ? ((await col.sub(p.projectId, 'cameraAxes').doc(p.sceneId).get()).data() as CameraAxisDoc | undefined) : undefined;
  const scene = p.sceneId ? await col.projects().doc(p.projectId).collection('scenes').doc(p.sceneId).get() : null;
  const inScene = p.sceneId ? await shotsCol.where('sceneId', '==', p.sceneId).get() : null;
  let order = masterShot ? masterShot.order : inScene && !inScene.empty ? Math.max(...inScene.docs.map((d) => Number(d.get('order') ?? 0))) : Date.now() / 1e9;
  const allDialogue = masterShot?.directions.dialogue ?? [];
  const batch = db.batch();
  const ids: string[] = [];
  for (const s of accepted) {
    const ref = shotsCol.doc();
    ids.push(ref.id);
    order += 0.01;
    const dialogue = s.dialogueLines.map((i) => allDialogue[i]).filter((x): x is { character: string; line: string } => Boolean(x));
    const base: Omit<ShotDoc, 'id'> = {
      sceneId: p.sceneId,
      sectionId: null,
      order,
      number: '',
      title: `${s.type.replace(/_/g, ' ')}${s.description ? ` — ${s.description.slice(0, 60)}` : ''}`,
      description: s.description,
      directions: { ...EMPTY_DIRECTIONS, ...(masterShot?.directions ?? {}), framing: s.framing, lens: s.lens, cameraMovement: s.cameraMovement, action: s.action || s.description, dialogue },
      promptOverride: null,
      durationSec: Math.max(VIDEO_CAPABILITIES.durationSec.min, Math.min(VIDEO_CAPABILITIES.durationSec.max, Math.round(s.durationSec))),
      aspectRatio: masterShot?.aspectRatio ?? '16:9',
      resolution: masterShot?.resolution ?? VIDEO_CAPABILITIES.defaultResolution,
      refs: { characterIds: s.subjectIds.length ? s.subjectIds : masterShot?.refs.characterIds ?? [], locationIds: masterShot?.refs.locationIds ?? (scene?.get('locationId') ? [String(scene.get('locationId'))] : []), elementIds: masterShot?.refs.elementIds ?? [], assetIds: [], firstFrameAssetId: null, lastFrameAssetId: null, storyboardAssetId: null },
      lockRefs: true,
      status: 'planned',
      selectedTakeId: null,
      approvedTakeId: null,
      timing: null,
      takeCount: 0,
      notes: `Coverage (${s.priority}): ${s.rationale}`,
      production: null,
      continuity: masterShot?.continuity ? { ...masterShot.continuity, propEvents: [] } : null,
    };
    batch.set(ref, { ...base, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    const plan = coverageBlocking(s, masterBlocking?.exists ? (masterBlocking.data() as never) : null, axis?.establishedSide ?? 'right', ref.id);
    if (plan.entities.length) batch.set(col.sub(p.projectId, 'blockingPlans').doc(ref.id), { ...plan, updatedAt: FieldValue.serverTimestamp() });
  }
  await batch.commit();
  return { shotIds: ids };
}

// ---------------------------------------------------------------------------
// Overview, credits metadata, cancelling queued work
// ---------------------------------------------------------------------------

export async function continuityOverview(owner: Owner, p: Payload<'continuityOverview'>) {
  await ownedProject(owner.uid, p.projectId);
  const [snaps, props, chars] = await Promise.all([col.sub(p.projectId, 'continuitySnapshots').orderBy('order', 'asc').get(), col.sub(p.projectId, 'propStates').orderBy('order', 'asc').get(), col.sub(p.projectId, 'characterStates').orderBy('order', 'asc').get()]);
  const snapshots = snaps.docs.map((d) => ({ ...(d.data() as ContinuitySnapshotDoc), id: d.id }));
  // Prop history from every snapshot (approved where available, otherwise planned and marked so).
  const propTimeline: Record<string, { shotId: string; order: number; approved: boolean; state: unknown }[]> = {};
  for (const s of snapshots) {
    const state = s.approvedState ?? s.plannedState;
    for (const [pid, ps] of Object.entries(state.props)) (propTimeline[pid] ??= []).push({ shotId: s.shotId, order: s.order, approved: Boolean(s.approvedState), state: ps });
  }
  return { snapshots, propTimeline, propRecords: props.size, characterRecords: chars.size };
}

export async function creditsMetadata(owner: Owner, p: Payload<'creditsMetadata'>): Promise<CreditMetadata> {
  const project = await ownedProject(owner.uid, p.projectId);
  const [chars, songs, scores, assets] = await Promise.all([
    col.projects().doc(p.projectId).collection('characters').get(),
    col.songs(p.projectId).get(),
    col.scores(p.projectId).get(),
    col.assets().where('ownerUid', '==', owner.uid).where('projectId', '==', p.projectId).get(),
  ]);
  const byModel = new Map<string, number>();
  let generated = 0;
  for (const a of assets.docs) {
    const m = a.get('generation.modelId') as string | undefined;
    if (!m || a.get('source') === 'render') continue;
    generated++;
    for (const id of m.split(',').map((x) => x.trim()).filter(Boolean)) byModel.set(id, (byModel.get(id) ?? 0) + 1);
  }
  const displayName = (id: string) => Object.values(MODEL_REGISTRY).find((m) => m.id === id)?.displayName ?? id;
  const credits = project.credits ?? { writer: [], director: [], producer: [], editors: [], brand: 'Indigen World' };
  return {
    title: project.title,
    writer: credits.writer,
    director: credits.director,
    producer: credits.producer,
    editors: credits.editors,
    performers: chars.docs.map((d) => ({ character: String(d.get('name') ?? ''), performer: String(d.get('bible.performer') ?? '') })),
    voices: chars.docs.filter((d) => d.get('voice')).map((d) => ({ character: String(d.get('name') ?? ''), voice: String(d.get('bible.voiceProfile') || '') })),
    music: songs.docs.map((d) => {
      const s = d.data() as SongDoc;
      return { title: s.title, artist: s.artist, generatedBy: s.generation ? displayName(s.generation.modelId) : null };
    }),
    score: scores.empty ? null : { title: String(scores.docs[0]!.get('title') ?? 'Score'), generatedBy: (scores.docs[0]!.get('movements') as { assetId?: string | null }[] | undefined)?.some((m) => m.assetId) ? displayName(MODEL_REGISTRY.music.id) : null },
    models: [...byModel.entries()].map(([modelId, n]) => ({ modelId, displayName: displayName(modelId), assets: n })).sort((a, b) => b.assets - a.assets),
    generatedAssets: generated,
    productionDate: new Date().toISOString().slice(0, 10),
    brand: credits.brand || 'Indigen World',
  };
}

export async function cancelQueued(owner: Owner, p: Payload<'cancelQueued'>) {
  let q = col.jobs().where('ownerUid', '==', owner.uid).where('status', '==', 'queued');
  if (p.projectId) q = q.where('projectId', '==', p.projectId);
  const snap = await q.get();
  let cancelled = 0;
  for (const d of snap.docs) {
    await d.ref.update({ cancelRequested: true, updatedAt: FieldValue.serverTimestamp() });
    await cancelJobDoc({ id: d.id, ownerUid: owner.uid }, 'Cancelled with the rest of the queue — no charge');
    cancelled++;
  }
  // Productions that have not started paying for anything yet stop too.
  let prodQ = col.productions().where('ownerUid', '==', owner.uid).where('status', '==', 'planning');
  if (p.projectId) prodQ = prodQ.where('projectId', '==', p.projectId);
  const prods = await prodQ.get();
  for (const d of prods.docs) await d.ref.set({ status: 'cancelled', waitingOn: [], stageMessage: 'Cancelled with the queue', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  const running = await col.jobs().where('ownerUid', '==', owner.uid).where('status', 'in', [...ACTIVE_STATUSES]).get();
  return { cancelled, productions: prods.size, stillRunning: running.size };
}
