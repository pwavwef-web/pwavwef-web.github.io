import { describe, expect, it } from 'vitest';
import * as continuityApi from '../../functions/src/api/continuity';
import * as production from '../../functions/src/api/production';
import { col, FieldValue } from '../../functions/src/lib/firebase';
import { CHEAP, camera, character, check, produce, saveBlocking, shot, snapshot, videoJob, type ShotSpec } from './continuity-kit';
import { payload, qaProject, reporter, studioOwner } from './harness';

const PEOPLE = [
  { id: 'ama', name: 'AMA', description: 'Ghanaian woman in her thirties, short natural hair, mustard-yellow kaba blouse' },
  { id: 'kofi', name: 'KOFI', description: 'Ghanaian man in his forties, close-cropped greying hair, crisp white shirt' },
  { id: 'esi', name: 'ESI', description: 'Ghanaian teenage girl with long braids in a blue school uniform' },
];
const BLOCKING_CATEGORIES = ['occlusion', 'face_hidden', 'bodies_merge', 'same_space', 'attached_character', 'speaker_blocked', 'depth_order', 'wrong_eyeline', 'character_merge'];
const DIRECTION_CATEGORIES = ['direction_reversal', 'entry_exit_side', 'screen_direction', 'side_swap', 'axis_crossing', 'spatial_confusion'];

