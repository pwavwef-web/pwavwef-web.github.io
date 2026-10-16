import type { LiteAspect } from './lite';
import { dbGain, clipPreroll, type LiteAssetInfo } from './lite-assemble';
import { fontSupports } from './lite-subtitles';
import { hasLook, resolveShotMotion, type ClipLook, type MotionIssue } from './motion';
import { barSeconds, mvShotImageId, type MvLiteSpec, type MvSong } from './mvlite';
import type { MvTiming } from './mvlite-timing';
import { applyLyricCaptions, makeClip, makeTrack, validateTimeline, type TimelineState } from './timeline';
import type { Clip, Track } from './types';

/**
 * Builds Music Video Lite's composition for one output format as an ordinary AZ Studio timeline: the stills
 * with their camera moves cut on the song's beat grid, the song itself (once, untouched), and the lyric
 * captions placed from the synchronised lyric sheet. The same persisted timeline drives the browser preview
 * and the FFmpeg render, so the export is exactly the approved edit.
 */

export interface MvAssemblyIssue {
  severity: 'error' | 'warning' | 'info';
  kind: string;
  message: string;
  sectionId: string | null;
  shotId: string | null;
  at: number | null;
}

export interface MvAssemblyInput {
  spec: MvLiteSpec;
  timing: MvTiming;
  song: MvSong | null;
  assets: Record<string, LiteAssetInfo>;
  aspect: LiteAspect;
  outWidth: number;
}

export interface MvAssembly {
  state: TimelineState;
  issues: MvAssemblyIssue[];
  durationSec: number;
  /** Lyric captions placed on the timeline. */
  captions: Clip[];
}

export const MV_TRACKS = { picture: 'mv_pic', lyrics: 'mv_lyr', song: 'mv_song' } as const;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

function mergeLook(base: ClipLook, over: Partial<ClipLook> | null, seed: number): ClipLook {
  return { ...base, ...(over ?? {}), seed };
}

