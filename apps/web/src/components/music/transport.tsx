import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Repeat } from 'lucide-react';
import { formatTimecode } from '@az-studio/shared';
import { useMediaUrls } from '../../lib/media';
import type { Transport } from '../lyrics';
import { IconButton } from '../ui';

/**
 * One audio element driven by the studio: play / pause, seek, play a range, loop a range (for auditioning
 * a section), with a time that updates every frame while playing.
 */
export function useAudioTransport(assetId: string | null) {
  const urls = useMediaUrls(assetId);
  const ref = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState<{ start: number; end: number } | null>(null);
  const stopAt = useRef<number | null>(null);
  useEffect(() => {
    const a = ref.current;
    if (!a || !playing) return;
    let raf = 0;
    const tick = () => {
      setTime(a.currentTime);
      if (loop && a.currentTime >= loop.end) a.currentTime = loop.start;
      else if (stopAt.current !== null && a.currentTime >= stopAt.current) {
        a.pause();
        stopAt.current = null;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, loop]);
  const seek = (t: number) => {
    if (ref.current) ref.current.currentTime = Math.max(0, t);
    setTime(Math.max(0, t));
  };
  const transport: Transport = {
    time,
    playing,
    seek,
    pause: () => ref.current?.pause(),
    playRange: (start, end) => {
      const a = ref.current;
      if (!a) return;
      setLoop(null);
      a.currentTime = start;
      stopAt.current = end;
      void a.play();
    },
  };
  const toggle = () => (playing ? ref.current?.pause() : void ref.current?.play());
  const loopRange = (r: { start: number; end: number } | null) => {
    setLoop(r);
    stopAt.current = null;
    if (r && ref.current) {
      ref.current.currentTime = r.start;
      void ref.current.play();
    }
  };
  const element = <audio ref={ref} src={urls?.file} preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />;
  return { element, transport, toggle, loop, loopRange, time, playing, seek, ready: Boolean(urls?.file) };
}

export function TransportBar({ t, duration, label }: { t: ReturnType<typeof useAudioTransport>; duration: number; label?: string }) {
  return (
    <div className="flex items-center gap-2">
      <IconButton label={t.playing ? 'Pause' : 'Play'} onClick={t.toggle} disabled={!t.ready}>
        {t.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </IconButton>
      <span className="timecode text-xs text-dim">
        {formatTimecode(t.time)} / {formatTimecode(duration)}
      </span>
      {t.loop && (
        <button type="button" className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-accent/50 px-2 py-0.5 text-[11px] text-accent-2" onClick={() => t.loopRange(null)}>
          <Repeat className="size-3" /> looping {formatTimecode(t.loop.start)}–{formatTimecode(t.loop.end)} · stop
        </button>
      )}
      {label && <span className="truncate text-xs text-faint">{label}</span>}
      {t.element}
    </div>
  );
}
