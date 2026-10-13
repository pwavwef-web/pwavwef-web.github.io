import './common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type AssetDoc, type Clip, makeClip, makeTrack, timelineDuration, type TextStyle } from '@az-studio/shared';
import * as actions from '../../../functions/src/api/actions';
import { bucket, col, FieldValue, loadState, OUT, patchState, say, saveState, sleep, studioOwner, submitJobs, uploadFile, waitForJob, WORK } from './common';
// @ts-expect-error plain ESM module shared with the scene renderer
import { buildSpec } from './spec.mjs';
import { VIDEOS } from './scripts';

// Usage: 03-assemble.ts upload|timeline|render|fetch <v1..v4> [draft|final]
const [step, key, mode = 'final'] = process.argv.slice(2);
const def = VIDEOS.find((v) => v.key === key)!;
const NAVY = '#0f1830';
const W = 1080;
const H = 1920;
const FPS = 30;
const fr = (x: number) => Math.round(x * FPS) / FPS;
const owner = await studioOwner();
const spec = buildSpec(key!);

type Seg = { type: 'scene' | 'human'; id: string; start: number; end: number };

async function upload() {
  const st = loadState();
  const pid = st.projects[key!] as string;
  st.assets ??= {};
  st.assets[key!] ??= {};
  const A = st.assets[key!] as Record<string, string>;
  const put = async (k: string, file: string, kind: 'audio' | 'video' | 'image', mime: string) => {
    if (A[k]) return;
    const a = await uploadFile(owner, pid, file, kind, mime, say);
    A[k] = a.id;
    patchState({ assets: { ...loadState().assets, [key!]: A } });
    say(`${k}: ${a.id} ${a.width ?? ''}x${a.height ?? ''} ${a.durationSec ?? ''}`);
  };
  for (const s of spec.segs as Seg[]) {
    const file = path.join(WORK, 'clips', key!, `${s.id}.mp4`);
    const stamp = readFileSync(file + '.stamp', 'utf8');
    if (A[`stamp:${s.id}`] !== stamp) { delete A[`clip:${s.id}`]; await put(`clip:${s.id}`, file, 'video', 'video/mp4'); A[`stamp:${s.id}`] = stamp; patchState({ assets: { ...loadState().assets, [key!]: A } }); }
  }
  for (const n of ['whoosh', 'tick', 'pop', 'lock', 'chime', 'fill', 'pulse']) await put(`sfx:${n}`, path.join(WORK, 'sfx', `${n}.wav`), 'audio', 'audio/wav');
  await put('scrim', path.join(WORK, 'scrim.png'), 'image', 'image/png');
}

