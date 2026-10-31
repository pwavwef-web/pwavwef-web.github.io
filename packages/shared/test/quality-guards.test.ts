import { describe, expect, it } from 'vitest';
import {
  activeAreaFromCropdetect,
  adStyleLines,
  applySpeechRespellings,
  checkFacts,
  checkTakeLength,
  compileLiteImageRequest,
  correctMishearings,
  defaultAdSpec,
  defaultLiteSpec,
  deliveryDirection,
  evaluateAdScene,
  evaluateQuality,
  extractFigures,
  factFindings,
  factsFromLinkAd,
  framingProblem,
  guardSpeech,
  guardSpokenText,
  likenessBlocksAutoApproval,
  likenessFailures,
  likenessPrompt,
  likenessSubjects,
  lintBrief,
  newScene,
  newShot,
  noLogoClause,
  normalizeAdSpec,
  normalizeLikenessVerdict,
  ocrConfirms,
  protectedTermList,
  reconcileTranscript,
  SEED_PRONUNCIATIONS,
  settleFinalModelFindings,
  settleTextProblems,
  spokenNumbersToDigits,
  summarizeTextEvidence,
  transcriptionVocabulary,
  finding,
  type ApprovedFact,
  type QualityProblem,
} from '../src';

describe('speech guard', () => {
  it('removes punctuation the speech model reads as instructions, never words', () => {
    const g = guardSpokenText('Price: GH₵450; call now! [laughs] *Fresh* honey (from Tamale) — "pure" and/or raw.');
    expect(g.text).toBe('Price, GH₵450, call now! Fresh honey, from Tamale, — pure and or raw.');
    expect(g.text).not.toMatch(/[:;*[\]"]/);
    expect(g.changes.join(' ')).toMatch(/stage note \[laughs\]/);
    expect(guardSpokenText('Open 24/7 at 10:30.').text).toBe('Open 24/7 at 10 30.');
    expect(guardSpokenText("Don't stop.").changes).toEqual([]);
  });

  it('flags lines about speech or transcription (the voice improvises on them)', () => {
    expect(guardSpokenText('The transcription model hears every word.').flags[0]).toMatch(/meta_text/);
    expect(guardSpokenText('Welcome to the market.').flags).toEqual([]);
  });

  it('reduces a direction to delivery: no pronunciation notes, no colons, capped', () => {
    const d = deliveryDirection('Tone: warm and unhurried. Pronounce Kasem as KAH-sem. Say the word exactly as written. Slight Ghanaian accent.');
    expect(d.direction).toBe('Tone, warm and unhurried. Slight Ghanaian accent.');
    expect(d.direction).not.toMatch(/:/);
    expect(d.dropped).toHaveLength(2);
    expect(deliveryDirection('Say it warmly, with a smile.').direction).toBe('Say it warmly, with a smile.');
    expect(deliveryDirection('Calm. '.repeat(60)).direction.length).toBeLessThanOrEqual(160);
  });

  it('builds the prompt with exactly one colon', () => {
    const p = guardSpeech('Call: 024 123 4567', 'Friendly: upbeat');
    expect(p.prompt).toBe('Friendly, upbeat: Call, 024 123 4567');
    expect(p.prompt.match(/:/g)).toHaveLength(1);
  });

  it('flags a take whose pace is implausible (improvised pitch, read-aloud direction, half a line)', () => {
    expect(checkTakeLength('Fresh honey, every day.', 20).verdict).toBe('too_long');
    expect(checkTakeLength('Yes.', 14).verdict).toBe('too_long');
    expect(checkTakeLength('Fresh honey, every day.', 1.6).verdict).toBe('ok');
    expect(checkTakeLength('Yes.', 0.5).verdict).toBe('ok'); // a short line may be slow
    expect(checkTakeLength('We deliver fresh honey from Tamale to your door every single morning of the week.', 1.2).verdict).toBe('too_short');
    expect(checkTakeLength('Hello there.', null).verdict).toBe('no_speech');
  });
});

describe('protected words', () => {
  it('builds one deduplicated transcription vocabulary with the shared list first', () => {
    const v = transcriptionVocabulary(['Kasem', 'Ama Serwaa', 'kasem']);
    expect(v.slice(0, 3)).toEqual(['Francis Pwavwe', 'Pwavwe', 'Francis']);
    expect(v).toContain('Ama Serwaa');
    expect(v.filter((x) => x.toLowerCase() === 'kasem')).toHaveLength(1);
    expect(transcriptionVocabulary(Array.from({ length: 200 }, (_, i) => `Name${i}`), 50)).toHaveLength(50);
    expect(protectedTermList(['Ama'], { shared: false })).toEqual(['Ama']);
  });

  it('respells letter-by-letter acronyms for the voice only, longest term first; project respellings win', () => {
    expect(applySpeechRespellings('Join UCC SRC at UCC with AZ Studio.')).toBe('Join U C C, S R C at U C C with A Z Studio.');
    expect(applySpeechRespellings('Visit GTHRC', [{ term: 'GTHRC', sayAs: 'Gee Tee' }])).toBe('Visit Gee Tee');
    expect(applySpeechRespellings('UCCX stays')).toBe('UCCX stays');
  });

  it('corrects known mishearings of expected terms', () => {
    const r = correctMishearings(
      [
        { text: 'Learn', start: 0, end: 0.3 },
        { text: 'Casa', start: 0.3, end: 0.7 },
        { text: 'on', start: 0.7, end: 0.8 },
        { text: 'Within', start: 0.8, end: 1.1 },
        { text: 'World.', start: 1.1, end: 1.5 },
      ],
      ['Kasem', 'Indigen World'],
    );
    expect(r.words.map((w) => w.text)).toEqual(['Learn', 'Kasem', 'on', 'Indigen World.']);
    expect(r.words[3]).toMatchObject({ start: 0.8, end: 1.5 });
    expect(correctMishearings([{ text: 'Casa', start: 0, end: 1 }], []).words[0]!.text).toBe('Casa');
  });

  it('reconciled transcripts keep shared terms the script uses, even when misheard', () => {
    const asr = [
      { text: 'Made', start: 0, end: 0.3 },
      { text: 'with', start: 0.3, end: 0.5 },
      { text: 'A', start: 0.5, end: 0.6 },
      { text: 'Studio', start: 0.6, end: 1.1 },
      { text: 'in', start: 1.1, end: 1.2 },
      { text: 'Kassa.', start: 1.2, end: 1.7 },
    ];
    const { sheet, report } = reconcileTranscript(asr, 'Made with AZ Studio in Kasem.', { durationSec: 2 });
    expect(sheet.lines.map((l) => l.text).join(' ')).toBe('Made with AZ Studio in Kasem.');
    expect(report.protectedTerms.map((t) => t.term).sort()).toEqual(['AZ Studio', 'Kasem']);
    expect(report.corrected.find((c) => c.written === 'Kasem')).toMatchObject({ heard: 'Kassa.', kind: 'protected_term' });
    // Without a script, a mishearing is corrected only for terms the project names.
    expect(reconcileTranscript([{ text: 'Casa', start: 0, end: 0.5 }], null, { durationSec: 1, protectedTerms: ['Kasem'] }).sheet.lines[0]!.text).toBe('Kasem');
    expect(reconcileTranscript([{ text: 'Casa', start: 0, end: 0.5 }], null, { durationSec: 1 }).sheet.lines[0]!.text).toBe('Casa');
  });

  it('seeds the Narrator notebook from the shared list (same names and order, nothing guessed)', () => {
    expect(SEED_PRONUNCIATIONS.map((p) => [p.id, p.term, p.spokenAs])).toEqual([
      ['seed-1', 'Francis Pwavwe', ''],
      ['seed-2', 'The Pwavwe Papers', ''],
      ['seed-3', 'Indigen World', ''],
      ['seed-4', 'Kasem', ''],
      ['seed-5', 'University of Cape Coast', ''],
    ]);
  });
});

describe('OCR settles text and logo findings', () => {
  const none = summarizeTextEvidence(Array.from({ length: 8 }, () => ({ text: [], logos: [] })), { logoChecked: true });
  const sign = summarizeTextEvidence(
    [
      { text: [{ text: 'BAKERY', box: { h: 0.04 } }], logos: [] },
      { text: [{ text: 'BAKERY', box: { h: 0.04 } }], logos: [] },
    ],
    { logoChecked: true },
  );

  it('confirms only what recognition read', () => {
    expect(ocrConfirms('text', none).confirmed).toBe(false);
    expect(ocrConfirms('text', sign).confirmed).toBe(true);
    expect(ocrConfirms('logo', summarizeTextEvidence([{ text: [], logos: [{ name: 'Honda', score: 0.9 }] }])).confirmed).toBe(true);
    expect(ocrConfirms('text', null).confirmed).toBeNull();
    expect(summarizeTextEvidence([{ text: [{ text: 'Fresh', box: { h: 0.1 } }, { text: 'BAKERY', box: { h: 0.1 } }] }], { ignore: ['Fresh honey'] }).words.map((w) => w.text)).toEqual(['BAKERY']);
  });

  it('makes an unconfirmed scene-inspection text finding minor (non-blocking), keeps measured ones', () => {
    const p = (category: QualityProblem['category'], source: QualityProblem['source'], description: string): QualityProblem => ({ id: category, category, severity: 'major', startSec: null, endSec: null, description, source, blocking: false });
    const problems = [p('rendered_text', 'model', 'Subtitles appear at the bottom.'), p('reversed_logo', 'model', 'Reversed logo on the van.'), p('misspelled_text', 'measured', 'Sign misspelled.'), p('face_change', 'model', 'Face differs.')];
    settleTextProblems(problems, none);
    expect(problems.map((x) => x.severity)).toEqual(['minor', 'minor', 'major', 'major']);
    expect(problems[0]!.description).toMatch(/not confirmed/);
    const kept = [p('rendered_text', 'model', 'A shop sign reads “BAKERY”.')];
    settleTextProblems(kept, sign);
    expect(kept[0]!.severity).toBe('major');
  });

  it('applies the rule inside evaluateQuality from the frames already annotated', () => {
    const review = {
      speakerAttribution: [],
      lipSync: { applicable: false, drift: 'none', note: '' },
      performanceFinished: true,
      abruptCutDuringSpeech: false,
      dialogueOverMusic: 'clear',
      actions: [],
      actionComplete: true,
      unfinishedMovementAtEnd: false,
      continuity: [],
      cameraMatchesDirection: true,
      screenDirectionConsistent: true,
      emotionalPerformanceMatches: true,
      renderedText: { present: true, acceptable: false, note: 'subtitles at the bottom of the frame' },
      artefacts: [],
      suddenDisappearance: false,
      accidentalSceneChange: false,
      firstFrame: { quality: 'good', note: '' },
      lastFrame: { quality: 'good', note: '' },
      problems: [],
      scores: { visualAccuracy: 80, characterContinuity: null, storyContinuity: 80, audioQuality: 80, actionCompleteness: 80, overallUsability: 80 },
    } as never;
    const base = { durationSec: 6, fps: 24, hasAudio: true, audio: null, visual: { sceneCuts: [], blackSegments: [] }, temporal: null, colour: null } as never;
    const dialogue = { applicable: false, problems: [], dialogueComplete: true, truncatedFinalWord: false, score: 100 } as never;
    const settings = { minApprovalScore: 70, ensureCompleteDialogue: true, ensureCompleteAction: true, checkContinuity: true } as never;
    const withVision = evaluateQuality({ dialogue, review, measurements: { ...(base as object), vision: { frames: [{ t: 0, faces: [], people: [], objects: [], text: [] }, { t: 1, faces: [], people: [], objects: [], text: [] }], screenText: [] } } as never, settings, hasCharacters: false });
    expect(withVision.problems.find((x) => x.category === 'rendered_text')).toMatchObject({ severity: 'minor', blocking: false });
    const noVision = evaluateQuality({ dialogue, review, measurements: { ...(base as object), vision: null } as never, settings, hasCharacters: false });
    expect(noVision.problems.find((x) => x.category === 'rendered_text')).toMatchObject({ severity: 'major', blocking: true });
  });

  it('settles the final-film reviewer: watermark needs a logo or foreign text, captions do not count', () => {
    const findings = [finding('watermark', 'error', 'A logo appears in the corner.', 'model', { startSec: 10 }), finding('private_information', 'error', 'A phone number is visible.', 'model', { startSec: 3 }), finding('lyric_cropped', 'error', 'Lyric cut off.', 'model', { startSec: 20 })];
    const ocr = [
      { t: 3, words: [{ text: 'Fresh', box: { h: 0.05 } }, { text: 'honey', box: { h: 0.05 } }] },
      { t: 10, words: [], logos: [] },
      { t: 11, words: [], logos: [] },
    ];
    const out = settleFinalModelFindings(findings, ocr, { ownText: () => ['Fresh honey'], logoChecked: true });
    expect(out.map((f) => f.severity)).toEqual(['info', 'info', 'info']);
    const logo = settleFinalModelFindings(findings.slice(0, 1), [{ t: 10, words: [], logos: [{ name: 'Nike', score: 0.8 }] }], { ownText: () => [], logoChecked: true });
    expect(logo[0]!.severity).toBe('error');
  });
});

describe('brand safety', () => {
  it('flags brand-prone objects and brand names, and proposes safer wording', () => {
    const l = lintBrief('A young man rides a motorbike past a shop, checking his phone, holding a can of Coca-Cola.');
    expect(l.risks.map((r) => r.group)).toEqual(['vehicle', 'phone', 'drink']);
    expect(l.brands).toEqual(['Coca-Cola']);
    expect(l.saferText).toMatch(/plain unbranded motorbike/);
    expect(l.saferText).toMatch(/plain unbranded phone/);
    expect(l.saferText).not.toMatch(/Coca-Cola/);
    expect(l.warnings.length).toBe(4);
    expect(lintBrief('A plain unbranded motorbike, no logos or lettering.').risks).toEqual([]);
    expect(lintBrief('An old woman smiles under a baobab tree.').warnings).toEqual([]);
  });

  it('adds the matching no-logo clause to compiled prompts only when needed', () => {
    expect(noLogoClause('A farmer walks to the field.')).toBe('');
    expect(noLogoClause('A farmer on a motorbike')).toMatch(/vehicles with no badges/);
    const brief = defaultAdSpec().brief;
    expect(adStyleLines(brief, 'A man in sneakers').join(' ')).toMatch(/footwear with no swooshes/);
    expect(adStyleLines(brief, 'A quiet river').join(' ')).not.toMatch(/Brand safety/);
    const spec = defaultLiteSpec();
    const shot = newShot({ brief: 'A girl holding a smartphone' });
    const req = compileLiteImageRequest(spec, newScene({ shots: [shot] }), shot);
    expect(req.prompt).toMatch(/devices with no maker logos/);
    const calm = newShot({ brief: 'A calm lake at dawn' });
    expect(compileLiteImageRequest(spec, newScene({ shots: [calm] }), calm).prompt).not.toMatch(/Brand safety/);
  });

  it('detects bars and insets from cropdetect and fails such a take', () => {
    const stderr = ['crop=1080:1216:0:352', 'crop=1080:1216:0:352', 'crop=1080:1920:0:0'].map((c) => `[Parsed_cropdetect_1 @ 0x] x1:0 ${c}`).join('\n');
    const area = activeAreaFromCropdetect(stderr, 1080, 1920)!;
    expect(area).toEqual({ w: 1, h: 0.633 });
    expect(framingProblem(area)).toMatch(/letterbox/);
    expect(framingProblem({ w: 0.7, h: 0.7 })).toMatch(/picture-in-picture/);
    expect(framingProblem({ w: 0.98, h: 1 })).toBeNull();
    const measurements = { durationSec: 9, width: 1080, height: 1920, fps: 24, decodeErrors: 0, blackSec: 0, activeArea: area };
    const v = evaluateAdScene({ kind: 'generated_video', windowSec: 8, neededSec: 8, expectedAspect: '9:16', outputHeight: 1920, measurements, probeOk: true, review: null, modelId: null });
    expect(v.verdict).toBe('fail');
    expect(v.checks.find((c) => c.id === 'full_frame')).toMatchObject({ ok: false, severity: 'error' });
    const byReviewer = evaluateAdScene({ kind: 'generated_video', windowSec: 8, neededSec: 8, expectedAspect: '9:16', outputHeight: 1920, measurements: { ...measurements, activeArea: { w: 1, h: 1 } }, probeOk: true, review: { matchesBrief: 80, summary: '', issues: [{ type: 'not_full_frame', severity: 'major', note: 'A smaller copy of the shot sits inside a blurred border.' }] }, modelId: 'r' });
    expect(byReviewer.verdict).toBe('fail');
  });
});

describe('likeness lock', () => {
  const chars = [
    { id: 'c1', name: 'Ama', refAssetIds: ['a1', 'a2', 'a3'], clothing: 'Indigo kente wrap' },
    { id: 'c2', name: 'Kofi', refAssetIds: [], clothing: '' },
  ];

  it('checks only characters with references, first two references each', () => {
    const s = likenessSubjects(chars, { outfitFromText: true });
    expect(s).toEqual([{ characterId: 'c1', name: 'Ama', assetIds: ['a1', 'a2'], outfit: 'Indigo kente wrap', outfitFromText: true }]);
    expect(likenessPrompt(s)).toMatch(/Images 2, 3: approved likeness references of Ama/);
  });

  it('never passes a still the reviewer did not fully judge, and fails a face or outfit mismatch', () => {
    const s = likenessSubjects(chars, { outfitFromText: false });
    expect(normalizeLikenessVerdict({ characters: [{ name: 'Ama', visible: true, faceMatch: true, outfitMatch: true, differences: [] }] }, s, { modelId: 'm', at: 1 }).verdict).toBe('pass');
    const fail = normalizeLikenessVerdict({ characters: [{ name: 'Ama', visible: true, faceMatch: true, outfitMatch: false, differences: ['red dress instead of indigo wrap'] }] }, s, { modelId: 'm' });
    expect(fail).toMatchObject({ verdict: 'fail', outfitMatch: false, differences: ['Ama: red dress instead of indigo wrap'] });
    expect(likenessBlocksAutoApproval(fail)).toBe(true);
    expect(normalizeLikenessVerdict({}, s, { modelId: 'm' }).verdict).toBe('unchecked');
    expect(likenessFailures({ x: { likeness: fail }, y: { likeness: null } })).toEqual({ x: 'Ama: red dress instead of indigo wrap' });
  });

  it('compiled Lite requests carry the subjects without changing the input hash', () => {
    const spec = defaultLiteSpec();
    const shot = newShot({ characterIds: ['c1'] });
    const base = newScene({ shots: [shot] });
    const ama = (refAssetIds: string[]) => ({ ...spec, bible: { ...spec.bible, characters: [{ id: 'c1', name: 'Ama', description: 'A woman', clothing: '', refAssetIds }] } }) as never;
    const r = compileLiteImageRequest(ama(['a1']), base, shot);
    expect(r.likeness?.[0]).toMatchObject({ name: 'Ama', assetIds: ['a1'] });
    const { likeness: _l, ...rest } = r;
    void _l;
    expect(r.hash).toBe(compileLiteImageRequest(ama(['a1']), base, shot).hash);
    expect(Object.keys(rest)).not.toContain('likeness');
    expect(compileLiteImageRequest(ama([]), base, shot).likeness).toBeUndefined();
  });
});

describe('fact check', () => {
  const facts: ApprovedFact[] = [
    { id: 'p', kind: 'price', value: 'GH₵450', label: 'One jar' },
    { id: 't', kind: 'phone', value: '+233 24 123 4567', label: 'Orders' },
    { id: 'd', kind: 'date', value: '12 November', label: 'Launch' },
    { id: 'u', kind: 'url', value: 'obaapaz.com', label: 'Shop' },
  ];
  const words = (text: string, from = 0) => text.split(' ').map((w, i) => ({ text: w, start: from + i * 0.4, end: from + i * 0.4 + 0.3 }));

  it('normalises spoken numbers, digit-by-digit phone numbers and ordinals', () => {
    expect(spokenNumbersToDigits('only four hundred and fifty cedis')).toBe('only 450 cedis');
    expect(spokenNumbersToDigits('four fifty cedis')).toBe('450 cedis');
    expect(spokenNumbersToDigits('call zero two four, one two three, four five six seven')).toBe('call 0241234567');
    expect(spokenNumbersToDigits('double four seven one')).toBe('4471');
    expect(spokenNumbersToDigits('on the twelfth of November')).toBe('on the 12th of November');
    expect(spokenNumbersToDigits('one thousand two hundred')).toBe('1200');
    expect(spokenNumbersToDigits('the one we love')).toBe('the 1 we love');
  });

  it('extracts prices, phone numbers, dates and links', () => {
    const f = extractFigures('Now GH₵ 1,200 · call 024 123 4567 · from 12/11/2026 · visit www.obaapaz.com or @obaapaz', {});
    expect(f.map((x) => [x.kind, x.key])).toEqual([
      ['price', '1200'],
      ['phone', '241234567'],
      ['date', '11-12'],
      ['url', 'obaapaz.com'],
      ['url', 'obaapaz'],
    ]);
  });

  it('passes a film that shows and says the approved facts', () => {
    const out = checkFacts({ facts, ocr: [{ t: 2, text: 'GH₵450 a jar\nCall 024 123 4567' }, { t: 9, text: 'obaapaz.com' }], words: words('Only four hundred and fifty cedis. Call zero two four one two three four five six seven. From the twelfth of November.') });
    expect(out).toEqual([]);
  });

  it('reports a price said wrong and an unknown phone number, with the closest approved fact', () => {
    const out = checkFacts({ facts, ocr: [{ t: 4, text: 'Call 020 999 8888' }], words: words('A jar for 150 cedis today', 5) });
    expect(out).toHaveLength(2);
    const price = out.find((x) => x.kind === 'price')!;
    expect(price).toMatchObject({ status: 'mismatch', severity: 'error', source: 'transcript', at: 6.2, closest: { id: 'p' } });
    expect(price.message).toMatch(/appears wrong/);
    const phone = out.find((x) => x.kind === 'phone')!;
    expect(phone).toMatchObject({ status: 'unapproved', severity: 'error', source: 'ocr', at: 4 });
    expect(factFindings(out).every((f) => f.check === 'fact_mismatch' && f.severity === 'error')).toBe(true);
  });

  it('a mangled read-out phone number is caught; other numbers only warn; no facts, no check', () => {
    const out = checkFacts({ facts, ocr: [], words: words('call zero two four one two three four five six') });
    expect(out[0]).toMatchObject({ kind: 'phone', status: 'mismatch' });
    expect(checkFacts({ facts, ocr: [{ t: 1, text: '3 steps, 37 hours a week since 2019' }], words: [] }).map((x) => [x.kind, x.severity])).toEqual([['number', 'warning']]);
    expect(checkFacts({ facts: [], ocr: [{ t: 1, text: 'GH₵999' }], words: [] })).toEqual([]);
  });

  it('derives approved facts from confirmed Link to Ad facts and keeps Short Ads facts on the draft', () => {
    const doc = {
      source: { facts: [{ id: 'f1', kind: 'price', text: 'A jar costs GH₵450', value: '450', currency: 'GH₵', qualifier: null, needsConfirmation: true, sourceUrl: null, excerpt: null }, { id: 'f2', kind: 'contact', text: 'Call 024 123 4567', value: null, currency: null, qualifier: null, needsConfirmation: false, sourceUrl: null, excerpt: null }] },
      userFacts: [],
      confirmations: {},
    } as never;
    expect(factsFromLinkAd(doc).map((f) => [f.kind, f.value])).toEqual([['phone', '024 123 4567']]);
    expect(normalizeAdSpec({ facts: [{ id: 'x', kind: 'price', value: 'GH₵10', label: '' }, { kind: 'bogus', value: '' }] } as never).facts).toEqual([{ id: 'x', kind: 'price', value: 'GH₵10', label: '' }]);
  });
});
