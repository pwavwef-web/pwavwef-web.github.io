import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, CloudOff, Coins, ExternalLink, FlaskConical, LoaderCircle, Pause, Play, Save } from 'lucide-react';
import { formatUsd, sceneDurations, type AdScene, type CostEstimate, type LinkAdAsset, type LinkAdDoc, type LinkAdStage } from '@az-studio/shared';
import { errorMessage } from '../../lib/api';
import { linkAdCall, type SaveStatus } from '../../lib/linkad';
import { useMediaUrls } from '../../lib/media';
import { Badge, Notice, cx } from '../../components/ui';

export const STEPS = ['source', 'brief', 'directions', 'edit', 'export'] as const;
export type LinkAdStepId = (typeof STEPS)[number];
export const STEP_LABELS: Record<LinkAdStepId, string> = { source: 'Website', brief: 'Proposed ad', directions: 'Directions', edit: 'Edit', export: 'Export' };

/** The step the ad is naturally on, from its stage (reopening continues where the work stopped). */
export function stepForStage(stage: LinkAdStage, hasAd: boolean): LinkAdStepId {
  switch (stage) {
    case 'draft':
    case 'analysing':
    case 'failed':
    case 'cancelled':
      return 'source';
    case 'reviewing':
      return 'brief';
    case 'planning':
    case 'awaiting_selection':
      return hasAd ? 'edit' : 'directions';
    case 'generating':
      return 'edit';
    case 'composing':
    case 'ready':
      return 'export';
  }
}

export function SaveBadge({ status }: { status: SaveStatus }) {
  if (status === 'saving') return <Badge icon={<LoaderCircle className="size-3 animate-spin" />}>Saving…</Badge>;
  if (status === 'unsaved') return <Badge icon={<Save className="size-3" />}>Unsaved changes</Badge>;
  if (status === 'error') return <Badge tone="danger" icon={<CloudOff className="size-3" />}>Not saved — will retry on your next change</Badge>;
  return <Badge tone="success" icon={<Check className="size-3" />}>Saved</Badge>;
}

export function FixtureBadge({ doc }: { doc: LinkAdDoc }) {
  if (doc.mode !== 'fixture') return null;
  return (
    <Badge tone="violet" icon={<FlaskConical className="size-3" />}>
      Fixture run — demo website, planner and tone voice; no live provider
    </Badge>
  );
}

export const hostOf = (u: string | null | undefined) => {
  try {
    const x = new URL(u ?? '');
    return `${x.hostname.replace(/^www\./, '')}${x.pathname === '/' ? '' : x.pathname}`.slice(0, 60);
  } catch {
    return u ?? '';
  }
};

export function SourceLink({ url, excerpt }: { url: string | null; excerpt?: string | null }) {
  if (!url) return <span className="text-[11px] text-faint">Your own note</span>;
  return (
    <details className="group text-[11px] text-faint">
      <summary className="cursor-pointer list-none hover:text-dim">
        <span className="underline decoration-dotted underline-offset-2">Where this came from</span> · {hostOf(url)}
      </summary>
      <div className="mt-1 space-y-1 rounded-lg border border-line bg-white/[0.03] p-2">
        {excerpt && <p className="text-dim">“{excerpt}”</p>}
        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-2 hover:underline">
          Open the page <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>
    </details>
  );
}

/** A picture from the ad's library of source/uploaded pictures. */
export function Thumb({ asset, className, alt }: { asset: Pick<LinkAdAsset, 'assetId' | 'alt' | 'status'>; className?: string; alt?: string }) {
  const urls = useMediaUrls(asset.status === 'stored' ? asset.assetId : null);
  const src = urls?.thumb ?? urls?.file;
  return src ? <img src={src} alt={alt ?? asset.alt} loading="lazy" draggable={false} className={cx('size-full object-cover', className)} /> : <div className={cx('grid size-full place-items-center bg-white/[0.04] text-[10px] text-faint', className)}>{asset.status === 'stored' ? '…' : 'no picture'}</div>;
}

/** Cost line with the cap, always labelled as an estimate. */
export function CostLine({ estimate, capUsd, committedUsd, fixture }: { estimate: CostEstimate | null; capUsd: number; committedUsd: number; fixture?: boolean }) {
  if (!estimate) return null;
  const priced = estimate.basis !== 'none';
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
      <Coins className="size-3.5 text-faint" aria-hidden />
      {priced ? (
        <span>
          Estimated <strong className="text-fg">{formatUsd(estimate.usd, { precise: true })}</strong> at Google&apos;s published list prices ({estimate.confidence} confidence)
        </span>
      ) : (
        <span className="text-warning">No price is configured for this step, so there is no estimate. The cap below still applies.</span>
      )}
      <span className="text-faint">
        · this ad so far {formatUsd(committedUsd, { precise: true })} of its {formatUsd(capUsd)} cap
      </span>
      {fixture && <span className="text-violet">· fixture run: nothing is charged</span>}
    </p>
  );
}

/** Loads an estimate from the server when the key changes. */
export interface EstimateReply {
  estimate: CostEstimate | null;
  problem?: string | null;
  capUsd?: number;
  committedUsd?: number;
  fixture?: boolean;
  noop?: boolean;
  interrupted?: string[];
  sceneIds?: string[];
  needsConfirm?: boolean;
}

