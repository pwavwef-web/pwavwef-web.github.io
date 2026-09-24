import { describe, expect, it } from 'vitest';
import * as production from '../../functions/src/api/production';
import { currentVersion, loadProductionDoc, payload, productionRecord, qaCharacter, qaProject, qaShot, reporter, runProduction, shotVideoJob, studioOwner, type QaShot } from './harness';

const ESI = { id: 'esi', name: 'ESI', appearance: 'Ghanaian woman in her twenties, braided hair tied up', wardrobe: 'green headwrap, yellow and green kente-print blouse, dark skirt' };

// Four action beats that cannot finish in the requested four seconds.
const SHOT: QaShot = {
  title: 'Through the courtyard door',
  description: 'A sunlit compound house courtyard with a blue wooden door in a whitewashed wall.',
  durationSec: 4,
  characterIds: ['esi'],
  directions: {
    framing: 'Wide shot, locked-off',
    lens: '28mm',
    lighting: 'Late-morning sun',
    mood: 'Calm',
    style: 'Naturalistic',
    action: 'Esi walks up to the blue wooden door, opens it, steps through into the courtyard, and closes the door behind her.',
    ambientSound: 'Footsteps on packed earth, the door creaking open and shut, distant chickens',
  },
};

describe('Acceptance 2 — action longer than the requested duration', () => {
  it('lengthens the shot so every action beat completes on screen before it ends', async () => {
    const { log, save } = reporter('02-incomplete-action');
    const owner = await studioOwner();
    const projectId = await qaProject(owner, 'action', 'Incomplete action', 'film');
    await qaCharacter(projectId, ESI);
    const directions = await qaShot(projectId, 'door', SHOT);
    const job = shotVideoJob(projectId, 'door', SHOT, directions, [ESI], true);

    const est = await production.estimateProduction(owner, payload('estimateProduction', { projectId, shotId: 'door', job, options: { requestedSec: 4 } }));
    log(`estimate: requested ${est.plan.requestedSec} s, required ${est.plan.requiredSec} s — ${est.plan.message} (action time ${est.plan.breakdown.actionTailSec} s) ≈ $${est.estimate.usd}`);
    expect(est.plan.requiredSec).toBeGreaterThan(4);
    expect(est.plan.breakdown.actionTailSec).toBeGreaterThan(0);

    const started = await production.startProduction(owner, payload('startProduction', { projectId, shotId: 'door', job, options: { requestedSec: 4 }, confirmedUsd: est.estimate.usd }));
    log(`production ${started.productionId} started in project ${projectId}`);
    await runProduction(owner, started.productionId, log);
    const rec = await productionRecord(started.productionId);
    save(rec);

    expect(rec.plan?.requestedSec).toBe(4);
    expect(rec.plan?.plannedSec).toBeGreaterThan(4);
    const final = currentVersion(rec)!;
    log(`final: version ${final.version.index} (${final.version.label}, ${final.report?.durationSec} s) ${final.report?.overall}/100 passed=${final.report?.passed}`);
    for (const a of final.report?.actions ?? []) log(`  beat "${a.beat}": ${a.completed ? 'completed' : 'NOT completed'}${a.endSec !== null ? ` by ${a.endSec} s` : ''}`);
    expect(rec.status).toBe('awaiting_review');
    expect(final.report?.passed).toBe(true);
    expect(final.report?.actionComplete).toBe(true);
    expect(final.report?.actions.length).toBeGreaterThanOrEqual(3);
    expect(final.report?.actions.every((a) => a.completed)).toBe(true);

    await production.productionAction(owner, payload('productionAction', { productionId: started.productionId, action: 'approve', versionId: final.version.id }));
    expect((await loadProductionDoc(started.productionId)).status).toBe('approved');
    save(await productionRecord(started.productionId));
  });
});
