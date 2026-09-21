import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Captions, Eye, EyeOff, Film, Image as ImageIcon, Lock, LockOpen, Music2, Type, Volume2, VolumeX } from 'lucide-react';
import { clipEnd, formatTimecode, moveClip, snap, snapPoints, timelineDuration, trackAccepts, trimEnd, trimStart, updateTrack, type Clip, type ClipKind, type TimelineState, type Track } from '@az-studio/shared';
import { useMediaUrls } from '../../lib/media';
import { useWaveform } from '../../components/media';
import { cx, IconButton } from '../../components/ui';

export const HEADER_W = 176;
const LANE_H: Record<Track['kind'], number> = { video: 64, overlay: 48, caption: 38, audio: 52 };
export const ASSET_MIME = 'application/x-azs-asset';

export interface DroppedAsset {
  assetId: string;
  kind: 'video' | 'image' | 'audio';
  durationSec: number | null;
  title: string;
}

const CLIP_TONE: Record<ClipKind, string> = {
  video: 'from-[#1f4fa8]/90 to-[#15356f]/90 border-[#5b97ff]/50',
  image: 'from-[#11606c]/90 to-[#0b3b44]/90 border-[#3fc3d6]/45',
  audio: 'from-[#4b3a9e]/85 to-[#2c2263]/85 border-[#9b8cff]/45',
  caption: 'from-[#7a5a14]/85 to-[#4a360b]/85 border-[#f4b84a]/45',
  title: 'from-[#6d4f12]/90 to-[#3f2d0a]/90 border-[#f4d27a]/45',
};

function ClipWave({ clip, width, height }: { clip: Clip; width: number; height: number }) {
  const wf = useWaveform(clip.assetId);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !wf || width < 4) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.floor(width * dpr);
    c.height = Math.floor(height * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, height);
    g.fillStyle = 'rgba(214,206,255,0.75)';
    const n = wf.max.length;
    const from = clip.inPoint / wf.durationSec;
    const span = clip.duration / wf.durationSec;
    const mid = height / 2;
    for (let x = 0; x < width; x++) {
      const i = Math.floor((from + (x / width) * span) * n);
      const hi = wf.max[i] ?? 0;
      const lo = wf.min[i] ?? 0;
      g.fillRect(x, mid - hi * mid * 0.9, 1, Math.max(1, (hi - lo) * mid * 0.9));
    }
  }, [wf, width, height, clip.inPoint, clip.duration]);
  return <canvas ref={ref} style={{ width, height }} className="pointer-events-none absolute inset-0" />;
}

function ClipFace({ clip, width, height }: { clip: Clip; width: number; height: number }) {
  const urls = useMediaUrls(clip.kind === 'video' || clip.kind === 'image' ? clip.assetId : null);
  const thumb = urls?.thumb ?? urls?.poster;
  const Icon = clip.kind === 'video' ? Film : clip.kind === 'image' ? ImageIcon : clip.kind === 'audio' ? Music2 : clip.kind === 'caption' ? Captions : Type;
  return (
    <>
      {thumb && width > 30 && <div className="pointer-events-none absolute inset-0 opacity-45" style={{ backgroundImage: `url("${thumb}")`, backgroundSize: `${Math.round(height * 1.78)}px 100%`, backgroundRepeat: 'repeat-x' }} />}
      {clip.kind === 'audio' && <ClipWave clip={clip} width={width} height={height} />}
      <div className="pointer-events-none relative flex items-center gap-1 truncate px-2 pt-1 text-[11px] font-medium text-white/90">
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{clip.kind === 'caption' || clip.kind === 'title' ? clip.text || '(empty)' : clip.label || clip.kind}</span>
      </div>
      {clip.transitionIn.type !== 'cut' && <div className="pointer-events-none absolute top-0 bottom-0 left-0 w-2 bg-gradient-to-r from-white/40 to-transparent" title={`${clip.transitionIn.type} ${clip.transitionIn.duration}s`} />}
    </>
  );
}

interface DragState {
  mode: 'move' | 'trim-start' | 'trim-end';
  clipId: string;
  originX: number;
  base: TimelineState;
  start: number;
  end: number;
  moved: boolean;
  last: TimelineState | null;
}

