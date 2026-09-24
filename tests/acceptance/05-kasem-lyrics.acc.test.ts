import { describe, expect, it } from 'vitest';
import { normalizeWord, parseLyricsText, sheetFromParsed, sheetToLyricLines, type AsrWord, type LyricsSheet } from '@az-studio/shared';
import { col, FieldValue } from '../../functions/src/lib/firebase';
import { qaProject, reporter, studioOwner, submitJobs, waitForJob } from './harness';

const codePoints = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0')).join(' ');
const KASEM_LETTERS = /[ɛɔɩʋŋƐƆƖƲŊ]/u;

/** The studio's own Kasem song ("De N Lei — Come Learn Kasem"): used read-only, never modified. */
async function findKasemSong(ownerUid: string) {
  const projects = await col.projects().where('ownerUid', '==', ownerUid).get();
  const found: { projectTitle: string; title: string; audioAssetId: string; durationSec: number; lines: string[] }[] = [];
  for (const p of projects.docs) {
    if (p.id.startsWith('qa-')) continue;
    for (const s of (await p.ref.collection('songs').get()).docs) {
      const lines = ((s.get('lyrics')?.lines ?? []) as { text: string }[]).map((l) => l.text).filter((t) => t.trim());
      if (/kasem/i.test(String(s.get('title'))) && s.get('audioAssetId') && lines.length) found.push({ projectTitle: String(p.get('title')), title: String(s.get('title')), audioAssetId: String(s.get('audioAssetId')), durationSec: Number(s.get('durationSec')), lines });
    }
  }
  return found.find((f) => !/layout check/i.test(f.projectTitle)) ?? found[0] ?? null;
}

