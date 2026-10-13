import '../../../tests/acceptance/setup';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { jobRequestSchema, sumEstimates, emptyTimeline, makeClip, addTrack, validateTimeline } from '@az-studio/shared';
import { studioOwner, uploadFile, getJob } from '../../../tests/acceptance/harness';
import { col, bucket, FieldValue } from '../../../functions/src/lib/firebase';
import { prepareAll, createJobs, confirmationPolicy } from '../../../functions/src/lib/submit';
import { getSettings } from '../../../functions/src/lib/usage';
import { PRICING } from '../../../functions/src/config/pricing';
import { enqueueJob } from '../../../functions/src/lib/jobs';

const OUT = path.join(process.cwd(), 'exports', 'francis-has-a-plan');
mkdirSync(OUT, { recursive: true });
const stateFile = path.join(OUT, 'production-state.json');
let st: any = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const save = (patch: any) => { st = { ...st, ...patch }; writeFileSync(stateFile, JSON.stringify(st, null, 2)); };
const log = (s: string) => console.log(s);
const owner = await studioOwner();
const mode = process.argv[2] ?? 'prepare';
const identity = 'Francis is the exact adult man in <IMAGE_REF_0>: preserve his face, skin tone, short natural black hair, light stubble, red polo shirt and white collar. Natural facial acting. Warm realistic single-camera sitcom, modest cream-walled home office, wooden desk, laptop, black smartphone, compact white printer. Same room and wardrobe throughout. Photorealistic live action, subtle film grain, eye-level camera, warm afternoon window light, gentle comic timing. No captions, subtitles, watermarks, logos, narration, dialogue or music; only natural room tone and specified foley.';
const shots = [
  { id: 'start', title: 'The plan', sec: 9, action: 'One continuous medium-wide shot. 0–2s: Francis sits confidently at the desk, rolls his shoulders, smiles like today is his day. 2–5s: opens the laptop with a grand flourish, briskly types, taps the enter key decisively. A framed graduation photograph is on the desk; laptop screen faces away from camera. 5–9s: folds his arms with a proud little nod, turns to the printer with expectant raised eyebrows. Underplay the confidence; let his face carry the joke. Foley: chair creak, typing, one enter-key tap.' },
  { id: 'obstacle', title: 'The printer has other plans', sec: 10, action: 'One continuous medium shot with the printer visible beside Francis. 0–2s: printer starts feeding one sheet of blank paper. 2–6s: it keeps feeding an absurd stream of blank sheets; paper slides off the desk into his lap. Francis calmly collects the first sheet, then watches the pile grow, his smile slowly draining. 6–8s: he presses the printer button once. It spits out another sheet immediately. 8–10s: he gives the camera a long, completely silent deadpan look, holding the useless page. Physically believable hands and paper, no floating objects. Foley: escalating printer whir, paper rustle, button click. No speech.' },
  { id: 'control', title: 'Everything is under control', sec: 10, action: 'One continuous medium close-up. Francis sits at the same desk with the heap of printer paper visible at bottom of frame. 0–3s: he slowly slides the papers out of frame with one hand, straightens his collar, gives the camera a tight reassuring smile and a small thumbs-up. 3–5s: holds the smile a little too long; one eyebrow twitches. 5–6s: the black phone on the desk suddenly vibrates twice with audible bzz-bzz. 6–8s: he glances down, picks it up naturally and reads the screen; screen faces him and is never readable. 8–10s: his smile freezes, eyes widen slightly, he stares at the phone without moving. Hold this reaction for the last two seconds. Do not fade to black within the shot; the edit will cut to black. Foley: paper scrape then unmistakable double phone vibration. No speech.' },
];

