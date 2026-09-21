import { useMemo, useState } from 'react';
import { collection, doc, orderBy, query, updateDoc, where } from 'firebase/firestore';
import { toast } from 'sonner';
import { CornerDownRight, Download, GitBranch, History, ImagePlus, MessageSquare, Send, Star } from 'lucide-react';
import { estimateImage, estimateVideo, relativeTime, toMillis, type ChainDoc, type ChainTurn, type JobRequest } from '@az-studio/shared';
import { api, errorMessage } from '../lib/api';
import { db } from '../lib/firebase';
import { useDoc, useQuery, type WithId } from '../lib/data';
import { downloadUrl } from '../lib/media';
import { useBoot, useUid } from '../lib/session';
import { EstimateText, useJobSubmitter } from './jobs';
import { AssetThumb, ImageView, useAsset, VideoPlayer, type Asset } from './media';
import { Badge, Button, Card, cx, EmptyState, Field, IconButton, Notice, Segmented, Select, Skeleton, Slider, Spinner, Textarea } from './ui';

export type Chain = WithId<ChainDoc>;
type Turn = WithId<ChainTurn>;

export function useChains(kind: 'video' | 'image', projectId: string | null) {
  const uid = useUid();
  return useQuery<ChainDoc>(() => (uid ? query(collection(db, 'chains'), where('ownerUid', '==', uid), where('kind', '==', kind), where('projectId', '==', projectId), orderBy('updatedAt', 'desc')) : null), [uid, kind, projectId]);
}

function ChainCover({ chain }: { chain: Chain }) {
  const head = useDoc<ChainTurn>(chain.headTurnId ? `chains/${chain.id}/turns/${chain.headTurnId}` : null);
  const asset = useAsset(head.data?.assetId ?? null);
  if (asset.data) return <AssetThumb asset={asset.data as Asset} showMeta={false} hoverPlay={false} />;
  return (
    <div className="cinema-thumb grid aspect-video place-items-center rounded-xl border border-line">
      <Spinner />
    </div>
  );
}

