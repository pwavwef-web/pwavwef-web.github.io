import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { aspectToRatio, type Clip, type TextStyle, type TimelineState, type Track } from '@az-studio/shared';
import { useMediaUrls } from '../../lib/media';

/**
 * Real-time preview compositor (monitoring only — exports are rendered by FFmpeg on Cloud Run).
 * Layers video/image/title/caption clips per track order and keeps media elements in sync with a
 * master clock.
 */

const LOOKAHEAD = 4;

function preroll(c: Clip) {
  const t = c.transitionIn;
  return t.type === 'dissolve' || t.type === 'slide_left' || t.type === 'slide_right' ? t.duration : 0;
}

function layerStyle(c: Clip, t: number, nextDipBlack: number): CSSProperties {
  const tr = c.transitionIn;
  const local = t - c.start;
  let opacity = 1;
  let transform = '';
  if (tr.type === 'dissolve' && local < 0) opacity = Math.max(0, 1 + local / tr.duration);
  if (tr.type === 'dip_black' && local < tr.duration / 2) opacity = Math.min(1, local / (tr.duration / 2));
  if ((tr.type === 'slide_left' || tr.type === 'slide_right') && local < 0) {
    const p = 1 + local / tr.duration;
    transform = `translateX(${(tr.type === 'slide_left' ? 1 : -1) * (1 - p) * 100}%)`;
  }
  if (c.fadeIn > 0 && local < c.fadeIn) opacity = Math.min(opacity, Math.max(0, local / c.fadeIn));
  const toEnd = c.start + c.duration - t;
  if (c.fadeOut > 0 && toEnd < c.fadeOut) opacity = Math.min(opacity, Math.max(0, toEnd / c.fadeOut));
  if (nextDipBlack > 0 && toEnd < nextDipBlack) opacity = Math.min(opacity, Math.max(0, toEnd / nextDipBlack));
  return { opacity, transform };
}

function textCss(style: TextStyle | null, heightPx: number): CSSProperties {
  const s = style ?? { font: 'Inter', sizePct: 5, color: '#fff', background: null, bold: true, italic: false, uppercase: false, outline: 2, shadow: true };
  const fonts: Record<string, string> = { Inter: '"Inter Variable", Inter, sans-serif', 'EB Garamond': '"EB Garamond", Georgia, serif', 'DejaVu Sans': '"DejaVu Sans", Verdana, sans-serif', 'Noto Sans': '"Noto Sans", Arial, sans-serif' };
  const outline = Math.max(0, (s.outline * heightPx) / 1080);
  return {
    fontFamily: fonts[s.font] ?? fonts.Inter,
    fontSize: `${(s.sizePct / 100) * heightPx}px`,
    color: s.color,
    fontWeight: s.bold ? 700 : 400,
    fontStyle: s.italic ? 'italic' : 'normal',
    textTransform: s.uppercase ? 'uppercase' : 'none',
    lineHeight: 1.15,
    textShadow: [outline > 0 ? `0 0 ${outline}px #000, 0 0 ${outline}px #000` : '', s.shadow ? `0 ${Math.max(1, heightPx / 540)}px ${Math.max(2, heightPx / 270)}px rgba(0,0,0,0.8)` : ''].filter(Boolean).join(', ') || undefined,
    whiteSpace: 'pre-wrap',
  };
}

