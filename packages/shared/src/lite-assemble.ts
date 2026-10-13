import { shotImageId, type AmbienceKind, type LiteAspect, type LiteSpec } from './lite';
import { movementSpan } from './lite-music';
import { buildLiteCues, liteCaptionStyle, type LiteCue } from './lite-subtitles';
import type { LiteNarrationTake, LiteTiming } from './lite-timing';
import { hasLook, parallaxMotion, resolveShotMotion, type ClipLook, type ClipMotion, type MotionIssue } from './motion';
import { DEFAULT_SCORE_MIX, scoreAutomation, type ScoreDoc } from './score';
import { makeClip, makeTrack, validateTimeline, type TimelineState } from './timeline';
import type { Clip, Track } from './types';

/**
 * Builds Film Studio Lite's composition for one output format as an ordinary AZ Studio timeline. The same
 * persisted timeline drives the browser preview and the FFmpeg render, so shot timings, camera moves,
 * subtitles and levels in the export are exactly the ones approved. Ducking is written as volume
 * automation from the measured speech (not a signal-driven compressor), so preview and export match.
 */

export interface LiteAssetInfo {
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

export interface LiteAssemblyIssue {
  severity: 'error' | 'warning' | 'info';
  kind: string;
  message: string;
  sceneId: string | null;
  shotId: string | null;
  at: number | null;
}

export interface LiteAssemblyInput {
  spec: LiteSpec;
  timing: LiteTiming;
  takes: Record<string, LiteNarrationTake | null | undefined>;
  assets: Record<string, LiteAssetInfo>;
  aspect: LiteAspect;
  /** Final output width of this format (resolution checks). */
  outWidth: number;
  score: Pick<ScoreDoc, 'movements' | 'cueSheet'> | null;
  /** Synthesised ambience beds by kind. */
  ambience: Partial<Record<AmbienceKind, { assetId: string; durationSec: number }>>;
}

export interface LiteAssembly {
  state: TimelineState;
  cues: LiteCue[];
  issues: LiteAssemblyIssue[];
  durationSec: number;
  /** Speech spans (film time) that duck music and ambience. */
  speech: { start: number; end: number }[];
}

export const LITE_TRACKS = { picture: 'lt_pic', foreground: 'lt_fg', subtitles: 'lt_sub', voice: 'lt_voice', effects: 'lt_fx' } as const;

const r3 = (n: number) => Math.round(n * 1000) / 1000;
export const dbGain = (db: number) => r3(10 ** (db / 20));

/** Seconds of picture a clip shows before its start (incoming dissolve). */
export function clipPreroll(c: Pick<Clip, 'transitionIn'>): number {
  const t = c.transitionIn;
  return t.type === 'dissolve' || t.type === 'slide_left' || t.type === 'slide_right' ? t.duration : 0;
}

/** Progress (0–1) of a clip's camera move at film time t — shared by the preview and the renderer. */
export function clipMotionProgress(c: Pick<Clip, 'start' | 'duration' | 'transitionIn'>, t: number): number {
  const pre = clipPreroll(c);
  return Math.max(0, Math.min(1, (t - (c.start - pre)) / Math.max(1e-6, c.duration + pre)));
}

/** Speech spans from the measured words, bridged across short gaps so music does not pump between words. */
export function speechSpans(spec: LiteSpec, timing: LiteTiming, takes: LiteAssemblyInput['takes']): { start: number; end: number }[] {
  const raw: { start: number; end: number }[] = [];
  for (const st of timing.scenes) {
    if (st.voiceAt === null) continue;
    const take = takes[st.sceneId];
    if (take?.words.length) {
      const offset = st.voiceAt - take.speechStart;
      for (const w of take.words) raw.push({ start: w.start + offset, end: w.end + offset });
    } else raw.push({ start: st.voiceAt, end: st.voiceAt + st.speechSec });
  }
  const bridge = Math.max(spec.sound.duck.bridgeGapSec, spec.sound.duck.attackSec + spec.sound.duck.releaseSec + 0.1);
  const out: { start: number; end: number }[] = [];
  for (const s of raw.sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && s.start - last.end < bridge) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out.map((s) => ({ start: r3(s.start), end: r3(s.end) }));
}

/** Gain of the duck envelope at film time t (1 = full level). */
export function duckGainAt(spans: { start: number; end: number }[], t: number, depthDb: number, attack: number, release: number): number {
  const low = 10 ** (-depthDb / 20);
  let g = 1;
  for (const s of spans) {
    if (t < s.start - attack) break;
    let v = 1;
    if (t < s.start) v = 1 - ((t - (s.start - attack)) / attack) * (1 - low);
    else if (t <= s.end) v = low;
    else if (t < s.end + release) v = low + ((t - s.end) / release) * (1 - low);
    g = Math.min(g, v);
  }
  return g;
}

/** Clip-local volume automation: intensity × duck envelope, sampled at every breakpoint of either. */
function automation(clipStart: number, clipDur: number, spans: { start: number; end: number }[], duck: { depthDb: number; attackSec: number; releaseSec: number }, intensity: { t: number; gain: number }[] | null): { t: number; gain: number }[] {
  const times = new Set<number>([0, r3(clipDur)]);
  for (const s of spans) {
    for (const x of [s.start - duck.attackSec, s.start, s.end, s.end + duck.releaseSec]) {
      const local = x - clipStart;
      if (local > 0 && local < clipDur) times.add(r3(local));
    }
  }
  for (const p of intensity ?? []) if (p.t > 0 && p.t < clipDur) times.add(r3(p.t));
  const intensityAt = (t: number) => {
    if (!intensity?.length) return 1;
    if (t <= intensity[0]!.t) return intensity[0]!.gain;
    for (let i = 1; i < intensity.length; i++) {
      const a = intensity[i - 1]!;
      const b = intensity[i]!;
      if (t <= b.t) return b.t - a.t < 1e-6 ? b.gain : a.gain + ((b.gain - a.gain) * (t - a.t)) / (b.t - a.t);
    }
    return intensity[intensity.length - 1]!.gain;
  };
  // Normalise intensity so the loudest cue plays at the chosen music level.
  const peak = Math.max(1e-6, ...(intensity ?? [{ t: 0, gain: 1 }]).map((p) => p.gain));
  const pts = [...times].sort((a, b) => a - b).map((t) => ({ t, gain: r3((intensityAt(t) / peak) * duckGainAt(spans, clipStart + t, duck.depthDb, duck.attackSec, duck.releaseSec)) }));
  // Drop redundant points on flat stretches.
  return pts.filter((p, i) => i === 0 || i === pts.length - 1 || !(Math.abs(p.gain - pts[i - 1]!.gain) < 1e-3 && Math.abs(p.gain - pts[i + 1]!.gain) < 1e-3));
}

interface Span {
  start: number;
  end: number;
}

/**
 * Fills a span with an audio file: one clip when it is long enough, otherwise crossfaded reuse of the
 * file's body (never stretched). Returns clip parameters (film time).
 */
export function fillSpan(span: Span, sourceSec: number, opts: { crossfadeSec: number; loopFrom: number; fit: 'loop' | 'end' }): { start: number; duration: number; inPoint: number; joinAt: number | null }[] {
  const need = span.end - span.start;
  if (sourceSec >= need - 0.05 || opts.fit === 'end') return [{ start: span.start, duration: r3(Math.min(need, sourceSec)), inPoint: 0, joinAt: null }];
  const out: { start: number; duration: number; inPoint: number; joinAt: number | null }[] = [{ start: span.start, duration: r3(sourceSec), inPoint: 0, joinAt: null }];
  const from = Math.max(0, Math.min(opts.loopFrom, sourceSec - opts.crossfadeSec * 3));
  let at = span.start + sourceSec;
  for (let guard = 0; at < span.end - 0.05 && guard < 200; guard++) {
    const start = at - opts.crossfadeSec;
    const duration = Math.min(sourceSec - from, span.end - start);
    out.push({ start: r3(start), duration: r3(duration), inPoint: r3(from), joinAt: r3(start) });
    at = start + duration;
  }
  return out;
}

/** Assigns overlapping clips to as few tracks as needed (crossfades need two). */
function assignTracks(clips: Clip[], prefix: string, name: string, tracks: Track[]): void {
  const lanes: { id: string; end: number }[] = [];
  for (const c of [...clips].sort((a, b) => a.start - b.start)) {
    let lane = lanes.find((l) => l.end <= c.start + 1e-6);
    if (!lane) {
      const id = `${prefix}${lanes.length + 1}`;
      lane = { id, end: 0 };
      lanes.push(lane);
      tracks.push({ ...makeTrack('audio', `${name} ${lanes.length}`), id });
    }
    c.trackId = lane.id;
    lane.end = c.start + c.duration;
  }
}

function mergeLook(base: ClipLook, over: Partial<ClipLook> | null, seed: number): ClipLook {
  return { ...base, ...(over ?? {}), seed };
}

export function assembleLiteTimeline(input: LiteAssemblyInput): LiteAssembly {
  const { spec, timing, takes, assets, aspect } = input;
  const issues: LiteAssemblyIssue[] = [];
  const issue = (severity: LiteAssemblyIssue['severity'], kind: string, message: string, sceneId: string | null = null, shotId: string | null = null, at: number | null = null) => issues.push({ severity, kind, message, sceneId, shotId, at });
  const D = timing.totalSec;
  const tracks: Track[] = [
    { ...makeTrack('video', 'Picture'), id: LITE_TRACKS.picture },
    { ...makeTrack('overlay', 'Foreground'), id: LITE_TRACKS.foreground },
    { ...makeTrack('caption', 'Subtitles'), id: LITE_TRACKS.subtitles, muted: !(spec.subtitles.enabled && spec.subtitles.burnIn) },
    { ...makeTrack('audio', 'Narration'), id: LITE_TRACKS.voice },
    { ...makeTrack('audio', 'Effects'), id: LITE_TRACKS.effects },
  ];
  const clips: Clip[] = [];
  const lastScene = timing.scenes[timing.scenes.length - 1];

  // ---- Picture --------------------------------------------------------------------------------
  let shotIndex = 0;
  for (const st of timing.scenes) {
    const scene = spec.scenes[st.index]!;
    if (st.blackSec > 0) {
      clips.push(makeClip({ id: `lb_${scene.id}`, trackId: LITE_TRACKS.picture, kind: 'title', start: st.blackStart, duration: r3(st.blackSec), text: '', style: { font: 'Inter', sizePct: 5, color: '#FFFFFF', background: '#000000', bold: false, italic: false, uppercase: false, outline: 0, shadow: false }, label: `Deliberate black · ${scene.title || `Scene ${st.index + 1}`}`, intentional: 'black' }));
    }
    if (!scene.shots.length) issue('error', 'no_shots', `${scene.title || `Scene ${st.index + 1}`} has no shots.`, scene.id);
    st.shots.forEach((sh, k) => {
      const shot = scene.shots[k]!;
      const isLast = st === lastScene && k === st.shots.length - 1;
      const duration = isLast ? r3(D - sh.start) : sh.duration;
      const imageId = shot.parallax?.backgroundAssetId ?? shotImageId(spec, shot);
      shotIndex++;
      if (!imageId) {
        issue('error', 'missing_image', `Shot ${k + 1} of ${scene.title || `scene ${st.index + 1}`} has no approved image.`, scene.id, shot.id, sh.start);
        return;
      }
      const info = assets[imageId];
      if (!info) issue('error', 'missing_asset', `The image of shot ${k + 1} in ${scene.title || `scene ${st.index + 1}`} is missing or not ready.`, scene.id, shot.id, sh.start);
      const firstOfScene = k === 0;
      let transitionIn: Clip['transitionIn'] = { type: 'cut', duration: 0 };
      if (firstOfScene && st.index > 0 && st.blackSec === 0) {
        if (scene.transitionIn === 'dissolve') transitionIn = { type: 'dissolve', duration: 1.2 };
        else if (scene.transitionIn === 'fade_black') transitionIn = { type: 'dip_black', duration: 1.4 };
      } else if (!firstOfScene && shot.transitionIn === 'dissolve') transitionIn = { type: 'dissolve', duration: 0.8 };
      const pre = clipPreroll({ transitionIn });
      const resolved = resolveShotMotion(shot.motion, { w: info?.width ?? null, h: info?.height ?? null }, { aspect, durationSec: duration + pre, outWidth: input.outWidth });
      for (const m of resolved.issues as MotionIssue[]) if (m.kind !== 'no_dimensions' || info) issue(m.severity, `motion_${m.kind}`, `${scene.title || `Scene ${st.index + 1}`}, shot ${k + 1}: ${m.message}`, scene.id, shot.id, sh.start);
      const look = mergeLook(spec.setup.look, shot.look, spec.setup.look.seed + shotIndex);
      const first = st.index === 0 && k === 0;
      clips.push(
        makeClip({
          id: `lc_${shot.id}`,
          trackId: LITE_TRACKS.picture,
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
          fadeIn: first ? Math.max(1, spec.sound.fadeInSec) : 0,
          fadeOut: isLast ? Math.max(1, spec.sound.fadeOutSec) : 0,
          label: `${scene.title || `Scene ${st.index + 1}`} · shot ${k + 1}`,
          shotId: shot.id,
        }),
      );
      if (shot.parallax?.foregroundAssetId) {
        const fgInfo = assets[shot.parallax.foregroundAssetId];
        if (!fgInfo) issue('warning', 'parallax_missing', `The foreground layer of ${scene.title || `scene ${st.index + 1}`}, shot ${k + 1} is not ready; the shot uses a plain move.`, scene.id, shot.id, sh.start);
        else {
          const fgMotion: ClipMotion = parallaxMotion(resolved.motion, shot.parallax.strength);
          clips.push(makeClip({ id: `lf_${shot.id}`, trackId: LITE_TRACKS.foreground, kind: 'image', start: sh.start, duration, assetId: shot.parallax.foregroundAssetId, fit: 'fill', motion: fgMotion, intentional: 'still', transitionIn, fadeIn: first ? Math.max(1, spec.sound.fadeInSec) : 0, fadeOut: isLast ? Math.max(1, spec.sound.fadeOutSec) : 0, label: `Foreground · shot ${k + 1}`, shotId: shot.id }));
        }
      }
    });
  }

  // ---- Narration ------------------------------------------------------------------------------
  const voiceClips: Clip[] = [];
  for (const st of timing.scenes) {
    const scene = spec.scenes[st.index]!;
    if (st.voiceAt === null) continue;
    const take = takes[scene.id];
    if (!take) {
      issue('error', 'missing_narration', `${scene.title || `Scene ${st.index + 1}`} has no narration yet (its length is an estimate).`, scene.id, null, st.voiceAt);
      continue;
    }
    const assetSec = assets[take.assetId]?.durationSec ?? take.outPoint;
    const clipIn = Math.max(take.inPoint, take.speechStart - 0.12);
    const clipOut = Math.min(take.outPoint, assetSec, take.speechEnd + 0.35);
    voiceClips.push(makeClip({ id: `lv_${scene.id}`, trackId: LITE_TRACKS.voice, kind: 'audio', start: r3(st.voiceAt - (take.speechStart - clipIn)), duration: r3(clipOut - clipIn), assetId: take.assetId, inPoint: r3(clipIn), sourceDuration: assetSec, useSourceAudio: false, volume: dbGain(spec.sound.levels.voiceDb), fadeIn: 0.03, fadeOut: 0.08, role: 'dialogue', label: `Narration · ${scene.title || `Scene ${st.index + 1}`}` }));
  }
  // Post-roll silence never overlaps the next line's pre-roll.
  voiceClips.sort((a, b) => a.start - b.start).forEach((c, i, all) => {
    const next = all[i + 1];
    if (next && c.start + c.duration > next.start) c.duration = r3(Math.max(0.1, next.start - c.start));
  });
  clips.push(...voiceClips);

  const speech = speechSpans(spec, timing, takes);
  const duck = spec.sound.duck;

  // ---- Music ----------------------------------------------------------------------------------
  const music: Clip[] = [];
  const xf = DEFAULT_SCORE_MIX.crossfadeSec;
  const musicGain = dbGain(spec.sound.levels.musicDb);
  if (spec.sound.music.mode === 'score' && !input.score?.movements.length) issue('warning', 'music_missing', 'The score has not been planned or composed yet — the film has no music (choose “No music” if that is deliberate).');
  if (spec.sound.music.mode === 'tracks' && !spec.sound.music.tracks.length) issue('warning', 'music_missing', 'No music track is chosen yet (choose “No music” if that is deliberate).');
  if (spec.sound.music.mode === 'score' && input.score) {
    const movements = [...input.score.movements].sort((a, b) => a.index - b.index);
    const ready = movements.filter((m) => m.assetId && m.durationSec);
    for (const m of movements) if (!m.assetId) issue('warning', 'music_missing', `Score movement ${m.index + 1} has not been generated yet — that part of the film has no music.`, null, null, m.start);
    ready.forEach((m, i) => {
      const span = movementSpan(m, timing, xf, i === 0, i === ready.length - 1);
      const fit = spec.sound.music.fit[m.id] ?? 'loop';
      const parts = fillSpan(span, m.durationSec!, { crossfadeSec: 3, loopFrom: m.durationSec! * 0.3, fit });
      const shortBy = span.end - span.start - m.durationSec!;
      if (shortBy > 0.5) {
        if (fit === 'loop') issue('info', 'music_extended', `Movement ${m.index + 1} is ${shortBy.toFixed(1)} s shorter than its scenes; it continues by crossfaded reuse — preview the join${parts[1] ? ` at ${fmt(parts[1].start)}` : ''}.`, null, null, parts[1]?.start ?? null);
        else issue('info', 'music_ends_early', `Movement ${m.index + 1} ends ${shortBy.toFixed(1)} s before its scenes do (fades out deliberately).`, null, null, span.start + m.durationSec!);
      }
      parts.forEach((p, k) => {
        const lastPart = k === parts.length - 1;
        const isFilmEnd = i === ready.length - 1 && lastPart && Math.abs(p.start + p.duration - D) < 0.05;
        const intensity = scoreAutomation(input.score!.cueSheet, { start: p.start, end: p.start + p.duration });
        music.push(
          makeClip({
            id: `lm_${m.id}_${k}`,
            trackId: 'lt_mus1',
            kind: 'audio',
            start: r3(p.start),
            duration: p.duration,
            assetId: m.assetId,
            inPoint: p.inPoint,
            sourceDuration: m.durationSec,
            useSourceAudio: false,
            volume: musicGain,
            fadeIn: k > 0 ? 3 : i === 0 ? Math.max(1.5, spec.sound.fadeInSec) : xf,
            fadeOut: isFilmEnd ? Math.max(2, spec.sound.fadeOutSec) : lastPart ? (i < ready.length - 1 ? xf : 3) : 3,
            role: 'music',
            duck: false,
            volumeAutomation: automation(p.start, p.duration, speech, duck, intensity),
            label: `Score · movement ${m.index + 1}${k ? ` (continued ${k})` : ''}`,
          }),
        );
      });
    });
  } else if (spec.sound.music.mode === 'tracks') {
    const placed = spec.sound.music.tracks
      .map((t) => ({ t, start: t.fromSceneId ? timing.scenes.find((s) => s.sceneId === t.fromSceneId)?.blackStart ?? 0 : 0 }))
      .sort((a, b) => a.start - b.start);
    placed.forEach(({ t, start }, i) => {
      const info = assets[t.assetId];
      if (!info?.durationSec) {
        issue('warning', 'music_missing', 'A music track is missing or still processing.', null, null, start);
        return;
      }
      const end = placed[i + 1] ? placed[i + 1]!.start + xf : D;
      const parts = fillSpan({ start, end }, info.durationSec, { crossfadeSec: 3, loopFrom: info.durationSec * 0.3, fit: t.fit });
      if (end - start - info.durationSec > 0.5) issue('info', t.fit === 'loop' ? 'music_extended' : 'music_ends_early', t.fit === 'loop' ? `A music track is extended by crossfaded reuse — preview the join${parts[1] ? ` at ${fmt(parts[1].start)}` : ''}.` : `A music track ends ${(end - start - info.durationSec).toFixed(1)} s early (fades out).`, null, null, parts[1]?.start ?? start + info.durationSec);
      parts.forEach((p, k) => {
        const lastPart = k === parts.length - 1;
        const isFilmEnd = lastPart && Math.abs(p.start + p.duration - D) < 0.05;
        music.push(makeClip({ id: `lm_${t.id}_${k}`, trackId: 'lt_mus1', kind: 'audio', start: r3(p.start), duration: p.duration, assetId: t.assetId, inPoint: p.inPoint, sourceDuration: info.durationSec, useSourceAudio: false, volume: dbGain(spec.sound.levels.musicDb + t.gainDb), fadeIn: k > 0 ? 3 : i === 0 ? Math.max(1.5, spec.sound.fadeInSec) : xf, fadeOut: isFilmEnd ? Math.max(2, spec.sound.fadeOutSec) : 3, role: 'music', duck: false, volumeAutomation: automation(p.start, p.duration, speech, duck, null), label: `Music · track ${i + 1}${k ? ` (continued ${k})` : ''}` }));
      });
    });
  }
  assignTracks(music, 'lt_mus', 'Music', tracks);
  clips.push(...music);

  // ---- Ambience -------------------------------------------------------------------------------
  const amb: Clip[] = [];
  const runs: { key: string; kind: string; assetId: string | null; levelDb: number; start: number; end: number; sceneId: string }[] = [];
  for (const st of timing.scenes) {
    const s = spec.scenes[st.index]!;
    const a = s.ambience;
    if (a.kind === 'none') continue;
    const key = a.kind === 'upload' ? `u:${a.assetId ?? ''}` : `s:${a.kind}`;
    const end = st === lastScene ? D : st.start + st.duration;
    const last = runs[runs.length - 1];
    if (last && last.key === key && Math.abs(last.end - st.blackStart) < 0.05) last.end = end;
    else runs.push({ key, kind: a.kind, assetId: a.kind === 'upload' ? a.assetId : input.ambience[a.kind as AmbienceKind]?.assetId ?? null, levelDb: a.levelDb, start: st.blackStart, end, sceneId: s.id });
  }
  runs.forEach((run, i) => {
    const src = run.assetId ? (run.kind === 'upload' ? assets[run.assetId]?.durationSec : input.ambience[run.kind as AmbienceKind]?.durationSec) ?? null : null;
    if (!run.assetId || !src) {
      issue('info', 'ambience_missing', run.kind === 'upload' ? 'An uploaded ambience file is missing or still processing.' : `The ${run.kind} ambience bed has not been made yet.`, run.sceneId, null, run.start);
      return;
    }
    const start = Math.max(0, run.start - (i > 0 ? 1.5 : 0));
    const end = Math.min(D, run.end + (i < runs.length - 1 ? 1.5 : 0));
    const parts = fillSpan({ start, end }, src, { crossfadeSec: 4, loopFrom: run.kind === 'upload' ? src * 0.1 : 0, fit: 'loop' });
    const gain = dbGain(spec.sound.levels.ambienceDb + run.levelDb);
    parts.forEach((p, k) => {
      const atEnd = Math.abs(p.start + p.duration - D) < 0.05;
      amb.push(makeClip({ id: `la_${i}_${k}`, trackId: 'lt_amb1', kind: 'audio', start: r3(p.start), duration: p.duration, assetId: run.assetId, inPoint: p.inPoint, sourceDuration: src, useSourceAudio: false, volume: gain, fadeIn: k > 0 ? 4 : 2.5, fadeOut: atEnd ? Math.max(2, spec.sound.fadeOutSec) : k < parts.length - 1 ? 4 : 2.5, role: 'effects', duck: false, volumeAutomation: automation(p.start, p.duration, speech, { ...duck, depthDb: duck.depthDb * 0.5 }, null), label: `Ambience · ${run.kind === 'upload' ? 'uploaded' : run.kind}` }));
    });
  });
  assignTracks(amb, 'lt_amb', 'Ambience', tracks);
  clips.push(...amb);

  // ---- Sound cues -----------------------------------------------------------------------------
  for (const st of timing.scenes) {
    const s = spec.scenes[st.index]!;
    const cue = s.soundCue;
    if (!cue?.assetId) continue;
    const info = assets[cue.assetId];
    if (!info?.durationSec) {
      issue('warning', 'cue_missing', `The sound cue “${cue.label || 'effect'}” in ${s.title || `scene ${st.index + 1}`} is missing or still processing.`, s.id);
      continue;
    }
    const start = r3(st.start + Math.max(0, cue.atSec));
    const duration = r3(Math.min(info.durationSec, D - start));
    if (duration < 0.1) continue;
    clips.push(makeClip({ id: `lx_${s.id}`, trackId: LITE_TRACKS.effects, kind: 'audio', start, duration, assetId: cue.assetId, sourceDuration: info.durationSec, useSourceAudio: false, volume: dbGain(spec.sound.levels.effectsDb + cue.levelDb), fadeIn: 0.02, fadeOut: Math.min(0.5, duration / 3), role: 'effects', label: `Sound · ${cue.label || 'effect'}` }));
  }

  // ---- Subtitles ------------------------------------------------------------------------------
  const cues = spec.subtitles.enabled ? buildLiteCues(spec.scenes, timing, takes, spec.subtitles, aspect) : [];
  if (cues.length && spec.subtitles.burnIn) {
    const sample = cues.map((c) => c.text).join(' ');
    const look = liteCaptionStyle(spec.subtitles, aspect, sample);
    if (look.fontSubstituted) issue('info', 'font_substituted', `${spec.subtitles.font} cannot show every letter of the narration (for example Kasem letters); subtitles use Noto Sans instead.`);
    cues.forEach((c, i) => clips.push(makeClip({ id: `ls_${i}`, trackId: LITE_TRACKS.subtitles, kind: 'caption', start: r3(c.start), duration: r3(Math.max(0.3, c.end - c.start)), text: c.text, style: look.style, position: look.position, fadeIn: 0.12, fadeOut: 0.12, label: 'Subtitle' })));
  }
  if (cues.some((c) => c.timing === 'estimated')) issue('warning', 'subtitles_estimated', 'Some subtitles are not timed from the audio yet (their words are spread evenly over the speech) — time the narration, or edit the cues, before export.', cues.find((c) => c.timing === 'estimated')!.sceneId);

  const state: TimelineState = { tracks, clips: clips.sort((a, b) => a.start - b.start), markers: timing.scenes.map((s) => ({ id: `m_${s.sceneId}`, time: s.blackStart, label: spec.scenes[s.index]!.title || `Scene ${s.index + 1}`, color: '#8ab6ff' })), fps: spec.setup.fps, aspectRatio: aspect, beatGrid: null };
  for (const p of validateTimeline(state)) issue('error', 'timeline', p);
  return { state, cues, issues, durationSec: D, speech };
}

function fmt(t: number): string {
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}
