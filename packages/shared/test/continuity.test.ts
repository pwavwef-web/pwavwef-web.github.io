import { describe, expect, it } from 'vitest';
import {
  analyzeBlocking,
  applyPropEvents,
  axisSide,
  backgroundAspect,
  blockingDirection,
  chooseRepair,
  compareStates,
  compileContinuity,
  computeCategoryScores,
  coverageBlocking,
  cropAvoiding,
  defaultCamera,
  defaultCharacterState,
  defaultPropState,
  detectedToState,
  directorProblems,
  emptyContinuityState,
  emptyExpectations,
  emptySetBible,
  emptyShotContinuity,
  evaluateQuality,
  heldFrameRatio,
  horizontalFov,
  measuredContinuityProblems,
  mergeApprovedState,
  normalizeDirectorReview,
  planShotContinuity,
  projectPoint,
  qualitySettings,
  rankTakes,
  temporalKind,
  textOrientation,
  trackDirection,
  travelDirection,
  viewForDirection,
  type BlockingEntity,
  type BlockingPlanDoc,
  type ContinuityState,
  type DialogueAnalysis,
  type Measurements,
  type ModelReview,
  type VisionFrame,
} from '../src';

const character = (id: string, x: number, y: number, facingDeg: number, extra: Partial<BlockingEntity> = {}): BlockingEntity => ({
  id: `e_${id}`,
  kind: 'character',
  refId: id,
  label: id.toUpperCase(),
  position: { x, y },
  facingDeg,
  gaze: { kind: 'none', targetId: null, deg: null },
  path: [],
  layer: null,
  occlusionAllowed: false,
  protectedVisibility: 'face',
  speaking: false,
  posture: 'standing',
  ...extra,
});

const plan = (entities: BlockingEntity[], camera = defaultCamera()): Pick<BlockingPlanDoc, 'camera' | 'entities'> => ({ camera, entities });

describe('camera geometry', () => {
  it('derives the field of view from the lens and projects left/right correctly', () => {
    expect(horizontalFov(35)).toBeCloseTo(54.4, 0);
    expect(horizontalFov(85)).toBeCloseTo(23.9, 0);
    const cam = { position: { x: 0.5, y: 0.9 }, directionDeg: 0, lensMm: 35 };
    const left = projectPoint(cam, { x: 0.4, y: 0.5 });
    const right = projectPoint(cam, { x: 0.6, y: 0.5 });
    const behind = projectPoint(cam, { x: 0.5, y: 0.95 });
    expect(left.visible && right.visible).toBe(true);
    expect(left.x).toBeLessThan(0.5);
    expect(right.x).toBeGreaterThan(0.5);
    expect(behind.visible).toBe(false);
    // Facing the camera (south = 180°) reads as frontal; facing away as back.
    expect(projectPoint(cam, { x: 0.5, y: 0.5 }, 180).facing).toBe('frontal');
    expect(projectPoint(cam, { x: 0.5, y: 0.5 }, 0).facing).toBe('back');
    // Facing east (90°) from a north-facing camera looks screen-right.
    expect(projectPoint(cam, { x: 0.5, y: 0.5 }, 90).looks).toBe('right');
  });

  it('reports which side of the 180° line a point is on', () => {
    expect(axisSide({ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 0.9 })).toBe('right');
    expect(axisSide({ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 0.1 })).toBe('left');
  });

  it('turns a walk across the frame into a screen direction', () => {
    const walker = character('kojo', 0.2, 0.5, 90, { path: [{ x: 0.8, y: 0.5 }] });
    expect(travelDirection(defaultCamera(), walker)).toBe('left_to_right');
    const back = character('kojo', 0.8, 0.5, 270, { path: [{ x: 0.2, y: 0.5 }] });
    expect(travelDirection(defaultCamera(), back)).toBe('right_to_left');
  });

  it('picks the canonical set view that matches the camera direction', () => {
    expect(viewForDirection(0)).toBe('front');
    expect(viewForDirection(95)).toBe('right');
    expect(viewForDirection(181)).toBe('rear');
    expect(viewForDirection(-80)).toBe('left');
    expect(viewForDirection(null)).toBe('wide');
  });
});

