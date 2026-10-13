import { readFileSync } from 'node:fs';
import { compileShotPrompt, jobRequestSchema, isTerminal } from '@az-studio/shared';
import { col, FieldValue, loadState, patchState, say, sleep, studioOwner, submitJobs, getJob } from './common';
import { SHOTS, genSeconds, type ShotSpec } from './shots';

// Usage: 09-generate.ts <resolution> [only=1,2,3] [aspects=16:9,9:16]
const resolution = process.argv[2] ?? '1080p';
const only = (process.argv.find((a) => a.startsWith('only='))?.slice(5) ?? '').split(',').filter(Boolean).map(Number);
const aspects = (process.argv.find((a) => a.startsWith('aspects='))?.slice(8) ?? '16:9,9:16').split(',') as ('16:9' | '9:16')[];
const overridesArg = process.argv.find((a) => a.startsWith('overrides='))?.slice(10);
const overrides: Record<string, { tag: string; spec: Partial<ShotSpec> }> = overridesArg ? JSON.parse(readFileSync(overridesArg, 'utf8')) : {};
const owner = await studioOwner();
let st = loadState();
const projectId = st.projectId as string;

const A = { L: st.refResults.learner_portrait.assetIds[0], A: st.ref2Results.alima_new.assetIds[0], M: st.ref2Results.amina_new.assetIds[0] };
const LOC = { compound: st.refResults.compound.assetIds[0], baobab: st.refResults.baobab.assetIds[0], lane: st.refResults.lane.assetIds[0] };
const CH = { L: st.chars.learner, A: st.chars.alima, M: st.chars.amina };
const WHO: Record<string, { name: string; desc: string }> = {
  L: { name: 'The learner (the man in the red polo shirt)', desc: 'keep exactly the face, skin tone, short natural black hair, light stubble beard and the bright red polo with white striped collar from this reference; dark indigo trousers, brown leather sandals, thin gold chain' },
  A: { name: 'Mama Alima, the elder', desc: 'keep exactly her face and the rust-red and mustard head wrap, white blouse and beaded wooden necklace from this reference' },
  M: { name: 'Amina, the eight-year-old girl', desc: 'keep exactly her face, braids with coloured beads and the mustard-yellow embroidered dress from this reference' },
};
const LOCS: Record<string, { name: string; desc: string }> = {
  compound: { name: 'the painted compound courtyard', desc: 'earthen buildings with hand-painted black, white and terracotta geometric walls, swept red-brown earth, a large shade tree' },
  baobab: { name: 'the baobab gathering ground', desc: 'wide open ground under a massive baobab tree' },
  lane: { name: 'the village lane', desc: 'dusty red-earth lane between earthen walls, a trader table under a patched umbrella, a tree at the end of the lane' },
};
const STYLE = 'Photoreal cinematic look, real 35mm film texture, warm golden palette of terracotta red, mustard, chalk white, deep mahogany and baobab green, natural skin texture, shallow depth of field. Real people with correct anatomy and natural hands.';

function promptFor(s: ShotSpec, aspect: '16:9' | '9:16') {
  const order: string[] = [];
  const media: { role: 'image_ref'; assetId: string; label: string }[] = [];
  const characters = s.who.map((w) => {
    const tag = `<IMAGE_REF_${media.length}>`;
    media.push({ role: 'image_ref', assetId: A[w as 'L' | 'A' | 'M'], label: WHO[w]!.name });
    order.push(w);
    return { tag, name: WHO[w]!.name, description: WHO[w]!.desc };
  });
  const locTag = `<IMAGE_REF_${media.length}>`;
  media.push({ role: 'image_ref', assetId: LOC[s.where], label: LOCS[s.where]!.name });
  const body = compileShotPrompt(
    {
      framing: aspect === '16:9' ? s.h : s.v,
      cameraMovement: s.move,
      lens: s.lens,
      lighting: s.light,
      mood: s.mood,
      style: STYLE,
      performance: s.perf,
      action: `${s.action} Steady, rhythmic movement at a relaxed mid-tempo pace.`,
      dialogue: [],
      ambientSound: s.sing ? 'Soft natural ambience only' : 'Soft natural ambience, footsteps, cloth, laughter',
      avoid: 'text, captions, subtitles, lettering, signs, logos or watermarks anywhere in the frame; any change to the learner\'s face, hair or red polo shirt; cartoon or plastic look; extra fingers or distorted faces; people looking at the camera except where directed; blurred or merged bodies',
    },
    {
      characters,
      locations: [{ tag: locTag, name: LOCS[s.where]!.name, description: LOCS[s.where]!.desc }],
      others: [{ tag: '', name: 'Other villagers where mentioned', description: 'a natural mix of ages in everyday clothes in warm colours, never looking at the camera' }],
      noBackgroundMusic: true,
      noOverlayText: true,
    },
  );
  return { body: s.sing ? body : body, media, characterIds: s.who.map((w) => CH[w as 'L' | 'A' | 'M']) };
}

