import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Pause, Play, SkipBack } from 'lucide-react';
import { aspectToRatio, automationGain, clipMotionProgress, clipPreroll, formatTimecode, motionRectAt, type Clip, type TimelineState } from '@az-studio/shared';
import { getMediaUrls } from '../../lib/media';
import { cx, IconButton } from '../ui';

/**
 * Faithful preview of a Film Studio Lite composition. Every frame is drawn from the persisted timeline
 * with the same timing and the same camera path (`motionRectAt` / `clipMotionProgress`) the renderer
 * uses, so what is approved here is what exports. Grain and haze are approximations of the local render;
 * a draft render shows the exact pixels.
 */

export interface PlayerHandle {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number) => void;
  time: () => number;
}

const images = new Map<string, Promise<HTMLImageElement>>();
function loadImage(assetId: string): Promise<HTMLImageElement> {
  let p = images.get(assetId);
  if (!p) {
    p = getMediaUrls(assetId).then(
      (u) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.decoding = 'async';
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('image failed to load'));
          img.src = u.file ?? u.poster ?? u.thumb ?? '';
        }),
    );
    p.catch(() => images.delete(assetId));
    images.set(assetId, p);
  }
  return p;
}

let grainTile: HTMLCanvasElement | null = null;
function grain(): HTMLCanvasElement {
  if (grainTile) return grainTile;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const data = g.createImageData(256, 256);
  let s = 12345;
  for (let i = 0; i < data.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = 128 + ((s % 120) - 60);
    data.data[i] = data.data[i + 1] = data.data[i + 2] = v;
    data.data[i + 3] = 255;
  }
  g.putImageData(data, 0, 0);
  grainTile = c;
  return c;
}

/** Opacity of a picture clip at t (dissolves, dips through black, fades) — mirrors the renderer's alpha fades. */
export function clipOpacity(c: Clip, t: number, next: Clip | undefined): number {
  const local = t - c.start;
  let a = 1;
  const tr = c.transitionIn;
  if (tr.type === 'dissolve' && local < 0) a = Math.max(0, 1 + local / tr.duration);
  if (tr.type === 'dip_black' && local < tr.duration / 2) a = Math.min(a, Math.max(0, local / (tr.duration / 2)));
  if (c.fadeIn > 0 && local < c.fadeIn) a = Math.min(a, Math.max(0, local / c.fadeIn));
  const toEnd = c.start + c.duration - t;
  if (c.fadeOut > 0 && toEnd < c.fadeOut) a = Math.min(a, Math.max(0, toEnd / c.fadeOut));
  if (next && next.transitionIn.type === 'dip_black' && Math.abs(next.start - (c.start + c.duration)) < 0.05) {
    const d = next.transitionIn.duration / 2;
    if (toEnd < d) a = Math.min(a, Math.max(0, toEnd / d));
  }
  return a;
}

/** Audio gain of a clip at t: level × automation (intensity and ducking) × fades — as the renderer mixes it. */
export function clipGain(c: Clip, t: number): number {
  const local = t - c.start;
  let g = c.volume * (c.volumeAutomation?.length ? automationGain(c.volumeAutomation, local) : 1);
  if (c.fadeIn > 0 && local < c.fadeIn) g *= Math.max(0, local / c.fadeIn);
  const toEnd = c.start + c.duration - t;
  if (c.fadeOut > 0 && toEnd < c.fadeOut) g *= Math.max(0, toEnd / c.fadeOut);
  return Math.max(0, Math.min(1, g));
}

