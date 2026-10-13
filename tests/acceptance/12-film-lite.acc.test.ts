import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  LITE_SCORE_ID,
  assembleLiteTimeline,
  computeLiteTiming,
  defaultLiteSpec,
  formatSrt,
  newScene,
  newShot,
  normalizeLiteSpec,
  sumEstimates,
  type JobDoc,
  type JobRequest,
  type LiteSpec,
  type RenderDoc,
  type ScoreDoc,
} from '@az-studio/shared';

// Workers run in this process: nothing is handed to the deployed worker (which may predate Film Studio Lite).
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
import { reporter, RUN, sleep, studioOwner } from './harness';

/**
 * Film Studio Lite against the live providers, kept small: one generated image (the other stills are
 * existing AZ Studio images from the De N Lei project, uploaded as test assets), three narrated scenes
 * (speech + word timing from the real audio), one score movement, synthesised ambience, then the real
 * renderer (run locally against the live project) for a draft, a final and a portrait export, and the
 * final-film inspection. Hard budget cap: $1.50 of generation.
 */

const BUDGET_USD = 1.5;
const ROOT = path.resolve(import.meta.dirname, '../..');
const STILLS = path.join(ROOT, 'exports/de-n-lei-come-learn-kasem-2026-10/assets/references');
const OUT = path.join(ROOT, 'exports/film-studio-lite-verification');
const require = createRequire(import.meta.url);

type Job = JobDoc & { id: string };

async function jobsOf(uid: string, projectId: string): Promise<Job[]> {
  return (await col.jobs().where('ownerUid', '==', uid).where('projectId', '==', projectId).get()).docs.map((d) => ({ ...(d.data() as JobDoc), id: d.id }));
}

/**
 * Test stills are stored on a backend-only path: objects under `uploads/` that were not reserved through the
 * API are removed by the deployed upload validator.
 */
async function uploadStill(uid: string, projectId: string, file: string, title: string, assetId = col.assets().doc().id): Promise<string> {
  const storagePath = `users/${uid}/generated/qa-lite/${assetId}.png`;
  await bucket.upload(file, { destination: storagePath, resumable: false, metadata: { contentType: 'image/png' } });
  await withTmpDir(async (dir) => {
    const local = path.join(dir, path.basename(file));
    copyFileSync(file, local);
    await createAsset({ uid, assetId, projectId, kind: 'image', source: 'upload', title, fileName: path.basename(file), mimeType: 'image/png', storagePath, localFile: local, dir, collections: ['lite:image', 'qa:test-asset'] });
  });
  return assetId;
}

