import { describe, expect, it } from 'vitest';
import { actionBeats, estimateSpeechSeconds, planSceneDuration, segmentTimingDirections, splitSentences, type PlanLine } from '../src/duration';
import { analyzeDialogue, chooseRepair, DEFAULT_QUALITY_SETTINGS, evaluateQuality, isBlocking, parseOffset, type DetectedWord, type ModelReview, type RepairContext } from '../src/quality';
import { decideAfterInspection, screenCompositeForPassedTake } from '../src/production';
import { alignWords, normalizeWord, tokenize } from '../src/text-align';

const CAPS = { minSec: 3, maxSec: 10, maxChainSec: 40 };

/** Word timings as a transcription model returns them (evenly spoken from `start`). */
function speak(text: string, start: number, perWord = 0.42): DetectedWord[] {
  return tokenize(text).map((t, i) => ({ text: t.raw, start: +(start + i * perWord).toFixed(3), end: +(start + (i + 1) * perWord - 0.05).toFixed(3) }));
}

const goodReview = (over: Partial<ModelReview> = {}): ModelReview => ({
  summary: 'Clean take.',
  speakerAttribution: [],
  lipSync: { applicable: true, drift: 'none', note: '' },
  performanceFinished: true,
  dialogueOverMusic: 'clear',
  abruptCutDuringSpeech: false,
  actions: [{ beat: 'Ama turns to Kofi', completed: true, startSec: 0.5, endSec: 2, note: '' }],
  actionComplete: true,
  unfinishedMovementAtEnd: false,
  continuity: [{ aspect: 'costume', ok: true, severity: 'none', note: '' }],
  cameraMatchesDirection: true,
  screenDirectionConsistent: true,
  emotionalPerformanceMatches: true,
  renderedText: { present: false, acceptable: true, note: '' },
  artefacts: [],
  suddenDisappearance: false,
  accidentalSceneChange: false,
  firstFrame: { quality: 'good', note: '' },
  lastFrame: { quality: 'good', note: '' },
  scores: { actionCompleteness: 92, visualAccuracy: 88, characterContinuity: 90, audioQuality: 86, storyContinuity: 90, overallUsability: 89 },
  problems: [],
  recommendedRepair: null,
  ...over,
});

const measurements = (durationSec: number, cuts: number[] = []) => ({
  durationSec,
  fps: 24,
  hasAudio: true,
  audio: { peakDbfs: -3, clippedRatio: 0, endLevelDb: -40, speechAtEnd: false, integratedLufs: -18 },
  visual: { sceneCuts: cuts, blackSegments: [], endMotionRatio: 0.6, frozenAtEnd: false },
});

describe('text alignment', () => {
  it('normalises accents, West African letters and numbers for matching only', () => {
    expect(normalizeWord('Begun.')).toBe('begun');
    expect(normalizeWord('Ɛŋɔ́')).toBe('engo');
    expect(normalizeWord('three')).toBe('3');
    expect(tokenize('We have—crossed the reef, but…').map((t) => t.raw)).toEqual(['We', 'have', 'crossed', 'the', 'reef,', 'but…']);
  });

  it('aligns with matches, substitutions, deletions and insertions', () => {
    const ops = alignWords(['we', 'have', 'crossed', 'the', 'reef'], ['we', 'we', 'have', 'crost', 'reef']);
    const count = (k: string) => ops.filter((o) => o.op === k).length;
    expect([count('match'), count('insert'), count('substitute'), count('delete')]).toEqual([3, 1, 1, 1]);
    expect(ops.find((o) => o.op === 'substitute')).toMatchObject({ e: 2, d: 3 });
  });
});

