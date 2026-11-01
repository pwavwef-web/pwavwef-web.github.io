import { dbGain, type LiteAssetInfo } from './lite-assemble';
import { cuesFromWords, cueProblems, estimatedWords, SUBTITLE_LINE_CHARS, type LiteCue } from './lite-subtitles';
import { resolveShotMotion, type ShotMotion } from './motion';
import { DEFAULT_TEXT_STYLE, makeClip, makeTrack, validateTimeline, type TimelineState } from './timeline';
import type { Clip, TextStyle, Track } from './types';
import { sceneDurations, sceneVoiceHash, type AdScene, type LinkAdDoc } from './linkad';
import { VERTICAL_ZONES } from './linkad-checks';

/**
 * Link to Ad: builds the ad's composition as an ordinary AZ Studio timeline (9:16): approved pictures with a
 * gentle camera move, exact text drawn by the compositor (never inside a picture), narration placed from the
 * measured speech, captions timed from the real audio and optional music ducked under the voice. The same
 * persisted timeline drives the browser preview and the FFmpeg render.
 */

export const AD_TRACKS = { picture: 'ad_pic', frame: 'ad_frame', logo: 'ad_logo', text: 'ad_text', line: 'ad_line', captions: 'ad_cap', voice: 'ad_voice', music: 'ad_music' } as const;

/** Top/bottom distances (fraction of frame height) for each text role. Matches VERTICAL_ZONES. */
const POS = {
  upper: { anchor: 'top' as const, offset: VERTICAL_ZONES.overlayUpper.from + 0.02 },
  middle: { anchor: 'top' as const, offset: VERTICAL_ZONES.overlayMiddle.from + 0.01 },
  lower: { anchor: 'bottom' as const, offset: 1 - VERTICAL_ZONES.overlayLower.to },
  caption: { anchor: 'bottom' as const, offset: 1 - VERTICAL_ZONES.captions.to },
  closingHeadline: { anchor: 'top' as const, offset: VERTICAL_ZONES.closingHeadline.from },
  closingLine: { anchor: 'top' as const, offset: VERTICAL_ZONES.closingLine.from },
};
/** Where a picture that cannot fill the vertical frame is shown: framed on the brand colour, clear of the text zones. */
export const FRAME_BOX = { x: 0.05, y: VERTICAL_ZONES.overlayUpper.to, w: 0.9, h: VERTICAL_ZONES.captions.from - VERTICAL_ZONES.overlayUpper.to - 0.02 };
export const LOGO_BOX = { x: 0.3, y: VERTICAL_ZONES.logoCta.from, w: 0.4, h: VERTICAL_ZONES.logoCta.to - VERTICAL_ZONES.logoCta.from };

export interface LinkAdAssemblyIssue {
  severity: 'error' | 'warning' | 'info';
  kind: string;
  message: string;
  sceneId: string | null;
}

export interface LinkAdAssemblyInput {
  doc: LinkAdDoc;
  /** Studio assets by id (dimensions, duration). */
  assets: Record<string, LiteAssetInfo>;
  outWidth: number;
}

