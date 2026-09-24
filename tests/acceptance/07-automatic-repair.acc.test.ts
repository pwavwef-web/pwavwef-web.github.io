import { describe, expect, it } from 'vitest';
import * as production from '../../functions/src/api/production';
import { col } from '../../functions/src/lib/firebase';
import { currentVersion, loadProductionDoc, payload, productionRecord, qaCharacter, qaProject, qaShot, reporter, runProduction, shotVideoJob, studioOwner, submitJobs, waitForJob, type QaShot } from './harness';

const YAW = { id: 'yaw', name: 'YAW', appearance: 'Ghanaian man in his sixties, white stubble, kind eyes', wardrobe: 'brown batakari smock, black cap' };

const SHOT: QaShot = {
  title: 'The fisherman remembers',
  description: 'Yaw sits on an upturned canoe on the beach at sunset, talking to someone off camera.',
  durationSec: 4,
  characterIds: ['yaw'],
  directions: {
    framing: 'Medium close-up',
    cameraMovement: 'Static',
    lens: '50mm',
    lighting: 'Golden sunset backlight',
    mood: 'Nostalgic',
    style: 'Naturalistic',
    performance: 'Warm, unhurried storytelling',
    dialogue: [{ character: 'YAW', line: 'When I was a boy, my father took me out beyond the breakers every morning. He taught me to read the water before the sun was up, and I have never forgotten it.' }],
    ambientSound: 'Gentle surf, wind',
  },
};

describe('Acceptance 7 — automatic repair of a truncated scene', () => {
  it('finds the cut-off dialogue in an existing take, repairs it and verifies the repaired version', async () => {
    const { log, save } = reporter('07-automatic-repair');
    const owner = await studioOwner();
    const projectId = await qaProject(owner, 'repair', 'Automatic repair', 'film');
    await qaCharacter(projectId, YAW);
    const directions = await qaShot(projectId, 'memory', SHOT);

    // 1. An ordinary 4-second take (no quality control): the ~9 s line cannot fit, so it is cut off.
    const [jobId] = await submitJobs(owner, [shotVideoJob(projectId, 'memory', SHOT, directions, [YAW], true, 4)], 'QA · truncated take');
    const job = await waitForJob(jobId!, log, 30 * 60_000);
    expect(job.status).toBe('completed');
    const takeId = job.target?.sub ?? null;
    expect(takeId).toBeTruthy();
    const take = (await col.projects().doc(projectId).collection('shots').doc('memory').collection('takes').doc(takeId!).get()).data()!;
    log(`truncated take ${takeId} (${job.result?.assetIds?.[0]}) generated`);

    // 2. Review & repair that take under quality control.
    const options = { requestedSec: 4, reviewTakeId: takeId };
    const est = await production.estimateProduction(owner, payload('estimateProduction', { projectId, shotId: 'memory', job: shotVideoJob(projectId, 'memory', SHOT, directions, [YAW], true), options }));
    log(`review estimate ≈ $${est.estimate.usd}; the scene needs about ${est.plan.requiredSec} s`);
    const started = await production.startProduction(owner, payload('startProduction', { projectId, shotId: 'memory', job: shotVideoJob(projectId, 'memory', SHOT, directions, [YAW], true), options, confirmedUsd: est.estimate.usd }));
    log(`production ${started.productionId} reviewing take ${takeId}`);
    await runProduction(owner, started.productionId, log);
    const rec = await productionRecord(started.productionId);
    save({ takeId, takeInteraction: Boolean(take.interactionId), ...rec });

    // Version 1 is the existing take and fails with incomplete dialogue.
    const first = rec.versions[0]!;
    log(`v1 (${first.version.label}): ${first.report?.overall}/100 passed=${first.report?.passed}; missing ${JSON.stringify(first.report?.dialogue.missingWords)} cutoff ${first.report?.dialogue.cutoffTime}`);
    expect(first.version.kind).toBe('existing');
    expect(first.report?.passed).toBe(false);
    expect(first.report?.dialogue.dialogueComplete).toBe(false);
    expect(first.report?.problems.some((p) => p.blocking && ['dialogue_truncated', 'dialogue_missing'].includes(p.category))).toBe(true);

    // At least one automatic repair ran and was re-inspected.
    expect(rec.repairs.length).toBeGreaterThanOrEqual(1);
    for (const r of rec.repairs) log(`repair: ${r.type} — ${r.reason} → ${r.outcome} (est. $${r.estimateUsd})`);
    expect(rec.versions.length).toBeGreaterThanOrEqual(2);
    expect(rec.versions.slice(1).every((v) => v.report !== null)).toBe(true);

    // The repaired version passes with the complete dialogue.
    const final = currentVersion(rec)!;
    log(`final: version ${final.version.index} (${final.version.label}, ${final.report?.durationSec} s) ${final.report?.overall}/100 passed=${final.report?.passed}; heard "${final.report?.dialogue.detectedText}"`);
    expect(rec.status).toBe('awaiting_review');
    expect(final.version.kind).toBe('repair');
    expect(final.report?.passed).toBe(true);
    expect(final.report?.dialogue.dialogueComplete).toBe(true);
    expect(rec.repairs.length).toBeLessThanOrEqual(3);

    await production.productionAction(owner, payload('productionAction', { productionId: started.productionId, action: 'approve', versionId: final.version.id }));
    expect((await loadProductionDoc(started.productionId)).status).toBe('approved');
    save({ takeId, ...(await productionRecord(started.productionId)) });
  });
});