describe('scene-duration intelligence', () => {
  const lines: PlanLine[] = [
    { index: 0, character: 'AMA', text: 'We have crossed the reef, but the journey has only begun. The tide will turn before nightfall, and we must be ready.', seconds: 7.2, measured: true },
    { index: 1, character: 'KOFI', text: 'Then we sail at first light. Tell the others to rest while they still can.', seconds: 4.6, measured: true },
  ];

  it('treats the selected duration as a preference and plans connected shots for dialogue overflow', () => {
    const plan = planSceneDuration({ lines, action: 'Ama turns from the railing to face Kofi.', requestedSec: 8, ensureCompleteDialogue: true, ensureCompleteAction: true, caps: CAPS });
    expect(plan.requestedSec).toBe(8);
    expect(plan.requiredSec).toBeGreaterThan(12);
    expect(plan.strategy).toBe('extend_chain');
    expect(plan.segments.length).toBe(2);
    expect(plan.message).toBe('AZ Studio will create two connected shots to complete this scene.');
    expect(plan.measured).toBe(true);
    for (const s of plan.segments) {
      expect(s.durationSec).toBeGreaterThanOrEqual(3);
      expect(s.durationSec).toBeLessThanOrEqual(10);
    }
    expect(plan.plannedSec).toBeGreaterThanOrEqual(plan.requiredSec);
    // Cuts happen only between whole sentences — never mid-sentence.
    const spoken = plan.segments.flatMap((s) => s.units.map((u) => u.text));
    expect(spoken).toEqual([...splitSentences(lines[0]!.text), ...splitSentences(lines[1]!.text)]);
    expect(plan.segments[1]!.camera).toMatch(/reaction shot|Cut to/);
    const directions = segmentTimingDirections(plan, plan.segments[1]!);
    expect(directions.join(' ')).toMatch(/hold on the characters/);
  });

  it('lengthens a single shot when the requirement fits one generation', () => {
    const plan = planSceneDuration({ lines: [{ index: 0, character: 'AMA', text: 'Hold the line.', seconds: 6.4, measured: true }], action: '', requestedSec: 6, ensureCompleteDialogue: true, ensureCompleteAction: true, caps: CAPS });
    expect(plan.strategy).toBe('lengthened');
    expect(plan.requiredSec).toBe(8);
    expect(plan.plannedSec).toBe(8);
    expect(plan.segments).toHaveLength(1);
  });

  it('keeps the requested duration when it is already long enough', () => {
    const plan = planSceneDuration({ lines: [{ index: 0, character: 'AMA', text: 'Now.', seconds: 0.6, measured: false }], action: '', requestedSec: 8, ensureCompleteDialogue: true, ensureCompleteAction: true, caps: CAPS });
    expect(plan.strategy).toBe('single');
    expect(plan.plannedSec).toBe(8);
  });

  it('refuses to force an over-long sentence into one generation', () => {
    const plan = planSceneDuration({ lines: [{ index: 0, character: 'NARRATOR', text: 'A single sentence that goes on and on without any pause at all for breath or thought or anything', seconds: 12, measured: true }], action: '', requestedSec: 8, ensureCompleteDialogue: true, ensureCompleteAction: true, caps: CAPS });
    expect(plan.blocked).toMatch(/never cuts a character off mid-sentence/);
  });

  it('adds time for action that continues after speech', () => {
    expect(actionBeats('A character opening a door, entering and closing it.')).toBe(3);
    const plan = planSceneDuration({ lines: [], action: 'A character opening a door, entering and closing it.', requestedSec: 4, ensureCompleteDialogue: true, ensureCompleteAction: true, caps: CAPS });
    expect(plan.breakdown.actionTailSec).toBeCloseTo(4.5);
    expect(plan.plannedSec).toBeGreaterThanOrEqual(6);
    const off = planSceneDuration({ lines: [], action: 'A character opening a door, entering and closing it.', requestedSec: 4, ensureCompleteDialogue: false, ensureCompleteAction: false, caps: CAPS });
    expect(off.plannedSec).toBe(4);
  });

  it('estimates speech length from the text when no audio exists', () => {
    const a = estimateSpeechSeconds('We have crossed the reef, but the journey has only begun.');
    expect(a).toBeGreaterThan(3.5);
    expect(a).toBeLessThan(6);
    expect(estimateSpeechSeconds('Go.')).toBeLessThan(a);
  });
});

