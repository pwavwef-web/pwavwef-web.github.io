import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { compileShotPrompt, jobRequestSchema } from '@az-studio/shared';
import { bucket, col, loadState, patchState, say, studioOwner, submitJobs, waitForJob, WORK } from './common';

// Usage: 02-human.ts refs | shots [name…] | fetch
// All human footage is silent, has no readable text, no vehicles/brands, and no dialogue (voice-over is added in the edit).
const [step = 'status', ...only] = process.argv.slice(2);
const owner = await studioOwner();
let st = loadState();
const projectId = st.projects.v2 as string; // human footage lives in one project, then is uploaded into each video's project

const PEOPLE: Record<string, { prompt: string; desc: string }> = {
  contributor: {
    prompt: 'Photorealistic portrait of a Ghanaian woman in her late twenties, short natural hair, warm brown skin, gentle confident smile, mustard-yellow plain cotton blouse and small gold hoop earrings, soft natural window light, neutral warm-grey background, shoulders up, looking slightly off camera. No text, no logos.',
    desc: 'exactly as in this reference: same face, short natural hair, mustard-yellow cotton blouse, small gold hoop earrings',
  },
  elder: {
    prompt: 'Photorealistic portrait of a Ghanaian grandmother in her seventies, deep-set kind eyes, a warm lined smile, silver-grey hair under a plain navy headwrap, cream cotton top, soft golden light, neutral warm background, shoulders up. No text, no logos.',
    desc: 'exactly as in this reference: same face, navy headwrap, cream cotton top',
  },
  teen: {
    prompt: 'Photorealistic portrait of a Ghanaian teenage girl of sixteen, braids tied back, curious bright eyes, light grey hooded sweatshirt, small white earbuds, soft indoor evening light, neutral background, shoulders up. No text, no logos.',
    desc: 'exactly as in this reference: same face, braids tied back, light grey hoodie, white earbuds',
  },
  reviewer: {
    prompt: 'Photorealistic portrait of a Ghanaian man in his forties, calm attentive expression, round glasses, white shirt with rolled sleeves, bright modern office with soft daylight, neutral blurred background, shoulders up. No text, no logos.',
    desc: 'exactly as in this reference: same face, round glasses, white shirt with rolled sleeves',
  },
};

interface Shot { key: string; who: string[]; seconds: number; framing: string; camera: string; lighting: string; mood: string; action: string; setting: string; avoid?: string }
const SHOTS: Shot[] = [
  { key: 'reviewer-puzzled', who: ['reviewer'], seconds: 6, framing: 'Medium close-up from the side of a desk, vertical framing', camera: 'Slow gentle push-in', lighting: 'Soft bright daylight from a window, clean modern office', mood: 'Thoughtful, quietly puzzled', setting: 'a tidy bright office desk with a closed-lid laptop angled away so no screen is visible, a notebook and a mug', action: 'The reviewer reads from a notebook, pauses, tilts his head slightly, rubs his chin and looks at the page again as if something is missing, then glances up thoughtfully. Calm natural movement.' },
  { key: 'reviewer-approve', who: ['reviewer'], seconds: 6, framing: 'Medium close-up from the side of a desk, vertical framing', camera: 'Slow gentle push-in', lighting: 'Soft bright daylight from a window, clean modern office', mood: 'Satisfied, warm', setting: 'a tidy bright office desk with a laptop angled away so no screen is visible, a notebook and a mug', action: 'The reviewer reads from a notebook, nods slowly, makes a small tick with a pen, and gives a quiet satisfied smile. Calm natural movement.' },
  { key: 'quiet-room', who: ['contributor'], seconds: 6, framing: 'Medium shot, vertical framing, eye level', camera: 'Slow gentle push-in', lighting: 'Soft warm daylight through a curtain', mood: 'Calm, careful', setting: 'a small quiet bedroom with woven cloth wall hangings and a cloth-covered table, door and window shutters being closed', action: 'The contributor gently closes a wooden door, crosses to a cloth-covered table, sits and places her phone upright on a small stand about a hand-width from her, takes a calm breath and settles. Unhurried.' },
  { key: 'elder-hands', who: ['elder'], seconds: 6, framing: 'Close-up on hands, vertical framing', camera: 'Locked-off with a very slow drift', lighting: 'Warm golden-hour light, a little dust glowing in the air', mood: 'Warm, intimate, everyday', setting: 'a family compound courtyard, earthen walls, an enamel bowl of groundnuts on a low stool', action: 'The elder’s hands crack groundnut shells and drop the nuts into the bowl while she talks warmly to someone just out of frame; the camera rises slowly to her smiling face in profile as she speaks with gentle gestures.' },
  { key: 'elder-guest', who: ['elder', 'contributor'], seconds: 6, framing: 'Over-the-shoulder two-shot, vertical framing', camera: 'Slow gentle push-in', lighting: 'Warm golden-hour sunlight, soft rim light', mood: 'Warm, welcoming, familiar', setting: 'a family compound courtyard with earthen walls', action: 'A young woman arrives at the courtyard and the elder looks up from her stool with a delighted smile, opens her arms in welcome and gestures for her to sit; they share an easy, affectionate laugh.', avoid: 'any text; any change to faces or clothing' },
  { key: 'record-voice', who: ['contributor'], seconds: 6, framing: 'Close-up, vertical framing, eye level', camera: 'Slow gentle push-in', lighting: 'Soft warm daylight through a curtain', mood: 'Intimate, thoughtful', setting: 'a quiet bedroom with woven cloth wall hangings', action: 'The contributor holds her phone close, thumb on the screen with the screen turned away from the camera, speaks softly and naturally into it, pauses, smiles to herself and speaks again. Unhurried.' },
  { key: 'teen-listening', who: ['teen'], seconds: 6, framing: 'Medium close-up, vertical framing', camera: 'Slow gentle push-in', lighting: 'Soft evening light and the warm glow of a desk lamp', mood: 'Curious then delighted', setting: 'a small city apartment bedroom with a desk, a notebook and a window showing a dusk skyline', action: 'The teenager listens carefully through her earbuds, her brow furrowed in concentration; her face then lights up with recognition and a slow smile, and she repeats something quietly under her breath.' },
  { key: 'compound-wide', who: ['elder'], seconds: 5, framing: 'Wide vertical shot', camera: 'Very slow gentle push-in', lighting: 'Warm golden-hour sunlight, soft long shadows', mood: 'Warm, peaceful', setting: 'a Ghanaian family compound courtyard with earthen painted walls, a shea tree, chickens in the distance, an elder seated on a low stool with family members sitting nearby sharing food', action: 'Family members chat easily around the elder, passing a bowl; a child runs across the background. Gentle natural movement.', avoid: 'vehicles, any text or signs' },
];

