import { addTrack, applyLyricCaptions, clipEnd, emptyTimeline, makeClip, addAudioBed, validateTimeline, checkLyricSync, type Clip, type LyricsSheet, type TimelineState } from '@az-studio/shared';
import { col, FieldValue, loadState, patchState, say, studioOwner, submitJobs, waitForJob, reporter } from './common';
import { SHOTS } from './shots';

// Usage: 11-timeline.ts <build|render> [aspects=16:9,9:16] [quality=draft|final]
const mode = process.argv[2] ?? 'build';
const aspects = (process.argv.find((a) => a.startsWith('aspects='))?.slice(8) ?? '16:9,9:16').split(',') as ('16:9' | '9:16')[];
const quality = (process.argv.find((a) => a.startsWith('quality='))?.slice(8) ?? 'final') as 'draft' | 'final';
const { log } = reporter('de-n-lei-11-timeline');
const owner = await studioOwner();
let st = loadState();
const projectId = st.projectId as string;
const DURATION = st.songDurationSec as number;
const ENGLISH = new Set(["Let us learn together", "Words from our grandparents' mouths", 'We hold them close, we hold them dear', 'I want to learn Kasem', 'I want to learn it right', 'My words, my language', 'I hear a word, I stop and ask', 'An elder tells me true', 'I say it back, I say it twice', 'Then I pass it on', 'One voice teaches another', 'One word lights the way', 'Come and speak Kasem with me']);
const TRANSITIONS: Record<number, { type: Clip['transitionIn']['type']; duration: number }> = { 18: { type: 'dip_black', duration: 0.7 }, 21: { type: 'dip_black', duration: 0.8 }, 22: { type: 'dip_white', duration: 0.3 } };

const song = (await col.songs(projectId).doc('song').get()).data()!;
const sheet = song.lyricsSheet as LyricsSheet;

async function assetInfo(id: string) {
  const a = (await col.assets().doc(id).get()).data()!;
  return { durationSec: a.durationSec as number, width: a.width as number, height: a.height as number };
}