describe('dialogue-completion validation', () => {
  const expected = [{ index: 0, character: 'AMA', text: 'We have crossed the reef, but the journey has only begun.' }];

  it('detects a cut-off final word (the spec example)', () => {
    const words = speak('We have crossed the reef, but the journey has only', 3.6);
    words[words.length - 1]!.end = 7.82;
    const a = analyzeDialogue({ expected, words, durationSec: 7.9, speechAtEnd: true });
    expect(a.dialogueComplete).toBe(false);
    expect(a.missingWords).toEqual(['begun']);
    expect(a.truncatedFinalWord).toBe(true);
    expect(a.cutoffTime).toBe(7.82);
    expect(a.recommendedRepair).toBe('extend_scene');
    expect(a.problems.find((p) => p.category === 'dialogue_truncated')?.severity).toBe('critical');
  });

  it('detects a word chopped mid-way', () => {
    const words = [...speak('We have crossed the reef, but the journey has only', 1), { text: 'beg', start: 5.9, end: 6.0 }];
    const a = analyzeDialogue({ expected, words, durationSec: 6.02 });
    expect(a.truncatedFinalWord).toBe(true);
    expect(a.missingWords).toEqual(['begun']);
    expect(a.alteredWords).toEqual([]);
  });

  it('passes complete dialogue with breathing room', () => {
    const a = analyzeDialogue({ expected, words: speak('We have crossed the reef, but the journey has only begun.', 0.7), durationSec: 7 });
    expect(a.dialogueComplete).toBe(true);
    expect(a.score).toBeGreaterThanOrEqual(95);
    expect(a.trailingRoomSec).toBeGreaterThan(1);
  });

  it('reports missing, changed and repeated words, early starts and no trailing room', () => {
    const words = speak('We we have crossed a boat but the journey has begun.', 0.02);
    const a = analyzeDialogue({ expected, words, durationSec: words[words.length - 1]!.end + 0.2 });
    const cats = a.problems.map((p) => p.category);
    expect(cats).toEqual(expect.arrayContaining(['dialogue_missing', 'dialogue_repeated', 'dialogue_early', 'trailing_room']));
    expect(a.missingWords).toEqual(expect.arrayContaining(['only']));
    expect(a.repeatedWords.map((w) => w.toLowerCase())).toEqual(['we']);
    expect(a.dialogueComplete).toBe(false);
  });

  it('is not applicable when the shot has no dialogue', () => {
    const a = analyzeDialogue({ expected: [], words: [], durationSec: 6 });
    expect(a.applicable).toBe(false);
    expect(a.score).toBeNull();
  });

  it('parses API offsets', () => {
    expect(parseOffset('1.300s')).toBe(1.3);
    expect(parseOffset('2s')).toBe(2);
    expect(parseOffset(undefined)).toBe(0);
  });
});