describe('Acceptance 9 — three-person blocking and screen direction', () => {
  it('stops a blocked speaker before generation, produces a clean three-person conversation, and catches a reversed walk with a neutral-shot proposal', async () => {
    const { log, save } = reporter('09-blocking-and-direction');
    const owner = await studioOwner();
    const projectId = await qaProject(owner, 'blocking', 'Blocking and screen direction', 'film');
    const results: Record<string, unknown> = {};
    for (const p of PEOPLE) await col.projects().doc(projectId).collection('characters').doc(p.id).set({ name: p.name, role: '', description: '', appearance: p.description, wardrobe: '', personality: '', voice: '', referenceAssetIds: [], primaryRefAssetId: null, turnaroundAssetId: null, locked: false, realPerson: false, consentConfirmed: false, createdAt: FieldValue.serverTimestamp() });
    await col.projects().doc(projectId).collection('scenes').doc('porch').set({ sequenceId: null, order: 1, number: '1', heading: 'EXT. COMPOUND PORCH - EVENING', intExt: 'EXT', locationName: 'Compound porch', locationId: null, timeOfDay: 'evening', summary: 'The family decides to travel north.', characterIds: PEOPLE.map((p) => p.id), props: [], costumes: [], mood: 'hopeful', dialoguePlan: '', audioPlan: '', estimatedDurationSec: 8, status: 'draft', notes: '' });

    // 1. A three-person conversation with ESI standing right in front of KOFI while he speaks.
    const talk: ShotSpec = {
      order: 1,
      number: '1A',
      title: 'Leaving at dawn',
      description: 'Three-person conversation on a compound porch at dusk: Kofi in the middle, Ama on the left, Esi on the right.',
      durationSec: 6,
      characterIds: PEOPLE.map((p) => p.id),
      sceneId: 'porch',
      directions: { framing: 'Medium wide three-shot', cameraMovement: 'Static', lens: '35mm', lighting: 'Warm dusk light', mood: 'Hopeful', dialogue: [{ character: 'KOFI', line: 'We leave at dawn.' }, { character: 'AMA', line: 'Then we pack tonight.' }, { character: 'ESI', line: 'Can I come?' }], ambientSound: 'Evening insects, distant radio' },
    };
    const directions = await shot(projectId, 'talk', talk);
    const cam = camera(0.5, 0.9, 0, { lensMm: 35 });
    await saveBlocking(owner, projectId, 'talk', 'porch', null, cam, [
      character('e_ama', 'ama', 'AMA', 0.3, 0.45, 120, { speaking: true, gaze: { kind: 'entity', targetId: 'e_kofi', deg: null } }),
      character('e_kofi', 'kofi', 'KOFI', 0.5, 0.4, 180, { speaking: true }),
      character('e_esi', 'esi', 'ESI', 0.5, 0.62, 0, { speaking: true }),
    ]);
    const bad = await check(owner, projectId, 'talk');
    const blocked = bad.warnings.filter((w) => w.kind === 'occlusion' && w.severity === 'critical');
    log(`bad blocking: ${bad.warnings.map((w) => `${w.kind}/${w.severity}: ${w.message}`).join(' | ')}`);
    expect(blocked.length).toBeGreaterThan(0);
    const job = videoJob(projectId, 'talk', talk, directions, PEOPLE, { name: 'Compound porch', description: 'a concrete porch of a family compound with a low wall and a hanging bulb' });
    const est = await production.estimateProduction(owner, payload('estimateProduction', { projectId, shotId: 'talk', job, options: { requestedSec: 6, settings: CHEAP } }));
    expect(est.continuity.warnings.some((w) => w.kind === 'occlusion' && w.severity === 'critical')).toBe(true);
    results.badBlocking = bad.warnings.map((w) => ({ kind: w.kind, severity: w.severity, message: w.message, repair: w.proposedRepair?.label }));

    // 2. Corrected blocking: a shallow arc facing the camera; nobody covers anybody.
    await saveBlocking(owner, projectId, 'talk', 'porch', null, cam, [
      character('e_ama', 'ama', 'AMA', 0.32, 0.47, 110, { speaking: true, gaze: { kind: 'entity', targetId: 'e_kofi', deg: null } }),
      character('e_kofi', 'kofi', 'KOFI', 0.5, 0.42, 180, { speaking: true }),
      character('e_esi', 'esi', 'ESI', 0.68, 0.47, 250, { speaking: true, gaze: { kind: 'entity', targetId: 'e_kofi', deg: null } }),
    ]);
    const good = await check(owner, projectId, 'talk');
    const open = good.warnings.filter((w) => w.status === 'open' && w.severity !== 'info' && ['occlusion', 'face_hidden', 'same_space', 'out_of_frame'].includes(w.kind));
    log(`corrected blocking: ${open.length} blocking warnings; screen order ${good.blocking?.screenOrder.join(', ')}`);
    expect(open).toEqual([]);
    expect(good.blocking?.screenOrder).toEqual(['ama', 'kofi', 'esi']);
    const talkRun = await produce(owner, projectId, 'talk', job, (m) => log(`[talk] ${m}`), { requestedSec: 6 });
    const final = talkRun.record.versions.find((v) => v.version.id === talkRun.record.currentVersionId) ?? talkRun.record.versions.at(-1)!;
    const scores = talkRun.categoryScores[String(final.version.index)] ?? {};
    log(`three-person take: v${final.version.index} ${final.report?.overall}/100 passed=${final.report?.passed}; blocking ${scores.blocking}; face visibility ${scores.faceVisibility}; problems ${JSON.stringify(final.report?.problems.map((p) => p.category))}`);
    expect(typeof scores.blocking).toBe('number');
    expect(typeof scores.faceVisibility).toBe('number');
    if (final.report?.passed) expect(final.report.problems.filter((p) => p.blocking && BLOCKING_CATEGORIES.includes(p.category))).toEqual([]);
    results.conversation = { status: talkRun.record.status, versions: talkRun.record.versions.map((v) => ({ index: v.version.index, overall: v.report?.overall, passed: v.report?.passed, problems: v.report?.problems.map((p) => `${p.category}${p.blocking ? '!' : ''}`) })), categoryScores: talkRun.categoryScores, spentUsd: talkRun.record.spentUsd };

    // 3. Screen direction: Kofi has walked left → right along the road; the next shot reverses him.
    await col.projects().doc(projectId).collection('scenes').doc('road').set({ sequenceId: null, order: 2, number: '2', heading: 'EXT. LATERITE ROAD - DAY', intExt: 'EXT', locationName: 'Laterite road', locationId: null, timeOfDay: 'day', summary: 'Kofi walks to the lorry station.', characterIds: ['kofi'], props: [], costumes: [], mood: 'determined', dialoguePlan: '', audioPlan: '', estimatedDurationSec: 12, status: 'draft', notes: '' });
    const walk = (order: number, number: string, title: string): ShotSpec => ({ order, number, title, description: 'Kofi walks along a red laterite road lined with neem trees, carrying a travel bag.', durationSec: 4, characterIds: ['kofi'], sceneId: 'road', directions: { framing: 'Wide shot', cameraMovement: 'Static', lens: '35mm', lighting: 'Midday sun', action: 'Kofi walks steadily across the frame.' } });
    const w1 = walk(10, '2A', 'Walking (1)');
    const w2 = walk(11, '2B', 'Walking (2)');
    const w1dir = await shot(projectId, 'w1', w1);
    await shot(projectId, 'w2', w2);
    const roadCam = camera(0.5, 0.9, 0, { lensMm: 35 });
    await saveBlocking(owner, projectId, 'w1', 'road', null, roadCam, [character('e_kofi', 'kofi', 'KOFI', 0.32, 0.5, 90, { path: [{ x: 0.68, y: 0.5 }] })]);
    // The approved first shot established the travel direction on the scene's axis.
    await continuityApi.continuitySave(owner, payload('continuitySave', { projectId, collection: 'cameraAxes', data: { sceneId: 'road', axis: null, establishedSide: null, travel: [{ refId: 'kofi', direction: 'left_to_right' }], crossings: [] } }));
    await saveBlocking(owner, projectId, 'w2', 'road', null, roadCam, [character('e_kofi', 'kofi', 'KOFI', 0.68, 0.5, 270, { path: [{ x: 0.32, y: 0.5 }] })]);
    const reversed = await check(owner, projectId, 'w2');
    const dir = reversed.warnings.find((w) => w.kind === 'screen_direction');
    log(`reversed walk: ${dir?.severity} — ${dir?.message}; proposed ${dir?.proposedRepair?.type} (${dir?.proposedRepair?.label})`);
    expect(dir?.severity).toBe('critical');
    expect(dir?.proposedRepair?.type).toBe('neutral_shot');
    // The proposed neutral transition is inserted between the two shots.
    const neutral = await continuityApi.insertNeutralShot(owner, payload('insertNeutralShot', { projectId, afterShotId: 'w1', kind: 'head_on' }));
    const n = (await col.projects().doc(projectId).collection('shots').doc(neutral.shotId).get()).data()!;
    log(`neutral shot ${neutral.shotId}: “${n.title}” at order ${n.order} — ${n.notes}`);
    expect(n.order).toBeGreaterThan(10);
    expect(n.order).toBeLessThan(11);
    expect(n.continuity.axisCrossing.reason).toBe('neutral_shot');
    // …or the shot is corrected: the same walk left → right raises no direction warning.
    await saveBlocking(owner, projectId, 'w2', 'road', null, roadCam, [character('e_kofi', 'kofi', 'KOFI', 0.32, 0.5, 90, { path: [{ x: 0.68, y: 0.5 }] })]);
    const fixed = await check(owner, projectId, 'w2');
    expect(fixed.warnings.some((w) => w.kind === 'screen_direction' && w.status === 'open')).toBe(false);
    results.direction = { warning: dir && { severity: dir.severity, message: dir.message, repair: dir.proposedRepair }, neutralShot: { id: neutral.shotId, title: n.title, order: n.order } };

    // 4. The first walk is generated and inspected: its measured travel must match the plan or be flagged.
    const walkRun = await produce(owner, projectId, 'w1', videoJob(projectId, 'w1', w1, w1dir, [PEOPLE[1]!], { name: 'Laterite road', description: 'a red laterite road lined with neem trees under a clear sky' }), (m) => log(`[w1] ${m}`));
    const snap = await snapshot(projectId, 'w1');
    const measured = snap?.continuityAfter?.camera.travel.kofi ?? null;
    const wv = walkRun.record.versions.find((v) => v.version.id === walkRun.record.currentVersionId) ?? walkRun.record.versions.at(-1)!;
    const flagged = (wv.report?.problems ?? []).filter((p) => DIRECTION_CATEGORIES.includes(p.category));
    log(`w1 measured travel: ${measured ?? 'not measured'}; direction problems ${JSON.stringify(flagged.map((p) => p.category))}; screen direction ${walkRun.categoryScores[String(wv.version.index)]?.screenDirection}`);
    expect(measured === 'left_to_right' || flagged.length > 0 || measured === null).toBe(true);
    if (measured && measured !== 'left_to_right') expect(flagged.length).toBeGreaterThan(0);
    results.walk = { measured, flagged, categoryScores: walkRun.categoryScores, status: walkRun.record.status };
    save({ projectId, ...results });
  });
});