describe('blocking analysis', () => {
  it('flags a character wrongly blocking a speaker, and accepts a deliberate over-the-shoulder', () => {
    const speaker = character('ama', 0.5, 0.35, 180, { speaking: true });
    const blocker = character('kojo', 0.5, 0.62, 0);
    const bad = analyzeBlocking(plan([speaker, blocker]));
    const occ = bad.warnings.find((w) => w.kind === 'occlusion');
    expect(occ?.severity).toBe('critical');
    expect(occ?.message).toMatch(/KOJO covers about \d+% of AMA’s face while they speak/);
    const ots = analyzeBlocking(plan([speaker, { ...blocker, occlusionAllowed: true }]));
    expect(ots.warnings.some((w) => w.kind === 'occlusion')).toBe(false);
  });

  it('detects bodies in the same space, walking through furniture and broken eyelines', () => {
    const a = character('ama', 0.5, 0.5, 90, { gaze: { kind: 'entity', targetId: 'e_kojo', deg: null } });
    const b = character('kojo', 0.52, 0.5, 270);
    expect(analyzeBlocking(plan([a, b])).warnings.some((w) => w.kind === 'same_space')).toBe(true);
    const walker = character('ama', 0.2, 0.5, 90, { path: [{ x: 0.8, y: 0.5 }] });
    const table = { id: 't', kind: 'furniture' as const, label: 'table', x: 0.45, y: 0.45, w: 0.1, h: 0.1, rotation: 0, locked: true };
    expect(analyzeBlocking(plan([walker]), { floorPlan: [table] }).warnings.some((w) => w.kind === 'walk_through' && w.message.includes('table'))).toBe(true);
    // AMA should look at KOJO (to her right) but faces away from him.
    const lookAway = character('ama', 0.4, 0.5, 270, { gaze: { kind: 'entity', targetId: 'e_kojo', deg: null } });
    const kojo = character('kojo', 0.6, 0.5, 270);
    expect(analyzeBlocking(plan([lookAway, kojo])).warnings.some((w) => w.kind === 'eyeline')).toBe(true);
  });

  it('warns when the camera crosses the established 180° line unless the crossing is planned', () => {
    const a = character('ama', 0.4, 0.5, 90);
    const b = character('kojo', 0.6, 0.5, 270);
    const axis = { id: 's1', sceneId: 's1', axis: { aId: 'ama', bId: 'kojo', a: a.position, b: b.position }, establishedSide: 'right' as const, travel: [], crossings: [] };
    const other = { ...defaultCamera(), position: { x: 0.5, y: 0.1 }, directionDeg: 180 };
    expect(analyzeBlocking(plan([a, b], other), { axis }).warnings.some((w) => w.kind === 'axis_crossing')).toBe(true);
    expect(analyzeBlocking(plan([a, b], other), { axis, axisCrossingAllowed: true }).warnings.some((w) => w.kind === 'axis_crossing')).toBe(false);
    expect(analyzeBlocking(plan([a, b]), { axis }).warnings.some((w) => w.kind === 'axis_crossing')).toBe(false);
  });

  it('checks planned depth layers and keeps protected zones (important actions) visible', () => {
    // Camera at the south edge looking north: KOJO is ~4 m away (midground), not in the foreground.
    const kojo = character('kojo', 0.5, 0.5, 180, { layer: 'foreground' });
    expect(analyzeBlocking(plan([kojo])).warnings.some((w) => w.kind === 'blocking' && /planned in the foreground/.test(w.message))).toBe(true);
    expect(analyzeBlocking(plan([{ ...kojo, layer: 'midground' }])).warnings.some((w) => w.kind === 'blocking')).toBe(false);
    // The well is behind AMA from the camera's point of view: she hides it.
    const well = { id: 'z1', label: 'well', x: 0.47, y: 0.2, w: 0.06, h: 0.06 };
    const ama = character('ama', 0.5, 0.6, 180);
    const hidden = analyzeBlocking({ ...plan([ama]), protectedZones: [well] });
    expect(hidden.warnings.some((w) => w.kind === 'occlusion' && /in front of the well/.test(w.message))).toBe(true);
    const clear = analyzeBlocking({ ...plan([{ ...ama, position: { x: 0.35, y: 0.6 } }]), protectedZones: [well] });
    expect(clear.warnings.some((w) => w.kind === 'occlusion')).toBe(false);
    // A zone behind the camera is out of frame, and the compiled direction names it.
    const behind = analyzeBlocking({ ...plan([ama]), protectedZones: [{ ...well, y: 0.95, h: 0.03 }] });
    expect(behind.warnings.some((w) => w.kind === 'out_of_frame' && /well/.test(w.message))).toBe(true);
    const p = { ...plan([ama]), protectedZones: [well] };
    expect(blockingDirection(p, analyzeBlocking(p), (e) => e.label).join(' ')).toMatch(/Keep well clearly visible/);
  });

  it('compiles blocking into camera-relative words with the left-to-right order', () => {
    const a = character('ama', 0.4, 0.5, 120, { speaking: true, gaze: { kind: 'entity', targetId: 'e_kojo', deg: null } });
    const b = character('kojo', 0.6, 0.5, 240);
    const p = plan([a, b]);
    const lines = blockingDirection(p, analyzeBlocking(p), (e) => e.label);
    expect(lines.join(' ')).toMatch(/AMA is camera-left/);
    expect(lines.join(' ')).toMatch(/Left-to-right order on screen: AMA, KOJO/);
    expect(lines.join(' ')).toMatch(/Keep AMA fully visible/);
  });
});