async function timeline() {
  const st = loadState();
  const pid = st.projects[key!] as string;
  const A = st.assets[key!] as Record<string, string>;
  const doc = async (id: string) => (await col.assets().doc(id).get()).data() as AssetDoc;
  const musicId: string = st.music[key!].result.assetIds[0];
  const musicDoc = await doc(musicId);
  const speech = st.speech[key!] as { index: number; assetId: string; seconds: number }[];

  const tV1 = makeTrack('video', 'V1 Picture');
  const tScrim = makeTrack('overlay', 'Title scrims');
  const tT1 = makeTrack('overlay', 'Titles 1');
  const tT2 = makeTrack('overlay', 'Titles 2');
  const tT3 = makeTrack('overlay', 'Titles 3');
  const tT4 = makeTrack('overlay', 'Titles 4');
  const tSubs = makeTrack('caption', 'Captions');
  const tMusic = makeTrack('audio', 'A1 Music');
  const tVoice = makeTrack('audio', 'A2 Narration');
  tVoice.volume = Number(process.env.VOICE_GAIN ?? 1.35);
  const sfxTracks = [makeTrack('audio', 'A3 Effects'), makeTrack('audio', 'A4 Effects 2'), makeTrack('audio', 'A5 Effects 3')];
  const tracks = [tV1, tScrim, tT1, tT3, tT4, tT2, tSubs, tMusic, tVoice, ...sfxTracks];
  const clips: Clip[] = [];

  // ---- picture ----------------------------------------------------------------------------------------------
  (spec.segs as Seg[]).forEach((s, i) => {
    const a = null;
    void a;
    clips.push(makeClip({ trackId: tV1.id, kind: 'video', start: fr(s.start), duration: fr(s.end) - fr(s.start), assetId: A[`clip:${s.id}`]!, inPoint: 0, sourceDuration: null, fit: 'fill', useSourceAudio: false, volume: 0, transitionIn: i === 0 ? { type: 'cut', duration: 0 } : { type: 'dissolve', duration: 0.16 }, label: `${s.type === 'scene' ? 'Scene' : 'Footage'} · ${s.id}` }));
  });
  const total = fr(spec.total);

  // ---- titles over footage (editable) ---------------------------------------------------------------------
  const style = (o: Partial<TextStyle> & { sizePct: number }): TextStyle => ({ font: 'Inter', color: '#ffffff', background: null, bold: true, italic: false, uppercase: false, outline: 3, shadow: true, ...o });
  const titles = spec.titles as { text: string; start: number; end: number; kicker?: boolean }[];
  const lanes = [tT1, tT3, tT4];
  const laneEnd = [0, 0, 0];
  titles.forEach((t) => {
    let lane = tT2;
    if (!t.kicker) { const li = laneEnd.findIndex((e) => e <= t.start + 0.01); if (li < 0) throw new Error('no free title lane'); lane = lanes[li]!; laneEnd[li] = t.end; }
    clips.push(makeClip({ trackId: lane.id, kind: 'title', start: fr(t.start), duration: fr(t.end - t.start), text: t.text, style: t.kicker ? style({ sizePct: 2.4, color: '#bcd2ff', uppercase: true, outline: 2 }) : style({ sizePct: 5.6, outline: 4 }), position: { anchor: 'top', offset: t.kicker ? 0.075 : 0.105, align: 'center' }, fadeIn: 0.3, fadeOut: 0.25, label: t.text.replace(/\n/g, ' ') }));
  });
  // a soft top scrim wherever titles sit on footage
  const humanSegs = (spec.segs as Seg[]).filter((s) => s.type === 'human');
  for (const h of humanSegs) {
    const ts = titles.filter((t) => t.start >= h.start - 0.5 && t.end <= h.end + 0.5);
    if (!ts.length) continue;
    const s0 = Math.max(h.start, Math.min(...ts.map((t) => t.start)) - 0.2);
    const e0 = Math.min(h.end, Math.max(...ts.map((t) => t.end)) + 0.2);
    clips.push(makeClip({ trackId: tScrim.id, kind: 'image', start: fr(s0), duration: fr(e0 - s0), assetId: A.scrim!, fit: 'fit', fadeIn: 0.3, fadeOut: 0.3, label: 'Top scrim', layout: { box: { x: 0, y: 0, w: 1, h: 760 / H }, radius: 0, shadow: false, push: 0 } }));
  }

  // ---- captions ---------------------------------------------------------------------------------------------
  const cap = (spec.captions as { text: string; start: number; end: number }[]);
  let prevEnd = 0;
  for (const c of cap) {
    const start = Math.max(fr(c.start), prevEnd);
    const dur = Math.round((c.end - start) * 1000) / 1000;
    if (dur <= 0.2) continue;
    clips.push(makeClip({ trackId: tSubs.id, kind: 'caption', start, duration: dur, text: c.text, style: style({ sizePct: 3.5, background: NAVY, outline: 0, shadow: false }), position: { anchor: 'bottom', offset: 0.19, align: 'center' }, label: c.text.replace(/\n/g, ' ') }));
    prevEnd = start + dur;
  }

  // ---- audio ------------------------------------------------------------------------------------------------
  const voiceDocs = await Promise.all(speech.map((s) => doc(s.assetId)));
  speech.forEach((s, i) => clips.push(makeClip({ trackId: tVoice.id, kind: 'audio', start: spec.lineStart[i], duration: Math.min(voiceDocs[i]!.durationSec ?? s.seconds, (i + 1 < speech.length ? spec.lineStart[i + 1] - 0.01 : 1e9) - spec.lineStart[i]), assetId: s.assetId, sourceDuration: voiceDocs[i]!.durationSec ?? s.seconds, role: 'dialogue', volume: 1, label: `Narration ${i + 1}` })));
  const mdur = musicDoc.durationSec ?? 60;
  const mlen = Math.min(mdur, total);
  clips.push(makeClip({ trackId: tMusic.id, kind: 'audio', start: 0, duration: fr(mlen), assetId: musicId, inPoint: 0, sourceDuration: mdur, role: 'music', duck: true, duckDb: 9, volume: Number(process.env.MUSIC_GAIN ?? 0.55), fadeIn: 0.4, fadeOut: 2.2, label: 'Score' }));
  const lastEnd: number[] = [0, 0, 0];
  for (const e of (spec.sfx as { name: string; t: number; vol: number }[]).sort((a, b) => a.t - b.t)) {
    const d = await doc(A[`sfx:${e.name}`]!);
    const dur = Math.min(d.durationSec ?? 1, total - e.t - 0.05);
    if (dur <= 0.1) continue;
    const lane = lastEnd.findIndex((x) => x <= e.t + 0.01);
    if (lane < 0) continue;
    clips.push(makeClip({ trackId: sfxTracks[lane]!.id, kind: 'audio', start: fr(e.t), duration: Math.round(dur * 1000) / 1000, assetId: A[`sfx:${e.name}`]!, sourceDuration: d.durationSec ?? dur, role: 'effects', volume: e.vol, label: `SFX · ${e.name}` }));
    lastEnd[lane] = e.t + dur;
  }

  const dur = timelineDuration(clips);
  say(`${key}: ${clips.length} clips, ${dur.toFixed(2)} s`);
  const tl = col.timelines(pid);
  let id = st.timelines?.[key!];
  const body = { tracks, clips, markers: [], beatGrid: null, fps: FPS, aspectRatio: '9:16', durationSec: dur, updatedAt: FieldValue.serverTimestamp() };
  if (id && (await tl.doc(id).get()).exists) {
    const cur = (await tl.doc(id).get()).data() as { version?: number; tracks: unknown; clips: unknown; markers: unknown };
    await tl.doc(id).collection('versions').add({ version: cur.version ?? 1, note: 'Before rebuild', tracks: cur.tracks, clips: cur.clips, markers: cur.markers, createdAt: FieldValue.serverTimestamp() });
    await tl.doc(id).set({ ...body, version: (cur.version ?? 1) + 1 }, { merge: true });
  } else {
    const ref = await tl.add({ ownerUid: owner.uid, projectId: pid, name: `${def.title} — 9:16`, version: 1, createdAt: FieldValue.serverTimestamp(), ...body });
    id = ref.id;
  }
  patchState({ timelines: { ...(loadState().timelines ?? {}), [key!]: id } });
  say(`timeline ${id}`);
}