for (const aspect of aspects) {
  const sel: Record<string, string> = st.selection?.[aspect] ?? {};
  let t: TimelineState = emptyTimeline(aspect, 24);
  const v1 = t.tracks.find((x) => x.kind === 'video')!;
  const missing: number[] = [];
  const clips: Clip[] = [];
  for (const s of SHOTS) {
    const assetId = sel[s.n] ?? st.genResults?.[`${aspect}|${s.n}|1080p`]?.assetId;
    if (!assetId) { missing.push(s.n); continue; }
    const info = await assetInfo(assetId);
    const duration = +(s.end - s.start).toFixed(3);
    if (info.durationSec + 0.05 < duration) throw new Error(`shot ${s.n} (${aspect}) clip is ${info.durationSec}s, needs ${duration}s`);
    clips.push(makeClip({ trackId: v1.id, kind: 'video', start: s.start, duration, assetId, inPoint: 0, sourceDuration: info.durationSec, label: `${String(s.n).padStart(2, '0')} ${s.title}`, shotId: st.shotIds[aspect][s.n], takeId: null, useSourceAudio: false, transitionIn: TRANSITIONS[s.n] ?? { type: 'cut', duration: 0 } }));
  }
  if (missing.length) { say(`${aspect}: missing shots ${missing.join(',')} — timeline not built`); continue; }
  // Close the sub-frame gaps between slots (slots tile the song exactly, so gaps only come from rounding).
  clips.sort((a, b) => a.start - b.start);
  // Snap every cut to a whole frame and tile in whole frames: a start and duration that each round on their own leave a one-frame black gap.
  const FPS = 24;
  // Whole multiples of 0.125 s (3 frames) are exact in milliseconds; the renderer rounds clip starts to 3 decimals and drops the first frame of a clip whose start rounds up.
  const startF = clips.map((c) => Math.round(c.start * 8) * 3);
  const endF = Math.round(DURATION * FPS);
  // A clip needs a little source left after its slot to run under the next one; if it has none, cut a few frames earlier.
  for (let i = 0; i < clips.length - 1; i++) {
    while ((clips[i]!.sourceDuration ?? 0) - (startF[i + 1]! - startF[i]!) / FPS < 0.135 && startF[i + 1]! - startF[i]! > 48) startF[i + 1]! -= 3;
  }
  clips.forEach((c, i) => { c.start = startF[i]! / FPS; c.duration = ((startF[i + 1] ?? endF) - startF[i]!) / FPS; });
  clips[0]!.start = 0;
  // The renderer can drop a boundary frame (it shows black). Give each clip its own video layer, above the previous one, and let every
  // clip run a little past its end underneath the next: a dropped frame then shows the previous picture instead of black.
  // (Not before a dip-to-black, where black is the intent.)
  const PAD = 0.125;
  const videoTracks = t.tracks.filter((x) => x.kind === 'video');
  while (videoTracks.length < clips.length) {
    t = addTrack(t, 'video', `V${videoTracks.length + 1} Picture`);
    videoTracks.push(t.tracks.filter((x) => x.kind === 'video').at(-1)!);
  }
  clips.forEach((c, i) => {
    c.trackId = videoTracks[i]!.id;
    const nextN = SHOTS[i + 1]?.n;
    const dipNext = nextN !== undefined && TRANSITIONS[nextN]?.type === 'dip_black';
    if (nextN === undefined || dipNext) return;
    c.duration = +(c.duration + Math.max(0, Math.min(PAD, (c.sourceDuration ?? 0) - c.duration - 0.001))).toFixed(3);
  });
  t = { ...t, clips: [...t.clips, ...clips] };
  t = addAudioBed(t, st.songAssetId, DURATION, 'De N Lei — Come Learn Kasem', { songId: 'song', sourceDuration: DURATION });

  // Lyric captions follow the song clip. English lines are set apart (warm tint) from the Kasem lines.
  t = applyLyricCaptions(t, 'song', sheet, aspect === '16:9' ? 'line' : 'vertical');
  const vertical = aspect === '9:16';
  t = {
    ...t,
    clips: t.clips.map((c) => {
      if (!c.lyric) return c;
      const isEnglish = ENGLISH.has(c.text);
      return {
        ...c,
        style: { ...c.style!, font: 'Noto Sans', sizePct: vertical ? 4.1 : 5.2, bold: true, outline: vertical ? 3 : 2, shadow: true, color: isEnglish ? '#FFE0A0' : '#FFFFFF', italic: isEnglish, highlight: null },
        karaoke: null,
        position: vertical ? { anchor: 'bottom', offset: 0.22, align: 'center' } : { anchor: 'bottom', offset: 0.075, align: 'center' },
      } as Clip;
    }),
  };

  // Title cards: the song title over the opening instrumental, and an end card.
  t = addTrack(t, 'overlay', 'Titles 2');
  const overlay = t.tracks.find((x) => x.kind === 'overlay')!;
  const overlay2 = t.tracks.filter((x) => x.kind === 'overlay').pop()!;
  const title = (trackId: string, text: string, start: number, duration: number, sizePct: number, offset: number, anchor: 'top' | 'bottom' = 'bottom', font: 'Noto Sans' | 'EB Garamond' = 'Noto Sans') =>
    makeClip({ trackId, kind: 'title', start, duration, text, label: 'Title', fadeIn: 0.6, fadeOut: 0.6, style: { font, sizePct, color: '#FFFFFF', background: null, bold: true, italic: false, uppercase: false, outline: 2, shadow: true }, position: { anchor, offset, align: 'center' } });
  t = { ...t, clips: [...t.clips, title(overlay.id, 'De N Lei — Come Learn Kasem', 1.4, 4.8, vertical ? 4.4 : 5.2, vertical ? 0.3 : 0.14), title(overlay.id, 'De N Lei — Come Learn Kasem', 203.6, 7.4, vertical ? 4.6 : 6, vertical ? 0.115 : 0.08, 'top'), title(overlay2.id, 'Indigen World', 205.4, 5.6, vertical ? 3.4 : 3.8, vertical ? 0.205 : 0.2, 'top')] };

  const issues = validateTimeline(t);
  const sync = checkLyricSync(t, { song: sheet });
  say(`${aspect}: ${t.clips.length} clips, ${issues.length} timeline issues, ${sync.length} lyric-sync issues`);
  for (const i of issues) say(`  timeline: ${i}`);
  for (const i of sync.slice(0, 10)) say(`  sync: ${JSON.stringify(i)}`);

  let timelineId: string | undefined = st.timelines?.[aspect];
  const ref = timelineId ? col.timelines(projectId).doc(timelineId) : col.timelines(projectId).doc();
  const doc = { ownerUid: owner.uid, projectId, name: `De N Lei — ${aspect === '16:9' ? 'YouTube 16:9' : 'TikTok 9:16'} cut`, fps: 24, aspectRatio: aspect, tracks: t.tracks, clips: t.clips, markers: [], beatGrid: null, version: 1, durationSec: DURATION, updatedAt: FieldValue.serverTimestamp() };
  if (timelineId) await ref.set(doc, { merge: true });
  else await ref.set({ ...doc, createdAt: FieldValue.serverTimestamp() });
  timelineId = ref.id;
  st = patchState({ timelines: { ...(st.timelines ?? {}), [aspect]: timelineId } });
  void clipEnd;

  if (mode === 'render') {
    const [id] = await submitJobs(owner, [{ type: 'render.timeline', projectId, timelineId, preset: aspect === '16:9' ? 'youtube_16x9' : 'vertical_9x16', quality, inspect: quality === 'final', acceptLyricSync: false, audioMaster: 'preserve', label: `De N Lei · render ${aspect} ${quality}` }], `De N Lei · render ${aspect}`);
    say(`render job ${id}`);
    const job = await waitForJob(id!, log, 60 * 60_000);
    say(`render ${aspect}: ${job.status} ${JSON.stringify(job.result ?? job.error)?.slice(0, 300)}`);
    st = patchState({ renders: { ...(st.renders ?? {}), [`${aspect}|${quality}`]: { jobId: id, status: job.status, result: job.result ?? null, error: job.error?.message ?? null } } });
  }
}