describe('Film Studio Lite · live providers', () => {
  it('generates, times, scores, renders and inspects a small film', async () => {
    const { log, save } = reporter('12-film-lite');
    const owner = await studioOwner();
    const projectId = `qa-lite-${RUN}`;
    mkdirSync(OUT, { recursive: true });

    // ---- Test stills (existing AZ Studio images) ------------------------------------------------
    // A rerun with the same AZS_ACCEPTANCE_RUN resumes the film: finished paid work is reused, never repeated.
    const existing = (await col.projects().doc(projectId).get()).get('lite') as LiteSpec | undefined;
    const prior = existing ? normalizeLiteSpec(existing) : null;
    const priorImage = (shotId: string) => prior?.scenes.flatMap((x) => x.shots).find((x) => x.id === shotId)?.image.approvedAssetId ?? undefined;
    const stills = [
      ['w1', 'location_baobab-gathering-ground.png', 'Test still · baobab gathering ground (De N Lei)'],
      ['w2', 'location_village-lane.png', 'Test still · village lane (De N Lei)'],
      ['p2', 'mama-alima_portrait.png', 'Test still · Mama Alima portrait (De N Lei)'],
    ] as const;
    const [baobab, lane, elder] = (await Promise.all(stills.map(([shot, file, title]) => uploadStill(owner.uid, projectId, path.join(STILLS, file), title, priorImage(shot))))) as [string, string, string];
    log(`${prior ? 'resumed' : 'new'} film · test stills ${baobab} ${lane} ${elder}`);

    const spec: LiteSpec = defaultLiteSpec({ direction: 'folklore', aspect: '16:9', targetSec: 60 });
    spec.setup.extraAspects = ['9:16'];
    spec.bible.characters = [{ id: 'alima', name: 'Mama Alima', description: 'A woman in her seventies with a warm, lined face and a calm gaze', clothing: 'White blouse, orange head wrap, coral bead necklaces', refAssetIds: [elder] }];
    spec.voice = { ...spec.voice, voice: 'Sulafat', pace: 'measured' };
    spec.sound.endHoldSec = 4;
    spec.scenes = [
      newScene({ id: 'walls', title: 'The walls remember', narration: 'In the village, the walls remember. Every season, the women paint them again, line by careful line.', transitionIn: 'fade_black', ambience: { kind: 'wind', assetId: null, levelDb: 0 }, music: { mode: 'score', intensity: 3, direction: 'Quiet opening, the theme alone' }, shots: [newShot({ id: 'w1', durationSec: 7, motion: { preset: 'push_in', intensity: 0.06, focal: { x: 0.45, y: 0.4 }, ease: 'gentle' }, image: { approvedAssetId: baobab, uploads: [], reuseOfShotId: null } }), newShot({ id: 'w2', durationSec: 6, motion: { preset: 'pan_right', intensity: 0.08, focal: { x: 0.5, y: 0.5 }, ease: 'gentle' }, image: { approvedAssetId: lane, uploads: [], reuseOfShotId: null } })] }),
      newScene({ id: 'patterns', title: 'A language of patterns', narration: 'The patterns are a language. Diamonds for the path, waves for the river, and an open hand for the guest who arrives at dusk.', transitionIn: 'dissolve', ambience: { kind: 'wind', assetId: null, levelDb: 0 }, music: { mode: 'score', intensity: 5, direction: 'The theme opens up' }, shots: [newShot({ id: 'p1', durationSec: 8, scale: 'detail', brief: 'Close detail of a mud wall freshly painted with bold black-and-white diamond and wave patterns, a woman’s hand holding a brush resting at the edge of the frame, warm late-afternoon light, dust in the air', composition: 'Pattern fills the frame; the hand in the lower right third', motion: { preset: 'drift', intensity: 0.04, focal: { x: 0.6, y: 0.6 }, ease: 'gentle' } }), newShot({ id: 'p2', durationSec: 7, characterIds: ['alima'], motion: { preset: 'still', intensity: 0.05, focal: { x: 0.5, y: 0.3 }, ease: 'gentle' }, image: { approvedAssetId: elder, uploads: [], reuseOfShotId: null } })] }),
      newScene({ id: 'rains', title: 'Retold', narration: 'When the rains come, the colours fade. And so they paint again, because a story kept is a story retold.', pauseBeforeSec: 1.5, pauseBlack: true, ambience: { kind: 'night', assetId: null, levelDb: 0 }, music: { mode: 'score', intensity: 4, direction: 'Resolve gently' }, shots: [newShot({ id: 'r1', durationSec: 10, motion: { preset: 'pull_out', intensity: 0.07, focal: { x: 0.45, y: 0.4 }, ease: 'gentle' }, image: { approvedAssetId: null, uploads: [], reuseOfShotId: 'w1' } })] }),
    ];
    if (!prior) await col.projects().doc(projectId).set({ ownerUid: owner.uid, title: `QA · Film Studio Lite (${RUN})`, type: 'film_lite', status: 'active', logline: 'Painted walls retold each season.', format: { aspectRatio: '16:9', fps: 24 }, coverAssetId: null, styleBible: {}, lite: spec, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    log(`project ${projectId}`);

    let spent = 0;
    const runWork = async (kind: 'images' | 'narration' | 'music' | 'ambience', run: (j: JobDoc) => Promise<void>) => {
      const current = normalizeLiteSpec((await col.projects().doc(projectId).get()).get('lite'));
      const score = ((await col.scores(projectId).doc(LITE_SCORE_ID).get()).data() as ScoreDoc | undefined) ?? null;
      const plan = planLiteWork(current, 'QA film', projectId, await jobsOf(owner.uid, projectId), kind, { score });
      if (plan.score) await col.scores(projectId).doc(LITE_SCORE_ID).set({ ...plan.score, updatedAt: FieldValue.serverTimestamp() });
      if (!plan.planned.length) return { jobIds: [] as string[], skipped: plan.skipped };
      const requests: JobRequest[] = plan.planned.map((p) => p.request);
      const prepared = await prepareAll(owner.uid, requests);
      const est = sumEstimates(prepared.map((p) => p.estimate), PRICING).usd;
      if (spent + est > BUDGET_USD) throw new Error(`Budget: ${kind} would bring the run to $${(spent + est).toFixed(2)} (cap $${BUDGET_USD}).`);
      spent += est;
      const res = await createJobs(owner.uid, requests, { confirmedUsd: est, batchLabel: `QA lite ${kind}` }, prepared);
      for (const id of res.jobIds) {
        const claimed = await claimJob(id);
        if (claimed) await run(claimed);
      }
      log(`${kind}: ${res.jobIds.length} job(s), est $${est.toFixed(3)}`);
      return { jobIds: res.jobIds, skipped: plan.skipped };
    };

    // ---- Paid work ------------------------------------------------------------------------------
    const images = await runWork('images', runImageJob);
    expect(images.jobIds).toHaveLength(prior ? 0 : 1);
    const imageJob = (await jobsOf(owner.uid, projectId)).find((j) => j.type === 'image.generate' && j.target?.id === 'p1' && j.status === 'completed');
    expect(imageJob, 'generated image').toBeTruthy();
    const generated = imageJob!.result!.assetIds![0]!;
    await col.projects().doc(projectId).update({ 'lite.scenes': spec.scenes.map((s) => ({ ...s, shots: s.shots.map((x) => (x.id === 'p1' ? { ...x, image: { ...x.image, approvedAssetId: generated } } : x)) })) });
    log(`generated image ${generated}`);

    const narration = await runWork('narration', runLiteNarrationJob);
    expect(narration.jobIds).toHaveLength(prior ? 0 : 3);
    await runWork('ambience', runAmbienceJob);
    const music = await runWork('music', runMusicJob);
    log(`music jobs ${music.jobIds.join(', ')}`);

    // ---- Reopen: nothing is requested again ------------------------------------------------------
    for (const kind of ['images', 'narration', 'ambience', 'music'] as const) {
      const again = await runWork(kind, async () => {
        throw new Error(`${kind} was requested twice`);
      });
      expect(again.jobIds).toEqual([]);
    }
    log('reopen: no repeated requests');

    // ---- Composition ----------------------------------------------------------------------------
    const finalSpec = normalizeLiteSpec((await col.projects().doc(projectId).get()).get('lite'));
    const jobs = await jobsOf(owner.uid, projectId);
    const takes = currentTakes(finalSpec, jobs);
    for (const s of finalSpec.scenes) {
      const t = takes[s.id];
      expect(t, `take for ${s.id}`).toBeTruthy();
      log(`take ${s.id}: ${t!.alignment} · ${(t!.speechEnd - t!.speechStart).toFixed(2)} s · coverage ${t!.coverage} · flags ${t!.flags.join(' | ') || 'none'}`);
    }
    const score = ((await col.scores(projectId).doc(LITE_SCORE_ID).get()).data() as ScoreDoc | undefined) ?? null;
    const beds = Object.fromEntries(jobs.filter((j) => j.type === 'audio.ambience' && j.status === 'completed').map((j) => [(j.params as { kind: string }).kind, { assetId: j.result!.assetIds![0]!, durationSec: 90 }]));
    const assetIds = new Set<string>([baobab, lane, elder, generated, ...Object.values(takes).map((t) => t!.assetId), ...(score?.movements.map((m) => m.assetId).filter(Boolean) as string[]), ...Object.values(beds).map((b) => b.assetId)]);
    const assetSnaps = await Promise.all([...assetIds].map((id) => col.assets().doc(id).get()));
    const assets = Object.fromEntries(assetSnaps.map((s) => [s.id, { width: (s.get('width') as number | null) ?? null, height: (s.get('height') as number | null) ?? null, durationSec: (s.get('durationSec') as number | null) ?? null }]));
    const timing = computeLiteTiming(finalSpec, takes);
    log(`timing: ${timing.totalSec.toFixed(2)} s, estimated=${timing.estimated}`);

    const renders: { aspect: string; quality: 'draft' | 'final'; renderId: string }[] = [];
    for (const [aspect, preset, outWidth] of [['16:9', 'youtube_16x9', 1920], ['9:16', 'vertical_9x16', 1080]] as const) {
      const assembly = assembleLiteTimeline({ spec: finalSpec, timing, takes, assets, aspect, outWidth, score, ambience: beds });
      const errors = assembly.issues.filter((i) => i.severity === 'error');
      expect(errors, JSON.stringify(errors)).toEqual([]);
      writeFileSync(path.join(OUT, `subtitles-${aspect.replace(':', 'x')}.srt`), formatSrt(assembly.cues));
      const tl = col.timelines(projectId).doc();
      await tl.set({ ownerUid: owner.uid, projectId, name: `QA lite ${aspect}`, fps: 24, aspectRatio: aspect, tracks: assembly.state.tracks, clips: assembly.state.clips, markers: assembly.state.markers, beatGrid: null, version: 1, durationSec: assembly.durationSec, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      for (const quality of aspect === '16:9' ? (['draft', 'final'] as const) : (['draft'] as const)) {
        const res = await createJobs(owner.uid, [{ type: 'render.timeline', projectId, timelineId: tl.id, preset, quality, inspect: quality === 'final', acceptLyricSync: false, audioMaster: 'normalize' }], { confirmedUsd: 5 });
        const job = (await col.jobs().doc(res.jobIds[0]!).get()).data() as JobDoc;
        renders.push({ aspect, quality, renderId: (job.params as { renderId: string }).renderId });
        await col.jobs().doc(res.jobIds[0]!).set({ status: 'rendering', stage: 'Rendering locally (acceptance)' }, { merge: true });
        const started = Date.now();
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [path.join(ROOT, 'services/renderer/dist/main.js')], {
            env: { ...process.env, RENDER_ID: (job.params as { renderId: string }).renderId, JOB_ID: res.jobIds[0]!, FFMPEG_BIN: require('ffmpeg-static') as string, FFPROBE_BIN: (require('ffprobe-static') as { path: string }).path, WORK_DIR: path.join(os.tmpdir(), `azs-lite-acc-${res.jobIds[0]}`) },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          let err = '';
          child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-3000)));
          child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`renderer exited ${code}: ${err}`))));
        });
        log(`render ${aspect} ${quality} done in ${Math.round((Date.now() - started) / 1000)} s`);
      }
    }

    // ---- Final-film inspection (the export gate) ------------------------------------------------
    const final = renders.find((r) => r.quality === 'final')!;
    await startFinalInspection(final.renderId, owner.uid, projectId);
    const inspection = (await col.jobs().where('ownerUid', '==', owner.uid).where('projectId', '==', projectId).where('type', '==', 'final.inspect').get()).docs.find((d) => (d.get('params') as { renderId?: string }).renderId === final.renderId)!;
    const claimed = await claimJob(inspection.id);
    if (claimed) await runFinalInspectJob(claimed);
    await sleep(500);
    const inspected = (await col.renders().doc(final.renderId).get()).data() as RenderDoc;
    const findings = (await col.sub(projectId, 'finalInspections').doc(final.renderId).get()).get('findings') as { check: string; severity: string; message: string; basis: string }[] | undefined;
    log(`final inspection: ${JSON.stringify(inspected.finalInspection)}`);
    for (const f of findings ?? []) log(`  ${f.severity} ${f.check} (${f.basis}): ${f.message}`);

    // ---- Exports for review ---------------------------------------------------------------------
    const outputs: Record<string, string> = {};
    for (const r of renders) {
      const doc = (await col.renders().doc(r.renderId).get()).data() as RenderDoc;
      expect(doc.status).toBe('completed');
      const a = (await col.assets().doc(doc.outputAssetId!).get()).data() as { storagePath: string; durationSec: number; width: number; height: number };
      const name = `film-lite-${r.aspect.replace(':', 'x')}-${r.quality}.mp4`;
      for (let attempt = 1; ; attempt++) {
        try {
          await bucket.file(a.storagePath).download({ destination: path.join(OUT, name) });
          break;
        } catch (e) {
          if (attempt >= 4) throw e;
          log(`download retry ${attempt}: ${String((e as Error).message).slice(0, 120)}`);
          await sleep(3000 * attempt);
        }
      }
      outputs[name] = `${a.width}x${a.height} · ${a.durationSec.toFixed(2)} s`;
    }
    const usage = (await col.projects().doc(projectId).get()).get('usage') as { costUsd: number } | undefined;
    save({ projectId, run: RUN, estimateUsd: spent, recordedUsd: usage?.costUsd ?? null, timingSec: timing.totalSec, outputs, finalInspection: inspected.finalInspection, findings });
    writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ projectId, run: RUN, generatedImage: generated, testStills: { baobab, lane, elder }, estimateUsd: spent, recordedUsd: usage?.costUsd ?? null, outputs, finalInspection: inspected.finalInspection, findings, takes: Object.fromEntries(Object.entries(takes).map(([k, t]) => [k, { alignment: t?.alignment, coverage: t?.coverage, speechSec: t ? t.speechEnd - t.speechStart : null, flags: t?.flags }])) }, null, 2));
    log(`spent ≈ $${(usage?.costUsd ?? spent).toFixed(3)}; exports in ${OUT}`);
  });
});
