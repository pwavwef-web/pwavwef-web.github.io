import { describe, expect, it } from 'vitest';
import {
  alignVersions,
  applyFinalFix,
  approximateMeasure,
  arrangementFilter,
  arrangementPlan,
  ASPECT_SIZES,
  blackFindings,
  chroma,
  computeColourMatch,
  computeReframe,
  creditsFromMetadata,
  cropSize,
  defaultCreditSequence,
  defaultLyricStyleDoc,
  detectKey,
  emptyTimeline,
  exportReadiness,
  headsCut,
  layoutCredits,
  layoutLyrics,
  loudnessFindings,
  LYRIC_PRESET_STYLES,
  LYRIC_PRESETS,
  makeClip,
  mixFilterGraph,
  defaultMixTrack,
  musicBriefPrompt,
  EMPTY_BRIEF,
  ocrCropFinding,
  presetSignature,
  privateInfoFindings,
  reframeCropExpressions,
  remapSheet,
  resolveLyricStyle,
  sceneToAss,
  statsFromRgb,
  structureTimeline,
  type LyricInputLine,
  type LyricsSheet,
  type SectionEdit,
} from '../src';

const lines: LyricInputLine[] = [
  { id: 'l1', text: 'Carry me home to the river', start: 1, end: 3.6, section: 'verse', words: null, translation: 'Tɔ mɛ ba fie', part: 'call' },
  { id: 'l2', text: 'Where the morning light is gold', start: 3.8, end: 6.5, section: 'verse', words: null, translation: null, part: 'response' },
  { id: 'l3', text: 'Sing it loud', start: 7, end: 9, section: 'chorus', words: [{ text: 'Sing', start: 7, end: 7.4 }, { text: 'it', start: 7.4, end: 7.7 }, { text: 'loud', start: 7.7, end: 8.8 }], translation: null },
];

