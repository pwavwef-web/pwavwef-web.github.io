import { HttpsError } from 'firebase-functions/v2/https';
import {
  ACTIVE_PRODUCTION_STATUSES,
  chooseRepair,
  estimateSpeechSeconds,
  qualitySettings,
  REPAIR_LABELS,
  type ApiRequest,
  type CharacterDoc,
  type DialogueAudioState,
  type ElementDoc,
  type ExpectedScene,
  type LocationDoc,
  type ModelAvailability,
  type ProductionDoc,
  type ProductionVersionDoc,
  type ProjectDoc,
  type RepairDecision,
  type ShotDoc,
  type TakeDoc,
  type VideoJobRequest,
} from '@az-studio/shared';
import { MODEL_REGISTRY, MUSIC_MODEL_LIMITATION } from '../config/models';
import { col, db, FieldValue } from '../lib/firebase';
import { cancelJobDoc, enqueueProduction, getJob } from '../lib/jobs';
import type { Owner } from '../lib/owner';
import { approveContinuity, loadShotContinuity, planContinuity } from '../lib/continuity';
import { prepareJob } from '../lib/prepare';
import { CAPS, chooseVersion, continuable, estimateRepairUsd, loadProduction, loadReport, mirrorShot, planFor, productionEstimate, productionSpend, reevaluate, reinspectVersion, startRepair } from '../lib/production';
import { confirmationPolicy } from '../lib/submit';
import { assertRateLimit, assertWithinLimits, getSettings, spendSnapshot } from '../lib/usage';
import { geminiDeveloperApi, genai } from '../lib/vertex';
import { toJobError } from '../lib/errors';
import { cancelJob } from './actions';

type Payload<A extends ApiRequest['action']> = Extract<ApiRequest, { action: A }>['payload'];

const MUSIC_WORDS = /\b(music|song|singing|band|radio|drum|choir|melody|score)\b/i;

async function ownedProject(uid: string, projectId: string): Promise<ProjectDoc & { id: string }> {
  const snap = await col.projects().doc(projectId).get();
  if (!snap.exists || snap.get('ownerUid') !== uid) throw new HttpsError('not-found', 'Project not found.');
  return { id: snap.id, ...snap.data() } as ProjectDoc & { id: string };
}

/** What the scene must contain, read from the shot and its continuity bibles (never from the client). */
export async function buildExpected(project: ProjectDoc & { id: string }, shot: ShotDoc & { id: string }): Promise<ExpectedScene> {
  const p = col.projects().doc(project.id);
  const [chars, locs, els] = await Promise.all([
    shot.refs.characterIds.length ? db.getAll(...shot.refs.characterIds.map((id) => p.collection('characters').doc(id))) : Promise.resolve([]),
    shot.refs.locationIds.length ? db.getAll(...shot.refs.locationIds.map((id) => p.collection('locations').doc(id))) : Promise.resolve([]),
    shot.refs.elementIds.length ? db.getAll(...shot.refs.elementIds.map((id) => p.collection('elements').doc(id))) : Promise.resolve([]),
  ]);
  const characters = chars.filter((s) => s.exists).map((s) => ({ ...(s.data() as CharacterDoc), id: s.id }));
  const location = locs.filter((s) => s.exists).map((s) => s.data() as LocationDoc)[0] ?? null;
  const elements = els.filter((s) => s.exists).map((s) => s.data() as ElementDoc);
  const d = shot.directions;
  // Previous shot in story order with an approved take (for continuity).
  const prevSnap = await p.collection('shots').where('order', '<', shot.order).orderBy('order', 'desc').limit(5).get();
  let previousShot: ExpectedScene['previousShot'] = null;
  for (const s of prevSnap.docs) {
    const prev = s.data() as ShotDoc;
    if ((shot.sceneId && prev.sceneId !== shot.sceneId) || !prev.approvedTakeId) continue;
    const take = (await s.ref.collection('takes').doc(prev.approvedTakeId).get()).data() as TakeDoc | undefined;
    if (take?.assetId) previousShot = { shotId: s.id, title: prev.title, assetId: take.assetId };
    break;
  }
  const music: ExpectedScene['music'] = project.type === 'music_video' ? 'song_laid_later' : project.type === 'film' && !MUSIC_WORDS.test(d.ambientSound) ? 'no_background_music' : 'as_prompted';
  return {
    lines: d.dialogue.filter((l) => l.line.trim()).map((l, index) => ({ index, character: l.character.trim(), text: l.line.trim() })),
    action: d.action.trim(),
    description: shot.description.trim(),
    characters: characters.map((c) => ({ id: c.id, name: c.name, description: [c.appearance, c.wardrobe].filter(Boolean).join('; '), referenceAssetId: c.primaryRefAssetId ?? null })),
    location: location ? { name: location.name, description: [location.description, location.atmosphere].filter(Boolean).join('; '), timeOfDay: location.timeOfDay } : null,
    props: elements.map((e) => e.name),
    camera: [d.framing, d.cameraMovement, d.lens].filter(Boolean).join(', '),
    screenDirection: '',
    performance: d.performance,
    mood: d.mood,
    style: [d.style, project.styleBible?.visualStyle].filter(Boolean).join('; '),
    music,
    storyboardAssetId: shot.refs.storyboardAssetId,
    firstFrameAssetId: shot.refs.firstFrameAssetId,
    previousShot,
    language: project.language ?? null,
    projectType: project.type,
  };
}

