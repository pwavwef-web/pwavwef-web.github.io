import '../../../tests/acceptance/setup';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { emptyTimeline, addTrack, makeClip, validateTimeline, jobRequestSchema, sumEstimates } from '@az-studio/shared';
import { col, bucket, FieldValue } from '../../../functions/src/lib/firebase';
import { studioOwner, getJob } from '../../../tests/acceptance/harness';
import { prepareAll, createJobs } from '../../../functions/src/lib/submit';
import { PRICING } from '../../../functions/src/config/pricing';
import { buildSegment, buildAudioMix, muxArgs, type RenderSnapshot } from '../../../services/renderer/src/graph';

const require = createRequire(import.meta.url);
const ff = require('ffmpeg-static') as string;
const OUT = path.join(process.cwd(), 'exports', 'francis-has-a-plan');
const ORIGINAL = JSON.parse(readFileSync(path.join(OUT, 'production-state.json'), 'utf8'));
const STATE = path.join(OUT, 'tight-cut-state.json');
let st: any = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = (p: any) => { st = { ...st, ...p }; writeFileSync(STATE, JSON.stringify(st, null, 2)); };
const mode = process.argv[2] ?? 'preview';
const DURATION = 20;
const ids = ORIGINAL.assetIds;
const sourceDurations = [9.024, 10.027, 10.027, 8.931, 90.906];
const cut = [
  { source: 0, start: 0, window: 3.5, inPoint: 1.25, label: 'Confident start — straight into the work' },
  { source: 0, start: 3.5, window: 2, inPoint: 6, label: 'One confident nod' },
  { source: 1, start: 5.5, window: 4.5, inPoint: 1.25, label: 'Paper avalanche' },
  { source: 1, start: 10, window: 2, inPoint: 7.75, label: 'Defeated look to camera' },
  { source: 2, start: 12, window: 1.25, inPoint: 1.25, label: 'Everything is fine — brief thumbs-up' },
  { source: 2, start: 13.25, window: 1.125, inPoint: 5, label: 'Phone buzz — close insert, face out of frame' },
  { source: -1, start: 14.375, window: 2.5, inPoint: 0, label: 'The message' },
  { source: 2, start: 16.875, window: 1.75, inPoint: 8, label: 'Shocked face, no explanation' },
];
let t = emptyTimeline('9:16', 24);
while (t.tracks.filter(x => x.kind === 'video').length < cut.length) t = addTrack(t, 'video', `Picture ${t.tracks.filter(x => x.kind === 'video').length + 1}`);
const picture = t.tracks.filter(x => x.kind === 'video');
for (const [i, c] of cut.entries()) {
  if (c.source < 0) {
    t.clips.push(makeClip({ trackId: picture[i].id, kind: 'title', start: c.start, duration: c.window + 0.125, text: '', style: { font: 'Inter', sizePct: 4, color: '#FFFFFF', background: '#163025', bold: false, italic: false, uppercase: false, outline: 0, shadow: false }, label: c.label }));
  } else {
    const clip = makeClip({ trackId: picture[i].id, kind: 'video', start: c.start, duration: c.window + 0.125, assetId: ids[c.source], inPoint: c.inPoint, sourceDuration: sourceDurations[c.source], useSourceAudio: true, volume: 0.8, label: c.label });
    if (i === 5) clip.reframe = { '9:16': { aspect: '9:16', crop: { w: 0.48, h: 0.48 }, keyframes: [{ t: 0, cx: 0.43, cy: 0.76, manual: true }], analysedAt: null, cutHeads: [] } };
    t.clips.push(clip);
  }
}
const ov = t.tracks.find(x => x.kind === 'overlay')!;
t.clips.push(makeClip({ trackId: ov.id, kind: 'title', start: 0.25, duration: 2.75, text: 'FRANCIS\nHAS A PLAN', style: { font: 'Inter', sizePct: 8.8, color: '#FFE6A3', background: null, bold: true, italic: false, uppercase: true, outline: 2, shadow: true }, position: { anchor: 'top', offset: 0.09, align: 'center' }, fadeIn: 0.125, fadeOut: 0.125, label: 'Series title' }));
t.clips.push(makeClip({ trackId: ov.id, kind: 'title', start: 18.625, duration: 1.375, text: '', style: { font: 'Inter', sizePct: 4, color: '#FFFFFF', background: '#000000', bold: false, italic: false, uppercase: false, outline: 0, shadow: false }, label: 'Cliffhanger — hard cut to black' }));
const cap = t.tracks.find(x => x.kind === 'caption')!;
t.clips.push(makeClip({ trackId: cap.id, kind: 'caption', start: 14.375, duration: 2.5, text: 'Small change.\nCan we rebuild\neverything?', style: { font: 'Inter', sizePct: 5.3, color: '#F4FFF7', background: null, bold: false, italic: false, uppercase: false, outline: 0, shadow: false }, position: { anchor: 'middle', offset: 0, align: 'center' }, label: 'Exact incoming message' }));
t = addTrack(t, 'overlay', 'Message sender');
t.clips.push(makeClip({ trackId: t.tracks.filter(x => x.kind === 'overlay').at(-1)!.id, kind: 'title', start: 14.375, duration: 2.5, text: 'PROJECT CHAT', style: { font: 'Inter', sizePct: 2.5, color: '#A7D9B9', background: null, bold: true, italic: false, uppercase: true, outline: 0, shadow: false }, position: { anchor: 'top', offset: 0.35, align: 'center' }, label: 'Incoming message sender' }));
t = addTrack(t, 'overlay', 'Message timestamp');
t.clips.push(makeClip({ trackId: t.tracks.filter(x => x.kind === 'overlay').at(-1)!.id, kind: 'title', start: 14.375, duration: 2.5, text: 'now', style: { font: 'Inter', sizePct: 2, color: '#8BAF98', background: null, bold: false, italic: false, uppercase: false, outline: 0, shadow: false }, position: { anchor: 'bottom', offset: 0.36, align: 'center' }, label: 'Notification timestamp' }));
const audio = t.tracks.filter(x => x.kind === 'audio');
t.clips.push(makeClip({ trackId: audio[1].id, kind: 'audio', start: 0.25, duration: sourceDurations[3], assetId: ids[3], sourceDuration: sourceDurations[3], role: 'dialogue', volume: 1, label: 'Original dramatic narration' }));
t.clips.push(makeClip({ trackId: audio[0].id, kind: 'audio', start: 0, duration: 13.125, assetId: ids[4], sourceDuration: sourceDurations[4], role: 'music', volume: 0.22, duck: true, duckDb: 7, fadeOut: 0.125, label: 'Sitcom cue — stops before phone buzz' }));
const problems = validateTimeline(t);
if (problems.length) throw new Error(JSON.stringify(problems));
writeFileSync(path.join(OUT, 'timeline-tight-cut.json'), JSON.stringify(t, null, 2));
save({ projectId: ORIGINAL.projectId, durationSec: DURATION, timelineId: 'trailer-tight-cut' });