describe('continuity state lifecycle', () => {
  const chars = [
    { id: 'ama', name: 'Ama', bible: { hair: 'box braids', costumes: [{ id: 'c1', name: 'Blue kaba', description: 'indigo wax print', assetId: null }], defaultCostumeId: 'c1', accessories: ['gold hoops'] }, wardrobe: '' },
    { id: 'kojo', name: 'Kojo', bible: null, wardrobe: 'white shirt' },
  ];
  const props = [{ id: 'key', name: 'brass key', initial: null, ownerId: 'ama' }];
  const shot = { id: 's2', sceneId: 'sc1', characterIds: ['ama', 'kojo'], locationId: 'loc', action: 'Ama walks to the door.', dialogueLastLine: null };

  it('continues from the bible, applies on-screen prop events and keeps hands consistent', () => {
    const cont = { ...emptyShotContinuity(), propIds: ['key'], propEvents: [{ propId: 'key', type: 'pick_up' as const, characterId: 'ama', toCharacterId: null, hand: 'right' as const, location: '', note: '' }] };
    const r = planShotContinuity({ shot, before: null, beforeSceneId: null, previousShotId: null, nextShotId: null, characters: chars, props, location: { id: 'loc', timeOfDay: 'dusk' }, continuity: cont, blocking: null, axis: null, floorPlan: [] });
    expect(r.planned.characters.ama!.costume).toMatch(/Blue kaba/);
    expect(r.planned.characters.ama!.rightHand).toBe('key');
    expect(r.planned.props.key!.holderId).toBe('ama');
    expect(r.planned.props.key!.hand).toBe('right');
    expect(r.planned.environment.timeOfDay).toBe('dusk');
    expect(r.warnings).toHaveLength(0);
  });

  it('flags a prop that switches hands with no on-screen action (the right-hand/left-hand test)', () => {
    const before = emptyContinuityState();
    before.characters.ama = { ...defaultCharacterState(null), rightHand: 'key' };
    before.props.key = { ...defaultPropState(), holderId: 'ama', hand: 'right' };
    const cont = { ...emptyShotContinuity(), characters: { ama: { rightHand: null, leftHand: 'key' } } };
    const r = planShotContinuity({ shot, before, beforeSceneId: 'sc1', previousShotId: 's1', nextShotId: 's3', characters: chars, props, location: null, continuity: cont, blocking: null, axis: null, floorPlan: [] });
    const w = r.warnings.filter((x) => x.kind === 'prop_hand');
    expect(w.length).toBeGreaterThanOrEqual(1);
    expect(w[0]!.severity).toBe('critical');
    expect(w[0]!.affects).toEqual({ previousShotId: 's1', nextShotId: 's3' });
    // With a switch-hands event the same change is justified.
    const ok = planShotContinuity({ shot, before, beforeSceneId: 'sc1', previousShotId: 's1', nextShotId: null, characters: chars, props, location: null, continuity: { ...emptyShotContinuity(), propEvents: [{ propId: 'key', type: 'switch_hands', characterId: 'ama', toCharacterId: null, hand: 'left', location: '', note: '' }] }, blocking: null, axis: null, floorPlan: [] });
    expect(ok.warnings.filter((x) => x.kind === 'prop_hand')).toHaveLength(0);
    expect(ok.planned.characters.ama!.leftHand).toBe('key');
    expect(ok.planned.characters.ama!.rightHand).toBeNull();
  });

  it('catches irreversible prop states, costume changes and a reversed travel direction', () => {
    const before = emptyContinuityState();
    before.characters.ama = { ...defaultCharacterState(null), costume: 'Blue kaba' };
    before.props.key = { ...defaultPropState(), status: 'damaged' };
    before.camera.travel.ama = 'left_to_right';
    const blocking: BlockingPlanDoc = { id: 's2', shotId: 's2', sceneId: 'sc1', locationId: null, camera: defaultCamera(), entities: [character('ama', 0.8, 0.5, 270, { path: [{ x: 0.2, y: 0.5 }] })], protectedZones: [], notes: '' };
    const cont = { ...emptyShotContinuity(), characters: { ama: { costume: 'Red dress' } } };
    const r = planShotContinuity({ shot, before: { ...before, props: { key: { ...before.props.key!, status: 'intact' } } }, beforeSceneId: 'sc1', previousShotId: 's1', nextShotId: null, characters: chars, props, location: null, continuity: cont, blocking, axis: null, floorPlan: [] });
    expect(r.warnings.some((w) => w.kind === 'costume')).toBe(true);
    expect(r.warnings.some((w) => w.kind === 'screen_direction' && w.severity === 'critical')).toBe(true);
    const damaged = planShotContinuity({ shot, before, beforeSceneId: 'sc1', previousShotId: 's1', nextShotId: null, characters: chars, props, location: null, continuity: { ...emptyShotContinuity(), propEvents: [] }, blocking: null, axis: null, floorPlan: [] });
    // Nothing repairs the key on screen, so it must stay damaged.
    expect(damaged.planned.props.key!.status).toBe('damaged');
    const applied = applyPropEvents({ key: { ...defaultPropState(), status: 'damaged' } }, {}, [{ propId: 'key', type: 'repair', characterId: null, toCharacterId: null, hand: null, location: '', note: 'mended' }]);
    expect(applied.props.key!.status).toBe('intact');
  });

  it('compares detected with planned state and adopts only waived deviations on approval', () => {
    const planned: ContinuityState = emptyContinuityState();
    planned.characters.ama = { ...defaultCharacterState(null), rightHand: 'key', costume: 'Blue kaba' };
    planned.props.key = { ...defaultPropState(), holderId: 'ama', hand: 'right' };
    const names = { characters: { ama: 'Ama' }, props: { key: 'brass key' } };
    const detected = detectedToState(planned, { characters: [{ characterId: null, name: 'Ama', present: true, costume: 'Blue kaba', hair: '', leftHand: 'brass key', rightHand: 'none', posture: 'standing', screenSide: 'left', facing: 'three-quarter', emotion: '', matchesReference: true }], props: [{ propId: null, name: 'brass key', present: true, holder: 'Ama', hand: 'left', status: 'intact', condition: '' }], environment: { timeOfDay: '', weather: '', lightDirection: '', background: '' }, travel: [] }, names);
    expect(detected.characters.ama!.leftHand).toBe('key');
    const w = compareStates(planned, detected, names, { previousShotId: null, nextShotId: null });
    expect(w.some((x) => x.kind === 'prop_hand' && x.detected === 'brass key')).toBe(true);
    expect(mergeApprovedState(planned, detected, []).characters.ama!.rightHand).toBe('key');
    expect(mergeApprovedState(planned, detected, ['prop_hand']).characters.ama!.leftHand).toBe('key');
  });
});

