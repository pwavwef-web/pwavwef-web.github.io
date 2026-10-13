import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LiteScene, LiteSpec } from '@az-studio/shared';
import type { LiteTiming } from '@az-studio/shared';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const SR = 48000;

type Cue = NonNullable<LiteScene['soundCue']>;

/** Seeded generator so a rerun produces the same sound. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stereo float buffer. */
class Buf {
  l: Float32Array;
  r: Float32Array;
  constructor(public sec: number) {
    this.l = new Float32Array(Math.ceil(sec * SR));
    this.r = new Float32Array(Math.ceil(sec * SR));
  }
  add(at: number, mono: Float32Array, gain = 1, pan = 0, delayR = 0.0004) {
    const i0 = Math.round(at * SR);
    const dr = Math.round(delayR * SR);
    const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < mono.length; i++) {
      const k = i0 + i;
      if (k >= 0 && k < this.l.length) this.l[k]! += mono[i]! * gl;
      if (k + dr >= 0 && k + dr < this.r.length) this.r[k + dr]! += mono[i]! * gr;
    }
  }
}

function lowpass(x: Float32Array, hz: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / SR);
  let y = 0;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = y += a * (x[i]! - y);
  return out;
}

function highpass(x: Float32Array, hz: number): Float32Array {
  const lp = lowpass(x, hz);
  return x.map((v, i) => v - lp[i]!);
}

function bandpass(x: Float32Array, hz: number, q: number): Float32Array {
  const w = (2 * Math.PI * hz) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const b0 = alpha, b2 = -alpha, a0 = 1 + alpha, a1 = -2 * Math.cos(w), a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i]! + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]!; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

/** A struck wooden mortar: low body tone, a short upper partial and a soft contact click. */
function thud(rand: () => number, f0 = 105, decay = 0.13, brightness = 1): Float32Array {
  const n = Math.round(0.6 * SR);
  const out = new Float32Array(n);
  const clickN = Math.round(0.006 * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = Math.sin(2 * Math.PI * f0 * t * (1 + 0.25 * Math.exp(-t * 40))) * Math.exp(-t / decay);
    v += 0.45 * Math.sin(2 * Math.PI * f0 * 2.37 * t) * Math.exp(-t / (decay * 0.45));
    v += 0.2 * Math.sin(2 * Math.PI * f0 * 4.1 * t) * Math.exp(-t / (decay * 0.25));
    if (i < clickN) v += (rand() * 2 - 1) * 0.5 * brightness * (1 - i / clickN);
    out[i] = v;
  }
  return out;
}

function noiseBurst(rand: () => number, sec: number, shape: (t: number) => number): Float32Array {
  const n = Math.round(sec * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rand() * 2 - 1) * shape(i / SR);
  return out;
}

/** Puts a sound further away: duller, quieter, with a faint echo off a wall. */
function distant(x: Float32Array, hz = 700): Float32Array {
  const lp = lowpass(x, hz);
  const echo = Math.round(0.19 * SR);
  const out = new Float32Array(lp.length + echo);
  lp.forEach((v, i) => {
    out[i] += v;
    out[i + echo] += v * 0.28;
  });
  return out;
}

function pounding(buf: Buf, rand: () => number, from: number, to: number, period: number, amp: number, opts: { far?: boolean; grain?: boolean; jitter?: number } = {}) {
  for (let t = from; t < to; t += period * (1 + (rand() - 0.5) * 0.04)) {
    const at = t + (rand() - 0.5) * (opts.jitter ?? 0.03);
    const a = amp * (0.82 + rand() * 0.36);
    let s = thud(rand, 100 + rand() * 14, 0.11 + rand() * 0.04);
    if (opts.far) s = distant(s, 520);
    buf.add(at, s, a, opts.far ? -0.5 + rand() * 0.2 : -0.1);
    if (opts.grain && !opts.far) {
      // pounded grain settling after the strike
      const g = highpass(lowpass(noiseBurst(rand, 0.35, (x) => Math.exp(-x * 9) * (x > 0.04 ? 1 : x / 0.04)), 5200), 900);
      buf.add(at + 0.02, g, a * 0.09, 0.1);
    }
  }
}

