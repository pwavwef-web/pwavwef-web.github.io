import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  LYRIC_PRESET_LABELS,
  LYRIC_PRESET_STYLES,
  applyMvConcept,
  assembleMvTimeline,
  computeMvTiming,
  defaultMvLiteSpec,
  mvConceptInput,
  mvPlanFromModel,
  mvSectionsFromSong,
  mvShotImageId,
  mvShotsInput,
  mvShotsNeedingImages,
  normalizeMvLiteSpec,
  snapToBeat,
  sumEstimates,
  toLrc,
  toSrt,
  type JobDoc,
  type JobRequest,
  type LyricsSheet,
  type MusicAnalysis,
  type MvConceptOut,
  type MvLiteSpec,
  type MvPlanOut,
  type RenderDoc,
  type SongDoc,
} from '@az-studio/shared';

// Workers run in this process: nothing is handed to the deployed worker (which may predate Music Video Lite).
vi.mock('../../functions/src/lib/jobs', async (orig) => ({ ...(await orig<typeof import('../../functions/src/lib/jobs')>()), enqueueJob: async () => undefined }));

import { PRICING } from '../../functions/src/config/pricing';
import { bucket, col, FieldValue } from '../../functions/src/lib/firebase';
import { claimJob } from '../../functions/src/lib/jobs';
import { createJobs, prepareAll } from '../../functions/src/lib/submit';
import { mvSongOf, planMvWork } from '../../functions/src/api/mvlite';
import { continuitySave } from '../../functions/src/api/continuity';
import { runImageJob } from '../../functions/src/workers/image';
import { runTextJob } from '../../functions/src/workers/text';
import { runLyricsAlignJob } from '../../functions/src/workers/lyrics';
import { runMusicAnalyzeJob } from '../../functions/src/workers/music-studio';
import { runFinalInspectJob } from '../../functions/src/workers/final-inspect';
import { startFinalInspection } from '../../functions/src/workers/after-render';
import { payload, reporter, RUN, sleep, studioOwner } from './harness';

/**
 * Music Video Lite against the live providers, kept small: a QA copy of the owner's “Unfinished Love Song”
 * (its audio and its hand-corrected lyric sheet; the original project is never changed), beat analysis on the
 * real audio, lyric synchronisation to the vocals (compared with the corrected sheet), a written concept and
 * a shot plan from the reasoning model, a few generated images (the other shots use the project's existing
 * location stills), a styled lyric layout, then the real renderer (run locally against the live project) for
 * a 16:9 draft and final and a 9:16 draft, and the final-film inspection. Hard budget cap: $1.50.
 */

const BUDGET_USD = 1.5;
const MAX_GENERATED_IMAGES = 5;
const SRC_PROJECT = 'k8q2I9bjwHroWQWEig3w';
const SRC_SONG = 'VKeBVIzsvo5yrAIGkKOb';
/** Existing stills of the source project (5504×3072 location plates) for shots that are not generated. */
const STILLS = ['lggKFICwO6C8fgxYPGKd', '7ckVeGowe3w1m5dUvTcA', 'eeohq4JLtdXGUj2NuWQB'];
const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'exports/music-video-lite-verification');
const require = createRequire(import.meta.url);

type Job = JobDoc & { id: string };

async function jobsOf(uid: string, projectId: string): Promise<Job[]> {
  return (await col.jobs().where('ownerUid', '==', uid).where('projectId', '==', projectId).get()).docs.map((d) => ({ ...(d.data() as JobDoc), id: d.id }));
}