// 1. Shot documents (visible in AZ Studio) — one per shot and format.
const shotIds: Record<string, Record<number, string>> = st.shotIds ?? { '16:9': {}, '9:16': {} };
for (const aspect of aspects) {
  for (const s of SHOTS) {
    if (shotIds[aspect]?.[s.n]) continue;
    const ref = col.projects().doc(projectId).collection('shots').doc();
    const { media, characterIds } = promptFor(s, aspect);
    void media;
    await ref.set({
      sceneId: null, sectionId: null, order: s.start + (aspect === '9:16' ? 1000 : 0), number: `${String(s.n).padStart(2, '0')}${aspect === '16:9' ? 'H' : 'V'}`,
      title: `${s.title} (${aspect === '16:9' ? 'YouTube' : 'TikTok'})`, description: s.action,
      directions: { framing: aspect === '16:9' ? s.h : s.v, cameraMovement: s.move, lens: s.lens, lighting: s.light, mood: s.mood, style: STYLE, performance: s.perf, action: s.action, dialogue: [], ambientSound: '', avoid: '' },
      promptOverride: null, durationSec: genSeconds(s), aspectRatio: aspect, resolution,
      refs: { characterIds, locationIds: [], elementIds: [], assetIds: [], firstFrameAssetId: null, lastFrameAssetId: null, storyboardAssetId: null },
      lockRefs: false, status: 'planned', selectedTakeId: null, approvedTakeId: null, timing: { start: s.start, end: s.end }, takeCount: 0, notes: `Song ${s.start.toFixed(1)}–${s.end.toFixed(1)} s · ${s.section}${s.sing ? ' · lip-sync candidate' : ''}`,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    shotIds[aspect] = { ...(shotIds[aspect] ?? {}), [s.n]: ref.id };
    st = patchState({ shotIds });
  }
}

// 2. Submit the generations (skipping any that already have a live or finished job).
const jobs: Record<string, string> = st.genJobs ?? {};
const todo: { key: string; req: any }[] = [];
for (const aspect of aspects) {
  for (const s of SHOTS) {
    if (only.length && !only.includes(s.n)) continue;
    const ov = overrides[`${aspect}|${s.n}`];
    if (overridesArg && !ov) continue;
    const key = `${aspect}|${s.n}|${resolution}${ov ? `|${ov.tag}` : ''}`;
    if (jobs[key]) continue;
    const { body, media, characterIds } = promptFor(ov ? { ...s, ...ov.spec } : s, aspect);
    todo.push({
      key,
      req: jobRequestSchema.parse({
        type: 'video.generate', projectId, mode: 'generate', prompt: body, promptFinal: true, aspectRatio: aspect, resolution, durationSec: genSeconds(s),
        media, characterIds, title: `${String(s.n).padStart(2, '0')} ${s.title} (${aspect})`, label: `De N Lei · ${String(s.n).padStart(2, '0')} ${s.title} · ${aspect} · ${resolution}`,
        target: { kind: 'shot', id: shotIds[aspect]![s.n]! },
      }),
    });
  }
}
say(`${todo.length} generations to submit at ${resolution}`);
for (let i = 0; i < todo.length; i += 10) {
  const chunk = todo.slice(i, i + 10);
  const ids = await submitJobs(owner, chunk.map((c) => c.req), `De N Lei · shots ${i + 1}-${i + chunk.length}`);
  chunk.forEach((c, k) => { jobs[c.key] = ids[k]!; });
  st = patchState({ genJobs: jobs });
  say(`submitted ${i + chunk.length}/${todo.length}`);
}

// 3. Follow them to the end.
const pending = Object.entries(jobs).filter(([k]) => (!only.length || only.includes(Number(k.split('|')[1]))) && aspects.includes(k.split('|')[0] as any) && (!overridesArg || Object.values(overrides).some((o) => k.endsWith(`|${o.tag}`))));
let last = '';
for (;;) {
  const states = await Promise.all(pending.map(async ([k, id]) => [k, await getJob(id)] as const));
  const counts: Record<string, number> = {};
  for (const [, j] of states) counts[j.status] = (counts[j.status] ?? 0) + 1;
  const line = Object.entries(counts).map(([a, b]) => `${a}:${b}`).join(' ');
  if (line !== last) say(line);
  last = line;
  if (states.every(([, j]) => isTerminal(j.status))) {
    const out: Record<string, any> = st.genResults ?? {};
    for (const [k, j] of states) out[k] = { status: j.status, assetId: j.result?.assetIds?.[0] ?? null, error: j.error?.message ?? null, jobId: j.id };
    patchState({ genResults: out });
    for (const [k, j] of states) say(`${k}: ${j.status} ${j.result?.assetIds?.[0] ?? j.error?.message ?? ''}`);
    break;
  }
  await sleep(30_000);
}