function cloth(buf: Buf, rand: () => number, at: number, sec: number, amp: number) {
  const base = bandpass(noiseBurst(rand, sec, () => 1), 1700, 0.7);
  const env = new Float32Array(base.length);
  let slow = 0;
  for (let i = 0; i < env.length; i++) {
    const t = i / SR;
    slow += (rand() - 0.5) * 0.002;
    const gust = 0.5 + 0.5 * Math.sin(2 * Math.PI * (0.7 + 0.2 * rand() * 0) * t + slow * 40);
    const fade = Math.min(1, t / 0.5, (sec - t) / 0.7);
    env[i] = Math.max(0, gust) ** 2 * fade * (0.5 + 0.5 * Math.sin(2 * Math.PI * 5.3 * t) ** 2);
  }
  buf.add(at, base.map((v, i) => v * env[i]!), amp, 0.3);
}

/** The sky withdrawing: a sub swell, a bright resonant sweep rising away, and a long shimmer of detuned partials. */
function skyLeaves(buf: Buf, rand: () => number, at: number, sec: number) {
  const n = Math.round(sec * SR);
  const sub = new Float32Array(n);
  const sweep = new Float32Array(n);
  const shimmer = new Float32Array(n);
  const noise = noiseBurst(rand, sec, () => 1);
  let ph = 0;
  let ps = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const u = t / sec;
    const swell = Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 1.5 * Math.min(1, t / 1.2);
    ph += (2 * Math.PI * (38 + 34 * u)) / SR;
    sub[i] = Math.sin(ph) * swell * 0.7 * (1 - 0.5 * u);
    ps += (2 * Math.PI * (200 * Math.pow(18, u))) / SR; // rising as it recedes
    const env = Math.sin(Math.PI * Math.min(1, u)) ** 1.2 * Math.min(1, t / 0.8);
    sweep[i] = Math.sin(ps) * env * 0.12 * (1 - u * 0.4);
    let sh = 0;
    for (let k = 2; k <= 7; k++) sh += Math.sin(2 * Math.PI * 220 * k * (1 + 0.0035 * Math.sin(t * 0.6 + k)) * t + k) / k;
    shimmer[i] = sh * 0.07 * Math.min(1, t / 3) * Math.min(1, (sec - t) / 4) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.23 * t));
  }
  // airy band that climbs in pitch as the sky climbs
  const air = new Float32Array(n);
  const chunk = Math.round(0.25 * SR);
  for (let s = 0; s < n; s += chunk) {
    const u = s / n;
    const seg = bandpass(noise.subarray(s, Math.min(n, s + chunk + 2048)), 400 * Math.pow(10, u * 1.0), 1.4);
    for (let i = 0; i < Math.min(chunk, n - s); i++) air[s + i] = seg[i]! * Math.sin(Math.PI * Math.min(1, u)) * 0.5;
  }
  buf.add(at, sub, 0.9, 0);
  buf.add(at, sweep, 1, -0.2, 0.0009);
  buf.add(at, shimmer, 1, 0.2, 0.0012);
  buf.add(at, air, 0.55, -0.3, 0.0011);
  // the first crack as it lets go
  buf.add(at, lowpass(noiseBurst(rand, 0.9, (x) => Math.exp(-x * 5)), 260), 0.5, 0);
}

function thread(buf: Buf, at: number, sec: number, hz: number, amp: number) {
  const n = Math.round(sec * SR);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 1.5) * Math.min(1, (sec - t) / 2.5);
    s[i] = (Math.sin(2 * Math.PI * hz * t) + 0.5 * Math.sin(2 * Math.PI * hz * 1.503 * t + 1)) * env * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.4 * t)) * amp;
  }
  buf.add(at, s, 1, 0.1, 0.001);
}

async function encode(buf: Buf, name: string): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sky-sfx-'));
  const n = buf.l.length;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf.l[i]!), Math.abs(buf.r[i]!));
  const norm = peak > 0.85 ? 0.85 / peak : 1;
  const pcm = Buffer.alloc(44 + n * 4);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 4, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(2, 22); pcm.writeUInt32LE(SR, 24); pcm.writeUInt32LE(SR * 4, 28); pcm.writeUInt16LE(4, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf.l[i]! * norm)) * 32767), 44 + i * 4);
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf.r[i]! * norm)) * 32767), 46 + i * 4);
  }
  const wav = path.join(dir, `${name}.wav`);
  const m4a = path.join(dir, `${name}.m4a`);
  writeFileSync(wav, pcm);
  await execFileAsync(require('ffmpeg-static') as string, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-af', 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo', '-c:a', 'aac', '-b:a', '192k', m4a]);
  return m4a;
}