export interface AdAssembly {
  state: TimelineState;
  issues: LinkAdAssemblyIssue[];
  durationSec: number;
  cues: LiteCue[];
  windows: { sceneId: string; start: number; end: number; speechStart: number | null; speechEnd: number | null }[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const FPS = 30;
/** Whether a picture fills the frame is decided at the final export width, so a draft preview is composed exactly like the final. */
const FRAMING_WIDTH = 1080;

function motionFor(scene: AdScene): ShotMotion {
  const preset = scene.motion === 'still' ? 'still' : scene.motion;
  return { preset, intensity: 0.06, focal: scene.focal, focalSize: null, ease: 'gentle', manual: null };
}

export function assembleLinkAd(input: LinkAdAssemblyInput): AdAssembly {
  const { doc, assets } = input;
  const { ad, brief } = doc;
  const issues: LinkAdAssemblyIssue[] = [];
  const issue = (severity: LinkAdAssemblyIssue['severity'], kind: string, message: string, sceneId: string | null = null) => issues.push({ severity, kind, message, sceneId });
  const tracks: Track[] = [
    { ...makeTrack('video', 'Pictures'), id: AD_TRACKS.picture },
    { ...makeTrack('overlay', 'Framed pictures'), id: AD_TRACKS.frame },
    { ...makeTrack('overlay', 'Logo'), id: AD_TRACKS.logo },
    { ...makeTrack('caption', 'On-screen text'), id: AD_TRACKS.text },
    { ...makeTrack('caption', 'Destination'), id: AD_TRACKS.line },
    { ...makeTrack('caption', 'Captions'), id: AD_TRACKS.captions, muted: !ad.captions.enabled },
    { ...makeTrack('audio', 'Voice'), id: AD_TRACKS.voice },
    { ...makeTrack('audio', 'Music'), id: AD_TRACKS.music },
  ];
  const clips: Clip[] = [];
  const refs = new Map(doc.source.assets.map((a) => [a.id, a]));
  const durations = sceneDurations(ad, brief.voice, brief.voiceDirection);
  const windows: AdAssembly['windows'] = [];
  const cues: LiteCue[] = [];
  const fontOf = ad.brand.font;
  // Scenes sit on the frame grid exactly (whole frames, not rounded milliseconds): a cut falling between two frames
  // would leave one frame of the picture track uncovered, which the renderer shows as a flash of black.
  let frame = 0;

  ad.scenes.forEach((scene, i) => {
    const d = durations[i]!;
    const frames = Math.max(1, Math.round(d.sec * FPS));
    const start = frame / FPS;
    const dur = frames / FPS;
    frame += frames;
    const end = frame / FPS;
    const first = i === 0;
    const last = i === ad.scenes.length - 1;
    const label = `Scene ${i + 1}`;
    const hasClosing = last && Boolean(ad.closing.headline.trim() || ad.closing.line.trim());
    // The closing scene is text-led so the call to action, destination and logo stay readable.
    const ref = scene.assetId && !hasClosing ? refs.get(scene.assetId) : undefined;
    if (scene.assetId && hasClosing) issue('info', 'closing_text_led', `${label}: the closing scene is shown on the brand colour so the call to action stays readable; its picture is not used.`, scene.id);
    const info = ref?.assetId ? assets[ref.assetId] : undefined;

    // ---- Picture or brand ground ----
    let framed = false;
    if (ref && ref.assetId && ref.status === 'stored') {
      if (!info) issue('error', 'missing_asset', `${label}'s picture is missing or still being checked.`, scene.id);
      const resolved = resolveShotMotion(motionFor(scene), { w: info?.width ?? null, h: info?.height ?? null }, { aspect: '9:16', durationSec: dur, outWidth: FRAMING_WIDTH });
      const tooSoft = resolved.issues.some((m) => m.kind === 'blurry');
      if (tooSoft) {
        // Filling the tall frame would enlarge the picture until it is visibly soft: show it whole, framed, on the brand colour.
        framed = true;
        issue('info', 'framed', `${label}: the picture is shown framed because filling the vertical frame would make it soft.`, scene.id);
        clips.push(makeClip({ id: `ad_pic_${scene.id}`, trackId: AD_TRACKS.picture, kind: 'title', start, duration: dur, text: '', style: { ...DEFAULT_TEXT_STYLE, background: ad.brand.background }, intentional: 'still', fadeIn: first ? 0.25 : 0, fadeOut: last ? 0.5 : 0, label: `${label} · brand colour`, shotId: scene.id }));
        clips.push(makeClip({ id: `ad_frame_${scene.id}`, trackId: AD_TRACKS.frame, kind: 'image', start, duration: dur, assetId: ref.assetId, label, fit: 'fit', layout: { box: FRAME_BOX, radius: 0.04, shadow: true, push: scene.motion === 'still' ? 0 : 0.03 }, fadeIn: first ? 0.3 : 0.2, fadeOut: last ? 0.5 : 0, shotId: scene.id }));
        if (info?.width && info.height && Math.max(info.width, info.height) < 640) issue('warning', 'small_picture', `${label}: the picture is small (${info.width}×${info.height}) even framed.`, scene.id);
      } else {
        for (const m of resolved.issues) if (m.kind !== 'no_dimensions' || info) issue(m.severity === 'error' ? 'error' : m.severity === 'warning' ? 'warning' : 'info', `motion_${m.kind}`, `${label}: ${m.message}`, scene.id);
        clips.push(
          makeClip({
            id: `ad_pic_${scene.id}`,
            trackId: AD_TRACKS.picture,
            kind: 'image',
            start,
            duration: dur,
            assetId: ref.assetId,
            fit: 'fill',
            kenBurns: false,
            motion: resolved.motion,
            intentional: 'still',
            transitionIn: !first && dur > 1 ? { type: 'dissolve', duration: 0.25 } : { type: 'cut', duration: 0 },
            fadeIn: first ? 0.25 : 0,
            fadeOut: last ? 0.5 : 0,
            label,
            shotId: scene.id,
          }),
        );
      }
    } else {
      if (scene.assetId) issue('error', 'missing_asset', `${label} uses a picture that is not available.`, scene.id);
      clips.push(
        makeClip({
          id: `ad_pic_${scene.id}`,
          trackId: AD_TRACKS.picture,
          kind: 'title',
          start,
          duration: dur,
          text: '',
          style: { ...DEFAULT_TEXT_STYLE, background: ad.brand.background },
          intentional: 'still',
          fadeIn: first ? 0.25 : 0,
          fadeOut: last ? 0.5 : 0,
          label: `${label} · brand colour`,
          shotId: scene.id,
        }),
      );
    }

    // ---- On-screen text (exact text drawn by the compositor) ----
    const textLed = !(ref && ref.assetId) || framed;
    if (scene.overlay.trim() && !hasClosing) {
      // Over a framed picture the text always sits above it, clear of the picture.
      const pos = framed ? POS.upper : POS[scene.overlayPos];
      const style: TextStyle = {
        ...DEFAULT_TEXT_STYLE,
        font: fontOf,
        sizePct: textLed ? 5.2 : 4.2,
        color: textLed ? ad.brand.text : '#FFFFFF',
        // A dark panel behind text on pictures keeps it readable on any photo.
        background: textLed ? null : '#000000',
        bold: true,
        outline: textLed ? 0 : 0,
        shadow: false,
      };
      clips.push(makeClip({ id: `ad_txt_${scene.id}`, trackId: AD_TRACKS.text, kind: 'caption', start: r3(start + 0.15), duration: r3(Math.max(0.6, dur - 0.35)), text: scene.overlay.trim(), style, position: { anchor: pos.anchor, offset: pos.offset, align: 'center' }, fadeIn: 0.25, fadeOut: 0.2, label: `${label} · text` }));
    }
    if (last) {
      // Closing call to action: headline and destination, logo above them.
      if (ad.closing.headline.trim()) clips.push(makeClip({ id: 'ad_cta_head', trackId: AD_TRACKS.text, kind: 'caption', start: r3(start + 0.1), duration: r3(dur - 0.15), text: ad.closing.headline.trim(), style: { ...DEFAULT_TEXT_STYLE, font: fontOf, sizePct: 5, color: ad.brand.text, background: null, bold: true, outline: textLed ? 0 : 2.4, shadow: !textLed }, position: { anchor: 'top', offset: POS.closingHeadline.offset, align: 'center' }, fadeIn: 0.3, fadeOut: 0.3, label: 'Closing · call to action' }));
      if (ad.closing.line.trim()) {
        // The destination sits below the headline; a headline long enough to wrap to three lines would run into it, so it moves down.
        clips.push(makeClip({ id: 'ad_cta_line', trackId: AD_TRACKS.line, kind: 'caption', start: r3(start + 0.3), duration: r3(dur - 0.35), text: ad.closing.line.trim(), style: { ...DEFAULT_TEXT_STYLE, font: fontOf, sizePct: 3.4, color: ad.brand.accent, background: textLed ? null : '#000000', bold: true, outline: 0, shadow: false }, position: { anchor: 'top', offset: POS.closingLine.offset, align: 'center' }, fadeIn: 0.3, fadeOut: 0.3, label: 'Closing · destination' }));
      }
      const logo = brief.logoId ? refs.get(brief.logoId) : undefined;
      if (ad.closing.showLogo && logo?.assetId && logo.status === 'stored') {
        clips.push(makeClip({ id: 'ad_logo', trackId: AD_TRACKS.logo, kind: 'image', start: r3(start + 0.1), duration: r3(dur - 0.15), assetId: logo.assetId, label: 'Logo', fit: 'fit', layout: { box: LOGO_BOX, radius: 0, shadow: false, push: 0 }, fadeIn: 0.4 }));
      }
    }

    // ---- Voice and captions ----
    const take = ad.takes[scene.id];
    const current = Boolean(take && take.hash === sceneVoiceHash(scene, brief.voice, brief.voiceDirection));
    if (scene.narration.trim() && take && current) {
      const lead = d.lead;
      const inPoint = r3(Math.max(0, take.speechStart - 0.12));
      const audioStart = r3(start + lead - (take.speechStart - inPoint));
      const audioLen = r3(Math.min(take.fileSec - inPoint, take.speechEnd - inPoint + 0.2));
      clips.push(makeClip({ id: `ad_voice_${scene.id}`, trackId: AD_TRACKS.voice, kind: 'audio', start: Math.max(0, audioStart), duration: Math.max(0.1, audioLen), assetId: take.assetId, inPoint, sourceDuration: take.fileSec, useSourceAudio: false, role: 'dialogue', volume: dbGain(ad.voiceGainDb), label: `${label} · voice`, shotId: scene.id }));
      const offset = start + lead - take.speechStart;
      const words = take.words.length ? take.words : estimatedWords(scene.narration, take.speechStart, take.speechEnd);
      const sceneCues = cuesFromWords(words, { maxChars: Math.floor(SUBTITLE_LINE_CHARS['9:16'] * (3.1 / ad.captions.sizePct)), maxLines: 2, offset, sceneId: scene.id, timing: take.words.length && take.alignment === 'aligned' ? 'aligned' : 'estimated' });
      // Captions never run past their own scene.
      for (const c of sceneCues) cues.push({ ...c, end: Math.min(c.end, end - 0.02) });
    } else if (scene.narration.trim()) {
      issue('error', 'no_voice', `${label} has no current voice recording yet.`, scene.id);
    }
    windows.push({ sceneId: scene.id, start, end, speechStart: take && current ? r3(start + d.lead) : null, speechEnd: take && current ? r3(start + d.lead + (take.speechEnd - take.speechStart)) : null });
  });

  const D = frame / FPS;
  if (D > 0 && ad.captions.enabled) {
    const box = ad.captions.preset === 'boxed';
    const style: TextStyle = {
      ...DEFAULT_TEXT_STYLE,
      font: ad.captions.font,
      sizePct: ad.captions.sizePct,
      color: ad.captions.color,
      background: box ? '#000000' : null,
      bold: ad.captions.preset !== 'clean',
      outline: ad.captions.preset === 'bold' ? 2.6 : ad.captions.preset === 'clean' ? 1.4 : 0,
      shadow: !box,
    };
    cues.forEach((c, k) => {
      if (c.end - c.start < 0.1) return;
      clips.push(makeClip({ id: `ad_cap_${k}`, trackId: AD_TRACKS.captions, kind: 'caption', start: c.start, duration: r3(c.end - c.start), text: c.text, style, position: { anchor: POS.caption.anchor, offset: POS.caption.offset, align: 'center' }, label: `Caption ${k + 1}` }));
    });
    for (const p of cueProblems(cues)) if (p.kind !== 'too_short') issue(p.kind === 'overlap' ? 'error' : 'warning', `caption_${p.kind}`, p.message, p.sceneId);
  }

  // ---- Music ----
  if (ad.music.assetId && D > 0) {
    const m = assets[ad.music.assetId];
    if (!m) issue('error', 'music_missing', 'The chosen music is missing or still being checked.');
    else {
      const avail = m.durationSec ?? D;
      const len = r3(Math.min(D, avail));
      if (avail + 0.05 < D) issue('warning', 'music_short', `The music is ${avail.toFixed(1)} s long and the ad runs ${D.toFixed(1)} s, so the music stops early.`);
      clips.push(makeClip({ id: 'ad_music', trackId: AD_TRACKS.music, kind: 'audio', start: 0, duration: len, assetId: ad.music.assetId, inPoint: 0, sourceDuration: m.durationSec ?? null, useSourceAudio: false, role: 'music', duck: true, duckDb: 9, volume: dbGain(ad.music.gainDb), fadeIn: 0.6, fadeOut: Math.min(1.5, len / 4), label: ad.music.title || 'Music' }));
    }
  }

  const state: TimelineState = { tracks, clips: clips.sort((a, b) => a.start - b.start), markers: windows.map((w, i) => ({ id: `m_${w.sceneId}`, time: w.start, label: `Scene ${i + 1}`, color: '#f4b84a' })), fps: 30, aspectRatio: '9:16', beatGrid: null };
  for (const p of validateTimeline(state)) issue('error', 'timeline', p);
  return { state, issues, durationSec: D, cues, windows };
}