async function render() {
  const st = loadState();
  const final = mode === 'final';
  const label = `${def.title} — ${final ? 'final' : 'draft'} 9:16`;
  const [jobId] = await submitJobs(owner, [{ type: 'render.timeline', projectId: st.projects[key!], timelineId: st.timelines[key!], preset: 'vertical_9x16', quality: final ? 'final' : 'draft', inspect: final, acceptLyricSync: false, audioMaster: 'normalize', label }], label);
  const job = await waitForJob(jobId!, say, 60 * 60_000);
  if (job.status !== 'completed') throw new Error(`Render ${job.status}: ${JSON.stringify(job.error)}`);
  const renderId = (job.params as { renderId: string }).renderId;
  let r = (await col.renders().doc(renderId).get()).data()!;
  if (final) {
    patchState({ renders: { ...(loadState().renders ?? {}), [key!]: renderId } });
    const until = Date.now() + 40 * 60_000;
    for (;;) {
      r = (await col.renders().doc(renderId).get()).data()!;
      const fi = r.finalInspection as { status?: string } | null;
      say(`final inspection: ${JSON.stringify(fi)}`);
      if (fi && (fi.status === 'completed' || fi.status === 'failed')) break;
      if (Date.now() > until) break;
      await sleep(15_000);
    }
  }
  const a = (await col.assets().doc(String(r.outputAssetId)).get()).data() as AssetDoc;
  mkdirSync(path.join(WORK, 'renders'), { recursive: true });
  const dest = path.join(WORK, 'renders', `${key}-${final ? 'final' : 'draft'}.mp4`);
  await bucket.file(a.storagePath).download({ destination: dest });
  say(`render ${renderId} -> ${dest} (${a.durationSec}s ${a.width}x${a.height})`);
  if (final) {
    const blocked = await actions.exportBlock(a.storagePath);
    if (blocked) say(`export gate says: ${blocked}`);
    const fi = r.finalInspection as { id?: string } | null;
    if (fi?.id) {
      const d = (await col.projects().doc(st.projects[key!]).collection('finalInspections').doc(fi.id).get()).data() as { findings?: unknown[] } | undefined;
      writeFileSync(path.join(WORK, 'renders', `${key}-final-inspection.json`), JSON.stringify(d ?? null, null, 1));
      say(`final-inspection findings: ${JSON.stringify(d?.findings ?? []).slice(0, 3000)}`);
    }
  }
}

async function exportProject() {
  const st = loadState();
  const dir = path.join(OUT, '_project', key!);
  mkdirSync(dir, { recursive: true });
  const tl = (await col.timelines(st.projects[key!]).doc(st.timelines[key!]).get()).data();
  writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(tl, null, 1));
  const proj = (await col.projects().doc(st.projects[key!]).get()).data();
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(proj, null, 1));
  say(`exported ${dir}`);
}

const steps: Record<string, () => Promise<void>> = { upload, timeline, render, project: exportProject };
await steps[step!]!();
void existsSync; void saveState;
process.exit(0);