if (mode === 'prepare') {
  if (!st.projectId) {
    const ref = col.projects().doc();
    await ref.set({ ownerUid: owner.uid, title: 'Francis Has a Plan — 30-second sitcom trailer', type: 'film', status: 'active', genre: 'Sitcom / comedy', language: 'en', format: { aspectRatio: '9:16', fps: 24, videoResolution: '720p' }, productionQuality: 'final', logline: 'A man with a degree, a dream, and seventeen tabs open meets a printer with its own agenda.', idea: 'Three scenes: confidence, absurd obstacle, pretending everything is fine. Phone buzz, silent stare, hard cut to black. Facial expressions carry the comedy.', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    save({ projectId: ref.id });
  }
  if (!st.portraitAssetId) {
    const a = await uploadFile(owner, st.projectId, 'C:/Users/DELL/Pictures/Photos/2026/2026-09/Portraits/WhatsApp Image 2026-09-11 at 12.00.38 (1).jpeg', 'image', 'image/jpeg', log);
    await col.assets().doc(a.id).set({ title: 'Francis — supplied identity reference' }, { merge: true });
    await col.projects().doc(st.projectId).set({ coverAssetId: a.id }, { merge: true });
    save({ portraitAssetId: a.id });
  }
  const requests: any[] = [];
  for (const [i, s] of shots.entries()) {
    const prompt = `${identity}\nDuration ${s.sec} seconds, vertical 9:16.\n${s.action}`;
    await col.projects().doc(st.projectId).collection('shots').doc(s.id).set({ sceneId: null, order: i + 1, number: String(i + 1), title: s.title, description: s.action, durationSec: s.sec, aspectRatio: '9:16', resolution: '720p', refs: { assetIds: [st.portraitAssetId], characterIds: [], locationIds: [], elementIds: [], firstFrameAssetId: null, lastFrameAssetId: null, storyboardAssetId: null }, promptOverride: prompt, status: 'planned', takeCount: 0, selectedTakeId: null, approvedTakeId: null, createdAt: FieldValue.serverTimestamp() });
    requests.push({ type: 'video.generate', projectId: st.projectId, mode: 'generate', prompt, promptFinal: true, aspectRatio: '9:16', resolution: '720p', durationSec: s.sec, media: [{ role: 'image_ref', assetId: st.portraitAssetId, label: 'Francis identity' }], characterIds: [], target: { kind: 'shot', id: s.id }, title: s.title, label: `Francis sitcom · scene ${i + 1}` });
  }
  requests.push({ type: 'speech.generate', projectId: st.projectId, languageCode: 'en', lines: [{ index: 0, character: 'Trailer narrator', text: 'He had a degree. He had a dream. He had seventeen tabs open.', voice: 'Charon', direction: 'Deep dramatic movie-trailer narrator. Warm, deadpan gravitas. Comically serious, three deliberate beats. Say exactly these words in about seven seconds. No extra words.' }], label: 'Francis sitcom · dramatic narration' });
  requests.push({ type: 'music.generate', projectId: st.projectId, purpose: 'song', prompt: 'Create a 30-second purely instrumental lighthearted sitcom trailer cue. Bouncy pizzicato strings, muted bass, dry rim-click drums and a playful clarinet motif, 112 BPM, warm dry small ensemble. Low density underneath narration. Start immediately, mischievous comic lift around 9 seconds, another comic lift around 19 seconds. Thin out from 24 seconds and stop abruptly at 26 seconds for a phone-buzz reaction. No vocals, no speech, no laughter, no sound effects.', instrumental: true, lyrics: null, languageCode: null, imageAssetIds: [], title: 'Francis Has a Plan — sitcom cue', label: 'Francis sitcom · original instrumental cue' });
  const parsed = requests.map(r => jobRequestSchema.parse(r));
  const prepared = await prepareAll(owner.uid, parsed);
  const total = sumEstimates(prepared.map(p => p.estimate), PRICING);
  const policy = confirmationPolicy(await getSettings(owner.uid), prepared, total.usd);
  save({ requests: parsed, estimateUsd: total.usd });
  writeFileSync(path.join(OUT, 'creative-plan.md'), '# Francis Has a Plan\n\n30 seconds · vertical 9:16 · AZ Studio\n\n0–9s: confident laptop start.\n9–19s: the printer refuses to stop.\n19–29s: forced smile, phone buzz, stare.\n29–30s: hard cut to black.\n\nVoice-over: “He had a degree. He had a dream. He had seventeen tabs open.”\n\nSupplied portrait is used as identity reference. Scenes, voice, and music are generated with AZ Studio.\n');
  console.log(JSON.stringify({ projectId: st.projectId, estimateUsd: total.usd, confirmation: policy, perJob: prepared.map(p => ({ type: p.type, usd: p.estimate.usd })) }));
}
if (mode === 'submit') {
  if (st.jobIds) throw new Error('Already submitted; use status.');
  const parsed = st.requests.map((r: any) => jobRequestSchema.parse(r));
  const prepared = await prepareAll(owner.uid, parsed);
  const total = sumEstimates(prepared.map(p => p.estimate), PRICING);
  const result = await createJobs(owner.uid, parsed, { confirmedUsd: total.usd, batchLabel: 'Francis Has a Plan · trailer' }, prepared);
  save({ jobIds: result.jobIds });
  console.log(JSON.stringify({ jobIds: result.jobIds, estimateUsd: result.estimate.usd }));
}
if (mode === 'status') {
  for (const id of [...(st.jobIds ?? []), ...(st.renderJobId ? [st.renderJobId] : [])]) {
    const j = await getJob(id);
    console.log(JSON.stringify({ id, type: j.type, status: j.status, stage: j.stage, result: j.result, error: j.error?.message ?? null, usageUsd: j.usageUsd }));
  }
}
if (mode === 'render-status') {
  const snap = await col.jobs().where('projectId', '==', st.projectId).get();
  const renders = snap.docs.filter(d => d.get('type') === 'render.timeline').sort((a, b) => b.get('createdAt').toMillis() - a.get('createdAt').toMillis());
  for (const d of renders.slice(0, 1)) {
    save({ renderJobId: d.id });
    console.log(JSON.stringify({ id: d.id, status: d.get('status'), stage: d.get('stage'), result: d.get('result'), error: d.get('error'), usageUsd: d.get('usageUsd') }));
  }
}
if (mode === 'dispatch-render') {
  const j = await getJob(st.renderJobId);
  if (j.status === 'queued') await enqueueJob(j.id, 'start');
  console.log(JSON.stringify({ id: j.id, status: j.status, dispatched: j.status === 'queued' }));
}
if (mode === 'sources') {
  mkdirSync(path.join(OUT, 'sources'), { recursive: true });
  for (const [i, id] of st.jobIds.entries()) {
    const j = await getJob(id);
    if (j.status !== 'completed') continue;
    const a = (await col.assets().doc(j.result!.assetIds![0]).get()).data()!;
    const file = path.join(OUT, 'sources', `${i + 1}-${i < 3 ? shots[i].id : i === 3 ? 'narration' : 'music'}${path.extname(a.fileName || a.storagePath)}`);
    if (!existsSync(file)) await bucket.file(a.storagePath).download({ destination: file });
    console.log(JSON.stringify({ file, durationSec: a.durationSec, width: a.width, height: a.height }));
  }
}
if (mode === 'assemble' || mode === 'rerender') {
  const jobs = await Promise.all(st.jobIds.map((id: string) => getJob(id)));
  if (jobs.some(j => j.status !== 'completed')) throw new Error('Some generation jobs are not completed.');
  const ids = jobs.map(j => j.result!.assetIds![0]);
  const assets = await Promise.all(ids.map(async (id: string) => ({ id, ...(await col.assets().doc(id).get()).data()! })));
  let t = emptyTimeline('9:16', 24);
  t = addTrack(t, 'video', 'V3 Final reaction');
  const vs = t.tracks.filter(x => x.kind === 'video');
  let start = 0;
  const windows = [8.875, 9.875, 9.875];
  for (let i = 0; i < 3; i++) {
    const a: any = assets[i];
    if (a.durationSec + 0.05 < shots[i].sec) throw new Error('Source is too short');
    t.clips.push(makeClip({ trackId: vs[i].id, kind: 'video', start, duration: Math.min(windows[i] + 0.125, a.durationSec), sourceDuration: a.durationSec, assetId: ids[i], shotId: shots[i].id, useSourceAudio: true, volume: 0.8, label: shots[i].title }));
    start += windows[i];
  }
  const overlay = t.tracks.find(x => x.kind === 'overlay')!;
  t.clips.push(makeClip({ trackId: overlay.id, kind: 'title', start: 1.5, duration: 3.5, text: 'FRANCIS\nHAS A PLAN', style: { font: 'Inter', sizePct: 8.8, color: '#FFE6A3', background: null, bold: true, italic: false, uppercase: true, outline: 2, shadow: true }, position: { anchor: 'top', offset: 0.09, align: 'center' }, fadeIn: 0.2, fadeOut: 0.2, label: 'Series title' }));
  t.clips.push(makeClip({ trackId: overlay.id, kind: 'title', start, duration: 30 - start, text: '', style: { font: 'Inter', sizePct: 4, color: '#FFFFFF', background: '#000000', bold: false, italic: false, uppercase: false, outline: 0, shadow: false }, label: 'Intentional cliffhanger cut to black' }));
  const aud = t.tracks.filter(x => x.kind === 'audio');
  const voice: any = assets[3], music: any = assets[4];
  t.clips.push(makeClip({ trackId: aud[1].id, kind: 'audio', start: 0.5, duration: voice.durationSec, sourceDuration: voice.durationSec, assetId: ids[3], role: 'dialogue', volume: 1, label: 'Dramatic narrator' }));
  t.clips.push(makeClip({ trackId: aud[0].id, kind: 'audio', start: 0, duration: Math.min(23.5, music.durationSec), sourceDuration: music.durationSec, assetId: ids[4], role: 'music', volume: 0.22, duck: true, duckDb: -7, fadeOut: 0.25, label: 'Original sitcom cue — stops before buzz' }));
  const issues = validateTimeline(t);
  if (issues.length) throw new Error(JSON.stringify(issues));
  const ref = col.timelines(st.projectId).doc('trailer');
  await ref.set({ ...t, ownerUid: owner.uid, projectId: st.projectId, name: 'Francis Has a Plan — 30-second trailer', durationSec: 30, version: 1, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify(t, null, 2));
  save({ timelineId: ref.id, assetIds: ids });
  if (st.renderJobId && mode !== 'rerender') throw new Error('A render already exists.');
  if (mode === 'rerender') save({ previousRenderJobIds: [...(st.previousRenderJobIds ?? []), st.renderJobId] });
  const req = jobRequestSchema.parse({ type: 'render.timeline', projectId: st.projectId, timelineId: ref.id, preset: 'vertical_9x16', quality: 'draft', inspect: false, acceptLyricSync: false, audioMaster: 'preserve', label: 'Francis sitcom · 30-second export' });
  const prepared = await prepareAll(owner.uid, [req]);
  const result = await createJobs(owner.uid, [req], { confirmedUsd: sumEstimates(prepared.map(p => p.estimate), PRICING).usd }, prepared);
  save({ renderJobId: result.jobIds[0] });
  console.log(JSON.stringify({ renderJobId: st.renderJobId, estimateUsd: result.estimate.usd }));
}
if (mode === 'download' || mode === 'finish') {
  if (mode === 'finish') {
    const until = Date.now() + 10 * 60_000;
    let last = '';
    for (;;) {
      const j = await getJob(st.renderJobId);
      const line = `${j.status}: ${j.stage}`;
      if (line !== last) console.log(line);
      last = line;
      if (j.status === 'completed') break;
      if (['failed', 'cancelled'].includes(j.status)) throw new Error(j.error?.message ?? line);
      if (Date.now() > until) throw new Error('Export is still running; resume with finish.');
      await new Promise(r => setTimeout(r, 15000));
    }
  }
  const job = await getJob(st.renderJobId);
  if (job.status !== 'completed') throw new Error('Render not completed');
  const id = job.result!.assetIds![0];
  const a = (await col.assets().doc(id).get()).data()!;
  const file = path.join(OUT, 'Francis-Has-a-Plan.mp4');
  await bucket.file(a.storagePath).download({ destination: file });
  if (a.posterPath) await bucket.file(a.posterPath).download({ destination: path.join(OUT, 'poster.jpg') });
  save({ renderAssetId: id, finalFile: file });
  const costJobs = await Promise.all([...(st.jobIds ?? []), ...(st.previousRenderJobIds ?? []), st.renderJobId].map(id => getJob(id)));
  const costUsd = costJobs.reduce((s, j) => s + (j.usageUsd ?? 0), 0);
  save({ recordedCostUsd: +costUsd.toFixed(6) });
  writeFileSync(path.join(OUT, 'production-report.json'), JSON.stringify({ title: 'Francis Has a Plan', projectUrl: `https://az-studio.web.app/projects/${st.projectId}/film/timeline`, durationSec: a.durationSec, width: a.width, height: a.height, fps: 24, recordedCostUsd: +costUsd.toFixed(6), tools: ['AZ Studio video generation', 'AZ Studio speech generation', 'AZ Studio music generation', 'AZ Studio timeline and FFmpeg renderer'], identityReference: 'User-supplied portrait', sceneWindows: [[0, 8.875], [8.875, 18.75], [18.75, 28.625]], intentionalBlack: [28.625, 30] }, null, 2));
  console.log(JSON.stringify({ file, durationSec: a.durationSec, width: a.width, height: a.height }));
}