describe('Acceptance 5 — Kasem lyrics', () => {
  it('keeps the creator’s Kasem spelling exactly, marks AI-derived Kasem for verification, and aligns without “correcting” it', async () => {
    const { log, save } = reporter('05-kasem-lyrics');
    const owner = await studioOwner();
    const source = await findKasemSong(owner.uid);
    expect(source, 'A Kasem song with audio is needed in the studio library').not.toBeNull();
    log(`using "${source!.title}" from "${source!.projectTitle}" (${source!.durationSec} s, ${source!.lines.length} lyric lines) — read-only`);
    const projectId = await qaProject(owner, 'kasem', 'Kasem lyrics', 'music_video', { language: 'xsm' });
    await col.songs(projectId).doc('song').set({ title: source!.title, artist: '', audioAssetId: source!.audioAssetId, durationSec: source!.durationSec, analysis: null, ai: null, lyrics: null, createdAt: FieldValue.serverTimestamp() });

    // 1. Extract lyrics from the song: an AI-derived Kasem draft that must be verified by a fluent speaker.
    const [extractId] = await submitJobs(owner, [{ type: 'lyrics.transcribe', projectId, songId: 'song', audioAssetId: source!.audioAssetId, languageCode: 'xsm', label: 'QA · extract Kasem lyrics' }], 'QA · extract');
    const extract = await waitForJob(extractId!, log);
    expect(extract.status).toBe('completed');
    const afterExtract = (await col.songs(projectId).doc('song').get()).data()!;
    const draft = afterExtract.lyricsSheet as LyricsSheet;
    log(`extracted draft: ${draft.lines.length} lines, source ${draft.source}, language ${draft.language}, needs verification ${draft.requiresLanguageVerification}; vocals ${JSON.stringify(afterExtract.vocals)}`);
    expect(afterExtract.vocals?.present).toBe(true);
    expect(draft.source).toBe('transcribed');
    expect(draft.language).toBe('xsm');
    expect(draft.requiresLanguageVerification).toBe(true);
    expect(draft.status).toBe('draft');

    // 2. The creator's own Kasem text replaces the draft and becomes the source of truth.
    const uploadedText = source!.lines.join('\n');
    const uploaded = sheetFromParsed(parseLyricsText(uploadedText, 'plain'), { source: 'uploaded', language: 'xsm' });
    expect(uploaded.lines.map((l) => l.text)).toEqual(source!.lines);
    expect(uploaded.requiresLanguageVerification).toBe(false);
    await col.songs(projectId).doc('song').set({ lyricsSheet: uploaded, lyrics: { source: 'upload', lines: sheetToLyricLines(uploaded) }, instrumental: false }, { merge: true });

    // 3. Align to the vocals (reuses the cached transcript) — the wording must not change.
    const [alignId] = await submitJobs(owner, [{ type: 'lyrics.align', projectId, songId: 'song', audioAssetId: source!.audioAssetId, languageCode: 'xsm', retranscribe: false, label: 'QA · synchronise Kasem lyrics' }], 'QA · align');
    const align = await waitForJob(alignId!, log);
    expect(align.status).toBe('completed');
    const song = (await col.songs(projectId).doc('song').get()).data()!;
    const sheet = song.lyricsSheet as LyricsSheet;
    const asr = (song.asr?.words ?? []) as AsrWord[];

    // Byte-for-byte: every line, every Kasem letter and diacritic — including the Greek "ε" the original text uses.
    expect(sheet.lines.map((l) => l.text)).toEqual(source!.lines);
    sheet.lines.forEach((l, i) => expect(codePoints(l.text)).toBe(codePoints(source!.lines[i]!)));
    const special = source!.lines.filter((l) => KASEM_LETTERS.test(l) || /ε/u.test(l));
    expect(special.length).toBeGreaterThan(0);
    expect(sheet.language).toBe('xsm');
    expect(sheet.source).toBe('uploaded');
    expect(sheet.requiresLanguageVerification).toBe(false);

    const timed = sheet.lines.filter((l) => l.start !== null && l.end !== null);
    const flagged = sheet.lines.filter((l) => l.flags.length);
    log(`aligned ${timed.length}/${sheet.lines.length} lines (${sheet.timing.status}); ${flagged.length} flagged for a listen; transcript language "${song.asr?.languageCode}", ${asr.length} words`);
    for (const l of sheet.lines.slice(0, 12)) log(`  ${l.start?.toFixed(1) ?? '—'}–${l.end?.toFixed(1) ?? '—'}  ${l.text}${l.flags.length ? `  [${l.flags.join(', ')}]` : ''}`);
    expect(timed.length).toBeGreaterThanOrEqual(Math.ceil(sheet.lines.length * 0.6));
    for (const l of timed) expect(l.end!).toBeGreaterThan(l.start!);

    // Where the transcript spelled a word differently, the sheet still has the creator's spelling.
    const heard = new Set(asr.map((w) => w.text));
    const keptOverTranscript = [...new Set(sheet.lines.flatMap((l) => l.text.split(/\s+/)).filter((w) => KASEM_LETTERS.test(w) || /ε/u.test(w)))].map((w) => ({ word: w, transcribedExactly: heard.has(w), transcriptVariants: asr.filter((a) => normalizeWord(a.text) === normalizeWord(w) && a.text !== w).map((a) => a.text).slice(0, 3) }));
    log(`Kasem-letter words kept as written: ${keptOverTranscript.map((k) => `${k.word}${k.transcriptVariants.length ? ` (heard as ${k.transcriptVariants.join('/')})` : ''}`).join(', ')}`);

    save({ source: { title: source!.title, project: source!.projectTitle, audioAssetId: source!.audioAssetId, durationSec: source!.durationSec }, extractedDraft: { lines: draft.lines.length, requiresLanguageVerification: draft.requiresLanguageVerification, sample: draft.lines.slice(0, 8).map((l) => l.text) }, timing: sheet.timing, transcriptLanguage: song.asr?.languageCode, transcriptModel: song.asr?.modelId, lines: sheet.lines.map((l) => ({ text: l.text, start: l.start, end: l.end, flags: l.flags })), keptOverTranscript });
  });
});