describe('lyric style presets', () => {
  it('are eighteen distinct rendering systems', () => {
    expect(LYRIC_PRESETS).toHaveLength(18);
    const sigs = new Set(LYRIC_PRESETS.map(presetSignature));
    expect(sigs.size).toBe(18);
  });

  it('render differently from the same timing data', () => {
    const outputs = new Map<string, string>();
    for (const preset of LYRIC_PRESETS) {
      const doc = { ...defaultLyricStyleDoc(preset), global: LYRIC_PRESET_STYLES[preset] };
      const { scene } = layoutLyrics({ lines, doc, aspect: '16:9', width: 1920, height: 1080, measure: approximateMeasure, fps: 24 });
      const ass = sceneToAss(scene);
      expect(scene.blocks.length).toBeGreaterThan(0);
      outputs.set(preset, ass.slice(ass.indexOf('[Events]')));
    }
    expect(new Set(outputs.values()).size).toBe(18);
    expect(outputs.get('karaoke')).toMatch(/\\kf\d+/);
    expect(outputs.get('active_word')).toMatch(/\\t\(\d+,\d+,\\1c&H[0-9A-F]+&\\fscx110/);
    expect(outputs.get('typewriter')).toMatch(/\\alpha&HFF&\\t\(/);
    expect(outputs.get('rolling_credit')).toMatch(/\\move\(/);
    expect(outputs.get('bouncing_ball')).toMatch(/\\p1/);
    expect(outputs.get('full_chorus')).toMatch(/\\p1\\bord0\\shad0\\1c&H000000&\\alpha/);
    expect(outputs.get('environment')).toMatch(/\\frz-4\\fry18/);
    expect(outputs.get('end_credit_scroll')).toMatch(/\\move\(/);
  });

  it('keeps timing identical across aspect ratios and repositions per aspect', () => {
    const doc = { ...defaultLyricStyleDoc('line_by_line') };
    const wide = layoutLyrics({ lines, doc, aspect: '16:9', ...ASPECT_SIZES['16:9'], measure: approximateMeasure, fps: 24 });
    const tall = layoutLyrics({ lines, doc, aspect: '9:16', ...ASPECT_SIZES['9:16'], measure: approximateMeasure, fps: 24 });
    expect(wide.scene.blocks.map((b) => [b.start, b.end])).toEqual(tall.scene.blocks.map((b) => [b.start, b.end]));
    // Vertical frames keep clear of the platform UI at the bottom (20%) and right (14%).
    for (const b of tall.scene.blocks) {
      expect(b.bounds.y + b.bounds.h).toBeLessThanOrEqual(1920 * 0.8 + 1);
      expect(b.bounds.x + b.bounds.w).toBeLessThanOrEqual(1080 * 0.86 + 1);
    }
    expect(tall.issues.filter((i) => i.kind === 'cropped')).toHaveLength(0);
  });

  it('moves lyrics off faces unless the position is locked', () => {
    const face = [{ x: 0.35, y: 0.7, w: 0.3, h: 0.25 }];
    const withFace = lines.map((l) => ({ ...l, avoid: face }));
    const doc = defaultLyricStyleDoc('line_by_line');
    const auto = layoutLyrics({ lines: withFace, doc, aspect: '16:9', width: 1920, height: 1080, measure: approximateMeasure });
    expect(Object.values(auto.positions).some((p) => p.moved)).toBe(true);
    expect(auto.issues.some((i) => i.kind === 'covers_face')).toBe(false);
    const locked = { ...doc, global: { ...doc.global, aspects: { '16:9': { locked: true } } } };
    const kept = layoutLyrics({ lines: withFace, doc: locked, aspect: '16:9', width: 1920, height: 1080, measure: approximateMeasure });
    expect(kept.issues.some((i) => i.kind === 'covers_face')).toBe(true);
  });

  it('applies per-section overrides (chorus as full-screen treatment)', () => {
    const doc = { ...defaultLyricStyleDoc('lower_third'), sections: { chorus: { preset: 'full_chorus' as const } } };
    expect(resolveLyricStyle(doc, 'verse', '16:9').preset).toBe('lower_third');
    expect(resolveLyricStyle(doc, 'chorus', '16:9').preset).toBe('full_chorus');
    const { scene } = layoutLyrics({ lines, doc, aspect: '16:9', width: 1920, height: 1080, measure: approximateMeasure });
    expect(scene.blocks.find((b) => b.refs.includes('l3'))!.dim).not.toBeNull();
    expect(scene.blocks.find((b) => b.refs.includes('l1'))!.box).not.toBeNull();
  });

  it('preserves diacritics and flags tight line spacing for stacked accents', () => {
    const kasem = [{ id: 'k1', text: 'Nɩ́ zʋ̀ ɔ́ ŋwaŋa kʋ́ra nɩ ba pɛ́ na', start: 0, end: 4, section: 'verse' as const, words: null, translation: null }];
    const doc = { ...defaultLyricStyleDoc('large_centred') };
    doc.global = { ...doc.global, lineSpacing: 0.85, maxCharsPerLine: 12 };
    const out = layoutLyrics({ lines: kasem, doc, aspect: '16:9', width: 1920, height: 1080, measure: approximateMeasure });
    const text = out.scene.blocks[0]!.lines.flatMap((l) => l.words.map((w) => w.text)).join(' ');
    expect(text.normalize('NFC')).toBe(kasem[0]!.text.normalize('NFC'));
    expect(out.issues.some((i) => i.kind === 'diacritics_clipped')).toBe(true);
  });
});

describe('credits', () => {
  const meta = { title: 'The River', writer: ['A. Writer'], director: ['F. Pwavwe'], producer: [], editors: ['E. Editor'], performers: [{ character: 'Ama', performer: 'A. Actor' }], voices: [], music: [{ title: 'Carry Me Home', artist: '', generatedBy: 'Lyria 3.5' }], score: null, models: [{ modelId: 'gemini-omni-1.1-flash-preview', displayName: 'Gemini Omni', assets: 12 }], generatedAssets: 14, productionDate: '2026-09-24', brand: 'Indigen World' };
  it('imports project metadata with an AI disclosure and branding', () => {
    const sections = creditsFromMetadata(meta, 'closing');
    expect(sections.map((s) => s.type)).toEqual(expect.arrayContaining(['title', 'crew', 'cast', 'music', 'ai_disclosure', 'copyright', 'branding']));
    expect(sections.find((s) => s.type === 'ai_disclosure')!.body).toMatch(/14 AI-generated assets/);
  });
  it('rolls credits so they finish before the video ends and flags when they would not', () => {
    const seq = { id: 'cr', ...defaultCreditSequence('closing', creditsFromMetadata(meta, 'closing')) };
    const ok = layoutCredits(seq, { width: 1920, height: 1080 }, 60, approximateMeasure, 95);
    expect(ok.finishesAt).toBe(90);
    expect(ok.issues).toHaveLength(0);
    const late = layoutCredits(seq, { width: 1920, height: 1080 }, 80, approximateMeasure, 95);
    expect(late.issues.some((i) => /finish at 110/.test(i))).toBe(true);
    const cards = layoutCredits({ ...seq, layout: 'cards' }, { width: 1920, height: 1080 }, 0, approximateMeasure);
    expect(cards.scene.blocks.length).toBeGreaterThan(1);
    expect(sceneToAss(ok.scene)).toMatch(/\\move\(/);
  });
});

describe('face-safe reframing', () => {
  it('follows a walking subject with a smooth, speed-limited crop instead of a centre crop', () => {
    const samples = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((t) => ({ t, subjects: [{ kind: 'face' as const, box: { x: 0.1 + t * 0.085, y: 0.2, w: 0.12, h: 0.25 } }] }));
    const track = computeReframe(samples, 16 / 9, 9 / 16);
    expect(track.crop).toEqual(cropSize(16 / 9, 9 / 16));
    expect(track.keyframes[0]!.cx).toBeLessThan(0.3);
    expect(track.keyframes[track.keyframes.length - 1]!.cx).toBeGreaterThan(0.6);
    for (let i = 1; i < track.keyframes.length; i++) {
      const a = track.keyframes[i - 1]!;
      const b = track.keyframes[i]!;
      expect(Math.abs(b.cx - a.cx) / Math.max(0.01, b.t - a.t)).toBeLessThanOrEqual(0.23);
    }
    expect(headsCut(samples, track.keyframes, track.crop)).toHaveLength(0);
    const expr = reframeCropExpressions(track.keyframes, 1920, 1080, track.crop);
    expect(expr.w).toBe(608);
    expect(expr.x).toMatch(/^if\(lt\(t,/);
  });

  it('never cuts a face even when the subject jumps (a cut inside the clip)', () => {
    const samples = [0, 1, 2, 3, 4, 5, 6].map((t) => ({ t, subjects: [{ kind: 'face' as const, box: { x: t < 3 ? 0.15 : 0.7, y: 0.2, w: 0.12, h: 0.25 } }] }));
    const track = computeReframe(samples, 16 / 9, 9 / 16);
    expect(headsCut(samples, track.keyframes, track.crop)).toHaveLength(0);
  });
});

describe('colour match', () => {
  it('moves toward the reference but protects skin tones', () => {
    const grey = statsFromRgb([100, 110, 120, 140, 150, 160, 60, 70, 80]);
    const warm = statsFromRgb([160, 120, 90, 200, 150, 110, 120, 90, 60]);
    const c = computeColourMatch(grey, warm);
    expect(c.offset[0]).toBeGreaterThan(c.offset[2]);
    const withSkin = computeColourMatch({ ...grey, skin: [120, 90, 70] }, { ...statsFromRgb([40, 120, 200, 60, 150, 240]), skin: [120, 90, 70] });
    expect(withSkin.skinProtected).toBe(true);
    expect(withSkin.strength).toBeLessThan(0.8);
  });
});

describe('music analysis and arrangement', () => {
  it('detects the key of a synthetic A-minor triad', () => {
    const rate = 22050;
    const n = rate * 3;
    const x = new Float32Array(n);
    for (const f of [220, 261.63, 329.63]) for (let i = 0; i < n; i++) x[i] = x[i]! + 0.3 * Math.sin((2 * Math.PI * f * i) / rate);
    const key = detectKey(chroma(x, rate));
    expect(['A minor', 'C major']).toContain(key.key);
  });

  it('aligns a re-mastered version by its onset envelope', () => {
    const rate = 8000;
    const a = new Float32Array(rate * 6);
    for (let k = 0; k < 12; k++) for (let i = 0; i < 400; i++) a[Math.round(k * 0.45 * rate) + i] = Math.sin(i / 3) * (1 - i / 400);
    const b = new Float32Array(rate * 6);
    const shift = Math.round(0.5 * rate);
    for (let i = 0; i < a.length - shift; i++) b[i + shift] = a[i]! * 0.8;
    const r = alignVersions(a, b, rate, 2);
    expect(r.offsetSec).toBeCloseTo(0.5, 1);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('plans a real-audio arrangement and re-times lyrics through it', () => {
    const sections: SectionEdit[] = [
      { id: 'a', label: 'intro', name: 'Intro', start: 0, end: 8, loop: 1, muted: true, gainDb: 0, fadeIn: 0, fadeOut: 0, visualIdea: '' },
      { id: 'b', label: 'verse', name: 'Verse', start: 8, end: 20, loop: 1, muted: false, gainDb: 0, fadeIn: 0, fadeOut: 0, visualIdea: '' },
      { id: 'c', label: 'chorus', name: 'Chorus', start: 20, end: 30, loop: 2, muted: false, gainDb: -2, fadeIn: 0, fadeOut: 1, visualIdea: '' },
    ];
    const plan = arrangementPlan(sections, 0.08);
    expect(plan.segments).toHaveLength(3);
    expect(plan.durationSec).toBeCloseTo(12 + 10 + 10 - 0.16, 2);
    expect(arrangementFilter(plan)).toMatch(/amix=inputs=3/);
    const sheet = { version: 1, source: 'uploaded', status: 'approved', approvedAt: 1, language: 'en', languageName: 'English', requiresLanguageVerification: false, languageVerifiedAt: null, instrumental: false, sections: [], lines: [{ id: 'v1', text: 'verse line', sectionId: null, start: 9, end: 11, words: [], confidence: 1, flags: [] }, { id: 'h1', text: 'hook line', sectionId: null, start: 21, end: 23, words: [], confidence: 1, flags: [] }], timing: { status: 'aligned', method: 'x', audioAssetId: 'a', alignedAt: 1, lowConfidenceLineIds: [], unalignedLineIds: [], adjustments: 0, notes: [] }, updatedAt: 1 } as LyricsSheet;
    const remapped = remapSheet(sheet, plan.timeMap);
    expect(remapped.lines.map((l) => l.start)).toEqual([1, 12.92, 22.84]);
    expect(remapped.lines.filter((l) => l.text === 'hook line')).toHaveLength(2);
  });

  it('builds a Lyria prompt with the timestamped structure and exact lyrics', () => {
    const brief = { ...EMPTY_BRIEF, title: 'Morning Gold', genre: 'Highlife', durationSec: 120, tempoBpm: 112, key: 'D major', instrumentation: ['guitar', 'bass'] };
    const p = musicBriefPrompt(brief, { mode: 'song', lyrics: '[Verse]\nCarry me home', languageName: 'English' });
    expect(p).toMatch(/\[0:00 - 0:\d\d\] Intro/);
    expect(p).toContain('Sing exactly these lyrics');
    expect(p).toContain('Tempo: 112 BPM.');
    expect(musicBriefPrompt(brief, { mode: 'instrumental' })).toContain('Instrumental only, no vocals');
    expect(structureTimeline(brief).at(-1)!.end).toBeCloseTo(120, -1);
  });

  it('builds a mix graph with EQ, compression, pan, ducking, loudness and limiter', () => {
    const vocal = { ...defaultMixTrack('v', 'Vocals', 'va', 'stem', 'vocal'), compressor: { enabled: true, thresholdDb: -18, ratio: 3 }, pan: -0.2 };
    const beat = { ...defaultMixTrack('b', 'Beat', 'ba', 'stem', 'music'), eq: { lowDb: 3, midDb: 0, highDb: -2 }, duck: { enabled: true, keyTrackId: 'v', amountDb: 9 } };
    const g = mixFilterGraph([vocal, beat], { limiter: true, targetLufs: -14, preset: 'balanced' }, 120);
    expect(g.inputs).toEqual(['va', 'ba']);
    expect(g.filter).toMatch(/acompressor=/);
    expect(g.filter).toMatch(/bass=g=3/);
    expect(g.filter).toMatch(/sidechaincompress/);
    expect(g.filter).toMatch(/loudnorm=I=-14/);
    expect(g.filter).toMatch(/alimiter/);
  });
});

describe('final-film inspection', () => {
  const tl = emptyTimeline('16:9', 24);
  const v1 = tl.tracks.find((t) => t.kind === 'video')!.id;
  const a1 = tl.tracks.find((t) => t.kind === 'audio')!.id;
  const clips = [
    makeClip({ trackId: v1, kind: 'video', start: 0, duration: 4, assetId: 'x', sourceDuration: 6, label: 'Shot 1' }),
    makeClip({ trackId: v1, kind: 'video', start: 5, duration: 4, assetId: 'y', sourceDuration: 4, inPoint: 0, label: 'Shot 2' }),
    makeClip({ trackId: a1, kind: 'audio', start: 0, duration: 9, assetId: 'song', sourceDuration: 60, label: 'Song', volume: 1.8, role: 'music' }),
  ];
  const state = { ...tl, clips };

  it('detects a black gap, a loud peak and a cropped lyric, and offers fixes', () => {
    const black = blackFindings([{ start: 4.0, end: 5.0 }], state);
    expect(black).toHaveLength(1);
    expect(black[0]!.severity).toBe('error');
    expect(black[0]!.fix?.type).toBe('close_gap');
    const fixed = applyFinalFix(state, black[0]!.fix!)!;
    // Shot 1 has a 2-second handle, so the gap is filled with real picture instead of rippling.
    expect(fixed.clips.find((c) => c.label === 'Shot 1')!.duration).toBeCloseTo(5, 3);
    const loud = loudnessFindings({ integratedLufs: -9, truePeakDb: 0.4, peaks: [{ t: 2.2, db: 0 }] }, state);
    expect(loud.some((f) => f.check === 'audio_clipping' && f.severity === 'error' && f.fix?.type === 'reduce_gain')).toBe(true);
    const lowered = applyFinalFix(state, loud.find((f) => f.fix?.type === 'reduce_gain')!.fix!)!;
    expect(lowered.clips.find((c) => c.label === 'Song')!.volume).toBeLessThan(1.8);
    const crop = ocrCropFinding('Carry me home to the river of gold', 'rry me home to the river of gold', 3, 'cap1');
    expect(crop?.check).toBe('lyric_cropped');
    expect(exportReadiness([...black, ...loud, crop!], null)).toBe('blocked');
    expect(exportReadiness([...black, ...loud, crop!], { at: 1, note: 'client approved' })).toBe('overridden');
    expect(exportReadiness(loud.filter((f) => f.severity !== 'error'), null)).toBe('ready');
  });

  it('finds private information in on-screen text', () => {
    const f = privateInfoFindings([{ t: 2, text: 'Call me on +233 24 555 0199 or mail ama@example.com' }]);
    expect(f.map((x) => x.check)).toEqual(['private_information', 'private_information']);
  });
});