describe('quality verdict', () => {
  const expected = [{ index: 0, character: 'AMA', text: 'We have crossed the reef, but the journey has only begun.' }];
  const complete = analyzeDialogue({ expected, words: speak(expected[0]!.text, 0.7), durationSec: 7 });

  it('approves only complete scenes at or above the threshold', () => {
    const v = evaluateQuality({ dialogue: complete, review: goodReview(), measurements: measurements(7), settings: DEFAULT_QUALITY_SETTINGS, hasCharacters: true });
    expect(v.passed).toBe(true);
    expect(v.overall).toBeGreaterThanOrEqual(75);
    expect(v.scores.dialogueCompleteness).toBeGreaterThanOrEqual(95);
  });

  it('never approves a truncated scene, even with a generous model score', () => {
    const words = speak('We have crossed the reef, but the journey has only', 3.6);
    const cut = analyzeDialogue({ expected, words, durationSec: words[words.length - 1]!.end + 0.05, speechAtEnd: true });
    const v = evaluateQuality({ dialogue: cut, review: goodReview({ scores: { ...goodReview().scores, overallUsability: 98 } }), measurements: measurements(7.9), settings: DEFAULT_QUALITY_SETTINGS, hasCharacters: true });
    expect(v.passed).toBe(false);
    expect(v.overall).toBeLessThanOrEqual(40);
    expect(v.reasons).toContain('Dialogue is incomplete.');
  });

  it('fails incomplete action and respects waivers', () => {
    const review = goodReview({ actionComplete: false, actions: [{ beat: 'She closes the door', completed: false, startSec: 4, endSec: null, note: 'still open at the end' }], unfinishedMovementAtEnd: true });
    const v = evaluateQuality({ dialogue: complete, review, measurements: measurements(7), settings: DEFAULT_QUALITY_SETTINGS, hasCharacters: true });
    expect(v.passed).toBe(false);
    expect(v.problems.some((p) => p.category === 'action_incomplete' && p.blocking)).toBe(true);
    const waived = evaluateQuality({ dialogue: complete, review, measurements: measurements(7), settings: DEFAULT_QUALITY_SETTINGS, hasCharacters: true, waivedCategories: ['action_incomplete', 'unfinished_movement'] });
    expect(waived.problems.filter((p) => p.blocking)).toEqual([]);
    expect(waived.problems.find((p) => p.category === 'action_incomplete')?.waived).toBeTruthy();
  });

  it('does not treat planned connected-shot cuts as accidental scene changes', () => {
    const planned = evaluateQuality({ dialogue: complete, review: goodReview(), measurements: measurements(14, [8.02]), settings: DEFAULT_QUALITY_SETTINGS, hasCharacters: true, plannedCuts: [8] });
    expect(planned.problems.some((p) => p.category === 'accidental_scene_change')).toBe(false);
    // A measured picture jump the reviewer did not see as a scene change is flagged, not failed…
    const unconfirmed = evaluateQuality({ dialogue: complete, review: goodReview(), measurements: measurements(7, [3.4]), settings: DEFAULT_QUALITY_SETTINGS, hasCharacters: true });
    const flag = unconfirmed.problems.find((p) => p.category === 'accidental_scene_change');
    expect(flag).toMatchObject({ severity: 'minor', blocking: false, source: 'measured', startSec: 3.4 });
    // …while a cut the reviewer confirms fails the scene.
    const confirmed = evaluateQuality({ dialogue: complete, review: { ...goodReview(), accidentalSceneChange: true }, measurements: measurements(7, [3.4]), settings: DEFAULT_QUALITY_SETTINGS, hasCharacters: true });
    expect(confirmed.problems.find((p) => p.category === 'accidental_scene_change')).toMatchObject({ severity: 'major', blocking: true, startSec: 3.4 });
    expect(confirmed.passed).toBe(false);
  });

  it('accepts the reaction-shot cuts a connected shot was directed to make, up to cutting away and back', () => {
    const window = { startSec: 6, endSec: 14, maxCuts: 2, direction: 'Cut to a reaction shot of KOFI while AMA keeps talking, then back to the speaker if natural.' };
    const directed = evaluateQuality({ dialogue: complete, review: goodReview(), measurements: measurements(19, [6.02, 7.5, 9.5]), settings: DEFAULT_QUALITY_SETTINGS, hasCharacters: true, plannedCuts: [6, 14], editorialCuts: [window] });
    expect(directed.problems.some((p) => p.category === 'accidental_scene_change')).toBe(false);
    // A third cut inside the same part, or one outside any directed part, is still reported.
    const choppy = evaluateQuality({ dialogue: complete, review: goodReview(), measurements: measurements(19, [7.5, 9.5, 10.5, 16.3]), settings: DEFAULT_QUALITY_SETTINGS, hasCharacters: true, plannedCuts: [6, 14], editorialCuts: [window] });
    expect(choppy.problems.find((p) => p.category === 'accidental_scene_change')?.description).toMatch(/10\.5 s, 16\.3 s/);
  });

  it('follows the project settings for blocking severity', () => {
    const p = { category: 'costume' as const, severity: 'major' as const, waived: null };
    expect(isBlocking(p, DEFAULT_QUALITY_SETTINGS)).toBe(true);
    expect(isBlocking(p, { ...DEFAULT_QUALITY_SETTINGS, checkContinuity: false })).toBe(false);
    expect(isBlocking({ ...p, severity: 'minor' }, DEFAULT_QUALITY_SETTINGS)).toBe(false);
  });
});