const DRAG_LABEL: Record<DragState['mode'], string> = { move: 'Move clip', 'trim-start': 'Trim clip start', 'trim-end': 'Trim clip end' };

export function TimelineLanes({
  state,
  pxPerSec,
  time,
  selection,
  snapOn,
  onSelect,
  onSeek,
  onDraft,
  onCommit,
  onDropAsset,
}: {
  state: TimelineState;
  pxPerSec: number;
  time: number;
  selection: string[];
  snapOn: boolean;
  onSelect: (id: string | null, additive: boolean) => void;
  onSeek: (t: number) => void;
  onDraft: (s: TimelineState | null) => void;
  onCommit: (s: TimelineState, label: string) => void;
  onDropAsset: (asset: DroppedAsset, trackId: string, t: number) => void;
}) {
  const laneRefs = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<DragState | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const total = Math.max(60, timelineDuration(state.clips) + 20);
  const width = total * pxPerSec;
  const tickStep = pxPerSec >= 120 ? 1 : pxPerSec >= 40 ? 5 : pxPerSec >= 12 ? 10 : 30;
  const ticks = useMemo(() => Array.from({ length: Math.ceil(total / tickStep) + 1 }, (_, i) => i * tickStep), [total, tickStep]);

  const trackAt = (clientY: number): string | null => {
    for (const [id, el] of laneRefs.current) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return id;
    }
    return null;
  };
  const snapT = (t: number, excludeId: string) => (snapOn ? snap(t, snapPoints(state, excludeId, time), 8 / pxPerSec) : t);

  // Window-level listeners: the dragged clip may remount in another lane mid-drag.
  const moveRef = useRef<(e: PointerEvent) => void>(() => undefined);
  const upRef = useRef<() => void>(() => undefined);
  const down = (e: RPointerEvent, clip: Clip, mode: DragState['mode']) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    drag.current = { mode, clipId: clip.id, originX: e.clientX, base: state, start: clip.start, end: clipEnd(clip), moved: false, last: null };
    onSelect(clip.id, e.shiftKey || e.metaKey || e.ctrlKey);
    const onMove = (ev: PointerEvent) => moveRef.current(ev);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      upRef.current();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.originX) / pxPerSec;
    if (!d.moved && Math.abs(e.clientX - d.originX) < 3) return;
    d.moved = true;
    const clip = d.base.clips.find((c) => c.id === d.clipId)!;
    let next: TimelineState;
    if (d.mode === 'move') {
      let s = d.start + dx;
      const snappedStart = snapT(s, clip.id);
      const snappedEnd = snapT(s + clip.duration, clip.id) - clip.duration;
      s = Math.abs(snappedStart - s) <= Math.abs(snappedEnd - s) ? snappedStart : snappedEnd;
      const target = trackAt(e.clientY);
      const track = target ? d.base.tracks.find((t) => t.id === target) : undefined;
      next = moveClip(d.base, clip.id, Math.max(0, s), track && trackAccepts(track.kind, clip.kind) ? track.id : clip.trackId);
    } else if (d.mode === 'trim-start') next = trimStart(d.base, clip.id, snapT(d.start + dx, clip.id));
    else next = trimEnd(d.base, clip.id, snapT(d.end + dx, clip.id));
    d.last = next;
    onDraft(next);
  };
  /** Commits the last previewed state as one undoable edit. */
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved && d.last) onCommit(d.last, DRAG_LABEL[d.mode]);
    onDraft(null);
  };
  moveRef.current = move;
  upRef.current = up;

  const scrubTo = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    onSeek(Math.max(0, (clientX - r.left) / pxPerSec));
  };

  return (
    <div className="relative select-none" style={{ width: HEADER_W + width }}>
      {/* Ruler */}
      <div className="sticky top-0 z-20 flex h-7 border-b border-line bg-panel">
        <div className="sticky left-0 z-30 shrink-0 border-r border-line bg-panel" style={{ width: HEADER_W }} />
        <div
          className="relative cursor-pointer"
          style={{ width }}
          onPointerDown={(e) => {
            (e.currentTarget as Element).setPointerCapture(e.pointerId);
            setScrubbing(true);
            scrubTo(e.clientX, e.currentTarget);
          }}
          onPointerMove={(e) => scrubbing && scrubTo(e.clientX, e.currentTarget)}
          onPointerUp={() => setScrubbing(false)}
          role="slider"
          aria-label="Timeline position"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={time}
        >
          {ticks.map((t) => (
            <div key={t} className="absolute top-0 h-full border-l border-line-strong" style={{ left: t * pxPerSec }}>
              <span className="timecode ml-1 text-[10px] text-faint">{formatTimecode(t, 0)}</span>
            </div>
          ))}
          {state.beatGrid && pxPerSec >= 20 && state.beatGrid.beats.map((b, i) => <div key={i} className="absolute bottom-0 h-1.5 w-px bg-accent/40" style={{ left: b * pxPerSec }} />)}
        </div>
      </div>

      {state.tracks.map((track) => (
        <div key={track.id} className="flex border-b border-line" style={{ height: LANE_H[track.kind] }}>
          <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-line bg-panel-2 px-2" style={{ width: HEADER_W }}>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-dim">{track.name}</span>
            <IconButton size="sm" label={track.muted ? (track.kind === 'audio' ? 'Unmute' : 'Show') : track.kind === 'audio' ? 'Mute' : 'Hide'} active={track.muted} onClick={() => onCommit(updateTrack(state, track.id, { muted: !track.muted }), 'Toggle track')}>
              {track.kind === 'audio' ? track.muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" /> : track.muted ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </IconButton>
            <IconButton size="sm" label={track.locked ? 'Unlock track' : 'Lock track'} active={track.locked} onClick={() => onCommit(updateTrack(state, track.id, { locked: !track.locked }), 'Lock track')}>
              {track.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
            </IconButton>
          </div>
          <div
            ref={(el) => {
              if (el) laneRefs.current.set(track.id, el);
              else laneRefs.current.delete(track.id);
            }}
            className={cx('relative', track.locked && 'bg-[repeating-linear-gradient(45deg,transparent,transparent_8px,rgba(255,255,255,0.02)_8px,rgba(255,255,255,0.02)_16px)]')}
            style={{ width }}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) {
                onSelect(null, false);
                scrubTo(e.clientX, e.currentTarget);
              }
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(ASSET_MIME)) e.preventDefault();
            }}
            onDrop={(e) => {
              const raw = e.dataTransfer.getData(ASSET_MIME);
              if (!raw) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              onDropAsset(JSON.parse(raw) as DroppedAsset, track.id, Math.max(0, (e.clientX - r.left) / pxPerSec));
            }}
          >
            {state.clips
              .filter((c) => c.trackId === track.id)
              .map((c) => {
                const w = Math.max(6, c.duration * pxPerSec);
                const h = LANE_H[track.kind] - 8;
                const selected = selection.includes(c.id);
                return (
                  <div
                    key={c.id}
                    className={cx('absolute top-1 overflow-hidden rounded-md border bg-gradient-to-b shadow-sm', CLIP_TONE[c.kind], selected && 'ring-2 ring-white/80', track.locked ? 'cursor-not-allowed opacity-70' : 'cursor-grab active:cursor-grabbing')}
                    style={{ left: c.start * pxPerSec, width: w, height: h }}
                    onPointerDown={(e) => !track.locked && down(e, c, 'move')}
                    role="button"
                    aria-label={`${c.kind} clip ${c.label || c.text || ''} at ${formatTimecode(c.start)}`}
                    aria-pressed={selected}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && onSelect(c.id, false)}
                  >
                    <ClipFace clip={c} width={w} height={h} />
                    {!track.locked && (
                      <>
                        <div className="absolute top-0 left-0 z-10 h-full w-2 cursor-ew-resize hover:bg-white/30" onPointerDown={(e) => down(e, c, 'trim-start')} aria-hidden />
                        <div className="absolute top-0 right-0 z-10 h-full w-2 cursor-ew-resize hover:bg-white/30" onPointerDown={(e) => down(e, c, 'trim-end')} aria-hidden />
                      </>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      ))}

      {/* Playhead */}
      <div className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-white shadow-[0_0_10px_rgba(255,255,255,0.7)]" style={{ left: HEADER_W + time * pxPerSec }}>
        <div className="absolute -top-0.5 -left-1.5 size-3 rotate-45 bg-white" />
      </div>
    </div>
  );
}
