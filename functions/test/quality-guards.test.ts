import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/firebase', async () => import('./fakes'));
vi.mock('firebase-functions', async (orig) => ({ ...(await orig<typeof import('firebase-functions')>()), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/lib/interactions', () => ({ logInteraction: async () => undefined }));
const generateContent = vi.fn();
vi.mock('../src/lib/vertex', () => ({ genai: () => ({ models: { generateContent: (...a: unknown[]) => generateContent(...a) } }) }));
const callReasoning = vi.fn();
vi.mock('../src/workers/text', async (orig) => ({ ...(await orig<typeof import('../src/workers/text')>()), callReasoning: (...a: unknown[]) => callReasoning(...a), usageFor: async () => 0 }));

import { likenessSubjects } from '@az-studio/shared';
import { speakLine } from '../src/lib/audio-models';
import { checkLikeness } from '../src/workers/image';
import { normalizeAdReview } from '../src/workers/ad-validate';
import { projectTerms } from '../src/workers/final-inspect';
import { nameTerms } from '../src/workers/linkad';

/** A spoken take: a tone of `seconds` after 0.2 s of silence, as the speech model returns it (PCM16 at 24 kHz). */
function take(seconds: number) {
  const rate = 24000;
  const pcm = Buffer.alloc(Math.round((seconds + 0.4) * rate) * 2);
  for (let i = 0; i < pcm.length / 2; i++) {
    const t = i / rate;
    const v = t > 0.2 && t < 0.2 + seconds ? Math.sin(2 * Math.PI * 220 * t) * 0.4 : 0;
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return { candidates: [{ content: { parts: [{ inlineData: { data: pcm.toString('base64'), mimeType: 'audio/L16;rate=24000' } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 100 } };
}
const promptOf = (call: number) => (generateContent.mock.calls[call]![0] as { contents: { parts: { text: string }[] }[] }).contents[0]!.parts[0]!.text;

beforeEach(() => {
  generateContent.mockReset();
  callReasoning.mockReset();
});

describe('speakLine: the guard on every spoken take', () => {
  it('sends clean text and a delivery-only direction with a single colon', async () => {
    generateContent.mockResolvedValueOnce(take(1.6));
    const r = await speakLine('Honey: fresh; every day!', 'Kore', 'Warm and bright. Pronounce honey as HUN-ee.');
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(promptOf(0)).toBe('Warm and bright: Honey, fresh, every day!');
    expect(r.guard).toMatchObject({ verdict: 'ok', takes: 1, retaken: false, direction: 'Warm and bright.' });
    expect(r.guard.changes.join(' ')).toMatch(/colons/);
    expect(r.guard.changes.join(' ')).toMatch(/direction reduced/);
  });

  it('re-takes an implausibly long take once, without the direction, and keeps the plausible one', async () => {
    generateContent.mockResolvedValueOnce(take(20)).mockResolvedValueOnce(take(1.7));
    const r = await speakLine('Fresh honey, every day.', 'Kore', 'Upbeat and friendly.');
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(promptOf(1)).toBe('Fresh honey, every day.');
    expect(r.guard).toMatchObject({ verdict: 'ok', takes: 2, retaken: true, direction: '' });
    expect(r.speech!.durationSec).toBeLessThan(2.5);
    // Both takes are billed.
    expect(r.usage).toEqual({ input: 20, output: 200 });
  });

  it('keeps the closer take and records the flag when the re-take is implausible too', async () => {
    generateContent.mockResolvedValueOnce(take(20)).mockResolvedValueOnce(take(12));
    const r = await speakLine('Fresh honey, every day.', 'Kore', '');
    expect(r.guard.verdict).toBe('too_long');
    expect(r.speech!.durationSec).toBeLessThan(13);
    expect(r.guard.flags.join(' ')).toMatch(/implausible_length.*re-take/);
    generateContent.mockResolvedValueOnce(take(20));
    expect((await speakLine('Fresh honey, every day.', 'Kore', '', { retake: false })).guard.takes).toBe(1);
  });

  it('applies the shared respellings to the spoken text only', async () => {
    generateContent.mockResolvedValueOnce(take(2.2));
    const r = await speakLine('Made with AZ Studio.', 'Kore', '');
    expect(promptOf(0)).toBe('Made with A Z Studio.');
    expect(r.guard.changes[0]).toMatch(/respellings/);
  });
});

describe('likeness check after a Lite still', () => {
  const subjects = likenessSubjects([{ id: 'ama', name: 'Ama', refAssetIds: ['ref-ama'], clothing: 'Indigo wrapper' }], { outfitFromText: true });
  const job = { id: 'j', ownerUid: 'u', projectId: 'p' } as never;

  it('sends the new still first, then the references, and stores a failing verdict', async () => {
    callReasoning.mockResolvedValueOnce({ json: { characters: [{ name: 'Ama', visible: true, faceMatch: true, outfitMatch: false, differences: ['red dress'] }] }, modelId: 'reasoner', res: {}, latencyMs: 1 });
    const v = await checkLikeness(job, { storagePath: 'users/u/new.png', mimeType: 'image/png' }, { subjects, references: [{ assetId: 'ref-ama', storagePath: 'users/u/ref-ama.png', mimeType: 'image/png' }] });
    const parts = callReasoning.mock.calls[0]![0] as { fileData?: { fileUri: string }; text?: string }[];
    expect(parts.map((p) => p.fileData?.fileUri ?? 'text')).toEqual([expect.stringContaining('new.png'), expect.stringContaining('ref-ama.png'), 'text']);
    expect(v).toMatchObject({ verdict: 'fail', outfitMatch: false, modelId: 'reasoner' });
  });

  it('records an unavailable check as unchecked, never as a pass', async () => {
    callReasoning.mockRejectedValueOnce(new Error('503'));
    const v = await checkLikeness(job, { storagePath: 'x', mimeType: 'image/png' }, { subjects, references: [] });
    expect(v.verdict).toBe('unchecked');
  });
});

describe('wiring', () => {
  it('the advert reviewer can report a take that does not fill the frame', () => {
    expect(normalizeAdReview({ matchesBrief: 70, summary: '', issues: [{ type: 'not_full_frame', severity: 'major', note: 'inset' }] }).issues[0]!.type).toBe('not_full_frame');
  });

  it('final inspection transcribes with the project’s own protected words', () => {
    expect(projectTerms({ ad: { audio: { protectedTerms: ['Obaapaz Honey'] } }, lite: { pronunciation: [{ term: 'Nana' }], bible: { characters: [{ name: 'Ama' }], locations: [{ name: 'Tamale' }] } } })).toEqual(['Obaapaz Honey', 'Nana', 'Ama', 'Tamale']);
    expect(projectTerms(null)).toEqual([]);
  });

  it('Link to Ad times its voice with the business and product names among its facts', () => {
    const doc = { source: { facts: [{ id: 'a', kind: 'business_name', text: 'Obaapaz', value: null }, { id: 'b', kind: 'description', text: 'Honey from the north', value: null }, { id: 'c', kind: 'product_name', text: 'The jar is called Golden Drop and it is sold everywhere', value: 'Golden Drop' }] }, userFacts: [] } as never;
    expect(nameTerms(doc)).toEqual(['Obaapaz', 'Golden Drop']);
  });
});
