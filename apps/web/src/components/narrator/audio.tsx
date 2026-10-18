import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Pause, Play, RotateCcw, RotateCw } from 'lucide-react';
import { fmtClock } from '@az-studio/shared';
import { cx } from '../ui';

/**
 * Waveform drawn from peaks measured on the real audio (server-side, from the decoded samples). Nothing is
 * drawn when there are no peaks — no placeholder waveforms.
 */
export function Waveform({ peaks, progress = 0, className, height = 56, marks = [] }: { peaks: number[] | null | undefined; progress?: number; className?: string; height?: number; marks?: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = ref.current;
    if (!c || !width || !peaks?.length) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, height);
    const bars = Math.max(1, Math.floor(width / 3));
    const max = Math.max(0.05, ...peaks);
    const mid = height / 2;
    for (let i = 0; i < bars; i++) {
      const a = Math.floor((i / bars) * peaks.length);
      const b = Math.max(a + 1, Math.floor(((i + 1) / bars) * peaks.length));
      let v = 0;
      for (let j = a; j < b; j++) v = Math.max(v, peaks[j] ?? 0);
      const h = Math.max(1, (v / max) * (height - 4));
      g.fillStyle = i / bars < progress ? '#8ab6ff' : 'rgba(158,171,194,0.38)';
      g.fillRect(i * 3, mid - h / 2, 2, h);
    }
    g.fillStyle = 'rgba(233,238,247,0.55)';
    for (const m of marks) g.fillRect(Math.round(m * width), 0, 1, height);
  }, [peaks, width, height, progress, marks]);
  return <canvas ref={ref} className={cx('block w-full', className)} style={{ height }} aria-hidden />;
}

