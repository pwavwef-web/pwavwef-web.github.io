import { DEFAULT_SETTINGS, EMPTY_DIRECTIONS, type CharacterDoc, type ElementDoc, type LocationDoc, type SceneDoc, type ShotDoc } from '@az-studio/shared';

/** Default documents for creative entities (pure — no Firebase imports, safe for unit tests). */
export function newShot(partial: Partial<ShotDoc> = {}): Omit<ShotDoc, 'id'> {
  return {
    sceneId: null,
    sectionId: null,
    order: Date.now(),
    number: '',
    title: 'New shot',
    description: '',
    directions: { ...EMPTY_DIRECTIONS },
    promptOverride: null,
    durationSec: 6,
    aspectRatio: '16:9',
    resolution: DEFAULT_SETTINGS.defaultVideoResolution,
    refs: { characterIds: [], locationIds: [], elementIds: [], assetIds: [], firstFrameAssetId: null, lastFrameAssetId: null, storyboardAssetId: null },
    lockRefs: true,
    status: 'planned',
    selectedTakeId: null,
    approvedTakeId: null,
    timing: null,
    takeCount: 0,
    notes: '',
    ...partial,
  };
}

export function newCharacter(partial: Partial<CharacterDoc> = {}): Omit<CharacterDoc, 'id'> {
  return { name: 'New character', role: '', description: '', appearance: '', wardrobe: '', personality: '', voice: '', referenceAssetIds: [], primaryRefAssetId: null, turnaroundAssetId: null, locked: false, realPerson: false, consentConfirmed: false, ...partial };
}

export function newLocation(partial: Partial<LocationDoc> = {}): Omit<LocationDoc, 'id'> {
  return { name: 'New location', description: '', timeOfDay: '', palette: '', atmosphere: '', referenceAssetIds: [], primaryRefAssetId: null, locked: false, ...partial };
}

export function newElement(partial: Partial<ElementDoc> = {}): Omit<ElementDoc, 'id'> {
  return { kind: 'prop', name: 'New item', description: '', characterId: null, referenceAssetIds: [], locked: false, ...partial };
}

export function newScene(partial: Partial<SceneDoc> = {}): Omit<SceneDoc, 'id'> {
  return {
    sequenceId: null,
    order: Date.now(),
    number: '',
    heading: '',
    intExt: '',
    locationName: '',
    locationId: null,
    timeOfDay: '',
    summary: '',
    characterIds: [],
    props: [],
    costumes: [],
    mood: '',
    dialoguePlan: '',
    audioPlan: '',
    estimatedDurationSec: 60,
    status: 'draft',
    notes: '',
    ...partial,
  };
}