describe('continuity prompt', () => {
  it('compiles protected constraints, adds the right references within the image limit', () => {
    const set = { ...emptySetBible('loc'), wallColours: 'ochre', floorPlan: [{ id: 'd', kind: 'door' as const, label: 'blue door', x: 0, y: 0.4, w: 0.02, h: 0.15, rotation: 0, locked: true }], neverChange: ['the blue door'], views: { wide: 'wide1', front: 'front1', rear: null, left: null, right: null } };
    set.canonical = { status: 'locked', approvedAt: 1, approvedViews: ['wide', 'front'], packJobId: null };
    const r = compileContinuity({
      sceneId: 'sc1',
      visualBible: { entries: { overallStyle: { value: 'warm 35mm film', level: 'locked', sceneIds: [] }, colourPalette: { value: 'ochre and indigo', level: 'preferred', sceneIds: [] }, prohibited: { value: 'visible logos', level: 'locked', sceneIds: [] }, lensPreferences: { value: 'anamorphic', level: 'flexible', sceneIds: [] } }, lookbookAssetIds: [], colour: { referenceAssetId: null, palette: [], skinTone: 'natural deep brown skin', whiteBalanceK: null, contrast: null, saturation: null, grain: null, highlightRollOff: null, shadowTreatment: null, look: null, lutAssetId: null, lutStrength: 0.6, approvedAt: null } },
      characters: [{ id: 'ama', name: 'Ama', bible: { approvedRefIds: ['amaFront'], ageRange: 'late 20s', hair: 'box braids', protectedIdentity: ['small scar over the left eyebrow'] }, appearance: '', primaryRefAssetId: 'amaPrimary', state: { ...defaultCharacterState(null), costume: 'Blue kaba', rightHand: 'key' } }],
      location: { id: 'loc', name: 'Compound', description: '', set, primaryRefAssetId: 'locPrimary' },
      props: [{ id: 'key', name: 'brass key', description: '', refAssetId: 'keyRef', state: { ...defaultPropState(), holderId: 'ama', hand: 'right' } }],
      screens: [],
      previous: { title: 'Shot 1', finalFrameAssetId: 'prevFrame', sameScene: true },
      blockingLines: ['Ama is camera-left in the midground, facing the camera.'],
      travel: [{ name: 'Ama', direction: 'left_to_right' }],
      cameraDirectionDeg: 0,
      environment: { locationId: 'loc', timeOfDay: 'dusk', weather: 'dry', lightDirection: 'from the west window', lightColour: 'warm', background: '' },
      startFromPreviousFrame: false,
      existingMedia: [{ role: 'image_ref', assetId: 'amaPrimary', label: 'Ama' }],
      maxImages: 10,
    });
    expect(r.setView).toBe('front');
    expect(r.added.map((a) => a.assetId)).toEqual(['amaFront', 'front1', 'prevFrame', 'keyRef']);
    expect(r.text).toContain('CONTINUITY (must hold for the whole shot):');
    expect(r.text).toContain('Visual style: warm 35mm film');
    expect(r.text).toContain('Never show visible logos');
    expect(r.text).not.toContain('anamorphic');
    expect(r.text).toMatch(/Ama <IMAGE_REF_1> <IMAGE_REF_0> keeps exactly the same face/);
    expect(r.text).toContain('small scar over the left eyebrow');
    expect(r.text).toMatch(/brass key in the RIGHT hand/);
    expect(r.text).toContain('Location: Compound <IMAGE_REF_2> (view facing the north wall)');
    expect(r.text).toContain('Screen direction: Ama travels left → right');
    expect(r.text).toMatch(/<IMAGE_REF_3> is the final frame of the previous shot/);
    expect(r.optionalPreferences.some((p) => p.text.includes('ochre and indigo'))).toBe(true);
    // With room for only two more images, lower-priority references are dropped and reported.
    const tight = compileContinuity({ sceneId: null, visualBible: null, characters: [], location: { id: 'loc', name: 'Compound', description: '', set, primaryRefAssetId: null }, props: [{ id: 'key', name: 'brass key', description: '', refAssetId: 'keyRef', state: defaultPropState() }], screens: [], previous: { title: 'Shot 1', finalFrameAssetId: 'prevFrame', sameScene: true }, blockingLines: [], travel: [], cameraDirectionDeg: 0, environment: null, startFromPreviousFrame: false, existingMedia: Array.from({ length: 8 }, (_, i) => ({ role: 'image_ref' as const, assetId: `x${i}` })), maxImages: 10 });
    expect(tight.added).toHaveLength(2);
    expect(tight.dropped.map((d) => d.assetId)).toEqual(['keyRef']);
  });
});

