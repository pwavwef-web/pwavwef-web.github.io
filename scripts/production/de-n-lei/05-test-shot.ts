import { compileShotPrompt, jobRequestSchema } from '@az-studio/shared';
import { loadState, say, studioOwner, submitJobs, waitForJob, reporter, col } from './common';

const { log } = reporter('de-n-lei-05-test');
const owner = await studioOwner();
const st = loadState();
const projectId = st.projectId as string;
const R = { learner: st.refResults.learner_portrait.assetIds[0], alima: st.ref2Results.alima_new.assetIds[0], amina: st.ref2Results.amina_new.assetIds[0], compound: st.refResults.compound.assetIds[0] };
const aspect = (process.argv[2] ?? '16:9') as '16:9' | '9:16';

const body = compileShotPrompt(
  {
    framing: aspect === '16:9' ? 'Medium two-shot, eye level' : 'Medium close two-shot, vertical framing, eye level',
    cameraMovement: 'Slow gentle push-in',
    lens: '50mm lens',
    lighting: 'Warm golden-hour sunlight, soft rim light, a little dust glowing in the air',
    mood: 'Warm, welcoming, curious',
    style: 'Photoreal cinematic, shallow depth of field, natural skin texture',
    performance: 'Natural, unforced, smiling',
    action: 'The learner steps into the painted compound courtyard and greets the elder with a warm smile and a small bow of the head; she looks up from her stool, lights up, and gestures for him to sit beside her. Gentle, natural movement with a steady relaxed tempo.',
    dialogue: [],
    ambientSound: 'Soft ambient courtyard sounds',
    avoid: 'text, captions, subtitles, lettering, signs or watermarks on screen; any change to the learner’s face, hair or red polo shirt',
  },
  {
    characters: [
      { tag: '<IMAGE_REF_0>', name: 'The learner (the man in the red polo)', description: 'exactly as in this reference: same face, skin tone, short natural black hair, light stubble, red polo with white collar' },
      { tag: '<IMAGE_REF_1>', name: 'Mama Alima, the elder', description: 'rust-red and mustard head wrap, white blouse, beaded necklace' },
    ],
    locations: [{ tag: '<IMAGE_REF_2>', name: 'the painted compound courtyard', description: 'earthen buildings with black, white and terracotta geometric painted walls' }],
    noBackgroundMusic: true,
    noOverlayText: true,
  },
);
const req = jobRequestSchema.parse({
  type: 'video.generate',
  projectId,
  mode: 'generate',
  prompt: body,
  aspectRatio: aspect,
  resolution: '360p',
  durationSec: 5,
  media: [
    { role: 'image_ref', assetId: R.learner, label: 'The learner' },
    { role: 'image_ref', assetId: R.alima, label: 'Mama Alima' },
    { role: 'image_ref', assetId: R.compound, label: 'Compound courtyard' },
  ],
  characterIds: [st.chars.learner, st.chars.alima],
  title: `TEST ${aspect}`,
  label: `De N Lei · test ${aspect} 360p`,
});
const [id] = await submitJobs(owner, [req], `De N Lei · test ${aspect}`);
say(`job ${id}`);
const job = await waitForJob(id!, log);
say(`${job.status} ${JSON.stringify(job.result?.assetIds ?? job.error)}`);
void col;
