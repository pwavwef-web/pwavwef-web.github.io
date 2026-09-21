import { describe, expect, it } from 'vitest';
import {
  addClip,
  assemblePicture,
  clipEnd,
  createHistory,
  deleteClips,
  emptyTimeline,
  findFreeStart,
  lyricsToCaptions,
  makeClip,
  moveClip,
  pushHistory,
  redo,
  resequence,
  rippleDelete,
  snap,
  splitClip,
  trimEnd,
  trimStart,
  undo,
  updateClip,
  validateTimeline,
  type TimelineState,
} from '../src/timeline';

function withVideo(state: TimelineState, start: number, duration: number, sourceDuration: number | null = 10) {
  const track = state.tracks.find((t) => t.kind === 'video')!;
  const clip = makeClip({ trackId: track.id, kind: 'video', start, duration, assetId: 'a1', sourceDuration });
  return { state: addClip(state, clip), clip, track };
}

describe('timeline operations', () => {
  it('creates default tracks for picture, overlays, captions and audio', () => {
    const s = emptyTimeline('16:9');
    expect(s.tracks.map((t) => t.kind)).toEqual(['video', 'video', 'overlay', 'caption', 'audio', 'audio', 'audio']);
  });

  it('never overlaps clips on the same track', () => {
    let s = emptyTimeline();
    ({ state: s } = withVideo(s, 0, 5));
    const { state: s2 } = withVideo(s, 2, 4);
    const clips = s2.clips.sort((a, b) => a.start - b.start);
    expect(clips[1]!.start).toBeGreaterThanOrEqual(clipEnd(clips[0]!));
    expect(validateTimeline(s2)).toEqual([]);
  });

  it('finds the nearest free slot', () => {
    const others = [makeClip({ trackId: 't', kind: 'video', start: 2, duration: 3 })];
    expect(findFreeStart(others, 3, 2)).toBe(5);
    expect(findFreeStart(others, 0.5, 1)).toBe(0.5);
    expect(findFreeStart(others, 1.5, 2)).toBe(0);
  });

  it('moves clips between compatible tracks only', () => {
    let s = emptyTimeline();
    const r = withVideo(s, 0, 4);
    s = r.state;
    const audio = s.tracks.find((t) => t.kind === 'audio')!;
    const v2 = s.tracks.filter((t) => t.kind === 'video')[1]!;
    expect(moveClip(s, r.clip.id, 3, audio.id)).toBe(s);
    const moved = moveClip(s, r.clip.id, 3, v2.id);
    expect(moved.clips[0]!.trackId).toBe(v2.id);
    expect(moved.clips[0]!.start).toBe(3);
  });

  it('trims start while keeping source alignment', () => {
    let s = emptyTimeline();
    const r = withVideo(s, 2, 6, 10);
    s = r.state;
    const t = trimStart(s, r.clip.id, 3.5);
    const c = t.clips[0]!;
    expect(c.start).toBeCloseTo(3.5);
    expect(c.inPoint).toBeCloseTo(1.5);
    expect(clipEnd(c)).toBeCloseTo(8);
    // Cannot reveal media before the source start.
    const back = trimStart(t, c.id, 0);
    expect(back.clips[0]!.inPoint).toBeCloseTo(0);
    expect(back.clips[0]!.start).toBeCloseTo(2);
  });

  it('bounds trims by the source length and neighbours', () => {
    let s = emptyTimeline();
    const r = withVideo(s, 0, 4, 5);
    s = r.state;
    const longer = trimEnd(s, r.clip.id, 20);
    expect(longer.clips[0]!.duration).toBeCloseTo(5);
    const r2 = withVideo(longer, 7, 2, 5);
    const blocked = trimEnd(r2.state, r.clip.id, 9);
    expect(blocked.clips.find((c) => c.id === r.clip.id)!.duration).toBeCloseTo(5);
  });

  it('splits a clip into two aligned parts', () => {
    let s = emptyTimeline();
    const r = withVideo(s, 1, 6, 10);
    s = r.state;
    const { state, rightId } = splitClip(s, r.clip.id, 3);
    expect(rightId).not.toBeNull();
    const left = state.clips.find((c) => c.id === r.clip.id)!;
    const right = state.clips.find((c) => c.id === rightId)!;
    expect(left.duration).toBeCloseTo(2);
    expect(right.start).toBeCloseTo(3);
    expect(right.inPoint).toBeCloseTo(2);
    expect(right.duration).toBeCloseTo(4);
    expect(right.transitionIn.type).toBe('cut');
  });

  it('ripple-deletes and closes gaps', () => {
    let s = emptyTimeline();
    const a = withVideo(s, 0, 3);
    const b = withVideo(a.state, 3, 3);
    const c = withVideo(b.state, 6, 3);
    s = rippleDelete(c.state, [b.clip.id]);
    const starts = s.clips.map((x) => x.start).sort((x, y) => x - y);
    expect(starts).toEqual([0, 3]);
    expect(deleteClips(s, [a.clip.id]).clips).toHaveLength(1);
  });

  it('resequences clips back to back in a new order', () => {
    let s = emptyTimeline();
    const a = withVideo(s, 0, 2);
    const b = withVideo(a.state, 2, 3);
    s = resequence(b.state, a.track.id, [b.clip.id, a.clip.id]);
    const bb = s.clips.find((x) => x.id === b.clip.id)!;
    const aa = s.clips.find((x) => x.id === a.clip.id)!;
    expect(bb.start).toBe(0);
    expect(aa.start).toBe(3);
  });

  it('clamps transition and fade durations', () => {
    let s = emptyTimeline();
    const r = withVideo(s, 0, 2);
    s = updateClip(r.state, r.clip.id, { fadeIn: 5, transitionIn: { type: 'dissolve', duration: 9 }, volume: 7 });
    const c = s.clips[0]!;
    expect(c.fadeIn).toBe(1);
    expect(c.transitionIn.duration).toBe(2);
    expect(c.volume).toBe(2);
  });

  it('assembles shots and lyric captions', () => {
    let s = emptyTimeline();
    s = assemblePicture(s, [
      { assetId: 'x', kind: 'video', durationSec: 5, sourceDuration: 4, label: 'Shot 1' },
      { assetId: 'y', kind: 'image', durationSec: 3, sourceDuration: null, label: 'Card' },
      { assetId: 'z', kind: 'video', durationSec: 6, sourceDuration: 8, label: 'Shot 3', at: 20 },
    ]);
    const v = s.clips.filter((c) => c.kind !== 'caption').sort((a, b) => a.start - b.start);
    expect(v.map((c) => [c.start, c.duration])).toEqual([
      [0, 4],
      [4, 3],
      [20, 6],
    ]);
    s = lyricsToCaptions(s, [
      { id: 'l1', start: 1, end: 3, text: 'First line' },
      { id: 'l2', start: 3, end: 3, text: 'invalid' },
    ]);
    expect(s.clips.filter((c) => c.kind === 'caption')).toHaveLength(1);
    expect(validateTimeline(s)).toEqual([]);
  });

  it('snaps to nearby points only within the threshold', () => {
    expect(snap(2.04, [0, 2, 4], 0.1)).toBe(2);
    expect(snap(2.5, [0, 2, 4], 0.1)).toBe(2.5);
  });

  it('reports structural problems', () => {
    const s = emptyTimeline();
    const track = s.tracks.find((t) => t.kind === 'caption')!;
    const bad: TimelineState = { ...s, clips: [makeClip({ trackId: track.id, kind: 'caption', start: 0, duration: 1, text: '' })] };
    expect(validateTimeline(bad)).toContain('A caption clip has no text.');
  });
});

describe('history', () => {
  it('supports undo and redo', () => {
    let h = createHistory(1);
    h = pushHistory(h, 2);
    h = pushHistory(h, 3);
    h = undo(h);
    expect(h.present).toBe(2);
    h = undo(h);
    expect(h.present).toBe(1);
    h = redo(h);
    expect(h.present).toBe(2);
    h = pushHistory(h, 9);
    expect(h.future).toEqual([]);
    expect(undo(createHistory(5)).present).toBe(5);
  });

  it('caps history length', () => {
    let h = createHistory(0);
    for (let i = 1; i <= 10; i++) h = pushHistory(h, i, 3);
    expect(h.past).toEqual([7, 8, 9]);
  });
});
