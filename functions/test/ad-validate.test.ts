import { describe, expect, it } from 'vitest';
import { evaluateAdScene, reconcileTextIssues, summarizeTextEvidence, validationSummary, type AdTextEvidence } from '@az-studio/shared';
import { normalizeAdReview } from '../src/workers/ad-validate';

const measurements = { durationSec: 9, width: 1080, height: 1920, fps: 24, decodeErrors: 0, blackSec: 0 };
const verdictFor = (raw: unknown, evidence: AdTextEvidence | null = null) =>
  evaluateAdScene({ kind: 'generated_video', windowSec: 8.35, neededSec: 8.35, expectedAspect: '9:16', outputHeight: 1920, measurements, probeOk: true, review: reconcileTextIssues(normalizeAdReview(raw), evidence), modelId: 'reviewer' });

describe('scene review: text findings are checked against text recognition on the frames', () => {
  const blank = (n: number) => Array.from({ length: n }, () => ({ text: [], logos: [] }));

  it('summarises recognised words and logos per frame', () => {
    const ev = summarizeTextEvidence([
      { text: [{ text: 'HONDA', box: { h: 0.021 } }, { text: '·', box: null }], logos: [{ name: 'Honda', score: 0.91 }] },
      { text: [{ text: 'Honda', box: { h: 0.018 } }], logos: [{ name: 'Honda', score: 0.88 }] },
      ...blank(6),
    ]);
    expect(ev.frames).toBe(8);
    expect(ev.words).toEqual([{ text: 'HONDA', frames: 2, heightPct: 2.1 }]);
    expect(ev.logos).toEqual([{ name: 'Honda', score: 0.91, frames: 2 }]);
  });

  it('fails a take whose frames show a recognised brand, whatever severity the reviewer gave it', () => {
    const ev: AdTextEvidence = { frames: 10, words: [{ text: 'HONDA', frames: 4, heightPct: 2.1 }], logos: [{ name: 'Honda', score: 0.92, frames: 3 }] };
    const v = verdictFor({ matchesBrief: 72, summary: 'A man beside a motorbike.', issues: [{ type: 'text_in_frame', severity: 'minor', note: 'Brand text on the motorcycle.' }] }, ev);
    expect(v.verdict).toBe('fail');
    expect(v.checks.find((c) => c.id === 'text_in_frame')!.detail).toMatch(/Honda/);
  });

  it('does not fail a take for subtitles the frames do not show (a reviewer inferring captions from speech)', () => {
    const ev: AdTextEvidence = { frames: 10, words: [], logos: [] };
    const v = verdictFor({ matchesBrief: 68, summary: 'A young man talks on his phone under a tree.', issues: [{ type: 'text_in_frame', severity: 'major', note: 'Subtitles appear on the screen during the video.' }] }, ev);
    expect(v.verdict).toBe('pass');
    expect(v.review!.issues[0]).toMatchObject({ severity: 'minor' });
    expect(v.review!.issues[0]!.note).toMatch(/not confirmed/);
  });

  it('keeps the reviewer’s judgement when recognition is unavailable, and ignores stray single letters', () => {
    expect(verdictFor({ matchesBrief: 70, summary: 's', issues: [{ type: 'text_in_frame', severity: 'major', note: 'Sign with words' }] }, null).verdict).toBe('fail');
    const stray: AdTextEvidence = { frames: 10, words: [{ text: 'I', frames: 3, heightPct: 1 }, { text: 'KO', frames: 1, heightPct: 1.2 }], logos: [{ name: 'Unclear', score: 0.2, frames: 1 }] };
    expect(verdictFor({ matchesBrief: 70, summary: 's', issues: [] }, stray).verdict).toBe('pass');
  });
});

describe('scene review: other brands never pass', () => {
  it('fails a take with a recognisable brand emblem even when the reviewer called it minor', () => {
    // The findings the reviewer returned for a generated motorbike with a readable manufacturer name on its tank.
    const v = verdictFor({
      matchesBrief: 72,
      summary: 'A young man stands beside his motorbike while speaking on his phone.',
      issues: [
        { type: 'text_in_frame', severity: 'minor', note: 'Clear brand text visible on the motorcycle body and parts.' },
        { type: 'logo', severity: 'minor', note: 'Motorcycle brand emblem visible on the fuel tank.' },
      ],
    });
    expect(v.verdict).toBe('fail');
    expect(v.checks.find((c) => c.id === 'text_in_frame')).toMatchObject({ ok: false, severity: 'error' });
  });

  it('treats a watermark as major and keeps blurred, unreadable text minor', () => {
    expect(normalizeAdReview({ issues: [{ type: 'watermark', severity: 'minor', note: 'Corner watermark' }] }).issues[0]!.severity).toBe('major');
    const v = verdictFor({ matchesBrief: 80, summary: 'Market scene', issues: [{ type: 'text_in_frame', severity: 'minor', note: 'Blurred, unreadable lettering on a distant stall.' }] });
    expect(v.verdict).toBe('pass');
    expect(v.checks.find((c) => c.id === 'text_in_frame')).toMatchObject({ ok: true });
  });
});

describe('the scene shows the validation of the take it uses', () => {
  it('summarises a take’s validation for the scene, or nothing when the take was never checked', () => {
    const v = verdictFor({ matchesBrief: 72, summary: 's', issues: [{ type: 'logo', severity: 'minor', note: 'Emblem on the tank' }] });
    expect(validationSummary('take-2', v)).toEqual({ takeId: 'take-2', verdict: 'fail', checkedAt: v.checkedAt, failed: ['No generated text or logos'] });
    expect(validationSummary('take-3', null)).toBeNull();
  });
});
