import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { describe, expect, it } from 'vitest';
import type { PropStateDoc } from '@az-studio/shared';
import * as continuityApi from '../../functions/src/api/continuity';
import { bucket, col, FieldValue } from '../../functions/src/lib/firebase';
import { allProblems, approve, check, generateImage, outsideTake, produce, shot, snapshot, videoJob, type Produced, type ShotSpec } from './continuity-kit';
import { getJob, payload, qaProject, reporter, studioOwner, submitJobs, uploadFile, waitForJob, type Log } from './harness';

const FFMPEG = ffmpegPath as unknown as string;
const AMA = { id: 'ama', name: 'AMA', description: 'Ghanaian woman in her early thirties, short natural black hair, mustard-yellow kaba blouse with an indigo pattern' };
const TEXT_CATEGORIES = ['rendered_text', 'mirrored_text', 'misspelled_text', 'reversed_logo', 'flipped_interface', 'distorted_ui', 'text_flicker', 'wrong_screen_content'];
const PROP_CATEGORIES = ['props', 'prop_appearance', 'prop_hand', 'prop_teleport', 'prop_state', 'prop_missing', 'prop_scale', 'duplicate_prop'];

type Ocr = { t: number; verdict: string; normal: number; flipped: number }[];

/** The screen-composite jobs a production ran, with what OCR read back from each result. */
async function composites(p: Produced): Promise<{ jobId: string; status: string; ocr: Ocr; source: string | null; assetId: string | null }[]> {
  const ids = p.record.repairs.filter((r) => r.type === 'screen_composite').flatMap((r) => r.jobIds);
  return Promise.all(
    ids.map(async (id) => {
      const j = await getJob(id);
      const data = (j.result?.data ?? {}) as { ocr?: Ocr; source?: string };
      return { jobId: id, status: j.status, ocr: data.ocr ?? [], source: data.source ?? null, assetId: j.result?.assetIds?.[0] ?? null };
    }),
  );
}

/** Files an uploaded clip as a take of a shot (as the Shots tab does for imported media). */
async function fileTake(projectId: string, shotId: string, assetId: string, label: string, log: Log): Promise<string> {
  const takes = col.projects().doc(projectId).collection('shots').doc(shotId).collection('takes');
  const ref = takes.doc();
  await ref.set({ index: (await takes.get()).size + 1, jobId: null, assetId, status: 'completed', prompt: '', params: {}, interactionId: null, parentTakeId: null, label, rating: 0, notes: 'QA: imported clip', approved: false, productionId: null, createdAt: FieldValue.serverTimestamp() });
  log(`take ${ref.id} (asset ${assetId}) filed under ${shotId}: ${label}`);
  return ref.id;
}

const current = (p: Produced) => p.record.versions.find((v) => v.version.id === p.record.currentVersionId) ?? p.record.versions.at(-1)!;

