import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { describe, expect, it } from 'vitest';
import { addTrack, applyScoreToTimeline, DEFAULT_SCORE_MIX, emptyTimeline, makeClip, movementPrompt, normalizeCueSheet, planMovements, timelineDuration, type MusicalBible, type ScoreCue } from '@az-studio/shared';
import { MUSIC_MODEL_LIMITATION } from '../../functions/src/config/models';
import { bucket, col, FieldValue } from '../../functions/src/lib/firebase';
import { qaProject, reporter, studioOwner, submitJobs, uploadFile, waitForJob } from './harness';

const FFMPEG = ffmpegPath as unknown as string;
const FOUNTAIN = `INT. FISHING CANOE - DAWN

The sea is still. AMA (30s) checks the nets while KOFI (40s) steers.

AMA
The tide will turn before nightfall.

KOFI
Then we sail at first light.

EXT. VILLAGE BEACH - DAY

Children run between drying nets. A storm gathers on the horizon.

EXT. OPEN SEA - STORM - NIGHT

Waves crash over the canoe. Kofi fights the tiller; Ama bails water.

EXT. VILLAGE BEACH - DAWN

Silence. The canoe drifts ashore. The village runs to meet them.`;

/** Mean level (dB) of the band below 70 Hz — where the score tone lives and the voice does not. */
function measure(file: string, start: number, dur: number): number {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-ss', String(start), '-t', String(dur), '-i', file, '-vn', '-af', 'lowpass=f=70,lowpass=f=70,lowpass=f=70,volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(/mean_volume:\s*(-?[\d.]+)/.exec(r.stderr)?.[1] ?? NaN);
}