async function refs() {
  st.refs ??= {};
  for (const [key, p] of Object.entries(PEOPLE)) {
    if (st.refs[key]) continue;
    const req = jobRequestSchema.parse({ type: 'image.generate', projectId, prompt: p.prompt, purpose: 'character', aspectRatio: '3:4', imageSize: '1K', referenceAssetIds: [], applyStyleBible: false, title: `ref ${key}`, label: `Indigen series ref · ${key}` });
    const [id] = await submitJobs(owner, [req], `ref ${key}`);
    const job = await waitForJob(id!, say, 15 * 60_000);
    say(`${key}: ${job.status} ${JSON.stringify(job.result?.assetIds ?? job.error)}`);
    if (job.status === 'completed') st = patchState({ refs: { ...(loadState().refs ?? {}), [key]: (job.result as any).assetIds[0] } });
  }
}

async function shots() {
  for (const s of SHOTS.filter((x) => !only.length || only.includes(x.key))) {
    const cur = loadState();
    if (cur.shots?.[s.key]) { say(`skip ${s.key} (done)`); continue; }
    const body = compileShotPrompt(
      { framing: s.framing, cameraMovement: s.camera, lens: '50mm lens', lighting: s.lighting, mood: s.mood, style: 'Photoreal cinematic, shallow depth of field, natural skin texture, true-to-life colour', performance: 'Natural, unforced', action: s.action, dialogue: [], ambientSound: 'Quiet natural room tone only', avoid: `${s.avoid ?? ''} text, captions, subtitles, lettering, signs, logos, watermarks; brand marks; vehicles; any readable screen; picture-in-picture, letterboxing or borders: full-frame edge to edge`.trim() },
      {
        characters: s.who.map((w, i) => ({ tag: `<IMAGE_REF_${i}>`, name: w, description: PEOPLE[w]!.desc })),
        locations: [{ tag: '', name: 'the setting', description: s.setting }],
        noBackgroundMusic: true,
        noOverlayText: true,
      },
    );
    const req = jobRequestSchema.parse({
      type: 'video.generate', projectId, mode: 'generate', prompt: body, aspectRatio: '9:16', resolution: '720p', durationSec: s.seconds,
      media: s.who.map((w) => ({ role: 'image_ref', assetId: cur.refs[w], label: w })), title: s.key, label: `Indigen series · ${s.key}`,
    });
    const [id] = await submitJobs(owner, [req], `Indigen · ${s.key}`);
    const job = await waitForJob(id!, say, 30 * 60_000);
    say(`${s.key}: ${job.status} ${JSON.stringify(job.result?.assetIds ?? job.error)}`);
    if (job.status === 'completed') patchState({ shots: { ...(loadState().shots ?? {}), [s.key]: (job.result as any).assetIds[0] } });
  }
}

async function fetch() {
  const cur = loadState();
  const dir = path.join(WORK, 'human');
  mkdirSync(dir, { recursive: true });
  for (const [group, map] of [['ref', cur.refs ?? {}], ['shot', cur.shots ?? {}]] as const) {
    for (const [key, id] of Object.entries(map as Record<string, string>)) {
      const a = (await col.assets().doc(id).get()).data()!;
      const src = group === 'ref' && a.thumbPath ? a.thumbPath : a.storagePath;
      const dest = path.join(dir, `${group}-${key}${path.extname(src)}`);
      await bucket.file(src).download({ destination: dest });
      say(`${dest} ${a.width}x${a.height} ${a.durationSec ?? ''}`);
    }
  }
}

const fn: Record<string, () => Promise<void>> = { refs, shots, fetch, status: async () => say(JSON.stringify({ refs: st.refs, shots: st.shots })) };
await fn[step]!();
process.exit(0);