describe('Acceptance 10 — protected phone screen and prop continuity', () => {
  it('composites approved AZ Studio content onto a phone (readable, never mirrored), catches a mirrored screen, and keeps a prop in the right hand across shots', async () => {
    const { log, save } = reporter('10-screen-and-prop');
    const owner = await studioOwner();
    const projectId = await qaProject(owner, 'screen-prop', 'Phone screen and prop continuity', 'film');
    const results: Record<string, unknown> = {};
    await col.projects().doc(projectId).collection('characters').doc(AMA.id).set({ name: AMA.name, role: 'Lead', description: '', appearance: AMA.description, wardrobe: 'mustard-yellow kaba blouse with an indigo pattern', personality: '', voice: '', referenceAssetIds: [], primaryRefAssetId: null, turnaroundAssetId: null, locked: false, realPerson: false, consentConfirmed: false, createdAt: FieldValue.serverTimestamp() });
    const dir = mkdtempSync(path.join(tmpdir(), 'azs-acc10-'));
    try {
      // ---------------------------------------------------------------------------------------------
      // 1. Screen orientation: approved AZ Studio interface on a phone.
      // ---------------------------------------------------------------------------------------------
      const png = path.join(dir, 'az-studio-phone.png');
      const font = "fontfile='C\\:/Windows/Fonts/arialbd.ttf'";
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0B1220:s=1080x1920', '-frames:v', '1', '-vf', [`drawbox=x=0:y=1560:w=1080:h=10:color=0xF4B84A:t=fill`, `drawtext=${font}:text='AZ':fontcolor=white:fontsize=440:x=(w-text_w)/2:y=h*0.26`, `drawtext=${font}:text='Studio':fontcolor=white:fontsize=250:x=(w-text_w)/2:y=h*0.52`].join(','), png]);
      const content = await uploadFile(owner, projectId, png, 'image', 'image/png', log);
      const screen = await continuityApi.continuitySave(owner, payload('continuitySave', { projectId, collection: 'protectedScreens', data: { name: 'Ama’s phone', surface: 'phone', expectedText: 'AZ Studio', contentAssetId: content.id, referenceAssetId: null, logoAssetId: null, corners: null, mayMirror: false, composite: true, minTextHeight: 0.02, notes: 'Held upright (portrait) toward the camera' } }));
      log(`protected screen ${screen.id} with approved content ${content.id}`);

      await col.projects().doc(projectId).collection('scenes').doc('stall').set({ sequenceId: null, order: 1, number: '1', heading: 'EXT. MARKET STALL - DAY', intExt: 'EXT', locationName: 'Market stall', locationId: null, timeOfDay: 'day', summary: 'Ama shows the new app, then buys a calabash.', characterIds: [AMA.id], props: ['calabash'], costumes: [], mood: 'bright', dialoguePlan: '', audioPlan: '', estimatedDurationSec: 20, status: 'draft', notes: '' });
      const phoneSpec: ShotSpec = {
        order: 1,
        number: '1A',
        title: 'The app',
        description: 'Insert close-up: Ama’s hand holds a smartphone upright toward the camera; its screen faces the lens squarely and fills the middle of the frame.',
        durationSec: 4,
        characterIds: [AMA.id],
        sceneId: 'stall',
        continuity: { screenIds: [screen.id] },
        directions: { framing: 'Insert close-up of the phone screen', cameraMovement: 'Static', lens: '85mm', lighting: 'Soft daylight, no glare on the screen', action: 'Ama holds the phone steady toward the camera so its screen is fully visible.' },
      };
      const phoneDirs = await shot(projectId, 'phone', phoneSpec);
      const phoneRun = await produce(owner, projectId, 'phone', videoJob(projectId, 'phone', phoneSpec, phoneDirs, [AMA], { name: 'Market stall', description: 'a busy open-air market stall with woven baskets' }), (m) => log(`[phone] ${m}`));
      const phoneFinal = current(phoneRun);
      const phoneComposites = await composites(phoneRun);
      log(`phone: ${phoneRun.record.status} · v${phoneFinal.version.index} (${phoneFinal.version.kind}${phoneFinal.version.repair ? `/${phoneFinal.version.repair.type}` : ''}) ${phoneFinal.report?.overall}/100 passed=${phoneFinal.report?.passed}; composites ${JSON.stringify(phoneComposites.map((c) => ({ status: c.status, source: c.source, ocr: c.ocr.map((o) => o.verdict) })))}`);
      log(`phone text problems by version: ${JSON.stringify(phoneRun.record.versions.map((v) => ({ v: v.version.index, text: (v.report?.problems ?? []).filter((x) => TEXT_CATEGORIES.includes(x.category)).map((x) => `${x.category}/${x.severity}`) })))}`);
      // The model is told to leave the screen clean; the approved content is composited and read back with OCR.
      let composite = phoneComposites.find((c) => c.status === 'completed') ?? null;
      if (!composite) {
        // The production never needed to composite (or could not): the director composites from the Continuity panel.
        const asset = phoneFinal.version.assetId!;
        const [jobId] = await submitJobs(owner, [{ type: 'media.screen_replace', projectId, sourceAssetId: asset, screenId: screen.id, shotId: 'phone', label: 'QA · composite the approved screen' }], 'QA · screen composite');
        const j = await waitForJob(jobId!, log);
        expect(j.status, j.error?.message).toBe('completed');
        const data = (j.result?.data ?? {}) as { ocr?: Ocr; source?: string };
        composite = { jobId: jobId!, status: j.status, ocr: data.ocr ?? [], source: data.source ?? null, assetId: j.result?.assetIds?.[0] ?? null };
      }
      log(`composite ${composite.jobId}: ${composite.source}; OCR ${JSON.stringify(composite.ocr)}`);
      expect(composite.ocr.length).toBeGreaterThan(0);
      expect(composite.ocr.some((o) => o.verdict === 'correct')).toBe(true);
      expect(composite.ocr.some((o) => o.verdict === 'mirrored')).toBe(false);
      // Where the production composited it, the re-inspection of the composite is clean of text faults.
      if (phoneFinal.version.repair?.type === 'screen_composite') {
        expect((phoneFinal.report?.problems ?? []).filter((x) => x.blocking && TEXT_CATEGORIES.includes(x.category))).toEqual([]);
      }
      results.screen = { contentAssetId: content.id, screenId: screen.id, production: { status: phoneRun.record.status, versions: phoneRun.record.versions.map((v) => ({ index: v.version.index, kind: v.version.kind, repair: v.version.repair?.type ?? null, overall: v.report?.overall, passed: v.report?.passed, text: (v.report?.problems ?? []).filter((x) => TEXT_CATEGORIES.includes(x.category)).map((x) => `${x.category}/${x.severity}`) })), spentUsd: phoneRun.record.spentUsd }, composite };

      // A mirrored version of the composited shot (as a flipped export would look) is caught and composited back.
      const compositedAsset = (await col.assets().doc(composite.assetId!).get()).data()!;
      const localComposite = path.join(dir, 'composited.mp4');
      await bucket.file(String(compositedAsset.storagePath)).download({ destination: localComposite });
      const mirroredFile = path.join(dir, 'mirrored.mp4');
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', localComposite, '-vf', 'hflip', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy', mirroredFile]);
      const mirrored = await uploadFile(owner, projectId, mirroredFile, 'video', 'video/mp4', log);
      const mirroredTake = await fileTake(projectId, 'phone', mirrored.id, 'Mirrored export (QA)', log);
      const mirrorRun = await produce(owner, projectId, 'phone', videoJob(projectId, 'phone', phoneSpec, phoneDirs, [AMA], null), (m) => log(`[mirrored] ${m}`), { reviewTakeId: mirroredTake });
      const m1 = mirrorRun.record.versions[0]!;
      const mirroredProblems = (m1.report?.problems ?? []).filter((x) => TEXT_CATEGORIES.includes(x.category));
      const mirrorFixed = await composites(mirrorRun);
      log(`mirrored take: v1 ${m1.report?.overall}/100 passed=${m1.report?.passed}; text problems ${JSON.stringify(mirroredProblems.map((x) => `${x.category}/${x.severity}: ${x.description}`))}; repaired by ${JSON.stringify(mirrorFixed.map((c) => ({ status: c.status, ocr: c.ocr.map((o) => o.verdict) })))}; final ${current(mirrorRun).report?.overall}/100 passed=${current(mirrorRun).report?.passed}`);
      expect(mirroredProblems.some((x) => x.category === 'mirrored_text')).toBe(true);
      expect(m1.report?.passed).toBe(false);
      // Where the production composited the approved content back, it reads correctly and is not mirrored.
      for (const c of mirrorFixed.filter((x) => x.status === 'completed')) {
        expect(c.ocr.some((o) => o.verdict === 'correct')).toBe(true);
        expect(c.ocr.some((o) => o.verdict === 'mirrored')).toBe(false);
      }
      results.mirrored = { takeId: mirroredTake, problems: mirroredProblems, composites: mirrorFixed, final: { overall: current(mirrorRun).report?.overall, passed: current(mirrorRun).report?.passed } };

      // ---------------------------------------------------------------------------------------------
      // 2. Prop continuity: the calabash is picked up with the right hand and carried into the next shot.
      // ---------------------------------------------------------------------------------------------
      const CALABASH = 'a round dried calabash gourd bowl, pale yellow-brown, about 25 cm across, with a dark carved zigzag band around its rim';
      const ref = await generateImage(owner, projectId, log, { title: 'Calabash reference', purpose: 'product', aspectRatio: '1:1', prompt: `Product reference photo of ${CALABASH}, on a plain light-grey background, soft even studio light, three-quarter view, whole object visible.` });
      await col.projects().doc(projectId).collection('elements').doc('calabash').set({ kind: 'prop', name: 'calabash', description: CALABASH, characterId: null, referenceAssetIds: [ref], locked: true });
      await continuityApi.continuitySave(owner, payload('continuitySave', { projectId, collection: 'props', data: { elementId: 'calabash', ownerId: AMA.id, approvedRefAssetId: ref, description: CALABASH, scale: 'about 25 cm across; held in one hand', entersShotId: 'p1', leavesShotId: null, initial: { present: true, holderId: null, hand: null, location: 'on the wooden stall table', condition: 'clean', status: 'intact', orientation: 'upright' }, notes: '' } }));
      const market = { name: 'Market stall', description: 'an open-air market stall with a wooden table, woven baskets and bright cloth awnings' };
      const p1: ShotSpec = {
        order: 2,
        number: '1B',
        title: 'Picks up the calabash',
        description: 'Medium shot: Ama stands at the market stall and picks the calabash up from the wooden table with her RIGHT hand, lifting it to look at it.',
        durationSec: 5,
        characterIds: [AMA.id],
        elementIds: ['calabash'],
        sceneId: 'stall',
        continuity: { propIds: ['calabash'], propEvents: [{ propId: 'calabash', type: 'pick_up', characterId: AMA.id, toCharacterId: null, hand: 'right', location: '', note: 'from the stall table' }] },
        directions: { framing: 'Medium shot', cameraMovement: 'Static', lens: '35mm', lighting: 'Bright daylight under the awning', action: `Ama picks up the calabash (${CALABASH}) with her right hand and holds it up in her right hand. Her left hand stays empty.` },
      };
      const p1Dirs = await shot(projectId, 'p1', p1);
      const beforeApproval = await col.projects().doc(projectId).collection('propStates').doc('p1__calabash').get();
      const p1Run = await produce(owner, projectId, 'p1', videoJob(projectId, 'p1', p1, p1Dirs, [AMA], market), (m) => log(`[p1] ${m}`));
      const p1Final = current(p1Run);
      log(`p1: ${p1Run.record.status} · v${p1Final.version.index} ${p1Final.report?.overall}/100 passed=${p1Final.report?.passed}; prop continuity ${p1Run.categoryScores[String(p1Final.version.index)]?.propContinuity}; prop problems ${JSON.stringify((p1Final.report?.problems ?? []).filter((x) => PROP_CATEGORIES.includes(x.category)).map((x) => `${x.category}/${x.severity}`))}`);
      expect((beforeApproval.data() as PropStateDoc | undefined)?.approved ?? null).toBeNull();
      await approve(owner, p1Run.productionId, p1Run.record, log);
      const ledger = (await col.projects().doc(projectId).collection('propStates').doc('p1__calabash').get()).data() as PropStateDoc | undefined;
      log(`prop ledger after approving p1: ${JSON.stringify(ledger?.approved)}`);
      expect(ledger?.approved).toMatchObject({ holderId: AMA.id, hand: 'right', present: true });

      // The next shot continues from the ledger: the calabash stays in AMA's right hand.
      const p2: ShotSpec = {
        order: 3,
        number: '1C',
        title: 'Carries it on',
        description: 'Medium wide shot: Ama walks past the next stall carrying the calabash in her RIGHT hand at her side.',
        durationSec: 5,
        characterIds: [AMA.id],
        elementIds: ['calabash'],
        sceneId: 'stall',
        continuity: { propIds: ['calabash'] },
        directions: { framing: 'Medium wide shot', cameraMovement: 'Slow pan following Ama', lens: '35mm', lighting: 'Bright daylight', action: 'Ama walks slowly past the stalls, the calabash held in her right hand; her left hand is empty.' },
      };
      const p2Dirs = await shot(projectId, 'p2', p2);
      await check(owner, projectId, 'p2');
      const planned = await snapshot(projectId, 'p2');
      log(`p2 planned: calabash ${JSON.stringify(planned?.plannedState.props.calabash)}; AMA hands L=${planned?.plannedState.characters[AMA.id]?.leftHand} R=${planned?.plannedState.characters[AMA.id]?.rightHand}`);
      expect(planned?.plannedState.props.calabash).toMatchObject({ holderId: AMA.id, hand: 'right' });
      expect(planned?.plannedState.characters[AMA.id]?.rightHand).toBe('calabash');
      // A plan that silently moves it to the left hand is flagged before anything is generated.
      await col.projects().doc(projectId).collection('shots').doc('p2').update({ 'continuity.characters': { [AMA.id]: { leftHand: 'calabash', rightHand: null } } });
      const wrongPlan = await check(owner, projectId, 'p2');
      const handWarning = wrongPlan.warnings.find((w) => w.kind === 'prop_hand');
      log(`left-hand plan: ${handWarning?.severity} — ${handWarning?.message}`);
      expect(handWarning?.severity).toBe('critical');
      await col.projects().doc(projectId).collection('shots').doc('p2').update({ 'continuity.characters': {} });
      const fixedPlan = await check(owner, projectId, 'p2');
      expect(fixedPlan.warnings.some((w) => w.kind === 'prop_hand' && w.status === 'open')).toBe(false);

      const p2Run = await produce(owner, projectId, 'p2', videoJob(projectId, 'p2', p2, p2Dirs, [AMA], market), (m) => log(`[p2] ${m}`));
      const p2Final = current(p2Run);
      const p2Scores = p2Run.categoryScores[String(p2Final.version.index)] ?? {};
      log(`p2: ${p2Run.record.status} · v${p2Final.version.index} ${p2Final.report?.overall}/100 passed=${p2Final.report?.passed}; prop continuity ${p2Scores.propContinuity}; prop problems ${JSON.stringify((p2Final.report?.problems ?? []).filter((x) => PROP_CATEGORIES.includes(x.category)).map((x) => `${x.category}/${x.severity}: ${x.description}`))}`);
      expect(typeof p2Scores.propContinuity).toBe('number');
      if (p2Final.report?.passed) expect((p2Final.report.problems ?? []).filter((x) => x.blocking && PROP_CATEGORIES.includes(x.category))).toEqual([]);

      // A deliberately wrong version — the calabash in the LEFT hand — is rejected.
      const leftSpec: ShotSpec = { ...p2, description: 'Medium wide shot: Ama walks past the next stall carrying the calabash in her LEFT hand; her RIGHT hand is empty and swinging.', directions: { ...p2.directions, action: 'Ama walks slowly past the stalls holding the calabash in her LEFT hand, raised a little in front of her; her right hand is clearly empty.' } };
      const leftJob = { ...videoJob(projectId, 'p2', leftSpec, { ...p2Dirs, action: leftSpec.directions.action! }, [AMA], market), title: 'QA · calabash in the left hand', label: 'QA · calabash in the left hand' };
      const left = await outsideTake(owner, projectId, 'p2', leftJob, log);
      const leftReview = await produce(owner, projectId, 'p2', videoJob(projectId, 'p2', p2, p2Dirs, [AMA], market), (m) => log(`[left hand] ${m}`), { reviewTakeId: left.takeId, settings: { maxRepairAttempts: 0 } });
      const l1 = leftReview.record.versions[0]!;
      const handProblems = (l1.report?.problems ?? []).filter((x) => PROP_CATEGORIES.includes(x.category));
      log(`left-hand take: ${l1.report?.overall}/100 passed=${l1.report?.passed}; prop problems ${JSON.stringify(handProblems.map((x) => `${x.category}/${x.severity}: ${x.description}`))}; prop continuity ${leftReview.categoryScores['1']?.propContinuity}`);
      expect(handProblems.some((x) => x.category === 'prop_hand') || (leftReview.categoryScores['1']?.propContinuity ?? 100) < 70).toBe(true);
      expect(l1.report?.passed).toBe(false);
      results.prop = {
        refAssetId: ref,
        ledgerAfterP1: ledger?.approved,
        plannedP2: planned?.plannedState.props.calabash,
        leftHandPlanWarning: handWarning && { severity: handWarning.severity, message: handWarning.message },
        p1: { status: p1Run.record.status, categoryScores: p1Run.categoryScores, problems: allProblems(p1Run), spentUsd: p1Run.record.spentUsd },
        p2: { status: p2Run.record.status, categoryScores: p2Run.categoryScores, problems: allProblems(p2Run), spentUsd: p2Run.record.spentUsd },
        leftHand: { takeId: left.takeId, overall: l1.report?.overall, passed: l1.report?.passed, problems: handProblems, categoryScores: leftReview.categoryScores['1'] },
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
      save({ projectId, ...results });
    }
  });
});