/** Compact player for one take, test or recording. */
export function ClipPlayer({ src, peaks, label, className, onPlay }: { src: string | null; peaks?: number[] | null; label: string; className?: string; onPlay?: () => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [d, setD] = useState(0);
  const toggle = () => {
    const a = audio.current;
    if (!a || !src) return;
    if (a.paused) {
      document.querySelectorAll('audio').forEach((x) => x !== a && x.pause());
      void a.play();
      onPlay?.();
    } else a.pause();
  };
  const seek = (e: PointerEvent<HTMLDivElement>) => {
    const a = audio.current;
    if (!a || !d) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(d, ((e.clientX - r.left) / r.width) * d));
  };
  return (
    <div className={cx('flex items-center gap-3', className)}>
      <button type="button" onClick={toggle} disabled={!src} aria-label={`${playing ? 'Pause' : 'Play'} ${label}`} className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full bg-accent/15 text-accent-2 transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40">
        {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
      </button>
      <div className="min-w-0 flex-1">
        {peaks?.length ? (
          <div role="slider" tabIndex={-1} aria-label={`Seek ${label}`} aria-valuemin={0} aria-valuemax={Math.round(d)} aria-valuenow={Math.round(t)} className="cursor-pointer" onPointerDown={seek}>
            <Waveform peaks={peaks} progress={d ? t / d : 0} height={34} />
          </div>
        ) : (
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10" onPointerDown={seek}>
            <div className="h-full bg-accent-2" style={{ width: `${d ? (t / d) * 100 : 0}%` }} />
          </div>
        )}
      </div>
      <span className="timecode shrink-0 text-[11px] text-faint">
        {fmtClock(t)} / {d ? fmtClock(d) : '–:––'}
      </span>
      {src && <audio ref={audio} src={src} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onLoadedMetadata={(e) => setD(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)} />}
    </div>
  );
}

export interface PlayerSection {
  title: string;
  startSec: number;
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * The edition player: waveform scrubbing (pointer and arrow keys), ±15 s, speed, and section navigation from
 * the section start times measured when the export was assembled.
 */
export function EditionPlayer({ src, peaks, duration, sections, onTime, seekTo }: { src: string | null; peaks: number[] | null; duration: number | null; sections: PlayerSection[]; onTime?: (sec: number) => void; seekTo?: { sec: number; n: number } | null }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [d, setD] = useState(duration ?? 0);
  const [speed, setSpeed] = useState(1);
  const dragging = useRef(false);
  const go = useCallback((sec: number) => {
    const a = audio.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(a.duration || d, sec));
    setT(a.currentTime);
  }, [d]);
  useEffect(() => {
    if (seekTo) {
      go(seekTo.sec);
      void audio.current?.play();
    }
  }, [seekTo, go]);
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
  }, [speed, src]);
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  };
  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    go(((e.clientX - r.left) / r.width) * d);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') go(t - 5);
    else if (e.key === 'ArrowRight') go(t + 5);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(d);
    else if (e.key === ' ' || e.key === 'k') toggle();
    else return;
    e.preventDefault();
  };
  const current = [...sections].reverse().find((s) => s.startSec <= t + 0.05);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button type="button" onClick={toggle} disabled={!src} aria-label={playing ? 'Pause' : 'Play'} className="grid size-12 shrink-0 cursor-pointer place-items-center rounded-full bg-gradient-to-b from-[#5b97ff] to-[#3a76f0] text-white shadow-[0_10px_30px_-10px_rgba(76,141,255,0.65)] disabled:cursor-not-allowed disabled:opacity-40">
          {playing ? <Pause className="size-5" /> : <Play className="size-5 translate-x-px" />}
        </button>
        <button type="button" onClick={() => go(t - 15)} disabled={!src} aria-label="Back 15 seconds" className="grid size-9 cursor-pointer place-items-center rounded-lg text-dim hover:bg-white/5 hover:text-fg disabled:opacity-40">
          <RotateCcw className="size-4" />
        </button>
        <button type="button" onClick={() => go(t + 15)} disabled={!src} aria-label="Forward 15 seconds" className="grid size-9 cursor-pointer place-items-center rounded-lg text-dim hover:bg-white/5 hover:text-fg disabled:opacity-40">
          <RotateCw className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-fg">{current?.title ?? '—'}</p>
          <p className="timecode text-xs text-faint">
            {fmtClock(t)} / {d ? fmtClock(d) : '–:––'}
          </p>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-dim">
          <span className="sr-only sm:not-sr-only">Speed</span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="field w-auto py-1 pr-2 text-xs" aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(d)}
        aria-valuenow={Math.round(t)}
        aria-valuetext={`${fmtClock(t)} of ${fmtClock(d)}`}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => dragging.current && fromPointer(e)}
        onPointerUp={() => (dragging.current = false)}
        className="cursor-pointer rounded-lg py-1"
      >
        {peaks?.length ? (
          <Waveform peaks={peaks} progress={d ? t / d : 0} height={64} marks={d ? sections.map((s) => s.startSec / d).filter((x) => x > 0.002) : []} />
        ) : (
          <div className="h-2 overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-accent-2" style={{ width: `${d ? (t / d) * 100 : 0}%` }} />
          </div>
        )}
      </div>
      {sections.length > 1 && (
        <nav aria-label="Sections" className="scroll-x -mx-1 flex gap-1 px-1">
          {sections.map((s, i) => (
            <button key={`${s.startSec}-${i}`} type="button" onClick={() => go(s.startSec)} className={cx('shrink-0 cursor-pointer rounded-lg border px-2.5 py-1 text-xs transition-colors', current === s ? 'border-accent/50 bg-accent/12 text-fg' : 'border-line text-dim hover:border-line-strong hover:text-fg')}>
              <span className="timecode mr-1.5 text-faint">{fmtClock(s.startSec)}</span>
              {s.title}
            </button>
          ))}
        </nav>
      )}
      {src && (
        <audio
          ref={audio}
          src={src}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => {
            setT(e.currentTarget.currentTime);
            onTime?.(e.currentTarget.currentTime);
          }}
          onLoadedMetadata={(e) => {
            if (Number.isFinite(e.currentTarget.duration)) setD(e.currentTarget.duration);
            e.currentTarget.playbackRate = speed;
          }}
        />
      )}
    </div>
  );
}
