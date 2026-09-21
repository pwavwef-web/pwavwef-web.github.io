import { describe, expect, it } from 'vitest';
import { characterName, parseFountain, parseHeading } from '../src/fountain';
import { kindForMime, parseUploadPath, safeFileName, storagePaths, validateDeclaredUpload } from '../src/media';
import { canTransition, isTerminal, JOB_TRANSITIONS } from '../src/jobs';
import { formatBytes, formatTimecode, formatUsd } from '../src/format';
import { apiRequestSchema, jobRequestSchema } from '../src/schemas';

const SCRIPT = `Title: The Last Drum
Credit: written by
Author: F. Pwavwe

INT. KUMASI MARKET - DAY #1#

The market roars. AMA (20s) weaves through stalls.

AMA
(breathless)
Where is he?

KOFI (O.S.)
Over here!

CUT TO:

EXT. ROOFTOP - NIGHT

= Ama confronts Kofi.

AMA
We finish the song tonight.

KOFI
Then we play it for everyone. ^

> THE END <
`;

describe('Fountain parser', () => {
  const doc = parseFountain(SCRIPT);

  it('reads the title page', () => {
    expect(doc.titlePage.title).toBe('The Last Drum');
    expect(doc.titlePage.author).toBe('F. Pwavwe');
  });

  it('finds scenes, headings and numbers', () => {
    expect(doc.scenes).toHaveLength(2);
    expect(doc.scenes[0]).toMatchObject({ intExt: 'INT', location: 'KUMASI MARKET', timeOfDay: 'DAY', number: '1' });
    expect(doc.scenes[1]).toMatchObject({ intExt: 'EXT', location: 'ROOFTOP', timeOfDay: 'NIGHT', synopsis: 'Ama confronts Kofi.' });
  });

  it('classifies dialogue elements and characters', () => {
    const types = doc.elements.map((e) => e.type);
    expect(types).toContain('parenthetical');
    expect(types).toContain('transition');
    expect(types).toContain('centered');
    expect(doc.characters).toEqual(['AMA', 'KOFI']);
    expect(doc.scenes[0]!.characters).toEqual(['AMA', 'KOFI']);
    expect(doc.elements.find((e) => e.type === 'character' && e.dual)?.text).toBeUndefined();
    expect(doc.pageCount).toBeGreaterThan(0);
  });

  it('parses headings with INT./EXT. and forced headings', () => {
    expect(parseHeading('INT./EXT. CAR - MOVING')).toMatchObject({ intExt: 'INT/EXT', location: 'CAR', timeOfDay: 'MOVING' });
    expect(parseHeading('.FLASHBACK')).toMatchObject({ intExt: '', location: 'FLASHBACK' });
    expect(characterName("KOFI (CONT'D)")).toBe('KOFI');
  });

  it('ignores boneyard comments', () => {
    const d = parseFountain('INT. A - DAY\n\n/* hidden\nINT. B - DAY */\n\nAction.');
    expect(d.scenes).toHaveLength(1);
  });
});

describe('media policy', () => {
  it('validates declared uploads', () => {
    expect(validateDeclaredUpload({ fileName: 'a.png', mimeType: 'image/png', sizeBytes: 1000, kind: 'image' })).toBeNull();
    expect(validateDeclaredUpload({ fileName: 'a.exe', mimeType: 'application/x-msdownload', sizeBytes: 1000, kind: 'image' })).toMatch(/not supported/);
    expect(validateDeclaredUpload({ fileName: 'a.png', mimeType: 'image/png', sizeBytes: 999 * 1024 * 1024, kind: 'image' })).toMatch(/30 MB/);
    expect(validateDeclaredUpload({ fileName: 'a.png', mimeType: 'image/png', sizeBytes: 0, kind: 'image' })).toMatch(/empty/);
  });

  it('builds safe storage paths', () => {
    expect(safeFileName('../../etc/passwd')).toBe('etc_passwd');
    expect(safeFileName('Mÿ Sóng (final).mp3')).toBe('My_Song_final_.mp3');
    const p = storagePaths.upload('u1', 'a1', 'My Song.mp3');
    expect(parseUploadPath(p)).toEqual({ uid: 'u1', assetId: 'a1', fileName: 'My_Song.mp3' });
    expect(parseUploadPath('users/u1/generated/x/y.mp4')).toBeNull();
    expect(kindForMime('audio/x-m4a')).toBe('audio');
    expect(kindForMime('application/zip')).toBeNull();
  });
});

describe('job state machine', () => {
  it('allows only forward transitions', () => {
    expect(canTransition('queued', 'validating')).toBe(true);
    expect(canTransition('generating', 'downloading')).toBe(true);
    expect(canTransition('completed', 'queued')).toBe(false);
    expect(canTransition('failed', 'generating')).toBe(false);
    expect(isTerminal('cancelled')).toBe(true);
    for (const s of ['completed', 'failed', 'cancelled'] as const) expect(JOB_TRANSITIONS[s]).toEqual([]);
  });
});

describe('formatting', () => {
  it('formats timecodes, bytes and money', () => {
    expect(formatTimecode(83.45)).toBe('1:23.4');
    expect(formatTimecode(3725, 0)).toBe('1:02:05');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(0.51)).toBe('$0.51');
  });
});

describe('API schemas', () => {
  it('parses job requests and rejects unknown actions', () => {
    const job = jobRequestSchema.parse({ type: 'image.generate', prompt: 'A lighthouse', aspectRatio: '16:9', imageSize: '2K' });
    expect(job.type).toBe('image.generate');
    expect(() => apiRequestSchema.parse({ action: 'dropDatabase', payload: {} })).toThrow();
    expect(() => jobRequestSchema.parse({ type: 'video.generate', prompt: '' })).toThrow();
    const r = apiRequestSchema.parse({ action: 'retryJob', payload: { jobId: 'abc', acknowledgeCharge: true } });
    expect(r.action).toBe('retryJob');
    expect(() => apiRequestSchema.parse({ action: 'retryJob', payload: { jobId: 'abc', acknowledgeCharge: false } })).toThrow();
  });
});
