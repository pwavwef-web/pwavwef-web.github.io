import { describe, expect, it } from 'vitest';
import { emptyCharacterBible, EMPTY_COLOUR, type CharacterStateDoc, type SetBibleDoc } from '@az-studio/shared';
import * as continuityApi from '../../functions/src/api/continuity';
import { col, FieldValue } from '../../functions/src/lib/firebase';
import { allProblems, approve, camera, character, generateImage, outsideTake, produce, saveBlocking, shot, snapshot, videoJob, type Produced, type ShotSpec } from './continuity-kit';
import { payload, qaProject, reporter, studioOwner, submitJobs, waitForJob } from './harness';

const AMA = { id: 'ama', name: 'AMA', description: 'Ghanaian woman in her early thirties, short natural black hair, a small scar above her left eyebrow, mustard-yellow kaba blouse with an indigo pattern and a dark wrap skirt' };
const ROOM = { name: 'Clinic waiting room', description: 'A small rural clinic waiting room with pale-green plaster walls, a wooden door on the north wall, a louvred window on the east wall, a long wooden bench along the west wall and a reception desk in the north-east corner; a round wall clock hangs above the door' };
const SET_CATEGORIES = ['background_drift', 'door_window_moved', 'furniture_moved', 'wall_colour', 'layout_reversed', 'architecture_mutation', 'location_replaced', 'location', 'accidental_scene_change', 'lighting_change', 'duplicate_object'];
const IDENTITY_CATEGORIES = ['character_identity', 'face_change', 'wrong_age', 'costume', 'hairstyle', 'missing_accessory', 'character_merge'];