if (mode === 'preview') {
  const work = path.join(OUT, 'tight-cut-preview');
  mkdirSync(work, { recursive: true });
  const files = Object.fromEntries(ids.map((id: string, i: number) => [id, path.join(OUT, 'sources', `${i + 1}-${['start', 'obstacle', 'control', 'narration', 'music'][i]}${i < 3 ? '.mp4' : i === 3 ? '.wav' : '.mp3'}`)]));
  const snap: RenderSnapshot = { ...t, width: 720, height: 1280, fps: 24, durationSec: DURATION, quality: 'draft', audioMaster: 'preserve', assets: Object.fromEntries(ids.map((id: string, i: number) => [id, { kind: i < 3 ? 'video' : 'audio', storagePath: id, width: i < 3 ? 720 : null, height: i < 3 ? 1280 : null, durationSec: sourceDurations[i], hasAudio: true }])) };
  const p = buildSegment(snap, { index: 0, start: 0, end: DURATION }, { resolve: id => files[id], filterScriptPath: path.join(work, 'picture.filter'), assPath: path.join(work, 'text.ass'), fontsDir: 'C:/Windows/Fonts', outputPath: path.join(work, 'picture.mp4'), aspect: '9:16' });
  writeFileSync(path.join(work, 'picture.filter'), p.filter);
  if (p.ass) writeFileSync(path.join(work, 'text.ass'), p.ass);
  const run = (args: string[]) => { const r = spawnSync(ff, args, { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 }); if (r.status) throw new Error(r.stderr); };
  run(p.args);
  const mix = buildAudioMix(snap, id => files[id], path.join(work, 'audio.m4a'), path.join(work, 'audio.filter'));
  writeFileSync(path.join(work, 'audio.filter'), mix.filter);
  run(mix.args);
  run(muxArgs(path.join(work, 'picture.mp4'), path.join(work, 'audio.m4a'), path.join(work, 'preview.mp4'), DURATION, { title: 'Francis Has a Plan — tight cut preview', encoder: 'AZ Studio renderer' }));
  console.log(path.join(work, 'preview.mp4'));
}
if (mode === 'submit') {
  if (st.renderJobId) throw new Error('Already submitted; use finish.');
  const owner = await studioOwner();
  await col.timelines(st.projectId).doc(st.timelineId).set({ ...t, ownerUid: owner.uid, projectId: st.projectId, name: 'Francis Has a Plan — tighter 20-second cut', durationSec: DURATION, version: 1, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  const req = jobRequestSchema.parse({ type: 'render.timeline', projectId: st.projectId, timelineId: st.timelineId, preset: 'vertical_9x16', quality: 'draft', inspect: false, acceptLyricSync: false, audioMaster: 'preserve', label: 'Francis sitcom · tighter 20-second cut with message' });
  const prepared = await prepareAll(owner.uid, [req]);
  const estimate = sumEstimates(prepared.map(p => p.estimate), PRICING).usd;
  console.log(JSON.stringify({ exportEstimateUsd: estimate, newGenerations: 0 }));
  const res = await createJobs(owner.uid, [req], { confirmedUsd: estimate }, prepared);
  save({ renderJobId: res.jobIds[0], exportEstimateUsd: estimate });
  console.log(JSON.stringify({ renderJobId: st.renderJobId }));
}
if (mode === 'finish') {
  const until = Date.now() + 10 * 60_000;
  let last = '';
  let job;
  for (;;) {
    job = await getJob(st.renderJobId);
    const status = `${job.status}: ${job.stage}`;
    if (status !== last) console.log(status);
    last = status;
    if (job.status === 'completed') break;
    if (['failed', 'cancelled'].includes(job.status)) throw new Error(job.error?.message ?? status);
    if (Date.now() > until) throw new Error('Still rendering; resume with finish.');
    await new Promise(r => setTimeout(r, 15000));
  }
  const id = job.result!.assetIds![0];
  const a = (await col.assets().doc(id).get()).data()!;
  const file = path.join(OUT, 'Francis-Has-a-Plan-Tight-Cut.mp4');
  await bucket.file(a.storagePath).download({ destination: file });
  save({ file, renderAssetId: id, recordedExportCostUsd: job.usageUsd, cumulativeCostUsd: ORIGINAL.recordedCostUsd + (job.usageUsd ?? 0) });
  console.log(JSON.stringify({ file, durationSec: a.durationSec, exportCostUsd: job.usageUsd, cumulativeCostUsd: st.cumulativeCostUsd }));
}
