import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { collection, orderBy, query, where } from 'firebase/firestore';
import { AudioWaveform, CircleAlert, FileText, Film, Image as ImageIcon, LoaderCircle, ShieldCheck, Star, Upload } from 'lucide-react';
import { formatBytes, formatDuration, type AssetDoc, type AssetKind } from '@az-studio/shared';
import { db } from '../lib/firebase';
import { useDoc, useQuery, type WithId } from '../lib/data';
import { uploadFile, useMediaUrls } from '../lib/media';
import { useUid } from '../lib/session';
import { usePresenterPrivacy } from '../lib/presenter';
import { Badge, Button, cx, EmptyState, Modal, ProgressBar, Segmented, Skeleton, Tip } from './ui';

export type Asset = WithId<AssetDoc>;

const KIND_ICON: Record<AssetKind, ReactNode> = {
  image: <ImageIcon className="size-5" />,
  video: <Film className="size-5" />,
  audio: <AudioWaveform className="size-5" />,
  document: <FileText className="size-5" />,
};

/** Live single asset (document read, so security rules evaluate the actual document). */
export function useAsset(assetId: string | null | undefined) {
  return useDoc<AssetDoc>(assetId ? `assets/${assetId}` : null);
}

/** Cinematic thumbnail for any asset. Videos play muted on hover. */
export function AssetThumb({ asset, className, aspect = 'aspect-video', showMeta = true, onClick, selected, overlay, hoverPlay = true }: { asset: Asset; className?: string; aspect?: string; showMeta?: boolean; onClick?: () => void; selected?: boolean; overlay?: ReactNode; hoverPlay?: boolean }) {
  const urls = useMediaUrls(asset.id, asset.status === 'ready' ? undefined : asset.status);
  const [hover, setHover] = useState(false);
  const privacy = usePresenterPrivacy();
  const img = asset.kind === 'image' ? urls?.thumb ?? urls?.file : urls?.thumb ?? urls?.poster;
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...privacy(asset.createdAt)}
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={cx(
        'cinema-thumb group block w-full rounded-xl border text-left transition-all duration-200',
        aspect,
        selected ? 'border-accent shadow-[var(--shadow-glow)]' : 'border-line hover:border-line-strong',
        onClick && 'cursor-pointer',
        className,
      )}
      aria-label={onClick ? `Open ${asset.title}` : undefined}
    >
      {asset.status === 'ready' && img ? (
        <img src={img} alt="" loading="lazy" className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" draggable={false} />
      ) : asset.status === 'uploading' || asset.status === 'processing' ? (
        <div className="absolute inset-0 grid place-items-center text-dim">
          <LoaderCircle className="size-5 animate-spin" />
        </div>
      ) : asset.status === 'rejected' ? (
        <div className="absolute inset-0 grid place-items-center p-3 text-center text-xs text-[#ff9b9b]">
          <CircleAlert className="mx-auto mb-1 size-5" />
          {asset.rejection?.reason ?? 'Rejected'}
        </div>
      ) : (
        <div className="absolute inset-0 grid place-items-center text-faint">{KIND_ICON[asset.kind]}</div>
      )}
      {hoverPlay && hover && asset.kind === 'video' && urls?.file && asset.status === 'ready' && (
        <video src={urls.file} autoPlay muted loop playsInline className="absolute inset-0 size-full object-cover" aria-hidden />
      )}
      {showMeta && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-2 p-2.5">
          <div className="min-w-0">
            <p className="truncate text-[12.5px] font-medium text-fg drop-shadow">{asset.title}</p>
            <p className="text-[10.5px] text-dim">
              {asset.kind}
              {asset.durationSec ? ` · ${formatDuration(asset.durationSec)}` : ''}
              {asset.width ? ` · ${asset.width}×${asset.height}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {asset.generation && (
              <Tip label={`AI-generated with ${asset.generation.modelId}. SynthID watermark${asset.generation.provenance.c2pa === 'present' ? ' + C2PA Content Credentials' : ''}.`}>
                <span className="grid size-5 place-items-center rounded-md bg-black/50 text-accent-2">
                  <ShieldCheck className="size-3" />
                </span>
              </Tip>
            )}
            {asset.favorite && <Star className="size-3.5 fill-warning text-warning" aria-label="Favourite" />}
          </div>
        </div>
      )}
      {overlay}
    </Tag>
  );
}

export function VideoPlayer({ assetId, className, autoPlay, poster = true, onTime, controls = true, loop }: { assetId: string; className?: string; autoPlay?: boolean; poster?: boolean; onTime?: (t: number) => void; controls?: boolean; loop?: boolean }) {
  const urls = useMediaUrls(assetId);
  if (!urls?.file) return <Skeleton className={cx('aspect-video w-full', className)} />;
  return (
    <video
      key={urls.file}
      src={urls.file}
      poster={poster ? urls.poster : undefined}
      controls={controls}
      autoPlay={autoPlay}
      loop={loop}
      playsInline
      preload="metadata"
      onTimeUpdate={onTime ? (e) => onTime(e.currentTarget.currentTime) : undefined}
      className={cx('w-full rounded-xl bg-black', className)}
    />
  );
}

export function ImageView({ assetId, className, alt = '' }: { assetId: string; className?: string; alt?: string }) {
  const urls = useMediaUrls(assetId);
  if (!urls?.file) return <Skeleton className={cx('aspect-square w-full', className)} />;
  return <img src={urls.file} alt={alt} className={cx('w-full rounded-xl bg-black object-contain', className)} />;
}

/** Draws min/max waveform peaks with an optional playhead and section overlay. */
export function Waveform({
  peaks,
  duration,
  playhead,
  onSeek,
  height = 96,
  regions,
  beats,
  range,
  className,
}: {
  peaks: { min: number[]; max: number[] } | null;
  duration: number;
  playhead?: number;
  onSeek?: (t: number) => void;
  height?: number;
  regions?: { start: number; end: number; color: string; label?: string }[];
  beats?: number[];
  /** Highlights a production range; the rest of the song is dimmed. */
  range?: { start: number; end: number } | null;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(100, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = height * dpr;
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, height);
    for (const r of regions ?? []) {
      g.fillStyle = r.color;
      g.fillRect((r.start / duration) * width, 0, ((r.end - r.start) / duration) * width, height);
    }
    if (beats && duration) {
      g.fillStyle = 'rgba(160,190,255,0.10)';
      for (const b of beats) g.fillRect((b / duration) * width, 0, 1, height);
    }
    if (peaks && peaks.max.length) {
      const n = peaks.max.length;
      const mid = height / 2;
      const grad = g.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, '#9cc2ff');
      grad.addColorStop(1, '#3f7dff');
      g.fillStyle = grad;
      for (let x = 0; x < width; x++) {
        const i = Math.floor((x / width) * n);
        const hi = Math.max(0, peaks.max[i] ?? 0);
        const lo = Math.min(0, peaks.min[i] ?? 0);
        g.fillRect(x, mid - hi * mid * 0.95, 1, Math.max(1, (hi - lo) * mid * 0.95));
      }
    }
  }, [peaks, width, height, duration, regions, beats]);
  const pct = duration && playhead !== undefined ? Math.min(100, (playhead / duration) * 100) : null;
  const showRange = Boolean(range && duration > 0 && (range.start > 0.05 || range.end < duration - 0.05));
  const at = (t: number) => `${Math.min(100, Math.max(0, (t / duration) * 100))}%`;
  return (
    <div
      ref={wrapRef}
      className={cx('relative w-full overflow-hidden rounded-xl border border-line bg-black/40', onSeek && 'cursor-pointer', className)}
      style={{ height }}
      onPointerDown={(e) => {
        if (!onSeek || !duration) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - rect.left) / rect.width) * duration);
      }}
      role={onSeek ? 'slider' : undefined}
      aria-label={onSeek ? 'Seek' : undefined}
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={playhead}
    >
      <canvas ref={canvasRef} style={{ width, height }} className="block" />
      {showRange && range && (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/60" style={{ width: at(range.start) }} />
          <div className="pointer-events-none absolute inset-y-0 right-0 bg-black/60" style={{ left: at(range.end) }} />
          <div className="pointer-events-none absolute inset-y-0 border-x-2 border-accent-2" style={{ left: at(range.start), width: `calc(${at(range.end)} - ${at(range.start)})` }}>
            <span className="absolute top-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-accent-2">Production range</span>
          </div>
        </>
      )}
      {pct !== null && <div className="pointer-events-none absolute inset-y-0 w-px bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]" style={{ left: `${pct}%` }} />}
      {!peaks && <div className="absolute inset-0 grid place-items-center text-xs text-faint">Waveform unavailable</div>}
    </div>
  );
}

/** Loads the waveform JSON produced by the server for an asset. */
export function useWaveform(assetId: string | null | undefined): { min: number[]; max: number[]; durationSec: number } | null {
  const urls = useMediaUrls(assetId);
  const [data, setData] = useState<{ min: number[]; max: number[]; durationSec: number } | null>(null);
  useEffect(() => {
    if (!urls?.waveform) return;
    let alive = true;
    fetch(urls.waveform)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => alive && j && setData(j))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [urls?.waveform]);
  return data;
}

// ---------------------------------------------------------------------------
// Upload dropzone & asset picker
// ---------------------------------------------------------------------------

export function UploadZone({
  accept,
  kind,
  projectId,
  collections,
  multiple = true,
  onUploaded,
  label = 'Drop files or browse',
  hint,
  compact,
}: {
  accept: string;
  kind?: AssetKind;
  projectId?: string | null;
  collections?: string[];
  multiple?: boolean;
  onUploaded?: (assetIds: string[]) => void;
  label?: string;
  hint?: ReactNode;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<{ name: string; progress: number; error?: string; done?: boolean }[]>([]);
  const [drag, setDrag] = useState(false);

  const handle = async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, multiple ? 20 : 1);
    const start = items.length;
    setItems((s) => [...s, ...list.map((f) => ({ name: f.name, progress: 0 }))]);
    const ids: string[] = [];
    await Promise.all(
      list.map(async (f, i) => {
        const idx = start + i;
        try {
          const id = await uploadFile(f, { kind, projectId: projectId ?? null, collections, onProgress: (p) => setItems((s) => s.map((it, k) => (k === idx ? { ...it, progress: p } : it))) });
          ids.push(id);
          setItems((s) => s.map((it, k) => (k === idx ? { ...it, progress: 1, done: true } : it)));
        } catch (e) {
          setItems((s) => s.map((it, k) => (k === idx ? { ...it, error: e instanceof Error ? e.message : String(e) } : it)));
        }
      }),
    );
    if (ids.length) onUploaded?.(ids);
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files.length) void handle(e.dataTransfer.files);
        }}
        className={cx(
          'flex w-full cursor-pointer items-center justify-center gap-3 rounded-xl border border-dashed text-sm transition-colors',
          compact ? 'px-3 py-3' : 'flex-col px-6 py-8',
          drag ? 'border-accent bg-accent/10 text-fg' : 'border-line-strong text-dim hover:border-accent/60 hover:text-fg',
        )}
      >
        <Upload className="size-5 text-accent-2" aria-hidden />
        <span>
          {label}
          {hint && <span className="mt-1 block text-xs text-faint">{hint}</span>}
        </span>
      </button>
      <input ref={inputRef} type="file" accept={accept} multiple={multiple} className="hidden" onChange={(e) => e.target.files && void handle(e.target.files)} />
      {items.length > 0 && (
        <ul className="mt-3 space-y-2" aria-live="polite">
          {items.map((it, i) => (
            <li key={i} className="rounded-lg border border-line bg-black/20 px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-fg">{it.name}</span>
                <span className={cx('shrink-0', it.error ? 'text-[#ff9b9b]' : it.done ? 'text-success' : 'text-dim')}>
                  {it.error ? 'Rejected' : it.done ? 'Ready' : it.progress >= 1 ? 'Validating…' : `${Math.round(it.progress * 100)}%`}
                </span>
              </div>
              {it.error ? <p className="mt-1 text-[#ff9b9b]">{it.error}</p> : !it.done && <ProgressBar value={it.progress} className="mt-1.5" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ACCEPT: Record<AssetKind, string> = {
  image: 'image/png,image/jpeg,image/webp,image/heic,image/heif',
  video: 'video/mp4,video/quicktime,video/webm,video/mpeg,video/3gpp',
  audio: 'audio/*',
  document: '.txt,.lrc,.fountain,.cube,.ttf,.otf,text/plain,application/pdf,font/ttf,font/otf',
};
export const acceptFor = (kinds: AssetKind[]) => kinds.map((k) => ACCEPT[k]).join(',');

/** Library picker with inline upload. */
export function AssetPicker({
  open,
  onOpenChange,
  kinds,
  projectId,
  multiple,
  max = 1,
  onPick,
  title = 'Choose media',
  initial = [],
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  kinds: AssetKind[];
  projectId?: string | null;
  multiple?: boolean;
  max?: number;
  onPick: (assets: Asset[]) => void;
  title?: string;
  initial?: string[];
}) {
  const uid = useUid();
  const [scope, setScope] = useState<'project' | 'all'>(projectId ? 'project' : 'all');
  const [selected, setSelected] = useState<string[]>(initial);
  useEffect(() => {
    if (open) setSelected(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const live = useQuery<AssetDoc>(
    () =>
      open && uid
        ? scope === 'project' && projectId
          ? query(collection(db, 'assets'), where('ownerUid', '==', uid), where('projectId', '==', projectId), orderBy('createdAt', 'desc'))
          : query(collection(db, 'assets'), where('ownerUid', '==', uid), orderBy('createdAt', 'desc'))
        : null,
    [open, uid, scope, projectId],
  );
  const assets = useMemo(() => live.data.filter((a) => kinds.includes(a.kind) && a.status !== 'rejected'), [live.data, kinds]);
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : multiple ? (s.length >= max ? s : [...s, id]) : [id]));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="xl"
      description={multiple ? `Select up to ${max}.` : undefined}
      footer={
        <>
          <span className="mr-auto text-xs text-faint">{selected.length} selected</span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!selected.length}
            onClick={() => {
              onPick(selected.map((id) => assets.find((a) => a.id === id)).filter((a): a is Asset => Boolean(a && a.status === 'ready')));
              onOpenChange(false);
            }}
          >
            Use {selected.length > 1 ? `${selected.length} items` : 'selection'}
          </Button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {projectId ? (
          <Segmented
            label="Scope"
            size="sm"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'project', label: 'This project' },
              { value: 'all', label: 'All media' },
            ]}
          />
        ) : (
          <span />
        )}
        <Badge>{kinds.join(' · ')}</Badge>
      </div>
      <UploadZone compact accept={acceptFor(kinds)} projectId={projectId ?? null} onUploaded={(ids) => setSelected((s) => (multiple ? [...s, ...ids].slice(0, max) : ids.slice(0, 1)))} label="Upload new" />
      <div className="mt-4">
        {live.loading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="aspect-video" />
            ))}
          </div>
        ) : assets.length === 0 ? (
          <EmptyState title="Nothing here yet" body="Upload media above or generate some in the studios." />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {assets.map((a) => (
              <AssetThumb key={a.id} asset={a} selected={selected.includes(a.id)} onClick={() => a.status === 'ready' && toggle(a.id)} hoverPlay={false} />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function AssetMeta({ asset }: { asset: Asset }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
      <dt className="text-faint">Type</dt>
      <dd className="text-dim">{asset.mimeType}</dd>
      <dt className="text-faint">Size</dt>
      <dd className="text-dim">{formatBytes(asset.sizeBytes)}</dd>
      {asset.width ? (
        <>
          <dt className="text-faint">Dimensions</dt>
          <dd className="text-dim">
            {asset.width}×{asset.height}
          </dd>
        </>
      ) : null}
      {asset.durationSec ? (
        <>
          <dt className="text-faint">Duration</dt>
          <dd className="text-dim">{formatDuration(asset.durationSec)}</dd>
        </>
      ) : null}
      <dt className="text-faint">Source</dt>
      <dd className="text-dim">{asset.source}</dd>
      {asset.generation && (
        <>
          <dt className="text-faint">Model</dt>
          <dd className="break-all text-dim">{asset.generation.modelId}</dd>
          <dt className="text-faint">Provenance</dt>
          <dd className="text-dim">SynthID{asset.generation.provenance.c2pa === 'present' ? ' · C2PA present' : asset.generation.provenance.c2pa === 'absent' ? ' · C2PA not embedded (re-encoded)' : ''}</dd>
        </>
      )}
    </dl>
  );
}