describe('automatic repair selection', () => {
  const expected = [{ index: 0, character: 'AMA', text: 'We have crossed the reef, but the journey has only begun.' }];
  const base = (over: Partial<RepairContext>): RepairContext => ({
    problems: [],
    dialogue: analyzeDialogue({ expected, words: speak(expected[0]!.text, 0.7), durationSec: 7 }),
    review: null,
    version: { durationSec: 7.9, continuable: true, chainSec: 8 },
    expected: { lines: expected, action: 'Ama looks out to sea.' },
    plan: { requiredSec: 7.4, breakdown: { openingSec: 0.6, dialogueSec: 5.1, pausesSec: 0, actionSec: 1.5, actionTailSec: 0, closingSec: 1 } },
    caps: CAPS,
    previous: [],
    ...over,
  });
  const truncated = () => {
    const words = speak('We have crossed the reef, but the journey has only', 3.6);
    return analyzeDialogue({ expected, words, durationSec: words[words.length - 1]!.end + 0.05, speechAtEnd: true });
  };

  it('extends a truncated scene, quoting the missing words without repeating the rest', () => {
    const d = truncated();
    const problems = d.problems.map((p) => ({ ...p, blocking: true }));
    const r = chooseRepair(base({ problems, dialogue: d }))!;
    expect(r.type).toBe('extend_scene');
    expect(r.instruction).toMatch(/begun/);
    expect(r.instruction).toMatch(/Do not repeat any words already spoken/);
    expect(r.durationSec).toBeGreaterThanOrEqual(3);
    expect(r.durationSec).toBeLessThanOrEqual(10);
  });

  it('regenerates longer when the take can no longer be extended, and escalates after a failed extension', () => {
    const d = truncated();
    const problems = d.problems.map((p) => ({ ...p, blocking: true }));
    expect(chooseRepair(base({ problems, dialogue: d, version: { durationSec: 7.9, continuable: false, chainSec: 8 } }))!.type).toBe('regenerate_longer');
    const escalated = chooseRepair(base({ problems, dialogue: d, previous: [{ type: 'extend_scene', categories: ['dialogue_truncated'] }] }))!;
    expect(escalated.type).toBe('regenerate_longer');
    expect(escalated.durationSec).toBeGreaterThanOrEqual(9);
  });

  it('does not extend a take whose speaker skipped words mid-line — continuing cannot put them back', () => {
    const words = speak('We have crossed the journey has only begun.', 0.7);
    const d = analyzeDialogue({ expected, words, durationSec: words[words.length - 1]!.end + 0.05, speechAtEnd: true });
    expect(d.missingWords.length).toBeGreaterThan(0);
    const problems = d.problems.map((p) => ({ ...p, blocking: true }));
    const r = chooseRepair(base({ problems, dialogue: d }))!;
    expect(r.type).not.toBe('extend_scene');
    expect(['regenerate_longer', 'split_into_shots', 'regenerate']).toContain(r.type);
  });

  it('still extends a take that stopped early even when a stray word was matched out of place', () => {
    // Cut off after "only"; the transcriber also caught a stray "the" at the very end.
    const words = [...speak('We have crossed the reef, but the journey has only', 0.7), { text: 'the', start: 5.4, end: 5.5 }];
    const d = analyzeDialogue({ expected, words, durationSec: 5.55, speechAtEnd: true });
    const problems = d.problems.map((p) => ({ ...p, blocking: true }));
    expect(chooseRepair(base({ problems, dialogue: d }))!.type).toBe('extend_scene');
  });

  it('never trims into the action: a fault during the last beat is fixed, not cut away', () => {
    const door = { lines: [], action: 'Esi opens the door, steps through and closes it behind her.' };
    const beats = [
      { beat: 'opens the door', completed: true, startSec: 1, endSec: 3.5, note: '' },
      { beat: 'steps through', completed: true, startSec: 3.5, endSec: 5.5, note: '' },
      { beat: 'closes it behind her', completed: true, startSec: 5.5, endSec: 6.75, note: '' },
    ];
    const silent = analyzeDialogue({ expected: [], words: [], durationSec: 8 });
    const artefact = (at: number) => [{ id: 'a', category: 'visual_artefact' as const, severity: 'major' as const, startSec: at, endSec: null, description: 'Her arm clips through the door.', source: 'model' as const, blocking: true }];
    const review = { recommendedRepair: null, actions: beats };
    // The fault is inside the closing beat (5.5–6.75 s): trimming there would cut the door closing.
    const during = chooseRepair(base({ problems: artefact(5.5), dialogue: silent, review, expected: door, version: { durationSec: 8, continuable: true, chainSec: 8 } }))!;
    expect(during.type).not.toBe('trim_ending');
    // A fault after everything has finished can be trimmed away.
    const afterAll = chooseRepair(base({ problems: artefact(7.7), dialogue: silent, review, expected: door, version: { durationSec: 8.5, continuable: true, chainSec: 8.5 } }))!;
    expect(afterAll).toMatchObject({ type: 'trim_ending' });
    expect(afterAll.durationSec!).toBeGreaterThanOrEqual(6.75);
  });

  it('never proposes a conversational edit for a version longer than Omni can edit', () => {
    const costume = [{ id: 'c', category: 'costume' as const, severity: 'major' as const, startSec: null, endSec: null, description: 'The scarf changes colour.', source: 'model' as const, blocking: true }];
    const r = chooseRepair(base({ problems: costume, version: { durationSec: 17, continuable: true, chainSec: 17 } }));
    expect(r?.type).not.toBe('conversational_edit');
  });

  it('splits a scene too long for one generation into connected shots, at most twice', () => {
    const d = truncated();
    const problems = d.problems.map((p) => ({ ...p, blocking: true }));
    const long = { requiredSec: 15.4, breakdown: { openingSec: 0.6, dialogueSec: 13.8, pausesSec: 0, actionSec: 0, actionTailSec: 0, closingSec: 1 } };
    const extendTried = { type: 'extend_scene' as const, categories: ['dialogue_truncated' as const] };
    const splitTried = { type: 'split_into_shots' as const, categories: ['dialogue_truncated' as const] };
    expect(chooseRepair(base({ problems, dialogue: d, plan: long, previous: [extendTried] }))!.type).toBe('split_into_shots');
    expect(chooseRepair(base({ problems, dialogue: d, plan: long, previous: [extendTried, splitTried] }))!.type).toBe('split_into_shots');
    // After two attempts the loop stops and the director decides — it never repeats itself indefinitely.
    expect(chooseRepair(base({ problems, dialogue: d, plan: long, previous: [extendTried, splitTried, splitTried] }))).toBeNull();
  });

  it('edits picture-only problems conversationally and keeps the dialogue', () => {
    const r = chooseRepair(base({ problems: [{ id: 'c', category: 'costume', severity: 'major', startSec: null, endSec: null, description: 'Ama’s scarf changes colour.', source: 'model', blocking: true }] }))!;
    expect(r.type).toBe('conversational_edit');
    expect(r.keepAudio).toBe(true);
    expect(r.instruction).toMatch(/scarf/);
  });

  it('covers a short local fault with a cutaway while the dialogue plays on', () => {
    const r = chooseRepair(base({ problems: [{ id: 'a', category: 'visual_artefact', severity: 'major', startSec: 2.1, endSec: 3.0, description: 'A hand warps.', source: 'model', blocking: true }] }))!;
    expect(r.type).toBe('cutaway');
    expect(r.keepAudio).toBe(true);
    expect(r.sectionStartSec).toBeCloseTo(1.9);
    expect(r.sectionEndSec).toBeCloseTo(3.2);
  });

  it('trims unwanted material after a completed scene (free repair)', () => {
    const review = { recommendedRepair: null, actions: [{ beat: 'Ama looks out to sea', completed: true, startSec: 1, endSec: 6.5, note: '' }] };
    const r = chooseRepair(base({ review, version: { durationSec: 9.9, continuable: true, chainSec: 10 }, problems: [{ id: 's', category: 'accidental_scene_change', severity: 'major', startSec: 8.9, endSec: 9.9, description: 'Cut to a new scene.', source: 'measured', blocking: true }] }))!;
    expect(r.type).toBe('trim_ending');
    expect(r.durationSec).toBeCloseTo(8.85);
    // Without the reviewer's beat timing the scene is never trimmed blind.
    expect(chooseRepair(base({ review: null, version: { durationSec: 9.9, continuable: true, chainSec: 10 }, problems: [{ id: 's', category: 'accidental_scene_change', severity: 'major', startSec: 8.9, endSec: 9.9, description: 'Cut to a new scene.', source: 'measured', blocking: true }] }))?.type).not.toBe('trim_ending');
  });

  it('respects repair limits, cost ceiling and expensive-retry approval', () => {
    const repair = { type: 'extend_scene' as const, reason: 'x', instruction: 'y', durationSec: 4, sectionStartSec: null, sectionEndSec: null, keepAudio: false };
    const s = DEFAULT_QUALITY_SETTINGS;
    expect(decideAfterInspection({ passed: true, settings: s, repairCount: 0, spentUsd: 1, repair: null, repairEstimateUsd: null }).action).toBe('await_review');
    expect(decideAfterInspection({ passed: false, settings: s, repairCount: 0, spentUsd: 1, repair, repairEstimateUsd: 0.6 }).action).toBe('repair');
    expect(decideAfterInspection({ passed: false, settings: s, repairCount: 3, spentUsd: 1, repair, repairEstimateUsd: 0.6 }).action).toBe('fail');
    expect(decideAfterInspection({ passed: false, settings: s, repairCount: 1, spentUsd: 5.8, repair, repairEstimateUsd: 0.6 })).toMatchObject({ action: 'await_repair_approval', waitingFor: 'cost_ceiling' });
    expect(decideAfterInspection({ passed: false, settings: s, repairCount: 1, spentUsd: 1, repair, repairEstimateUsd: 2.1 })).toMatchObject({ action: 'await_repair_approval', waitingFor: 'expensive_retry' });
    expect(decideAfterInspection({ passed: false, settings: { ...s, autoFixIncomplete: false }, repairCount: 0, spentUsd: 1, repair, repairEstimateUsd: 0.6 }).action).toBe('fail');
    expect(decideAfterInspection({ passed: false, settings: s, repairCount: 1, spentUsd: 1, repair: null, repairEstimateUsd: null }).action).toBe('fail');
  });

  it('composites a protected screen onto a passing take once', () => {
    const blank = [{ category: 'wrong_screen_content' as const }];
    const composite = screenCompositeForPassedTake({ problems: blank, compositeScreenIds: ['phone'], triedTypes: [] });
    expect(composite).toMatchObject({ type: 'screen_composite', keepAudio: true, data: { screenIds: ['phone'] } });
    // Never again once a composite was made or tried, never without an approved screen, never without a text problem.
    expect(screenCompositeForPassedTake({ problems: blank, compositeScreenIds: ['phone'], triedTypes: ['screen_composite'] })).toBeNull();
    expect(screenCompositeForPassedTake({ problems: blank, compositeScreenIds: [], triedTypes: [] })).toBeNull();
    expect(screenCompositeForPassedTake({ problems: [{ category: 'lighting_flicker' as const }], compositeScreenIds: ['phone'], triedTypes: [] })).toBeNull();
  });
});
