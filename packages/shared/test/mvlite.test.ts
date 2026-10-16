import { describe, expect, it } from 'vitest';
import {
  applyMvDirection,
  assembleMvTimeline,
  barsIn,
  compileMvImageRequest,
  computeMvTiming,
  defaultMvLiteSpec,
  dialogueMaskingFindings,
  mergeMvSections,
  moveMvBoundary,
  mvPlanFromModel,
  mvExportChecks,
  mvSectionsFromSong,
  mvShotsNeedingImages,
  newMvSection,
  newMvShot,
  normalizeMvLiteSpec,
  shareBars,
  shotLyrics,
  splitMvSection,
  splitMvShot,
  type LyricsSheet,
  type MvLiteSpec,
  type MvSong,
} from '../src/index';

const BPM = 120;
const BEAT = 60 / BPM;
const DUR = 64;
const beats = Array.from({ length: Math.floor(DUR / BEAT) }, (_, i) => i * BEAT);
const downbeats = beats.filter((_, i) => i % 4 === 0);

function sheet(lines: { text: string; start: number; end: number }[], audioAssetId = 'song-audio'): LyricsSheet {
  return {
    version: 1,
    source: 'uploaded',
    status: 'approved',
    approvedAt: 1,
    language: 'en',
    languageName: 'English',
    requiresLanguageVerification: false,
    languageVerifiedAt: null,
    instrumental: false,
    sections: [{ id: 'v', label: 'verse', name: 'Verse' }],
    lines: lines.map((l, i) => {
      const ws = l.text.split(' ');
      const step = (l.end - l.start) / ws.length;
      return { id: `l${i}`, text: l.text, sectionId: 'v', start: l.start, end: l.end, words: ws.map((w, k) => ({ text: w, start: l.start + k * step, end: l.start + (k + 0.9) * step, confidence: 0.9, flag: 'aligned' as const })), confidence: 0.9, flags: [] };
    }),
    timing: { status: 'aligned', method: 'test', audioAssetId, alignedAt: 1, lowConfidenceLineIds: [], unalignedLineIds: [], adjustments: 0, notes: [] },
    updatedAt: 1,
  };
}

const SONG: MvSong = {
  id: 'song1',
  title: 'Test song',
  audioAssetId: 'song-audio',
  durationSec: DUR,
  analysis: {
    bpm: BPM,
    beats,
    downbeats,
    energy: Array.from({ length: DUR * 2 }, (_, i) => (i / 2 >= 16 && i / 2 < 32 ? 0.9 : 0.2)),
    energyHop: 0.5,
    sections: [
      { id: 'a', label: 'intro', name: 'Intro', start: 0, end: 8, energy: 0.2 },
      { id: 'b', label: 'verse', name: 'Verse 1', start: 8, end: 16, energy: 0.4 },
      { id: 'c', label: 'chorus', name: 'Chorus', start: 16, end: 32, energy: 0.9 },
      { id: 'd', label: 'outro', name: 'Outro', start: 32, end: DUR, energy: 0.2 },
    ],
  },
  sheet: sheet([
    { text: 'walking down the river road', start: 8.5, end: 11 },
    { text: 'carry home the light', start: 12, end: 14.5 },
    { text: 'sing it loud tonight', start: 16.2, end: 18.8 },
  ]),
  instrumental: false,
};

function planned(): MvLiteSpec {
  const spec = { ...defaultMvLiteSpec({ direction: 'performance' }), song: { songId: 'song1', range: null } };
  return { ...spec, sections: mvSectionsFromSong(spec, SONG) };
}

function withImages(spec: MvLiteSpec): MvLiteSpec {
  return { ...spec, sections: spec.sections.map((s) => ({ ...s, shots: s.shots.map((x, i) => ({ ...x, image: { ...x.image, approvedAssetId: `img${i % 3}` } })) })) };
}

const ASSETS = { img0: { width: 2752, height: 1536, durationSec: null }, img1: { width: 2752, height: 1536, durationSec: null }, img2: { width: 2752, height: 1536, durationSec: null }, 'song-audio': { width: null, height: null, durationSec: DUR } };