function VisualLayer({ clip, t, playing, heightPx, nextDipBlack, zIndex }: { clip: Clip; t: number; playing: boolean; heightPx: number; nextDipBlack: number; zIndex: number }) {
  const urls = useMediaUrls(clip.assetId);
  const ref = useRef<HTMLVideoElement>(null);
  const expected = clip.inPoint + (t - clip.start);
  const visible = t >= clip.start - preroll(clip) && t < clip.start + clip.duration;
  useEffect(() => {
    const v = ref.current;
    if (!v || clip.kind !== 'video') return;
    const target = Math.max(0, expected);
    if (!playing || !visible) {
      v.pause();
      if (Math.abs(v.currentTime - target) > 0.04) v.currentTime = target;
      return;
    }
    if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target;
    if (v.paused) void v.play().catch(() => undefined);
  }, [expected, playing, visible, clip.kind]);
  useEffect(() => {
    const v = ref.current;
    if (v) v.muted = true; // Audio is played by the audio layer so volume/mute rules apply.
  }, []);
  const style = layerStyle(clip, t, nextDipBlack);
  const fit = clip.fit === 'fit' || clip.fit === 'blur' ? 'contain' : 'cover';
  const kb = clip.kenBurns && clip.kind === 'image' ? `scale(${1 + 0.12 * Math.min(1, Math.max(0, (t - clip.start) / clip.duration))})` : '';
  const src = clip.kind === 'image' ? urls?.file ?? urls?.thumb : urls?.file;
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ ...style, zIndex, visibility: visible ? 'visible' : 'hidden' }}>
      {clip.fit === 'blur' && (clip.kind === 'image' ? urls?.file : urls?.poster) && <img src={clip.kind === 'image' ? urls?.file : urls?.poster} alt="" className="absolute inset-0 size-full scale-110 object-cover blur-2xl brightness-75" />}
      {clip.kind === 'video' && src ? (
        <video ref={ref} src={src} className="absolute inset-0 size-full" style={{ objectFit: fit }} muted playsInline preload="auto" />
      ) : clip.kind === 'image' && src ? (
        <img src={src} alt="" className="absolute inset-0 size-full" style={{ objectFit: fit, transform: kb, transition: playing ? 'none' : 'transform 120ms' }} />
      ) : null}
      {clip.kind === 'title' && (
        <div className="absolute inset-0 flex p-[6%]" style={{ background: clip.style?.background ?? 'transparent', alignItems: clip.position?.anchor === 'top' ? 'flex-start' : clip.position?.anchor === 'bottom' ? 'flex-end' : 'center', justifyContent: clip.position?.align === 'left' ? 'flex-start' : clip.position?.align === 'right' ? 'flex-end' : 'center', textAlign: clip.position?.align ?? 'center' }}>
          <span style={textCss(clip.style, heightPx)}>{clip.text}</span>
        </div>
      )}
    </div>
  );
}

function CaptionLayer({ clip, heightPx, t }: { clip: Clip; heightPx: number; t: number }) {
  const s = clip.style;
  const pos = clip.position ?? { anchor: 'bottom', offset: 0.08, align: 'center' };
  const style = layerStyle({ ...clip, transitionIn: { type: 'cut', duration: 0 } }, t, 0);
  const boxed = Boolean(s?.background);
  return (
    <div className="pointer-events-none absolute inset-x-[6%] flex" style={{ opacity: style.opacity, zIndex: 50, justifyContent: pos.align === 'left' ? 'flex-start' : pos.align === 'right' ? 'flex-end' : 'center', ...(pos.anchor === 'top' ? { top: `${pos.offset * 100}%` } : pos.anchor === 'bottom' ? { bottom: `${pos.offset * 100}%` } : { top: '50%', transform: 'translateY(-50%)' }) }}>
      <span style={{ ...textCss(s, heightPx), textAlign: pos.align, ...(boxed ? { background: s?.background ?? '#000', padding: '0.15em 0.45em', borderRadius: 4 } : {}) }}>
        {clip.karaoke?.length && clip.lyric && clip.lyric.mode !== 'line' && clip.lyric.mode !== 'subtitle'
          ? clip.karaoke.map((u, i) => (
              <span key={i} style={{ color: t - clip.start >= u.start ? (s?.highlight ?? '#F4B84A') : undefined }}>
                {u.text}
                {i < clip.karaoke!.length - 1 ? ' ' : ''}
              </span>
            ))
          : clip.text}
      </span>
    </div>
  );
}

