import { useState } from 'react';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { Link } from 'react-router';
import { Clapperboard, Download, Monitor, Play, Plus, Smartphone, Square } from 'lucide-react';
import { EXPORT_PRESETS, estimateRender, formatDuration, relativeTime, toMillis, type ExportPreset, type ProjectDoc, type RenderDoc, type RenderQuality, type TimelineDoc } from '@az-studio/shared';
import { db } from '../lib/firebase';
import { useQuery, type WithId } from '../lib/data';
import { downloadUrl } from '../lib/media';
import { useBoot, useUid } from '../lib/session';
import { useSub } from '../lib/studio';
import { EstimateText, useJobSubmitter } from './jobs';
import { AssetThumb, useAsset, VideoPlayer, type Asset } from './media';
import { Badge, Button, Card, EmptyState, ProgressBar, Segmented, Select } from './ui';

const PRESET_ICON = { youtube_16x9: Monitor, vertical_9x16: Smartphone, square_1x1: Square };

function RenderRow({ render }: { render: WithId<RenderDoc> }) {
  const asset = useAsset(render.outputAssetId);
  const [watching, setWatching] = useState(false);
  const active = !['completed', 'failed', 'cancelled'].includes(render.status);
  const download = async () => {
    if (!render.outputAssetId) return;
    const url = await downloadUrl(render.outputAssetId);
    if (url) window.open(url, '_blank', 'noopener');
  };
  return (
    <li className="rounded-xl border border-line p-2.5">
      <div className="flex items-center gap-3">
      <div className="w-28 shrink-0">{asset.data ? <AssetThumb asset={asset.data as Asset} showMeta={false} /> : <div className="grid aspect-video place-items-center rounded-lg bg-black/30 text-faint"><Clapperboard className="size-4" /></div>}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm text-fg">{EXPORT_PRESETS[render.preset as ExportPreset['id']]?.label ?? render.preset}</p>
          <Badge tone={render.quality === 'final' ? 'violet' : 'neutral'}>{render.quality === 'final' ? 'Final' : 'Draft'}</Badge>
          <Badge tone={render.status === 'completed' ? 'success' : render.status === 'failed' ? 'danger' : 'accent'}>{render.status}</Badge>
        </div>
        <p className="mt-0.5 text-xs text-dim">
          {render.width}×{render.height} · {formatDuration(render.durationSec)} · {render.stage} · {relativeTime(toMillis(render.createdAt))}
        </p>
        {active && <ProgressBar value={render.progress} className="mt-2" label="Render progress" />}
        {render.error && <p className="mt-1 text-xs text-[#ff9b9b]">{render.error.message}</p>}
      </div>
      {render.status === 'completed' && (
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant={watching ? 'subtle' : 'ghost'} icon={<Play className="size-3.5" />} onClick={() => setWatching((w) => !w)}>
            {watching ? 'Close' : 'Play'}
          </Button>
          <Button size="sm" variant="secondary" icon={<Download className="size-3.5" />} onClick={() => void download()}>
            MP4
          </Button>
        </div>
      )}
      </div>
      {watching && render.outputAssetId && <VideoPlayer assetId={render.outputAssetId} autoPlay className="mt-3 rounded-lg" />}
    </li>
  );
}

export function EditAndExport({ project, onAssemble, assembleLabel = 'Assemble timeline', assembling, assembleHint }: { project: WithId<ProjectDoc>; onAssemble?: () => void; assembleLabel?: string; assembling?: boolean; assembleHint?: string }) {
  const boot = useBoot();
  const uid = useUid();
  const timelines = useSub<TimelineDoc>(project.id, 'timelines', 'updatedAt', 'desc');
  const renders = useQuery<RenderDoc>(() => (uid ? query(collection(db, 'renders'), where('ownerUid', '==', uid), where('projectId', '==', project.id), orderBy('createdAt', 'desc'), limit(20)) : null), [uid, project.id]);
  const [timelineId, setTimelineId] = useState<string>('');
  const [quality, setQuality] = useState<RenderQuality>('draft');
  const { submit, busy, dialog } = useJobSubmitter();
  const tl = timelines.data.find((t) => t.id === (timelineId || timelines.data[0]?.id));

  const render = async (preset: ExportPreset['id']) => {
    if (!tl) return;
    await submit([{ type: 'render.timeline', projectId: project.id, timelineId: tl.id, preset, quality }], { label: `${EXPORT_PRESETS[preset].label} ${quality}`, alwaysConfirm: quality === 'final' });
  };

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <Card className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="eyebrow">Timelines</p>
            {onAssemble && (
              <Button variant="primary" size="sm" loading={assembling} onClick={onAssemble} icon={<Plus className="size-4" />}>
                {assembleLabel}
              </Button>
            )}
          </div>
          {assembleHint && <p className="text-xs text-faint">{assembleHint}</p>}
          {timelines.data.length === 0 ? (
            <EmptyState title="No timeline yet" body="Assemble one from your approved shots, then trim, order and add transitions in the editor." />
          ) : (
            <ul className="space-y-2">
              {timelines.data.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-fg">{t.name}</p>
                    <p className="text-xs text-faint">
                      {t.clips.length} clips · {formatDuration(t.durationSec)} · v{t.version} · {relativeTime(toMillis(t.updatedAt))}
                    </p>
                  </div>
                  <Link to={`/projects/${project.id}/timeline/${t.id}`}>
                    <Button size="sm" variant="secondary">
                      Open editor
                    </Button>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="space-y-4 p-5">
          <p className="eyebrow">Export</p>
          {tl ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Select value={tl.id} onChange={(e) => setTimelineId(e.target.value)} className="!w-60" aria-label="Timeline to export">
                  {timelines.data.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
                <Segmented
                  label="Quality"
                  value={quality}
                  onChange={setQuality}
                  options={[
                    { value: 'draft', label: 'Draft (fast)' },
                    { value: 'final', label: 'Final (full quality)' },
                  ]}
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {(Object.values(EXPORT_PRESETS) as ExportPreset[]).map((p) => {
                  const Icon = PRESET_ICON[p.id];
                  const dims = quality === 'final' ? p.final : p.draft;
                  return (
                    <button key={p.id} type="button" disabled={busy || !tl.clips.length} onClick={() => void render(p.id)} className="card cursor-pointer p-4 text-left transition-all hover:border-accent/40 disabled:cursor-not-allowed disabled:opacity-50">
                      <Icon className="size-5 text-accent-2" aria-hidden />
                      <p className="mt-3 text-sm font-medium text-fg">{p.label}</p>
                      <p className="text-xs text-faint">
                        {dims.width}×{dims.height} · {p.platform}
                      </p>
                      {boot && <EstimateText className="mt-2" estimate={estimateRender({ durationSec: tl.durationSec, quality }, boot.pricing)} />}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-faint">Rendering runs FFmpeg on Cloud Run. Square and alternate-ratio exports reframe each clip using its fit mode (fill, fit or blurred background).</p>
            </>
          ) : (
            <p className="text-sm text-faint">Create a timeline to export.</p>
          )}
        </Card>
      </div>
      <Card className="space-y-4 p-5">
        <p className="eyebrow">Renders</p>
        {renders.data.length === 0 ? <p className="text-sm text-faint">Rendered films appear here with live progress.</p> : <ul className="space-y-2">{renders.data.map((r) => <RenderRow key={r.id} render={r} />)}</ul>}
      </Card>
      {dialog}
    </div>
  );
}