describe('Music Video Lite · live providers', () => {
  it('analyses, synchronises, plans, generates, renders and inspects a short music video', async () => {
    const { log, save } = reporter('14-mv-lite');
    const owner = await studioOwner();
    const projectId = `qa-mvlite-${RUN}`;
    const pref = col.projects().doc(projectId);
    mkdirSync(OUT, { recursive: true });

    // ---- QA copy of the song (the original project is only read) --------------------------------
    // A rerun with the same AZS_ACCEPTANCE_RUN resumes the video: finished paid work is reused, never repeated.
    const srcSong = (await col.songs(SRC_PROJECT).doc(SRC_SONG).get()).data() as SongDoc;
    expect(srcSong?.lyricsSheet?.lines.length, 'source lyric sheet').toBeGreaterThan(10);
    const reference = srcSong.lyricsSheet!;
    const chars = (await col.projects().doc(SRC_PROJECT).collection('characters').get()).docs.map((d) => d.data() as { name: string; description?: string; appearance?: string; wardrobe?: string; primaryRefAssetId?: string | null; referenceAssetIds?: string[] });
    const refsOf = (name: string) => {
      const c = chars.find((x) => x.name.toLowerCase().startsWith(name.toLowerCase()));
      return { description: [c?.description, c?.appearance].filter(Boolean).join(' ').slice(0, 600), clothing: c?.wardrobe ?? '', refAssetIds: [...new Set([c?.primaryRefAssetId, ...(c?.referenceAssetIds ?? [])].filter((x): x is string => Boolean(x)))].slice(0, 3) };
    };
    const prior = (await pref.get()).exists;
    if (!prior) {
      const spec: MvLiteSpec = defaultMvLiteSpec({ direction: 'narrative', aspect: '16:9', idea: 'Two young men in Cape Coast: a friendship, a feeling one of them cannot say. Keep it tender and discreet — glances, hands, the sea.' });
      spec.setup.extraAspects = ['9:16'];
      spec.song = { songId: SRC_SONG, range: null };
      spec.bible.characters = [
        { id: 'kofi', name: 'Kofi', ...refsOf('Kofi') },
        { id: 'kweku', name: 'Kweku', ...refsOf('Kweku') },
      ];
      spec.bible.locations = [
        { id: 'shore', name: 'Cape Coast shoreline and seawall', description: 'Atlantic shoreline with a weathered seawall, fishing canoes, salt haze', refAssetIds: ['lggKFICwO6C8fgxYPGKd'] },
        { id: 'room', name: 'Kofi’s bedroom', description: 'A small bedroom with a window onto the street, posters, a single bed, warm lamp', refAssetIds: ['7ckVeGowe3w1m5dUvTcA'] },
        { id: 'pitch', name: 'Community football pitch and kiosk', description: 'A dusty pitch with goalposts and a blue kiosk at the edge', refAssetIds: ['eeohq4JLtdXGUj2NuWQB'] },
      ];
      await pref.set({ ownerUid: owner.uid, title: `QA · Music Video Lite (${RUN})`, type: 'mv_lite', status: 'active', logline: 'An unfinished love song, told in stills.', format: { aspectRatio: '16:9', fps: 24 }, coverAssetId: null, styleBible: {}, mvlite: spec, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      await col.songs(projectId).doc(SRC_SONG).set({ audioAssetId: srcSong.audioAssetId, title: 'Unfinished Love Song', artist: '', durationSec: srcSong.durationSec, analysis: null, lyrics: null, ai: null, instrumental: false, lyricsSheet: reference, asr: null, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    }
    log(`${prior ? 'resumed' : 'new'} video ${projectId}`);

    let spent = 0;
    const runJobs = async (label: string, requests: JobRequest[], run: (j: JobDoc) => Promise<void>) => {
      if (!requests.length) return [] as string[];
      const prepared = await prepareAll(owner.uid, requests);
      const est = sumEstimates(prepared.map((p) => p.estimate), PRICING).usd;
      if (spent + est > BUDGET_USD) throw new Error(`Budget: ${label} would bring the run to $${(spent + est).toFixed(2)} (cap $${BUDGET_USD}).`);
      spent += est;
      const res = await createJobs(owner.uid, requests, { confirmedUsd: est, batchLabel: `QA mvlite ${label}` }, prepared);
      for (const id of res.jobIds) {
        const claimed = await claimJob(id);
        if (claimed) await run(claimed);
      }
      const failed = (await Promise.all(res.jobIds.map((id) => col.jobs().doc(id).get()))).filter((d) => d.get('status') !== 'completed');
      expect(failed.map((d) => `${d.id}: ${JSON.stringify(d.get('error'))}`), label).toEqual([]);
      log(`${label}: ${res.jobIds.length} job(s), est $${est.toFixed(3)}`);
      return res.jobIds;
    };
    const done = (type: string, pred: (j: Job) => boolean = () => true) => jobsOf(owner.uid, projectId).then((js) => js.find((j) => j.type === type && j.status === 'completed' && pred(j)) ?? null);
    const songNow = async () => mvSongOf(SRC_SONG, (await col.songs(projectId).doc(SRC_SONG).get()).data() as SongDoc)!;
    const specNow = async () => normalizeMvLiteSpec((await pref.get()).get('mvlite'));

    // ---- Beats, bars and sections from the real audio (DSP, no model) -----------------------------
    if (!(await done('music.analyze'))) await runJobs('analysis', [{ type: 'music.analyze', projectId, audioAssetId: srcSong.audioAssetId, detectVocals: false, label: 'Beat and section analysis' }], runMusicAnalyzeJob);
    const analysis = (await done('music.analyze'))!.result!.data!.analysis as MusicAnalysis;
    await col.songs(projectId).doc(SRC_SONG).update({ analysis: { bpm: analysis.bpm, beats: analysis.beats, downbeats: analysis.downbeats, energy: analysis.energy, energyHop: analysis.energyHop, sections: analysis.sections, method: 'dsp', analyzedAt: Date.now() } });
    log(`analysis: ${analysis.bpm} BPM · ${analysis.downbeats.length} bars · ${analysis.sections.map((s) => `${s.label}@${s.start.toFixed(1)}`).join(' ')}`);
    // First verse and chorus: from the bar before the first sung line to the bar before the second verse.
    const first = reference.lines.find((l) => l.start !== null)!.start!;
    const verse2 = reference.lines.find((l) => /in this country/i.test(l.text))?.start ?? first + 45;
    const range = { start: snapToBeat(Math.max(0, first - 1.2), analysis.downbeats), end: snapToBeat(verse2 - 0.3, analysis.downbeats) };
    await pref.update({ 'mvlite.song.range': range });
    log(`range ${range.start.toFixed(2)}–${range.end.toFixed(2)} s`);

    // ---- Lyrics synchronised to the vocals (transcription + alignment) ------------------------------
    if (!(await done('lyrics.align'))) await runJobs('lyrics', [{ type: 'lyrics.align', projectId, songId: SRC_SONG, audioAssetId: srcSong.audioAssetId, languageCode: 'en', retranscribe: false, label: 'Synchronise lyrics' }], runLyricsAlignJob);
    const aligned = (await col.songs(projectId).doc(SRC_SONG).get()).get('lyricsSheet') as LyricsSheet;
    const deltas = aligned.lines
      .map((l) => ({ l, r: reference.lines.find((x) => x.id === l.id) }))
      .filter(({ l, r }) => l.start !== null && r?.start != null && r.start >= range.start && r.start < range.end)
      .map(({ l, r }) => Math.abs(l.start! - r!.start!));
    const mean = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
    log(`lyrics: ${aligned.timing.status} · ${deltas.length} lines in range · start vs corrected sheet: mean ${mean.toFixed(2)} s, max ${Math.max(0, ...deltas).toFixed(2)} s · low-confidence ${aligned.timing.lowConfidenceLineIds.length}`);
    expect(deltas.length).toBeGreaterThan(5);
    // The director reads the synchronised sheet through and approves it.
    await col.songs(projectId).doc(SRC_SONG).update({ 'lyricsSheet.status': 'approved', 'lyricsSheet.approvedAt': Date.now() });

    // ---- Concept and shot plan (reasoning model) ------------------------------------------------
    let spec = await specNow();
    let song = await songNow();
    if (!spec.concept.treatment) {
      await runJobs('concept', [{ type: 'text.assist', projectId, task: 'mvlite.concept', input: mvConceptInput(spec, song), label: 'Music video concept' }], runTextJob);
      const job = (await done('text.assist', (j) => (j.params as { task?: string }).task === 'mvlite.concept'))!;
      const out = (await pref.collection('aiRuns').doc(job.result!.aiRunId!).get()).get('output') as MvConceptOut;
      spec = applyMvConcept(spec, out);
      await pref.update({ mvlite: spec });
      log(`concept: “${spec.concept.treatment?.title}” — ${spec.concept.treatment?.logline}`);
    }
    if (!spec.sections.length) {
      await runJobs('shot plan', [{ type: 'text.assist', projectId, task: 'mvlite.shots', input: mvShotsInput(spec, song), label: 'Music video shot plan' }], runTextJob);
      const job = (await done('text.assist', (j) => (j.params as { task?: string }).task === 'mvlite.shots'))!;
      const out = (await pref.collection('aiRuns').doc(job.result!.aiRunId!).get()).get('output') as MvPlanOut;
      spec = { ...spec, sections: mvPlanFromModel(spec, mvSectionsFromSong(spec, song), out) };
      await pref.update({ mvlite: spec });
    }
    log(`plan: ${spec.sections.map((s) => `${s.name || s.label} (${s.shots.length})`).join(' · ')}`);

    // ---- Images: a few generated, the rest existing stills ----------------------------------------
    const firstGen = mvShotsNeedingImages(spec)
      .filter(({ shot }) => !shot.image.approvedAssetId)
      .slice(0, MAX_GENERATED_IMAGES)
      .map(({ shot }) => shot.id);
    const plan = planMvWork(spec, song, 'QA music video', projectId, await jobsOf(owner.uid, projectId), { targetIds: firstGen });
    await runJobs('images', plan.planned.map((p) => p.request), runImageJob);
    const imgJobs = (await jobsOf(owner.uid, projectId)).filter((j) => j.type === 'image.generate' && j.status === 'completed');
    let stillNo = 0;
    spec = await specNow();
    spec = {
      ...spec,
      sections: spec.sections.map((s) => ({
        ...s,
        shots: s.shots.map((x) => {
          if (x.image.approvedAssetId || x.image.reuseOfShotId) return x;
          const gen = imgJobs.find((j) => j.target?.id === x.id)?.result?.assetIds?.[0];
          return { ...x, image: { ...x.image, approvedAssetId: gen ?? STILLS[stillNo++ % STILLS.length]!, uploads: gen ? x.image.uploads : [...x.image.uploads, { assetId: STILLS[(stillNo - 1) % STILLS.length]!, source: 'import' as const, jobId: null, prompt: null, at: Date.now() }] } };
        }),
      })),
    };
    await pref.update({ mvlite: spec });
    log(`images: ${imgJobs.length} generated (${imgJobs.map((j) => j.result?.assetIds?.[0]).join(', ')}), ${stillNo} existing stills`);

    // ---- Reopen: nothing is requested again ------------------------------------------------------
    const again = planMvWork(spec, song, 'QA music video', projectId, await jobsOf(owner.uid, projectId), {});
    expect(again.planned).toEqual([]);
    log('reopen: no repeated requests');

    // ---- Lyric style (the renderer lays the lyrics out with it) ------------------------------------
    const preset = spec.lyrics.preset;
    const track = (await pref.collection('lyricsTracks').doc(SRC_SONG).get()).data() as { styleId?: string } | undefined;
    if (!track?.styleId) {
      const style = await continuitySave(owner, payload('continuitySave', { projectId, collection: 'lyricStyles', data: { name: LYRIC_PRESET_LABELS[preset], global: { ...LYRIC_PRESET_STYLES[preset] }, sections: {}, fonts: [] }, id: null }));
      await continuitySave(owner, payload('continuitySave', { projectId, collection: 'lyricsTracks', data: { songId: SRC_SONG, styleId: style.id, placements: {} }, id: null }));
    }
    log(`lyric style: ${LYRIC_PRESET_LABELS[preset]}`);

    // ---- Composition and renders ----------------------------------------------------------------
    spec = await specNow();
    song = await songNow();
    const timing = computeMvTiming(spec, song);
    const imageIds = new Set(spec.sections.flatMap((s) => s.shots.map((x) => mvShotImageId(spec, x)).filter((x): x is string => Boolean(x))));
    const assetSnaps = await Promise.all([...imageIds, song.audioAssetId].map((id) => col.assets().doc(id).get()));
    const assets = Object.fromEntries(assetSnaps.map((s) => [s.id, { width: (s.get('width') as number | null) ?? null, height: (s.get('height') as number | null) ?? null, durationSec: (s.get('durationSec') as number | null) ?? null }]));
    const offGrid = timing.sections.flatMap((s) => s.shots).filter((x) => !x.onGrid).length;
    log(`timing: ${timing.totalSec.toFixed(2)} s · ${timing.sections.reduce((a, s) => a + s.shots.length, 0)} shots · ${offGrid} cut(s) off the grid`);

    const renders: { aspect: string; quality: 'draft' | 'final'; renderId: string }[] = [];
    for (const [aspect, preset, outWidth] of [['16:9', 'youtube_16x9', 1920], ['9:16', 'vertical_9x16', 1080]] as const) {
      const assembly = assembleMvTimeline({ spec, timing, song, assets, aspect, outWidth });
      const errors = assembly.issues.filter((i) => i.severity === 'error');
      // The main format must be clean; the vertical reframe of 16:9 stills is reported (framing is per format).
      if (aspect === spec.setup.aspect) expect(errors, JSON.stringify(errors)).toEqual([]);
      for (const i of assembly.issues) log(`  ${aspect} ${i.severity} ${i.kind}: ${i.message}`);
      log(`${aspect}: ${assembly.captions.length} lyric captions`);
      const tl = col.timelines(projectId).doc();
      await tl.set({ ownerUid: owner.uid, projectId, name: `QA mvlite ${aspect}`, fps: 24, aspectRatio: aspect, tracks: assembly.state.tracks, clips: assembly.state.clips, markers: assembly.state.markers, beatGrid: assembly.state.beatGrid, version: 1, durationSec: assembly.durationSec, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      for (const quality of aspect === '16:9' ? (['draft', 'final'] as const) : (['draft'] as const)) {
        const res = await createJobs(owner.uid, [{ type: 'render.timeline', projectId, timelineId: tl.id, preset, quality, inspect: quality === 'final', acceptLyricSync: false, audioMaster: 'preserve' }], { confirmedUsd: 5 });
        const job = (await col.jobs().doc(res.jobIds[0]!).get()).data() as JobDoc;
        const renderId = (job.params as { renderId: string }).renderId;
        renders.push({ aspect, quality, renderId });
        await col.jobs().doc(res.jobIds[0]!).set({ status: 'rendering', stage: 'Rendering locally (acceptance)' }, { merge: true });
        const started = Date.now();
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [path.join(ROOT, 'services/renderer/dist/main.js')], {
            env: { ...process.env, RENDER_ID: renderId, JOB_ID: res.jobIds[0]!, FFMPEG_BIN: require('ffmpeg-static') as string, FFPROBE_BIN: (require('ffprobe-static') as { path: string }).path, WORK_DIR: path.join(os.tmpdir(), `azs-mvlite-acc-${res.jobIds[0]}`) },
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
      const name = `mv-lite-${r.aspect.replace(':', 'x')}-${r.quality}.mp4`;
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
      expect(Math.abs(a.durationSec - timing.totalSec)).toBeLessThan(0.3);
    }
    const sheet = song.sheet!;
    writeFileSync(path.join(OUT, 'lyrics.lrc'), toLrc(sheet, { range, title: 'Unfinished Love Song', wordLevel: true }));
    writeFileSync(path.join(OUT, 'lyrics.srt'), toSrt(sheet, { range }));
    const usage = (await pref.get()).get('usage') as { costUsd: number } | undefined;
    const report = { projectId, run: RUN, sourceProject: SRC_PROJECT, range, estimateUsd: spent, recordedUsd: usage?.costUsd ?? null, timingSec: timing.totalSec, lyricSync: { status: aligned.timing.status, lines: deltas.length, meanStartDeltaSec: mean, maxStartDeltaSec: Math.max(0, ...deltas) }, concept: spec.concept.treatment, plan: spec.sections.map((s) => ({ section: s.name || s.label, idea: s.idea, shots: s.shots.map((x) => ({ brief: x.brief, bars: x.bars, motion: x.motion.preset, image: mvShotImageId(spec, x) })) })), outputs, finalInspection: inspected.finalInspection, findings };
    save(report);
    writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    log(`spent ≈ $${(usage?.costUsd ?? spent).toFixed(3)}; exports in ${OUT}`);
  });
});