describe('Music Video Lite plan from the song', () => {
  it('makes one section per song section and cuts faster where the song is loud', () => {
    const spec = planned();
    expect(spec.sections.map((s) => s.label)).toEqual(['intro', 'verse', 'chorus', 'outro']);
    const chorus = spec.sections[2]!;
    const intro = spec.sections[0]!;
    // Performance: 1 bar per shot when loud, 4 when quiet. Chorus = 8 bars, intro = 4 bars.
    expect(chorus.shots).toHaveLength(8);
    expect(intro.shots).toHaveLength(1);
    expect(chorus.transitionIn).toBe('flash');
    for (const s of spec.sections) expect(s.shots.reduce((a, x) => a + x.bars, 0)).toBeCloseTo(barsIn(SONG.analysis, s.start, s.end), 5);
  });

  it('shares bars evenly in quarter bars', () => {
    expect(shareBars(8, 2)).toEqual([2, 2, 2, 2]);
    expect(shareBars(7, 2).reduce((a, b) => a + b, 0)).toBeCloseTo(7);
    expect(shareBars(0.5, 4)).toEqual([0.5]);
  });
});

describe('Music Video Lite timing', () => {
  it('lands every cut on a bar line and spans the song plus the tail', () => {
    const spec = planned();
    const t = computeMvTiming(spec, SONG);
    expect(t.songSec).toBeCloseTo(DUR, 3);
    expect(t.totalSec).toBeCloseTo(DUR + spec.sound.tailSec, 3);
    for (const s of t.sections)
      for (const x of s.shots) {
        expect(x.onGrid).toBe(true);
        expect(downbeats.some((d) => Math.abs(d - x.start) < 1 / 24 + 1e-6)).toBe(true);
      }
    // Contiguous, no overlaps.
    const shots = t.sections.flatMap((s) => s.shots);
    shots.forEach((x, i) => i && expect(x.start).toBeCloseTo(shots[i - 1]!.start + shots[i - 1]!.duration, 3));
  });

  it('keeps shots contiguous when the bar lines fall between frames (measured grids are never frame-aligned)', () => {
    const off = (x: number) => Math.round((x - 0.03) * 1000) / 1000;
    const song: MvSong = { ...SONG, analysis: { ...SONG.analysis!, beats: beats.map(off).filter((x) => x > 0), downbeats: downbeats.map(off).filter((x) => x > 0) } };
    const spec = withImages({ ...planned(), sections: mvSectionsFromSong(planned(), song) });
    const t = computeMvTiming(spec, song);
    const shots = t.sections.flatMap((s) => s.shots);
    shots.forEach((x, i) => i && expect(x.start).toBe(shots[i - 1]!.start + shots[i - 1]!.duration));
    const a = assembleMvTimeline({ spec, timing: t, song, assets: ASSETS, aspect: '16:9', outWidth: 1920 });
    expect(a.issues.filter((i) => i.kind === 'timeline')).toEqual([]);
  });

  it('scales planned bars into the real section and reports it', () => {
    const spec = planned();
    const s = spec.sections[1]!;
    const odd = { ...spec, sections: spec.sections.map((x) => (x.id === s.id ? { ...x, shots: [newMvShot({ bars: 1 }), newMvShot({ bars: 1 }), newMvShot({ bars: 4 })] } : x)) };
    const t = computeMvTiming(odd, SONG);
    const st = t.sections[1]!;
    expect(st.shots.map((x) => Math.round(x.duration * 10) / 10)).toEqual([2, 2, 4]);
    expect(t.issues.some((i) => i.kind === 'bars_scaled')).toBe(true);
  });

  it('uses a part of the song and shifts film time to it', () => {
    const spec = { ...planned(), song: { songId: 'song1', range: { start: 8, end: 32 } } };
    const p = { ...spec, sections: mvSectionsFromSong(spec, SONG) };
    const t = computeMvTiming(p, SONG);
    expect(t.sections[0]!.start).toBe(0);
    expect(t.songStart).toBe(8);
    expect(t.songSec).toBeCloseTo(24, 3);
    expect(p.sections.map((s) => s.label)).toEqual(['verse', 'chorus']);
  });

  it('falls back to proportional cuts without a beat grid and says so', () => {
    const t = computeMvTiming(planned(), { ...SONG, analysis: { ...SONG.analysis!, beats: [], downbeats: [] } });
    expect(t.gridded).toBe(false);
    expect(t.issues.some((i) => i.kind === 'no_grid')).toBe(true);
  });
});