/**
 * Sound cues fitted to the measured scenes (all synthesised locally — no generation cost):
 * distant pounding and cloth, the close pounding motif, the sky's thin voice, accelerating strikes with a
 * hard cut-off, and the withdrawing sky. One cue per scene (the studio's model); each file spans the scene.
 */
export async function synthesiseCues(
  spec: LiteSpec,
  timing: LiteTiming,
  _uid: string,
  _projectId: string,
  upload: (file: string, title: string, fileName: string) => Promise<string>,
  assetExists: (id: string) => Promise<boolean>,
): Promise<Record<string, Cue>> {
  const out: Record<string, Cue> = {};
  for (const st of timing.scenes) {
    const scene = spec.scenes[st.index]!;
    const D = st.duration;
    const voiceAt = (st.voiceAt ?? st.start) - st.start;
    const speechEnd = voiceAt + st.speechSec;
    const rand = rng(1000 + st.index * 17);
    const buf = new Buf(D);
    let label = '';
    let levelDb = 0;
    switch (scene.id) {
      case 'sc_near': {
        pounding(buf, rand, 1.0, D - 0.5, 1.45, 0.22, { far: true });
        const n2 = st.shots[1]!.start - st.start;
        cloth(buf, rand, n2 + 0.3, Math.min(6, st.shots[1]!.duration - 0.6), 0.5);
        label = 'Distant pounding and cloth';
        levelDb = -2;
        break;
      }
      case 'sc_work':
        pounding(buf, rand, 0.4, D - 0.3, 1.12, 0.5, { grain: true });
        label = 'Pestle and mortar';
        break;
      case 'sc_warning':
        thread(buf, 0.3, Math.min(D - 0.5, speechEnd - 1), 1760, 0.05);
        pounding(buf, rand, Math.max(voiceAt, speechEnd - 2.6), D - 0.2, 1.2, 0.42, { grain: true });
        label = 'Thin sky shimmer, pounding resumes';
        break;
      case 'sc_blow': {
        const strike = Math.min(D - 1.2, speechEnd + 0.12);
        let t = 0.2;
        let period = 1.1;
        let a = 0.3;
        while (t < strike - 0.1) {
          buf.add(t + (rand() - 0.5) * 0.015, thud(rand, 100 + rand() * 12, 0.12), a, -0.1);
          t += period;
          period = Math.max(0.3, period * 0.86);
          a = Math.min(0.85, a + 0.05);
        }
        const big = thud(rand, 70, 0.55);
        buf.add(strike, big, 1.0, 0);
        const boom = new Float32Array(Math.round(1.4 * SR)).map((_, i) => Math.sin(2 * Math.PI * 42 * (i / SR)) * Math.exp(-i / SR / 0.45));
        buf.add(strike, boom, 0.9, 0);
        buf.add(strike, highpass(noiseBurst(rand, 0.25, (x) => Math.exp(-x * 22)), 1500), 0.6, 0);
        label = 'Accelerating strikes and the final blow';
        levelDb = 2;
        break;
      }
      case 'sc_retreat':
        skyLeaves(buf, rand, 0.0, D);
        label = 'The sky withdraws';
        levelDb = -2;
        break;
      case 'sc_reply':
        thread(buf, Math.max(0, voiceAt + st.speechSec * 0.62), Math.max(3, D - (voiceAt + st.speechSec * 0.62) - 0.2), 2093, 0.06);
        label = 'A thin thread of light';
        break;
      default:
        continue;
    }
    const tag = `${label} [${D.toFixed(1)}s]`;
    const existing = scene.soundCue;
    if (existing?.assetId && existing.label === tag && (await assetExists(existing.assetId))) {
      out[scene.id] = existing;
      continue;
    }
    const file = await encode(buf, scene.id);
    const assetId = await upload(file, `${tag} (synthesised)`, `${scene.id}-cue.m4a`);
    out[scene.id] = { label: tag, assetId, atSec: 0, levelDb };
  }
  return out;
}