async function prepareProduction(uid: string, p: Payload<'startProduction'> | Payload<'estimateProduction'>) {
  const project = await ownedProject(uid, p.projectId);
  const shotSnap = await col.projects().doc(p.projectId).collection('shots').doc(p.shotId).get();
  if (!shotSnap.exists) throw new HttpsError('not-found', 'Shot not found.');
  const shot = { id: shotSnap.id, ...shotSnap.data() } as ShotDoc & { id: string };
  if (p.job.projectId !== p.projectId || p.job.target?.kind !== 'shot' || p.job.target.id !== p.shotId || p.job.mode !== 'generate') throw new HttpsError('invalid-argument', 'The production request must generate this shot.');
  const requestedSec = Math.round(p.options.requestedSec);
  const request: VideoJobRequest = { ...p.job, durationSec: Math.min(CAPS.maxSec, Math.max(CAPS.minSec, requestedSec)), parentTakeId: null, chainId: null, parentTurnId: null };
  // Dry run: validates media, consent and parameters exactly as a real generation would.
  await prepareJob(uid, request, { skipContinuity: true });
  // Continuity preview: references, protected screens and plan warnings (the production re-plans at start).
  const cont = planContinuity(await loadShotContinuity(p.projectId, p.shotId), request.media, { lockRefs: shot.lockRefs });
  const continuity = {
    constraints: cont.compiled.protectedConstraints.length,
    preferences: cont.compiled.optionalPreferences.length,
    added: cont.compiled.added.length,
    dropped: cont.compiled.dropped.length,
    references: cont.inspectionRefs.length,
    screens: cont.expectations.screens.length,
    warnings: cont.planned.warnings.filter((w) => w.status === 'open' && w.severity !== 'info').map((w) => ({ kind: w.kind, severity: w.severity, message: w.message })),
  };
  const settings = qualitySettings({ ...(project.quality ?? {}), ...(p.options.settings ?? {}) });
  const expected = await buildExpected(project, shot);
  const lines = expected.lines.map((l) => ({ index: l.index, character: l.character, text: l.text, assetId: null as string | null, seconds: null as number | null, estimatedSec: estimateSpeechSeconds(l.text), voice: null as string | null }));
  let audio: DialogueAudioState = { mode: lines.length ? (settings.dialogueAudio === 'generate' ? 'generated' : 'estimated') : 'none', lines, jobId: null, note: lines.length ? (settings.dialogueAudio === 'generate' ? 'Guide audio will be generated and measured before the scene.' : 'Line lengths are estimated from the text.') : 'No dialogue in this shot.' };
  let review: { takeId: string; label: string; durationSec: number | null } | null = null;
  if (p.options.reviewTakeId) {
    // Review an existing take: nothing is generated first, so no guide audio is needed.
    const takeSnap = await shotSnap.ref.collection('takes').doc(p.options.reviewTakeId).get();
    const take = takeSnap.data() as TakeDoc | undefined;
    if (!take) throw new HttpsError('not-found', 'Take not found.');
    if (take.status !== 'completed' || !take.assetId) throw new HttpsError('failed-precondition', 'Only a finished take can be reviewed.');
    if (take.productionId) throw new HttpsError('failed-precondition', 'This take already belongs to a quality-controlled production — open it in the AI Director Review.');
    const asset = await col.assets().doc(take.assetId).get();
    if (!asset.exists || asset.get('ownerUid') !== uid || asset.get('kind') !== 'video') throw new HttpsError('failed-precondition', 'The take’s video is not available.');
    review = { takeId: takeSnap.id, label: take.label, durationSec: Number(asset.get('durationSec') ?? 0) || null };
    audio = { ...audio, mode: lines.length ? 'estimated' : 'none', note: lines.length ? 'Reviewing an existing take: its dialogue is measured by the inspection.' : audio.note };
  }
  if (!review && p.options.uploadedAudio.length && lines.length) {
    const snaps = await db.getAll(...p.options.uploadedAudio.map((u) => col.assets().doc(u.assetId)));
    for (const s of snaps) if (!s.exists || s.get('ownerUid') !== uid || s.get('kind') !== 'audio' || s.get('status') !== 'ready') throw new HttpsError('invalid-argument', 'Uploaded dialogue must be ready audio files you own.');
    audio = { ...audio, mode: 'uploaded', lines: lines.map((l) => ({ ...l, assetId: p.options.uploadedAudio.find((u) => u.lineIndex === l.index)?.assetId ?? null })), note: 'Line lengths are measured from your uploaded recordings.' };
  } else if (!review && p.options.identifyFromTakeId && lines.length) {
    const take = (await shotSnap.ref.collection('takes').doc(p.options.identifyFromTakeId).get()).data() as TakeDoc | undefined;
    const reportId = take?.quality?.reportId;
    if (!take?.productionId || !reportId) throw new HttpsError('failed-precondition', 'That take has not been inspected, so its dialogue timing is unknown.');
    const report = await loadReport({ id: take.productionId }, reportId);
    if (!report?.dialogue.applicable) throw new HttpsError('failed-precondition', 'That take has no measured dialogue.');
    audio = {
      ...audio,
      mode: 'identified',
      lines: lines.map((l) => {
        const m = report.dialogue.lines.find((x) => x.index === l.index);
        return { ...l, seconds: m?.start !== null && m?.end !== null && m?.complete ? +(m!.end! - m!.start!).toFixed(2) : null };
      }),
      note: `Line lengths measured from the dialogue in ${take.label}.`,
    };
  }
  const draft = { dialogueAudio: audio, expected, settings, request: { ...request, media: cont.compiled.media } as unknown as Record<string, unknown> };
  const plan = planFor(draft, requestedSec);
  const takes = review ? 1 : Math.max(1, Math.min(p.options.takes ?? 1, settings.maxTakesPerShot));
  const estimate = productionEstimate({ ...draft, plan }, plan, review ? { reviewSec: review.durationSec ?? requestedSec, references: continuity.references, screens: continuity.screens } : { takes, references: continuity.references, screens: continuity.screens });
  return { project, shot, expected, request, audio, settings, plan, estimate, review, takes: plan.segments.length === 1 ? takes : 1, continuity };
}