export function assembleMvTimeline(input: MvAssemblyInput): MvAssembly {
  const { spec, timing, song, assets, aspect } = input;
  const issues: MvAssemblyIssue[] = timing.issues.map((i) => ({ ...i }));
  const issue = (severity: MvAssemblyIssue['severity'], kind: string, message: string, sectionId: string | null = null, shotId: string | null = null, at: number | null = null) => issues.push({ severity, kind, message, sectionId, shotId, at });
  const D = timing.totalSec;
  const lyricsOn = spec.lyrics.enabled && spec.lyrics.burnIn;
  const tracks: Track[] = [
    { ...makeTrack('video', 'Picture'), id: MV_TRACKS.picture },
    { ...makeTrack('caption', 'Lyrics'), id: MV_TRACKS.lyrics, muted: !lyricsOn },
    { ...makeTrack('audio', 'Song'), id: MV_TRACKS.song },
  ];
  const clips: Clip[] = [];
  const byId = new Map(spec.sections.map((s) => [s.id, s]));
  const beat = timing.bpm ? 60 / timing.bpm : 0.5;
  const bar = barSeconds(song?.analysis ?? null);
  if (!song) issue('error', 'no_song', 'Choose the song first — the video is cut to it.');
  else if (!assets[song.audioAssetId]) issue('error', 'song_missing', 'The song’s audio is missing or still processing.');

  // ---- Picture --------------------------------------------------------------------------------
  let shotNo = 0;
  const lastSection = timing.sections[timing.sections.length - 1];
  for (const st of timing.sections) {
    const section = byId.get(st.sectionId)!;
    const sectionName = section.name || section.label;
    st.shots.forEach((sh, k) => {
      const shot = section.shots[k]!;
      const isLast = st === lastSection && k === st.shots.length - 1;
      const duration = isLast ? r3(D - sh.start) : sh.duration;
      const imageId = mvShotImageId(spec, shot);
      shotNo++;
      if (!imageId) {
        issue('error', 'missing_image', `${sectionName}, shot ${k + 1} has no approved image.`, section.id, shot.id, sh.start);
        return;
      }
      const info = assets[imageId];
      if (!info) issue('error', 'missing_asset', `The image of ${sectionName}, shot ${k + 1} is missing or not ready.`, section.id, shot.id, sh.start);
      let transitionIn: Clip['transitionIn'] = { type: 'cut', duration: 0 };
      const first = st.index === 0 && k === 0;
      if (k === 0 && st.index > 0) {
        if (section.transitionIn === 'dissolve') transitionIn = { type: 'dissolve', duration: r3(Math.max(0.4, Math.min(1.2, bar / 2))) };
        else if (section.transitionIn === 'flash') transitionIn = { type: 'dip_white', duration: r3(Math.max(0.2, Math.min(0.4, beat * 0.6))) };
        else if (section.transitionIn === 'fade_black') transitionIn = { type: 'dip_black', duration: r3(Math.max(0.6, Math.min(1.4, bar / 2))) };
      } else if (k > 0) {
        if (shot.transitionIn === 'dissolve') transitionIn = { type: 'dissolve', duration: r3(Math.max(0.3, Math.min(0.8, beat))) };
        else if (shot.transitionIn === 'flash') transitionIn = { type: 'dip_white', duration: r3(Math.max(0.16, Math.min(0.3, beat * 0.5))) };
      }
      // A dissolve cannot be longer than the shot before it shows.
      if (transitionIn.type === 'dissolve') {
        const prev = k > 0 ? st.shots[k - 1] : timing.sections[st.index - 1]?.shots.at(-1);
        if (prev) transitionIn.duration = r3(Math.min(transitionIn.duration, prev.duration * 0.6));
      }
      const pre = clipPreroll({ transitionIn });
      const resolved = resolveShotMotion(shot.motion, { w: info?.width ?? null, h: info?.height ?? null }, { aspect, durationSec: duration + pre, outWidth: input.outWidth });
      // Brisk moves on short shots are the music video's language: the narrated-film pace check does not apply.
      for (const m of resolved.issues as MotionIssue[]) if ((m.kind !== 'no_dimensions' || info) && m.kind !== 'too_fast') issue(m.severity, `motion_${m.kind}`, `${sectionName}, shot ${k + 1}: ${m.message}`, section.id, shot.id, sh.start);
      const look = mergeLook(spec.setup.look, shot.look, spec.setup.look.seed + shotNo);
      clips.push(
        makeClip({
          id: `mc_${shot.id}`,
          trackId: MV_TRACKS.picture,
          kind: 'image',
          start: sh.start,
          duration,
          assetId: imageId,
          fit: 'fill',
          kenBurns: false,
          motion: resolved.motion,
          look: hasLook(look) ? look : null,
          intentional: 'still',
          transitionIn,
          fadeIn: first ? Math.max(0.3, spec.sound.fadeInSec) : 0,
          fadeOut: isLast ? Math.max(1, spec.sound.fadeOutSec) : 0,
          label: `${sectionName} · shot ${k + 1}`,
          shotId: shot.id,
        }),
      );
    });
  }

  // ---- Song -----------------------------------------------------------------------------------
  if (song && timing.songSec > 0) {
    const startsMid = timing.songStart > 0.05;
    const endsEarly = timing.songEnd < song.durationSec - 0.05;
    clips.push(
      makeClip({
        id: 'ms_song',
        trackId: MV_TRACKS.song,
        kind: 'audio',
        start: 0,
        duration: timing.songSec,
        assetId: song.audioAssetId,
        inPoint: timing.songStart,
        sourceDuration: song.durationSec,
        useSourceAudio: false,
        songId: song.id,
        role: 'music',
        volume: dbGain(spec.sound.gainDb),
        fadeIn: startsMid ? Math.max(0.3, spec.sound.fadeInSec) : 0.02,
        fadeOut: endsEarly ? Math.max(1, spec.sound.fadeOutSec) : 0.05,
        label: song.title || 'Song',
      }),
    );
    if (endsEarly && spec.sound.fadeOutSec < 1) issue('warning', 'song_cut', 'The video ends before the song does and the song barely fades — it will sound cut off.', null, null, timing.songSec);
  }

  let state: TimelineState = {
    tracks,
    clips: clips.sort((a, b) => a.start - b.start),
    markers: timing.sections.map((s) => ({ id: `m_${s.sectionId}`, time: s.start, label: byId.get(s.sectionId)!.name || byId.get(s.sectionId)!.label, color: '#f4b84a' })),
    fps: spec.setup.fps,
    aspectRatio: aspect,
    beatGrid: timing.gridded && timing.bpm ? { bpm: timing.bpm, beats: timing.beats } : null,
  };

  // ---- Lyrics ---------------------------------------------------------------------------------
  const sheet = song?.sheet ?? null;
  if (song && spec.lyrics.enabled && !song.instrumental) {
    const timed = sheet?.lines.filter((l) => l.start !== null && l.end !== null && l.text.trim()) ?? [];
    if (!sheet?.lines.length) issue('warning', 'no_lyrics', 'The song has no lyrics yet, so the video has no lyric captions (mark it instrumental, or add the lyrics).');
    else if (!timed.length) issue('error', 'lyrics_untimed', 'The lyrics are not synchronised to the song yet — synchronise them on the Song stage.');
    else {
      if (sheet.timing.audioAssetId && sheet.timing.audioAssetId !== song.audioAssetId) issue('error', 'lyrics_other_audio', 'The lyrics were timed to a different recording of the song — synchronise them again.');
      state = applyLyricCaptions(state, song.id, sheet, spec.lyrics.mode);
      // Sections that keep the picture clean drop their captions.
      const clean = timing.sections.filter((s) => !byId.get(s.sectionId)!.lyrics);
      if (clean.length) state = { ...state, clips: state.clips.filter((c) => !(c.lyric && clean.some((s) => c.start >= s.start - 0.01 && c.start < s.start + s.duration - 0.01))) };
      const lyricClips = state.clips.filter((c) => c.lyric);
      const sample = lyricClips.map((c) => c.text).join(' ');
      const font = lyricClips[0]?.style?.font;
      if (font && sample && !fontSupports(font, sample)) {
        state = { ...state, clips: state.clips.map((c) => (c.lyric && c.style ? { ...c, style: { ...c.style, font: 'Noto Sans' } } : c)) };
        issue('info', 'font_substituted', `${font} cannot show every letter of the lyrics (for example Kasem letters); captions use Noto Sans instead.`);
      }
      const inside = timed.filter((l) => l.end! > timing.songStart && l.start! < timing.songEnd).length;
      const placed = state.clips.filter((c) => c.lyric).length;
      if (!clean.length && placed < inside) issue('info', 'lyrics_partial', `${inside - placed} lyric line(s) in this part of the song are too short or cross its edge, so they are not captioned.`);
    }
  }

  for (const p of validateTimeline(state)) issue('error', 'timeline', p);
  return { state, issues, durationSec: D, captions: state.clips.filter((c) => c.lyric) };
}
