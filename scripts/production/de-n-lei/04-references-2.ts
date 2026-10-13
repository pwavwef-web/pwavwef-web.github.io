import { col, loadState, patchState, say, studioOwner, submitJobs, waitForJob, reporter } from './common';

const { log } = reporter('de-n-lei-04-references-2');
const owner = await studioOwner();
let st = loadState();
const projectId = st.projectId as string;
const NO_TEXT = 'Absolutely no text, lettering, typography, logos, captions, signs or watermark anywhere in the image.';
const learnerPortrait = st.refResults.learner_portrait.assetIds[0] as string;

const img = (o: any) => ({ type: 'image.generate', projectId, imageSize: '2K', applyStyleBible: false, grounding: false, collections: [], referenceAssetIds: [], characterIds: [], ...o });
const jobs: { key: string; req: any }[] = [
  {
    key: 'alima_new',
    req: img({
      purpose: 'character',
      aspectRatio: '4:5',
      target: { kind: 'character', id: st.chars.alima },
      title: 'Mama Alima · portrait reference',
      prompt: `Photorealistic documentary portrait of a dignified elderly West African grandmother in her seventies, sitting upright on a wooden chair in a sunlit compound doorway. Deep smile lines, warm brown skin, calm proud eyes and a gentle closed-mouth smile. She wears a rust-red and mustard patterned head wrap, a beaded wooden necklace and a white cotton blouse. Chest-up framing, soft golden-hour light from the side, plain earthen wall softly out of focus. Cinematic photography, 85mm lens, real skin texture. ${NO_TEXT}`,
    }),
  },
  {
    key: 'amina_new',
    req: img({
      purpose: 'character',
      aspectRatio: '4:5',
      target: { kind: 'character', id: st.chars.amina },
      title: 'Amina · portrait reference',
      prompt: `Photorealistic family-album portrait of a cheerful eight-year-old Ghanaian girl sitting on a wooden stool in a sunny courtyard, smiling shyly at the camera. Neat braids with small coloured beads at the ends, a mustard-yellow cotton dress with fine embroidery at the chest. Chest-up framing, soft golden-hour light, plain warm earthen wall softly out of focus. Natural, wholesome, documentary style, 85mm lens. ${NO_TEXT}`,
    }),
  },
  {
    key: 'learner_full',
    req: img({
      purpose: 'turnaround',
      aspectRatio: '2:3',
      referenceAssetIds: [st.portraitAssetId, learnerPortrait],
      target: { kind: 'character', id: st.chars.learner },
      title: 'The Learner · full-body wardrobe reference',
      prompt: `Photorealistic full-body character reference of the same real man as in the two reference images (reference 1 is his own selfie, reference 2 is the approved portrait): identical face, skin tone, short natural black hair and light stubble beard. He stands relaxed and facing the camera in a sunlit earthen compound courtyard. Canonical wardrobe: bright red short-sleeve polo shirt with white striped collar and white placket, thin gold chain, dark indigo cotton trousers, brown leather sandals. Natural proportions, friendly open posture, soft golden-hour light. Cinematic photography, 50mm lens. ${NO_TEXT}`,
    }),
  },
];
const ids = st.ref2Jobs ?? {};
for (const j of jobs) {
  if (ids[j.key]) continue;
  const [id] = await submitJobs(owner, [{ ...j.req, label: `De N Lei · ref · ${j.key}` }], `De N Lei · ref ${j.key}`);
  ids[j.key] = id;
  st = patchState({ ref2Jobs: ids });
}
const out: Record<string, any> = {};
for (const [k, id] of Object.entries(ids)) {
  const job = await waitForJob(id as string, log);
  out[k] = { status: job.status, assetIds: job.result?.assetIds, error: job.error?.message };
  say(`${k}: ${job.status} ${JSON.stringify(job.result?.assetIds ?? job.error?.message)}`);
}
patchState({ ref2Results: out });
void col;
