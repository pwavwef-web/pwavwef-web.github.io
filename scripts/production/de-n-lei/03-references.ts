import { col, FieldValue, loadState, patchState, say, studioOwner, submitJobs, waitForJob, reporter } from './common';

const { log } = reporter('de-n-lei-03-references');
const owner = await studioOwner();
let st = loadState();
const projectId = st.projectId as string;
const NO_TEXT = 'Absolutely no text, lettering, typography, logos, captions, signs or watermark anywhere in the image.';

// Existing studio references reused by editing out their baked-in lettering (the earlier project's pictures carry unverified Kasem words).
const OLD = { alima: 'x9lqarUmanadkQw43pJo', amina: '16i51bdyQk9v52SxUnMQ', courtyard: 'E8NfT9fZtqIKfzMx9lWz' };

if (!st.stemsJobId) {
  const [id] = await submitJobs(owner, [{ type: 'audio.stems', projectId, audioAssetId: st.songAssetId, label: 'De N Lei · vocal stem for timing and lip-sync' }], 'De N Lei · stems');
  st = patchState({ stemsJobId: id });
  say(`stems job ${id}`);
}

const chars: Record<string, any> = {
  learner: {
    name: 'The Learner (the artist)',
    role: 'Lead — learner who becomes the guide',
    realPerson: true,
    consentConfirmed: true,
    appearance: 'The artist himself, from his own portrait: young adult man, dark brown skin, short natural black hair with a clean rounded hairline, light stubble and chin beard, warm open face. Identity must match the portrait exactly.',
    wardrobe: 'Bright red short-sleeve polo with a white striped collar and white placket, thin gold chain, dark indigo cotton trousers, brown leather sandals. Never changes.',
  },
  alima: {
    name: 'Mama Alima (the elder)',
    role: 'Elder who passes the words on',
    realPerson: false,
    consentConfirmed: false,
    appearance: 'Regal, joyful elderly woman with deep smile lines, warm brown skin, calm proud eyes.',
    wardrobe: 'Rust-red and mustard patterned head wrap, beaded wooden necklace, a plain mustard-and-cream wrapper cloth with a white cotton blouse.',
  },
  amina: {
    name: 'Amina (the child)',
    role: 'Eight-year-old who learns fast and teaches back',
    realPerson: false,
    consentConfirmed: false,
    appearance: 'Eight-year-old girl, bright and quick, braids with coloured beads at the ends.',
    wardrobe: 'Mustard-yellow cotton dress with fine embroidery at the chest, bright coloured beads in her braids.',
  },
};
const locs: Record<string, any> = {
  compound: { name: 'The painted compound courtyard', description: 'Swept red-brown earth yard, low earthen buildings, hand-painted black, white and terracotta geometric wall patterns, a large shade tree, clay pots, a wooden bench and stools.' },
  baobab: { name: 'The baobab gathering ground', description: 'A wide, sun-drenched open ground under a massive baobab tree where the whole community gathers to dance.' },
  lane: { name: 'The village lane', description: 'A dusty red-earth lane between earthen compound walls, a trader table under an umbrella, a tree at the end of the lane.' },
};
for (const [k, c] of Object.entries(chars)) {
  if (st.chars?.[k]) continue;
  const ref = col.projects().doc(projectId).collection('characters').doc();
  await ref.set({ ...c, description: '', personality: '', voice: '', referenceAssetIds: [], primaryRefAssetId: null, turnaroundAssetId: null, locked: false, createdAt: FieldValue.serverTimestamp() });
  st = patchState({ chars: { ...(st.chars ?? {}), [k]: ref.id } });
}
for (const [k, l] of Object.entries(locs)) {
  if (st.locs?.[k]) continue;
  const ref = col.projects().doc(projectId).collection('locations').doc();
  await ref.set({ ...l, timeOfDay: '', palette: '', atmosphere: '', locked: false, referenceAssetIds: [], primaryRefAssetId: null, createdAt: FieldValue.serverTimestamp() });
  st = patchState({ locs: { ...(st.locs ?? {}), [k]: ref.id } });
}

