import { describe, expect, it } from 'vitest';
import {
  MOTION_PRESETS,
  assembleLiteTimeline,
  buildLiteCues,
  buildLiteScore,
  clipMotionProgress,
  compileLiteImageRequest,
  compileNarrationRequest,
  computeLiteTiming,
  cuesFromWords,
  defaultLiteSpec,
  duckGainAt,
  fillSpan,
  fontSupports,
  formatVtt,
  liteExportChecks,
  motionInBounds,
  motionRectAt,
  newScene,
  newShot,
  normalizeLiteSpec,
  pickTake,
  reconcileTiming,
  resolveShotMotion,
  scenesFromScript,
  spokenText,
  splitScene,
  timingBaseline,
  validateTimeline,
  type LiteNarrationTake,
  type LiteSpec,
  type ShotMotion,
} from '../src/index';

const IMG = { w: 2752, h: 1536 };

function words(text: string, start: number, wps = 2.4): LiteNarrationTake['words'] {
  return text.split(/\s+/).map((t, i) => ({ text: t, start: start + i / wps, end: start + (i + 0.8) / wps, confidence: 0.9, sentenceEnd: /[.!?]$/.test(t) }));
}

function take(sceneId: string, text: string, speechSec: number, over: Partial<LiteNarrationTake> = {}): LiteNarrationTake {
  const ws = words(text, 0.3, text.split(/\s+/).length / speechSec);
  return { jobId: `job_${sceneId}`, sceneId, hash: 'h', assetId: `voice_${sceneId}`, inPoint: 0, outPoint: speechSec + 0.8, speechStart: 0.3, speechEnd: 0.3 + speechSec, words: ws, alignment: 'aligned', coverage: 1, flags: [], source: 'generated', voice: 'Sulafat', createdAt: 1, ...over };
}

function film(): LiteSpec {
  const spec = defaultLiteSpec({ direction: 'documentary', targetSec: 120, aspect: '16:9' });
  spec.scenes = [
    newScene({ id: 'a', title: 'Dawn', narration: 'The river wakes before the town does. Mist hangs over the water.', shots: [newShot({ id: 'a1', durationSec: 8 }), newShot({ id: 'a2', durationSec: 6, motion: { preset: 'still', intensity: 0.05, focal: { x: 0.5, y: 0.5 }, ease: 'gentle' } })] }),
    newScene({ id: 'b', title: 'Market', narration: 'By seven, the market is loud with voices and colour.', pauseBeforeSec: 2, pauseBlack: true, shots: [newShot({ id: 'b1', durationSec: 10, motion: { preset: 'pan_right', intensity: 0.06, focal: { x: 0.4, y: 0.5 }, ease: 'gentle' } })] }),
    newScene({ id: 'c', title: 'Dusk', narration: 'And at dusk, the river keeps its secrets.', transitionIn: 'dissolve', shots: [newShot({ id: 'c1', durationSec: 9, motion: { preset: 'pull_out', intensity: 0.06, focal: { x: 0.6, y: 0.4 }, ease: 'gentle' } })] }),
  ];
  for (const s of spec.scenes) for (const sh of s.shots) sh.image.approvedAssetId = `img_${sh.id}`;
  return spec;
}

const ASSETS = Object.fromEntries(['a1', 'a2', 'b1', 'c1'].map((id) => [`img_${id}`, { width: IMG.w, height: IMG.h, durationSec: null }]));
function assets(takes: Record<string, LiteNarrationTake>) {
  return { ...ASSETS, ...Object.fromEntries(Object.values(takes).map((t) => [t.assetId, { width: null, height: null, durationSec: t.outPoint }])) };
}