describe('continuity-aware inspection', () => {
  it('detects mirrored writing by comparing OCR of the frame with its mirror image', () => {
    expect(textOrientation('AZ Studio', 'AZ Studio', 'oibutS ZA').verdict).toBe('correct');
    expect(textOrientation('AZ Studio', 'oibutS ZA', 'AZ Studio').verdict).toBe('mirrored');
    expect(textOrientation('AZ Studio', 'AZ Stuido', '').verdict).toBe('misspelled');
  });

  it('counts stutter only where frames are held while the picture moves', () => {
    // Per-frame luma differences measured on real 360p Omni takes (see the acceptance evidence): a seated,
    // almost still shot changes ~0.2–0.4 on every frame — calm, not stutter.
    const still = [0, 0.17, 0.17, 0.17, 0.35, 0.26, 0.2, 0.22, 0.31, 0.3, 0.24, 0.22, 0.29, 0.24, 0.24, 0.2, 0.37, 0.3, 0.24, 0.23, 0.34, 0.27, 0.24, 0.23, 0.33, 0.28, 0.27, 0.25];
    expect(heldFrameRatio(still)).toBe(0);
    // A moving shot with every other frame held (duplicated, then re-encoded: not exactly zero).
    const stutter = [0, ...Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.1 + (i % 3) * 0.02 : 0.8 + (i % 5) * 0.2))];
    expect(heldFrameRatio(stutter)).toBeGreaterThan(0.4);
    // Smooth motion that speeds up and slows down, and a single dropped frame (a jump, not a hold).
    const smooth = [0, 0.11, 0.1, 0.17, 0.3, 0.24, 0.21, 0.21, 0.37, 0.37, 0.41, 0.46, 0.55, 0.46, 0.39, 0.48, 0.66, 0.44, 0.47, 0.55, 0.58, 0.73, 0.95, 1.09, 0.56, 0.54, 0.55];
    expect(heldFrameRatio(smooth)).toBe(0);
    // An exact duplicate in the middle of motion is one held frame.
    const hitch = [0, 0.9, 1, 0.95, 1.1, 1, 0, 1.05, 0.98, 1.02, 0.97, 1];
    expect(heldFrameRatio(hitch)).toBeCloseTo(1 / 11, 3);
    expect(heldFrameRatio([0, 0])).toBe(0);
  });

  it('keeps a reviewer’s fault even when it uses its own word for the kind', () => {
    // Seen live: “frozen_frames” as a temporal kind and “none” as a severity.
    const d = normalizeDirectorReview({
      temporal: { problems: [{ kind: 'frozen_frames', startSec: 1, endSec: 2, severity: 'minor', description: 'The picture holds.' }, { kind: 'face_melting', severity: 'major', description: 'Face warps.' }], note: '' },
      background: [{ aspect: 'bench_moved', ok: false, severity: 'major', note: 'A second bench appears.' }, { aspect: 'furniture_moved', ok: true, severity: 'none', note: '' }],
    });
    expect(d.temporal.problems.map((p) => p.kind)).toEqual(['broken_motion', 'morphing']);
    expect(d.temporal.problems[0]!.description).toBe('frozen frames: The picture holds.');
    expect(d.background.map((b) => b.aspect)).toEqual(['furniture_moved', 'furniture_moved']);
    expect(d.background[0]).toMatchObject({ ok: false, severity: 'major' });
    expect(temporalKind('texture_flicker')).toBe('texture_flicker');
    expect(temporalKind('strobing light flicker')).toBe('lighting_flicker');
    expect(backgroundAspect('different location')).toBe('location_replaced');
    expect(backgroundAspect('something odd')).toBe('architecture_mutation');
  });

  it('tracks the main subject across frames', () => {
    const frames: VisionFrame[] = [0, 1, 2, 3, 4, 5].map((t) => ({ t, faces: [], objects: [], text: [], people: [{ box: { x: 0.1 + t * 0.12, y: 0.3, w: 0.1, h: 0.5 }, score: 0.9 }] }));
    expect(trackDirection(frames).direction).toBe('left_to_right');
    expect(trackDirection(frames.map((f) => ({ ...f, people: f.people.map((p) => ({ ...p, box: { ...p.box, x: 0.9 - p.box.x } })) }))).direction).toBe('right_to_left');
  });

  it('turns measurements into problems (freeze, flicker, mirrored screen, reversed travel, colour drift)', () => {
    const expect_ = { ...emptyExpectations(), characters: [{ id: 'ama', name: 'Ama', speaking: false, mustShowFace: true }], travel: [{ id: 'ama', name: 'Ama', direction: 'left_to_right' as const }], screens: [{ id: 'phone', name: 'Phone', expectedText: 'AZ Studio', mayMirror: false, composite: true }] };
    const frames: VisionFrame[] = [0, 1, 2, 3, 4].map((t) => ({ t, faces: [], objects: [], text: [], people: [{ box: { x: 0.8 - t * 0.15, y: 0.3, w: 0.1, h: 0.5 }, score: 0.9 }] }));
    const problems = measuredContinuityProblems({
      temporal: { frozen: [{ start: 2, end: 3.2 }], repeatedRatio: 0.2, flickerIndex: 1.4, jumps: [4.1], decodeErrors: 0, frames: 200 },
      vision: { frames, screenText: [{ screenId: 'phone', expected: 'AZ Studio', t: 1, normal: 'oibutS ZA', flipped: 'AZ Studio' }] },
      colour: { shot: { r: 200, g: 150, b: 90, luma: 160, skin: null }, reference: { r: 120, g: 128, b: 140, luma: 128, skin: null }, previous: null },
      expect: expect_,
      durationSec: 6,
    });
    const cats = problems.map((p) => p.category);
    expect(cats).toEqual(expect.arrayContaining(['frozen_frames', 'repeated_frames', 'lighting_flicker', 'camera_jump', 'mirrored_text', 'direction_reversal', 'white_balance']));
    expect(problems.find((p) => p.category === 'mirrored_text')!.severity).toBe('critical');
  });

  it('normalises a partial model report and ranks takes', () => {
    const d = normalizeDirectorReview({ characters: [{ name: 'Ama', faceMatchesReference: false, severity: 'critical' }], background: [{ aspect: 'door_window_moved', ok: false, severity: 'major', note: 'door moved to the right wall' }, { aspect: 'nonsense', ok: false }], categoryScores: { characterConsistency: 30, backgroundConsistency: 150 } });
    // A set fault in the reviewer's own words is kept (mapped to the nearest aspect), never dropped.
    expect(d.background.map((b) => b.aspect)).toEqual(['door_window_moved', 'architecture_mutation']);
    expect(d.categoryScores.backgroundConsistency).toBe(100);
    const probs = directorProblems(d, emptyExpectations());
    expect(probs.map((p) => p.category)).toEqual(expect.arrayContaining(['face_change', 'door_window_moved']));
    const cs = computeCategoryScores({ model: d.categoryScores, dialogueScore: null, actionScore: 80, audioScore: 80, lipSync: null, problems: probs, hasText: false, hasDialogue: false });
    expect(cs.characterConsistency).toBeLessThanOrEqual(30);
    expect(cs.backgroundConsistency).toBeLessThanOrEqual(55);
    const ranked = rankTakes([
      { index: 1, passed: false, overall: 80, categoryScores: null },
      { index: 2, passed: true, overall: 76, categoryScores: null },
      { index: 3, passed: true, overall: 88, categoryScores: null },
    ]);
    expect(ranked.map((t) => t.index)).toEqual([3, 2, 1]);
  });

  it('fails a take whose background drifted and repairs only the background', () => {
    const review: ModelReview = {
      summary: '',
      speakerAttribution: [],
      lipSync: { applicable: false, drift: 'none', note: '' },
      performanceFinished: true,
      dialogueOverMusic: 'not_applicable',
      abruptCutDuringSpeech: false,
      actions: [],
      actionComplete: true,
      unfinishedMovementAtEnd: false,
      continuity: [],
      cameraMatchesDirection: true,
      screenDirectionConsistent: true,
      emotionalPerformanceMatches: true,
      renderedText: { present: false, acceptable: true, note: '' },
      artefacts: [],
      suddenDisappearance: false,
      accidentalSceneChange: false,
      firstFrame: { quality: 'good', note: '' },
      lastFrame: { quality: 'good', note: '' },
      scores: { actionCompleteness: 90, visualAccuracy: 85, characterContinuity: 90, audioQuality: 85, storyContinuity: 85, overallUsability: 88 },
      problems: [],
      recommendedRepair: null,
      director: normalizeDirectorReview({ background: [{ aspect: 'furniture_moved', ok: false, severity: 'major', note: 'the sofa moved from under the window to the left wall' }] }),
    };
    const dialogue = { applicable: false, dialogueComplete: true, lines: [], missingWords: [], alteredWords: [], repeatedWords: [], extraWords: [], truncatedFinalWord: false, cutoffTime: null, firstWordStart: null, lastWordEnd: null, leadingRoomSec: null, trailingRoomSec: null, wordCoverage: 1, recommendedRepair: null, problems: [], score: null, expectedText: '', detectedText: '' } as DialogueAnalysis;
    const measurements: Measurements = { durationSec: 6, fps: 24, hasAudio: true, audio: null, visual: { sceneCuts: [], blackSegments: [], endMotionRatio: 0.5, frozenAtEnd: false } };
    const v = evaluateQuality({ dialogue, review, measurements, settings: qualitySettings(null), hasCharacters: true });
    expect(v.passed).toBe(false);
    expect(v.problems.find((p) => p.category === 'furniture_moved')?.blocking).toBe(true);
    const repair = chooseRepair({ problems: v.problems, dialogue, review, version: { durationSec: 6, continuable: true, chainSec: 6 }, expected: { lines: [], action: '' }, plan: null, caps: { minSec: 3, maxSec: 10, maxChainSec: 40 }, previous: [] });
    expect(repair?.type).toBe('replace_background');
    expect(repair?.keepAudio).toBe(true);
    // A passing alternative take is used before anything is regenerated.
    const other = chooseRepair({ alternatives: [{ versionId: 'v2', index: 2, overall: 86, passed: true, label: 'Take 2' }], problems: v.problems, dialogue, review, version: { durationSec: 6, continuable: true, chainSec: 6 }, expected: { lines: [], action: '' }, plan: null, caps: { minSec: 3, maxSec: 10, maxChainSec: 40 }, previous: [] });
    expect(other?.type).toBe('use_other_take');
    expect(other?.data).toEqual({ versionId: 'v2' });
  });

  it('crops away a fault at the edge of frame but not one in the middle', () => {
    expect(cropAvoiding([{ x: 0.92, y: 0.05, w: 0.07, h: 0.08 }])).not.toBeNull();
    expect(cropAvoiding([{ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }])).toBeNull();
  });
});

describe('coverage', () => {
  it('places coverage cameras on the established side of the line', () => {
    const master = { entities: [character('ama', 0.4, 0.5, 90), character('kojo', 0.6, 0.5, 270)], sceneId: 'sc', locationId: null };
    for (const type of ['master', 'close_up', 'reaction', 'over_the_shoulder'] as const) {
      const b = coverageBlocking({ id: 'c', type, subjectIds: ['ama', 'kojo'], description: '', action: '', framing: '', lens: '', cameraMovement: '', durationSec: 5, dialogueLines: [], priority: 'essential', rationale: '', accepted: true }, master, 'right', 'shot1');
      expect(axisSide({ x: 0.4, y: 0.5 }, { x: 0.6, y: 0.5 }, b.camera.position)).toBe('right');
    }
  });
});
