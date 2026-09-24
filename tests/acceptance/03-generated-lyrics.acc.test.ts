import { describe, expect, it } from 'vitest';
import { parseLyricsText, sheetFromParsed, sheetToLyricLines, type LyricsSheet } from '@az-studio/shared';
import { MODEL_REGISTRY, MUSIC_MODEL_LIMITATION } from '../../functions/src/config/models';
import { col, FieldValue } from '../../functions/src/lib/firebase';
import { prepareAll } from '../../functions/src/lib/submit';
import { qaProject, reporter, studioOwner, submitJobs, waitForJob } from './harness';

type LyricsOut = { title?: string; languageCode?: string; sections?: { label: string; name: string; lines: string[] }[]; notes?: string };

describe('Acceptance 3 — generated lyrics', () => {
  it('writes editable draft lyrics with the reasoning model, flags AI-written Kasem, and never invents lyrics for instrumentals', async () => {
    const { log, save } = reporter('03-generated-lyrics');
    const owner = await studioOwner();
    const projectId = await qaProject(owner, 'lyrics-gen', 'Generated lyrics', 'music_video', { language: 'en' });
    const results: Record<string, unknown> = {};

    // 1. Lyrics only (Gemini reasoning model), in English and in Kasem.
    const sheets: Record<string, LyricsSheet> = {};
    for (const [language, languageName] of [
      ['en', 'English'],
      ['xsm', 'Kasem'],
    ] as const) {
      const [jobId] = await submitJobs(owner, [{ type: 'text.assist', projectId, task: 'music.lyrics', input: { language, languageName, subject: 'Fishermen returning home across the Volta at dawn', structure: 'verse, chorus, verse, chorus', tone: 'hopeful', genre: 'highlife', title: 'Volta Morning', notes: '' }, label: `QA · lyrics (${language})` }], 'QA · lyrics');
      const job = await waitForJob(jobId!, log);
      expect(job.status).toBe('completed');
      const run = await col.projects().doc(projectId).collection('aiRuns').doc(String(job.result?.aiRunId)).get();
      const out = run.get('output') as LyricsOut;
      const text = (out.sections ?? []).map((s) => `[${s.name || s.label}]\n${s.lines.join('\n')}`).join('\n\n');
      const sheet = sheetFromParsed(parseLyricsText(text, 'plain'), { source: 'generated', language, status: 'draft' });
      sheets[language] = sheet;
      // Saved to a song exactly as the Lyrics tab does.
      await col.songs(projectId).doc(`draft-${language}`).set({ title: `Volta Morning (${languageName})`, artist: '', audioAssetId: '', durationSec: 0, analysis: null, ai: null, lyricsSheet: sheet, lyrics: { source: 'ai', lines: sheetToLyricLines(sheet) }, instrumental: false, createdAt: FieldValue.serverTimestamp() });
      log(`${languageName}: ${sheet.lines.length} lines in ${sheet.sections.length} sections by ${job.modelId}; needs language verification: ${sheet.requiresLanguageVerification}`);
      log(`  first lines: ${sheet.lines.slice(0, 3).map((l) => l.text).join(' / ')}`);
      results[language] = { modelId: job.modelId, usageUsd: job.usageUsd ?? null, lines: sheet.lines.map((l) => l.text), sections: sheet.sections.map((s) => s.name), requiresLanguageVerification: sheet.requiresLanguageVerification, status: sheet.status };
      expect([MODEL_REGISTRY.reasoning.id, MODEL_REGISTRY.reasoning.fallbackId]).toContain(job.modelId);
      expect(sheet.lines.length).toBeGreaterThanOrEqual(8);
      expect(sheet.sections.length).toBeGreaterThanOrEqual(3);
      expect(sheet.status).toBe('draft');
      expect(sheet.source).toBe('generated');
      expect(sheet.timing.status).toBe('none');
    }
    // AI-written Kasem must be verified by a fluent speaker before approval; English need not be.
    expect(sheets.xsm!.requiresLanguageVerification).toBe(true);
    expect(sheets.en!.requiresLanguageVerification).toBe(false);

    // 2. Music and lyrics with Lyria 3.5 — only that model; if Vertex AI does not serve it, the job
    //    must fail with the exact limitation and nothing may be generated or billed by another model.
    const lyrics = sheets.en!.lines.map((l) => l.text).join('\n');
    const [musicId] = await submitJobs(owner, [{ type: 'music.generate', projectId, purpose: 'song', prompt: 'Joyful Ghanaian highlife with interlocking clean electric guitars, congas and a warm male tenor.', lyrics, instrumental: false, languageCode: 'en', imageAssetIds: [], songId: null, title: 'Volta Morning' }], 'QA · Lyria song');
    const music = await waitForJob(musicId!, log, 20 * 60_000);
    results.music = { status: music.status, modelId: music.modelId, error: music.error ?? null, usageUsd: music.usageUsd ?? 0, assetIds: music.result?.assetIds ?? [] };
    log(`Lyria 3.5 song: ${music.status}${music.error ? ` — ${music.error.code}: ${music.error.message}` : ''}`);
    expect(music.modelId).toBe('lyria-3.5');
    if (music.status === 'completed') {
      expect(music.result?.assetIds?.length).toBeGreaterThan(0);
    } else {
      expect(music.status).toBe('failed');
      expect(music.error?.code).toBe('model_unavailable');
      expect(music.error?.message).toBe(MUSIC_MODEL_LIMITATION);
      expect(music.usageUsd ?? 0).toBe(0);
    }

    // 3. Instrumental songs never get lyrics: extraction and "instrumental with lyrics" are refused.
    await col.songs(projectId).doc('instrumental').set({ title: 'Instrumental bed', artist: '', audioAssetId: 'none', durationSec: 0, analysis: null, ai: null, lyrics: null, instrumental: true, createdAt: FieldValue.serverTimestamp() });
    await expect(prepareAll(owner.uid, [{ type: 'music.generate', projectId, purpose: 'song', prompt: 'Calm guitar', lyrics: 'La la la', instrumental: true, languageCode: null, imageAssetIds: [], songId: null } as never])).rejects.toThrow(/Instrumental music cannot have lyrics/);
    results.instrumentalGuards = 'Instrumental music with lyrics is refused before any model call.';
    save(results);
  });
});