export function ChainList({ chains, selected, onSelect }: { chains: Chain[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-2 2xl:grid-cols-3">
      {chains.map((c) => (
        <button key={c.id} type="button" onClick={() => onSelect(c.id)} className={cx('cursor-pointer rounded-2xl border p-2 text-left transition-all', selected === c.id ? 'border-accent/60 bg-accent/[0.06] shadow-[var(--shadow-glow)]' : 'border-transparent hover:border-line-strong')}>
          <ChainCover chain={c} />
          <p className="mt-2 line-clamp-1 px-1 text-[13px] text-fg">{c.title || 'Untitled'}</p>
          <p className="px-1 text-[11px] text-faint">
            {c.turnCount} turn{c.turnCount === 1 ? '' : 's'} · {relativeTime(toMillis(c.updatedAt))}
          </p>
        </button>
      ))}
    </div>
  );
}

function TurnResult({ turn, kind, isHead, onBranch, active }: { turn: Turn; kind: 'video' | 'image'; isHead: boolean; onBranch: () => void; active: boolean }) {
  const asset = useAsset(turn.assetId);
  const job = useDoc<{ stage?: string; progress?: number; error?: { message: string; safety?: boolean } | null }>(`jobs/${turn.jobId}`);
  const [busy, setBusy] = useState(false);
  const running = turn.status !== 'completed' && turn.status !== 'failed' && turn.status !== 'cancelled';

  const toggleFav = async () => {
    if (!asset.data) return;
    await updateDoc(doc(db, 'assets', asset.data.id), { favorite: !asset.data.favorite });
  };
  const download = async () => {
    if (!turn.assetId) return;
    const url = await downloadUrl(turn.assetId);
    if (url) window.open(url, '_blank', 'noopener');
  };
  const extract = async () => {
    if (!turn.assetId) return;
    setBusy(true);
    try {
      await api('extractFrame', { assetId: turn.assetId, atSec: Math.max(0, (asset.data?.durationSec ?? 0.1) - 0.05), collections: ['frames'] });
      toast.success('Last frame saved to your library', { description: 'Use it as the first frame of the next shot for continuity.' });
    } catch (e) {
      toast.error('Could not extract frame', { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2.5">
        <div className="grid size-7 shrink-0 place-items-center rounded-full bg-white/[0.06] text-dim">
          <MessageSquare className="size-3.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-line bg-white/[0.03] px-3.5 py-2.5">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={turn.index === 0 ? 'accent' : 'violet'}>{turn.index === 0 ? 'Generate' : turn.mode}</Badge>
            {turn.parentTurnId && <span className="text-[11px] text-faint">continues an earlier result</span>}
          </div>
          <p className="text-sm whitespace-pre-wrap text-fg">{turn.prompt}</p>
        </div>
      </div>
      <div className={cx('ml-9 rounded-2xl border p-2.5', active ? 'border-accent/50' : 'border-line')}>
        {turn.status === 'completed' && turn.assetId ? (
          kind === 'video' ? (
            <VideoPlayer assetId={turn.assetId} />
          ) : (
            <ImageView assetId={turn.assetId} className="max-h-[520px]" />
          )
        ) : running ? (
          <div className="grid aspect-video place-items-center rounded-xl bg-black/30">
            <div className="text-center">
              <Spinner className="mx-auto" />
              <p className="mt-2 text-xs text-dim">{job.data?.stage ?? 'Queued'}</p>
            </div>
          </div>
        ) : (
          <div className="rounded-xl bg-black/30 p-4 text-sm text-[#ff9b9b]">{job.data?.error?.message ?? `This turn ${turn.status}.`}</div>
        )}
        {turn.status === 'completed' && turn.assetId && (
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {isHead ? <Badge tone="success">Latest</Badge> : null}
            <Button size="sm" variant={active ? 'subtle' : 'ghost'} icon={<GitBranch className="size-3.5" />} onClick={onBranch}>
              {active ? 'Editing from here' : 'Continue from here'}
            </Button>
            {kind === 'video' && (
              <Button size="sm" variant="ghost" loading={busy} icon={<ImagePlus className="size-3.5" />} onClick={() => void extract()}>
                Save last frame
              </Button>
            )}
            <IconButton label={asset.data?.favorite ? 'Remove favourite' : 'Add to favourites'} size="sm" onClick={() => void toggleFav()} active={Boolean(asset.data?.favorite)}>
              <Star className={cx('size-3.5', asset.data?.favorite && 'fill-warning text-warning')} />
            </IconButton>
            <IconButton label="Download original" size="sm" onClick={() => void download()}>
              <Download className="size-3.5" />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  );
}

export function ChainView({ chainId, kind, projectId }: { chainId: string; kind: 'video' | 'image'; projectId: string | null }) {
  const boot = useBoot();
  const chain = useDoc<ChainDoc>(`chains/${chainId}`);
  const turns = useQuery<ChainTurn>(() => query(collection(db, 'chains', chainId, 'turns'), orderBy('index', 'asc')), [chainId]);
  const [parentId, setParentId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'edit' | 'extend'>('edit');
  const [extendSec, setExtendSec] = useState(6);
  const [resolution, setResolution] = useState(boot?.capabilities.video.defaultResolution ?? '720p');
  const [imageSize, setImageSize] = useState(boot?.capabilities.image.defaultImageSize ?? '2K');
  const [aspect, setAspect] = useState('16:9');
  const { submit, busy, dialog } = useJobSubmitter();

  const completed = turns.data.filter((t) => t.status === 'completed' && t.assetId);
  const effectiveParent = parentId ?? chain.data?.headTurnId ?? completed[completed.length - 1]?.id ?? null;
  const parentTurn = turns.data.find((t) => t.id === effectiveParent) ?? null;
  const parentAsset = useAsset(parentTurn?.assetId ?? null);
  const caps = boot?.capabilities;
  const expired = kind === 'video' && parentTurn && caps ? Date.now() - (toMillis(parentTurn.createdAt) ?? Date.now()) > (caps.video.interactionRetentionDays - 0.25) * 86_400_000 : false;

  const estimate = useMemo(() => {
    if (!boot || !prompt.trim()) return null;
    if (kind === 'image') return estimateImage({ imageSize, referenceImages: 1, promptChars: prompt.length, outputs: 1 }, boot.pricing);
    const dur = parentAsset.data?.durationSec ?? 6;
    return estimateVideo({ resolution, outputSeconds: mode === 'extend' ? dur + extendSec : dur, promptChars: prompt.length, imageInputs: 0, videoInputSeconds: dur, task: mode }, boot.pricing);
  }, [boot, prompt, kind, imageSize, resolution, mode, extendSec, parentAsset.data?.durationSec]);

  const send = async () => {
    if (!effectiveParent || !prompt.trim()) return;
    const job: JobRequest =
      kind === 'video'
        ? { type: 'video.generate', projectId, mode, prompt: prompt.trim(), chainId, parentTurnId: effectiveParent, resolution, ...(mode === 'extend' ? { durationSec: extendSec } : {}), media: [], characterIds: [] }
        : { type: 'image.generate', projectId, prompt: prompt.trim(), purpose: 'free', aspectRatio: aspect, imageSize, referenceAssetIds: [], chainId, parentTurnId: effectiveParent, grounding: false, applyStyleBible: false, characterIds: [], collections: [] };
    const ids = await submit([job], { label: kind === 'video' ? `Omni ${mode}` : 'Image edit' });
    if (ids) {
      setPrompt('');
      setParentId(null);
    }
  };

  if (chain.loading || turns.loading) return <Skeleton className="h-96" />;
  if (!chain.data) return <EmptyState title="Chain not found" />;
  const maxExtend = caps ? Math.max(caps.video.durationSec.min, Math.min(caps.video.durationSec.max, caps.video.maxExtendedLengthSec - Math.ceil(parentAsset.data?.durationSec ?? 0))) : 10;

  return (
    <Card className="flex flex-col p-0">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="eyebrow flex items-center gap-1.5">
            <History className="size-3.5" /> {kind === 'video' ? 'Omni interaction chain' : 'Edit history'}
          </p>
          <p className="truncate text-sm text-fg">{chain.data.title}</p>
        </div>
        <Badge>{turns.data.length} turns</Badge>
      </div>
      <div className="max-h-[70vh] space-y-6 overflow-y-auto px-4 py-4">
        {turns.data.map((t) => (
          <TurnResult key={t.id} turn={t} kind={kind} isHead={t.id === chain.data!.headTurnId} active={t.id === effectiveParent} onBranch={() => setParentId(t.id)} />
        ))}
      </div>
      <div className="border-t border-line p-4">
        {!effectiveParent ? (
          <p className="text-sm text-faint">Follow-up edits unlock when the first result is ready.</p>
        ) : (
          <div className="space-y-3">
            <p className="flex items-center gap-1.5 text-xs text-faint">
              <CornerDownRight className="size-3.5" /> Editing turn {(parentTurn?.index ?? 0) + 1}
              {parentId && (
                <button type="button" className="cursor-pointer text-accent-2 hover:underline" onClick={() => setParentId(null)}>
                  (use latest)
                </button>
              )}
            </p>
            {kind === 'video' && caps && (
              <div className="flex flex-wrap items-end gap-3">
                <Segmented
                  label="Follow-up mode"
                  size="sm"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'edit', label: 'Edit' },
                    { value: 'extend', label: 'Extend', disabled: (parentAsset.data?.durationSec ?? 0) + caps.video.durationSec.min > caps.video.maxExtendedLengthSec },
                  ]}
                />
                <Select value={resolution} onChange={(e) => setResolution(e.target.value)} className="!w-28 !py-1.5 text-xs" aria-label="Resolution">
                  {caps.video.resolutions.map((r) => (
                    <option key={r} value={r}>
                      {r.toUpperCase()}
                    </option>
                  ))}
                </Select>
                {mode === 'extend' && (
                  <div className="w-48">
                    <Field label={`Add ${extendSec}s`}>
                      <Slider label="Extension length" min={caps.video.durationSec.min} max={maxExtend} step={1} value={Math.min(extendSec, maxExtend)} onChange={setExtendSec} />
                    </Field>
                  </div>
                )}
              </div>
            )}
            {kind === 'image' && caps && (
              <div className="flex flex-wrap gap-3">
                <Select value={aspect} onChange={(e) => setAspect(e.target.value)} className="!w-28 !py-1.5 text-xs" aria-label="Aspect ratio">
                  {caps.image.aspectRatios.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </Select>
                <Select value={imageSize} onChange={(e) => setImageSize(e.target.value)} className="!w-24 !py-1.5 text-xs" aria-label="Image size">
                  {caps.image.imageSizes.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {expired && (
              <Notice tone="warning" className="text-xs">
                This result is older than Omni’s retention window, so the edit will re-send the video as a source clip (≤{caps?.video.maxEditInputSeconds}s) instead of continuing the stored interaction.
              </Notice>
            )}
            <div className="flex gap-2">
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={2}
                placeholder={kind === 'video' ? (mode === 'edit' ? 'e.g. Make it night, with lanterns lighting the street' : 'e.g. The camera keeps pushing in as she starts to sing') : 'e.g. Change her dress to indigo kente, keep the pose'}
                aria-label="Follow-up instruction"
                onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && void send()}
              />
              <Button variant="primary" className="self-end" loading={busy} disabled={!prompt.trim()} onClick={() => void send()} icon={<Send className="size-4" />}>
                Send
              </Button>
            </div>
            <EstimateText estimate={estimate} />
          </div>
        )}
      </div>
      {dialog}
    </Card>
  );
}