describe('motion', () => {
  it('never exposes an image edge for any preset, format or focal point', () => {
    for (const aspect of ['16:9', '9:16', '1:1']) {
      for (const src of [IMG, { w: 1536, h: 2752 }, { w: 2048, h: 2048 }]) {
        for (const preset of MOTION_PRESETS) {
          for (const focal of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 0.5 }, { x: 0.05, y: 0.9 }]) {
            for (const intensity of [0, 0.05, 0.25]) {
              const m: ShotMotion = { preset, intensity, focal, ease: 'gentle' };
              const r = resolveShotMotion(m, src, { aspect, durationSec: 12, outWidth: 1920 });
              expect(motionInBounds(r.motion, 240)).toBe(true);
              // Every sampled frame keeps the output aspect ratio (never stretched).
              const rect = motionRectAt(r.motion, 0.37);
              const ratio = (rect.w * src.w) / (rect.h * src.h);
              const target = aspect === '16:9' ? 16 / 9 : aspect === '9:16' ? 9 / 16 : 1;
              expect(Math.abs(ratio - target) / target).toBeLessThan(0.002);
            }
          }
        }
      }
    }
  });

  it('moves slowly and smoothly: a 6 % push over 12 s changes the frame by under 0.1 % per frame, and starts gently', () => {
    const r = resolveShotMotion({ preset: 'push_in', intensity: 0.06, focal: { x: 0.5, y: 0.45 }, ease: 'gentle' }, IMG, { aspect: '16:9', durationSec: 12, outWidth: 1920 });
    const frames = 12 * 24;
    let maxStep = 0;
    for (let i = 1; i <= frames; i++) maxStep = Math.max(maxStep, Math.abs(motionRectAt(r.motion, i / frames).w - motionRectAt(r.motion, (i - 1) / frames).w) / r.motion.from.w);
    expect(maxStep).toBeLessThan(0.001);
    const first = Math.abs(motionRectAt(r.motion, 1 / frames).w - r.motion.from.w);
    const mid = Math.abs(motionRectAt(r.motion, 0.5 + 1 / frames).w - motionRectAt(r.motion, 0.5).w);
    expect(first).toBeLessThan(mid);
    expect(r.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('warns about excessive crops instead of stretching, and flags blur', () => {
    const portraitFromLandscape = resolveShotMotion({ preset: 'push_in', intensity: 0.2, focal: { x: 0.5, y: 0.5 }, ease: 'gentle' }, { w: 1376, h: 768 }, { aspect: '9:16', durationSec: 10, outWidth: 1080 });
    expect(portraitFromLandscape.scale).toBeGreaterThan(1.5);
    expect(portraitFromLandscape.issues.some((i) => i.kind === 'blurry' && i.severity === 'error')).toBe(true);
  });

  it('a still hold does not move', () => {
    const r = resolveShotMotion({ preset: 'still', intensity: 0.05, focal: { x: 0.3, y: 0.4 }, ease: 'gentle' }, IMG, { aspect: '16:9', durationSec: 10 });
    expect(r.motion.from).toEqual(r.motion.to);
  });

  it('adapts focal framing per format: the focal point stays inside the frame in 16:9 and 9:16', () => {
    const m: ShotMotion = { preset: 'push_in', intensity: 0.05, focal: { x: 0.78, y: 0.4 }, ease: 'gentle' };
    for (const aspect of ['16:9', '9:16']) {
      const r = resolveShotMotion(m, IMG, { aspect, durationSec: 10 });
      for (const p of [0, 0.5, 1]) {
        const rect = motionRectAt(r.motion, p);
        expect(0.78).toBeGreaterThan(rect.x);
        expect(0.78).toBeLessThan(rect.x + rect.w);
      }
    }
  });
});

describe('timing and reconciliation', () => {
  it('estimates before audio, then follows measured narration without truncating it', () => {
    const spec = film();
    const est = computeLiteTiming(spec, {});
    expect(est.estimated).toBe(true);
    const takes = { a: take('a', spec.scenes[0]!.narration, 20), b: take('b', spec.scenes[1]!.narration, 4), c: take('c', spec.scenes[2]!.narration, 3) };
    const t = computeLiteTiming(spec, takes);
    expect(t.estimated).toBe(false);
    const a = t.scenes[0]!;
    // 20 s of speech + lead-in + tail > 14 s of planned shots: shots lengthen proportionally.
    // The first line waits for the opening fade-in to establish the sound bed.
    const firstLead = Math.max(spec.scenes[0]!.leadInSec, spec.sound.fadeInSec + 1.2);
    expect(a.duration).toBeCloseTo(20 + firstLead + spec.scenes[0]!.tailSec, 1);
    expect(a.voiceAt! - a.start).toBeCloseTo(firstLead, 1);
    expect(a.shots[0]!.duration / a.shots[1]!.duration).toBeCloseTo(8 / 6, 1);
    // Deliberate black before scene b.
    expect(t.scenes[1]!.blackSec).toBe(2);
    expect(t.scenes[1]!.start - t.scenes[1]!.blackStart).toBeCloseTo(2, 2);
    // The closing hold follows the last scene.
    expect(t.totalSec - t.storyEnd).toBeCloseTo(spec.sound.endHoldSec, 2);
  });

  it('keeps locked shot lengths and reports an overrun', () => {
    const spec = film();
    spec.scenes[0]!.shots.forEach((s) => (s.lockDuration = true));
    const t = computeLiteTiming(spec, { a: take('a', spec.scenes[0]!.narration, 20) });
    expect(t.scenes[0]!.shots[0]!.duration).toBeCloseTo(8, 2);
    expect(t.scenes[0]!.overrunSec).toBeGreaterThan(5);
  });

  it('replacing one narration segment only moves that scene and the ones after it', () => {
    const spec = film();
    const takes: Record<string, LiteNarrationTake> = { a: take('a', spec.scenes[0]!.narration, 6), b: take('b', spec.scenes[1]!.narration, 5), c: take('c', spec.scenes[2]!.narration, 3) };
    const before = computeLiteTiming(spec, takes);
    spec.timing = { ...timingBaseline(before), acknowledgedAt: 1 };
    const after = computeLiteTiming(spec, { ...takes, b: take('b', spec.scenes[1]!.narration, 9, { jobId: 'job_b2', assetId: 'voice_b2' }) });
    const { changes } = reconcileTiming(spec, after);
    expect(changes.map((c) => c.sceneId)).toEqual(['b', 'c']);
    expect(after.scenes[0]).toEqual(before.scenes[0]);
    // Subtitles of scene b follow its new take; scene a's cues are unchanged.
    const cuesBefore = buildLiteCues(spec.scenes, before, takes, spec.subtitles, '16:9');
    const cuesAfter = buildLiteCues(spec.scenes, after, { ...takes, b: take('b', spec.scenes[1]!.narration, 9) }, spec.subtitles, '16:9');
    expect(cuesAfter.filter((c) => c.sceneId === 'a')).toEqual(cuesBefore.filter((c) => c.sceneId === 'a'));
    const shift = after.scenes[2]!.voiceAt! - before.scenes[2]!.voiceAt!;
    expect(shift).toBeGreaterThan(1);
    expect(cuesAfter.filter((c) => c.sceneId === 'c')[0]!.start - cuesBefore.filter((c) => c.sceneId === 'c')[0]!.start).toBeCloseTo(shift, 3);
  });

  it('picks the newest take for the current text and marks older takes stale', () => {
    const t1 = take('a', 'x', 3, { jobId: 'j1', hash: 'old', createdAt: 1 });
    const t2 = take('a', 'x', 3, { jobId: 'j2', hash: 'new', createdAt: 2 });
    expect(pickTake({ id: 'a', voiceJobId: null }, 'new', [t1, t2]).take?.jobId).toBe('j2');
    expect(pickTake({ id: 'a', voiceJobId: null }, 'newer', [t1, t2]).stale).toBe(true);
    expect(pickTake({ id: 'a', voiceJobId: 'j1' }, 'new', [t1, t2])).toEqual({ take: t1, stale: true });
  });
});

describe('subtitles', () => {
  it('builds readable, non-overlapping cues of at most two lines from word timing', () => {
    const text = 'The river wakes before the town does, and the mist hangs low over the water for an hour. Nobody hurries here; the day arrives the way the tide does.';
    const cues = cuesFromWords(words(text, 0, 2.6), { maxChars: 42, maxLines: 2, offset: 10, sceneId: 's', timing: 'aligned' });
    expect(cues.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i]!;
      expect(c.text.split('\n').length).toBeLessThanOrEqual(2);
      for (const line of c.text.split('\n')) expect(line.length).toBeLessThanOrEqual(46);
      expect(c.end - c.start).toBeGreaterThanOrEqual(0.99);
      if (cues[i + 1]) expect(c.end).toBeLessThanOrEqual(cues[i + 1]!.start);
      expect(c.start).toBeGreaterThanOrEqual(10);
    }
    expect(formatVtt(cues)).toMatch(/^WEBVTT/);
  });

  it('labels evenly spread timing as estimated, never as aligned', () => {
    const spec = film();
    const t = computeLiteTiming(spec, { a: take('a', spec.scenes[0]!.narration, 6, { alignment: 'estimated', words: [] }) });
    const cues = buildLiteCues(spec.scenes, t, { a: take('a', spec.scenes[0]!.narration, 6, { alignment: 'estimated', words: [] }) }, spec.subtitles, '16:9');
    expect(cues.filter((c) => c.sceneId === 'a').every((c) => c.timing === 'estimated')).toBe(true);
  });

  it('switches to a font that has Kasem letters', () => {
    expect(fontSupports('Inter', 'Kasena: bɛ kɔ ŋwaŋa')).toBe(false);
    expect(fontSupports('Noto Sans', 'Kasena: bɛ kɔ ŋwaŋa')).toBe(true);
    expect(fontSupports('EB Garamond', 'The river')).toBe(true);
  });
});