const img = (o: any) => ({ type: 'image.generate', projectId, imageSize: '2K', applyStyleBible: false, grounding: false, collections: [], referenceAssetIds: [], characterIds: [], ...o });
const jobs: { key: string; req: any }[] = [
  {
    key: 'learner_portrait',
    req: img({
      purpose: 'character',
      aspectRatio: '4:5',
      referenceAssetIds: [st.portraitAssetId],
      target: { kind: 'character', id: st.chars.learner },
      title: 'The Learner · portrait reference',
      prompt: `Photorealistic character reference portrait of the real man in reference image 1 (his own selfie). Recreate this exact person: identical face shape, eyes, brows, nose, lips, light stubble and chin beard, dark brown skin tone, ears, neck and his short natural black hair with a clean rounded hairline. Do not beautify, slim, age or change him. Wardrobe (canonical): bright red short-sleeve polo shirt with white striped collar and a white button placket, thin gold chain. Chest-up framing, natural relaxed warm smile, soft golden-hour key light from the left, plain warm stone-coloured wall softly out of focus behind him. Cinematic photography, 85mm lens, real skin texture. ${NO_TEXT}`,
    }),
  },
  {
    key: 'alima_clean',
    req: img({
      purpose: 'character',
      aspectRatio: '4:5',
      sourceAssetId: OLD.alima,
      target: { kind: 'character', id: st.chars.alima },
      title: 'Mama Alima · portrait reference (text removed)',
      prompt: 'Remove ALL text, lettering, handwriting and typography from the image (the white and blue words written around her). Rebuild the plain wall and chair background where the lettering was. Do not change her face, head wrap, necklace, skin, expression or pose.',
    }),
  },
  {
    key: 'amina_clean',
    req: img({
      purpose: 'character',
      aspectRatio: '4:5',
      sourceAssetId: OLD.amina,
      target: { kind: 'character', id: st.chars.amina },
      title: 'Amina · portrait reference (text removed)',
      prompt: 'Remove ALL text, lettering and typography from the image (the white and blue words at the lower right). Rebuild the plain warm backdrop and chair where the lettering was. Do not change the girl, her dress, braids, beads, expression or pose.',
    }),
  },
  {
    key: 'compound',
    req: img({
      purpose: 'location',
      aspectRatio: '16:9',
      target: { kind: 'location', id: st.locs.compound },
      title: 'Painted compound courtyard · reference',
      prompt: `A family compound courtyard in the savanna of northern Ghana at golden hour: swept red-brown earth yard, low earthen buildings with flat roofs, outer walls hand-painted with bold black, white and terracotta-red geometric patterns (zigzags and diamonds), one large shade tree on the left, clay water pots, a long wooden bench and two stools, a few hens. Lived-in, tidy and warm. Wide establishing shot, cinematic photography, soft haze and dust in the low sun. No people. ${NO_TEXT}`,
    }),
  },
  {
    key: 'baobab',
    req: img({
      purpose: 'location',
      aspectRatio: '16:9',
      sourceAssetId: OLD.courtyard,
      target: { kind: 'location', id: st.locs.baobab },
      title: 'Baobab gathering ground · reference (text removed)',
      prompt: 'Remove the wooden signboard and ALL text, lettering and typography from the image (the sign reading "The Courtyard / Kasem Vocabulary" and the large words in the middle). Replace the sign with open air and the continuing scene. Keep the baobab tree, the dust, the light and the architecture. Keep the dancing crowd but make it a natural, unlettered scene.',
    }),
  },
  {
    key: 'lane',
    req: img({
      purpose: 'location',
      aspectRatio: '16:9',
      target: { kind: 'location', id: st.locs.lane },
      title: 'Village lane · reference',
      prompt: `A dusty village lane in northern Ghana in late afternoon: red-earth path between low earthen compound walls (some painted with black, white and red geometric patterns), a roadside trader's table with enamel bowls, groundnuts and oranges under a patched umbrella, a leafy tree at the end of the lane, warm haze. No people. ${NO_TEXT}`,
    }),
  },
];
const ids = st.refJobs ?? {};
for (const j of jobs) {
  if (ids[j.key]) continue;
  const [id] = await submitJobs(owner, [{ ...j.req, label: `De N Lei · ref · ${j.key}` }], `De N Lei · ref ${j.key}`);
  ids[j.key] = id;
  st = patchState({ refJobs: ids });
}
const out: Record<string, any> = {};
for (const [k, id] of Object.entries(ids)) {
  const job = await waitForJob(id as string, log);
  out[k] = { status: job.status, assetIds: job.result?.assetIds, error: job.error?.message };
  say(`${k}: ${job.status} ${JSON.stringify(job.result?.assetIds ?? job.error?.message)}`);
}
patchState({ refResults: out });
