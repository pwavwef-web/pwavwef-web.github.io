import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  LITE_SCORE_ID,
  assembleLiteTimeline,
  computeLiteTiming,
  formatSrt,
  normalizeLiteSpec,
  sumEstimates,
  type JobDoc,
  type JobRequest,
  type LiteSpec,
  type RenderDoc,
  type ScoreDoc,
} from '@az-studio/shared';

vi.mock('../../functions/src/lib/jobs', async (orig) => ({ ...(await orig<typeof import('../../functions/src/lib/jobs')>()), enqueueJob: async () => undefined }));

import { PRICING } from '../../functions/src/config/pricing';
import { bucket, col, FieldValue } from '../../functions/src/lib/firebase';
import { claimJob } from '../../functions/src/lib/jobs';
import { createAsset, withTmpDir } from '../../functions/src/lib/assets';
import { createJobs, prepareAll } from '../../functions/src/lib/submit';
import { currentTakes, planLiteWork } from '../../functions/src/api/lite';
import { runImageJob } from '../../functions/src/workers/image';
import { runLiteNarrationJob } from '../../functions/src/workers/lite-narration';
import { runAmbienceJob } from '../../functions/src/workers/ambience';
import { runMusicJob } from '../../functions/src/workers/music';
import { runFinalInspectJob } from '../../functions/src/workers/final-inspect';
import { startFinalInspection } from '../../functions/src/workers/after-render';
import { reporter, sleep, studioOwner } from './harness';
import { COURTYARD, REFERENCE_PROMPTS, SCENES, TITLE, WOMAN, buildSpec } from './fixtures/sky-pestle-story';
import { synthesiseCues } from './fixtures/sky-pestle-sfx';

/**
 * Production driver for "The Sky, the Woman and the Pestle" in Film Studio Lite, against the live providers.
 * Phases (env SKY_PHASES, comma separated): refs, shots, narration, sound, render, inspect, export.
 * Every phase is resumable: finished paid work is found again by its input hash and never requested twice.
 * No video-generation or lip-sync model is ever called.
 */

const BUDGET_USD = Number(process.env.SKY_BUDGET_USD ?? 14);
const PROJECT_ID = process.env.SKY_PROJECT_ID ?? 'sky-pestle-lite';
const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'exports/the-sky-the-woman-and-the-pestle');
const REVIEW = process.env.SKY_REVIEW_DIR ?? path.join(OUT, 'review');
const require = createRequire(import.meta.url);
const phases = new Set((process.env.SKY_PHASES ?? 'refs').split(',').map((s) => s.trim()));

type Job = JobDoc & { id: string };
const { log, save } = reporter('13-sky-pestle');

async function jobsOf(uid: string): Promise<Job[]> {
  return (await col.jobs().where('ownerUid', '==', uid).where('projectId', '==', PROJECT_ID).get()).docs.map((d) => ({ ...(d.data() as JobDoc), id: d.id }));
}

async function loadSpec(): Promise<LiteSpec | null> {
  const snap = await col.projects().doc(PROJECT_ID).get();
  return snap.exists ? normalizeLiteSpec(snap.get('lite')) : null;
}

const saveSpec = (spec: LiteSpec) => col.projects().doc(PROJECT_ID).update({ lite: JSON.parse(JSON.stringify({ ...spec, updatedAt: Date.now() })), updatedAt: FieldValue.serverTimestamp() });

async function spentSoFar(uid: string): Promise<number> {
  const jobs = await jobsOf(uid);
  return jobs.reduce((a, j) => a + (typeof (j as { usageUsd?: number }).usageUsd === 'number' ? (j as { usageUsd?: number }).usageUsd! : 0), 0);
}

async function download(storagePath: string, dest: string) {
  mkdirSync(path.dirname(dest), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      await bucket.file(storagePath).download({ destination: dest });
      return;
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(3000 * attempt);
    }
  }
}

async function assetPath(id: string): Promise<string> {
  return (await col.assets().doc(id).get()).get('storagePath') as string;
}