function AudioLayer({ clip, track, t, playing, media }: { clip: Clip; track: Track | undefined; t: number; playing: boolean; media: 'audio' | 'video' }) {
  const urls = useMediaUrls(clip.assetId);
  const ref = useRef<HTMLMediaElement>(null);
  const active = t >= clip.start && t < clip.start + clip.duration;
  const expected = clip.inPoint + (t - clip.start);
  const local = t - clip.start;
  const toEnd = clip.start + clip.duration - t;
  let gain = clip.volume * (track?.kind === 'audio' ? track.volume : 1);
  if (clip.fadeIn > 0 && local < clip.fadeIn) gain *= Math.max(0, local / clip.fadeIn);
  if (clip.fadeOut > 0 && toEnd < clip.fadeOut) gain *= Math.max(0, toEnd / clip.fadeOut);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, gain));
    if (!playing || !active) {
      el.pause();
      return;
    }
    if (Math.abs(el.currentTime - expected) > 0.25) el.currentTime = Math.max(0, expected);
    if (el.paused) void el.play().catch(() => undefined);
  }, [playing, active, expected, gain]);
  if (!urls?.file) return null;
  return media === 'audio' ? <audio ref={ref as React.RefObject<HTMLAudioElement>} src={urls.file} preload="auto" /> : <video ref={ref as React.RefObject<HTMLVideoElement>} src={urls.file} preload="auto" className="hidden" playsInline />;
}

export function Preview({ state, time, playing, className }: { state: TimelineState; time: number; playing: boolean; className?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [heightPx, setHeightPx] = useState(360);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setHeightPx(Math.max(1, e!.contentRect.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const trackIndex = useMemo(() => new Map(state.tracks.map((t, i) => [t.id, i])), [state.tracks]);
  const hidden = useMemo(() => new Set(state.tracks.filter((t) => t.muted).map((t) => t.id)), [state.tracks]);
  const tracksById = useMemo(() => new Map(state.tracks.map((t) => [t.id, t])), [state.tracks]);
  const layerOrder = (c: Clip) => {
    const tr = tracksById.get(c.trackId);
    const kindRank = tr?.kind === 'video' ? 0 : tr?.kind === 'overlay' ? 100 : 200;
    return kindRank + (trackIndex.get(c.trackId) ?? 0);
  };
  const near = (c: Clip) => c.start - preroll(c) - LOOKAHEAD < time && c.start + c.duration > time - 1;
  const visuals = state.clips.filter((c) => (c.kind === 'video' || c.kind === 'image' || c.kind === 'title') && !hidden.has(c.trackId) && near(c));
  const captions = state.clips.filter((c) => c.kind === 'caption' && !hidden.has(c.trackId) && time >= c.start && time < c.start + c.duration);
  const audible = state.clips.filter((c) => !hidden.has(c.trackId) && c.assetId && near(c) && (c.kind === 'audio' || (c.kind === 'video' && c.useSourceAudio)));
  const dipBlackBefore = (c: Clip) => {
    const next = state.clips.find((n) => n.trackId === c.trackId && Math.abs(n.start - (c.start + c.duration)) < 0.05 && n.transitionIn.type === 'dip_black');
    return next ? next.transitionIn.duration / 2 : 0;
  };
  const whiteFlash = state.clips
    .filter((c) => c.transitionIn.type === 'dip_white' && Math.abs(time - c.start) < c.transitionIn.duration / 2)
    .reduce((m, c) => Math.max(m, 1 - Math.abs(time - c.start) / (c.transitionIn.duration / 2)), 0);

  return (
    <div ref={wrap} className={className} style={{ aspectRatio: String(aspectToRatio(state.aspectRatio)) }}>
      <div className="relative size-full overflow-hidden rounded-lg bg-black">
        {visuals.map((c) => (
          <VisualLayer key={c.id} clip={c} t={time} playing={playing} heightPx={heightPx} nextDipBlack={dipBlackBefore(c)} zIndex={layerOrder(c)} />
        ))}
        {whiteFlash > 0 && <div className="absolute inset-0 bg-white" style={{ opacity: whiteFlash, zIndex: 400 }} />}
        {captions.map((c) => (
          <CaptionLayer key={c.id} clip={c} heightPx={heightPx} t={time} />
        ))}
        {audible.map((c) => (
          <AudioLayer key={`a-${c.id}`} clip={c} track={tracksById.get(c.trackId)} t={time} playing={playing} media={c.kind === 'audio' ? 'audio' : 'video'} />
        ))}
      </div>
    </div>
  );
}