describe('assembly', () => {
  const spec = film();
  const takes: Record<string, LiteNarrationTake> = { a: take('a', spec.scenes[0]!.narration, 6), b: take('b', spec.scenes[1]!.narration, 5), c: take('c', spec.scenes[2]!.narration, 3) };
  const timing = computeLiteTiming(spec, takes);
  const score = buildLiteScore(spec, timing, null, 'River');
  score.movements = score.movements.map((m) => ({ ...m, status: 'ready', assetId: `music_${m.id}`, durationSec: 20 }));
  const all = { ...assets(takes), ...Object.fromEntries(score.movements.map((m) => [m.assetId!, { width: null, height: null, durationSec: 20 }])) };
  const assembly = assembleLiteTimeline({ spec, timing, takes, assets: all, aspect: '16:9', outWidth: 1920, score, ambience: { room: { assetId: 'amb_room', durationSec: 30 } } });

  it('produces a valid timeline whose shots follow the timing exactly', () => {
    expect(validateTimeline(assembly.state)).toEqual([]);
    const pic = assembly.state.clips.filter((c) => c.trackId === 'lt_pic' && c.kind === 'image');
    expect(pic.map((c) => c.shotId)).toEqual(['a1', 'a2', 'b1', 'c1']);
    const flat = timing.scenes.flatMap((s) => s.shots);
    pic.forEach((c, i) => expect(c.start).toBeCloseTo(flat[i]!.start, 6));
    expect(pic[pic.length - 1]!.start + pic[pic.length - 1]!.duration).toBeCloseTo(timing.totalSec, 3);
    expect(pic.every((c) => c.motion && motionInBounds(c.motion))).toBe(true);
    // Deliberate black is marked as intentional.
    expect(assembly.state.clips.find((c) => c.id === 'lb_b')?.intentional).toBe('black');
  });

  it('places each narration line where the timing says the first word lands', () => {
    for (const st of timing.scenes) {
      const v = assembly.state.clips.find((c) => c.id === `lv_${st.sceneId}`)!;
      const t = takes[st.sceneId]!;
      expect(v.start + (t.speechStart - v.inPoint)).toBeCloseTo(st.voiceAt!, 3);
      expect(v.inPoint + v.duration).toBeGreaterThanOrEqual(t.speechEnd);
    }
  });

  it('ducks music under narration and lets it breathe between lines', () => {
    const m = assembly.state.clips.find((c) => c.role === 'music')!;
    const gainAt = (t: number) => {
      const pts = m.volumeAutomation!;
      const local = t - m.start;
      let g = pts[0]!.gain;
      for (let i = 1; i < pts.length; i++) if (local >= pts[i - 1]!.t) g = pts[i - 1]!.gain + ((pts[i]!.gain - pts[i - 1]!.gain) * Math.min(1, (local - pts[i - 1]!.t) / Math.max(1e-6, pts[i]!.t - pts[i - 1]!.t)));
      return g;
    };
    const speaking = assembly.speech[0]!;
    const mid = (speaking.start + speaking.end) / 2;
    expect(gainAt(mid)).toBeLessThan(0.5);
    expect(duckGainAt(assembly.speech, mid, spec.sound.duck.depthDb, 0.35, 0.9)).toBeCloseTo(10 ** (-spec.sound.duck.depthDb / 20), 3);
    expect(duckGainAt(assembly.speech, speaking.end + 1.2, spec.sound.duck.depthDb, 0.35, 0.9)).toBe(1);
  });

  it('fills a short music cue by crossfaded reuse instead of stretching it', () => {
    const parts = fillSpan({ start: 0, end: 50 }, 20, { crossfadeSec: 3, loopFrom: 6, fit: 'loop' });
    expect(parts.length).toBeGreaterThan(2);
    expect(parts[parts.length - 1]!.start + parts[parts.length - 1]!.duration).toBeCloseTo(50, 3);
    for (let i = 1; i < parts.length; i++) expect(parts[i]!.start).toBeCloseTo(parts[i - 1]!.start + parts[i - 1]!.duration - 3, 3);
    expect(parts.every((p) => p.inPoint + p.duration <= 20 + 1e-6)).toBe(true);
  });

  it('preview and export share the motion progress of every clip', () => {
    const c = assembly.state.clips.find((x) => x.shotId === 'c1' && x.kind === 'image')!;
    expect(c.transitionIn.type).toBe('dissolve');
    expect(clipMotionProgress(c, c.start - c.transitionIn.duration)).toBe(0);
    expect(clipMotionProgress(c, c.start + c.duration)).toBe(1);
  });

  it('passes the export checks when everything is in place', () => {
    const findings = liteExportChecks({ spec, timing, assembly, staleNarration: [] });
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('reports a missing image with a link to its shot', () => {
    const s2 = normalizeLiteSpec(JSON.parse(JSON.stringify(spec)));
    s2.scenes[1]!.shots[0]!.image.approvedAssetId = null;
    const a2 = assembleLiteTimeline({ spec: s2, timing, takes, assets: all, aspect: '16:9', outWidth: 1920, score, ambience: {} });
    const f = liteExportChecks({ spec: s2, timing, assembly: a2, staleNarration: [] });
    expect(f.find((x) => x.kind === 'missing_image')?.shotId).toBe('b1');
    expect(f.some((x) => x.kind === 'gap' && x.severity === 'error')).toBe(true);
  });
});

describe('edits that must not spend money', () => {
  it('crop, subtitle and level edits leave image and narration request hashes unchanged', () => {
    const spec = film();
    const img = compileLiteImageRequest(spec, spec.scenes[0]!, spec.scenes[0]!.shots[0]!).hash;
    const voice = compileNarrationRequest(spec, spec.scenes[0]!).hash;
    const edited = normalizeLiteSpec(JSON.parse(JSON.stringify(spec)));
    edited.scenes[0]!.shots[0]!.motion = { ...edited.scenes[0]!.shots[0]!.motion, preset: 'pan_left', focal: { x: 0.2, y: 0.3 }, manual: { '16:9': { from: { cx: 0.4, cy: 0.5, zoom: 1.1 }, to: { cx: 0.6, cy: 0.5, zoom: 1.1 } } } };
    edited.scenes[0]!.shots[0]!.durationSec = 13;
    edited.subtitles = { ...edited.subtitles, preset: 'boxed', contrast: 'box', sizePct: 5.5 };
    edited.sound.levels = { voiceDb: 1, musicDb: -24, ambienceDb: -30, effectsDb: -6 };
    expect(compileLiteImageRequest(edited, edited.scenes[0]!, edited.scenes[0]!.shots[0]!).hash).not.toBe('');
    // Composition guidance depends on the movement, so framing presets are part of the brief — but manual crops,
    // durations, subtitle style and levels are not.
    const sameMotion = normalizeLiteSpec(JSON.parse(JSON.stringify(edited)));
    sameMotion.scenes[0]!.shots[0]!.motion = { ...spec.scenes[0]!.shots[0]!.motion, manual: edited.scenes[0]!.shots[0]!.motion.manual };
    expect(compileLiteImageRequest(sameMotion, sameMotion.scenes[0]!, sameMotion.scenes[0]!.shots[0]!).hash).toBe(img);
    expect(compileNarrationRequest(edited, edited.scenes[0]!).hash).toBe(voice);
  });

  it('pronunciation guidance changes only the spoken text, never the subtitles', () => {
    const rules = [{ id: 'p', term: 'Kasena', sayAs: 'Kah-SEH-nah', note: '' }];
    expect(spokenText('The Kasena people of Paga.', rules)).toBe('The Kah-SEH-nah people of Paga.');
    const spec = film();
    spec.scenes[0]!.narration = 'The Kasena people of Paga.';
    spec.pronunciation = rules;
    const req = compileNarrationRequest(spec, spec.scenes[0]!);
    expect(req.text).toBe('The Kasena people of Paga.');
    expect(req.vocabulary).toContain('Kasena');
  });
});

describe('planning helpers', () => {
  it('drafts a scene plan from script paragraphs without a model call', () => {
    const spec = defaultLiteSpec({ direction: 'folklore' });
    spec.story.script = 'First paragraph about the village.\n\nSecond paragraph, the storm.\n\nThird: dawn.';
    const scenes = scenesFromScript(spec);
    expect(scenes.map((s) => s.narration)).toEqual(['First paragraph about the village.', 'Second paragraph, the storm.', 'Third: dawn.']);
    expect(scenes[0]!.transitionIn).toBe('fade_black');
  });

  it('splits a scene at a sentence and keeps the images', () => {
    const spec = film();
    const next = splitScene(spec, 'a', spec.scenes[0]!.narration.indexOf('Mist'));
    expect(next.scenes).toHaveLength(4);
    expect(next.scenes[1]!.narration).toBe('Mist hangs over the water.');
    expect(next.scenes[1]!.shots[0]!.image.approvedAssetId).toBe('img_a2');
  });

  it('normalises a partial saved draft', () => {
    const n = normalizeLiteSpec({ setup: { aspect: '9:16', targetSec: 99999 }, scenes: [{ id: 'x', shots: [{ id: 'y' }] }] });
    expect(n.setup.targetSec).toBe(1200);
    expect(n.setup.aspect).toBe('9:16');
    expect(n.scenes[0]!.shots[0]!.motion.preset).toBe('push_in');
  });
});

describe('final inspection of a narrated film', () => {
  it('reports narration entering after a quiet passage as information, but a hot voice or a sting as a fault', async () => {
    const { loudnessFindings, makeClip } = await import('../src/index');
    const voice = makeClip({ trackId: 'lt_voice', kind: 'audio', start: 3.1, duration: 8, assetId: 'v', role: 'dialogue', label: 'Narration · opening' });
    const sting = makeClip({ trackId: 'lt_fx', kind: 'audio', start: 20, duration: 1.2, assetId: 's', role: 'effects', label: 'Sound · drum' });
    const state = { tracks: [], clips: [voice, sting] };
    const quietOpening = loudnessFindings({ integratedLufs: -14, truePeakDb: -2, peaks: [], spikes: [{ start: 3.2, end: 3.8, lufs: -11, referenceLufs: -38 }] }, state);
    expect(quietOpening.map((f) => f.severity)).toEqual(['info']);
    const hotVoice = loudnessFindings({ integratedLufs: -14, truePeakDb: -2, peaks: [], spikes: [{ start: 3.2, end: 3.8, lufs: -6, referenceLufs: -30 }] }, state);
    expect(hotVoice[0]!.severity).toBe('error');
    const drum = loudnessFindings({ integratedLufs: -14, truePeakDb: -2, peaks: [], spikes: [{ start: 20.1, end: 20.6, lufs: -9, referenceLufs: -30 }] }, state);
    expect(drum[0]!.severity).toBe('error');
  });

  it('accepts marked still holds and deliberate black', async () => {
    const { blackFindings, frozenFindings, makeClip } = await import('../src/index');
    const pic = makeClip({ trackId: 'lt_pic', kind: 'image', start: 0, duration: 12, assetId: 'a', intentional: 'still' });
    const pic2 = makeClip({ trackId: 'lt_pic', kind: 'image', start: 12, duration: 10, assetId: 'b', intentional: 'still' });
    const black = makeClip({ trackId: 'lt_pic', kind: 'title', start: 22, duration: 1.5, intentional: 'black', style: { font: 'Inter', sizePct: 5, color: '#fff', background: '#000000', bold: false, italic: false, uppercase: false, outline: 0, shadow: false } });
    const state = { tracks: [{ id: 'lt_pic', kind: 'video' as const, name: 'Picture', muted: false, locked: false, volume: 1 }], clips: [pic, pic2, black] };
    expect(frozenFindings([{ start: 8, end: 16 }], state)).toEqual([]);
    expect(blackFindings([{ start: 22, end: 23.5 }], state)).toEqual([]);
    expect(blackFindings([{ start: 5, end: 7 }], state)).toHaveLength(1);
  });
});

describe('subtitle phrasing', () => {
  it('breaks a long sentence at its last comma instead of stranding the tail', async () => {
    const { cuesFromWords } = await import('../src/index');
    const text = 'Diamonds for the path, waves for the river, and an open hand for the guest who arrives at dusk.';
    const ws = text.split(' ').map((t, i) => ({ text: t, start: i * 0.4, end: i * 0.4 + 0.33, confidence: 1, sentenceEnd: /\.$/.test(t) }));
    const cues = cuesFromWords(ws, { maxChars: 42, maxLines: 2, offset: 0, sceneId: 's', timing: 'aligned' });
    expect(cues.map((c) => c.text.replace(/\n/g, ' '))).toEqual(['Diamonds for the path, waves for the river,', 'and an open hand for the guest who arrives at dusk.']);
  });
});
