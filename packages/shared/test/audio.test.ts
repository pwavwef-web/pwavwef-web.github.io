import { describe, expect, it } from 'vitest';
import { analyzeAudio, computePeaks, decimate, estimateTempo, FFT, planShotSlots, snapToBeat, spectralFeatures } from '../src/audio';

const SR = 22050;

/** Click track: short decaying noise bursts at the given tempo, accented every `accentEvery` beats. */
function clickTrack(bpm: number, seconds: number, accentEvery = 4): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  const period = 60 / bpm;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let b = 0; b * period < seconds; b++) {
    const start = Math.floor(b * period * SR);
    const amp = b % accentEvery === 0 ? 1 : 0.55;
    for (let i = 0; i < 0.03 * SR && start + i < out.length; i++) out[start + i] = amp * rnd() * Math.exp(-i / (0.006 * SR));
  }
  return out;
}

describe('FFT', () => {
  it('finds a pure tone in the right bin', () => {
    const n = 1024;
    const fft = new FFT(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 64 * i) / n);
    fft.transform(re, im);
    let best = 0;
    for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k]!, im[k]!) > Math.hypot(re[best]!, im[best]!)) best = k;
    expect(best).toBe(64);
  });

  it('rejects non power-of-two sizes', () => {
    expect(() => new FFT(1000)).toThrow();
  });
});

describe('signal helpers', () => {
  it('computes waveform peaks', () => {
    const x = new Float32Array([0, 0.5, -1, 0.25, 0.8, -0.2]);
    const p = computePeaks(x, 2);
    expect(p.max).toEqual([0.5, 0.8]);
    expect(p.min).toEqual([-1, -0.2]);
  });

  it('decimates by averaging', () => {
    expect(Array.from(decimate(new Float32Array([1, 3, 5, 7]), 2))).toEqual([2, 6]);
  });
});

describe('tempo and beats', () => {
  it.each([90, 120, 140])('estimates %i BPM from a click track', (bpm) => {
    const x = clickTrack(bpm, 30);
    const f = spectralFeatures(x, SR);
    const { bpm: est } = estimateTempo(f.onset, f.hopSec);
    // Accept octave-equivalent answers only at the true tempo.
    expect(Math.abs(est - bpm)).toBeLessThan(3);
  });

  it('tracks beats at the right spacing and finds downbeats', () => {
    const r = analyzeAudio(clickTrack(120, 32), SR);
    expect(Math.abs(r.bpm - 120)).toBeLessThan(3);
    const gaps = r.beats.slice(1).map((b, i) => b - r.beats[i]!);
    const median = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
    expect(median).toBeCloseTo(0.5, 1);
    expect(r.beats.length).toBeGreaterThan(55);
    // Downbeats are every fourth beat (the accented clicks at 0, 2, 4 … seconds).
    const dGaps = r.downbeats.slice(1).map((b, i) => b - r.downbeats[i]!);
    expect(dGaps.every((g) => Math.abs(g - 2) < 0.15)).toBe(true);
    expect(r.downbeats[0]! % 2).toBeLessThan(0.15);
  });

  it('snaps to the nearest beat', () => {
    expect(snapToBeat(1.26, [0, 0.5, 1, 1.5])).toBe(1.5);
    expect(snapToBeat(1.24, [0, 0.5, 1, 1.5])).toBe(1);
    expect(snapToBeat(3, [])).toBe(3);
  });
});

describe('structure', () => {
  it('finds a boundary where the texture changes', () => {
    const seconds = 64;
    const x = clickTrack(120, seconds);
    // Second half: add a loud high-frequency tone bed (a "chorus" with a different timbre and energy).
    for (let i = Math.floor(32 * SR); i < x.length; i++) x[i] = x[i]! * 0.6 + 0.5 * Math.sin((2 * Math.PI * 3000 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR);
    const r = analyzeAudio(x, SR);
    const inner = r.sections.slice(1).map((s) => s.start);
    expect(inner.some((t) => Math.abs(t - 32) < 2.5)).toBe(true);
    expect(r.sections[0]!.start).toBe(0);
    expect(r.sections[r.sections.length - 1]!.end).toBeCloseTo(seconds, 1);
    expect(r.energy.length).toBeGreaterThan(100);
  });
});

describe('shot slots', () => {
  it('splits sections into 3–8 second slots on bar lines', () => {
    const downbeats = Array.from({ length: 20 }, (_, i) => i * 2);
    const slots = planShotSlots({ start: 0, end: 30 }, downbeats, 3, 8);
    expect(slots[0]!.start).toBe(0);
    expect(slots[slots.length - 1]!.end).toBe(30);
    for (const s of slots) {
      expect(s.end - s.start).toBeGreaterThanOrEqual(3 - 1e-6);
      expect(s.end - s.start).toBeLessThanOrEqual(8 + 1e-6);
    }
    for (let i = 1; i < slots.length; i++) expect(slots[i]!.start).toBeCloseTo(slots[i - 1]!.end);
  });

  it('handles long spans without bar lines', () => {
    const slots = planShotSlots({ start: 10, end: 34 }, [], 3, 8);
    expect(slots).toHaveLength(3);
    expect(slots.every((s) => Math.abs(s.end - s.start - 8) < 1e-6)).toBe(true);
  });
});