describe('Music Video Lite assembly and checks', () => {
  it('places stills, the song once and karaoke lyrics on the timeline', () => {
    const spec = withImages(planned());
    const timing = computeMvTiming(spec, SONG);
    const a = assembleMvTimeline({ spec, timing, song: SONG, assets: ASSETS, aspect: '16:9', outWidth: 1920 });
    const songClips = a.state.clips.filter((c) => c.kind === 'audio');
    expect(songClips).toHaveLength(1);
    expect(songClips[0]!.songId).toBe('song1');
    expect(a.captions).toHaveLength(3);
    expect(a.captions[0]!.karaoke?.length).toBe(5);
    expect(a.captions[0]!.start).toBeCloseTo(8.5, 3);
    const flash = a.state.clips.find((c) => c.transitionIn.type === 'dip_white');
    expect(flash?.start).toBeCloseTo(16, 2);
    expect(a.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const findings = mvExportChecks({ spec, timing, assembly: a, song: SONG });
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('offsets lyrics when the video starts mid-song and drops captions in clean sections', () => {
    const base = withImages(planned());
    const spec0 = { ...base, song: { songId: 'song1', range: { start: 8, end: 32 } } };
    const spec = withImages({ ...spec0, sections: mvSectionsFromSong(spec0, SONG) });
    const timing = computeMvTiming(spec, SONG);
    const a = assembleMvTimeline({ spec, timing, song: SONG, assets: ASSETS, aspect: '16:9', outWidth: 1920 });
    expect(a.captions[0]!.start).toBeCloseTo(0.5, 3);
    const clean = { ...spec, sections: spec.sections.map((s) => (s.label === 'chorus' ? { ...s, lyrics: false } : s)) };
    const b = assembleMvTimeline({ spec: clean, timing: computeMvTiming(clean, SONG), song: SONG, assets: ASSETS, aspect: '16:9', outWidth: 1920 });
    expect(b.captions).toHaveLength(2);
  });

  it('reports missing images, untimed lyrics and lyrics timed to another recording', () => {
    const spec = planned();
    const untimed = { ...SONG, sheet: { ...SONG.sheet!, lines: SONG.sheet!.lines.map((l) => ({ ...l, start: null, end: null })) } };
    const a = assembleMvTimeline({ spec, timing: computeMvTiming(spec, untimed), song: untimed, assets: ASSETS, aspect: '16:9', outWidth: 1920 });
    expect(a.issues.some((i) => i.kind === 'missing_image')).toBe(true);
    expect(a.issues.some((i) => i.kind === 'lyrics_untimed')).toBe(true);
    const other = { ...SONG, sheet: { ...SONG.sheet!, timing: { ...SONG.sheet!.timing, audioAssetId: 'old-mix' } } };
    const b = assembleMvTimeline({ spec: withImages(spec), timing: computeMvTiming(spec, other), song: other, assets: ASSETS, aspect: '16:9', outWidth: 1920 });
    expect(b.issues.some((i) => i.kind === 'lyrics_other_audio')).toBe(true);
  });

  it('flags a song cut off before its end without a fade', () => {
    const spec0 = { ...withImages(planned()), song: { songId: 'song1', range: { start: 0, end: 32 } }, sound: { gainDb: 0, fadeInSec: 0.6, fadeOutSec: 0.2, tailSec: 1 } };
    const spec = withImages({ ...spec0, sections: mvSectionsFromSong(spec0, SONG) });
    const a = assembleMvTimeline({ spec, timing: computeMvTiming(spec, SONG), song: SONG, assets: ASSETS, aspect: '16:9', outWidth: 1920 });
    expect(a.issues.some((i) => i.kind === 'song_cut')).toBe(true);
  });
});

describe('Music Video Lite prompts and edits', () => {
  it('puts the sung lyric in the prompt as feeling, never as text, and hashes stably', () => {
    const spec = planned();
    const timing = computeMvTiming(spec, SONG);
    const lyrics = shotLyrics(timing, SONG.sheet);
    const verse = spec.sections[1]!;
    const r = compileMvImageRequest(spec, verse, verse.shots[0]!, lyrics[verse.shots[0]!.id]!);
    expect(r.prompt).toContain('walking down the river road');
    expect(r.prompt).toContain('never write these words');
    expect(r.hash).toBe(compileMvImageRequest(spec, verse, verse.shots[0]!, lyrics[verse.shots[0]!.id]!).hash);
    expect(mvShotsNeedingImages(spec)).toHaveLength(spec.sections.reduce((a, s) => a + s.shots.length, 0));
  });

  it('splits, merges and moves sections without losing shots', () => {
    const spec = planned();
    const verse = spec.sections[1]!;
    const split = splitMvSection(spec, verse.id, 12);
    expect(split.sections).toHaveLength(5);
    expect(split.sections[1]!.end).toBe(12);
    expect(split.sections[2]!.start).toBe(12);
    const merged = mergeMvSections(split, split.sections[1]!.id);
    expect(merged.sections).toHaveLength(4);
    expect(merged.sections[1]!.shots.length).toBe(split.sections[1]!.shots.length + split.sections[2]!.shots.length);
    const moved = moveMvBoundary(spec, verse.id, 18);
    expect(moved.sections[1]!.end).toBe(18);
    expect(moved.sections[2]!.start).toBe(18);
    const sp = splitMvShot(spec, verse.shots[0]!.id);
    expect(sp.sections[1]!.shots[1]!.image.reuseOfShotId).toBe(verse.shots[0]!.id);
  });

  it('normalises partial drafts and keeps the plan when the direction changes', () => {
    const n = normalizeMvLiteSpec({ setup: { aspect: '4:5' }, sections: [{ shots: [{ bars: 0 }] }], lyrics: { mode: 'vertical' } });
    expect(n.setup.aspect).toBe('16:9');
    expect(n.sections[0]!.shots[0]!.bars).toBe(0.25);
    expect(n.lyrics.mode).toBe('karaoke');
    const spec = { ...planned() };
    const changed = applyMvDirection(spec, 'atmospheric');
    expect(changed.sections).toBe(spec.sections);
    expect(changed.lyrics.preset).toBe('minimal_cinematic');
    expect(newMvSection().lyrics).toBe(true);
  });
});

describe('Music Video Lite plan from the model', () => {
  it('keeps the song structure, maps names to the bible and links chorus callbacks', () => {
    const base = planned();
    const spec = { ...base, bible: { ...base.bible, characters: [{ id: 'k', name: 'Kofi', description: '', clothing: '', refAssetIds: [] }], locations: [{ id: 'sea', name: 'Shoreline', description: '', refAssetIds: [] }] } };
    const out = mvPlanFromModel(spec, spec.sections, {
      sections: [
        { index: 1, idea: 'Kofi alone', transitionIn: 'dissolve', shots: [{ brief: 'Kofi at the seawall', characters: ['kofi'], location: 'Shoreline', motion: 'push_in', bars: 2 }, { brief: 'Waves', motion: 'warp', bars: 99 }] },
        { index: 2, transitionIn: 'flash', lyrics: false, shots: [{ brief: 'Callback', reuseOf: 1, bars: 8 }] },
        { index: 9, shots: [{ brief: 'ignored' }] },
      ],
    });
    expect(out.map((s) => s.id)).toEqual(spec.sections.map((s) => s.id));
    expect(out[0]).toBe(spec.sections[0]);
    expect(out[1]!.shots[0]!.characterIds).toEqual(['k']);
    expect(out[1]!.shots[0]!.locationId).toBe('sea');
    expect(out[1]!.shots[1]!.motion.preset).toBe('push_in');
    expect(out[1]!.shots[1]!.bars).toBe(16);
    expect(out[2]!.shots[0]!.image.reuseOfShotId).toBe(out[1]!.shots[0]!.id);
    expect(out[2]!.lyrics).toBe(false);
    expect(out[2]!.transitionIn).toBe('flash');
  });
});

describe('final inspection of a music video', () => {
  it('does not ask the song to duck under its own vocals, but still flags a music bed over speech', () => {
    const spec = withImages(planned());
    const a = assembleMvTimeline({ spec, timing: computeMvTiming(spec, SONG), song: SONG, assets: ASSETS, aspect: '16:9', outWidth: 1920 });
    const sung = SONG.sheet!.lines.map((l) => ({ start: l.start!, end: l.end! }));
    expect(dialogueMaskingFindings(a.state, sung)).toEqual([]);
    const bed = { ...a.state.clips.find((c) => c.songId)!, id: 'bed', songId: null };
    expect(dialogueMaskingFindings({ ...a.state, clips: [...a.state.clips, bed] }, sung).map((f) => f.check)).toEqual(['dialogue_drowned']);
  });
});

describe('Music Video Lite wardrobe in prompts', () => {
  it('states the outfit as a rule that overrides the reference image, with clean sentences', () => {
    const base = planned();
    const spec = { ...base, bible: { ...base.bible, palette: 'Ochre, slate blue.', characters: [{ id: 'k', name: 'Kweku', description: 'A 23-year-old with an easy smile', clothing: 'ochre linen shirt, dusty-rose scarf', refAssetIds: ['ref1'] }] } };
    const sec = spec.sections[1]!;
    const shot = { ...sec.shots[0]!, characterIds: ['k'] };
    const r = compileMvImageRequest(spec, sec, shot, []);
    expect(r.prompt).toContain('Wardrobe — identical in every image of the video: ochre linen shirt, dusty-rose scarf.');
    expect(r.prompt).toContain('but dress them as described here, not as in the reference');
    expect(r.prompt).toContain('changing anyone’s clothing from the wardrobe above');
    expect(r.prompt).not.toContain('..');
    expect(r.referenceAssetIds).toEqual(['ref1']);
  });
});