describe('Acceptance 8 — recurring location and recurring character', () => {
  it('keeps a locked set and a locked character across angles, catches deliberate background drift and a wrong face, and records character state only on approval', async () => {
    const { log, save } = reporter('08-set-and-character');
    const owner = await studioOwner();
    const projectId = await qaProject(owner, 'set-char', 'Recurring location and character', 'film');
    const results: Record<string, unknown> = {};

    // Visual Bible (approved) — the look every shot inherits.
    await continuityApi.continuitySave(owner, payload('continuitySave', { projectId, collection: 'visualBibles', data: { entries: { overallStyle: { value: 'Naturalistic documentary realism, soft morning daylight, gentle handheld feel', level: 'locked', sceneIds: [] }, colourPalette: { value: 'pale greens, mustard yellow, indigo, warm wood', level: 'preferred', sceneIds: [] } }, referenceAssetIds: [], lookbookAssetIds: [], colour: { ...EMPTY_COLOUR } } }));
    await continuityApi.bibleApprove(owner, payload('bibleApprove', { projectId, kind: 'visual', id: 'main', approve: true, views: [] }));

    // Character Bible with an approved identity reference (locked).
    await col.projects().doc(projectId).collection('characters').doc(AMA.id).set({ name: AMA.name, role: 'Lead', description: '', appearance: AMA.description, wardrobe: 'mustard-yellow kaba blouse with an indigo pattern, dark wrap skirt', personality: '', voice: '', referenceAssetIds: [], primaryRefAssetId: null, turnaroundAssetId: null, locked: false, realPerson: false, consentConfirmed: false, createdAt: FieldValue.serverTimestamp() });
    const face = await generateImage(owner, projectId, log, { title: 'AMA front', characterIds: [AMA.id], prompt: `Front view portrait facing the camera, neutral expression, even soft light, plain light-grey background. ${AMA.description}.` });
    await col.projects().doc(projectId).collection('characters').doc(AMA.id).set({ referenceAssetIds: [face], primaryRefAssetId: face }, { merge: true });
    const { approvedAt: _a, ...bible } = { ...emptyCharacterBible(), refs: { front: face, profile: null, threeQuarter: null, fullBody: null }, approvedRefIds: [face], height: '1.68 m', build: 'slim', skinTone: 'deep brown', hair: 'short natural black hair', ageRange: '30–35', features: 'small scar above the left eyebrow', costumes: [{ id: 'day', name: 'Clinic day', description: 'mustard-yellow kaba blouse with an indigo pattern, dark wrap skirt', assetId: null }], defaultCostumeId: 'day', protectedIdentity: ['small scar above the left eyebrow', 'short natural black hair'] };
    void _a;
    const locked = await continuityApi.characterBibleSave(owner, payload('characterBibleSave', { projectId, characterId: AMA.id, bible, approve: true }));
    expect(locked.approvedAt).toBeTruthy();

    // Set Bible with a floor plan; Nano Banana Pro proposes the reference pack; the director approves it.
    await col.projects().doc(projectId).collection('locations').doc('room').set({ name: ROOM.name, description: ROOM.description, timeOfDay: 'morning', palette: 'pale green, warm wood', atmosphere: 'quiet', referenceAssetIds: [], primaryRefAssetId: null, locked: false, createdAt: FieldValue.serverTimestamp() });
    const plan = [
      { id: 'door', kind: 'door', label: 'wooden door', x: 0.45, y: 0.02, w: 0.1, h: 0.03, rotation: 0, locked: true },
      { id: 'window', kind: 'window', label: 'louvred window', x: 0.95, y: 0.4, w: 0.03, h: 0.18, rotation: 0, locked: true },
      { id: 'bench', kind: 'furniture', label: 'long wooden bench', x: 0.05, y: 0.3, w: 0.08, h: 0.4, rotation: 0, locked: true },
      { id: 'desk', kind: 'furniture', label: 'reception desk', x: 0.72, y: 0.06, w: 0.22, h: 0.1, rotation: 0, locked: true },
      { id: 'clock', kind: 'object', label: 'round wall clock', x: 0.47, y: 0.0, w: 0.06, h: 0.02, rotation: 0, locked: true },
    ];
    await continuityApi.continuitySave(owner, payload('continuitySave', { projectId, collection: 'setBibles', data: { locationId: 'room', planSizeM: 6, views: { wide: null, front: null, rear: null, left: null, right: null }, detailAssetIds: [], floorPlanAssetId: null, floorPlan: plan, wallColours: 'pale-green plaster walls', materials: 'lime plaster, worn wooden bench and desk, concrete floor', backgroundObjects: ['round wall clock above the door'], lighting: { keyDirection: 'from the east window', colour: 'soft morning daylight', notes: '' }, timeOfDayVariants: [], weatherVariants: [], protectedFeatures: ['wooden door on the north wall', 'louvred window on the east wall'], readableSigns: [], mayChange: ['people waiting on the bench'], neverChange: ['pale-green wall colour', 'door and window positions', 'bench along the west wall'], population: 'empty apart from the characters' } }));
    const [packJob] = await submitJobs(owner, [{ type: 'reference.pack', projectId, locationId: 'room', views: ['wide', 'front', 'left'], imageSize: '1K', aspectRatio: '16:9' }], 'QA · reference pack');
    const pack = await waitForJob(packJob!, log, 30 * 60_000);
    expect(pack.status, pack.error?.message).toBe('completed');
    const proposed = (await col.projects().doc(projectId).collection('setBibles').doc('room').get()).data() as SetBibleDoc;
    log(`reference pack: ${JSON.stringify(proposed.views)} · status ${proposed.canonical.status}`);
    expect(proposed.canonical.status).toBe('pending_approval');
    expect(proposed.views.wide && proposed.views.front && proposed.views.left).toBeTruthy();
    await continuityApi.bibleApprove(owner, payload('bibleApprove', { projectId, kind: 'set', id: 'room', approve: true, views: ['wide', 'front', 'left'] }));
    results.set = { views: proposed.views, packCostUsd: pack.usageUsd };

    // Scene and five shots of AMA; the first three are the same room from different angles.
    await col.projects().doc(projectId).collection('scenes').doc('waiting').set({ sequenceId: null, order: 1, number: '1', heading: 'INT. CLINIC WAITING ROOM - MORNING', intExt: 'INT', locationName: ROOM.name, locationId: 'room', timeOfDay: 'morning', summary: 'Ama waits for news.', characterIds: [AMA.id], props: [], costumes: [], mood: 'anxious', dialoguePlan: '', audioPlan: '', estimatedDurationSec: 30, status: 'draft', notes: '' });
    const base = { characterIds: [AMA.id], locationIds: ['room'], sceneId: 'waiting', durationSec: 4 };
    const shots: (ShotSpec & { id: string; cam: ReturnType<typeof camera>; ama: ReturnType<typeof character> })[] = [
      { ...base, id: 's1', order: 1, number: '1A', title: 'Waiting (from the south)', description: 'Wide shot of the waiting room: Ama sits alone on the long bench along the west wall, hands folded, glancing at the door.', directions: { framing: 'Wide shot', cameraMovement: 'Static', lens: '24mm', lighting: 'Soft morning daylight from the east window', action: 'Ama sits still on the bench, then looks toward the door.' }, cam: camera(0.5, 0.95, 0, { lensMm: 24 }), ama: character('e_ama', AMA.id, 'AMA', 0.17, 0.5, 90) },
      { ...base, id: 's2', order: 2, number: '1B', title: 'Waiting (from the east)', description: 'Medium shot from beside the window: Ama on the bench against the west wall, looking toward the reception desk.', directions: { framing: 'Medium shot', cameraMovement: 'Static', lens: '35mm', lighting: 'Soft morning daylight', action: 'Ama shifts on the bench and smooths her blouse.' }, cam: camera(0.88, 0.5, 270, { lensMm: 35 }), ama: character('e_ama', AMA.id, 'AMA', 0.17, 0.5, 90) },
      { ...base, id: 's3', order: 3, number: '1C', title: 'Waiting (medium, from the south)', description: 'Medium shot of Ama on the bench with the door behind her in the corner of frame.', directions: { framing: 'Medium shot', cameraMovement: 'Slow push-in', lens: '50mm', lighting: 'Soft morning daylight', action: 'Ama breathes out slowly and looks at the clock above the door.' }, cam: camera(0.4, 0.8, 330, { lensMm: 50 }), ama: character('e_ama', AMA.id, 'AMA', 0.17, 0.5, 60) },
      { ...base, id: 's4', order: 4, number: '1D', title: 'The letter', description: 'Close-up of Ama reading a folded letter on the bench.', directions: { framing: 'Close-up', cameraMovement: 'Static', lens: '85mm', lighting: 'Soft window light on her face', action: 'Ama unfolds a letter and reads it; her eyes fill with hope.' }, cam: camera(0.35, 0.5, 270, { lensMm: 85 }), ama: character('e_ama', AMA.id, 'AMA', 0.17, 0.5, 90) },
      { ...base, id: 's5', order: 5, number: '1E', title: 'To the door', description: 'Ama stands up from the bench and walks toward the wooden door on the north wall.', directions: { framing: 'Medium wide shot', cameraMovement: 'Static', lens: '35mm', lighting: 'Soft morning daylight', action: 'Ama rises and walks to the door, stopping with her hand on the handle.' }, cam: camera(0.6, 0.95, 350, { lensMm: 35 }), ama: character('e_ama', AMA.id, 'AMA', 0.17, 0.6, 30, { path: [{ x: 0.3, y: 0.35 }, { x: 0.48, y: 0.1 }] }) },
    ];
    const jobs: Record<string, ReturnType<typeof videoJob>> = {};
    const dirs: Record<string, Awaited<ReturnType<typeof shot>>> = {};
    for (const s of shots) {
      const directions = await shot(projectId, s.id, s);
      dirs[s.id] = directions;
      await saveBlocking(owner, projectId, s.id, 'waiting', 'room', s.cam, [s.ama]);
      jobs[s.id] = videoJob(projectId, s.id, s, directions, [AMA], ROOM);
    }

    // Each shot is produced with continuity (set view for its camera direction + approved face + bible direction).
    const produced: Record<string, Produced> = {};
    await Promise.all(
      shots.map(async (s) => {
        produced[s.id] = await produce(owner, projectId, s.id, jobs[s.id]!, (m) => log(`[${s.id}] ${m}`));
      }),
    );
    for (const s of shots) {
      const p = produced[s.id]!;
      const snap = await snapshot(projectId, s.id);
      const final = p.record.versions.find((v) => v.version.id === p.record.currentVersionId) ?? p.record.versions.at(-1)!;
      const scores = p.categoryScores[String(final.version.index)] ?? {};
      const refs = p.record.versions.length ? (await col.productions().doc(p.productionId).get()).get('continuity') : null;
      log(`${s.id}: ${p.record.status} · v${final.version.index} ${final.report?.overall}/100 passed=${final.report?.passed} · background ${scores.backgroundConsistency} · character ${scores.characterConsistency} · set view ${refs?.setView ?? '—'} · constraints ${snap?.protectedConstraints.length}`);
      // Continuity was planned from the bibles: the set, the locked face and the protected set features are constraints.
      expect(snap?.plannedState.environment.locationId).toBe('room');
      expect(snap?.protectedConstraints.some((c) => c.source === 'set')).toBe(true);
      expect(snap?.protectedConstraints.some((c) => c.source === 'character')).toBe(true);
      expect(typeof scores.backgroundConsistency).toBe('number');
      expect(typeof scores.characterConsistency).toBe('number');
      // Drift never passes silently: a version that passed has no blocking set or identity problem.
      if (final.report?.passed) expect(final.report.problems.filter((x) => x.blocking && [...SET_CATEGORIES, ...IDENTITY_CATEGORIES].includes(x.category))).toEqual([]);
    }
    results.shots = Object.fromEntries(shots.map((s) => [s.id, { status: produced[s.id]!.record.status, versions: produced[s.id]!.record.versions.map((v) => ({ index: v.version.index, kind: v.version.kind, overall: v.report?.overall, passed: v.report?.passed })), categoryScores: produced[s.id]!.categoryScores, problems: allProblems(produced[s.id]!), spentUsd: produced[s.id]!.record.spentUsd }]));

    // Character state is canonical only after approval.
    const before = await col.projects().doc(projectId).collection('characterStates').doc(`s1__${AMA.id}`).get();
    expect(before.exists ? (before.data() as CharacterStateDoc).approved : null).toBeNull();
    await approve(owner, produced.s1!.productionId, produced.s1!.record, log);
    const after = (await col.projects().doc(projectId).collection('characterStates').doc(`s1__${AMA.id}`).get()).data() as CharacterStateDoc | undefined;
    log(`character state after approval: ${JSON.stringify(after?.approved)}`);
    expect(after?.approved).toBeTruthy();
    expect(after?.approvedAt).toBeTruthy();
    // The next shot now continues from the approved state.
    const next = await continuityApi.continuityCheck(owner, payload('continuityCheck', { projectId, shotId: 's2', save: false }));
    expect(next.previousShotId).toBe('s1');
    expect(next.before?.characters[AMA.id]).toBeTruthy();
    results.stateAfterApproval = after?.approved;

    // Deliberate background drift: a take of the same shot in a repainted, rearranged room is caught.
    const drifted = { name: 'Waiting room', description: 'A waiting room with bright red painted walls, no windows at all, a grey metal door on the left wall and rows of blue plastic chairs in the middle of the room' };
    const driftJob = { ...videoJob(projectId, 's3', shots[2]!, dirs.s3!, [AMA], drifted), title: 'QA · drifted background', label: 'QA · drifted background' };
    const drift = await outsideTake(owner, projectId, 's3', driftJob, log);
    const driftReview = await produce(owner, projectId, 's3', jobs.s3!, (m) => log(`[drift] ${m}`), { reviewTakeId: drift.takeId, settings: { maxRepairAttempts: 0 } });
    const d1 = driftReview.record.versions[0]!;
    const driftSet = (d1.report?.problems ?? []).filter((x) => SET_CATEGORIES.includes(x.category));
    log(`drift review v1: ${d1.report?.overall}/100 passed=${d1.report?.passed}; set problems ${JSON.stringify(driftSet.map((x) => `${x.category}: ${x.description}`))}; background ${driftReview.categoryScores['1']?.backgroundConsistency}`);
    expect(d1.version.kind).toBe('existing');
    expect(driftSet.length > 0 || (driftReview.categoryScores['1']?.backgroundConsistency ?? 100) < 70).toBe(true);
    expect(d1.report?.passed).toBe(false);
    results.drift = { takeId: drift.takeId, problems: driftSet, categoryScores: driftReview.categoryScores['1'] };

    // A wrong face in AMA's close-up is caught against the locked identity.
    const wrongJob = { ...videoJob(projectId, 's4', shots[3]!, dirs.s4!, [{ ...AMA, description: 'a tall woman in her sixties with long grey braids, round glasses and a bright green dress' }], ROOM), title: 'QA · wrong face', label: 'QA · wrong face' };
    const wrong = await outsideTake(owner, projectId, 's4', wrongJob, log);
    const wrongReview = await produce(owner, projectId, 's4', jobs.s4!, (m) => log(`[identity] ${m}`), { reviewTakeId: wrong.takeId, settings: { maxRepairAttempts: 0 } });
    const w1 = wrongReview.record.versions[0]!;
    const idProblems = (w1.report?.problems ?? []).filter((x) => IDENTITY_CATEGORIES.includes(x.category));
    log(`identity review v1: ${w1.report?.overall}/100 passed=${w1.report?.passed}; identity problems ${JSON.stringify(idProblems.map((x) => `${x.category}: ${x.description}`))}; character ${wrongReview.categoryScores['1']?.characterConsistency}`);
    expect(idProblems.length > 0 || (wrongReview.categoryScores['1']?.characterConsistency ?? 100) < 70).toBe(true);
    expect(w1.report?.passed).toBe(false);
    const warn = await snapshot(projectId, 's4');
    results.identity = { takeId: wrong.takeId, problems: idProblems, categoryScores: wrongReview.categoryScores['1'], snapshotWarnings: warn?.continuityWarnings.map((w) => `${w.kind}/${w.severity}: ${w.message}`) };
    save({ projectId, ...results });
  });
});
