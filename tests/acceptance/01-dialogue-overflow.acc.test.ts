import { describe, expect, it } from 'vitest';
import * as production from '../../functions/src/api/production';
import { currentVersion, loadProductionDoc, payload, productionRecord, qaCharacter, qaProject, qaShot, reporter, runProduction, shotVideoJob, studioOwner, type QaShot } from './harness';

const AMA = { id: 'ama', name: 'AMA', appearance: 'Ghanaian woman in her thirties, close-cropped hair, weathered hands', wardrobe: 'faded indigo wrapper dress, cowrie-shell necklace' };
const KOFI = { id: 'kofi', name: 'KOFI', appearance: 'Ghanaian man in his forties, short grey beard, broad shoulders', wardrobe: 'white linen shirt with rolled sleeves, straw hat' };

const SHOT: QaShot = {
  title: 'Reef crossing',
  description: 'Ama and Kofi stand at the bow of a wooden fishing canoe at dusk, the reef behind them.',
  durationSec: 8,
  characterIds: ['ama', 'kofi'],
  directions: {
    framing: 'Medium two-shot',
    cameraMovement: 'Slow push-in',
    lens: '35mm',
    lighting: 'Warm dusk light',
    mood: 'Resolute',
    style: 'Naturalistic, cinematic',
    performance: 'Quiet determination',
    dialogue: [
      { character: 'AMA', line: 'We have crossed the reef, but the journey has only begun. The tide will turn before nightfall, and we must be ready.' },
      { character: 'KOFI', line: 'Then we sail at first light. Tell the others to rest while they still can.' },
    ],
    ambientSound: 'Waves lapping against the hull, distant gulls',
  },
};

describe('Acceptance 1 — dialogue longer than the requested duration', () => {
  it('measures the dialogue, extends the scene into connected shots and passes inspection with every word spoken', async () => {
    const { log, save } = reporter('01-dialogue-overflow');
    const owner = await studioOwner();
    const projectId = await qaProject(owner, 'dialogue', 'Dialogue overflow', 'film');
    for (const c of [AMA, KOFI]) await qaCharacter(projectId, c);
    const directions = await qaShot(projectId, 'reef', SHOT);
    const job = shotVideoJob(projectId, 'reef', SHOT, directions, [AMA, KOFI], true);

    const est = await production.estimateProduction(owner, payload('estimateProduction', { projectId, shotId: 'reef', job, options: { requestedSec: 8 } }));
    log(`estimate: requested ${est.plan.requestedSec} s, required ${est.plan.requiredSec} s (text estimate) — ${est.plan.message} ≈ $${est.estimate.usd}`);
    expect(est.plan.requiredSec).toBeGreaterThan(8);

    const started = await production.startProduction(owner, payload('startProduction', { projectId, shotId: 'reef', job, options: { requestedSec: 8 }, confirmedUsd: est.estimate.usd }));
    log(`production ${started.productionId} started in project ${projectId}`);
    await runProduction(owner, started.productionId, log);
    const rec = await productionRecord(started.productionId);
    save(rec);

    // Duration intelligence from the measured guide audio.
    expect(rec.dialogueAudio.mode).toBe('generated');
    for (const l of rec.dialogueAudio.lines) expect(l.seconds).toBeGreaterThan(0);
    expect(rec.plan?.requestedSec).toBe(8);
    expect(rec.plan?.requiredSec).toBeGreaterThan(8);
    expect(['extend_chain', 'lengthened']).toContain(rec.plan?.strategy);

    // The version awaiting approval passed inspection with the complete dialogue.
    const final = currentVersion(rec)!;
    log(`final: version ${final.version.index} (${final.version.label}) ${final.report?.overall}/100 passed=${final.report?.passed}; heard "${final.report?.dialogue.detectedText}"`);
    expect(rec.status).toBe('awaiting_review');
    expect(final.report?.passed).toBe(true);
    expect(final.report?.dialogue.dialogueComplete).toBe(true);
    expect(final.report?.dialogue.missingWords).toEqual([]);
    expect(final.report?.dialogue.truncatedFinalWord).toBe(false);

    // The director approves it.
    await production.productionAction(owner, payload('productionAction', { productionId: started.productionId, action: 'approve', versionId: final.version.id }));
    expect((await loadProductionDoc(started.productionId)).status).toBe('approved');
    save(await productionRecord(started.productionId));
  });
});