describe('Acceptance 6 — film score continuity', () => {
  it('plans a continuous instrumental score from a musical bible and cue sheet, and ducks the score under dialogue in the real render', async () => {
    const { log, save } = reporter('06-film-score');
    const owner = await studioOwner();
    const projectId = await qaProject(owner, 'score', 'Film score', 'film', { logline: 'Two fishers race a storm home across the Gulf of Guinea.', genre: 'drama' });
    const results: Record<string, unknown> = {};

    // 1. Musical bible (Gemini).
    const [bibleJob] = await submitJobs(owner, [{ type: 'text.assist', projectId, task: 'film.score_bible', input: { title: 'The Tide', genre: 'drama', logline: 'Two fishers race a storm home across the Gulf of Guinea.', direction: 'Ghanaian, restrained, hopeful', treatment: '', characters: [{ name: 'AMA', description: 'fisher, thirties' }, { name: 'KOFI', description: 'fisher, forties' }], locations: [{ name: 'Canoe', description: 'wooden fishing canoe' }, { name: 'Village beach', description: 'nets drying on the sand' }], fountain: FOUNTAIN }, label: 'QA · musical bible' }], 'QA · bible');
    const bj = await waitForJob(bibleJob!, log);
    expect(bj.status).toBe('completed');
    const b = (await col.projects().doc(projectId).collection('aiRuns').doc(String(bj.result?.aiRunId)).get()).get('output') as Record<string, unknown>;
    const bible: MusicalBible = { mainTheme: String(b.mainTheme), emotionalMotif: String(b.emotionalMotif), instrumentation: (b.instrumentation as string[]) ?? [], key: String(b.key), tempoRange: { min: Math.round(Number(b.tempoMin) || 70), max: Math.round(Number(b.tempoMax) || 100) }, culturalDirection: String(b.culturalDirection), characterThemes: (b.characterThemes as MusicalBible['characterThemes']) ?? [], locationThemes: (b.locationThemes as MusicalBible['locationThemes']) ?? [], tensionLanguage: String(b.tensionLanguage), resolutionLanguage: String(b.resolutionLanguage), avoid: (b.avoid as string[]) ?? [], notes: String(b.notes ?? '') };
    log(`bible: main theme "${bible.mainTheme}"; ${bible.key}; ${bible.tempoRange.min}–${bible.tempoRange.max} BPM; ${bible.instrumentation.join(', ')}`);
    expect(bible.mainTheme.length).toBeGreaterThan(10);
    expect(bible.instrumentation.length).toBeGreaterThan(1);
    results.bible = bible;

    // 2. Cue sheet (Gemini) for a 5-minute cut → connected movements.
    const scenes = [
      { sceneId: 's1', heading: 'INT. FISHING CANOE - DAWN', summary: 'Ama and Kofi prepare to sail; quiet dialogue', mood: 'calm', start: 0, end: 70, dialogueShare: 0.5 },
      { sceneId: 's2', heading: 'EXT. VILLAGE BEACH - DAY', summary: 'Children among the nets; a storm gathers', mood: 'unease', start: 70, end: 140, dialogueShare: 0.1 },
      { sceneId: 's3', heading: 'EXT. OPEN SEA - STORM - NIGHT', summary: 'They fight the storm', mood: 'danger', start: 140, end: 240, dialogueShare: 0.05 },
      { sceneId: 's4', heading: 'EXT. VILLAGE BEACH - DAWN', summary: 'Silence, then the village runs to meet them', mood: 'relief', start: 240, end: 300, dialogueShare: 0 },
    ];
    const [cueJob] = await submitJobs(owner, [{ type: 'text.assist', projectId, task: 'film.cue_sheet', input: { title: 'The Tide', bible, mode: 'cinematic', direction: 'Ghanaian, restrained, hopeful', durationSec: 300, scenes }, label: 'QA · cue sheet' }], 'QA · cues');
    const cj = await waitForJob(cueJob!, log);
    expect(cj.status).toBe('completed');
    const out = (await col.projects().doc(projectId).collection('aiRuns').doc(String(cj.result?.aiRunId)).get()).get('output') as { cues: Partial<ScoreCue>[] };
    const cueSheet = normalizeCueSheet(out.cues, 300);
    const movements = planMovements(cueSheet, { crossfadeSec: DEFAULT_SCORE_MIX.crossfadeSec });
    for (const c of cueSheet) log(`  cue ${c.start}–${c.end} s ${c.silence ? 'SILENCE' : `intensity ${c.intensity}`} ${c.purpose}`);
    for (const m of movements) log(`  movement ${m.index + 1}: ${m.start}–${m.end} s (${m.cueIds.length} cues)`);
    expect(cueSheet.length).toBeGreaterThanOrEqual(3);
    expect(cueSheet[0]!.start).toBe(0);
    for (let i = 1; i < cueSheet.length; i++) expect(cueSheet[i]!.start).toBeGreaterThanOrEqual(cueSheet[i - 1]!.end - 1e-6);
    expect(movements.length).toBeGreaterThanOrEqual(1);
    for (const m of movements) expect(m.end - m.start).toBeLessThanOrEqual(150 + DEFAULT_SCORE_MIX.crossfadeSec + 1e-6);
    const prompts = movements.map((m) => movementPrompt({ title: 'The Tide', mode: 'cinematic', cueSheet, bible }, m, DEFAULT_SCORE_MIX.crossfadeSec));
    for (const p of prompts) {
      expect(p).toMatch(/Strictly instrumental/);
      expect(p).toContain(bible.mainTheme.slice(0, 20));
    }
    await col.scores(projectId).doc('main').set({ title: 'The Tide', mode: 'cinematic', bible, mainThemeLockedAt: Date.now(), bibleApprovedAt: Date.now(), cueSheet, movements, mix: DEFAULT_SCORE_MIX, importedAssetId: null, durationSec: 300, createdAt: FieldValue.serverTimestamp() });
    results.cueSheet = cueSheet;
    results.movements = movements.map((m, i) => ({ start: m.start, end: m.end, cues: m.cueIds.length, prompt: prompts[i] }));

    // 3. Movement generation uses Lyria 3.5 only.
    const [mvJob] = await submitJobs(owner, [{ type: 'music.generate', projectId, purpose: 'score_movement', prompt: 'score', lyrics: null, instrumental: true, languageCode: null, imageAssetIds: [], songId: null, scoreId: 'main', movementId: movements[0]!.id, label: 'QA · score movement 1' }], 'QA · movement');
    const mv = await waitForJob(mvJob!, log, 20 * 60_000);
    log(`Lyria 3.5 movement: ${mv.status}${mv.error ? ` — ${mv.error.code}: ${mv.error.message}` : ''}`);
    results.movementGeneration = { status: mv.status, modelId: mv.modelId, error: mv.error ?? null, usageUsd: mv.usageUsd ?? 0 };
    expect(mv.modelId).toBe('lyria-3.5');
    if (mv.status !== 'completed') {
      expect(mv.error?.code).toBe('model_unavailable');
      expect(mv.error?.message).toBe(MUSIC_MODEL_LIMITATION);
    }

    // 4. Mixing in the deployed renderer: an imported soundtrack (a steady low tone) ducks under real dialogue.
    const dir = mkdtempSync(path.join(tmpdir(), 'azs-acc-'));
    try {
      const tone = path.join(dir, 'imported-soundtrack.wav');
      const FILM = 24;
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=55:duration=${FILM}:sample_rate=48000`, '-af', 'volume=12dB', '-ac', '2', '-c:a', 'pcm_s16le', tone]);
      const soundtrack = await uploadFile(owner, projectId, tone, 'audio', 'audio/wav', log);
      const [speechJob] = await submitJobs(owner, [{ type: 'speech.generate', projectId, lines: [{ index: 0, character: 'AMA', text: 'The tide will turn before nightfall.', voice: null, direction: 'Calm and resolute' }], languageCode: 'en', label: 'QA · dialogue line' }], 'QA · speech');
      const sj = await waitForJob(speechJob!, log);
      expect(sj.status).toBe('completed');
      const line = (sj.result?.data as { lines: { assetId: string; fileSeconds: number; seconds: number | null }[] }).lines[0]!;
      log(`dialogue line: ${line.fileSeconds} s file, ${line.seconds} s of speech`);

      const dlgStart = 8;
      let tl = addTrack(emptyTimeline('16:9', 24), 'audio', 'Dialogue');
      const dlgTrack = tl.tracks.filter((t) => t.kind === 'audio').at(-1)!;
      tl = { ...tl, clips: [...tl.clips, makeClip({ trackId: dlgTrack.id, kind: 'audio', start: dlgStart, duration: line.fileSeconds, assetId: line.assetId, sourceDuration: line.fileSeconds, label: 'Dialogue · AMA', role: 'dialogue' })] };
      tl = applyScoreToTimeline(tl, { mode: 'cinematic', mix: DEFAULT_SCORE_MIX, cueSheet: [], movements: [], importedAssetId: soundtrack.id }, { importedDurationSec: Number(soundtrack.durationSec), filmDurationSec: FILM });
      const scoreClip = tl.clips.find((c) => c.label.startsWith('Score'))!;
      expect(scoreClip).toMatchObject({ role: 'music', duck: true, duckDb: DEFAULT_SCORE_MIX.duckDb });
      await col.timelines(projectId).doc('mix').set({ ownerUid: owner.uid, projectId, name: 'Score mix check', fps: tl.fps, aspectRatio: tl.aspectRatio, tracks: tl.tracks, clips: tl.clips, markers: tl.markers, beatGrid: tl.beatGrid, version: 1, durationSec: timelineDuration(tl.clips), updatedAt: FieldValue.serverTimestamp() });
      const [renderId] = await submitJobs(owner, [{ type: 'render.timeline', projectId, timelineId: 'mix', preset: 'youtube_16x9', quality: 'draft', acceptLyricSync: false }], 'QA · render');
      const render = await waitForJob(renderId!, log, 30 * 60_000);
      expect(render.status).toBe('completed');
      const asset = (await col.assets().doc(String(render.result?.assetIds?.[0])).get()).data()!;
      const file = path.join(dir, 'render.mp4');
      await bucket.file(String(asset.storagePath)).download({ destination: file });
      // Baselines away from the fades and the dialogue; half-second windows while the line is spoken.
      const speechEnd = dlgStart + line.fileSeconds;
      const before = measure(file, 2, 5);
      const after = measure(file, speechEnd + 1.5, 4);
      const baseline = (before + after) / 2;
      const windows: { at: number; db: number; reductionDb: number }[] = [];
      for (let t = dlgStart + 0.25; t + 0.5 <= speechEnd - 0.2; t += 0.5) {
        const db = measure(file, t, 0.5);
        windows.push({ at: Math.round(t * 100) / 100, db, reductionDb: Math.round((baseline - db) * 10) / 10 });
      }
      const reductions = windows.map((w) => w.reductionDb).sort((a, b) => a - b);
      const median = reductions[Math.floor(reductions.length / 2)] ?? 0;
      const max = reductions.at(-1) ?? 0;
      log(`score level below 70 Hz: before ${before} dB, after ${after} dB; under dialogue ${windows.map((w) => `${w.at}s ${w.db}`).join(', ')} → median duck ${median} dB, deepest ${max} dB (setting ${DEFAULT_SCORE_MIX.duckDb} dB)`);
      results.mix = { renderAssetId: render.result?.assetIds?.[0], beforeDb: before, afterDb: after, windows, medianDuckDb: median, maxDuckDb: max, duckSettingDb: DEFAULT_SCORE_MIX.duckDb, crossfadeSec: DEFAULT_SCORE_MIX.crossfadeSec };
      expect(windows.length).toBeGreaterThanOrEqual(3);
      // The score dips under the voice and comes back afterwards.
      expect(median).toBeGreaterThanOrEqual(6);
      expect(max).toBeGreaterThanOrEqual(8);
      expect(Math.abs(after - before)).toBeLessThan(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    save(results);
  });
});
