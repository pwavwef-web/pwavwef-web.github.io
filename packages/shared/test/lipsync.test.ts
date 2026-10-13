import { describe, expect, it } from 'vitest';
import { decideLipSync, lipSyncEstimateUsd, voicedSeconds } from '../src/lipsync';

const base = { characterCount: 1, voicedSec: 6, durationSec: 7, voiceBelongsOnScreen: true };

describe('decideLipSync', () => {
  it('syncs a close-up of the singer performing a sung line', () => {
    const d = decideLipSync({ ...base, framing: 'Close-up, eye level', performance: 'The singer looks straight into the camera, singing the lyric' });
    expect(d.apply).toBe(true);
  });

  it('skips wide, atmosphere and insert shots', () => {
    expect(decideLipSync({ ...base, framing: 'Wide shot, low angle', performance: 'The singer sings to the sea' }).apply).toBe(false);
    expect(decideLipSync({ ...base, characterCount: 0, framing: 'Medium shot', performance: 'None; atmosphere' }).apply).toBe(false);
    expect(decideLipSync({ ...base, framing: 'Extreme close-up', performance: 'Hands fold a page', action: 'A hand folds a lyric sheet' }).apply).toBe(false);
  });

  it('skips shots where the voice barely plays', () => {
    expect(decideLipSync({ ...base, voicedSec: 0.6, framing: 'Close-up', performance: 'singing to camera' }).apply).toBe(false);
    expect(decideLipSync({ ...base, voicedSec: 1.5, durationSec: 8, framing: 'Close-up', performance: 'singing to camera' }).apply).toBe(false);
  });

  it('skips when the recording is not a voice that belongs on screen (voice-over, instrumental)', () => {
    expect(decideLipSync({ ...base, voiceBelongsOnScreen: false, framing: 'Close-up', performance: 'singing to camera' }).apply).toBe(false);
  });

  it('syncs an advert presenter speaking to camera', () => {
    expect(decideLipSync({ ...base, framing: 'Medium close-up', performance: 'The host talks to camera and smiles' }).apply).toBe(true);
  });
});

describe('voicedSeconds', () => {
  it('counts only the part of each span inside the window, merging near neighbours', () => {
    expect(voicedSeconds([{ start: 0, end: 1 }, { start: 1.2, end: 2 }, { start: 5, end: 9 }], 0.5, 6)).toBeCloseTo(2.5, 5);
  });
  it('is zero for silence', () => {
    expect(voicedSeconds([{ start: 10, end: 12 }], 0, 5)).toBe(0);
  });
});

describe('lipSyncEstimateUsd', () => {
  it('prices the pro tier above the standard tier', () => {
    expect(lipSyncEstimateUsd(10, 'pro')).toBeGreaterThan(lipSyncEstimateUsd(10, 'standard'));
  });
});