/** Runs prepared requests through the live providers in this process; returns completed jobs. */
async function runRequests(uid: string, requests: JobRequest[], label: string, run: (j: JobDoc) => Promise<void>, concurrency = 3): Promise<Job[]> {
  if (!requests.length) return [];
  const prepared = await prepareAll(uid, requests);
  const est = sumEstimates(prepared.map((p) => p.estimate), PRICING).usd;
  const spent = await spentSoFar(uid);
  if (spent + est > BUDGET_USD) throw new Error(`Budget: ${label} (+$${est.toFixed(2)}) would bring the film to $${(spent + est).toFixed(2)} (cap $${BUDGET_USD}).`);
  const res = await createJobs(uid, requests, { confirmedUsd: est, batchLabel: `Sky pestle · ${label}` }, prepared);
  log(`${label}: ${res.jobIds.length} job(s), est $${est.toFixed(3)}`);
  const queue = [...res.jobIds];
  const done: Job[] = [];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const claimed = await claimJob(id);
      if (claimed) {
        try {
          await run(claimed);
        } catch (e) {
          log(`  job ${id} threw: ${String((e as Error).message).slice(0, 200)}`);
        }
      }
      const doc = (await col.jobs().doc(id).get()).data() as JobDoc;
      done.push({ ...doc, id });
      log(`  ${doc.status} ${(doc.params as { label?: string }).label ?? id}${doc.status !== 'completed' ? ` — ${String((doc as { error?: { message?: string } }).error?.message ?? doc.stage ?? '').slice(0, 160)}` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return done;
}

const imageReq = (projectId: string, prompt: string, aspectRatio: string, refs: string[], labels: string[], tag: string, title: string, target?: { kind: 'lite_shot'; id: string }, inputHash?: string): JobRequest =>
  ({ type: 'image.generate', projectId, prompt, purpose: 'free', aspectRatio, imageSize: '2K', referenceAssetIds: refs, referenceLabels: labels, grounding: false, applyStyleBible: false, characterIds: [], collections: ['lite:image', tag], title, label: `Image · ${title}`, ...(target ? { target } : {}), ...(inputHash ? { inputHash } : {}) }) as JobRequest;

describe('The Sky, the Woman and the Pestle · Film Studio Lite', () => {
  it.runIf(phases.has('refs'))('creates the project and the reference assets', async () => {
    const owner = await studioOwner();
    mkdirSync(REVIEW, { recursive: true });
    let spec = await loadSpec();
    const have = spec?.bible.characters[0]?.refAssetIds.length === 2 && spec.bible.locations[0]?.refAssetIds.length === 2;
    if (!have) {
      const make = async (tag: string, key: keyof typeof REFERENCE_PROMPTS, aspect: string, refs: string[] = [], labels: string[] = []) => {
        const existing = (await jobsOf(owner.uid)).find((j) => j.type === 'image.generate' && j.status === 'completed' && (j.params as { collections?: string[] }).collections?.includes(tag));
        if (existing) return existing.result!.assetIds![0]!;
        if (!(await col.projects().doc(PROJECT_ID).get()).exists) await col.projects().doc(PROJECT_ID).set({ ownerUid: owner.uid, title: TITLE, type: 'film_lite', status: 'active', logline: 'A woman strikes the low sky once too often.', format: { aspectRatio: '16:9', fps: 24 }, coverAssetId: null, styleBible: {}, lite: buildSpec({ woman: [], courtyard: [] }, {}), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
        const done = await runRequests(owner.uid, [imageReq(PROJECT_ID, REFERENCE_PROMPTS[key], aspect, refs, labels, tag, `Reference · ${key}`)], `reference ${key}`, runImageJob, 1);
        const j = done[0];
        if (!j || j.status !== 'completed') throw new Error(`reference ${key} failed`);
        return j.result!.assetIds![0]!;
      };
      const portrait = await make('lite:ref:woman-portrait', 'womanPortrait', '3:4');
      const full = await make('lite:ref:woman-full', 'womanFull', '3:4', [portrait], ['The woman — face and hair reference (image 1)']);
      const mortar = await make('lite:ref:mortar', 'mortar', '4:3');
      const courtyard = await make('lite:ref:courtyard', 'courtyard', '16:9');
      spec = buildSpec({ woman: [portrait, full], courtyard: [courtyard, mortar] }, {});
      await col.projects().doc(PROJECT_ID).update({ lite: JSON.parse(JSON.stringify(spec)), title: TITLE, updatedAt: FieldValue.serverTimestamp() });
      log(`references: woman ${portrait} ${full}, courtyard ${courtyard}, mortar ${mortar}`);
    }
    for (const [name, id] of [['woman-portrait', spec!.bible.characters[0]!.refAssetIds[0]!], ['woman-full', spec!.bible.characters[0]!.refAssetIds[1]!], ['courtyard', spec!.bible.locations[0]!.refAssetIds[0]!], ['mortar', spec!.bible.locations[0]!.refAssetIds[1]!]] as const) await download(await assetPath(id!), path.join(REVIEW, `ref-${name}.png`));
    expect(WOMAN.name).toBeTruthy();
    expect(COURTYARD.name).toBeTruthy();
  });

  it.runIf(phases.has('unstick'))('marks provider-throttled jobs that this driver abandoned as failed', async () => {
    const owner = await studioOwner();
    const stuck = (await jobsOf(owner.uid)).filter((j) => ['queued', 'validating', 'generating', 'downloading', 'rendering'].includes(j.status) && !j.result);
    for (const j of stuck) await col.jobs().doc(j.id).set({ status: 'failed', stage: 'Provider rate limit — retried by the production driver', error: { code: 'rate_limited', message: 'Rate limited by the image provider; no image was produced.', retryable: true } }, { merge: true });
    log(`unstuck ${stuck.length} job(s): ${stuck.map((j) => j.target?.id ?? j.type).join(', ')}`);
  });

  it.runIf(phases.has('shots'))('generates the shot images (only the ones still missing, or the ones named in SKY_REDO)', async () => {
    const owner = await studioOwner();
    mkdirSync(REVIEW, { recursive: true });
    let spec = (await loadSpec())!;
    const redo = new Set((process.env.SKY_REDO ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    const projectTitle = TITLE;
    if (redo.size) {
      log('redo: ' + [...redo].join(', '));
      const fresh = buildSpec({ woman: [], courtyard: [] }, {});
      const src = new Map(fresh.scenes.flatMap((x) => x.shots).map((x) => [x.id, x]));
      for (const sc of spec.scenes) for (const sh of sc.shots) if (redo.has(sh.id)) Object.assign(sh, { brief: src.get(sh.id)!.brief, composition: src.get(sh.id)!.composition, motion: src.get(sh.id)!.motion });
      await saveSpec(spec);
    }
    const jobs = await jobsOf(owner.uid);
    const plan = planLiteWork(spec, projectTitle, PROJECT_ID, jobs, 'images', { targetIds: redo.size ? [...redo] : undefined, force: redo.size > 0 });
    for (const s of plan.skipped) log(`skip ${s.key}: ${s.reason}`);
    // Completed results for the exact same input are adopted, not regenerated.
    const requests = plan.planned.map((p) => p.request);
    const done = await runRequests(owner.uid, requests, 'shot images', runImageJob, Number(process.env.SKY_CONC ?? 3));
    const all = await jobsOf(owner.uid);
    for (const scene of spec.scenes)
      for (const shot of scene.shots) {
        const mine = all.filter((j) => j.type === 'image.generate' && j.status === 'completed' && j.target?.id === shot.id).sort((a, b) => (b.completedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0 - ((a.completedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0));
        const pick = mine[0];
        if (pick && (!shot.image.approvedAssetId || redo.has(shot.id) || done.some((d) => d.id === pick.id))) shot.image.approvedAssetId = pick.result!.assetIds![0]!;
      }
    await saveSpec(spec);
    spec = (await loadSpec())!;
    for (const scene of spec.scenes)
      for (const shot of scene.shots) if (shot.image.approvedAssetId) await download(await assetPath(shot.image.approvedAssetId), path.join(REVIEW, `shot-${shot.id}.png`));
    const missing = spec.scenes.flatMap((s) => s.shots).filter((x) => !x.image.approvedAssetId).map((x) => x.id);
    log(`images ready: ${spec.scenes.flatMap((s) => s.shots).length - missing.length}/${spec.scenes.flatMap((s) => s.shots).length}${missing.length ? `; missing ${missing.join(', ')}` : ''}`);
  });

  it.runIf(phases.has('adopt'))('adopts the newest completed image for the shots named in SKY_REDO', async () => {
    const owner = await studioOwner();
    const spec = (await loadSpec())!;
    const jobs = await jobsOf(owner.uid);
    const ms = (j: Job) => (j.completedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
    for (const id of (process.env.SKY_REDO ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const newest = jobs.filter((j) => j.type === 'image.generate' && j.status === 'completed' && j.target?.id === id).sort((a, b) => ms(b) - ms(a))[0];
      const shot = spec.scenes.flatMap((x) => x.shots).find((x) => x.id === id);
      if (newest && shot) {
        shot.image.approvedAssetId = newest.result!.assetIds![0]!;
        log('adopted ' + shot.image.approvedAssetId + ' for ' + id);
        await download(await assetPath(shot.image.approvedAssetId), path.join(REVIEW, 'shot-' + id + '.png'));
      }
    }
    await saveSpec(spec);
  });

  it.runIf(phases.has('patch'))('swaps a retouched image into a shot (SKY_PATCH_SHOT, SKY_PATCH_FILE)', async () => {
    const owner = await studioOwner();
    const shotId = process.env.SKY_PATCH_SHOT!;
    const file = process.env.SKY_PATCH_FILE!;
    const spec = (await loadSpec())!;
    const shot = spec.scenes.flatMap((x) => x.shots).find((x) => x.id === shotId)!;
    const assetId = col.assets().doc().id;
    const storagePath = 'users/' + owner.uid + '/generated/sky-pestle/' + assetId + '.png';
    await bucket.upload(file, { destination: storagePath, resumable: false, metadata: { contentType: 'image/png' } });
    await withTmpDir(async (dir) => {
      const local = path.join(dir, path.basename(file));
      copyFileSync(file, local);
      await createAsset({ uid: owner.uid, assetId, projectId: PROJECT_ID, kind: 'image', source: 'derived', title: TITLE + ' - ' + shotId + ' (retouched: stray signature removed)', fileName: path.basename(file), mimeType: 'image/png', storagePath, localFile: local, dir, collections: ['lite:image', 'lite:shot:' + shotId, 'sky-pestle:retouched'] });
    });
    shot.image.approvedAssetId = assetId;
    await saveSpec(spec);
    log('patched ' + shotId + ' with retouched asset ' + assetId);
  });

  it.runIf(phases.has('narration'))('records the narration (voice, timing, subtitles source)', async () => {
    const owner = await studioOwner();
    const spec = (await loadSpec())!;
    const fresh = buildSpec({ woman: [], courtyard: [] }, {});
    for (const sc of spec.scenes) {
      const want = fresh.scenes.find((x) => x.id === sc.id)?.narration;
      if (want !== undefined && want !== sc.narration) {
        log('narration text updated for ' + sc.id);
        sc.narration = want;
      }
    }
    spec.story.script = fresh.story.script;
    await saveSpec(spec);
    const plan = planLiteWork(spec, TITLE, PROJECT_ID, await jobsOf(owner.uid), 'narration', {});
    await runRequests(owner.uid, plan.planned.map((p) => p.request), 'narration', runLiteNarrationJob, 2);
    const takes = currentTakes(spec, await jobsOf(owner.uid));
    for (const s of spec.scenes) {
      const t = takes[s.id];
      if (s.narration) log(`take ${s.id}: ${t ? `${t.alignment} · ${(t.speechEnd - t.speechStart).toFixed(2)} s · coverage ${t.coverage} · ${t.flags.join(' | ') || 'no flags'}` : 'MISSING'}`);
    }
    const timing = computeLiteTiming(spec, takes);
    log(`timing: total ${timing.totalSec.toFixed(1)} s (estimated=${timing.estimated})`);
    for (const st of timing.scenes) log(`  ${spec.scenes[st.index]!.title}: starts ${st.start.toFixed(1)} s, ${st.duration.toFixed(1)} s, voice ${st.voiceAt?.toFixed(1) ?? '-'} + ${st.speechSec.toFixed(1)} s`);
    if (process.env.SKY_REVIEW_NARRATION) for (const s of spec.scenes) if (takes[s.id]) await download(await assetPath(takes[s.id]!.assetId), path.join(REVIEW, `narration-${s.id}.wav`));
  });

  it.runIf(phases.has('sound'))('builds ambience, cues and the score from the measured timing', async () => {
    const owner = await studioOwner();
    const spec = (await loadSpec())!;
    const freshSpec = buildSpec({ woman: [], courtyard: [] }, {});
    for (const sc of spec.scenes) {
      const w = freshSpec.scenes.find((x) => x.id === sc.id);
      if (w) {
        sc.leadInSec = w.leadInSec;
        sc.tailSec = w.tailSec;
        sc.narration = w.narration;
      }
    }
    await saveSpec(spec);
    const takes = currentTakes(spec, await jobsOf(owner.uid));
    const timing = computeLiteTiming(spec, takes);
    // Synthesised sound cues (pounding, cloth, the sky withdrawing) fitted to the measured scenes.
    const cues = await synthesiseCues(spec, timing, owner.uid, PROJECT_ID, async (file, title, fileName) => {
      const assetId = col.assets().doc().id;
      const storagePath = `users/${owner.uid}/generated/sky-pestle/${assetId}.m4a`;
      await bucket.upload(file, { destination: storagePath, resumable: false, metadata: { contentType: 'audio/mp4' } });
      await withTmpDir(async (dir) => {
        const local = path.join(dir, fileName);
        copyFileSync(file, local);
        await createAsset({ uid: owner.uid, assetId, projectId: PROJECT_ID, kind: 'audio', source: 'derived', title, fileName, mimeType: 'audio/mp4', storagePath, localFile: local, dir, collections: ['lite:cue', 'sky-pestle:sfx'] });
      });
      return assetId;
    }, (id) => col.assets().doc(id).get().then((s) => s.exists));
    for (const s of spec.scenes) s.soundCue = cues[s.id] ?? s.soundCue;
    await saveSpec(spec);

    const amb = planLiteWork(spec, TITLE, PROJECT_ID, await jobsOf(owner.uid), 'ambience', {});
    await runRequests(owner.uid, amb.planned.map((p) => p.request), 'ambience', runAmbienceJob, 2);

    const score = ((await col.scores(PROJECT_ID).doc(LITE_SCORE_ID).get()).data() as ScoreDoc | undefined) ?? null;
    const mus = planLiteWork(spec, TITLE, PROJECT_ID, await jobsOf(owner.uid), 'music', { score });
    if (mus.score) await col.scores(PROJECT_ID).doc(LITE_SCORE_ID).set({ ...mus.score, updatedAt: FieldValue.serverTimestamp() });
    await runRequests(owner.uid, mus.planned.map((p) => p.request), 'score', runMusicJob, 1);
    const after = ((await col.scores(PROJECT_ID).doc(LITE_SCORE_ID).get()).data() as ScoreDoc | undefined) ?? null;
    log(`score movements: ${after?.movements.map((m) => `${m.index + 1}:${m.assetId ? 'ready' : m.status}`).join(', ')}`);
  });

  const renderPhase = async (kind: 'preview' | 'full') => {
    const owner = await studioOwner();
    mkdirSync(OUT, { recursive: true });
    const base = (await loadSpec())!;
    // The project must carry the approved script text (something may have saved an older copy meanwhile).
    const fresh = buildSpec({ woman: [], courtyard: [] }, {});
    let restored = false;
    for (const sc of base.scenes) {
      const want = fresh.scenes.find((x) => x.id === sc.id)?.narration;
      if (want !== undefined && want !== sc.narration) {
        log('restoring approved narration text for ' + sc.id);
        sc.narration = want;
        restored = true;
      }
    }
    for (const sc of base.scenes) {
      const fs2 = fresh.scenes.find((x) => x.id === sc.id);
      if (fs2 && (fs2.leadInSec !== sc.leadInSec || fs2.tailSec !== sc.tailSec)) {
        sc.leadInSec = fs2.leadInSec;
        sc.tailSec = fs2.tailSec;
        restored = true;
      }
    }
    if (restored) await saveSpec(base);
    const jobs = await jobsOf(owner.uid);
    // A representative preview: the warning, the final blow, the silence and the retreat.
    const spec: LiteSpec = kind === 'preview' ? { ...base, scenes: base.scenes.filter((s) => ['sc_warning', 'sc_blow', 'sc_silence', 'sc_retreat'].includes(s.id)) } : base;
    const takes = currentTakes(base, jobs);
    const score = ((await col.scores(PROJECT_ID).doc(LITE_SCORE_ID).get()).data() as ScoreDoc | undefined) ?? null;
    const beds = Object.fromEntries(jobs.filter((j) => j.type === 'audio.ambience' && j.status === 'completed').map((j) => [(j.params as { kind: string }).kind, { assetId: j.result!.assetIds![0]!, durationSec: 90 }]));
    const ids = new Set<string>(spec.scenes.flatMap((s) => [...s.shots.map((x) => x.image.approvedAssetId), s.soundCue?.assetId]).filter(Boolean) as string[]);
    for (const t of Object.values(takes)) if (t) ids.add(t.assetId);
    for (const m of score?.movements ?? []) if (m.assetId) ids.add(m.assetId);
    for (const b of Object.values(beds)) ids.add(b.assetId);
    const snaps = await Promise.all([...ids].map((id) => col.assets().doc(id).get()));
    const assets = Object.fromEntries(snaps.map((s) => [s.id, { width: (s.get('width') as number | null) ?? null, height: (s.get('height') as number | null) ?? null, durationSec: (s.get('durationSec') as number | null) ?? null }]));
    const timing = computeLiteTiming(spec, takes);
    log(`${kind}: ${timing.totalSec.toFixed(1)} s`);
    const only = process.env.SKY_ASPECTS;
    const aspects = (kind === 'preview' ? ['16:9'] : only ? only.split(',') : ['16:9', '9:16']) as ('16:9' | '9:16')[];
    const renders: { aspect: string; quality: 'draft' | 'final'; renderId: string; timelineId: string }[] = [];
    for (const aspect of aspects) {
      const preset = aspect === '16:9' ? 'youtube_16x9' : 'vertical_9x16';
      const assembly = assembleLiteTimeline({ spec, timing, takes, assets, aspect, outWidth: aspect === '16:9' ? 1920 : 1080, score, ambience: beds });
      for (const i of assembly.issues) log(`  ${i.severity} ${i.code}: ${i.message}`);
      expect(assembly.issues.filter((i) => i.severity === 'error')).toEqual([]);
      writeFileSync(path.join(OUT, kind === 'preview' ? 'preview.srt' : `the-sky-the-woman-and-the-pestle-${aspect.replace(':', 'x')}.srt`), formatSrt(assembly.cues));
      const tlId = kind === 'preview' ? `sky-preview-${Date.now()}` : (base.timelines[aspect] ?? col.timelines(PROJECT_ID).doc().id);
      await col.timelines(PROJECT_ID).doc(tlId).set({ ownerUid: owner.uid, projectId: PROJECT_ID, name: `${TITLE} ${aspect}${kind === 'preview' ? ' (preview)' : ''}`, fps: 24, aspectRatio: aspect, tracks: assembly.state.tracks, clips: assembly.state.clips, markers: assembly.state.markers, beatGrid: null, version: 1, durationSec: assembly.durationSec, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      const quality = kind === 'preview' ? 'draft' : 'final';
      const res = await createJobs(owner.uid, [{ type: 'render.timeline', projectId: PROJECT_ID, timelineId: tlId, preset, quality, inspect: quality === 'final' && aspect === '16:9', acceptLyricSync: false, audioMaster: 'normalize' }], { confirmedUsd: 5 });
      const job = (await col.jobs().doc(res.jobIds[0]!).get()).data() as JobDoc;
      const renderId = (job.params as { renderId: string }).renderId;
      renders.push({ aspect, quality, renderId, timelineId: tlId });
      await col.jobs().doc(res.jobIds[0]!).set({ status: 'rendering', stage: 'Rendering locally' }, { merge: true });
      const started = Date.now();
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(ROOT, 'services/renderer/dist/main.js')], {
          env: { ...process.env, RENDER_ID: renderId, JOB_ID: res.jobIds[0]!, FFMPEG_BIN: require('ffmpeg-static') as string, FFPROBE_BIN: (require('ffprobe-static') as { path: string }).path, WORK_DIR: path.join(os.tmpdir(), `azs-sky-${res.jobIds[0]}`) },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let err = '';
        child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-3000)));
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`renderer exited ${code}: ${err}`))));
      });
      log(`render ${kind} ${aspect} ${quality} done in ${Math.round((Date.now() - started) / 1000)} s (${renderId})`);
      const doc = (await col.renders().doc(renderId).get()).data() as RenderDoc;
      const a = (await col.assets().doc(doc.outputAssetId!).get()).data() as { storagePath: string; durationSec: number; width: number; height: number };
      const name = kind === 'preview' ? 'preview-16x9-draft.mp4' : `the-sky-the-woman-and-the-pestle-${aspect.replace(':', 'x')}.mp4`;
      await download(a.storagePath, path.join(OUT, name));
      log(`  ${name}: ${a.width}x${a.height} · ${a.durationSec.toFixed(1)} s`);
    }
    if (kind === 'full') {
      const finals = (await col.renders().where('ownerUid', '==', owner.uid).where('projectId', '==', PROJECT_ID).get()).docs.filter((d) => d.get('quality') === 'final' && d.get('status') === 'completed');
      for (const d of finals) {
        const aspect = d.get('preset') === 'vertical_9x16' ? '9:16' : '16:9';
        base.timelines[aspect] = String(d.get('timelineId') ?? base.timelines[aspect] ?? '');
        if (!base.renders.some((x) => x.renderId === d.id)) base.renders.push({ renderId: d.id, aspect, quality: 'final', at: Date.now() });
      }
      
      const t = computeLiteTiming(base, takes);
      base.timing = { baseline: Object.fromEntries(t.scenes.map((s) => [s.sceneId, { start: s.start, duration: s.duration }])), totalSec: t.totalSec, acknowledgedAt: Date.now() };
      base.stage = 'export';
      await saveSpec(base);
      save({ renders });
      writeFileSync(path.join(OUT, 'renders.json'), JSON.stringify(base.renders, null, 2));
    }
  };
  it.runIf(phases.has('preview'))('renders a short representative preview', () => renderPhase('preview'), 90 * 60_000);
  it.runIf(phases.has('render'))('renders the full film in both formats', () => renderPhase('full'), 90 * 60_000);

  it.runIf(phases.has('songs'))('looks for the named song assets in the studio library', async () => {
    const owner = await studioOwner();
    const docs = (await col.assets().where('ownerUid', '==', owner.uid).where('kind', '==', 'audio').get()).docs;
    const hits = docs.filter((d) => /cloud song|look up|hear me from here/i.test(String(d.get('title') ?? '') + ' ' + String(d.get('fileName') ?? '')));
    log('audio assets in library: ' + docs.length + '; matching the named songs: ' + hits.map((d) => d.get('title')).join(' | '));
    const projs = (await col.projects().where('ownerUid', '==', owner.uid).get()).docs.filter((d) => /cloud song|look up|hear me from here/i.test(String(d.get('title') ?? '')));
    for (const d of hits) log('asset ' + d.id + ' · ' + d.get('title') + ' · ' + d.get('fileName') + ' · ' + (d.get('durationSec') ?? '?') + ' s · project ' + d.get('projectId') + ' · source ' + d.get('source') + ' · gen ' + JSON.stringify(d.get('generation') ?? null).slice(0, 2600));
    for (const d of (await col.projects().where('ownerUid', '==', owner.uid).get()).docs.filter((x) => /cloud song|look up|hear me from here/i.test(String(x.get('title') ?? '')))) log('project ' + d.id + ' · ' + d.get('title') + ' · type ' + d.get('type') + ' · logline ' + String(d.get('logline') ?? '').slice(0, 200));
    log('projects matching: ' + projs.map((d) => d.get('title')).join(' | '));
  });

  it.runIf(phases.has('diag'))('lists the film’s renders', async () => {
    const owner = await studioOwner();
    const sp = (await loadSpec())!;
    log('blow narration in project: ' + sp.scenes.find((x) => x.id === 'sc_blow')!.narration);
    const tk = currentTakes(sp, await jobsOf(owner.uid));
    log('blow take speech: ' + (tk['sc_blow']!.speechEnd - tk['sc_blow']!.speechStart).toFixed(2) + ' job ' + tk['sc_blow']!.jobId);
    const docs = (await col.renders().where('ownerUid', '==', owner.uid).where('projectId', '==', PROJECT_ID).get()).docs;
    for (const d of docs) log(`render ${d.id}: ${d.get('status')} · ${d.get('quality')} · ${d.get('preset')} · output ${d.get('outputAssetId') ?? 'none'} · ${JSON.stringify(d.get('error') ?? null).slice(0, 200)}`);
  });

  it.runIf(phases.has('inspect'))('runs the final-film inspection on the 16:9 render', async () => {
    const owner = await studioOwner();
    const final = { renderId: (await col.renders().where('ownerUid', '==', owner.uid).where('projectId', '==', PROJECT_ID).get()).docs.find((d) => d.get('quality') === 'final' && d.get('status') === 'completed' && d.get('preset') === 'youtube_16x9')!.id };
    await startFinalInspection(final.renderId, owner.uid, PROJECT_ID);
    const doc = (await col.jobs().where('ownerUid', '==', owner.uid).where('projectId', '==', PROJECT_ID).where('type', '==', 'final.inspect').get()).docs.find((d) => (d.get('params') as { renderId?: string }).renderId === final.renderId)!;
    const claimed = await claimJob(doc.id);
    if (claimed) await runFinalInspectJob(claimed);
    await sleep(500);
    const r = (await col.renders().doc(final.renderId).get()).data() as RenderDoc;
    const findings = (await col.sub(PROJECT_ID, 'finalInspections').doc(final.renderId).get()).get('findings') as { check: string; severity: string; message: string; basis: string }[] | undefined;
    log(`final inspection: ${JSON.stringify(r.finalInspection)}`);
    for (const f of findings ?? []) log(`  ${f.severity} ${f.check} (${f.basis}): ${f.message}`);
    writeFileSync(path.join(OUT, 'final-inspection.json'), JSON.stringify({ summary: r.finalInspection, findings }, null, 2));
  }, 60 * 60_000);

  it.runIf(phases.has('export'))('writes the usage report', async () => {
    const owner = await studioOwner();
    const jobs = await jobsOf(owner.uid);
    const by: Record<string, { n: number; usd: number }> = {};
    for (const j of jobs) {
      const k = j.type;
      by[k] ??= { n: 0, usd: 0 };
      by[k].n += 1;
      by[k].usd += (j as { usageUsd?: number }).usageUsd ?? 0;
    }
    const usage = (await col.projects().doc(PROJECT_ID).get()).get('usage') as { costUsd?: number } | undefined;
    writeFileSync(path.join(OUT, 'usage.json'), JSON.stringify({ projectId: PROJECT_ID, recordedUsd: usage?.costUsd ?? null, byType: by, statuses: jobs.reduce<Record<string, number>>((a, j) => ((a[j.status] = (a[j.status] ?? 0) + 1), a), {}) }, null, 2));
    log(`usage: ${JSON.stringify(by)} recorded ${usage?.costUsd}`);
    expect(existsSync(OUT)).toBe(true);
    expect(SCENES.length).toBeGreaterThan(0);
  });
});