function textCss(c: Clip, heightPx: number): CSSProperties {
  const s = c.style!;
  const fonts: Record<string, string> = { Inter: '"Inter Variable", Inter, sans-serif', 'EB Garamond': '"EB Garamond", Georgia, serif', 'DejaVu Sans': '"DejaVu Sans", Verdana, sans-serif', 'Noto Sans': '"Noto Sans", Arial, sans-serif' };
  const outline = Math.max(0, (s.outline * heightPx) / 1080);
  return {
    fontFamily: fonts[s.font] ?? fonts.Inter,
    fontSize: `${(s.sizePct / 100) * heightPx}px`,
    color: s.color,
    fontWeight: s.bold ? 600 : 400,
    fontStyle: s.italic ? 'italic' : 'normal',
    lineHeight: 1.22,
    whiteSpace: 'pre-line',
    textShadow: s.background ? undefined : [outline > 0 ? `0 0 ${outline}px #000, 0 0 ${outline}px #000` : '', s.shadow ? `0 ${Math.max(1, heightPx / 540)}px ${Math.max(2, heightPx / 200)}px rgba(0,0,0,0.85)` : ''].filter(Boolean).join(', ') || undefined,
    ...(s.background ? { background: 'rgba(0,0,0,0.72)', padding: '0.12em 0.45em', borderRadius: 3, boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone' } : {}),
  };
}

interface Props {
  state: TimelineState;
  durationSec: number;
  className?: string;
  /** Play only this window (e.g. one scene); the transport still shows the film time. */
  range?: { start: number; end: number } | null;
  onTime?: (t: number) => void;
  markers?: { time: number; label: string }[];
  showSafeArea?: boolean;
}

export const LitePlayer = forwardRef<PlayerHandle, Props>(function LitePlayer({ state, durationSec, className, range, onTime, markers, showSafeArea }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 640, h: 360 });
  const [playing, setPlaying] = useState(false);
  const [uiTime, setUiTime] = useState(range?.start ?? 0);
  const clock = useRef({ t: range?.start ?? 0, playing: false, startedAt: 0, startT: 0 });
  const stateRef = useRef(state);
  stateRef.current = state;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const loaded = useRef(new Map<string, HTMLImageElement>());
  const audio = useRef(new Map<string, HTMLAudioElement>());
  const audioUrl = useRef(new Map<string, string>());
  const [, bump] = useState(0);

  const ratio = aspectToRatio(state.aspectRatio);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.max(1, e!.contentRect.width);
      setSize({ w, h: w / ratio });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ratio]);

  // Load the pictures this composition uses.
  const imageIds = useMemo(() => [...new Set(state.clips.filter((c) => c.kind === 'image' && c.assetId).map((c) => c.assetId!))], [state.clips]);
  useEffect(() => {
    let alive = true;
    for (const id of imageIds) {
      if (loaded.current.has(id)) continue;
      loadImage(id)
        .then((img) => {
          if (!alive) return;
          loaded.current.set(id, img);
          bump((n) => n + 1);
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [imageIds]);

  const now = useCallback(() => {
    const c = clock.current;
    return c.playing ? c.startT + (performance.now() - c.startedAt) / 1000 : c.t;
  }, []);

  const draw = useCallback(
    (t: number) => {
      const cv = canvas.current;
      if (!cv) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.round(size.w * dpr);
      const H = Math.round(size.h * dpr);
      if (cv.width !== W || cv.height !== H) {
        cv.width = W;
        cv.height = H;
      }
      const g = cv.getContext('2d');
      if (!g) return;
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
      const st = stateRef.current;
      const order = { video: 0, overlay: 1 } as Record<string, number>;
      const tracks = st.tracks.filter((x) => (x.kind === 'video' || x.kind === 'overlay') && !x.muted).sort((a, b) => (order[a.kind] ?? 0) - (order[b.kind] ?? 0));
      for (const track of tracks) {
        const clips = st.clips.filter((c) => c.trackId === track.id).sort((a, b) => a.start - b.start);
        clips.forEach((c, i) => {
          if (t < c.start - clipPreroll(c) || t >= c.start + c.duration) return;
          const alpha = clipOpacity(c, t, clips[i + 1]);
          if (alpha <= 0) return;
          g.save();
          g.globalAlpha = alpha;
          if (c.kind === 'title') {
            g.fillStyle = c.style?.background ?? '#000';
            g.fillRect(0, 0, W, H);
          } else if (c.kind === 'image' && c.assetId) {
            const img = loaded.current.get(c.assetId);
            if (img) {
              const nw = img.naturalWidth;
              const nh = img.naturalHeight;
              const look = c.look;
              if (look && (look.haze > 0 || Math.abs(look.warmth) > 0)) g.filter = `contrast(${1 - 0.14 * look.haze}) brightness(${1 + 0.06 * look.haze}) saturate(${1 - 0.18 * look.haze}) sepia(${Math.max(0, look.warmth) * 0.18}) hue-rotate(${Math.min(0, look.warmth) * 12}deg)`;
              if (c.motion) {
                const r = motionRectAt(c.motion, clipMotionProgress(c, t));
                g.drawImage(img, r.x * nw, r.y * nh, r.w * nw, r.h * nh, 0, 0, W, H);
              } else {
                const s = Math.max(W / nw, H / nh);
                g.drawImage(img, (W - nw * s) / 2, (H - nh * s) / 2, nw * s, nh * s);
              }
              g.filter = 'none';
              if (look && look.vignette > 0) {
                const grad = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) / 2);
                grad.addColorStop(0, 'rgba(0,0,0,0)');
                grad.addColorStop(1, `rgba(0,0,0,${0.25 + 0.4 * look.vignette})`);
                g.fillStyle = grad;
                g.fillRect(0, 0, W, H);
              }
              if (look && look.grain > 0) {
                g.globalAlpha = alpha * 0.06 * look.grain;
                g.globalCompositeOperation = 'overlay';
                const tile = grain();
                const frame = Math.floor(t * st.fps);
                const ox = (frame * 97) % 256;
                const oy = (frame * 57) % 256;
                for (let y = -oy; y < H; y += 256) for (let x = -ox; x < W; x += 256) g.drawImage(tile, x, y);
              }
            } else {
              g.fillStyle = '#0c121d';
              g.fillRect(0, 0, W, H);
            }
          }
          g.restore();
        });
        // Dip-to-white flash centred on the cut (as the renderer draws it).
        for (const c of clips) {
          if (c.transitionIn.type !== 'dip_white') continue;
          const half = c.transitionIn.duration / 2;
          const d = Math.abs(t - c.start);
          if (half <= 0 || d >= half) continue;
          g.save();
          g.globalAlpha = 1 - d / half;
          g.fillStyle = '#fff';
          g.fillRect(0, 0, W, H);
          g.restore();
        }
      }
    },
    [size.w, size.h],
  );

  // Audio follows the clock (levels include fades and duck automation, as in the export mix).
  const syncAudio = useCallback((t: number, isPlaying: boolean) => {
    const st = stateRef.current;
    const muted = new Set(st.tracks.filter((x) => x.muted).map((x) => x.id));
    const wanted = new Set<string>();
    for (const c of st.clips) {
      if (c.kind !== 'audio' || !c.assetId || muted.has(c.trackId)) continue;
      const near = t >= c.start - 3 && t < c.start + c.duration;
      if (!near) continue;
      wanted.add(c.id);
      let el = audio.current.get(c.id);
      if (!el) {
        el = new Audio();
        el.preload = 'auto';
        audio.current.set(c.id, el);
        const id = c.assetId;
        const url = audioUrl.current.get(id);
        if (url) el.src = url;
        else
          void getMediaUrls(id).then((u) => {
            if (u.file) {
              audioUrl.current.set(id, u.file);
              const e = audio.current.get(c.id);
              if (e && !e.src) e.src = u.file;
            }
          });
      }
      const active = t >= c.start && t < c.start + c.duration;
      const desired = c.inPoint + (t - c.start);
      el.volume = active ? clipGain(c, t) : 0;
      if (!isPlaying || !active) {
        if (!el.paused) el.pause();
        if (!isPlaying && el.src && Math.abs(el.currentTime - Math.max(0, desired)) > 0.05 && el.readyState > 0) el.currentTime = Math.max(0, desired);
        continue;
      }
      if (!el.src) continue;
      if (Math.abs(el.currentTime - desired) > 0.18) el.currentTime = Math.max(0, desired);
      if (el.paused) void el.play().catch(() => undefined);
    }
    for (const [id, el] of audio.current) {
      if (wanted.has(id)) continue;
      el.pause();
      audio.current.delete(id);
    }
  }, []);

  useEffect(() => {
    let raf = 0;
    let lastUi = 0;
    const tick = () => {
      let t = now();
      const r = rangeRef.current;
      const end = r ? r.end : durationSec;
      if (clock.current.playing && t >= end) {
        clock.current = { ...clock.current, playing: false, t: end };
        t = end;
        setPlaying(false);
      }
      draw(t);
      syncAudio(t, clock.current.playing);
      if (performance.now() - lastUi > 90) {
        lastUi = performance.now();
        setUiTime(t);
        onTime?.(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [draw, syncAudio, now, durationSec, onTime]);

  useEffect(
    () => () => {
      for (const el of audio.current.values()) el.pause();
      audio.current.clear();
    },
    [],
  );

  const seek = useCallback(
    (t: number) => {
      const c = clock.current;
      const x = Math.max(0, Math.min(durationSec, t));
      clock.current = c.playing ? { ...c, startT: x, startedAt: performance.now() } : { ...c, t: x };
      setUiTime(x);
      // Draw the new frame now (animation frames are throttled in background tabs).
      draw(x);
    },
    [durationSec, draw],
  );

  // A paused frame is redrawn whenever the composition, the size or a loaded picture changes.
  useEffect(() => {
    if (!clock.current.playing) draw(clock.current.t);
  });
  const play = useCallback(() => {
    const c = clock.current;
    const r = rangeRef.current;
    let t = c.playing ? now() : c.t;
    if (r && (t < r.start || t >= r.end - 0.05)) t = r.start;
    if (!r && t >= durationSec - 0.05) t = 0;
    clock.current = { t, playing: true, startedAt: performance.now(), startT: t };
    setPlaying(true);
  }, [durationSec, now]);
  const pause = useCallback(() => {
    clock.current = { ...clock.current, playing: false, t: now() };
    setPlaying(false);
  }, [now]);
  const toggle = useCallback(() => (clock.current.playing ? pause() : play()), [pause, play]);
  useImperativeHandle(ref, () => ({ play, pause, toggle, seek, time: now }), [play, pause, toggle, seek, now]);

  // Moving into a scene's window starts there.
  useEffect(() => {
    if (range) seek(range.start);
  }, [range?.start, range?.end]); // eslint-disable-line react-hooks/exhaustive-deps

  const captions = state.clips.filter((c) => c.kind === 'caption' && !state.tracks.find((x) => x.id === c.trackId)?.muted && uiTime >= c.start && uiTime < c.start + c.duration);
  const pct = durationSec ? (uiTime / durationSec) * 100 : 0;
  return (
    <div className={cx('select-none', className)}>
      <div ref={wrap} className="relative w-full overflow-hidden rounded-xl bg-black shadow-[var(--shadow-float)]" style={{ aspectRatio: String(ratio) }}>
        <canvas ref={canvas} className="absolute inset-0 size-full" aria-label="Film preview" role="img" onClick={toggle} />
        {showSafeArea && <div className="pointer-events-none absolute inset-[6%] rounded border border-dashed border-white/25" aria-hidden />}
        {captions.map((c) => (
          <div key={c.id} className="pointer-events-none absolute inset-x-[6%] flex justify-center text-center" style={{ bottom: `${(c.position?.offset ?? 0.07) * 100}%` }}>
            <span style={textCss(c, size.h)}>
              {c.karaoke?.length
                ? c.karaoke.map((u, i) => (
                    <span key={i} style={uiTime - c.start >= u.start ? { color: c.style?.highlight ?? '#F4B84A' } : undefined}>
                      {i ? ' ' : ''}
                      {u.text}
                    </span>
                  ))
                : c.text}
            </span>
          </div>
        ))}
        {!playing && (
          <button type="button" onClick={play} className="absolute top-1/2 left-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full bg-black/45 text-white backdrop-blur transition hover:bg-black/65" aria-label="Play">
            <Play className="ml-0.5 size-6" />
          </button>
        )}
      </div>
      <div className="mt-2.5 flex items-center gap-2.5">
        <IconButton label={playing ? 'Pause' : 'Play'} onClick={toggle} size="sm">
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </IconButton>
        <IconButton label="Back to start" size="sm" onClick={() => seek(range?.start ?? 0)}>
          <SkipBack className="size-4" />
        </IconButton>
        <div
          className="relative h-7 flex-1 cursor-pointer"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={durationSec}
          aria-valuenow={Math.round(uiTime * 10) / 10}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') seek(uiTime + (e.shiftKey ? 10 : 1));
            if (e.key === 'ArrowLeft') seek(uiTime - (e.shiftKey ? 10 : 1));
            if (e.key === ' ') {
              e.preventDefault();
              toggle();
            }
          }}
          onPointerDown={(e) => {
            const el = e.currentTarget;
            const at = (x: number) => {
              const r = el.getBoundingClientRect();
              seek(((x - r.left) / r.width) * durationSec);
            };
            at(e.clientX);
            el.setPointerCapture(e.pointerId);
            const move = (ev: PointerEvent) => at(ev.clientX);
            const up = () => {
              el.removeEventListener('pointermove', move);
              el.removeEventListener('pointerup', up);
            };
            el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', up);
          }}
        >
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/10" />
          {range && durationSec > 0 && <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent/30" style={{ left: `${(range.start / durationSec) * 100}%`, width: `${((range.end - range.start) / durationSec) * 100}%` }} />}
          <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent-2" style={{ width: `${pct}%` }} />
          {(markers ?? []).map((m) => (
            <span key={`${m.time}-${m.label}`} title={m.label} className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-white/35" style={{ left: `${(m.time / Math.max(1e-6, durationSec)) * 100}%` }} />
          ))}
          <div className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow" style={{ left: `${pct}%` }} />
        </div>
        <span className="timecode w-[120px] text-right text-xs text-dim">
          {formatTimecode(uiTime, 1)} / {formatTimecode(durationSec, 0)}
        </span>
      </div>
    </div>
  );
});