export async function estimateProduction(owner: Owner, p: Payload<'estimateProduction'>) {
  const x = await prepareProduction(owner.uid, p);
  const settings = await getSettings(owner.uid);
  const confirmation = confirmationPolicy(settings, x.review ? [] : [{ type: 'video.generate' }, ...(x.plan.segments.length > 1 ? [{ type: 'video.generate' as const }] : [])], x.estimate.usd);
  let limitProblem: string | null = null;
  try {
    assertWithinLimits(settings, await spendSnapshot(owner.uid), x.estimate.usd);
  } catch (e) {
    limitProblem = (e as Error).message;
  }
  return { plan: x.plan, estimate: x.estimate, confirmation, limitProblem, quality: x.settings, audioMode: x.audio.mode, repairBudgetUsd: Math.max(0, x.settings.repairCostCeilingUsd - x.estimate.usd), review: x.review, takes: x.takes, continuity: x.continuity };
}

export async function startProduction(owner: Owner, p: Payload<'startProduction'>) {
  const uid = owner.uid;
  await assertRateLimit(uid, 1);
  const x = await prepareProduction(uid, p);
  if (x.plan.blocked && !x.review) throw new HttpsError('failed-precondition', x.plan.blocked);
  const settings = await getSettings(uid);
  const confirmation = confirmationPolicy(settings, x.review ? [] : [{ type: 'video.generate' }, ...(x.plan.segments.length > 1 ? [{ type: 'video.generate' as const }] : [])], x.estimate.usd);
  if (confirmation.required && (p.confirmedUsd === null || p.confirmedUsd === undefined || p.confirmedUsd + 0.005 < x.estimate.usd)) {
    throw new HttpsError('failed-precondition', 'Confirm the estimated cost before starting this production.', { reason: 'confirmation_required', estimate: x.estimate, reasons: confirmation.reasons });
  }
  assertWithinLimits(settings, await spendSnapshot(uid), x.estimate.usd);
  const running = await col.productions().where('ownerUid', '==', uid).where('shotId', '==', p.shotId).where('status', 'in', [...ACTIVE_PRODUCTION_STATUSES]).limit(1).get();
  if (!running.empty) throw new HttpsError('failed-precondition', 'This shot is already being produced. Wait for it, or cancel it in the AI Director Review.');
  const docRef = col.productions().doc();
  const doc: Omit<ProductionDoc, 'id'> & { run: null; lock: null } = {
    ownerUid: uid,
    projectId: p.projectId,
    shotId: p.shotId,
    sceneId: x.shot.sceneId,
    title: `${x.shot.number ? `${x.shot.number} · ` : ''}${x.shot.title}`.slice(0, 160),
    status: 'planning',
    stage: 'plan',
    stageMessage: x.review
      ? `Reviewing existing take ${x.review.label}${x.review.durationSec ? ` (${x.review.durationSec} s)` : ''}; the scene needs about ${x.plan.requiredSec} s.`
      : `Planning: requested ${x.plan.requestedSec} s, needs about ${x.plan.requiredSec} s${x.audio.mode === 'generated' ? ' (estimate — measuring the dialogue next)' : ''}.`,
    settings: x.settings,
    expected: x.expected,
    request: x.request as unknown as Record<string, unknown>,
    dialogueAudio: x.audio,
    plan: x.plan,
    chain: { segmentIndex: 0, takeIds: [], assetIds: [] },
    waitingOn: [],
    versionCount: 0,
    currentVersionId: null,
    bestVersionId: null,
    approvedVersionId: null,
    repairCount: 0,
    repairs: [],
    pendingRepair: null,
    spentUsd: 0,
    estimateUsd: x.estimate.usd,
    failure: null,
    waivedCategories: [],
    approval: null,
    reviewTakeId: x.review?.takeId ?? null,
    continuity: null,
    takes: x.takes,
    comparison: null,
    run: null,
    lock: null,
  };
  await docRef.set({ ...doc, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  await docRef.collection('events').add({ at: Date.now(), stage: 'plan', status: 'planning', message: doc.stageMessage, detail: { estimateUsd: x.estimate.usd, strategy: x.plan.strategy }, createdAt: FieldValue.serverTimestamp() });
  await mirrorShot({ id: docRef.id, ...doc });
  if (!x.review) await col.projects().doc(p.projectId).collection('shots').doc(p.shotId).set({ status: 'generating', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await enqueueProduction(docRef.id, { delaySec: 0 });
  return { productionId: docRef.id, plan: x.plan, estimate: x.estimate, takes: x.takes, continuity: x.continuity };
}

// ---------------------------------------------------------------------------
// Director actions
// ---------------------------------------------------------------------------

async function ownedProduction(uid: string, id: string) {
  const p = await loadProduction(id);
  if (!p || p.ownerUid !== uid) throw new HttpsError('not-found', 'Production not found.');
  return p;
}

async function version(productionId: string, versionId: string): Promise<ProductionVersionDoc> {
  const snap = await col.productions().doc(productionId).collection('versions').doc(versionId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Version not found.');
  return { id: snap.id, ...snap.data() } as ProductionVersionDoc;
}

async function update(id: string, patch: Record<string, unknown>, message: string, p: { stage: string; status: string }) {
  await col.productions().doc(id).set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await col.productions().doc(id).collection('events').add({ at: Date.now(), stage: patch.stage ?? p.stage, status: patch.status ?? p.status, message, detail: {}, createdAt: FieldValue.serverTimestamp() });
  const fresh = await loadProduction(id);
  if (fresh) await mirrorShot(fresh, { overall: null, passed: null });
}

/** Approves a version that passes review (after any recorded waivers) and makes it the shot's take. */
async function approveVersion(uid: string, p: NonNullable<Awaited<ReturnType<typeof loadProduction>>>, v: ProductionVersionDoc, waived: string[], note: string, override: boolean) {
  const report = await loadReport(p, v.reportId);
  if (!report) throw new HttpsError('failed-precondition', 'This version has not been inspected yet. AZ Studio only approves inspected scenes.');
  const verdict = reevaluate(report, p, waived, v.plannedCuts, v.editorialCuts ?? []);
  if (!verdict.passed) {
    const open = verdict.problems.filter((x) => x.blocking).map((x) => x.description);
    throw new HttpsError('failed-precondition', `Version ${v.index} does not pass quality review (${verdict.overall}/100, threshold ${p.settings.minApprovalScore}). ${open.length ? `Open issues: ${open.slice(0, 4).join(' ')}` : verdict.reasons.join(' ')} Mark the issues as acceptable first if you want to use it anyway.`, { reason: 'quality_review_failed', problems: verdict.problems.filter((x) => x.blocking) });
  }
  if (!v.takeId) throw new HttpsError('failed-precondition', 'This version has no take to approve.');
  const shotRef = col.projects().doc(p.projectId).collection('shots').doc(p.shotId);
  const shot = (await shotRef.get()).data() as ShotDoc;
  const batch = db.batch();
  if (shot.approvedTakeId && shot.approvedTakeId !== v.takeId) batch.set(shotRef.collection('takes').doc(shot.approvedTakeId), { approved: false }, { merge: true });
  batch.set(shotRef.collection('takes').doc(v.takeId), { approved: true, quality: { verdict: 'passed', overall: verdict.overall, reportId: report.id } }, { merge: true });
  batch.set(shotRef, { approvedTakeId: v.takeId, selectedTakeId: v.takeId, status: 'approved', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  batch.set(col.productions().doc(p.id).collection('versions').doc(v.id), { verdict: 'passed', overall: verdict.overall, scores: verdict.scores }, { merge: true });
  batch.set(col.productions().doc(p.id), { status: 'approved', stage: 'render', approvedVersionId: v.id, currentVersionId: v.id, waivedCategories: waived, pendingRepair: null, approval: { at: Date.now(), versionId: v.id, override, note }, stageMessage: `Approved version ${v.index} (${verdict.overall}/100)${override ? ' with issues marked acceptable' : ''} — ready for the edit and render`, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await batch.commit();
  await col.productions().doc(p.id).collection('events').add({ at: Date.now(), stage: 'approve', status: 'approved', message: `Director approved version ${v.index}${override ? ` — accepted: ${waived.join(', ')}` : ''}${note ? ` (${note})` : ''}`, detail: { versionId: v.id, uid }, createdAt: FieldValue.serverTimestamp() });
  // Update continuity state: the approved take becomes canonical (states, props, axis, final frame).
  await approveContinuity(p.projectId, p.shotId, { versionId: v.id, productionId: p.id, waivedKinds: waived, takeAssetId: v.assetId, repaired: v.kind === 'repair', inspected: true, ownerUid: uid });
  await col.productions().doc(p.id).collection('events').add({ at: Date.now(), stage: 'update_continuity', status: 'approved', message: `Continuity state updated from version ${v.index}: character, prop and camera-axis records and the final frame for the next shot`, detail: { versionId: v.id }, createdAt: FieldValue.serverTimestamp() });
  const fresh = await loadProduction(p.id);
  if (fresh) await mirrorShot(fresh, { overall: verdict.overall, passed: true });
  return { status: 'approved', versionId: v.id, overall: verdict.overall };
}

export async function productionAction(owner: Owner, a: Payload<'productionAction'>) {
  const p = await ownedProduction(owner.uid, a.productionId);
  const vid = a.versionId ?? p.currentVersionId ?? p.bestVersionId;
  const busy = ACTIVE_PRODUCTION_STATUSES.includes(p.status);
  switch (a.action) {
    case 'approve': {
      if (!vid) throw new HttpsError('failed-precondition', 'There is no version to approve yet.');
      return approveVersion(owner.uid, p, await version(p.id, vid), p.waivedCategories, a.note ?? '', p.waivedCategories.length > 0);
    }
    case 'keep_original': {
      const first = (await col.productions().doc(p.id).collection('versions').where('index', '==', 1).limit(1).get()).docs[0];
      if (!first) throw new HttpsError('failed-precondition', 'There is no original version.');
      const v = { id: first.id, ...first.data() } as ProductionVersionDoc;
      const report = await loadReport(p, v.reportId);
      if (!report) throw new HttpsError('failed-precondition', 'The original version was never inspected.');
      // Keeping the original means explicitly accepting each of its open issues (recorded, never silent).
      const open = reevaluate(report, p, p.waivedCategories, v.plannedCuts, v.editorialCuts ?? []).problems.filter((x) => x.blocking).map((x) => x.category);
      const waived = [...new Set([...p.waivedCategories, ...open])];
      return approveVersion(owner.uid, p, v, waived, a.note || 'Director kept the original version', open.length > 0);
    }
    case 'waive':
    case 'unwaive': {
      if (!a.categories.length) throw new HttpsError('invalid-argument', 'Choose which issues to mark as acceptable.');
      const waived = a.action === 'waive' ? [...new Set([...p.waivedCategories, ...a.categories])] : p.waivedCategories.filter((c) => !a.categories.includes(c));
      let status = p.status;
      let passed: boolean | null = null;
      if (vid) {
        const v = await version(p.id, vid);
        const report = await loadReport(p, v.reportId);
        if (report) {
          const verdict = reevaluate(report, p, waived, v.plannedCuts, v.editorialCuts ?? []);
          passed = verdict.passed;
          await col.productions().doc(p.id).collection('versions').doc(v.id).set({ verdict: verdict.passed ? 'passed' : 'failed', overall: verdict.overall, scores: verdict.scores }, { merge: true });
          if (verdict.passed && (p.status === 'failed_review' || p.status === 'awaiting_review')) status = 'awaiting_review';
          if (!verdict.passed && p.status === 'awaiting_review' && !p.pendingRepair) status = 'failed_review';
        }
      }
      await update(p.id, { waivedCategories: waived, status, ...(passed ? { stage: 'approve', failure: null } : {}) }, a.action === 'waive' ? `Director marked as acceptable: ${a.categories.join(', ')}${a.note ? ` — ${a.note}` : ''}` : `Director withdrew acceptance of: ${a.categories.join(', ')}`, p);
      return { status, waivedCategories: waived, passed };
    }
    case 'cancel': {
      for (const jobId of p.waitingOn ?? []) {
        const job = await getJob(jobId);
        if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) continue;
        if (job.status === 'queued') await cancelJobDoc(job);
        else await cancelJob(owner, { jobId });
      }
      await update(p.id, { status: 'cancelled', waitingOn: [], stageMessage: 'Cancelled by the director', pendingRepair: null }, 'Cancelled by the director', p);
      return { status: 'cancelled' };
    }
    case 'dismiss_pending_repair': {
      if (!p.pendingRepair) return { status: p.status };
      await update(p.id, { pendingRepair: null, status: 'failed_review', failure: p.failure ?? { summary: 'The director declined the proposed repair.', failed: [], attempted: p.repairs.map((r) => REPAIR_LABELS[r.type]), strongestVersionId: p.bestVersionId, nextAttemptUsd: p.pendingRepair.estimateUsd, options: [] } }, `Director declined: ${REPAIR_LABELS[p.pendingRepair.type]}`, p);
      return { status: 'failed_review' };
    }
    case 'reinspect': {
      if (busy) throw new HttpsError('failed-precondition', 'Wait for the current step to finish.');
      if (!vid) throw new HttpsError('failed-precondition', 'There is no version to inspect.');
      await reinspectVersion(p.id, vid);
      return { status: 'inspecting' };
    }
    case 'choose_version': {
      if (busy) throw new HttpsError('failed-precondition', 'Wait for the current step to finish.');
      if (!a.versionId) throw new HttpsError('invalid-argument', 'Choose a version.');
      return chooseVersion(p.id, a.versionId);
    }
    default:
      break;
  }

  // Repairs and regenerations requested by the director.
  if (busy) throw new HttpsError('failed-precondition', 'Wait for the current step to finish, or cancel it.');
  if (p.status === 'cancelled') throw new HttpsError('failed-precondition', 'This production was cancelled — start a new one from the shot.');
  if (a.action === 'split' && p.plan?.strategy === 'split_shots') return splitIntoShots(owner.uid, p);
  if (!vid) throw new HttpsError('failed-precondition', 'There is no version to work from yet.');
  const v = await version(p.id, vid);
  const report = await loadReport(p, v.reportId);
  let decision: RepairDecision | null = null;
  if (a.action === 'approve_pending_repair') {
    if (!p.pendingRepair) throw new HttpsError('failed-precondition', 'There is no proposed repair waiting for approval.');
    const { estimateUsd: _e, waitingFor: _w, forVersionId: _f, categories: _c, ...rest } = p.pendingRepair;
    decision = rest;
  } else if (a.action === 'repair') {
    if (!report) throw new HttpsError('failed-precondition', 'Inspect this version first.');
    decision = p.pendingRepair && p.pendingRepair.forVersionId === v.id ? (({ estimateUsd: _e, waitingFor: _w, forVersionId: _f, categories: _c, ...rest }) => rest)(p.pendingRepair) : chooseRepair({ compositableScreens: p.continuity?.compositeScreenIds ?? [], regions: report.problems.filter((x) => x.region).map((x) => ({ problemId: x.id, box: x.region! })), problems: report.problems, dialogue: report.dialogue, review: report.review, version: { durationSec: v.durationSec ?? 0, continuable: continuable(v), chainSec: v.chainSec }, expected: { lines: p.expected.lines, action: p.expected.action }, plan: p.plan, caps: CAPS, previous: p.repairs.map((r) => ({ type: r.type, categories: r.categories as never })) });
    if (!decision) throw new HttpsError('failed-precondition', 'No automatic repair applies to this version’s issues. Try Regenerate with new direction.');
  } else if (a.action === 'extend') {
    const secs = a.extendSec ?? 4;
    decision = { type: 'extend_scene', reason: 'The director asked to extend the scene.', instruction: a.instruction?.trim() || `Continue this exact scene from its final frame for about ${secs} seconds so the moment completes naturally; hold on the characters at the end. Do not restart or repeat anything. Keep the same characters, wardrobe, location, lighting and emotional state.`, durationSec: secs, sectionStartSec: null, sectionEndSec: null, keepAudio: false };
  } else if (a.action === 'regenerate') {
    decision = { type: 'regenerate', reason: 'The director asked for a new take.', instruction: a.instruction?.trim() || 'Deliver every scripted word exactly, at a natural pace, and let the action complete fully on screen.', durationSec: Math.min(CAPS.maxSec, Math.max(CAPS.minSec, p.plan?.plannedSec && p.plan.segments.length === 1 ? p.plan.plannedSec : Math.ceil(v.durationSec ?? 8))), sectionStartSec: null, sectionEndSec: null, keepAudio: false };
  } else if (a.action === 'split') {
    decision = { type: 'split_into_shots', reason: 'The director asked to split the scene into connected shots.', instruction: a.instruction?.trim() || '', durationSec: null, sectionStartSec: null, sectionEndSec: null, keepAudio: false };
  } else if (a.action === 'color_match') {
    if (!p.continuity?.colourRefAssetId) throw new HttpsError('failed-precondition', 'There is no colour reference for this shot yet: approve the previous shot of the scene first, or colour-match from the Colour Director with a reference still.');
    decision = { type: 'color_match', reason: 'The director asked to colour-match the shot to the previous shot of the scene.', instruction: 'Colour-match the shot to the approved reference.', durationSec: null, sectionStartSec: null, sectionEndSec: null, keepAudio: true };
  } else if (a.action === 'screen_composite') {
    const screenIds = p.continuity?.compositeScreenIds ?? [];
    if (!screenIds.length) throw new HttpsError('failed-precondition', 'This shot has no protected screen with approved content. Add one in the Continuity panel (Protected screens) first.');
    decision = { type: 'screen_composite', reason: 'The director asked to composite the approved screen content.', instruction: 'Composite the approved content onto the protected surface.', durationSec: null, sectionStartSec: null, sectionEndSec: null, keepAudio: true, data: { screenIds } };
  } else if (a.action === 'correct_blocking') {
    decision = { type: 'correct_blocking', reason: 'The director asked to correct the blocking from a blocking frame.', instruction: a.instruction?.trim() || 'Every character in their planned position with their face visible; nobody blocks anyone; correct eyelines and depth order.', durationSec: Math.min(CAPS.maxSec, Math.max(CAPS.minSec, Math.ceil(v.durationSec ?? 8))), sectionStartSec: null, sectionEndSec: null, keepAudio: false };
  } else if (a.action === 'regenerate_with_references') {
    decision = { type: 'regenerate_with_references', reason: 'The director asked to regenerate with every approved reference.', instruction: a.instruction?.trim() || 'Match the approved references exactly — faces, age, hair, costumes, accessories, props and the set.', durationSec: Math.min(CAPS.maxSec, Math.max(CAPS.minSec, Math.ceil(v.durationSec ?? 8))), sectionStartSec: null, sectionEndSec: null, keepAudio: false };
  }
  if (!decision) throw new HttpsError('invalid-argument', 'Unknown action.');
  const estimateUsd = Math.round(estimateRepairUsd(p, v, decision) * 100) / 100;
  const spent = await productionSpend(p.id);
  if (spent + estimateUsd > p.settings.repairCostCeilingUsd && (a.confirmedUsd === null || a.confirmedUsd === undefined || a.confirmedUsd + 0.005 < estimateUsd)) {
    throw new HttpsError('failed-precondition', `This would take the scene past its $${p.settings.repairCostCeilingUsd.toFixed(2)} cost ceiling (spent ≈ $${spent.toFixed(2)}, this ≈ $${estimateUsd.toFixed(2)}). Confirm to continue.`, { reason: 'confirmation_required', estimate: { usd: estimateUsd, basis: 'published_rate', confidence: 'medium', breakdown: [{ label: REPAIR_LABELS[decision.type], usd: estimateUsd }], notes: ['Director-approved spend above the scene’s repair ceiling.'], pricingVersion: '' }, reasons: ['Above the scene cost ceiling'] });
  }
  assertWithinLimits(await getSettings(owner.uid), await spendSnapshot(owner.uid), estimateUsd);
  const categories = report ? [...new Set(report.problems.filter((x) => x.blocking).map((x) => x.category))] : [];
  await startRepair({ ...p, spentUsd: spent }, v, decision, estimateUsd, categories, true);
  return { status: 'repairing', repair: decision.type, estimateUsd };
}

/** Splits an over-long scene into separate shots at sentence boundaries (one shot per planned part). */
async function splitIntoShots(uid: string, p: NonNullable<Awaited<ReturnType<typeof loadProduction>>>) {
  const plan = p.plan!;
  const shotRef = col.projects().doc(p.projectId).collection('shots').doc(p.shotId);
  const shot = (await shotRef.get()).data() as ShotDoc;
  const batch = db.batch();
  const created: string[] = [];
  plan.segments.forEach((seg, i) => {
    const lines = seg.units.map((u) => ({ character: u.character, line: u.text }));
    const directions = { ...shot.directions, dialogue: lines, ...(i > 0 && seg.camera ? { framing: seg.camera } : {}) };
    if (i === 0) {
      batch.set(shotRef, { directions, durationSec: seg.durationSec, promptOverride: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return;
    }
    const ref = col.projects().doc(p.projectId).collection('shots').doc();
    created.push(ref.id);
    batch.set(ref, { ...shot, title: `${shot.title} (${i + 1}/${plan.segments.length})`, number: shot.number ? `${shot.number}.${i + 1}` : '', order: shot.order + i * 0.01, directions, durationSec: seg.durationSec, promptOverride: null, status: 'planned', selectedTakeId: null, approvedTakeId: null, takeCount: 0, production: null, notes: `Split from “${shot.title}” — continues the same scene. ${seg.camera}`, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  });
  batch.set(col.productions().doc(p.id), { status: 'cancelled', stageMessage: `Split into ${plan.segments.length} shots at sentence boundaries — produce each shot separately`, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await batch.commit();
  await col.productions().doc(p.id).collection('events').add({ at: Date.now(), stage: p.stage, status: 'cancelled', message: `Split into ${plan.segments.length} shots`, detail: { created, uid }, createdAt: FieldValue.serverTimestamp() });
  return { status: 'split', shotIds: [p.shotId, ...created] };
}

// ---------------------------------------------------------------------------
// Live model availability
// ---------------------------------------------------------------------------

const STATUS_TTL_MS = 6 * 60 * 60 * 1000;

async function probeRole(role: keyof typeof MODEL_REGISTRY): Promise<ModelAvailability> {
  const m = MODEL_REGISTRY[role];
  const base = { role, modelId: m.id, checkedAt: Date.now() };
  try {
    await genai().models.get({ model: m.id });
    return { ...base, status: 'available', detail: `Listed for this project on Vertex AI (${m.location}).` };
  } catch (e) {
    const err = toJobError(e);
    if (err.code === 'not_found') {
      if (role === 'music' && await geminiDeveloperApi()) {
        return { ...base, status: 'available', detail: 'Lyria 3.5 is configured on the Gemini Developer API with a server-side key in Secret Manager.' };
      }
      return { ...base, status: 'unavailable', detail: role === 'music' ? MUSIC_MODEL_LIMITATION : `${m.id} is not available on Vertex AI for this project (${(err.details ?? err.message).slice(0, 200)}).` };
    }
    return { ...base, status: 'unknown', detail: err.message };
  }
}

export async function modelStatus(_owner: Owner, p: Payload<'modelStatus'>) {
  const ref = col.runtime().doc('modelStatus');
  const cached = await ref.get();
  const at = Number(cached.get('checkedAt') ?? 0);
  if (!p.refresh && cached.exists && Date.now() - at < STATUS_TTL_MS) {
    const models = cached.get('models') as ModelAvailability[];
    const music = models.find((m) => m.role === 'music');
    const keyConfigured = Boolean(await geminiDeveloperApi());
    const cachedDeveloper = music?.status === 'available' && music.detail.includes('Gemini Developer API');
    if ((music?.status === 'unavailable' && keyConfigured) || (cachedDeveloper && !keyConfigured)) {
      const refreshed = await probeRole('music');
      const updated = models.map((m) => m.role === 'music' ? refreshed : m);
      const checkedAt = Date.now();
      await ref.set({ models: updated, checkedAt });
      return { models: updated, checkedAt };
    }
    return { models, checkedAt: at };
  }
  const roles = Object.keys(MODEL_REGISTRY) as (keyof typeof MODEL_REGISTRY)[];
  const models = await Promise.all(roles.map((r) => probeRole(r)));
  await ref.set({ models, checkedAt: Date.now() });
  return { models, checkedAt: Date.now() };
}