export function useEstimate<T extends EstimateReply>(load: (() => Promise<T>) | null, key: string) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false });
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const fn = loadRef.current;
    if (!fn) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e) => alive && setState({ data: null, error: errorMessage(e), loading: false }),
    );
    return () => {
      alive = false;
    };
  }, [key]);
  return state;
}

export function EstimateBlock({ state, doc }: { state: ReturnType<typeof useEstimate>; doc: LinkAdDoc }) {
  if (state.loading && !state.data) return <p className="text-xs text-faint">Working out the cost…</p>;
  if (state.error) return <Notice tone="warning">{state.error}</Notice>;
  const d = state.data as { estimate: CostEstimate | null; problem?: string | null; capUsd?: number; committedUsd?: number } | null;
  if (!d) return null;
  return (
    <div className="space-y-2">
      <CostLine estimate={d.estimate} capUsd={d.capUsd ?? doc.spend.capUsd} committedUsd={d.committedUsd ?? 0} fixture={doc.mode === 'fixture'} />
      {d.problem && <Notice tone="danger">{d.problem}</Notice>}
    </div>
  );
}

export const linkAdPing = (projectId: string) => linkAdCall({ op: 'refresh', projectId });

// ---------------------------------------------------------------------------
// A rough storyboard preview (no voice): scenes in order for their estimated length
// ---------------------------------------------------------------------------

export function StoryboardPreview({ doc, scenes, className, onScene }: { doc: LinkAdDoc; scenes: AdScene[]; className?: string; onScene?: (i: number) => void }) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timings = useMemo(() => sceneDurations({ ...doc.ad, scenes, takes: {} }, doc.brief.voice, doc.brief.voiceDirection), [doc.ad, doc.brief.voice, doc.brief.voiceDirection, scenes]);
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => {
      if (i >= scenes.length - 1) {
        setPlaying(false);
        return;
      }
      setI(i + 1);
    }, Math.max(900, (timings[i]?.sec ?? 3) * 1000));
    return () => clearTimeout(t);
  }, [playing, i, scenes.length, timings]);
  useEffect(() => onScene?.(i), [i, onScene]);
  const scene = scenes[Math.min(i, scenes.length - 1)];
  const ref = scene?.assetId ? doc.source.assets.find((a) => a.id === scene.assetId) : undefined;
  const urls = useMediaUrls(ref?.status === 'stored' ? ref.assetId : null);
  const src = urls?.file ?? urls?.thumb;
  const total = timings.reduce((a, t) => a + t.sec, 0);
  if (!scene) return null;
  return (
    <div className={cx('space-y-2', className)}>
      <div className="relative mx-auto aspect-[9/16] w-full max-w-[260px] overflow-hidden rounded-2xl border border-line" style={{ background: doc.ad.brand.background }}>
        {src && <img src={src} alt="" draggable={false} className="absolute inset-0 size-full object-cover" style={{ objectPosition: `${scene.focal.x * 100}% ${scene.focal.y * 100}%` }} />}
        {scene.overlay && (
          <div className={cx('absolute inset-x-3 text-center text-[15px] leading-tight font-semibold text-white', scene.overlayPos === 'upper' ? 'top-[11%]' : scene.overlayPos === 'middle' ? 'top-[42%]' : 'top-[56%]')}>
            <span className={src ? 'rounded bg-black/70 px-2 py-0.5 [box-decoration-break:clone]' : ''} style={src ? undefined : { color: doc.ad.brand.text }}>
              {scene.overlay}
            </span>
          </div>
        )}
        <div className="absolute inset-x-3 bottom-[14%] text-center text-[11px] leading-snug font-semibold text-white [text-shadow:0_1px_3px_#000]">{scene.narration}</div>
        <span className="absolute top-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white">Rough preview · no voice</span>
      </div>
      <div className="flex items-center justify-center gap-2">
        <button type="button" aria-label={playing ? 'Pause' : 'Play the storyboard'} className="grid size-8 cursor-pointer place-items-center rounded-full bg-white/[0.08] text-fg hover:bg-white/[0.14]" onClick={() => (playing ? setPlaying(false) : (i >= scenes.length - 1 && setI(0), setPlaying(true)))}>
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>
        <div className="flex gap-1" role="tablist" aria-label="Scenes">
          {scenes.map((s, k) => (
            <button key={s.id} type="button" role="tab" aria-selected={k === i} aria-label={`Scene ${k + 1}`} onClick={() => (setPlaying(false), setI(k))} className={cx('h-1.5 cursor-pointer rounded-full transition-all', k === i ? 'w-6 bg-accent-2' : 'w-3 bg-white/20 hover:bg-white/35')} />
          ))}
        </div>
        <span className="timecode text-[11px] text-faint">≈ {total.toFixed(0)} s</span>
      </div>
    </div>
  );
}

export function Panel({ title, sub, action, children, className }: { title: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('card space-y-4 p-5', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="display text-2xl text-fg">{title}</h2>
          {sub && <p className="mt-0.5 text-xs text-dim">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
